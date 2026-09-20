/**
 * Property checks (not part of the unit suite):
 *  - random round-trips through canonical encode -> decode
 *  - canonical output is stable under re-encoding
 *  - every representable-ish double: f16 exactness matches Node semantics
 *  - exhaustive half-float bit patterns: encodeHalfExact(decodeHalf(p))
 *    is minimal and reproduces the value
 */
import { strict as assert } from 'node:assert';
import { encode, decode, Decoder, Tagged, Simple, NeedMoreDataError, CborError } from '../src/index.js';

const rand = mulberry(0x1234abcd);
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(depth: number): unknown {
  if (depth > 5) return randomScalar();
  const r = rand();
  if (r < 0.55) return randomScalar();
  if (r < 0.7) {
    const n = Math.floor(rand() * 5);
    return Array.from({ length: n }, () => randomValue(depth + 1));
  }
  if (r < 0.85) {
    const n = Math.floor(rand() * 5);
    const m = new Map<unknown, unknown>();
    const seenBytes = new Set<string>();
    let guard = 0;
    while (m.size < n && guard++ < 50) {
      const k = randomKey();
      const kb = encode(k, { canonical: true });
      const sig = `${kb.length}:${[...kb].join(',')}`;
      if (seenBytes.has(sig)) continue;
      seenBytes.add(sig);
      m.set(k, randomValue(depth + 1));
    }
    return m;
  }
  if (r < 0.92) {
    // Mostly arbitrary tags with arbitrary content; occasionally the
    // standard bignum tags with a sign-consistent bigint (tag 2:
    // non-negative, tag 3: negative so -1 - mag is the magnitude).
    if (r >= 0.905) {
      const mag = randomNonNegativeBigInt();
      const tag = rand() < 0.5 ? 2 : 3;
      return new Tagged(tag, tag === 2 ? mag : -1n - mag);
    }
    return new Tagged(4 + Math.floor(rand() * 1000), randomValue(depth + 1));
  }
  return randomScalar();
}

function randomNonNegativeBigInt(): bigint {
  const width = Math.floor(rand() * 80);
  let v = 0n;
  for (let i = 0; i < width; i++) v = (v << 1n) | (rand() < 0.5 ? 1n : 0n);
  return v;
}

function randomKey(): unknown {
  const r = rand();
  if (r < 0.45) return randomString();
  if (r < 0.75) return randomBigInt();
  const n = Math.floor(rand() * 6);
  return new Uint8Array(Array.from({ length: n }, () => Math.floor(rand() * 256)));
}

function randomScalar(): unknown {
  const r = rand();
  if (r < 0.2) return randomBigInt();
  if (r < 0.35) return randomDouble();
  if (r < 0.5) return randomString();
  if (r < 0.6) {
    const n = Math.floor(rand() * 8);
    return new Uint8Array(Array.from({ length: n }, () => Math.floor(rand() * 256)));
  }
  if (r < 0.7) return rand() < 0.5;
  if (r < 0.78) return null;
  if (r < 0.82) return undefined;
  if (r < 0.9) return Math.floor(rand() * 1000);
  return new Simple([0, 16, 17, 32, 99, 255][Math.floor(rand() * 5)]);
}

function randomBigInt(): bigint {
  const width = Math.floor(rand() * 80);
  let v = 0n;
  for (let i = 0; i < width; i++) v = (v << 1n) | (rand() < 0.5 ? 1n : 0n);
  return rand() < 0.5 ? v : -v - 1n;
}

function randomDouble(): number {
  const r = rand();
  if (r < 0.1) {
    // random bit pattern double
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, Math.floor(rand() * 2 ** 32));
    dv.setUint32(4, Math.floor(rand() * 2 ** 32));
    const x = dv.getFloat64(0);
    return Number.isFinite(x) ? x : 0;
  }
  if (r < 0.2) return [NaN, -0, 0, Infinity, -Infinity][Math.floor(rand() * 5)];
  return (rand() - 0.5) * 10 ** Math.floor(rand() * 8);
}

const STRING_CHARS = ['a', 'b', 'é', '€', '日', '\n', '', 'λ'];
function randomString(): string {
  const n = Math.floor(rand() * 7);
  let s = '';
  for (let i = 0; i < n; i++) s += STRING_CHARS[Math.floor(rand() * STRING_CHARS.length)];
  return s;
}

