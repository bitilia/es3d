// The ES3D Modeller's data and its ES3D output. Points are typed as x, y, z;
// planes join three or more of them; paints (materials) colour the planes;
// every other ES3D element is an object (objects.js). This module has no
// DOM, so the tests run it in Node.
//
// The output uses ES3D as it is, nothing added to the format:
//
//   <material id="clay" color="#c8553d"/>
//   <group material="clay">
//     <polygon position="2,2,1.5" rotation="-56.309932,0,0" points="0,0 1.802776,0 …"/>
//   </group>
//
// A <polygon> is a flat face in its local XY plane. Each plane is written as
// one, placed with position (its first point) and rotation="pitch,yaw,0", so
// its local x axis stays level and its local z axis is the face's outward
// normal. Points that are not on one flat plane cannot be a polygon, so such
// a plane is split into triangles, each a plane of its own.

import { h, Document, walk } from '../format/ast.js';
import { serialize } from '../format/serializer.js';
import { parse } from '../format/parse.js';
import { validate } from '../format/validator.js';
import { ELEMENTS } from '../format/schema.js';
import { formatNumber } from '../format/value-format.js';
import { parseColor, colorToHex } from '../format/colors.js';
import { localMatrix } from '../transform/transform.js';
import * as mat4 from '../math/mat4.js';
import { sub, dot, cross, length, normalize, boundsOf, diagonal, centroid, newell, largestCross, planeAxes, isSimple, angleOrder, earClip, flatFrame, frameAttrs } from './geometry.js';
import { walkObjects, toElement, fromElement, anchorOf } from './objects.js';

/** Paints a new model starts with. Their ids become material ids. */
export const DEFAULT_PAINTS = [
  { id: 'chalk', color: '#e9e4d8' },
  { id: 'clay', color: '#c8553d' },
  { id: 'sand', color: '#e9c46a' },
  { id: 'leaf', color: '#6a994e' },
  { id: 'pine', color: '#2d6a4f' },
  { id: 'sea', color: '#2a9d8f' },
  { id: 'sky', color: '#8ecae6' },
  { id: 'slate', color: '#5c677d' },
  { id: 'bark', color: '#7f5539' },
  { id: 'coal', color: '#2b2d31' },
];

export function createModel() {
  return { title: 'Untitled model', points: [], planes: [], paints: DEFAULT_PAINTS.map((p) => ({ ...p })), objects: [], nextPoint: 1, nextPlane: 1, nextObject: 1 };
}

export const pointLabel = (id) => `P${id}`;
export const planeLabel = (id) => `Plane ${id}`;

// --- the model -----------------------------------------------------------------------

export const pointMap = (model) => new Map(model.points.map((p) => [p.id, p]));
const xyzOf = (p) => [p.x, p.y, p.z];

/** Diagonal of the bounding box of every point. */
export function modelExtent(model) {
  return diagonal(model.points.map(xyzOf));
}

/** Points closer than this to a plane through the others count as on it. */
const flatTolerance = (extent, size) => 1e-6 * Math.max(size, extent, 1e-6);

/** Decimals written for coordinates: errors stay below 10⁻⁷ of the model's size. */
export function decimalsFor(extent) {
  return Math.min(12, Math.max(0, Math.ceil(-Math.log10(Math.max(extent, 1e-9) * 1e-7))));
}

const invalid = (reason) => ({ kind: 'invalid', reason });

/**
 * How points (ids in outline order) make a plane:
 * - kind 'flat': one polygon; `ids` is put in order around the outline when
 *   the given order crossed itself (`reordered`)
 * - kind 'bent': not on one flat plane; `triangles` are the triangles it splits into
 * - kind 'invalid': `reason` says why not
 */
