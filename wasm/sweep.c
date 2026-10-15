// Sweeps: rotation-minimising spine frames, profile rings, walls and caps,
// the operations of spineFrames and sweepMesh in src/geometry/sweep.js in the
// same order, including the profile's contour frames and, for a shaped
// profile, the triangulated caps.

#include "geometry.h"

static const double TAU = 6.283185307179586; // Math.PI * 2

/** Unit vector of (x, y, z) into out[0..2] (zero when degenerate), as vec3 normalize. */
static void normalize_into(double *out, double x, double y, double z) {
  const double l = js_hypot3(x, y, z);
  if (l > 1e-20) {
    out[0] = x / l;
    out[1] = y / l;
    out[2] = z / l;
  } else out[0] = out[1] = out[2] = 0;
}

typedef struct {
  i32 count, closed;
  double *pos, *T, *N, *B, *K, *stretch, *arc;
  double length;
} Frames;

/** spineFrames: returns 0 when the spine has fewer than two distinct points, -1 when memory ran out. */
static i32 spine_frames(const double *points, i32 np, i32 closed, Frames *fr) {
  // dedupe: drop repeated points (and a closing point equal to the first)
  double *p = es3d_alloc((u32)(np > 0 ? np : 1) * 24u);
  if (!p) return -1;
  i32 k = 0;
  for (i32 i = 0; i < np; i++) {
    const double x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
    if (k && js_hypot3(p[k - 3] - x, p[k - 2] - y, p[k - 1] - z) < 1e-9) continue;
    p[k++] = x;
    p[k++] = y;
    p[k++] = z;
  }
  if (closed && k > 6) {
    if (js_hypot3(p[0] - p[k - 3], p[1] - p[k - 2], p[2] - p[k - 1]) < 1e-9) k -= 3;
  }
  const i32 n = k / 3;
  if (n < 2) return 0;
  const i32 count = closed ? n + 1 : n;
  double *pos = es3d_alloc((u32)count * 24u);
  const i32 nd = count - 1;
  double *dirs = es3d_alloc((u32)nd * 24u);
  double *T = es3d_alloc((u32)count * 24u), *K = es3d_alloc((u32)count * 24u), *N = es3d_alloc((u32)count * 24u), *B = es3d_alloc((u32)count * 24u);
  double *stretch = es3d_alloc((u32)count * 8u), *arc = es3d_alloc((u32)count * 8u);
  if (!pos || !dirs || !T || !K || !N || !B || !stretch || !arc) return -1;
  for (i32 i = 0; i < count; i++) {
    const i32 s = (i % n) * 3;
    pos[i * 3] = p[s];
    pos[i * 3 + 1] = p[s + 1];
    pos[i * 3 + 2] = p[s + 2];
  }
  for (i32 i = 0; i < nd; i++) normalize_into(dirs + i * 3, pos[i * 3 + 3] - pos[i * 3], pos[i * 3 + 4] - pos[i * 3 + 1], pos[i * 3 + 5] - pos[i * 3 + 2]);
  for (i32 i = 0; i < count; i++) {
    const i32 d0 = 3 * (closed ? (i - 1 + nd) % nd : (i - 1 > 0 ? i - 1 : 0));
    const i32 d1 = 3 * (closed ? i % nd : (nd - 1 < i ? nd - 1 : i));
    double *t = T + i * 3;
    normalize_into(t, dirs[d0] + dirs[d1], dirs[d0 + 1] + dirs[d1 + 1], dirs[d0 + 2] + dirs[d1 + 2]);
    if (t[0] == 0 && t[1] == 0 && t[2] == 0) {
      t[0] = dirs[d1];
      t[1] = dirs[d1 + 1];
      t[2] = dirs[d1 + 2];
    }
    const double c = js_max(t[0] * dirs[d1] + t[1] * dirs[d1 + 1] + t[2] * dirs[d1 + 2], 0.25);
    normalize_into(K + i * 3, dirs[d1] - dirs[d0], dirs[d1 + 1] - dirs[d0 + 1], dirs[d1 + 2] - dirs[d0 + 2]);
    stretch[i] = 1 / c;
  }
  // initial normal: the world up direction projected onto the plane of T0
  const double tx = T[0], ty = T[1], tz = T[2];
  const double ux = js_abs(ty) < 0.99 ? 0 : 1, uy = js_abs(ty) < 0.99 ? 1 : 0, uz = 0;
  const double wx = ty * uz - tz * uy, wy = tz * ux - tx * uz, wz = tx * uy - ty * ux;
  normalize_into(N, wy * tz - wz * ty, wz * tx - wx * tz, wx * ty - wy * tx);
  if (N[0] == 0 && N[1] == 0 && N[2] == 0) {
    // perpendicular(T0): cross with the axis T0 is least aligned with
    const double ax = js_abs(tx), ay = js_abs(ty), az = js_abs(tz);
    double ox, oy, oz;
    if (ax <= ay && ax <= az) ox = 1, oy = 0, oz = 0;
    else if (ay <= az) ox = 0, oy = 1, oz = 0;
    else ox = 0, oy = 0, oz = 1;
    normalize_into(N, ty * oz - tz * oy, tz * ox - tx * oz, tx * oy - ty * ox);
  }
  // rotation minimising frames: double reflection
  for (i32 i = 0; i < count - 1; i++) {
    const i32 o = i * 3;
    const double v1x = pos[o + 3] - pos[o], v1y = pos[o + 4] - pos[o + 1], v1z = pos[o + 5] - pos[o + 2];
    const double c1 = v1x * v1x + v1y * v1y + v1z * v1z;
    double rx = N[o], ry = N[o + 1], rz = N[o + 2];
    double lx = T[o], ly = T[o + 1], lz = T[o + 2];
    if (c1 > 0) {
      const double sr = (2 / c1) * (v1x * rx + v1y * ry + v1z * rz);
      rx = rx - v1x * sr;
      ry = ry - v1y * sr;
      rz = rz - v1z * sr;
      const double st = (2 / c1) * (v1x * lx + v1y * ly + v1z * lz);
      lx = lx - v1x * st;
      ly = ly - v1y * st;
      lz = lz - v1z * st;
    }
    const double v2x = T[o + 3] - lx, v2y = T[o + 4] - ly, v2z = T[o + 5] - lz;
    const double c2 = v2x * v2x + v2y * v2y + v2z * v2z;
    if (c2 > 1e-20) {
      const double s2 = (2 / c2) * (v2x * rx + v2y * ry + v2z * rz);
      rx = rx - v2x * s2;
      ry = ry - v2y * s2;
      rz = rz - v2z * s2;
    }
    normalize_into(N + o + 3, rx, ry, rz);
  }
  if (closed) {
    // distribute the residual rotation so the last frame matches the first
    const i32 o = (count - 1) * 3;
    const double ax = N[o + 1] * N[2] - N[o + 2] * N[1], ay = N[o + 2] * N[0] - N[o] * N[2], az = N[o] * N[1] - N[o + 1] * N[0];
    const double ang = js_atan2(ax * T[0] + ay * T[1] + az * T[2], N[o] * N[0] + N[o + 1] * N[1] + N[o + 2] * N[2]);
    for (i32 i = 0; i < count; i++) {
      // Rodrigues rotation of N[i] around T[i]
      const double angle = (ang * i) / (count - 1);
      const double c = js_cos(angle), s = js_sin(angle);
      const i32 q = i * 3;
      const double vx = N[q], vy = N[q + 1], vz = N[q + 2];
      const double kx = T[q], ky = T[q + 1], kz = T[q + 2];
      const double cx = ky * vz - kz * vy, cy = kz * vx - kx * vz, cz = kx * vy - ky * vx;
      const double kd = (kx * vx + ky * vy + kz * vz) * (1 - c);
      N[q] = vx * c + cx * s + kx * kd;
      N[q + 1] = vy * c + cy * s + ky * kd;
      N[q + 2] = vz * c + cz * s + kz * kd;
    }
    N[o] = N[0];
    N[o + 1] = N[1];
    N[o + 2] = N[2];
  }
  for (i32 i = 0; i < count * 3; i += 3) {
    B[i] = T[i + 1] * N[i + 2] - T[i + 2] * N[i + 1];
    B[i + 1] = T[i + 2] * N[i] - T[i] * N[i + 2];
    B[i + 2] = T[i] * N[i + 1] - T[i + 1] * N[i];
  }
  arc[0] = 0;
  for (i32 i = 1; i < count; i++) arc[i] = arc[i - 1] + js_hypot3(pos[i * 3] - pos[i * 3 - 3], pos[i * 3 + 1] - pos[i * 3 - 2], pos[i * 3 + 2] - pos[i * 3 - 1]);
  fr->count = count;
  fr->closed = closed;
  fr->pos = pos;
  fr->T = T;
  fr->N = N;
  fr->B = B;
  fr->K = K;
  fr->stretch = stretch;
  fr->arc = arc;
  fr->length = arc[count - 1];
  return 1;
}

