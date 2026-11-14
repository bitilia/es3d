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
// - Shows fragments: stage.add(source) puts a whole other document into the
//   scene (a map tile, a room, a route), and only that document is compiled
//   when it is added, replaced or removed (scene/fragments.js). Changes are
//   applied in the frame loop within changeBudget milliseconds per frame.
// - Compiles off the main thread: stage.prepare(source) compiles in a worker
//   started from this same file (render/compile-worker.js), and add() or
//   show() of the result takes about a millisecond here.
//
// Until a page calls add(), show() does exactly what it did before fragments
// existed: the host's scene is handed to the renderer as it is.
//
// Reduced motion (prefers-reduced-motion) stops clock animations and the
// automatic orbit; scroll-driven cameras jump between stops. stage.reducedMotion
// reads that preference on each access, and the clock checks it every frame.
//
// clock: 'always' advances time even when the document has no <animate>.
// background: true selects that clock and leaves the camera still, for a
// page that moves shapes itself with stage.setTransform(id, matrix).

// first: in the compiler worker it keeps messages that arrive while the modules load
import './worker-boot.js';
import { compile } from '../pipeline.js';
import { formatDiagnostics } from '../format/parse.js';
import { applyLocalMatrices, updateDynamic } from '../scene/flatten.js';
import { pick, ancestorNames } from '../scene/picking.js';
import { GeometryCache, DOCUMENT } from '../geometry/geometry-cache.js';
import { FragmentStage } from '../scene/fragments.js';
import { Prepared } from '../scene/prepared.js';
import { createRenderer, PROGRESSIVE_BUDGET_MS } from './renderer.js';
import { openGeometryStore, persistGeometry } from '../cache/geometry-store.js';
import { Camera } from './camera.js';
import { OrbitControls } from './orbit-controls.js';
import { ScrollTimeline } from './scroll-timeline.js';
import { CompilerClient, isWorkerScope, serveCompiler } from './compile-worker.js';

export { ancestorNames };

// In a worker started by stage.prepare(), this file is the compiler.
if (isWorkerScope()) serveCompiler(self);

const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 16));
const clock = () => performance.now();

/**
 * Clock and orbit flags for createStage. background: true runs the clock
 * and does not orbit, unless clock or autoOrbit is set explicitly.
 * @param {object} [opts]
 * @param {boolean} [reduced]
 */
export function stageOptions(opts = {}, reduced = false) {
  const background = opts.background === true;
  const always = opts.clock === 'always' || (opts.clock == null && background);
  const autoOrbit = opts.autoOrbit !== undefined ? opts.autoOrbit !== false : !background;
  return {
    clock: always ? 'always' : 'document',
    playing: opts.playing !== false && !reduced,
    auto: autoOrbit && !reduced,
  };
}

/** True when this frame should add dt to the stage clock. */
export function clockAdvances(state, scene, reduced) {
  return !!(state.playing && !reduced && (state.clock === 'always' || (scene.animation && scene.animation.time)));
}

/** True when this frame should turn the automatic orbit. */
export function orbitAdvances(state, reduced) {
  return !!(state.auto && !reduced);
}

/** Views sampled along a scroll path to warm up its meshes. */
const PREFETCH_SAMPLES = 24;

/** How long a new document waits for its stored meshes before drawing without them (ms). */
const RESTORE_WAIT_MS = 50;

/** Default changeBudget: ms per frame for compiling and placing fragments. */
export const CHANGE_BUDGET_MS = 4;

const waitAtMost = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

