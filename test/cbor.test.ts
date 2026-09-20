import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encode,
  decode,
  CborDecoder,
  CborError,
  CborNeedMoreDataError,
  CborTag,
  CborSimple,
} from '../src/index.js';

const hex = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('hex');
const fromHex = (s: string): Uint8Array =>
  new Uint8Array(Buffer.from(s, 'hex'));

function roundTrip(value: unknown, canonical = false): unknown {
  return decode(encode(value, { canonical })).value;
}

// ---------------------------------------------------------------------------
// Integers (shortest head)
// ---------------------------------------------------------------------------

test('integers use the shortest head', () => {
  assert.equal(hex(encode(0)), '00');
  assert.equal(hex(encode(1)), '01');
  assert.equal(hex(encode(10)), '0a');
  assert.equal(hex(encode(23)), '17');
  assert.equal(hex(encode(24)), '1818');
  assert.equal(hex(encode(100)), '1864');
  assert.equal(hex(encode(1000)), '1903e8');
  assert.equal(hex(encode(1000000)), '1a000f4240');
  assert.equal(hex(encode(1000000000000)), '1b000000e8d4a51000');
  assert.equal(hex(encode(-1)), '20');
  assert.equal(hex(encode(-10)), '29');
  assert.equal(hex(encode(-100)), '3863');
  assert.equal(hex(encode(-1000)), '3903e7');
});

test('non-preferred integer encodings are still decoded', () => {
  assert.equal(decode(fromHex('1800')).value, 0);
  assert.equal(decode(fromHex('190001')).value, 1);
  assert.equal(decode(fromHex('1a000000ff')).value, 255);
});

test('bigints beyond safe integer range round-trip as bigint', () => {
  const big = 9007199254740993n; // 2^53 + 1
  const bytes = encode(big);
  assert.equal(hex(bytes), '1b0020000000000001');
  assert.equal(decode(bytes).value, big);
  assert.equal(typeof decode(bytes).value, 'bigint');

  assert.equal(roundTrip(-big), -big);
  assert.equal(roundTrip(18446744073709551615n), 18446744073709551615n);
  assert.equal(roundTrip(-18446744073709551616n), -18446744073709551616n);
});

test('bigint at the safe-integer boundary decodes by type', () => {
  assert.equal(decode(fromHex('1b001fffffffffffff')).value, 9007199254740991);
  assert.equal(typeof decode(fromHex('1b001fffffffffffff')).value, 'number');
  assert.equal(decode(fromHex('1b0020000000000000')).value, 9007199254740992n);
});

test('bigints outside uint64/int64 cannot be encoded', () => {
  assert.throws(() => encode(18446744073709551616n), (e: unknown) =>
    e instanceof CborError && e.code === 'BIGINT_OUT_OF_RANGE');
  assert.throws(() => encode(-18446744073709551617n), (e: unknown) =>
    e instanceof CborError && e.code === 'BIGINT_OUT_OF_RANGE');
});

// ---------------------------------------------------------------------------
// Floats, NaN, negative zero
// ---------------------------------------------------------------------------

test('normal mode encodes non-integer numbers as float64', () => {
  assert.equal(hex(encode(1.5)), 'fb3ff8000000000000');
  assert.equal(hex(encode(0.5)), 'fb3fe0000000000000');
});

test('canonical mode picks shortest float representation', () => {
  assert.equal(hex(encode(1.5, { canonical: true })), 'f93e00');
  assert.equal(hex(encode(0.5, { canonical: true })), 'f93800');
  // 3.1416015625 is an exact float32 but not representable in float16.
  assert.equal(hex(encode(3.1416015625, { canonical: true })), 'fa40491000');
  // 0.1 is neither float16 nor float32 exact -> float64.
  assert.equal(hex(encode(0.1, { canonical: true })), 'fb3fb999999999999a');
  assert.equal(hex(encode(Infinity, { canonical: true })), 'f97c00');
  assert.equal(hex(encode(-Infinity, { canonical: true })), 'f9fc00');
});

