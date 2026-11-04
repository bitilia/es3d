// Scene description shared by the X3D, USD, OpenSCAD and three.js exporters.
//
// structure 'keep' walks the scene graph. A shape stays a primitive wherever
// the target has one; the size is the element's own size, taken from the
// schema defaults and from the canonical unit matrix in registry.js (the unit
// matrix is not applied a second time). A shape the target cannot say stays
// one mesh per geometry entry, at the requested tessellation level.
//
// structure 'flatten' walks the RenderScene, the same triangles as the glTF
// and OBJ exporters at that level, one mesh per geometry and one instance per
// drawn copy.
//
// <lod> keeps its first child, which is the most detailed alternative, matching
// exportableInstances(). <repeat> and <scatter> stay as placement rules; each
// writer expands them with the target's own reuse (a loop, a point instancer,
// or a copy per placement). Scatter placements are computed here, with the
// same mulberry32 and es3dSin the flattener uses, so a baked copy lands on the
// same point.

import * as mat4 from '../math/mat4.js';
import { valueOf } from '../format/schema.js';
import { lodSegments } from '../geometry/primitives.js';
import { gearOutline } from '../geometry/gear.js';
import { pathFlattenDeviation } from '../geometry/lod-error.js';
import { pathControlBounds } from '../path/path-parser.js';
import { flattenPath, circleContour } from '../path/path-flatten.js';
import { buildRegions, triangulateRegion } from '../path/shapes.js';
import { mulberry32 } from '../math/random.js';
import { es3dSin, es3dCos } from '../math/trig.js';
import { exportableInstances } from './external-scene.js';

const CURVE = new Set(['C', 'S', 'Q', 'T', 'A']);

function segs(el, base, min, lod) {
  return el.values.segments || lodSegments(base, lod, 1, min);
}

function pathOf(el) {
  if (el.values.d) return { path: el.values.d, fillRule: valueOf(el, 'fillRule') };
  const t = el.pathTarget;
  if (t && t.values && t.values.d) {
    const fillRule = el.values.fillRule !== undefined ? el.values.fillRule : valueOf(t, 'fillRule');
    return { path: t.values.d, fillRule };
  }
  return null;
}

function tolerance(segments, lod) {
  const b = pathControlBounds(segments);
  const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) || 1;
  return pathFlattenDeviation(diag, lod);
}

function hasCurve(segments) {
  return segments.some((s) => CURVE.has(s.c));
}

function pts2(typed) {
  return Array.from(typed);
}

/** Stable key for a list of contours, so two different outlines never share a definition. */
function contourKey(regions) {
  let h = 2166136261;
  const mix = (v) => {
    h ^= Math.round(v * 1e6) | 0;
    h = Math.imul(h, 16777619);
  };
  for (const r of regions) {
    for (const v of r.outer) mix(v);
    mix(1);
    for (const hole of r.holes) {
      for (const v of hole) mix(v);
      mix(2);
    }
  }
  return (h >>> 0).toString(36);
}

function scalePts(typed, s) {
  const o = new Array(typed.length);
  for (let i = 0; i < typed.length; i++) o[i] = typed[i] * s;
  return o;
}

/** One filled outline and its holes, in the XY plane. Outer is counter-clockwise. */
function regionsOf(src, lod, curves) {
  if (hasCurve(src.path.segments)) curves.count++;
  const contours = flattenPath(src.path.segments, { tolerance: tolerance(src.path.segments, lod) });
  const shape = buildRegions(contours, src.fillRule);
  if (!shape.regions.length) return null;
  return shape.regions.map((r) => ({
    outer: pts2(r.outer.points),
    holes: r.holes.map((h) => pts2(h.points)),
  }));
}

/**
 * A primitive in element space, or null when the shape has to be a mesh.
 * `unit` means the mesh (or the unit cylinder of a straight tube) still needs
 * the canonical unit matrix from the registry.
 */
