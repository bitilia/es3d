// The exact geometry of a STEP boundary representation: every face with its
// surface (plane, cylinder, cone, sphere, torus, linear extrusion, or other)
// and its loops of edges with their curves (line, circle, ellipse, B-spline,
// polyline). Nothing is sampled here; step-exact.js decides what each face
// becomes in ES3D.
//
// B-spline curves that are in fact straight or circular (CAD tools write
// circles as rational quadratic B-splines, and lines as degree-1 splines)
// are recognised as such, so the faces they bound keep exact edges.

import { has, part, coordsOf, directionOf, placementFrame, shellEntries, isFaceEntity, labelOf } from './step.js';

const TAU = Math.PI * 2;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / (len(a) || 1));

const refs = (args) => args.filter((a) => a && a.ref);
const nums = (args) => args.filter((a) => typeof a === 'number');
const lists = (args) => args.filter((a) => Array.isArray(a));
const bools = (args) => args.filter((a) => typeof a === 'boolean');
const get = (entities, ref) => (ref && ref.ref ? entities.get(ref.ref) : null);

/** Radians per unit of plane angle in the file's representation context (1, or π/180 for degrees). */
export function angleFactor(entities) {
  for (const e of entities.values()) {
    const ctx = part(e, 'GLOBAL_UNIT_ASSIGNED_CONTEXT');
    if (!ctx) continue;
    for (const list of lists(ctx.args)) {
      for (const r of list) {
        const u = get(entities, r);
        if (!u || !has(u, 'PLANE_ANGLE_UNIT')) continue;
        const conv = part(u, 'CONVERSION_BASED_UNIT');
        const name = conv && conv.args.find((a) => typeof a === 'string');
        return name && /deg/i.test(name) ? Math.PI / 180 : 1;
      }
    }
  }
  return 1;
}

// --- B-spline curves -------------------------------------------------------------------

