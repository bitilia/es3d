// Scene graph, transforms, instancing, materials, animation and picking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/pipeline.js';
import { updateDynamic } from '../src/scene/flatten.js';
import { pick } from '../src/scene/picking.js';
import { parseTransform } from '../src/transform/transform.js';
import * as mat4 from '../src/math/mat4.js';
import { mulberry32 } from '../src/math/random.js';

const run = (body) => {
  const r = compile(`<es3d version="1">${body}</es3d>`);
  assert.ok(r.ok, r.diagnostics.map((d) => d.message).join('\n'));
  return r;
};
const pos = (s, i) => [s.matrices[i * 16 + 12], s.matrices[i * 16 + 13], s.matrices[i * 16 + 14]].map((v) => Math.round(v * 1e6) / 1e6);

test('transform lists compose left to right like SVG', () => {
  const { matrix } = parseTransform('translate(1,0,0) rotateY(90) scale(2)');
  const p = mat4.transformPoint([0, 0, 0], matrix, 1, 0, 0);
  // scale -> (2,0,0), rotate 90 about Y -> (0,0,-2), translate -> (1,0,-2)
  assert.deepEqual(p.map((v) => Math.round(v * 1e9) / 1e9), [1, 0, -2]);
  assert.throws(() => parseTransform('rotate(45)'), (e) => /rotateY/.test(e.hint));
  assert.throws(() => parseTransform('skew(1)'), /Unknown transform function/);
});

test('local matrix = transform * T(position) * R(rotation) * S(scale)', () => {
  const r = run('<box transform="rotate(0,90,0)" position="1,0,0"/>');
  // position is applied inside the transform, so the box ends up at (0,0,-1)
  assert.deepEqual(pos(r.scene, 0), [0, 0, -1]);
});

test('hierarchy, defs/use, and instance counts', () => {
  const r = run(`<defs><group id="t"><box position="0,1,0"/><sphere position="0,2,0"/></group></defs>
    <group position="10,0,0"><use ref="t" position="0,0,5"/><use ref="t" position="0,0,-5"/></group>`);
  assert.equal(r.scene.count, 4);
  assert.deepEqual(pos(r.scene, 0), [10, 1, 5]);
  assert.deepEqual(pos(r.scene, 3), [10, 2, -5]);
  // all four instances belong to their <use>, which is what picking selects
  const useUids = [...r.doc.byUid.values()].filter((e) => e.name === 'use').map((e) => e.uid);
  assert.deepEqual(new Set(Array.from(r.scene.uid.subarray(0, 4))), new Set(useUids));
});

test('repeat applies its step cumulatively', () => {
  const r = run('<repeat count="4" step="translate(0,0.5,1) rotate(0,90,0)"><box position="1,0,0"/></repeat>');
  assert.equal(r.scene.count, 4);
  assert.deepEqual(pos(r.scene, 0), [1, 0, 0]);
  assert.deepEqual(pos(r.scene, 1), [0, 0.5, 0]);
  // step * step * (1,0,0): rotate -> (0,0,-1), translate -> (0,.5,0), rotate -> (0,.5,0), translate -> (0,1,1)
  assert.deepEqual(pos(r.scene, 2), [0, 1, 1]);
});

test('scatter is deterministic and uses the specified random sequence', () => {
  const src = '<scatter count="5" area="10,20" seed="42"><box/></scatter>';
  const a = run(src), b = run(src);
  assert.deepEqual(Array.from(a.scene.matrices.subarray(0, 80)), Array.from(b.scene.matrices.subarray(0, 80)));
  const rand = mulberry32(42);
  const u = Array.from({ length: 9 }, rand);
  assert.ok(Math.abs(pos(a.scene, 0)[0] - (u[0] - 0.5) * 10) < 1e-5);
  assert.ok(Math.abs(pos(a.scene, 0)[2] - (u[1] - 0.5) * 20) < 1e-5);
  const grid = run('<scatter grid="3,2" spacing="2,4"><box/></scatter>');
  assert.equal(grid.scene.count, 6);
  assert.deepEqual(pos(grid.scene, 0), [-2, 0, -2]);
});

test('material and color inheritance with deduplication', () => {
  const r = run(`<material id="m" color="#ff0000" roughness="0.2"/><material id="m2" color="#ff0000" roughness="0.2"/>
    <group material="m"><box/><box color="#00ff00"/><group color="#0000ff"><box/><box material="m2"/></group></group>`);
  const mats = Array.from(r.scene.mat.subarray(0, 4)).map((i) => r.scene.materials[i]);
  assert.equal(mats[0].roughness, 0.2);
  assert.ok(mats[1].baseColor[1] > 0.9 && mats[1].roughness === 0.2);
  assert.ok(mats[2].baseColor[2] > 0.9);
  // m2 has the same parameters as m: one Material, and its own color (red) wins over the inherited blue
  assert.equal(mats[3], mats[0]);
});

test('explicit lod switches and automatic instance limits', () => {
  const r = run('<lod distances="10"><sphere/><box/></lod>');
  assert.equal(r.scene.lodSwitches.length, 1);
  assert.deepEqual(Array.from(r.scene.lodChild.subarray(0, 2)), [0, 1]);
  const big = compile('<es3d version="1"><scatter count="2000" area="1,1"><scatter count="2000" area="1,1"><box/></scatter></scatter></es3d>');
  assert.equal(big.ok, false);
  assert.ok(big.diagnostics.some((d) => d.code === 'E_TOO_MANY_INSTANCES'));
});

test('animations update only their segment', () => {
  const r = run('<box/><group><animate attr="position" from="0,0,0" to="10,0,0" dur="2"/><sphere/></group>');
  assert.equal(r.scene.dynamic.length, 1);
  updateDynamic(r.scene, r.graph, 1);
  assert.deepEqual(pos(r.scene, 1), [5, 0, 0]);
  assert.deepEqual(pos(r.scene, 0), [0, 0, 0]);
  updateDynamic(r.scene, r.graph, 3); // repeats indefinitely: half way through the second cycle
  assert.deepEqual(pos(r.scene, 1), [5, 0, 0]);
});

test('lights and cameras are transformed to world space', () => {
  const r = run('<group position="0,5,0"><light type="point" position="1,0,0"/><camera position="0,0,10" target="0,0,0"/></group><light type="directional" target="0,-1,0" position="0,0,0"/>');
  assert.deepEqual(r.scene.lights[0].position, [1, 5, 0]);
  assert.deepEqual(r.scene.cameras[0].target, [0, 5, 0]);
  assert.deepEqual(r.scene.lights[1].direction.map((v) => Math.round(v)), [0, -1, 0]);
});

test('ray picking finds the nearest instance', () => {
  const r = run('<box position="0,0,0" id="near"/><box position="0,0,-5" id="far"/>');
  const hit = pick(r.scene, (e, l) => r.cache.mesh(e, l), [0, 0, 10], [0, 0, -1]);
  assert.equal(r.doc.byUid.get(hit.uid).values.id, 'near');
  assert.ok(Math.abs(hit.distance - 9.5) < 1e-6);
  assert.equal(pick(r.scene, (e, l) => r.cache.mesh(e, l), [0, 10, 10], [0, 0, -1]), null);
});

test('mirrored instances are flagged for winding flips', () => {
  const r = run('<box scale="-1,1,1"/><box/>');
  assert.equal(r.scene.flags[0] & 1, 1);
  assert.equal(r.scene.flags[1] & 1, 0);
});
