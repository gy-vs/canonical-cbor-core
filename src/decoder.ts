/**
 * Incremental CBOR (RFC 8949) decoder.
 *
 * A stack-based state machine whose frames survive across calls to
 * {@link CborDecoder.next}.
 *
 * Buffer model (kept deliberately simple):
 * - {@link push} only ever appends;
 * - `pos` and every frame offset are indices into `buf`; the absolute stream
 *   offset of such an index is `origin + index`;
 * - head and definite string/byte-string bodies are read atomically: the
 *   position only advances once all of their bytes are present, so a
 *   truncated prefix leaves the parser exactly where it started and simply
 *   requests more data;
 * - on success, the completed value's bytes are trimmed from the front and
 *   `origin` advances;
 * - on a permanent error the position is rewound to the start of the failing
 *   top-level value, so neither its bytes nor any following value's bytes are
 *   consumed.
 *
 * This makes "need more data" distinguishable from every permanent format
 * error, supports arbitrarily-chunked input (including a UTF-8 sequence split
 * across chunks) and keeps error offsets absolute across chunks.
 */
import { CborError, type CborErrorCode } from './errors.js';
import { float16BitsToNumber } from './float16.js';
import { CborSimple, CborTag } from './tag.js';
import { decodeUtf8, findInvalidUtf8 } from './utf8.js';
import type { DecodeOptions, DecodedValue } from './types.js';

const DEFAULT_MAX_DEPTH = 100;

/** Internal signal: the buffer ends in the middle of a token. */
class NeedMore extends Error {
  constructor(readonly at: number) {
    super('need more data');
  }
}

interface Head {
  major: number;
  arg: bigint;
  /** Buffer index of the head's first byte. */
  start: number;
  indefinite: boolean;
}

type FrameKind = 'array' | 'map' | 'tag' | 'bstr-indef' | 'tstr-indef';

interface Frame {
  kind: FrameKind;
  /** Buffer index of this frame's head byte. */
  start: number;
  /** Definite array/map: items (elements or pairs) remaining; -1 if indef. */
  remaining: number;
  /** Map: the next expected item is a key. */
  expectKey: boolean;
  /** Array elements, and map values (in pair order). */
  items: unknown[];
  /** Map keys (in pair order). */
  keys: unknown[];
  /** Raw encoded CBOR bytes of each map key. */
  keyRaw: Uint8Array[];
  /** Indefinite strings: chunk bodies and their buffer start indices. */
  chunks: Uint8Array[];
  chunkStarts: number[];
  /** Tag number (kind === 'tag'). */
  tag: bigint;
}

/**
 * Streaming CBOR decoder.
 *
 * Feed arbitrary {@link Uint8Array} chunks with {@link push}; call
 * {@link next} to decode one top-level value at a time. A result with
 * `done: false` means the stream so far only contains a prefix of the next
 * value — call `next` again after pushing more bytes.
 */
export class CborDecoder {
  private buf = new Uint8Array(0);
  /** Absolute stream offset of `buf[0]`. */
  private origin = 0;
  /** Read position in `buf` (always at a token boundary). */
  private pos = 0;
  private readonly frames: Frame[] = [];
  private result: unknown;
  private topLevelDone = false;
  private readonly maxDepth: number;
  private readonly rejectDuplicateKeys: boolean;

  constructor(options: DecodeOptions = {}) {
    if (options.maxDepth !== undefined) {
      if (!Number.isInteger(options.maxDepth) || options.maxDepth < 0) {
        throw new RangeError('maxDepth must be a non-negative integer');
      }
      this.maxDepth = options.maxDepth;
    } else {
      this.maxDepth = DEFAULT_MAX_DEPTH;
    }
    this.rejectDuplicateKeys = options.rejectDuplicateKeys === true;
  }

  /** Append a chunk of CBOR bytes. The input is copied. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (this.buf.length === 0) {
      const copy = new Uint8Array(chunk.length);
      copy.set(chunk);
      this.buf = copy;
      return;
    }
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;
  }

  /** Total number of stream bytes already consumed by complete values. */
  get consumed(): number {
    return this.origin;
  }

  /** Bytes buffered but not yet committed by a complete top-level value. */
  get pendingLength(): number {
    return this.buf.length;
  }

