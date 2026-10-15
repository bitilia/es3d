// Normative sine and cosine for placement.
//
// IEEE 754 does not require Math.sin and Math.cos to be correctly rounded, so
// two readers can disagree in the last bit. Scatter positions and rotation
// matrices use the functions below instead. Every operation is a binary64
// round-to-nearest add, subtract or multiply, in the order written, so every
// IEEE 754 implementation produces the same bits.
//
// Tessellation of spheres, gears and paths may keep the platform sin and cos.
// Those meshes are bounded by a chordal error, not hashed.

const PI = Math.PI;
const TWO_PI = PI * 2;
const HALF_PI = PI * 0.5;
const QUARTER_PI = PI * 0.25;

// fdlibm __kernel_sin coefficients, as binary64 literals. Valid for |x| <= π/4.
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

// fdlibm __kernel_cos coefficients.
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

function kernelSin(x) {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + v * (S1 + z * r);
}

function kernelCos(x) {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  // 1 - z/2 + z^2 * (C1 + ...). The extra z is the Taylor power; r already holds one.
  return 1 - 0.5 * z + z * r;
}

/** Sine of a radian angle. Finite inputs only; non-finite values pass through. */
export function es3dSin(x) {
  if (!Number.isFinite(x)) return x;
  let y = x - TWO_PI * Math.round(x / TWO_PI);
  let sign = 1;
  if (y < 0) {
    sign = -1;
    y = -y;
  }
  if (y > HALF_PI) y = PI - y;
  if (y < 0) y = 0;
  const s = y > QUARTER_PI ? kernelCos(HALF_PI - y) : kernelSin(y);
  return sign < 0 ? -s : s;
}

/** Cosine. Defined as sin(x + π/2) with the same reduction. */
export function es3dCos(x) {
  return es3dSin(x + HALF_PI);
}
