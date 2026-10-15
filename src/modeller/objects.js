// Every ES3D element the modeller holds besides its planes. An object is the
// element's name, its attributes as written (canonical names, raw text), its
// children and its text: the same tree a reader parses, so a file read in is
// written out with nothing lost.
//
// A new element is placed once from the points picked for it: a sphere on a
// point, a cylinder between two, an extrusion from a flat outline. After that
// it is an ordinary element, edited in the inspector; moving a point later
// does not move it.

import { ELEMENTS, SHAPES, elementSpec } from '../format/schema.js';
import { parseTyped } from '../format/values.js';
import { h } from '../format/ast.js';
import { formatNumber } from '../format/value-format.js';
import { localMatrix } from '../transform/transform.js';
import * as mat4 from '../math/mat4.js';
import { sub, dot, length, normalize, diagonal, boundsOf, centroid, newell, largestCross, flatFrame, frameAttrs } from './geometry.js';

const DEG = 180 / Math.PI;

/** The Add menu: every element, grouped, with what the picked points do. */
export const CATALOGUE = [
  {
    group: 'Shapes',
    items: [
      ['box', 'Box', 'spans the picked points'],
      ['sphere', 'Sphere', 'centred on the 1st point; a 2nd sets the radius'],
      ['cylinder', 'Cylinder', 'from the 1st point to the 2nd'],
      ['cone', 'Cone', 'base on the 1st point, tip on the 2nd'],
      ['capsule', 'Capsule', 'from the 1st point to the 2nd'],
      ['plane', 'Rectangle', 'spans the picked points in x and z'],
      ['torus', 'Torus', 'centred on the 1st point; a 2nd sets the radius'],
      ['line', 'Line', 'from the 1st point to the 2nd'],
      ['polyline', 'Polyline', 'through the picked points'],
      ['polygon', 'Polygon', 'a plane through the picked points'],
      ['path', 'Path', 'the flat outline of the picked points'],
      ['extrude', 'Extrude', 'the flat outline of the picked points, pushed out'],
      ['revolve', 'Revolve', 'the picked points turned around the upright line through the 1st'],
      ['sweep', 'Sweep', 'a tube through the picked points'],
      ['gear', 'Gear', 'centred on the 1st point'],
      ['mesh', 'Mesh', 'triangles fanned from the 1st point'],
    ],
  },
  {
    group: 'Structure',
    items: [
      ['group', 'Group', 'at the 1st point'],
      ['repeat', 'Repeat', 'copies what you put in it; a 2nd point sets the step'],
      ['scatter', 'Scatter', 'scatters what you put in it around the 1st point'],
      ['lod', 'Level of detail', 'a near and a far version, at the 1st point'],
      ['defs', 'Defs', 'holds elements to reuse with Use'],
      ['use', 'Use', 'a copy of a definition, at the 1st point'],
    ],
  },
  {
    group: 'Scene',
    items: [
      ['light', 'Light', 'at the 1st point; a 2nd makes it a spot aimed there'],
      ['camera', 'Camera', 'at the 1st point, looking at the 2nd'],
      ['environment', 'Environment', 'background and ambient light'],
      ['controls', 'Controls', 'how viewers may move the camera'],
      ['desc', 'Description', 'text about the model'],
    ],
  },
  { group: 'Animation', items: [['animate', 'Animate', 'moves the selected element; a picked point is where it goes']] },
].map((g) => ({ group: g.group, items: g.items.map(([name, label, uses]) => ({ name, label, uses })) }));

/** Root elements a document holds once. */
export const ONCE = new Set(['defs', 'environment', 'controls', 'scene']);

/** Elements that may hold `child`, by the schema. */
export function accepts(container, child) {
  const kids = ELEMENTS[container] && ELEMENTS[container].children;
  return Array.isArray(kids) && kids.includes(child);
}

export const isShape = (name) => SHAPES.includes(name);

class PlaceError extends Error {}
const fail = (message) => {
  throw new PlaceError(message);
};

const nice = (v) => Number(v.toPrecision(2));

/** rotation that turns local +Y towards d (pitch about X, then yaw about Y). */
function alignY(d) {
  const n = normalize(d);
  const pitch = Number(formatNumber(Math.acos(Math.max(-1, Math.min(1, n[1]))) * DEG, 6));
  const yaw = Math.hypot(n[0], n[2]) < 1e-12 ? 0 : Number(formatNumber(Math.atan2(n[0], n[2]) * DEG, 6));
  return pitch || yaw ? `${formatNumber(pitch)},${formatNumber(yaw)},0` : undefined;
}

