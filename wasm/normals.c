// Crease-angle normals for an indexed triangle soup: the operations of
// weldMap and computeNormals in src/geometry/mesh.js, in the same order.

#include "runtime.h"

/** Map each vertex to the first vertex with the same position quantized to 1e-6. */
static u32 *weld_map(const float *positions, i32 n) {
  u32 *map = es3d_alloc((u32)n * 4u);
  double *q = es3d_alloc((u32)n * 24u);
  i32 size = 16;
  while (size < n * 2) size *= 2;
  i32 *table = es3d_alloc((u32)size * 4u);
  if (!map || !q || !table) return 0;
  const i32 mask = size - 1;
  for (i32 i = 0; i < size; i++) table[i] = -1;
  for (i32 i = 0; i < n * 3; i++) q[i] = js_round((double)positions[i] * 1e6);
  for (i32 i = 0; i < n; i++) {
    const double x = q[i * 3], y = q[i * 3 + 1], z = q[i * 3 + 2];
    // the probe order only decides where a key is stored: the first vertex with
    // equal coordinates wins whatever the hash
    i32 h = ((i32)((u32)js_toint32(x) * 73856093u) ^ (i32)((u32)js_toint32(y) * 19349663u) ^ (i32)((u32)js_toint32(z) * 83492791u)) & mask;
    for (;;) {
      const i32 f = table[h];
      if (f < 0) {
        table[h] = i;
        map[i] = (u32)i;
        break;
      }
      if (q[f * 3] == x && q[f * 3 + 1] == y && q[f * 3 + 2] == z) {
        map[i] = (u32)f;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return map;
}

/** Output of the last normals() call, read by the JavaScript side: vertex count, index count, then four pointers. */
static u32 result[6];

/**
 * Normals for nt = ni / 3 triangles over nv vertices. crease in degrees
 * (already clamped to [0, 180]) and cos_crease = Math.cos(crease * PI / 180)
 * come from JavaScript. Returns a pointer to `result`, or 0 when memory ran out.
 */
EXPORT("normals") u32 *normals(const float *positions, i32 nv, const u32 *indices, i32 ni, const float *uvs, double crease, double cos_crease) {
  // an index outside the vertices reads undefined in JavaScript: leave that to it
  for (i32 i = 0; i < ni; i++)
    if (indices[i] >= (u32)nv) return 0;
  const i32 nt = ni / 3;
  double *faceN = es3d_alloc((u32)nt * 24u); // area weighted
  double *faceU = es3d_alloc((u32)nt * 24u); // unit length
  if (!faceN || !faceU) return 0;
  for (i32 t = 0; t < nt; t++) {
    const u32 a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const double pa0 = positions[a], pa1 = positions[a + 1], pa2 = positions[a + 2];
    const double e1x = (double)positions[b] - pa0, e1y = (double)positions[b + 1] - pa1, e1z = (double)positions[b + 2] - pa2;
    const double e2x = (double)positions[c] - pa0, e2y = (double)positions[c + 1] - pa1, e2z = (double)positions[c + 2] - pa2;
    const double x = e1y * e2z - e1z * e2y, y = e1z * e2x - e1x * e2z, z = e1x * e2y - e1y * e2x;
    faceN[t * 3] = x;
    faceN[t * 3 + 1] = y;
    faceN[t * 3 + 2] = z;
    const double l = js_or(js_sqrt(x * x + y * y + z * z), 1);
    faceU[t * 3] = x / l;
    faceU[t * 3 + 1] = y / l;
    faceU[t * 3 + 2] = z / l;
  }
  const u32 *weld = weld_map(positions, nv);
  if (!weld) return 0;
  // faces incident to each welded vertex (CSR layout), needed only to test the crease angle
  u32 *counts = 0, *inc = 0;
  if (crease > 0 && crease < 180) {
    counts = es3d_alloc((u32)(nv + 1) * 4u);
    inc = es3d_alloc((u32)ni * 4u);
    u32 *fill = es3d_alloc((u32)nv * 4u);
    if (!counts || !inc || !fill) return 0;
    for (i32 i = 0; i <= nv; i++) counts[i] = 0;
    for (i32 i = 0; i < ni; i++) counts[weld[indices[i]] + 1]++;
    for (i32 i = 0; i < nv; i++) counts[i + 1] += counts[i];
    for (i32 i = 0; i < nv; i++) fill[i] = counts[i];
    for (i32 i = 0; i < ni; i++) inc[fill[weld[indices[i]]]++] = (u32)(i / 3);
  }
  // without creases every corner of a welded vertex gets the same normal
  double *smoothN = 0;
  if (crease >= 180) {
    smoothN = es3d_alloc((u32)nv * 24u);
    if (!smoothN) return 0;
    for (i32 k = 0; k < nv * 3; k++) smoothN[k] = 0;
    for (i32 i = 0; i < ni; i++) {
      const u32 w = weld[indices[i]] * 3, f = (u32)(i / 3) * 3;
      smoothN[w] += faceN[f];
      smoothN[w + 1] += faceN[f + 1];
      smoothN[w + 2] += faceN[f + 2];
    }
    for (i32 w = 0; w < nv * 3; w += 3) {
      const double x = smoothN[w], y = smoothN[w + 1], z = smoothN[w + 2];
      const double l = js_or(js_sqrt(x * x + y * y + z * z), 1);
      smoothN[w] = x / l;
      smoothN[w + 1] = y / l;
      smoothN[w + 2] = z / l;
    }
  }
  // at most one output vertex per corner
  const i32 cap = nv > ni ? (nv > 1 ? nv : 1) : (ni > 1 ? ni : 1);
  float *outP = es3d_alloc((u32)cap * 12u), *outN = es3d_alloc((u32)cap * 12u), *outT = es3d_alloc((u32)cap * 8u);
  u32 *outI = es3d_alloc((u32)(ni > 1 ? ni : 1) * 4u);
  if (!outP || !outN || !outT || !outI) return 0;
  i32 vc = 0;
  int smooth_ok = smoothN != 0;
  for (i32 k = 0; smooth_ok && k < nv * 3; k++)
    if (is_nan(smoothN[k])) smooth_ok = 0;
  if (smooth_ok) {
    // one normal per welded vertex: every input vertex becomes exactly one
    // output vertex, in the order the triangles first use it
    i32 *out = es3d_alloc((u32)nv * 4u);
    if (!out) return 0;
    for (i32 k = 0; k < nv; k++) out[k] = -1;
    for (i32 i = 0; i < ni; i++) {
      const u32 vi = indices[i];
      i32 idx = out[vi];
      if (idx < 0) {
        idx = out[vi] = vc++;
        const u32 w = weld[vi] * 3;
        outP[idx * 3] = positions[vi * 3];
        outP[idx * 3 + 1] = positions[vi * 3 + 1];
        outP[idx * 3 + 2] = positions[vi * 3 + 2];
        outN[idx * 3] = (float)smoothN[w];
        outN[idx * 3 + 1] = (float)smoothN[w + 1];
        outN[idx * 3 + 2] = (float)smoothN[w + 2];
        outT[idx * 2] = uvs ? uvs[vi * 2] : 0;
        outT[idx * 2 + 1] = uvs ? uvs[vi * 2 + 1] : 0;
      }
      outI[i] = (u32)idx;
    }
  } else {
    // output vertices already emitted for each input vertex, as a linked list
    // keyed by the normal quantized to 1e-4 (corners with equal normals share)
    i32 *head = es3d_alloc((u32)nv * 4u), *next = es3d_alloc((u32)cap * 4u), *qn = es3d_alloc((u32)cap * 12u);
    if (!head || !next || !qn) return 0;
    for (i32 k = 0; k < nv; k++) head[k] = -1;
    for (i32 i = 0; i < ni; i++) {
      const i32 t = i / 3;
      const u32 vi = indices[i];
      const u32 w = weld[vi];
      double nx = 0, ny = 0, nz = 0;
      if (crease <= 0) {
        nx = faceU[t * 3];
        ny = faceU[t * 3 + 1];
        nz = faceU[t * 3 + 2];
      } else if (smoothN) {
        nx = smoothN[w * 3];
        ny = smoothN[w * 3 + 1];
        nz = smoothN[w * 3 + 2];
      } else {
        // faces within the crease angle of this corner's face
        const double fx = faceU[t * 3], fy = faceU[t * 3 + 1], fz = faceU[t * 3 + 2];
        for (u32 k = counts[w]; k < counts[w + 1]; k++) {
          const u32 f = inc[k];
          if ((i32)f == t || faceU[f * 3] * fx + faceU[f * 3 + 1] * fy + faceU[f * 3 + 2] * fz >= cos_crease) {
            nx += faceN[f * 3];
            ny += faceN[f * 3 + 1];
            nz += faceN[f * 3 + 2];
          }
        }
        const double l = js_or(js_sqrt(nx * nx + ny * ny + nz * nz), 1);
        nx /= l;
        ny /= l;
        nz /= l;
      }
      const double qx = js_round(nx * 1e4), qy = js_round(ny * 1e4), qz = js_round(nz * 1e4);
      i32 idx = head[vi];
      // the list stores the quantized normal as Int32Array does; NaN never matches
      while (idx >= 0 && !((double)qn[idx * 3] == qx && (double)qn[idx * 3 + 1] == qy && (double)qn[idx * 3 + 2] == qz)) idx = next[idx];
      if (idx < 0) {
        idx = vc++;
        outP[idx * 3] = positions[vi * 3];
        outP[idx * 3 + 1] = positions[vi * 3 + 1];
        outP[idx * 3 + 2] = positions[vi * 3 + 2];
        outN[idx * 3] = (float)nx;
        outN[idx * 3 + 1] = (float)ny;
        outN[idx * 3 + 2] = (float)nz;
        outT[idx * 2] = uvs ? uvs[vi * 2] : 0;
        outT[idx * 2 + 1] = uvs ? uvs[vi * 2 + 1] : 0;
        next[idx] = head[vi];
        head[vi] = idx;
        qn[idx * 3] = js_toint32(qx);
        qn[idx * 3 + 1] = js_toint32(qy);
        qn[idx * 3 + 2] = js_toint32(qz);
      }
      outI[i] = (u32)idx;
    }
  }
  result[0] = (u32)vc;
  result[1] = (u32)ni;
  result[2] = (u32)outP;
  result[3] = (u32)outN;
  result[4] = (u32)outT;
  result[5] = (u32)outI;
  return result;
}