function findSpan(n, p, t, U) {
  if (t >= U[n + 1]) return n;
  if (t <= U[p]) return p;
  let lo = p, hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (t < U[mid] || t >= U[mid + 1]) {
    if (t < U[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** A point of a (rational) B-spline curve at parameter t (de Boor in homogeneous coordinates). */
export function evalSpline(c, t) {
  const { degree: p, points: P, knots: U, weights: W } = c;
  const n = P.length - 1;
  const k = findSpan(n, p, t, U);
  const d = [];
  for (let j = 0; j <= p; j++) {
    const i = k - p + j;
    const w = W ? W[i] : 1;
    d.push([P[i][0] * w, P[i][1] * w, P[i][2] * w, w]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const a = (t - U[i]) / (U[i + p - r + 1] - U[i] || 1);
      for (let q = 0; q < 4; q++) d[j][q] = (1 - a) * d[j - 1][q] + a * d[j][q];
    }
  }
  const h = d[p];
  return [h[0] / h[3], h[1] / h[3], h[2] / h[3]];
}

function splineFrom(entities, e) {
  // the simple form keeps everything in one part; the complex form spreads it over several
  let degree, points, mults, knotValues, weights = null;
  const simple = part(e, 'B_SPLINE_CURVE_WITH_KNOTS');
  const base = part(e, 'B_SPLINE_CURVE');
  if (simple && !base) {
    const a = simple.args;
    degree = nums(a)[0];
    const ls = lists(a);
    points = ls[0];
    mults = ls[1];
    knotValues = ls[2];
  } else if (base) {
    degree = nums(base.args)[0];
    points = lists(base.args)[0];
    const kn = simple && lists(simple.args);
    if (!kn) return null;
    mults = kn[0];
    knotValues = kn[1];
    const rat = part(e, 'RATIONAL_B_SPLINE_CURVE');
    if (rat) weights = lists(rat.args)[0];
  } else return null;
  if (!Number.isInteger(degree) || !points || !mults || !knotValues) return null;
  const P = points.map((r) => coordsOf(entities, r));
  if (P.some((p) => !p)) return null;
  const knots = [];
  mults.forEach((m, i) => {
    for (let k = 0; k < m; k++) knots.push(knotValues[i]);
  });
  if (knots.length !== P.length + degree + 1) return null;
  return { kind: 'bspline', degree, points: P, knots, weights: weights && weights.length === P.length ? weights : null };
}

/** The circle through three points, or null when they are on one line. */
function circleThrough(a, b, c) {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn < 1e-24 * dot(ab, ab) * dot(ac, ac)) return null;
  const centre = add(a, mul(add(mul(cross(n, ab), dot(ac, ac)), mul(cross(ac, n), dot(ab, ab))), 1 / (2 * nn)));
  return { centre, normal: unit(n), radius: len(sub(a, centre)) };
}

/** A B-spline that is really a line or a circular arc becomes one; tol is a length. */
function simplifySpline(c, tol) {
  const t0 = c.knots[c.degree];
  const t1 = c.knots[c.knots.length - c.degree - 1];
  const samples = [];
  const N = Math.max(16, c.points.length * 4);
  for (let i = 0; i <= N; i++) samples.push(evalSpline(c, t0 + ((t1 - t0) * i) / N));
  const a = samples[0];
  const b = samples[N];
  const span = len(sub(b, a));
  const dir = span > tol ? unit(sub(b, a)) : null;
  if (dir && samples.every((p) => len(cross(sub(p, a), dir)) <= tol)) return { kind: 'line', point: a, dir };
  const circle = circleThrough(a, samples[N >> 1], span > tol ? b : samples[N >> 2]);
  if (circle && samples.every((p) => Math.abs(len(sub(p, circle.centre)) - circle.radius) <= tol && Math.abs(dot(sub(p, circle.centre), circle.normal)) <= tol)) {
    const x = unit(sub(a, circle.centre));
    // orient the circle so the spline runs counter-clockwise about its axis
    let z = circle.normal;
    const probe = sub(samples[1], circle.centre);
    if (dot(cross(x, probe), z) < 0) z = mul(z, -1);
    return { kind: 'circle', frame: { origin: circle.centre, x, y: cross(z, x), z }, radius: circle.radius, fromSpline: true };
  }
  return c;
}

/**
 * The 3D curve of a curve entity, unwrapping surface curves and trimmed curves.
 * @returns {{kind: string, ...}}
 */
export function readCurve(entities, ref, tol = 1e-6, depth = 0) {
  const e = get(entities, ref);
  if (!e || depth > 6) return { kind: 'other' };
  for (const wrapper of ['SURFACE_CURVE', 'SEAM_CURVE', 'INTERSECTION_CURVE', 'TRIMMED_CURVE', 'BOUNDED_SURFACE_CURVE']) {
    const w = part(e, wrapper);
    if (w && refs(w.args).length) return { ...readCurve(entities, refs(w.args)[0], tol, depth + 1), seam: wrapper === 'SEAM_CURVE' };
  }
  const line = part(e, 'LINE');
  if (line) {
    const [pRef, vRef] = refs(line.args);
    const point = coordsOf(entities, pRef);
    const vec = get(entities, vRef);
    const dir = vec && directionOf(entities, refs(part(vec, 'VECTOR') ? part(vec, 'VECTOR').args : [])[0]);
    if (point && dir) return { kind: 'line', point, dir };
    return { kind: 'other' };
  }
  const circle = part(e, 'CIRCLE');
  if (circle) {
    const frame = placementFrame(entities, refs(circle.args)[0]);
    const radius = nums(circle.args)[0];
    return frame && radius > 0 ? { kind: 'circle', frame, radius } : { kind: 'other' };
  }
  const ellipse = part(e, 'ELLIPSE');
  if (ellipse) {
    const frame = placementFrame(entities, refs(ellipse.args)[0]);
    const [a, b] = nums(ellipse.args);
    return frame && a > 0 && b > 0 ? { kind: 'ellipse', frame, a, b } : { kind: 'other' };
  }
  const poly = part(e, 'POLYLINE');
  if (poly) {
    const pts = (lists(poly.args)[0] || []).map((r) => coordsOf(entities, r));
    return pts.length >= 2 && pts.every(Boolean) ? { kind: 'polyline', points: pts } : { kind: 'other' };
  }
  if (part(e, 'B_SPLINE_CURVE_WITH_KNOTS') || part(e, 'B_SPLINE_CURVE')) {
    const s = splineFrom(entities, e);
    return s ? simplifySpline(s, tol) : { kind: 'other' };
  }
  return { kind: 'other' };
}

// --- surfaces ------------------------------------------------------------------------

/** The surface of a face: kind, frame and its sizes. */
export function readSurface(entities, ref, angle, tol) {
  const e = get(entities, ref);
  if (!e) return { kind: 'other' };
  const frameOf = (p) => placementFrame(entities, refs(p.args)[0]);
  let p;
  if ((p = part(e, 'PLANE'))) {
    const frame = frameOf(p);
    return frame ? { kind: 'plane', frame } : { kind: 'other' };
  }
  if ((p = part(e, 'CYLINDRICAL_SURFACE'))) {
    const frame = frameOf(p);
    const radius = nums(p.args)[0];
    return frame && radius > 0 ? { kind: 'cylinder', frame, radius } : { kind: 'other' };
  }
  if ((p = part(e, 'CONICAL_SURFACE'))) {
    const frame = frameOf(p);
    const [radius, semi] = nums(p.args);
    return frame && radius >= 0 && semi > 0 ? { kind: 'cone', frame, radius, semiAngle: semi * angle } : { kind: 'other' };
  }
  if ((p = part(e, 'SPHERICAL_SURFACE'))) {
    const frame = frameOf(p);
    const radius = nums(p.args)[0];
    return frame && radius > 0 ? { kind: 'sphere', frame, radius } : { kind: 'other' };
  }
  if ((p = part(e, 'TOROIDAL_SURFACE'))) {
    const frame = frameOf(p);
    const [major, minor] = nums(p.args);
    return frame && major > 0 && minor > 0 ? { kind: 'torus', frame, major, minor } : { kind: 'other' };
  }
  if ((p = part(e, 'SURFACE_OF_LINEAR_EXTRUSION'))) {
    const [cRef, vRef] = refs(p.args);
    const curve = readCurve(entities, cRef, tol);
    const vec = get(entities, vRef);
    const vp = vec && part(vec, 'VECTOR');
    const dir = vp && directionOf(entities, refs(vp.args)[0]);
    return dir ? { kind: 'extrusion', curve, dir } : { kind: 'other' };
  }
  if (part(e, 'B_SPLINE_SURFACE_WITH_KNOTS') || part(e, 'B_SPLINE_SURFACE')) {
    const sp = splineSurfaceFrom(entities, e);
    if (sp) return sp;
  }
  const names = e.parts.map((x) => x.name);
  return { kind: 'other', type: names.find((n) => n.includes('SURFACE')) || names[0] };
}

function expandKnots(mults, values) {
  const out = [];
  mults.forEach((m, i) => {
    for (let k = 0; k < m; k++) out.push(values[i]);
  });
  return out;
}

function splineSurfaceFrom(entities, e) {
  let du, dv, grid, um, vm, uk, vk, weights = null;
  const simple = part(e, 'B_SPLINE_SURFACE_WITH_KNOTS');
  const base = part(e, 'B_SPLINE_SURFACE');
  if (simple && !base) {
    [du, dv] = nums(simple.args);
    const ls = lists(simple.args);
    [grid, um, vm, uk, vk] = ls;
  } else if (base && simple) {
    [du, dv] = nums(base.args);
    grid = lists(base.args)[0];
    [um, vm, uk, vk] = lists(simple.args);
    const rat = part(e, 'RATIONAL_B_SPLINE_SURFACE');
    if (rat) weights = lists(rat.args)[0];
  } else return null;
  if (!grid || !um || !vm || !uk || !vk) return null;
  const P = grid.map((row) => row.map((r) => coordsOf(entities, r)));
  if (P.some((row) => row.some((p) => !p))) return null;
  const U = expandKnots(um, uk);
  const V = expandKnots(vm, vk);
  if (U.length !== P.length + du + 1 || V.length !== P[0].length + dv + 1) return null;
  return { kind: 'bspline', du, dv, points: P, U, V, weights: weights && weights.length === P.length ? weights : null };
}

/** A point of a (rational) B-spline surface at (u, v). */
export function evalSplineSurface(s, u, v) {
  // a curve in u through the points each row of v makes
  const rows = s.points.map((row, i) => {
    const w = s.weights ? s.weights[i] : null;
    const curve = { degree: s.dv, points: row.map((p, j) => (w ? [p[0] * w[j], p[1] * w[j], p[2] * w[j]] : p)), knots: s.V, weights: null };
    const pt = evalSpline(curve, v);
    const weight = w ? evalSpline({ degree: s.dv, points: w.map((x) => [x, 0, 0]), knots: s.V, weights: null }, v)[0] : 1;
    return [pt, weight];
  });
  const hp = evalSpline({ degree: s.du, points: rows.map(([p]) => p), knots: s.U, weights: null }, u);
  if (!s.weights) return hp;
  const hw = evalSpline({ degree: s.du, points: rows.map(([, w]) => [w, 0, 0]), knots: s.U, weights: null }, u)[0];
  return [hp[0] / hw, hp[1] / hw, hp[2] / hw];
}

// --- edges, loops, faces ---------------------------------------------------------------

/**
 * One edge of a loop, in the order the loop walks it.
 * @returns {{curve: object, start: number[], end: number[], forward: boolean}|null}
 *   forward: the loop walks the edge in the curve's own direction
 */
function readEdge(entities, item, tol) {
  let e = get(entities, item);
  if (!e) return null;
  let orientation = true;
  const oe = part(e, 'ORIENTED_EDGE');
  if (oe) {
    if (bools(oe.args).pop() === false) orientation = false;
    e = get(entities, refs(oe.args).pop());
    if (!e) return null;
  }
  const ec = part(e, 'EDGE_CURVE');
  if (!ec) return null;
  const [v0, v1, cRef] = refs(ec.args);
  const sameSense = bools(ec.args).pop() !== false;
  const a = coordsOf(entities, v0);
  const b = coordsOf(entities, v1);
  if (!a || !b) return null;
  const curve = readCurve(entities, cRef, tol);
  return orientation ? { curve, start: a, end: b, forward: sameSense } : { curve, start: b, end: a, forward: !sameSense };
}

function readLoop(entities, bound, tol) {
  const b = part(bound, 'FACE_OUTER_BOUND') || part(bound, 'FACE_BOUND');
  if (!b) return null;
  const loop = get(entities, refs(b.args)[0]);
  const orientation = bools(b.args).pop() !== false;
  if (!loop) return null;
  const outer = !!part(bound, 'FACE_OUTER_BOUND');
  if (part(loop, 'VERTEX_LOOP')) {
    const p = coordsOf(entities, refs(part(loop, 'VERTEX_LOOP').args)[0]);
    return p ? { outer, vertex: p, edges: [] } : null;
  }
  if (part(loop, 'POLY_LOOP')) {
    const pts = (lists(part(loop, 'POLY_LOOP').args)[0] || []).map((r) => coordsOf(entities, r));
    if (pts.length < 3 || pts.some((p) => !p)) return null;
    const ring = orientation ? pts : pts.slice().reverse();
    return { outer, edges: ring.map((p, i) => ({ curve: { kind: 'line', point: p, dir: unit(sub(ring[(i + 1) % ring.length], p)) }, start: p, end: ring[(i + 1) % ring.length], forward: true })) };
  }
  const el = part(loop, 'EDGE_LOOP');
  if (!el) return null;
  const edges = [];
  for (const item of lists(el.args)[0] || []) {
    const edge = readEdge(entities, item, tol);
    if (!edge) return null;
    edges.push(edge);
  }
  if (!orientation) {
    edges.reverse();
    for (const ed of edges) {
      [ed.start, ed.end] = [ed.end, ed.start];
      ed.forward = !ed.forward;
    }
  }
  return { outer, edges };
}

/**
 * A face: its surface, whether its outward side is the surface's normal side
 * (`sense`), and its loops (the first one the outer bound when the file says so).
 */
function readFace(entities, entry, angle, tol) {
  const f = entry.face;
  const fp = part(f, 'ADVANCED_FACE') || part(f, 'FACE_SURFACE') || part(f, 'FACE');
  const bounds = (lists(fp.args)[0] || []).map((r) => get(entities, r)).filter(Boolean);
  const surfRef = refs(fp.args).find((r) => !bounds.some((b) => b.id === r.ref));
  const surface = surfRef ? readSurface(entities, surfRef, angle, tol) : { kind: 'unbounded' };
  const sameSense = bools(fp.args).pop() !== false;
  const loops = [];
  for (const b of bounds) {
    const loop = readLoop(entities, b, tol);
    if (!loop) return { id: f.id, surface: { kind: 'other' }, loops: [], sense: true, broken: true };
    loops.push(loop);
  }
  loops.sort((a, b) => (b.outer ? 1 : 0) - (a.outer ? 1 : 0));
  // a faceted face names no surface: its plane is the one its largest loop turns around
  if (surface.kind === 'unbounded') return { id: f.id, surface: planeOfLoops(loops) || { kind: 'other' }, sense: !entry.flip, loops };
  return { id: f.id, surface, sense: sameSense !== entry.flip, loops };
}

function planeOfLoops(loops) {
  let best = null;
  let bestLen = 0;
  for (const loop of loops) {
    if (!loop.edges.length || loop.edges.some((e) => e.curve.kind !== 'line')) return null;
    const pts = loop.edges.map((e) => e.start);
    const n = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    if (len(n) > bestLen) {
      bestLen = len(n);
      best = { pts, n };
    }
  }
  if (!best || bestLen === 0) return null;
  const z = unit(best.n);
  const d = sub(best.pts[1], best.pts[0]);
  const x = unit(sub(d, mul(z, dot(d, z))));
  return { kind: 'plane', frame: { origin: best.pts[0], x, y: cross(z, x), z } };
}

/** Largest coordinate in the file's points, for tolerances. */
function extentOf(entities) {
  let m = 0;
  for (const e of entities.values()) {
    const cp = part(e, 'CARTESIAN_POINT');
    if (!cp) continue;
    const l = lists(cp.args)[0];
    if (l) for (const v of l) if (typeof v === 'number') m = Math.max(m, Math.abs(v));
  }
  return m || 1;
}

/**
 * Shells of the B-rep, each with its faces in exact form.
 * @returns {{shells: {id: number, name: string, closed: boolean, faces: object[]}[], tol: number}}
 */
export function readBrep(entities) {
  const tol = extentOf(entities) * 1e-7;
  const angle = angleFactor(entities);
  const shells = [];
  const used = new Set();
  for (const e of entities.values()) {
    const kind = ['CLOSED_SHELL', 'OPEN_SHELL', 'CONNECTED_FACE_SET'].find((k) => has(e, k));
    if (!kind) continue;
    const faces = [];
    for (const entry of shellEntries(entities, e)) {
      used.add(entry.face.id);
      faces.push(readFace(entities, entry, angle, tol));
    }
    if (faces.length) shells.push({ id: e.id, name: labelOf(e), closed: kind === 'CLOSED_SHELL', faces });
  }
  const loose = [];
  for (const e of entities.values()) if (isFaceEntity(e) && !used.has(e.id)) loose.push(readFace(entities, { face: e, flip: false }, angle, tol));
  if (loose.length) shells.push({ id: 0, name: '', closed: false, faces: loose });
  return { shells, tol };
}

