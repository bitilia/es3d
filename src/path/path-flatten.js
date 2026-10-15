// Flattening of path segments into polylines ("contours").
//
// Curves are subdivided adaptively from a geometric tolerance (Wang's formula
// for Béziers, chord error for arcs), so the same path produces coarser or
// finer polylines for different levels of detail. Every output point carries a
// `smooth` flag: true for curve interiors and tangent-continuous joints, false
// for corners. Geometry generators use the flags to decide where normals must
// be split (sharp edges) and where they are shared (smooth surfaces).

const SMOOTH_JOINT_COS = Math.cos((8 * Math.PI) / 180);
const MAX_SEGMENTS = 256;

function norm2(x, y) {
  const l = Math.hypot(x, y);
  return l > 1e-12 ? [x / l, y / l, 0] : null;
}
function norm3(x, y, z) {
  const l = Math.hypot(x, y, z);
  return l > 1e-12 ? [x / l, y / l, z / l] : null;
}

class ContourBuilder {
  constructor(dim) {
    this.dim = dim;
    this.pts = [];
    this.smooth = [];
    this.firstTan = null;
    this.lastTan = null;
    this.closed = false;
  }

  get count() {
    return this.smooth.length;
  }

  lastPoint() {
    const d = this.dim;
    const p = this.pts;
    const k = p.length - d;
    return d === 3 ? [p[k], p[k + 1], p[k + 2]] : [p[k], p[k + 1], 0];
  }

  start(x, y, z) {
    this.pts.push(x, y);
    if (this.dim === 3) this.pts.push(z);
    this.smooth.push(0);
  }

  /** Begin a piece: decide whether the joint at the current last point is smooth. */
  joint(tan) {
    if (!tan) return;
    if (this.lastTan) {
      const c = this.lastTan[0] * tan[0] + this.lastTan[1] * tan[1] + this.lastTan[2] * tan[2];
      this.smooth[this.smooth.length - 1] = c >= SMOOTH_JOINT_COS ? 1 : 0;
    } else {
      this.firstTan = tan;
    }
  }

  push(x, y, z, smooth) {
    // skip duplicate points
    const d = this.dim;
    const p = this.pts;
    const k = p.length - d;
    if (Math.abs(p[k] - x) < 1e-12 && Math.abs(p[k + 1] - y) < 1e-12 && (d === 2 || Math.abs(p[k + 2] - z) < 1e-12)) return;
    p.push(x, y);
    if (d === 3) p.push(z);
    this.smooth.push(smooth ? 1 : 0);
  }

  end(tan) {
    if (tan) this.lastTan = tan;
  }
}

function tangent(dim, x, y, z) {
  return dim === 3 ? norm3(x, y, z) : norm2(x, y);
}

/**
 * @param {object[]} segments absolute segments from parsePathData
 * @param {{tolerance:number, dim?:2|3, maxSegments?:number}} opts
 * @returns {{points: Float64Array, smooth: Uint8Array, closed: boolean}[]}
 */
