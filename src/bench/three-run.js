// The three.js formats of the browser benchmark: the same measurement as
// runFormat() in runner.js (load, first frame, full detail, orbiting frames),
// with three.js loading and drawing. Imported only when such a format runs.

import * as THREE from 'three';
import { compile } from '../pipeline.js';
import { GeometryCache } from '../geometry/geometry-cache.js';
import { exportableInstances } from '../io/external-scene.js';
import { viewOf, median, percentile } from './runner.js';
import { createThreeEngine, glbToThree, es3dToThree, threeLights, threeCamera, syncCamera, threeGeometryBytes, threeMaterial, threeTextures } from './three-engine.js';

const now = () => performance.now();
const engines = new WeakMap();

/** The three.js engine drawn next to an ES3D renderer's canvas (made once per renderer). */
async function engineFor(renderer, width, height) {
  let e = engines.get(renderer);
  if (e && (e.width !== width || e.height !== height)) {
    e.engine.dispose();
    e = null;
  }
  if (!e) {
    const canvas = renderer.canvas || renderer.backend.canvas;
    e = { engine: await createThreeEngine(canvas, renderer.kind, width, height, renderer.backend.device), width, height };
    engines.set(renderer, e);
  }
  return e.engine;
}

/** Free the three.js engine of a renderer (call before disposing the renderer). */
export function releaseThree(renderer) {
  const e = engines.get(renderer);
  if (e) e.engine.dispose();
  engines.delete(renderer);
}

function disposeScene(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) for (const m of [].concat(o.material)) m.dispose();
    if (o.isInstancedMesh) o.dispose();
  });
}

