import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/pipeline.js';
import { FINER_LEVEL, GeometryCache } from '../src/geometry/geometry-cache.js';
import { FINER_FACTORS, sphereMeshError } from '../src/geometry/lod-error.js';
import { FrameBuilder, lodFrameConstants, instancePixelsPerUnit, SURFACE_ERROR_PX } from '../src/render/frame-builder.js';
import { GeometryPool } from '../src/render/geometry-pool.js';
import { Camera } from '../src/render/camera.js';
import { preparePayload, sceneFromPayload } from '../src/scene/prepared.js';

// Section 8.1: a frame may draw a level only while its bound projects to at
// most one pixel. Close to a shape even level 0 fails that, so the reference
// reader makes a finer level on demand: level 0 at 2, 4 or 8 times the quality.

const H = 1080;
// stored positions are float32: about 6e-8 of rounding near a unit radius (conformance.test.mjs allows 1e-5)
const SLACK = 1e-6;

function view(src, distance, options = {}) {
  const r = compile(`<es3d version="1">${src}</es3d>`, { cache: new GeometryCache() });
  const camera = new Camera();
  camera.position = [0, 0, distance];
  camera.target = [0, 0, 0];
  camera.near = 1e-3;
  camera.far = 1e4;
  camera.update(16 / 9, false, r.scene.bounds);
  const builder = new FrameBuilder();
  const p = { scene: r.scene, camera, pool: new GeometryPool(), meshOf: (e, l) => r.cache.mesh(e, l), viewportHeight: H, options: { autoLod: true, culling: false, ...options } };
  return { r, camera, builder, p, build: () => builder.build(p) };
}

/** Projected error, in pixels, of the level a batch drew, for the shape at the origin. */
function projectedError(v, b) {
  const e = b.entry;
  const bound = b.lod >= FINER_LEVEL ? e.finerDeviation[b.lod - FINER_LEVEL] : e.lodDeviation[b.lod];
  const k = lodFrameConstants(v.camera, H);
  const c = v.camera.position;
  return bound * instancePixelsPerUnit(k, 0, 0, 0, Math.hypot(c[0], c[1], c[2]));
}

test('a close-up draws a level finer than level 0, within one pixel', () => {
  // a unit sphere's level 0 (48 segments) projects to more than a pixel inside about 2.8 units
  for (const distance of [2, 1.5, 1.1]) {
    const v = view('<sphere radius="1"/>', distance);
    const f = v.build();
    const [b] = f.batches;
    assert.ok(b.lod >= FINER_LEVEL, `finer at ${distance}`);
    assert.ok(b.entry.lodDeviation[0] * (projectedError(v, b) / b.entry.finerDeviation[b.lod - FINER_LEVEL]) > SURFACE_ERROR_PX, 'level 0 would fail here');
    assert.ok(projectedError(v, b) <= SURFACE_ERROR_PX, `within a pixel at ${distance}`);
    assert.equal(f.stats.finer, 1);
    assert.equal(f.stats.lodHistogram[0], 1);
    assert.ok(b.mesh.indices.length > v.r.cache.mesh(b.entry, 0).indices.length);
    // the coarsest finer level that passes: the one before it would not
    const i = b.lod - FINER_LEVEL;
    if (i > 0) assert.ok(projectedError(v, { ...b, lod: b.lod - 1 }) > SURFACE_ERROR_PX);
  }
});

test('away from a close-up nothing finer is made', () => {
  // level 0 passes from about 5.5 units out
  const v = view('<sphere radius="1"/>', 10);
  const f = v.build();
  assert.ok(f.batches[0].lod < FINER_LEVEL);
  assert.equal(f.stats.finer, 0);
  assert.ok(f.batches[0].entry.finer.every((m) => m === null));
});

test('fixed segments and exact shapes never get a finer level', () => {
  for (const src of ['<sphere radius="1" segments="6"/>', '<box size="1,1,1"/>', '<cylinder radius="1" height="1" segments="12"/>']) {
    const v = view(src, 1.2);
    const f = v.build();
    assert.ok(f.batches[0].lod < FINER_LEVEL, src);
    assert.equal(f.batches[0].entry.finerDeviation, null, src);
  }
});

