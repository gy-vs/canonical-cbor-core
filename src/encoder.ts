/**
 * CBOR (RFC 8949) encoder.
 *
 * Two modes:
 * - normal (`canonical: false`): definite-length encoding of every value;
 *   numbers are integers when they are safe integers, otherwise float64.
 * - canonical (`canonical: true`): shortest integer arguments, shortest
 *   floating-point representation, deterministic map key ordering and
 *   rejection of duplicate keys.
 */
import { CborError } from './errors.js';
import { numberToFloat16BitsOrNone } from './float16.js';
import { CborSimple, CborTag } from './tag.js';
import type { EncodeOptions } from './types.js';

const INITIAL_CAPACITY = 64;
const MAX_UINT = 0xffffffffffffffffn;

/** Growable byte sink backed by a DataView. */
class Writer {
  u8 = new Uint8Array(INITIAL_CAPACITY);
  dv = new DataView(this.u8.buffer);
  pos = 0;

  ensure(extra: number): void {
    const needed = this.pos + extra;
    if (needed <= this.u8.length) return;
    let capacity = this.u8.length;
    while (capacity < needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.u8);
    this.u8 = next;
    this.dv = new DataView(next.buffer);
  }

  byte(b: number): void {
    this.ensure(1);
    this.dv.setUint8(this.pos++, b);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.u8.set(b, this.pos);
    this.pos += b.length;
  }
}

/** Encode a CBOR head: major type plus argument. */
function writeHead(w: Writer, major: number, arg: number | bigint): void {
  const ai = typeof arg === 'bigint' ? arg : BigInt(arg);
  const lead = major << 5;
  if (ai < 0n) throw new CborError('UNENCODABLE_VALUE', `negative head argument: ${ai}`);
  if (ai < 24n) {
    w.byte(lead | Number(ai));
  } else if (ai <= 0xffn) {
    w.byte(lead | 24);
    w.byte(Number(ai));
  } else if (ai <= 0xffffn) {
    w.ensure(3);
    w.dv.setUint8(w.pos++, lead | 25);
    w.dv.setUint16(w.pos, Number(ai));
    w.pos += 2;
  } else if (ai <= 0xffffffffn) {
    w.ensure(5);
    w.dv.setUint8(w.pos++, lead | 26);
    w.dv.setUint32(w.pos, Number(ai));
    w.pos += 4;
  } else if (ai <= MAX_UINT) {
    w.ensure(9);
    w.dv.setUint8(w.pos++, lead | 27);
    w.dv.setBigUint64(w.pos, ai);
    w.pos += 8;
  } else {
    throw new CborError('BIGINT_OUT_OF_RANGE', `argument exceeds uint64: ${ai}`);
  }
}

function writeFloat32(w: Writer, value: number): void {
  w.ensure(5);
  w.dv.setUint8(w.pos++, 0xfa);
  w.dv.setFloat32(w.pos, value);
  w.pos += 4;
}

function writeFloat64(w: Writer, value: number): void {
  w.ensure(9);
  w.dv.setUint8(w.pos++, 0xfb);
  w.dv.setFloat64(w.pos, value);
  w.pos += 8;
}

/** Canonical float: shortest f16/f32/f64 representation that round-trips. */
function writeCanonicalFloat(w: Writer, value: number): void {
  const f16 = numberToFloat16BitsOrNone(value);
  if (f16 !== null) {
    w.ensure(3);
    w.dv.setUint8(w.pos++, 0xf9);
    w.dv.setUint16(w.pos, f16);
    w.pos += 2;
    return;
  }
  const f32 = Math.fround(value);
  if (Object.is(f32, value)) {
    writeFloat32(w, value);
    return;
  }
  writeFloat64(w, value);
}

interface MapEntry {
  keyBytes: Uint8Array;
  key: unknown;
  value: unknown;
}

class Encoder {
  private readonly canonical: boolean;
  private readonly active = new Set<object>();

  constructor(canonical: boolean) {
    this.canonical = canonical;
  }