function parametric(el, lod, curves) {
  const name = el.name;
  if (name === 'box') {
    if (valueOf(el, 'radius') > 0) return null;
    const size = valueOf(el, 'size');
    return { solid: { kind: 'box', size: size.slice(), key: `box:${size.join('x')}` } };
  }
  if (name === 'sphere') {
    const radius = valueOf(el, 'radius');
    const segments = segs(el, 48, 8, lod);
    return { solid: { kind: 'sphere', radius, segments, key: `sphere:${radius}:${segments}` } };
  }
  if (name === 'cylinder' || name === 'cone') {
    const radius = valueOf(el, 'radius');
    const height = valueOf(el, 'height');
    const top = name === 'cone' ? 0 : (el.values.radiusTop !== undefined ? el.values.radiusTop : radius);
    const caps = valueOf(el, 'caps');
    const segments = segs(el, 48, 8, lod);
    if (!(radius > 0) || !(height > 0)) return null;
    if (top === 0) return { solid: { kind: 'cone', radius, height, caps, segments, key: `cone:${radius}:${height}:${caps}:${segments}` } };
    if (Math.abs(top - radius) < 1e-12) {
      return { solid: { kind: 'cylinder', radius, height, caps, segments, key: `cyl:${radius}:${height}:${caps}:${segments}` } };
    }
    return { solid: { kind: 'frustum', radius, radiusTop: top, height, caps, segments, key: `frustum:${radius}:${top}:${height}:${caps}:${segments}` } };
  }
  if (name === 'capsule') {
    const radius = valueOf(el, 'radius');
    const height = valueOf(el, 'height');
    const segments = segs(el, 32, 8, lod);
    return { solid: { kind: 'capsule', radius, height, segments, key: `capsule:${radius}:${height}:${segments}` } };
  }
  if (name === 'plane') {
    const size = valueOf(el, 'size');
    return { solid: { kind: 'plane', width: size[0], depth: size[1], key: `plane:${size[0]}x${size[1]}` } };
  }
  if (name === 'torus') {
    const arc = valueOf(el, 'arc');
    if (arc < 360 - 1e-6) return null;
    const radius = valueOf(el, 'radius');
    const tube = valueOf(el, 'tube');
    const segments = el.values.segments || lodSegments(64, lod, 1, 8);
    const tubeSegments = el.values.tubeSegments || lodSegments(24, lod, 1, 6);
    return { solid: { kind: 'torus', radius, tube, segments, tubeSegments, key: `torus:${radius}:${tube}:${segments}:${tubeSegments}` } };
  }
  if (name === 'line' && valueOf(el, 'radius') > 0) {
    const segments = segs(el, 48, 8, lod);
    return { solid: { kind: 'cylinder', radius: 1, height: 1, caps: true, segments, key: `tube:${segments}` }, unit: true };
  }
  if (name === 'extrude') {
    if (valueOf(el, 'bevel') > 0) return null;
    const src = pathOf(el);
    if (!src) return null;
    const regions = regionsOf(src, lod, curves);
    if (!regions) return null;
    const depth = valueOf(el, 'depth');
    const center = valueOf(el, 'center');
    return { solid: { kind: 'extrude', depth, center, regions, key: `extrude:${depth}:${center}:${contourKey(regions)}` } };
  }
  if (name === 'polygon') {
    const points = el.values.points;
    if (!points || points.length < 6) return null;
    const regions = [{ outer: pts2(points), holes: [] }];
    return { solid: { kind: 'surface', regions, key: `poly:${contourKey(regions)}` } };
  }
  if (name === 'path') {
    const src = pathOf(el);
    if (!src) return null;
    const regions = regionsOf(src, lod, curves);
    if (!regions) return null;
    return { solid: { kind: 'surface', regions, key: `path:${contourKey(regions)}` } };
  }
  if (name === 'revolve') {
    const src = pathOf(el);
    if (!src) return null;
    if (hasCurve(src.path.segments)) curves.count++;
    const contours = flattenPath(src.path.segments, { tolerance: tolerance(src.path.segments, lod) });
    if (contours.length !== 1) return null;
    const raw = contours[0].points;
    for (let i = 0; i < raw.length; i += 2) if (raw[i] < -1e-6) return null;
    const points = [];
    for (let i = 0; i < raw.length; i += 2) points.push(Math.max(0, raw[i]), raw[i + 1]);
    const closed = !!contours[0].closed;
    const angle = valueOf(el, 'angle');
    const segments = el.values.segments || Math.max(3, Math.round(lodSegments(48, lod, 1, 8) * Math.min(1, angle / 360) + (angle < 360 ? 1 : 0)));
    return { solid: { kind: 'revolve', points, closed, angle, segments, doubleSided: angle < 360 - 1e-6 || !closed, key: `revolve:${angle}:${segments}:${closed}:${contourKey([{ outer: points, holes: [] }])}` } };
  }
  if (name === 'gear') {
    if (valueOf(el, 'bevel') > 0) return null;
    const teeth = valueOf(el, 'teeth');
    const module = valueOf(el, 'module');
    const pa = valueOf(el, 'pressureAngle');
    const depth = valueOf(el, 'depth');
    const bore = valueOf(el, 'bore');
    const center = valueOf(el, 'center');
    const flank = lodSegments(8, lod, 1, 2);
    const arc = lodSegments(4, lod, 1, 2);
    const g = gearOutline(teeth, pa, flank, arc);
    const regions = [{ outer: scalePts(g.outline.points, module), holes: [] }];
    if (bore > 0) {
      const c = circleContour(bore / module, lodSegments(48, lod, 1, 8));
      const n = c.points.length / 2;
      const hole = new Array(n * 2);
      for (let i = 0; i < n; i++) {
        const j = n - 1 - i;
        hole[i * 2] = c.points[j * 2] * module;
        hole[i * 2 + 1] = c.points[j * 2 + 1] * module;
      }
      regions[0].holes.push(hole);
    }
    return { solid: { kind: 'extrude', depth, center, regions, key: `gear:${teeth}:${module}:${pa}:${depth}:${bore}:${center}:${contourKey(regions)}` } };
  }
  return null;
}