test('NaN canonicalizes to f9 7e00; normal mode uses float64', () => {
  assert.equal(hex(encode(NaN, { canonical: true })), 'f97e00');
  const normal = hex(encode(NaN));
  assert.equal(normal, 'fb7ff8000000000000');
  for (const payload of ['f97e00', 'fa7fc00000', 'fb7ff8000000000000']) {
    assert.ok(Number.isNaN(decode(fromHex(payload)).value as number));
  }
});

test('negative zero is preserved', () => {
  const canonical = encode(-0, { canonical: true });
  assert.equal(hex(canonical), 'f98000');
  assert.ok(Object.is(decode(canonical).value as number, -0));
  const normal = encode(-0);
  assert.equal(hex(normal), 'fb8000000000000000');
  assert.ok(Object.is(decode(normal).value as number, -0));
  // Positive zero stays the integer 0.
  assert.equal(hex(encode(0, { canonical: true })), '00');
});

test('all decoded floats round-trip', () => {
  const values = [1.5, -2.25, 65504, 3.1416015625, 1e300, -1e-300, 1 / 3];
  for (const v of values) {
    assert.equal(roundTrip(v, true), v);
    assert.equal(roundTrip(v, false), v);
  }
});

test('half-float subnormals, boundaries and every NaN payload canonicalize', () => {
  // Brute force every 16-bit payload: decode it, then canonically re-encode.
  for (let bits = 0; bits <= 0xffff; bits++) {
    const bytes = fromHex(`f9${bits.toString(16).padStart(4, '0')}`);
    const decoded = decode(bytes).value as number;
    const encoded = encode(decoded, { canonical: true });
    if (Number.isNaN(decoded)) {
      assert.equal(hex(encoded), 'f97e00', `NaN from ${bits.toString(16)}`);
    } else {
      // Canonical encoding must decode back to the same value.
      assert.equal(decode(encoded).value as number, decoded);
    }
  }

  // Specific boundary values. Integers that fit f16 still encode as the
  // shorter integers (canonical CBOR); exercise the float path with values
  // that are not integers or that the f16 space covers as fractions.
  assert.equal(decode(fromHex('f90400')).value, 2 ** -14);
  assert.equal(hex(encode(2 ** -14, { canonical: true })), 'f90400');
  assert.equal(decode(fromHex('f90001')).value, 2 ** -24);
  assert.equal(hex(encode(2 ** -24, { canonical: true })), 'f90001');
  assert.equal(decode(fromHex('f97bff')).value, 65504);
  assert.equal(decode(fromHex('f93bff')).value, 0.99951171875);
  assert.equal(hex(encode(0.99951171875, { canonical: true })), 'f93bff');
  assert.equal(hex(encode(Math.PI, { canonical: true })), 'fb400921fb54442d18');
});

// ---------------------------------------------------------------------------
// Simple scalar types
// ---------------------------------------------------------------------------

test('booleans, null, undefined', () => {
  assert.equal(hex(encode(false)), 'f4');
  assert.equal(hex(encode(true)), 'f5');
  assert.equal(hex(encode(null)), 'f6');
  assert.equal(hex(encode(undefined)), 'f7');
  assert.equal(decode(fromHex('f4')).value, false);
  assert.equal(decode(fromHex('f5')).value, true);
  assert.equal(decode(fromHex('f6')).value, null);
  assert.equal(decode(fromHex('f7')).value, undefined);
});

test('unassigned simple values', () => {
  assert.equal(hex(encode(new CborSimple(16))), 'f0');
  assert.equal(hex(encode(new CborSimple(32))), 'f820');
  const decoded = decode(fromHex('f0')).value;
  assert.ok(decoded instanceof CborSimple && decoded.value === 16);
  for (const reserved of [24, 25, 26, 27, 28, 29, 30, 31]) {
    assert.throws(() => encode(new CborSimple(reserved)), (e: unknown) =>
      e instanceof CborError && e.code === 'INVALID_SIMPLE_VALUE');
  }
});

test('unencodable values are rejected with a structured error', () => {
  assert.throws(() => encode(() => 1), (e: unknown) =>
    e instanceof CborError && e.code === 'UNENCODABLE_VALUE');
  assert.throws(() => encode(Symbol('x')), (e: unknown) =>
    e instanceof CborError && e.code === 'UNENCODABLE_VALUE');
});

