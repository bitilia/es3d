// The ES3D transform system.
//
// transform="translate(0,2,0) rotate(0,45,0) scale(2)" is read exactly like
// SVG: functions are applied left to right as nested coordinate systems, so the
// resulting matrix is T1 * T2 * T3 (the rightmost function acts on the object
// first). Supported functions:
//
//   translate(x[,y[,z]])      rotate(x,y,z)  Euler degrees (X, then Y, then Z)
//   rotateX(a) rotateY(a) rotateZ(a)         rotate(a, ax,ay,az) axis-angle
//   scale(s) | scale(x,y,z)                  quat(x,y,z,w)
//   matrix(m0..m15)  16 numbers, column-major (like CSS matrix3d)
//
// Elements additionally accept position / rotation / scale attributes. The
// local matrix of an element is   transform * T(position) * R(rotation) * S(scale)
// mirroring SVG <use>, where x/y are applied after (inside) the transform.

import * as mat4 from '../math/mat4.js';
import { ValueError } from '../format/value-error.js';
import { suggest } from '../format/errors.js';
import { readNumber, numberValue } from '../path/path-parser.js';

const FUNCS = {
  translate: [1, 3],
  rotate: [3, 4],
  rotateX: [1, 1],
  rotateY: [1, 1],
  rotateZ: [1, 1],
  scale: [1, 3],
  matrix: [16, 16],
  quat: [4, 4],
};

function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 44; // comma acts as separator between functions
}

/** Parse a transform list into operations (validated, with offsets). */
export function parseTransformOps(str) {
  const ops = [];
  const n = str.length;
  let i = 0;
  while (true) {
    while (i < n && isWs(str.charCodeAt(i))) i++;
    if (i >= n) break;
    const nameStart = i;
    while (i < n && /[A-Za-z0-9]/.test(str[i])) i++;
    const fn = str.slice(nameStart, i);
    if (!fn) throw new ValueError(`Unexpected character '${str[i]}' in transform.`, i, 1);
    if (!(fn in FUNCS)) {
      throw new ValueError(`Unknown transform function '${fn}'.`, nameStart, fn.length, {
        suggestion: suggest(fn, Object.keys(FUNCS)),
        hint: 'Valid functions: translate, rotate, rotateX, rotateY, rotateZ, scale, matrix, quat.',
      });
    }
    while (i < n && (str[i] === ' ' || str[i] === '\t')) i++;
    if (str[i] !== '(') throw new ValueError(`Expected '(' after '${fn}'.`, i, 1);
    i++;
    const args = [];
    for (;;) {
      while (i < n && /[\s,]/.test(str[i])) i++;
      if (str[i] === ')') {
        i++;
        break;
      }
      if (i >= n) throw new ValueError(`Missing ')' to close '${fn}('.`, nameStart, fn.length + 1);
      const end = readNumber(str, i);
      if (end < 0) throw new ValueError(`Expected a number in '${fn}()' but found '${str[i]}'.`, i, 1);
      args.push(numberValue);
      i = end;
    }
    const [min, max] = FUNCS[fn];
    if (args.length < min || args.length > max) {
      let hint;
      if (fn === 'rotate' && args.length === 1) hint = 'rotate() takes Euler angles rotate(x,y,z) or an axis-angle rotate(a,ax,ay,az); use rotateY(a) for a single angle.';
      if (fn === 'rotate' && args.length === 2) hint = 'rotate() takes 3 Euler angles in degrees, e.g. rotate(0,45,0).';
      throw new ValueError(
        `${fn}() takes ${min === max ? min : `${min} to ${max}`} numbers but ${args.length} ${args.length === 1 ? 'was' : 'were'} given.`,
        nameStart,
        i - nameStart,
        { hint },
      );
    }
    if (fn === 'rotate' && args.length === 4 && Math.hypot(args[1], args[2], args[3]) < 1e-12) {
      throw new ValueError('rotate(angle, ax, ay, az): the rotation axis must not be zero.', nameStart, i - nameStart);
    }
    if (fn === 'scale' && args.length === 2) {
      throw new ValueError('scale() takes 1 (uniform) or 3 numbers.', nameStart, i - nameStart);
    }
    ops.push({ fn, args, offset: nameStart });
  }
  return ops;
}

