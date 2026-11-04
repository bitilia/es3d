// OpenSCAD import. The language is the OpenSCAD User Manual (the 2021.01
// manual; the same primitives in current builds). Positional parameter order
// is the order Parameters::parse lists them in the OpenSCAD sources
// (src/core/primitives.cc, LinearExtrudeNode.cc, RotateExtrudeNode.cc,
// TransformNode.cc, ColorNode.cc, ImportNode.cc, control.cc), checked against
// the master branch. cylinder's positional parameters are h, r1, r2, center;
// r and d are named. An omitted r2 stays 1, it is not copied from r1. A named
// r sets both radii. linear_extrude's positional parameters are height, v,
// scale, center, twist, slices, segments, and the default height is 100.
//
// The file is read, not sent to the OpenSCAD binary: a browser build cannot
// shell out, and the value of the format is the solids it names. cube, sphere,
// cylinder, polygon, polyhedron, linear_extrude, rotate_extrude, modules,
// functions, for, if and the affine transforms are evaluated. union is a group.
// difference, intersection, hull, minkowski and offset have no ES3D equivalent;
// their children are kept and the notes say the operation was not applied.
// A flat difference (the usual hole in an extrusion) is written as holes in
// the first outline.
//
// OpenSCAD is Z-up. Every solid is then mapped with a −90° rotation about X,
// (x, y, z) → (x, z, −y), which is the inverse of the root rotate([90, 0, 0])
// the exporter writes. A cylinder along Z becomes a cylinder along Y.
// Trigonometry in expressions is in degrees, as OpenSCAD specifies.
// $fn sets segments. A curve with $fn 0 stays an exact ES3D solid.

import * as mat4 from '../math/mat4.js';
import { matrixToTransformString } from '../transform/transform.js';
import { colorToShortHex, parseColor } from '../format/colors.js';
import { n } from './text-encode.js';
import { parseSTL, weldTriangles } from './stl.js';

const UNDEF = Symbol('undef');
const RX90 = (() => { const m = mat4.createF64(); mat4.fromEulerDeg(m, 90, 0, 0); return m; })();
const RXM90 = (() => { const m = mat4.createF64(); mat4.fromEulerDeg(m, -90, 0, 0); return m; })();

/**
 * @param {string} text
 * @param {{files?: {name: string, bytes: Uint8Array}[]}} [opts]
 * @returns {{text: string, notes: string[]}}
 */
export function importOpenSCAD(text, { files = [] } = {}) {
  const tally = new Map();
  const add = (key, k = 1) => tally.set(key, (tally.get(key) || 0) + k);
  const missing = new Set();
  const unknown = new Set();
  const lib = new Map();
  for (const f of files) lib.set(baseName(f.name), f);

  const prog = parseProgram(text);
  const root = newScope(null);
  root.vars.set('$fn', 0);
  root.vars.set('$fa', 12);
  root.vars.set('$fs', 2);
  root.vars.set('PI', Math.PI);
  const leaves = [];
  const env = { add, missing, unknown, lib, stack: [], only: [], onlySeen: false };
  execute(prog.body, root, leaves, env);
  const produced = env.onlySeen ? env.only : leaves;
  const flats = produced.filter((leaf) => leaf.dim === 2).length;
  if (flats) add('flat', flats);

  const notes = [];
  const say = (key, one, many) => {
    const k = tally.get(key);
    if (k) notes.push(`${k.toLocaleString('en-US')} ${k === 1 ? one : many}`);
  };
  say('difference', 'difference was not subtracted; its solids are all in the scene.', 'differences were not subtracted; their solids are all in the scene.');
  say('intersection', 'intersection was not clipped; its solids are all in the scene.', 'intersections were not clipped; their solids are all in the scene.');
  say('hull', 'hull was not computed; the children are in the scene instead.', 'hulls were not computed; the children are in the scene instead.');
  say('minkowski', 'minkowski sum was not computed; the children are in the scene instead.', 'minkowski sums were not computed; the children are in the scene instead.');
  say('offset', 'offset was not applied.', 'offsets were not applied.');
  say('resize', 'resize was not applied.', 'resizes were not applied.');
  say('projection', 'projection was left as the original solid.', 'projections were left as the original solids.');
  say('flat-diff', 'flat difference was written as holes in the first outline, without clipping overlaps.', 'flat differences were written as holes in the first outline, without clipping overlaps.');
  say('twist', 'extrusion dropped a twist or taper.', 'extrusions dropped a twist or taper.');
  say('direction', 'extrusion did not run along +Z; it was given that length along Z.', 'extrusions did not run along +Z; they were given that length along Z.');
  say('sweep', 'rotate_extrude with a negative angle was swept the other way.', 'rotate_extrude calls with a negative angle were swept the other way.');
  say('flat', 'flat shape was imported as a surface.', 'flat shapes were imported as surfaces.');
  say('disabled', 'object was disabled with * or %.', 'objects were disabled with * or %.');
  say('only', 'show-only subtree was kept and the rest of the file was left out.', 'show-only subtrees were kept and the rest of the file was left out.');
  say('text', 'text() was omitted (there is no font).', 'text() calls were omitted (there is no font).');
  say('import-skip', 'import() was omitted (only STL companions are read).', 'import() calls were omitted (only STL companions are read).');
  if (missing.size) notes.push(`Missing included file${missing.size === 1 ? '' : 's'}: ${[...missing].join(', ')}.`);
  if (unknown.size) notes.push(`Unknown module${unknown.size === 1 ? '' : 's'}: ${[...unknown].join(', ')}.`);

  const markup = emitDocument(produced.filter((leaf) => leaf.dim === 3 || leaf.dim === 2));
  return { text: markup, notes };
}

function baseName(name) {
  return String(name).replace(/\\/g, '/').split('/').pop();
}

