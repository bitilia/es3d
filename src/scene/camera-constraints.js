// Camera limits and collision for interactive viewers (<controls>).
//
// Limits keep the orbit target in a box, the camera within a distance range
// and between two angles from straight up. Collision stops a moving camera in
// front of the first surface it would pass through: the move from the last
// camera position to the new one is ray cast against the scene, and only
// surfaces whose front side faces the camera block it. So a camera that starts
// inside an object can still leave it, an orbit target inside a product does
// not trap the camera, and a camera outside cannot enter. Instances under
// collide="false" are ignored.
//
// Nothing here touches the DOM; OrbitControls calls constrainCamera after
// every drag, pinch and wheel step.

import { raycast } from './picking.js';
import { FLAG_NO_COLLIDE } from './flatten.js';

const DEG = Math.PI / 180;
const POLE = 1e-3; // keeps the view direction off the up axis, where lookAt is undefined

/** Keep the target in its box and the camera within the distance and angle limits. */
export function applyLimits(camera, limits) {
  if (!limits) return;
  const p = camera.position, t = camera.target;
  if (limits.targetMin && limits.targetMax) {
    for (let k = 0; k < 3; k++) {
      const c = Math.min(limits.targetMax[k], Math.max(limits.targetMin[k], t[k]));
      p[k] += c - t[k];
      t[k] = c;
    }
  }
  const off = [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
  const r = Math.hypot(off[0], off[1], off[2]);
  if (r < 1e-12) return;
  let phi = Math.acos(Math.max(-1, Math.min(1, off[1] / r)));
  const theta = Math.atan2(off[0], off[2]);
  const minPolar = limits.minPolar ?? 0;
  const maxPolar = limits.maxPolar ?? 180;
  const angled = minPolar > 0 || maxPolar < 180;
  if (angled) phi = Math.min(Math.min(maxPolar * DEG, Math.PI - POLE), Math.max(Math.max(minPolar * DEG, POLE), phi));
  let d = r;
  if (limits.minDistance != null) d = Math.max(d, limits.minDistance);
  if (limits.maxDistance != null) d = Math.min(d, limits.maxDistance);
  if (!angled && d === r) return;
  const s = Math.sin(phi);
  p[0] = t[0] + d * s * Math.sin(theta);
  p[1] = t[1] + d * Math.cos(phi);
  p[2] = t[2] + d * s * Math.cos(theta);
}

/** Distance kept between the camera and a surface: enough that the near plane does not cut into it. */
export function collisionMargin(camera, scene) {
  const b = scene.bounds;
  const R = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 || 1;
  // the near plane's corners lie up to ~1.5 near distances from the eye at common fields of view
  return Math.max((camera.currentNear || 0) * 2, R * 0.01);
}

/**
 * Stop a camera move at the first surface it would pass through.
 * @param {{position:number[], target:number[]}} prev camera before the move (assumed valid)
 * @param {import('../render/camera.js').Camera} camera camera after the move; changed in place
 * @param {{scene: object, meshOf: Function, isVisible?: Function, margin?: number}} world
 * @returns {boolean} true when the move was shortened
 */
export function sweepCamera(prev, camera, world) {
  const { scene, meshOf } = world;
  if (!scene || !scene.count) return false;
  const margin = world.margin ?? collisionMargin(camera, scene);
  const targetMove = [camera.target[0] - prev.target[0], camera.target[1] - prev.target[1], camera.target[2] - prev.target[2]];
  let from = prev.position.slice();
  let move = [camera.position[0] - from[0], camera.position[1] - from[1], camera.position[2] - from[2]];
  const total = Math.hypot(move[0], move[1], move[2]);
  if (total < 1e-12) return false;
  let blocked = false;
  let travelled = 0; // fraction of the requested move that was made, for the target
  // the first stop leaves the rest of the move; its part along the surface is
  // tried once more, so a drag that grazes a wall slides along it
  for (let pass = 0; pass < 2; pass++) {
    const len = Math.hypot(move[0], move[1], move[2]);
    if (len < 1e-12) break;
    const dir = [move[0] / len, move[1] / len, move[2] / len];
    const hit = raycast(scene, meshOf, from, dir, { isVisible: world.isVisible, maxDistance: len + margin * 4, skipFlags: FLAG_NO_COLLIDE, facing: true });
    // approaching at a grazing angle needs a longer stop along the ray for the same clearance
    const cos = hit ? Math.abs(dir[0] * hit.normal[0] + dir[1] * hit.normal[1] + dir[2] * hit.normal[2]) : 0;
    const allowed = hit ? Math.max(0, hit.distance - margin / Math.max(cos, 0.25)) : len;
    const s = Math.min(1, allowed / len);
    for (let k = 0; k < 3; k++) from[k] += move[k] * s;
    if (pass === 0) travelled = s;
    if (s >= 1) break;
    blocked = true;
    const rest = move.map((m) => m * (1 - s));
    const into = rest[0] * hit.normal[0] + rest[1] * hit.normal[1] + rest[2] * hit.normal[2];
    move = rest.map((m, k) => m - hit.normal[k] * into);
  }
  if (!blocked) return false;
  // a pan moves target and camera together: keep doing so, so the view direction is unchanged
  const pan = Math.hypot(targetMove[0] - (camera.position[0] - prev.position[0]), targetMove[1] - (camera.position[1] - prev.position[1]), targetMove[2] - (camera.position[2] - prev.position[2])) < total * 1e-6;
  for (let k = 0; k < 3; k++) {
    camera.target[k] = prev.target[k] + (pan ? from[k] - prev.position[k] : targetMove[k] * travelled);
    camera.position[k] = from[k];
  }
  return true;
}

/**
 * Apply <controls> limits, then collision when it is on.
 * @param {{position:number[], target:number[]}} prev
 * @param {import('../render/camera.js').Camera} camera
 * @param {object|null} limits scene.controls
 * @param {{scene: object, meshOf: Function, isVisible?: Function}|null} world
 */
export function constrainCamera(prev, camera, limits, world) {
  applyLimits(camera, limits);
  if (limits && limits.collide && world) return sweepCamera(prev, camera, world);
  return false;
}
