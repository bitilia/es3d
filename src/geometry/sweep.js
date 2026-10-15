// Sweeping a 2D profile along a 3D spine.
//
// Frames along the spine are rotation minimising (double reflection method,
// Wang et al. 2008), so tubes do not twist unexpectedly; closed spines get the
// residual twist distributed evenly so the seam matches. Sharp spine corners
// are mitered (the profile is stretched along the bend so the tube keeps its
// thickness). Optional twist and taper are applied along the arc length.

import { Mesh, MeshBuilder } from './mesh.js';
import { triangulateRegions, reportTriangulation } from './extrude.js';
import { contourFrames } from './contour.js';
import { flattenPath } from '../path/path-flatten.js';
import { perpendicular } from '../math/vec3.js';
import { sweepWasm, catmullRomWasm } from '../wasm/kernels.js';

const TAU = Math.PI * 2;

/** Helix around +Y starting at (r, 0, 0). */
export function helixPoints(radius, pitch, turns, segmentsPerTurn) {
  const n = Math.max(2, Math.ceil(turns * segmentsPerTurn));
  const pts = new Float64Array((n + 1) * 3);
  const total = turns * TAU;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * total;
    pts[i * 3] = radius * Math.cos(t);
    pts[i * 3 + 1] = (pitch * t) / TAU;
    pts[i * 3 + 2] = -radius * Math.sin(t);
  }
  return pts;
}

/** Centripetal Catmull-Rom spline through 3D points. */
export function catmullRom(points, closed, subdivisions) {
  const n = points.length / 3;
  if (n < 2) return Float64Array.from(points);
  const fast = catmullRomWasm(points, closed, subdivisions);
  if (fast) return fast;
  const P = (i) => {
    if (closed) {
      const k = ((i % n) + n) % n;
      return [points[k * 3], points[k * 3 + 1], points[k * 3 + 2]];
    }
    if (i < 0) {
      const a = P(0), b = P(1);
      return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    }
    if (i > n - 1) {
      const a = P(n - 1), b = P(n - 2);
      return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    }
    return [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
  };
  const out = [];
  const segs = closed ? n : n - 1;
  const knot = (a, b) => Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])), 1e-6);
  for (let s = 0; s < segs; s++) {
    const p0 = P(s - 1), p1 = P(s), p2 = P(s + 1), p3 = P(s + 2);
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let k = 0; k < subdivisions; k++) {
      const u = t1 + ((t2 - t1) * k) / subdivisions;
      const lerp = (a, b, ta, tb) => {
        const w = (u - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
      };
      const A1 = lerp(p0, p1, t0, t1);
      const A2 = lerp(p1, p2, t1, t2);
      const A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2);
      const B2 = lerp(A2, A3, t1, t3);
      const C = lerp(B1, B2, t1, t2);
      out.push(C[0], C[1], C[2]);
    }
  }
  if (!closed) {
    const last = P(n - 1);
    out.push(last[0], last[1], last[2]);
  }
  return Float64Array.from(out);
}

/** Spine polylines from a parsed `along` value. Returns [{points, closed}]. */
export function spinePolylines(spine, { tolerance, segmentsPerTurn, smooth, subdivisions }) {
  if (spine.kind === 'helix') {
    return [{ points: helixPoints(spine.radius, spine.pitch, spine.turns, spine.segmentsPerTurn || segmentsPerTurn), closed: false }];
  }
  if (spine.kind === 'path') {
    return flattenPath(spine.segments, { dim: 3, tolerance }).map((c) => ({ points: c.points, closed: c.closed }));
  }
  let pts = spine.points;
  const n = pts.length / 3;
  let closed = false;
  if (n > 2 && Math.hypot(pts[0] - pts[(n - 1) * 3], pts[1] - pts[(n - 1) * 3 + 1], pts[2] - pts[(n - 1) * 3 + 2]) < 1e-12) {
    closed = true;
    pts = pts.slice(0, (n - 1) * 3);
  }
  if (smooth) pts = catmullRom(pts, closed, subdivisions);
  return [{ points: pts, closed }];
}

function dedupe(points, closed) {
  const out = [];
  const n = points.length / 3;
  for (let i = 0; i < n; i++) {
    const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
    const k = out.length;
    if (k && Math.hypot(out[k - 3] - x, out[k - 2] - y, out[k - 1] - z) < 1e-9) continue;
    out.push(x, y, z);
  }
  if (closed && out.length > 6) {
    const k = out.length;
    if (Math.hypot(out[0] - out[k - 3], out[1] - out[k - 2], out[2] - out[k - 1]) < 1e-9) out.length -= 3;
  }
  return out;
}

