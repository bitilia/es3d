// Chordal error of each generator, in the same units as its canonical mesh.
//
// The frame builder keeps a level only while this distance, scaled by the
// instance and projected, stays within one pixel. Bounds are the maximum
// distance from the mesh to the true surface. Analytic primitives are measured
// from the same vertex grid the tessellator builds. Curves use the flatten
// tolerance, which the flattener treats as a hard chordal limit.

import { sphereDeviationWasm } from '../wasm/kernels.js';

/** Sagitta of a unit circle drawn with n equal chords, as a fraction of the radius. */
export function circleSagitta(n) {
  const s = Math.max(3, n);
  return 1 - Math.cos(Math.PI / s);
}

function closestDistanceToOrigin(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  let nx = aby * acz - abz * acy;
  let ny = abz * acx - abx * acz;
  let nz = abx * acy - aby * acx;
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-14) return 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const d = ax * nx + ay * ny + az * nz;
  const fx = d * nx, fy = d * ny, fz = d * nz;
  const v0x = acx, v0y = acy, v0z = acz;
  const v1x = abx, v1y = aby, v1z = abz;
  const v2x = fx - ax, v2y = fy - ay, v2z = fz - az;
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d02 = v0x * v2x + v0y * v2y + v0z * v2z;
  const d12 = v1x * v2x + v1y * v2y + v1z * v2z;
  const det = d00 * d11 - d01 * d01;
  if (Math.abs(det) > 1e-18) {
    const inv = 1 / det;
    const u = (d11 * d02 - d01 * d12) * inv;
    const v = (d00 * d12 - d01 * d02) * inv;
    if (u >= -1e-5 && v >= -1e-5 && u + v <= 1 + 1e-5) return Math.abs(d);
  }
  return Math.min(edgeDistance(ax, ay, az, bx, by, bz), edgeDistance(bx, by, bz, cx, cy, cz), edgeDistance(cx, cy, cz, ax, ay, az));
}

function edgeDistance(ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 0 ? -(ax * abx + ay * aby + az * abz) / ab2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(ax + abx * t, ay + aby * t, az + abz * t);
}

function radialError(a, b, c) {
  return 1 - closestDistanceToOrigin(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

const sphereDeviations = new Map();

/** Maximum radial error of the reference UV sphere at this segment count. */
export function sphereDeviation(segments) {
  // every sphere element asks for the same few segment counts: measure each once
  const w = Math.max(3, segments | 0);
  let max = sphereDeviations.get(w);
  if (max === undefined) {
    max = measureSphereDeviation(w);
    sphereDeviations.set(w, max);
  }
  return max;
}

function measureSphereDeviation(w) {
  const v = sphereDeviationWasm(w);
  if (v !== null) return v;
  const hRings = Math.max(2, Math.round(w / 2));
  const TAU = Math.PI * 2;
  // the grid's sines and cosines, once per ring and per column
  const st = new Float64Array(hRings + 1), ct = new Float64Array(hRings + 1);
  for (let j = 0; j <= hRings; j++) {
    const th = (j / hRings) * Math.PI;
    st[j] = Math.sin(th);
    ct[j] = Math.cos(th);
  }
  const cp = new Float64Array(w + 1), sp = new Float64Array(w + 1);
  for (let i = 0; i <= w; i++) {
    const ph = ((i % w) / w) * TAU;
    cp[i] = Math.cos(ph);
    sp[i] = Math.sin(ph);
  }
  let max = 0;
  for (let j = 0; j < hRings; j++) {
    for (let i = 0; i < w; i++) {
      // quad corners a (i, j), b (i, j + 1), c (i + 1, j + 1), d (i + 1, j)
      const ax = st[j] * cp[i], ay = ct[j], az = -st[j] * sp[i];
      const bx = st[j + 1] * cp[i], by = ct[j + 1], bz = -st[j + 1] * sp[i];
      const cx = st[j + 1] * cp[i + 1], cy = ct[j + 1], cz = -st[j + 1] * sp[i + 1];
      const dx = st[j] * cp[i + 1], dy = ct[j], dz = -st[j] * sp[i + 1];
      if (j !== hRings - 1) {
        const e = 1 - closestDistanceToOrigin(ax, ay, az, bx, by, bz, cx, cy, cz);
        if (e > max) max = e;
      }
      if (j !== 0) {
        const e = 1 - closestDistanceToOrigin(ax, ay, az, cx, cy, cz, dx, dy, dz);
        if (e > max) max = e;
      }
    }
  }
  return max;
}

/** Radial error of a stored unit sphere (binary32 vertex positions). */
export function sphereMeshError(positions, indices) {
  let max = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const at = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const e = radialError(at(indices[t]), at(indices[t + 1]), at(indices[t + 2]));
    if (e > max) max = e;
  }
  return max;
}

/** Cylinder or cone in canonical space (bottom radius 1, top radius `top`). */
export function cylinderDeviation(top, segments) {
  return Math.max(1, top, 0) * circleSagitta(segments);
}

/** Capsule of tube radius 1. The straight section does not add radial error. */
export function capsuleDeviation(segments) {
  const w = Math.max(3, segments | 0);
  const hr = Math.max(1, Math.round(w / 4));
  // latitude step over a quarter circle, and the equatorial chord
  return Math.max(circleSagitta(w), 1 - Math.cos(Math.PI / (2 * hr)));
}

/** Torus of major radius 1 and tube radius `tube`, in major-radius units. */
export function torusDeviation(tube, arcDeg, segments, tubeSegments) {
  const full = arcDeg >= 360 - 1e-9;
  const ts = Math.max(3, Math.round(segments * (full ? 1 : arcDeg / 360)) || 3);
  const rs = Math.max(3, tubeSegments);
  // The quad sags along the tube and along the sweep. Adding the two sagittas
  // bounds the distance to the true torus.
  return tube * circleSagitta(rs) + (1 + tube) * circleSagitta(ts);
}

/** Rounded box: the corner is a sphere of radius r, stepped by π/4 per segment. */
export function roundedBoxDeviation(radius, seg) {
  const s = Math.max(1, seg);
  return radius * (1 - Math.cos(Math.PI / (4 * s)));
}

/**
 * Gear outline in module units. The flank and the tip arc are polylines;
 * the bound is the sagitta of the tip circle at the flank's step.
 */
export function gearDeviation(teeth, flank) {
  const ra = teeth / 2 + 1;
  return ra * circleSagitta(Math.max(3, flank));
}

/** Flatten tolerances as a fraction of the path's control-box diagonal, per level. */
export const PATH_TOL = [0.0006, 0.0025, 0.01, 0.035];

/** Absolute flatten error for a path whose control box has this diagonal. */
export function pathFlattenDeviation(diag, lod) {
  const d = diag > 0 && Number.isFinite(diag) ? diag : 1;
  const i = Math.min(PATH_TOL.length - 1, Math.max(0, lod));
  return d * PATH_TOL[i];
}

/** Quarter-round bevel of radius r with n segments. */
export function bevelDeviation(radius, segments) {
  if (!(radius > 0)) return 0;
  const n = Math.max(1, segments);
  return radius * (1 - Math.cos(Math.PI / (2 * n)));
}
