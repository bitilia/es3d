// STEP solids to procedural ES3D, from their exact geometry (step-brep.js).
//
// A CAD part is a boundary of faces. Each shell is written as the most
// direct ES3D it can be:
//
//   1. one shape when the whole shell is one: a box or an <extrude> (a prism:
//      two matching flat caps and straight walls, with holes, arcs, ellipses
//      and splines in the outline), a <cylinder>, <cone>, <sphere>, <torus>
//      or a <revolve> (a turned part: every face a surface of revolution
//      about one axis, or a flat ring across it);
//   2. otherwise face by face: a flat face is a <path> (lines, circular and
//      elliptical arcs, Bézier curves, holes as subpaths); a cylindrical,
//      conical, spherical or toroidal face bounded along its own circles and
//      meridians (a fillet, a hole wall, a rounded corner) is a <revolve> of
//      its meridian through the angle it spans;
//   3. a face that ES3D v1 cannot describe exactly (a free-form NURBS
//      surface, or a curved face cut along a curve that is not one of its
//      circles or meridians, such as the rim of a cross hole) is tessellated
//      from its exact surface into a <mesh>, and counted in the note.
//
// Coordinates stay in the file's unit and frame. A Z-up file is turned Y-up
// by a rotation on the group that holds it, so every number is the CAD
// tool's own.

import { parseSTEP, colourMap, ownerIndex, inheritedColour, productName } from './step.js';
import { readBrep, evalSpline, evalSplineSurface } from './step-brep.js';
import { h, Document, Comment } from '../format/ast.js';
import { serialize } from '../format/serializer.js';
import { formatNumber } from '../format/value-format.js';
import { colorToHex } from '../format/colors.js';
import { matrixToEuler } from '../transform/transform.js';
import * as mat4 from '../math/mat4.js';

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / (len(a) || 1));
const neg = (a) => [-a[0], -a[1], -a[2]];
/** angle in (0, 2π] (a whole turn stays a whole turn) */
const turn = (a) => {
  const m = a - TAU * Math.floor(a / TAU);
  return m <= 1e-12 ? TAU : m;
};

const UNIT = { millimetres: 'mm', centimetres: 'cm', metres: 'm', kilometres: 'km', inch: 'in', inches: 'in', foot: 'ft', feet: 'ft' };

// --- placement ---------------------------------------------------------------------------

/**
 * position and rotation of a frame (X, Y, Z axes at origin), and the frame a
 * reader builds back from the rounded angles, for measuring local coordinates.
 */
function placement(origin, X, Y, Z, fmt) {
  const m = [X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, 0, 0, 0, 1];
  const e = matrixToEuler(m);
  const rot = e.rotation.map((a) => {
    const r = Number(formatNumber(a, 6));
    return r === -180 ? 180 : r === 0 ? 0 : r;
  });
  const R = mat4.fromEulerDeg(mat4.createF64(), rot[0], rot[1], rot[2]);
  const attrs = {};
  if (origin.some((v) => v !== 0)) attrs.position = origin.map(fmt).join(',');
  if (rot.some((v) => v !== 0)) attrs.rotation = rot.map((v) => formatNumber(v)).join(',');
  return { attrs, frame: { o: origin, x: [R[0], R[1], R[2]], y: [R[4], R[5], R[6]], z: [R[8], R[9], R[10]] } };
}

const localOf = (frame) => (p) => {
  const d = sub(p, frame.o);
  return [dot(d, frame.x), dot(d, frame.y)];
};

// --- edges as 2D path data ----------------------------------------------------------------

/** Insert knots until every interior knot is full: the Bézier segments of a polynomial spline. */
function bezierSegments(c) {
  const p = c.degree;
  let P = c.points.map((q) => q.slice());
  let U = c.knots.slice();
  const interior = [...new Set(U.slice(p + 1, U.length - p - 1))];
  for (const t of interior) {
    let mult = U.filter((u) => Math.abs(u - t) < 1e-14).length;
    while (mult < p) {
      const k = U.findIndex((u) => u > t) - 1;
      const Q = [];
      for (let i = 0; i < P.length + 1; i++) {
        if (i <= k - p) Q.push(P[i]);
        else if (i > k) Q.push(P[i - 1]);
        else {
          const a = (t - U[i]) / (U[i + p] - U[i]);
          Q.push(add(mul(P[i - 1], 1 - a), mul(P[i], a)));
        }
      }
      P = Q;
      U.splice(k + 1, 0, t);
      mult++;
    }
  }
  const segs = [];
  for (let i = 0; i + p < P.length; i += p) segs.push(P.slice(i, i + p + 1));
  return segs;
}

const polynomial = (c) => !c.weights || c.weights.every((w) => Math.abs(w - c.weights[0]) < 1e-12 * Math.abs(c.weights[0]));

/** Points along an edge, start to end, for curves without an exact form. */
function sampleEdge(e, n = 24) {
  const c = e.curve;
  if (c.kind === 'line') return [e.start, e.end];
  if (c.kind === 'polyline') return e.forward ? c.points : c.points.slice().reverse();
  if (c.kind === 'circle' || c.kind === 'ellipse') {
    const a = c.kind === 'circle' ? c.radius : c.a;
    const b = c.kind === 'circle' ? c.radius : c.b;
    const f = c.frame;
    const param = (p) => {
      const d = sub(p, f.origin);
      return Math.atan2(dot(d, f.y) / b, dot(d, f.x) / a);
    };
    const t0 = param(e.start);
    const t1 = param(e.end);
    const closed = len(sub(e.start, e.end)) < 1e-9 * (a + b);
    const span = closed ? (e.forward ? TAU : -TAU) : e.forward ? turn(t1 - t0) : -turn(t0 - t1);
    const m = Math.max(n, Math.ceil(Math.abs(span) / (Math.PI / 36)));
    const out = [];
    for (let i = 0; i <= m; i++) {
      const t = t0 + (span * i) / m;
      out.push(add(f.origin, add(mul(f.x, a * Math.cos(t)), mul(f.y, b * Math.sin(t)))));
    }
    out[0] = e.start;
    out[m] = e.end;
    return out;
  }
  if (c.kind === 'bspline') {
    const t0 = c.knots[c.degree];
    const t1 = c.knots[c.knots.length - c.degree - 1];
    const m = Math.max(n, c.points.length * 6);
    const out = [];
    for (let i = 0; i <= m; i++) out.push(evalSpline(c, t0 + ((t1 - t0) * i) / m));
    if (!e.forward) out.reverse();
    out[0] = e.start;
    out[m] = e.end;
    return out;
  }
  return null;
}

/**
 * Path data for one edge of a flat face, from the current point (the edge's
 * start) to its end. `exact` is false when the curve was sampled.
 */
