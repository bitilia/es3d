// Flat fills and extrusions of 2D regions.
//
// extrude: caps are the triangulated regions (front at z = depth facing +Z,
// back at z = 0 facing -Z); side walls follow the contours where the fill
// state changes. An optional quarter-circle bevel insets the caps by `bevel`
// so the silhouette of the 2D path is kept at the widest point.

import { Mesh, MeshBuilder } from './mesh.js';
import { triangulateRegion } from '../path/shapes.js';
import { contourFrames, bounds2 } from './contour.js';
import { extrudeWasm } from '../wasm/kernels.js';

function regionBounds(regions) {
  const lists = [];
  for (const r of regions) {
    lists.push(r.outer.points);
    for (const h of r.holes) lists.push(h.points);
  }
  return bounds2(lists);
}

/** Warn about a triangulation that does not cover its region (self-intersecting input). */
export function reportTriangulation(error, report) {
  if (error > 0.01 && report) {
    report('warning', 'W_SELF_INTERSECTION', `A filled contour appears to be self-intersecting; the triangulation covers ${(100 * (1 - error)).toFixed(1)}% of the expected area.`);
  }
}

/** Triangulate regions once; reports malformed (self-intersecting) input. */
export function triangulateRegions(regions, report) {
  const out = [];
  for (const r of regions) {
    const t = triangulateRegion(r);
    reportTriangulation(t.error, report);
    out.push({ region: r, ...t });
  }
  return out;
}

/** Flat double-sided fill in the XY plane (normal +Z). */
export function flatMesh(regions, report) {
  const tris = triangulateRegions(regions, report);
  let vertices = 0, indices = 0;
  for (const t of tris) {
    vertices += t.positions.length / 2;
    indices += t.indices.length;
  }
  const b = new MeshBuilder('triangles', vertices, indices);
  const bb = regionBounds(regions);
  for (const t of tris) {
    const base = b.vertexCount;
    const p = t.positions;
    for (let i = 0; i < p.length; i += 2) {
      b.vertex(p[i], p[i + 1], 0, 0, 0, 1, (p[i] - bb.minX) / bb.size, (p[i + 1] - bb.minY) / bb.size);
    }
    const idx = t.indices;
    for (let i = 0; i < idx.length; i += 3) b.tri(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
  }
  return b.build();
}

/**
 * Inset positions of a contour: p - a * miter (a = 0 for contours that are not walls).
 */
function insetPoints(contour, amount) {
  const pts = contour.points;
  if (!amount || contour.isWall === false) return pts;
  const f = contourFrames(pts, contour.smooth, true);
  const out = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = pts[i] - f.miter[i] * amount;
    out[i + 1] = pts[i + 1] - f.miter[i + 1] * amount;
  }
  return out;
}

/** Profile rings (back to front) for a straight or bevelled wall. */
function wallProfile(depth, bevel, segs) {
  const rings = [];
  if (!(bevel > 0)) {
    rings.push({ inset: 0, z: 0, nr: 1, nz: 0 }, { inset: 0, z: depth, nr: 1, nz: 0 });
    return rings;
  }
  for (let k = 0; k <= segs; k++) {
    const phi = (k / segs) * (Math.PI / 2);
    rings.push({ inset: bevel * (1 - Math.sin(phi)), z: bevel * (1 - Math.cos(phi)), nr: Math.sin(phi), nz: -Math.cos(phi) });
  }
  for (let k = segs; k >= 0; k--) {
    const phi = (k / segs) * (Math.PI / 2);
    const ring = { inset: bevel * (1 - Math.sin(phi)), z: depth - bevel * (1 - Math.cos(phi)), nr: Math.sin(phi), nz: Math.cos(phi) };
    // the straight section starts where the back bevel ends
    if (k === segs && Math.abs(ring.z - rings[rings.length - 1].z) < 1e-12) continue;
    rings.push(ring);
  }
  return rings;
}

/**
 * @param {{regions: object[], walls: object[]}} shape from buildRegions (contours carry `smooth` and `isWall`)
 * @param {{depth:number, bevel?:number, bevelSegments?:number, center?:boolean}} o
 */
