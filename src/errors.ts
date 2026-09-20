/**
 * Structured error types raised by the CBOR codec.
 */

export type CborErrorCode =
  | 'truncated'
  | 'malformed'
  | 'unsupported'
  | 'depth'
  | 'duplicate-key'
  | 'utf8';

export interface CborErrorInfo {
  /** Machine-readable error category. */
  code: CborErrorCode;
  /**
   * Absolute byte offset within the data handed to the decoder/encoder.
   * For the incremental decoder this is the offset into the current
   * internal buffer; `valueOffset` is relative to the top-level value.
   */
  offset: number;
  /** Offset relative to the start of the current top-level value. */
  valueOffset?: number;
  /** Navigation path inside the value, e.g. `[2].a` (best effort). */
  path?: string;
  message: string;
}

/** Permanent structural error: feeding more bytes can never make it valid. */
export class CborError extends Error implements CborErrorInfo {
  readonly code: CborErrorCode;
  readonly offset: number;
  readonly valueOffset?: number;
  readonly path?: string;

  constructor(info: CborErrorInfo) {
    const at = info.valueOffset !== undefined ? `value+${info.valueOffset}` : `offset ${info.offset}`;
    super(`${info.code} at ${at}${info.path ? ` (path ${info.path})` : ''}: ${info.message}`);
    this.name = 'CborError';
    this.code = info.code;
    this.offset = info.offset;
    if (info.valueOffset !== undefined) this.valueOffset = info.valueOffset;
    if (info.path !== undefined) this.path = info.path;
  }
}

/**
 * Transient condition: the byte stream is currently incomplete.
 *
 * This is *not* a `CborError`. Feeding additional chunks may allow parsing
 * to continue. For the incremental decoder, no bytes of the in-progress
 * value are consumed when this is thrown.
 */
export class NeedMoreDataError extends Error {
  /** Absolute offset in the current internal buffer where more bytes are needed. */
  readonly offset: number;
  /** Offset relative to the start of the current top-level value. */
  readonly valueOffset?: number;

  constructor(offset: number, valueOffset?: number, message = 'unexpected end of data') {
    super(`need more data at offset ${offset}${valueOffset !== undefined ? ` (value+${valueOffset})` : ''}: ${message}`);
    this.name = 'NeedMoreDataError';
    this.offset = offset;
    if (valueOffset !== undefined) this.valueOffset = valueOffset;
  }
}

export function isNeedMoreData(e: unknown): e is NeedMoreDataError {
  return e instanceof NeedMoreDataError;
}

export function isCborError(e: unknown): e is CborError {
  return e instanceof CborError;
}
