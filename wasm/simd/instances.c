// Instance rows for <repeat> and <scatter>: Walker.emitRepeat, emitScatter,
// emitLod and RenderScene.setInstance in src/scene/flatten.js, in the same
// order of operations. The walker records the subtree below one placement
// once, as a small program over matrix slots (recordTemplate there); this
// kernel runs it for every placement.
//
// It is built as a module of its own with 128-bit SIMD: each lane of a
// vector operation is one IEEE 754 operation of the scalar code, so the bits
// are the same, and a browser without WebAssembly SIMD loses only this
// kernel. Placement uses the normative sine and cosine of src/math/trig.js
// and the mulberry32 generator of src/math/random.js, both plain binary64
// and integer arithmetic, so they are computed here rather than imported.

#include <wasm_simd128.h>
#include "../runtime.h"

/** The material index of a template row's material code, resolved by the walker on first use. */
IMPORT("material") i32 js_material(i32 code);

typedef v128_t f64x2;
#define splat wasm_f64x2_splat
#define add wasm_f64x2_add
#define sub wasm_f64x2_sub
#define mul wasm_f64x2_mul
#define pick wasm_v128_bitselect
#define lane wasm_f64x2_extract_lane

#define PI 3.141592653589793
static const double TWO_PI = PI * 2;
static const double HALF_PI = PI * 0.5;
static const double QUARTER_PI = PI * 0.25;
static const double DEG = PI / 180;

static const double S1 = -1.66666666666666324348e-1;
static const double S2 = 8.33333333332248946124e-3;
static const double S3 = -1.98412698298579493134e-4;
static const double S4 = 2.75573137070700676789e-6;
static const double S5 = -2.50507602534068634195e-8;
static const double S6 = 1.58969099521155010221e-10;

static const double C1 = 4.16666666666666019037e-2;
static const double C2 = -1.38888888888741095749e-3;
static const double C3 = 2.48015872894767294178e-5;
static const double C4 = -2.75573143513906633035e-7;
static const double C5 = 2.0875723212981748279e-9;
static const double C6 = -1.13596475577881948265e-11;

static inline f64x2 kernel_sin(f64x2 x) {
  const f64x2 z = mul(x, x);
  const f64x2 v = mul(z, x);
  const f64x2 r = add(splat(S2), mul(z, add(splat(S3), mul(z, add(splat(S4), mul(z, add(splat(S5), mul(z, splat(S6)))))))));
  return add(x, mul(v, add(splat(S1), mul(z, r))));
}

static inline f64x2 kernel_cos(f64x2 x) {
  const f64x2 z = mul(x, x);
  const f64x2 r = mul(z, add(splat(C1), mul(z, add(splat(C2), mul(z, add(splat(C3), mul(z, add(splat(C4), mul(z, add(splat(C5), mul(z, splat(C6))))))))))));
  return add(sub(splat(1), mul(splat(0.5), z)), mul(z, r));
}

/** es3dSin of both lanes, without branches (random angles would mispredict them). */
static f64x2 es3d_sin2(f64x2 x) {
  const f64x2 zero = splat(0);
  const f64x2 finite = wasm_f64x2_eq(sub(x, x), zero); // NaN and infinities pass through
  // Math.round(x / TWO_PI): the ceiling, less one when it is more than a half above
  const f64x2 q = wasm_f64x2_div(x, splat(TWO_PI));
  f64x2 r = wasm_f64x2_ceil(q);
  r = pick(sub(r, splat(1)), r, wasm_f64x2_gt(sub(r, splat(0.5)), q));
  f64x2 y = sub(x, mul(splat(TWO_PI), r));
  const f64x2 negative = wasm_f64x2_lt(y, zero);
  y = pick(wasm_f64x2_neg(y), y, negative);
  y = pick(sub(splat(PI), y), y, wasm_f64x2_gt(y, splat(HALF_PI)));
  y = pick(zero, y, wasm_f64x2_lt(y, zero));
  f64x2 s = pick(kernel_cos(sub(splat(HALF_PI), y)), kernel_sin(y), wasm_f64x2_gt(y, splat(QUARTER_PI)));
  s = pick(wasm_f64x2_neg(s), s, negative);
  return pick(s, x, finite);
}

