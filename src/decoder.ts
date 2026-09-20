import { CborError, NeedMoreDataError } from './errors.js';
import {
  MAJOR_ARRAY,
  MAJOR_BYTES,
  MAJOR_MAP,
  MAJOR_NINT,
  MAJOR_SIMPLE,
  MAJOR_TAG,
  MAJOR_TEXT,
  MAJOR_UINT,
} from './encoder.js';
import { decodeHalf } from './half.js';
import { Simple, Tagged } from './tagged.js';

const BREAK = 0xff;
const INDEFINITE = 31;

export interface DecodeOptions {
  /** Maximum nesting depth for arrays, maps and tags. Default: 100. */
  maxDepth?: number;
  /** Reject maps containing duplicate keys (compared by encoded bytes). Default: false. */
  rejectDuplicateKeys?: boolean;
  /** Reject unassigned CBOR simple values instead of returning `Simple`. Default: true. */
  rejectUnknownSimple?: boolean;
  /**
   * Reject non-minimal integer/head arguments (e.g. 18 01 for 1).
   * Default: false — such encodings are accepted by a generic CBOR
   * decoder; canonical CBOR requires them to be rejected.
   */
  rejectNonMinimal?: boolean;
}

export interface DecodedOne {
  value: unknown;
  /** Bytes consumed from the front of the current buffered data. */
  bytesConsumed: number;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Incremental CBOR decoder.
 *
 * Feed arbitrary, arbitrarily-chunked `Uint8Array` pieces with `write()`
 * and call `decode()` to pull one top-level value at a time.
 *
 * - Not enough buffered? `NeedMoreDataError` (transient) — feed more and retry.
 * - Structurally invalid? `CborError` (permanent) — the decoder rolls back
 *   to the start of the offending value: bytes of following top-level
 *   values are never consumed.
 */
export class Decoder {
  private buf = new Uint8Array(0);
  private len = 0;
  private pos = 0;
  private depth = 0;
  private totalConsumed = 0;
  private readonly maxDepth: number;
  private readonly rejectDuplicateKeys: boolean;
  private readonly rejectUnknownSimple: boolean;
  private readonly rejectNonMinimal: boolean;

  constructor(options: DecodeOptions = {}) {
    this.maxDepth = options.maxDepth ?? 100;
    this.rejectDuplicateKeys = options.rejectDuplicateKeys ?? false;
    this.rejectUnknownSimple = options.rejectUnknownSimple ?? true;
    this.rejectNonMinimal = options.rejectNonMinimal ?? false;
  }

  /** Append a chunk. The chunk is copied; the caller may reuse the buffer. */
  write(chunk: Uint8Array): this {
    if (chunk.length === 0) return this;
    if (this.len + chunk.length > this.buf.length) {
      let cap = Math.max(64, this.buf.length);
      while (cap < this.len + chunk.length) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    return this;
  }

  /** Number of bytes currently buffered (including not-yet-decoded data). */
  get bufferedLength(): number {
    return this.len;
  }

  /** Total bytes successfully consumed since construction (or `reset()`). */
  get bytesConsumedTotal(): number {
    return this.totalConsumed;
  }

  /**
   * Decode one top-level value from the buffered data.
   *
   * On success the value's bytes are removed; use `remainingBytes()` for
   * anything left (e.g. a second value or an incomplete tail).
   */
  decode(): DecodedOne {
    const start = this.pos;
    this.depth = 0;
    let value: unknown;
    try {
      value = this.readValue('$');
    } catch (e) {
      // Roll back to the start of this top-level value. On a permanent
      // error the bytes are deliberately retained (the caller can inspect
      // or `skip()` them); bytes of following values are never consumed.
      // On truncation the retained bytes are exactly what is needed to
      // resume once more data is written.
      this.pos = start;
      throw e;
    }
    const consumed = this.pos - start;
    this.totalConsumed += consumed;
    this.compact();
    return { value, bytesConsumed: consumed };
  }

  private compact(): void {
    if (this.pos === 0) return;
    const rest = this.len - this.pos;
    if (rest > 0) {
      this.buf.copyWithin(0, this.pos, this.len);
    }
    this.len = rest;
    this.pos = 0;
  }

  /** Discard buffered bytes from the front (e.g. skip a poisoned value). */
  skip(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > this.len) {
      throw new RangeError(`skip(${n}) out of range, have ${this.len} bytes`);
    }
    this.pos = n;
    this.compact();
  }

  /** Copy of the bytes currently waiting to be decoded. */
  remainingBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  /** Remove every buffered byte and reset the consumption counter. */
  reset(): void {
    this.buf = new Uint8Array(0);
    this.len = 0;
    this.pos = 0;
    this.depth = 0;
    this.totalConsumed = 0;
  }