export async function runThree(renderer, prepared, format, opts, { value, base, size }) {
  let engine;
  try {
    engine = await engineFor(renderer, opts.width, opts.height);
  } catch (e) {
    return { ...base, skipped: `three.js could not start: ${e.message}` };
  }
  // a discarded pass first, as the ES3D renderer gets one per scene: shader
  // compilation and JIT warm-up are not charged to the first measured format
  if (!prepared.threeWarm && opts.warmup !== false) {
    prepared.threeWarm = true;
    await runThree(renderer, prepared, format, { ...opts, frames: 3, onFrame: null }, { value, base, size }).catch(() => {});
  }
  const zeroToOne = engine.renderer.coordinateSystem === THREE.WebGPUCoordinateSystem;
  // load: parse into three.js objects (for ES3D: compile and generate the finest meshes)
  await new Promise((r) => setTimeout(r, 0));
  const t0 = now();
  let root, geometryMs = 0;
  if (format.kind === 'es3d') {
    const r = compile(value, { cache: new GeometryCache() });
    if (!r.ok) throw new Error(r.diagnostics.find((d) => d.severity === 'error').message);
    root = es3dToThree(r.scene, (e, l) => r.cache.mesh(e, l), exportableInstances(r.scene));
    geometryMs = r.cache.stats.generateMs;
    if (!prepared.reference) Object.assign(prepared, viewOf(r.scene));
  } else {
    root = await glbToThree(value);
  }
  const loadMs = now() - t0;
  // after the timed load, as both engines make textures alike: the scene's
  // textures, and for GLB (whose materials carry no procedural textures) the
  // ES3D scene's materials, as our renderer draws them
  const textures = await threeTextures(prepared.reference.materials.values(), engine.renderer);
  const made = new Map();
  root.traverse((o) => {
    if (!o.material || !(o.isMesh || o.isInstancedMesh)) return;
    const ref = o.material.userData.es3d || prepared.reference.materials.get(o.material.name);
    if (!ref) return;
    const k = `${ref.index}|${o.material.side}`;
    if (!made.has(k)) made.set(k, threeMaterial(ref, o.material.side, textures));
    o.material.dispose();
    o.material = made.get(k);
  });
  const scene = new THREE.Scene();
  const bg = prepared.reference.environment && prepared.reference.environment.background;
  if (bg) scene.background = new THREE.Color().setRGB(bg[0], bg[1], bg[2], THREE.SRGBColorSpace);
  scene.add(root, ...threeLights(prepared.reference.lights, prepared.reference.environment));
  const cam = prepared.camera.clone();
  const tcam = threeCamera();
  const aspect = opts.width / opts.height;
  const place = () => {
    cam.update(aspect, zeroToOne, prepared.bounds);
    syncCamera(tcam, cam);
  };
  // headless WebGPU cannot present to a canvas (the ES3D renderer reads its
  // frames back instead): three.js then draws into an offscreen 4x target
  const offscreen = renderer.backend.present === 'readback' ? new THREE.RenderTarget(opts.width, opts.height, { samples: 4 }) : null;
  engine.renderer.setRenderTarget(offscreen);
  engine.show(true);
  try {
    // first frame: GPU upload, shader compilation, drawing, waiting for the GPU
    place();
    const t1 = now();
    engine.renderer.render(scene, tcam);
    await engine.finish();
    const firstFrame = now() - t1;
    const frames = opts.frames || 60;
    const target = cam.target.slice();
    const dx = cam.position[0] - target[0], dz = cam.position[2] - target[2];
    const radius = Math.hypot(dx, dz);
    const a0 = Math.atan2(dz, dx);
    const times = [], cpu = [], tris = [];
    let draws = 0;
    for (let f = -3; f < frames; f++) {
      const a = a0 + ((Math.max(0, f) + 0.5) / frames) * Math.PI * 2;
      cam.position = [target[0] + Math.cos(a) * radius, cam.position[1], target[2] + Math.sin(a) * radius];
      const t = now();
      place();
      engine.renderer.render(scene, tcam);
      const c = now() - t;
      await engine.finish();
      const dt = now() - t;
      if (f < 0) continue;
      const s = engine.stats();
      times.push(dt);
      cpu.push(c);
      draws += s.drawCalls;
      tris.push(s.triangles);
      if (opts.onFrame) opts.onFrame();
    }
    const bytes = threeGeometryBytes(root);
    let instances = 0, sceneTriangles = 0;
    root.traverse((o) => {
      const n = o.isInstancedMesh ? o.count : o.isMesh || o.isLineSegments ? 1 : 0;
      instances += n;
      if (o.isMesh && o.geometry.index) sceneTriangles += (o.geometry.index.count / 3) * n;
    });
    // three.js's WebGPU renderer does not count triangles: report what the scene holds
    const drawn = (t) => (tris.every((v) => v === 0) ? sceneTriangles : t);
    return {
      ...base,
      engine: `three.js r${THREE.REVISION} (${engine.kind === 'webgpu' ? 'WebGPU' : 'WebGL2'})`,
      bytes: size.bytes,
      gzip: size.gzip,
      loadMs,
      firstFrameMs: firstFrame,
      readyMs: loadMs + firstFrame,
      fullMs: loadMs + firstFrame,
      refineFrames: 0,
      geometryMs,
      uploadBytes: bytes,
      gpuGeometryBytes: bytes,
      frameMs: median(times),
      frameP95: percentile(times, 0.95),
      cpuMs: median(cpu),
      drawCalls: Math.round(draws / frames),
      triangles: drawn(Math.round(tris.reduce((s, v) => s + v, 0) / frames)),
      trianglesMin: drawn(Math.min(...tris)),
      trianglesMax: drawn(Math.max(...tris)),
      instances,
      frames,
      msaaSamples: engine.msaaSamples,
      errors: [],
    };
  } finally {
    engine.renderer.setRenderTarget(null);
    if (offscreen) offscreen.dispose();
    engine.show(false);
    disposeScene(root);
    for (const t of textures.values()) t.dispose();
    engine.renderer.renderLists && engine.renderer.renderLists.dispose();
  }
}