/** (es3dCos(x), es3dSin(x)): es3dCos(x) is es3dSin(x + HALF_PI). */
static inline f64x2 cos_sin(double x) { return es3d_sin2(wasm_f64x2_make(x + HALF_PI, x)); }

/** es3dCos and es3dSin of x into out[0] and out[1] (for the tests). */
EXPORT("cos_sin") void cos_sin_export(double x, double *out) { wasm_v128_store(out, cos_sin(x)); }

static inline double mulberry32(u32 *state) {
  *state += 0x6d2b79f5u;
  u32 t = *state;
  t = (t ^ (t >> 15)) * (t | 1u);
  t ^= t + (t ^ (t >> 7)) * (t | 61u);
  return (double)(t ^ (t >> 14)) / 4294967296.0;
}

/** mat4.multiply; out must not alias a or b. */
static void multiply(double *out, const double *a, const double *b) {
  const f64x2 a0 = wasm_v128_load(a), a1 = wasm_v128_load(a + 2);
  const f64x2 a4 = wasm_v128_load(a + 4), a5 = wasm_v128_load(a + 6);
  const f64x2 a8 = wasm_v128_load(a + 8), a9 = wasm_v128_load(a + 10);
  const f64x2 a12 = wasm_v128_load(a + 12), a13 = wasm_v128_load(a + 14);
  for (int c = 0; c < 16; c += 4) {
    const f64x2 b0 = splat(b[c]), b1 = splat(b[c + 1]), b2 = splat(b[c + 2]), b3 = splat(b[c + 3]);
    wasm_v128_store(out + c, add(add(add(mul(b0, a0), mul(b1, a4)), mul(b2, a8)), mul(b3, a12)));
    wasm_v128_store(out + c + 2, add(add(add(mul(b0, a1), mul(b1, a5)), mul(b2, a9)), mul(b3, a13)));
  }
}

static inline double determinant3(const double *a) {
  return a[0] * (a[5] * a[10] - a[6] * a[9]) - a[4] * (a[1] * a[10] - a[2] * a[9]) + a[8] * (a[1] * a[6] - a[2] * a[5]);
}

/** The cosine and sine of one Euler angle, kept while the angle repeats (most scatters turn about one axis only). */
typedef struct {
  u64 key;
  int valid;
  double c, s;
} angle;

static void turn(angle *m, double deg) {
  u64 key;
  __builtin_memcpy(&key, &deg, 8);
  if (m->valid && m->key == key) return;
  const f64x2 cs = cos_sin(deg * DEG);
  m->c = lane(cs, 0);
  m->s = lane(cs, 1);
  m->key = key;
  m->valid = 1;
}

/** mat4.compose: fromEulerDeg, then the scale, then the position. */
static void compose(double *out, const double *pos, const double *rot, const double *scl, angle *memo) {
  turn(&memo[0], rot[0]);
  turn(&memo[1], rot[1]);
  turn(&memo[2], rot[2]);
  const double cx = memo[0].c, sx = memo[0].s, cy = memo[1].c, sy = memo[1].s, cz = memo[2].c, sz = memo[2].s;
  out[0] = cz * cy * scl[0];
  out[1] = sz * cy * scl[0];
  out[2] = -sy * scl[0];
  out[3] = 0;
  out[4] = (cz * sy * sx - sz * cx) * scl[1];
  out[5] = (sz * sy * sx + cz * cx) * scl[1];
  out[6] = cy * sx * scl[1];
  out[7] = 0;
  out[8] = (cz * sy * cx + sz * sx) * scl[2];
  out[9] = (sz * sy * cx - cz * sx) * scl[2];
  out[10] = cy * cx * scl[2];
  out[11] = 0;
  out[12] = pos[0];
  out[13] = pos[1];
  out[14] = pos[2];
  out[15] = 1;
}