function meshSolid(node, meshOf, lod) {
  const entry = node.geometry;
  const mesh = meshOf(entry, Math.min(lod, entry.lods - 1));
  const kind = mesh.kind === 'lines' ? 'lines' : 'mesh';
  return {
    solid: {
      kind,
      key: `g${entry.id}`,
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
    },
    unit: true,
  };
}

function composed(local, unit) {
  if (!unit && !local) return null;
  if (!unit) return mat4.isIdentity(local, 1e-12) ? null : new Float64Array(local);
  if (!local || mat4.isIdentity(local, 1e-12)) return mat4.isIdentity(unit, 1e-12) ? null : new Float64Array(unit);
  const out = mat4.createF64();
  mat4.multiply(out, local, unit);
  return mat4.isIdentity(out, 1e-12) ? null : out;
}

function group(matrix, children, own) {
  if (!children.length) return null;
  const style = own || NO_STYLE;
  const styled = style.material != null || style.color != null;
  const m = matrix && !mat4.isIdentity(matrix, 1e-12) ? new Float64Array(matrix) : null;
  if (!m && children.length === 1 && !styled) return children[0];
  return { kind: 'group', matrix: m, children, own: style };
}

const FALLBACK = {
  box: 'rounded box',
  extrude: 'bevelled extrusion',
  sweep: 'sweep',
  torus: 'partial torus',
  polyline: 'tube along a path',
  revolve: 'revolve',
  gear: 'bevelled gear',
  mesh: 'authored mesh',
  line: 'line',
  polygon: 'polygon',
  path: 'filled path',
};

/**
 * @param {{graph: object, scene: object, doc: object}} compiled
 * @param {(entry: object, lod: number) => object} meshOf
 * @param {{lod?: number, structure?: 'keep'|'flatten'}} [opts]
 */
