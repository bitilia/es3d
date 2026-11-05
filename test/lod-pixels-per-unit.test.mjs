import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../src/render/camera.js';
import { lodFrameConstants, instancePixelsPerUnit, selectLod } from '../src/render/frame-builder.js';

const W = 1920, H = 1080, ASPECT = W / H;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

function persp() {
  const cam = new Camera();
  cam.position = [0, 0, 0];
  cam.target = [0, 0, -1]; // looks down -z
  cam.up = [0, 1, 0];
  cam.near = 0.01;
  cam.far = 1e4;
  cam.update(ASPECT, false, null);
  return cam;
}
const F = (cam) => H / (2 * Math.tan(cam.verticalFov(ASPECT) / 2));
const ppu = (cam, c, vh = H) => {
  const k = lodFrameConstants(cam, vh);
  return instancePixelsPerUnit(k, c[0], c[1], c[2], Math.hypot(c[0], c[1], c[2]));
};

test('on the view axis the estimate is F/d', () => {
  const cam = persp();
  close(ppu(cam, [0, 0, -7]), F(cam) / 7);
});

test('at angle alpha the estimate is F/(d cos^2 alpha)', () => {
  const cam = persp();
  const a = (30 * Math.PI) / 180, d = 5;
  const c = [d * Math.sin(a), 0, -d * Math.cos(a)]; // angle a from the axis, inside the view
  close(ppu(cam, c), F(cam) / (d * Math.cos(a) ** 2));
});

test('beyond the frustum corner and behind the eye plane the capped value is used', () => {
  const cam = persp();
  const k = lodFrameConstants(cam, H);
  const tanV = Math.tan(cam.verticalFov(ASPECT) / 2);
  close(k.cornerStretch, 1 + tanV * tanV * (1 + ASPECT * ASPECT));
  const d = 10;
  // far outside the view (about 80 degrees off axis)
  const a = (80 * Math.PI) / 180;
  close(ppu(cam, [d * Math.sin(a), 0, -d * Math.cos(a)]), (F(cam) * k.cornerStretch) / d);
  // z <= 0: at the eye plane and behind it
  close(ppu(cam, [d, 0, 0]), (F(cam) * k.cornerStretch) / d);
  close(ppu(cam, [0, 0, d]), (F(cam) * k.cornerStretch) / d);
});

test('an orthographic camera keeps the old value', () => {
  const cam = persp();
  cam.type = 'orthographic';
  cam.orthoHeight = 4;
  cam.update(ASPECT, false, null);
  const old = cam.pixelsPerUnit(1, H);
  close(ppu(cam, [3, 2, -9]), old);
  close(ppu(cam, [0, 0, -9]), old);
});

test("lodPixels 'device' scales the estimate by the device-pixel ratio", () => {
  const cam = persp();
  const c = [2, 1, -6];
  close(ppu(cam, c, H * 2), 2 * ppu(cam, c, H));
});

test('lodBias still divides the budget', () => {
  const dev = [0, 0.1, 0.02, 0.005];
  const k = 12; // scale * pixelsPerUnit
  const plain = selectLod(dev, 4, 1, k, 1);
  const tight = selectLod(dev, 4, 1, k, 4);
  assert.ok(tight <= plain);
  assert.equal(selectLod(dev, 4, 1, k, 4), selectLod(dev, 4, 1, k * 4, 1));
});