export function analysePlane(model, ids, ctx = null) {
  const map = (ctx && ctx.map) || pointMap(model);
  const extent = ctx ? ctx.extent : modelExtent(model);
  if (ids.length < 3) return invalid('A plane needs at least 3 points.');
  if (new Set(ids).size !== ids.length) return invalid('Each point can be used once in a plane.');
  const pts = ids.map((id) => map.get(id));
  if (pts.some((p) => !p)) return invalid('A point of this plane no longer exists.');
  const xyz = pts.map(xyzOf);
  const size = diagonal(xyz);
  const tol = flatTolerance(extent, size);
  for (let i = 0; i < xyz.length; i++) {
    for (let j = i + 1; j < xyz.length; j++) {
      if (length(sub(xyz[i], xyz[j])) <= tol) return invalid(`${pointLabel(ids[i])} and ${pointLabel(ids[j])} are at the same place.`);
    }
  }
  const tiny = 1e-9 * size * size;
  // Newell's normal fits a flat or gently bent outline; an outline picked in a
  // crossing order can cancel it, so the spoke normal is tried too
  const normals = [newell(xyz), largestCross(xyz)].filter((m) => length(m) > tiny).map(normalize);
  if (!normals.length) return invalid('These points are on one line, so they do not make a plane.');
  const c = centroid(xyz);
  const deviationAlong = (m) => xyz.reduce((d, p) => Math.max(d, Math.abs(dot(sub(p, c), m))), 0);
  const n = normals.reduce((best, m) => (deviationAlong(m) < deviationAlong(best) ? m : best));
  const deviation = deviationAlong(n);
  const [u, v] = planeAxes(n);
  const p2 = xyz.map((p) => {
    const d = sub(p, c);
    return [dot(d, u), dot(d, v)];
  });
  const eps = 1e-10 * size * size;
  if (!isSimple(p2, eps)) {
    // picked out of order: go round the outline instead, as if picked that way
    const again = ctx && ctx.retry ? null : analysePlane(model, angleOrder(p2).map((i) => ids[i]), { map, extent, retry: true });
    if (!again || again.kind === 'invalid') return invalid('The outline crosses itself in every order.');
    return { ...again, reordered: true };
  }
  if (deviation <= tol) return { kind: 'flat', ids, reordered: false, deviation };
  const triangles = earClip(p2, xyz, eps)
    .map((t) => t.map((k) => ids[k]))
    .filter((t) => length(cross(sub(xyzOf(map.get(t[1])), xyzOf(map.get(t[0]))), sub(xyzOf(map.get(t[2])), xyzOf(map.get(t[0]))))) > tiny);
  return { kind: 'bent', ids, reordered: false, deviation, triangles };
}

const context = (model) => ({ map: pointMap(model), extent: modelExtent(model) });
const setKey = (ids) => [...ids].sort((a, b) => a - b).join(',');

export function addPoint(model, [x, y, z]) {
  const p = { id: model.nextPoint++, x, y, z };
  model.points.push(p);
  return p;
}

/**
 * Join points (ids in outline order) into a plane with a paint. Points that
 * are not on one flat plane become triangles.
 * @returns {{planes: object[], split?: boolean, reordered?: boolean, deviation?: number, error?: string}}
 */
export function makePlane(model, ids, paint) {
  const a = analysePlane(model, ids);
  if (a.kind === 'invalid') return { planes: [], error: a.reason };
  const taken = new Map(model.planes.map((p) => [setKey(p.points), p.id]));
  const key = setKey(ids);
  if (taken.has(key)) return { planes: [], error: `These points already make ${planeLabel(taken.get(key))}.` };
  const outlines = a.kind === 'flat' ? [a.ids] : a.triangles.filter((t) => !taken.has(setKey(t)));
  if (!outlines.length) return { planes: [], error: 'The triangles these points split into already exist.' };
  const planes = outlines.map((points) => ({ id: model.nextPlane++, points, paint }));
  model.planes.push(...planes);
  return { planes, split: a.kind === 'bent', reordered: a.reordered, deviation: a.deviation };
}

export function deletePlanes(model, ids) {
  const del = new Set(ids);
  model.planes = model.planes.filter((p) => !del.has(p.id));
}

/**
 * After points moved: planes through them that are no longer flat are split
 * into triangles, and an outline that now crosses itself is put back in order.
 * A plane that has become a line stays in the list, marked, and is not drawn.
 * @param {Set<number>|null} touched point ids that changed (null: check every plane)
 * @returns {string[]} what changed, for the person
 */
