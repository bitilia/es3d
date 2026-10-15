// Analytic primitives (src/geometry/primitives.js), Catmull-Rom spines
// (catmullRom in sweep.js) and involute gear outlines (gear.js), operation
// for operation.

#include "runtime.h"

static const double PI = 3.141592653589793; // Math.PI
static const double TAU = 6.283185307179586; // Math.PI * 2

// --- mesh output: what MeshBuilder does, into arrays sized by the caller ---

typedef struct {
  float *p, *n, *t;
  u32 *i;
  i32 vc, ic;
} Out;

static u32 result[6];

static int out_init(Out *o, i32 vertices, i32 indices) {
  o->p = es3d_alloc((u32)(vertices > 0 ? vertices : 1) * 12u);
  o->n = es3d_alloc((u32)(vertices > 0 ? vertices : 1) * 12u);
  o->t = es3d_alloc((u32)(vertices > 0 ? vertices : 1) * 8u);
  o->i = es3d_alloc((u32)(indices > 0 ? indices : 1) * 4u);
  o->vc = o->ic = 0;
  return o->p && o->n && o->t && o->i;
}

static inline i32 vtx(Out *o, double px, double py, double pz, double nx, double ny, double nz, double u, double v) {
  const i32 k = o->vc++;
  o->p[k * 3] = (float)px;
  o->p[k * 3 + 1] = (float)py;
  o->p[k * 3 + 2] = (float)pz;
  o->n[k * 3] = (float)nx;
  o->n[k * 3 + 1] = (float)ny;
  o->n[k * 3 + 2] = (float)nz;
  o->t[k * 2] = (float)u;
  o->t[k * 2 + 1] = (float)v;
  return k;
}

static inline void tri(Out *o, i32 a, i32 b, i32 c) {
  o->i[o->ic++] = (u32)a;
  o->i[o->ic++] = (u32)b;
  o->i[o->ic++] = (u32)c;
}

static inline void quad(Out *o, i32 a, i32 b, i32 c, i32 d) {
  tri(o, a, b, c);
  tri(o, a, c, d);
}

static u32 *done(Out *o) {
  result[0] = (u32)o->vc;
  result[1] = (u32)o->ic;
  result[2] = (u32)o->p;
  result[3] = (u32)o->n;
  result[4] = (u32)o->t;
  result[5] = (u32)o->i;
  return result;
}

/** unitSphere (segments a whole number). */
EXPORT("sphere") u32 *sphere(i32 segments) {
  const i32 w = segments > 3 ? segments : 3;
  const double hr = js_round(w / 2.0);
  const i32 hRings = hr > 2 ? (i32)hr : 2;
  Out o;
  if (!out_init(&o, (w + 1) * (hRings + 1), w * (hRings - 1) * 6)) return 0;
  for (i32 j = 0; j <= hRings; j++) {
    const double th = ((double)j / hRings) * PI;
    const double st = js_sin(th), ct = js_cos(th);
    for (i32 i = 0; i <= w; i++) {
      const double ph = ((double)(i % w) / w) * TAU; // the seam column repeats column 0 exactly
      const double x = st * js_cos(ph), y = ct, z = -st * js_sin(ph);
      vtx(&o, x, y, z, x, y, z, (double)i / w, 1 - (double)j / hRings);
    }
  }
  const i32 row = w + 1;
  for (i32 j = 0; j < hRings; j++) {
    for (i32 i = 0; i < w; i++) {
      const i32 a = j * row + i, bb = (j + 1) * row + i, c = bb + 1, d = a + 1;
      // at the poles one triangle of each quad is degenerate and skipped
      if (j != hRings - 1) tri(&o, a, bb, c);
      if (j != 0) tri(&o, a, c, d);
    }
  }
  return done(&o);
}

