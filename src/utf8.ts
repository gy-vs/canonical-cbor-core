/**
 * Strict UTF-8 validation following the WHATWG Encoding Standard byte
 * decoder state machine.
 *
 * The incremental decoder may receive a single text string spread across
 * several chunks (indefinite-length text), so validation happens over the
 * full reassembled UTF-8 byte sequence. Invalid sequences are permanent
 * errors; this routine returns the index of the first offending *leading*
 * byte (or continuation byte when no lead is applicable), or -1.
 */

/** Validate UTF-8; return the index of the first invalid byte, or -1. */
export function findInvalidUtf8(bytes: Uint8Array): number {
  let i = 0;
  const len = bytes.length;

  while (i < len) {
    const lead = bytes[i]!;

    if (lead < 0x80) {
      i += 1;
      continue;
    }

    if (lead >= 0xc2 && lead <= 0xdf) {
      if (!isContinuation(bytes, i + 1)) return i;
      i += 2;
      continue;
    }

    if (lead >= 0xe0 && lead <= 0xef) {
      const b1 = at(bytes, i + 1);
      const b2 = at(bytes, i + 2);
      if (b1 < 0 || b2 < 0) return i;
      let valid = b1 >= 0x80 && b1 <= 0xbf && b2 >= 0x80 && b2 <= 0xbf;
      if (lead === 0xe0) valid = b1 >= 0xa0 && b1 <= 0xbf && b2 >= 0x80 && b2 <= 0xbf;
      if (lead === 0xed) valid = b1 >= 0x80 && b1 <= 0x9f && b2 >= 0x80 && b2 <= 0xbf;
      if (!valid) return i;
      i += 3;
      continue;
    }

    if (lead >= 0xf0 && lead <= 0xf4) {
      const b1 = at(bytes, i + 1);
      const b2 = at(bytes, i + 2);
      const b3 = at(bytes, i + 3);
      if (b1 < 0 || b2 < 0 || b3 < 0) return i;
      let valid =
        b1 >= 0x80 && b1 <= 0xbf &&
        b2 >= 0x80 && b2 <= 0xbf &&
        b3 >= 0x80 && b3 <= 0xbf;
      if (lead === 0xf0) {
        valid =
          b1 >= 0x90 && b1 <= 0xbf &&
          b2 >= 0x80 && b2 <= 0xbf &&
          b3 >= 0x80 && b3 <= 0xbf;
      }
      if (lead === 0xf4) {
        valid =
          b1 >= 0x80 && b1 <= 0x8f &&
          b2 >= 0x80 && b2 <= 0xbf &&
          b3 >= 0x80 && b3 <= 0xbf;
      }
      if (!valid) return i;
      i += 4;
      continue;
    }

    // Stray continuation byte (0x80..0xbf), overlong lead 0xc0/0xc1,
    // or 0xf5..0xff: all illegal here.
    return i;
  }

  return -1;
}

function at(bytes: Uint8Array, index: number): number {
  return index < bytes.length ? bytes[index]! : -1;
}

function isContinuation(bytes: Uint8Array, index: number): boolean {
  const b = at(bytes, index);
  return b >= 0x80 && b <= 0xbf;
}

const textDecoderCache = new TextDecoder('utf-8', { fatal: false });

/** Decode UTF-8 bytes that have already been validated. */
export function decodeUtf8(bytes: Uint8Array): string {
  return textDecoderCache.decode(bytes);
}