export function flattenPath(segments, opts) {
  const dim = opts.dim || 2;
  const tol = Math.max(opts.tolerance, 1e-9);
  const maxSeg = opts.maxSegments || MAX_SEGMENTS;
  const out = [];
  let b = null;

  const finish = () => {
    if (!b) return;
    if (b.closed) {
      // drop a duplicated end point and resolve the joint at the start point
      const d = dim;
      const p = b.pts;
      const n = b.count;
      if (n > 1) {
        const k = (n - 1) * d;
        const same = Math.abs(p[k] - p[0]) < 1e-9 && Math.abs(p[k + 1] - p[1]) < 1e-9 && (d === 2 || Math.abs(p[k + 2] - p[2]) < 1e-9);
        if (same) {
          p.length -= d;
          b.smooth.pop();
        } else {
          // implicit closing line
          const t = tangent(dim, p[0] - p[k], p[1] - p[k + 1], d === 3 ? p[2] - p[k + 2] : 0);
          b.joint(t);
          b.end(t);
        }
      }
      if (b.firstTan && b.lastTan) {
        const c = b.lastTan[0] * b.firstTan[0] + b.lastTan[1] * b.firstTan[1] + b.lastTan[2] * b.firstTan[2];
        b.smooth[0] = c >= SMOOTH_JOINT_COS ? 1 : 0;
      }
    }
    if (b.count >= (b.closed ? 3 : 2)) {
      out.push({ points: Float64Array.from(b.pts), smooth: Uint8Array.from(b.smooth), closed: b.closed });
    } else if (b.count >= 2) {
      // a closed contour with fewer than 3 distinct points is degenerate; keep it open so it can be reported
      out.push({ points: Float64Array.from(b.pts), smooth: Uint8Array.from(b.smooth), closed: false, degenerate: true });
    }
    b = null;
  };

  for (const s of segments) {
    if (s.c === 'M') {
      finish();
      b = new ContourBuilder(dim);
      b.start(s.x, s.y, s.z || 0);
      continue;
    }
    if (!b) continue;
    const [px, py, pz] = b.lastPoint();
    switch (s.c) {
      case 'L': {
        const t = tangent(dim, s.x - px, s.y - py, (s.z || 0) - pz);
        if (!t) break;
        b.joint(t);
        b.push(s.x, s.y, s.z || 0, false);
        b.end(t);
        break;
      }
      case 'Q': {
        const x0 = px, y0 = py, z0 = pz;
        const ddx = x0 - 2 * s.x1 + s.x, ddy = y0 - 2 * s.y1 + s.y, ddz = dim === 3 ? z0 - 2 * s.z1 + s.z : 0;
        const M = Math.hypot(ddx, ddy, ddz);
        const n = Math.max(1, Math.min(maxSeg, Math.ceil(Math.sqrt((0.25 * M) / tol))));
        const t0 = tangent(dim, s.x1 - x0, s.y1 - y0, (s.z1 || 0) - z0) || tangent(dim, s.x - x0, s.y - y0, (s.z || 0) - z0);
        const t1 = tangent(dim, s.x - s.x1, s.y - s.y1, (s.z || 0) - (s.z1 || 0)) || t0;
        if (!t0) break;
        b.joint(t0);
        for (let i = 1; i <= n; i++) {
          const t = i / n, mt = 1 - t;
          const a = mt * mt, bb = 2 * mt * t, c = t * t;
          b.push(a * x0 + bb * s.x1 + c * s.x, a * y0 + bb * s.y1 + c * s.y, a * z0 + bb * (s.z1 || 0) + c * (s.z || 0), i < n);
        }
        b.end(t1);
        break;
      }
      case 'C': {
        const x0 = px, y0 = py, z0 = pz;
        const z1 = s.z1 || 0, z2 = s.z2 || 0, z3 = s.z || 0;
        const d1 = Math.hypot(x0 - 2 * s.x1 + s.x2, y0 - 2 * s.y1 + s.y2, dim === 3 ? z0 - 2 * z1 + z2 : 0);
        const d2 = Math.hypot(s.x1 - 2 * s.x2 + s.x, s.y1 - 2 * s.y2 + s.y, dim === 3 ? z1 - 2 * z2 + z3 : 0);
        const M = Math.max(d1, d2);
        const n = Math.max(1, Math.min(maxSeg, Math.ceil(Math.sqrt((0.75 * M) / tol))));
        const t0 =
          tangent(dim, s.x1 - x0, s.y1 - y0, z1 - z0) ||
          tangent(dim, s.x2 - x0, s.y2 - y0, z2 - z0) ||
          tangent(dim, s.x - x0, s.y - y0, z3 - z0);
        const t1 =
          tangent(dim, s.x - s.x2, s.y - s.y2, z3 - z2) ||
          tangent(dim, s.x - s.x1, s.y - s.y1, z3 - z1) ||
          t0;
        if (!t0) break;
        b.joint(t0);
        for (let i = 1; i <= n; i++) {
          const t = i / n, mt = 1 - t;
          const a = mt * mt * mt, bb = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
          b.push(
            a * x0 + bb * s.x1 + c * s.x2 + d * s.x,
            a * y0 + bb * s.y1 + c * s.y2 + d * s.y,
            a * z0 + bb * z1 + c * z2 + d * z3,
            i < n,
          );
        }
        b.end(t1);
        break;
      }
      case 'A': {
        const arc = arcToCenter(px, py, s.rx, s.ry, s.rot, s.large, s.sweep, s.x, s.y);
        if (!arc) {
          const t = tangent(2, s.x - px, s.y - py, 0);
          if (!t) break;
          b.joint(t);
          b.push(s.x, s.y, 0, false);
          b.end(t);
          break;
        }
        const r = Math.max(arc.rx, arc.ry);
        const step = tol >= r ? Math.PI / 2 : 2 * Math.acos(1 - tol / r);
        const n = Math.max(1, Math.min(maxSeg, Math.ceil(Math.abs(arc.dtheta) / step)));
        b.joint(arc.tangentAt(arc.theta1));
        for (let i = 1; i <= n; i++) {
          const th = arc.theta1 + (arc.dtheta * i) / n;
          if (i === n) b.push(s.x, s.y, 0, false);
          else {
            const p = arc.pointAt(th);
            b.push(p[0], p[1], 0, true);
          }
        }
        b.end(arc.tangentAt(arc.theta1 + arc.dtheta));
        break;
      }
      case 'Z':
        b.closed = true;
        finish();
        break;
      default:
        break;
    }
  }
  finish();
  return out;
}