function emitDocument(leaves) {
  const solids = [];
  for (const leaf of leaves) {
    const solid = leaf.dim === 2 ? promote2D(leaf) : leaf;
    if (!solid) continue;
    const matrix = toEs(solid);
    solids.push({ solid, matrix, color: leaf.color });
  }
  const counts = new Map();
  for (const s of solids) {
    const key = JSON.stringify(s.solid.shape);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const defs = new Map();
  let seq = 0;
  const lines = [];
  const defLines = [];
  for (const s of solids) {
    const key = JSON.stringify(s.solid.shape);
    const attrs = {};
    if (s.color) attrs.color = s.color;
    const transform = matrixToTransformString(s.matrix, (v) => n(v));
    if (transform) attrs.transform = transform;
    if (counts.get(key) > 1) {
      if (!defs.has(key)) {
        const id = `s${seq++}`;
        defs.set(key, id);
        defLines.push(shapeTag(s.solid.shape, { id }));
      }
      attrs.ref = defs.get(key);
      lines.push(shapeTag(null, attrs, 'use'));
    } else lines.push(shapeTag(s.solid.shape, attrs));
  }
  const body = [];
  if (defLines.length) body.push(`<defs>\n${defLines.map((l) => '  ' + l).join('\n')}\n</defs>`);
  body.push(...lines);
  return `<es3d version="1">\n${body.map((l) => '  ' + l).join('\n')}\n</es3d>\n`;
}

function promote2D(leaf) {
  if (leaf.kind === 'square') {
    return { dim: 3, matrix: leaf.matrix, shape: { kind: 'plane', width: leaf.w, depth: leaf.h }, color: leaf.color, axis: 'y' };
  }
  const baked = bakeProfile([leaf], leaf.matrix);
  if (!baked) return null;
  return { dim: 3, matrix: leaf.matrix, shape: { kind: 'path', d: baked.d, fillRule: baked.evenodd ? 'evenodd' : '' }, color: leaf.color, axis: 'z' };
}

/** OpenSCAD Z-up matrix to an ES3D matrix. Cylinders and planes also swap their local axis. */
function toEs(solid) {
  const local = solid.axis === 'y' ? RX90 : mat4.createF64();
  return mul(mul(RXM90, solid.matrix), local);
}

function shapeTag(shape, attrs, name) {
  const a = { ...attrs };
  if (shape) Object.assign(a, shapeAttrs(shape));
  const body = Object.entries(a).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  return `<${name || shape.kind}${body ? ' ' + body : ''}/>`;
}

function shapeAttrs(shape) {
  const seg = (v) => (v ? String(v) : '');
  if (shape.kind === 'box') return { size: shape.size.map((v) => n(v)).join(' ') };
  if (shape.kind === 'sphere') return { radius: n(shape.radius), segments: seg(shape.segments) };
  if (shape.kind === 'cylinder') {
    const a = { radius: n(shape.radius), height: n(shape.height), segments: seg(shape.segments) };
    if (Math.abs(shape.radiusTop - shape.radius) > 1e-9) a.radiusTop = n(shape.radiusTop);
    return a;
  }
  if (shape.kind === 'cone') return { radius: n(shape.radius), height: n(shape.height), segments: seg(shape.segments) };
  if (shape.kind === 'plane') return { size: `${n(shape.width)} ${n(shape.depth)}` };
  if (shape.kind === 'torus') return { radius: n(shape.radius), tube: n(shape.tube), arc: shape.arc < 360 - 1e-6 ? n(shape.arc) : '', segments: seg(shape.segments), tubeSegments: seg(shape.tubeSegments) };
  if (shape.kind === 'extrude') return { d: shape.d, depth: n(shape.depth), center: shape.center ? 'true' : '', fillRule: shape.fillRule || '' };
  if (shape.kind === 'revolve') return { d: shape.d, angle: shape.angle < 360 - 1e-6 ? n(shape.angle) : '', segments: seg(shape.segments), fillRule: shape.fillRule || '' };
  if (shape.kind === 'path') return { d: shape.d, fillRule: shape.fillRule || '' };
  if (shape.kind === 'polygon') return { points: shape.points.map((v) => n(v)).join(' ') };
  if (shape.kind === 'mesh') return { positions: shape.positions.map((v) => n(v)).join(' '), indices: shape.indices.join(' ') };
  return {};
}

function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// --- execution ----------------------------------------------------------------

function execute(stmts, scope, out, env) {
  for (const stmt of stmts) {
    if (stmt.t === 'module') scope.modules.set(stmt.name, stmt);
    else if (stmt.t === 'function') scope.functions.set(stmt.name, stmt);
  }
  for (const stmt of stmts) {
    if (stmt.t === 'module' || stmt.t === 'function') continue;
    evalStmt(stmt, scope, out, env);
  }
}

function evalStmt(stmt, scope, out, env) {
  if (!stmt) return;
  if (stmt.t === 'block') { execute(stmt.body, scope, out, env); return; }
  if (stmt.t === 'assign') { scope.vars.set(stmt.name, evalExpr(stmt.expr, scope, env)); return; }
  if (stmt.t === 'module') { scope.modules.set(stmt.name, stmt); return; }
  if (stmt.t === 'function') { scope.functions.set(stmt.name, stmt); return; }
  if (stmt.t === 'include') { includeFile(stmt, scope, out, env, stmt.kind === 'use'); return; }
  if (stmt.t === 'for') { evalFor(stmt, scope, out, env); return; }
  if (stmt.t === 'let') { evalLet(stmt, scope, out, env); return; }
  if (stmt.t === 'if') {
    if (truthy(evalExpr(stmt.cond, scope, env))) evalStmt(stmt.then, scope, out, env);
    else if (stmt.else) evalStmt(stmt.else, scope, out, env);
    return;
  }
  if (stmt.t === 'call') evalCall(stmt, scope, out, env);
}

function evalFor(stmt, scope, out, env) {
  const lists = stmt.bindings.map((b) => iterable(evalExpr(b.expr, scope, env)));
  const total = lists.reduce((n, list) => n * list.length, 1);
  if (total > 100000) throw new Error('An OpenSCAD for-loop expands past 100000 copies.');
  const rec = (i) => {
    if (i === lists.length) { evalStmt(stmt.body, scope, out, env); return; }
    const name = stmt.bindings[i].name;
    for (const value of lists[i]) {
      scope.vars.set(name, value);
      rec(i + 1);
    }
  };
  rec(0);
}

function evalLet(stmt, scope, out, env) {
  const inner = childScope(scope);
  for (const b of stmt.bindings) inner.vars.set(b.name, evalExpr(b.expr, inner, env));
  evalStmt(stmt.body, inner, out, env);
}

function evalCall(stmt, scope, out, env) {
  if (stmt.mod === '*' || stmt.mod === '%') { env.add('disabled'); return; }
  const values = bindArgs(stmt.args, scope, env);
  const args = mapParams(stmt.name, values, scope);
  const inner = childScope(scope);
  for (const [name, value] of Object.entries(args)) if (name.startsWith('$')) inner.vars.set(name, value);
  inner.children = childList(stmt.child);
  const bucket = stmt.mod === '!' ? [] : out;
  builtin(stmt.name, args, stmt.child, inner, bucket, env);
  if (stmt.mod === '!') {
    env.onlySeen = true;
    env.only.push(...bucket);
    env.add('only');
  }
}

function builtin(name, args, child, scope, out, env) {
  const at = (m) => { const s = childScope(scope); s.matrix = m; return s; };
  if (name === 'union' || name === 'group' || name === 'render') { evalStmt(child, scope, out, env); return; }
  if (name === 'difference' || name === 'intersection') {
    const parts = [];
    evalStmt(child, scope, parts, env);
    if (name === 'difference' && parts.length && parts.every((p) => p.dim === 2)) {
      env.add('flat-diff');
      const baked = bakeProfile(parts, scope.matrix);
      if (baked) out.push({ dim: 2, kind: 'poly', matrix: scope.matrix, loops: baked.loops || [], d: baked.d, evenodd: true, color: scope.color });
      return;
    }
    env.add(name);
    out.push(...parts);
    return;
  }
  if (name === 'hull' || name === 'minkowski' || name === 'offset' || name === 'resize' || name === 'projection') {
    env.add(name);
    evalStmt(child, scope, out, env);
    return;
  }
  if (name === 'translate') { evalStmt(child, at(mul(scope.matrix, translation(...vec3(arg(args, 'v', [0, 0, 0]))))), out, env); return; }
  if (name === 'rotate') { evalStmt(child, at(mul(scope.matrix, rotationOf(args))), out, env); return; }
  if (name === 'scale') { evalStmt(child, at(mul(scope.matrix, scaleOf(arg(args, 'v', 1)))), out, env); return; }
  if (name === 'mirror') { evalStmt(child, at(mul(scope.matrix, mirrorOf(vec3(arg(args, 'v', [0, 0, 1]))))), out, env); return; }
  if (name === 'multmatrix') { evalStmt(child, at(mul(scope.matrix, matrixOf(arg(args, 'm', null)))), out, env); return; }
  if (name === 'color') { const s = childScope(scope); s.color = colorOf(args) || scope.color; evalStmt(child, s, out, env); return; }
  if (name === 'linear_extrude') { extrude(args, child, scope, out, env); return; }
  if (name === 'rotate_extrude') { revolve(args, child, scope, out, env); return; }
  if (name === 'cube') { cube(args, scope, out); return; }
  if (name === 'sphere') { sphere(args, scope, out); return; }
  if (name === 'cylinder') { cylinder(args, scope, out); return; }
  if (name === 'square') { square(args, scope, out); return; }
  if (name === 'circle') { circle(args, scope, out); return; }
  if (name === 'polygon') { polygon(args, scope, out); return; }
  if (name === 'polyhedron') { polyhedron(args, scope, out); return; }
  if (name === 'text') { env.add('text'); return; }
  if (name === 'import') { importMesh(args, scope, out, env); return; }
  if (name === 'echo' || name === 'assert') { if (child) evalStmt(child, scope, out, env); return; }
  if (name === 'children') { childrenOf(args, scope, out, env); return; }
  const mod = lookupMod(scope, name);
  if (!mod) { if (!BUILTIN_SKIP.has(name)) env.unknown.add(name); return; }
  if (env.stack.length > 64) throw new Error(`OpenSCAD module ${name} recurses more than 64 deep.`);
  env.stack.push(name);
  const inner = childScope(scope);
  for (const p of mod.params) {
    const value = args[p.name] !== undefined ? args[p.name] : (p.def ? evalExpr(p.def, scope, env) : UNDEF);
    inner.vars.set(p.name, value);
  }
  inner.children = childList(child);
  evalStmt(mod.body, inner, out, env);
  env.stack.pop();
}

const BUILTIN_SKIP = new Set(['cube', 'sphere', 'cylinder', 'square', 'circle', 'polygon', 'polyhedron', 'union', 'difference', 'intersection', 'translate', 'rotate', 'scale', 'mirror', 'multmatrix', 'color', 'linear_extrude', 'rotate_extrude', 'children', 'group', 'render', 'hull', 'minkowski', 'offset', 'resize', 'projection', 'text', 'import', 'echo', 'assert']);

function cube(args, scope, out) {
  let size = arg(args, 'size', [1, 1, 1]);
  if (typeof size === 'number') size = [size, size, size];
  size = vec3(size);
  if (size.some((v) => !(v > 0))) return;
  const center = truthy(args.center);
  const m = center ? scope.matrix : mul(scope.matrix, translation(size[0] / 2, size[1] / 2, size[2] / 2));
  out.push({ dim: 3, matrix: m, shape: { kind: 'box', size }, color: scope.color, axis: 'z' });
}

function sphere(args, scope, out) {
  const found = lookupRadius(args, 'd', 'r');
  const r = found === undefined ? 1 : found;
  if (!(r > 0)) return;
  const fn = fragments(r, scope);
  out.push({ dim: 3, matrix: scope.matrix, shape: { kind: 'sphere', radius: r, segments: explicitFn(scope) ? fn : 0 }, color: scope.color, axis: 'z' });
}

function cylinder(args, scope, out) {
  const h = typeof args.h === 'number' && Number.isFinite(args.h) ? args.h : 1;
  const r = lookupRadius(args, 'd', 'r');
  const bottomNamed = lookupRadius(args, 'd1', 'r1');
  const topNamed = lookupRadius(args, 'd2', 'r2');
  let r1 = 1;
  let r2 = 1;
  if (r !== undefined) { r1 = r; r2 = r; }
  if (bottomNamed !== undefined) r1 = bottomNamed;
  if (topNamed !== undefined) r2 = topNamed;
  if (!(h > 0) || r1 < 0 || r2 < 0 || (r1 === 0 && r2 === 0)) return;
  const center = truthy(args.center);
  const m = center ? scope.matrix : mul(scope.matrix, translation(0, 0, h / 2));
  const fn = explicitFn(scope) ? fragments(Math.max(r1, r2), scope) : 0;
  if (r1 === 0) {
    out.push({ dim: 3, matrix: mul(m, rotationXYZ(180, 0, 0)), shape: { kind: 'cone', radius: r2, height: h, segments: fn }, color: scope.color, axis: 'y' });
    return;
  }
  if (r2 === 0) {
    out.push({ dim: 3, matrix: m, shape: { kind: 'cone', radius: r1, height: h, segments: fn }, color: scope.color, axis: 'y' });
    return;
  }
  out.push({ dim: 3, matrix: m, shape: { kind: 'cylinder', radius: r1, radiusTop: r2, height: h, segments: fn }, color: scope.color, axis: 'y' });
}

function square(args, scope, out) {
  let size = arg(args, 'size', [1, 1]);
  if (typeof size === 'number') size = [size, size];
  const w = num(size[0], 1), h = num(size[1], w);
  if (!(w > 0) || !(h > 0)) return;
  const center = truthy(args.center);
  const m = center ? scope.matrix : mul(scope.matrix, translation(w / 2, h / 2, 0));
  out.push({ dim: 2, kind: 'square', w, h, matrix: m, color: scope.color });
}

function circle(args, scope, out) {
  const found = lookupRadius(args, 'd', 'r');
  const r = found === undefined ? 1 : found;
  if (!(r > 0)) return;
  out.push({ dim: 2, kind: 'circle', r, fn: fragments(r, scope), matrix: scope.matrix, color: scope.color });
}

function polygon(args, scope, out) {
  const points = asList(arg(args, 'points', []));
  const paths = args.paths !== undefined ? asList(args.paths).map(asList) : null;
  const loops = [];
  const use = paths || [points.map((_, i) => i)];
  for (const path of use) {
    const loop = [];
    for (const index of path) {
      const p = points[index | 0];
      if (Array.isArray(p)) loop.push(num(p[0], 0), num(p[1], 0));
    }
    if (loop.length >= 6) loops.push(loop);
  }
  if (!loops.length) return;
  out.push({ dim: 2, kind: 'poly', loops, matrix: scope.matrix, color: scope.color, evenodd: loops.length > 1 });
}

function polyhedron(args, scope, out) {
  const pts = asList(arg(args, 'points', []));
  const faces = asList(args.faces !== undefined ? args.faces : args.triangles || []);
  const positions = [];
  for (const p of pts) positions.push(num(p[0], 0), num(p[1], 0), num(p[2], 0));
  const indices = [];
  for (const face of faces) {
    const idx = asList(face).map((v) => v | 0);
    if (idx.length < 3) continue;
    const rev = idx.slice().reverse();
    for (let i = 1; i < rev.length - 1; i++) indices.push(rev[0], rev[i], rev[i + 1]);
  }
  if (indices.length < 3) return;
  out.push({ dim: 3, matrix: scope.matrix, shape: { kind: 'mesh', positions, indices }, color: scope.color, axis: 'z' });
}

function extrude(args, child, scope, out, env) {
  const height = extrusionLength(args, env);
  const center = truthy(args.center);
  const twist = num(args.twist, 0);
  const scale = args.scale === undefined || args.scale === UNDEF ? 1 : args.scale;
  const scaleFlat = typeof scale === 'number' ? Math.abs(scale - 1) < 1e-9 : Array.isArray(scale) && scale.every((v) => Math.abs(num(v, 1) - 1) < 1e-9);
  if (Math.abs(twist) > 1e-9 || !scaleFlat) env.add('twist');
  const parts = [];
  evalStmt(child, scope, parts, env);
  const flat = parts.filter((p) => p.dim === 2);
  if (!flat.length || !(height > 0)) return;
  if (flat.length === 1 && flat[0].kind === 'circle') {
    const c = circleFrame(flat[0], scope.matrix);
    if (c) {
      const m = mul(scope.matrix, translation(c.x, c.y, center ? 0 : height / 2));
      out.push({ dim: 3, matrix: m, shape: { kind: 'cylinder', radius: c.r, radiusTop: c.r, height, segments: explicitFn(scope) ? flat[0].fn : 0 }, color: scope.color, axis: 'y' });
      return;
    }
  }
  if (flat.length === 1 && flat[0].kind === 'square') {
    const s = flat[0];
    const rel = relative(scope.matrix, s.matrix);
    if (planar(rel)) {
      const o = apply(rel, 0, 0, 0);
      const m = mul(scope.matrix, translation(o[0], o[1], center ? 0 : height / 2));
      out.push({ dim: 3, matrix: m, shape: { kind: 'box', size: [s.w, s.h, height] }, color: scope.color, axis: 'z' });
      return;
    }
  }
  const baked = bakeProfile(flat, scope.matrix);
  if (!baked) return;
  out.push({ dim: 3, matrix: scope.matrix, shape: { kind: 'extrude', d: baked.d, depth: height, center, fillRule: baked.evenodd ? 'evenodd' : '' }, color: scope.color, axis: 'z' });
}

/** OpenSCAD's linear_extrude height vector: v sets the direction, height its length, and a negative Z is dropped. */
function extrusionLength(args, env) {
  const hasV = Array.isArray(args.v);
  const hasH = typeof args.height === 'number' && Number.isFinite(args.height);
  let dir = hasV ? [num(args.v[0], 0), num(args.v[1], 0), num(args.v[2], 0)] : [0, 0, 1];
  let scalar = hasV ? 1 : 100;
  if (hasH) {
    scalar = args.height;
    const l = Math.hypot(dir[0], dir[1], dir[2]);
    if (l > 1e-12) dir = dir.map((c) => c / l);
  }
  const vec = dir.map((c) => c * scalar);
  if (vec[2] < 0) vec[2] = 0;
  if (Math.abs(vec[0]) > 1e-8 || Math.abs(vec[1]) > 1e-8) env.add('direction');
  return Math.hypot(vec[0], vec[1], vec[2]);
}

function revolve(args, child, scope, out, env) {
  let angle = 360;
  let start = 180;
  if (typeof args.angle === 'number' && Number.isFinite(args.angle)) {
    angle = args.angle;
    start = 0;
    if (angle <= -360 || angle > 360) angle = 360;
  }
  if (typeof args.start === 'number' && Number.isFinite(args.start)) start = args.start;
  if (angle < 0 && angle > -360) env.add('sweep');
  angle = Math.min(360, Math.abs(angle));
  if (angle < 1e-9) return;
  const turned = angle < 360 - 1e-6 && Math.abs(start) > 1e-9;
  const frame = turned ? mul(scope.matrix, rotationXYZ(0, 0, start)) : scope.matrix;
  const parts = [];
  evalStmt(child, scope, parts, env);
  const flat = parts.filter((p) => p.dim === 2);
  if (flat.length === 1 && flat[0].kind === 'circle' && angle >= 360 - 1e-6) {
    const c = circleFrame(flat[0], scope.matrix);
    if (c && Math.abs(c.y) < 1e-6 && c.x > c.r) {
      out.push({ dim: 3, matrix: frame, shape: { kind: 'torus', radius: c.x, tube: c.r, arc: 360, segments: explicitFn(scope) ? fragments(c.x, scope) : 0, tubeSegments: explicitFn(scope) ? flat[0].fn : 0 }, color: scope.color, axis: 'y' });
      return;
    }
  }
  const baked = bakeProfile(flat, scope.matrix);
  if (!baked) return;
  out.push({ dim: 3, matrix: frame, shape: { kind: 'revolve', d: baked.d, angle, segments: explicitFn(scope) ? fragments(1, scope) : 0, fillRule: baked.evenodd ? 'evenodd' : '' }, color: scope.color, axis: 'y' });
}

function importMesh(args, scope, out, env) {
  const file = String(arg(args, 'file', ''));
  const hit = env.lib.get(baseName(file));
  if (!hit || !/\.stl$/i.test(hit.name)) { env.add('import-skip'); return; }
  const parsed = parseSTL(hit.bytes);
  const welded = weldTriangles(parsed.positions);
  out.push({ dim: 3, matrix: scope.matrix, shape: { kind: 'mesh', positions: Array.from(welded.positions), indices: Array.from(welded.indices) }, color: scope.color, axis: 'z' });
}

function childrenOf(args, scope, out, env) {
  const list = scope.children || [];
  const index = args.index !== undefined ? args.index : args[0];
  const pick = index === undefined ? list.map((_, i) => i) : iterable(index);
  for (const i of pick) if (list[i]) evalStmt(list[i], scope, out, env);
}

function includeFile(stmt, scope, out, env, onlyDefs) {
  const hit = env.lib.get(baseName(stmt.file));
  if (!hit) { env.missing.add(stmt.file); return; }
  if (env.stack.includes(stmt.file)) return;
  env.stack.push(stmt.file);
  const text = new TextDecoder('utf-8').decode(hit.bytes);
  const prog = parseProgram(text);
  const body = onlyDefs ? prog.body.filter((s) => s.t === 'module' || s.t === 'function') : prog.body;
  execute(body, scope, out, env);
  env.stack.pop();
}

function childList(stmt) {
  if (!stmt) return [];
  if (stmt.t === 'block') return stmt.body;
  return [stmt];
}

function lookupMod(scope, name) {
  let s = scope;
  while (s) {
    if (s.modules.has(name)) return s.modules.get(name);
    s = s.parent;
  }
  return null;
}

// --- 2D profiles --------------------------------------------------------------

function bakeProfile(parts, frame) {
  const subs = [];
  let evenodd = false;
  for (const part of parts) {
    if (part.evenodd) evenodd = true;
    if (part.kind === 'circle') {
      const c = circleFrame(part, frame);
      if (!c) continue;
      subs.push(circlePath(c.x, c.y, c.r));
    } else if (part.kind === 'square') {
      const rel = relative(frame, part.matrix);
      const w = part.w / 2, h = part.h / 2;
      const corners = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => apply(rel, x, y, 0));
      subs.push(loopPath(corners.map((p) => [p[0], p[1]])));
    } else if (part.kind === 'poly') {
      if (part.d && sameMatrix(part.matrix, frame)) subs.push(part.d);
      else {
        const rel = relative(frame, part.matrix);
        for (const loop of part.loops || []) {
          const pts = [];
          for (let i = 0; i < loop.length; i += 2) {
            const p = apply(rel, loop[i], loop[i + 1], 0);
            pts.push([p[0], p[1]]);
          }
          subs.push(loopPath(pts));
        }
        if (part.evenodd) evenodd = true;
      }
    }
  }
  if (!subs.length) return null;
  return { d: subs.join(' '), evenodd: evenodd || subs.length > 1 && parts.length > 1, loops: null };
}

