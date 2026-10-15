// The chordal-error bound of the UV sphere: measureSphereDeviation in
// src/geometry/lod-error.js, in the same order of operations.

#include "runtime.h"

static double edge_distance(double ax, double ay, double az, double bx, double by, double bz) {
  const double abx = bx - ax, aby = by - ay, abz = bz - az;
  const double ab2 = abx * abx + aby * aby + abz * abz;
  double t = ab2 > 0 ? -(ax * abx + ay * aby + az * abz) / ab2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return js_hypot3(ax + abx * t, ay + aby * t, az + abz * t);
}

static double closest_distance_to_origin(double ax, double ay, double az, double bx, double by, double bz, double cx, double cy, double cz) {
  const double abx = bx - ax, aby = by - ay, abz = bz - az;
  const double acx = cx - ax, acy = cy - ay, acz = cz - az;
  double nx = aby * acz - abz * acy;
  double ny = abz * acx - abx * acz;
  double nz = abx * acy - aby * acx;
  const double nl = js_hypot3(nx, ny, nz);
  if (nl < 1e-14) return 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const double d = ax * nx + ay * ny + az * nz;
  const double fx = d * nx, fy = d * ny, fz = d * nz;
  const double v0x = acx, v0y = acy, v0z = acz;
  const double v1x = abx, v1y = aby, v1z = abz;
  const double v2x = fx - ax, v2y = fy - ay, v2z = fz - az;
  const double d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const double d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const double d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const double d02 = v0x * v2x + v0y * v2y + v0z * v2z;
  const double d12 = v1x * v2x + v1y * v2y + v1z * v2z;
  const double det = d00 * d11 - d01 * d01;
  if (js_abs(det) > 1e-18) {
    const double inv = 1 / det;
    const double u = (d11 * d02 - d01 * d12) * inv;
    const double v = (d00 * d12 - d01 * d02) * inv;
    if (u >= -1e-5 && v >= -1e-5 && u + v <= 1 + 1e-5) return js_abs(d);
  }
  return js_min(js_min(edge_distance(ax, ay, az, bx, by, bz), edge_distance(bx, by, bz, cx, cy, cz)), edge_distance(cx, cy, cz, ax, ay, az));
}

/** Maximum radial error of the reference UV sphere with w segments (w >= 3). */
EXPORT("sphere_deviation") double sphere_deviation(i32 w) {
  const i32 h = w / 2 + (w % 2); // Math.round(w / 2) for positive w
  const i32 hRings = h > 2 ? h : 2;
  double *st = es3d_alloc((u32)(hRings + 1) * 8u), *ct = es3d_alloc((u32)(hRings + 1) * 8u);
  double *cp = es3d_alloc((u32)(w + 1) * 8u), *sp = es3d_alloc((u32)(w + 1) * 8u);
  if (!st || !ct || !cp || !sp) return -1;
  for (i32 j = 0; j <= hRings; j++) {
    const double th = ((double)j / hRings) * 3.141592653589793;
    st[j] = js_sin(th);
    ct[j] = js_cos(th);
  }
  for (i32 i = 0; i <= w; i++) {
    const double ph = ((double)(i % w) / w) * 6.283185307179586;
    cp[i] = js_cos(ph);
    sp[i] = js_sin(ph);
  }
  double max = 0;
  for (i32 j = 0; j < hRings; j++) {
    for (i32 i = 0; i < w; i++) {
      // quad corners a (i, j), b (i, j + 1), c (i + 1, j + 1), d (i + 1, j)
      const double ax = st[j] * cp[i], ay = ct[j], az = -st[j] * sp[i];
      const double bx = st[j + 1] * cp[i], by = ct[j + 1], bz = -st[j + 1] * sp[i];
      const double cx = st[j + 1] * cp[i + 1], cy = ct[j + 1], cz = -st[j + 1] * sp[i + 1];
      const double dx = st[j] * cp[i + 1], dy = ct[j], dz = -st[j] * sp[i + 1];
      if (j != hRings - 1) {
        const double e = 1 - closest_distance_to_origin(ax, ay, az, bx, by, bz, cx, cy, cz);
        if (e > max) max = e;
      }
      if (j != 0) {
        const double e = 1 - closest_distance_to_origin(ax, ay, az, cx, cy, cz, dx, dy, dz);
        if (e > max) max = e;
      }
    }
  }
  return max;
}
