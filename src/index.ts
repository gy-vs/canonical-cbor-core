/**
 * canonical-cbor-core: a zero-dependency CBOR (RFC 8949) codec.
 */
export { encode } from './encoder.js';
export { CborDecoder } from './decoder.js';
export { CborError, CborNeedMoreDataError } from './errors.js';
export type { CborErrorCode } from './errors.js';
export { CborTag, CborSimple } from './tag.js';
export type {
  EncodeOptions,
  DecodeOptions,
  DecodedValue,
  CborValue,
} from './types.js';

import { CborDecoder } from './decoder.js';
import { CborNeedMoreDataError } from './errors.js';
import type { DecodeOptions } from './types.js';

/**
 * Decode exactly one CBOR value from a complete byte sequence.
 *
 * Throws {@link CborNeedMoreDataError} when the input ends in the middle of
 * a value; throws {@link CborError} on permanent format errors. Extra bytes
 * after the first value are reported via the returned `length`/`consumed`
 * fields (they equal each other for this one-shot call).
 */
export function decode(
  bytes: Uint8Array,
  options: DecodeOptions = {},
): { value: unknown; consumed: number; length: number } {
  const decoder = new CborDecoder(options);
  decoder.push(bytes);
  const result = decoder.next();
  if (!result.done) {
    throw new CborNeedMoreDataError(bytes.length);
  }
  return { value: result.value, consumed: result.consumed, length: result.length };
}