// ---------------------------------------------------------------------------
// Byte strings and text strings
// ---------------------------------------------------------------------------

test('byte strings round-trip and match RFC vectors', () => {
  assert.equal(hex(encode(new Uint8Array([1, 2, 3, 4]))), '4401020304');
  const decoded = decode(fromHex('4401020304')).value;
  assert.deepEqual(decoded, new Uint8Array([1, 2, 3, 4]));
  assert.equal(hex(encode(new Uint8Array([]))), '40');
});

test('text strings match RFC vectors', () => {
  assert.equal(hex(encode('')), '60');
  assert.equal(hex(encode('a')), '6161');
  assert.equal(hex(encode('IETF')), '6449455446');
  assert.equal(hex(encode('"\\')), '62225c');
  assert.equal(hex(encode('ü')), '62c3bc');
  assert.equal(hex(encode('水')), '63e6b0b4');
  assert.equal(decode(fromHex('6449455446')).value, 'IETF');
});

// ---------------------------------------------------------------------------
// Arrays, maps and tags
// ---------------------------------------------------------------------------

test('arrays match RFC vectors and round-trip', () => {
  assert.deepEqual(roundTrip([]), []);
  assert.equal(hex(encode([])), '80');
  assert.equal(hex(encode([1, 2, 3])), '83010203');
  assert.equal(
    hex(encode([1, [2, 3], [4, 5]])),
    '8301820203820405',
  );
  assert.deepEqual(roundTrip([1, [2, 3], ['a', 'b', null]]), [1, [2, 3], ['a', 'b', null]]);
});

test('plain objects and Maps both produce CBOR maps and decode to Map', () => {
  const obj = { a: 1, b: [2, 3] };
  const decodedObj = decode(encode(obj)).value;
  assert.ok(decodedObj instanceof Map);
  assert.deepEqual([...(decodedObj as Map<string, unknown>)], [
    ['a', 1],
    ['b', [2, 3]],
  ]);
  const map = new Map<unknown, unknown>([
    [1, 'one'],
    [new Uint8Array([9]), 'byte-key'],
  ]);
  const decodedMap = decode(encode(map)).value;
  assert.ok(decodedMap instanceof Map);
  assert.equal((decodedMap as Map<unknown, unknown>).get(1), 'one');
});

test('tags round-trip', () => {
  const tagged = new CborTag(0, '2013-03-21T20:04:00Z');
  const bytes = encode(tagged);
  assert.equal(hex(bytes), 'c074323031332d30332d32315432303a30343a30305a');
  const decoded = decode(bytes).value;
  assert.ok(decoded instanceof CborTag);
  assert.equal((decoded as CborTag).tag, 0);
  assert.equal((decoded as CborTag).value, '2013-03-21T20:04:00Z');
  assert.equal((roundTrip(new CborTag(16384n, [1, 2])) as CborTag).tag, 16384);
});

test('cyclic values are rejected', () => {
  const a: unknown[] = [1];
  a.push(a);
  assert.throws(() => encode(a), (e: unknown) =>
    e instanceof CborError && e.code === 'CYCLE_DETECTED');
  const obj: Record<string, unknown> = {};
  obj.self = obj;
  assert.throws(() => encode(obj), (e: unknown) =>
    e instanceof CborError && e.code === 'CYCLE_DETECTED');
  // A map that is its own key (canonical key encoding must not recurse forever).
  const selfKey = new Map<unknown, unknown>();
  selfKey.set(selfKey, 1);
  assert.throws(() => encode(selfKey, { canonical: true }), (e: unknown) =>
    e instanceof CborError && e.code === 'CYCLE_DETECTED');
  assert.throws(() => encode(selfKey), (e: unknown) =>
    e instanceof CborError && e.code === 'CYCLE_DETECTED');
});