typedef struct {
  const Frames *fr;
  const double *ks, *cas, *sas;
  double dscale;
} Station;

/** placeAt: position of profile point (px, py) at station i. */
static inline void place_at(double *out, const Station *st, i32 i, double px, double py) {
  const Frames *fr = st->fr;
  const double k = st->ks[i], ca = st->cas[i], sa = st->sas[i];
  const double x = (px * ca - py * sa) * k;
  const double y = (px * sa + py * ca) * k;
  const i32 i3 = i * 3;
  const double *Nf = fr->N, *Bf = fr->B, *Kf = fr->K, *Pf = fr->pos;
  double ox = Nf[i3] * x + Bf[i3] * y, oy = Nf[i3 + 1] * x + Bf[i3 + 1] * y, oz = Nf[i3 + 2] * x + Bf[i3 + 2] * y;
  // miter stretch along the bend axis
  const double s = fr->stretch[i];
  if (s > 1.0001) {
    const double d = (ox * Kf[i3] + oy * Kf[i3 + 1] + oz * Kf[i3 + 2]) * (s - 1);
    ox = ox + Kf[i3] * d;
    oy = oy + Kf[i3 + 1] * d;
    oz = oz + Kf[i3 + 2] * d;
  }
  out[0] = Pf[i3] + ox;
  out[1] = Pf[i3 + 1] + oy;
  out[2] = Pf[i3 + 2] + oz;
}