  /**
   * Attempt to decode one top-level value.
   *
   * Returns `{ done: false }` when more bytes are required (nothing is
   * consumed). Throws {@link CborError} on permanent malformed input; the
   * failing value and all following bytes are retained. On success the
   * value's bytes are removed from the internal buffer.
   */
  next(): { done: false } | ({ done: true } & DecodedValue) {
    if (this.frames.length === 0 && this.pos >= this.buf.length) {
      return { done: false };
    }
    const valueStart = this.pos;

    try {
      for (;;) {
        const top = this.frames[this.frames.length - 1];
        if (!top) {
          if (this.topLevelDone) break;
          this.result = undefined;
          this.parseValue(); // scalar completes, or a frame is pushed
          continue;
        }
        // Close a definite container already satisfied by its declared
        // length (covers empty containers right after their head and
        // cascades when a completed child closes a chain of parents).
        if (this.tryCompleteFinished(top)) continue;

        if (top.kind === 'array' || top.kind === 'map') {
          if (top.remaining === -1) {
            this.need(1);
            if (this.buf[this.pos] === 0xff) {
              this.pos += 1;
              this.finishContainer(top);
              continue;
            }
          }
          this.parseValue();
          continue;
        }
        if (top.kind === 'tag') {
          // Structurally transparent: the next token is the tag's content.
          this.parseValue();
          continue;
        }
        // Indefinite byte/text string: next definite chunk, or a break.
        this.stepIndefiniteString(top);
      }
    } catch (err) {
      if (err instanceof NeedMore) {
        // No state changes at all: frames and `pos` are at token boundaries.
        return { done: false };
      }
      // Permanent error: rewind to the failing top-level value's start and
      // drop its partial frames. Nothing is trimmed from `buf`, so that
      // value and all following bytes remain available to the caller.
      this.pos = valueStart;
      this.frames.length = 0;
      this.result = undefined;
      this.topLevelDone = false;
      throw err;
    }

    const value = this.result;
    const end = this.pos;
    const length = end - valueStart;
    const absoluteEnd = this.origin + end;
    // Commit exactly this value's bytes; trailing bytes stay buffered.
    this.buf = this.buf.subarray(end);
    this.origin = absoluteEnd;
    this.pos = 0;
    this.result = undefined;
    this.topLevelDone = false;
    return { done: true, value, consumed: absoluteEnd, length };
  }

  // -------------------------------------------------------------- errors --

  private fail(code: CborErrorCode, message: string, index?: number): never {
    const offset = this.origin + (index === undefined ? this.pos : index);
    throw new CborError(code, message, offset, this.frames.length);
  }

