// A stage: an ES3D document on a canvas, ready for a web page.
//
//   const stage = await createStage(canvas, { scroll: document.querySelector('#tour') });
//   stage.show(source);
//
// It compiles the document, draws it with the renderer, and handles what a
// page needs around that:
//
// - Draws only when something visible changed (camera, animation, size, a
//   texture arriving), and not at all while the canvas is scrolled away.
// - Applies the document's <controls>: orbit limits, collision with the scene,
//   no dragging (mode="none") or a camera driven by page scroll (mode="scroll").
// - Drives timeline="scroll" animations from the scroll position of a page
//   section (see ScrollTimeline), and builds the meshes the scroll path will
//   need while the browser is idle, so scrolling does not stutter later.
// - Keeps geometry between documents: show() reuses the previous document's
//   geometry cache, so swapping a colour re-tessellates and re-uploads nothing.
// - Keeps geometry between visits: the meshes a document's shapes produced
//   are stored in the browser (IndexedDB, src/cache/geometry-store.js) once
//   the page is idle, and read back instead of tessellated on the next visit.
//
// Reduced motion (prefers-reduced-motion) stops clock animations and the
// automatic orbit; scroll-driven cameras jump between stops.

import { compile } from '../pipeline.js';
import { updateDynamic } from '../scene/flatten.js';
import { pick } from '../scene/picking.js';
import { createRenderer, PROGRESSIVE_BUDGET_MS } from './renderer.js';
import { openGeometryStore, persistGeometry } from '../cache/geometry-store.js';
import { Camera } from './camera.js';
import { OrbitControls } from './orbit-controls.js';
import { ScrollTimeline } from './scroll-timeline.js';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 16));

/** Names (name or id) on an element and its ancestors, nearest first. */
export function ancestorNames(doc, uid) {
  const names = [];
  let el = doc && doc.byUid.get(uid);
  while (el) {
    const n = el.values && (el.values.name || el.values.id);
    if (n) names.push(n);
    el = el.parent;
  }
  return names;
}

/** Views sampled along a scroll path to warm up its meshes. */
const PREFETCH_SAMPLES = 24;

/** How long a new document waits for its stored meshes before drawing without them (ms). */
const RESTORE_WAIT_MS = 50;

/**
 * @param {HTMLCanvasElement} canvas sized by its parent element
 * @param {object} [opts]
 * @param {boolean} [opts.playing=true] play clock animations
 * @param {boolean} [opts.autoOrbit=true] turn slowly around the target until someone drags
 * @param {number} [opts.orbitSpeed=0.22] radians per second
 * @param {boolean} [opts.interactive=true] false: no dragging, whatever the document says
 * @param {HTMLElement} [opts.scroll] section whose scroll position drives timeline="scroll"
 *   animations (default: the whole page)
 * @param {string} [opts.backend] 'auto' | 'webgpu' | 'webgl2'
 * @param {(dt:number, stage:object) => void} [opts.onFrame] called every animation frame
 * @param {(hit: object|null) => void} [opts.onPick] click on the scene; hit.names lists name/id up the tree
 * @param {() => void} [opts.onInteract] the visitor moved the camera
 * @param {(message: string, result: object) => void} [opts.onError] the document did not compile
 * @param {object|Promise<object>|false} [opts.geometryStore] where generated meshes are kept
 *   between visits (default: IndexedDB, openGeometryStore()); false keeps nothing
 */