  // ---- low level -------------------------------------------------------

  private need(n: number, topStart: number): void {
    if (this.pos + n > this.len) {
      throw new NeedMoreDataError(this.pos, this.pos - topStart);
    }
  }

  private readU8(topStart: number): number {
    this.need(1, topStart);
    return this.buf[this.pos++];
  }

  private takeBytes(n: number, topStart: number): Uint8Array {
    this.need(n, topStart);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  private malformed(message: string, topStart: number, at: number = this.pos): never {
    throw new CborError({
      code: 'malformed',
      offset: at,
      valueOffset: at - topStart,
      message,
    });
  }

  /**
   * Read an initial byte and its argument.
   * Returns `[major, ai, arg]`; `arg` is null for ai=31 (indefinite/break).
   */
  private readHead(topStart: number): [number, number, number | bigint | null] {
    const at = this.pos;
    const ib = this.readU8(topStart);
    const major = ib >> 5;
    const ai = ib & 0x1f;
    switch (ai) {
      case 24: {
        const v = this.readU8(topStart);
        // Minimal-argument rule does not apply to one-byte simple values
        // in major 7 (f8 01 == simple(1) is non-preferred but legal).
        if (this.rejectNonMinimal && major !== MAJOR_SIMPLE && v < 24) {
          this.malformed('non-minimal one-byte argument', topStart, at);
        }
        return [major, ai, v];
      }
      case 25: {
        this.need(2, topStart);
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 2);
        const v = dv.getUint16(0, false);
        this.pos += 2;
        // ai 25 in major 7 is a half-float: no integer-minimality rule.
        if (this.rejectNonMinimal && major !== MAJOR_SIMPLE && v <= 0xff) {
          this.malformed('non-minimal two-byte argument', topStart, at);
        }
        return [major, ai, v];
      }
      case 26: {
        this.need(4, topStart);
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
        const v = dv.getUint32(0, false);
        this.pos += 4;
        if (this.rejectNonMinimal && major !== MAJOR_SIMPLE && v <= 0xffff) {
          this.malformed('non-minimal four-byte argument', topStart, at);
        }
        return [major, ai, v];
      }
      case 27: {
        this.need(8, topStart);
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
        const v = dv.getBigUint64(0, false);
        this.pos += 8;
        if (this.rejectNonMinimal && major !== MAJOR_SIMPLE && v <= 0xffffffffn) {
          this.malformed('non-minimal eight-byte argument', topStart, at);
        }
        return [major, ai, v];
      }
      case 28:
      case 29:
      case 30:
        this.malformed(`reserved additional information ${ai}`, topStart, at);
      case INDEFINITE:
        return [major, ai, null];
      default:
        return [major, ai, ai];
    }
  }

  private readValue(path: string, topStart?: number): unknown {
    const ts = topStart ?? this.pos;
    try {
      return this.readValueInner(path, ts);
    } catch (e) {
      if (e instanceof CborError && e.path === undefined) {
        throw new CborError({
          code: e.code,
          offset: e.offset,
          ...(e.valueOffset !== undefined ? { valueOffset: e.valueOffset } : {}),
          path,
          message: e.message,
        });
      }
      throw e;
    }
  }

  private readValueInner(path: string, ts: number): unknown {
    const [major, ai, arg] = this.readHead(ts);
    switch (major) {
      case MAJOR_UINT:
        if (ai === INDEFINITE) this.malformed('indefinite length on integer', ts, ts);
        // CBOR integers are returned as bigint (they span 64+ bits via
        // tags 2/3); callers can Number() values they know to be safe.
        return typeof arg === 'bigint' ? arg : BigInt(arg as number);
      case MAJOR_NINT: {
        if (ai === INDEFINITE) this.malformed('indefinite length on negative integer', ts, ts);
        const a = typeof arg === 'bigint' ? arg : BigInt(arg as number);
        return -1n - a;
      }
      case MAJOR_BYTES:
        return this.readBytes(ai, arg, ts);
      case MAJOR_TEXT:
        return this.readText(ai, arg, ts);
      case MAJOR_ARRAY:
        return this.readArray(ai, arg, ts, path);
      case MAJOR_MAP:
        return this.readMap(ai, arg, ts, path);
      case MAJOR_TAG:
        return this.readTag(ai, arg, ts, path);
      case MAJOR_SIMPLE:
        return this.readSimple(ai, arg, ts);
      default:
        this.malformed(`unknown major type ${major}`, ts);
    }
  }

