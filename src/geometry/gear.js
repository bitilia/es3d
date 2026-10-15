// Involute spur gear outline (module 1); the descriptor scales it by the module.
//
// A gear is described by a handful of parameters instead of thousands of
// vertices: the outline is generated from the involute of the base circle,
// then handed to the regular extrusion, bevel included if you asked for one.
// A 2D outline goes in. The generic extrude operator does the rest.

import { gearOutlineWasm } from '../wasm/kernels.js';

const TAU = Math.PI * 2;

function inv(a) {
  return Math.tan(a) - a;
}

/**
 * @returns {{outline: {points: Float64Array, smooth: Uint8Array, closed: true}, outerRadius: number, rootRadius: number}}
 */
export function gearOutline(teeth, pressureAngleDeg, flankSamples = 6, arcSamples = 3) {
  const fast = gearOutlineWasm(teeth, pressureAngleDeg, flankSamples, arcSamples);
  if (fast) return fast;
  const N = teeth;
  const alpha = (pressureAngleDeg * Math.PI) / 180;
  const rp = N / 2;
  const rb = rp * Math.cos(alpha);
  let ra = rp + 1;
  const rf = rp - 1.25;
  const psi = Math.PI / (2 * N);
  const invA = inv(alpha);
  const half = (r) => {
    // half tooth angle at radius r (r >= rb)
    const ar = Math.acos(Math.min(1, rb / r));
    return psi + invA - inv(ar);
  };
  // pointed teeth: shrink the tip radius until the tip keeps some width
  if (half(ra) < psi * 0.15) {
    let lo = Math.max(rb, rf), hi = ra;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (half(mid) > psi * 0.15) lo = mid;
      else hi = mid;
    }
    ra = lo;
  }
  const rStart = Math.max(rb, rf);
  const pts = [];
  const smooth = [];
  const add = (r, a, s) => {
    pts.push(r * Math.cos(a), r * Math.sin(a));
    smooth.push(s ? 1 : 0);
  };
  const pitchAngle = TAU / N;
  for (let k = 0; k < N; k++) {
    const c = k * pitchAngle;
    const leftRoot = c - half(rStart);
    const rightRoot = c + half(rStart);
    const prevRightRoot = c - pitchAngle + half(rStart);
    // root arc from the previous tooth to this one
    for (let i = 1; i < arcSamples; i++) {
      add(rf, prevRightRoot + ((leftRoot - prevRightRoot) * i) / arcSamples, true);
    }
    // left flank: radial segment (when the root is inside the base circle) then involute
    add(rf, leftRoot, false);
    if (rf < rStart - 1e-9) add(rStart, leftRoot, false);
    for (let i = 1; i <= flankSamples; i++) {
      const r = rStart + ((ra - rStart) * i) / flankSamples;
      add(r, c - half(r), i < flankSamples);
    }
    // tip arc
    const tipL = c - half(ra), tipR = c + half(ra);
    for (let i = 1; i < arcSamples; i++) add(ra, tipL + ((tipR - tipL) * i) / arcSamples, true);
    // right flank going down
    for (let i = flankSamples; i >= 1; i--) {
      const r = rStart + ((ra - rStart) * i) / flankSamples;
      add(r, c + half(r), i < flankSamples);
    }
    if (rf < rStart - 1e-9) add(rStart, rightRoot, false);
    add(rf, rightRoot, false);
  }
  return {
    outline: { points: Float64Array.from(pts), smooth: Uint8Array.from(smooth), closed: true },
    outerRadius: ra,
    rootRadius: rf,
  };
}
