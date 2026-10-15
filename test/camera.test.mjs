// Camera features: keyframe and path animation, scroll timelines, camera
// target/fov animation, framing (fit/aspect), <controls> limits and collision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/pipeline.js';
import { updateDynamic, FLAG_NO_COLLIDE } from '../src/scene/flatten.js';
import { raycast } from '../src/scene/picking.js';
import { applyLimits, sweepCamera, constrainCamera } from '../src/scene/camera-constraints.js';
import { serialize } from '../src/format/serializer.js';
import { parse } from '../src/format/parse.js';
import { Camera } from '../src/render/camera.js';

const doc = (body) => `<es3d version="1">${body}</es3d>`;
const run = (body, opts) => {
  const r = compile(doc(body), opts);
  assert.ok(r.ok, r.diagnostics.map((d) => d.message).join('\n'));
  return r;
};
const errors = (body) => compile(doc(body)).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
const pos = (s, i = 0) => [s.matrices[i * 16 + 12], s.matrices[i * 16 + 13], s.matrices[i * 16 + 14]].map((v) => Math.round(v * 1e6) / 1e6);
const near = (a, b, eps = 1e-6) => a.every((x, k) => Math.abs(x - b[k]) <= eps);

test('values and keyTimes: key values are reached at their key times', () => {
  const r = run('<box><animate attr="position" values="0,0,0; 10,0,0; 10,5,0" keyTimes="0, 0.8, 1" dur="10s" repeat="1"/></box>');
  const at = (t) => {
    updateDynamic(r.scene, r.graph, t);
    return pos(r.scene);
  };
  assert.deepEqual(at(0), [0, 0, 0]);
  assert.deepEqual(at(4), [5, 0, 0]); // halfway to the second key, which is reached at 0.8
  assert.deepEqual(at(8), [10, 0, 0]);
  assert.deepEqual(at(9), [10, 2.5, 0]);
  assert.deepEqual(at(20), [10, 5, 0]); // holds the end value
});

test('smooth key values pass through every key on a curve', () => {
  const r = run('<box><animate attr="position" values="0,0,0; 4,4,0; 8,0,0" smooth="true" timeline="scroll"/></box>');
  updateDynamic(r.scene, r.graph, 0, 0.5);
  assert.deepEqual(pos(r.scene), [4, 4, 0]);
  updateDynamic(r.scene, r.graph, 0, 0.25);
  const p = pos(r.scene);
  // on a curve, not on the straight segment (where y would be 2)
  assert.ok(p[1] > 2.2, `expected y above the chord, got ${p[1]}`);
});

test('along walks a path at constant speed', () => {
  // an L of total length 10: 6 along x, then 4 along z
  const r = run('<box><animate attr="position" along="0,0,0 6,0,0 6,0,4" timeline="scroll"/></box>');
  const at = (p) => {
    updateDynamic(r.scene, r.graph, 0, p);
    return pos(r.scene);
  };
  assert.deepEqual(at(0), [0, 0, 0]);
  assert.deepEqual(at(0.3), [3, 0, 0]);
  assert.deepEqual(at(0.6), [6, 0, 0]);
  assert.deepEqual(at(0.8), [6, 0, 2]);
  assert.deepEqual(at(1), [6, 0, 4]);
  // 3D path data works too
  const q = run('<box><animate attr="position" along="M0,0,0 L0,10,0" timeline="scroll"/></box>', { progress: 0.25 });
  assert.deepEqual(pos(q.scene), [0, 2.5, 0]);
});

test('scroll timelines follow progress, not the clock, and are reported', () => {
  const r = run('<box><animate attr="rotation" to="0,90,0" timeline="scroll"/></box><sphere><animate attr="position" to="1,0,0" dur="1s"/></sphere>');
  assert.deepEqual(r.scene.animation, { time: true, scroll: true });
  const s = run('<box><animate attr="position" to="2,0,0" timeline="scroll" easing="linear"/></box>');
  assert.deepEqual(s.scene.animation, { time: false, scroll: true });
  updateDynamic(s.scene, s.graph, 100, 0.5);
  assert.deepEqual(pos(s.scene), [1, 0, 0]);
  updateDynamic(s.scene, s.graph, 0, 2); // clamped
  assert.deepEqual(pos(s.scene), [2, 0, 0]);
});