test('a finer level keeps to its bound', () => {
  const r = compile('<es3d version="1"><sphere radius="1"/></es3d>', { cache: new GeometryCache() });
  const e = r.scene.geometries[0];
  assert.equal(e.finerDeviation.length, FINER_FACTORS.length);
  let prev = e.lodDeviation[0];
  for (let i = 0; i < FINER_FACTORS.length; i++) {
    const m = r.cache.mesh(e, FINER_LEVEL + i);
    assert.ok(e.finerDeviation[i] < prev, 'each finer level is closer to the surface');
    assert.ok(sphereMeshError(m.positions, m.indices) <= e.finerDeviation[i] + SLACK, `level ${i} measured within its bound`);
    prev = e.finerDeviation[i];
  }
  // a torus, sampled at triangle centres and edge midpoints
  const t = compile('<es3d version="1"><torus radius="1" tube="0.25"/></es3d>', { cache: new GeometryCache() });
  const te = t.scene.geometries[0];
  for (let i = 0; i < FINER_FACTORS.length; i++) {
    const m = t.cache.mesh(te, FINER_LEVEL + i), P = m.positions, I = m.indices;
    const at = (j) => [P[j * 3], P[j * 3 + 1], P[j * 3 + 2]];
    const dist = (p) => Math.abs(Math.hypot(Math.hypot(p[0], p[2]) - 1, p[1]) - 0.25);
    let worst = 0;
    for (let k = 0; k < I.length; k += 3) {
      const [a, b, c] = [at(I[k]), at(I[k + 1]), at(I[k + 2])];
      for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
        worst = Math.max(worst, dist([0, 1, 2].map((q) => a[q] * w[0] + b[q] * w[1] + c[q] * w[2])));
      }
    }
    assert.ok(worst <= te.finerDeviation[i] + SLACK, `torus level ${i}: ${worst} within ${te.finerDeviation[i]}`);
  }
});

test('a finer level not made yet is drawn as level 0 for a frame', () => {
  const v = view('<sphere radius="1"/><torus radius="0.6" tube="0.3"/>', 1.6, { tessellationBudget: 0 });
  for (const e of v.r.scene.geometries) v.r.cache.mesh(e, 0);
  const first = v.build();
  assert.ok(first.batches.every((b) => b.lod >= FINER_LEVEL));
  assert.equal(first.stats.refining, 1, 'one made this frame, one drawn as level 0');
  const standIn = first.batches.find((b) => !b.entry.finer[b.lod - FINER_LEVEL]);
  assert.equal(standIn.mesh, v.r.cache.mesh(standIn.entry, 0));
  const second = v.build();
  assert.equal(second.stats.refining, 0);
  for (const b of second.batches) assert.equal(b.mesh, b.entry.finer[b.lod - FINER_LEVEL]);
});

test('a new quality drops the finer levels', () => {
  const r = compile('<es3d version="1"><sphere radius="1"/></es3d>', { cache: new GeometryCache() });
  const e = r.scene.geometries[0];
  const before = r.cache.mesh(e, FINER_LEVEL);
  r.cache.setQuality(2);
  assert.equal(e.finer[0], null);
  assert.ok(r.cache.mesh(e, FINER_LEVEL).indices.length > before.indices.length);
});

test('a document compiled in a worker keeps its finer bounds', () => {
  const src = '<es3d version="1"><sphere radius="1"/><gear teeth="12" module="0.1"/><box size="1,1,1"/></es3d>';
  const here = compile(src, { cache: new GeometryCache() });
  const { message, transfer } = preparePayload(src, { quality: 1 });
  const payload = structuredClone(message, { transfer });
  const scene = sceneFromPayload(payload, new GeometryCache(), 'test', () => {
    throw new Error('not needed');
  });
  const byKey = new Map(here.scene.geometries.map((e) => [e.key, e.finerDeviation]));
  for (const e of scene.geometries) assert.deepEqual(e.finerDeviation, byKey.get(e.key), e.key);
});