/** stationNormal: normal at station i of profile point (px, py) whose 2D normal is (nx, ny). */
static inline void station_normal(float *out, const Station *st, i32 i, double px, double py, double nx, double ny) {
  const Frames *fr = st->fr;
  const double ca = st->cas[i], sa = st->sas[i];
  const double qx = nx * ca - ny * sa;
  const double qy = nx * sa + ny * ca;
  const i32 i3 = i * 3;
  const double *Nf = fr->N, *Bf = fr->B, *Tf = fr->T;
  double n0 = Nf[i3] * qx + Bf[i3] * qy, n1 = Nf[i3 + 1] * qx + Bf[i3 + 1] * qy, n2 = Nf[i3 + 2] * qx + Bf[i3 + 2] * qy;
  if (st->dscale != 0) {
    // taper tilts the surface along the spine
    const double slope = st->dscale * (px * nx + py * ny);
    const double a0 = n0 - Tf[i3] * slope, a1 = n1 - Tf[i3 + 1] * slope, a2 = n2 - Tf[i3 + 2] * slope;
    const double l = js_hypot3(a0, a1, a2);
    if (l > 1e-20) {
      n0 = a0 / l;
      n1 = a1 / l;
      n2 = a2 / l;
    } else n0 = n1 = n2 = 0;
  }
  out[0] = (float)n0;
  out[1] = (float)n1;
  out[2] = (float)n2;
}

static u32 result[9];

typedef struct {
  float *p, *n, *t;
  u32 *i;
  i32 vc, ic;
} Out;

static inline i32 vertex(Out *o, const double *p, const float *nrm, double u, double v) {
  const i32 k = o->vc++;
  o->p[k * 3] = (float)p[0];
  o->p[k * 3 + 1] = (float)p[1];
  o->p[k * 3 + 2] = (float)p[2];
  o->n[k * 3] = nrm[0];
  o->n[k * 3 + 1] = nrm[1];
  o->n[k * 3 + 2] = nrm[2];
  o->t[k * 2] = (float)u;
  o->t[k * 2 + 1] = (float)v;
  return k;
}

static inline void tri(Out *o, i32 a, i32 b, i32 c) {
  o->i[o->ic++] = (u32)a;
  o->i[o->ic++] = (u32)b;
  o->i[o->ic++] = (u32)c;
}

/**
 * The sweep. Input layout (i32 words at `in`):
 *   [0] spine count S, [1] pointer to S x {points pointer, point count, closed}
 *   [2] contour count, [3] pointer to {n, points, smooth, isWall} records
 *   [4] profile contour count C, [5] pointer to their indices in the contour table
 *   [6] cap kind (1 circle, 2 regions), [7] circle point count m or region count,
 *   [8] circle points pointer or pointer to {first contour, contour count} region records
 *   [9] caps (0 or 1)
 * Returns a pointer to {vertex count, index count, positions, normals, uvs,
 * indices, open, degenerate flags (one byte per spine), one triangulation
 * error per cap region}, or 0 when JavaScript must do it.
 */