/**
 * Stations along a spine: position, tangent T, normal N, binormal B, arc length,
 * and miter data (bend axis K and stretch factor) at each point. Vectors are
 * flat arrays, x y z per station.
 */
export function spineFrames(points, closed) {
  const p = dedupe(points, closed);
  const n = p.length / 3;
  if (n < 2) return null;
  const count = closed ? n + 1 : n;
  const pos = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const k = (i % n) * 3;
    pos[i * 3] = p[k];
    pos[i * 3 + 1] = p[k + 1];
    pos[i * 3 + 2] = p[k + 2];
  }
  const nd = count - 1;
  const dirs = new Float64Array(nd * 3);
  for (let i = 0; i < nd; i++) normalizeInto(dirs, i * 3, pos[i * 3 + 3] - pos[i * 3], pos[i * 3 + 4] - pos[i * 3 + 1], pos[i * 3 + 5] - pos[i * 3 + 2]);
  const T = new Float64Array(count * 3);
  const K = new Float64Array(count * 3);
  const stretch = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const d0 = 3 * (closed ? (i - 1 + nd) % nd : Math.max(0, i - 1));
    const d1 = 3 * (closed ? i % nd : Math.min(nd - 1, i));
    const o = i * 3;
    normalizeInto(T, o, dirs[d0] + dirs[d1], dirs[d0 + 1] + dirs[d1 + 1], dirs[d0 + 2] + dirs[d1 + 2]);
    if (T[o] === 0 && T[o + 1] === 0 && T[o + 2] === 0) {
      T[o] = dirs[d1];
      T[o + 1] = dirs[d1 + 1];
      T[o + 2] = dirs[d1 + 2];
    }
    const c = Math.max(T[o] * dirs[d1] + T[o + 1] * dirs[d1 + 1] + T[o + 2] * dirs[d1 + 2], 0.25);
    normalizeInto(K, o, dirs[d1] - dirs[d0], dirs[d1 + 1] - dirs[d0 + 1], dirs[d1 + 2] - dirs[d0 + 2]);
    stretch[i] = 1 / c;
  }
  // initial normal: the world up direction projected onto the plane of T0
  const N = new Float64Array(count * 3);
  const tx = T[0], ty = T[1], tz = T[2];
  const ux = Math.abs(ty) < 0.99 ? 0 : 1, uy = Math.abs(ty) < 0.99 ? 1 : 0, uz = 0;
  const wx = ty * uz - tz * uy, wy = tz * ux - tx * uz, wz = tx * uy - ty * ux;
  normalizeInto(N, 0, wy * tz - wz * ty, wz * tx - wx * tz, wx * ty - wy * tx);
  if (N[0] === 0 && N[1] === 0 && N[2] === 0) N.set(perpendicular([tx, ty, tz]));
  // rotation minimising frames: double reflection
  for (let i = 0; i < count - 1; i++) {
    const o = i * 3;
    const v1x = pos[o + 3] - pos[o], v1y = pos[o + 4] - pos[o + 1], v1z = pos[o + 5] - pos[o + 2];
    const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
    let rx = N[o], ry = N[o + 1], rz = N[o + 2];
    let lx = T[o], ly = T[o + 1], lz = T[o + 2];
    if (c1 > 0) {
      const sr = (2 / c1) * (v1x * rx + v1y * ry + v1z * rz);
      rx = rx - v1x * sr;
      ry = ry - v1y * sr;
      rz = rz - v1z * sr;
      const st = (2 / c1) * (v1x * lx + v1y * ly + v1z * lz);
      lx = lx - v1x * st;
      ly = ly - v1y * st;
      lz = lz - v1z * st;
    }
    const v2x = T[o + 3] - lx, v2y = T[o + 4] - ly, v2z = T[o + 5] - lz;
    const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
    if (c2 > 1e-20) {
      const s2 = (2 / c2) * (v2x * rx + v2y * ry + v2z * rz);
      rx = rx - v2x * s2;
      ry = ry - v2y * s2;
      rz = rz - v2z * s2;
    }
    normalizeInto(N, o + 3, rx, ry, rz);
  }
  if (closed) {
    // distribute the residual rotation so the last frame matches the first
    const o = (count - 1) * 3;
    const ax = N[o + 1] * N[2] - N[o + 2] * N[1], ay = N[o + 2] * N[0] - N[o] * N[2], az = N[o] * N[1] - N[o + 1] * N[0];
    const ang = Math.atan2(ax * T[0] + ay * T[1] + az * T[2], N[o] * N[0] + N[o + 1] * N[1] + N[o + 2] * N[2]);
    for (let i = 0; i < count; i++) {
      // Rodrigues rotation of N[i] around T[i]
      const angle = (ang * i) / (count - 1);
      const c = Math.cos(angle), s = Math.sin(angle);
      const k = i * 3;
      const vx = N[k], vy = N[k + 1], vz = N[k + 2];
      const kx = T[k], ky = T[k + 1], kz = T[k + 2];
      const cx = ky * vz - kz * vy, cy = kz * vx - kx * vz, cz = kx * vy - ky * vx;
      const kd = (kx * vx + ky * vy + kz * vz) * (1 - c);
      N[k] = vx * c + cx * s + kx * kd;
      N[k + 1] = vy * c + cy * s + ky * kd;
      N[k + 2] = vz * c + cz * s + kz * kd;
    }
    N[o] = N[0];
    N[o + 1] = N[1];
    N[o + 2] = N[2];
  }
  const B = new Float64Array(count * 3);
  for (let i = 0; i < count * 3; i += 3) {
    B[i] = T[i + 1] * N[i + 2] - T[i + 2] * N[i + 1];
    B[i + 1] = T[i + 2] * N[i] - T[i] * N[i + 2];
    B[i + 2] = T[i] * N[i + 1] - T[i + 1] * N[i];
  }
  const arc = new Float64Array(count);
  for (let i = 1; i < count; i++) arc[i] = arc[i - 1] + Math.hypot(pos[i * 3] - pos[i * 3 - 3], pos[i * 3 + 1] - pos[i * 3 - 2], pos[i * 3 + 2] - pos[i * 3 - 1]);
  return { count, pos, T, N, B, K, stretch, arc, length: arc[count - 1], closed };
}