test('non-integer tag numbers are rejected with a structured error', () => {
  assert.throws(() => encode(new CborTag(1.5, 1)), (e: unknown) =>
    e instanceof CborError && e.code === 'UNENCODABLE_VALUE');
  assert.throws(() => encode(new CborTag(-1, 1)), (e: unknown) =>
    e instanceof CborError && e.code === 'BIGINT_OUT_OF_RANGE');
});

// ---------------------------------------------------------------------------
// Canonical map key ordering and duplicate detection
// ---------------------------------------------------------------------------

test('canonical map keys are sorted by encoded length then by bytes', () => {
  const map = new Map<unknown, unknown>([
    ['ab', 1], // 62 61 62 (len 3)
    ['b', 2], // 61 62 (len 2)
    ['A', 3], // 61 41
    ['a', 4], // 61 61
    [1000, 5], // 19 03 e8 (len 3)
    ['', 6], // 60 (len 1)
    [1, 7], // 01 (len 1)
    [10, 8], // 0a (len 1)
  ]);
  const bytes = hex(encode(map, { canonical: true }));
  // head a8, then: 01, 0a, 60, 61 41, 61 61, 61 62, 19 03 e8, 62 61 62
  assert.equal(
    bytes,
    'a8' +
      '0107' +
      '0a08' +
      '6006' +
      '614103' +
      '616104' +
      '616202' +
      '1903e805' +
      '62616201',
  );
});

test('canonical encoding rejects duplicate keys (including 1 vs 1.0)', () => {
  // A JS Map keeps distinct Uint8Array instances even with equal content,
  // and they encode to identical canonical key bytes.
  const dup = new Map<unknown, unknown>([
    [new Uint8Array([1, 2]), 'x'],
    [new Uint8Array([1, 2]), 'y'],
  ]);
  assert.throws(() => encode(dup, { canonical: true }), (e: unknown) =>
    e instanceof CborError && e.code === 'DUPLICATE_KEY');

  // Note: integer 1 and float 1.0 are the same JS Map key, so a map cannot
  // hold both — but their canonical encodings are identical anyway.
  assert.equal(hex(encode(1, { canonical: true })), hex(encode(1.0, { canonical: true })));

  // Normal mode permits byte-identical keys.
  assert.doesNotThrow(() => encode(dup));
});

test('decoder optionally rejects duplicate keys by encoded bytes', () => {
  // a2 01 61 61 01 61 62 = {1:"a", 1:"b"}
  const dup = fromHex('a2016161016162');
  assert.ok(decode(dup).value instanceof Map);
  const strict = new CborDecoder({ rejectDuplicateKeys: true });
  strict.push(dup);
  assert.throws(() => strict.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'DUPLICATE_KEY_DECODE');

  // Canonical 1.0 encodes to the same bytes as integer 1 (0x01), so the
  // same encoded key appears twice even though the source values differ in
  // intent. Construct the map manually: a2 01 01 01 02.
  const oneAndFloatOne = fromHex('a201010102'); // {1:1, 1:2}
  const strict2 = new CborDecoder({ rejectDuplicateKeys: true });
  strict2.push(oneAndFloatOne);
  assert.throws(() => strict2.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'DUPLICATE_KEY_DECODE');

  // In non-strict mode both entries decode (last write wins in the Map).
  assert.equal((decode(oneAndFloatOne).value as Map<number, number>).get(1), 2);
});

// ---------------------------------------------------------------------------
// Indefinite-length containers
// ---------------------------------------------------------------------------

test('indefinite arrays and maps decode', () => {
  assert.deepEqual(decode(fromHex('9fff')).value, []);
  assert.deepEqual(decode(fromHex('9f018202039f0405ffff')).value, [1, [2, 3], [4, 5]]);
  assert.deepEqual(decode(fromHex('9f0102ff')).value, [1, 2]);
  const map = decode(fromHex('bf61610161629f0203ffff')).value;
  assert.ok(map instanceof Map);
  assert.deepEqual((map as Map<string, unknown>).get('a'), 1);
  assert.deepEqual((map as Map<string, unknown>).get('b'), [2, 3]);
});