function edgeData(e, frame, L, fmt, tol) {
  const c = e.curve;
  const P = (p) => `${fmt(p[0])},${fmt(p[1])}`;
  const end = L(e.end);
  if (c.kind === 'line') return { d: `L${P(end)}`, exact: true };
  if (c.kind === 'polyline') return { d: (e.forward ? c.points.slice(1) : c.points.slice(0, -1).reverse()).map((p) => `L${P(L(p))}`).join(''), exact: true };
  if ((c.kind === 'circle' || c.kind === 'ellipse') && Math.abs(Math.abs(dot(c.frame.z, frame.z)) - 1) < 1e-9) {
    const a = c.kind === 'circle' ? c.radius : c.a;
    const b = c.kind === 'circle' ? c.radius : c.b;
    const f = c.frame;
    const ccw = e.forward === dot(f.z, frame.z) > 0;
    const param = (p) => {
      const d = sub(p, f.origin);
      return Math.atan2(dot(d, f.y) / b, dot(d, f.x) / a);
    };
    const t0 = param(e.start);
    const rot = c.kind === 'circle' ? 0 : Math.atan2(dot(f.x, frame.y), dot(f.x, frame.x)) * DEG;
    const arc = (to, large) => `A${fmt(a)},${fmt(b)} ${c.kind === 'circle' ? 0 : formatNumber(rot, 6)} ${large ? 1 : 0},${ccw ? 1 : 0} ${P(to)}`;
    if (len(sub(e.start, e.end)) <= tol) {
      // a whole circle: two half turns
      const tm = t0 + Math.PI;
      const mid = add(f.origin, add(mul(f.x, a * Math.cos(tm)), mul(f.y, b * Math.sin(tm))));
      return { d: arc(L(mid), false) + arc(end, false), exact: true };
    }
    const t1 = param(e.end);
    const span = ccw === (dot(f.z, frame.z) > 0) ? turn(t1 - t0) : turn(t0 - t1);
    return { d: arc(end, span > Math.PI + 1e-12), exact: true };
  }
  if (c.kind === 'bspline' && polynomial(c) && c.degree <= 3) {
    let segs = bezierSegments(c);
    if (!e.forward) segs = segs.reverse().map((s) => s.slice().reverse());
    const cmd = c.degree === 1 ? 'L' : c.degree === 2 ? 'Q' : 'C';
    return { d: segs.map((s) => cmd + s.slice(1).map((p) => P(L(p))).join(' ')).join(''), exact: true };
  }
  const pts = sampleEdge(e);
  if (!pts) return null;
  return { d: pts.slice(1).map((p) => `L${P(L(p))}`).join(''), exact: false };
}

/** A flat face as a <path> in its plane. */
function planarFace(face, fmt, tol) {
  const s = face.surface.frame;
  const z = face.sense ? s.z : neg(s.z);
  const { attrs, frame } = placement(s.origin, s.x, cross(z, s.x), z, fmt);
  const L = localOf(frame);
  const subpaths = [];
  let exact = true;
  for (const loop of face.loops) {
    if (!loop.edges.length) continue;
    let d = `M${fmt(L(loop.edges[0].start)[0])},${fmt(L(loop.edges[0].start)[1])}`;
    for (const e of loop.edges) {
      const seg = edgeData(e, frame, L, fmt, tol);
      if (!seg) return null;
      d += seg.d;
      exact = exact && seg.exact;
    }
    subpaths.push(`${d}Z`);
  }
  if (!subpaths.length) return null;
  attrs.d = subpaths.join(' ');
  if (subpaths.length > 1) attrs.fillRule = 'evenodd';
  return { el: h('path', attrs), exact };
}

// --- faces of revolution ---------------------------------------------------------------------

/** Where a point is on a surface of revolution: azimuth u, and v (height, or latitude on spheres and tori). */
function revolutionCoords(s) {
  const f = s.frame;
  return (p) => {
    const d = sub(p, f.origin);
    const hgt = dot(d, f.z);
    const x = dot(d, f.x);
    const y = dot(d, f.y);
    const rho = Math.hypot(x, y);
    const u = Math.atan2(y, x);
    if (s.kind === 'sphere') return { u, v: Math.atan2(hgt, rho), rho, h: hgt };
    if (s.kind === 'torus') return { u, v: Math.atan2(hgt, rho - s.major), rho, h: hgt };
    return { u, v: hgt, rho, h: hgt };
  };
}

/** A point along an edge at fraction t (0 start, 1 end). */
function edgeAt(e, t) {
  const pts = sampleEdge(e, 8);
  if (!pts) return null;
  const x = t * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(x));
  const f = x - i;
  return add(mul(pts[i], 1 - f), mul(pts[i + 1], f));
}

/** The CCW interval from a to b that holds probe: [start, span]. */
function intervalHolding(a, b, probe) {
  const s1 = turn(b - a);
  return turn(probe - a) < s1 ? [a, s1] : [b, turn(a - b)];
}

/**
 * A face of a cylinder, cone, sphere or torus bounded only along its own
 * circles (parallels) and meridians: the ranges of u and v it covers.
 * Null when an edge runs any other way.
 */