function circleFrame(node, frame) {
  const rel = relative(frame, node.matrix);
  if (!planar(rel)) return null;
  const c = apply(rel, 0, 0, 0);
  const px = apply(rel, node.r, 0, 0);
  const py = apply(rel, 0, node.r, 0);
  const rx = Math.hypot(px[0] - c[0], px[1] - c[1]);
  const ry = Math.hypot(py[0] - c[0], py[1] - c[1]);
  if (!(rx > 1e-9) || Math.abs(rx - ry) > 1e-4 * rx) return null;
  return { x: c[0], y: c[1], r: rx };
}

function circlePath(x, y, r) {
  return `M ${n(x + r)} ${n(y)} A ${n(r)} ${n(r)} 0 1 1 ${n(x - r)} ${n(y)} A ${n(r)} ${n(r)} 0 1 1 ${n(x + r)} ${n(y)} Z`;
}

function loopPath(pts) {
  if (pts.length < 3) return '';
  let d = `M ${n(pts[0][0])} ${n(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${n(pts[i][0])} ${n(pts[i][1])}`;
  return d + ' Z';
}

function planar(m) {
  const z = apply(m, 0, 0, 1);
  const o = apply(m, 0, 0, 0);
  return Math.abs(z[0] - o[0]) < 1e-6 && Math.abs(z[1] - o[1]) < 1e-6 && Math.abs(o[2]) < 1e-6 && Math.abs(z[2] - o[2] - 1) < 1e-4 || Math.abs(z[2] - o[2]) > 0.5 && Math.abs(o[2]) < 1e-6 && Math.abs(z[0] - o[0]) < 1e-6 && Math.abs(z[1] - o[1]) < 1e-6;
}