  private countOf(arg: number | bigint | null, topStart: number): number {
    if (typeof arg === 'bigint') {
      if (arg > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new CborError({
          code: 'unsupported',
          offset: this.pos,
          valueOffset: this.pos - topStart,
          message: `container length ${arg} exceeds safe integer range`,
        });
      }
      return Number(arg);
    }
    return arg as number;
  }

  private enterContainer(topStart: number): void {
    if (this.depth >= this.maxDepth) {
      throw new CborError({
        code: 'depth',
        offset: this.pos,
        valueOffset: this.pos - topStart,
        message: `nesting depth exceeds limit of ${this.maxDepth}`,
      });
    }
    this.depth += 1;
  }

  private readBytes(
    ai: number,
    arg: number | bigint | null,
    topStart: number,
    rejectIndefinite = false,
  ): Uint8Array {
    if (ai === INDEFINITE) {
      if (rejectIndefinite) this.malformed('expected a definite-length byte string', topStart);
      return this.readIndefiniteChunks(MAJOR_BYTES, topStart);
    }
    return this.takeBytes(this.countOf(arg, topStart), topStart);
  }

  private readIndefiniteChunks(
    major: number,
    topStart: number,
    onChunk?: (chunk: Uint8Array, chunkEnd: number) => void,
  ): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const at = this.pos;
      this.need(1, topStart);
      const b = this.buf[this.pos];
      if (b === BREAK) {
        this.pos += 1;
        return concatParts(parts, total);
      }
      const [cm, cai, carg] = this.readHead(topStart);
      if (cm !== major) {
        this.malformed(`indefinite ${major === MAJOR_BYTES ? 'byte' : 'text'} string contains major type ${cm}`, topStart, at);
      }
      if (cai === INDEFINITE) {
        this.malformed('nested indefinite-length string chunk is not allowed', topStart, at);
      }
      const chunk = this.takeBytes(this.countOf(carg, topStart), topStart);
      if (onChunk) onChunk(chunk, this.pos);
      parts.push(chunk);
      total += chunk.length;
    }
  }

  private readText(ai: number, arg: number | bigint | null, topStart: number): string {
    if (ai === INDEFINITE) {
      // RFC 8949 §3.2.3: every indefinite text chunk must itself be
      // well-formed UTF-8 (a character may not straddle chunks). Chunks
      // are validated as they arrive.
      const raw = this.readIndefiniteChunks(MAJOR_TEXT, topStart, (chunk, chunkEnd) => {
        try {
          chunkUtf8Decoder.decode(chunk, { stream: false });
        } catch {
          throw new CborError({
            code: 'utf8',
            offset: chunkEnd - chunk.length,
            valueOffset: chunkEnd - chunk.length - topStart,
            message: 'indefinite text chunk is not well-formed UTF-8 in isolation',
          });
        }
      });
      return utf8Decoder.decode(raw);
    }
    const raw = this.takeBytes(this.countOf(arg, topStart), topStart);
    try {
      // Single-shot decode of the fully assembled bytes: multibyte UTF-8
      // sequences split across transport feeds validate naturally here.
      return utf8Decoder.decode(raw);
    } catch {
      throw new CborError({
        code: 'utf8',
        offset: topStart,
        valueOffset: 0,
        message: 'invalid UTF-8 sequence in text string',
      });
    }
  }

  private readArray(
    ai: number,
    arg: number | bigint | null,
    topStart: number,
    path: string,
  ): unknown[] {
    this.enterContainer(topStart);
    try {
      const out: unknown[] = [];
      if (ai === INDEFINITE) {
        for (;;) {
          if (this.isBreak(topStart)) {
            this.pos += 1;
            return out;
          }
          out.push(this.readValue(`${path}[${out.length}]`, topStart));
        }
      }
      const count = this.countOf(arg, topStart);
      for (let i = 0; i < count; i++) {
        out.push(this.readValue(`${path}[${i}]`, topStart));
      }
      return out;
    } finally {
      this.depth -= 1;
    }
  }

  private readMap(
    ai: number,
    arg: number | bigint | null,
    topStart: number,
    path: string,
  ): Map<unknown, unknown> {
    this.enterContainer(topStart);
    try {
      const out = new Map<unknown, unknown>();
      const seen: Uint8Array[] = [];
      const put = (keyBytes: Uint8Array, key: unknown, value: unknown): void => {
        if (this.rejectDuplicateKeys) {
          for (const s of seen) {
            if (s.length === keyBytes.length && arrayEqual(s, keyBytes)) {
              throw new CborError({
                code: 'duplicate-key',
                offset: this.pos,
                valueOffset: this.pos - topStart,
                path,
                message: 'duplicate map key (compared by encoded key bytes)',
              });
            }
          }
        }
        seen.push(keyBytes);
        out.set(key, value);
      };

      if (ai === INDEFINITE) {
        for (;;) {
          if (this.isBreak(topStart)) {
            this.pos += 1;
            return out;
          }
          const { bytes: kb, value: key } = this.readKeyValue(topStart, path);
          const value = this.readValue(`${path}.<value>`, topStart);
          put(kb, key, value);
        }
      }
      const count = this.countOf(arg, topStart);
      for (let i = 0; i < count; i++) {
        const { bytes: kb, value: key } = this.readKeyValue(topStart, path);
        const value = this.readValue(`${path}[${i}]`, topStart);
        put(kb, key, value);
      }
      return out;
    } finally {
      this.depth -= 1;
    }
  }

  private readKeyValue(topStart: number, path: string): { bytes: Uint8Array; value: unknown } {
    const before = this.pos;
    const value = this.readValue(`${path}.<key>`, topStart);
    return { bytes: this.buf.slice(before, this.pos), value };
  }

  private isBreak(topStart: number): boolean {
    this.need(1, topStart);
    return this.buf[this.pos] === BREAK;
  }

  private readTag(
    ai: number,
    arg: number | bigint | null,
    topStart: number,
    path: string,
  ): unknown {
    if (ai === INDEFINITE) this.malformed('tag number must be definite', topStart);
    const tag = typeof arg === 'bigint' ? arg : BigInt(arg as number);
    if (tag === 2n || tag === 3n) {
      // Standard bignum tags: byte string payload decodes to a bigint.
      this.need(1, topStart);
      if ((this.buf[this.pos] >> 5) === MAJOR_BYTES) {
        const [, pai, parg] = this.readHead(topStart);
        const payload = this.readBytes(pai, parg, topStart, true);
        return decodeBignum(tag === 3n, payload);
      }
      // Non-byte-string content: fall through and preserve as Tagged.
    }
    this.enterContainer(topStart);
    try {
      const content = this.readValue(`${path}#tag`, topStart);
      return new Tagged(normalizeTag(tag), content);
    } finally {
      this.depth -= 1;
    }
  }

  private readSimple(
    ai: number,
    arg: number | bigint | null,
    topStart: number,
  ): unknown {
    if (ai === INDEFINITE) {
      // 0xff is a break code, only legal inside indefinite containers;
      // seeing it as a value means a stray break.
      this.malformed('unexpected break code outside indefinite container', topStart, this.pos - 1);
    }
    switch (ai) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 23:
        return undefined;
      case 24: {
        const v = arg as number;
        if (v < 32) this.malformed(`reserved simple value ${v}`, topStart, topStart + 1);
        if (v >= 32 && v <= 255 && this.rejectUnknownSimple) {
          this.malformed(`unassigned simple value ${v}`, topStart);
        }
        return new Simple(v);
      }
      case 25: {
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos - 2, 2);
        const bits = dv.getUint16(0, false);
        return decodeHalf(bits);
      }
      case 26: {
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos - 4, 4);
        return dv.getFloat32(0, false);
      }
      case 27: {
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos - 8, 8);
        return dv.getFloat64(0, false);
      }
      default:
        // ai 0..19 are unassigned simple values 0..19
        if (this.rejectUnknownSimple) {
          this.malformed(`unassigned simple value ${ai}`, topStart, this.pos - 1);
        }
        return new Simple(ai);
    }
  }
}