function revolutionPatch(face, tol) {
  const s = face.surface;
  const f = s.frame;
  const at = revolutionCoords(s);
  const parallels = [];
  const meridians = [];
  let seamU = false;
  let seamV = false;
  const poles = [];
  const curves = new Map();
  for (const loop of face.loops) {
    if (loop.vertex) poles.push(at(loop.vertex));
    for (const e of loop.edges) {
      const c = e.curve;
      const key = c.kind === 'circle' ? `${c.frame.origin.map((x) => x.toFixed(9))}:${c.radius.toFixed(9)}` : null;
      if (len(sub(e.start, e.end)) <= tol && c.kind === 'line') continue;
      if (c.kind === 'circle' && Math.abs(Math.abs(dot(c.frame.z, f.z)) - 1) < 1e-7 && at(c.frame.origin).rho <= tol * 10) {
        const closed = len(sub(e.start, e.end)) <= tol;
        const ccw = e.forward === dot(c.frame.z, f.z) > 0;
        const u0 = at(e.start).u;
        const u1 = at(e.end).u;
        parallels.push({ e, v: at(edgeAt(e, 0.5)).v, closed, interval: closed ? null : ccw ? [u0, turn(u1 - u0)] : [u1, turn(u0 - u1)] });
        if (c.seam || (key && curves.has(key) && closed)) seamV = true;
        if (key) curves.set(key, true);
        continue;
      }
      const a = at(e.start);
      const b = at(e.end);
      const m = at(edgeAt(e, 0.5));
      const sameU = (p, q) => Math.abs(Math.sin(p.u - q.u)) < 1e-7 && Math.cos(p.u - q.u) > 0;
      const onAxis = (p) => p.rho <= tol * 10;
      const meridianLine = c.kind === 'line' && (s.kind === 'cylinder' || s.kind === 'cone') && (sameU(a, b) || onAxis(a) || onAxis(b)) && (onAxis(m) || sameU(m, onAxis(a) ? b : a));
      const meridianArc = c.kind === 'circle' && (s.kind === 'sphere' || s.kind === 'torus') && Math.abs(dot(c.frame.z, f.z)) < 1e-7 && (onAxis(a) || onAxis(b) || sameU(a, b)) && (onAxis(m) || sameU(m, onAxis(a) ? b : a));
      if (meridianLine || meridianArc) {
        meridians.push({ e, u: onAxis(a) ? b.u : a.u, a, b, m });
        if (c.seam) seamU = true;
        continue;
      }
      return null;
    }
  }
  // two meridians at one azimuth walked both ways are the seam of a whole turn
  for (let i = 0; i < meridians.length; i++) {
    for (let j = i + 1; j < meridians.length; j++) {
      if (Math.abs(Math.sin(meridians[i].u - meridians[j].u)) < 1e-7 && Math.cos(meridians[i].u - meridians[j].u) > 0) seamU = true;
    }
  }

  // azimuth range
  let u0 = 0;
  let uSpan = TAU;
  if (!seamU && !parallels.some((p) => p.closed)) {
    const open = parallels.filter((p) => p.interval);
    if (open.length) [u0, uSpan] = open.reduce((best, p) => (p.interval[1] > best[1] ? p.interval : best), open[0].interval);
    else if (meridians.length >= 2) {
      const us = [...new Set(meridians.map((m) => Number(m.u.toFixed(9))))];
      if (us.length !== 2) return null;
      const probe = interiorProbe(face, meridians[0].e, at);
      if (probe === null) return null;
      [u0, uSpan] = intervalHolding(us[0], us[1], probe.u);
    }
  }

  // range across: heights on cylinders and cones, latitudes on spheres and tori
  let v0;
  let v1;
  if (s.kind === 'torus') {
    const arcs = meridians.filter((m) => !m.e.curve.seam);
    if (seamV || (!arcs.length && parallels.length < 2)) [v0, v1] = [-Math.PI, Math.PI];
    else if (arcs.length) {
      const m = arcs[0];
      const [start, span] = intervalHolding(m.a.v, m.b.v, m.m.v);
      [v0, v1] = [start, start + span];
    } else {
      const vs = [...new Set(parallels.map((p) => Number(p.v.toFixed(9))))];
      if (vs.length !== 2) return null;
      const probe = interiorProbe(face, parallels[0].e, at);
      if (probe === null) return null;
      const [start, span] = intervalHolding(vs[0], vs[1], probe.v);
      [v0, v1] = [start, start + span];
    }
  } else {
    const vs = [];
    for (const p of parallels) vs.push(p.v);
    for (const m of meridians) vs.push(m.a.v, m.b.v);
    for (const p of poles) vs.push(p.v);
    if (s.kind === 'sphere' && !vs.length) vs.push(-Math.PI / 2, Math.PI / 2);
    if (s.kind === 'sphere' && poles.length === 1 && !parallels.length && !meridians.length) vs.push(-poles[0].v);
    if (vs.length < 2) return null;
    v0 = Math.min(...vs);
    v1 = Math.max(...vs);
    if (v1 - v0 <= tol) return null;
  }
  return { u0, uSpan, v0, v1 };
}

/** Coordinates of a point just inside the face, beside the middle of edge e. */
function interiorProbe(face, e, at) {
  const p0 = edgeAt(e, 0.45);
  const p1 = edgeAt(e, 0.55);
  const m = edgeAt(e, 0.5);
  if (!p0 || !p1 || !m) return null;
  const s = face.surface;
  const f = s.frame;
  // the outward normal at m
  const d = sub(m, f.origin);
  const radial = unit(sub(d, mul(f.z, dot(d, f.z))));
  let n;
  if (s.kind === 'cylinder') n = radial;
  else if (s.kind === 'cone') n = unit(sub(mul(radial, Math.cos(s.semiAngle)), mul(f.z, Math.sin(s.semiAngle))));
  else if (s.kind === 'sphere') n = unit(d);
  else n = unit(sub(d, mul(radial, s.major)));
  if (!face.sense) n = neg(n);
  const t = unit(sub(p1, p0));
  const inward = unit(cross(n, t));
  const step = Math.max(len(sub(p1, p0)), 1e-9);
  return at(add(m, mul(inward, step)));
}

/** The profile of a patch in (radius, height) about its axis: a line or an arc. */
function patchProfile(s, v0, v1) {
  if (s.kind === 'cylinder') return { kind: 'line', a: [s.radius, v0], b: [s.radius, v1] };
  if (s.kind === 'cone') {
    const r = (v) => Math.max(0, s.radius + v * Math.tan(s.semiAngle));
    return { kind: 'line', a: [r(v0), v0], b: [r(v1), v1] };
  }
  const c = s.kind === 'sphere' ? [0, 0] : [s.major, 0];
  const r = s.kind === 'sphere' ? s.radius : s.minor;
  const pt = (v) => [c[0] + r * Math.cos(v), c[1] + r * Math.sin(v)];
  return { kind: 'arc', centre: c, radius: r, a: pt(v0), b: pt(v1), span: v1 - v0, v0 };
}

function profileData(p, fmt, move = true) {
  const P = (q) => `${fmt(Math.max(0, q[0]))},${fmt(q[1])}`;
  const head = move ? `M${P(p.a)}` : '';
  if (p.kind === 'line') return `${head}L${P(p.b)}`;
  const arc = (to, large) => `A${fmt(p.radius)},${fmt(p.radius)} 0 ${large ? 1 : 0},1 ${P(to)}`;
  if (p.span >= TAU - 1e-9) {
    const mid = [p.centre[0] + p.radius * Math.cos(p.v0 + Math.PI), p.centre[1] + p.radius * Math.sin(p.v0 + Math.PI)];
    return `${head}${arc(mid, false)}${arc(p.b, false)}`;
  }
  return `${head}${arc(p.b, p.span > Math.PI + 1e-12)}`;
}

/** A face of revolution as an open <revolve> through the angle it spans. */
function revolveFace(face, fmt, tol) {
  const patch = revolutionPatch(face, tol);
  if (!patch) return null;
  const s = face.surface;
  const f = s.frame;
  const X = add(mul(f.x, Math.cos(patch.u0)), mul(f.y, Math.sin(patch.u0)));
  const { attrs } = placement(f.origin, X, f.z, cross(X, f.z), fmt);
  attrs.d = profileData(patchProfile(s, patch.v0, patch.v1), fmt);
  if (patch.uSpan < TAU - 1e-9) attrs.angle = formatNumber(patch.uSpan * DEG, 6);
  return { el: h('revolve', attrs), exact: true };
}

// --- whole solids ----------------------------------------------------------------------------

const parallelDir = (a, b) => Math.abs(Math.abs(dot(a, b)) - 1) < 1e-7;
const REVOLUTION = new Set(['cylinder', 'cone', 'sphere', 'torus']);

/** A shell that is one sphere or one torus. */
function primitiveSolid(shell, fmt, tol) {
  if (shell.faces.length !== 1) return null;
  const face = shell.faces[0];
  const s = face.surface;
  if (s.kind !== 'sphere' && s.kind !== 'torus') return null;
  const patch = revolutionPatch(face, tol);
  if (!patch || patch.uSpan < TAU - 1e-9) return null;
  if (s.kind === 'sphere') {
    if (patch.v1 - patch.v0 < Math.PI - 1e-7) return null;
    const attrs = { radius: fmt(s.radius) };
    if (s.frame.origin.some((v) => v !== 0)) attrs.position = s.frame.origin.map(fmt).join(',');
    return h('sphere', attrs);
  }
  if (patch.v1 - patch.v0 < TAU - 1e-7) return null;
  const { attrs } = placement(s.frame.origin, s.frame.x, s.frame.z, cross(s.frame.x, s.frame.z), fmt);
  return h('torus', { ...attrs, radius: fmt(s.major), tube: fmt(s.minor) });
}