export function repairPlanes(model, touched = null) {
  const ctx = context(model);
  const notes = [];
  const out = [];
  for (const plane of model.planes) {
    if (touched && !plane.points.some((id) => touched.has(id))) {
      out.push(plane);
      continue;
    }
    const a = analysePlane(model, plane.points, ctx);
    if (a.kind === 'bent') {
      const tris = a.triangles.map((points, k) => ({ id: k === 0 ? plane.id : model.nextPlane++, points, paint: plane.paint }));
      notes.push(`${planeLabel(plane.id)} was no longer flat, so it is now ${tris.length} triangles.`);
      out.push(...tris);
      continue;
    }
    if (a.kind === 'flat' && a.reordered) {
      plane.points = a.ids;
      notes.push(`${planeLabel(plane.id)}'s points were put back in order around its outline.`);
    }
    out.push(plane);
  }
  model.planes = out;
  return notes;
}

/** Remove points, and every plane left with fewer than 3. */
export function deletePoints(model, ids) {
  const del = new Set(ids);
  model.points = model.points.filter((p) => !del.has(p.id));
  const touched = new Set();
  let removed = 0;
  model.planes = model.planes.filter((plane) => {
    const kept = plane.points.filter((id) => !del.has(id));
    if (kept.length === plane.points.length) return true;
    plane.points = kept;
    for (const id of kept) touched.add(id);
    if (kept.length >= 3) return true;
    removed++;
    return false;
  });
  return { removedPlanes: removed, notes: repairPlanes(model, touched) };
}

// --- paints ------------------------------------------------------------------------

/** A valid, unused material id made from a name. */
export function paintId(model, name, except = null) {
  let base = String(name).trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_.:-]/g, '');
  if (!/^[A-Za-z]/.test(base)) base = 'paint' + base;
  let id = base;
  for (let k = 2; model.paints.some((p) => p.id === id && p.id !== except); k++) id = `${base}${k}`;
  return id;
}

export function addPaint(model, color) {
  let k = 1;
  while (model.paints.some((p) => p.id === `paint${k}`)) k++;
  const paint = { id: `paint${k}`, color };
  model.paints.push(paint);
  return paint;
}

/** Rename a paint (its material id); planes follow. Returns the id it got. */
export function renamePaint(model, id, name) {
  const paint = model.paints.find((p) => p.id === id);
  if (!paint) return id;
  const next = paintId(model, name, id);
  for (const plane of model.planes) if (plane.paint === id) plane.paint = next;
  paint.id = next;
  return next;
}

/** Remove a paint; its planes take the first remaining paint. */
export function removePaint(model, id) {
  if (model.paints.length < 2) return;
  model.paints = model.paints.filter((p) => p.id !== id);
  const fallback = model.paints[0].id;
  for (const plane of model.planes) if (plane.paint === id) plane.paint = fallback;
}

// --- faces -------------------------------------------------------------------------

/**
 * What each plane draws: a flat plane is one face, a bent one (a point being
 * dragged) its triangles, an invalid one nothing.
 * @returns {{plane: object, kind: string, reason?: string, faces: number[][]}[]}
 */
export function resolvePlanes(model) {
  const ctx = context(model);
  return model.planes.map((plane) => {
    const a = analysePlane(model, plane.points, ctx);
    if (a.kind === 'invalid') return { plane, kind: 'invalid', reason: a.reason, faces: [] };
    return { plane, kind: a.kind, faces: a.kind === 'flat' ? [a.ids] : a.triangles };
  });
}

/** World-space triangles of a flat face (for picking and occlusion). */
export function faceTriangles(xyz) {
  if (xyz.length === 3) return [xyz];
  const size = diagonal(xyz);
  let n = newell(xyz);
  if (length(n) <= 1e-9 * size * size) n = largestCross(xyz);
  const [u, v] = planeAxes(normalize(n));
  const p2 = xyz.map((p) => [dot(p, u), dot(p, v)]);
  return earClip(p2, xyz, 1e-10 * size * size).map((t) => t.map((i) => xyz[i]));
}

