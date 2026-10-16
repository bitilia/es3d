// ES3D Studio: the browser application tying together the editor, the
// pipeline, the renderer and the panels.

import { h, $, clear, debounce, formatBytes } from './dom.js';
import { Editor } from './editor.js';
import { SceneTree } from './scene-tree.js';
import { Inspector } from './inspector.js';
import { StatsPanel } from './stats-panel.js';
import { setAttributeEdit, removeAttributeEdit, deleteElementEdit, appendChildEdit, SNIPPETS } from './text-edits.js';
import { compile, elementDiagnostic, GeometryCache } from '../pipeline.js';
import { parse, detectSyntax } from '../format/parse.js';
import { serialize } from '../format/serializer.js';
import { updateDynamic } from '../scene/flatten.js';
import { pick } from '../scene/picking.js';
import { createRenderer, PROGRESSIVE_BUDGET_MS } from '../render/renderer.js';
import { Camera } from '../render/camera.js';
import { OrbitControls } from '../render/orbit-controls.js';
import { loadFile } from '../io/file-loader.js';
import { readHandoff } from '../../docs/site/handoff.js';
import { download } from '../io/download.js';
import { gzip } from '../io/compression.js';
import { exportOBJ } from '../io/obj.js';
import { exportGLB } from '../io/gltf.js';
import { exportSTEP } from '../io/step.js';
import { optimize } from '../optimize/optimizer.js';
import { openGeometryStore, persistGeometry } from '../cache/geometry-store.js';

const now = () => performance.now();

export class App {
  constructor() {
    this.params = new URLSearchParams(location.search);
    this.cache = new GeometryCache();
    // meshes kept between visits (IndexedDB); ?nocache keeps nothing. Edits
    // make new records, so wait a little longer before saving than a page does
    this.persist = persistGeometry(this.params.has('nocache') ? null : openGeometryStore(), { delay: 4000 });
    this.holdUntil = 0; // an opened document waits this long at most for its stored meshes
    this.camera = new Camera();
    this.compiled = null;
    this.current = null;
    this.geometryDiagnostics = [];
    this.selectedUid = 0;
    this.selectedPath = null;
    this.playing = !this.params.has('paused');
    this.time = Number(this.params.get('t') || 0);
    this.progress = Math.min(1, Math.max(0, Number(this.params.get('progress') || 0))); // scroll timeline
    this.fileName = 'untitled.es3d';
    this.loadedBytes = 0;
    this.dirty = true;
    this.frames = 0;
    this.fpsTime = now();
    this.fps = 0;
    this.lastFrame = now();
    this.statsTime = 0;
    this.sceneCameras = [];
    this.tessMs = 0;
  }

  // ---------------------------------------------------------------------------
  // setup

  async init() {
    document.body.classList.toggle('minimal', this.params.get('ui') === 'minimal');
    this.editor = new Editor($('#editor'), {
      onChange: () => this.scheduleCompile(),
      onCursor: (off) => this.selectAtOffset(off),
    });
    this.tree = new SceneTree($('#tree'), { onSelect: (uid) => this.select(uid, { reveal: true }) });
    this.inspector = new Inspector($('#inspector'), {
      onEdit: (el, name, raw) => this.applyEdit(setAttributeEdit(this.current.doc, el, name, raw)),
      onRemove: (el, name) => this.applyEdit(removeAttributeEdit(this.current.doc, el, name)),
      onDelete: (el) => {
        this.selectedUid = 0;
        this.selectedPath = null;
        this.applyEdit(deleteElementEdit(this.current.doc, el));
      },
      onAddChild: (el, kind) => this.applyEdit(appendChildEdit(this.current.doc, el, SNIPPETS[kind])),
      onReveal: (el) => this.editor.reveal(el.start, Math.max(0, el.openEnd - el.start)),
      onSelect: (uid) => this.select(uid, { reveal: true }),
    });
    this.inspector.show(null, null);
    this.stats = new StatsPanel($('#stats'));
    this.scheduleCompile = debounce(() => this.compileNow(false), 220);

    await this.initRenderer();
    this.bindUI();
    await this.loadManifest();
    const example = this.params.get('example');
    const file = this.params.get('file');
    // a document handed over by the converter page
    const handoff = this.params.has('handoff') ? readHandoff() : null;
    if (this.params.has('handoff') && !handoff) this.toast('The converted document could not be handed over (browser storage is unavailable). Download it on the converter page and open it here.', 'error', 0);
    if (handoff) await this.openFile(new File([handoff.text], handoff.name || 'converted.es3d'));
    else if (file) await this.loadUrl(file);
    else await this.loadExample(example || (this.examples[0] && this.examples[0].id));
    requestAnimationFrame((t) => this.frame(t));
  }

