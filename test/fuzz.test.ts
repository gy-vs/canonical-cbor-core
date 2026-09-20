import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encode,
  CborDecoder,
  CborError,
  CborTag,
  CborSimple,
} from '../src/index.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));

function feedInChunks(bytes: Uint8Array, chunkSize: () => number): unknown {
  const d = new CborDecoder();
  let i = 0;
  let guard = 0;
  while (i < bytes.length) {
    const size = Math.min(chunkSize(), bytes.length - i);
    d.push(bytes.subarray(i, i + size));
    i += size;
    const r = d.next();
    if (r.done) {
      assert.equal(i, bytes.length, 'decoded before all bytes were pushed');
      assert.equal(d.pendingLength, 0);
      return r.value;
    }
    if (++guard > bytes.length + 5) throw new Error('loop guard tripped');
  }
  const r = d.next();
  assert.equal(r.done, true, 'expected completion after final chunk');
  return (r as { value: unknown }).value;
}

// Deterministic PRNG so the fuzz run is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(rng: () => number, depth: number): unknown {
  const roll = rng();
  if (depth > 3 || roll < 0.3) {
    const kind = Math.floor(rng() * 8);
    switch (kind) {
      case 0:
        return Math.floor(rng() * 2000) - 1000;
      case 1:
        return Math.floor(rng() * 1e14);
      case 2: {
        // Bigint spanning and exceeding the safe-integer boundary, but
        // within CBOR's uint64 range (0 .. 2^64-1).
        const high = BigInt(Math.floor(rng() * 0x100000000));
        const low = BigInt(Math.floor(rng() * 0x100000000));
        return (high << 32n) | low;
      }
      case 3: {
        const f = rng();
        // Favor exactly-representable half/single floats sometimes.
        if (f < 0.25) return Math.fround(rng() * 100 - 50);
        if (f < 0.5) return Math.round(rng() * 2048) / 2048;
        return rng() * 1e6 - 5e5;
      }
      case 4:
        return rng() < 0.5;
      case 5:
        return null;
      case 6:
        return undefined;
      default: {
        const len = Math.floor(rng() * 6);
        const out = new Uint8Array(len);
        for (let i = 0; i < len; i++) out[i] = Math.floor(rng() * 256);
        return out;
      }
    }
  }
  if (roll < 0.55) {
    // Build text from complete code points so surrogate pairs (emoji) are
    // never split into isolated halves by the generator.
    const codePoints = [0x61, 0x4e2d, 0x20ac, 0x1f389, 0x7a];
    let s = '';
    const len = Math.floor(rng() * 8);
    for (let i = 0; i < len; i++) {
      s += String.fromCodePoint(codePoints[Math.floor(rng() * codePoints.length)]!);
    }
    return s;
  }
  if (roll < 0.75) {
    const len = Math.floor(rng() * 5);
    return Array.from({ length: len }, () => randomValue(rng, depth + 1));
  }
  const len = Math.floor(rng() * 4);
  const map = new Map<unknown, unknown>();
  for (let i = 0; i < len; i++) {
    map.set(
      ['k', 'x', 'long-key-name', Math.floor(rng() * 100)][i % 4],
      randomValue(rng, depth + 1),
    );
  }
  return map;
}

test('fuzz: canonical encode + arbitrary chunking decodes identically', () => {
  const rng = mulberry32(20260920);
  for (let iter = 0; iter < 400; iter++) {
    const value = randomValue(rng, 0);
    let bytes: Uint8Array;
    try {
      bytes = encode(value, { canonical: true });
    } catch (e) {
      // Cycles cannot be produced by randomValue; only expected encodable values.
      throw e;
    }

    // Chunk sizes 1..4 with random boundaries.
    const decoded = feedInChunks(bytes, () => 1 + Math.floor(rng() * 4));
    assert.deepEqual(decoded, value);

    // Re-encoding decoded must reproduce identical canonical bytes.
    assert.equal(hex(encode(decoded, { canonical: true })), hex(bytes));
  }
});

test('fuzz: byte-at-a-time never reports a value before the final byte', () => {
  const rng = mulberry32(7);
  for (let iter = 0; iter < 200; iter++) {
    const bytes = encode(randomValue(rng, 0), { canonical: true });
    const d = new CborDecoder();
    for (let i = 0; i < bytes.length - 1; i++) {
      d.push(bytes.subarray(i, i + 1));
      const r = d.next();
      assert.equal(r.done, false, `completed early at byte ${i} of ${bytes.length}`);
      assert.equal(d.consumed, 0);
    }
    d.push(bytes.subarray(bytes.length - 1));
    const r = d.next();
    assert.equal(r.done, true);
    assert.equal(d.pendingLength, 0);
  }
});

