import { CborError } from './errors.js';
import { encodeHalfExact } from './half.js';
import { Simple, Tagged } from './tagged.js';

export const MAJOR_UINT = 0;
export const MAJOR_NINT = 1;
export const MAJOR_BYTES = 2;
export const MAJOR_TEXT = 3;
export const MAJOR_ARRAY = 4;
export const MAJOR_MAP = 5;
export const MAJOR_TAG = 6;
export const MAJOR_SIMPLE = 7;

const U64_MAX = 0xffffffffffffffffn;

/** Growable byte sink. */
class ByteWriter {
  buf: Uint8Array;
  length = 0;

  constructor(initial = 64) {
    this.buf = new Uint8Array(initial);
  }

  private ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.buf.length) return;
    let cap = this.buf.length || 64;
    while (cap < needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.length++] = v;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  head(major: number, arg: number | bigint): void {
    const a = typeof arg === 'bigint' ? arg : BigInt(arg);
    const prefix = major << 5;
    if (a < 24n) {
      this.u8(prefix | Number(a));
    } else if (a <= 0xffn) {
      this.u8(prefix | 24);
      this.u8(Number(a));
    } else if (a <= 0xffffn) {
      this.u8(prefix | 25);
      this.ensure(2);
      this.buf[this.length] = Number(a >> 8n);
      this.buf[this.length + 1] = Number(a & 0xffn);
      this.length += 2;
    } else if (a <= 0xffffffffn) {
      this.u8(prefix | 26);
      this.ensure(4);
      const dv = new DataView(this.buf.buffer, this.length, 4);
      dv.setUint32(0, Number(a), false);
      this.length += 4;
    } else if (a <= U64_MAX) {
      this.u8(prefix | 27);
      this.ensure(8);
      const dv = new DataView(this.buf.buffer, this.length, 8);
      dv.setBigUint64(0, a, false);
      this.length += 8;
    } else {
      throw new CborError({ code: 'unsupported', offset: this.length, message: `head argument ${a} exceeds 2^64-1` });
    }
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export interface EncodeOptions {
  /**
   * RFC 8949 canonical deterministic encoding:
   * - shortest integer and float representation
   * - definite-length containers only
   * - map keys sorted by encoded byte length, then unsigned byte order
   * - duplicate canonical keys rejected
   * - NaN normalized to f9 0xf97e00
   */
  canonical?: boolean;
}

const textEncoder = new TextEncoder();

/** Encode a value to a CBOR byte sequence (normal mode). */
export function encode(value: unknown, options: EncodeOptions = {}): Uint8Array {
  const canonical = options.canonical ?? false;
  const w = new ByteWriter();
  encodeValue(w, value, canonical, '$');
  return w.result();
}

function encodeValue(w: ByteWriter, value: unknown, canonical: boolean, path: string): void {
  if (value === null) {
    w.u8(0xf6);
    return;
  }
  if (value === undefined) {
    w.u8(0xf7);
    return;
  }

  switch (typeof value) {
    case 'boolean':
      w.u8(value ? 0xf5 : 0xf4);
      return;
    case 'number':
      encodeNumber(w, value, canonical);
      return;
    case 'bigint':
      encodeBigInt(w, value);
      return;
    case 'string':
      encodeText(w, value);
      return;
    case 'object':
      break;
    default:
      throw new CborError({
        code: 'unsupported',
        offset: w.length,
        path,
        message: `cannot encode value of type ${typeof value}`,
      });
  }

  if (value instanceof Uint8Array) {
    w.head(MAJOR_BYTES, value.length);
    w.bytes(value);
    return;
  }
  if (value instanceof Tagged) {
    // Bignum tags 2/3 carry a byte string magnitude in canonical form;
    // a bigint content is a lossless convenience representation. Inline
    // integer items (when the magnitude fits 64 bits) are emitted as a
    // tagged integer item to preserve round-trip fidelity; larger values
    // use the byte string bignum form.
    const tagNum = typeof value.tag === 'bigint' ? value.tag : BigInt(value.tag);
    if ((tagNum === 2n || tagNum === 3n) && typeof value.value === 'bigint') {
      w.u8(tagNum === 2n ? 0xc2 : 0xc3);
      encodeBignumContent(w, value.value, tagNum === 3n);
      return;
    }
    w.head(MAJOR_TAG, value.tag);
    encodeValue(w, value.value, canonical, `${path}#tag`);
    return;
  }
  if (value instanceof Simple) {
    if (value.value < 24) {
      w.u8((MAJOR_SIMPLE << 5) | value.value);
    } else {
      w.u8(0xf8);
      w.u8(value.value);
    }
    return;
  }
  if (Array.isArray(value)) {
    w.head(MAJOR_ARRAY, value.length);
    value.forEach((item, i) => encodeValue(w, item, canonical, `${path}[${i}]`));
    return;
  }
  if (value instanceof Map) {
    encodeMap(w, [...value.entries()], canonical, path);
    return;
  }
  if (isPlainObject(value)) {
    encodeMap(w, Object.entries(value as Record<string, unknown>), canonical, path);
    return;
  }

  throw new CborError({
    code: 'unsupported',
    offset: w.length,
    path,
    message: `cannot encode ${(value as object).constructor?.name ?? 'object'}`,
  });
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function encodeMap(
  w: ByteWriter,
  entries: [unknown, unknown][],
  canonical: boolean,
  path: string,
): void {
  if (canonical) {
    const encoded = entries.map(([k, v]) => {
      const kw = new ByteWriter();
      encodeValue(kw, k, true, `${path}<key>`);
      return { k, v, kb: kw.result() };
    });
    encoded.sort((a, b) => compareEncodedKeys(a.kb, b.kb));
    for (let i = 1; i < encoded.length; i++) {
      if (byteArraysEqual(encoded[i - 1].kb, encoded[i].kb)) {
        throw new CborError({
          code: 'duplicate-key',
          offset: w.length,
          path,
          message: `duplicate canonical map key: ${describeKey(encoded[i].k)}`,
        });
      }
    }
    w.head(MAJOR_MAP, encoded.length);
    encoded.forEach(({ kb, v }, i) => {
      w.bytes(kb);
      encodeValue(w, v, true, `${path}[${i}]`);
    });
  } else {
    w.head(MAJOR_MAP, entries.length);
    entries.forEach(([k, v], i) => {
      encodeValue(w, k, false, `${path}<key${i}>`);
      encodeValue(w, v, false, `${path}[${i}]`);
    });
  }
}

/** Shorter encoding first; equal lengths: unsigned lexicographic byte order. */
function compareEncodedKeys(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return (a[i] & 0xff) - (b[i] & 0xff);
  }
  return 0;
}

function byteArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function describeKey(k: unknown): string {
  if (typeof k === 'string') return JSON.stringify(k);
  if (typeof k === 'bigint') return `${k}n`;
  return String(k);
}

function encodeText(w: ByteWriter, s: string): void {
  if (hasLoneSurrogate(s)) {
    throw new CborError({
      code: 'utf8',
      offset: w.length,
      message: 'string contains an unpaired UTF-16 surrogate',
    });
  }
  const utf8 = textEncoder.encode(s);
  w.head(MAJOR_TEXT, utf8.length);
  w.bytes(utf8);
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function encodeBigInt(w: ByteWriter, v: bigint): void {
  if (v >= 0n) {
    if (v <= U64_MAX) {
      w.head(MAJOR_UINT, v);
    } else {
      // Bignum tag 2: byte string is the big-endian magnitude.
      w.u8(0xc2);
      encodeBigMagnitude(w, v);
    }
  } else {
    const arg = -1n - v; // v = -1 - arg
    if (arg <= U64_MAX) {
      w.head(MAJOR_NINT, arg);
    } else {
      // Bignum tag 3: negative, -1 - magnitude.
      w.u8(0xc3);
      encodeBigMagnitude(w, arg);
    }
  }
}

/**
 * Encode the content item of a bignum tag (2/3) whose content was given
 * as a bigint: a bare integer item when the magnitude fits 64 bits,
 * otherwise a big-endian byte string magnitude (RFC 8949 §3.4.3).
 */
function encodeBignumContent(w: ByteWriter, v: bigint, negative: boolean): void {
  // Preferred content for a tag-2/tag-3 value given as a bigint:
  //  - tag 2 with v >= 0, or tag 3 with v < 0 and a small magnitude:
  //    the matching inline integer item
  //  - otherwise (large magnitude or mismatched sign): the big-endian
  //    byte string magnitude defined by RFC 8949 §3.4.3
  if (!negative && v >= 0n) {
    if (v <= U64_MAX) w.head(MAJOR_UINT, v);
    else encodeBigMagnitude(w, v);
    return;
  }
  if (negative && v < 0n) {
    const mag = -1n - v;
    if (mag <= U64_MAX) w.head(MAJOR_NINT, mag);
    else encodeBigMagnitude(w, mag);
    return;
  }
  const mag = v < 0n ? -1n - v : v;
  encodeBigMagnitude(w, mag);
}

function encodeBigMagnitude(w: ByteWriter, mag: bigint): void {
  let m = mag;
  const out: number[] = [];
  while (m > 0n) {
    out.push(Number(m & 0xffn));
    m >>= 8n;
  }
  out.reverse();
  // Strip leading zero bytes (canonical minimal bignum); keep one byte
  // for magnitude zero.
  let start = 0;
  while (start < out.length - 1 && out[start] === 0) start++;
  const bytes = new Uint8Array(out.slice(start));
  w.head(MAJOR_BYTES, bytes.length);
  w.bytes(bytes);
}

function encodeNumber(w: ByteWriter, n: number, canonical: boolean): void {
  if (canonical) {
    if (Number.isNaN(n)) {
      writeHalf(w, 0x7e00);
      return;
    }
    if (Object.is(n, -0)) {
      writeHalf(w, 0x8000);
      return;
    }
    if (n === Infinity) {
      writeHalf(w, 0x7c00);
      return;
    }
    if (n === -Infinity) {
      writeHalf(w, 0xfc00);
      return;
    }
    // RFC 8949 §4.2.1: integer-valued floats are encoded as integers
    // only when the value fits the 64-bit argument range. Compare against
    // the exact f64-representable range edges (-2^64 and 2^64-1 rounds
    // to 2^64); BigInt(n) is unsafe for non-safe integers because it
    // reveals the decimal literal rather than the f64 value.
    if (Number.isInteger(n) && n > -18446744073709551616 && n < 18446744073709551616) {
      const bi = BigInt(n);
      if (bi >= 0n) {
        w.head(MAJOR_UINT, bi);
      } else {
        w.head(MAJOR_NINT, -1n - bi);
      }
      return;
      // Integer-valued doubles outside the 64-bit range stay floats
      // (bignum tags would change the decoded type).
    }
    const h = encodeHalfExact(n);
    if (h !== null) {
      writeHalf(w, h);
      return;
    }
    if (Math.fround(n) === n) {
      w.u8(0xfa);
      const dv = new DataView(new ArrayBuffer(4));
      dv.setFloat32(0, n, false);
      w.bytes(new Uint8Array(dv.buffer));
      return;
    }
    writeDouble(w, n);
    return;
  }

  // Normal mode: safe integers use minimal integer heads; -0 and other
  // non-integers (NaN, ±Infinity, fractions) are full 64-bit floats.
  if (Number.isSafeInteger(n) && !Object.is(n, -0)) {
    if (n >= 0) {
      w.head(MAJOR_UINT, n);
    } else {
      w.head(MAJOR_NINT, -1 - n);
    }
    return;
  }
  writeDouble(w, n);
}

function writeHalf(w: ByteWriter, bits: number): void {
  w.u8(0xf9);
  w.u8((bits >>> 8) & 0xff);
  w.u8(bits & 0xff);
}

function writeDouble(w: ByteWriter, n: number): void {
  w.u8(0xfb);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n, false);
  w.bytes(new Uint8Array(buf));
}