/** unitCylinder (segments a whole number). */
EXPORT("cylinder") u32 *cylinder(double top, i32 segments, i32 caps) {
  const i32 s = segments > 3 ? segments : 3;
  Out o;
  if (!out_init(&o, (s + 1) * 2 + (caps ? s + 2 + (top > 0 ? s + 2 : 0) : 0), s * (top > 0 ? 6 : 3) + (caps ? s * 3 * (top > 0 ? 2 : 1) : 0))) return 0;
  const double slope = 1 - top;
  double *rc = es3d_alloc((u32)(s + 1) * 8u), *rs = es3d_alloc((u32)(s + 1) * 8u);
  i32 *bottom = es3d_alloc((u32)(s + 1) * 4u), *topv = es3d_alloc((u32)(s + 1) * 4u);
  if (!rc || !rs || !bottom || !topv) return 0;
  for (i32 i = 0; i <= s; i++) {
    const double ph = ((double)(i % s) / s) * TAU;
    rc[i] = js_cos(ph);
    rs[i] = -js_sin(ph);
  }
  for (i32 i = 0; i <= s; i++) {
    const double c = rc[i], sn = rs[i];
    const double l = js_hypot3(c, slope, sn);
    const double n0 = c / l, n1 = slope / l, n2 = sn / l;
    bottom[i] = vtx(&o, c, -0.5, sn, n0, n1, n2, (double)i / s, 0);
    if (top > 0) {
      topv[i] = vtx(&o, c * top, 0.5, sn * top, n0, n1, n2, (double)i / s, 1);
    } else {
      // apex: use the normal halfway through the segment for smooth shading
      const double ph = ((i + 0.5) / s) * TAU;
      const double mc = js_cos(ph), ms = -js_sin(ph);
      const double ml = js_hypot3(mc, slope, ms);
      topv[i] = vtx(&o, 0, 0.5, 0, mc / ml, slope / ml, ms / ml, (i + 0.5) / s, 1);
    }
  }
  for (i32 i = 0; i < s; i++) {
    if (top > 0) quad(&o, bottom[i], bottom[i + 1], topv[i + 1], topv[i]);
    else tri(&o, bottom[i], bottom[i + 1], topv[i]);
  }
  if (caps) {
    const i32 cb = vtx(&o, 0, -0.5, 0, 0, -1, 0, 0.5, 0.5);
    const i32 rb = o.vc;
    for (i32 i = 0; i <= s; i++) vtx(&o, rc[i], -0.5, rs[i], 0, -1, 0, rc[i] * 0.5 + 0.5, rs[i] * 0.5 + 0.5);
    for (i32 i = 0; i < s; i++) tri(&o, cb, rb + i + 1, rb + i);
    if (top > 0) {
      const i32 ct = vtx(&o, 0, 0.5, 0, 0, 1, 0, 0.5, 0.5);
      const i32 rt = o.vc;
      for (i32 i = 0; i <= s; i++) vtx(&o, rc[i] * top, 0.5, rs[i] * top, 0, 1, 0, rc[i] * 0.5 + 0.5, rs[i] * 0.5 + 0.5);
      for (i32 i = 0; i < s; i++) tri(&o, ct, rt + i, rt + i + 1);
    }
  }
  return done(&o);
}

/** unitCapsule (segments a whole number). */
EXPORT("capsule") u32 *capsule(double L, i32 segments) {
  const i32 w = segments > 3 ? segments : 3;
  const double hrd = js_round(w / 4.0);
  const i32 hr = hrd > 1 ? (i32)hrd : 1;
  const i32 nr = 2 * (hr + 1);
  const double total = L + 2;
  Out o;
  if (!out_init(&o, nr * (w + 1), w * 3 * (2 * (nr - 1) - 2))) return 0;
  for (i32 j = 0; j < nr; j++) {
    const i32 k = j <= hr ? j : j - hr - 1;
    const double th = j <= hr ? ((double)k / hr) * (PI / 2) : PI / 2 + ((double)k / hr) * (PI / 2);
    const double yo = j <= hr ? L / 2 : -L / 2;
    const double st = js_sin(th), ct = js_cos(th);
    const double y = ct + yo;
    for (i32 i = 0; i <= w; i++) {
      const double ph = ((double)(i % w) / w) * TAU;
      const double x = st * js_cos(ph), z = -st * js_sin(ph);
      vtx(&o, x, y, z, x, ct, z, (double)i / w, (y + total / 2) / total);
    }
  }
  const i32 row = w + 1;
  for (i32 j = 0; j < nr - 1; j++) {
    for (i32 i = 0; i < w; i++) {
      const i32 a = j * row + i, bb = (j + 1) * row + i, c = bb + 1, d = a + 1;
      if (j != nr - 2) tri(&o, a, bb, c);
      if (j != 0) tri(&o, a, c, d);
    }
  }
  return done(&o);
}