test('a camera animates its position, target and fov', () => {
  const r = run(`<camera position="0,0,10" target="0,0,0" fov="40">
      <animate attr="position" along="0,0,10 10,0,0" timeline="scroll"/>
      <animate attr="target" values="0,0,0; 0,2,0" timeline="scroll"/>
      <animate attr="fov" to="20" timeline="scroll"/>
    </camera>`);
  updateDynamic(r.scene, r.graph, 0, 1);
  const c = r.scene.cameras[0];
  assert.ok(near(c.position, [10, 0, 0]));
  assert.ok(near(c.target, [0, 2, 0]));
  assert.equal(Math.round(c.fov * 1e9) / 1e9, 20);
  updateDynamic(r.scene, r.graph, 0, 0.5);
  assert.equal(Math.round(r.scene.cameras[0].fov * 1e9) / 1e9, 30);
});

test('animate rules are checked', () => {
  assert.match(errors('<box><animate attr="position" dur="1s"/></box>')[0], /needs to=/);
  assert.match(errors('<box><animate attr="position" to="1,0,0" values="0,0,0;1,1,1" dur="1s"/></box>')[0], /only one of/);
  assert.match(errors('<box><animate attr="position" to="1,0,0"/></box>')[0], /dur/);
  assert.match(errors('<box><animate attr="fov" to="20" dur="1s"/></box>')[0], /only animate a <camera>/);
  assert.match(errors('<camera rotation="0,10,0"><animate attr="target" to="1,0,0" dur="1s"/></camera>')[0], /oriented by rotation/);
  assert.match(errors('<box><animate attr="rotation" along="0,0,0 1,0,0" dur="1s"/></box>')[0], /position or target/);
  assert.match(errors('<box><animate attr="position" values="0,0,0; 1,0" dur="1s"/></box>')[0], /key value 2 has 2/);
  assert.match(errors('<box><animate attr="position" values="0,0,0; 1,0,0" keyTimes="0,0.5,1" dur="1s"/></box>')[0], /keyTimes has 3/);
  assert.match(errors('<box><animate attr="position" values="0,0,0; 1,0,0" keyTimes="0.1,1" dur="1s"/></box>')[0], /start at 0/);
  assert.match(errors('<box><animate attr="position" values="0,0,0;;1,0,0" dur="1s"/></box>')[0], /Empty key value/);
});

test('key values survive markup and compact round trips', () => {
  const src = doc('<box><animate attr="position" values="0,0,0; 1.5,2,0; 3,0,0" keyTimes="0,0.25,1" smooth="true" timeline="scroll"/></box>');
  for (const syntax of ['xml', 'compact']) {
    for (const pretty of [true, false]) {
      const text = serialize(parse(src), { syntax, pretty });
      const r = compile(text, { progress: 0.25 });
      assert.ok(r.ok, `${syntax} ${pretty}: ${r.diagnostics.map((d) => d.message).join('\n')}\n${text}`);
      assert.deepEqual(pos(r.scene), [1.5, 2, 0], `${syntax} pretty=${pretty}`);
    }
  }
});

test('<controls> is read once, checked, and collide="false" marks instances', () => {
  const r = run('<controls mode="orbit" minDistance="2" maxDistance="9" maxPolar="85" targetMin="-1,0,-1" targetMax="1,2,1" collide="true"/><box/><group collide="false"><sphere/></group>');
  const c = r.scene.controls;
  assert.equal(c.mode, 'orbit');
  assert.equal(c.minDistance, 2);
  assert.equal(c.maxPolar, 85);
  assert.equal(c.collide, true);
  assert.equal(r.scene.flags[0] & FLAG_NO_COLLIDE, 0);
  assert.equal(r.scene.flags[1] & FLAG_NO_COLLIDE, FLAG_NO_COLLIDE);
  assert.equal(run('<box/>').scene.controls, null);
  assert.match(errors('<controls minDistance="5" maxDistance="2"/>')[0], /maxDistance/);
  assert.match(errors('<controls targetMin="0,0,0"/>')[0], /both/);
  assert.match(errors('<group><controls/></group>')[0], /not allowed/);
  const two = compile(doc('<controls/><controls mode="none"/>'));
  assert.ok(two.diagnostics.some((d) => d.code === 'W_MULTIPLE_CONTROLS'));
  assert.equal(two.scene.controls.mode, 'orbit');
});

test('limits clamp distance, angle from straight up and the target box', () => {
  const cam = new Camera();
  cam.target = [0, 0, 0];
  cam.position = [0, -5, 0.0001]; // below the target
  applyLimits(cam, { minDistance: 2, maxDistance: 4, minPolar: 0, maxPolar: 90 });
  const r = Math.hypot(...cam.position);
  assert.ok(Math.abs(r - 4) < 1e-9, `distance ${r}`);
  assert.ok(cam.position[1] >= -1e-9, 'not below the horizon');
  cam.target = [5, 0, 0];
  cam.position = [5, 0, 3];
  applyLimits(cam, { targetMin: [-1, -1, -1], targetMax: [1, 1, 1] });
  assert.deepEqual(cam.target, [1, 0, 0]);
  assert.deepEqual(cam.position, [1, 0, 3]); // moved with the target
});