function flatOutline(pts, what) {
  if (pts.length < 3) fail(`${what} needs 3 or more points on one flat plane (or none, for a square).`);
  const size = diagonal(pts);
  let n = newell(pts);
  if (length(n) <= 1e-9 * size * size) n = largestCross(pts);
  if (length(n) <= 1e-9 * size * size) fail(`The points for ${what.toLowerCase()} are on one line.`);
  n = normalize(n);
  const c = centroid(pts);
  if (pts.some((p) => Math.abs(dot(sub(p, c), n)) > 1e-6 * size)) fail(`${what} needs points on one flat plane.`);
  return { frame: flatFrame(pts, null), size };
}

const SQUARE = 'M-0.5,-0.5 L0.5,-0.5 L0.5,0.5 L-0.5,0.5 Z';

/**
 * Attributes (and children or text) of a new element placed from points,
 * which are in the frame of the element it goes into.
 * Throws PlaceError when the points do not fit the element.
 */
const PLACE = {
  box(pts, c) {
    if (pts.length === 1) return { attrs: { position: c.v3(pts[0]) } };
    if (!pts.length) return {};
    const b = boundsOf(pts);
    const size = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
    const big = Math.max(...size);
    if (big <= 0) fail('The picked points are all at one place.');
    let note = null;
    for (let k = 0; k < 3; k++) {
      if (size[k] <= 1e-9 * big) {
        size[k] = nice(big * 0.1);
        note = 'The points are flat, so the box got a thickness of a tenth of its size.';
      }
    }
    return { attrs: { position: c.v3([0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2)), size: size.map(c.fmt).join(',') }, note };
  },
  sphere(pts, c) {
    if (!pts.length) return {};
    const attrs = { position: c.v3(pts[0]) };
    if (pts.length > 1) {
      const r = length(sub(pts[1], pts[0]));
      if (r <= 0) fail('The 2nd point is at the centre, so it gives no radius.');
      attrs.radius = c.fmt(r);
    }
    return { attrs };
  },
  cylinder: (pts, c) => axisShape(pts, c),
  cone: (pts, c) => axisShape(pts, c),
  capsule(pts, c) {
    const r = axisShape(pts, c);
    const height = r.attrs && Number(r.attrs.height);
    if (height && height < 0.5) r.attrs.radius = c.fmt(height / 4);
    return r;
  },
  plane(pts, c) {
    if (pts.length === 1) return { attrs: { position: c.v3(pts[0]) } };
    if (!pts.length) return {};
    const b = boundsOf(pts);
    const dx = b.max[0] - b.min[0];
    const dz = b.max[2] - b.min[2];
    if (dx <= 0 || dz <= 0) fail('A rectangle lies in x and z: pick points that spread in both.');
    const y = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return { attrs: { position: c.v3([(b.min[0] + b.max[0]) / 2, y, (b.min[2] + b.max[2]) / 2]), size: `${c.fmt(dx)},${c.fmt(dz)}` } };
  },
  torus(pts, c) {
    if (!pts.length) return {};
    const attrs = { position: c.v3(pts[0]) };
    if (pts.length > 1) {
      const r = length(sub(pts[1], pts[0]));
      if (r <= 0) fail('The 2nd point is at the centre, so it gives no radius.');
      attrs.radius = c.fmt(r);
      attrs.tube = c.fmt(nice(r * 0.3));
    }
    return { attrs };
  },
  line(pts, c) {
    if (!pts.length) return { attrs: { from: '0,0,0', to: '1,0,0' } };
    const to = pts[1] || [pts[0][0] + 1, pts[0][1], pts[0][2]];
    if (length(sub(to, pts[0])) <= 0) fail('A line needs two different points.');
    return { attrs: { from: c.v3(pts[0]), to: c.v3(to) } };
  },
  polyline(pts, c) {
    if (!pts.length) return { attrs: { points: '0,0,0 1,0,0 1,1,0' } };
    if (pts.length < 2) fail('A polyline needs 2 or more points.');
    return { attrs: { points: pts.map(c.v3).join(' ') } };
  },
  path(pts, c) {
    if (!pts.length) return { attrs: { d: SQUARE } };
    const { frame } = flatOutline(pts, 'A path');
    return { attrs: { ...frameAttrs(frame, c.fmt), d: pathData(frame.local, c.fmt) } };
  },
  extrude(pts, c) {
    if (!pts.length) return { attrs: { d: SQUARE, depth: '0.3' } };
    const { frame, size } = flatOutline(pts, 'Extrude');
    return {
      attrs: { ...frameAttrs(frame, c.fmt), d: pathData(frame.local, c.fmt), depth: c.fmt(nice(size * 0.2)) },
      note: 'Extruded towards the side the points go round anticlockwise; pick them the other way round to push the other way.',
    };
  },
  revolve(pts, c) {
    if (!pts.length) return { attrs: { d: 'M0,0 L0.35,0 L0.5,0.4 L0.25,0.9 L0.3,1' } };
    if (pts.length < 2) fail('Revolve needs 2 or more points: the 1st is on the axis.');
    const a = pts[0];
    const profile = pts.map((p) => [Math.hypot(p[0] - a[0], p[2] - a[2]), p[1] - a[1]]);
    if (profile.every(([r]) => r <= 1e-9)) fail('All the points are on the upright line through the 1st, so there is nothing to turn.');
    return { attrs: { position: c.v3(a), d: pathData(profile, c.fmt, false) } };
  },
  sweep(pts, c) {
    if (!pts.length) return { attrs: { along: '0,0,0 0,1,0 1,2,0', radius: '0.1', smooth: 'true' } };
    if (pts.length < 2) fail('A sweep needs 2 or more points to follow.');
    let run = 0;
    for (let i = 1; i < pts.length; i++) run += length(sub(pts[i], pts[i - 1]));
    if (run <= 0) fail('The points are all at one place.');
    return { attrs: { along: pts.map(c.v3).join(' '), radius: c.fmt(nice(run * 0.03)) } };
  },
  gear: (pts, c) => (pts.length ? { attrs: { position: c.v3(pts[0]) } } : {}),
  mesh(pts, c) {
    if (!pts.length) return { attrs: { positions: '0 0 0 1 0 0 0 1 0', smooth: '0' } };
    if (pts.length < 3) fail('A mesh needs 3 or more points.');
    const indices = [];
    for (let i = 1; i + 1 < pts.length; i++) indices.push(0, i, i + 1);
    return { attrs: { positions: pts.map((p) => p.map(c.fmt).join(' ')).join(' '), indices: indices.join(' '), smooth: '0' } };
  },
  group: (pts, c) => (pts.length ? { attrs: { position: c.v3(pts[0]) } } : {}),
  repeat(pts, c) {
    const attrs = { count: '3', step: 'translate(1.5,0,0)' };
    if (pts.length) attrs.position = c.v3(pts[0]);
    if (pts.length > 1) {
      const d = sub(pts[1], pts[0]);
      if (length(d) > 0) attrs.step = `translate(${d.map(c.fmt).join(',')})`;
    }
    return { attrs, note: 'Put shapes in the repeat (select it, then add) to copy them.' };
  },
  scatter(pts, c) {
    const attrs = { count: '20', radius: '5', seed: '1' };
    if (pts.length) attrs.position = c.v3(pts[0]);
    if (pts.length > 1) {
      const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][2] - pts[0][2]);
      if (r > 0) attrs.radius = c.fmt(r);
    }
    return { attrs, note: 'Put shapes in the scatter (select it, then add) to scatter them.' };
  },
  lod(pts, c) {
    const attrs = { distances: '15' };
    if (pts.length) attrs.position = c.v3(pts[0]);
    const near = { name: 'sphere', attrs: { segments: '32' }, children: [], text: null };
    const far = { name: 'sphere', attrs: { segments: '6' }, children: [], text: null };
    if (c.paint) near.attrs.material = far.attrs.material = c.paint;
    return { attrs, children: [near, far], note: 'Closer than 15 the first child shows, farther the second.' };
  },
  defs: () => ({ note: 'Put elements with an id in Defs, then add Use to place copies of them.' }),
  use(pts, c) {
    if (!c.defsIds.length) fail('Use copies an element in Defs: add Defs, put a shape in it and give the shape an id.');
    const attrs = { ref: c.defsIds[0] };
    if (pts.length) attrs.position = c.v3(pts[0]);
    return { attrs };
  },
  light(pts, c) {
    if (!pts.length) return { attrs: { type: 'directional', direction: '-1,-2,-1.5' } };
    if (pts.length === 1) return { attrs: { type: 'point', position: c.v3(pts[0]) } };
    if (length(sub(pts[1], pts[0])) <= 0) fail('A spot light needs its aim point away from it.');
    return { attrs: { type: 'spot', position: c.v3(pts[0]), target: c.v3(pts[1]) } };
  },
  camera(pts, c) {
    if (!pts.length) return { attrs: { position: '6,4,8', target: '0,0,0' } };
    const target = pts[1] || [0, 0, 0];
    if (length(sub(target, pts[0])) <= 0) fail('A camera cannot look at the point it stands on.');
    return { attrs: { position: c.v3(pts[0]), target: c.v3(target) } };
  },
  environment: () => ({}),
  controls: () => ({ attrs: { mode: 'orbit' } }),
  desc: () => ({ text: 'About this model.' }),
  animate(pts, c) {
    if (pts.length) return { attrs: { attr: 'position', to: c.v3(pts[0]), dur: '2s', alternate: 'true' } };
    return { attrs: { attr: 'rotation', to: '0,360,0', dur: '4s' } };
  },
};

