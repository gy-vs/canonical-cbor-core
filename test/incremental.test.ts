import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, Decoder, CborError, NeedMoreDataError } from '../src/index.js';

function bytes(...b: number[]): Uint8Array {
  return new Uint8Array(b);
}

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Feed one byte at a time; asserts that truncation occurs repeatedly. */
function feedByteByByte(data: Uint8Array, opts?: ConstructorParameters<typeof Decoder>[0]): unknown[] {
  const d = new Decoder(opts);
  const values: unknown[] = [];
  let needMore = 0;
  for (let i = 0; i < data.length; i++) {
    d.write(data.subarray(i, i + 1));
    while (d.bufferedLength > 0) {
      try {
        values.push(d.decode().value);
      } catch (e) {
        assert.ok(e instanceof NeedMoreDataError, `at byte ${i}: expected NeedMoreData, got ${String(e)}`);
        needMore++;
        break;
      }
    }
  }
  assert.ok(needMore > 0, 'expected to hit need-more-data while byte feeding');
  return values;
}

/** Pull values while data is available. */
function drain(d: Decoder): unknown[] {
  const out: unknown[] = [];
  while (d.bufferedLength > 0) {
    try {
      out.push(d.decode().value);
    } catch (e) {
      if (e instanceof NeedMoreDataError) return out;
      throw e;
    }
  }
  return out;
}

test('byte-by-byte: primitives', () => {
  assert.deepEqual(feedByteByByte(fromHex('1818')), [24n]);
  assert.deepEqual(feedByteByByte(fromHex('1b00000000000003e8')), [1000n]);
  assert.deepEqual(feedByteByByte(fromHex('fb3ff199999999999a')), [1.1]);
  assert.deepEqual(feedByteByByte(fromHex('6449455446')), ['IETF']);
});

test('byte-by-byte: nested array and map', () => {
  const data = fromHex('8301820203a1616102');
  assert.deepEqual(feedByteByByte(data), [[1n, [2n, 3n], new Map([['a', 2n]])]]);
});

test('byte-by-byte: indefinite array with break', () => {
  assert.deepEqual(feedByteByByte(fromHex('9f010203ff')), [[1n, 2n, 3n]]);
});

test('transient vs permanent classification', () => {
  const d = new Decoder();
  d.write(bytes(0x18));
  assert.throws(() => d.decode(), NeedMoreDataError);
  assert.equal(d.bufferedLength, 1);
  d.write(bytes(0x18));
  assert.deepEqual(d.decode().value, 24n);
  assert.equal(d.bufferedLength, 0);
});

test('permanent error does not consume next top-level value bytes', () => {
  const d = new Decoder();
  d.write(bytes(0x1c, 0x01)); // reserved ai 28, then a valid 0x01
  assert.throws(() => d.decode(), (e: unknown) => e instanceof CborError && e.code === 'malformed');
  assert.equal(d.bufferedLength, 2);
  assert.deepEqual([...d.remainingBytes()], [0x1c, 0x01]);
  // Skip the poisoned value; the following value is intact.
  d.skip(1);
  assert.deepEqual(d.decode().value, 1n);
  assert.equal(d.bufferedLength, 0);
});

test('truncation does not consume bytes; resume with appended chunk', () => {
  const d = new Decoder();
  d.write(bytes(0x82, 0x01, 0x18)); // array of 2: [1, <need 1 byte>]
  assert.throws(() => d.decode(), NeedMoreDataError);
  assert.equal(d.bufferedLength, 3);
  // Complete the array, then append a second top-level value.
  d.write(bytes(0x05, 0x02));
  assert.deepEqual(d.decode().value, [1n, 5n]);
  assert.deepEqual(d.decode().value, 2n);
});

test('continuous multi-value stream split across irregular chunks', () => {
  const values: unknown[] = [100n, 'hi', new Uint8Array([9, 8]), [true, null], -7n];
  const encoded = concat(values.map((v) => encode(v)));

  const chunks: Uint8Array[] = [];
  let i = 0;
  let seed = 7;
  while (i < encoded.length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = 1 + (seed % 3);
    chunks.push(encoded.subarray(i, i + n));
    i += n;
  }

  const d = new Decoder();
  const got: unknown[] = [];
  for (const c of chunks) {
    d.write(c);
    got.push(...drain(d));
  }
  assert.equal(got.length, values.length);
  assert.deepEqual(got, values);
  assert.equal(d.bytesConsumedTotal, encoded.length);
});

test('cross-chunk UTF-8: multibyte char split between feeds (definite)', () => {
  const data = bytes(0x63, 0xe2, 0x82, 0xac); // "€"
  const d = new Decoder();
  d.write(data.subarray(0, 2));
  assert.throws(() => d.decode(), NeedMoreDataError);
  d.write(data.subarray(2, 3));
  assert.throws(() => d.decode(), NeedMoreDataError);
  d.write(data.subarray(3, 4));
  assert.equal(d.decode().value, '€');
});