/**
 * A turned part: every face a whole turn of a surface of revolution about one
 * axis, or a flat ring or disc across it. Written as a cylinder, a cone or a
 * <revolve> of the profile the faces make in (radius, height).
 */
function revolvedSolid(shell, fmt, tol) {
  const axisFace = shell.faces.find((fc) => REVOLUTION.has(fc.surface.kind));
  if (!axisFace) return null;
  const O = axisFace.surface.frame.origin;
  // the axis points up (or along the first axis it has a part of), so the profile reads bottom to top
  let Z = axisFace.surface.frame.z;
  const lead = Math.abs(Z[2]) > 1e-9 ? Z[2] : Math.abs(Z[1]) > 1e-9 ? Z[1] : Z[0];
  if (lead < 0) Z = neg(Z);
  const onAxis = (p) => len(cross(sub(p, O), Z)) <= tol * 10;
  const H = (p) => dot(sub(p, O), Z);
  const segments = [];
  for (const face of shell.faces) {
    const s = face.surface;
    if (REVOLUTION.has(s.kind)) {
      if (!parallelDir(s.frame.z, Z) || !onAxis(s.frame.origin)) return null;
      const patch = revolutionPatch(face, tol);
      if (!patch || patch.uSpan < TAU - 1e-9) return null;
      const p = patchProfile(s, patch.v0, patch.v1);
      // the face's own axis may point the other way or start elsewhere
      const flip = dot(s.frame.z, Z) < 0 ? -1 : 1;
      const shift = H(s.frame.origin);
      const map = (q) => [q[0], shift + flip * q[1]];
      if (p.kind === 'line') segments.push({ kind: 'line', a: map(p.a), b: map(p.b) });
      else segments.push({ kind: 'arc', centre: map(p.centre), radius: p.radius, a: map(p.a), b: map(p.b), ccw: flip > 0, span: p.span });
    } else if (s.kind === 'plane') {
      if (!parallelDir(s.frame.z, Z)) return null;
      const radii = [];
      for (const loop of face.loops) {
        for (const e of loop.edges) {
          if (e.curve.kind !== 'circle' || !parallelDir(e.curve.frame.z, Z) || !onAxis(e.curve.frame.origin)) return null;
          radii.push(e.curve.radius);
        }
      }
      if (!radii.length) return null;
      const hgt = H(s.frame.origin);
      segments.push({ kind: 'line', a: [radii.length > 1 ? Math.min(...radii) : 0, hgt], b: [Math.max(...radii), hgt] });
    } else return null;
  }
  // chain the pieces into one profile
  const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol * 10;
  const left = segments.slice();
  const start = left.findIndex((sg) => sg.a[0] <= tol * 10 || sg.b[0] <= tol * 10);
  const chain = [];
  let cur = left.splice(start >= 0 ? start : 0, 1)[0];
  if (cur.b[0] <= tol * 10 && !(cur.a[0] <= tol * 10)) cur = reverseSegment(cur);
  chain.push(cur);
  while (left.length) {
    const end = chain[chain.length - 1].b;
    const i = left.findIndex((sg) => same(sg.a, end) || same(sg.b, end));
    if (i < 0) return null;
    let next = left.splice(i, 1)[0];
    if (!same(next.a, end)) next = reverseSegment(next);
    chain.push(next);
  }
  const first = chain[0].a;
  const last = chain[chain.length - 1].b;
  const touchesAxis = first[0] <= tol * 10 && last[0] <= tol * 10;
  if (!touchesAxis && !same(first, last)) return null;
  // a frame on the axis at the lowest height
  const hs = chain.flatMap((sg) => [sg.a[1], sg.b[1]]);
  const base = Math.min(...hs);
  const origin = add(O, mul(Z, base));
  const X = unit(Math.abs(Z[0]) < 0.9 ? cross([0, 1, 0], Z) : cross(Z, [0, 0, 1]));
  const lines = chain.every((sg) => sg.kind === 'line');
  const rs = chain.map((sg) => [sg.a, sg.b]).flat();
  // cylinder: disc, wall, disc; cone and frustum likewise
  if (lines && touchesAxis && chain.length === 3) {
    const [d0, wall, d1] = chain;
    if (Math.abs(d0.a[1] - d0.b[1]) <= tol && Math.abs(d1.a[1] - d1.b[1]) <= tol) {
      const r0 = wall.a[0];
      const r1 = wall.b[0];
      const lowFirst = wall.a[1] < wall.b[1];
      const height = Math.abs(wall.b[1] - wall.a[1]);
      const centre = add(origin, mul(Z, height / 2));
      const { attrs } = placement(centre, X, Z, cross(X, Z), fmt);
      const [bottom, top] = lowFirst ? [r0, r1] : [r1, r0];
      if (Math.abs(bottom - top) <= tol) return { el: h('cylinder', { ...attrs, radius: fmt(bottom), height: fmt(height) }), kind: 'cylinder' };
      return { el: h('cylinder', { ...attrs, radius: fmt(bottom), radiusTop: fmt(top), height: fmt(height) }), kind: 'cylinder' };
    }
  }
  if (lines && touchesAxis && chain.length === 2) {
    const flat = chain.find((sg) => Math.abs(sg.a[1] - sg.b[1]) <= tol);
    const slope = chain.find((sg) => sg !== flat);
    if (flat && slope) {
      const height = Math.abs(slope.a[1] - slope.b[1]);
      const apexUp = Math.max(slope.a[1], slope.b[1]) > flat.a[1];
      const centre = add(origin, mul(Z, height / 2));
      const Y = apexUp ? Z : neg(Z);
      const { attrs } = placement(centre, X, Y, cross(X, Y), fmt);
      return { el: h('cone', { ...attrs, radius: fmt(Math.max(...rs.map((p) => p[0]))), height: fmt(height) }), kind: 'cone' };
    }
  }
  const { attrs } = placement(origin, X, Z, cross(X, Z), fmt);
  const shifted = chain.map((sg) => ({ ...sg, a: [sg.a[0], sg.a[1] - base], b: [sg.b[0], sg.b[1] - base], centre: sg.centre && [sg.centre[0], sg.centre[1] - base] }));
  let d = '';
  shifted.forEach((sg, i) => {
    d += i === 0 ? `M${fmt(Math.max(0, sg.a[0]))},${fmt(sg.a[1])}` : '';
    if (sg.kind === 'line') d += `L${fmt(Math.max(0, sg.b[0]))},${fmt(sg.b[1])}`;
    else d += `A${fmt(sg.radius)},${fmt(sg.radius)} 0 ${Math.abs(sg.span) > Math.PI + 1e-12 ? 1 : 0},${sg.ccw ? 1 : 0} ${fmt(Math.max(0, sg.b[0]))},${fmt(sg.b[1])}`;
  });
  if (!touchesAxis) d += 'Z';
  return { el: h('revolve', { ...attrs, d }), kind: 'revolve' };
}

