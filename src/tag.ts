/**
 * CBOR tags (major type 6) and unassigned simple values (major type 7).
 */

/**
 * A CBOR tag: `tag(value)`, RFC 8949 section 3.4.
 *
 * Decoded tagged values are produced as instances of this class, and the
 * encoder accepts it for re-encoding.
 */
export class CborTag {
  readonly tag: number | bigint;
  readonly value: unknown;

  constructor(tag: number | bigint, value: unknown) {
    this.tag = tag;
    this.value = value;
  }
}

/**
 * A CBOR "simple value" (major type 7, additional information 0..19 or 24+).
 *
 * The assigned simple values false (20), true (21), null (22) and
 * undefined (23) map directly to JavaScript primitives; use this class only
 * for other simple values. Values 24..31 are reserved by the spec and the
 * decoder exposes them through this class but the encoder rejects them.
 */
export class CborSimple {
  readonly value: number;

  constructor(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new RangeError(`simple value must be an integer in 0..255, got ${value}`);
    }
    this.value = value;
  }
}
