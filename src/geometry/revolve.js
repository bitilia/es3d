// Revolution (lathe) of a 2D profile around the Y axis.
//
// The profile lives in the XY plane: x is the distance from the axis, y the
// height. Open profiles are oriented automatically so their normals face away
// from the axis region they enclose; closed profiles become solids of
// revolution and get end caps when the angle is below 360 degrees.

import { MeshBuilder } from './mesh.js';
import { signedArea, reverseContour } from '../path/path-flatten.js';
import { contourFrames } from './contour.js';
import { triangulate } from '../path/triangulate.js';

/** Orient an open profile so that (profile + axis) forms a counter-clockwise loop. */
function orientOpen(c) {
  const p = c.points;
  const n = p.length / 2;
  const loop = new Float64Array(p.length + 4);
  loop.set(p);
  loop[p.length] = 0;
  loop[p.length + 1] = p[(n - 1) * 2 + 1];
  loop[p.length + 2] = 0;
  loop[p.length + 3] = p[1];
  return signedArea(loop) >= 0 ? c : reverseContour(c);
}

/**
 * @param {object[]} contours flattened 2D contours
 * @param {{angle:number, segments:number}} o angle in degrees
 * @returns {{mesh: import('./mesh.js').Mesh, doubleSided: boolean}}
 */
export function revolveMesh(contours, o, report) {
  const full = o.angle >= 360 - 1e-9;
  const A = (Math.min(o.angle, 360) * Math.PI) / 180;
  const S = Math.max(2, o.segments);
  let open = false;

  // profiles first, so the mesh can be allocated once at its final size
  const profiles = [];
  for (const raw of contours) {
    const pts0 = raw.points;
    for (let i = 0; i < pts0.length; i += 2) {
      if (pts0[i] < -1e-9) {
        if (report) report('error', 'E_REVOLVE_AXIS', `The revolve profile crosses the axis: point (${pts0[i]}, ${pts0[i + 1]}) has x < 0. Profiles must stay at x ≥ 0.`);
        break;
      }
    }
    const closed = raw.closed;
    if (!closed) open = true;
    const c = closed ? (signedArea(raw.points) > 0 ? raw : reverseContour(raw)) : orientOpen(raw);
    const pts = c.points;
    const n = pts.length / 2;
    if (n < 2) continue;
    const f = contourFrames(pts, c.smooth, closed);
    const total = f.length || 1;
    // profile entries (x, y, nx, ny, v): per vertex, entryIn (end of the
    // previous edge) and entryOut (start of the next edge)
    const entries = [];
    const entryIn = new Int32Array(n).fill(-1);
    const entryOut = new Int32Array(n).fill(-1);
    const add = (x, y, nx, ny, v) => entries.push(x, y, nx, ny, v) / 5 - 1;
    for (let i = 0; i < n; i++) {
      const pe = closed ? (i - 1 + n) % n : i - 1;
      const ne = closed || i < n - 1 ? i : -1;
      const x = Math.max(0, pts[i * 2]), y = pts[i * 2 + 1];
      const v = f.arc[i] / total;
      if (pe >= 0 && ne >= 0 && f.corner[i]) {
        entryIn[i] = add(x, y, f.edgeN[pe * 2], f.edgeN[pe * 2 + 1], v);
        entryOut[i] = add(x, y, f.edgeN[ne * 2], f.edgeN[ne * 2 + 1], v);
      } else {
        const e = ne >= 0 ? ne : pe;
        const k = f.corner[i] ? add(x, y, f.edgeN[e * 2], f.edgeN[e * 2 + 1], v) : add(x, y, f.vertN[i * 2], f.vertN[i * 2 + 1], v);
        entryIn[i] = k;
        entryOut[i] = k;
      }
    }
    const tri = !full && closed ? triangulate(pts) : null;
    profiles.push({ closed, pts, n, entries, entryIn, entryOut, tri });
  }
  let vertices = 0, indices = 0;
  for (const p of profiles) {
    vertices += (p.entries.length / 5) * (S + 1);
    indices += (p.closed ? p.n : p.n - 1) * S * 6;
    if (p.tri) {
      vertices += 2 * p.n;
      indices += 2 * p.tri.length;
    }
  }
  const b = new MeshBuilder('triangles', vertices, indices);
  // the angle of each column is the same for every profile entry
  const cosCol = new Float64Array(S + 1), sinCol = new Float64Array(S + 1);
  for (let j = 0; j <= S; j++) {
    const th = (A * j) / S;
    cosCol[j] = Math.cos(th);
    sinCol[j] = Math.sin(th);
  }

  for (const { closed, pts, n, entries, entryIn, entryOut, tri } of profiles) {
    // closing seam of closed contours: v wraps to 1 at the last edge end
    const base = b.vertexCount;
    const cols = S + 1;
    for (let k = 0; k < entries.length; k += 5) {
      const x = entries[k], y = entries[k + 1], nx = entries[k + 2], ny = entries[k + 3], v = entries[k + 4];
      for (let j = 0; j <= S; j++) {
        const ct = cosCol[j], st = sinCol[j];
        b.vertex(x * ct, y, -x * st, nx * ct, ny, -nx * st, j / S, v);
      }
    }
    const edges = closed ? n : n - 1;
    for (let e = 0; e < edges; e++) {
      const s0 = entryOut[e];
      const t0 = entryIn[(e + 1) % n];
      for (let j = 0; j < S; j++) {
        const a = base + s0 * cols + j;
        const d = base + t0 * cols + j;
        b.quad(a, a + 1, d + 1, d);
      }
    }
    // caps for partial revolutions of closed profiles
    if (tri) {
      for (const [th, sign] of [[0, 1], [A, -1]]) {
        const ct = Math.cos(th), st = Math.sin(th);
        // start cap faces +Z (against the sweep); the end cap faces the sweep direction (-sin A, 0, -cos A)
        const cb = b.vertexCount;
        for (let i = 0; i < n; i++) {
          const x = Math.max(0, pts[i * 2]), y = pts[i * 2 + 1];
          b.vertex(x * ct, y, -x * st, sign > 0 ? 0 : -st, 0, sign > 0 ? 1 : -ct, x, y);
        }
        for (let i = 0; i < tri.length; i += 3) {
          if (sign > 0) b.tri(cb + tri[i], cb + tri[i + 1], cb + tri[i + 2]);
          else b.tri(cb + tri[i], cb + tri[i + 2], cb + tri[i + 1]);
        }
      }
    }
  }
  return { mesh: b.build(), doubleSided: open };
}