/** unitTorus (segment counts whole numbers). */
EXPORT("torus") u32 *torus(double t, double arcDeg, i32 segments, i32 tubeSegments) {
  const int full = arcDeg >= 360 - 1e-9;
  const double arc = (js_min(arcDeg, 360) * PI) / 180;
  const double tsd = js_or(js_round(segments * (full ? 1 : arcDeg / 360)), 3);
  const i32 ts = tsd > 3 ? (i32)tsd : 3;
  const i32 rs = tubeSegments > 3 ? tubeSegments : 3;
  Out o;
  if (!out_init(&o, (ts + 1) * (rs + 1) + (full ? 0 : 2 * (rs + 2)), ts * rs * 6 + (full ? 0 : 2 * rs * 3))) return 0;
  for (i32 i = 0; i <= ts; i++) {
    const double ph = full ? ((double)(i % ts) / ts) * TAU : ((double)i / ts) * arc;
    const double cp = js_cos(ph), sp = js_sin(ph);
    for (i32 j = 0; j <= rs; j++) {
      const double th = ((double)(j % rs) / rs) * TAU;
      const double ct = js_cos(th), st = js_sin(th);
      const double R = 1 + t * ct;
      vtx(&o, R * cp, t * st, -R * sp, ct * cp, st, -ct * sp, (double)i / ts, (double)j / rs);
    }
  }
  const i32 row = rs + 1;
  for (i32 i = 0; i < ts; i++)
    for (i32 j = 0; j < rs; j++) {
      const i32 a = i * row + j;
      quad(&o, a, a + row, a + row + 1, a + 1);
    }
  if (!full) {
    // end caps (discs) so a partial torus is closed
    for (i32 end = 0; end < 2; end++) {
      const double ph = end ? arc : 0, dir = end ? -1 : 1;
      const double cp = js_cos(ph), sp = js_sin(ph);
      // outward normal: opposite to the sweep direction at the start, along it at the end
      const double tx = -sp, tz = -cp;
      const double nx = -tx * dir, nz = -tz * dir;
      const i32 center = vtx(&o, cp, 0, -sp, nx, 0, nz, 0.5, 0.5);
      const i32 rim = o.vc;
      for (i32 j = 0; j <= rs; j++) {
        const double th = ((double)(j % rs) / rs) * TAU;
        const double R = 1 + t * js_cos(th);
        vtx(&o, R * cp, t * js_sin(th), -R * sp, nx, 0, nz, 0.5 + js_cos(th) * 0.5, 0.5 + js_sin(th) * 0.5);
      }
      for (i32 j = 0; j < rs; j++) {
        if (dir > 0) tri(&o, center, rim + j, rim + j + 1);
        else tri(&o, center, rim + j + 1, rim + j);
      }
    }
  }
  return done(&o);
}

/** The roundedBox grid coordinates along one axis: 2 seg + 2 values, times sign. */
static void box_coords(double Hh, double r, i32 seg, double sign, double *out) {
  const double inner = Hh - r;
  i32 k = 0;
  for (i32 q = seg; q >= 1; q--) out[k++] = (-inner - r * js_tan((((double)q / seg) * PI) / 4)) * sign;
  out[k++] = -inner * sign;
  out[k++] = inner * sign;
  for (i32 q = 1; q <= seg; q++) out[k++] = (inner + r * js_tan((((double)q / seg) * PI) / 4)) * sign;
}

