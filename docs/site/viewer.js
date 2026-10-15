// A small ES3D viewer for the website. It compiles a document, draws it
// with the reference renderer (WebGPU, otherwise WebGL2), plays animations,
// and lets you orbit with a mouse or a finger. Drawing pauses when the
// viewer is scrolled out of sight.

import { compile } from '../../src/pipeline.js';
import { updateDynamic } from '../../src/scene/flatten.js';
import { createRenderer, PROGRESSIVE_BUDGET_MS } from '../../src/render/renderer.js';
import { Camera } from '../../src/render/camera.js';
import { OrbitControls } from '../../src/render/orbit-controls.js';
import { openGeometryStore, persistGeometry } from '../../src/cache/geometry-store.js';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {HTMLElement} container element whose content is replaced by the canvas
 * @param {{interactive?: boolean, backend?: string, autoplay?: boolean, geometryStore?: object|false}} [opts]
 */
export async function createViewer(container, { interactive = true, backend = 'auto', autoplay = !reducedMotion(), geometryStore } = {}) {
  // meshes kept between visits (IndexedDB); false keeps nothing
  const persist = persistGeometry(geometryStore === false ? null : geometryStore || openGeometryStore());
  const canvas = document.createElement('canvas');
  const renderer = await createRenderer(canvas, { backend });
  renderer.options.tessellationBudget = PROGRESSIVE_BUDGET_MS;
  const el = renderer.canvas || canvas;
  container.replaceChildren(el);

  const camera = new Camera();
  let result = null;
  let time = 0;
  let last = 0;
  let dirty = true;
  let holdUntil = 0; // a new document waits this long at most for its stored meshes
  let visible = true;
  let disposed = false;
  let trianglesDrawn = 0;
  let playing = autoplay;

  const controls = interactive ? new OrbitControls(el, camera) : null;
  if (controls) controls.onChange = () => (dirty = true);
  renderer.textures.onReady = () => (dirty = true);

  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => (visible = entries.some((e) => e.isIntersecting))) : null;
  if (io) io.observe(container);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => (dirty = true)) : null;
  if (ro) ro.observe(container);

  const frame = (t) => {
    if (disposed) return;
    requestAnimationFrame(frame);
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    if (!visible || !result || !result.scene) return;
    if (playing && result.scene.animation.time) {
      time += dt;
      updateDynamic(result.scene, result.graph, time);
      dirty = true;
    }
    if (!dirty || (holdUntil && t < holdUntil)) return;
    dirty = false;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    renderer.render(camera, { width: w, height: h, dpr: Math.min(window.devicePixelRatio || 1, 2), time });
    trianglesDrawn += renderer.stats.triangles || 0;
    // levels drawn coarser than wanted: refine them on the next frame
    if (renderer.stats.refining) dirty = true;
    persist.changed(result.cache);
  };
  requestAnimationFrame(frame);

  return {
    renderer,
    camera,
    get playing() {
      return playing;
    },
    set playing(value) {
      playing = value;
      if (value) dirty = true;
    },
    get kind() {
      return renderer.kind === 'webgpu' ? 'WebGPU' : 'WebGL2';
    },
    get trianglesDrawn() {
      return trianglesDrawn;
    },
    get stats() {
      return renderer.stats;
    },
    /** Compile and show an ES3D document; returns the compile result. */
    load(source, opts = {}) {
      const res = compile(source);
      if (res.scene && res.ok) this.show(res, opts);
      return res;
    },
    /** Show an already compiled document. */
    show(res, { keepCamera = false } = {}) {
      result = res;
      time = 0;
      renderer.setScene(res.scene, (entry, lod) => res.cache.mesh(entry, lod));
      holdUntil = performance.now() + 50;
      persist.restore(res.cache).finally(() => {
        if (result !== res) return;
        holdUntil = 0;
        dirty = true;
      });
      if (controls) {
        controls.configure(res.scene.controls, { world: () => ({ scene: res.scene, meshOf: (entry, lod) => res.cache.mesh(entry, lod) }) });
        if (!interactive) controls.enabled = false;
      }
      if (!keepCamera) {
        if (res.scene.cameras.length) camera.fromSpec(res.scene.cameras[0]);
        else {
          camera.type = 'perspective';
          camera.near = null;
          camera.far = null;
          camera.frame(res.scene.bounds);
        }
      }
      dirty = true;
    },
    redraw() {
      dirty = true;
    },
    dispose() {
      disposed = true;
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      if (controls) controls.dispose();
      renderer.dispose();
    },
  };
}
