// Shared by the WebAssembly kernels of the ES3D reader (see wasm/README.md).
//
// The kernels are freestanding C: no libc, no libm. Floating point follows
// IEEE 754 binary64 exactly as JavaScript does (WebAssembly has no fused
// multiply-add, and nothing here is compiled with fast-math), so a kernel
// that performs the same operations in the same order as the JavaScript it
// replaces produces the same bits. Functions whose result JavaScript leaves
// to the engine (sin, cos, atan2, hypot) are imported from the page's own
// Math object for the same reason.

#ifndef ES3D_RUNTIME_H
#define ES3D_RUNTIME_H

typedef unsigned char u8;
typedef unsigned int u32;
typedef int i32;
typedef unsigned long long u64;
typedef long long i64;

#define EXPORT(name) __attribute__((export_name(name)))
#define IMPORT(name) __attribute__((import_module("env"), import_name(name)))

IMPORT("sin") double js_sin(double x);
IMPORT("cos") double js_cos(double x);
IMPORT("atan2") double js_atan2(double y, double x);
IMPORT("tan") double js_tan(double x);
IMPORT("acos") double js_acos(double x);
IMPORT("hypot2") double import_hypot2(double x, double y);
IMPORT("hypot3") double import_hypot3(double x, double y, double z);
/** Number(text.slice(start, end)) of the text being parsed (rare: long or extreme numbers). */
IMPORT("number") double js_number(i32 start, i32 end);

// Math.hypot as V8 computes it (largest magnitude first, Kahan-summed squares).
// The loader switches it on only when it gives this engine's Math.hypot results
// on a test set; otherwise every call goes to the imported Math.hypot.
extern int es3d_native_hypot;
double v8_hypot2(double x, double y);
double v8_hypot3(double x, double y, double z);
static inline double js_hypot2(double x, double y) { return es3d_native_hypot ? v8_hypot2(x, y) : import_hypot2(x, y); }
static inline double js_hypot3(double x, double y, double z) { return es3d_native_hypot ? v8_hypot3(x, y, z) : import_hypot3(x, y, z); }

static inline double js_floor(double x) { return __builtin_floor(x); }
static inline double js_ceil(double x) { return __builtin_ceil(x); }
static inline double js_sqrt(double x) { return __builtin_sqrt(x); }
static inline double js_abs(double x) { return __builtin_fabs(x); }
// WebAssembly's f64.max/min are JavaScript's Math.max/min of two numbers (NaN wins, +0 > -0)
static inline double js_max(double a, double b) { return __builtin_wasm_max_f64(a, b); }
static inline double js_min(double a, double b) { return __builtin_wasm_min_f64(a, b); }
static inline int is_nan(double x) { return x != x; }
/** JavaScript's `x || fallback` for a number: 0, -0 and NaN are falsy. */
static inline double js_or(double x, double fallback) { return x == 0 || x != x ? fallback : x; }

/** Math.round: the nearest integer, ties towards +Infinity, -0 kept for -0.5 <= x < 0. */
static inline double js_round(double x) {
  double r = __builtin_ceil(x);
  if (r - 0.5 > x) r -= 1.0;
  return r;
}

/** ToInt32 (what `x | 0` and an Int32Array store do). */
static inline i32 js_toint32(double x) {
  if (x != x || x - x != 0) return 0; // NaN, +-Infinity
  double t = __builtin_trunc(x);
  // t mod 2^32 is exact: the scaling is by a power of two and the result fits
  double r = t - __builtin_floor(t / 4294967296.0) * 4294967296.0;
  if (r >= 2147483648.0) r -= 4294967296.0;
  return (i32)r;
}

// --- memory: a bump allocator, reset by the caller before each operation ---

void *es3d_alloc(u32 bytes);

#endif
