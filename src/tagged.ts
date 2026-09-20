/**
 * A CBOR tag wrapping another value: tag `tag` applied to `value`.
 */
export class Tagged {
  readonly tag: number | bigint;
  readonly value: unknown;

  constructor(tag: number | bigint, value: unknown) {
    if (typeof tag === 'number') {
      if (!Number.isInteger(tag) || tag < 0 || !Number.isSafeInteger(tag)) {
        throw new TypeError(`numeric tag must be a non-negative safe integer, got ${tag}`);
      }
    } else {
      if (tag < 0n || tag > 0xffffffffffffffffn) {
        throw new TypeError(`bigint tag must be in [0, 2^64-1], got ${tag}`);
      }
    }
    this.tag = tag;
    this.value = value;
  }

  static isTagged(v: unknown): v is Tagged {
    return v instanceof Tagged;
  }
}

/**
 * A CBOR "simple value" other than the well-known false/true/null/undefined.
 * Unassigned simple values are preserved on decode only when
 * `rejectUnknownSimple` is false.
 */
export class Simple {
  readonly value: number;

  constructor(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 255 || value === 24 || (value >= 28 && value <= 31)) {
      throw new TypeError(`invalid simple value ${value}`);
    }
    this.value = value;
  }
}