/** Matrix of a single transform operation. */
export function opMatrix(op, out = mat4.createF64()) {
  const a = op.args;
  switch (op.fn) {
    case 'translate':
      return mat4.fromTranslation(out, a[0], a[1] || 0, a[2] || 0);
    case 'rotate':
      if (a.length === 4) return mat4.fromAxisAngle(out, a[1], a[2], a[3], a[0] * mat4.DEG);
      return mat4.fromEulerDeg(out, a[0], a[1], a[2]);
    case 'rotateX':
      return mat4.fromRotationX(out, a[0] * mat4.DEG);
    case 'rotateY':
      return mat4.fromRotationY(out, a[0] * mat4.DEG);
    case 'rotateZ':
      return mat4.fromRotationZ(out, a[0] * mat4.DEG);
    case 'scale':
      return a.length === 1 ? mat4.fromScaling(out, a[0], a[0], a[0]) : mat4.fromScaling(out, a[0], a[1], a[2]);
    case 'matrix':
      for (let k = 0; k < 16; k++) out[k] = a[k];
      return out;
    case 'quat':
      return mat4.fromQuat(out, a[0], a[1], a[2], a[3]);
    default:
      throw new Error(`unknown transform ${op.fn}`);
  }
}

export function opsToMatrix(ops) {
  const m = mat4.createF64();
  const t = mat4.createF64();
  for (const op of ops) {
    opMatrix(op, t);
    mat4.multiply(m, m, t);
  }
  return m;
}

/**
 * {ops, matrix} for already separated operations (binary decoding), applying
 * the same rules as the text parser; null when an operation is invalid.
 */
export function transformFromOps(ops) {
  for (const op of ops) {
    const range = FUNCS[op.fn];
    if (!range) return null;
    const n = op.args.length;
    if (n < range[0] || n > range[1] || !op.args.every(Number.isFinite)) return null;
    if (op.fn === 'rotate' && n === 4 && Math.hypot(op.args[1], op.args[2], op.args[3]) < 1e-12) return null;
    if (op.fn === 'scale' && n === 2) return null;
  }
  return { ops, matrix: opsToMatrix(ops) };
}

/** Parse a transform attribute value into {ops, matrix}. */
export function parseTransform(str) {
  const ops = parseTransformOps(str);
  return { ops, matrix: opsToMatrix(ops) };
}

const ZERO = [0, 0, 0];
const ONE = [1, 1, 1];

/**
 * Local matrix of an element from its typed values:
 *   transform * T(position) * R(rotation) * S(scale)
 */
export function localMatrix(values, out = mat4.createF64(), overrides = null) {
  const position = (overrides && overrides.position) || values.position || ZERO;
  const rotation = (overrides && overrides.rotation) || values.rotation || ZERO;
  const scale = (overrides && overrides.scale) || values.scale || ONE;
  mat4.compose(out, position, rotation, scale);
  const tr = values.transform;
  if (tr && tr.ops.length) mat4.multiply(out, tr.matrix, out);
  return out;
}

/** Format a matrix as a transform string (used by serializers / expansion). */
export function matrixToTransformString(m, fmt) {
  const d = mat4.decompose(m);
  if (d) {
    const parts = [];
    const [tx, ty, tz] = d.translation;
    if (Math.abs(tx) > 1e-9 || Math.abs(ty) > 1e-9 || Math.abs(tz) > 1e-9) parts.push(`translate(${fmt(tx)},${fmt(ty)},${fmt(tz)})`);
    const [qx, qy, qz, qw] = d.rotation;
    if (Math.abs(qx) > 1e-9 || Math.abs(qy) > 1e-9 || Math.abs(qz) > 1e-9) parts.push(`quat(${fmt(qx)},${fmt(qy)},${fmt(qz)},${fmt(qw)})`);
    const [sx, sy, sz] = d.scale;
    if (Math.abs(sx - 1) > 1e-9 || Math.abs(sy - 1) > 1e-9 || Math.abs(sz - 1) > 1e-9) {
      if (Math.abs(sx - sy) < 1e-9 && Math.abs(sy - sz) < 1e-9) parts.push(`scale(${fmt(sx)})`);
      else parts.push(`scale(${fmt(sx)},${fmt(sy)},${fmt(sz)})`);
    }
    return parts.join(' ');
  }
  return `matrix(${Array.from(m, fmt).join(',')})`;
}

/**
 * Decompose a shear-free affine matrix into translation, ES3D Euler angles
 * (degrees, R = Rz * Ry * Rx) and scale. Returns null when shear is present.
 */
export function matrixToEuler(m) {
  const d = mat4.decompose(m);
  if (!d) return null;
  const [sx, sy, sz] = d.scale;
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  const R2 = Math.max(-1, Math.min(1, -r[2]));
  const y = Math.asin(R2);
  let x, z;
  if (Math.abs(R2) < 0.9999999) {
    x = Math.atan2(r[5], r[8]);
    z = Math.atan2(r[1], r[0]);
  } else {
    // gimbal lock: rotation about X and Z are coupled; put everything into Z
    x = 0;
    z = Math.atan2(-r[3], r[4]);
  }
  const deg = (v) => (v * 180) / Math.PI;
  return { translation: d.translation, rotation: [deg(x), deg(y), deg(z)], scale: d.scale };
}