  encode(value: unknown): Uint8Array {
    const w = new Writer();
    this.writeValue(w, value);
    return w.u8.subarray(0, w.pos);
  }

  private writeValue(w: Writer, value: unknown): void {
    if (value === null) {
      w.byte(0xf6);
      return;
    }
    if (value === undefined) {
      w.byte(0xf7);
      return;
    }
    switch (typeof value) {
      case 'boolean':
        w.byte(value ? 0xf5 : 0xf4);
        return;
      case 'number':
        this.writeNumber(w, value);
        return;
      case 'bigint':
        this.writeBigInt(w, value);
        return;
      case 'string':
        this.writeText(w, value);
        return;
      case 'object':
        this.writeObject(w, value);
        return;
      default:
        throw new CborError(
          'UNENCODABLE_VALUE',
          `values of type ${typeof value} cannot be encoded`,
        );
    }
  }

  private writeNumber(w: Writer, value: number): void {
    // -0 must remain a float: integer encoding would collapse it into +0.
    if (Object.is(value, -0)) {
      if (this.canonical) {
        w.ensure(3);
        w.dv.setUint8(w.pos++, 0xf9);
        w.dv.setUint16(w.pos, 0x8000);
        w.pos += 2;
      } else {
        writeFloat64(w, value);
      }
      return;
    }
    if (Number.isNaN(value)) {
      if (this.canonical) {
        w.ensure(3);
        w.dv.setUint8(w.pos++, 0xf9);
        w.dv.setUint16(w.pos, 0x7e00);
        w.pos += 2;
      } else {
        writeFloat64(w, value);
      }
      return;
    }
    if (Number.isSafeInteger(value)) {
      if (value >= 0) writeHead(w, 0, value);
      else writeHead(w, 1, -value - 1);
      return;
    }
    if (this.canonical) writeCanonicalFloat(w, value);
    else writeFloat64(w, value);
  }

  private writeBigInt(w: Writer, value: bigint): void {
    if (value >= 0n) {
      if (value <= MAX_UINT) writeHead(w, 0, value);
      else throw new CborError('BIGINT_OUT_OF_RANGE', `unsigned bigint exceeds uint64: ${value}`);
    } else {
      const encoded = -value - 1n;
      if (encoded <= MAX_UINT) writeHead(w, 1, encoded);
      else throw new CborError('BIGINT_OUT_OF_RANGE', `negative bigint exceeds int64: ${value}`);
    }
  }

  private writeText(w: Writer, value: string): void {
    // TextEncoder always produces UTF-8; its byte length is authoritative.
    const bytes = utf8Encode(value);
    writeHead(w, 3, bytes.length);
    w.bytes(bytes);
  }

  private writeObject(w: Writer, value: object): void {
    if (value instanceof Uint8Array) {
      writeHead(w, 2, value.length);
      w.bytes(value);
      return;
    }
    if (value instanceof ArrayBuffer) {
      const view = new Uint8Array(value);
      writeHead(w, 2, view.length);
      w.bytes(view);
      return;
    }
    if (ArrayBuffer.isView(value)) {
      throw new CborError(
        'UNENCODABLE_VALUE',
        `typed arrays other than Uint8Array cannot be encoded (got ${value.constructor.name})`,
      );
    }
    if (value instanceof CborTag) {
      let tag: bigint;
      try {
        tag = typeof value.tag === 'bigint' ? value.tag : BigInt(value.tag);
      } catch {
        throw new CborError('UNENCODABLE_VALUE', `tag number is not an integer: ${value.tag}`);
      }
      if (tag < 0n || tag > MAX_UINT) {
        throw new CborError('BIGINT_OUT_OF_RANGE', `tag number out of range: ${value.tag}`);
      }
      writeHead(w, 6, tag);
      this.enter(value, () => this.writeValue(w, value.value));
      return;
    }
    if (value instanceof CborSimple) {
      this.writeSimple(w, value.value);
      return;
    }
    if (Array.isArray(value)) {
      writeHead(w, 4, value.length);
      this.enter(value, () => {
        for (const item of value) this.writeValue(w, item);
      });
      return;
    }
    if (value instanceof Map) {
      this.writeMap(w, value, value);
      return;
    }
    // Plain object: own enumerable string-keyed properties. The original
    // object (not the Map view) is used for cycle detection.
    {
      const obj = value as Record<string, unknown>;
      const map = new Map<string, unknown>();
      for (const key of Object.keys(obj)) map.set(key, obj[key]);
      this.writeMap(w, map, value);
    }
  }

