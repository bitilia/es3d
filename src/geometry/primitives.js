// Tessellation of the analytic primitives.
//
// Generators work in a canonical space (unit sphere, unit-radius cylinder of
// height 1, unit cube ...). Element parameters that are pure scale factors
// (radius, size, height) are moved into the instance transform, so every
// sphere in a document shares one tessellated mesh per level of detail. Only
// shape-defining ratios (cone taper, torus tube ratio and so on) create new meshes.
// All triangles are counter-clockwise when seen from outside.

import { Mesh, MeshBuilder } from './mesh.js';
import { primitivesWasm } from '../wasm/kernels.js';

const TAU = Math.PI * 2;

/** Segment count for a level of detail: lod 0 is the finest. */
export function lodSegments(base, lod, quality = 1, min = 3) {
  return Math.max(min, Math.round((base * quality) / (1 << lod)));
}

export function unitBox() {
  const b = new MeshBuilder('triangles', 24, 36);
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, a, c] of faces) {
    const v = [];
    for (const [su, sv, u, w] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]]) {
      v.push(
        b.vertex(
          n[0] * 0.5 + a[0] * 0.5 * su + c[0] * 0.5 * sv,
          n[1] * 0.5 + a[1] * 0.5 * su + c[1] * 0.5 * sv,
          n[2] * 0.5 + a[2] * 0.5 * su + c[2] * 0.5 * sv,
          n[0], n[1], n[2], u, w,
        ),
      );
    }
    b.quad(v[0], v[1], v[2], v[3]);
  }
  return b.build();
}

/**
 * Box with rounded edges (Minkowski sum of an inner box and a sphere of radius r).
 * Each face is a grid whose rows follow the rounding angle uniformly.
 */
export function roundedBox(w, h, d, r, seg) {
  const fast = primitivesWasm.roundedBox(w, h, d, r, seg);
  if (fast) return new Mesh({ ...fast, kind: 'triangles' });
  const H = [w / 2, h / 2, d / 2];
  const side = 2 * seg + 2;
  const b = new MeshBuilder('triangles', 6 * side * side, 6 * (side - 1) * (side - 1) * 6);
  const p = new Float64Array(3);
  const coords = (Hh) => {
    const inner = Hh - r;
    const out = [];
    for (let k = seg; k >= 1; k--) out.push(-inner - r * Math.tan(((k / seg) * Math.PI) / 4));
    out.push(-inner, inner);
    for (let k = 1; k <= seg; k++) out.push(inner + r * Math.tan(((k / seg) * Math.PI) / 4));
    return out;
  };
  const faces = [
    [0, 1, [0, 0, -1], [0, 1, 0]],
    [0, -1, [0, 0, 1], [0, 1, 0]],
    [1, 1, [1, 0, 0], [0, 0, -1]],
    [1, -1, [1, 0, 0], [0, 0, 1]],
    [2, 1, [1, 0, 0], [0, 1, 0]],
    [2, -1, [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [axis, sign, au, av] of faces) {
    const ua = au.findIndex((x) => x !== 0);
    const va = av.findIndex((x) => x !== 0);
    const us = coords(H[ua]).map((x) => x * au[ua]);
    const vs = coords(H[va]).map((x) => x * av[va]);
    const n = us.length;
    const base = b.vertexCount;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        p[axis] = sign * H[axis];
        p[ua] = us[i];
        p[va] = vs[j];
        const c0 = Math.max(-(H[0] - r), Math.min(H[0] - r, p[0]));
        const c1 = Math.max(-(H[1] - r), Math.min(H[1] - r, p[1]));
        const c2 = Math.max(-(H[2] - r), Math.min(H[2] - r, p[2]));
        let nx = p[0] - c0, ny = p[1] - c1, nz = p[2] - c2;
        const l = Math.hypot(nx, ny, nz);
        if (l > 1e-12) {
          nx /= l;
          ny /= l;
          nz /= l;
        } else {
          // only reachable for r = 0: use the face normal
          nx = axis === 0 ? sign : 0;
          ny = axis === 1 ? sign : 0;
          nz = axis === 2 ? sign : 0;
        }
        b.vertex(c0 + nx * r, c1 + ny * r, c2 + nz * r, nx, ny, nz, (us[i] / H[ua] / au[ua] + 1) / 2, (vs[j] / H[va] / av[va] + 1) / 2);
      }
    }
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = base + j * n + i;
        b.quad(a, a + 1, a + n + 1, a + n);
      }
    }
  }
  return b.build();
}