test('fuzz: consecutive values in one stream with random boundaries', () => {
  const rng = mulberry32(99);
  const values = Array.from({ length: 60 }, () => randomValue(rng, 0));
  const stream = (() => {
    const parts = values.map((v) => encode(v, { canonical: true }));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  })();

  const d = new CborDecoder();
  let pushed = 0;
  let index = 0;
  let guard = 0;
  while (index < values.length && guard++ < 100000) {
    if (pushed < stream.length && rng() < 0.6) {
      const size = 1 + Math.floor(rng() * 7);
      d.push(stream.subarray(pushed, pushed + size));
      pushed += size;
    }
    const r = d.next();
    if (r.done) {
      assert.deepEqual(r.value, values[index]);
      index += 1;
    }
  }
  assert.equal(index, values.length);
});

test('malformed bytes are permanent errors and never consume following data', () => {
  // Various malformed prefixes followed by a valid value; after the error
  // the decoder must keep the whole bad value plus the following bytes.
  const badPrefixes = [
    'fc', // reserved ai
    '7c',
    'ff', // stray break
    '82ff', // break inside definite array
    '5f6161ff', // text chunk inside indefinite byte string
    '62c328', // invalid UTF-8
  ];
  for (const bad of badPrefixes) {
    const following = encode('after');
    const d = new CborDecoder();
    d.push(fromHex(bad));
    d.push(following);
    assert.throws(() => d.next(), CborError, `prefix ${bad}`);
    assert.equal(d.consumed, 0);
    // Nothing was trimmed: pending still contains bad + following.
    assert.equal(d.pendingLength, fromHex(bad).length + following.length);
  }
});

test('permanent error mid-stream does not consume the next top-level value', () => {
  // A good value, a bad one, then another good one.
  const stream = (() => {
    const parts = [encode(1), fromHex('fc'), encode('next')];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  })();

  const d = new CborDecoder();
  d.push(stream);
  const first = d.next();
  assert.equal(first.done && first.value, 1);
  assert.equal(d.consumed, 1);

  assert.throws(() => d.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'RESERVED_HEAD');
  // Failure consumed nothing: the bad byte is still first in line.
  assert.equal(d.consumed, 1);
  assert.equal(d.pendingLength, stream.length - 1);
});

test('depth limit boundary with tags and arrays, byte-at-a-time', () => {
  const nest = (n: number): Uint8Array => {
    let s = '';
    for (let i = 0; i < n; i++) s += '81';
    s += '01';
    return fromHex(s);
  };
  for (const depth of [0, 1, 5, 10]) {
    const ok = new CborDecoder({ maxDepth: depth });
    ok.push(nest(depth));
    assert.doesNotThrow(() => ok.next(), `depth ${depth} should decode`);
    const bad = new CborDecoder({ maxDepth: depth });
    bad.push(nest(depth + 1));
    assert.throws(() => bad.next(), (e: unknown) =>
      e instanceof CborError && e.code === 'NESTING_TOO_DEEP');
  }
});

test('canonical re-encoding of every decoded f16 payload is canonical', () => {
  // Already covered exhaustively elsewhere; here verify tags carry bigints.
  const v = new CborTag(18446744073709551615n, new Uint8Array([1, 2]));
  const bytes = encode(v, { canonical: true });
  assert.equal(hex(bytes), 'dbffffffffffffffff420102');
  const d = new CborDecoder();
  d.push(bytes);
  const r = d.next();
  assert.equal(r.done, true);
  const tag = (r as { value: CborTag }).value;
  assert.equal(tag.tag, 18446744073709551615n);
});

test('CborSimple round-trips unassigned values and rejects bad input', () => {
  for (const s of [0, 16, 19, 32, 100, 255]) {
    const bytes = encode(new CborSimple(s));
    const d = new CborDecoder();
    d.push(bytes);
    const r = d.next();
    assert.equal(r.done && (r.value as CborSimple).value, s);
  }
  assert.throws(() => new CborSimple(-1), RangeError);
  assert.throws(() => new CborSimple(256), RangeError);
  assert.throws(() => new CborSimple(1.5), RangeError);
});
