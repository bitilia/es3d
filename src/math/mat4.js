// Minimal column-major 4x4 matrix library (same memory layout as WebGL/WebGPU).
// Functions write into `out` and return it; `out` may alias an input.
// Rotations use the normative placement trig so two readers build the same matrix.

import { es3dCos, es3dSin } from './trig.js';

export const DEG = Math.PI / 180;

export function create() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function createF64() {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function identity(out) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function copy(out, a) {
  for (let i = 0; i < 16; i++) out[i] = a[i];
  return out;
}

export function clone(a) {
  return new Float64Array(a);
}

export function isIdentity(a, eps = 1e-12) {
  for (let i = 0; i < 16; i++) {
    const e = i % 5 === 0 ? 1 : 0;
    if (Math.abs(a[i] - e) > eps) return false;
  }
  return true;
}

export function multiply(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
  out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
  out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
  out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  return out;
}

/** Multiply affine matrices (last row is 0,0,0,1). Faster for scene graphs. */
export function multiplyAffine(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2];
  const a10 = a[4], a11 = a[5], a12 = a[6];
  const a20 = a[8], a21 = a[9], a22 = a[10];
  const a30 = a[12], a31 = a[13], a32 = a[14];
  const b00 = b[0], b01 = b[1], b02 = b[2];
  const b10 = b[4], b11 = b[5], b12 = b[6];
  const b20 = b[8], b21 = b[9], b22 = b[10];
  const b30 = b[12], b31 = b[13], b32 = b[14];
  out[0] = b00 * a00 + b01 * a10 + b02 * a20;
  out[1] = b00 * a01 + b01 * a11 + b02 * a21;
  out[2] = b00 * a02 + b01 * a12 + b02 * a22;
  out[3] = 0;
  out[4] = b10 * a00 + b11 * a10 + b12 * a20;
  out[5] = b10 * a01 + b11 * a11 + b12 * a21;
  out[6] = b10 * a02 + b11 * a12 + b12 * a22;
  out[7] = 0;
  out[8] = b20 * a00 + b21 * a10 + b22 * a20;
  out[9] = b20 * a01 + b21 * a11 + b22 * a21;
  out[10] = b20 * a02 + b21 * a12 + b22 * a22;
  out[11] = 0;
  out[12] = b30 * a00 + b31 * a10 + b32 * a20 + a30;
  out[13] = b30 * a01 + b31 * a11 + b32 * a21 + a31;
  out[14] = b30 * a02 + b31 * a12 + b32 * a22 + a32;
  out[15] = 1;
  return out;
}

export function fromTranslation(out, x, y, z) {
  identity(out);
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}

export function fromScaling(out, x, y, z) {
  identity(out);
  out[0] = x;
  out[5] = y;
  out[10] = z;
  return out;
}

export function fromRotationX(out, rad) {
  const c = es3dCos(rad), s = es3dSin(rad);
  identity(out);
  out[5] = c;
  out[6] = s;
  out[9] = -s;
  out[10] = c;
  return out;
}

export function fromRotationY(out, rad) {
  const c = es3dCos(rad), s = es3dSin(rad);
  identity(out);
  out[0] = c;
  out[2] = -s;
  out[8] = s;
  out[10] = c;
  return out;
}

export function fromRotationZ(out, rad) {
  const c = es3dCos(rad), s = es3dSin(rad);
  identity(out);
  out[0] = c;
  out[1] = s;
  out[4] = -s;
  out[5] = c;
  return out;
}

/**
 * ES3D Euler convention: rotation="x,y,z" (degrees) rotates about the fixed X
 * axis first, then Y, then Z, i.e. R = Rz * Ry * Rx (Blender "XYZ Euler").
 */
