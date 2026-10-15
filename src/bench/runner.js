// Browser benchmark core: loads one scene in every format and renders it,
// measuring load time, first frame (which includes geometry generation and
// the GPU upload) and steady-state frame times.
//
// Most formats go through this project's renderer, so they compare formats,
// not renderers. The three.js formats (three-engine.js) are the reference
// for glTF as pages actually show it: three.js's GLTFLoader and renderer,
// and ES3D handed to three.js, which separates format from engine.
// "ES3D (stored meshes)" is a repeat visit: its meshes come from the
// persistent geometry cache in IndexedDB (src/cache/).
//
// The LAN benchmark (benchmark/client/main.js) drives this module.

import { compile } from '../pipeline.js';
import { GeometryCache } from '../geometry/geometry-cache.js';
import { exportOBJ, objToScene } from '../io/obj.js';
import { exportGLB, glbToScene } from '../io/gltf.js';
import { exportableInstances, materialNames } from '../io/external-scene.js';
import { gzip } from '../io/compression.js';
import { Camera } from '../render/camera.js';
import { PROGRESSIVE_BUDGET_MS } from '../render/renderer.js';
import { indexedDBStore, restoreGeometry, saveGeometry } from '../cache/geometry-store.js';
import { benchSceneSource } from './scenes.js';

const now = () => performance.now();