/**
 * @param {HTMLCanvasElement} canvas sized by its parent element
 * @param {object} [opts]
 * @param {boolean} [opts.playing=true] play clock animations
 * @param {boolean} [opts.autoOrbit=true] turn slowly around the target until someone drags.
 *   background: true starts this off
 * @param {'always'|'document'} [opts.clock] 'always' advances time with no <animate>.
 *   background: true selects 'always'
 * @param {boolean} [opts.background=false] a still camera and a running clock, for a script
 *   that moves shapes with setTransform. <controls mode="none"/> turns dragging off
 * @param {number} [opts.orbitSpeed=0.22] radians per second
 * @param {boolean} [opts.interactive=true] false: no dragging, whatever the document says
 * @param {HTMLElement} [opts.scroll] section whose scroll position drives timeline="scroll"
 *   animations (default: the whole page)
 * @param {string} [opts.backend] 'auto' | 'webgpu' | 'webgl2'
 * @param {'canvas'|'readback'} [opts.present] WebGPU: 'readback' copies each frame into a 2D canvas
 *   (headless browsers, which do not show WebGPU canvases)
 * @param {(dt:number, stage:object) => void} [opts.onFrame] called every animation frame
 * @param {(hit: object|null) => void} [opts.onPick] click on the scene; hit.names lists name/id up the tree,
 *   hit.fragment is the id of the fragment that was hit (absent for the stage's document)
 * @param {() => void} [opts.onInteract] the visitor moved the camera
 * @param {(message: string, result: object) => void} [opts.onError] a document or fragment did not compile,
 *   or a fragment has elements only the stage's document can set (result.ok is then true)
 * @param {object|Promise<object>|false} [opts.geometryStore] where generated meshes are kept
 *   between visits (default: IndexedDB, openGeometryStore()); false keeps nothing
 * @param {number} [opts.changeBudget=4] ms per frame for compiling and placing fragments
 * @param {number} [opts.workers=1] 0 compiles prepare() on the main thread
 */