export function buildExportModel(compiled, meshOf, { lod = 0, structure = 'keep' } = {}) {
  const level = Math.max(0, Math.min(3, lod | 0));
  const { graph, scene, doc } = compiled;
  const materials = graph.materials;
  const notes = [];
  const counts = new Map();
  const count = (key, n = 1) => counts.set(key, (counts.get(key) || 0) + n);
  const curves = { count: 0 };
  let meshTriangles = 0;

  const addMesh = (solid) => {
    if (solid.kind === 'mesh') meshTriangles += solid.indices.length / 3;
    else if (solid.kind === 'lines') meshTriangles += solid.indices.length / 2;
  };

  let root = null;
  if (structure === 'flatten') {
    const solids = new Map();
    const children = [];
    for (const i of exportableInstances(scene)) {
      const gi = scene.geom[i];
      let solid = solids.get(gi);
      if (!solid) {
        const entry = scene.geometries[gi];
        const mesh = meshOf(entry, Math.min(level, entry.lods - 1));
        solid = {
          kind: mesh.kind === 'lines' ? 'lines' : 'mesh',
          key: `g${entry.id}`,
          positions: mesh.positions,
          normals: mesh.normals,
          indices: mesh.indices,
          doubleSided: !!entry.doubleSided,
        };
        solids.set(gi, solid);
        addMesh(solid);
      }
      const mi = scene.mat[i];
      const matrix = new Float64Array(16);
      const src = scene.matrices;
      const o = i * 16;
      for (let k = 0; k < 16; k++) matrix[k] = src[o + k];
      const mp = materials.list[mi];
      children.push({
        kind: 'shape',
        matrix: mat4.isIdentity(matrix, 1e-7) ? null : matrix,
        solid,
        material: mi,
        inherits: false,
        doubleSided: !!(solid.doubleSided || (mp && mp.doubleSided)),
      });
    }
    root = children.length === 1 ? children[0] : { kind: 'group', matrix: null, children };
    notes.push('Flattened to the triangles of the glTF and OBJ export at this level of detail, one mesh per geometry.');
  } else {
    const reasonOf = new Map();
    const walk = (node, inMat, inCol) => {
      if (!node || node.visible === false) {
        if (node && node.visible === false) count('hidden');
        return null;
      }
      if (node.anims && node.anims.length) count('animated');
      if (node.kind === 'light' || node.kind === 'camera') return null;
      const local = node.scriptLocal || node.local || null;
      let mat = inMat;
      let col = inCol;
      if (node.material !== null && node.material !== undefined) {
        mat = node.material;
        col = null;
      }
      if (node.color !== null && node.color !== undefined) col = node.color;
      const inherits = (node.material === null || node.material === undefined) && (node.color === null || node.color === undefined);

      const own = styleOf(node);
      if (node.kind === 'lod') {
        if (node.children.length > 1) count('lod', node.children.length - 1);
        const chosen = node.children[0] ? walk(node.children[0], mat, col) : null;
        return group(local, chosen ? [chosen] : [], own);
      }
      if (node.kind === 'repeat') {
        const children = node.children.map((c) => walk(c, mat, col)).filter(Boolean);
        if (!children.length || !node.count) return null;
        return group(local, [{ kind: 'repeat', count: node.count, step: new Float64Array(node.step), children, own: NO_STYLE }], own);
      }
      if (node.kind === 'scatter') {
        const children = node.children.map((c) => walk(c, mat, col)).filter(Boolean);
        if (!children.length || !node.params || !node.params.count) return null;
        if (node.params.randomMaterial) {
          for (const id of node.params.randomMaterial) materials.resolve(id, null);
        }
        return group(local, [{ kind: 'scatter', params: node.params, children, own: NO_STYLE }], own);
      }
      if (node.kind === 'use') {
        const parts = [];
        if (node.target) {
          const t = walk(node.target, mat, col);
          if (t) parts.push(t);
        }
        for (const c of node.children) {
          const t = walk(c, mat, col);
          if (t) parts.push(t);
        }
        return group(local, parts, own);
      }
      if (node.kind === 'shape') {
        if (!node.geometry) return null;
        let built = parametric(node.el, level, curves);
        if (!built) {
          const why = FALLBACK[node.el.name] || node.el.name;
          reasonOf.set(why, (reasonOf.get(why) || 0) + 1);
          built = meshSolid(node, meshOf, level);
          addMesh(built.solid);
        }
        const mi = materials.resolve(mat, col);
        const mp = materials.list[mi];
        if (mp && (mp.map || mp.normalMap || mp.emissiveMap || mp.metallicRoughnessMap || mp.occlusionMap)) count('texture');
        const open = built.solid.kind === 'plane' || built.solid.kind === 'surface' || built.solid.kind === 'lines'
          || built.solid.doubleSided || ((built.solid.kind === 'cylinder' || built.solid.kind === 'cone' || built.solid.kind === 'frustum') && built.solid.caps === false);
        return {
          kind: 'shape',
          matrix: built.unit ? composed(local, node.unit) : composed(local, null),
          meshMatrix: composed(local, node.unit),
          entry: node.geometry,
          solid: built.solid,
          material: mi,
          own,
          inherits,
          doubleSided: !!(open || node.geometry.doubleSided || (mp && mp.doubleSided)),
        };
      }
      const children = [];
      for (const c of node.children) {
        const t = walk(c, mat, col);
        if (t) children.push(t);
      }
      return group(local, children, own);
    };
    root = walk(graph.root, null, null) || { kind: 'group', matrix: null, children: [] };
    for (const [why, n] of reasonOf) {
      notes.push(`${n.toLocaleString('en-US')} ${why}${n === 1 ? '' : 's'} tessellated: the target has no primitive for ${n === 1 ? 'it' : 'them'}.`);
    }
    if (curves.count) notes.push(`${curves.count.toLocaleString('en-US')} curved outline${curves.count === 1 ? '' : 's'} flattened to polygons at this level of detail.`);
  }

  if (counts.get('lod')) notes.push(`${counts.get('lod').toLocaleString('en-US')} level-of-detail alternative${counts.get('lod') === 1 ? '' : 's'} omitted; the most detailed child is written.`);
  if (counts.get('animated')) notes.push(`${counts.get('animated').toLocaleString('en-US')} animated transform${counts.get('animated') === 1 ? '' : 's'} written at the rest pose.`);
  if (counts.get('hidden')) notes.push(`${counts.get('hidden').toLocaleString('en-US')} hidden element${counts.get('hidden') === 1 ? '' : 's'} omitted.`);
  if (counts.get('texture')) notes.push(`${counts.get('texture').toLocaleString('en-US')} material${counts.get('texture') === 1 ? '' : 's'} lost texture maps; the base colour is kept.`);

  const unit = (doc && doc.root && valueOf(doc.root, 'unit')) || 'm';
  const baked = new Map();
  return {
    structure: structure === 'flatten' ? 'flatten' : 'keep',
    lod: level,
    unit,
    root,
    materials: materials.list,
    resolve: (id, color) => materials.resolve(id, color),
    /** Triangles of a shape's geometry at this level, in the geometry's own space. */
    bakedMesh(entry) {
      if (!entry) return null;
      let hit = baked.get(entry);
      if (hit) return hit;
      const mesh = meshOf(entry, Math.min(level, entry.lods - 1));
      hit = {
        kind: mesh.kind === 'lines' ? 'lines' : 'mesh',
        key: `g${entry.id}`,
        positions: mesh.positions,
        normals: mesh.normals,
        indices: mesh.indices,
      };
      baked.set(entry, hit);
      return hit;
    },
    lights: scene.lights || [],
    cameras: scene.cameras || [],
    environment: graph.environment,
    notes,
    meshTriangles,
  };
}