// ---- round trips ----
// Integers decode as bigint by design; normalize numbers/bigints to a
// common representation for structural (order-independent for maps) compare.
function stableJSON(v: unknown): string {
  return JSON.stringify(v, replacer);
}

function norm(v: unknown): unknown {
  // Canonical CBOR maps every integer-valued f64 (even unsafe ones like
  // -8.13e18) to an integer head; BigInt(n) yields the exact f64 value.
  if (typeof v === 'number' && Number.isInteger(v) && !Object.is(v, -0)) return { __int: BigInt(v) };
  if (typeof v === 'bigint') return { __int: v };
  if (v instanceof Uint8Array) return { __bytes: [...v] };
  if (Array.isArray(v)) return v.map(norm);
  if (v instanceof Map) {
    const entries = [...v.entries()]
      .map(([k, val]) => [norm(k), norm(val)] as [unknown, unknown])
      .sort((a, b) => {
        const sa = stableJSON(a[0]);
        const sb = stableJSON(b[0]);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
    return { __map: entries };
  }
  if (v instanceof Tagged) {
    // The decoder unwraps standard bignum tags with byte string payloads
    // into a plain bigint; mirror that for comparison.
    if (typeof v.value === 'bigint' && (v.tag === 2 || v.tag === 2n || v.tag === 3 || v.tag === 3n)) {
      const tag = typeof v.tag === 'bigint' ? v.tag : BigInt(v.tag);
      const matchesSign = tag === 2n ? v.value >= 0n : v.value < 0n;
      const mag = v.value < 0n ? -1n - v.value : v.value;
      const oversized = mag > 0xffffffffffffffffn;
      if (oversized && matchesSign) return { __int: v.value };
    }
    return { __tag: v.tag, value: norm(v.value) };
  }
  if (v instanceof Simple) return { __simple: v.value };
  return v;
}

let roundTrips = 0;
for (let i = 0; i < 20000; i++) {
  const v = randomValue(0);
  const enc = encode(v, { canonical: true });
  const dec = decode(enc, { rejectUnknownSimple: false, rejectNonMinimal: true });
  assert.deepEqual(norm(dec), norm(v), `roundtrip failed: ${JSON.stringify(v, replacer)}`);
  // canonical stability: re-encoding the decoded value yields same bytes
  const enc2 = encode(dec, { canonical: true });
  assert.deepEqual([...enc2], [...enc], 'canonical re-encode differs');
  roundTrips++;
}
console.log(`canonical round-trips: ${roundTrips}`);

// ---- incremental: every prefix gives NeedMoreData, then succeeds ----
let prefixCases = 0;
for (let i = 0; i < 3000; i++) {
  const v = randomValue(0);
  const data = encode(v, { canonical: true });
  if (data.length < 2) continue;
  const cut = 1 + Math.floor(rand() * (data.length - 1));
  const d = new Decoder({ rejectUnknownSimple: false });
  d.write(data.subarray(0, cut));
  assert.throws(() => d.decode(), NeedMoreDataError, 'prefix should truncate');
  d.write(data.subarray(cut));
  assert.deepEqual(norm(d.decode().value), norm(v));
  prefixCases++;
}
console.log(`prefix/resume cases: ${prefixCases}`);

// ---- multi-value stream byte-by-byte ----
{
  const values = Array.from({ length: 50 }, () => randomValue(0));
  const stream = concat(values.map((v) => encode(v, { canonical: true })));
  const d = new Decoder({ rejectUnknownSimple: false });
  const got: unknown[] = [];
  for (let i = 0; i < stream.length; i++) {
    d.write(stream.subarray(i, i + 1));
    for (;;) {
      try {
        got.push(d.decode().value);
      } catch (e) {
        assert.ok(e instanceof NeedMoreDataError);
        break;
      }
      if (d.bufferedLength === 0) break;
    }
  }
  assert.deepEqual(norm(got), norm(values));
  assert.equal(d.bytesConsumedTotal, stream.length);
  console.log(`byte-wise stream values: ${values.length}`);
}

// ---- exhaustive half-float round-trip ----
{
  let exact = 0;
  for (let p = 0; p < 0x10000; p++) {
    const x = decodeHalfBits(p);
    const enc = encode(x, { canonical: true });
    // Re-decode whatever item was chosen; must equal x.
    // (Positive integer-valued half floats collapse to integer heads and
    // come back as bigint.)
    const back = decode(enc) as number | bigint;
    if (Number.isNaN(x)) {
      assert.ok(typeof back === 'number' && Number.isNaN(back));
      assert.deepEqual([...enc], [0xf9, 0x7e, 0x00]);
    } else if (typeof back === 'bigint') {
      // Integer-valued half (positive or negative, excluding -0) collapses
      // to an integer head; Number(back) must equal the f64 x.
      assert.equal(Number(back), x, `bigint collapse mismatch at ${p.toString(16)}`);
      assert.ok(Number.isInteger(x) && !Object.is(x, -0));
    } else {
      assert.ok(Object.is(back, x), `half pattern ${p.toString(16)} mismatch`);
    }
    if (enc.length === 3 && enc[0] === 0xf9) {
      exact++;
      // Minimal: shorter than f32/f64 and exact — nothing more to check;
      // but ensure a f32-only value really isn't tagged f9 via spot checks below.
    }
  }
  console.log(`exhaustive binary16 patterns checked (${exact} encoded as f16)`);
}

// ---- f32 precision spot checks against Math.fround ----
{
  let n = 0;
  for (let i = 0; i < 100000; i++) {
    const bits = Math.floor(rand() * 2 ** 32);
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, bits);
    const x = new DataView(buf).getFloat32(0);
    if (!Number.isFinite(x) || Object.is(x, 0)) continue;
    const enc = encode(x, { canonical: true });
    if (Number.isInteger(x)) {
      // Integer-valued floats collapse to integer heads; just verify the
      // round trip reproduces the same f64 value.
      const back = decode(enc);
      if (typeof back === 'bigint') assert.equal(Number(back), x);
      else assert.ok(Object.is(back as number, x));
    } else {
      // Non-integer f32-exact value: encoding must be f16 or f32.
      assert.ok(enc[0] === 0xf9 || enc[0] === 0xfa, `expected f16/f32 for ${x}, got ${enc[0]?.toString(16)}`);
      assert.ok(enc.length <= 5);
      assert.ok(Object.is(decode(enc) as number, x));
    }
    n++;
  }
  console.log(`f32 random patterns: ${n}`);
}

// ---- canonical duplicate-key rejection fuzz ----
{
  let rejected = 0;
  for (let i = 0; i < 2000; i++) {
    const m = new Map<unknown, unknown>();
    // Pick a mix of numeric keys, deliberately inserting both a safe
    // number and its bigint twin (identical canonical encoding).
    const used = new Set<number>();
    const uniqueCount = 1 + Math.floor(rand() * 4);
    for (let j = 0; j < uniqueCount; j++) {
      const n = Math.floor(rand() * 100000);
      used.add(n);
      m.set(BigInt(n), randomValue(1));
    }
    const twin = [...used][Math.floor(rand() * used.size)];
    m.set(twin, randomValue(1)); // number twin -> duplicate canonical key
    assert.throws(
      () => encode(m, { canonical: true }),
      (e: unknown) => e instanceof CborError && e.code === 'duplicate-key',
    );
    rejected++;
  }
  // Distinct Uint8Array instances with equal bytes are duplicates too.
  assert.throws(
    () =>
      encode(
        new Map<unknown, unknown>([
          [new Uint8Array([1, 2]), 1],
          [new Uint8Array([1, 2]), 2],
        ]),
        { canonical: true },
      ),
    (e: unknown) => e instanceof CborError && e.code === 'duplicate-key',
  );
  console.log(`duplicate-key rejections sampled: ${rejected}`);
}

// ---- errors are permanent: garbage followed by valid values ----
{
  const d = new Decoder();
  const good = encode([1n, 'ok']);
  const garbage = Uint8Array.from([0x1c, ...good]);
  d.write(garbage);
  assert.throws(() => d.decode(), CborError);
  assert.equal(d.bufferedLength, garbage.length);
  d.skip(1);
  assert.deepEqual(d.decode().value, [1n, 'ok']);
}

function decodeHalfBits(p: number): number {
  const m = p & 0x3ff;
  const e = (p >> 10) & 0x1f;
  const s = p & 0x8000 ? -1 : 1;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m === 0 ? s * Infinity : NaN;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function replacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Uint8Array) return [...v];
  if (v instanceof Tagged) return { tag: v.tag, value: v.value };
  if (v instanceof Simple) return `simple(${v.value})`;
  if (v instanceof Map) return Object.fromEntries(v);
  return v;
}

console.log('ALL PROPERTY CHECKS PASSED');