function reverseSegment(sg) {
  return sg.kind === 'line' ? { ...sg, a: sg.b, b: sg.a } : { ...sg, a: sg.b, b: sg.a, ccw: !sg.ccw };
}

/**
 * A prism: two flat caps with the same outline, the second the first moved
 * along their normal, and walls that run straight between them. Written as
 * a box when the outline is a rectangle, else an <extrude> of the outline.
 */
function prismSolid(shell, fmt, tol) {
  const planes = shell.faces.filter((fc) => fc.surface.kind === 'plane');
  for (const cap of planes) {
    const n = cap.sense ? cap.surface.frame.z : neg(cap.surface.frame.z);
    const d = neg(n);
    const caps = planes.filter((fc) => parallelDir(fc.surface.frame.z, d));
    if (caps.length !== 2) continue;
    const other = caps.find((fc) => fc !== cap);
    const depth = dot(sub(other.surface.frame.origin, cap.surface.frame.origin), d);
    if (depth <= tol) continue;
    const H = (p) => dot(sub(p, cap.surface.frame.origin), d);
    let ok = true;
    for (const fc of shell.faces) {
      if (fc === cap || fc === other) continue;
      const s = fc.surface;
      const wall = (s.kind === 'plane' && Math.abs(dot(s.frame.z, d)) < 1e-7) || ((s.kind === 'cylinder') && parallelDir(s.frame.z, d)) || (s.kind === 'extrusion' && parallelDir(s.dir, d));
      if (!wall) {
        ok = false;
        break;
      }
      for (const loop of fc.loops) {
        for (const e of loop.edges) {
          const h0 = H(e.start);
          const h1 = H(e.end);
          const across = e.curve.kind === 'line' && parallelDir(e.curve.dir, d);
          const inCap = (Math.abs(h0) <= tol && Math.abs(h1) <= tol) || (Math.abs(h0 - depth) <= tol && Math.abs(h1 - depth) <= tol);
          if (!across && !inCap) ok = false;
        }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    // the far cap is the near one moved by the depth
    const corners = (fc) => fc.loops.flatMap((l) => l.edges.map((e) => e.start));
    const near = corners(cap);
    const far = corners(other);
    if (near.length !== far.length || !far.every((p) => near.some((q) => len(sub(add(q, mul(d, depth)), p)) <= tol * 10))) continue;
    // the outline in a frame on the near cap whose +Z points into the solid
    const s = cap.surface.frame;
    const xAxis = s.x;
    const { attrs, frame } = placement(s.origin, xAxis, cross(d, xAxis), d, fmt);
    const L = localOf(frame);
    const loops = cap.loops.filter((l) => l.edges.length);
    const rect = loops.length === 1 && loops[0].edges.length === 4 && loops[0].edges.every((e) => e.curve.kind === 'line') && loops[0].edges.every((e, i, a) => Math.abs(dot(unit(sub(e.end, e.start)), unit(sub(a[(i + 1) % 4].end, a[(i + 1) % 4].start)))) < 1e-7);
    if (rect) {
      const p = loops[0].edges.map((e) => e.start);
      const ex = unit(sub(p[1], p[0]));
      const ey = cross(d, ex);
      const centre = add(mul(add(p[0], p[2]), 0.5), mul(d, depth / 2));
      const pl = placement(centre, ex, ey, d, fmt);
      return { el: h('box', { ...pl.attrs, size: [len(sub(p[1], p[0])), len(sub(p[3], p[0])), depth].map(fmt).join(',') }), kind: 'box' };
    }
    const subpaths = [];
    let exact = true;
    for (const loop of loops) {
      let dd = `M${fmt(L(loop.edges[0].start)[0])},${fmt(L(loop.edges[0].start)[1])}`;
      for (const e of loop.edges) {
        const seg = edgeData(e, frame, L, fmt, tol);
        if (!seg) return null;
        dd += seg.d;
        exact = exact && seg.exact;
      }
      subpaths.push(`${dd}Z`);
    }
    const out = { ...attrs, d: subpaths.join(' '), depth: fmt(depth) };
    if (subpaths.length > 1) out.fillRule = 'evenodd';
    return { el: h('extrude', out), kind: 'extrude', exact };
  }
  return null;
}

// --- faces ES3D cannot describe: tessellated from the exact surface ------------------------------

/** Parameters of a surface point, and the point of parameters, for tessellation. */
function parametrisation(s) {
  const f = s.frame;
  if (s.kind === 'plane') {
    return { uv: (p) => [dot(sub(p, f.origin), f.x), dot(sub(p, f.origin), f.y)], xyz: ([u, v]) => add(f.origin, add(mul(f.x, u), mul(f.y, v))), periodic: [false, false] };
  }
  if (REVOLUTION.has(s.kind)) {
    const at = revolutionCoords(s);
    return {
      uv: (p) => {
        const c = at(p);
        return [c.u, c.v];
      },
      xyz: ([u, v]) => {
        const dir = add(mul(f.x, Math.cos(u)), mul(f.y, Math.sin(u)));
        if (s.kind === 'cylinder') return add(f.origin, add(mul(f.z, v), mul(dir, s.radius)));
        if (s.kind === 'cone') return add(f.origin, add(mul(f.z, v), mul(dir, s.radius + v * Math.tan(s.semiAngle))));
        if (s.kind === 'sphere') return add(f.origin, add(mul(f.z, s.radius * Math.sin(v)), mul(dir, s.radius * Math.cos(v))));
        return add(f.origin, add(mul(f.z, s.minor * Math.sin(v)), mul(dir, s.major + s.minor * Math.cos(v))));
      },
      periodic: [true, s.kind === 'torus'],
    };
  }
  if (s.kind === 'bspline') {
    const u0 = s.U[s.du];
    const u1 = s.U[s.U.length - s.du - 1];
    const v0 = s.V[s.dv];
    const v1 = s.V[s.V.length - s.dv - 1];
    const xyz = ([u, v]) => evalSplineSurface(s, Math.min(u1, Math.max(u0, u)), Math.min(v1, Math.max(v0, v)));
    const G = 16;
    const grid = [];
    for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) {
      const uv = [u0 + ((u1 - u0) * i) / G, v0 + ((v1 - v0) * j) / G];
      grid.push([uv, xyz(uv)]);
    }
    // nearest grid point, then Gauss-Newton on the distance
    const uv = (p) => {
      let best = grid[0];
      for (const g of grid) if (len(sub(g[1], p)) < len(sub(best[1], p))) best = g;
      let [u, v] = best[0];
      const hu = (u1 - u0) * 1e-6;
      const hv = (v1 - v0) * 1e-6;
      for (let k = 0; k < 12; k++) {
        const q = xyz([u, v]);
        const r = sub(p, q);
        const su = mul(sub(xyz([u + hu, v]), q), 1 / hu);
        const sv = mul(sub(xyz([u, v + hv]), q), 1 / hv);
        const a = dot(su, su), b = dot(su, sv), c = dot(sv, sv);
        const det = a * c - b * b;
        if (Math.abs(det) < 1e-30) break;
        const du = (c * dot(su, r) - b * dot(sv, r)) / det;
        const dv = (a * dot(sv, r) - b * dot(su, r)) / det;
        u = Math.min(u1, Math.max(u0, u + du));
        v = Math.min(v1, Math.max(v0, v + dv));
        if (Math.abs(du) < hu && Math.abs(dv) < hv) break;
      }
      return [u, v];
    };
    return { uv, xyz, periodic: [false, false] };
  }
  return null;
}

function area2(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

/** One outline from an outer ring and holes, joined by bridges (for ear clipping). */
function bridgeHoles(outer, holes) {
  let ring = outer.slice();
  const sorted = holes.slice().sort((a, b) => Math.max(...b.map((p) => p.uv[0])) - Math.max(...a.map((p) => p.uv[0])));
  for (const hole of sorted) {
    let hi = 0;
    for (let i = 1; i < hole.length; i++) if (hole[i].uv[0] > hole[hi].uv[0]) hi = i;
    const hp = hole[hi].uv;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const q = ring[i].uv;
      if (q[0] < hp[0]) continue;
      const dd = Math.hypot(q[0] - hp[0], q[1] - hp[1]);
      if (dd < bestD && !crossesRing(hp, q, ring, hole)) {
        bestD = dd;
        best = i;
      }
    }
    if (best < 0) {
      for (let i = 0; i < ring.length; i++) {
        const q = ring[i].uv;
        const dd = Math.hypot(q[0] - hp[0], q[1] - hp[1]);
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
    }
    const holeRun = [...hole.slice(hi), ...hole.slice(0, hi + 1)];
    ring = [...ring.slice(0, best + 1), ...holeRun, ...ring.slice(best)];
  }
  return ring;
}

function crossesRing(a, b, ring, hole) {
  const segs = [ring, hole];
  for (const r of segs) {
    for (let i = 0; i < r.length; i++) {
      const p = r[i].uv;
      const q = r[(i + 1) % r.length].uv;
      if ((p === a || q === a || p === b || q === b)) continue;
      const o = (x, y, z) => (y[0] - x[0]) * (z[1] - x[1]) - (y[1] - x[1]) * (z[0] - x[0]);
      const d1 = o(a, b, p), d2 = o(a, b, q), d3 = o(p, q, a), d4 = o(p, q, b);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/** Ear clipping in (u, v), cutting at the shortest 3D diagonal; returns index triples into ring. */
function clipEars(ring) {
  const n = ring.length;
  let idx = ring.map((_, i) => i);
  if (area2(ring.map((p) => p.uv)) < 0) idx.reverse();
  const tris = [];
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => o(a, b, p) > 0 && o(b, c, p) > 0 && o(c, a, p) > 0;
  let guard = n * n;
  while (idx.length > 3 && guard-- > 0) {
    let best = -1;
    let bestLen = Infinity;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (o(ring[a].uv, ring[b].uv, ring[c].uv) <= 0) continue;
      if (idx.some((m) => m !== a && m !== b && m !== c && inside(ring[m].uv, ring[a].uv, ring[b].uv, ring[c].uv))) continue;
      const l = len(sub(ring[a].p, ring[c].p));
      if (l < bestLen) {
        bestLen = l;
        best = k;
      }
    }
    if (best < 0) break;
    const m = idx.length;
    tris.push([idx[(best + m - 1) % m], idx[best], idx[(best + 1) % m]]);
    idx.splice(best, 1);
  }
  for (let k = 1; k + 1 < idx.length; k++) tris.push([idx[0], idx[k], idx[k + 1]]);
  return tris;
}

/** Cells of the parameter grid for a surface: few along straight directions, more where it curves. */
function gridSteps(s, box, chord) {
  const angleStep = (r) => Math.min(Math.PI / 12, 2 * Math.acos(Math.max(-1, 1 - chord / Math.max(r, chord))));
  const du = box.max[0] - box.min[0];
  const dv = box.max[1] - box.min[1];
  const n = (span, step) => Math.max(1, Math.min(720, Math.ceil(span / step)));
  if (s.kind === 'cylinder') return [n(du, angleStep(s.radius)), 1];
  if (s.kind === 'cone') {
    const r = Math.max(Math.abs(s.radius + box.min[1] * Math.tan(s.semiAngle)), Math.abs(s.radius + box.max[1] * Math.tan(s.semiAngle)));
    return [n(du, angleStep(r)), 1];
  }
  if (s.kind === 'sphere') return [n(du, angleStep(s.radius)), n(dv, angleStep(s.radius))];
  if (s.kind === 'torus') return [n(du, angleStep(s.major + s.minor)), n(dv, angleStep(s.minor))];
  if (s.kind === 'bspline') return [Math.max(4, (s.U.length - 2 * s.du - 1) * 6), Math.max(4, (s.V.length - 2 * s.dv - 1) * 6)];
  return [1, 1];
}

/** The part of a polygon inside the cell [u0, u1] × [v0, v1] (Sutherland–Hodgman). */
function clipToCell(poly, u0, u1, v0, v1) {
  let out = poly;
  const edges = [
    [(q) => q[0] >= u0, 0, u0],
    [(q) => q[0] <= u1, 0, u1],
    [(q) => q[1] >= v0, 1, v0],
    [(q) => q[1] <= v1, 1, v1],
  ];
  for (const [inside, k, c] of edges) {
    if (!out.length) break;
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      const ia = inside(a);
      const ib = inside(b);
      if (ia) next.push(a);
      if (ia !== ib) {
        const t = (c - a[k]) / (b[k] - a[k]);
        const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        q[k] = c;
        next.push(q);
      }
    }
    out = next;
  }
  return out;
}

/**
 * The simple regions of a clipped cell. Clipping an outline with bridged
 * holes can leave pieces joined by zero-width corridors and holes joined to
 * their outline; the outline is cut where it touches itself, the loops
 * without area dropped, and each hole bridged again into the loop around it.
 * Returns rings of {uv, p} ready for ear clipping.
 */
function cellRegions(cell, su, sv) {
  const key = (q) => `${Math.round(q[0] / su)},${Math.round(q[1] / sv)}`;
  const loops = [];
  const stack = [];
  const at = new Map();
  for (const q of cell) {
    const k = key(q);
    if (at.has(k)) {
      const from = at.get(k);
      const loop = stack.splice(from + 1);
      for (const r of loop) at.delete(key(r));
      loops.push([stack[from], ...loop]);
      continue;
    }
    at.set(k, stack.length);
    stack.push(q);
  }
  if (stack.length) loops.push(stack);
  const tiny = su * sv * 1e3;
  const kept = loops.filter((l) => l.length >= 3 && Math.abs(area2(l)) > tiny);
  const outers = kept.filter((l) => area2(l) > 0);
  const holes = kept.filter((l) => area2(l) < 0);
  const inside = (q, ring) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a[1] > q[1] !== b[1] > q[1] && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };
  return outers.map((outer) => {
    const mine = holes.filter((hole) => inside(hole[0], outer));
    const ring = (l) => l.map((uv) => ({ uv, p: [uv[0], uv[1], 0] }));
    return mine.length ? bridgeHoles(ring(outer), mine.map(ring)) : ring(outer);
  });
}

/**
 * Triangles of a face from its exact surface: its loops are sampled and
 * mapped to the surface's parameters, the region they bound is cut along a
 * grid fine enough for the surface's curvature, and each cell is
 * triangulated there and mapped back onto the surface.
 */
function tessellateFace(face, chord) {
  const par = parametrisation(face.surface);
  if (!par) return null;
  const rings = [];
  for (const loop of face.loops) {
    if (!loop.edges.length) continue;
    const ring = [];
    let prev = null;
    for (const e of loop.edges) {
      const pts = sampleEdge(e, 16);
      if (!pts) return null;
      for (let i = 0; i < pts.length - 1; i++) {
        const uv = par.uv(pts[i]);
        if (prev) {
          // stay on the side of the seam the loop is on
          for (let k = 0; k < 2; k++) {
            if (!par.periodic[k]) continue;
            while (uv[k] - prev[k] > Math.PI) uv[k] -= TAU;
            while (uv[k] - prev[k] < -Math.PI) uv[k] += TAU;
          }
        }
        ring.push({ uv, p: pts[i] });
        prev = uv;
      }
    }
    if (ring.length >= 3) rings.push(ring);
  }
  if (!rings.length) return null;
  rings.sort((a, b) => Math.abs(area2(b.map((q) => q.uv))) - Math.abs(area2(a.map((q) => q.uv))));
  const outer = rings[0];
  if (area2(outer.map((q) => q.uv)) < 0) outer.reverse();
  const holes = rings.slice(1).map((r) => (area2(r.map((q) => q.uv)) > 0 ? r.slice().reverse() : r));
  // a hole unwrapped a whole turn away from the outline is moved inside it
  for (let k = 0; k < 2; k++) {
    if (!par.periodic[k]) continue;
    const lo = Math.min(...outer.map((q) => q.uv[k]));
    const hi = Math.max(...outer.map((q) => q.uv[k]));
    for (const hole of holes) {
      const mid = hole.reduce((sum, q) => sum + q.uv[k], 0) / hole.length;
      const shift = mid < lo ? Math.ceil((lo - mid) / TAU) * TAU : mid > hi ? -Math.ceil((mid - hi) / TAU) * TAU : 0;
      if (shift) for (const q of hole) q.uv = k === 0 ? [q.uv[0] + shift, q.uv[1]] : [q.uv[0], q.uv[1] + shift];
    }
  }
  const poly = (holes.length ? bridgeHoles(outer, holes) : outer).map((q) => q.uv);
  const box = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  for (const q of poly) {
    for (let k = 0; k < 2; k++) {
      box.min[k] = Math.min(box.min[k], q[k]);
      box.max[k] = Math.max(box.max[k], q[k]);
    }
  }
  const [nu, nv] = gridSteps(face.surface, box, chord);
  const positions = [];
  const indices = [];
  const ids = new Map();
  const su = (box.max[0] - box.min[0]) * 1e-9 || 1e-12;
  const sv = (box.max[1] - box.min[1]) * 1e-9 || 1e-12;
  const uvs = [];
  const vert = (uv) => {
    const key = `${Math.round(uv[0] / su)},${Math.round(uv[1] / sv)}`;
    if (!ids.has(key)) {
      uvs.push(uv);
      ids.set(key, positions.push(par.xyz(uv)) - 1);
    }
    return ids.get(key);
  };
  for (let i = 0; i < nu; i++) {
    const u0 = box.min[0] + ((box.max[0] - box.min[0]) * i) / nu;
    const u1 = box.min[0] + ((box.max[0] - box.min[0]) * (i + 1)) / nu;
    for (let j = 0; j < nv; j++) {
      const v0 = box.min[1] + ((box.max[1] - box.min[1]) * j) / nv;
      const v1 = box.min[1] + ((box.max[1] - box.min[1]) * (j + 1)) / nv;
      const cell = clipToCell(poly, u0, u1, v0, v1);
      if (cell.length < 3 || Math.abs(area2(cell)) <= su * sv) continue;
      for (const ring of cellRegions(cell, su, sv)) {
        for (const q of ring) q.p = par.xyz(q.uv);
        for (const [a, b, c] of clipEars(ring)) {
          const t = [vert(ring[a].uv), vert(ring[b].uv), vert(ring[c].uv)];
          if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue;
          // counter-clockwise in (u, v) faces along the surface normal; the face may face the other way
          if (face.sense) indices.push(t[0], t[1], t[2]);
          else indices.push(t[0], t[2], t[1]);
        }
      }
    }
  }
  if (!indices.length) return null;
  return { positions, indices: closeTJunctions(indices, uvs, positions, par, su, sv) };
}

/**
 * Neighbouring cells can meet with a vertex of one lying on an edge of the
 * other, which shows as pinholes. Triangles without area go, and a triangle
 * with vertices on its edges is fanned from its centre through them.
 */
function closeTJunctions(indices, uvs, positions, par, su, sv) {
  // a lookup grid of 64 × 64 cells over the face's parameters
  let lo = [Infinity, Infinity];
  let hi = [-Infinity, -Infinity];
  for (const q of uvs) {
    lo = [Math.min(lo[0], q[0]), Math.min(lo[1], q[1])];
    hi = [Math.max(hi[0], q[0]), Math.max(hi[1], q[1])];
  }
  const cu = (hi[0] - lo[0]) / 64 || 1;
  const cv = (hi[1] - lo[1]) / 64 || 1;
  const grid = new Map();
  uvs.forEach((q, i) => {
    const k = `${Math.floor((q[0] - lo[0]) / cu)},${Math.floor((q[1] - lo[1]) / cv)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const eps = Math.hypot(su, sv) * 1e3;
  const onEdge = (a, b) => {
    const A = uvs[a];
    const B = uvs[b];
    const d = [B[0] - A[0], B[1] - A[1]];
    const L2 = d[0] * d[0] + d[1] * d[1];
    const found = [];
    const [i0, i1] = [Math.floor((Math.min(A[0], B[0]) - lo[0]) / cu), Math.floor((Math.max(A[0], B[0]) - lo[0]) / cu)];
    const [j0, j1] = [Math.floor((Math.min(A[1], B[1]) - lo[1]) / cv), Math.floor((Math.max(A[1], B[1]) - lo[1]) / cv)];
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const v of grid.get(`${i},${j}`) || []) {
          if (v === a || v === b) continue;
          const P = uvs[v];
          const t = ((P[0] - A[0]) * d[0] + (P[1] - A[1]) * d[1]) / L2;
          if (t <= 1e-9 || t >= 1 - 1e-9) continue;
          if (Math.abs((P[0] - A[0]) * d[1] - (P[1] - A[1]) * d[0]) / Math.sqrt(L2) > eps) continue;
          found.push([t, v]);
        }
      }
    }
    return found.sort((x, y) => x[0] - y[0]).map(([, v]) => v);
  };
  const out = [];
  for (let k = 0; k < indices.length; k += 3) {
    const t = [indices[k], indices[k + 1], indices[k + 2]];
    const [A, B, C] = t.map((i) => uvs[i]);
    const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (Math.abs(area) <= su * sv) continue;
    const ring = [];
    for (let e = 0; e < 3; e++) {
      for (const v of [t[e], ...onEdge(t[e], t[(e + 1) % 3])]) if (!ring.includes(v)) ring.push(v);
    }
    if (ring.length === 3) {
      out.push(...t);
      continue;
    }
    const mid = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3];
    uvs.push(mid);
    const c = positions.push(par.xyz(mid)) - 1;
    for (let i = 0; i < ring.length; i++) out.push(c, ring[i], ring[(i + 1) % ring.length]);
  }
  return out;
}

// --- the document --------------------------------------------------------------------------

function digitsFor(extent) {
  return Math.min(12, Math.max(0, Math.ceil(-Math.log10(Math.max(extent, 1e-9) * 1e-7))));
}

/**
 * Convert a STEP file with a boundary representation to procedural ES3D.
 * @param {string|Uint8Array} input
 * @param {{up?: 'z'|'y', name?: string}} [opts]
 * @returns {{text: string, note: string, stats: {shells: number, faces: number, exact: number, tessellated: number, shapes: object}}|null}
 *   null when the file has no B-rep faces (a tessellated STEP file)
 */
export function stepToExact(input, { up = 'z', name = '' } = {}) {
  const doc = parseSTEP(input);
  const { shells, tol } = readBrep(doc.entities);
  if (!shells.length || shells.every((s) => !s.faces.length)) return null;
  let extent = 0;
  for (const sh of shells) for (const fc of sh.faces) for (const l of fc.loops) for (const e of l.edges) for (const p of [e.start, e.end]) extent = Math.max(extent, len(p));
  const digits = digitsFor(Math.max(extent * 2, 1e-6));
  const fmt = (v) => formatNumber(v, digits);

  const colours = colourMap(doc.entities);
  const owners = ownerIndex(doc.entities);
  const materials = new Map();
  const materialFor = (rgba) => {
    const hex = colorToHex(rgba || [0.78, 0.8, 0.82, 1]);
    if (!materials.has(hex)) materials.set(hex, `c${hex.slice(1, 7)}`);
    return materials.get(hex);
  };

  const stats = { shells: shells.length, faces: 0, exact: 0, tessellated: 0, approximate: 0, skipped: 0, shapes: {} };
  const count = (k) => (stats.shapes[k] = (stats.shapes[k] || 0) + 1);
  const groups = [];
  for (const shell of shells) {
    const shellMat = materialFor(inheritedColour(colours, owners, [shell.id]));
    const g = h('group', { material: shellMat });
    if (shell.name) g.setAttr('name', shell.name);
    stats.faces += shell.faces.length;
    const whole = primitiveSolid(shell, fmt, tol);
    const solid = whole ? { el: whole, kind: whole.name } : shell.closed ? revolvedSolid(shell, fmt, tol) || prismSolid(shell, fmt, tol) : null;
    if (solid) {
      g.appendChild(solid.el);
      count(solid.kind);
      if (solid.exact === false) stats.approximate += shell.faces.length;
      else stats.exact += shell.faces.length;
      groups.push(g);
      continue;
    }
    const mesh = { positions: [], indices: [] };
    for (const face of shell.faces) {
      const faceColour = colours.get(face.id);
      const k = face.surface.kind;
      let out = null;
      if (k === 'plane') out = planarFace(face, fmt, tol);
      else if (REVOLUTION.has(k)) out = revolveFace(face, fmt, tol);
      if (out) {
        if (faceColour) out.el.setAttr('material', materialFor(faceColour));
        g.appendChild(out.el);
        count(out.el.name);
        if (out.exact) stats.exact++;
        else stats.approximate++;
        continue;
      }
      const t = tessellateFace(face, extent * 5e-4);
      if (!t) {
        stats.skipped++;
        continue;
      }
      const base = mesh.positions.length;
      for (const p of t.positions) mesh.positions.push(p);
      for (const i of t.indices) mesh.indices.push(base + i);
      stats.tessellated++;
    }
    if (mesh.indices.length) {
      g.appendChild(
        h('mesh', {
          positions: mesh.positions.map((p) => p.map(fmt).join(' ')).join(' '),
          indices: mesh.indices.join(' '),
          smooth: '30',
        }),
      );
      count('mesh');
    }
    groups.push(g);
  }

  // nothing in the file could be read as a surface (unbounded faces): the triangle path says why
  if (stats.skipped === stats.faces) return null;
  // CAD kernels name an unnamed part after its kind; the file name says more
  const product = productName(doc.entities);
  const title = (product && !/^(compound|solid|shell|body|part|unnamed)\s*\d*$/i.test(product.trim()) ? product : '') || String(name).replace(/\.(step|stp|p21)$/i, '') || product || 'step';
  const rootAttrs = { version: '1' };
  if (UNIT[doc.unit]) rootAttrs.unit = UNIT[doc.unit];
  const root = h('es3d', rootAttrs, h('title', {}, title));
  for (const [hex, id] of materials) root.appendChild(h('material', { id, color: hex }));
  const holder = up === 'z' ? root.appendChild(h('group', { name: 'z-up', rotation: '-90,0,0' })) : root;
  for (const g of groups) holder.appendChild(g);
  const label = { box: ['box', 'boxes'], extrude: ['extrusion', 'extrusions'], revolve: ['revolve', 'revolves'], path: ['flat face', 'flat faces'], mesh: ['mesh', 'meshes'], torus: ['torus', 'tori'] };
  const summary = Object.entries(stats.shapes)
    .map(([k, n]) => `${n} ${(label[k] || [k, `${k}s`])[n === 1 ? 0 : 1]}`)
    .join(', ');
  const exactNote = stats.tessellated
    ? `${stats.exact + stats.approximate} of ${stats.faces} faces are ES3D shapes; ${stats.tessellated} face${stats.tessellated === 1 ? ' is a free-form or cross-cut surface ES3D cannot describe, so it is' : 's are free-form or cross-cut surfaces ES3D cannot describe, so they are'} tessellated from the exact surface into a mesh.`
    : `All ${stats.faces} faces are ES3D shapes${stats.approximate ? ` (${stats.approximate} with edges sampled: rational splines)` : ''}; nothing is a mesh.`;
  const comment = new Comment(` Converted from STEP: ${summary}. `);
  const text = serialize(new Document({ root, syntax: 'xml', leading: [comment] }), { pretty: true, comments: true });
  const skippedNote = stats.skipped ? ` ${stats.skipped} face${stats.skipped === 1 ? ' has' : 's have'} no surface or bounds that can be read and ${stats.skipped === 1 ? 'was' : 'were'} left out.` : '';
  const unitNote = doc.unit ? ` Coordinates are in ${doc.unit} and were not rescaled.` : ' The file does not name a length unit; coordinates were used as written.';
  return { text, note: `STEP B-rep: ${summary}. ${exactNote}${skippedNote}${unitNote}${up === 'z' ? ' Turned from Z-up to Y-up by the outer group.' : ''}`, stats };
}