/** step^0, step^1, … in the same order and with the same multiply as the flattener. */
export function repeatCopies(node) {
  const out = [];
  const acc = mat4.createF64();
  const tmp = mat4.createF64();
  for (let i = 0; i < node.count; i++) {
    out.push(new Float64Array(acc));
    mat4.multiply(tmp, acc, node.step);
    acc.set(tmp);
  }
  return out;
}

/**
 * One matrix per scatter copy, in flattener order. `material` is a material id
 * when the copy draws a random material, otherwise null. Paint the copy with
 * {@link paint} so a descendant that sets its own material keeps it.
 */
export function scatterCopies(node) {
  const p = node.params;
  const rand = mulberry32(p.seed);
  const lerp = (r, t) => r[0] + (r[1] - r[0]) * t;
  const nx = p.grid ? p.grid[0] : 0;
  const nz = p.grid ? p.grid[1] : 0;
  const pos = [0, 0, 0];
  const rot = [0, 0, 0];
  const scl = [1, 1, 1];
  const copies = [];
  for (let i = 0; i < p.count; i++) {
    const u0 = rand(), u1 = rand(), u2 = rand(), u3 = rand(), u4 = rand(), u5 = rand(), u6 = rand(), u7 = rand(), u8 = rand();
    pos[1] = 0;
    rot[0] = rot[1] = rot[2] = 0;
    scl[0] = scl[1] = scl[2] = 1;
    if (p.grid) {
      const ix = i % nx;
      const iz = Math.floor(i / nx);
      pos[0] = (ix - (nx - 1) / 2) * p.spacing[0] + (u0 - 0.5) * p.jitter * p.spacing[0];
      pos[2] = (iz - (nz - 1) / 2) * p.spacing[1] + (u1 - 0.5) * p.jitter * p.spacing[1];
    } else if (p.radius) {
      const r = p.radius * Math.sqrt(u0);
      const a = u1 * Math.PI * 2;
      pos[0] = r * es3dCos(a);
      pos[2] = r * es3dSin(a);
    } else {
      pos[0] = (u0 - 0.5) * p.area[0];
      pos[2] = (u1 - 0.5) * p.area[1];
    }
    if (p.randomRotation) {
      const rr = p.randomRotation.ranges;
      rot[0] = lerp(rr[0], u2);
      rot[1] = lerp(rr[1], u3);
      rot[2] = lerp(rr[2], u4);
    }
    if (p.randomScale) {
      const rs = p.randomScale.ranges;
      if (p.randomScale.uniform) scl[0] = scl[1] = scl[2] = lerp(rs[0], u5);
      else {
        scl[0] = lerp(rs[0], u5);
        scl[1] = lerp(rs[1], u6);
        scl[2] = lerp(rs[2], u7);
      }
    }
    const place = mat4.createF64();
    mat4.compose(place, pos, rot, scl);
    let material = null;
    if (p.randomMaterial && p.randomMaterial.length) {
      material = p.randomMaterial[Math.min(p.randomMaterial.length - 1, Math.floor(u8 * p.randomMaterial.length))];
    }
    copies.push({ matrix: place, material });
  }
  return copies;
}

