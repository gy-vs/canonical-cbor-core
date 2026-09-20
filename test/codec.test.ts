import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, decodeAll, Decoder, Tagged, Simple, CborError, NeedMoreDataError } from '../src/index.js';

function bytes(...b: number[]): Uint8Array {
  return new Uint8Array(b);
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

test('RFC 8949 Appendix A core vectors round-trip', () => {
  const cases: [number[], unknown][] = [
    [[0x00], 0n],
    [[0x01], 1n],
    [[0x0a], 10n],
    [[0x17], 23n],
    [[0x18, 0x18], 24n],
    [[0x18, 0x19], 25n],
    [[0x18, 0x64], 100n],
    [[0x19, 0x03, 0xe8], 1000n],
    [[0x1a, 0x00, 0x0f, 0x42, 0x40], 1000000n],
    [[0x1b, 0, 0, 0, 0, 0, 0, 0x03, 0xe8], 1000n],
    [[0x20], -1n],
    [[0x29], -10n],
    [[0x38, 0x63], -100n],
    [[0x39, 0x03, 0xe7], -1000n],
    [[0x40], new Uint8Array()],
    [[0x44, 0x01, 0x02, 0x03, 0x04], bytes(1, 2, 3, 4)],
    [[0x60], ''],
    [[0x61, 0x61], 'a'],
    [[0x64, 0x49, 0x45, 0x54, 0x46], 'IETF'],
    [[0x80], []],
    [[0x83, 0x01, 0x02, 0x03], [1n, 2n, 3n]],
    [[0xa0], new Map()],
    [[0xf4], false],
    [[0xf5], true],
    [[0xf6], null],
    [[0xf7], undefined],
  ];
  for (const [encoded, value] of cases) {
    const b = bytes(...encoded);
    assert.deepEqual(decode(b), value, `decode ${hex(b)}`);
    assert.deepEqual(decode(encode(value)), value, `roundtrip ${hex(b)}`);
  }
});

test('integers: number vs bigint boundaries', () => {
  assert.deepEqual(decode(bytes(0x17)), 23n);
  assert.equal(typeof decode(bytes(0x17)), 'bigint');
  assert.deepEqual(decode(bytes(0x1b, 0, 0, 0, 0, 0, 0, 0x03, 0xe8)), 1000n);
  assert.deepEqual(decode(bytes(0x3b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)), -(2n ** 64n));

  // Encoder: JS numbers that are safe integers use minimal heads.
  assert.deepEqual(hex(encode(0)), '00');
  assert.deepEqual(hex(encode(23)), '17');
  assert.deepEqual(hex(encode(24)), '1818');
  assert.deepEqual(hex(encode(100)), '1864');
  assert.deepEqual(hex(encode(-1)), '20');
  assert.deepEqual(hex(encode(-1000)), '3903e7');
});

test('bignums beyond 2^64 use tags 2/3', () => {
  const big = 2n ** 64n;
  assert.deepEqual(hex(encode(big)), 'c249010000000000000000');
  assert.deepEqual(decode(fromHex('c249010000000000000000')), big);
  const neg = -(2n ** 64n) - 1n;
  assert.deepEqual(hex(encode(neg)), 'c349010000000000000000');
  assert.deepEqual(decode(fromHex('c349010000000000000000')), neg);
  // empty payload == zero magnitude
  assert.deepEqual(decode(fromHex('c240')), 0n);
  assert.deepEqual(decode(fromHex('c340')), -1n);
});

test('floats: f16/f32/f64 decode', () => {
  assert.equal(decode(fromHex('f90000')), 0);
  assert.ok(Object.is(decode(fromHex('f98000')), -0));
  assert.equal(decode(fromHex('f93c00')), 1);
  assert.equal(decode(fromHex('fb3ff199999999999a')), 1.1);
  assert.equal(decode(fromHex('f97c00')), Infinity);
  assert.equal(decode(fromHex('f9fc00')), -Infinity);
  assert.ok(Number.isNaN(decode(fromHex('f97e00'))));
  assert.ok(Number.isNaN(decode(fromHex('fa7ff80000'))));
  // non-canonical NaN payloads also decode to NaN
  assert.ok(Number.isNaN(decode(fromHex('f97e01'))));
  assert.ok(Number.isNaN(decode(fromHex('fb7ff0000000000001'))));
});

test('normal mode encodes numbers minimally as ints or f64', () => {
  assert.deepEqual(hex(encode(1.5)), 'fb3ff8000000000000');
  assert.deepEqual(hex(encode(1.1)), 'fb3ff199999999999a');
  // Safe integer -> minimal integer head even in normal mode
  assert.deepEqual(hex(encode(2 ** 53 - 1)), '1b001fffffffffffff');
  // Unsafe integer -> f64
  assert.deepEqual(hex(encode(Number.MAX_SAFE_INTEGER + 1)), 'fb4340000000000000');
  // NaN and -0 stay float64 in normal mode (no normalization imposed)
  assert.deepEqual(hex(encode(NaN)), 'fb7ff8000000000000');
  assert.deepEqual(hex(encode(-0)), 'fb8000000000000000');
});

test('canonical mode: NaN normalized, -0 preserved, shortest floats', () => {
  assert.deepEqual(hex(encode(NaN, { canonical: true })), 'f97e00');
  assert.deepEqual(hex(encode(-0, { canonical: true })), 'f98000');
  assert.deepEqual(hex(encode(Infinity, { canonical: true })), 'f97c00');
  assert.deepEqual(hex(encode(-Infinity, { canonical: true })), 'f9fc00');
  assert.deepEqual(hex(encode(1.5, { canonical: true })), 'f93e00');
  assert.deepEqual(hex(encode(1.1, { canonical: true })), 'fb3ff199999999999a');
  // exactly representable in f32 but not f16
  const x = Math.fround(12345.625);
  assert.deepEqual(hex(encode(x, { canonical: true })), 'fa4640e680');
  // integer-valued float collapses to integer
  assert.deepEqual(hex(encode(1.0, { canonical: true })), '01');
});

test('canonical f16 coverage: subnormals and rounding boundaries', () => {
  // smallest normal/subnormal half values
  assert.deepEqual(hex(encode(2 ** -14, { canonical: true })), 'f90400');
  assert.deepEqual(hex(encode(2 ** -24, { canonical: true })), 'f90001');
  const f16 = fromHex('f903ff');
  assert.deepEqual(hex(encode(decode(f16), { canonical: true })), 'f903ff');
  // value requiring rounding in half range still exact -> f16
  assert.deepEqual(hex(encode(1.0009765625, { canonical: true })), 'f93c01');
  // integer-valued 65520 collapses to an integer head
  assert.deepEqual(hex(encode(65520, { canonical: true })), '19fff0');
  // a non-integer above the f16 finite range uses f32/f64
  assert.deepEqual(hex(encode(65520.5, { canonical: true })), 'fa477ff080');
});

test('canonical: shortest integer heads', () => {
  assert.deepEqual(hex(encode(23n, { canonical: true })), '17');
  assert.deepEqual(hex(encode(24n, { canonical: true })), '1818');
  assert.deepEqual(hex(encode(256n, { canonical: true })), '190100');
  assert.deepEqual(hex(encode(65536n, { canonical: true })), '1a00010000');
  assert.deepEqual(hex(encode(2n ** 32n, { canonical: true })), '1b0000000100000000');
  assert.deepEqual(hex(encode(-23n, { canonical: true })), '36');
  assert.deepEqual(hex(encode(-24n, { canonical: true })), '37');
});

test('canonical: map keys sorted by encoded length then byte order', () => {
  const m = new Map<unknown, unknown>([
    ['longkey', 1n],
    ['a', 2n],
    [10n, 3n], // 0x0a, 1 byte
    [100n, 4n], // 0x1864, 2 bytes
  ]);
  const enc = encode(m, { canonical: true });
  // 0a          (1 byte) key 10
  // 18 64       (2 bytes) key 100
  // 61 61       (2 bytes) key "a" — same length as 1864, 0x18 < 0x61
  // 67 ...      (8 bytes) key "longkey"
  assert.deepEqual(hex(enc), 'a40a03186404616102676c6f6e676b657901');
  assert.deepEqual(decode(enc), m);
});

test('canonical: same-length keys ordered lexicographically by unsigned bytes', () => {
  const m = new Map<unknown, unknown>([['b', 1n], ['a', 2n], ['c', 3n]]);
  const enc = encode(m, { canonical: true });
  assert.deepEqual(hex(enc), 'a3616102616201616303');
});

test('canonical: duplicate keys rejected, nothing half-emitted state', () => {
  const m = new Map<unknown, unknown>([
    [1n, 'x'],
    [1.0, 'y'], // identical canonical encoding (0x01)
  ]);
  assert.throws(
    () => encode(m, { canonical: true }),
    (e: unknown) => e instanceof CborError && e.code === 'duplicate-key',
  );
  // Number 1 and bigint 1n are distinct JS keys but encode identically
  // in canonical mode (both 0x01).
  const m2 = new Map<unknown, unknown>([[1, 'x'], [1n, 'y']]);
  assert.throws(
    () => encode(m2, { canonical: true }),
    (e: unknown) => e instanceof CborError && e.code === 'duplicate-key',
  );
});

test('tags round-trip as Tagged', () => {
  const t = new Tagged(0, '2013-03-21T20:04:00Z');
  const enc = encode(t);
  assert.deepEqual(hex(enc), 'c074323031332d30332d32315432303a30343a30305a');
  const back = decode(enc);
  assert.ok(back instanceof Tagged);
  assert.equal(back.tag, 0);
  assert.equal(back.value, '2013-03-21T20:04:00Z');
});

test('simple values', () => {
  assert.deepEqual(hex(encode(new Simple(16))), 'f0');
  // rejected by default
  assert.throws(() => decode(bytes(0xf0)), CborError);
  assert.throws(() => decode(bytes(0xf8, 0x20)), CborError);
  // opt in
  const s = decode(bytes(0xf0), { rejectUnknownSimple: false });
  assert.ok(s instanceof Simple && s.value === 16);
  const s2 = decode(bytes(0xf8, 0x20), { rejectUnknownSimple: false });
  assert.ok(s2 instanceof Simple && s2.value === 32);
});

test('nested arrays, maps and indefinite containers', () => {
  assert.deepEqual(decode(fromHex('9f018202039f0405ffff')), [1n, [2n, 3n], [4n, 5n]]);
  assert.deepEqual(decode(fromHex('9f018202030405ff')), [1n, [2n, 3n], 4n, 5n]);
  assert.deepEqual(decode(fromHex('bf61610161629f0203ffff')), new Map([['a', 1n], ['b', [2n, 3n]]]));
  // indefinite bytes/text
  assert.deepEqual(decode(fromHex('5f42010243030405ff')), bytes(1, 2, 3, 4, 5));
  assert.deepEqual(decode(fromHex('7f657374726561646d696e67ff')), 'streaming');
});

test('empty indefinite containers', () => {
  assert.deepEqual(decode(bytes(0x9f, 0xff)), []);
  assert.deepEqual(decode(bytes(0xbf, 0xff)), new Map());
  assert.deepEqual(decode(bytes(0x5f, 0xff)), new Uint8Array());
  assert.deepEqual(decode(bytes(0x7f, 0xff)), '');
});

test('permanent malformed errors carry structured offsets', () => {
  // reserved additional info 28
  assertOffset(fromHex('1c'), 0, 'malformed');
  // non-minimal head: accepted by the generic decoder...
  assert.equal(decode(fromHex('1817')), 23n);
  // ...rejected in strict/canonical-compatible mode
  assert.throws(
    () => decode(fromHex('1817'), { rejectNonMinimal: true }),
    (e: unknown) => e instanceof CborError && e.code === 'malformed',
  );
  // indefinite on integer
  assertOffset(fromHex('1f'), 0, 'malformed');
  // invalid simple 28: offset points at the argument byte
  assertOffset(fromHex('f81c'), 1, 'malformed');
  // stray break
  assertOffset(fromHex('ff'), 0, 'malformed');
  // bignum tags accept byte strings and integer items; other payload
  // types are preserved as Tagged, not errors. Here c2 80 (array payload)
  // is valid Tagged data and decodes without throwing.
  const tagged = decode(fromHex('c280'));
  assert.ok(tagged instanceof Tagged && tagged.tag === 2);
  // Indefinite byte string as bignum payload is still rejected.
  assertOffset(fromHex('c25fff'), 2, 'malformed');

  function assertOffset(data: Uint8Array, valueOffset: number, code: string): void {
    try {
      decode(data);
      assert.fail('expected throw');
    } catch (e) {
      assert.ok(e instanceof CborError, 'CborError');
      assert.equal(e.code, code);
      assert.equal(e.valueOffset, valueOffset);
    }
  }
});

test('invalid UTF-8 is a permanent error', () => {
  // definite text with bad continuation byte
  assert.throws(() => decode(bytes(0x62, 0xc3, 0x28)), (e: unknown) => e instanceof CborError && e.code === 'utf8');
  // indefinite split where the assembly is invalid: 0xe2 0x28
  assert.throws(() => decode(fromHex('7f61e26128ff')), (e: unknown) => e instanceof CborError && e.code === 'utf8');
});

test('definite container claims too many elements -> need more', () => {
  const d = new Decoder();
  d.write(bytes(0x82, 0x01));
  assert.throws(() => d.decode(), NeedMoreDataError);
});

test('trailing bytes rejected by one-shot decode', () => {
  assert.throws(() => decode(bytes(0x01, 0x02)), CborError);
  assert.deepEqual(decodeAll(bytes(0x01, 0x02)), [1n, 2n]);
});

test('full unsigned and negative integer ranges', () => {
  assert.deepEqual(hex(encode(2n ** 64n - 1n)), '1bffffffffffffffff');
  assert.deepEqual(decode(fromHex('1bffffffffffffffff')), 2n ** 64n - 1n);
  assert.deepEqual(hex(encode(-(2n ** 64n))), '3bffffffffffffffff');
  assert.deepEqual(decode(fromHex('3bffffffffffffffff')), -(2n ** 64n));
  assert.deepEqual(hex(encode(2n ** 64n)), 'c249010000000000000000');
  assert.deepEqual(hex(encode(-(2n ** 64n) - 1n)), 'c349010000000000000000');
});

test('lone surrogate strings are rejected by the encoder', () => {
  assert.throws(
    () => encode('a\uD800b'),
    (e: unknown) => e instanceof CborError && e.code === 'utf8',
  );
  assert.throws(
    () => encode('\uDC00'),
    (e: unknown) => e instanceof CborError && e.code === 'utf8',
  );
  // paired surrogate encodes fine
  assert.equal(typeof encode('😀'), 'object');
});

test('canonical encoding is definite-length only and re-encodes identically', () => {
  const v = { a: [1n, 2n], b: new Map([['x', 3n]]), c: new Uint8Array([9]) };
  const first = encode(v, { canonical: true });
  assert.ok(![...first].includes(0x9f), 'no indefinite markers');
  assert.deepEqual(encode(decode(first), { canonical: true }), first);
});