/** Unit-radius UV sphere. */
export function unitSphere(segments) {
  const fast = primitivesWasm.sphere(segments);
  if (fast) return new Mesh({ ...fast, kind: 'triangles' });
  const w = Math.max(3, segments);
  const hRings = Math.max(2, Math.round(w / 2));
  // at the poles one triangle of each quad is degenerate and skipped
  const b = new MeshBuilder('triangles', (w + 1) * (hRings + 1), w * (hRings - 1) * 6);
  for (let j = 0; j <= hRings; j++) {
    const th = (j / hRings) * Math.PI;
    const st = Math.sin(th), ct = Math.cos(th);
    for (let i = 0; i <= w; i++) {
      const ph = ((i % w) / w) * TAU; // the seam column repeats column 0 exactly
      const x = st * Math.cos(ph), y = ct, z = -st * Math.sin(ph);
      b.vertex(x, y, z, x, y, z, i / w, 1 - j / hRings);
    }
  }
  const row = w + 1;
  for (let j = 0; j < hRings; j++) {
    for (let i = 0; i < w; i++) {
      const a = j * row + i, bb = (j + 1) * row + i, c = bb + 1, d = a + 1;
      // at the poles one triangle of each quad is degenerate and skipped
      if (j !== hRings - 1) b.tri(a, bb, c);
      if (j !== 0) b.tri(a, c, d);
    }
  }
  return b.build();
}

/** Cylinder / truncated cone of bottom radius 1, top radius `top`, height 1, centred on the origin. */
export function unitCylinder(top, segments, caps) {
  const fast = primitivesWasm.cylinder(top, segments, caps);
  if (fast) return new Mesh({ ...fast, kind: 'triangles' });
  const s = Math.max(3, segments);
  const b = new MeshBuilder(
    'triangles',
    (s + 1) * 2 + (caps ? s + 2 + (top > 0 ? s + 2 : 0) : 0),
    s * (top > 0 ? 6 : 3) + (caps ? s * 3 * (top > 0 ? 2 : 1) : 0),
  );
  const slope = 1 - top;
  const ring = [];
  for (let i = 0; i <= s; i++) {
    const ph = ((i % s) / s) * TAU;
    ring.push([Math.cos(ph), -Math.sin(ph)]);
  }
  const nrm = (c, sN) => {
    const l = Math.hypot(c, slope, sN);
    return [c / l, slope / l, sN / l];
  };
  const bottom = [];
  const topV = [];
  for (let i = 0; i <= s; i++) {
    const [c, sN] = ring[i];
    const n = nrm(c, sN);
    bottom.push(b.vertex(c, -0.5, sN, n[0], n[1], n[2], i / s, 0));
    if (top > 0) {
      topV.push(b.vertex(c * top, 0.5, sN * top, n[0], n[1], n[2], i / s, 1));
    } else {
      // apex: use the normal halfway through the segment for smooth shading
      const ph = ((i + 0.5) / s) * TAU;
      const m = nrm(Math.cos(ph), -Math.sin(ph));
      topV.push(b.vertex(0, 0.5, 0, m[0], m[1], m[2], (i + 0.5) / s, 1));
    }
  }
  for (let i = 0; i < s; i++) {
    if (top > 0) b.quad(bottom[i], bottom[i + 1], topV[i + 1], topV[i]);
    else b.tri(bottom[i], bottom[i + 1], topV[i]);
  }
  if (caps) {
    const cb = b.vertex(0, -0.5, 0, 0, -1, 0, 0.5, 0.5);
    const rb = [];
    for (let i = 0; i <= s; i++) rb.push(b.vertex(ring[i][0], -0.5, ring[i][1], 0, -1, 0, ring[i][0] * 0.5 + 0.5, ring[i][1] * 0.5 + 0.5));
    for (let i = 0; i < s; i++) b.tri(cb, rb[i + 1], rb[i]);
    if (top > 0) {
      const ct = b.vertex(0, 0.5, 0, 0, 1, 0, 0.5, 0.5);
      const rt = [];
      for (let i = 0; i <= s; i++) rt.push(b.vertex(ring[i][0] * top, 0.5, ring[i][1] * top, 0, 1, 0, ring[i][0] * 0.5 + 0.5, ring[i][1] * 0.5 + 0.5));
      for (let i = 0; i < s; i++) b.tri(ct, rt[i], rt[i + 1]);
    }
  }
  return b.build();
}