/**
 * A copy of `node` whose materials are resolved as the flattener would,
 * starting from an inherited material id and colour. A node that sets its
 * own material or colour replaces what it inherits.
 * @param {(id: string|null, color: number[]|null) => number} resolve
 */
export function paint(node, inMat, inCol, resolve) {
  let mat = inMat;
  let col = inCol;
  const own = node.own || NO_STYLE;
  if (own.material != null) {
    mat = own.material;
    col = null;
  }
  if (own.color != null) col = own.color;
  if (node.kind === 'shape') return { ...node, material: resolve(mat, col) };
  if (!node.children) return node;
  return { ...node, children: node.children.map((c) => paint(c, mat, col, resolve)) };
}

/**
 * Closed triangle mesh of a straight extrusion of XY regions along Z.
 * Outer contours are counter-clockwise. The signed volume is positive.
 */
export function extrudeMesh(regions, depth, center) {
  const z0 = center ? -depth / 2 : 0;
  const z1 = z0 + depth;
  const positions = [];
  const normals = [];
  const indices = [];
  const pushV = (x, y, z, nx, ny, nz) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    return (positions.length / 3) - 1;
  };
  for (const region of regions) {
    const tri = triangulateRegion({
      outer: { points: Float64Array.from(region.outer), smooth: new Uint8Array(region.outer.length / 2) },
      holes: region.holes.map((h) => ({ points: Float64Array.from(h), smooth: new Uint8Array(h.length / 2) })),
    });
    if (!tri || !tri.indices || !tri.indices.length) continue;
    const baseTop = positions.length / 3;
    const pts = tri.positions;
    for (let i = 0; i < pts.length; i += 2) pushV(pts[i], pts[i + 1], z1, 0, 0, 1);
    for (let i = 0; i < tri.indices.length; i += 3) {
      indices.push(baseTop + tri.indices[i], baseTop + tri.indices[i + 1], baseTop + tri.indices[i + 2]);
    }
    const baseBot = positions.length / 3;
    for (let i = 0; i < pts.length; i += 2) pushV(pts[i], pts[i + 1], z0, 0, 0, -1);
    for (let i = 0; i < tri.indices.length; i += 3) {
      indices.push(baseBot + tri.indices[i], baseBot + tri.indices[i + 2], baseBot + tri.indices[i + 1]);
    }
    const wall = (loop) => {
      const n = loop.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = loop[i * 2], ay = loop[i * 2 + 1];
        const bx = loop[j * 2], by = loop[j * 2 + 1];
        const vx = bx - ax, vy = by - ay;
        const nl = Math.hypot(vy, vx) || 1;
        const nx = vy / nl, ny = -vx / nl;
        const a = pushV(ax, ay, z0, nx, ny, 0);
        const b = pushV(bx, by, z0, nx, ny, 0);
        const c = pushV(bx, by, z1, nx, ny, 0);
        const d = pushV(ax, ay, z1, nx, ny, 0);
        indices.push(a, b, c, a, c, d);
      }
    };
    wall(region.outer);
    for (const h of region.holes) wall(h);
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices) };
}

