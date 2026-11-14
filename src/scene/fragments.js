// Fragments: complete ES3D documents shown inside a stage's document.
//
//   const tile = stage.add(source, { id: '16/32748/21789' });
//   await tile.ready;            // compiled and placed
//   tile.visible = false;        // kept, not drawn
//   tile.replace(newSource);     // only this fragment is rebuilt
//   tile.remove();
//
// Every fragment is a conforming version-1 document, so any reader can open
// it on its own; the stage only draws several of them together. Each keeps
// its own compile result: its own ids (fragment.setTransforms, <use>), its
// own scene graph and animation. Drawing goes through a SceneSet
// (scene-set.js): materials with identical parameters are one material for
// the whole stage, and one GeometryCache serves the host and every fragment,
// each building under its own owner (geometry-cache.js), so a shape repeated
// across tiles is generated and uploaded once.
//
// Changes are queued: applyQueued(budget) compiles and places them in the
// stage's frame loop until the budget (ms) is spent, and the rest waits for
// the next frame. A change already started finishes over budget. Removing and
// hiding are applied at once: they cost what the fragment's own geometry and
// material lists do, and a page expects a removed tile gone in the next frame.
//
// This module has no DOM: the stage (render/stage.js) connects it to the
// renderer and the frame loop, and the tests drive it directly.

import { compile, now as clockNow } from '../pipeline.js';
import { parse, formatDiagnostics } from '../format/parse.js';
import { GeometryCache, DOCUMENT } from '../geometry/geometry-cache.js';
import { applyLocalMatrices, updateDynamic } from './flatten.js';
import { ancestorNames } from './picking.js';
import { SceneSet, ScenePart } from './scene-set.js';
import { Prepared, hostOnlyWarnings, sceneFromPayload } from './prepared.js';

const isThenable = (v) => !!v && typeof v.then === 'function';

/** One document shown inside the stage's document. */
export class Fragment {
  constructor(owner, id) {
    this.stage = owner;
    this.id = id;
    this.part = new ScenePart(id, 'fragment');
    this.result = null; // the placed compile result (a prepared one compiles its graph on demand)
    this.owner = null; // its cache owner
    this.source = null;
    this.warnings = [];
    this.tasks = []; // queued changes, oldest first
    this.removed = false;
    this.time = NaN; // clock its animated rows were last evaluated at
    this.progress = NaN;
    /** @type {Promise<{ok: boolean, diagnostics: object[], fragment: string}>} */
    this.ready = null;
  }

  /** Compiled and drawn (or hidden) in the stage. */
  get placed() {
    return !!this.part.scene;
  }

  get visible() {
    return this.part.visible;
  }

  /** Hide or show it. Nothing is recompiled; a hidden fragment draws no rows at all. */
  set visible(v) {
    if (this.removed) return;
    this.stage.set.setVisible(this.part, v);
    this.stage.changed = true;
  }

  /** Diagnostics of the content on screen (compile's and the stage's warnings). */
  get diagnostics() {
    return this.result ? [...this.result.diagnostics, ...this.warnings] : [];
  }

  /**
   * Show other content in this fragment's place, in its turn. Bad input keeps
   * the content on screen. Resolves when the new content is placed or failed.
   * @param {string|ArrayBuffer|Uint8Array|Prepared|Promise<Prepared>} source
   * @param {{immediate?: boolean}} [opts]
   */
  replace(source, opts = {}) {
    if (this.removed) return Promise.resolve({ ok: false, diagnostics: [], fragment: this.id, removed: true });
    this.ready = this.stage.enqueue(this, source, !!opts.immediate);
    return this.ready;
  }

  /**
   * Replace the local matrix of elements of this fragment, by their ids in
   * this fragment's document. Same entries, rules and return values as
   * stage.setTransforms: false for an id that is missing or drawn in more
   * than one place.
   * @param {Array<[string, ArrayLike<number>]|{id: string, matrix: ArrayLike<number>}>} entries
   */
  setTransforms(entries) {
    const list = Array.from(entries || []);
    if (this.removed || !this.result) return list.map(() => false);
    const res = this.stage.materialize(this);
    const byId = res.graph.byId;
    const nodes = list.map((entry) => byId.get(Array.isArray(entry) ? entry[0] : entry && entry.id));
    const matrices = list.map((entry) => (Array.isArray(entry) ? entry[1] : entry && entry.matrix));
    const { time, progress } = this.stage.clock();
    const applied = applyLocalMatrices(res.scene, res.graph, nodes, matrices, time, progress);
    if (applied.some(Boolean)) {
      this.stage.set.invalidateBounds();
      this.stage.changed = true;
    }
    return applied;
  }

  /** setTransforms for one id; true when it was applied. */
  setTransform(id, matrix) {
    return this.setTransforms([[id, matrix]])[0] === true;
  }