function concatParts(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const chunkUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function arrayEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizeTag(tag: bigint): number | bigint {
  return tag <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(tag) : tag;
}

function decodeBignum(negative: boolean, payload: Uint8Array): bigint {
  // An empty byte string is a legal zero magnitude (RFC 8949 §3.4.3).
  let mag = 0n;
  for (const b of payload) mag = (mag << 8n) | BigInt(b);
  return negative ? -1n - mag : mag;
}

/** Decode exactly one CBOR value; reject trailing bytes. */
export function decode(data: Uint8Array, options?: DecodeOptions): unknown {
  const d = new Decoder(options);
  d.write(data);
  const { value, bytesConsumed } = d.decode();
  if (d.bufferedLength !== 0) {
    throw new CborError({
      code: 'malformed',
      offset: bytesConsumed,
      valueOffset: bytesConsumed,
      message: `${d.bufferedLength} trailing byte(s) after top-level value`,
    });
  }
  return value;
}

/** Decode every top-level value in a complete buffer. Throws on a truncated tail. */
export function decodeAll(data: Uint8Array, options?: DecodeOptions): unknown[] {
  const d = new Decoder(options);
  d.write(data);
  const values: unknown[] = [];
  for (;;) {
    if (d.bufferedLength === 0) return values;
    const { value } = d.decode();
    values.push(value);
  }
}