function axisShape(pts, c) {
  if (!pts.length) return {};
  if (pts.length === 1) return { attrs: { position: c.v3([pts[0][0], pts[0][1] + 0.5, pts[0][2]]) } };
  const d = sub(pts[1], pts[0]);
  const height = length(d);
  if (height <= 0) fail('The two points are at one place.');
  const attrs = { position: c.v3([0, 1, 2].map((k) => (pts[0][k] + pts[1][k]) / 2)), height: c.fmt(height) };
  const rotation = alignY(d);
  if (rotation) attrs.rotation = rotation;
  return { attrs };
}

function pathData(pts, fmt, close = true) {
  const p = (q) => `${fmt(q[0])},${fmt(q[1])}`;
  return `M${p(pts[0])} ${pts.slice(1).map((q) => `L${p(q)}`).join(' ')}${close ? ' Z' : ''}`;
}

/**
 * A new element of kind `name`, placed from points given in the frame of the
 * element it goes into.
 * @param {string} name
 * @param {{points?: number[][], fmt: (v:number)=>string, paint?: string|null, defsIds?: string[]}} ctx
 * @returns {{node: object, note: string|null}|{error: string}}
 */
export function placeElement(name, ctx) {
  const place = PLACE[name];
  if (!place) return { error: `<${name}> is not added this way.` };
  const c = { fmt: ctx.fmt, v3: (p) => p.map(ctx.fmt).join(','), paint: ctx.paint || null, defsIds: ctx.defsIds || [] };
  try {
    const r = place(ctx.points || [], c);
    const attrs = { ...(r.attrs || {}) };
    if (isShape(name) && c.paint) attrs.material = c.paint;
    return { node: { name, attrs, children: r.children || [], text: r.text ?? null }, note: r.note || null };
  } catch (err) {
    if (err instanceof PlaceError) return { error: err.message };
    throw err;
  }
}

