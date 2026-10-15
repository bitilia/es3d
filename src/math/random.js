// Deterministic pseudo random numbers.
//
// ES3D procedural elements (<scatter>) must produce the same result in every
// implementation, so the generator is part of the format specification:
// mulberry32 seeded with the 32-bit unsigned integer `seed`, returning floats in
// [0, 1) as (state >>> 0) / 2^32 exactly as implemented below.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform value in [lo, hi] for a range [lo, hi]. */
export function inRange(rand, range) {
  return range[0] + (range[1] - range[0]) * rand();
}

/** Integer hash -> [0,1) (used for value noise in procedural textures). */
export function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