  /** Take it out of the stage. Its rows and the geometry only it used are freed. */
  remove() {
    this.stage.removeFragment(this);
  }
}

/**
 * The fragments of one stage and the scene set that draws them with the host.
 */
export class FragmentStage {
  /**
   * @param {object} [o]
   * @param {GeometryCache} [o.cache] shared with the host document
   * @param {() => {time: number, progress: number}} [o.clock]
   * @param {(message: string, result: object) => void} [o.report] errors and stage warnings
   * @param {{compile: Function}|null} [o.compiler] a CompilerClient (compile-worker.js); null compiles here
   * @param {(owner: *) => void} [o.forget] an owner's geometry is gone (stop storing it)
   * @param {(cache: GeometryCache, owner: *) => Promise|null} [o.restore] read an owner's stored
   *   meshes before it is placed (the stage's geometry store); null: place at once
   * @param {() => number} [o.now]
   */
  constructor(o = {}) {
    this.cache = o.cache || new GeometryCache();
    this.clock = o.clock || (() => ({ time: 0, progress: 0 }));
    this.report = o.report || null;
    this.compiler = o.compiler || null;
    this.forget = o.forget || null;
    this.restore = o.restore || null;
    this.now = o.now || clockNow;
    this.set = new SceneSet();
    this.host = this.set.insert(new ScenePart(null, 'host'));
    this.hostResult = null;
    this.hostOwner = DOCUMENT;
    this.byId = new Map();
    this.queue = [];
    this.waiting = 0; // changes waiting for a worker's result
    this.nextId = 1;
    this.changed = false; // something to draw since the stage last looked (takeChanged)
  }

  /** Fragments in the order added. */
  get list() {
    return [...this.byId.values()];
  }

  /** Changes not yet placed: queued ones and those waiting for a worker. */
  get queued() {
    return this.queue.length;
  }

  get pending() {
    return this.queue.length > 0;
  }

  /** True once if anything changed since the last call. */
  takeChanged() {
    const c = this.changed;
    this.changed = false;
    return c;
  }

  newOwner(kind) {
    return { owner: kind };
  }

  // --- the host ---------------------------------------------------------------

  /**
   * Draw a compiled document as the host. `owner` holds its geometry; the
   * previous host's owner is released.
   */
  setHost(result, owner) {
    this.set.place(this.host, result.scene);
    this.adoptHost(result, owner);
  }

  /** Record the host without drawing it (a stage that has no fragment yet). */
  adoptHost(result, owner) {
    if (this.hostOwner !== owner) this.release(this.hostOwner);
    this.hostResult = result;
    this.hostOwner = owner;
    this.changed = true;
  }

  release(owner) {
    if (owner == null) return;
    this.cache.release(owner);
    if (this.forget && owner !== DOCUMENT) this.forget(owner);
  }

  /**
   * The compile result a prepared document stands for, with its geometry in
   * this stage's cache. A prepared document is placed once.
   * @param {Prepared} prepared
   * @returns {{result: object, owner: *}}
   */
  fromPrepared(prepared, kind = 'fragment') {
    if (prepared.used) throw new Error('A prepared document can be shown or added once; prepare it again.');
    prepared.used = true;
    prepared.claimed = true;
    if (!prepared.ok) {
      return { result: { ok: false, doc: null, graph: null, scene: null, cache: this.cache, diagnostics: prepared.documentDiagnostics, timings: prepared.timings, lineIndex: prepared.lineIndex }, owner: null };
    }
    if (prepared.result) return { result: prepared.result, owner: prepared.owner };
    const owner = this.newOwner(kind);
    if (prepared.payload.main) {
      // the worker could not carry it (animation, textures): compile it here
      const { time, progress } = this.clock();
      return { result: compile(prepared.source, { cache: this.cache, owner, time, progress }), owner };
    }
    const source = prepared.source;
    const cache = this.cache;
    let local = null;
    // a level the worker did not send (its key was sent for another document
    // and evicted here since) is generated from this document, compiled here once
    const real = (key) => {
      if (!local) {
        local = new GeometryCache();
        local.quality = cache.quality;
        compile(source, { cache: local });
      }
      const e = local.entries.get(key);
      if (!e) throw new Error(`The document has no geometry ${key}.`);
      return e.desc;
    };
    const scene = sceneFromPayload(prepared.payload, cache, owner, real);
    prepared.payload = null; // its buffers are the scene's rows now
    let doc = null;
    const result = {
      ok: true,
      scene,
      cache,
      graph: null, // compiled on demand (FragmentStage.materialize)
      diagnostics: prepared.documentDiagnostics,
      timings: prepared.timings,
      prepared: true,
      source,
      // parsed on first use, for the names of a picked element
      get doc() {
        if (!doc) doc = parse(source);
        return doc;
      },
    };
    return { result, owner };
  }