test('indefinite byte and text strings are concatenated', () => {
  assert.deepEqual(
    decode(fromHex('5f42010243030405ff')).value,
    new Uint8Array([1, 2, 3, 4, 5]),
  );
  // indefinite text "strea" + "ming" = "streaming"
  assert.equal(decode(fromHex('7f657374726561646d696e67ff')).value, 'streaming');
});

test('illegal indefinite chunks are permanent errors', () => {
  // byte-string indef containing a text chunk
  const d = new CborDecoder();
  d.push(fromHex('5f6161ff'));
  assert.throws(() => d.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'INVALID_INDEFINITE_CHUNK');
});

// ---------------------------------------------------------------------------
// Incremental decoding: arbitrary chunking, byte-at-a-time
// ---------------------------------------------------------------------------

test('byte-at-a-time feeding decodes exactly on the final byte', () => {
  const values: unknown[] = [
    1,
    -24,
    9007199254740993n,
    1.5,
    'IETF',
    '水',
    new Uint8Array([1, 2, 3]),
    [1, [2, 3], new Uint8Array([7])],
    new CborTag(42, 'hi'),
    null,
    true,
  ];
  for (const value of values) {
    const bytes = encode(value, { canonical: true });
    const decoder = new CborDecoder();
    for (let i = 0; i < bytes.length - 1; i++) {
      decoder.push(bytes.subarray(i, i + 1));
      const r = decoder.next();
      assert.equal(r.done, false, `value ${String(value)} completed at byte ${i}`);
      assert.equal(decoder.consumed, 0);
    }
    decoder.push(bytes.subarray(bytes.length - 1));
    const final = decoder.next();
    assert.equal(final.done, true);
    if (final.done) {
      assert.deepEqual(final.value, value);
      assert.equal(final.consumed, bytes.length);
      assert.equal(decoder.pendingLength, 0);
    }
  }
});

test('truncated prefixes ask for more; completing them succeeds', () => {
  const d = new CborDecoder();
  d.push(fromHex('18')); // uint8 head without payload
  assert.deepEqual(d.next(), { done: false });
  d.push(fromHex('01'));
  const r = d.next();
  assert.equal(r.done && r.value, 1);

  const d2 = new CborDecoder();
  d2.push(fromHex('8201')); // array(2) with one element
  assert.equal(d2.next().done, false);
  d2.push(fromHex('02'));
  const r2 = d2.next();
  assert.deepEqual(r2.done && r2.value, [1, 2]);

  const d3 = new CborDecoder();
  d3.push(fromHex('bf6161')); // indefinite map, key "a" with missing value
  assert.equal(d3.next().done, false);
  d3.push(fromHex('01ff'));
  const r3 = d3.next();
  assert.ok(r3.done && (r3.value as Map<string, unknown>).get('a') === 1);
});

test('cross-chunk multibyte UTF-8 decodes (even split mid-codepoint)', () => {
  const euro = '€'; // e2 82 ac
  const encoded = encode(euro);
  // Split after the first UTF-8 byte.
  const d = new CborDecoder();
  d.push(encoded.subarray(0, 2)); // head + e2
  assert.equal(d.next().done, false);
  d.push(encoded.subarray(2));
  const r = d.next();
  assert.equal(r.done && r.value, euro);

  // Indefinite text string split across chunks mid-codepoint.
  const d2 = new CborDecoder();
  d2.push(fromHex('7f62e282')); // chunk head says 2 bytes: e2 82 (incomplete char)
  assert.equal(d2.next().done, false);
  d2.push(fromHex('61acff')); // next chunk finishes the codepoint
  const r2 = d2.next();
  assert.equal(r2.done && r2.value, euro);
});

test('consecutive top-level values are decoded in order with cumulative consumed', () => {
  const stream = concat([
    encode(1),
    encode('ab'),
    encode([1, 2]),
    encode(9007199254740993n),
  ]);
  const d = new CborDecoder();
  d.push(stream);
  const expected: Array<[unknown, number]> = [
    [1, 1],
    ['ab', 4],
    [[1, 2], 7],
    [9007199254740993n, 16],
  ];
  for (const [value, consumed] of expected) {
    const r = d.next();
    assert.equal(r.done, true);
    if (r.done) {
      assert.deepEqual(r.value, value);
      assert.equal(r.consumed, consumed);
    }
  }
  assert.equal(d.next().done, false);
});