const NO_STYLE = { material: null, color: null };

function styleOf(node) {
  return {
    material: node.material != null ? node.material : null,
    color: node.color != null ? node.color : null,
  };
}

/**
 * Closed mesh of a frustum along Y, base radius at −height/2, top radius at
 * +height/2. `segments` is the number of sides. Positive signed volume.
 */
export function frustumMesh(radius, radiusTop, height, segments, caps) {
  const n = Math.max(3, segments | 0);
  const y0 = -height / 2;
  const y1 = height / 2;
  const positions = [];
  const normals = [];
  const indices = [];
  const pushV = (x, y, z, nx, ny, nz) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    return (positions.length / 3) - 1;
  };
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push(Math.cos(a), Math.sin(a));
  }
  const slope = radius - radiusTop;
  const nl = Math.hypot(height, slope) || 1;
  const side = [];
  for (let i = 0; i < n; i++) {
    const c = ring[i * 2], s = ring[i * 2 + 1];
    const nx = (c * height) / nl;
    const ny = slope / nl;
    const nz = (s * height) / nl;
    side.push(pushV(c * radius, y0, s * radius, nx, ny, nz));
    side.push(pushV(c * radiusTop, y1, s * radiusTop, nx, ny, nz));
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = side[i * 2], b = side[j * 2], c = side[j * 2 + 1], d = side[i * 2 + 1];
    indices.push(a, b, c, a, c, d);
  }
  if (caps && radius > 1e-8) {
    const hub = pushV(0, y0, 0, 0, -1, 0);
    const rim = [];
    for (let i = 0; i < n; i++) rim.push(pushV(ring[i * 2] * radius, y0, ring[i * 2 + 1] * radius, 0, -1, 0));
    for (let i = 0; i < n; i++) indices.push(hub, rim[(i + 1) % n], rim[i]);
  }
  if (caps && radiusTop > 1e-8) {
    const hub = pushV(0, y1, 0, 0, 1, 0);
    const rim = [];
    for (let i = 0; i < n; i++) rim.push(pushV(ring[i * 2] * radiusTop, y1, ring[i * 2 + 1] * radiusTop, 0, 1, 0));
    for (let i = 0; i < n; i++) indices.push(hub, rim[i], rim[(i + 1) % n]);
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices) };
}

/** Flat XY regions as one double-sided triangle mesh in the XY plane. */
export function surfaceMesh(regions) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (const region of regions) {
    const tri = triangulateRegion({
      outer: { points: Float64Array.from(region.outer), smooth: new Uint8Array(region.outer.length / 2) },
      holes: region.holes.map((h) => ({ points: Float64Array.from(h), smooth: new Uint8Array(h.length / 2) })),
    });
    if (!tri || !tri.indices) continue;
    const base = positions.length / 3;
    const pts = tri.positions;
    for (let i = 0; i < pts.length; i += 2) {
      positions.push(pts[i], pts[i + 1], 0);
      normals.push(0, 0, 1);
    }
    for (let i = 0; i < tri.indices.length; i++) indices.push(base + tri.indices[i]);
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices) };
}