  // --- fragments --------------------------------------------------------------

  /**
   * Add a fragment. Its content is compiled and placed in its turn (or at
   * once with immediate: true); until then it draws nothing.
   * @param {string|ArrayBuffer|Uint8Array|Prepared|Promise<Prepared>} source
   * @param {{id?: string, immediate?: boolean}} [opts]
   */
  add(source, opts = {}) {
    let id = opts.id != null ? String(opts.id) : null;
    if (id === null) {
      while (this.byId.has(`fragment-${this.nextId}`)) this.nextId++;
      id = `fragment-${this.nextId++}`;
    }
    if (this.byId.has(id)) throw new Error(`The stage has a fragment "${id}" already. Replace it, or remove it first.`);
    const frag = new Fragment(this, id);
    this.byId.set(id, frag);
    this.set.insert(frag.part);
    frag.ready = this.enqueue(frag, source, !!opts.immediate);
    return frag;
  }

  /** Queue new content for a fragment. A change not yet started gives way to it. */
  enqueue(frag, input, immediate) {
    this.claim(input);
    let settle;
    const promise = new Promise((r) => (settle = r));
    const task = { frag, input, ready: !isThenable(input), cancelled: false, finished: false, immediate, placing: null, resolve: null };
    task.resolve = (v) => {
      task.finished = true;
      settle(v);
    };
    // older changes of this fragment that have not started resolve with this one
    for (const old of frag.tasks) {
      this.cancel(old);
      promise.then(old.resolve);
    }
    frag.tasks = [task];
    if (isThenable(input)) {
      this.waiting++;
      input.then(
        (v) => {
          task.input = v;
        },
        (err) => {
          task.input = null;
          task.error = err;
        },
      ).then(() => {
        this.waiting--;
        task.ready = true;
        if (task.cancelled) this.discard(task.input);
      });
    }
    if (immediate && task.ready) this.run(task);
    else this.queue.push(task);
    return promise;
  }

  // a prepared document becomes one fragment's rows: using it twice would share them
  claim(input) {
    if (!(input instanceof Prepared)) return;
    if (input.claimed) throw new Error('A prepared document can be shown or added once; prepare it again.');
    input.claimed = true;
  }

  cancel(task) {
    task.cancelled = true;
    task.finished = true;
    if (task.placing) this.release(task.placing.owner);
    const k = this.queue.indexOf(task);
    if (k >= 0) this.queue.splice(k, 1);
    if (task.ready) this.discard(task.input);
  }

  // a prepared document compiled here holds geometry until it is used
  discard(input) {
    if (input instanceof Prepared && !input.used && input.owner) {
      input.used = true;
      this.release(input.owner);
    }
  }

  /**
   * Apply queued changes until `budget` ms are spent (at least one per call).
   * @returns {{applied: number, changeMs: number, compileMs: number}}
   */
  applyQueued(budget = Infinity) {
    const t0 = this.now();
    let applied = 0;
    let compileMs = 0;
    while (this.queue.length) {
      if (applied && this.now() - t0 >= budget) break;
      const k = this.queue.findIndex((t) => t.ready);
      if (k < 0) break;
      const task = this.queue.splice(k, 1)[0];
      compileMs += this.run(task);
      applied++;
    }
    return { applied, changeMs: applied ? this.now() - t0 : 0, compileMs };
  }

  /** Compile and place one change. Returns the time spent compiling (ms). */
  run(task) {
    const frag = task.frag;
    frag.tasks = frag.tasks.filter((t) => t !== task);
    if (task.cancelled || frag.removed) return 0;
    if (task.placing) {
      // compiled earlier; its stored meshes have been read
      const p = task.placing;
      task.placing = null;
      this.place(frag, p.result, p.owner, p.warnings, p.input);
      task.resolve({ ok: true, diagnostics: frag.diagnostics, fragment: frag.id });
      return 0;
    }
    const t0 = this.now();
    let result, owner, warnings, lineIndex;
    const input = task.input;
    try {
      if (input instanceof Prepared) {
        ({ result, owner } = this.fromPrepared(input, 'fragment'));
        warnings = result.ok ? input.hostOnly : [];
        lineIndex = input.lineIndex;
      } else if (input == null) {
        result = { ok: false, diagnostics: [], error: task.error };
      } else {
        owner = this.newOwner('fragment');
        const { time, progress } = this.clock();
        result = compile(input, { cache: this.cache, owner, time, progress });
        warnings = result.ok ? hostOnlyWarnings(result) : [];
      }
    } catch (err) {
      result = { ok: false, diagnostics: [], error: err };
    }
    const ms = this.now() - t0;
    if (!result.ok) {
      if (owner) this.release(owner);
      const msg = result.error ? String(result.error && result.error.message ? result.error.message : result.error) : formatDiagnostics({ diagnostics: result.diagnostics, lineIndex: lineIndex || (result.doc && result.doc.lineIndex) });
      if (this.report) this.report(msg, { ...result, fragment: frag.id });
      task.resolve({ ok: false, diagnostics: result.diagnostics, fragment: frag.id });
      return ms;
    }
    // meshes made here may be stored from an earlier visit: read them before
    // the first frame draws this fragment (a prepared one brought its meshes)
    const wait = this.restore && !task.immediate && !result.prepared ? this.restore(this.cache, owner) : null;
    if (wait) {
      task.placing = { result, owner, warnings, input };
      task.ready = false;
      frag.tasks.push(task);
      this.queue.push(task);
      this.waiting++;
      Promise.resolve(wait).catch(() => {}).then(() => {
        this.waiting--;
        task.ready = true;
      });
      return ms;
    }
    this.place(frag, result, owner, warnings, input);
    task.resolve({ ok: true, diagnostics: frag.diagnostics, fragment: frag.id });
    return ms;
  }