/** A face as <polygon> attributes, its local z axis turned away from `centre`. */
function polygonAttrs(xyz, centre, fmt) {
  const frame = flatFrame(xyz, centre);
  return { ...frameAttrs(frame, fmt), points: frame.local.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ') };
}

// --- ES3D output ---------------------------------------------------------------------

/** Colours of the editing aids drawn in the preview (never exported). */
export const PREVIEW_COLORS = {
  point: '#dfe7f1',
  selected: '#ffb74d',
  edge: '#262d37',
  edgeSelected: '#4fc3f7',
  pending: '#ffb74d',
  grid: '#2c3542',
  x: '#d9534f',
  y: '#5cb85c',
  z: '#428bca',
  light: '#ffd54f',
  camera: '#b0bec5',
};

/** A 1, 2 or 5 times a power of ten, at least v. */
function niceStep(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v - 1e-12) return m * p;
  return 10 * p;
}

/** Material ids the objects refer to. */
function referencedMaterials(objects) {
  const ids = new Set();
  walkObjects(objects, (n) => {
    if (n.attrs.material) ids.add(n.attrs.material.trim());
    if (n.attrs.randomMaterial) for (const id of n.attrs.randomMaterial.split(/[\s,]+/)) if (id) ids.add(id);
  });
  return ids;
}

/** Root elements written before the materials and planes. */
const FIRST = new Set(['desc', 'environment', 'controls', 'defs']);

/**
 * The model as an ES3D document: the title, the document-wide elements, the
 * materials, the planes as polygons grouped by paint, then the other
 * elements. With `view`, editing aids are added for the preview (point
 * markers, edges, the outline being picked, light and camera markers and a
 * ground grid) and <controls> is left out, so it cannot lock the editor's camera.
 * The document carries objectOf (element → object id) and planeOf (polygon → plane id).
 * @param {object} model
 * @param {{selectedPoints?: number[], selectedPlanes?: Iterable<number>, edges?: boolean, grid?: boolean, bounds?: {min: number[], max: number[]}}|null} [view]
 *   bounds: what the model draws, so the grid reaches past it
 */
export function buildDocument(model, view = null) {
  const map = pointMap(model);
  const extent = modelExtent(model);
  const digits = decimalsFor(extent);
  const fmt = (v) => formatNumber(v, digits);
  const resolved = resolvePlanes(model);
  const used = new Set();
  for (const r of resolved) for (const f of r.faces) for (const id of f) used.add(id);
  const usedXyz = [...used].map((id) => xyzOf(map.get(id)));
  const b = boundsOf(usedXyz);
  const centre = usedXyz.length ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2] : [0, 0, 0];
  const objectOf = new Map();
  const planeOf = new Map();

  const root = h('es3d', { version: '1' });
  if (model.title) root.appendChild(h('title', {}, String(model.title)));
  const roots = model.objects.filter((n) => !(view && n.name === 'controls'));
  for (const n of roots) if (FIRST.has(n.name)) root.appendChild(toElement(n, objectOf));

  const paints = new Map(model.paints.map((p) => [p.id, p]));
  const fallback = model.paints[0] || { id: 'paint', color: '#bfbfbf' };
  const groups = new Map();
  for (const r of resolved) {
    const paint = paints.get(r.plane.paint) || fallback;
    if (!r.faces.length) continue;
    if (!groups.has(paint)) groups.set(paint, []);
    for (const f of r.faces) groups.get(paint).push({ face: f, plane: r.plane.id });
  }
  const refs = referencedMaterials(model.objects);
  const materials = [...new Set([...model.paints, ...groups.keys()])].filter((p) => groups.has(p) || p.keep || refs.has(p.id));
  for (const paint of materials) root.appendChild(h('material', { id: paint.id, color: paint.color, ...(paint.attrs || {}) }));
  for (const paint of materials) {
    if (!groups.has(paint)) continue;
    const g = root.appendChild(h('group', { material: paint.id }));
    for (const { face, plane } of groups.get(paint)) {
      const el = g.appendChild(
        h(
          'polygon',
          polygonAttrs(
            face.map((id) => xyzOf(map.get(id))),
            centre,
            fmt,
          ),
        ),
      );
      planeOf.set(el, plane);
    }
  }
  for (const n of roots) if (!FIRST.has(n.name)) root.appendChild(toElement(n, objectOf));
  if (view) appendAids(root, model, view, resolved, fmt);
  const doc = new Document({ root, syntax: 'xml' });
  doc.objectOf = objectOf;
  doc.planeOf = planeOf;
  return doc;
}

