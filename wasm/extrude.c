// Extrusions: extrudeMesh in src/geometry/extrude.js from the regions and
// walls of a shape to the finished mesh (inset caps, their triangulation,
// contour frames, caps and walls), operation for operation. The bevel
// profile (wallProfile) and the bounds come from JavaScript.

#include "geometry.h"

static u32 result[7];

/**
 * Input layout (i32 words at `in`):
 *   [0] contour count, [1] pointer to {n, points, smooth, isWall} records
 *   [2] region count, [3] pointer to {first contour, contour count} records (outer, then holes)
 *   [4] wall count, [5] pointer to the walls' contour indices
 *   [6] ring count R, [7] pointer to R x {inset, z, nr, nz} (f64)
 * zTop = z0 + depth. Returns a pointer to {vertex count, index count,
 * positions, normals, uvs, indices, one triangulation error per region},
 * or 0 when JavaScript must do it.
 */
EXPORT("extrude") u32 *extrude(const i32 *in, double bevel, double z0, double zTop, double minX, double minY, double S) {
  const ContourIn *contours = (const ContourIn *)in[1];
  const i32 nregions = in[2];
  const i32 *regions = (const i32 *)in[3];
  const i32 nwalls = in[4];
  const i32 *wall_idx = (const i32 *)in[5];
  const i32 R = in[6];
  const double *rings = (const double *)in[7];
  // caps: the inset contours are triangulated directly
  Cap *caps = es3d_alloc((u32)(nregions > 0 ? nregions : 1) * sizeof(Cap));
  double *errors = es3d_alloc((u32)(nregions > 0 ? nregions : 1) * 8u);
  Frames2 *frames = es3d_alloc((u32)(nwalls > 0 ? nwalls : 1) * sizeof(Frames2));
  if (!caps || !errors || !frames) return 0;
  for (i32 r = 0; r < nregions; r++) {
    const ContourIn *outer = &contours[regions[r * 2]];
    if (!triangulate_region(outer, outer + 1, regions[r * 2 + 1] - 1, bevel, &caps[r])) return 0;
    errors[r] = caps[r].error;
  }
  for (i32 w = 0; w < nwalls; w++) {
    const ContourIn *c = &contours[wall_idx[w]];
    if (!contour_frames(c->pts, c->n, c->smooth, 1, &frames[w])) return 0;
  }
  // count first, so the mesh is allocated once at its final size
  i32 vertices = 0, indices = 0;
  for (i32 r = 0; r < nregions; r++) {
    vertices += caps[r].np;
    indices += 2 * caps[r].ni;
  }
  for (i32 w = 0; w < nwalls; w++) {
    vertices += frames[w].n * R * 2;
    indices += frames[w].n * (R - 1) * 6;
  }
  float *P = es3d_alloc((u32)(vertices > 0 ? vertices : 1) * 12u), *Nn = es3d_alloc((u32)(vertices > 0 ? vertices : 1) * 12u);
  float *T = es3d_alloc((u32)(vertices > 0 ? vertices : 1) * 8u);
  u32 *I = es3d_alloc((u32)(indices > 0 ? indices : 1) * 4u);
  if (!P || !Nn || !T || !I) return 0;
  i32 vc = 0, ic = 0;
#define VERTEX(px, py, pz, nx, ny, nz, u, v) \
  (P[vc * 3] = (float)(px), P[vc * 3 + 1] = (float)(py), P[vc * 3 + 2] = (float)(pz), Nn[vc * 3] = (float)(nx), Nn[vc * 3 + 1] = (float)(ny), \
   Nn[vc * 3 + 2] = (float)(nz), T[vc * 2] = (float)(u), T[vc * 2 + 1] = (float)(v), vc++)
  for (i32 r = 0; r < nregions; r++) {
    const double *flat = caps[r].positions;
    const u32 *idx = caps[r].indices;
    for (i32 side = 0; side < 2; side++) {
      const double z = side ? z0 : zTop, nz = side ? -1 : 1;
      const i32 base = vc;
      for (i32 i = 0; i < caps[r].np; i += 2) VERTEX(flat[i], flat[i + 1], z, 0, 0, nz, (flat[i] - minX) / S, (flat[i + 1] - minY) / S);
      for (i32 i = 0; i < caps[r].ni; i += 3) {
        I[ic++] = (u32)base + idx[i];
        I[ic++] = (u32)base + (nz > 0 ? idx[i + 1] : idx[i + 2]);
        I[ic++] = (u32)base + (nz > 0 ? idx[i + 2] : idx[i + 1]);
      }
    }
  }
  for (i32 w = 0; w < nwalls; w++) {
    const Frames2 *f = &frames[w];
    const double *pts = contours[wall_idx[w]].pts;
    const i32 n = f->n;
    for (i32 e = 0; e < n; e++) {
      const i32 i0 = e, i1 = (e + 1) % n;
      // normal at each end of the edge: the edge's own at corners, else the vertex's
      const double n0x = f->corner[i0] ? f->edgeN[e * 2] : f->vertN[i0 * 2], n0y = f->corner[i0] ? f->edgeN[e * 2 + 1] : f->vertN[i0 * 2 + 1];
      const double n1x = f->corner[i1] ? f->edgeN[e * 2] : f->vertN[i1 * 2], n1y = f->corner[i1] ? f->edgeN[e * 2 + 1] : f->vertN[i1 * 2 + 1];
      const double u0 = f->arc[e] / S, u1 = f->arc[e + 1] / S;
      i32 prevA = -1, prevB = -1;
      for (i32 r = 0; r < R; r++) {
        const double inset = rings[r * 4], rz = rings[r * 4 + 1], nr = rings[r * 4 + 2], rnz = rings[r * 4 + 3];
        const double ax = pts[i0 * 2] - f->miter[i0 * 2] * inset;
        const double ay = pts[i0 * 2 + 1] - f->miter[i0 * 2 + 1] * inset;
        const double bx = pts[i1 * 2] - f->miter[i1 * 2] * inset;
        const double by = pts[i1 * 2 + 1] - f->miter[i1 * 2 + 1] * inset;
        const double z = z0 + rz;
        const i32 a = vc;
        VERTEX(ax, ay, z, n0x * nr, n0y * nr, rnz, u0, rz / S);
        const i32 c = vc;
        VERTEX(bx, by, z, n1x * nr, n1y * nr, rnz, u1, rz / S);
        if (prevA >= 0) {
          // quad (prevA, prevB, c, a) as two triangles
          I[ic++] = (u32)prevA;
          I[ic++] = (u32)prevB;
          I[ic++] = (u32)c;
          I[ic++] = (u32)prevA;
          I[ic++] = (u32)c;
          I[ic++] = (u32)a;
        }
        prevA = a;
        prevB = c;
      }
    }
  }
#undef VERTEX
  result[0] = (u32)vc;
  result[1] = (u32)ic;
  result[2] = (u32)P;
  result[3] = (u32)Nn;
  result[4] = (u32)T;
  result[5] = (u32)I;
  result[6] = (u32)errors;
  return result;
}
