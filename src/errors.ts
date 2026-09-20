/**
 * Machine-readable error codes produced by the encoder and decoder.
 */
export type CborErrorCode =
  // Encoder errors
  | 'UNENCODABLE_VALUE'
  | 'BIGINT_OUT_OF_RANGE'
  | 'UNSAFE_LENGTH'
  | 'CYCLE_DETECTED'
  | 'DUPLICATE_KEY'
  // Decoder errors (permanent format errors)
  | 'INVALID_HEAD'
  | 'INVALID_INDEFINITE_CHUNK'
  | 'BREAK_IN_VALUE'
  | 'INVALID_UTF8'
  | 'INVALID_SIMPLE_VALUE'
  | 'NON_STRING_MAP_KEY'
  | 'NESTING_TOO_DEEP'
  | 'INDEF_IN_DEF'
  | 'RESERVED_HEAD'
  | 'DUPLICATE_KEY_DECODE';

/**
 * Error thrown for every encoder failure and every *permanent* decoder
 * format error. It carries the zero-based byte offset at which the problem
 * was detected, measured from the start of the whole logical byte stream
 * (i.e. it is valid even when the offending value arrived in a later chunk).
 */
export class CborError extends Error {
  override readonly name = 'CborError';
  readonly code: CborErrorCode;
  /** Absolute byte offset in the logical stream, or -1 when not applicable. */
  readonly offset: number;
  /** Container depth at the point of failure (decoder only), or -1. */
  readonly depth: number;

  constructor(code: CborErrorCode, message: string, offset = -1, depth = -1) {
    super(message);
    this.code = code;
    this.offset = offset;
    this.depth = depth;
  }
}

/**
 * Thrown internally when an incremental decode needs more bytes.
 *
 * It deliberately does NOT extend {@link CborError}: needing more data is a
 * normal, recoverable condition rather than a format error. The public
 * streaming API ({@link CborDecoder}) never surfaces it as an exception;
 * the one-shot {@link decode} helper wraps it as {@link CborNeedMoreDataError}.
 */
export class CborNeedMoreDataError extends Error {
  override readonly name = 'CborNeedMoreDataError';
  /** Absolute offset reached while waiting for more data. */
  readonly offset: number;

  constructor(offset: number) {
    super('incomplete CBOR value: more data required');
    this.offset = offset;
  }
}