function appendAids(root, model, view, resolved, fmt) {
  const C = PREVIEW_COLORS;
  const size = Math.max(1, modelExtent(model));
  const map = pointMap(model);
  const own = { _pt: C.point, _sel: C.selected, _edge: C.edge, _edgesel: C.edgeSelected, _pending: C.pending, _grid: C.grid, _x: C.x, _y: C.y, _z: C.z, _light: C.light, _camera: C.camera };
  for (const [id, color] of Object.entries(own)) root.appendChild(h('material', { id, color, unlit: 'true' }));
  const aids = root.appendChild(h('group', { name: 'editing aids', collide: 'false' }));
  const v3 = (p) => `${fmt(p[0])},${fmt(p[1])},${fmt(p[2])}`;
  const tube = (a, b, radius, material) => {
    if (length(sub(a, b)) <= 1e-9 * size) return;
    aids.appendChild(h('line', { from: v3(a), to: v3(b), radius: formatNumber(radius, 6), material }));
  };

  if (view.grid !== false) {
    let reach = 2;
    for (const p of model.points) reach = Math.max(reach, Math.abs(p.x) * 1.2, Math.abs(p.z) * 1.2);
    const b = view.bounds;
    if (b) for (const v of [b.min[0], b.max[0], b.min[2], b.max[2]]) reach = Math.max(reach, Math.abs(v) * 1.2);
    const step = niceStep(reach / 8);
    const half = Math.ceil(reach / step) * step;
    const count = Math.round((2 * half) / step) + 1;
    const g = formatNumber(-size * 0.002, 6);
    const a = formatNumber(-size * 0.001, 6);
    const s = formatNumber(step, 9);
    const hs = formatNumber(half, 9);
    const grid = aids.appendChild(h('group', { name: 'grid' }));
    grid.appendChild(h('repeat', { count, step: `translate(${s},0,0)` }, h('line', { from: `-${hs},${g},-${hs}`, to: `-${hs},${g},${hs}`, material: '_grid' })));
    grid.appendChild(h('repeat', { count, step: `translate(0,0,${s})` }, h('line', { from: `-${hs},${g},-${hs}`, to: `${hs},${g},-${hs}`, material: '_grid' })));
    grid.appendChild(h('line', { from: `-${hs},${a},0`, to: `${hs},${a},0`, material: '_x' }));
    grid.appendChild(h('line', { from: `0,${a},-${hs}`, to: `0,${a},${hs}`, material: '_z' }));
    grid.appendChild(h('line', { from: '0,0,0', to: `0,${formatNumber(half * 0.4, 9)},0`, material: '_y' }));
  }

  const selectedPlanes = new Set(view.selectedPlanes || []);
  const selectedPoints = new Set(view.selectedPoints || []);
  const edgeR = size * 0.0025;
  if (view.edges !== false) {
    const seen = new Set();
    for (const r of resolved) {
      for (const f of r.faces) {
        for (let i = 0; i < f.length; i++) {
          const a = f[i], b = f[(i + 1) % f.length];
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tube(xyzOf(map.get(a)), xyzOf(map.get(b)), edgeR, '_edge');
        }
      }
    }
  }
  for (const r of resolved) {
    if (!selectedPlanes.has(r.plane.id)) continue;
    for (const f of r.faces) for (let i = 0; i < f.length; i++) tube(xyzOf(map.get(f[i])), xyzOf(map.get(f[(i + 1) % f.length])), edgeR * 1.9, '_edgesel');
  }
  const chain = (view.selectedPoints || []).map((id) => map.get(id)).filter(Boolean).map(xyzOf);
  for (let i = 0; i + 1 < chain.length; i++) tube(chain[i], chain[i + 1], edgeR * 1.4, '_pending');
  if (chain.length >= 3) tube(chain[chain.length - 1], chain[0], edgeR * 1.4, '_pending');

  const r = formatNumber(size * 0.012, 6);
  for (const p of model.points) aids.appendChild(h('sphere', { radius: r, position: v3(xyzOf(p)), material: selectedPoints.has(p.id) ? '_sel' : '_pt' }));
  // lights and cameras have no surface of their own: a marker shows where they are
  walkObjects(model.objects, (n) => {
    if (n.name !== 'light' && n.name !== 'camera') return;
    if (n.name === 'light' && !/^(point|spot)$/.test((n.attrs.type || '').trim())) return;
    const at = anchorOf(model, n.oid);
    if (!at) return;
    const m = formatNumber(size * 0.03, 6);
    if (n.name === 'light') aids.appendChild(h('sphere', { radius: m, segments: '8', position: v3(at.world), material: '_light' }));
    else aids.appendChild(h('box', { size: m, position: v3(at.world), material: '_camera' }));
  });
}

