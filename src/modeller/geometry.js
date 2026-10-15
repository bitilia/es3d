// Geometry shared by the modeller's planes and the elements placed from
// points: vectors, flat outlines, triangulation, and the frame that puts a
// flat outline (an ES3D polygon, path or extrude) in its place.

import { formatNumber } from '../format/value-format.js';
import * as mat4 from '../math/mat4.js';

const DEG = 180 / Math.PI;

// --- vectors -----------------------------------------------------------------------

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a) => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function boundsOf(pts) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  return { min, max };
}

export function diagonal(pts) {
  if (pts.length < 2) return 0;
  const b = boundsOf(pts);
  return length(sub(b.max, b.min));
}

export const centroid = (pts) => {
  const c = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k] / pts.length;
  return c;
};

/** Newell's normal: perpendicular to a flat outline whatever its shape, twice its area long. */
export function newell(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

/** The longest cross product of two spokes from the first point (an outline that cancels Newell's sum). */
export function largestCross(pts) {
  let best = [0, 0, 0];
  let bestLen = 0;
  for (let i = 1; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const c = cross(sub(pts[i], pts[0]), sub(pts[j], pts[0]));
      const l = length(c);
      if (l > bestLen) {
        best = c;
        bestLen = l;
      }
    }
  }
  return best;
}

/** Two axes spanning the plane with normal n. */
export function planeAxes(n) {
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(ref, n));
  return [u, cross(n, u)];
}

// --- 2D outline tests --------------------------------------------------------------

export const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);

export function signedArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

const between = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);

function segmentsMeet(a, b, c, d, eps) {
  const d1 = orient(c, d, a), d2 = orient(c, d, b), d3 = orient(a, b, c), d4 = orient(a, b, d);
  const opposite = (s, t) => (s > eps && t < -eps) || (s < -eps && t > eps);
  if (opposite(d1, d2) && opposite(d3, d4)) return true;
  return (Math.abs(d1) <= eps && between(c, d, a)) || (Math.abs(d2) <= eps && between(c, d, b)) || (Math.abs(d3) <= eps && between(a, b, c)) || (Math.abs(d4) <= eps && between(a, b, d));
}

/** True when no two edges of the closed outline meet, other than neighbours at their shared corner. */
export function isSimple(p, eps) {
  const n = p.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsMeet(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n], eps)) return false;
    }
  }
  return true;
}

/** Indices in order of angle around the centroid, starting from index 0. */
export function angleOrder(p) {
  const cx = p.reduce((s, q) => s + q[0], 0) / p.length;
  const cy = p.reduce((s, q) => s + q[1], 0) / p.length;
  const order = p.map((_, i) => i).sort((i, j) => Math.atan2(p[i][1] - cy, p[i][0] - cx) - Math.atan2(p[j][1] - cy, p[j][0] - cx));
  const k = order.indexOf(0);
  return [...order.slice(k), ...order.slice(0, k)];
}

function insideTriangle(p, a, b, c, eps) {
  return orient(a, b, p) > eps && orient(b, c, p) > eps && orient(c, a, p) > eps;
}

/**
 * Triangles of a simple 2D outline, as index triples. Ears are cut where the
 * new diagonal is shortest in 3D, so a bent quad folds along its short diagonal.
 */
export function earClip(p2, p3, eps) {
  let idx = p2.map((_, i) => i);
  if (signedArea(p2) < 0) idx = [idx[0], ...idx.slice(1).reverse()];
  const tris = [];
  while (idx.length > 3) {
    let best = -1;
    let bestLen = Infinity;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (orient(p2[a], p2[b], p2[c]) <= eps) continue;
      if (idx.some((m) => m !== a && m !== b && m !== c && insideTriangle(p2[m], p2[a], p2[b], p2[c], eps))) continue;
      const len = length(sub(p3[a], p3[c]));
      if (len < bestLen) {
        best = k;
        bestLen = len;
      }
    }
    if (best < 0) break;
    const n = idx.length;
    tris.push([idx[(best + n - 1) % n], idx[best], idx[(best + 1) % n]]);
    idx.splice(best, 1);
  }
  // only an outline with no ear left (numerically flat corners) gets here with more than 3
  for (let k = 1; k + 1 < idx.length; k++) tris.push([idx[0], idx[k], idx[k + 1]]);
  return tris;
}

/**
 * The frame of a flat outline: rotation="pitch,yaw,0" keeps its local x axis
 * level and turns its local z axis to the normal, and the outline is listed
 * counter-clockwise from its lowest corner (leftmost of the lowest), in that
 * frame. The angles are rounded first and the outline measured in the frame
 * of the rounded angles, which is the frame a reader builds.
 * @param {number[][]} xyz corners in order
 * @param {number[]|null} centre the normal points away from it; null: the normal
 *   the corners go counter-clockwise around
 * @returns {{origin: number[], pitch: number, yaw: number, local: number[][], normal: number[]}}
 */
export function flatFrame(xyz, centre = null) {
  const size = diagonal(xyz);
  let n = newell(xyz);
  if (length(n) <= 1e-9 * size * size) n = largestCross(xyz);
  n = normalize(n);
  if (centre) {
    const out = dot(sub(centroid(xyz), centre), n);
    if (out < -1e-9 * size || (Math.abs(out) <= 1e-9 * size && n[1] < -1e-12)) n = [-n[0], -n[1], -n[2]];
  }
  const pitch = Number(formatNumber(Math.asin(Math.max(-1, Math.min(1, -n[1]))) * DEG, 6));
  let yaw = Math.abs(n[1]) > 1 - 1e-12 ? 0 : Number(formatNumber(Math.atan2(n[0], n[2]) * DEG, 6));
  if (yaw === -180) yaw = 180;
  const R = mat4.fromEulerDeg(mat4.createF64(), pitch, yaw, 0);
  let corners = xyz.map((p) => [p, dot(p, [R[0], R[1], R[2]]), dot(p, [R[4], R[5], R[6]])]);
  if (signedArea(corners.map((c) => [c[1], c[2]])) < 0) corners.reverse();
  const eps = 1e-9 * size;
  let k = 0;
  corners.forEach((c, i) => {
    const b = corners[k];
    if (c[2] < b[2] - eps || (Math.abs(c[2] - b[2]) <= eps && c[1] < b[1])) k = i;
  });
  corners = [...corners.slice(k), ...corners.slice(0, k)];
  return {
    origin: corners[0][0],
    pitch,
    yaw,
    local: corners.map((c) => [c[1] - corners[0][1], c[2] - corners[0][2]]),
    normal: n,
  };
}

/** position and rotation attributes of a frame (omitted when zero). */
export function frameAttrs(frame, fmt) {
  return {
    position: frame.origin.some((v) => v !== 0) ? frame.origin.map(fmt).join(',') : undefined,
    rotation: frame.pitch || frame.yaw ? `${formatNumber(frame.pitch)},${formatNumber(frame.yaw)},0` : undefined,
  };
}
