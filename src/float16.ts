/**
 * Exact IEEE-754 half-float (binary16) conversion, used by the canonical
 * encoder to decide whether a double can be represented as an f16.
 *
 * Weight accounting: in a binary32 mantissa bit k (implicit leading 1 at
 * bit 23) has value weight 2^(k-23) * 2^(E-127). In a binary16 subnormal
 * payload r, bit j has weight 2^(j-24). So aligning requires a right shift
 * of 126 - E = 14 - halfExponent bits.
 */

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

/** Index of the highest set bit (0..10 for values up to 2047). */
function highestBit(x: number): number {
  return 31 - Math.clz32(x);
}

/** Shift a 32-bit non-negative integer right by `shift` (1..31), ties-to-even. */
function shiftRightRoundEven(value: number, shift: number): number {
  const halfBit = 1 << (shift - 1);
  const roundBits = value & ((halfBit << 1) - 1);
  let result = value >>> shift;
  if (roundBits > halfBit) {
    result += 1;
  } else if (roundBits === halfBit && (result & 1) === 1) {
    // Exactly at the tie point and the last retained bit is odd.
    result += 1;
  }
  return result >>> 0;
}

/**
 * Round a finite binary32 value (given by its bits) to binary16 and return
 * the 16-bit payload. Handles subnormals and round-to-nearest-even.
 * Callers handle NaN/±infinity before calling.
 */
function roundFloat32ToFloat16Bits(x: number): number {
  const sign = x & 0x80000000;
  const sign16 = sign >>> 16;
  const exponent = (x >>> 23) & 0xff;
  const mantissa = x & 0x7fffff;

  // Signed zero and f32 subnormals (all round to f16 zero).
  if (exponent === 0) return sign16;

  // Rebase exponent to the binary16 bias of 15.
  const halfExponent = exponent - 127 + 15;

  if (halfExponent >= 0x1f) {
    // Finite f32 value that exceeds the finite f16 range -> infinity.
    return sign16 | 0x7c00;
  }

  if (halfExponent <= 0) {
    // Subnormal f16 result: shift the implicit 1 and mantissa into place.
    const shift = 14 - halfExponent; // >= 14
    if (shift >= 32) return sign16; // rounds to zero
    const wide = mantissa | 0x800000; // restore implicit leading 1
    return sign16 | shiftRightRoundEven(wide, shift);
  }

  // Normal range: keep the top 10 mantissa bits, round on the 11th.
  // A rounding carry into bit 10 simply increments the exponent field.
  const roundedMantissa = shiftRightRoundEven(mantissa, 13);
  return sign16 | (halfExponent << 10) | roundedMantissa;
}

/** Decode a 16-bit half-float payload into a JavaScript number. */
export function float16BitsToNumber(bits: number): number {
  const sign = bits & 0x8000;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x03ff;

  if (exponent === 0 && mantissa === 0) {
    u32Scratch[0] = sign << 16;
    return f32Scratch[0]!;
  }
  if (exponent === 0) {
    // Subnormal: value = sign * mantissa * 2^-24. Normalize by locating
    // the highest set bit and expressing it as an f32 normal number.
    if (mantissa === 0) {
      u32Scratch[0] = sign << 16;
      return f32Scratch[0]!;
    }
    const h = highestBit(mantissa); // 0..9, weight 2^h in payload
    const f32Exponent = -24 + h + 127;
    const f32Mantissa = (mantissa << (23 - h)) & 0x7fffff;
    u32Scratch[0] = (sign << 16) | (f32Exponent << 23) | f32Mantissa;
    return f32Scratch[0]!;
  }
  if (exponent === 0x1f) {
    u32Scratch[0] = (sign << 16) | 0x7f800000 | (mantissa << 13);
    return f32Scratch[0]!;
  }
  // Normal number: rebias the exponent from binary16 (bias 15) to
  // binary32 (bias 127): exponent_f32 = exponent_f16 + 112.
  u32Scratch[0] = (sign << 16) | ((exponent + 112) << 23) | (mantissa << 13);
  return f32Scratch[0]!;
}

/**
 * If the double `value` is exactly representable as binary16, return its
 * 16-bit payload; otherwise return null. Exactness is verified by re-decoding
 * the payload and comparing with `Object.is` (so -0 and NaN behave correctly;
 * NaN always maps to the canonical payload 0x7e00).
 */
export function numberToFloat16BitsOrNone(value: number): number | null {
  if (Number.isNaN(value)) return 0x7e00;
  if (value === Infinity) return 0x7c00;
  if (value === -Infinity) return 0xfc00;
  if (Object.is(value, -0)) return 0x8000;
  if (value === 0) return 0x0000;

  // Every double representable as f16 is also representable as f32, so
  // narrowing through float32 first loses no information that f16 keeps.
  f32Scratch[0] = value;
  const f32Bits = u32Scratch[0]!;
  const bits = roundFloat32ToFloat16Bits(f32Bits);
  return float16BitsToNumber(bits) === value ? bits : null;
}