/**
 * The model as ES3D text.
 * @param {object} model
 * @param {{syntax?: 'xml'|'compact', pretty?: boolean}} [opts]
 */
export function toES3D(model, opts = {}) {
  return serialize(buildDocument(model), { syntax: opts.syntax || 'xml', pretty: opts.pretty !== false });
}

/** The preview document (the model plus editing aids) as markup, and the document it came from. */
export function previewES3D(model, view = {}) {
  return serialize(buildDocument(model, view), { syntax: 'xml', pretty: false });
}

/**
 * What the validator says about the model's ES3D, per object.
 * @returns {{diagnostics: object[], byObject: Map<number, object[]>, errors: number, warnings: number}}
 */
export function checkModel(model) {
  const doc = validate(buildDocument(model));
  const oidOf = new Map();
  for (const [el, oid] of doc.objectOf) oidOf.set(el.uid, oid);
  const byObject = new Map();
  let errors = 0;
  let warnings = 0;
  for (const d of doc.diagnostics) {
    if (d.severity === 'error') errors++;
    else if (d.severity === 'warning') warnings++;
    const oid = oidOf.get(d.uid);
    if (oid === undefined) continue;
    if (!byObject.has(oid)) byObject.set(oid, []);
    byObject.get(oid).push(d);
  }
  return { diagnostics: doc.diagnostics, byObject, errors, warnings };
}

// --- ES3D input ----------------------------------------------------------------------

/**
 * Read an ES3D document (any syntax) back into a model. Every element is
 * kept. Polygons that sit directly in groups (not in a repeat, scatter, lod,
 * defs or use, not animated, hidden or referenced by id) become planes,
 * placed in the world; the corners they share become one point. Materials
 * become paints.
 * @returns {{model: object, planes: number, objects: number}}
 */