test('the camera stops in front of a surface and can always leave an object', () => {
  const r = run('<box size="1"/>');
  const world = { scene: r.scene, meshOf: (e, l) => r.cache.mesh(e, l), margin: 0.1 };
  const cam = new Camera();
  // zooming from z=5 to z=0 (the target) stops 0.1 before the face at z=0.5
  cam.target = [0, 0, 0];
  cam.position = [0, 0, 0];
  assert.equal(sweepCamera({ position: [0, 0, 5], target: [0, 0, 0] }, cam, world), true);
  assert.ok(near(cam.position, [0, 0, 0.6], 1e-9), `stopped at ${cam.position}`);
  // from inside the box outwards nothing blocks
  cam.position = [0, 0, 5];
  assert.equal(sweepCamera({ position: [0, 0, 0], target: [0, 0, 0] }, cam, world), false);
  assert.deepEqual(cam.position, [0, 0, 5]);
  // a diagonal move into the face stops, then slides along it instead of sticking
  cam.position = [0.4, 0, 0.3];
  assert.equal(sweepCamera({ position: [0, 0, 0.7], target: [0, 0, 0] }, cam, world), true);
  assert.ok(near(cam.position, [0.4, 0, 0.6], 1e-9), `slid to ${cam.position}`);
  // a move that passes beside the box is not touched
  cam.position = [3, 0, 0.3];
  assert.equal(sweepCamera({ position: [0, 0, 0.7], target: [0, 0, 0] }, cam, world), false);
  // collide="false" lets the camera through
  const g = run('<box size="1" collide="false"/>');
  cam.position = [0, 0, 0];
  assert.equal(sweepCamera({ position: [0, 0, 5], target: [0, 0, 0] }, cam, { scene: g.scene, meshOf: (e, l) => g.cache.mesh(e, l), margin: 0.1 }), false);
  // constrainCamera only collides when <controls collide> is on
  cam.position = [0, 0, 0];
  assert.equal(constrainCamera({ position: [0, 0, 5], target: [0, 0, 0] }, cam, { collide: false }, world), false);
});

test('raycast reports the facing surface and its normal', () => {
  const r = run('<box size="2"/>');
  const meshOf = (e, l) => r.cache.mesh(e, l);
  const hit = raycast(r.scene, meshOf, [0, 0, 5], [0, 0, -1]);
  assert.equal(Math.round(hit.distance * 1e9) / 1e9, 4);
  assert.ok(near(hit.normal, [0, 0, 1], 1e-9));
  // from inside, only back faces are ahead: a facing-only cast finds nothing
  assert.equal(raycast(r.scene, meshOf, [0, 0, 0], [0, 0, 1], { facing: true }), null);
  assert.ok(raycast(r.scene, meshOf, [0, 0, 0], [0, 0, 1]));
});

test('fit and aspect keep the framed view on every screen shape', () => {
  const cam = new Camera();
  cam.fov = 40;
  const vfov = (aspect) => (cam.verticalFov(aspect) * 180) / Math.PI;
  const hfov = (aspect) => (2 * Math.atan(Math.tan(cam.verticalFov(aspect) / 2) * aspect) * 180) / Math.PI;
  // default (contain, aspect 1): fov applies to the shorter side
  assert.equal(Math.round(vfov(2) * 1e9) / 1e9, 40);
  assert.equal(Math.round(hfov(0.5) * 1e9) / 1e9, 40);
  // framed at 16:9: a portrait phone still shows the whole width
  cam.refAspect = 16 / 9;
  const wide = hfov(16 / 9);
  assert.ok(Math.abs(hfov(9 / 16) - wide) < 1e-9);
  assert.ok(Math.abs(vfov(2.5) - 40) < 1e-9); // wider screens show more at the sides
  cam.fit = 'cover';
  assert.ok(Math.abs(vfov(9 / 16) - 40) < 1e-9); // fills the height, crops the sides
  assert.ok(Math.abs(hfov(2.5) - wide) < 1e-9);
  cam.fit = 'height';
  assert.ok(Math.abs(vfov(0.5) - 40) < 1e-9);
  // the document carries the settings to the camera
  const r = run('<camera position="0,0,5" target="0,0,0" aspect="1.6" fit="cover"/>');
  const c = new Camera().fromSpec(r.scene.cameras[0]);
  assert.equal(c.refAspect, 1.6);
  assert.equal(c.fit, 'cover');
});
