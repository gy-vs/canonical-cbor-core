# canonical-cbor-core

A zero-dependency CBOR (RFC 8949) encoder/decoder for Node.js 20+, written in
TypeScript. It provides:

- **all core data types**: unsigned/negative integers, half/single/double
  floats, byte strings, text strings, arrays, maps, booleans, `null`,
  `undefined`, tags and unassigned simple values;
- **two encoder modes**: normal definite-length encoding and a deterministic
  *canonical* mode;
- an **incremental decoder** that accepts arbitrarily-chunked `Uint8Array`
  input and clearly distinguishes “need more data” from permanent format
  errors;
- integers beyond JavaScript’s safe-integer range as native **`bigint`**;
- public **consumed-byte counts** and structured **error offsets**.

There is no CLI and no web page — this is a library only. It does not depend
on any CBOR implementation.

## Install / build

```bash
npm install
npm run build      # emits dist/
npm test           # builds and runs the node:test suite
npm run typecheck
```

## Quick start

```ts
import { encode, decode, CborDecoder } from 'canonical-cbor-core';

const bytes = encode({ a: 1, b: [2, 3] }, { canonical: true });

// One-shot
const { value, consumed, length } = decode(bytes);
// value is a Map<string, unknown>

// Incremental: feed any chunk boundaries you like.
const decoder = new CborDecoder({ maxDepth: 100, rejectDuplicateKeys: true });
decoder.push(chunk1);
let r = decoder.next();      // { done: false }  -> needs more data
decoder.push(chunk2);
r = decoder.next();          // { done: true, value, consumed, length }
```

Maps always decode to JavaScript `Map` (keys are not limited to strings).

## Canonical encoding rules

`encode(value, { canonical: true })` produces deterministic output:

1. **Shortest integer argument** for every head (`0..23`, one/two/four/eight
   bytes).
2. **Shortest float representation** that round-trips exactly:
   half (`f9`), single (`fa`) or double (`fb`), chosen in that order. Every
   `NaN` is emitted as the canonical half payload `f9 7e00`; `-0` keeps its
   own sign (`f9 8000`). Integers are always encoded as integers (never as an
   equal-valued float).
3. **Map keys are sorted** by their encoded byte length, then by byte value
   (length-lexicographic / core-deterministic ordering).
4. **Duplicate canonical keys are rejected** with a `CborError`
   (`code: 'DUPLICATE_KEY'`).
5. Indefinite-length encoding is never emitted in canonical mode.

In normal mode the encoder emits definite-length values, non-integer numbers
as float64 (`NaN` as float64), and preserves map insertion order.

## Incremental decoding

```ts
const d = new CborDecoder();
d.push(someBytes);

while (true) {
  const r = d.next();
  if (!r.done) break;        // wait for more bytes; nothing was consumed
  handle(r.value);
  // r.consumed = total bytes consumed across the whole stream so far
  // r.length   = byte length of this value alone
}
```

- `next()` decodes exactly **one top-level value**; call it repeatedly to
  decode a stream of consecutive values.
- `{ done: false }` means the buffered bytes are only a prefix. It is a
  normal condition, not an exception, and consumes nothing.
- Permanent format errors throw `CborError`. The failing value’s bytes and
  **all following bytes are retained**, so a caller can report/resync without
  losing the next top-level value.
- Partial tokens never advance the parser: an integer head, a float or a
  string body split across chunks is simply re-read once the bytes arrive.
- **Cross-chunk UTF-8** in both definite and indefinite text strings is
  reassembled before strict validation (WHATWG rules).
- **Nesting depth** is bounded (`maxDepth`, default `100`); tags count.
- `rejectDuplicateKeys: true` rejects maps with keys whose *raw encoded
  bytes* are equal (`code: 'DUPLICATE_KEY_DECODE'`).

Supported container forms include definite and indefinite-length arrays and
maps, and indefinite-length byte/text strings (chunks are concatenated).

## Value mapping

| CBOR | JavaScript |
| --- | --- |
| uint / nint within `±(2^53-1)` | `number` |
| larger uint / nint (up to uint64 / int64) | `bigint` |
| half/single/double | `number` |
| byte string | `Uint8Array` |
| text string | `string` |
| array | `unknown[]` |
| map | `Map<unknown, unknown>` |
| false / true / null / undefined | `boolean` / `null` / `undefined` |
| tag | `new CborTag(tagNumber, value)` |
| other simple values | `new CborSimple(n)` |

For encoding, plain objects are treated as maps of their own enumerable
string-keyed properties; `Map`, `Array`, `Uint8Array`, `CborTag`,
`CborSimple` and `bigint` are all accepted directly. Other typed arrays,
functions and symbols are rejected (`UNENCODABLE_VALUE`).

## Errors

```ts
class CborError extends Error {
  readonly code: CborErrorCode;
  readonly offset: number; // absolute byte offset in the logical stream
  readonly depth: number;  // container depth at the failure
}

class CborNeedMoreDataError extends Error {
  readonly offset: number;
}
```

`decode` throws `CborNeedMoreDataError` for a truncated one-shot input; the
streaming API reports that case as `{ done: false }`. Error codes include
`INVALID_HEAD`, `RESERVED_HEAD`, `BREAK_IN_VALUE`, `INVALID_INDEFINITE_CHUNK`,
`INVALID_UTF8`, `INVALID_SIMPLE_VALUE`, `NESTING_TOO_DEEP`,
`UNSAFE_LENGTH`, `DUPLICATE_KEY` / `DUPLICATE_KEY_DECODE`,
`BIGINT_OUT_OF_RANGE`, `UNENCODABLE_VALUE`, `CYCLE_DETECTED`.

## License

MIT