export function extrudeMesh(shape, o, report) {
  const depth = o.depth;
  const bevel = Math.min(o.bevel || 0, depth / 2);
  const segs = o.bevelSegments || 3;
  const z0 = o.center ? -depth / 2 : 0;
  const bb = regionBounds(shape.regions);
  const S = bb.size;
  const rings = wallProfile(depth, bevel, segs);
  const w = extrudeWasm(shape, bevel, rings, z0, z0 + depth, bb.minX, bb.minY, S);
  if (w) {
    for (const e of w.errors) reportTriangulation(e, report);
    return new Mesh({ positions: w.positions, normals: w.normals, uvs: w.uvs, indices: w.indices, kind: 'triangles' });
  }

  // caps: the inset contours are triangulated directly (re-using the original
  // triangulation with moved vertices can flip long thin triangles)
  const capRegions = shape.regions.map((r) => ({
    outer: { ...r.outer, points: insetPoints(r.outer, bevel) },
    holes: r.holes.map((h) => ({ ...h, points: insetPoints(h, bevel) })),
  }));
  const caps = triangulateRegions(capRegions, report);
  const walls = shape.walls.map((c) => ({ pts: c.points, f: contourFrames(c.points, c.smooth, true) }));
  // count first, so the mesh is allocated once at its final size
  let vertices = 0, indices = 0;
  for (const t of caps) {
    vertices += t.positions.length;
    indices += 2 * t.indices.length;
  }
  for (const { f } of walls) {
    vertices += f.n * rings.length * 2;
    indices += f.n * (rings.length - 1) * 6;
  }
  const b = new MeshBuilder('triangles', vertices, indices);
  for (const t of caps) {
    const flat = t.positions;
    const idx = t.indices;
    for (const [z, nz] of [[z0 + depth, 1], [z0, -1]]) {
      const base = b.vertexCount;
      for (let i = 0; i < flat.length; i += 2) {
        b.vertex(flat[i], flat[i + 1], z, 0, 0, nz, (flat[i] - bb.minX) / S, (flat[i + 1] - bb.minY) / S);
      }
      for (let i = 0; i < idx.length; i += 3) {
        if (nz > 0) b.tri(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
        else b.tri(base + idx[i], base + idx[i + 2], base + idx[i + 1]);
      }
    }
  }

  // walls
  for (const { pts, f } of walls) {
    const n = f.n;
    for (let e = 0; e < n; e++) {
      const i0 = e, i1 = (e + 1) % n;
      // normal at each end of the edge: the edge's own at corners, else the vertex's
      const n0x = f.corner[i0] ? f.edgeN[e * 2] : f.vertN[i0 * 2], n0y = f.corner[i0] ? f.edgeN[e * 2 + 1] : f.vertN[i0 * 2 + 1];
      const n1x = f.corner[i1] ? f.edgeN[e * 2] : f.vertN[i1 * 2], n1y = f.corner[i1] ? f.edgeN[e * 2 + 1] : f.vertN[i1 * 2 + 1];
      const u0 = f.arc[e] / S, u1 = f.arc[e + 1] / S;
      let prevA = -1, prevB = -1;
      for (const ring of rings) {
        const ax = pts[i0 * 2] - f.miter[i0 * 2] * ring.inset;
        const ay = pts[i0 * 2 + 1] - f.miter[i0 * 2 + 1] * ring.inset;
        const bx = pts[i1 * 2] - f.miter[i1 * 2] * ring.inset;
        const by = pts[i1 * 2 + 1] - f.miter[i1 * 2 + 1] * ring.inset;
        const z = z0 + ring.z;
        const a = b.vertex(ax, ay, z, n0x * ring.nr, n0y * ring.nr, ring.nz, u0, ring.z / S);
        const c = b.vertex(bx, by, z, n1x * ring.nr, n1y * ring.nr, ring.nz, u1, ring.z / S);
        if (prevA >= 0) b.quad(prevA, prevB, c, a);
        prevA = a;
        prevB = c;
      }
    }
  }
  return b.build();
}
