// 2D contours, their frames and filled regions, shared by the sweep and
// extrusion kernels (contour.c, earcut.c).

#ifndef ES3D_GEOMETRY_H
#define ES3D_GEOMETRY_H

#include "runtime.h"

/** A contour as JavaScript passes it: n points (x y), per-point smooth flags (or none), wall flag. */
typedef struct {
  i32 n;
  const double *pts;
  const u8 *smooth; // 0: every point is a corner
  i32 is_wall;      // 0 only when the contour says isWall === false
} ContourIn;

/** contourFrames (src/geometry/contour.js): edge and vertex normals, miter vectors, corner flags, arc length. */
typedef struct {
  i32 n, edges;
  double *edgeN, *vertN, *miter, *arc;
  u8 *corner;
  double length;
} Frames2;

/** Frames of a contour; returns 0 when memory ran out. */
int contour_frames(const double *points, i32 n, const u8 *smooth, int closed, Frames2 *f);

/** A triangulated region: its points (x y, outer first, then the holes) and triangle indices. */
typedef struct {
  double *positions;
  i32 np; // numbers in positions
  u32 *indices;
  i32 ni;
  double error; // triangulationError: relative area mismatch
} Cap;

/**
 * triangulateRegion for a region given as an outer contour and its holes,
 * every contour first inset by `inset` along its miters (insetPoints; 0 or
 * NaN: no inset). Returns 0 when JavaScript must do it.
 */
int triangulate_region(const ContourIn *outer, const ContourIn *holes, i32 nholes, double inset, Cap *cap);

/** The earcut kernel: triangle indices for data[0, n) with holes; 0 when JavaScript must do it. */
u32 *earcut(const double *data, i32 n, const i32 *holes, i32 nh, i32 *count);

#endif