export function fromES3D(text) {
  const doc = parse(text);
  if (!doc.ok) {
    const first = doc.errors[0];
    throw new Error(`The file has ${doc.errors.length} error${doc.errors.length > 1 ? 's' : ''}: ${first.format ? first.format(doc.lineIndex) : first.message}`);
  }
  const model = createModel();
  model.paints = [];
  const titleEl = doc.root.children.find((c) => c.type === 'element' && c.name === 'title');
  model.title = titleEl && titleEl.text ? titleEl.text.trim() : '';

  // materials become paints; ids starting with '_' are the preview's own, so they are renamed
  const renamed = new Map();
  walk(doc.root, (el) => {
    if (el.name !== 'material' || !el.values || !el.values.id) return;
    const attrs = fromElement(el).attrs;
    delete attrs.id;
    delete attrs.color;
    let id = el.values.id;
    if (id.startsWith('_')) {
      id = paintId(model, `m${id}`);
      renamed.set(el.values.id, id);
    }
    model.paints.push({ id, color: el.values.color ? colorToHex(el.values.color) : '#cccccc', attrs, keep: true });
  });
  const rename = (id) => renamed.get(id) || id;

  const faces = [];
  const skipMaterial = (c) => c.name === 'material';
  const visit = (el, world, material, color, out) => {
    for (const c of el.children) {
      if (c.type !== 'element' || c.name === 'material') continue;
      if (c.name === 'title' && el === doc.root) continue;
      const v = c.values || {};
      const kids = c.children.filter((k) => k.type === 'element');
      if (v.visible !== false && c.name === 'polygon' && v.id === undefined && !kids.length) {
        const m = mat4.multiply(mat4.createF64(), world, localMatrix(v));
        const pts = [];
        for (let i = 0; i + 1 < v.points.length; i += 2) pts.push(mat4.transformPoint([0, 0, 0], m, v.points[i], v.points[i + 1], 0));
        faces.push({ pts, material: v.material ? v.material : material, color: v.material ? (v.color ? colorToHex(v.color) : null) : v.color ? colorToHex(v.color) : color });
        continue;
      }
      if (v.visible !== false && (c.name === 'group' || c.name === 'scene') && !kids.some((k) => k.name === 'animate')) {
        const node = fromElement(c, () => true);
        const before = faces.length;
        const mat = v.material ? v.material : material;
        const col = v.material ? (v.color ? colorToHex(v.color) : null) : v.color ? colorToHex(v.color) : color;
        visit(c, mat4.multiply(mat4.createF64(), world, localMatrix(v)), mat, col, node.children);
        // a group that only held polygons is gone with them
        if (!(faces.length > before && !node.children.length && v.id === undefined)) out.push(node);
        continue;
      }
      out.push(fromElement(c, skipMaterial));
    }
  };
  visit(doc.root, mat4.createF64(), null, null, model.objects);
  model.nextObject = 1;
  walkObjects(model.objects, (n) => {
    n.oid = model.nextObject++;
    if (n.attrs.material) n.attrs.material = rename(n.attrs.material.trim());
    if (n.attrs.randomMaterial) n.attrs.randomMaterial = n.attrs.randomMaterial.split(/[\s,]+/).filter(Boolean).map(rename).join(' ');
  });

  const all = faces.flatMap((f) => f.pts);
  const digits = decimalsFor(diagonal(all));
  const snap = (v) => Number(formatNumber(v, digits));
  const ids = new Map();
  const pointId = (p) => {
    const q = p.map(snap);
    const key = q.join(',');
    if (!ids.has(key)) ids.set(key, addPoint(model, q).id);
    return ids.get(key);
  };
  const colourPaints = new Map();
  const paintFor = (f) => {
    if (f.color) {
      if (!colourPaints.has(f.color)) {
        const id = paintId(model, `c${f.color.slice(1)}`);
        model.paints.push({ id, color: f.color });
        colourPaints.set(f.color, id);
      }
      return colourPaints.get(f.color);
    }
    if (f.material) return rename(f.material);
    if (!model.paints.some((p) => p.id === 'grey')) model.paints.push({ id: 'grey', color: '#cccccc' });
    return 'grey';
  };
  for (const f of faces) {
    const outline = [];
    for (const p of f.pts) {
      const id = pointId(p);
      if (outline[outline.length - 1] !== id && outline[0] !== id) outline.push(id);
    }
    // a polygon without area stays a polygon
    if (outline.length < 3) {
      model.objects.push({ oid: model.nextObject++, name: 'polygon', attrs: {}, children: [], text: null });
      continue;
    }
    model.planes.push({ id: model.nextPlane++, points: outline, paint: paintFor(f) });
  }
  for (const p of DEFAULT_PAINTS) if (!model.paints.some((q) => q.id === p.id)) model.paints.push({ ...p });
  let objects = 0;
  walkObjects(model.objects, () => objects++);
  return { model, planes: model.planes.length, objects };
}

// --- point lists ---------------------------------------------------------------------

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/**
 * Points from pasted text: x, y, z per line (commas, spaces, tabs or
 * semicolons; brackets and labels such as "P1:" are ignored). A line may hold
 * several points. Lines without numbers (headers) are skipped.
 * @returns {{points: number[][], errors: {line: number, text: string}[]}}
 */
export function parsePointList(text) {
  const points = [];
  const errors = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      const nums = line
        .split(/[\s,;:=()[\]{}]+/)
        .filter((t) => NUMBER.test(t))
        .map(Number);
      if (!nums.length) return;
      if (nums.length % 3) errors.push({ line: i + 1, text: line.trim() });
      else for (let k = 0; k < nums.length; k += 3) points.push(nums.slice(k, k + 3));
    });
  return { points, errors };
}