export async function createStage(canvas, opts = {}) {
  // opened while the renderer starts, so the first show() rarely waits for it
  const persist = persistGeometry(opts.geometryStore === false ? null : opts.geometryStore || openGeometryStore());
  const renderer = await createRenderer(canvas, { backend: opts.backend });
  renderer.options.tessellationBudget = PROGRESSIVE_BUDGET_MS;
  const target = renderer.canvas || canvas;
  const parent = target.parentElement;
  target.style.display = 'block';
  const camera = new Camera();
  const controls = new OrbitControls(target, camera);
  const motion = !reducedMotion();
  const state = {
    result: null,
    time: 0,
    progress: 0,
    last: 0,
    disposed: false,
    playing: opts.playing !== false && motion,
    auto: opts.autoOrbit !== false && motion,
    orbitSpeed: opts.orbitSpeed ?? 0.22,
    onScreen: true,
    // A frame is drawn only when something visible changed: the camera, the
    // animation time or scroll progress, the size, the scene or a texture.
    dirty: true,
    sceneTime: NaN, // time and progress the animated instances were last evaluated at
    sceneProgress: NaN,
    width: 0,
    height: 0,
    dpr: renderer.pixelRatio(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1),
    gpuEpoch: renderer.backend.resourceEpoch || 0,
    timeline: null,
    generation: 0, // bumps on show(), to cancel stale idle work
    holdUntil: 0, // no drawing before this time: a new document's stored meshes are on their way
  };
  const invalidate = () => {
    state.dirty = true;
  };
  renderer.textures.onReady = invalidate;

  // Camera state at the last drawn frame; onFrame callbacks move the camera directly.
  const seen = new Float64Array(15).fill(NaN);
  let moved = false;
  const see = (i, v) => {
    if (seen[i] !== v) {
      seen[i] = v;
      moved = true;
    }
  };
  const cameraMoved = () => {
    const c = camera;
    moved = false;
    for (let k = 0; k < 3; k++) {
      see(k, c.position[k]);
      see(3 + k, c.target[k]);
      see(6 + k, c.up[k]);
    }
    see(9, c.fov);
    see(10, c.orthoHeight);
    see(11, c.type === 'orthographic' ? 1 : 0);
    see(12, c.near ?? -1);
    see(13, c.refAspect);
    see(14, c.fit === 'cover' ? 1 : c.fit === 'width' ? 2 : c.fit === 'height' ? 3 : 0);
    return moved;
  };

  const meshOf = (entry, lod) => state.result.cache.mesh(entry, lod);
  const lodVisible = (scene) => {
    const lods = renderer.frames.lodStates(scene, camera.position, (p) => Math.hypot(p[0] - camera.position[0], p[1] - camera.position[1], p[2] - camera.position[2]));
    return (i) => {
      const ln = scene.lodNode[i];
      return ln < 0 || (lods.visible[ln] && lods.active[ln] === scene.lodChild[i]);
    };
  };
  const world = () => (state.result ? { scene: state.result.scene, meshOf, isVisible: lodVisible(state.result.scene) } : null);

  controls.onChange = () => {
    state.auto = false;
    state.dirty = true;
    if (opts.onInteract) opts.onInteract();
  };
  controls.onClick = (x, y) => {
    if (!state.result || !opts.onPick) return;
    const w = target.clientWidth;
    const h = target.clientHeight;
    if (!w || !h) return;
    const scene = state.result.scene;
    camera.update(w / h, renderer.backend.zeroToOne, scene.bounds);
    const ray = camera.ray(x, y, w, h, renderer.backend.zeroToOne);
    const hit = pick(scene, meshOf, ray.origin, ray.dir, lodVisible(scene));
    opts.onPick(hit ? { ...hit, names: ancestorNames(state.result.doc, hit.uid) } : null);
  };

  const io = new IntersectionObserver(([entry]) => {
    state.onScreen = entry.isIntersecting;
    if (state.onScreen) state.dirty = true;
  }, { threshold: 0.02 });
  io.observe(parent || target);
  // Size comes from the observer, so frames never read layout.
  const ro = new ResizeObserver(([entry]) => {
    const box = entry.contentBoxSize && entry.contentBoxSize[0];
    const w = Math.round(box ? box.inlineSize : entry.contentRect.width);
    const h = Math.round(box ? box.blockSize : entry.contentRect.height);
    if (w === state.width && h === state.height) return;
    state.width = w;
    state.height = h;
    target.style.width = `${w}px`;
    target.style.height = `${h}px`;
    state.dirty = true;
  });
  ro.observe(parent || target);

  const mode = () => (state.result && state.result.scene.controls ? state.result.scene.controls.mode : 'orbit');
  // in scroll and none modes the document's first camera is the view
  const followsDocument = () => mode() !== 'orbit' && state.result && state.result.scene.cameras.length > 0;
  const view = () => ({ width: state.width, height: state.height, dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1 });

  /** Build, while the browser is idle, the meshes for views sampled along the scroll path. */
  const prefetchScrollPath = () => {
    const gen = state.generation;
    let k = 0;
    const step = () => {
      const res = state.result;
      if (state.disposed || gen !== state.generation || !res || k > PREFETCH_SAMPLES) return;
      if (!state.width || !state.height) return void setTimeout(() => idle(step), 200);
      const p = k / PREFETCH_SAMPLES;
      k++;
      updateDynamic(res.scene, res.graph, state.time, p);
      const cam = followsDocument() ? new Camera().fromSpec(res.scene.cameras[0]) : camera;
      renderer.prepare(cam, view());
      // put the scene back where the page is
      updateDynamic(res.scene, res.graph, state.sceneTime, state.sceneProgress);
      persist.changed(res.cache);
      idle(step);
    };
    idle(step);
  };

  const configureScroll = () => {
    const scene = state.result.scene;
    if (!scene.animation.scroll) {
      if (state.timeline) state.timeline.dispose();
      state.timeline = null;
      return;
    }
    if (!state.timeline) {
      const section = opts.scroll || document.scrollingElement || document.documentElement;
      state.timeline = new ScrollTimeline(section);
    }
    state.timeline.update(0);
    state.progress = state.timeline.value;
  };

  const api = {
    camera,
    renderer,
    controls,
    kind: renderer.kind,
    get time() {
      return state.time;
    },
    set time(v) {
      state.time = v;
    },
    /** Scroll timeline position 0..1; set it to drive scroll animations without a page section. */
    get progress() {
      return state.progress;
    },
    set progress(v) {
      if (state.timeline) {
        state.timeline.dispose();
        state.timeline = null;
      }
      state.progress = Math.min(1, Math.max(0, v));
    },
    get playing() {
      return state.playing;
    },
    set playing(v) {
      state.playing = !!v;
    },
    /** Draw the next frame even if nothing the stage tracks has changed. */
    invalidate,
    get result() {
      return state.result;
    },
    /**
     * Compile and show a document. Returns the compile result; on errors the
     * previous document stays on screen.
     * @param {string} source
     * @param {{keepCamera?: boolean, time?: number}} [showOpts]
     */
    show(source, showOpts = {}) {
      if (showOpts.time !== undefined) state.time = showOpts.time;
      // Reusing the cache keeps every mesh whose definition did not change
      // (a new wrap or paint only changes materials), so nothing is re-tessellated
      // and the renderer finds those meshes already on the GPU.
      const result = compile(source, { time: state.time, progress: state.progress, cache: state.result ? state.result.cache : undefined });
      if (!result.ok) {
        const msg = result.diagnostics.map((d) => d.format()).join('\n\n');
        if (opts.onError) opts.onError(msg, result);
        else console.error(msg);
        return result;
      }
      state.result = result;
      state.generation++;
      renderer.setScene(result.scene, meshOf);
      configureScroll();
      if (state.progress !== 0) updateDynamic(result.scene, result.graph, state.time, state.progress);
      state.sceneTime = state.time;
      state.sceneProgress = state.progress;
      state.dirty = true;
      const spec = result.scene.controls;
      controls.configure(spec, { world });
      if (opts.interactive === false) controls.enabled = false;
      if (spec && spec.mode !== 'orbit') state.auto = false;
      if (!showOpts.keepCamera || followsDocument()) {
        if (result.scene.cameras.length) camera.fromSpec(result.scene.cameras[0]);
        else camera.frame(result.scene.bounds);
      }
      // draw once the stored meshes are in, or without them after a short wait;
      // the scroll path is prepared after that, so it only builds what was not stored
      const gen = state.generation;
      state.holdUntil = performance.now() + RESTORE_WAIT_MS;
      persist.restore(result.cache).finally(() => {
        if (gen !== state.generation) return;
        state.holdUntil = 0;
        state.dirty = true;
        if (result.scene.animation.scroll) prefetchScrollPath();
      });
      return result;
    },
    dispose() {
      state.disposed = true;
      io.disconnect();
      ro.disconnect();
      if (state.timeline) state.timeline.dispose();
      controls.dispose();
      renderer.dispose();
    },
  };

  const frame = (now) => {
    if (state.disposed) return;
    requestAnimationFrame(frame);
    const dt = state.last ? Math.min(0.05, (now - state.last) / 1000) : 0;
    state.last = now;
    if (!state.result || !state.onScreen) return;
    if (!state.width || !state.height) return;
    const res = state.result;
    const scene = res.scene;
    // a scene without clock animations looks the same at every time
    if (state.playing && scene.animation.time) state.time += dt;
    if (state.timeline && state.timeline.update(dt)) state.progress = state.timeline.value;
    if (opts.onFrame) opts.onFrame(dt, api);
    if (state.auto) {
      const prev = controls.snapshot();
      const dx = camera.position[0] - camera.target[0];
      const dz = camera.position[2] - camera.target[2];
      const a = state.orbitSpeed * dt;
      const co = Math.cos(a);
      const si = Math.sin(a);
      camera.position[0] = camera.target[0] + dx * co - dz * si;
      camera.position[2] = camera.target[2] + dx * si + dz * co;
      controls.constrain(prev);
    }
    if (scene.dynamic.length && (state.time !== state.sceneTime || state.progress !== state.sceneProgress)) {
      updateDynamic(scene, res.graph, state.time, state.progress);
      state.sceneTime = state.time;
      state.sceneProgress = state.progress;
      if (followsDocument()) camera.fromSpec(scene.cameras[0]);
      state.dirty = true;
    }
    if (cameraMoved()) state.dirty = true;
    const dpr = renderer.pixelRatio(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    if (dpr !== state.dpr) {
      state.dpr = dpr;
      state.dirty = true;
    }
    const epoch = renderer.backend.resourceEpoch || 0;
    if (epoch !== state.gpuEpoch) {
      state.gpuEpoch = epoch;
      state.dirty = true;
    }
    if (!state.dirty || (state.holdUntil && now < state.holdUntil)) return;
    state.dirty = false;
    renderer.render(camera, { ...view(), time: state.time });
    // levels drawn coarser than wanted: refine them on the next frame
    if (renderer.stats.refining) state.dirty = true;
    persist.changed(res.cache);
  };
  requestAnimationFrame(frame);
  return api;
}