EXPORT("sweep") u32 *sweep(const i32 *in, double twist, double taper) {
  const i32 S = in[0];
  const i32 *spines = (const i32 *)in[1];
  const ContourIn *table = (const ContourIn *)in[3];
  const i32 C = in[4];
  const i32 *profile = (const i32 *)in[5];
  const i32 cap_kind = in[6], cap_count = in[7];
  const i32 caps = in[9];
  const double *circle = cap_kind == 1 ? (const double *)in[8] : 0;
  const i32 *region_tab = cap_kind == 2 ? (const i32 *)in[8] : 0;
  // cap regions first (their warnings come before anything else), then the profile's frames
  Cap *cap_tris = es3d_alloc((u32)(cap_kind == 2 && cap_count > 0 ? cap_count : 1) * sizeof(Cap));
  double *errors = es3d_alloc((u32)(cap_kind == 2 && cap_count > 0 ? cap_count : 1) * 8u);
  Frames2 *contours = es3d_alloc((u32)(C > 0 ? C : 1) * sizeof(Frames2));
  const double **cpts = es3d_alloc((u32)(C > 0 ? C : 1) * 4u);
  if (!cap_tris || !errors || !contours || !cpts) return 0;
  if (cap_kind == 2) {
    for (i32 r = 0; r < cap_count; r++) {
      const ContourIn *outer = &table[region_tab[r * 2]];
      if (!triangulate_region(outer, outer + 1, region_tab[r * 2 + 1] - 1, 0, &cap_tris[r])) return 0;
      errors[r] = cap_tris[r].error;
    }
  }
  for (i32 c = 0; c < C; c++) {
    const ContourIn *ci = &table[profile[c]];
    if (!contour_frames(ci->pts, ci->n, ci->smooth, 1, &contours[c])) return 0;
    cpts[c] = ci->pts;
  }

  // frames first, so the mesh can be allocated once at its final size
  Frames *frames = es3d_alloc((u32)(S > 0 ? S : 1) * sizeof(Frames));
  u8 *degenerate = es3d_alloc((u32)(S > 0 ? S : 1));
  if (!frames || !degenerate) return 0;
  i32 vertices = 0, indices = 0;
  for (i32 s = 0; s < S; s++) {
    const i32 r = spine_frames((const double *)spines[s * 3], spines[s * 3 + 1], spines[s * 3 + 2], &frames[s]);
    if (r < 0) return 0;
    degenerate[s] = r == 0;
    if (r == 0) continue;
    const Frames *fr = &frames[s];
    for (i32 c = 0; c < C; c++) {
      vertices += contours[c].n * fr->count * 2;
      indices += contours[c].n * (fr->count - 1) * 6;
    }
    if (!fr->closed && caps) {
      if (cap_kind == 1) {
        vertices += 2 * (cap_count + 1);
        indices += 2 * cap_count * 3;
      } else {
        for (i32 t = 0; t < cap_count; t++) {
          vertices += cap_tris[t].np;
          indices += 2 * cap_tris[t].ni;
        }
      }
    }
  }
  Out o = {0};
  o.p = es3d_alloc((u32)(vertices > 0 ? vertices : 1) * 12u);
  o.n = es3d_alloc((u32)(vertices > 0 ? vertices : 1) * 12u);
  o.t = es3d_alloc((u32)(vertices > 0 ? vertices : 1) * 8u);
  o.i = es3d_alloc((u32)(indices > 0 ? indices : 1) * 4u);
  if (!o.p || !o.n || !o.t || !o.i) return 0;
  i32 open = 0;
  double pt[3];
  float nrm[3];

  for (i32 s = 0; s < S; s++) {
    if (degenerate[s]) continue;
    const Frames *fr = &frames[s];
    const i32 count = fr->count;
    const double L = js_or(fr->length, 1);
    Station st;
    st.fr = fr;
    st.dscale = (taper - 1) / L;
    double *ks = es3d_alloc((u32)count * 8u), *cas = es3d_alloc((u32)count * 8u), *sas = es3d_alloc((u32)count * 8u);
    if (!ks || !cas || !sas) return 0;
    // twist and taper only depend on the station
    for (i32 i = 0; i < count; i++) {
      const double t = fr->arc[i] / L;
      ks[i] = 1 + (taper - 1) * t;
      const double ang = twist * t;
      cas[i] = js_cos(ang);
      sas[i] = js_sin(ang);
    }
    st.ks = ks;
    st.cas = cas;
    st.sas = sas;

    for (i32 c = 0; c < C; c++) {
      const Frames2 *f = &contours[c];
      const i32 n = f->n;
      const double *pts = cpts[c];
      // every profile point at every station, computed once for both of its edges
      double *ring = es3d_alloc((u32)(count * n > 0 ? count * n : 1) * 24u);
      if (!ring) return 0;
      for (i32 q = 0; q < count; q++)
        for (i32 j = 0; j < n; j++) place_at(ring + (q * n + j) * 3, &st, q, pts[j * 2], pts[j * 2 + 1]);
      const double perim = js_or(f->length, 1);
      for (i32 e = 0; e < n; e++) {
        const i32 i0 = e, i1 = (e + 1) % n;
        const int c0 = f->corner[i0], c1 = f->corner[i1];
        const double n0x = c0 ? f->edgeN[e * 2] : f->vertN[i0 * 2], n0y = c0 ? f->edgeN[e * 2 + 1] : f->vertN[i0 * 2 + 1];
        const double n1x = c1 ? f->edgeN[e * 2] : f->vertN[i1 * 2], n1y = c1 ? f->edgeN[e * 2 + 1] : f->vertN[i1 * 2 + 1];
        const double u0 = f->arc[e] / perim, u1 = f->arc[e + 1] / perim;
        const double p0x = pts[i0 * 2], p0y = pts[i0 * 2 + 1], p1x = pts[i1 * 2], p1y = pts[i1 * 2 + 1];
        i32 prevA = -1, prevB = -1;
        for (i32 q = 0; q < count; q++) {
          const double v = fr->arc[q] / perim;
          station_normal(nrm, &st, q, p0x, p0y, n0x, n0y);
          const i32 a = vertex(&o, ring + (q * n + i0) * 3, nrm, u0, v);
          station_normal(nrm, &st, q, p1x, p1y, n1x, n1y);
          const i32 c2 = vertex(&o, ring + (q * n + i1) * 3, nrm, u1, v);
          if (prevA >= 0) {
            tri(&o, prevA, prevB, c2);
            tri(&o, prevA, c2, a);
          }
          prevA = a;
          prevB = c2;
        }
      }
    }

    if (!fr->closed) {
      if (!caps) open = 1;
      else {
        for (i32 end = 0; end < 2; end++) {
          const i32 q = end ? count - 1 : 0;
          const double dir = end ? 1 : -1;
          nrm[0] = (float)(fr->T[q * 3] * dir);
          nrm[1] = (float)(fr->T[q * 3 + 1] * dir);
          nrm[2] = (float)(fr->T[q * 3 + 2] * dir);
          if (cap_kind == 1) {
            place_at(pt, &st, q, 0, 0);
            const i32 ci = vertex(&o, pt, nrm, 0.5, 0.5);
            const i32 m = cap_count;
            const i32 first = o.vc;
            for (i32 j = 0; j < m; j++) {
              place_at(pt, &st, q, circle[j * 2], circle[j * 2 + 1]);
              vertex(&o, pt, nrm, 0.5 + js_cos(((double)j / m) * TAU) / 2, 0.5 + js_sin(((double)j / m) * TAU) / 2);
            }
            for (i32 j = 0; j < m; j++) {
              const i32 a = first + j, c2 = first + ((j + 1) % m);
              if (dir > 0) tri(&o, ci, a, c2);
              else tri(&o, ci, c2, a);
            }
          } else {
            for (i32 t = 0; t < cap_count; t++) {
              const i32 np = cap_tris[t].np;
              const double *p = cap_tris[t].positions;
              const i32 ni = cap_tris[t].ni;
              const u32 *idx = cap_tris[t].indices;
              const i32 base = o.vc;
              for (i32 k = 0; k < np; k += 2) {
                place_at(pt, &st, q, p[k], p[k + 1]);
                vertex(&o, pt, nrm, p[k], p[k + 1]);
              }
              for (i32 k = 0; k < ni; k += 3) {
                if (dir > 0) tri(&o, base + (i32)idx[k], base + (i32)idx[k + 1], base + (i32)idx[k + 2]);
                else tri(&o, base + (i32)idx[k], base + (i32)idx[k + 2], base + (i32)idx[k + 1]);
              }
            }
          }
        }
      }
    }
  }
  result[0] = (u32)o.vc;
  result[1] = (u32)o.ic;
  result[2] = (u32)o.p;
  result[3] = (u32)o.n;
  result[4] = (u32)o.t;
  result[5] = (u32)o.i;
  result[6] = (u32)open;
  result[7] = (u32)degenerate;
  result[8] = (u32)errors;
  return result;
}
