// Geometry registry: turns shape elements into geometry descriptors.
//
// A descriptor captures everything needed to (lazily) produce triangles:
//   key         cache key built only from shape-defining parameters; elements
//               that differ only in size share the same mesh (see `unit`)
//   unit        matrix from the canonical mesh space into element space
//   lods        number of tessellation levels (1 = no level of detail)
//   kind        'triangles' | 'lines'
//   doubleSided render back faces (flat or open surfaces)
//   bounds      conservative canonical bounds, known without tessellating
//   generate(lod, quality, report) -> Mesh
//   identity    (set here, built-in shapes only) the key with the full text of
//               every input it hashes: what the persistent geometry cache
//               names its records by, so that two shapes whose short keys
//               collide can never share a cached mesh
//
// New element types can be added with registerGeometry(); this is the
// extension point that keeps the core format small.

import * as mat4 from '../math/mat4.js';
import { valueOf } from '../format/schema.js';
import { pathControlBounds } from '../path/path-parser.js';
import { flattenPath, circleContour } from '../path/path-flatten.js';
import { buildRegions } from '../path/shapes.js';
import { unitBox, roundedBox, unitSphere, unitCylinder, unitCapsule, unitPlane, unitTorus, lineMesh, lodSegments } from './primitives.js';
import {
  sphereDeviation, cylinderDeviation, capsuleDeviation, torusDeviation, roundedBoxDeviation,
  gearDeviation, pathFlattenDeviation, bevelDeviation, circleSagitta,
} from './lod-error.js';
import { flatMesh, extrudeMesh } from './extrude.js';
import { revolveMesh } from './revolve.js';
import { sweepMesh, spinePolylines, catmullRom } from './sweep.js';
import { gearOutline } from './gear.js';
import { Mesh, computeNormals } from './mesh.js';

export const LOD_COUNT = 4;

function lodList(fn) {
  const a = new Array(LOD_COUNT);
  for (let lod = 0; lod < LOD_COUNT; lod++) a[lod] = fn(lod);
  return a;
}

function segsAt(base, min, fixed) {
  return fixed ? [fixed] : lodList((lod) => lodSegments(base, lod, 1, min));
}

const registry = new Map();
// shapes defined in this module; filled at the end of it. A replacement
// registered later loses the identity (its key may hash anything)
let builtins = null;

export function registerGeometry(name, describe) {
  registry.set(name, describe);
  if (builtins) builtins.delete(name);
}

export function hasGeometry(name) {
  return registry.has(name);
}

// raw inputs hashed into the key of the descriptor being built, or null
// when it cannot have an identity (keyed by a hash of mesh data)
let inputs = null;

/** @returns {object|null} descriptor */
export function describeShape(el, ctx) {
  const fn = registry.get(el.name);
  if (!fn) return null;
  inputs = builtins && builtins.has(el.name) ? [] : null;
  try {
    const desc = fn(el, ctx);
    if (desc && inputs) desc.identity = [desc.key, ...inputs].map((t) => `${t.length}:${t}`).join('');
    return desc;
  } finally {
    inputs = null;
  }
}

