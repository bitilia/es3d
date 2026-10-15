// Animation of a transform (and of a camera's target and fov).
//
// An animation has a timeline and a value source.
//
// Timeline. "time" (the default): nothing happens before `begin`; then the
// animation plays `repeat` cycles of length `dur` (optionally reversing
// direction) and holds the end value. "scroll": progress is the page scroll
// position mapped to 0..1 by the viewer, and dur/begin/repeat are not used.
// Either way the result is a fraction f in 0..1, shaped by `easing`.
//
// Value source. from/to: a straight interpolation. values (+ keyTimes): key
// values reached at the given fractions, linear or on a centripetal
// Catmull-Rom curve (smooth). along: a 3D path walked at constant speed, so
// equal scroll moves the camera an equal distance. This is not SMIL. It is the
// whole animation model.

import { valueOf } from '../format/schema.js';
import { spinePolylines } from '../geometry/sweep.js';

const EASINGS = {
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => 1 - (1 - t) * (1 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function animationFromElement(el, base) {
  const attr = valueOf(el, 'attr');
  const expand = (v) => (attr === 'scale' && v.length === 1 ? [v[0], v[0], v[0]] : v.slice());
  const v = el.values;
  const a = {
    attr,
    dur: valueOf(el, 'dur') || 1,
    begin: valueOf(el, 'begin'),
    repeat: valueOf(el, 'repeat'),
    alternate: valueOf(el, 'alternate'),
    ease: EASINGS[valueOf(el, 'easing')] || EASINGS.linear,
    timeline: valueOf(el, 'timeline'),
    smooth: valueOf(el, 'smooth'),
    from: null,
    to: null,
    keys: null,
    keyTimes: null,
    path: null,
  };
  if (v.along) {
    a.path = arcLengthPath(v.along, a.smooth);
  } else if (v.values) {
    a.keys = v.values.map(expand);
    const n = a.keys.length;
    a.keyTimes = v.keyTimes && v.keyTimes.length === n ? v.keyTimes.slice() : a.keys.map((_, i) => i / (n - 1));
  } else {
    a.from = v.from !== undefined ? expand(v.from) : base[attr];
    a.to = expand(v.to);
  }
  return a;
}

/** Fraction 0..1 of an animation at a time and scroll progress, or -1 when it has no effect yet. */
export function animationFraction(a, t, progress = 0) {
  if (a.timeline === 'scroll') return a.ease(clamp01(progress));
  const elapsed = t - a.begin;
  if (elapsed < 0) return -1;
  const cycles = elapsed / a.dur;
  let f;
  if (cycles >= a.repeat) {
    const whole = Math.ceil(a.repeat) - 1;
    f = a.repeat - whole;
    if (a.alternate && whole % 2 === 1) f = 1 - f;
  } else {
    const k = Math.floor(cycles);
    f = cycles - k;
    if (a.alternate && k % 2 === 1) f = 1 - f;
  }
  return a.ease(f);
}

/** Value of an animation at time t (seconds) and scroll progress, or null when it has no effect yet. */
export function sampleAnimation(a, t, progress = 0) {
  const e = animationFraction(a, t, progress);
  if (e < 0) return null;
  if (a.path) return samplePath(a.path, e);
  if (a.keys) return sampleKeys(a, e);
  const out = new Array(a.from.length);
  for (let k = 0; k < out.length; k++) out[k] = a.from[k] + (a.to[k] - a.from[k]) * e;
  return out;
}

// ---------------------------------------------------------------------------
// key values

function sampleKeys(a, e) {
  const keys = a.keys;
  const kt = a.keyTimes;
  const n = keys.length;
  let i = 0;
  while (i < n - 2 && e >= kt[i + 1]) i++;
  const span = kt[i + 1] - kt[i];
  const u = span > 0 ? clamp01((e - kt[i]) / span) : 1;
  const p1 = keys[i], p2 = keys[i + 1];
  if (!a.smooth || n < 3) return p1.map((x, k) => x + (p2[k] - x) * u);
  // end tangents mirror the neighbouring key, as for sweep spines
  const p0 = i > 0 ? keys[i - 1] : p1.map((x, k) => 2 * x - p2[k]);
  const p3 = i + 2 < n ? keys[i + 2] : p2.map((x, k) => 2 * x - p1[k]);
  return centripetal(p0, p1, p2, p3, u);
}

/** Point at u (0..1) between p1 and p2 on the centripetal Catmull-Rom curve (Barry-Goldman). */
function centripetal(p0, p1, p2, p3, u) {
  const knot = (a, b) => {
    let d = 0;
    for (let k = 0; k < a.length; k++) d += (b[k] - a[k]) ** 2;
    return Math.max(Math.sqrt(Math.sqrt(d)), 1e-9);
  };
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const lerp = (a, b, ta, tb) => a.map((x, k) => x + ((b[k] - x) * (t - ta)) / (tb - ta));
  const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
  const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
  return lerp(B1, B2, t1, t2);
}

// ---------------------------------------------------------------------------
// paths

/** Flatten an `along` value into one polyline with cumulative arc lengths. */
export function arcLengthPath(spine, smooth) {
  const opts = (tolerance) => ({ tolerance, segmentsPerTurn: 64, smooth, subdivisions: 24 });
  // path data needs a tolerance relative to its size: measure it coarsely first
  let lines = spinePolylines(spine, opts(1e-2));
  if (spine.kind === 'path') {
    let ext = 0;
    for (const l of lines) for (let i = 0; i < l.points.length; i++) ext = Math.max(ext, Math.abs(l.points[i]));
    lines = spinePolylines(spine, opts(Math.max(ext, 1e-6) * 1e-4));
  }
  const pts = [];
  for (const l of lines) {
    for (let i = 0; i < l.points.length; i++) pts.push(l.points[i]);
    if (l.closed && l.points.length >= 3) pts.push(l.points[0], l.points[1], l.points[2]);
  }
  const n = pts.length / 3;
  const lengths = new Float64Array(Math.max(n, 1));
  for (let i = 1; i < n; i++) {
    lengths[i] = lengths[i - 1] + Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
  }
  return { points: Float64Array.from(pts), lengths, total: n ? lengths[n - 1] : 0 };
}

/** Point at fraction e of a path's length. */
export function samplePath(path, e) {
  const P = path.points;
  const L = path.lengths;
  const n = P.length / 3;
  if (n === 0) return [0, 0, 0];
  if (n === 1 || path.total <= 0) return [P[0], P[1], P[2]];
  const s = clamp01(e) * path.total;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (L[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = L[hi] - L[lo];
  const u = seg > 0 ? (s - L[lo]) / seg : 0;
  return [P[lo * 3] + (P[hi * 3] - P[lo * 3]) * u, P[lo * 3 + 1] + (P[hi * 3 + 1] - P[lo * 3 + 1]) * u, P[lo * 3 + 2] + (P[hi * 3 + 2] - P[lo * 3 + 2]) * u];
}
