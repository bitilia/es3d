import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compile } from '../src/pipeline.js';
import { GeometryCache } from '../src/geometry/geometry-cache.js';
import { FrameBuilder } from '../src/render/frame-builder.js';
import { GeometryPool } from '../src/render/geometry-pool.js';
import { Camera } from '../src/render/camera.js';

// A finite tessellation budget draws levels that are not generated yet with a
// stand-in, then refines them frame by frame to what an unlimited budget draws.

const source = fs.readFileSync(new URL('../docs/public/examples/02-primitives.es3d', import.meta.url), 'utf8');

const frames = (budget) => {
  const r = compile(source, { cache: new GeometryCache() });
  const camera = new Camera().frame(r.scene.bounds);
  camera.update(16 / 9, false, r.scene.bounds);
  const builder = new FrameBuilder();
  const pool = new GeometryPool();
  const p = { scene: r.scene, camera, pool, meshOf: (e, l) => r.cache.mesh(e, l), viewportHeight: 720, options: { autoLod: true, tessellationBudget: budget } };
  const out = [];
  do out.push(builder.build(p));
  while (out.at(-1).stats.refining && out.length < 100);
  return out.map((f) => ({ refining: f.stats.refining, meshes: f.batches.map((b) => b.mesh) }));
};

test('a zero budget draws stand-ins, then one new level per frame', () => {
  const full = frames(Infinity);
  assert.equal(full.length, 1);
  assert.equal(full[0].refining, 0);
  const steps = frames(0);
  assert.ok(steps.length > 2, 'refined over several frames');
  assert.ok(steps[0].refining > 0);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].refining < steps[i - 1].refining, `frame ${i} made progress`);
  // the same levels in the end: identical vertex and triangle counts per batch
  const shape = (f) => f.meshes.map((m) => `${m.positions.length}/${m.indices.length}`);
  assert.deepEqual(shape(steps.at(-1)), shape(full[0]));
});
