# cbor-codec

A dependency-free CBOR ([RFC 8949](https://www.rfc-editor.org/rfc/rfc8949))
encoder and incremental decoder for Node.js 20+ and TypeScript. No CLI, no UI —
library only.

## Features

- Integer (major 0/1), byte string (2), text (3), array (4), map (5), tag (6),
  simple values/floats (7), `true`/`false`, `null`, `undefined`
- Integers beyond the 64-bit range use `bigint` (tags 2/3 bignums on the wire)
- **Normal** and **canonical deterministic** encoder modes
  - shortest integer heads
  - shortest float width: f16 → f32 → f64, with integer-valued floats folded
    into integer items
  - NaN normalized to `f9 7e00`; `-0` preserved as `f9 8000`
  - definite-length containers only
  - map keys sorted by encoded byte length, then unsigned byte order
  - duplicate canonical keys rejected
- **Streaming decoder**: feed arbitrary chunks (`Uint8Array`) of any size;
  pull one complete top-level value at a time
  - distinguishes **need more data** (`NeedMoreDataError`, transient) from
    **permanent format errors** (`CborError`)
  - indefinite-length arrays, maps, byte and text strings
  - multibyte UTF-8 sequences split across input chunks
  - per-chunk UTF-8 validation for indefinite text strings (RFC 8949 §3.2.3)
  - configurable nesting depth limit
  - on failure, no bytes of any following top-level value are consumed
- Structured error offsets: absolute buffer offset, offset relative to the
  current value, and a best-effort navigation path
- Explicit consumed-byte counters

## Install / build

```bash
npm install
npm run build      # emits ESM JS + .d.ts to dist/
npm test           # typecheck + node:test unit suite
```

## Quick start

```ts
import { encode, decode } from 'cbor-codec';

const bytes = encode({ hello: 'world', n: 42n }, { canonical: true });
const value = decode(bytes); // Map { 'hello' => 'world', 'n' => 42n }
```

### Canonical encoding

```ts
import { encode } from 'cbor-codec';

encode(NaN, { canonical: true });  // f9 7e00
encode(-0, { canonical: true });   // f9 8000
encode(1.5, { canonical: true });  // f9 3e00
encode(1.1, { canonical: true });  // fb 3ff1999999999999a
encode(new Map([['b', 1n], ['a', 2n]]), { canonical: true });
// a2 6161 02  6162 01   (length-then-byte key order)
```

Duplicate canonical keys (including cross-type collisions such as the number
`1` and bigint `1n`, or two equal byte strings) throw `CborError` with
`code: 'duplicate-key'`.

### Incremental decoding

```ts
import { Decoder, NeedMoreDataError, CborError } from 'cbor-codec';

const d = new Decoder({ maxDepth: 100 });

socket.on('data', (chunk) => {
  d.write(chunk); // any chunk size, copied internally
  for (;;) {
    try {
      const { value, bytesConsumed } = d.decode();
      handle(value);
    } catch (e) {
      if (e instanceof NeedMoreDataError) break; // wait for more bytes
      if (e instanceof CborError) {
        // Permanent: the bad value is still at the front of the buffer.
        // Inspect it, then skip exactly its bytes; following values stay
        // intact.
        log(e.code, e.offset, e.valueOffset, e.path);
        d.skip(badValueLength(d.remainingBytes()));
        continue;
      }
      throw e;
    }
    if (d.bufferedLength === 0) break;
  }
});
```

- `d.write(chunk)` appends a chunk (copied, caller buffer reusable).
- `d.decode()` decodes one top-level value.
- `NeedMoreDataError` means the current value is incomplete; the decoder has
  rolled back to that value's first byte and resumes once more data is written.
- `CborError` means the bytes can never become valid; the decoder also rolls
  back, so no later top-level value is consumed. `skip(n)` discards bytes
  explicitly.
- `d.bytesConsumedTotal` is the running count of successfully consumed bytes;
  each `decode()` result also reports `bytesConsumed`.
- `d.remainingBytes()` returns a copy of pending data; `d.reset()` clears all
  state.

### Value model

| CBOR                        | JS                                |
| --------------------------- | --------------------------------- |
| unsigned / negative integer | `bigint`                          |
| tags 2/3 + byte string      | `bigint` (unwrapped)              |
| other tags                  | `Tagged`                          |
| byte string                 | `Uint8Array`                      |
| text                        | `string`                          |
| array                       | `Array`                           |
| map                         | `Map` (plain objects also encode) |
| false/true/null             | `false`/`true`/`null`             |
| undefined (simple 23)       | `undefined`                       |
| other simple values         | `Simple` (rejected by default)    |
| floats                      | `number`                          |

Plain objects encode as maps with string keys; use `Map` for non-string keys.

### Decode options

```ts
new Decoder({
  maxDepth: 100, // arrays/maps/tags nesting limit
  rejectDuplicateKeys: false, // compare encoded key bytes
  rejectUnknownSimple: true, // reject unassigned simple values
  rejectNonMinimal: false, // strict: reject 18 01-style heads
});
```

`decode(data, options?)` decodes exactly one value and rejects trailing bytes;
`decodeAll(data, options?)` decodes every top-level value in a complete buffer.

## Errors

```ts
class CborError extends Error {
  code:
    | 'truncated'
    | 'malformed'
    | 'unsupported'
    | 'depth'
    | 'duplicate-key'
    | 'utf8';
  offset: number; // absolute byte offset
  valueOffset?: number; // offset relative to the current top-level value
  path?: string; // e.g. "$[2].a.<key>"
}

class NeedMoreDataError extends Error {
  offset: number;
  valueOffset?: number;
}
```

## License

MIT