  async initRenderer() {
    const backend = this.params.get('renderer') || this.params.get('backend') || 'auto';
    const present = this.params.get('present') || 'canvas';
    let canvas = $('#viewport');
    try {
      this.renderer = await createRenderer(canvas, { backend, present });
      this.renderer.options.tessellationBudget = PROGRESSIVE_BUDGET_MS;
    } catch (e) {
      this.renderer = null;
      this.toast(`Renderer unavailable: ${e.message}`, 'error', 0);
      $('#backend-label').textContent = 'no GPU renderer';
      return;
    }
    if (this.renderer.canvas) canvas = this.renderer.canvas;
    this.canvas = canvas;
    this.seenDpr = Math.min(window.devicePixelRatio || 1, 2);
    this.gpuEpoch = this.renderer.backend.resourceEpoch || 0;
    const label = this.renderer.kind === 'webgpu' ? 'WebGPU' : 'WebGL2';
    $('#backend-label').textContent = label;
    $('#backend-label').title = `${label}: ${this.renderer.info}${this.renderer.fallbackReason ? `\nWebGPU unavailable: ${this.renderer.fallbackReason}` : ''}`;
    this.controls = new OrbitControls(canvas, this.camera);
    this.controls.onChange = () => {
      this.dirty = true;
      $('#camera-select').value = 'free';
    };
    this.controls.onClick = (x, y) => this.pickAt(x, y);
    this.controls.onDoubleClick = (x, y) => {
      const hit = this.rayPick(x, y);
      if (hit) this.controls.focus(hit.point);
    };
    this.renderer.textures.onReady = () => (this.dirty = true);
    this.renderer.textures.onError = (entry, err) => {
      this.geometryDiagnostics.push({ severity: 'warning', code: 'W_TEXTURE', message: `Texture '${entry.spec.key}' could not be loaded: ${err.message}`, element: null, phase: 'render' });
      this.refreshDiagnostics();
    };
    this.cache.onDiagnostic = (d) => {
      this.geometryDiagnostics.push(d);
      this.refreshDiagnosticsSoon();
    };
    this.refreshDiagnosticsSoon = debounce(() => this.refreshDiagnostics(), 100);
    const ro = new ResizeObserver(() => (this.dirty = true));
    ro.observe(canvas.parentElement);
  }

