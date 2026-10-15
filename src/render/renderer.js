// Renderer facade: picks a GPU backend (WebGPU preferred, WebGL2 fallback)
// and runs the backend-independent parts of a frame (camera, culling, LOD,
// batching, uniform packing, incremental geometry upload).
//
// The facade is the only renderer API used by the application and the
// benchmark; backends never see the ES3D document, only a RenderScene.

import { GeometryPool } from './geometry-pool.js';
import { FrameBuilder } from './frame-builder.js';
import { TextureCache } from './texture-cache.js';
import { FRAME_FLOATS, packFrameUniforms } from './lighting.js';
import { Mesh } from '../geometry/mesh.js';
import { WebGL2Backend } from './webgl2/webgl2-backend.js';
import { WebGPUBackend } from './webgpu/webgpu-backend.js';

const now = () => performance.now();

function cubeEdges() {
  const p = [];
  for (let i = 0; i < 8; i++) p.push(i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5);
  const e = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];
  return new Mesh({ positions: Float32Array.from(p), indices: Uint32Array.from(e), kind: 'lines' });
}

export const OVERLAY_COLORS = {
  wireframe: [0.02, 0.03, 0.05, 0.55],
  normals: [1.0, 0.82, 0.15, 0.95],
  bbox: [0.35, 0.78, 1.0, 0.75],
  selection: [1.0, 0.55, 0.12, 1.0],
};

// setScene keeps the packed geometry, so a new document that shares meshes
// with the last one (a colour change, an edit elsewhere in the file) uploads
// only what is new. Meshes no longer used stay packed until the pool passes
// this size; then it is repacked from what the scene draws.
const POOL_REPACK_BYTES = 32 << 20;

/**
 * Tessellation budget (ms per frame) for render loops that draw again while
 * stats.refining is non-zero: the first frame comes at once with coarser
 * stand-ins, full detail a few frames later.
 */
export const PROGRESSIVE_BUDGET_MS = 4;

export class Renderer {
  constructor(backend) {
    this.backend = backend;
    this.kind = backend.kind;
    this.pool = new GeometryPool();
    this.frames = new FrameBuilder();
    this.textures = new TextureCache();
    this.frameData = new Float32Array(FRAME_FLOATS);
    this.options = {
      wireframe: false,
      normals: false,
      bbox: false,
      autoLod: true,
      fixedLod: 0,
      culling: true,
      lodBias: 1,
      // Same picture on every screen: the canvas resolution is capped at this
      // many device pixels per CSS pixel, and automatic LOD budgets its error in
      // CSS pixels, so a phone and a desktop choose the same meshes for the
      // same view ('device' spends more triangles on high-density screens).
      maxPixelRatio: 2,
      lodPixels: 'css',
      // Milliseconds of mesh generation per frame. Past it, levels that do not
      // exist yet are drawn with a coarser one, and stats.refining counts them:
      // render again while it is non-zero and full detail follows within a few
      // frames. Infinity (the default) generates everything the frame needs.
      tessellationBudget: Infinity,
    };
    this.selection = new Set();
    this.scene = null;
    this.meshOf = null;
    this.cube = cubeEdges();
    this.cubeRange = this.pool.meshRange(this.cube);
    this.lastDraw = null;
    this.lightInfo = { truncated: 0, usedDefaults: false };
    this.stats = { cpuMs: 0, uploadBytes: 0, totalUploadBytes: 0, drawCalls: 0, triangles: 0, visible: 0, instances: 0 };
  }

  get info() {
    return this.backend.info;
  }

  /**
   * What this device actually renders with, for checking that two devices
   * show the same thing: backend, MSAA samples, texture filtering, limits,
   * and whether the scene has more lights than are drawn.
   */
  get caps() {
    return { backend: this.kind, ...this.backend.caps, maxPixelRatio: this.options.maxPixelRatio, lodPixels: this.options.lodPixels, lightsDropped: this.lightInfo.truncated || 0 };
  }

  /** Device pixels per CSS pixel actually used for a requested ratio. */
  pixelRatio(dpr) {
    return Math.min(dpr || 1, this.options.maxPixelRatio || Infinity);
  }

  /**
   * Replace the scene. Geometry is packed lazily into the shared buffers.
   * Meshes already packed are kept (pass keepGeometry: false for a cold start).
   */
  setScene(scene, meshOf, { keepGeometry = true } = {}) {
    this.scene = scene;
    this.meshOf = meshOf;
    if (!scene || !keepGeometry || this.pool.byteSize > POOL_REPACK_BYTES) {
      this.pool.reset();
      this.cubeRange = this.pool.meshRange(this.cube);
    }
    this.backend.releaseMaterials(new Set(scene ? scene.materials : []));
    this.stats.totalUploadBytes = 0;
  }