export async function createStage(canvas, opts = {}) {
  // opened while the renderer starts, so the first show() rarely waits for it
  const persist = persistGeometry(opts.geometryStore === false ? null : opts.geometryStore || openGeometryStore());
  const renderer = await createRenderer(canvas, { backend: opts.backend, present: opts.present });
  renderer.options.tessellationBudget = PROGRESSIVE_BUDGET_MS;
  const target = renderer.canvas || canvas;
  const parent = target.parentElement;
  target.style.display = 'block';
  const camera = new Camera();
  const controls = new OrbitControls(target, camera);
  const motion = stageOptions(opts, prefersReducedMotion());
  const state = {
    result: null,
    cache: new GeometryCache(), // one for the document and every fragment
    setMode: false, // true once a fragment was added: the renderer draws a SceneSet
    time: 0,
    progress: 0,
    last: 0,
    disposed: false,
    clock: motion.clock,
    playing: motion.playing,
    auto: motion.auto,
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
    changeBudget: opts.changeBudget ?? CHANGE_BUDGET_MS,
    workers: opts.workers ?? 1,
    compilerTried: false,
    placedSinceDraw: false, // a change was placed that no frame has drawn yet
    framesDrawn: 0,
    waiters: [], // stage.drawn() promises
    since: { changeMs: 0, compileMs: 0 }, // change work since the last drawn frame
    stats: { frameMs: 0, changeMs: 0, compileMs: 0, tessellateMs: 0, renderMs: 0, instances: 0, drawCalls: 0, uploadBytes: 0, refining: 0, queued: 0 },
    storeOwners: new Set(), // cache owners with meshes generated since the last save
  };
  const invalidate = () => {
    state.dirty = true;
  };
  renderer.textures.onReady = invalidate;

  const frags = new FragmentStage({
    cache: state.cache,
    clock: () => ({ time: state.time, progress: state.progress }),
    report: (message, result) => {
      if (opts.onError) opts.onError(message, result);
      else if (result.ok) console.warn(message);
      else console.error(message);
    },
    forget: (owner) => {
      persist.forget(owner);
      state.storeOwners.delete(owner);
    },
    restore: (cache, owner) => (persist.store ? waitAtMost(persist.restore(cache, { entries: cache.owned(owner) }), RESTORE_WAIT_MS) : null),
  });

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

  const meshOf = (entry, lod) => state.cache.mesh(entry, lod);
  // what the renderer draws: the document's scene, or the set of it and the fragments
  const drawScene = () => (state.setMode ? frags.set : state.result && state.result.scene);
  const lodVisibleIn = (scene) => {
    const lods = renderer.frames.lodStates(scene, camera.position, (p) => Math.hypot(p[0] - camera.position[0], p[1] - camera.position[1], p[2] - camera.position[2]));
    return (i) => {
      const ln = scene.lodNode[i];
      return ln < 0 || (lods.visible[ln] && lods.active[ln] === scene.lodChild[i]);
    };
  };
  // a scene set is tested part by part (raycast passes the part's scene)
  const lodVisible = (scene) => {
    if (!scene.parts) return lodVisibleIn(scene);
    const memo = new Map();
    return (i, part) => {
      let f = memo.get(part);
      if (!f) memo.set(part, (f = lodVisibleIn(part)));
      return f(i);
    };
  };
  const world = () => {
    const scene = drawScene();
    return scene ? { scene, meshOf, isVisible: lodVisible(scene) } : null;
  };

  controls.onChange = () => {
    state.auto = false;
    state.dirty = true;
    if (opts.onInteract) opts.onInteract();
  };
  controls.onClick = (x, y) => {
    const scene = drawScene();
    if (!scene || !opts.onPick) return;
    const w = target.clientWidth;
    const h = target.clientHeight;
    if (!w || !h) return;
    camera.update(w / h, renderer.backend.zeroToOne, scene.bounds);
    const ray = camera.ray(x, y, w, h, renderer.backend.zeroToOne);
    const hit = pick(scene, meshOf, ray.origin, ray.dir, lodVisible(scene));
    if (!hit) return opts.onPick(null);
    if (!scene.parts) return opts.onPick({ ...hit, names: ancestorNames(state.result.doc, hit.uid) });
    const { part, ...rest } = hit;
    const out = { ...rest, names: frags.names(part, hit.uid) };
    if (part && part !== frags.host) out.fragment = part.id;
    opts.onPick(out);
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
      persistChanged();
      idle(step);
    };
    idle(step);
  };

  // reset: read the scroll position now (show(); a fragment placed later keeps the timeline as it is)
  const configureScroll = (reset = true) => {
    const scene = drawScene();
    if (!scene || !scene.animation.scroll) {
      if (state.timeline) state.timeline.dispose();
      state.timeline = null;
      return;
    }
    if (!state.timeline) {
      const section = opts.scroll || document.scrollingElement || document.documentElement;
      state.timeline = new ScrollTimeline(section);
      reset = true;
    }
    if (reset) {
      state.timeline.update(0);
      state.progress = state.timeline.value;
    }
  };

  // Meshes generated since the last save, stored per owner once a fragment
  // exists (one record for the document, one per fragment)
  const persistChanged = () => {
    if (!state.setMode) {
      if (state.result) persist.changed(state.result.cache);
      return;
    }
    for (const owner of state.storeOwners) persist.changed(state.cache, { owner, entries: () => state.cache.owned(owner) });
    state.storeOwners.clear();
  };

  /** Draw a SceneSet from now on: the document and the fragments. */
  const enterSetMode = () => {
    if (state.setMode) return;
    state.setMode = true;
    if (state.result) frags.set.place(frags.host, state.result.scene);
    renderer.setScene(frags.set, meshOf);
    state.cache.onGenerate = (entry) => {
      for (const o of entry.owners) state.storeOwners.add(o);
    };
    state.dirty = true;
  };

  /** The document's compile result with its scene graph (a prepared one is compiled here now, once). */
  const hostResult = () => {
    const res = state.result;
    if (!res || res.graph || !res.prepared) return res;
    const owner = frags.newOwner('document');
    const full = compile(res.source, { cache: state.cache, owner, time: state.time, progress: state.progress });
    state.result = full;
    if (state.setMode) frags.setHost(full, owner);
    else {
      frags.adoptHost(full, owner);
      renderer.setScene(full.scene, meshOf);
    }
    state.dirty = true;
    return full;
  };

  const ensureCompiler = () => {
    if (state.compilerTried) return;
    state.compilerTried = true;
    if (state.workers === 0) return;
    const client = new CompilerClient(import.meta.url);
    if (!client.failed) frags.compiler = client;
  };

  // promises from stage.drawn(), resolved after the first frame that shows
  // every change queued before the call, fully refined
  const settleWaiters = () => {
    if (!state.waiters.length) return;
    if (state.placedSinceDraw || !state.framesDrawn || renderer.stats.refining) return;
    state.waiters = state.waiters.filter((w) => {
      for (const t of w.tasks) if (!t.finished) return true;
      w.resolve(state.stats);
      return false;
    });
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
    /** True while the visitor prefers reduced motion. The clock and the automatic orbit stay still. */
    get reducedMotion() {
      return prefersReducedMotion();
    },
    /** Milliseconds per frame for compiling and placing fragments (default 4). */
    get changeBudget() {
      return state.changeBudget;
    },
    set changeBudget(v) {
      state.changeBudget = Math.max(0, +v || 0);
    },
    /**
     * The last drawn frame, in main-thread milliseconds: frameMs is the whole
     * frame callback; changeMs the fragment changes applied since the frame
     * before (compileMs of it compiling); tessellateMs mesh generation while
     * drawing; renderMs drawing without that generation.
     */
    get stats() {
      return { ...state.stats };
    },
    /**
     * Replace the local matrix of each element. An entry is `[id, matrix]`
     * or `{id, matrix}`. The matrix is column-major, 16 numbers, the same
     * layout as matrix(). Every matrix is stored first, then each affected
     * part of the scene is walked once. The returned array has false for an
     * id that is missing or drawn in more than one place (a shared
     * definition, or a copy made by repeat or scatter). Ids are those of the
     * stage's document; a fragment has fragment.setTransforms.
     * @param {Array<[string, ArrayLike<number>]|{id: string, matrix: ArrayLike<number>}>} entries
     */
    setTransforms(entries) {
      const list = Array.from(entries || []);
      const res = hostResult();
      const graph = res && res.graph;
      const byId = graph && graph.byId;
      const nodes = list.map((entry) => byId && byId.get(Array.isArray(entry) ? entry[0] : entry && entry.id));
      const matrices = list.map((entry) => Array.isArray(entry) ? entry[1] : entry && entry.matrix);
      const applied = graph && res.scene
        ? applyLocalMatrices(res.scene, graph, nodes, matrices, state.time, state.progress)
        : list.map(() => false);
      if (applied.some(Boolean)) {
        state.dirty = true;
        if (state.setMode) frags.set.invalidateBounds();
      }
      return applied;
    },
    /**
     * Replace the local matrix of the element with this id. The matrix is
     * column-major, 16 numbers, the same layout as matrix(). Returns false
     * when the id is missing or that element is drawn in more than one place
     * (a shared definition, or a copy made by repeat or scatter).
     * @param {string} id
     * @param {ArrayLike<number>} matrix
     */
    setTransform(id, matrix) {
      return this.setTransforms([[id, matrix]])[0] === true;
    },
    /** Draw the next frame even if nothing the stage tracks has changed. */
    invalidate,
    /** The document's compile result (a prepared document is compiled here on first access). */
    get result() {
      return hostResult();
    },
    /**
     * Compile and show a document. Returns the compile result; on errors the
     * previous document stays on screen. Fragments stay, unless
     * keepFragments is false.
     * @param {string|ArrayBuffer|Uint8Array|Prepared} source
     * @param {{keepCamera?: boolean, time?: number, keepFragments?: boolean}} [showOpts]
     */
    show(source, showOpts = {}) {
      if (showOpts.time !== undefined) state.time = showOpts.time;
      let result;
      let owner;
      if (source instanceof Prepared) {
        ({ result, owner } = frags.fromPrepared(source, 'document'));
      } else {
        // Reusing the cache keeps every mesh whose definition did not change
        // (a new wrap or paint only changes materials), so nothing is re-tessellated
        // and the renderer finds those meshes already on the GPU. Next to
        // fragments the document builds as an owner of its own, so it does not
        // evict theirs.
        owner = state.setMode ? frags.newOwner('document') : DOCUMENT;
        result = compile(source, { time: state.time, progress: state.progress, cache: state.cache, owner });
      }
      if (!result.ok) {
        if (owner && owner !== DOCUMENT) frags.release(owner);
        const msg = formatDiagnostics(result);
        if (opts.onError) opts.onError(msg, result);
        else console.error(msg);
        return result;
      }
      if (state.setMode && showOpts.keepFragments === false) frags.clear();
      state.result = result;
      state.generation++;
      if (state.setMode) {
        frags.setHost(result, owner);
        renderer.updateScene(frags.set);
        state.placedSinceDraw = true;
      } else {
        frags.adoptHost(result, owner);
        renderer.setScene(result.scene, meshOf);
      }
      configureScroll();
      if (state.progress !== 0 && result.graph) updateDynamic(result.scene, result.graph, state.time, state.progress);
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
      persist.restore(state.cache, state.setMode ? { entries: state.cache.owned(owner) } : undefined).finally(() => {
        if (gen !== state.generation) return;
        state.holdUntil = 0;
        state.dirty = true;
        if (result.scene.animation.scroll && result.graph) prefetchScrollPath();
      });
      return result;
    },
    /**
     * Show another document inside this one: a fragment. Returns at once; the
     * fragment is compiled and placed in the frame loop, within changeBudget
     * (immediate: true does it now). fragment.ready resolves when it is placed.
     * @param {string|ArrayBuffer|Uint8Array|Prepared|Promise<Prepared>} source a complete ES3D document
     * @param {{id?: string, immediate?: boolean}} [addOpts]
     * @returns {import('../scene/fragments.js').Fragment}
     */
    add(source, addOpts = {}) {
      enterSetMode();
      const f = frags.add(source, addOpts);
      state.dirty = true;
      return f;
    },
    /** The fragment with this id, or undefined. */
    fragment(id) {
      return frags.byId.get(String(id));
    },
    /** All fragments, in the order added. */
    get fragments() {
      return frags.list;
    },
    /**
     * Compile a document off the main thread (in a worker, where the page
     * allows one; otherwise here). Pass the result to add() or show().
     * @param {string|ArrayBuffer|Uint8Array} source
     * @param {{as?: 'fragment'|'document'}} [prepareOpts]
     * @returns {Promise<Prepared>}
     */
    prepare(source, prepareOpts = {}) {
      ensureCompiler();
      return frags.prepare(source, prepareOpts);
    },
    /**
     * Resolves after the first frame that shows every change queued before
     * this call, fully refined (renderer.stats.refining is 0), with stage.stats.
     */
    drawn() {
      return new Promise((resolve) => {
        state.waiters.push({ resolve, tasks: new Set(frags.queue) });
        state.dirty = true;
      });
    },
    dispose() {
      state.disposed = true;
      io.disconnect();
      ro.disconnect();
      if (state.timeline) state.timeline.dispose();
      frags.dispose();
      controls.dispose();
      renderer.dispose();
    },
  };

  const frame = (now) => {
    if (state.disposed) return;
    requestAnimationFrame(frame);
    const t0 = clock();
    const dt = state.last ? Math.min(0.05, (now - state.last) / 1000) : 0;
    state.last = now;
    if (state.setMode) {
      // fragments compile and place within the budget, also while off screen
      if (frags.queue.length) {
        const c = frags.applyQueued(state.changeBudget);
        state.since.changeMs += c.changeMs;
        state.since.compileMs += c.compileMs;
      }
      if (frags.takeChanged()) {
        renderer.updateScene(frags.set);
        configureScroll(false);
        state.placedSinceDraw = true;
        state.dirty = true;
      }
    }
    const scene = drawScene();
    if (!scene || !state.onScreen) return;
    if (!state.width || !state.height) return;
    const res = state.result;
    const reduced = prefersReducedMotion();
    if (clockAdvances(state, scene, reduced)) state.time += dt;
    if (state.timeline && state.timeline.update(dt)) state.progress = state.timeline.value;
    if (opts.onFrame) opts.onFrame(dt, api);
    if (orbitAdvances(state, reduced)) {
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
    if (res && res.graph && res.scene.dynamic.length && (state.time !== state.sceneTime || state.progress !== state.sceneProgress)) {
      updateDynamic(res.scene, res.graph, state.time, state.progress);
      state.sceneTime = state.time;
      state.sceneProgress = state.progress;
      if (followsDocument()) camera.fromSpec(res.scene.cameras[0]);
      if (state.setMode) frags.set.invalidateBounds();
      state.dirty = true;
    }
    if (state.setMode && frags.updateDynamic(state.time, state.progress)) state.dirty = true;
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
    if (!state.dirty || (state.holdUntil && now < state.holdUntil)) {
      settleWaiters();
      return;
    }
    state.dirty = false;
    const generated = state.cache.stats.generateMs;
    const r0 = clock();
    renderer.render(camera, { ...view(), time: state.time });
    const renderMs = clock() - r0;
    // levels drawn coarser than wanted: refine them on the next frame
    if (renderer.stats.refining) state.dirty = true;
    persistChanged();
    const tessellateMs = state.cache.stats.generateMs - generated;
    const rs = renderer.stats;
    const s = state.stats;
    s.changeMs = state.since.changeMs;
    s.compileMs = state.since.compileMs;
    s.tessellateMs = tessellateMs;
    s.renderMs = renderMs - tessellateMs;
    s.instances = rs.instances;
    s.drawCalls = rs.drawCalls;
    s.uploadBytes = rs.uploadBytes;
    s.refining = rs.refining;
    s.queued = frags.queue.length;
    state.since.changeMs = 0;
    state.since.compileMs = 0;
    state.placedSinceDraw = false;
    state.framesDrawn++;
    s.frameMs = clock() - t0;
    settleWaiters();
  };
  requestAnimationFrame(frame);
  return api;
}