const box3 = (minX, minY, minZ, maxX, maxY, maxZ) => ({ min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
const S = (x, y, z) => mat4.fromScaling(mat4.createF64(), x, y, z);

function hashString(s) {
  if (inputs) inputs.push(s);
  // FNV-1a, two lanes for a 64-bit-ish key
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + ':' + s.length;
}

/** Hash of a typed array's contents (two 32-bit lanes + length). */
function hashTyped(a) {
  // mesh data: hashing all of it for a persistent name would cost more than
  // the mesh does to build, so such shapes have no identity
  inputs = null;
  if (!a) return '';
  const w = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
  let h1 = 0x9747b28c, h2 = 0x01000193;
  for (let i = 0; i < w.length; i++) {
    let k = Math.imul(w[i], 0xcc9e2d51);
    k = Math.imul((k << 15) | (k >>> 17), 0x1b873593);
    h1 ^= k;
    h1 = (Math.imul((h1 << 13) | (h1 >>> 19), 5) + 0xe6546b64) | 0;
    h2 = Math.imul(h2 ^ w[i], 0x85ebca6b);
    h2 ^= h2 >>> 13;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + ':' + a.length;
}

function rawOf(el, name) {
  const a = el.attrIndex && el.attrIndex[name];
  return a ? a.value.trim() : '';
}

/** Path data of a path-consuming element (inline d or referenced <path>). */
function pathSource(el) {
  if (el.values.d) return { path: el.values.d, raw: rawOf(el, 'd'), fillRule: valueOf(el, 'fillRule') };
  const t = el.pathTarget;
  if (t && t.values && t.values.d) {
    const rule = el.values.fillRule !== undefined ? el.values.fillRule : valueOf(t, 'fillRule');
    return { path: t.values.d, raw: rawOf(t, 'd'), fillRule: rule };
  }
  return null;
}

function pathDiag(segments) {
  const b = pathControlBounds(segments);
  return Math.hypot(b.maxX - b.minX, b.maxY - b.minY) || 1;
}

function pathTolerance(segments, lod, quality) {
  return pathFlattenDeviation(pathDiag(segments), lod) / quality;
}

function subpathsOpen(segments) {
  let open = false;
  let inSub = false;
  let closed = false;
  for (const s of segments) {
    if (s.c === 'M') {
      if (inSub && !closed) open = true;
      inSub = true;
      closed = false;
    } else if (s.c === 'Z') closed = true;
  }
  if (inSub && !closed) open = true;
  return open;
}

function regionsFor(src, lod, quality, report) {
  const contours = flattenPath(src.path.segments, { tolerance: pathTolerance(src.path.segments, lod, quality) });
  for (const c of contours) {
    if (c.degenerate && report) report('warning', 'W_DEGENERATE_CONTOUR', 'A subpath has fewer than three distinct points and encloses no area.');
  }
  const shape = buildRegions(contours, src.fillRule);
  if (!shape.regions.length && report) report('warning', 'W_EMPTY_FILL', 'The path encloses no area; nothing is filled.');
  return shape;
}

// --- primitives --------------------------------------------------------------

registerGeometry('box', (el) => {
  const size = valueOf(el, 'size');
  const r = valueOf(el, 'radius');
  if (r > 0) {
    const fixed = el.values.segments;
    return {
      key: `rbox:${size.join(',')}:${r}:${fixed || ''}`,
      unit: null,
      lods: fixed ? 1 : LOD_COUNT,
      kind: 'triangles',
      doubleSided: false,
      bounds: box3(-size[0] / 2, -size[1] / 2, -size[2] / 2, size[0] / 2, size[1] / 2, size[2] / 2),
      lodDeviation: segsAt(4, 1, fixed).map((n) => roundedBoxDeviation(r, n)),
      generate: (lod, q) => roundedBox(size[0], size[1], size[2], r, fixed || lodSegments(4, lod, q, 1)),
    };
  }
  return {
    key: 'box',
    unit: S(size[0], size[1], size[2]),
    lods: 1,
    kind: 'triangles',
    doubleSided: false,
    bounds: box3(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5),
    lodDeviation: [0],
    generate: () => unitBox(),
  };
});

registerGeometry('sphere', (el) => {
  const r = valueOf(el, 'radius');
  const fixed = el.values.segments;
  return {
    key: `sphere:${fixed || ''}`,
    unit: S(r, r, r),
    lods: fixed ? 1 : LOD_COUNT,
    kind: 'triangles',
    doubleSided: false,
    bounds: box3(-1, -1, -1, 1, 1, 1),
    lodDeviation: segsAt(48, 8, fixed).map(sphereDeviation),
    generate: (lod, q) => unitSphere(fixed || lodSegments(48, lod, q, 8)),
  };
});

function cylinderLike(el, top) {
  const r = valueOf(el, 'radius');
  const h = valueOf(el, 'height');
  const caps = valueOf(el, 'caps');
  const fixed = el.values.segments;
  const t = top / r;
  const m = Math.max(1, t);
  return {
    key: `cyl:${t}:${caps}:${fixed || ''}`,
    unit: S(r, h, r),
    lods: fixed ? 1 : LOD_COUNT,
    kind: 'triangles',
    doubleSided: !caps,
    bounds: box3(-m, -0.5, -m, m, 0.5, m),
    lodDeviation: segsAt(48, 8, fixed).map((n) => cylinderDeviation(t, n)),
    generate: (lod, q) => unitCylinder(t, fixed || lodSegments(48, lod, q, 8), caps),
  };
}

registerGeometry('cylinder', (el) => {
  const r = valueOf(el, 'radius');
  const top = el.values.radiusTop !== undefined ? el.values.radiusTop : r;
  return cylinderLike(el, top);
});

registerGeometry('cone', (el) => cylinderLike(el, 0));

registerGeometry('capsule', (el) => {
  const r = valueOf(el, 'radius');
  const h = valueOf(el, 'height');
  const L = Math.max(0, h / r - 2);
  const fixed = el.values.segments;
  return {
    key: `capsule:${L}:${fixed || ''}`,
    unit: S(r, r, r),
    lods: fixed ? 1 : LOD_COUNT,
    kind: 'triangles',
    doubleSided: false,
    bounds: box3(-1, -(L / 2 + 1), -1, 1, L / 2 + 1, 1),
    lodDeviation: segsAt(32, 8, fixed).map(capsuleDeviation),
    generate: (lod, q) => unitCapsule(L, fixed || lodSegments(32, lod, q, 8)),
  };
});

registerGeometry('plane', (el) => {
  const size = valueOf(el, 'size');
  return {
    key: 'plane',
    unit: S(size[0], 1, size[1]),
    lods: 1,
    kind: 'triangles',
    doubleSided: true,
    bounds: box3(-0.5, 0, -0.5, 0.5, 0, 0.5),
    lodDeviation: [0],
    generate: () => unitPlane(),
  };
});

registerGeometry('torus', (el) => {
  const R = valueOf(el, 'radius');
  const tube = valueOf(el, 'tube');
  const arc = valueOf(el, 'arc');
  const t = tube / R;
  const fs = el.values.segments;
  const ft = el.values.tubeSegments;
  return {
    key: `torus:${t}:${arc}:${fs || ''}:${ft || ''}`,
    unit: S(R, R, R),
    lods: fs && ft ? 1 : LOD_COUNT,
    kind: 'triangles',
    doubleSided: false,
    bounds: box3(-(1 + t), -t, -(1 + t), 1 + t, t, 1 + t),
    lodDeviation: (fs && ft ? [0] : lodList((lod) => 0)).map((_, lod) => torusDeviation(t, arc, fs || lodSegments(64, lod, 1, 8), ft || lodSegments(24, lod, 1, 6))),
    generate: (lod, q) => unitTorus(t, arc, fs || lodSegments(64, lod, q, 8), ft || lodSegments(24, lod, q, 6)),
  };
});

// --- curves --------------------------------------------------------------------

function pointsBounds(pts, dim, pad = 0) {
  const b = box3(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  for (let i = 0; i < pts.length; i += dim) {
    for (let k = 0; k < 3; k++) {
      const v = k < dim ? pts[i + k] : 0;
      if (v < b.min[k]) b.min[k] = v;
      if (v > b.max[k]) b.max[k] = v;
    }
  }
  for (let k = 0; k < 3; k++) {
    b.min[k] -= pad;
    b.max[k] += pad;
  }
  return b;
}

registerGeometry('line', (el) => {
  const a = el.values.from, b = el.values.to;
  const r = valueOf(el, 'radius');
  if (r > 0) {
    // a tube is the shared unit cylinder, oriented and scaled along the segment
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    const y = [d[0] / len, d[1] / len, d[2] / len];
    const ref = Math.abs(y[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
    let x = [ref[1] * y[2] - ref[2] * y[1], ref[2] * y[0] - ref[0] * y[2], ref[0] * y[1] - ref[1] * y[0]];
    const xl = Math.hypot(...x);
    x = x.map((v) => v / xl);
    const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    // columns: x*r, dir*len, z*r (right handed since z = x cross y), translation = midpoint
    const m = mat4.createF64();
    m.set([x[0] * r, x[1] * r, x[2] * r, 0, y[0] * len, y[1] * len, y[2] * len, 0, z[0] * r, z[1] * r, z[2] * r, 0, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 1]);
    const fixed = el.values.segments;
    return {
      key: `cyl:1:true:${fixed || ''}`,
      unit: m,
      lods: fixed ? 1 : LOD_COUNT,
      kind: 'triangles',
      doubleSided: false,
      bounds: box3(-1, -0.5, -1, 1, 0.5, 1),
      lodDeviation: segsAt(48, 8, fixed).map((n) => cylinderDeviation(1, n)),
      generate: (lod, q) => unitCylinder(1, fixed || lodSegments(48, lod, q, 8), true),
    };
  }
  return {
    key: `line:${a.join(',')}:${b.join(',')}`,
    unit: null,
    lods: 1,
    kind: 'lines',
    doubleSided: false,
    bounds: pointsBounds([...a, ...b], 3),
    lodDeviation: [0],
    generate: () => lineMesh([...a, ...b], false),
  };
});

registerGeometry('polyline', (el) => {
  const r = valueOf(el, 'radius');
  const closed = valueOf(el, 'closed');
  const smooth = valueOf(el, 'smooth');
  const fixed = el.values.segments;
  const pts = el.values.points;
  const d = el.values.d;
  const keyBase = pts ? `pts:${hashString(rawOf(el, 'points'))}` : `d:${hashString(rawOf(el, 'd'))}`;
  const polylines = (lod, q) => {
    if (pts) {
      let p = pts;
      if (smooth) p = catmullRom(pts, closed, lodSegments(12, lod, q, 2));
      return [{ points: p, closed }];
    }
    const tol = pathTolerance(d.segments, lod, q);
    return flattenPath(d.segments, { tolerance: tol }).map((c) => {
      const n = c.points.length / 2;
      const p3 = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        p3[i * 3] = c.points[i * 2];
        p3[i * 3 + 1] = c.points[i * 2 + 1];
      }
      return { points: p3, closed: c.closed || closed };
    });
  };
  let bounds;
  if (pts) {
    const raw = pointsBounds(pts, 3);
    const diag = Math.hypot(raw.max[0] - raw.min[0], raw.max[1] - raw.min[1], raw.max[2] - raw.min[2]);
    // splines may overshoot the control points slightly
    bounds = pointsBounds(pts, 3, r + (smooth ? 0.1 * diag : 0));
  } else {
    const cb = pathControlBounds(d.segments);
    bounds = box3(cb.minX - r, cb.minY - r, -r, cb.maxX + r, cb.maxY + r, r);
  }
  if (r > 0) {
    return {
      key: `tube:${keyBase}:${r}:${closed}:${smooth}:${fixed || ''}`,
      unit: null,
      lods: LOD_COUNT,
      kind: 'triangles',
      doubleSided: false,
      bounds,
      lodDeviation: lodList((lod) => {
        const spine = pts
          ? Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) * (smooth ? 0.05 / lodSegments(12, lod, 1, 2) : 0)
          : pathFlattenDeviation(pathDiag(d.segments), lod);
        return spine + r * circleSagitta(fixed || lodSegments(24, lod, 1, 6));
      }),
      generate: (lod, q, report) => sweepMesh({ kind: 'circle', radius: r, segments: fixed || lodSegments(24, lod, q, 6) }, polylines(lod, q), { caps: true }, report).mesh,
    };
  }
  return {
    key: `polyline:${keyBase}:${closed}:${smooth}`,
    unit: null,
    lods: smooth || d ? LOD_COUNT : 1,
    kind: 'lines',
    doubleSided: false,
    bounds,
    lodDeviation: smooth || d
      ? lodList((lod) => (pts
        ? Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) * (smooth ? 0.05 / lodSegments(12, lod, 1, 2) : 0)
        : pathFlattenDeviation(pathDiag(d.segments), lod)))
      : [0],
    generate: (lod, q) => {
      const list = polylines(lod, q);
      if (list.length === 1) return lineMesh(list[0].points, list[0].closed);
      // several subpaths: concatenate
      const meshes = list.map((l) => lineMesh(l.points, l.closed));
      let vc = 0, ic = 0;
      for (const m of meshes) {
        vc += m.vertexCount;
        ic += m.indices.length;
      }
      const positions = new Float32Array(vc * 3);
      const indices = new Uint32Array(ic);
      let vo = 0, io = 0;
      for (const m of meshes) {
        positions.set(m.positions, vo * 3);
        for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo;
        vo += m.vertexCount;
        io += m.indices.length;
      }
      return new Mesh({ positions, indices, kind: 'lines' });
    },
  };
});

// --- flat shapes -------------------------------------------------------------------

registerGeometry('polygon', (el) => {
  const pts = el.values.points;
  const contour = { points: Float64Array.from(pts), smooth: new Uint8Array(pts.length / 2), closed: true };
  return {
    key: `polygon:${hashString(rawOf(el, 'points'))}`,
    unit: null,
    lods: 1,
    kind: 'triangles',
    doubleSided: true,
    bounds: pointsBounds(pts, 2),
    lodDeviation: [0],
    generate: (lod, q, report) => flatMesh(buildRegions([contour], 'nonzero').regions, report),
  };
});

registerGeometry('path', (el) => {
  const src = pathSource(el);
  if (!src) return null;
  const cb = pathControlBounds(src.path.segments);
  return {
    key: `path:${hashString(src.raw)}:${src.fillRule}`,
    unit: null,
    lods: LOD_COUNT,
    kind: 'triangles',
    doubleSided: true,
    bounds: box3(cb.minX, cb.minY, 0, cb.maxX, cb.maxY, 0),
    lodDeviation: lodList((lod) => pathFlattenDeviation(pathDiag(src.path.segments), lod)),
    generate: (lod, q, report) => flatMesh(regionsFor(src, lod, q, report).regions, report),
  };
});

registerGeometry('extrude', (el) => {
  const src = pathSource(el);
  if (!src) return null;
  const depth = valueOf(el, 'depth');
  const bevel = valueOf(el, 'bevel');
  const bevelSegments = valueOf(el, 'bevelSegments');
  const center = valueOf(el, 'center');
  const cb = pathControlBounds(src.path.segments);
  const z0 = center ? -depth / 2 : 0;
  return {
    key: `extrude:${hashString(src.raw)}:${src.fillRule}:${depth}:${bevel}:${bevelSegments}:${center}`,
    unit: null,
    lods: LOD_COUNT,
    kind: 'triangles',
    doubleSided: false,
    bounds: box3(cb.minX, cb.minY, z0, cb.maxX, cb.maxY, z0 + depth),
    lodDeviation: lodList((lod) => pathFlattenDeviation(pathDiag(src.path.segments), lod) + bevelDeviation(bevel, Math.max(1, Math.round(bevelSegments / (lod >= 2 ? 2 : 1))))),
    generate: (lod, q, report) =>
      extrudeMesh(regionsFor(src, lod, q, report), { depth, bevel, bevelSegments: Math.max(1, Math.round(bevelSegments / (lod >= 2 ? 2 : 1))), center }, report),
  };
});

registerGeometry('revolve', (el) => {
  const src = pathSource(el);
  if (!src) return null;
  const angle = valueOf(el, 'angle');
  const fixed = el.values.segments;
  const cb = pathControlBounds(src.path.segments);
  const R = Math.max(Math.abs(cb.maxX), Math.abs(cb.minX));
  return {
    key: `revolve:${hashString(src.raw)}:${angle}:${fixed || ''}`,
    unit: null,
    lods: LOD_COUNT,
    kind: 'triangles',
    doubleSided: subpathsOpen(src.path.segments),
    bounds: box3(-R, cb.minY, -R, R, cb.maxY, R),
    lodDeviation: lodList((lod) => {
      const segs = fixed || Math.max(3, Math.round(lodSegments(48, lod, 1, 8) * Math.min(1, angle / 360) + (angle < 360 ? 1 : 0)));
      return pathFlattenDeviation(pathDiag(src.path.segments), lod) + R * circleSagitta(segs);
    }),
    generate: (lod, q, report) => {
      const contours = flattenPath(src.path.segments, { tolerance: pathTolerance(src.path.segments, lod, q) });
      const segs = fixed || Math.max(3, Math.round(lodSegments(48, lod, q, 8) * Math.min(1, angle / 360) + (angle < 360 ? 1 : 0)));
      return revolveMesh(contours, { angle, segments: segs }, report).mesh;
    },
  };
});

function spineBounds(spine) {
  if (spine.kind === 'helix') return box3(-spine.radius, Math.min(0, spine.pitch * spine.turns), -spine.radius, spine.radius, Math.max(0, spine.pitch * spine.turns), spine.radius);
  if (spine.kind === 'points') {
    const b = pointsBounds(spine.points, 3);
    const pad = 0.15 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    return pointsBounds(spine.points, 3, pad);
  }
  const b = box3(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  for (const s of spine.segments) {
    if (s.c === 'Z') continue;
    const pts = [[s.x, s.y, s.z]];
    if (s.c === 'C') pts.push([s.x1, s.y1, s.z1], [s.x2, s.y2, s.z2]);
    if (s.c === 'Q') pts.push([s.x1, s.y1, s.z1]);
    for (const p of pts) for (let k = 0; k < 3; k++) {
      b.min[k] = Math.min(b.min[k], p[k] || 0);
      b.max[k] = Math.max(b.max[k], p[k] || 0);
    }
  }
  return b;
}

registerGeometry('sweep', (el) => {
  const spine = el.values.along;
  const radius = el.values.radius;
  const src = radius === undefined ? pathSource(el) : null;
  if (radius === undefined && !src) return null;
  const smooth = valueOf(el, 'smooth');
  const twist = valueOf(el, 'twist');
  const taper = valueOf(el, 'taper');
  const caps = valueOf(el, 'caps');
  const fixed = el.values.segments;
  let profileR = radius;
  if (src) {
    const cb = pathControlBounds(src.path.segments);
    profileR = Math.max(Math.abs(cb.minX), Math.abs(cb.maxX), Math.abs(cb.minY), Math.abs(cb.maxY));
  }
  const sb = spineBounds(spine);
  const pad = profileR * Math.max(1, taper) * 1.5;
  const spineOpen = spine.kind === 'helix' || (spine.kind === 'path' ? subpathsOpen(spine.segments) : !(spine.points.length > 6 && spine.points[0] === spine.points[spine.points.length - 3] && spine.points[1] === spine.points[spine.points.length - 2] && spine.points[2] === spine.points[spine.points.length - 1]));
  const spineSize = Math.hypot(sb.max[0] - sb.min[0], sb.max[1] - sb.min[1], sb.max[2] - sb.min[2]) || 1;
  return {
    key: `sweep:${src ? hashString(src.raw) + ':' + src.fillRule : 'r' + radius}:${hashString(rawOf(el, 'along'))}:${smooth}:${twist}:${taper}:${caps}:${fixed || ''}`,
    unit: null,
    lods: LOD_COUNT,
    kind: 'triangles',
    doubleSided: !caps && spineOpen,
    bounds: box3(sb.min[0] - pad, sb.min[1] - pad, sb.min[2] - pad, sb.max[0] + pad, sb.max[1] + pad, sb.max[2] + pad),
    lodDeviation: lodList((lod) => {
      const profileErr = src
        ? pathFlattenDeviation(pathDiag(src.path.segments), lod)
        : (radius || 0) * circleSagitta(fixed || lodSegments(24, lod, 1, 6));
      return pathFlattenDeviation(spineSize, lod) + profileErr;
    }),
    generate: (lod, q, report) => {
      const spines = spinePolylines(spine, {
        tolerance: pathFlattenDeviation(spineSize, lod) / q,
        segmentsPerTurn: lodSegments(48, lod, q, 8),
        smooth,
        subdivisions: lodSegments(12, lod, q, 2),
      });
      const profile = src
        ? { kind: 'shape', ...regionsFor(src, lod, q, report) }
        : { kind: 'circle', radius, segments: fixed || lodSegments(24, lod, q, 6) };
      return sweepMesh(profile, spines, { twist, taper, caps }, report).mesh;
    },
  };
});

registerGeometry('gear', (el) => {
  const teeth = valueOf(el, 'teeth');
  const m = valueOf(el, 'module');
  const pa = valueOf(el, 'pressureAngle');
  const depth = valueOf(el, 'depth') / m;
  const bore = valueOf(el, 'bore') / m;
  const bevel = valueOf(el, 'bevel') / m;
  const center = valueOf(el, 'center');
  const ra = teeth / 2 + 1;
  const z0 = center ? -depth / 2 : 0;
  return {
    key: `gear:${teeth}:${pa}:${depth}:${bore}:${bevel}:${center}`,
    unit: S(m, m, m),
    lods: LOD_COUNT,
    kind: 'triangles',
    doubleSided: false,
    bounds: box3(-ra, -ra, z0, ra, ra, z0 + depth),
    lodDeviation: lodList((lod) => gearDeviation(teeth, lodSegments(8, lod, 1, 2)) + bevelDeviation(bevel, lod >= 2 ? 1 : 2)),
    generate: (lod, q, report) => {
      const flank = lodSegments(8, lod, q, 2);
      const arc = lodSegments(4, lod, q, 2);
      const g = gearOutline(teeth, pa, flank, arc);
      const outer = { ...g.outline, isWall: true };
      const holes = [];
      if (bore > 0) {
        const c = circleContour(bore, lodSegments(48, lod, q, 8));
        // holes are clockwise
        const n = c.points.length / 2;
        const rev = new Float64Array(c.points.length);
        for (let i = 0; i < n; i++) {
          rev[i * 2] = c.points[(n - 1 - i) * 2];
          rev[i * 2 + 1] = c.points[(n - 1 - i) * 2 + 1];
        }
        holes.push({ points: rev, smooth: c.smooth, closed: true, isWall: true });
      }
      const shape = { regions: [{ outer, holes }], walls: [outer, ...holes] };
      return extrudeMesh(shape, { depth, bevel, bevelSegments: lod >= 2 ? 1 : 2, center }, report);
    },
  };
});

registerGeometry('mesh', (el) => {
  const positions = el.values.positions;
  const indices = el.values.indices || Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  const normals = el.values.normals;
  const uvs = el.values.uvs;
  const smooth = valueOf(el, 'smooth');
  // keyed by value, not spelling: "1.0" and "1" describe the same mesh
  const key = `mesh:${hashTyped(positions)}:${hashTyped(el.values.indices)}:${hashTyped(normals)}:${hashTyped(uvs)}:${smooth}`;
  return {
    key,
    unit: null,
    lods: 1,
    kind: 'triangles',
    doubleSided: false,
    bounds: pointsBounds(positions, 3),
    lodDeviation: [0],
    generate: () => {
      if (normals) return new Mesh({ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: uvs ? Float32Array.from(uvs) : null, indices: Uint32Array.from(indices) });
      return computeNormals(positions, indices, smooth, uvs);
    },
  };
});

builtins = new Set(registry.keys());