  /**
   * Render one frame.
   * @param {import('./camera.js').Camera} camera
   * @param {{width:number, height:number, dpr?:number, time?:number}} view CSS size of the canvas
   */
  render(camera, view) {
    const t0 = now();
    const dpr = this.pixelRatio(view.dpr);
    const w = Math.max(1, Math.round(view.width * dpr));
    const h = Math.max(1, Math.round(view.height * dpr));
    this.backend.resize(w, h);
    const scene = this.scene;
    const bounds = scene ? scene.bounds : { min: [-1, -1, -1], max: [1, 1, 1] };
    camera.update(w / h, this.backend.zeroToOne, bounds);
    const env = scene && scene.environment ? scene.environment : { background: [0.09, 0.1, 0.12, 1], sky: [0.8, 0.86, 0.95, 1], ground: [0.25, 0.22, 0.2, 1], intensity: 0.5, exposure: 1 };
    let draw;
    if (scene) {
      draw = this.buildFrame(camera, view, h);
    } else {
      draw = { batches: [], overlays: { wireframe: [], normals: [], bbox: null, selection: null }, instanceData: new Float32Array(16), instanceCount: 0, stats: { instances: 0, visible: 0, culled: 0, batches: 0, drawCalls: 0, triangles: 0, lodHistogram: [0, 0, 0, 0], refining: 0 } };
    }
    const radius = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2 || 1;
    this.lightInfo = packFrameUniforms(this.frameData, {
      viewProj: camera.viewProj,
      view: camera.view,
      cameraPos: camera.position,
      time: view.time || 0,
      environment: env,
      lights: scene ? scene.lights : [],
      normalLength: radius * 0.025,
      lineBias: 0.0015,
      viewportHeight: h,
    });
    const uploaded = this.backend.syncPool(this.pool);
    this.backend.render(draw, this.frameData, {
      background: env.background,
      textures: this.textures,
      overlayColors: OVERLAY_COLORS,
      cubeRange: this.cubeRange,
    });
    this.lastDraw = draw;
    const s = this.stats;
    s.cpuMs = now() - t0;
    s.uploadBytes = uploaded + draw.instanceCount * 64;
    s.totalUploadBytes += uploaded;
    s.drawCalls = draw.stats.drawCalls;
    s.triangles = draw.stats.triangles;
    s.visible = draw.stats.visible;
    s.instances = draw.stats.instances;
    s.culled = draw.stats.culled;
    s.batches = draw.stats.batches;
    s.lodHistogram = draw.stats.lodHistogram;
    s.refining = draw.stats.refining || 0;
    s.geometryBytes = this.pool.byteSize;
    s.instanceBytes = draw.instanceCount * 64;
    s.textureBytes = this.backend.gpuBytes;
    return draw;
  }

  buildFrame(camera, view, deviceHeight, tessellationBudget = this.options.tessellationBudget) {
    const lodHeight = this.options.lodPixels === 'device' ? deviceHeight : Math.max(1, Math.round(view.height));
    return this.frames.build({
      scene: this.scene,
      camera,
      pool: this.pool,
      meshOf: this.meshOf,
      viewportHeight: lodHeight,
      options: { ...this.options, selection: this.selection, tessellationBudget },
    });
  }

  /**
   * Generate and pack (but do not draw) every mesh a view needs, so a later
   * frame from that view does not stall on tessellation. The upload happens
   * with the next render. Used to warm up a scroll-driven camera path.
   * @param {import('./camera.js').Camera} camera not modified
   * @param {{width:number, height:number, dpr?:number}} view
   */
  prepare(camera, view) {
    if (!this.scene) return;
    const dpr = this.pixelRatio(view.dpr);
    const w = Math.max(1, Math.round(view.width * dpr));
    const h = Math.max(1, Math.round(view.height * dpr));
    const cam = camera.clone();
    cam.update(w / h, this.backend.zeroToOne, this.scene.bounds);
    const keep = this.frames.last;
    this.buildFrame(cam, view, h, Infinity);
    this.frames.last = keep;
  }

  /** Wait for the GPU to finish all submitted work (benchmarks). */
  finish() {
    return this.backend.finish();
  }

  dispose() {
    this.textures.clear((g) => this.backend.destroyTexture(g));
    this.backend.dispose();
  }
}

/**
 * Create a renderer for a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {{backend?: 'auto'|'webgpu'|'webgl2', present?: 'canvas'|'readback'}} [opts]
 */
export async function createRenderer(canvas, opts = {}) {
  const want = opts.backend || 'auto';
  const errors = [];
  if ((want === 'auto' || want === 'webgpu') && typeof navigator !== 'undefined' && navigator.gpu) {
    const b = new WebGPUBackend(canvas, { present: opts.present });
    try {
      await b.init();
      return new Renderer(b);
    } catch (e) {
      errors.push(e.message);
      if (want === 'webgpu') throw e;
    }
  } else if (want === 'webgpu') {
    throw new Error('WebGPU is not available in this browser.');
  }
  // A canvas that already has a WebGPU context cannot create a WebGL2 context.
  let target = canvas;
  if (errors.length && canvas.getContext && canvas.parentNode) {
    target = canvas.cloneNode(false);
    canvas.parentNode.replaceChild(target, canvas);
  }
  const b = new WebGL2Backend(target);
  await b.init();
  const r = new Renderer(b);
  r.fallbackReason = errors.join('; ');
  r.canvas = target;
  return r;
}