function sameMatrix(a, b) {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-8) return false;
  return true;
}

// --- values -------------------------------------------------------------------

function newScope(parent) {
  return { parent, vars: new Map(), modules: new Map(), functions: new Map(), matrix: mat4.createF64(), color: null, children: [] };
}

function childScope(parent) {
  const s = newScope(parent);
  s.matrix = parent.matrix;
  s.color = parent.color;
  s.children = parent.children;
  return s;
}

function bindArgs(args, scope, env) {
  const named = {};
  const positional = [];
  for (const a of args) {
    const value = evalExpr(a.expr, scope, env);
    if (a.name) named[a.name] = value;
    else positional.push(value);
  }
  named['#n'] = positional.length;
  for (let i = 0; i < positional.length; i++) named['#' + i] = positional[i];
  return named;
}

function mapParams(name, values, scope) {
  const out = {};
  for (const [k, v] of Object.entries(values)) if (!k.startsWith('#')) out[k] = v;
  const order = PARAMS[name] || (lookupMod(scope, name) ? lookupMod(scope, name).params.map((p) => p.name) : null);
  const count = values['#n'] || 0;
  if (order) {
    let p = 0;
    for (let i = 0; i < count; i++) {
      while (p < order.length && out[order[p]] !== undefined) p++;
      if (p < order.length) out[order[p++]] = values['#' + i];
    }
  }
  if (name === 'linear_extrude' && out.height === undefined && out.h !== undefined) out.height = out.h;
  if (name === 'rotate_extrude' && out.angle === undefined && out.a !== undefined) out.angle = out.a;
  return out;
}

