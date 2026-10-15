// Contour frames, inset contours and triangulated regions: contourFrames
// (src/geometry/contour.js), insetPoints (extrude.js), triangulateRegion
// (path/shapes.js) and triangulationError (path/triangulate.js), operation
// for operation.

#include "geometry.h"

static const double MAX_MITER = 4;

int contour_frames(const double *points, i32 n, const u8 *smooth, int closed, Frames2 *f) {
  const i32 edges = closed ? n : n - 1;
  double *edgeN = es3d_alloc((u32)(edges > 0 ? edges : 1) * 16u);
  double *vertN = es3d_alloc((u32)(n > 0 ? n : 1) * 16u), *miter = es3d_alloc((u32)(n > 0 ? n : 1) * 16u);
  u8 *corner = es3d_alloc((u32)(n > 0 ? n : 1));
  double *arc = es3d_alloc((u32)(n + 1) * 8u);
  if (!edgeN || !vertN || !miter || !corner || !arc) return 0;
  for (i32 i = 0; i < edges; i++) {
    const i32 j = (i + 1) % n;
    const double dx = points[j * 2] - points[i * 2];
    const double dy = points[j * 2 + 1] - points[i * 2 + 1];
    const double l = js_or(js_hypot2(dx, dy), 1);
    edgeN[i * 2] = dy / l;
    edgeN[i * 2 + 1] = -dx / l;
  }
  for (i32 i = 0; i < n; i++) {
    const int has_prev = closed || i > 0;
    const int has_next = closed || i < n - 1;
    const i32 pe = has_prev ? (i - 1 + edges) % edges : -1;
    const i32 ne = has_next ? i % edges : -1;
    double ax = 0, ay = 0, bx = 0, by = 0;
    if (pe >= 0) {
      ax = edgeN[pe * 2];
      ay = edgeN[pe * 2 + 1];
    }
    if (ne >= 0) {
      bx = edgeN[ne * 2];
      by = edgeN[ne * 2 + 1];
    }
    if (pe < 0) {
      ax = bx;
      ay = by;
    }
    if (ne < 0) {
      bx = ax;
      by = ay;
    }
    double mx = ax + bx, my = ay + by;
    double ml = js_hypot2(mx, my);
    if (ml < 1e-9) {
      mx = ax;
      my = ay;
      ml = 1;
    }
    mx /= ml;
    my /= ml;
    vertN[i * 2] = mx;
    vertN[i * 2 + 1] = my;
    const double cos_half = js_max(mx * ax + my * ay, 1 / MAX_MITER);
    miter[i * 2] = mx / cos_half;
    miter[i * 2 + 1] = my / cos_half;
    corner[i] = smooth && smooth[i] ? 0 : 1;
  }
  arc[0] = 0;
  for (i32 i = 1; i <= n; i++) {
    if (!closed && i == n) {
      arc[i] = arc[i - 1];
      break;
    }
    const i32 a = (i - 1) % n, b = i % n;
    arc[i] = arc[i - 1] + js_hypot2(points[b * 2] - points[a * 2], points[b * 2 + 1] - points[a * 2 + 1]);
  }
  f->n = n;
  f->edges = edges;
  f->edgeN = edgeN;
  f->vertN = vertN;
  f->miter = miter;
  f->corner = corner;
  f->arc = arc;
  f->length = arc[closed ? n : n - 1];
  return 1;
}

/** insetPoints: the contour's points moved by `amount` along the miters, into out. */
static int inset_into(const ContourIn *c, double amount, double *out) {
  if (!(amount != 0 && amount == amount) || !c->is_wall) {
    for (i32 i = 0; i < c->n * 2; i++) out[i] = c->pts[i];
    return 1;
  }
  Frames2 f;
  if (!contour_frames(c->pts, c->n, c->smooth, 1, &f)) return 0;
  for (i32 i = 0; i < c->n * 2; i += 2) {
    out[i] = c->pts[i] - f.miter[i] * amount;
    out[i + 1] = c->pts[i + 1] - f.miter[i + 1] * amount;
  }
  return 1;
}

static double poly_area(const double *data, i32 start, i32 end) {
  double s = 0;
  for (i32 i = start, j = end - 2; i < end; i += 2) {
    s += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
  }
  return js_abs(s / 2);
}

/** triangulationError: relative difference between the triangulated and the polygon area. */
static double triangulation_error(const double *data, i32 n, const i32 *holes, i32 nh, const u32 *tris, i32 ni) {
  const i32 outer_end = nh ? holes[0] * 2 : n;
  double expected = poly_area(data, 0, outer_end);
  for (i32 i = 0; i < nh; i++) {
    const i32 s = holes[i] * 2;
    const i32 e = i < nh - 1 ? holes[i + 1] * 2 : n;
    expected -= poly_area(data, s, e);
  }
  double actual = 0;
  for (i32 i = 0; i < ni; i += 3) {
    const u32 a = tris[i] * 2, b = tris[i + 1] * 2, c = tris[i + 2] * 2;
    actual += js_abs((data[a] - data[c]) * (data[b + 1] - data[a + 1]) - (data[a] - data[b]) * (data[c + 1] - data[a + 1])) / 2;
  }
  if (expected == 0 && actual == 0) return 0;
  return js_abs(expected - actual) / js_max(js_abs(expected), 1e-12);
}

int triangulate_region(const ContourIn *outer, const ContourIn *holes, i32 nholes, double inset, Cap *cap) {
  i32 total = outer->n * 2;
  for (i32 h = 0; h < nholes; h++) total += holes[h].n * 2;
  double *data = es3d_alloc((u32)(total > 0 ? total : 1) * 8u);
  i32 *hole_idx = es3d_alloc((u32)(nholes > 0 ? nholes : 1) * 4u);
  if (!data || !hole_idx) return 0;
  if (!inset_into(outer, inset, data)) return 0;
  i32 off = outer->n * 2;
  for (i32 h = 0; h < nholes; h++) {
    hole_idx[h] = off / 2;
    if (!inset_into(&holes[h], inset, data + off)) return 0;
    off += holes[h].n * 2;
  }
  i32 ni = 0;
  u32 *tris = earcut(data, total, hole_idx, nholes, &ni);
  if (!tris) return 0;
  cap->positions = data;
  cap->np = total;
  cap->indices = tris;
  cap->ni = ni;
  cap->error = triangulation_error(data, total, hole_idx, nholes, tris, ni);
  return 1;
}
