import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/pipeline.js';
import { FrameBuilder } from '../src/render/frame-builder.js';
import { GeometryPool } from '../src/render/geometry-pool.js';
import { Camera } from '../src/render/camera.js';

// Where the renderer switches to level k (k >= 1), that level's surface must project within about
// one CSS pixel of the exact surface, wherever the shape sits in the view. The level is chosen by
// the real FrameBuilder; this test only finds the switch distance and measures the error there.

const W = 1920, H = 1080, SUB = 6;
const hyp = Math.hypot;
const SHAPES = [
  ['sphere', '<sphere radius="1"/>', (x, y, z) => Math.abs(hyp(x, y, z) - 1)],
  ['thin torus', '<torus radius="1" tube="0.25"/>', (x, y, z) => Math.abs(hyp(hyp(x, z) - 1, y) - 0.25)],
];
// centre of the shape in normalised device coordinates: on the axis, near the top edge, near a corner
const PLACES = [[0, 0], [0, 0.8], [0.9, 0.9], [-0.9, -0.9]];
// fixed camera orientations (forward vectors), so the test is deterministic
const FORWARD = [[0, 0, -1], [0.6, -0.48, -0.64], [-0.36, 0.8, 0.48]];

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = hyp(...v); return v.map((c) => c / l); };
const nearest = (dist, x, y, z) => {
  for (let it = 0; it < 3; it++) {
    const d = dist(x, y, z), e = 1e-7;
    const g = [(dist(x + e, y, z) - dist(x - e, y, z)) / (2 * e), (dist(x, y + e, z) - dist(x, y - e, z)) / (2 * e), (dist(x, y, z + e) - dist(x, y, z - e)) / (2 * e)];
    const g2 = g[0] ** 2 + g[1] ** 2 + g[2] ** 2;
    if (!(g2 > 0) || d < 1e-13) break;
    x -= (d * g[0]) / g2; y -= (d * g[1]) / g2; z -= (d * g[2]) / g2;
  }
  return [x, y, z];
};

function worstAtSwitches(el, dist) {
  const r = compile(`<es3d version="1">${el}</es3d>`);
  const sc = r.scene, e = sc.geometries[0], C = [sc.spheres[0], sc.spheres[1], sc.spheres[2]];
  const M = Array.from(sc.matrices.subarray(0, 16));
  const toWorld = (p) => [0, 1, 2].map((a) => M[a] * p[0] + M[4 + a] * p[1] + M[8 + a] * p[2] + M[12 + a]);
  const samples = [];
  for (let k = 0; k < e.lods; k++) {
    const mesh = r.cache.mesh(e, k), P = mesh.positions, I = mesh.indices, list = [];
    for (let t = 0; t < I.length; t += 3) {
      const v = [0, 1, 2].map((q) => [P[I[t + q] * 3], P[I[t + q] * 3 + 1], P[I[t + q] * 3 + 2]]);
      const w = v.map(toWorld), n = cross(w[1].map((c, a) => c - w[0][a]), w[2].map((c, a) => c - w[0][a]));
      for (let i = 0; i <= SUB; i++) for (let j = 0; i + j <= SUB; j++) {
        const u = i / SUB, vv = j / SUB, ww = 1 - u - vv;
        const pc = [0, 1, 2].map((a) => v[0][a] * ww + v[1][a] * u + v[2][a] * vv);
        list.push([toWorld(pc), toWorld(nearest(dist, ...pc)), n]);
      }
    }
    samples.push(list);
  }
  const cam = new Camera();
  cam.near = 1e-3;
  cam.far = 1e5;
  const builder = new FrameBuilder();
  const p = { scene: sc, camera: cam, pool: new GeometryPool(), meshOf: (en, l) => r.cache.mesh(en, l), viewportHeight: H, options: { autoLod: true, culling: false } };
  const tanV = Math.tan(Math.PI / 8), tanH = (tanV * W) / H;
  const place = (f, right, up, ndc, d) => {
    const w = norm([0, 1, 2].map((a) => ndc[0] * tanH * right[a] + ndc[1] * tanV * up[a] + f[a]));
    cam.position = [0, 1, 2].map((a) => C[a] - w[a] * d);
    cam.target = [0, 1, 2].map((a) => cam.position[a] + f[a]);
    cam.up = up;
    cam.update(W / H, false, null);
  };
  const error = (k) => {
    const V = cam.viewProj, cp = cam.position;
    const proj = (x) => {
      const cw = V[3] * x[0] + V[7] * x[1] + V[11] * x[2] + V[15];
      return [(((V[0] * x[0] + V[4] * x[1] + V[8] * x[2] + V[12]) / cw + 1) / 2) * W, ((1 - (V[1] * x[0] + V[5] * x[1] + V[9] * x[2] + V[13]) / cw) / 2) * H, cw];
    };
    let worst = 0;
    for (const [x, y, n] of samples[k]) {
      if (n[0] * (x[0] - cp[0]) + n[1] * (x[1] - cp[1]) + n[2] * (x[2] - cp[2]) >= 0) continue;
      const a = proj(x), b = proj(y);
      if (a[2] > 0 && b[2] > 0) worst = Math.max(worst, hyp(a[0] - b[0], a[1] - b[1]));
    }
    return worst;
  };
  const worst = PLACES.map(() => 0);
  for (const fw of FORWARD) {
    const f = norm(fw), right = norm(cross(f, [0, 1, 0])), up = cross(right, f);
    PLACES.forEach((ndc, pi) => {
      const lodAt = (d) => { place(f, right, up, ndc, d); builder.build(p); return builder.lods[0]; };
      for (let k = 1; k < e.lods; k++) {
        let lo = 1e-3, hi = 1e5;
        if (lodAt(hi) < k) continue;
        for (let it = 0; it < 48; it++) { const mid = Math.sqrt(lo * hi); if (lodAt(mid) >= k) hi = mid; else lo = mid; }
        if (lodAt(hi) === k) worst[pi] = Math.max(worst[pi], error(k));
      }
    });
  }
  return worst;
}

for (const [name, el, dist] of SHAPES) {
  test(`${name}: every level switch stays within about one CSS pixel on screen`, () => {
    const worst = worstAtSwitches(el, dist);
    PLACES.forEach((ndc, i) => assert.ok(worst[i] <= 1.06, `centre at NDC (${ndc}): ${worst[i].toFixed(3)} px`));
    assert.ok(worst[0] <= 1.01, `on the view axis: ${worst[0].toFixed(3)} px`);
  });
}
