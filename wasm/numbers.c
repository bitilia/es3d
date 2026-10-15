// Number lists (mesh positions, normals, uvs, indices, point lists): the same
// grammar and the same values as readNumber / readNumberList in
// src/path/path-parser.js and src/format/values.js. Anything irregular (a
// syntax error, an index that is not a whole number below 2^32) returns -1,
// and the JavaScript reader then produces the value or the error message.

#include "runtime.h"

static const double POW10[23] = {1e0,  1e1,  1e2,  1e3,  1e4,  1e5,  1e6,  1e7,  1e8,  1e9,  1e10, 1e11,
                                 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};

static inline int at(const u8 *s, i32 n, i32 i) { return i < n ? s[i] : -1; }
static inline int is_digit(int c) { return c >= 48 && c <= 57; }
static inline int is_ws(int c) { return c == 32 || c == 9 || c == 10 || c == 13; }

/** The number at s[i]: its end (or -1 when none starts there), the value in *value. */
static i32 read_number(const u8 *s, i32 n, i32 i, double *value) {
  const i32 start = i;
  int c = at(s, n, i);
  const int neg = c == 45;
  if (c == 43 || c == 45) c = at(s, n, ++i);
  // the mantissa only grows, so it is exact whenever it ends at most 2^53
  double m = 0;
  const i32 int_start = i;
  while (is_digit(c)) {
    m = m * 10 + (c - 48);
    c = at(s, n, ++i);
  }
  i32 digits = i - int_start, frac = 0;
  if (c == 46) {
    const i32 frac_start = ++i;
    c = at(s, n, i);
    while (is_digit(c)) {
      m = m * 10 + (c - 48);
      c = at(s, n, ++i);
    }
    frac = i - frac_start;
    digits += frac;
  }
  if (!digits) return -1;
  double e = 0;
  if (c == 101 || c == 69) {
    // the exponent belongs to the number only when digits follow
    i32 j = i + 1;
    int c2 = at(s, n, j);
    const int eneg = c2 == 45;
    if (c2 == 43 || c2 == 45) c2 = at(s, n, ++j);
    if (is_digit(c2)) {
      while (is_digit(c2)) {
        e = e * 10 + (c2 - 48);
        c2 = at(s, n, ++j);
      }
      if (eneg) e = -e;
      i = j;
    }
  }
  e -= frac;
  if (m > 9007199254740992.0 || e > 22 || e < -22) *value = js_number(start, i);
  else {
    const double v = e >= 0 ? m * POW10[(i32)e] : m / POW10[(i32)-e];
    *value = neg ? -v : v;
  }
  return i;
}

enum { AS_F64 = 0, AS_F32 = 1, AS_INDEX = 2 };

/**
 * Read the list in s[0, n) into out (f64, f32 or u32 by `as`), at most
 * n / 2 + 1 values. Returns the count, or -1 to leave the text to JavaScript.
 */
EXPORT("numbers") i32 numbers(const u8 *s, i32 n, void *out, i32 as) {
  double *o64 = (double *)out;
  float *o32 = (float *)out;
  u32 *oi = (u32 *)out;
  i32 count = 0, i = 0;
  while (i < n && is_ws(s[i])) i++;
  while (i < n) {
    double v;
    const i32 end = read_number(s, n, i, &v);
    if (end < 0) return -1;
    if (as == AS_F64) o64[count] = v;
    else if (as == AS_F32) o32[count] = (float)v;
    else {
      // a whole number in [0, 2^32): anything else is an error or a wrap the JavaScript reader handles
      if (!(v >= 0 && v < 4294967296.0) || v != js_floor(v)) return -1;
      oi[count] = (u32)v;
    }
    count++;
    i = end;
    int sep = 0;
    while (i < n && is_ws(s[i])) {
      i++;
      sep = 1;
    }
    if (i < n && s[i] == 44) {
      i++;
      sep = 1;
      while (i < n && is_ws(s[i])) i++;
      if (i >= n) return -1; // trailing comma
    }
    if (i < n && !sep) return -1; // missing separator
  }
  return count;
}