test('one-shot decode throws CborNeedMoreDataError on truncation', () => {
  assert.throws(() => decode(fromHex('1901')), CborNeedMoreDataError);
});

test('unclosed indefinite containers and truncated chunks ask for more', () => {
  for (const prefix of ['9f01', 'bf616101', '5f420102', '7f6161', '82', 'a101', 'c0', '42aa']) {
    const d = new CborDecoder();
    d.push(fromHex(prefix));
    assert.equal(d.next().done, false, `prefix ${prefix}`);
  }
  // Completing the unclosed container works.
  const d = new CborDecoder();
  d.push(fromHex('9f01'));
  assert.equal(d.next().done, false);
  d.push(fromHex('02ff'));
  assert.deepEqual((d.next() as { value: unknown[] }).value, [1, 2]);
});

// ---------------------------------------------------------------------------
// Error semantics: permanent malformed data never consumes following bytes
// ---------------------------------------------------------------------------

test('permanent errors expose absolute structured offsets', () => {
  const bad = fromHex('62c328'); // text(2) with invalid UTF-8 c3 28
  const d = new CborDecoder();
  d.push(fromHex('01')); // one consumed good value
  d.push(bad);
  d.next(); // consume the 0x01
  try {
    d.next();
    assert.fail('expected CborError');
  } catch (e) {
    assert.ok(e instanceof CborError);
    assert.equal((e as CborError).code, 'INVALID_UTF8');
    // Absolute offsets: 0x01@0, text head 0x62@1, bad lead 0xc3@2, 0x28@3.
    assert.equal((e as CborError).offset, 2);
  }
});

test('error offsets stay absolute when the malformed value is split across chunks', () => {
  // Two good values, then an indefinite text string whose UTF-8 only becomes
  // invalid once a later chunk completes it.
  const d = new CborDecoder();
  d.push(fromHex('0102'));
  d.next();
  d.next();
  d.push(fromHex('7f62e282'));
  assert.equal(d.next().done, false);
  d.push(fromHex('6128ff'));
  try {
    d.next();
    assert.fail('expected CborError');
  } catch (e) {
    assert.ok(e instanceof CborError);
    assert.equal((e as CborError).code, 'INVALID_UTF8');
    // 0x01@0 0x02@1 0x7f@2 0x62@3 e2@4 82@5 | 0x61@6 0x28@7 0xff@8.
    // The first chunk was a valid prefix (needs more); reassembly fails at
    // the lead byte e2 (offset 4) when its bad continuation 0x28 arrives.
    assert.equal((e as CborError).offset, 4);
  }
  assert.equal(d.consumed, 2);
});

test('a stray continuation byte is reported at its own absolute offset', () => {
  const d = new CborDecoder();
  d.push(fromHex('01'));
  d.next();
  d.push(fromHex('61'));
  assert.equal(d.next().done, false);
  d.push(fromHex('80')); // 0x80 cannot begin a code point; offset 2
  try {
    d.next();
    assert.fail('expected CborError');
  } catch (e) {
    assert.ok(e instanceof CborError);
    assert.equal((e as CborError).code, 'INVALID_UTF8');
    assert.equal((e as CborError).offset, 2);
  }
  // Failure did not consume the malformed value.
  assert.equal(d.consumed, 1);
  assert.equal(d.pendingLength, 2);
});

test('empty chunks and empty pushes are harmless', () => {
  const d = new CborDecoder();
  d.push(new Uint8Array(0));
  assert.equal(d.next().done, false);
  const bytes = encode([1, 2, 3]);
  for (let i = 0; i < bytes.length; i++) {
    d.push(new Uint8Array(0));
    d.push(bytes.subarray(i, i + 1));
  }
  const r = d.next();
  assert.deepEqual(r.done && r.value, [1, 2, 3]);
});