// --- the tree ------------------------------------------------------------------------

/** Depth-first visit; fn(node, parent, list). */
export function walkObjects(list, fn, parent = null) {
  for (const node of list) {
    fn(node, parent, list);
    walkObjects(node.children, fn, node);
  }
}

/** {node, parent, list, index} of the object with this oid, or null. */
export function findObject(list, oid, parent = null) {
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    if (node.oid === oid) return { node, parent, list, index: i };
    const inner = findObject(node.children, oid, node);
    if (inner) return inner;
  }
  return null;
}

/** Ancestors of an object, outermost first. */
export function ancestorsOf(list, oid) {
  const path = [];
  const visit = (nodes) => {
    for (const node of nodes) {
      if (node.oid === oid) return true;
      path.push(node);
      if (visit(node.children)) return true;
      path.pop();
    }
    return false;
  };
  return visit(list) ? path : [];
}

function numberTree(model, node) {
  node.oid = model.nextObject++;
  for (const c of node.children) numberTree(model, c);
  return node;
}

/** Insert a node (and its children) into the object with oid `into`, or at the root. */
export function insertObject(model, node, into = null, at = -1) {
  numberTree(model, node);
  const list = into === null ? model.objects : findObject(model.objects, into).node.children;
  if (at < 0 || at > list.length) list.push(node);
  else list.splice(at, 0, node);
  return node;
}

export function removeObject(model, oid) {
  const f = findObject(model.objects, oid);
  if (f) f.list.splice(f.index, 1);
  return !!f;
}

/** A copy placed right after the original; ids are left out so they stay unique. */
export function duplicateObject(model, oid) {
  const f = findObject(model.objects, oid);
  if (!f) return null;
  const copy = (n) => {
    const attrs = { ...n.attrs };
    delete attrs.id;
    return { name: n.name, attrs, children: n.children.map(copy), text: n.text };
  };
  const node = numberTree(model, copy(f.node));
  f.list.splice(f.index + 1, 0, node);
  return node;
}