export function fromEulerDeg(out, xd, yd, zd) {
  const x = xd * DEG, y = yd * DEG, z = zd * DEG;
  const cx = es3dCos(x), sx = es3dSin(x);
  const cy = es3dCos(y), sy = es3dSin(y);
  const cz = es3dCos(z), sz = es3dSin(z);
  // columns of Rz*Ry*Rx
  out[0] = cz * cy;
  out[1] = sz * cy;
  out[2] = -sy;
  out[3] = 0;
  out[4] = cz * sy * sx - sz * cx;
  out[5] = sz * sy * sx + cz * cx;
  out[6] = cy * sx;
  out[7] = 0;
  out[8] = cz * sy * cx + sz * sx;
  out[9] = sz * sy * cx - cz * sx;
  out[10] = cy * cx;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

export function fromAxisAngle(out, ax, ay, az, rad) {
  let len = Math.hypot(ax, ay, az);
  if (len < 1e-12) return identity(out);
  len = 1 / len;
  const x = ax * len, y = ay * len, z = az * len;
  const s = es3dSin(rad), c = es3dCos(rad), t = 1 - c;
  out[0] = x * x * t + c;
  out[1] = y * x * t + z * s;
  out[2] = z * x * t - y * s;
  out[3] = 0;
  out[4] = x * y * t - z * s;
  out[5] = y * y * t + c;
  out[6] = z * y * t + x * s;
  out[7] = 0;
  out[8] = x * z * t + y * s;
  out[9] = y * z * t - x * s;
  out[10] = z * z * t + c;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

export function fromQuat(out, x, y, z, w) {
  const len = Math.hypot(x, y, z, w) || 1;
  x /= len; y /= len; z /= len; w /= len;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, yx = y * x2, yy = y * y2;
  const zx = z * x2, zy = z * y2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - yy - zz;
  out[1] = yx + wz;
  out[2] = zx - wy;
  out[3] = 0;
  out[4] = yx - wz;
  out[5] = 1 - xx - zz;
  out[6] = zy + wx;
  out[7] = 0;
  out[8] = zx + wy;
  out[9] = zy - wx;
  out[10] = 1 - xx - yy;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

/** M = T(position) * R(euler) * S(scale) */
export function compose(out, position, rotationDeg, scale) {
  fromEulerDeg(out, rotationDeg[0], rotationDeg[1], rotationDeg[2]);
  const sx = scale[0], sy = scale[1], sz = scale[2];
  out[0] *= sx; out[1] *= sx; out[2] *= sx;
  out[4] *= sy; out[5] *= sy; out[6] *= sy;
  out[8] *= sz; out[9] *= sz; out[10] *= sz;
  out[12] = position[0];
  out[13] = position[1];
  out[14] = position[2];
  return out;
}

export function invert(out, a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

export function transpose(out, a) {
  if (out === a) {
    const a01 = a[1], a02 = a[2], a03 = a[3], a12 = a[6], a13 = a[7], a23 = a[11];
    out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
    out[4] = a01; out[6] = a[9]; out[7] = a[13];
    out[8] = a02; out[9] = a12; out[11] = a[14];
    out[12] = a03; out[13] = a13; out[14] = a23;
    return out;
  }
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = a[r * 4 + c];
  return out;
}

export function determinant3(a) {
  return (
    a[0] * (a[5] * a[10] - a[6] * a[9]) -
    a[4] * (a[1] * a[10] - a[2] * a[9]) +
    a[8] * (a[1] * a[6] - a[2] * a[5])
  );
}

/** Largest axis scale factor of the upper 3x3. */
export function maxScale(a) {
  const sx = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
  const sy = a[4] * a[4] + a[5] * a[5] + a[6] * a[6];
  const sz = a[8] * a[8] + a[9] * a[9] + a[10] * a[10];
  return Math.sqrt(Math.max(sx, sy, sz));
}

export function transformPoint(out, m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return out;
}

export function transformDir(out, m, x, y, z) {
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

/**
 * Perspective projection. zeroToOne selects the WebGPU clip-space depth range
 * [0,1]; otherwise the OpenGL range [-1,1] is used.
 */
export function perspective(out, fovyRad, aspect, near, far, zeroToOne = false) {
  const f = 1 / Math.tan(fovyRad / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  if (zeroToOne) {
    out[10] = far / (near - far);
    out[14] = (far * near) / (near - far);
  } else {
    out[10] = (far + near) / (near - far);
    out[14] = (2 * far * near) / (near - far);
  }
  return out;
}

export function ortho(out, left, right, bottom, top, near, far, zeroToOne = false) {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = -2 * lr;
  out[5] = -2 * bt;
  out[12] = (left + right) * lr;
  out[13] = (top + bottom) * bt;
  if (zeroToOne) {
    out[10] = nf;
    out[14] = near * nf;
  } else {
    out[10] = 2 * nf;
    out[14] = (far + near) * nf;
  }
  out[15] = 1;
  return out;
}

export function lookAt(out, eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz);
  if (len < 1e-12) return identity(out);
  zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-12) {
    // up is parallel to the view direction: pick another up vector
    const alt = Math.abs(zy) < 0.9 ? [0, 1, 0] : [0, 0, 1];
    xx = alt[1] * zz - alt[2] * zy;
    xy = alt[2] * zx - alt[0] * zz;
    xz = alt[0] * zy - alt[1] * zx;
    len = Math.hypot(xx, xy, xz);
  }
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

/**
 * Decompose an affine matrix into translation, rotation quaternion and scale.
 * Returns null when the matrix contains shear (not representable as TRS).
 */
export function decompose(m, eps = 1e-5) {
  const t = [m[12], m[13], m[14]];
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  if (determinant3(m) < 0) sx = -sx;
  if (Math.abs(sx) < 1e-20 || sy < 1e-20 || sz < 1e-20) return null;
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  // orthogonality check (shear detection)
  const d01 = r[0] * r[3] + r[1] * r[4] + r[2] * r[5];
  const d02 = r[0] * r[6] + r[1] * r[7] + r[2] * r[8];
  const d12 = r[3] * r[6] + r[4] * r[7] + r[5] * r[8];
  if (Math.abs(d01) > eps || Math.abs(d02) > eps || Math.abs(d12) > eps) return null;
  const q = quatFromRotationMatrix(r);
  return { translation: t, rotation: q, scale: [sx, sy, sz] };
}

/** r: 3x3 column-major rotation matrix */
export function quatFromRotationMatrix(r) {
  const m00 = r[0], m10 = r[1], m20 = r[2];
  const m01 = r[3], m11 = r[4], m21 = r[5];
  const m02 = r[6], m12 = r[7], m22 = r[8];
  const trace = m00 + m11 + m22;
  let x, y, z, w;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const len = Math.hypot(x, y, z, w) || 1;
  return [x / len, y / len, z / len, w / len];
}

/** Integer power of an affine matrix by repeated squaring. */
export function power(out, m, n) {
  const result = createF64();
  let base = new Float64Array(m);
  let k = n;
  const tmp = new Float64Array(16);
  while (k > 0) {
    if (k & 1) {
      multiplyAffine(tmp, result, base);
      result.set(tmp);
    }
    k >>= 1;
    if (k) {
      multiplyAffine(tmp, base, base);
      base = new Float64Array(tmp);
    }
  }
  out.set(result);
  return out;
}

export function equals(a, b, eps = 1e-9) {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > eps * Math.max(1, Math.abs(a[i]), Math.abs(b[i]))) return false;
  return true;
}