test('a malformed value does not consume bytes of the next top-level value', () => {
  const good = fromHex('0102'); // two fine values before the bad one
  const badThenGood = concat([fromHex('fc'), encode('next')]); // 0xfc reserved head
  const d = new CborDecoder();
  d.push(concat([good, badThenGood]));

  assert.deepEqual(takeValue(d), 1);
  assert.deepEqual(takeValue(d), 2);
  const consumedBefore = d.consumed;
  const pendingBefore = d.pendingLength;
  assert.throws(() => d.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'RESERVED_HEAD');
  // Nothing consumed by the failure: offsets and buffer are untouched.
  assert.equal(d.consumed, consumedBefore);
  assert.equal(d.pendingLength, pendingBefore);

  // The following top-level value is still fully present right after bad.
  const suffix = concat([fromHex('fc'), encode('next')]);
  assert.equal(decode(suffix.subarray(1)).value, 'next');

  // Feeding more bytes keeps the later value; after removing the bad prefix
  // manually (as a resyncing caller would), the next value decodes.
  d.push(new Uint8Array(0));
  assert.equal(d.pendingLength, pendingBefore);
});

test('bare break and breaks inside definite containers are permanent errors', () => {
  const d1 = new CborDecoder();
  d1.push(fromHex('ff'));
  assert.throws(() => d1.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'BREAK_IN_VALUE');

  const d2 = new CborDecoder();
  d2.push(fromHex('82ff01'));
  assert.throws(() => d2.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'BREAK_IN_VALUE');
});

test('reserved additional information is a permanent error, not need-more', () => {
  const d = new CborDecoder();
  d.push(fromHex('7c')); // major 7, ai 28
  assert.throws(() => d.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'RESERVED_HEAD');
});

test('truncated UTF-8 needs more; completed invalid UTF-8 is permanent', () => {
  // Indefinite text string: first chunk declares 2 bytes but the
  // three-byte codepoint is split across chunks, so the stream needs
  // more data until the last byte arrives; a wrong continuation makes
  // the reassembled sequence invalid.
  const d = new CborDecoder();
  d.push(fromHex('7f62e282'));
  assert.equal(d.next().done, false);
  // 0x28 cannot continue a 3-byte sequence: permanent UTF-8 error.
  d.push(fromHex('6128ff'));
  assert.throws(() => d.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'INVALID_UTF8');

  // A definite text string with an invalid byte is always a permanent error.
  const d2 = new CborDecoder();
  d2.push(fromHex('62c328'));
  assert.throws(() => d2.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'INVALID_UTF8');
});

// ---------------------------------------------------------------------------
// Nesting depth
// ---------------------------------------------------------------------------

test('nesting depth is enforced and counted across tags', () => {
  const encodeNested = (depth: number): Uint8Array => {
    let s = '';
    for (let i = 0; i < depth; i++) s += '81'; // 1-element arrays
    s += '01';
    for (let i = 0; i < depth; i++) s += ''; // closings are implicit
    return fromHex(s);
  };

  const ok = new CborDecoder({ maxDepth: 5 });
  ok.push(encodeNested(5));
  assert.doesNotThrow(() => ok.next());

  const tooDeep = new CborDecoder({ maxDepth: 5 });
  tooDeep.push(encodeNested(6));
  assert.throws(() => tooDeep.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'NESTING_TOO_DEEP');

  // Tags count too: tag chain of 6 with maxDepth 5.
  const tagged = new CborDecoder({ maxDepth: 5 });
  tagged.push(fromHex('c0c0c0c0c0c001'));
  assert.throws(() => tagged.next(), (e: unknown) =>
    e instanceof CborError && e.code === 'NESTING_TOO_DEEP');
});

// ---------------------------------------------------------------------------
// Trailing data / length accounting
// ---------------------------------------------------------------------------

test('one-shot decode reports value length and leaves trailing bytes to caller', () => {
  const bytes = concat([encode('hi'), encode(1)]);
  const result = decode(bytes);
  assert.equal(result.value, 'hi');
  assert.equal(result.length, 3);
  assert.equal(result.consumed, 3);
  assert.equal(bytes.length - result.length, 1);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function takeValue(d: CborDecoder): unknown {
  const r = d.next();
  if (!r.done) throw new Error('expected complete value');
  return r.value;
}