/** Capsule of radius 1 whose straight section has length L (total height L + 2). */
export function unitCapsule(L, segments) {
  const fast = primitivesWasm.capsule(L, segments);
  if (fast) return new Mesh({ ...fast, kind: 'triangles' });
  const w = Math.max(3, segments);
  const hr = Math.max(1, Math.round(w / 4));
  const rings = [];
  for (let k = 0; k <= hr; k++) rings.push([(k / hr) * (Math.PI / 2), L / 2]);
  for (let k = 0; k <= hr; k++) rings.push([Math.PI / 2 + (k / hr) * (Math.PI / 2), -L / 2]);
  const total = L + 2;
  const nRings = rings.length;
  const b = new MeshBuilder('triangles', nRings * (w + 1), w * 3 * (2 * (nRings - 1) - 2));
  for (let j = 0; j < rings.length; j++) {
    const [th, yo] = rings[j];
    const st = Math.sin(th), ct = Math.cos(th);
    const y = ct + yo;
    for (let i = 0; i <= w; i++) {
      const ph = ((i % w) / w) * TAU;
      const x = st * Math.cos(ph), z = -st * Math.sin(ph);
      b.vertex(x, y, z, x, ct, z, i / w, (y + total / 2) / total);
    }
  }
  const row = w + 1;
  const nr = rings.length;
  for (let j = 0; j < nr - 1; j++) {
    for (let i = 0; i < w; i++) {
      const a = j * row + i, bb = (j + 1) * row + i, c = bb + 1, d = a + 1;
      if (j !== nr - 2) b.tri(a, bb, c);
      if (j !== 0) b.tri(a, c, d);
    }
  }
  return b.build();
}

/** Unit plane in XZ facing +Y. */
export function unitPlane() {
  const b = new MeshBuilder('triangles', 4, 6);
  const a = b.vertex(-0.5, 0, 0.5, 0, 1, 0, 0, 0);
  const c = b.vertex(0.5, 0, 0.5, 0, 1, 0, 1, 0);
  const d = b.vertex(0.5, 0, -0.5, 0, 1, 0, 1, 1);
  const e = b.vertex(-0.5, 0, -0.5, 0, 1, 0, 0, 1);
  b.quad(a, c, d, e);
  return b.build();
}

/** Torus with major radius 1 and tube radius t, around Y, swept over `arcDeg`. */
export function unitTorus(t, arcDeg, segments, tubeSegments) {
  const fast = primitivesWasm.torus(t, arcDeg, segments, tubeSegments);
  if (fast) return new Mesh({ ...fast, kind: 'triangles' });
  const full = arcDeg >= 360 - 1e-9;
  const arc = (Math.min(arcDeg, 360) * Math.PI) / 180;
  const ts = Math.max(3, Math.round(segments * (full ? 1 : arcDeg / 360)) || 3);
  const rs = Math.max(3, tubeSegments);
  const b = new MeshBuilder('triangles', (ts + 1) * (rs + 1) + (full ? 0 : 2 * (rs + 2)), ts * rs * 6 + (full ? 0 : 2 * rs * 3));
  for (let i = 0; i <= ts; i++) {
    const ph = full ? ((i % ts) / ts) * TAU : (i / ts) * arc;
    const cp = Math.cos(ph), sp = Math.sin(ph);
    for (let j = 0; j <= rs; j++) {
      const th = ((j % rs) / rs) * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      const R = 1 + t * ct;
      b.vertex(R * cp, t * st, -R * sp, ct * cp, st, -ct * sp, i / ts, j / rs);
    }
  }
  const row = rs + 1;
  for (let i = 0; i < ts; i++) {
    for (let j = 0; j < rs; j++) {
      const a = i * row + j;
      b.quad(a, a + row, a + row + 1, a + 1);
    }
  }
  if (!full) {
    // end caps (discs) so a partial torus is closed
    for (const [ph, dir] of [[0, 1], [arc, -1]]) {
      const cp = Math.cos(ph), sp = Math.sin(ph);
      // outward normal: opposite to the sweep direction at the start, along it at the end
      const tx = -sp, tz = -cp;
      const nx = -tx * dir, nz = -tz * dir;
      const center = b.vertex(cp, 0, -sp, nx, 0, nz, 0.5, 0.5);
      const rim = [];
      for (let j = 0; j <= rs; j++) {
        const th = ((j % rs) / rs) * TAU;
        const R = 1 + t * Math.cos(th);
        rim.push(b.vertex(R * cp, t * Math.sin(th), -R * sp, nx, 0, nz, 0.5 + Math.cos(th) * 0.5, 0.5 + Math.sin(th) * 0.5));
      }
      for (let j = 0; j < rs; j++) {
        if (dir > 0) b.tri(center, rim[j], rim[j + 1]);
        else b.tri(center, rim[j + 1], rim[j]);
      }
    }
  }
  return b.build();
}

/** Hairline polyline through 3D points (rendered with the line pipeline). */
export function lineMesh(points, closed) {
  const n = points.length / 3;
  const b = new MeshBuilder('lines', n, 2 * (n - 1) + (closed && n > 2 ? 2 : 0));
  for (let i = 0; i < n; i++) b.vertex(points[i * 3], points[i * 3 + 1], points[i * 3 + 2], 0, 0, 0, i / Math.max(1, n - 1), 0);
  for (let i = 0; i < n - 1; i++) b.line(i, i + 1);
  if (closed && n > 2) b.line(n - 1, 0);
  return b.build();
}