/** roundedBox (seg a whole number >= 1). */
EXPORT("rounded_box") u32 *rounded_box(double w, double h, double d, double r, i32 seg) {
  const double H[3] = {w / 2, h / 2, d / 2};
  const i32 side = 2 * seg + 2;
  Out o;
  double *us = es3d_alloc((u32)side * 8u), *vs = es3d_alloc((u32)side * 8u);
  if (!us || !vs || !out_init(&o, 6 * side * side, 6 * (side - 1) * (side - 1) * 6)) return 0;
  // faces: axis, sign, the axis and direction u and v run along
  static const i32 F[6][6] = {{0, 1, 2, -1, 1, 1}, {0, -1, 2, 1, 1, 1}, {1, 1, 0, 1, 2, -1}, {1, -1, 0, 1, 2, 1}, {2, 1, 0, 1, 1, 1}, {2, -1, 0, -1, 1, 1}};
  double p[3] = {0, 0, 0};
  for (i32 f = 0; f < 6; f++) {
    const i32 axis = F[f][0], ua = F[f][2], va = F[f][4];
    const double sign = F[f][1], au = F[f][3], av = F[f][5];
    box_coords(H[ua], r, seg, au, us);
    box_coords(H[va], r, seg, av, vs);
    const i32 n = side;
    const i32 base = o.vc;
    for (i32 j = 0; j < n; j++) {
      for (i32 i = 0; i < n; i++) {
        p[axis] = sign * H[axis];
        p[ua] = us[i];
        p[va] = vs[j];
        const double c0 = js_max(-(H[0] - r), js_min(H[0] - r, p[0]));
        const double c1 = js_max(-(H[1] - r), js_min(H[1] - r, p[1]));
        const double c2 = js_max(-(H[2] - r), js_min(H[2] - r, p[2]));
        double nx = p[0] - c0, ny = p[1] - c1, nz = p[2] - c2;
        const double l = js_hypot3(nx, ny, nz);
        if (l > 1e-12) {
          nx /= l;
          ny /= l;
          nz /= l;
        } else {
          // only reachable for r = 0: use the face normal
          nx = axis == 0 ? sign : 0;
          ny = axis == 1 ? sign : 0;
          nz = axis == 2 ? sign : 0;
        }
        vtx(&o, c0 + nx * r, c1 + ny * r, c2 + nz * r, nx, ny, nz, (us[i] / H[ua] / au + 1) / 2, (vs[j] / H[va] / av + 1) / 2);
      }
    }
    for (i32 j = 0; j < n - 1; j++)
      for (i32 i = 0; i < n - 1; i++) {
        const i32 a = base + j * n + i;
        quad(&o, a, a + 1, a + n + 1, a + n);
      }
  }
  return done(&o);
}

// --- Catmull-Rom spines ---

/** Point i of the control polygon, extended past the ends of an open one. */
static void control(const double *pts, i32 n, int closed, i32 i, double *out) {
  if (closed) {
    const i32 k = ((i % n) + n) % n;
    out[0] = pts[k * 3];
    out[1] = pts[k * 3 + 1];
    out[2] = pts[k * 3 + 2];
  } else if (i < 0) {
    for (int c = 0; c < 3; c++) out[c] = 2 * pts[c] - pts[3 + c];
  } else if (i > n - 1) {
    for (int c = 0; c < 3; c++) out[c] = 2 * pts[(n - 1) * 3 + c] - pts[(n - 2) * 3 + c];
  } else {
    out[0] = pts[i * 3];
    out[1] = pts[i * 3 + 1];
    out[2] = pts[i * 3 + 2];
  }
}

static inline double knot(const double *a, const double *b) { return js_max(js_sqrt(js_hypot3(b[0] - a[0], b[1] - a[1], b[2] - a[2])), 1e-6); }

static inline void lerp(double *o, const double *a, const double *b, double u, double ta, double tb) {
  const double w = (u - ta) / (tb - ta);
  o[0] = a[0] + (b[0] - a[0]) * w;
  o[1] = a[1] + (b[1] - a[1]) * w;
  o[2] = a[2] + (b[2] - a[2]) * w;
}

static u32 spine_result[2];

/** catmullRom for n >= 2 points: a pointer to {point count, points}. */
EXPORT("catmull_rom") u32 *catmull_rom(const double *pts, i32 n, i32 closed, i32 subdivisions) {
  const i32 segs = closed ? n : n - 1;
  const i32 count = segs * subdivisions + (closed ? 0 : 1);
  double *out = es3d_alloc((u32)(count > 0 ? count : 1) * 24u);
  if (!out) return 0;
  double p0[3], p1[3], p2[3], p3[3], A1[3], A2[3], A3[3], B1[3], B2[3], C[3];
  i32 k = 0;
  for (i32 s = 0; s < segs; s++) {
    control(pts, n, closed, s - 1, p0);
    control(pts, n, closed, s, p1);
    control(pts, n, closed, s + 1, p2);
    control(pts, n, closed, s + 2, p3);
    const double t0 = 0;
    const double t1 = t0 + knot(p0, p1);
    const double t2 = t1 + knot(p1, p2);
    const double t3 = t2 + knot(p2, p3);
    for (i32 q = 0; q < subdivisions; q++) {
      const double u = t1 + ((t2 - t1) * q) / subdivisions;
      lerp(A1, p0, p1, u, t0, t1);
      lerp(A2, p1, p2, u, t1, t2);
      lerp(A3, p2, p3, u, t2, t3);
      lerp(B1, A1, A2, u, t0, t2);
      lerp(B2, A2, A3, u, t1, t3);
      lerp(C, B1, B2, u, t1, t2);
      out[k++] = C[0];
      out[k++] = C[1];
      out[k++] = C[2];
    }
  }
  if (!closed) {
    control(pts, n, closed, n - 1, C);
    out[k++] = C[0];
    out[k++] = C[1];
    out[k++] = C[2];
  }
  spine_result[0] = (u32)(k / 3);
  spine_result[1] = (u32)out;
  return spine_result;
}