test('indefinite text: char straddling chunk boundary is permanently invalid', () => {
  // 7f 62 e2 82 62 ac — after the 6-byte second write, chunk 1
  // (e2 82) is complete and itself invalid. The rollback retains those
  // 6 bytes; after the break byte, 7 are retained.
  const d = new Decoder();
  d.write(fromHex('7f62e2'));
  assert.throws(() => d.decode(), NeedMoreDataError);
  d.write(fromHex('8262ac'));
  assert.throws(() => d.decode(), (e: unknown) => e instanceof CborError && e.code === 'utf8');
  assert.equal(d.bufferedLength, 6);
  d.write(bytes(0xff));
  assert.throws(() => d.decode(), (e: unknown) => e instanceof CborError && e.code === 'utf8');
  assert.equal(d.bufferedLength, 7);
});

test('indefinite text: valid whole characters per chunk succeeds', () => {
  const d = new Decoder();
  d.write(fromHex('7f63e282ac6121ff'));
  assert.equal(d.decode().value, '€!');
});

test('nested depth limit', () => {
  const enc: number[] = [];
  for (let i = 0; i < 101; i++) enc.push(0x81);
  enc.push(0x01);
  assert.doesNotThrow(() => new Decoder({ maxDepth: 101 }).write(bytes(...enc)).decode());
  assert.throws(
    () => new Decoder({ maxDepth: 100 }).write(bytes(...enc)).decode(),
    (e: unknown) => e instanceof CborError && e.code === 'depth',
  );
});

test('tags participate in depth accounting', () => {
  const enc: number[] = [];
  for (let i = 0; i < 5; i++) enc.push(0xc0);
  enc.push(0x01);
  assert.throws(
    () => new Decoder({ maxDepth: 4 }).write(bytes(...enc)).decode(),
    (e: unknown) => e instanceof CborError && e.code === 'depth',
  );
  assert.doesNotThrow(() => new Decoder({ maxDepth: 5 }).write(bytes(...enc)).decode());
});

test('offset reporting: value-relative after a previous good value', () => {
  const d = new Decoder();
  d.write(bytes(0x01));
  d.decode();
  d.write(bytes(0x82, 0x01, 0x1c, 0x02));
  try {
    d.decode();
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof CborError);
    assert.equal(e.code, 'malformed');
    assert.equal(e.valueOffset, 2);
  }
});

test('NeedMoreDataError exposes absolute and value-relative offsets', () => {
  const d = new Decoder();
  d.write(bytes(0x1a, 0x01)); // head consumed, 2 of 4 payload bytes missing
  try {
    d.decode();
    assert.fail();
  } catch (e) {
    assert.ok(e instanceof NeedMoreDataError);
    assert.equal(e.offset, 1);
    assert.equal(e.valueOffset, 1);
  }
});

test('decoder duplicate-key option compares encoded key bytes', () => {
  const data = fromHex('a2616101616102'); // {"a":1,"a":2}
  const d1 = new Decoder({ rejectDuplicateKeys: true });
  d1.write(data);
  assert.throws(() => d1.decode(), (e: unknown) => e instanceof CborError && e.code === 'duplicate-key');

  const d2 = new Decoder();
  d2.write(data);
  const m = d2.decode().value as Map<unknown, unknown>;
  assert.equal(m.get('a'), 2n);
});

test('consumed counter advances per value and per decode() result', () => {
  const d = new Decoder();
  d.write(fromHex('011818820102'));
  assert.equal(d.bytesConsumedTotal, 0);
  d.decode();
  assert.equal(d.bytesConsumedTotal, 1);
  d.decode();
  assert.equal(d.bytesConsumedTotal, 3);
  const r = d.decode();
  assert.deepEqual(r.value, [1n, 2n]);
  assert.equal(r.bytesConsumed, 3);
  assert.equal(d.bytesConsumedTotal, 6);
});

test('zero-length writes are harmless', () => {
  const d = new Decoder();
  d.write(new Uint8Array(0));
  assert.throws(() => d.decode(), NeedMoreDataError);
  d.write(bytes(0xf6));
  assert.equal(d.decode().value, null);
});

test('reset clears buffered data and counters', () => {
  const d = new Decoder();
  d.write(bytes(0x01));
  d.decode();
  d.write(bytes(0x18));
  d.reset();
  assert.equal(d.bufferedLength, 0);
  assert.equal(d.bytesConsumedTotal, 0);
  d.write(bytes(0x02));
  assert.deepEqual(d.decode().value, 2n);
});

test('malformed nested element reports path and offset; siblings preserved', () => {
  // [1, 1c, 2]
  const d = new Decoder();
  d.write(bytes(0x83, 0x01, 0x1c, 0x02));
  assert.throws(
    () => d.decode(),
    (e: unknown) =>
      e instanceof CborError &&
      e.code === 'malformed' &&
      e.valueOffset === 2 &&
      typeof e.path === 'string' &&
      e.path.includes('[1]'),
  );
  // Nothing of the array (nor sibling) was consumed.
  assert.equal(d.bufferedLength, 4);
});

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