  bindUI() {
    $('#btn-open').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (f) await this.openFile(f);
      e.target.value = '';
    });
    $('#examples').addEventListener('change', (e) => e.target.value && this.loadExample(e.target.value));
    $('#btn-format').addEventListener('click', () => this.reformat());
    $('#btn-convert').addEventListener('click', () => this.convertSyntax());
    $('#btn-optimize').addEventListener('click', () => this.runOptimize());
    $('#btn-export').addEventListener('click', (e) => {
      e.stopPropagation();
      $('#export-menu').classList.toggle('open');
    });
    document.addEventListener('click', () => $('#export-menu').classList.remove('open'));
    for (const item of document.querySelectorAll('#export-menu [data-export]')) {
      item.addEventListener('click', () => this.exportAs(item.dataset.export));
    }
    const toggles = { wireframe: 'wireframe', normals: 'normals', bbox: 'bbox' };
    for (const [id, opt] of Object.entries(toggles)) {
      const el = $(`#tg-${id}`);
      el.addEventListener('change', () => {
        if (this.renderer) this.renderer.options[opt] = el.checked;
        this.dirty = true;
      });
    }
    $('#tg-lod').addEventListener('change', (e) => {
      if (this.renderer) this.renderer.options.autoLod = e.target.checked;
      this.dirty = true;
    });
    $('#tg-play').addEventListener('change', (e) => {
      this.playing = e.target.checked;
      this.dirty = true;
    });
    $('#tg-play').checked = this.playing;
    $('#scroll-progress').value = String(this.progress);
    $('#scroll-progress').addEventListener('input', (e) => {
      this.progress = Number(e.target.value);
      this.updateAnimation();
    });
    $('#tg-limits').addEventListener('change', () => this.configureControls());
    $('#quality').addEventListener('change', (e) => {
      this.cache.setQuality(Number(e.target.value));
      // every mesh is regenerated at the new quality, so none of the packed ones is reused
      if (this.compiled && this.renderer) this.renderer.setScene(this.compiled.scene, (en, lod) => this.cache.mesh(en, lod), { keepGeometry: false });
      this.dirty = true;
    });
    $('#camera-select').addEventListener('change', (e) => this.useCamera(e.target.value));
    $('#btn-frame').addEventListener('click', () => this.frameAll());
    $('#btn-compare').addEventListener('click', () => this.compareFormats());
    $('#diag-head').addEventListener('click', () => $('#diagnostics').classList.toggle('collapsed'));

    // keyboard shortcuts outside text inputs
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        this.exportAs('source');
        return;
      }
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
      const flip = (id) => {
        const el = $(id);
        el.checked = !el.checked;
        el.dispatchEvent(new Event('change'));
      };
      if (e.key === 'w') flip('#tg-wireframe');
      else if (e.key === 'n') flip('#tg-normals');
      else if (e.key === 'b') flip('#tg-bbox');
      else if (e.key === 'l') flip('#tg-lod');
      else if (e.key === 'f') this.frameAll();
      else if (e.key === ' ') {
        e.preventDefault();
        flip('#tg-play');
      } else if (e.key === 'Escape') this.select(0);
    });

    // drag and drop anywhere
    const overlay = $('#drop-overlay');
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      overlay.classList.add('show');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.classList.remove('show');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      const f = e.dataTransfer.files[0];
      if (f) await this.openFile(f);
    });

    // resizable columns
    for (const sp of document.querySelectorAll('.splitter')) {
      sp.addEventListener('pointerdown', (e) => {
        sp.setPointerCapture(e.pointerId);
        const layout = $('#layout');
        const rect = layout.getBoundingClientRect();
        const move = (ev) => {
          if (sp.dataset.side === 'left') {
            const w = Math.max(240, Math.min(rect.width * 0.7, ev.clientX - rect.left));
            layout.style.setProperty('--left', `${w}px`);
          } else {
            const w = Math.max(220, Math.min(rect.width * 0.5, rect.right - ev.clientX));
            layout.style.setProperty('--right', `${w}px`);
          }
          this.dirty = true;
        };
        const up = () => {
          sp.removeEventListener('pointermove', move);
          sp.removeEventListener('pointerup', up);
        };
        sp.addEventListener('pointermove', move);
        sp.addEventListener('pointerup', up);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // documents

  async loadManifest() {
    try {
      const res = await fetch('../examples/manifest.json');
      this.examples = (await res.json()).examples;
    } catch {
      this.examples = [];
    }
    const sel = $('#examples');
    clear(sel).append(h('option', { value: '' }, 'Examples…'), ...this.examples.map((e) => h('option', { value: e.id, title: e.description }, e.title)));
  }

  async loadExample(id) {
    const ex = this.examples.find((e) => e.id === id);
    if (!ex) return;
    $('#examples').value = id;
    await this.loadUrl(`../examples/${ex.file}`, ex.file);
  }

  async loadUrl(url, name = url.split('/').pop()) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const file = new File([await res.arrayBuffer()], name);
      await this.openFile(file);
    } catch (e) {
      this.toast(`Could not load ${url}: ${e.message}`, 'error');
    }
  }

  async openFile(file) {
    let r;
    try {
      r = await loadFile(file);
    } catch (e) {
      this.toast(`Could not open ${file.name}: ${e.message}`, 'error');
      return;
    }
    const text = r.text;
    this.fileName = r.name.replace(/\.(obj|glb|gltf|stl|svg|json|step|stp|p21)$/i, '.es3d');
    this.loadedBytes = r.originalSize;
    $('#file-name').textContent = r.name;
    if (r.note) this.toast(`${r.name}: ${r.note}`);
    this.selectedUid = 0;
    this.selectedPath = null;
    this.editor.setValue(text, detectSyntax(text));
    this.compileNow(true);
  }

  compileNow(isNew) {
    this.scheduleCompile.cancel();
    const text = this.editor.value;
    this.geometryDiagnostics = [];
    const res = compile(text, { cache: this.cache, time: this.time, progress: this.progress });
    this.current = res;
    if (res.doc) this.editor.setSyntax(res.doc.syntax === 'compact' ? 'compact' : 'xml');
    $('#syntax-label').textContent = res.doc ? { xml: 'markup', compact: 'compact', json: 'JSON', binary: 'binary' }[res.doc.syntax] : '';
    $('#btn-convert').textContent = res.doc && res.doc.syntax === 'compact' ? 'To markup' : 'To compact';
    if (res.ok && res.scene) {
      this.compiled = res;
      if (this.renderer) this.renderer.setScene(res.scene, (e, lod) => this.cache.mesh(e, lod));
      this.sceneCameras = res.scene.cameras.slice();
      this.populateCameras();
      if (isNew) {
        if (this.sceneCameras.length) this.useCamera('0');
        else this.frameAll();
        this.holdUntil = now() + 50;
        this.persist.restore(this.cache).finally(() => {
          this.holdUntil = 0;
          this.dirty = true;
        });
      }
      $('#scroll-wrap').hidden = !res.scene.animation.scroll;
      this.configureControls();
      this.tessMs = 0;
      $('#stale').classList.remove('show');
      this.dirty = true;
    } else if (this.compiled) {
      $('#stale').classList.add('show');
    }
    if (res.doc && res.doc.root) {
      this.tree.setDocument(res.doc);
      this.restoreSelection();
    } else {
      this.tree.setDocument(null);
    }
    this.refreshDiagnostics();
    this.updateSourceStats(text);
  }

  allDiagnostics() {
    const res = this.current;
    if (!res) return [];
    const geo = this.geometryDiagnostics.map((d) => elementDiagnostic(res.doc, d));
    return [...res.diagnostics, ...geo];
  }

  refreshDiagnostics() {
    const list = this.allDiagnostics();
    this.editor.setDiagnostics(list.map((d) => ({ offset: d.offset, length: d.length, severity: d.severity, line: d.line })));
    const panel = $('#diag-list');
    clear(panel);
    const errors = list.filter((d) => d.severity === 'error').length;
    const warnings = list.length - errors;
    $('#diag-count').textContent = list.length ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}` : 'No problems';
    $('#diag-count').className = errors ? 'has-errors' : warnings ? 'has-warnings' : 'ok';
    for (const d of list) {
      const loc = d.line > 0 ? `${d.line}:${d.column}` : d.path || '';
      const item = h(
        'div',
        { class: `diag diag-${d.severity}`, title: d.format(this.current && this.current.doc ? this.current.doc.lineIndex : null) },
        h('span', { class: 'diag-icon' }, d.severity === 'error' ? '✖' : '⚠'),
        h('span', { class: 'diag-title' }, d.title),
        h('span', { class: 'diag-loc' }, loc),
        h('div', { class: 'diag-msg' }, d.message, d.suggestion ? h('span', { class: 'diag-sug' }, ` Did you mean: ${d.suggestion}?`) : null),
        d.hint ? h('div', { class: 'diag-hint' }, d.hint) : null,
      );
      if (d.offset >= 0) item.addEventListener('click', () => this.editor.reveal(d.offset, d.length));
      panel.append(item);
    }
    if (errors) $('#diagnostics').classList.remove('collapsed');
  }

  async updateSourceStats(text) {
    const res = this.current;
    const bytes = new TextEncoder().encode(text).length;
    const syntaxNames = { xml: 'markup', compact: 'compact', json: 'JSON', binary: 'binary' };
    const base = {
      syntax: res && res.doc ? syntaxNames[res.doc.syntax] || res.doc.syntax : '–',
      sourceBytes: bytes,
      loadedBytes: this.loadedBytes,
      elements: res && res.doc ? res.doc.elementCount : 0,
      parseMs: res ? res.timings.parse : null,
      buildMs: res ? res.timings.build : null,
      flattenMs: res ? res.timings.flatten : null,
      gzipBytes: null,
    };
    const c = this.compiled;
    if (c && c.ok) {
      Object.assign(base, {
        shapes: c.graph.stats.shapes,
        instances: c.scene.count,
        geometries: c.scene.geometries.length,
        materials: c.scene.materials.length,
        lights: c.scene.lights.length,
        cameras: c.scene.cameras.length,
        animated: c.scene.dynamic.length,
      });
    }
    this.stats.compare = null;
    this.stats.update(base);
    const token = (this.statsToken = (this.statsToken || 0) + 1);
    const g = await gzip(text);
    if (token === this.statsToken) this.stats.update({ gzipBytes: g.length });
  }

  // ---------------------------------------------------------------------------
  // editing

  applyEdit(edit) {
    if (!edit) return;
    this.editor.replaceRange(edit.start, edit.end, edit.text);
    this.compileNow(false);
  }

  reformat() {
    const res = this.current;
    if (!res || !res.doc || !res.doc.root) return this.toast('Fix the syntax errors before formatting.', 'error');
    const text = serialize(res.doc, { syntax: res.doc.syntax === 'compact' ? 'compact' : 'xml', pretty: true });
    this.editor.replaceRange(0, this.editor.value.length, text);
    this.compileNow(false);
  }

  convertSyntax() {
    const res = this.current;
    if (!res || !res.doc || !res.doc.root) return this.toast('Fix the syntax errors before converting.', 'error');
    const target = res.doc.syntax === 'compact' ? 'xml' : 'compact';
    const before = this.editor.value.length;
    const text = serialize(res.doc, { syntax: target, pretty: true });
    this.editor.replaceRange(0, before, text);
    this.editor.setSyntax(target);
    this.fileName = this.fileName.replace(/(\.es3d)?$/, '.es3d');
    this.compileNow(false);
    this.toast(`Converted to ${target === 'compact' ? 'compact' : 'markup'} syntax: ${formatBytes(before)} → ${formatBytes(text.length)}`);
  }

  runOptimize() {
    const res = this.current;
    if (!res || !res.ok) return this.toast('The document must be valid before it can be optimised.', 'error');
    let out;
    try {
      out = optimize(res.doc);
    } catch (e) {
      return this.toast(`Optimiser failed: ${e.message}`, 'error');
    }
    const before = this.editor.value.length;
    if (!out.report.length) return this.toast('The optimiser found nothing to improve.');
    this.editor.replaceRange(0, before, out.text);
    this.compileNow(false);
    const pct = ((1 - out.text.length / before) * 100).toFixed(1);
    this.toast(h('div', {}, h('strong', {}, `Optimised: ${formatBytes(before)} → ${formatBytes(out.text.length)} (${pct}% smaller)`), h('ul', {}, ...out.report.map((r) => h('li', {}, r.detail)))), 'info', 9000);
  }

  // ---------------------------------------------------------------------------
  // selection

  pathOf(el) {
    const parts = [];
    for (let e = el; e && e.parent; e = e.parent) parts.unshift(e.parent.children.filter((c) => c.type === 'element').indexOf(e));
    return parts;
  }

  elementAtPath(path) {
    let el = this.current && this.current.doc && this.current.doc.root;
    for (const i of path || []) {
      if (!el) return null;
      el = el.children.filter((c) => c.type === 'element')[i];
    }
    return el || null;
  }

  restoreSelection() {
    if (!this.selectedPath) return;
    const el = this.elementAtPath(this.selectedPath);
    if (el && el.name === this.selectedName) this.select(el.uid, { keepEditor: true });
    else this.select(0);
  }

  selectAtOffset(off) {
    const doc = this.current && this.current.doc;
    if (!doc || !doc.root) return;
    let best = null;
    const visit = (el) => {
      if (off >= el.start && off <= el.end) {
        best = el;
        for (const c of el.children) if (c.type === 'element') visit(c);
      }
    };
    visit(doc.root);
    if (best && best.uid !== this.selectedUid) this.select(best.uid, { keepEditor: true });
  }

  /** uids of rendered instances that belong to an element. */
  selectionUids(el) {
    const set = new Set();
    const add = (e) => {
      set.add(e.uid);
      for (const c of e.children) if (c.type === 'element') add(c);
    };
    add(el);
    let inDefs = false;
    for (let p = el; p; p = p.parent) if (p.name === 'defs') inDefs = true;
    if (inDefs && this.current && this.current.doc) {
      const doc = this.current.doc;
      const anc = new Set();
      for (let p = el; p; p = p.parent) anc.add(p);
      for (const e of doc.byUid.values()) if (e.name === 'use' && e.target && anc.has(e.target)) set.add(e.uid);
    }
    return set;
  }

  select(uid, opts = {}) {
    this.selectedUid = uid;
    const doc = this.current && this.current.doc;
    const el = uid && doc ? doc.byUid.get(uid) : null;
    if (!el) {
      this.selectedPath = null;
      if (this.renderer) this.renderer.selection = new Set();
      this.tree.select(0);
      this.inspector.show(null, null);
      this.dirty = true;
      return;
    }
    this.selectedPath = this.pathOf(el);
    this.selectedName = el.name;
    const uids = this.selectionUids(el);
    if (this.renderer) this.renderer.selection = uids;
    this.tree.select(uid);
    const info = { diagnostics: this.allDiagnostics().filter((d) => d.offset >= el.start && d.offset <= el.end) };
    const c = this.compiled;
    if (c && c.scene && doc === c.doc) {
      let n = 0;
      for (let i = 0; i < c.scene.count; i++) if (uids.has(c.scene.uid[i])) n++;
      info.instances = n;
      const node = c.graph && this.findGeometry(el);
      if (node) info.geometry = node;
    }
    this.inspector.show(doc, el, info);
    if (opts.reveal && !opts.keepEditor) this.editor.reveal(el.start, Math.max(0, el.openEnd - el.start), false);
    this.dirty = true;
  }

  findGeometry(el) {
    const c = this.compiled;
    const entry = [...c.scene.geometries].find((g) => g.owner === el);
    if (!entry) return null;
    const mesh = this.cache.mesh(entry, 0);
    const gi = c.scene.geometries.indexOf(entry);
    let shared = 0;
    for (let i = 0; i < c.scene.count; i++) if (c.scene.geom[i] === gi) shared++;
    return { triangles: mesh.kind === 'triangles' ? mesh.primitiveCount : 0, lods: entry.lods, shared };
  }

  rayPick(x, y) {
    const c = this.compiled;
    if (!c || !this.canvas) return null;
    const ray = this.camera.ray(x, y, this.canvas.clientWidth, this.canvas.clientHeight, this.renderer.backend.zeroToOne);
    const lods = this.renderer.frames.lodStates(c.scene, this.camera.position, (p) => Math.hypot(p[0] - this.camera.position[0], p[1] - this.camera.position[1], p[2] - this.camera.position[2]));
    const visible = (i) => {
      const ln = c.scene.lodNode[i];
      return ln < 0 || (lods.visible[ln] && lods.active[ln] === c.scene.lodChild[i]);
    };
    return pick(c.scene, (e, lod) => this.cache.mesh(e, lod), ray.origin, ray.dir, visible);
  }

  pickAt(x, y) {
    const hit = this.rayPick(x, y);
    this.select(hit ? hit.uid : 0, { reveal: true });
  }

  // ---------------------------------------------------------------------------
  // camera

  populateCameras() {
    const sel = $('#camera-select');
    const prev = sel.value;
    clear(sel).append(h('option', { value: 'free' }, 'Free camera'), ...this.sceneCameras.map((c, i) => h('option', { value: String(i) }, c.name || `Camera ${i + 1}`)));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  /** The document's <controls> limits for the free camera (never its mode: Studio always orbits). */
  configureControls() {
    if (!this.controls) return;
    const c = this.compiled;
    const spec = c && c.scene && $('#tg-limits').checked ? c.scene.controls : null;
    const world = () => (this.compiled ? { scene: this.compiled.scene, meshOf: (e, lod) => this.cache.mesh(e, lod) } : null);
    this.controls.configure(spec, { world, ignoreMode: true });
  }

  /** Re-evaluate animations at the current time and scroll progress; scene cameras follow theirs. */
  updateAnimation() {
    const c = this.compiled;
    if (!c || !c.scene || !c.scene.dynamic.length) return;
    updateDynamic(c.scene, c.graph, this.time, this.progress);
    this.sceneCameras = c.scene.cameras.slice();
    const v = $('#camera-select').value;
    if (v !== 'free' && this.sceneCameras[Number(v)]) this.camera.fromSpec(this.sceneCameras[Number(v)]);
    this.dirty = true;
  }

  useCamera(v) {
    if (v === 'free' || !this.sceneCameras[Number(v)]) return;
    this.camera.fromSpec(this.sceneCameras[Number(v)]);
    $('#camera-select').value = v;
    this.dirty = true;
  }

  frameAll() {
    if (this.compiled && this.compiled.scene) {
      this.camera.type = 'perspective';
      this.camera.near = null;
      this.camera.far = null;
      this.camera.frame(this.compiled.scene.bounds);
    }
    $('#camera-select').value = 'free';
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // export

  baseName() {
    return this.fileName.replace(/\.[^.]+$/, '') || 'scene';
  }

  async exportAs(kind) {
    $('#export-menu').classList.remove('open');
    const c = this.compiled;
    const name = this.baseName();
    const meshOf = (e, lod) => this.cache.mesh(e, lod);
    if (kind === 'source') return download(`${name}.es3d`, this.editor.value, 'text/plain');
    if (kind === 'png') return this.screenshot(`${name}.png`);
    if (!c || !c.ok) return this.toast('Fix the errors in the document before exporting.', 'error');
    const doc = c.doc;
    switch (kind) {
      case 'xml-pretty':
        return download(`${name}.es3d`, serialize(doc, { syntax: 'xml', pretty: true }), 'text/plain');
      case 'xml-min':
        return download(`${name}.min.es3d`, serialize(doc, { syntax: 'xml', pretty: false }), 'text/plain');
      case 'compact-pretty':
        return download(`${name}.es3d`, serialize(doc, { syntax: 'compact', pretty: true }), 'text/plain');
      case 'compact-min':
        return download(`${name}.min.es3d`, serialize(doc, { syntax: 'compact', pretty: false }), 'text/plain');
      case 'json':
        return download(`${name}.es3d.json`, serialize(doc, { syntax: 'json', pretty: false }), 'application/json');
      case 'obj': {
        const o = exportOBJ(c.scene, meshOf, { name });
        download(`${name}.obj`, o.obj, 'text/plain');
        download(`${name}.mtl`, o.mtl, 'text/plain');
        return undefined;
      }
      case 'step': {
        try {
          const s = exportSTEP(c.scene, meshOf, { name });
          return download(`${name}.step`, s.data, 'model/step');
        } catch (e) {
          return this.toast(e.message, 'error');
        }
      }
      case 'glb':
        return download(`${name}.glb`, exportGLB(c.scene, meshOf), 'model/gltf-binary');
      case 'glb-inst':
        return download(`${name}.instanced.glb`, exportGLB(c.scene, meshOf, { instancing: true }), 'model/gltf-binary');
      case 'glb-q':
        return download(`${name}.quantized.glb`, exportGLB(c.scene, meshOf, { instancing: true, quantize: true }), 'model/gltf-binary');
      default:
        return undefined;
    }
  }

  screenshot(name) {
    if (!this.renderer) return;
    // the picture has full detail, even while the view is still refining
    const budget = this.renderer.options.tessellationBudget;
    this.renderer.options.tessellationBudget = Infinity;
    this.renderNow();
    this.renderer.options.tessellationBudget = budget;
    const finish = () => this.canvas.toBlob((b) => b && download(name, b, 'image/png'), 'image/png');
    if (this.renderer.kind === 'webgpu') this.renderer.finish().then(finish);
    else finish();
  }

  async compareFormats() {
    const c = this.compiled;
    if (!c || !c.ok) return;
    const btn = $('#btn-compare');
    btn.disabled = true;
    btn.textContent = 'Measuring…';
    await new Promise((r) => setTimeout(r, 20));
    try {
      const meshOf = (e, lod) => this.cache.mesh(e, lod);
      const text = this.editor.value;
      const items = [
        ['ES3D (this source)', text],
        ['ES3D minified', serialize(c.doc, { syntax: 'xml', pretty: false })],
        ['ES3D compact', serialize(c.doc, { syntax: 'compact', pretty: false })],
        ['glTF binary (GLB)', exportGLB(c.scene, meshOf)],
        ['GLB + GPU instancing', exportGLB(c.scene, meshOf, { instancing: true })],
        ['GLB, instanced + quantized', exportGLB(c.scene, meshOf, { instancing: true, quantize: true })],
      ];
      const o = exportOBJ(c.scene, meshOf);
      if (o.obj.length < 64e6) items.push(['OBJ (+MTL)', o.obj + o.mtl]);
      else items.push(['OBJ (+MTL)', null, o.obj.length + o.mtl.length]);
      const out = [];
      for (const [label, data, size] of items) {
        if (data === null) {
          out.push({ label, raw: size, gzip: null });
          continue;
        }
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        out.push({ label, raw: bytes.length, gzip: (await gzip(bytes)).length });
      }
      this.stats.compare = out;
      this.stats.render();
    } catch (e) {
      this.toast(`Comparison failed: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Compare formats';
    }
  }

  // ---------------------------------------------------------------------------
  // frame loop

  renderNow() {
    if (!this.renderer || !this.canvas) return;
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth, hgt = parent.clientHeight;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hgt}px`;
    this.renderer.render(this.camera, { width: w, height: hgt, dpr: Math.min(window.devicePixelRatio || 1, 2), time: this.time });
  }

  frame(t) {
    requestAnimationFrame((tt) => this.frame(tt));
    const dt = Math.min(0.1, (t - this.lastFrame) / 1000);
    this.lastFrame = t;
    const c = this.compiled;
    if (c && c.scene && c.scene.animation.time && this.playing) {
      this.time += dt;
      this.updateAnimation();
    }
    if (this.renderer) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (this.seenDpr !== dpr) {
        this.seenDpr = dpr;
        this.dirty = true;
      }
      const epoch = this.renderer.backend.resourceEpoch || 0;
      if (this.gpuEpoch !== epoch) {
        this.gpuEpoch = epoch;
        this.dirty = true;
      }
    }
    if (this.renderer && (this.dirty || this.params.has('continuous')) && !(this.holdUntil && t < this.holdUntil)) {
      this.dirty = false;
      const before = this.cache.stats.generateMs;
      this.renderNow();
      this.tessMs += this.cache.stats.generateMs - before;
      this.frames++;
      this.persist.changed(this.cache);
      // levels drawn coarser than wanted: refine them on the next frame
      if (this.renderer.stats.refining) this.dirty = true;
    }
    if (t - this.fpsTime >= 1000) {
      this.fps = (this.frames * 1000) / (t - this.fpsTime);
      this.frames = 0;
      this.fpsTime = t;
    }
    if (t - this.statsTime > 300 && this.renderer) {
      this.statsTime = t;
      this.updateRenderStats();
    }
  }

  updateRenderStats() {
    const s = this.renderer.stats;
    const c = this.compiled;
    let genV = 0, genT = 0, equivalentTriangles = 0, equivalentBytes = 0;
    if (c && c.scene) {
      const tri = new Map();
      for (const e of c.scene.geometries) {
        for (const m of e.meshes || []) {
          if (!m) continue;
          genV += m.vertexCount;
          if (m.kind === 'triangles') genT += m.primitiveCount;
        }
      }
      for (let i = 0; i < c.scene.count; i++) {
        const e = c.scene.geometries[c.scene.geom[i]];
        let r = tri.get(e);
        if (r === undefined) {
          const m = e.meshes && e.meshes[0];
          r = m ? [m.kind === 'triangles' ? m.primitiveCount : 0, m.vertexCount, m.indices.length] : [0, 0, 0];
          tri.set(e, r);
        }
        equivalentTriangles += r[0];
        equivalentBytes += r[1] * 32 + r[2] * 4;
      }
    }
    const srcBytes = this.stats.data.sourceBytes || 1;
    // frames are drawn only on change, so a still scene has no frame rate to show
    const rate = this.fps >= 1 ? `${this.fps.toFixed(0)} fps` : 'idle';
    $('#hud').textContent = `${rate} · ${s.cpuMs.toFixed(2)} ms · ${s.drawCalls || 0} draws · ${(s.triangles || 0).toLocaleString('en-US')} tris`;
    this.stats.update({
      backend: `${this.renderer.kind === 'webgpu' ? 'WebGPU' : 'WebGL2'}`,
      fps: this.fps,
      frameMs: s.cpuMs,
      drawCalls: s.drawCalls,
      triangles: s.triangles,
      visible: s.visible,
      culled: s.culled,
      lodHistogram: s.lodHistogram,
      geometryBytes: s.geometryBytes,
      instanceBytes: s.instanceBytes,
      genVertices: genV,
      genTriangles: genT,
      equivalentTriangles,
      expansion: equivalentBytes / srcBytes,
      tessMs: this.tessMs,
    });
  }

  // ---------------------------------------------------------------------------

  toast(message, kind = 'info', ms = 4500) {
    const el = h('div', { class: `toast toast-${kind}` }, message);
    el.addEventListener('click', () => el.remove());
    $('#toasts').append(el);
    if (ms) setTimeout(() => el.remove(), ms);
  }
}