/** Unit vector of (x, y, z) into out[o..o+2] (zero when degenerate), as vec3 normalize. */
function normalizeInto(out, o, x, y, z) {
  const l = Math.hypot(x, y, z);
  if (l > 1e-20) {
    out[o] = x / l;
    out[o + 1] = y / l;
    out[o + 2] = z / l;
  } else out[o] = out[o + 1] = out[o + 2] = 0;
}

/** Position of profile point (px, py) at station i, written to out[o..o+2]. */
function placeAt(out, o, i, px, py, ks, cas, sas, Nf, Bf, Pf, Kf, stretch) {
  const k = ks[i], ca = cas[i], sa = sas[i];
  const x = (px * ca - py * sa) * k;
  const y = (px * sa + py * ca) * k;
  const i3 = i * 3;
  let ox = Nf[i3] * x + Bf[i3] * y, oy = Nf[i3 + 1] * x + Bf[i3 + 1] * y, oz = Nf[i3 + 2] * x + Bf[i3 + 2] * y;
  // miter stretch along the bend axis
  const st = stretch[i];
  if (st > 1.0001) {
    const d = (ox * Kf[i3] + oy * Kf[i3 + 1] + oz * Kf[i3 + 2]) * (st - 1);
    ox = ox + Kf[i3] * d;
    oy = oy + Kf[i3 + 1] * d;
    oz = oz + Kf[i3 + 2] * d;
  }
  out[o] = Pf[i3] + ox;
  out[o + 1] = Pf[i3 + 1] + oy;
  out[o + 2] = Pf[i3 + 2] + oz;
}

/** Normal at station i of profile point (px, py) whose 2D normal is (nx, ny), into out[0..2]. */
function stationNormal(out, i, px, py, nx, ny, cas, sas, Nf, Bf, Tf, dScale) {
  const ca = cas[i], sa = sas[i];
  const qx = nx * ca - ny * sa;
  const qy = nx * sa + ny * ca;
  const i3 = i * 3;
  let n0 = Nf[i3] * qx + Bf[i3] * qy, n1 = Nf[i3 + 1] * qx + Bf[i3 + 1] * qy, n2 = Nf[i3 + 2] * qx + Bf[i3 + 2] * qy;
  if (dScale !== 0) {
    // taper tilts the surface along the spine
    const slope = dScale * (px * nx + py * ny);
    const a0 = n0 - Tf[i3] * slope, a1 = n1 - Tf[i3 + 1] * slope, a2 = n2 - Tf[i3 + 2] * slope;
    const l = Math.hypot(a0, a1, a2);
    if (l > 1e-20) {
      n0 = a0 / l;
      n1 = a1 / l;
      n2 = a2 / l;
    } else n0 = n1 = n2 = 0;
  }
  out[0] = n0;
  out[1] = n1;
  out[2] = n2;
}