export const BROWSER_FORMATS = [
  { id: 'es3d', label: 'ES3D (auto LOD)', kind: 'es3d', autoLod: true },
  { id: 'es3d-progressive', label: 'ES3D (progressive)', kind: 'es3d', autoLod: true, progressive: true },
  { id: 'es3d-cached', label: 'ES3D (stored meshes)', kind: 'es3d', autoLod: true, cached: true },
  { id: 'es3d-lod0', label: 'ES3D (LOD 0 only)', kind: 'es3d', autoLod: false },
  { id: 'obj', label: 'OBJ + MTL', kind: 'obj' },
  { id: 'glb', label: 'glTF binary (GLB)', kind: 'glb' },
  { id: 'glb-inst', label: 'GLB + EXT_mesh_gpu_instancing', kind: 'glb-inst' },
  { id: 'three-glb', label: 'GLB in three.js', kind: 'glb', engine: 'three' },
  { id: 'three-glb-inst', label: 'GLB + instancing in three.js', kind: 'glb-inst', engine: 'three' },
  { id: 'es3d-three', label: 'ES3D in three.js (LOD 0)', kind: 'es3d', engine: 'three' },
];

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export function percentile(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

const nextTask = () => new Promise((r) => setTimeout(r, 0));

/**
 * Compile the ES3D scene and produce the data of every format (not timed).
 * @param {object} desc entry of BENCH_SCENES
 * @param {{objLimit?: number, formats?: string[], examples?: string, log?: (s:string)=>void}} opts
 *   `examples` is the folder of the example scenes, relative to the page
 *   (default `../examples/`)
 */
export async function prepareScene(desc, opts = {}) {
  const log = opts.log || (() => {});
  const examples = new URL(opts.examples || '../examples/', location.href);
  const source = await benchSceneSource(desc, async (file) => {
    const url = new URL(file, examples);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
    return res.text();
  });
  const want = new Set(opts.formats || BROWSER_FORMATS.map((f) => f.id));
  // a cold page that only measures ES3D must not compile it first: that would
  // warm up the very code the measurement is about. Its view comes from the
  // measured load instead (viewOf)
  if (opts.cold && [...want].every((id) => (BROWSER_FORMATS.find((f) => f.id === id) || {}).kind === 'es3d')) {
    const data = new Map();
    for (const id of want) data.set(id, source);
    return { desc, source, triangles: null, instances: null, data, camera: null, reference: null, bounds: null };
  }
  const compiled = compile(source);
  if (!compiled.ok) throw new Error(`${desc.id}: ${compiled.diagnostics.find((d) => d.severity === 'error').message}`);
  const scene = compiled.scene;
  const meshOf = (e, l) => compiled.cache.mesh(e, l);
  let triangles = 0;
  for (const i of exportableInstances(scene)) {
    const e = scene.geometries[scene.geom[i]];
    const m = meshOf(e, 0);
    if (m.kind === 'triangles') triangles += m.primitiveCount;
  }
  const data = new Map();
  for (const f of BROWSER_FORMATS) if (f.kind === 'es3d') data.set(f.id, source);
  if (want.has('obj')) {
    if (triangles > (opts.objLimit || 3e6)) {
      data.set('obj', null);
    } else {
      log(`  exporting OBJ (${triangles.toLocaleString('en-US')} triangles)…`);
      await nextTask();
      const o = exportOBJ(scene, meshOf);
      data.set('obj', { obj: o.obj, mtl: o.mtl });
    }
  }
  // the same GLB bytes for both renderers
  if (want.has('glb') || want.has('three-glb')) {
    const glb = exportGLB(scene, meshOf);
    if (want.has('glb')) data.set('glb', glb);
    if (want.has('three-glb')) data.set('three-glb', glb);
  }
  if (want.has('glb-inst') || want.has('three-glb-inst')) {
    const glb = exportGLB(scene, meshOf, { instancing: true });
    if (want.has('glb-inst')) data.set('glb-inst', glb);
    if (want.has('three-glb-inst')) data.set('three-glb-inst', glb);
  }
  return { desc, source, triangles, instances: scene.count, data, ...viewOf(scene) };
}

/**
 * Camera, bounds and shading of an ES3D scene. The shading inputs are shared
 * by every format (OBJ and glTF exports carry no lights, environment or
 * procedural textures): only geometry delivery may differ.
 */
export function viewOf(scene) {
  const camera = new Camera();
  if (scene.cameras.length) camera.fromSpec(scene.cameras[0]);
  else camera.frame(scene.bounds);
  const reference = {
    lights: scene.lights,
    environment: scene.environment,
    materials: new Map(materialNames(scene.materials).map((name, i) => [name, scene.materials[i]])),
  };
  return { camera, reference, bounds: scene.bounds };
}

/** Formats whose size is not reported: the ES3D variants share one document, measured once as 'es3d'. */
const sizeless = (id) => id !== 'es3d' && BROWSER_FORMATS.some((f) => f.id === id && f.kind === 'es3d');

async function sizeOf(value) {
  if (value === null || value === undefined) return { bytes: null, gzip: null };
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value.obj !== undefined ? new TextEncoder().encode(value.obj + value.mtl) : value;
  return { bytes: bytes.length, gzip: (await gzip(bytes)).length };
}

/** Give an imported scene the lights, environment and materials of the ES3D original. */
function shareShading(scene, reference) {
  scene.lights = reference.lights;
  scene.environment = reference.environment;
  scene.materials = scene.materials.map((m) => reference.materials.get(m.name) || m);
}

/** Parse a format into a renderable scene (this is the timed load step). */
function load(format, value) {
  const t0 = now();
  let scene, meshOf, generated = null;
  if (format.kind === 'es3d') {
    const r = compile(value, { cache: new GeometryCache() });
    if (!r.ok) throw new Error(r.diagnostics.find((d) => d.severity === 'error').message);
    scene = r.scene;
    meshOf = (e, l) => r.cache.mesh(e, l);
    generated = r.cache;
  } else if (format.kind === 'obj') {
    const o = objToScene(value.obj, value.mtl);
    scene = o.scene;
    meshOf = o.meshOf;
  } else {
    const g = glbToScene(value);
    scene = g.scene;
    meshOf = g.meshOf;
  }
  return { scene, meshOf, cache: generated, ms: now() - t0 };
}

// three.js is loaded only when one of its formats runs
let threeRun = null;

/** Free what the benchmark created next to a renderer (call before disposing it). */
export function releaseEngines(renderer) {
  if (threeRun) threeRun.releaseThree(renderer);
}

let benchStore = null;
/** The benchmark's own IndexedDB store (not the one pages use), or null. */
async function geometryStore() {
  if (benchStore === null) benchStore = (await indexedDBStore({ name: 'es3d-geometry-bench' }).catch(() => null)) || false;
  return benchStore || null;
}

/** ES3D load of a repeat visit: compile, then read the stored meshes. */
async function loadCached(value, store) {
  const t0 = now();
  const r = compile(value, { cache: new GeometryCache() });
  if (!r.ok) throw new Error(r.diagnostics.find((d) => d.severity === 'error').message);
  const t1 = now();
  const restored = await restoreGeometry(r.cache, store, { timeout: Infinity });
  const t2 = now();
  return { scene: r.scene, meshOf: (e, l) => r.cache.mesh(e, l), cache: r.cache, ms: t2 - t0, restoreMs: t2 - t1, restored };
}

/**
 * Load one format and render it.
 * @param {import('../render/renderer.js').Renderer} renderer
 * @param {object} prepared result of prepareScene
 * @param {object} format entry of BROWSER_FORMATS
 * @param {{frames?: number, width: number, height: number, onFrame?: () => void, warmup?: boolean, phase?: 'prime'|'measure'}} opts
 *   warmup false: no discarded pass first (three.js formats); phase: for the stored-meshes
 *   format, only store the meshes ('prime', in one page) or only measure ('measure', in the
 *   next page), so that the measured load runs in a page that has not built them yet
 */
export async function runFormat(renderer, prepared, format, opts) {
  const value = prepared.data.get(format.id);
  const base = { scene: prepared.desc.id, format: format.id, label: format.label };
  if (value === null) return { ...base, skipped: `${(prepared.triangles / 1e6).toFixed(1)} M triangles exceed the OBJ limit` };
  if (value === undefined) return { ...base, skipped: 'not prepared' };
  if (format.engine === 'three') {
    threeRun = threeRun || (await import('./three-run.js'));
    return threeRun.runThree(renderer, prepared, format, opts, { value, base, size: await sizeOf(sizeless(format.id) ? null : value) });
  }
  const size = await sizeOf(sizeless(format.id) ? null : value);
  let store = null;
  if (format.cached) {
    store = await geometryStore();
    if (!store) return { ...base, skipped: 'IndexedDB is not available' };
  }
  if (format.cached && opts.phase !== 'measure') {
    // the visit before: draw the same view once and store what it generated
    const first = load(format, value);
    if (!prepared.camera) Object.assign(prepared, viewOf(first.scene));
    renderer.options.autoLod = true;
    renderer.options.tessellationBudget = Infinity;
    renderer.setScene(first.scene, first.meshOf, { keepGeometry: false });
    renderer.render(prepared.camera.clone(), { width: opts.width, height: opts.height, dpr: 1, time: 0 });
    await renderer.finish();
    const saved = await saveGeometry(first.cache, store);
    if (!saved.saved && saved.reason !== 'up to date') return { ...base, skipped: `nothing stored (${saved.reason})` };
    renderer.setScene(null, null);
    if (opts.phase === 'prime') return { ...base, primed: true, storedBytes: saved.bytes };
  }
  await nextTask();
  const loaded = store ? await loadCached(value, store) : load(format, value);
  if (!prepared.camera) Object.assign(prepared, viewOf(loaded.scene), { instances: loaded.scene.count });
  if (format.kind !== 'es3d') shareShading(loaded.scene, prepared.reference);
  renderer.options.autoLod = format.autoLod !== false;
  renderer.options.fixedLod = 0;
  // progressive: draw at once with stand-in levels, refine over the next frames;
  // every other format waits for full detail in its first frame
  renderer.options.tessellationBudget = format.progressive ? PROGRESSIVE_BUDGET_MS : Infinity;
  // every format starts from empty GPU buffers, so first-frame upload is comparable
  renderer.setScene(loaded.scene, loaded.meshOf, { keepGeometry: false });
  const view = { width: opts.width, height: opts.height, dpr: 1, time: 0 };
  const cam = prepared.camera.clone();
  const genBefore = loaded.cache ? loaded.cache.stats.generateMs : 0;
  // first frame: lazy geometry generation, packing and GPU upload included
  const t0 = now();
  renderer.render(cam, view);
  await renderer.finish();
  const firstFrame = now() - t0;
  const firstStats = { ...renderer.stats };
  // full detail: frames until no level is drawn coarser than wanted
  let refineFrames = 0;
  while (renderer.stats.refining && refineFrames < 1000) {
    renderer.render(cam, view);
    await renderer.finish();
    refineFrames++;
  }
  const fullMs = loaded.ms + (now() - t0);
  const geometryMs = loaded.cache ? loaded.cache.stats.generateMs - genBefore : 0;
  // orbit around the target for the measured frames
  const frames = opts.frames || 60;
  const target = cam.target.slice();
  const dx = cam.position[0] - target[0], dz = cam.position[2] - target[2];
  const radius = Math.hypot(dx, dz);
  const a0 = Math.atan2(dz, dx);
  const times = [];
  const cpu = [];
  let draws = 0, tris = 0, lodTris = [];
  const warmup = 3;
  for (let f = -warmup; f < frames; f++) {
    const a = a0 + ((Math.max(0, f) + 0.5) / frames) * Math.PI * 2;
    cam.position = [target[0] + Math.cos(a) * radius, cam.position[1], target[2] + Math.sin(a) * radius];
    const t = now();
    renderer.render(cam, view);
    await renderer.finish();
    const dt = now() - t;
    if (f < 0) continue;
    times.push(dt);
    cpu.push(renderer.stats.cpuMs);
    draws += renderer.stats.drawCalls;
    tris += renderer.stats.triangles;
    lodTris.push(renderer.stats.triangles);
    if (opts.onFrame) opts.onFrame();
  }
  const errors = renderer.backend.errors ? renderer.backend.errors.splice(0) : [];
  return {
    ...base,
    bytes: size.bytes,
    gzip: size.gzip,
    loadMs: loaded.ms,
    restoreMs: loaded.restoreMs,
    restoredLevels: loaded.restored ? loaded.restored.levels : undefined,
    storedBytes: loaded.restored ? loaded.restored.bytes : undefined,
    firstFrameMs: firstFrame,
    readyMs: loaded.ms + firstFrame,
    fullMs,
    refineFrames,
    geometryMs,
    uploadBytes: firstStats.totalUploadBytes,
    gpuGeometryBytes: renderer.stats.geometryBytes,
    frameMs: median(times),
    frameP95: percentile(times, 0.95),
    cpuMs: median(cpu),
    drawCalls: Math.round(draws / frames),
    triangles: Math.round(tris / frames),
    trianglesMin: Math.min(...lodTris),
    trianglesMax: Math.max(...lodTris),
    instances: loaded.scene.count,
    frames,
    msaaSamples: renderer.caps.msaaSamples,
    engine: `ES3D (${renderer.kind === 'webgpu' ? 'WebGPU' : 'WebGL2'})`,
    errors,
  };
}