function arg(args, name, fallback) {
  if (args[name] !== undefined && args[name] !== UNDEF) return args[name];
  return fallback;
}

function lookupRadius(args, dName, rName) {
  if (typeof args[dName] === 'number' && Number.isFinite(args[dName])) return args[dName] / 2;
  if (typeof args[rName] === 'number' && Number.isFinite(args[rName])) return args[rName];
  return undefined;
}

function explicitFn(scope) {
  const fn = lookup(scope, '$fn');
  return typeof fn === 'number' && fn > 0;
}

function fragments(r, scope) {
  const fn = num(lookup(scope, '$fn'), 0);
  if (fn > 0) return Math.max(3, Math.min(512, Math.round(fn)));
  const fa = num(lookup(scope, '$fa'), 12) || 12;
  const fs = num(lookup(scope, '$fs'), 2) || 2;
  return Math.max(5, Math.min(512, Math.ceil(Math.max(Math.min(360 / fa, (Math.abs(r) * 2 * Math.PI) / fs), 5))));
}

function colorOf(args) {
  const c = args.c !== undefined ? args.c : args['#0'];
  const alpha = args.alpha !== undefined ? num(args.alpha, 1) : null;
  let rgba = null;
  if (typeof c === 'string') rgba = parseColor(c);
  else if (Array.isArray(c)) {
    rgba = [num(c[0], 0), num(c[1], 0), num(c[2], 0), c.length > 3 ? num(c[3], 1) : 1];
  }
  if (!rgba) return null;
  if (alpha != null) rgba[3] = alpha;
  return colorToShortHex(rgba);
}

function rotationOf(args) {
  const a = args.a !== undefined ? args.a : args['#0'];
  const v = args.v;
  if (Array.isArray(a)) return rotationXYZ(num(a[0], 0), num(a[1], 0), num(a[2], 0));
  const deg = num(a, 0);
  const axis = v ? vec3(v) : [0, 0, 1];
  const m = mat4.createF64();
  const rad = deg * Math.PI / 180;
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / l, y = axis[1] / l, z = axis[2] / l;
  const s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;
  m[0] = t * x * x + c; m[4] = t * x * y - s * z; m[8] = t * x * z + s * y;
  m[1] = t * x * y + s * z; m[5] = t * y * y + c; m[9] = t * y * z - s * x;
  m[2] = t * x * z - s * y; m[6] = t * y * z + s * x; m[10] = t * z * z + c;
  return m;
}

function rotationXYZ(x, y, z) {
  const m = mat4.createF64();
  mat4.fromEulerDeg(m, x, y, z);
  return m;
}

function scaleOf(v) {
  const s = typeof v === 'number' ? [v, v, v] : vec3(v, 1);
  const m = mat4.createF64();
  m[0] = s[0]; m[5] = s[1]; m[10] = s[2];
  return m;
}

function mirrorOf(n) {
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  const x = n[0] / l, y = n[1] / l, z = n[2] / l;
  const m = mat4.createF64();
  m[0] = 1 - 2 * x * x; m[4] = -2 * x * y; m[8] = -2 * x * z;
  m[1] = -2 * y * x; m[5] = 1 - 2 * y * y; m[9] = -2 * y * z;
  m[2] = -2 * z * x; m[6] = -2 * z * y; m[10] = 1 - 2 * z * z;
  return m;
}