  private writeSimple(w: Writer, raw: number): void {
    if (!Number.isInteger(raw) || raw < 0 || raw > 255) {
      throw new CborError('INVALID_SIMPLE_VALUE', `simple value out of range: ${raw}`);
    }
    // 20..23 are assigned (false/true/null/undefined) and must use their
    // dedicated one-byte forms; 24..31 are reserved.
    if (raw >= 20 && raw <= 23) {
      w.byte(0xf4 + (raw - 20));
      return;
    }
    if (raw >= 24 && raw <= 31) {
      throw new CborError('INVALID_SIMPLE_VALUE', `reserved simple value: ${raw}`);
    }
    if (raw < 24) {
      w.byte(0xe0 | raw);
    } else {
      w.byte(0xf8);
      w.byte(raw);
    }
  }

  private writeMap(w: Writer, map: Map<unknown, unknown>, guard: object): void {
    if (this.canonical) {
      const entries: MapEntry[] = [];
      for (const [key, val] of map) {
        // Keys are encoded with this encoder so a self-referential object
        // key (e.g. the map being its own key) triggers cycle detection
        // instead of overflowing the stack.
        const encodeKey = (): Uint8Array => this.encode(key);
        const keyBytes =
          key !== null && (typeof key === 'object' || typeof key === 'function')
            ? this.withGuarded(key, encodeKey)
            : encodeKey();
        entries.push({ keyBytes, key, value: val });
      }
      // Length-lexicographic ordering of the encoded keys.
      entries.sort((a, b) => compareEncodedKeys(a.keyBytes, b.keyBytes));
      for (let i = 1; i < entries.length; i++) {
        if (compareEncodedKeys(entries[i - 1]!.keyBytes, entries[i]!.keyBytes) === 0) {
          throw new CborError(
            'DUPLICATE_KEY',
            'canonical encoding rejected a duplicate map key',
          );
        }
      }
      writeHead(w, 5, entries.length);
      this.enter(guard, () => {
        for (const entry of entries) {
          w.bytes(entry.keyBytes);
          this.writeValue(w, entry.value);
        }
      });
    } else {
      writeHead(w, 5, map.size);
      this.enter(guard, () => {
        for (const [key, val] of map) this.writeValue(w, key), this.writeValue(w, val);
      });
    }
  }

  /** Run `fn` with cycle detection for the given container. */
  private enter(node: object, fn: () => void): void {
    if (this.active.has(node)) {
      throw new CborError('CYCLE_DETECTED', 'cyclic value cannot be CBOR-encoded');
    }
    this.active.add(node);
    try {
      fn();
    } finally {
      this.active.delete(node);
    }
  }

  /** Run `fn` with the key marked active for cycle detection. */
  private withGuarded(key: object, fn: () => Uint8Array): Uint8Array {
    if (this.active.has(key)) {
      throw new CborError('CYCLE_DETECTED', 'cyclic map key cannot be CBOR-encoded');
    }
    this.active.add(key);
    try {
      return fn();
    } finally {
      this.active.delete(key);
    }
  }
}

const encoderCache = new TextEncoder();
function utf8Encode(value: string): Uint8Array {
  return encoderCache.encode(value);
}

/** Compare encoded CBOR keys: first by length, then lexicographically. */
export function compareEncodedKeys(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  const length = a.length;
  for (let i = 0; i < length; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Encode a value to CBOR bytes. */
export function encode(value: unknown, options: EncodeOptions = {}): Uint8Array {
  return new Encoder(options.canonical === true).encode(value);
}
