/**
 * IEEE-754 half-precision (binary16) helpers, implemented without
 * Float16Array so the library runs on every Node 20 release.
 */

const F16_MAX_EXP = 0x1f;
const F16_MAX_MANT = 0x3ff;

const F64_MANT_BITS = 52;
const F64_EXP_BIAS = 1023;
const F64_MAX_EXP = 0x7ff;

/** Decode a 16-bit half-float bit pattern into a JS number. */
export function decodeHalf(u16: number): number {
  const sign = (u16 & 0x8000) ? -1 : 1;
  const exp = (u16 >>> 10) & F16_MAX_EXP;
  const mant = u16 & F16_MAX_MANT;

  if (exp === 0) {
    // Subnormal (or zero): value = sign * 2^-14 * (mant / 1024)
    return sign * 2 ** -14 * (mant / 1024);
  }
  if (exp === F16_MAX_EXP) {
    return mant === 0 ? sign * Infinity : NaN;
  }
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

/**
 * Encode a double losslessly to its 16-bit pattern, or return null when
 * the value is not exactly representable as binary16.
 */
export function encodeHalfExact(x: number): number | null {
  if (Number.isNaN(x)) return 0x7e00;
  if (x === Infinity) return 0x7c00;
  if (x === -Infinity) return 0xfc00;
  if (Object.is(x, -0)) return 0x8000;
  if (x === 0) return 0x0000;

  const bits = roundToHalf(x);
  if (bits === null) return null;
  // Rounding to binary16 must reproduce the original double exactly.
  return Object.is(decodeHalf(bits), x) ? bits : null;
}

/** Round x to a binary16 pattern (null only on finite-range overflow). */
function roundToHalf(x: number): number | null {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x, false);
  const bits = dv.getBigUint64(0, false);

  const sign = Number(bits >> 63n);
  const exp64 = Number((bits >> BigInt(F64_MANT_BITS)) & BigInt(F64_MAX_EXP));
  const mant64 = bits & ((1n << BigInt(F64_MANT_BITS)) - 1n);
  const e = exp64 === 0 ? 1 - F64_EXP_BIAS : exp64 - F64_EXP_BIAS;

  if (e > 15) {
    // Magnitude too large for binary16 finite range.
    return null;
  }

  if (e < -25) {
    // Below half of the smallest subnormal binary16 (2^-24): the only
    // tie, 2^-25 with the minimal significand, rounds to even zero too,
    // so everything here becomes ±0.
    return sign << 15;
  }

  if (e < -14) {
    // Subnormal binary16 result: real mantissa m = value / 2^-24
    //   = sig * 2^(e-28) = (sig >> shift) with shift = 28 - e in 43..53.
    // Round the dropped low bits to nearest, ties to even.
    const shift = 28 - e;
    const mask = (1n << BigInt(shift)) - 1n;
    const halfBit = 1n << BigInt(shift - 1);
    const sig = (1n << BigInt(F64_MANT_BITS)) | mant64;
    const low = sig & mask;
    let mant16 = Number(sig >> BigInt(shift));
    if (low > halfBit || (low === halfBit && (mant16 & 1) === 1)) {
      mant16 += 1;
    }
    if (mant16 >= 1024) {
      // Rounded up to 2^-14: the smallest *normal* binary16 (0x0400).
      return (sign << 15) | 0x0400;
    }
    return (sign << 15) | mant16;
  }

  // Normal binary16: drop the low 42 mantissa bits, round to nearest even.
  const dropped = mant64 & ((1n << 42n) - 1n);
  let mant16 = Number(mant64 >> 42n);
  let exp16 = e + 15;
  if (dropped > 1n << 41n || (dropped === 1n << 41n && (mant16 & 1) === 1)) {
    mant16 += 1;
    if (mant16 === 1024) {
      // Carry into the exponent.
      mant16 = 0;
      exp16 += 1;
      if (exp16 === F16_MAX_EXP) {
        // Rounded up to infinity: not an exact finite representation.
        return null;
      }
    }
  }
  return (sign << 15) | (exp16 << 10) | mant16;
}