function matrixOf(v) {
  const rows = asList(v);
  const m = mat4.createF64();
  for (let r = 0; r < 4; r++) {
    const row = asList(rows[r] || [0, 0, 0, r === 3 ? 1 : 0]);
    for (let c = 0; c < 4; c++) m[c * 4 + r] = num(row[c], r === c ? 1 : 0);
  }
  return m;
}

function translation(x, y, z) {
  const m = mat4.createF64();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

function mul(a, b) {
  const o = mat4.createF64();
  mat4.multiply(o, a, b);
  return o;
}

function relative(frame, child) {
  const inv = mat4.createF64();
  mat4.invert(inv, frame);
  return mul(inv, child);
}

function apply(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function vec3(v, fallback = 0) {
  if (typeof v === 'number') return [v, v, v];
  if (!Array.isArray(v)) return [fallback, fallback, fallback];
  return [num(v[0], fallback), num(v[1], fallback), num(v[2], fallback)];
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function truthy(v) {
  if (v === UNDEF || v == null || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.length > 0;
  return !!v;
}

function iterable(v) {
  if (v && v.range) return rangeValues(v.start, v.step, v.end);
  if (Array.isArray(v)) return v;
  if (typeof v === 'number') return [v];
  return [];
}

function rangeValues(start, step, end) {
  if (!Number.isFinite(start) || !Number.isFinite(step) || !Number.isFinite(end) || step === 0) return [];
  const n = Math.floor((end - start) / step + 1e-9);
  if (n < 0 || n > 100000) return n > 100000 ? (() => { throw new Error('An OpenSCAD range is longer than 100000.'); })() : [];
  const out = [];
  for (let i = 0; i <= n; i++) out.push(start + i * step);
  return out;
}

function asList(v) {
  if (v && v.range) return rangeValues(v.start, v.step, v.end);
  return Array.isArray(v) ? v : [];
}

function lookup(scope, name) {
  let s = scope;
  while (s) {
    if (s.vars.has(name)) return s.vars.get(name);
    s = s.parent;
  }
  return UNDEF;
}

function lookupFn(scope, name) {
  let s = scope;
  while (s) {
    if (s.functions.has(name)) return s.functions.get(name);
    s = s.parent;
  }
  return null;
}

const PREC = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

function evalExpr(expr, scope, env) {
  if (!expr) return UNDEF;
  if (expr.t === 'num') return expr.v;
  if (expr.t === 'str') return expr.v;
  if (expr.t === 'undef') return UNDEF;
  if (expr.t === 'bool') return expr.v;
  if (expr.t === 'id') return lookup(scope, expr.v);
  if (expr.t === 'list') return expr.items.map((e) => evalExpr(e, scope, env));
  if (expr.t === 'range') return { range: true, start: num(evalExpr(expr.start, scope, env), 0), step: expr.step ? num(evalExpr(expr.step, scope, env), 1) : 1, end: num(evalExpr(expr.end, scope, env), 0) };
  if (expr.t === 'unary') {
    const v = evalExpr(expr.v, scope, env);
    if (expr.op === '!') return !truthy(v);
    if (expr.op === '-') return typeof v === 'number' ? -v : Array.isArray(v) ? v.map((x) => -num(x, 0)) : UNDEF;
    return v;
  }
  if (expr.t === 'ternary') return truthy(evalExpr(expr.cond, scope, env)) ? evalExpr(expr.then, scope, env) : evalExpr(expr.else, scope, env);
  if (expr.t === 'index') {
    const v = evalExpr(expr.v, scope, env);
    const i = evalExpr(expr.i, scope, env);
    if (Array.isArray(v) && typeof i === 'number') return v[i] !== undefined ? v[i] : UNDEF;
    return UNDEF;
  }
  if (expr.t === 'dot') {
    const v = evalExpr(expr.v, scope, env);
    const map = { x: 0, y: 1, z: 2 };
    if (Array.isArray(v) && map[expr.name] !== undefined) return v[map[expr.name]] !== undefined ? v[map[expr.name]] : UNDEF;
    return UNDEF;
  }
  if (expr.t === 'call') return callFn(expr.name, expr.args.map((a) => evalExpr(a, scope, env)), scope, env);
  if (expr.t === 'bin') return binOp(expr.op, evalExpr(expr.l, scope, env), evalExpr(expr.r, scope, env));
  if (expr.t === 'comp') return evalComp(expr, scope, env);
  return UNDEF;
}

function binOp(op, l, r) {
  if ((op === '*' || op === '/' || op === '%' || op === '+' || op === '-') && (Array.isArray(l) || Array.isArray(r))) return vecOp(op, l, r);
  if (l === UNDEF || r === UNDEF) return op === '==' || op === '!=' ? false : UNDEF;
  if (op === '+') return num(l, 0) + num(r, 0);
  if (op === '-') return num(l, 0) - num(r, 0);
  if (op === '*') return num(l, 0) * num(r, 0);
  if (op === '/') return num(r, 0) === 0 ? UNDEF : num(l, 0) / num(r, 0);
  if (op === '%') return num(r, 0) === 0 ? UNDEF : num(l, 0) % num(r, 0);
  if (op === '==') return sameVal(l, r);
  if (op === '!=') return !sameVal(l, r);
  if (op === '<') return num(l, 0) < num(r, 0);
  if (op === '>') return num(l, 0) > num(r, 0);
  if (op === '<=') return num(l, 0) <= num(r, 0);
  if (op === '>=') return num(l, 0) >= num(r, 0);
  if (op === '&&') return truthy(l) && truthy(r);
  if (op === '||') return truthy(l) || truthy(r);
  return UNDEF;
}

function vecOp(op, l, r) {
  const a = Array.isArray(l) ? l : null;
  const b = Array.isArray(r) ? r : null;
  if (op === '*' && a && typeof r === 'number') return a.map((v) => num(v, 0) * r);
  if (op === '*' && b && typeof l === 'number') return b.map((v) => num(v, 0) * l);
  if (op === '/' && a && typeof r === 'number' && r !== 0) return a.map((v) => num(v, 0) / r);
  if ((op === '+' || op === '-' || op === '*') && a && b) {
    const n = Math.max(a.length, b.length);
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = num(a[i], 0), y = num(b[i], 0);
      out.push(op === '+' ? x + y : op === '-' ? x - y : x * y);
    }
    return out;
  }
  return UNDEF;
}

function sameVal(a, b) {
  if (a === UNDEF || b === UNDEF) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameVal(v, b[i]));
  return a === b;
}

function callFn(name, args, scope, env) {
  const rad = (v) => v * 180 / Math.PI;
  if (name === 'sin') return Math.sin(num(args[0], 0) * Math.PI / 180);
  if (name === 'cos') return Math.cos(num(args[0], 0) * Math.PI / 180);
  if (name === 'tan') return Math.tan(num(args[0], 0) * Math.PI / 180);
  if (name === 'asin') return rad(Math.asin(clamp1(args[0])));
  if (name === 'acos') return rad(Math.acos(clamp1(args[0])));
  if (name === 'atan') return rad(Math.atan(num(args[0], 0)));
  if (name === 'atan2') return rad(Math.atan2(num(args[0], 0), num(args[1], 0)));
  if (name === 'abs') return Math.abs(num(args[0], 0));
  if (name === 'ceil') return Math.ceil(num(args[0], 0));
  if (name === 'floor') return Math.floor(num(args[0], 0));
  if (name === 'round') return Math.round(num(args[0], 0));
  if (name === 'sqrt') return Math.sqrt(Math.max(0, num(args[0], 0)));
  if (name === 'pow') return Math.pow(num(args[0], 0), num(args[1], 0));
  if (name === 'ln') return Math.log(num(args[0], 1));
  if (name === 'log') return Math.log(num(args[0], 1)) / Math.LN10;
  if (name === 'exp') return Math.exp(num(args[0], 0));
  if (name === 'sign') return Math.sign(num(args[0], 0));
  if (name === 'min') return Math.min(...flatNums(args));
  if (name === 'max') return Math.max(...flatNums(args));
  if (name === 'len') return Array.isArray(args[0]) ? args[0].length : args[0] && args[0].range ? rangeValues(args[0].start, args[0].step, args[0].end).length : 0;
  if (name === 'norm') return Math.hypot(...(Array.isArray(args[0]) ? args[0].map((v) => num(v, 0)) : [0]));
  if (name === 'cross') {
    const a = vec3(args[0]), b = vec3(args[1]);
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  if (name === 'concat') return args.flatMap((v) => Array.isArray(v) ? v : [v]);
  if (name === 'str') return args.map((v) => v === UNDEF ? 'undef' : String(v)).join('');
  const fn = lookupFn(scope, name);
  if (!fn) return UNDEF;
  const inner = childScope(scope);
  fn.params.forEach((p, i) => inner.vars.set(p.name, args[i] !== undefined ? args[i] : (p.def ? evalExpr(p.def, scope, env) : UNDEF)));
  return evalExpr(fn.expr, inner, env);
}

function clamp1(v) {
  return Math.max(-1, Math.min(1, num(v, 0)));
}

function flatNums(args) {
  const out = [];
  for (const a of args) {
    if (Array.isArray(a)) out.push(...a.map((v) => num(v, 0)));
    else out.push(num(a, 0));
  }
  return out.length ? out : [0];
}

function evalComp(expr, scope, env) {
  const out = [];
  const walk = (i) => {
    if (i === expr.gens.length) { out.push(evalExpr(expr.expr, scope, env)); return; }
    const g = expr.gens[i];
    if (g.t === 'for') {
      const lists = g.bindings.map((b) => iterable(evalExpr(b.expr, scope, env)));
      const rec = (k) => {
        if (k === lists.length) { walk(i + 1); return; }
        for (const value of lists[k]) { scope.vars.set(g.bindings[k].name, value); rec(k + 1); }
      };
      rec(0);
      return;
    }
    if (g.t === 'if') { if (truthy(evalExpr(g.cond, scope, env))) walk(i + 1); return; }
    if (g.t === 'let') {
      for (const b of g.bindings) scope.vars.set(b.name, evalExpr(b.expr, scope, env));
      walk(i + 1);
    }
  };
  walk(0);
  return out;
}

// --- parser -------------------------------------------------------------------

function parseProgram(text) {
  const p = new Parser(lex(text));
  const body = [];
  while (!p.end()) body.push(p.stmt());
  return { body };
}

class Parser {
  constructor(tokens) { this.toks = tokens; this.i = 0; }
  cur() { return this.toks[this.i]; }
  end() { return this.cur().t === 'eof'; }
  eat(t, v) {
    const c = this.cur();
    if (c.t !== t || (v !== undefined && c.v !== v)) this.fail(`expected ${v || t}`);
    this.i++;
    return c;
  }
  is(t, v) { const c = this.cur(); return c.t === t && (v === undefined || c.v === v); }
  fail(msg) { throw new Error(`OpenSCAD line ${this.cur().line}: ${msg}`); }

  stmt() {
    if (this.is('punct', '{')) return this.block();
    let mod = null;
    if (this.is('punct', '*') || this.is('punct', '!') || this.is('punct', '#') || this.is('punct', '%')) mod = this.eat('punct').v;
    if (this.is('id', 'include') || this.is('id', 'use')) return this.include();
    if (this.is('id', 'module')) return this.module();
    if (this.is('id', 'function')) return this.fn();
    if (this.is('id', 'for') || this.is('id', 'intersection_for')) return this.forStmt();
    if (this.is('id', 'if')) return this.ifStmt();
    if (this.is('id', 'let') || this.is('id', 'assign')) return this.letStmt();
    if (this.is('id')) {
      const name = this.eat('id').v;
      if (this.is('punct', '=')) {
        this.eat('punct', '=');
        const expr = this.expr();
        if (this.is('punct', ';')) this.eat('punct', ';');
        return { t: 'assign', name, expr };
      }
      const args = this.is('punct', '(') ? this.args() : [];
      let child = null;
      if (this.startsStmt()) child = this.stmt();
      else if (this.is('punct', ';')) this.eat('punct', ';');
      const node = { t: 'call', name, args, child };
      if (mod) node.mod = mod;
      return node;
    }
    this.fail(`unexpected ${this.cur().v || this.cur().t}`);
  }

  startsStmt() {
    if (this.is('punct', '{') || this.is('punct', '*') || this.is('punct', '!') || this.is('punct', '#') || this.is('punct', '%')) return true;
    return this.is('id') && !this.is('id', 'else');
  }

  block() {
    this.eat('punct', '{');
    const body = [];
    while (!this.is('punct', '}') && !this.end()) body.push(this.stmt());
    this.eat('punct', '}');
    return { t: 'block', body };
  }

  include() {
    const kind = this.eat('id').v;
    this.eat('punct', '<');
    let file = '';
    while (!this.is('punct', '>') && !this.end()) {
      const tok = this.cur();
      file += tok.t === 'str' ? tok.v : String(tok.v);
      this.i++;
    }
    this.eat('punct', '>');
    if (this.is('punct', ';')) this.eat('punct', ';');
    return { t: 'include', kind, file };
  }

  module() {
    this.eat('id', 'module');
    const name = this.eat('id').v;
    const params = this.is('punct', '(') ? this.params() : [];
    const body = this.stmt();
    return { t: 'module', name, params, body };
  }

  fn() {
    this.eat('id', 'function');
    const name = this.eat('id').v;
    const params = this.params();
    this.eat('punct', '=');
    const expr = this.expr();
    if (this.is('punct', ';')) this.eat('punct', ';');
    return { t: 'function', name, params, expr };
  }

  forStmt() {
    const name = this.eat('id').v;
    this.eat('punct', '(');
    const bindings = this.bindings();
    this.eat('punct', ')');
    const body = this.stmt();
    return { t: 'for', name, bindings, body };
  }

  ifStmt() {
    this.eat('id', 'if');
    this.eat('punct', '(');
    const cond = this.expr();
    this.eat('punct', ')');
    const then = this.stmt();
    let els = null;
    if (this.is('id', 'else')) { this.eat('id', 'else'); els = this.stmt(); }
    return { t: 'if', cond, then, else: els };
  }

  letStmt() {
    this.eat('id');
    this.eat('punct', '(');
    const bindings = this.bindings();
    this.eat('punct', ')');
    return { t: 'let', bindings, body: this.stmt() };
  }

  bindings() {
    const list = [];
    if (this.is('punct', ')')) return list;
    do {
      const name = this.eat('id').v;
      this.eat('punct', '=');
      list.push({ name, expr: this.expr() });
    } while (this.is('punct', ',') && this.eat('punct', ','));
    return list;
  }

  params() {
    this.eat('punct', '(');
    const list = [];
    if (!this.is('punct', ')')) {
      do {
        const name = this.eat('id').v;
        let def = null;
        if (this.is('punct', '=')) { this.eat('punct', '='); def = this.expr(); }
        list.push({ name, def });
      } while (this.is('punct', ',') && this.eat('punct', ','));
    }
    this.eat('punct', ')');
    return list;
  }

  args() {
    this.eat('punct', '(');
    const list = [];
    if (!this.is('punct', ')')) {
      do {
        if (this.is('punct', ')')) break;
        if (this.is('id') && this.toks[this.i + 1] && this.toks[this.i + 1].t === 'punct' && this.toks[this.i + 1].v === '=') {
          const name = this.eat('id').v;
          this.eat('punct', '=');
          list.push({ name, expr: this.expr() });
        } else list.push({ name: null, expr: this.expr() });
      } while (this.is('punct', ',') && this.eat('punct', ','));
    }
    this.eat('punct', ')');
    return list;
  }

  expr(min = 0) {
    let left = this.unary();
    while (this.is('punct', '?') && min <= 1) {
      this.eat('punct', '?');
      const then = this.expr(0);
      this.eat('punct', ':');
      const els = this.expr(1);
      left = { t: 'ternary', cond: left, then, else: els };
    }
    while (this.is('punct') && PREC[this.cur().v] >= min && this.cur().v !== '?') {
      const op = this.eat('punct').v;
      const right = this.expr(PREC[op] + 1);
      left = { t: 'bin', op, l: left, r: right };
    }
    return left;
  }

  unary() {
    if (this.is('punct', '!') || this.is('punct', '+') || this.is('punct', '-')) {
      const op = this.eat('punct').v;
      return { t: 'unary', op, v: this.unary() };
    }
    return this.postfix(this.primary());
  }

  postfix(v) {
    while (this.is('punct', '[') || this.is('punct', '.')) {
      if (this.is('punct', '.')) {
        this.eat('punct', '.');
        v = { t: 'dot', v, name: this.eat('id').v };
      } else {
        this.eat('punct', '[');
        const i = this.expr();
        this.eat('punct', ']');
        v = { t: 'index', v, i };
      }
    }
    return v;
  }

  primary() {
    if (this.is('num')) return { t: 'num', v: this.eat('num').v };
    if (this.is('str')) return { t: 'str', v: this.eat('str').v };
    if (this.is('id', 'undef')) { this.eat('id'); return { t: 'undef' }; }
    if (this.is('id', 'true')) { this.eat('id'); return { t: 'bool', v: true }; }
    if (this.is('id', 'false')) { this.eat('id'); return { t: 'bool', v: false }; }
    if (this.is('id')) {
      const name = this.eat('id').v;
      if (this.is('punct', '(')) {
        const args = this.args().map((a) => a.expr);
        return { t: 'call', name, args };
      }
      return { t: 'id', v: name };
    }
    if (this.is('punct', '(')) { this.eat('punct', '('); const e = this.expr(); this.eat('punct', ')'); return e; }
    if (this.is('punct', '[')) return this.list();
    this.fail(`unexpected ${this.cur().v || this.cur().t}`);
  }

  list() {
    this.eat('punct', '[');
    if (this.is('id', 'for') || this.is('id', 'if') || this.is('id', 'let')) {
      const gens = [];
      while (this.is('id', 'for') || this.is('id', 'if') || this.is('id', 'let')) {
        const k = this.eat('id').v;
        this.eat('punct', '(');
        if (k === 'if') gens.push({ t: 'if', cond: this.expr() });
        else gens.push({ t: k, bindings: this.bindings() });
        this.eat('punct', ')');
      }
      const expr = this.expr();
      this.eat('punct', ']');
      return { t: 'comp', gens, expr };
    }
    if (this.is('punct', ']')) { this.eat('punct', ']'); return { t: 'list', items: [] }; }
    const first = this.expr();
    if (this.is('punct', ':')) {
      this.eat('punct', ':');
      const second = this.expr();
      if (this.is('punct', ':')) {
        this.eat('punct', ':');
        const third = this.expr();
        this.eat('punct', ']');
        return { t: 'range', start: first, step: second, end: third };
      }
      this.eat('punct', ']');
      return { t: 'range', start: first, step: null, end: second };
    }
    const items = [first];
    while (this.is('punct', ',') && this.eat('punct', ',')) {
      if (this.is('punct', ']')) break;
      items.push(this.expr());
    }
    this.eat('punct', ']');
    return { t: 'list', items };
  }
}

function lex(text) {
  const toks = [];
  let i = 0;
  let line = 1;
  const push = (t, v) => toks.push({ t, v, line });
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '"' ) {
      let s = '';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') { const e = text[++i]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; i++; }
        else { if (text[i] === '\n') line++; s += text[i++]; }
      }
      i++;
      push('str', s);
      continue;
    }
    if (c === '.' && text[i + 1] >= '0' && text[i + 1] <= '9' || (c >= '0' && c <= '9')) {
      let j = i;
      if (text[j] === '.') j++;
      while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
      if (text[j] === '.' && text[i] !== '.') { j++; while (j < text.length && text[j] >= '0' && text[j] <= '9') j++; }
      if (text[j] === 'e' || text[j] === 'E') {
        j++;
        if (text[j] === '+' || text[j] === '-') j++;
        while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
      }
      push('num', Number(text.slice(i, j)));
      i = j;
      continue;
    }
    if (c === '$' || c === '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j++;
      push('id', text.slice(i, j));
      i = j;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { push('punct', two); i += 2; continue; }
    push('punct', c);
    i++;
  }
  push('eof', '');
  return toks;
}

// Positional names, required then optional, in the order Parameters::parse lists them.
const PARAMS = {
  cube: ['size', 'center'],
  sphere: ['r', 'd'],
  cylinder: ['h', 'r1', 'r2', 'center', 'r', 'd', 'd1', 'd2'],
  square: ['size', 'center'],
  circle: ['r', 'd'],
  polygon: ['points', 'paths', 'convexity'],
  polyhedron: ['points', 'faces', 'convexity'],
  translate: ['v'],
  rotate: ['a', 'v'],
  scale: ['v'],
  mirror: ['v'],
  multmatrix: ['m'],
  color: ['c', 'alpha'],
  linear_extrude: ['height', 'v', 'scale', 'center', 'twist', 'slices', 'segments', 'convexity', 'h'],
  rotate_extrude: ['angle', 'start', 'convexity', 'a'],
  import: ['file', 'layer', 'convexity', 'origin', 'scale'],
  children: ['index'],
  text: ['text', 'size', 'font'],
  offset: ['r'],
  projection: ['cut'],
  resize: ['newsize', 'auto', 'convexity'],
  surface: ['file', 'center', 'convexity'],
};