/** Positions of every profile point at every station (station-major), into ring. */
function sweepRing(ring, pts, n, count, ks, cas, sas, Nf, Bf, Pf, Kf, stretch) {
  for (let s = 0; s < count; s++) {
    for (let j = 0; j < n; j++) placeAt(ring, (s * n + j) * 3, s, pts[j * 2], pts[j * 2 + 1], ks, cas, sas, Nf, Bf, Pf, Kf, stretch);
  }
}

/**
 * Wall of one contour along one spine: for each profile edge, a strip of
 * quads from the first station to the last. The hot loop of a sweep, in a
 * function of its own so the engine optimizes it early and on its own.
 */
function sweepWalls(b, ring, f, pts, count, arc, cas, sas, Nf, Bf, Tf, dScale, out) {
  const n = f.n;
  const perim = f.length || 1;
  for (let e = 0; e < n; e++) {
    const i0 = e, i1 = (e + 1) % n;
    const c0 = f.corner[i0], c1 = f.corner[i1];
    const n0x = c0 ? f.edgeN[e * 2] : f.vertN[i0 * 2], n0y = c0 ? f.edgeN[e * 2 + 1] : f.vertN[i0 * 2 + 1];
    const n1x = c1 ? f.edgeN[e * 2] : f.vertN[i1 * 2], n1y = c1 ? f.edgeN[e * 2 + 1] : f.vertN[i1 * 2 + 1];
    const u0 = f.arc[e] / perim, u1 = f.arc[e + 1] / perim;
    const p0x = pts[i0 * 2], p0y = pts[i0 * 2 + 1], p1x = pts[i1 * 2], p1y = pts[i1 * 2 + 1];
    let prevA = -1, prevB = -1;
    for (let s = 0; s < count; s++) {
      const v = arc[s] / perim;
      stationNormal(out, s, p0x, p0y, n0x, n0y, cas, sas, Nf, Bf, Tf, dScale);
      let o = (s * n + i0) * 3;
      const a = b.vertex(ring[o], ring[o + 1], ring[o + 2], out[0], out[1], out[2], u0, v);
      stationNormal(out, s, p1x, p1y, n1x, n1y, cas, sas, Nf, Bf, Tf, dScale);
      o = (s * n + i1) * 3;
      const c2 = b.vertex(ring[o], ring[o + 1], ring[o + 2], out[0], out[1], out[2], u1, v);
      if (prevA >= 0) b.quad(prevA, prevB, c2, a);
      prevA = a;
      prevB = c2;
    }
  }
}

/**
 * Sweep a profile along spines.
 * @param {object} profile {kind:'circle', radius, segments} | {kind:'shape', regions, walls}
 * @param {{points:Float64Array, closed:boolean}[]} spines
 * @param {{twist?:number, taper?:number, caps?:boolean}} o twist in degrees
 */