static inline double lerp(const double *range, double t) { return range[0] + (range[1] - range[0]) * t; }

enum { OP_MUL = 0, OP_ROW = 1, OP_LOD = 2 };
enum { REPEAT = 0, SCATTER = 1 };
enum { GRID = 0, RADIUS = 1, AREA = 2 };
enum { RANDOM_ROTATION = 1, RANDOM_SCALE = 2, UNIFORM_SCALE = 4 };

// The i32 header (h) and f64 header (f), filled by instancesWasm in src/wasm/kernels.js.
enum {
  H_KIND, H_FIRST, H_COUNT, H_STATE, H_MODE, H_NX, H_NZ, H_RANDOM, H_CHOICES,
  H_OPS, H_NOPS, H_MATS, H_ROWS, H_NROWS, H_BOUNDS, H_MATERIALS, H_LODS, H_OUTER_LOD, H_SWITCH, H_SLOTS,
  // outputs: kernel-memory addresses of the columns
  H_OUT_MATRIX, H_OUT_SPHERE, H_OUT_GEOM, H_OUT_MAT, H_OUT_UID, H_OUT_LOD, H_OUT_CHILD, H_OUT_FLAGS, H_OUT_SWITCHES,
};
enum {
  F_WORLD = 0, F_ACC = 16, F_STEP = 32, F_SPACING = 48, F_JITTER = 50, F_RADIUS = 51, F_AREA = 52,
  F_ROTATION = 54, F_SCALE = 60, F_BOUNDS = 66,
};
// a template row: geometry, uid, template lod (-1: the outer one), lod child, flags, has bounds
enum { R_GEOM, R_UID, R_LOD, R_CHILD, R_FLAGS, R_BOUNDED, R_SIZE };

/**
 * Rows for placements [first, first + count). Returns 1, or 0 when memory
 * ran out. The generator state, the repeat's accumulated step, the scene
 * bounds and the resolved materials are read from the headers and written
 * back, so a long element is expanded in several calls.
 */
