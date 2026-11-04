// Shared number and transform formatting for the text exporters.
//
// Coordinates use fixed() so the same scene always produces the same bytes.
// Six digits is enough to round-trip the placements these formats store
// (a degree of rotation, a scale, a coordinate) without trailing noise.

import * as mat4 from '../math/mat4.js';
import { fixed } from './external-scene.js';

export const DIGITS = 6;

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Fixed-point number, trimmed. Non-finite values become 0. */
export function n(v) {
  return fixed(Number.isFinite(v) ? v : 0, DIGITS);
}

/** Numbers wrapped onto several lines. `per` values per line. */
export function numList(values, per = 12) {
  const parts = [];
  for (let i = 0; i < values.length; i++) {
    if (i) parts.push(i % per === 0 ? '\n        ' : ' ');
    parts.push(n(values[i]));
  }
  return parts.join('');
}

/**
 * Translation, quaternion [x, y, z, w] and scale of an affine matrix.
 * Null when the matrix shears, which TRS cannot represent.
 * `identity` is the 4x4 identity. `plain` is a pure translation.
 */
export function trsOf(m) {
  if (!m || mat4.isIdentity(m, 1e-9)) {
    return { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], identity: true, plain: true, scaleOnly: true };
  }
  const d = mat4.decompose(m, 1e-6);
  if (!d) return null;
  const translation = d.translation;
  const rotation = d.rotation;
  const scale = d.scale;
  const plain = Math.hypot(rotation[0], rotation[1], rotation[2]) < 1e-8 && scale.every((v) => Math.abs(v - 1) < 1e-8);
  const noRot = Math.hypot(rotation[0], rotation[1], rotation[2]) < 1e-8;
  const noScale = scale.every((v) => Math.abs(v - 1) < 1e-8);
  const noTrans = translation.every((v) => Math.abs(v) < 1e-8);
  return { translation, rotation, scale, identity: plain && noTrans, plain, scaleOnly: noRot, rotationOnly: noTrans && noScale, noRot, noScale, noTrans };
}

/** Axis (unit) and angle in radians of a quaternion [x, y, z, w]. */
export function axisAngle(q) {
  let x = q[0], y = q[1], z = q[2], w = q[3];
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const angle = 2 * Math.acos(Math.min(1, Math.max(-1, w)));
  const s = Math.sin(angle / 2);
  if (Math.abs(s) < 1e-8 || angle < 1e-8) return { axis: [0, 1, 0], angle: 0 };
  return { axis: [x / s, y / s, z / s], angle };
}

/**
 * Rows of a column-vector matrix (translation in the last column).
 * OpenSCAD multmatrix uses this layout.
 */
export function matrixRows(m) {
  const a = m || I;
  const rows = [];
  for (let r = 0; r < 4; r++) rows.push([a[r], a[r + 4], a[r + 8], a[r + 12]]);
  return rows;
}

/**
 * Rows of the transpose. OpenUSD applies row vectors (p' = p · M), so a
 * translation lives on the last row. See usd.js.
 */
export function usdRows(m) {
  const a = m || I;
  const rows = [];
  for (let c = 0; c < 4; c++) rows.push([a[c * 4], a[c * 4 + 1], a[c * 4 + 2], a[c * 4 + 3]]);
  return rows;
}

/** Metres per one authoring unit, for the ES3D unit tokens. */
export const METRES_PER_UNIT = { m: 1, cm: 0.01, mm: 0.001, km: 1000, in: 0.0254, ft: 0.3048 };

export function metresPerUnit(unit) {
  return METRES_PER_UNIT[unit] ?? 1;
}
