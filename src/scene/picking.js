// CPU ray picking against the instance table.
//
// Each instance is tested with a world-space bounding-sphere check, then the
// ray is transformed into the instance's canonical mesh space (inverse world
// matrix) and tested against the canonical bounds and finally the triangles
// (Möller–Trumbore). Because instancing keeps one canonical mesh per
// geometry, picking cost scales with visible instances, not with triangles.

import * as mat4 from '../math/mat4.js';

function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return Infinity;
  const thc = Math.sqrt(r * r - d2);
  const t0 = tca - thc;
  const t1 = tca + thc;
  if (t1 < 0) return Infinity;
  return t0 < 0 ? 0 : t0;
}

function rayBox(o, d, b) {
  let tmin = -Infinity, tmax = Infinity;
  for (let k = 0; k < 3; k++) {
    const pad = 1e-6 + (b.max[k] - b.min[k]) * 1e-4;
    const lo = b.min[k] - pad, hi = b.max[k] + pad;
    if (Math.abs(d[k]) < 1e-20) {
      if (o[k] < lo || o[k] > hi) return false;
    } else {
      let t1 = (lo - o[k]) / d[k];
      let t2 = (hi - o[k]) / d[k];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return tmax >= 0;
}

let hitTriangle = -1; // first index of the triangle found by the last rayTriangles call

/**
 * Nearest triangle hit closer than `best`. With `facing` (+1 or -1) only
 * triangles whose front side faces the ray origin count: det > 0 means the
 * ray meets the counter-clockwise side, and `facing` is -1 for mirrored instances.
 */
function rayTriangles(o, d, mesh, best, facing = 0) {
  const p = mesh.positions;
  const idx = mesh.indices;
  let tBest = best;
  hitTriangle = -1;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-18) continue;
    if (facing && det * facing < 0) continue;
    const inv = 1 / det;
    const tx = o[0] - p[a], ty = o[1] - p[a + 1], tz = o[2] - p[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1e-9 && t < tBest) {
      tBest = t;
      hitTriangle = i;
    }
  }
  return tBest;
}

/**
 * Nearest surface along a ray.
 * @param {import('./flatten.js').RenderScene} scene
 * @param {(entry:object, lod:number)=>import('../geometry/mesh.js').Mesh} meshOf
 * @param {number[]} origin world ray origin
 * @param {number[]} dir world ray direction (normalized)
 * @param {{isVisible?: (i:number)=>boolean, maxDistance?: number, skipFlags?: number, facing?: boolean}} [opts]
 *   skipFlags: instances with any of these flag bits are ignored. facing: only
 *   surfaces whose front side faces the origin (double-sided geometry always counts).
 * @returns {{index:number, uid:number, distance:number, point:number[], normal:number[]}|null}
 *   normal is the world-space surface normal turned against the ray.
 */
export function raycast(scene, meshOf, origin, dir, opts = {}) {
  const { isVisible = null, maxDistance = Infinity, skipFlags = 0, facing = false } = opts;
  const cands = [];
  const S = scene.spheres;
  for (let i = 0; i < scene.count; i++) {
    if (skipFlags && scene.flags[i] & skipFlags) continue;
    if (isVisible && !isVisible(i)) continue;
    const entry = scene.geometries[scene.geom[i]];
    if (entry.kind !== 'triangles') continue;
    const t = raySphere(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], S[i * 4], S[i * 4 + 1], S[i * 4 + 2], S[i * 4 + 3]);
    if (t < maxDistance) cands.push([t, i]);
  }
  cands.sort((a, b) => a[0] - b[0]);
  let best = maxDistance;
  let bestIndex = -1;
  let bestTriangle = -1;
  const normal = [0, 0, 0];
  const m = new Float64Array(16);
  const inv = new Float64Array(16);
  const lo = [0, 0, 0];
  const ld = [0, 0, 0];
  for (const [tSphere, i] of cands) {
    if (tSphere > best) break;
    for (let k = 0; k < 16; k++) m[k] = scene.matrices[i * 16 + k];
    if (!mat4.invert(inv, m)) continue;
    mat4.transformPoint(lo, inv, origin[0], origin[1], origin[2]);
    mat4.transformDir(ld, inv, dir[0], dir[1], dir[2]);
    const entry = scene.geometries[scene.geom[i]];
    if (entry.bounds && !rayBox(lo, ld, entry.bounds)) continue;
    const mesh = meshOf(entry, 0);
    const material = scene.materials[scene.mat[i]];
    const twoSided = entry.doubleSided || (material && material.doubleSided);
    const front = facing && !twoSided ? (scene.flags[i] & 1 ? -1 : 1) : 0;
    // t is in world units because the direction was transformed linearly (not renormalized)
    const t = rayTriangles(lo, ld, mesh, best, front);
    if (t < best) {
      best = t;
      bestIndex = i;
      bestTriangle = hitTriangle;
      // triangle normal to world space with the inverse transpose
      const p = mesh.positions, idx = mesh.indices;
      const a = idx[bestTriangle] * 3, b = idx[bestTriangle + 1] * 3, c = idx[bestTriangle + 2] * 3;
      const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      for (let k = 0; k < 3; k++) normal[k] = inv[k * 4] * n[0] + inv[k * 4 + 1] * n[1] + inv[k * 4 + 2] * n[2];
    }
  }
  if (bestIndex < 0) return null;
  const nl = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const sign = normal[0] * dir[0] + normal[1] * dir[1] + normal[2] * dir[2] > 0 ? -1 : 1;
  return {
    index: bestIndex,
    uid: scene.uid[bestIndex],
    distance: best,
    point: [origin[0] + dir[0] * best, origin[1] + dir[1] * best, origin[2] + dir[2] * best],
    normal: [(normal[0] / nl) * sign, (normal[1] / nl) * sign, (normal[2] / nl) * sign],
  };
}

/**
 * Element under a ray (for selection).
 * @param {import('./flatten.js').RenderScene} scene
 * @param {(entry:object, lod:number)=>import('../geometry/mesh.js').Mesh} meshOf
 * @param {number[]} origin world ray origin
 * @param {number[]} dir world ray direction (normalized)
 * @param {(i:number)=>boolean} [isVisible]
 * @returns {{index:number, uid:number, distance:number, point:number[], normal:number[]}|null}
 */
export function pick(scene, meshOf, origin, dir, isVisible = null) {
  return raycast(scene, meshOf, origin, dir, { isVisible });
}