EXPORT("instances") i32 instances(i32 *h, double *f) {
  const i32 count = h[H_COUNT], nrows = h[H_NROWS], nlods = h[H_LODS], nops = h[H_NOPS];
  const i32 *ops = (const i32 *)h[H_OPS];
  const double *mats = (const double *)h[H_MATS];
  const i32 *rows = (const i32 *)h[H_ROWS];
  const double *row_bounds = (const double *)h[H_BOUNDS];
  i32 *materials = (i32 *)h[H_MATERIALS];
  const i32 n = count * nrows;
  double *slots = es3d_alloc(h[H_SLOTS] * 128);
  float *out_matrix = es3d_alloc(n * 64);
  float *out_sphere = es3d_alloc(n * 16);
  u32 *out_geom = es3d_alloc(n * 4);
  u32 *out_mat = es3d_alloc(n * 4);
  u32 *out_uid = es3d_alloc(n * 4);
  i32 *out_lod = es3d_alloc(n * 4);
  unsigned short *out_child = es3d_alloc(n * 2);
  u8 *out_flags = es3d_alloc(n);
  double *out_switches = es3d_alloc(count * nlods * 32);
  if (!slots || !out_matrix || !out_sphere || !out_geom || !out_mat || !out_uid || !out_lod || !out_child || !out_flags || !out_switches) return 0;
  h[H_OUT_MATRIX] = (i32)out_matrix;
  h[H_OUT_SPHERE] = (i32)out_sphere;
  h[H_OUT_GEOM] = (i32)out_geom;
  h[H_OUT_MAT] = (i32)out_mat;
  h[H_OUT_UID] = (i32)out_uid;
  h[H_OUT_LOD] = (i32)out_lod;
  h[H_OUT_CHILD] = (i32)out_child;
  h[H_OUT_FLAGS] = (i32)out_flags;
  h[H_OUT_SWITCHES] = (i32)out_switches;

  const int repeat = h[H_KIND] == REPEAT;
  const i32 random = h[H_RANDOM], choices = h[H_CHOICES], mode = h[H_MODE], nx = h[H_NX], nz = h[H_NZ];
  const i32 first = h[H_FIRST], outer_lod = h[H_OUTER_LOD], switch_base = h[H_SWITCH];
  const double spacing_x = f[F_SPACING], spacing_z = f[F_SPACING + 1], jitter = f[F_JITTER], radius = f[F_RADIUS];
  const double area_x = f[F_AREA], area_z = f[F_AREA + 1];
  double world[16], acc[16], step[16], rotation[6], scale[6];
  for (int k = 0; k < 16; k++) {
    world[k] = f[F_WORLD + k];
    acc[k] = f[F_ACC + k];
    step[k] = f[F_STEP + k];
  }
  for (int k = 0; k < 6; k++) {
    rotation[k] = f[F_ROTATION + k];
    scale[k] = f[F_SCALE + k];
  }
  double *bb = f + F_BOUNDS;
  // lanes (x, y) and (z, unused) of the scene bounds
  f64x2 min_xy = wasm_v128_load(bb), min_z = splat(bb[2]), max_xy = wasm_v128_load(bb + 3), max_z = splat(bb[5]);
  u32 state = (u32)h[H_STATE];
  double place[16], tmp[16], u[9];
  double pos[3] = {0, 0, 0}, rot[3] = {0, 0, 0}, scl[3] = {1, 1, 1};
  angle memo[3] = {{0, 0, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}};

  i32 i = 0;
  for (i32 p = 0; p < count; p++) {
    i32 choice = 0;
    if (repeat) multiply(slots, world, acc);
    else {
      for (int k = 0; k < 9; k++) u[k] = mulberry32(&state);
      if (mode == GRID) {
        const i32 at = first + p;
        const double ix = at % nx, iz = at / nx;
        pos[0] = (ix - (double)(nx - 1) / 2) * spacing_x + (u[0] - 0.5) * jitter * spacing_x;
        pos[2] = (iz - (double)(nz - 1) / 2) * spacing_z + (u[1] - 0.5) * jitter * spacing_z;
      } else if (mode == RADIUS) {
        const double r = radius * js_sqrt(u[0]);
        const f64x2 cs = cos_sin(u[1] * PI * 2);
        pos[0] = r * lane(cs, 0);
        pos[2] = r * lane(cs, 1);
      } else {
        pos[0] = (u[0] - 0.5) * area_x;
        pos[2] = (u[1] - 0.5) * area_z;
      }
      if (random & RANDOM_ROTATION) {
        rot[0] = lerp(rotation, u[2]);
        rot[1] = lerp(rotation + 2, u[3]);
        rot[2] = lerp(rotation + 4, u[4]);
      }
      if (random & RANDOM_SCALE) {
        if (random & UNIFORM_SCALE) scl[0] = scl[1] = scl[2] = lerp(scale, u[5]);
        else {
          scl[0] = lerp(scale, u[5]);
          scl[1] = lerp(scale + 2, u[6]);
          scl[2] = lerp(scale + 4, u[7]);
        }
      }
      compose(place, pos, rot, scl, memo);
      multiply(slots, world, place);
      if (choices) choice = (i32)js_min(choices - 1, js_floor(u[8] * choices));
    }

    const i32 switch0 = switch_base + p * nlods;
    for (i32 o = 0; o < nops; o += 4) {
      const double *w = slots + ops[o + 2] * 16;
      if (ops[o] == OP_MUL) {
        multiply(slots + ops[o + 1] * 16, w, mats + ops[o + 3] * 16);
        continue;
      }
      if (ops[o] == OP_LOD) {
        double *s = out_switches + (p * nlods + ops[o + 1]) * 4;
        s[0] = w[12];
        s[1] = w[13];
        s[2] = w[14];
        s[3] = determinant3(w);
        continue;
      }
      const i32 r = ops[o + 1];
      const i32 *row = rows + r * R_SIZE;
      float *m = out_matrix + i * 16;
      for (int k = 0; k < 16; k += 4) {
        const v128_t lo = wasm_f32x4_demote_f64x2_zero(wasm_v128_load(w + k));
        const v128_t hi = wasm_f32x4_demote_f64x2_zero(wasm_v128_load(w + k + 2));
        wasm_v128_store(m + k, wasm_i32x4_shuffle(lo, hi, 0, 1, 4, 5));
      }
      const i32 code = choice * nrows + r;
      if (materials[code] < 0) materials[code] = js_material(code);
      out_geom[i] = (u32)row[R_GEOM];
      out_mat[i] = (u32)materials[code];
      out_uid[i] = (u32)row[R_UID];
      out_lod[i] = row[R_LOD] >= 0 ? switch0 + row[R_LOD] : outer_lod;
      out_child[i] = (unsigned short)row[R_CHILD];
      out_flags[i] = (u8)((determinant3(w) < 0 ? 1 : 0) | row[R_FLAGS]);
      f64x2 centre = splat(0), rest = centre;
      if (row[R_BOUNDED]) {
        // lanes (x, y) and (z, unused) of the centre and the half extents of the transformed box
        const double *b = row_bounds + r * 6;
        const f64x2 lx = splat(b[0]), ly = splat(b[1]), lz = splat(b[2]), hx = splat(b[3]), hy = splat(b[4]), hz = splat(b[5]);
        const f64x2 w0 = wasm_v128_load(w), w2 = wasm_v128_load(w + 2), w4 = wasm_v128_load(w + 4), w6 = wasm_v128_load(w + 6);
        const f64x2 w8 = wasm_v128_load(w + 8), w10 = wasm_v128_load(w + 10), w12 = wasm_v128_load(w + 12), w14 = wasm_v128_load(w + 14);
        const f64x2 cxy = add(add(add(mul(w0, lx), mul(w4, ly)), mul(w8, lz)), w12);
        const f64x2 cz = add(add(add(mul(w2, lx), mul(w6, ly)), mul(w10, lz)), w14);
        const f64x2 exy = add(add(mul(wasm_f64x2_abs(w0), hx), mul(wasm_f64x2_abs(w4), hy)), mul(wasm_f64x2_abs(w8), hz));
        const f64x2 ez = add(add(mul(wasm_f64x2_abs(w2), hx), mul(wasm_f64x2_abs(w6), hy)), mul(wasm_f64x2_abs(w10), hz));
        const double ex = lane(exy, 0), ey = lane(exy, 1), ez0 = lane(ez, 0);
        // strictly smaller or larger, as the walker compares: NaN never enters, a tie keeps the first
        f64x2 v = sub(cxy, exy);
        min_xy = pick(v, min_xy, wasm_f64x2_lt(v, min_xy));
        v = sub(cz, ez);
        min_z = pick(v, min_z, wasm_f64x2_lt(v, min_z));
        v = add(cxy, exy);
        max_xy = pick(v, max_xy, wasm_f64x2_gt(v, max_xy));
        v = add(cz, ez);
        max_z = pick(v, max_z, wasm_f64x2_gt(v, max_z));
        centre = cxy;
        rest = wasm_f64x2_replace_lane(cz, 1, js_sqrt(ex * ex + ey * ey + ez0 * ez0));
      }
      wasm_v128_store(out_sphere + i * 4, wasm_i32x4_shuffle(wasm_f32x4_demote_f64x2_zero(centre), wasm_f32x4_demote_f64x2_zero(rest), 0, 1, 4, 5));
      i++;
    }

    if (repeat) {
      multiply(tmp, acc, step);
      for (int k = 0; k < 16; k++) acc[k] = tmp[k];
    }
  }
  for (int k = 0; k < 16; k++) f[F_ACC + k] = acc[k];
  wasm_v128_store(bb, min_xy);
  bb[2] = lane(min_z, 0);
  wasm_v128_store(bb + 3, max_xy);
  bb[5] = lane(max_z, 0);
  h[H_STATE] = (i32)state;
  return 1;
}