/** Move an object among its siblings. */
export function moveObject(model, oid, delta) {
  const f = findObject(model.objects, oid);
  if (!f) return;
  const to = Math.max(0, Math.min(f.list.length - 1, f.index + delta));
  f.list.splice(f.index, 1);
  f.list.splice(to, 0, f.node);
}

// --- placement in the world ---------------------------------------------------------

function typed(name, attr, raw) {
  const spec = elementSpec(name) && elementSpec(name).attrs[attr];
  if (!spec || raw === undefined) return undefined;
  try {
    return parseTyped(spec, raw);
  } catch {
    return undefined;
  }
}

/** Local matrix of an object from its attributes (attributes that do not parse count as absent). */
export function localOf(node) {
  if (node.name === 'defs') return mat4.createF64();
  const values = {};
  for (const k of ['transform', 'position', 'rotation', 'scale']) {
    const v = typed(node.name, k, node.attrs[k]);
    if (v !== undefined) values[k] = v;
  }
  return localMatrix(values);
}

/** World matrix of the frame an object's children live in (its own matrix included when `self`). */
export function worldOf(model, oid, self = true) {
  const m = mat4.createF64();
  const chain = ancestorsOf(model.objects, oid);
  if (self) {
    const f = findObject(model.objects, oid);
    if (f) chain.push(f.node);
  }
  for (const node of chain) mat4.multiply(m, m, localOf(node));
  return m;
}

/** World point → the frame of the object with oid `into` (null: the world). */
export function toFrame(model, into, p) {
  if (into === null) return p.slice();
  const inv = mat4.invert(mat4.createF64(), worldOf(model, into));
  if (!inv) return p.slice();
  return mat4.transformPoint([0, 0, 0], inv, p[0], p[1], p[2]);
}

/**
 * Where an object's position attribute puts it in the world, and the matrix
 * that turns a world point into a value for that attribute. Null for
 * elements without a position.
 */
export function anchorOf(model, oid) {
  const f = findObject(model.objects, oid);
  if (!f || !elementSpec(f.node.name) || !elementSpec(f.node.name).attrs.position) return null;
  const outer = f.parent ? worldOf(model, f.parent.oid) : mat4.createF64();
  const tr = typed(f.node.name, 'transform', f.node.attrs.transform);
  const base = tr && tr.ops && tr.ops.length ? mat4.multiply(mat4.createF64(), outer, tr.matrix) : outer;
  const position = typed(f.node.name, 'position', f.node.attrs.position) || elementSpec(f.node.name).attrs.position.default || [0, 0, 0];
  const world = mat4.transformPoint([0, 0, 0], base, position[0], position[1], position[2]);
  const inverse = mat4.invert(mat4.createF64(), base);
  return inverse ? { world, inverse } : null;
}

// --- to and from the ES3D tree ------------------------------------------------------

/** The ES3D element for an object; `map` collects element → oid. */
export function toElement(node, map = null) {
  const el = h(node.name, node.attrs);
  if (node.text !== null && node.text !== undefined) el.text = node.text;
  for (const c of node.children) el.appendChild(toElement(c, map));
  el.selfClosing = el.children.length === 0 && el.text === null;
  if (map) map.set(el, node.oid);
  return el;
}

/** An object from a validated ES3D element, attributes under their canonical names. */
export function fromElement(el, skip = () => false) {
  const attrs = {};
  if (el.attrIndex) for (const [name, a] of Object.entries(el.attrIndex)) attrs[name] = a.value;
  else for (const a of el.attrs) attrs[a.name] = a.value;
  const children = el.children.filter((c) => c.type === 'element' && !skip(c)).map((c) => fromElement(c, skip));
  return { name: el.name, attrs, children, text: el.text !== null && el.text !== undefined ? el.text.trim() : null };
}

/** A short label for lists: the element name and its id or name. */
export function objectLabel(node) {
  const a = node.attrs;
  const who = a.id ? ` #${a.id}` : a.name ? ` “${a.name}”` : '';
  let what = '';
  if (a.radius && /sphere|cylinder|cone|capsule|torus|sweep/.test(node.name)) what = `r ${a.radius}`;
  else if (node.name === 'box' && a.size) what = a.size;
  else if (node.name === 'light' && a.type) what = a.type;
  else if (node.name === 'use' && a.ref) what = `→ ${a.ref}`;
  else if (node.name === 'repeat' && a.count) what = `×${a.count}`;
  else if (node.name === 'scatter' && a.count) what = `×${a.count}`;
  else if (node.name === 'animate' && a.attr) what = a.attr;
  else if (node.name === 'desc' && node.text) what = node.text.slice(0, 24);
  return { name: node.name, who, what };
}