/** SVG arc endpoint -> center parameterization (SVG 1.1 implementation notes F.6.5). */
export function arcToCenter(x1, y1, rx, ry, rotDeg, large, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return null;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx < 1e-12 || ry < 1e-12) return null;
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx, ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = den > 0 ? Math.sqrt(Math.max(0, num / den)) : 0;
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = Math.atan2(uy, ux);
  let dtheta = ang(ux, uy, vx, vy);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  const sign = dtheta >= 0 ? 1 : -1;
  return {
    cx,
    cy,
    rx,
    ry,
    theta1,
    dtheta,
    pointAt(th) {
      const c = Math.cos(th), s = Math.sin(th);
      return [cx + rx * cosP * c - ry * sinP * s, cy + rx * sinP * c + ry * cosP * s];
    },
    tangentAt(th) {
      const c = Math.cos(th), s = Math.sin(th);
      return norm2(sign * (-rx * cosP * s - ry * sinP * c), sign * (-rx * sinP * s + ry * cosP * c));
    },
  };
}

/** Polyline points (flat array) -> contour with corner detection by turning angle. */
export function polylineContour(points, dim, closed) {
  const n = points.length / dim;
  const smooth = new Uint8Array(n);
  return { points: Float64Array.from(points), smooth, closed };
}

/** Regular polygon approximation of a circle (all points smooth), counter-clockwise. */
export function circleContour(r, segments) {
  const pts = new Float64Array(segments * 2);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts[i * 2] = Math.cos(a) * r;
    pts[i * 2 + 1] = Math.sin(a) * r;
  }
  return { points: pts, smooth: new Uint8Array(segments).fill(1), closed: true };
}

/** Signed area of a 2D contour (positive = counter-clockwise with y up). */
export function signedArea(points) {
  let a = 0;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += (points[j * 2] - points[i * 2]) * (points[j * 2 + 1] + points[i * 2 + 1]);
  }
  return a / 2;
}

/** Reverse a 2D/3D contour in place-safe manner (returns a new contour). */
export function reverseContour(c, dim = 2) {
  const n = c.points.length / dim;
  const pts = new Float64Array(c.points.length);
  const sm = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    for (let k = 0; k < dim; k++) pts[i * dim + k] = c.points[j * dim + k];
    sm[i] = c.smooth[j];
  }
  return { ...c, points: pts, smooth: sm };
}