// --- involute gears ---

static inline double inv(double a) { return js_tan(a) - a; }

static u32 gear_result[5];

/**
 * gearOutline: a pointer to {point count, points (x y), smooth flags, outer
 * radius (f64 bits, two words) ...}: see the JavaScript side for the layout.
 */
EXPORT("gear_outline") u32 *gear_outline(i32 teeth, double pressureAngleDeg, i32 flankSamples, i32 arcSamples) {
  const i32 N = teeth;
  const double alpha = (pressureAngleDeg * PI) / 180;
  const double rp = N / 2.0;
  const double rb = rp * js_cos(alpha);
  double ra = rp + 1;
  const double rf = rp - 1.25;
  const double psi = PI / (2 * N);
  const double invA = inv(alpha);
#define HALF(r) (psi + invA - inv(js_acos(js_min(1, rb / (r)))))
  // pointed teeth: shrink the tip radius until the tip keeps some width
  if (HALF(ra) < psi * 0.15) {
    double lo = js_max(rb, rf), hi = ra;
    for (i32 k = 0; k < 40; k++) {
      const double mid = (lo + hi) / 2;
      if (HALF(mid) > psi * 0.15) lo = mid;
      else hi = mid;
    }
    ra = lo;
  }
  const double rStart = js_max(rb, rf);
  const i32 per = (arcSamples - 1) + 2 + flankSamples + (arcSamples - 1) + flankSamples + 2;
  double *pts = es3d_alloc((u32)(N * per > 0 ? N * per : 1) * 16u);
  u8 *smooth = es3d_alloc((u32)(N * per > 0 ? N * per : 1));
  double *radii = es3d_alloc(16);
  if (!pts || !smooth || !radii) return 0;
  i32 k = 0;
#define ADD(r, a, s) (pts[k * 2] = (r) * js_cos(a), pts[k * 2 + 1] = (r) * js_sin(a), smooth[k] = (s) ? 1 : 0, k++)
  const double pitchAngle = TAU / N;
  for (i32 t = 0; t < N; t++) {
    const double c = t * pitchAngle;
    const double leftRoot = c - HALF(rStart);
    const double rightRoot = c + HALF(rStart);
    const double prevRightRoot = c - pitchAngle + HALF(rStart);
    // root arc from the previous tooth to this one
    for (i32 i = 1; i < arcSamples; i++) ADD(rf, prevRightRoot + ((leftRoot - prevRightRoot) * i) / arcSamples, 1);
    // left flank: radial segment (when the root is inside the base circle) then involute
    ADD(rf, leftRoot, 0);
    if (rf < rStart - 1e-9) ADD(rStart, leftRoot, 0);
    for (i32 i = 1; i <= flankSamples; i++) {
      const double r = rStart + ((ra - rStart) * i) / flankSamples;
      ADD(r, c - HALF(r), i < flankSamples);
    }
    // tip arc
    const double tipL = c - HALF(ra), tipR = c + HALF(ra);
    for (i32 i = 1; i < arcSamples; i++) ADD(ra, tipL + ((tipR - tipL) * i) / arcSamples, 1);
    // right flank going down
    for (i32 i = flankSamples; i >= 1; i--) {
      const double r = rStart + ((ra - rStart) * i) / flankSamples;
      ADD(r, c + HALF(r), i < flankSamples);
    }
    if (rf < rStart - 1e-9) ADD(rStart, rightRoot, 0);
    ADD(rf, rightRoot, 0);
  }
#undef ADD
#undef HALF
  radii[0] = ra;
  radii[1] = rf;
  gear_result[0] = (u32)k;
  gear_result[1] = (u32)pts;
  gear_result[2] = (u32)smooth;
  gear_result[3] = (u32)radii;
  return gear_result;
}