  place(frag, result, owner, warnings, source, quiet = false) {
    const before = frag.owner;
    this.set.place(frag.part, result.scene);
    frag.result = result;
    frag.owner = owner;
    frag.source = source instanceof Prepared ? source.source : source;
    frag.warnings = warnings || [];
    const { time, progress } = this.clock();
    frag.time = time;
    frag.progress = progress;
    if (before && before !== owner) this.release(before);
    this.changed = true;
    if (!quiet && frag.warnings.length && this.report) {
      this.report(formatDiagnostics({ diagnostics: frag.warnings, lineIndex: result.doc && !result.prepared ? result.doc.lineIndex : null }), { ok: true, diagnostics: frag.warnings, fragment: frag.id });
    }
  }

  /**
   * A fragment's full compile result, with its scene graph. A prepared
   * fragment has none yet: its document is compiled here now and drawn in
   * its place (the same rows), once.
   */
  materialize(frag) {
    const res = frag.result;
    if (res.graph) return res;
    const owner = this.newOwner('fragment');
    const { time, progress } = this.clock();
    const full = compile(frag.source, { cache: this.cache, owner, time, progress });
    this.place(frag, full, owner, frag.warnings, frag.source, true);
    return full;
  }

  removeFragment(frag) {
    if (frag.removed) return;
    frag.removed = true;
    for (const t of frag.tasks) {
      this.cancel(t);
      t.resolve({ ok: false, diagnostics: [], fragment: frag.id, removed: true });
    }
    frag.tasks = [];
    this.set.remove(frag.part);
    this.release(frag.owner);
    frag.owner = null;
    this.byId.delete(frag.id);
    this.changed = true;
  }

  /** Remove every fragment. */
  clear() {
    for (const f of this.list) this.removeFragment(f);
  }

  /**
   * Compile a document for add() or show(), in the worker where there is one.
   * @param {string|ArrayBuffer|Uint8Array} source
   * @param {{as?: 'fragment'|'document'}} [opts]
   * @returns {Promise<Prepared>}
   */
  prepare(source, opts = {}) {
    const as = opts.as === 'document' ? 'document' : 'fragment';
    const { time, progress } = this.clock();
    const here = () => {
      const owner = this.newOwner(as);
      const result = compile(source, { cache: this.cache, owner, time, progress });
      if (!result.ok) this.release(owner);
      return new Prepared({ as, source, result, owner: result.ok ? owner : null, hostOnly: result.ok ? hostOnlyWarnings(result) : [] });
    };
    if (!this.compiler) return Promise.resolve(here());
    return this.compiler.compile(source, { time, progress, quality: this.cache.quality }).then((payload) => (payload ? new Prepared({ as, source, payload }) : here()));
  }

  // --- per frame ----------------------------------------------------------------

  /**
   * Evaluate the animated rows of the drawn fragments at this clock (the
   * stage animates the host as it always has). True when any row moved.
   */
  updateDynamic(time, progress) {
    let any = false;
    for (const f of this.byId.values()) {
      const r = f.result;
      if (!r || !f.part.drawn || !r.scene.dynamic.length || !r.graph) continue;
      if (f.time === time && f.progress === progress) continue;
      updateDynamic(r.scene, r.graph, time, progress);
      f.time = time;
      f.progress = progress;
      any = true;
    }
    if (any) this.set.invalidateBounds();
    return any;
  }

  /** Names (name or id) of a picked element and its ancestors, from its own document. */
  names(part, uid) {
    if (!part || part === this.host) return ancestorNames(this.hostResult && this.hostResult.doc, uid);
    const f = this.byId.get(part.id);
    return f && f.result ? ancestorNames(f.result.doc, uid) : [];
  }

  dispose() {
    this.clear();
    if (this.compiler && this.compiler.dispose) this.compiler.dispose();
  }
}