// --- saving the editor's state ---------------------------------------------------------

const ID_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const MATERIAL_ATTRS = Object.keys(ELEMENTS.material.attrs).filter((k) => k !== 'id' && k !== 'color');

function restoreObject(n) {
  if (!n || typeof n.name !== 'string' || !ELEMENTS[n.name] || !n.attrs || typeof n.attrs !== 'object' || !Array.isArray(n.children)) return null;
  const attrs = {};
  for (const [k, v] of Object.entries(n.attrs)) if (typeof v === 'string') attrs[k] = v;
  return { oid: 0, name: n.name, attrs, children: n.children.map(restoreObject).filter(Boolean), text: typeof n.text === 'string' ? n.text : null };
}

/** A model from saved JSON (autosave), or null when it does not look like one. */
export function restoreModel(data) {
  if (!data || !Array.isArray(data.points) || !Array.isArray(data.planes) || !Array.isArray(data.paints)) return null;
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const points = data.points.filter((p) => p && Number.isInteger(p.id) && num(p.x) && num(p.y) && num(p.z)).map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z }));
  const paints = data.paints
    .filter((p) => p && typeof p.id === 'string' && ID_RE.test(p.id) && parseColor(String(p.color)))
    .map((p) => {
      const paint = { id: p.id, color: colorToHex(parseColor(p.color)) };
      if (p.attrs && typeof p.attrs === 'object') {
        const attrs = {};
        for (const k of MATERIAL_ATTRS) if (typeof p.attrs[k] === 'string') attrs[k] = p.attrs[k];
        if (Object.keys(attrs).length) paint.attrs = attrs;
      }
      if (p.keep === true) paint.keep = true;
      return paint;
    });
  if (!paints.length) paints.push(...DEFAULT_PAINTS.map((p) => ({ ...p })));
  const known = new Set(points.map((p) => p.id));
  const planes = data.planes
    .filter((p) => p && Number.isInteger(p.id) && Array.isArray(p.points) && p.points.every((id) => known.has(id)) && p.points.length >= 3)
    .map((p) => ({ id: p.id, points: p.points.slice(), paint: paints.some((q) => q.id === p.paint) ? p.paint : paints[0].id }));
  const objects = Array.isArray(data.objects) ? data.objects.map(restoreObject).filter(Boolean) : [];
  let nextObject = 1;
  walkObjects(objects, (n) => (n.oid = nextObject++));
  const max = (list) => list.reduce((m, p) => Math.max(m, p.id), 0);
  return {
    title: typeof data.title === 'string' ? data.title : '',
    points,
    planes,
    paints,
    objects,
    nextPoint: Math.max(Number.isInteger(data.nextPoint) ? data.nextPoint : 1, max(points) + 1),
    nextPlane: Math.max(Number.isInteger(data.nextPlane) ? data.nextPlane : 1, max(planes) + 1),
    nextObject,
  };
}

// --- an example ------------------------------------------------------------------------

/** A small house: walls, gables, a pitched roof and a floor. */
export function exampleHouse() {
  const model = createModel();
  model.title = 'Little house';
  const P = [
    [-2, 0, -1.5], [2, 0, -1.5], [2, 0, 1.5], [-2, 0, 1.5],
    [-2, 2, -1.5], [2, 2, -1.5], [2, 2, 1.5], [-2, 2, 1.5],
    [-2, 3, 0], [2, 3, 0],
  ];
  for (const p of P) addPoint(model, p);
  const planes = [
    [[4, 3, 7, 8], 'chalk'],
    [[2, 1, 5, 6], 'chalk'],
    [[1, 4, 8, 9, 5], 'chalk'],
    [[3, 2, 6, 10, 7], 'chalk'],
    [[8, 7, 10, 9], 'clay'],
    [[6, 5, 9, 10], 'clay'],
    [[1, 2, 3, 4], 'slate'],
  ];
  for (const [ids, paint] of planes) makePlane(model, ids, paint);
  return model;
}
