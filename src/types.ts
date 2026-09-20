/**
 * Public types for the canonical-cbor-core library.
 */
import type { CborSimple, CborTag } from './tag.js';

/** Options accepted by {@link encode}. */
export interface EncodeOptions {
  /**
   * When `true`, emit a deterministic canonical encoding:
   * - shortest possible integer argument for every head;
   * - shortest floating-point representation that round-trips exactly
   *   (NaN is always the half-float payload `0x7e00`);
   * - map keys sorted by encoded byte length, then lexicographically;
   * - duplicate map keys (equal encoded bytes) are rejected.
   *
   * Defaults to `false`.
   */
  canonical?: boolean;
}

/** Options accepted by {@link CborDecoder}. */
export interface DecodeOptions {
  /** Maximum nesting depth of arrays, maps and tags. Defaults to 100. */
  maxDepth?: number;
  /**
   * Reject maps containing duplicate keys. Keys are compared by their raw
   * encoded CBOR bytes (the canonical CBOR key-equivalence rule).
   * Defaults to `false`.
   */
  rejectDuplicateKeys?: boolean;
}

/** Result returned by {@link CborDecoder.next} when a full value was decoded. */
export interface DecodedValue {
  value: unknown;
  /** Bytes consumed from the total byte stream, across all pushed chunks. */
  consumed: number;
  /** Length, in bytes, of this value alone. */
  length: number;
}

/**
 * Any value representable by the encoder:
 * integers/numbers, bigints, typed arrays, strings, booleans, null,
 * undefined, arrays, plain objects/Maps, {@link CborTag} and
 * {@link CborSimple}.
 */
export type CborValue =
  | number
  | bigint
  | Uint8Array
  | string
  | boolean
  | null
  | undefined
  | CborValue[]
  | { [key: string]: CborValue }
  | Map<unknown, unknown>
  | CborTag
  | CborSimple;