export function sweepMesh(profile, spines, o, report) {
  const twist = ((o.twist || 0) * Math.PI) / 180;
  const taper = o.taper === undefined ? 1 : o.taper;
  const caps = o.caps !== false;
  let open = false;

  // profile contours with per-vertex normals (2D)
  let contours;
  let capTris = null;
  if (profile.kind === 'circle') {
    const m = Math.max(3, profile.segments);
    const pts = new Float64Array(m * 2);
    for (let j = 0; j < m; j++) {
      const a = (j / m) * TAU;
      pts[j * 2] = Math.cos(a) * profile.radius;
      pts[j * 2 + 1] = Math.sin(a) * profile.radius;
    }
    contours = [{ points: pts, smooth: new Uint8Array(m).fill(1), closed: true }];
    capTris = { circle: true, pts };
  } else contours = profile.walls;
  const w = spines.every((sp) => sp.points.length % 3 === 0) ? sweepWasm(spines, contours, capTris && capTris.pts, profile.regions, twist, taper, caps) : null;
  if (w) {
    for (const e of w.errors) reportTriangulation(e, report);
    for (const d of w.degenerate) if (d && report) report('error', 'E_DEGENERATE_SPINE', 'The sweep spine needs at least two distinct points.');
    return { mesh: new Mesh({ positions: w.positions, normals: w.normals, uvs: w.uvs, indices: w.indices, kind: 'triangles' }), doubleSided: w.open };
  }
  if (!capTris) capTris = triangulateRegions(profile.regions, report);
  const contourInfo = contours.map((c) => ({ pts: c.points, f: contourFrames(c.points, c.smooth, true) }));

  // frames first, so the mesh can be allocated once at its final size
  const frames = [];
  let vertices = 0, indices = 0;
  for (const sp of spines) {
    const fr = spineFrames(sp.points, sp.closed);
    if (!fr) {
      if (report) report('error', 'E_DEGENERATE_SPINE', 'The sweep spine needs at least two distinct points.');
      continue;
    }
    frames.push(fr);
    for (const { f } of contourInfo) {
      vertices += f.n * fr.count * 2;
      indices += f.n * (fr.count - 1) * 6;
    }
    if (!fr.closed && caps) {
      if (capTris.circle) {
        const m = capTris.pts.length / 2;
        vertices += 2 * (m + 1);
        indices += 2 * m * 3;
      } else {
        for (const t of capTris) {
          vertices += t.positions.length;
          indices += 2 * t.indices.length;
        }
      }
    }
  }
  const b = new MeshBuilder('triangles', vertices, indices);
  const out = new Float64Array(3);

  for (const fr of frames) {
    const count = fr.count;
    const L = fr.length || 1;
    const dScale = (taper - 1) / L;
    const Nf = fr.N, Bf = fr.B, Tf = fr.T, Pf = fr.pos, Kf = fr.K;
    const stretch = fr.stretch, arc = fr.arc;
    // twist and taper only depend on the station
    const ks = new Float64Array(count), cas = new Float64Array(count), sas = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const s = arc[i] / L;
      ks[i] = 1 + (taper - 1) * s;
      const ang = twist * s;
      cas[i] = Math.cos(ang);
      sas[i] = Math.sin(ang);
    }

    for (const { pts, f } of contourInfo) {
      // every profile point at every station, computed once for both of its edges
      const ring = new Float64Array(count * f.n * 3);
      sweepRing(ring, pts, f.n, count, ks, cas, sas, Nf, Bf, Pf, Kf, stretch);
      sweepWalls(b, ring, f, pts, count, arc, cas, sas, Nf, Bf, Tf, dScale, out);
    }

    if (!fr.closed) {
      if (!caps) open = true;
      else {
        for (const [s, dir] of [[0, -1], [count - 1, 1]]) {
          const nx = Tf[s * 3] * dir, ny = Tf[s * 3 + 1] * dir, nz = Tf[s * 3 + 2] * dir;
          if (capTris.circle) {
            placeAt(out, 0, s, 0, 0, ks, cas, sas, Nf, Bf, Pf, Kf, stretch);
            const ci = b.vertex(out[0], out[1], out[2], nx, ny, nz, 0.5, 0.5);
            const m = capTris.pts.length / 2;
            const first = b.vertexCount;
            for (let j = 0; j < m; j++) {
              placeAt(out, 0, s, capTris.pts[j * 2], capTris.pts[j * 2 + 1], ks, cas, sas, Nf, Bf, Pf, Kf, stretch);
              b.vertex(out[0], out[1], out[2], nx, ny, nz, 0.5 + Math.cos((j / m) * TAU) / 2, 0.5 + Math.sin((j / m) * TAU) / 2);
            }
            for (let j = 0; j < m; j++) {
              const a = first + j, c2 = first + ((j + 1) % m);
              if (dir > 0) b.tri(ci, a, c2);
              else b.tri(ci, c2, a);
            }
          } else {
            for (const t of capTris) {
              const base = b.vertexCount;
              const p = t.positions;
              for (let k = 0; k < p.length; k += 2) {
                placeAt(out, 0, s, p[k], p[k + 1], ks, cas, sas, Nf, Bf, Pf, Kf, stretch);
                b.vertex(out[0], out[1], out[2], nx, ny, nz, p[k], p[k + 1]);
              }
              const idx = t.indices;
              for (let k = 0; k < idx.length; k += 3) {
                if (dir > 0) b.tri(base + idx[k], base + idx[k + 1], base + idx[k + 2]);
                else b.tri(base + idx[k], base + idx[k + 2], base + idx[k + 1]);
              }
            }
          }
        }
      }
    }
  }
  return { mesh: b.build(), doubleSided: open };
}
