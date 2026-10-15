#include "runtime.h"

extern unsigned char __heap_base;
static u32 top;

/** Forget every allocation: the JavaScript side has copied out what it needed. */
EXPORT("reset") void reset(void) { top = (u32)&__heap_base; }

/** `bytes` of memory, 8-byte aligned, growing the memory when needed (0 when it cannot grow). */
EXPORT("alloc") void *es3d_alloc(u32 bytes) {
  if (top == 0) reset();
  u32 p = (top + 7u) & ~7u;
  u32 end = p + bytes;
  u32 have = (u32)__builtin_wasm_memory_size(0) * 65536u;
  if (end > have) {
    u32 pages = (end - have + 65535u) / 65536u;
    if (__builtin_wasm_memory_grow(0, pages) == (unsigned long)-1) return 0;
  }
  top = end;
  return (void *)p;
}

int es3d_native_hypot = 0;

/** Use the built-in hypot (1) or the imported Math.hypot (0); see runtime.h. */
EXPORT("set_native_hypot") void set_native_hypot(int on) { es3d_native_hypot = on; }

static double hypot_n(const double *v, int n) {
  double abs[3];
  double max = 0;
  int nan = 0;
  for (int i = 0; i < n; i++) {
    const double x = v[i];
    abs[i] = 0;
    if (x != x) nan = 1;
    else {
      abs[i] = __builtin_fabs(x);
      if (abs[i] > max) max = abs[i];
    }
  }
  if (max == __builtin_inf()) return __builtin_inf();
  if (nan) return __builtin_nan("");
  if (max == 0) return 0;
  // normalise to the largest value to avoid overflow, Kahan summation for the squares
  double sum = 0, compensation = 0;
  for (int i = 0; i < n; i++) {
    const double q = abs[i] / max;
    const double summand = q * q - compensation;
    const double preliminary = sum + summand;
    compensation = (preliminary - sum) - summand;
    sum = preliminary;
  }
  return __builtin_sqrt(sum) * max;
}

EXPORT("hypot2") double v8_hypot2(double x, double y) {
  const double v[2] = {x, y};
  return hypot_n(v, 2);
}

EXPORT("hypot3") double v8_hypot3(double x, double y, double z) {
  const double v[3] = {x, y, z};
  return hypot_n(v, 3);
}