  /** Atomically require `n` more bytes; throws NeedMore without advancing. */
  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new NeedMore(this.origin + this.buf.length);
    }
  }

  // ---------------------------------------------------------------- head --

  private readHead(): Head {
    this.need(1);
    const start = this.pos;
    const initial = this.buf[start]!;
    const major = initial >> 5;
    const ai = initial & 0x1f;

    // Determine the full head width first, require all of it, and only then
    // advance: a truncated head never moves `pos`.
    const width =
      ai < 24 || ai === 31 ? 0 :
      ai === 24 ? 1 :
      ai === 25 ? 2 :
      ai === 26 ? 4 :
      ai === 27 ? 8 : -1;
    if (width === -1) {
      this.fail(
        'RESERVED_HEAD',
        `reserved additional information ${ai} in head byte 0x${initial.toString(16)}`,
        start,
      );
    }
    this.need(1 + width);
    this.pos += 1; // leading byte

    let arg: bigint;
    let indefinite = false;
    if (ai === 31) {
      arg = -1n;
      indefinite = true;
    } else if (ai < 24) {
      arg = BigInt(ai);
    } else if (ai === 24) {
      arg = BigInt(this.buf[this.pos]!);
      this.pos += 1;
    } else if (ai === 25) {
      arg = BigInt(((this.buf[this.pos]! << 8) | this.buf[this.pos + 1]!) >>> 0);
      this.pos += 2;
    } else if (ai === 26) {
      let value = 0;
      for (let i = 0; i < 4; i++) value = value * 256 + this.buf[this.pos + i]!;
      arg = BigInt(value >>> 0);
      this.pos += 4;
    } else {
      let value = 0n;
      for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(this.buf[this.pos + i]!);
      arg = value;
      this.pos += 8;
    }
    return { major, arg, start, indefinite };
  }

  // ------------------------------------------------------------ one value --

  private parseValue(): void {
    this.need(1);
    // Stack depth before this value: 0 at top level.
    if (this.frames.length > this.maxDepth) {
      this.fail('NESTING_TOO_DEEP', `nesting depth exceeds limit of ${this.maxDepth}`);
    }
    // Parse this token atomically: a scalar is "head + optional body". The
    // head succeeds but the body may need more bytes, so on NeedMore rewind
    // `pos` to the head and let the next call re-parse the whole token.
    // Container heads have no body and push a frame instead, so their
    // progress is kept.
    const tokenStart = this.pos;
    const framesBefore = this.frames.length;
    try {
      this.parseToken();
    } catch (err) {
      if (err instanceof NeedMore) {
        if (this.frames.length === framesBefore) this.pos = tokenStart;
      }
      throw err;
    }
  }

  private parseToken(): void {
    const tokenStart = this.pos;
    const head = this.readHead();

    switch (head.major) {
      case 0:
        this.deliver(bigintToNumberOrBig(head.arg), tokenStart);
        return;
      case 1:
        this.deliver(bigintToNumberOrBig(-head.arg - 1n), tokenStart);
        return;
      case 2:
        if (head.indefinite) {
          this.frames.push(this.indefFrame('bstr-indef', head.start));
          return;
        }
        this.deliver(this.takeBody(head), tokenStart);
        return;
      case 3:
        if (head.indefinite) {
          this.frames.push(this.indefFrame('tstr-indef', head.start));
          return;
        }
        this.deliver(this.readTextBody(head), tokenStart);
        return;
      case 4:
        this.frames.push(head.indefinite
          ? this.containerFrame('array', head.start, -1)
          : this.containerFrame('array', head.start, this.safeLength(head.arg, 'array length', head.start)));
        return;
      case 5:
        this.frames.push(head.indefinite
          ? this.containerFrame('map', head.start, -1)
          : this.containerFrame('map', head.start, this.safeLength(head.arg, 'map length', head.start)));
        return;
      case 6:
        this.frames.push({
          kind: 'tag',
          start: head.start,
          remaining: 1,
          expectKey: false,
          items: [],
          keys: [],
          keyRaw: [],
          chunks: [],
          chunkStarts: [],
          tag: head.arg,
        });
        return;
      case 7:
        if (head.indefinite) {
          this.fail('BREAK_IN_VALUE', 'unexpected break code 0xff outside an indefinite container', head.start);
        }
        this.deliver(this.parseSimple(head), tokenStart);
        return;
    }
  }

  private indefFrame(kind: FrameKind, start: number): Frame {
    return {
      kind,
      start,
      remaining: -1,
      expectKey: false,
      items: [],
      keys: [],
      keyRaw: [],
      chunks: [],
      chunkStarts: [],
      tag: 0n,
    };
  }

  private containerFrame(kind: 'array' | 'map', start: number, count: number): Frame {
    return {
      kind,
      start,
      remaining: count,
      expectKey: kind === 'map',
      items: [],
      keys: [],
      keyRaw: [],
      chunks: [],
      chunkStarts: [],
      tag: 0n,
    };
  }

  /**
   * Deliver a completed value to its enclosing frame (or finish the
   * top-level value). `tokenStart` is where this value's own head began,
   * allowing map keys to capture their exact raw bytes.
   */
  private deliver(value: unknown, tokenStart: number): void {
    const parent = this.frames[this.frames.length - 1];
    if (!parent) {
      this.result = value;
      this.topLevelDone = true;
      return;
    }

    if (parent.kind === 'array') {
      parent.items.push(value);
      if (parent.remaining > 0) parent.remaining -= 1;
      this.closeIfComplete(parent);
      return;
    }
    if (parent.kind === 'map') {
      if (parent.expectKey) {
        parent.keys.push(value);
        parent.keyRaw.push(this.buf.slice(tokenStart, this.pos));
        parent.expectKey = false;
      } else {
        parent.items.push(value);
        parent.expectKey = true;
        if (parent.remaining > 0) parent.remaining -= 1;
      }
      this.closeIfComplete(parent);
      return;
    }
    if (parent.kind === 'tag') {
      const tagged = new CborTag(bigintToNumberOrBig(parent.tag), value);
      const tagStart = parent.start;
      this.frames.pop();
      this.deliver(tagged, tagStart);
      return;
    }
    this.fail('INVALID_INDEFINITE_CHUNK', 'invalid state: scalar delivered into a string frame');
  }

  private closeIfComplete(frame: Frame): void {
    if (frame.remaining !== 0) return;
    if (frame.kind === 'array') {
      const value = frame.items;
      const start = frame.start;
      this.frames.pop();
      this.deliver(value, start);
      return;
    }
    if (frame.kind === 'map' && frame.expectKey) {
      const value = this.buildMap(frame);
      const start = frame.start;
      this.frames.pop();
      this.deliver(value, start);
    }
  }

  private tryCompleteFinished(frame: Frame): boolean {
    if (frame.remaining !== 0) return false;
    if (frame.kind === 'array') {
      const value = frame.items;
      const start = frame.start;
      this.frames.pop();
      this.deliver(value, start);
      return true;
    }
    if (frame.kind === 'map' && frame.expectKey) {
      const value = this.buildMap(frame);
      const start = frame.start;
      this.frames.pop();
      this.deliver(value, start);
      return true;
    }
    return false;
  }

  /** Close an indefinite array/map after its break byte was consumed. */
  private finishContainer(frame: Frame): void {
    const value = frame.kind === 'array' ? frame.items : this.buildMap(frame);
    const start = frame.start;
    this.frames.pop();
    this.deliver(value, start);
  }

  /** Read one chunk (or the terminating break) of an indefinite string. */
  private stepIndefiniteString(frame: Frame): void {
    this.need(1);
    if (this.buf[this.pos] === 0xff) {
      this.pos += 1;
      this.finishIndefiniteString(frame);
      return;
    }
    const expectedMajor = frame.kind === 'bstr-indef' ? 2 : 3;
    const chunkHeadStart = this.pos;
    const chunkHead = this.readHead();
    if (chunkHead.major !== expectedMajor || chunkHead.indefinite) {
      this.fail(
        'INVALID_INDEFINITE_CHUNK',
        `indefinite ${expectedMajor === 2 ? 'byte' : 'text'} string contains an invalid chunk`,
        chunkHeadStart,
      );
    }
    const bodyStart = this.pos;
    const body = this.takeBody(chunkHead);
    frame.chunkStarts.push(bodyStart);
    frame.chunks.push(body);
  }

  private finishIndefiniteString(frame: Frame): void {
    const all = concatChunks(frame.chunks);
    if (frame.kind === 'tstr-indef') {
      const bad = findInvalidUtf8(all);
      if (bad !== -1) {
        let local = bad;
        let i = 0;
        while (i < frame.chunks.length && local >= frame.chunks[i]!.length) {
          local -= frame.chunks[i]!.length;
          i += 1;
        }
        const index = i < frame.chunkStarts.length
          ? frame.chunkStarts[i]! + local
          : this.pos;
        this.fail('INVALID_UTF8', 'invalid UTF-8 sequence in text string', index);
      }
    }
    const value = frame.kind === 'bstr-indef' ? all : decodeUtf8(all);
    const start = frame.start;
    this.frames.pop();
    this.deliver(value, start);
  }

  // -------------------------------------------------------------- bodies --

  private takeBody(head: Head): Uint8Array {
    const n = this.safeLength(head.arg, 'string length', head.start);
    this.need(n); // atomic: advance only once the whole body is present
    const copy = new Uint8Array(n);
    copy.set(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return copy;
  }

  private readTextBody(head: Head): string {
    const bodyStart = this.pos;
    const bytes = this.takeBody(head);
    const bad = findInvalidUtf8(bytes);
    if (bad !== -1) {
      this.fail('INVALID_UTF8', 'invalid UTF-8 sequence in text string', bodyStart + bad);
    }
    return decodeUtf8(bytes);
  }

  private parseSimple(head: Head): unknown {
    const ai = this.buf[head.start]! & 0x1f;
    if (head.arg === 20n) return false;
    if (head.arg === 21n) return true;
    if (head.arg === 22n) return null;
    if (head.arg === 23n) return undefined;
    const payload = head.start + 1; // right after the leading byte
    if (ai === 25) {
      const bits = ((this.buf[payload]! << 8) | this.buf[payload + 1]!) >>> 0;
      return float16BitsToNumber(bits);
    }
    if (ai === 26) return readFloat(this.buf, payload, 4);
    if (ai === 27) return readFloat(this.buf, payload, 8);
    return new CborSimple(Number(head.arg));
  }

  private safeLength(arg: bigint, what: string, index: number): number {
    if (arg > Number.MAX_SAFE_INTEGER) {
      this.fail('UNSAFE_LENGTH', `${what} ${arg} exceeds the safe integer range`, index);
    }
    return Number(arg);
  }

  private buildMap(frame: Frame): Map<unknown, unknown> {
    const map = new Map<unknown, unknown>();
    const seen = this.rejectDuplicateKeys ? new Set<string>() : null;
    for (let i = 0; i < frame.keys.length; i++) {
      if (seen) {
        const digest = keyDigest(frame.keyRaw[i]!);
        if (seen.has(digest)) {
          this.fail('DUPLICATE_KEY_DECODE', 'duplicate key in CBOR map (equal encoded bytes)', frame.start);
        }
        seen.add(digest);
      }
      map.set(frame.keys[i], frame.items[i]);
    }
    return map;
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Length-prefixed raw-byte digest for encoded-key equivalence. */
function keyDigest(bytes: Uint8Array): string {
  let s = `${bytes.length}:`;
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

function bigintToNumberOrBig(v: bigint): number | bigint {
  if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(v);
  }
  return v;
}

const floatView = new DataView(new ArrayBuffer(8));
function readFloat(buf: Uint8Array, offset: number, width: number): number {
  for (let i = 0; i < width; i++) floatView.setUint8(i, buf[offset + i]!);
  return width === 4 ? floatView.getFloat32(0) : floatView.getFloat64(0);
}
