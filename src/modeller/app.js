// The ES3D Modeller page (docs/modeller/): type points, join them into flat
// planes, add any other ES3D element placed from the points, paint and edit
// everything, and save the model as ES3D.
//
// The model (model.js) is the one source of truth. Every edit goes through
// change(), which keeps the undo history and the browser's copy, and redraws.
// The 3D view is the model's own ES3D plus editing aids, drawn by the ES3D
// renderer. Point handles and labels are HTML on top of it, so they can be
// clicked and dragged without the camera moving.

import { createStage } from '../render/stage.js';
import { h, $, clear, formatBytes } from '../ui/dom.js';
import { highlightXml } from '../ui/highlight.js';
import { download } from '../io/download.js';
import { formatNumber } from '../format/value-format.js';
import { writeHandoff, HANDOFF_LIMIT } from '../../docs/site/handoff.js';
import { indexTree } from '../format/ast.js';
import { serialize } from '../format/serializer.js';
import { raycast } from '../scene/picking.js';
import { FLAG_NO_COLLIDE } from '../scene/flatten.js';
import { ICONS } from '../ui/scene-tree.js';
import * as M from './model.js';
import * as O from './objects.js';
import * as mat4 from '../math/mat4.js';
import { renderInspector } from './inspector.js';

const STORE = 'es3d:modeller';
const HISTORY = 200;
const MEDIA_TYPE = 'model/vnd.es3d';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const fmt = (v) => formatNumber(v, 9);

/** Distance along the ray to the triangle, or Infinity (Möller–Trumbore, both sides). */
function rayTriangle(o, d, [a, b, c]) {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-18) return Infinity;
  const inv = 1 / det;
  const t0 = sub(o, a);
  const u = dot(t0, p) * inv;
  if (u < 0 || u > 1) return Infinity;
  const q = cross(t0, e1);
  const v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = dot(e2, q) * inv;
  return t > 0 ? t : Infinity;
}

function hslToHex(hue, s, l) {
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const isTyping = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['checkbox', 'button', 'color'].includes(el.type)));

export class Modeller {
  constructor() {
    this.model = M.createModel();
    /** point ids in the order they were picked: the outline of the next plane */
    this.picked = [];
    /** selected plane ids */
    this.selected = new Set();
    this.paint = this.model.paints[0].id;
    this.tool = 'select';
    this.view = { edges: true, labels: true, grid: true, snap: 0.5 };
    this.undoStack = [];
    this.redoStack = [];
    this.liveBefore = null;
    this.stage = null;
    this.handles = new Map();
    this.faces = [];
    this.labelKey = '';
    this.version = 0;
    this.previewQueued = false;
    this.source = '';
    this.rowsKey = '';
    /** the selected element (object id), and what the inspector shows */
    this.object = null;
    this.inspecting = 'object';
    this.check = { diagnostics: [], byObject: new Map(), errors: 0, warnings: 0 };
    /** preview element uid → {plane} or {object} */
    this.uids = new Map();
    this.objectHandle = null;
    this.contentBounds = null;
    this.frameNext = false;
  }

  async init() {
    this.restore();
    this.bind();
    this.renderPanels();
    try {
      this.stage = await createStage($('#viewport'), {
        autoOrbit: false,
        geometryStore: false,
        onFrame: () => this.placeHandles(),
        // the inspector and the stale-view note already show what is wrong
        onError: () => {},
      });
    } catch (err) {
      $('#backend-label').textContent = 'No 3D';
      this.toast(`This browser cannot draw the 3D view (${err.message}). The lists, paints and saving still work.`, 'error');
      return;
    }
    $('#backend-label').textContent = this.stage.kind === 'webgpu' ? 'WebGPU' : 'WebGL2';
    this.stage.controls.onClick = (x, y, e) => this.clickScene(x, y, e);
    this.showPreview(true);
  }

  // --- history and storage -----------------------------------------------------------

  /** Run an edit; if it changed the model, it can be undone. Returns what fn returned. */
  change(fn) {
    const before = JSON.stringify(this.model);
    const result = fn();
    if (JSON.stringify(this.model) !== before) {
      this.pushUndo(before);
      this.afterChange();
    }
    return result;
  }

  pushUndo(before) {
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Edits that run over many events (a drag, a colour picker) are one undo step. */
  beginLive() {
    if (this.liveBefore === null) this.liveBefore = JSON.stringify(this.model);
  }

  endLive() {
    const before = this.liveBefore;
    this.liveBefore = null;
    if (before !== null && before !== JSON.stringify(this.model)) this.pushUndo(before);
    this.afterChange();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.model));
    this.model = JSON.parse(this.undoStack.pop());
    this.afterChange();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.model));
    this.model = JSON.parse(this.redoStack.pop());
    this.afterChange();
  }

  afterChange() {
    const points = new Set(this.model.points.map((p) => p.id));
    this.picked = this.picked.filter((id) => points.has(id));
    const planes = new Set(this.model.planes.map((p) => p.id));
    for (const id of this.selected) if (!planes.has(id)) this.selected.delete(id);
    if (!this.model.paints.some((p) => p.id === this.paint)) this.paint = this.model.paints[0].id;
    if (this.object !== null && !O.findObject(this.model.objects, this.object)) this.object = null;
    this.save();
    this.renderPanels();
    this.updatePreview();
  }

  save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ model: this.model, paint: this.paint, view: this.view }));
    } catch {
      // storage can be missing or full; the model stays on the page
    }
  }

  restore() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(STORE) || 'null');
    } catch {
      data = null;
    }
    const model = data && M.restoreModel(data.model);
    if (model) this.model = model;
    if (data && typeof data.paint === 'string') this.paint = data.paint;
    if (!this.model.paints.some((p) => p.id === this.paint)) this.paint = this.model.paints[0].id;
    if (data && data.view) {
      for (const k of ['edges', 'labels', 'grid']) if (typeof data.view[k] === 'boolean') this.view[k] = data.view[k];
      if ([0, 0.1, 0.25, 0.5, 1].includes(data.view.snap)) this.view.snap = data.view.snap;
    }
  }

  // --- user interface ----------------------------------------------------------------

  bind() {
    $('#add-point').addEventListener('submit', (e) => {
      e.preventDefault();
      this.addTypedPoint();
    });
    $('#btn-paste').addEventListener('click', () => this.addPastedPoints());
    $('#btn-plane').addEventListener('click', () => this.makePlane());
    $('#btn-delete-points').addEventListener('click', () => this.deletePoints(this.model.points.map((p) => p.id)));
    $('#btn-material').addEventListener('click', () => this.inspectPaint());
    $('#tab-inspector').addEventListener('click', () => this.setTab('inspector'));
    $('#tab-source').addEventListener('click', () => this.setTab('source'));
    this.buildAddMenu();
    $('#btn-clear').addEventListener('click', () => this.clearPicks());
    $('#btn-undo').addEventListener('click', () => this.undo());
    $('#btn-redo').addEventListener('click', () => this.redo());
    $('#btn-example').addEventListener('click', () => this.load(M.exampleHouse()));
    $('#btn-frame').addEventListener('click', () => this.frameModel());
    $('#btn-studio').addEventListener('click', () => this.openInStudio());
    $('#btn-open').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) this.openText(await file.text(), file.name);
    });

    const title = $('#title');
    title.value = this.model.title;
    title.addEventListener('change', () => this.change(() => (this.model.title = title.value.trim())));
    title.addEventListener('keydown', (e) => e.key === 'Enter' && title.blur());

    for (const [button, menu] of [['#btn-new', '#new-menu'], ['#btn-save', '#save-menu'], ['#btn-add', '#add-menu']]) {
      $(button).addEventListener('click', (e) => {
        e.stopPropagation();
        const open = !$(menu).classList.contains('open');
        document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
        $(menu).classList.toggle('open', open);
      });
    }
    document.addEventListener('click', () => document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')));
    $('#new-menu').addEventListener('click', (e) => {
      const kind = e.target.dataset.new;
      if (kind) this.load(kind === 'house' ? M.exampleHouse() : M.createModel());
    });
    $('#save-menu').addEventListener('click', (e) => {
      const kind = e.target.dataset.save;
      if (kind === 'copy') this.copySource();
      else if (kind) this.saveFile(kind);
    });

    $('#tool-select').addEventListener('click', () => this.setTool('select'));
    $('#tool-paint').addEventListener('click', () => this.setTool('paint'));
    const snap = $('#snap');
    snap.value = String(this.view.snap);
    snap.addEventListener('change', () => {
      this.view.snap = Number(snap.value);
      this.save();
    });
    for (const k of ['edges', 'labels', 'grid']) {
      const box = $(`#tg-${k}`);
      box.checked = this.view[k];
      box.addEventListener('change', () => {
        this.view[k] = box.checked;
        this.save();
        if (k === 'labels') $('#labels').classList.toggle('no-text', !box.checked);
        else this.updatePreview();
      });
    }
    $('#labels').classList.toggle('no-text', !this.view.labels);

    $('#btn-add-paint').addEventListener('click', () =>
      this.change(() => {
        this.paint = M.addPaint(this.model, hslToHex(Math.random() * 360, 0.55, 0.55)).id;
      }),
    );
    $('#btn-remove-paint').addEventListener('click', () => this.change(() => M.removePaint(this.model, this.paint)));
    const name = $('#paint-name');
    name.addEventListener('change', () => {
      this.change(() => {
        this.paint = M.renamePaint(this.model, this.paint, name.value || this.paint);
      });
      // the name as it is stored, even when it did not change
      this.renderPalette();
    });
    name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());
    const color = $('#paint-color');
    color.addEventListener('input', () => {
      const paint = this.model.paints.find((p) => p.id === this.paint);
      if (!paint) return;
      this.beginLive();
      paint.color = color.value;
      this.renderPalette();
      this.renderPlanes();
      this.updatePreview();
    });
    color.addEventListener('change', () => this.endLive());

    const canvas = $('#viewport');
    canvas.addEventListener('pointermove', (e) => this.showGroundPoint(e));
    canvas.addEventListener('pointerleave', () => ($('#hud').textContent = ''));

    document.addEventListener('keydown', (e) => this.key(e));

    const overlay = $('#drop-overlay');
    let depth = 0;
    document.addEventListener('dragenter', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      depth++;
      overlay.classList.add('show');
    });
    document.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.classList.remove('show');
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      const file = e.dataTransfer.files[0];
      if (file) this.openText(await file.text(), file.name);
    });
  }

  key(e) {
    const mod = e.ctrlKey || e.metaKey;
    const typing = isTyping(e.target);
    if (mod && !typing && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && !typing && (e.key === 'd' || e.key === 'D') && this.object !== null) {
      e.preventDefault();
      this.duplicateObject(this.object);
      return;
    }
    if (mod && !typing && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      this.redo();
      return;
    }
    if (typing || mod || e.altKey) return;
    if (e.key === 'Enter' && e.target.tagName === 'BUTTON') return;
    if (e.key === 'Enter' || e.key === 'p' || e.key === 'P') {
      if (this.picked.length >= 3) {
        e.preventDefault();
        this.makePlane();
      }
    } else if (e.key === 'Escape') {
      this.clearPicks();
      this.selected.clear();
      this.object = null;
      this.refreshSelection();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // Delete removes the selected planes; Backspace takes back the last pick first
      e.preventDefault();
      if (e.key === 'Backspace' && this.picked.length) {
        this.picked.pop();
        this.refreshSelection();
      } else if (this.selected.size) this.deletePlanes([...this.selected]);
      else if (this.object !== null) this.deleteObject(this.object);
    } else if (e.key === 'v' || e.key === 'V') this.setTool('select');
    else if (e.key === 'b' || e.key === 'B') this.setTool('paint');
    else if (e.key === 'f' || e.key === 'F') this.frameModel();
  }

  setTool(tool) {
    this.tool = tool;
    $('#tool-select').classList.toggle('on', tool === 'select');
    $('#tool-paint').classList.toggle('on', tool === 'paint');
    $('#viewport-wrap').classList.toggle('painting', tool === 'paint');
  }

  toast(message, kind = 'info') {
    const el = h('div', { class: `toast${kind === 'error' ? ' toast-error' : kind === 'warning' ? ' toast-warning' : ''}`, role: 'status' }, message);
    el.addEventListener('click', () => el.remove());
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 9000 : 5000);
  }

  // --- editing -------------------------------------------------------------------------

  pointAt(xyz) {
    return this.model.points.find((p) => p.x === xyz[0] && p.y === xyz[1] && p.z === xyz[2]);
  }

  addTypedPoint() {
    const inputs = ['#in-x', '#in-y', '#in-z'].map((s) => $(s));
    const xyz = inputs.map((i) => Number(i.value));
    if (inputs.some((i) => i.value.trim() === '') || !xyz.every(Number.isFinite)) return this.toast('Type a number for X, Y and Z.', 'error');
    const there = this.pointAt(xyz);
    if (there) return this.toast(`${M.pointLabel(there.id)} is already at ${xyz.map(fmt).join(', ')}.`, 'warning');
    this.change(() => M.addPoint(this.model, xyz));
    this.keepInView();
    inputs[0].focus();
    inputs[0].select();
  }

  addPastedPoints() {
    const { points, errors } = M.parsePointList($('#paste-text').value);
    let added = 0;
    let doubles = 0;
    this.change(() => {
      for (const xyz of points) {
        if (this.pointAt(xyz)) doubles++;
        else {
          M.addPoint(this.model, xyz);
          added++;
        }
      }
    });
    if (added) this.keepInView();
    const parts = [`Added ${added} point${added === 1 ? '' : 's'}.`];
    if (doubles) parts.push(`${doubles} already existed.`);
    if (errors.length) parts.push(`Line${errors.length > 1 ? 's' : ''} ${errors.map((e) => e.line).join(', ')} did not hold x, y and z.`);
    const note = $('#paste-note');
    note.textContent = parts.join(' ');
    note.classList.toggle('error', errors.length > 0);
    if (added && !errors.length) $('#paste-text').value = '';
  }

  setCoordinate(id, k, input) {
    const p = this.model.points.find((q) => q.id === id);
    const v = Number(input.value);
    if (!p) return;
    if (input.value.trim() === '' || !Number.isFinite(v)) {
      input.value = fmt(p[k]);
      return;
    }
    const notes = this.change(() => {
      p[k] = v;
      return M.repairPlanes(this.model, new Set([id]));
    });
    for (const n of notes || []) this.toast(n, 'warning');
  }

  togglePick(id) {
    const at = this.picked.indexOf(id);
    // picking the first point again closes the outline
    if (at === 0 && this.picked.length >= 3) return this.makePlane();
    if (at >= 0) this.picked.splice(at, 1);
    else this.picked.push(id);
    this.refreshSelection();
  }

  clearPicks() {
    this.picked = [];
    this.refreshSelection();
  }

  makePlane() {
    if (this.picked.length < 3) return;
    const r = this.change(() => M.makePlane(this.model, this.picked, this.paint));
    if (r.error) return this.toast(r.error, 'error');
    // the new plane is not selected: choosing a paint for the next one must not repaint it
    this.picked = [];
    if (r.split) this.toast(`Those points are not on one flat plane (one is ${formatNumber(r.deviation, 4)} off), so they became ${r.planes.length} triangles.`, 'warning');
    else if (r.reordered) this.toast('The points were put in order around the outline.');
    this.refreshSelection();
  }

  deletePlanes(ids) {
    this.change(() => M.deletePlanes(this.model, ids));
  }

  deletePoints(ids) {
    const r = this.change(() => M.deletePoints(this.model, ids));
    if (r && r.removedPlanes) this.toast(`${r.removedPlanes} plane${r.removedPlanes > 1 ? 's' : ''} had fewer than 3 points left and went too.`, 'warning');
    for (const n of (r && r.notes) || []) this.toast(n, 'warning');
  }

  choosePaint(id) {
    this.paint = id;
    const node = this.object !== null && O.findObject(this.model.objects, this.object);
    if (this.selected.size || (node && this.paintable(node.node))) {
      this.change(() => {
        for (const plane of this.model.planes) if (this.selected.has(plane.id)) plane.paint = id;
        if (node && this.paintable(node.node)) this.paintObject(node.node, id);
      });
    }
    if (this.inspecting === 'paint') this.renderInspector();
    this.save();
    this.renderPalette();
  }

  /** Elements that take a material: shapes, groups and other placed elements. */
  paintable(node) {
    const spec = O.isShape(node.name) || ['group', 'scene', 'use', 'repeat', 'scatter', 'lod'].includes(node.name);
    return spec;
  }

  /** Give an element a material; its own colour would hide it, so that goes. */
  paintObject(node, id) {
    node.attrs.material = id;
    delete node.attrs.color;
  }

  load(model, note = null) {
    this.change(() => (this.model = model));
    this.picked = [];
    this.selected.clear();
    this.object = null;
    this.inspecting = 'object';
    $('#title').value = this.model.title;
    this.refreshSelection();
    // framed once the new model is drawn, so its elements count
    this.frameNext = true;
    if (note) this.toast(note, 'warning');
  }

  openText(text, name) {
    let r;
    try {
      r = M.fromES3D(text);
    } catch (err) {
      return this.toast(`${name}: ${err.message}`, 'error');
    }
    if (!r.model.title) r.model.title = name.replace(/\.(es3d|json|txt)$/i, '');
    this.load(r.model);
    this.toast(`${name}: ${r.planes} plane${r.planes === 1 ? '' : 's'} from its polygons, ${r.objects} other element${r.objects === 1 ? '' : 's'}.`);
  }

  fileName() {
    return (this.model.title || 'model').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
  }

  warnUnused() {
    const used = new Set(this.model.planes.flatMap((p) => p.points));
    const n = this.model.points.filter((p) => !used.has(p.id)).length;
    if (n) this.toast(`${n} point${n > 1 ? 's are' : ' is'} not part of a plane, so not in the file. This browser keeps ${n > 1 ? 'them' : 'it'} for the modeller.`, 'warning');
  }

  saveFile(syntax) {
    download(`${this.fileName()}.es3d`, M.toES3D(this.model, { syntax }), MEDIA_TYPE);
    this.warnUnused();
  }

  async copySource() {
    try {
      await navigator.clipboard.writeText(this.source);
      this.toast('The ES3D source is on the clipboard.');
    } catch {
      this.toast('The browser did not allow copying. Select the source on the right and copy it.', 'error');
    }
  }

  openInStudio() {
    if (this.source.length > HANDOFF_LIMIT || !writeHandoff(`${this.fileName()}.es3d`, this.source)) {
      return this.toast('The browser does not allow handing the model to ES3D Studio here. Save it and open the file in Studio.', 'error');
    }
    location.href = '../studio/?handoff=1';
  }

  // --- panels --------------------------------------------------------------------------

  renderPanels() {
    this.version++;
    this.resolved = M.resolvePlanes(this.model);
    this.check = M.checkModel(this.model);
    this.renderPoints();
    this.renderPlanes();
    this.renderPalette();
    this.renderElements();
    this.renderInspector();
    this.renderSource();
    this.renderStatus();
    if ($('#title') !== document.activeElement) $('#title').value = this.model.title;
  }

  refreshSelection() {
    this.renderPoints();
    this.renderPlanes();
    this.renderElements();
    this.renderInspector();
    this.renderStatus();
    this.updatePreview();
  }

  renderStatus() {
    const n = this.picked.length;
    $('#btn-plane').disabled = n < 3;
    $('#btn-clear').disabled = n === 0;
    $('#btn-delete-points').disabled = !this.model.points.length;
    $('#stale').classList.toggle('show', this.check.errors > 0);
    $('#btn-undo').disabled = !this.undoStack.length;
    $('#btn-redo').disabled = !this.redoStack.length;
    $('#pick-note').textContent = n
      ? `${this.picked.map(M.pointLabel).join(' → ')}${n < 3 ? `: pick ${3 - n} more.` : '. Pick more, or make the plane.'}`
      : 'Pick 3 or more points in order around the outline.';
    $('#empty-hint').hidden = this.model.points.length > 0 || this.model.objects.length > 0;
    $('#point-count').textContent = this.model.points.length ? String(this.model.points.length) : '';
    $('#plane-count').textContent = this.model.planes.length ? String(this.model.planes.length) : '';
    $('#points-empty').hidden = this.model.points.length > 0;
    $('#planes-empty').hidden = this.model.planes.length > 0;
  }

  renderPoints() {
    const body = $('#points');
    const key = this.model.points.map((p) => p.id).join(',');
    if (key !== this.rowsKey) {
      this.rowsKey = key;
      clear(body);
      for (const p of this.model.points) {
        const id = p.id;
        const coord = (k) =>
          h(
            'td',
            {},
            h('input', {
              type: 'number',
              step: 'any',
              'data-k': k,
              'aria-label': `${M.pointLabel(id)} ${k}`,
              onchange: (e) => this.setCoordinate(id, k, e.target),
              onkeydown: (e) => e.key === 'Enter' && e.target.blur(),
            }),
          );
        body.append(
          h(
            'tr',
            { 'data-id': id },
            h('td', {}, h('button', { class: 'pick', title: `Pick ${M.pointLabel(id)}`, onclick: () => this.togglePick(id) })),
            h('td', { class: 'point-name', onclick: () => this.togglePick(id) }, M.pointLabel(id), h('span', { class: 'unused', title: 'Not part of a plane yet, so not in the file' }, '○')),
            coord('x'),
            coord('y'),
            coord('z'),
            h('td', {}, h('button', { class: 'icon', title: `Delete ${M.pointLabel(id)}`, onclick: () => this.deletePoints([id]) }, '×')),
          ),
        );
      }
    }
    const used = new Set(this.model.planes.flatMap((p) => p.points));
    const rows = body.children;
    this.model.points.forEach((p, i) => {
      const row = rows[i];
      const at = this.picked.indexOf(p.id);
      row.classList.toggle('sel', at >= 0);
      row.querySelector('.pick').textContent = at >= 0 ? String(at + 1) : '';
      row.querySelector('.unused').hidden = used.has(p.id);
      for (const input of row.querySelectorAll('input')) {
        if (input !== document.activeElement) input.value = fmt(p[input.dataset.k]);
      }
    });
  }

  renderPlanes() {
    const list = clear($('#planes'));
    const colors = new Map(this.model.paints.map((p) => [p.id, p.color]));
    for (const r of this.resolved || []) {
      const plane = r.plane;
      const li = h(
        'li',
        {
          class: this.selected.has(plane.id) ? 'sel' : '',
          'data-id': plane.id,
          title: r.kind === 'invalid' ? r.reason : `${M.planeLabel(plane.id)}, painted ${plane.paint}`,
          onclick: (e) => {
            if (e.target.closest('button')) return;
            this.selectPlane(plane.id, e.shiftKey || e.ctrlKey || e.metaKey);
          },
        },
        h('span', { class: 'swatch', style: { background: colors.get(plane.paint) || '#bfbfbf' } }),
        h('span', { class: 'name' }, M.planeLabel(plane.id)),
        h('span', { class: 'ids' }, plane.points.map(M.pointLabel).join(' ')),
        r.kind === 'invalid' ? h('span', { class: 'warn', title: r.reason }, '⚠') : null,
        h('button', { class: 'icon', title: `Delete ${M.planeLabel(plane.id)}`, onclick: () => this.deletePlanes([plane.id]) }, '×'),
      );
      list.append(li);
    }
  }

  selectPlane(id, add) {
    this.object = null;
    if (add) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    } else this.selected = new Set([id]);
    this.refreshSelection();
    const row = $(`#planes li[data-id="${id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  renderPalette() {
    const palette = clear($('#palette'));
    for (const p of this.model.paints) {
      palette.append(
        h(
          'button',
          { class: `paint${p.id === this.paint ? ' on' : ''}`, role: 'option', 'aria-selected': String(p.id === this.paint), title: `${p.id} ${p.color}`, onclick: () => this.choosePaint(p.id) },
          h('span', { class: 'chip', style: { background: p.color } }),
          h('span', { class: 'label' }, p.id),
        ),
      );
    }
    const paint = this.model.paints.find((p) => p.id === this.paint);
    if (paint) {
      if ($('#paint-name') !== document.activeElement) $('#paint-name').value = paint.id;
      $('#paint-color').value = paint.color.slice(0, 7);
    }
    $('#btn-remove-paint').disabled = this.model.paints.length < 2;
  }

  renderSource() {
    this.source = M.toES3D(this.model);
    $('#source').innerHTML = highlightXml(this.source);
    const problems = this.check.errors ? ` · ${this.check.errors} error${this.check.errors === 1 ? '' : 's'}` : '';
    $('#size').textContent = `${formatBytes(new TextEncoder().encode(this.source).length)}${problems}`;
  }

  setTab(tab) {
    for (const [id, name] of [['#tab-inspector', 'inspector'], ['#tab-source', 'source']]) {
      $(id).classList.toggle('on', tab === name);
      $(id).setAttribute('aria-selected', String(tab === name));
    }
    $('#inspector').hidden = tab !== 'inspector';
    $('#source').hidden = tab !== 'source';
  }

  // --- elements ---------------------------------------------------------------------

  buildAddMenu() {
    const menu = $('#add-menu');
    for (const g of O.CATALOGUE) {
      menu.append(h('div', { class: 'menu-group' }, g.group));
      for (const item of g.items) {
        menu.append(h('button', { 'data-add': item.name, title: `<${item.name}>`, onclick: () => this.addElement(item.name) }, h('b', {}, item.label), h('span', {}, item.uses)));
      }
    }
  }

  /** The element a new one goes into: the selected one, or the one around it, when it may hold it. */
  containerFor(name) {
    if (O.ONCE.has(name) || name === 'desc') return null;
    if (this.object === null) return null;
    const chain = [...O.ancestorsOf(this.model.objects, this.object), O.findObject(this.model.objects, this.object).node];
    for (let i = chain.length - 1; i >= 0; i--) if (O.accepts(chain[i].name, name)) return chain[i].oid;
    return null;
  }

  addElement(name) {
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
    if (name === 'polygon') {
      if (this.picked.length < 3) return this.toast('A polygon is a plane: pick 3 or more points first.', 'warning');
      return this.makePlane();
    }
    if (O.ONCE.has(name)) {
      const there = this.model.objects.find((n) => n.name === name);
      if (there) {
        this.selectObject(there.oid);
        return this.toast(`The file has its <${name}> already; it is selected.`);
      }
    }
    let into = this.containerFor(name);
    if (name === 'animate') {
      const target = this.object !== null && O.findObject(this.model.objects, this.object);
      if (!target || !O.accepts(target.node.name, 'animate')) return this.toast('Select the element to animate first (a shape, group, light or camera).', 'warning');
      into = target.node.oid;
    }
    // points arrive in the frame of the element the new one goes into; an
    // animation's values are in the frame its element is placed in
    const frame = name === 'animate' ? (O.findObject(this.model.objects, into).parent || { oid: null }).oid : into;
    const map = M.pointMap(this.model);
    const points = this.picked.map((id) => map.get(id)).map((p) => O.toFrame(this.model, frame, [p.x, p.y, p.z]));
    const defsIds = [];
    for (const d of this.model.objects.filter((n) => n.name === 'defs')) for (const c of d.children) if (c.attrs.id) defsIds.push(c.attrs.id.trim());
    const digits = M.decimalsFor(Math.max(1, M.modelExtent(this.model)));
    const r = O.placeElement(name, { points, fmt: (v) => formatNumber(v, digits), paint: this.paint, defsIds });
    if (r.error) return this.toast(r.error, 'error');
    const node = this.change(() => O.insertObject(this.model, r.node, into));
    this.picked = [];
    this.selected.clear();
    this.selectObject(node.oid);
    if (r.note) this.toast(r.note);
  }

  selectObject(oid) {
    this.object = oid;
    this.inspecting = 'object';
    if (oid !== null) this.selected.clear();
    this.setTab('inspector');
    this.refreshSelection();
    const row = oid !== null && $(`#elements [data-oid="${oid}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  deleteObject(oid) {
    this.change(() => O.removeObject(this.model, oid));
  }

  duplicateObject(oid) {
    const copy = this.change(() => O.duplicateObject(this.model, oid));
    if (copy) this.selectObject(copy.oid);
  }

  renderElements() {
    const tree = clear($('#elements'));
    const rowFor = (node) => {
      const label = O.objectLabel(node);
      const diags = this.check.byObject.get(node.oid) || [];
      const errors = diags.filter((d) => d.severity === 'error');
      const li = h(
        'li',
        {},
        h(
          'div',
          { class: `el-row${node.oid === this.object ? ' sel' : ''}`, 'data-oid': node.oid, title: diags.map((d) => d.message).join('\n'), onclick: () => this.selectObject(node.oid) },
          h('span', { class: 'icon-glyph' }, ICONS[node.name] || '•'),
          h('span', { class: 'tag-name' }, node.name),
          h('span', { class: 'who' }, label.who),
          h('span', { class: 'what' }, label.what),
          errors.length ? h('span', { class: 'err' }, '●') : diags.length ? h('span', { class: 'warn' }, '●') : null,
        ),
      );
      if (node.children.length) li.append(h('ul', {}, node.children.map(rowFor)));
      return li;
    };
    for (const node of this.model.objects) tree.append(rowFor(node));
    let count = 0;
    O.walkObjects(this.model.objects, () => count++);
    $('#element-count').textContent = count ? String(count) : '';
    $('#elements-empty').hidden = count > 0;
  }

  inspectPaint() {
    this.inspecting = 'paint';
    this.setTab('inspector');
    this.renderInspector();
  }

  /** ids the inspector offers for references, by kind. */
  refIds() {
    const material = this.model.paints.map((p) => p.id);
    const path = [];
    const node = [];
    O.walkObjects(this.model.objects, (n, parent) => {
      const id = n.attrs.id && n.attrs.id.trim();
      if (!id) return;
      node.push(id);
      if (n.name === 'path' && parent && parent.name === 'defs') path.push(id);
    });
    return { material, path, node };
  }

  renderInspector() {
    const box = $('#inspector');
    if (this.inspecting === 'paint') {
      const paint = this.model.paints.find((p) => p.id === this.paint);
      if (!paint) return clear(box);
      return renderInspector(box, {
        name: 'material',
        heading: `Paint “${paint.id}”`,
        attrs: { id: paint.id, color: paint.color, ...(paint.attrs || {}) },
        refs: this.refIds(),
        onSet: (attr, raw) =>
          this.change(() => {
            if (attr === 'id') this.paint = M.renamePaint(this.model, paint.id, raw || paint.id);
            else if (attr === 'color') {
              if (raw) paint.color = raw;
            } else {
              paint.attrs = { ...(paint.attrs || {}) };
              if (raw === null) delete paint.attrs[attr];
              else paint.attrs[attr] = raw;
            }
          }),
      });
    }
    const f = this.object !== null && O.findObject(this.model.objects, this.object);
    if (!f) {
      clear(box).append(h('p', { class: 'empty' }, 'Select an element in the list or the view to edit every attribute it has. Paint… shows the current paint as a material.'));
      return;
    }
    const node = f.node;
    renderInspector(box, {
      name: node.name,
      attrs: node.attrs,
      text: node.text,
      diagnostics: this.check.byObject.get(node.oid) || [],
      refs: this.refIds(),
      onSet: (attr, raw) =>
        this.change(() => {
          if (raw === null) delete node.attrs[attr];
          else node.attrs[attr] = raw;
        }),
      onText: (text) => this.change(() => (node.text = text)),
      actions: [
        { label: '↑', title: 'Move up', onClick: () => this.change(() => O.moveObject(this.model, node.oid, -1)) },
        { label: '↓', title: 'Move down', onClick: () => this.change(() => O.moveObject(this.model, node.oid, 1)) },
        { label: 'Duplicate', title: 'Ctrl+D', onClick: () => this.duplicateObject(node.oid) },
        { label: 'Delete', title: 'Delete', danger: true, onClick: () => this.deleteObject(node.oid) },
      ],
    });
  }

  // --- the 3D view -----------------------------------------------------------------------

  updatePreview() {
    if (!this.stage || this.previewQueued) return;
    this.previewQueued = true;
    requestAnimationFrame(() => {
      this.previewQueued = false;
      this.showPreview(false);
    });
  }

  showPreview(first) {
    const doc = M.buildDocument(this.model, { selectedPoints: this.picked, selectedPlanes: this.selected, edges: this.view.edges, grid: this.view.grid, bounds: this.contentBounds });
    // the uids the renderer will give these elements: it numbers them in the same order
    indexTree(doc);
    this.uids = new Map();
    for (const [el, plane] of doc.planeOf) this.uids.set(el.uid, { plane });
    for (const [el, object] of doc.objectOf) this.uids.set(el.uid, { object });
    const selection = new Set();
    if (this.object !== null) {
      const el = [...doc.objectOf].find(([, oid]) => oid === this.object);
      const add = (e) => {
        selection.add(e.uid);
        for (const c of e.children) if (c.type === 'element') add(c);
      };
      if (el) add(el[0]);
    }
    this.stage.show(serialize(doc, { syntax: 'xml', pretty: false }), { keepCamera: !first });
    this.stage.renderer.selection = selection;
    this.stage.invalidate();
    // the grid reaches past what is drawn; when that grew, draw once more with the larger grid
    const before = this.contentBounds;
    this.contentBounds = this.measureContent();
    const reach = (b) => (b ? Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[2]), Math.abs(b.max[2])) : 0);
    if (Math.abs(reach(this.contentBounds) - reach(before)) > 1e-6) this.updatePreview();
    if (first || this.frameNext) {
      this.frameNext = false;
      this.frameModel();
    }
    const map = M.pointMap(this.model);
    this.faces = [];
    for (const r of M.resolvePlanes(this.model)) {
      for (const f of r.faces) for (const tri of M.faceTriangles(f.map((id) => [map.get(id).x, map.get(id).y, map.get(id).z]))) this.faces.push({ plane: r.plane.id, tri });
    }
    this.syncHandles();
    this.labelKey = '';
  }

  /** Bounds of what the model draws, editing aids left out (from the instances' bounding spheres). */
  measureContent() {
    const scene = this.stage && this.stage.result && this.stage.result.scene;
    if (!scene) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < scene.count; i++) {
      if (scene.flags[i] & FLAG_NO_COLLIDE) continue;
      const r = scene.spheres[i * 4 + 3];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], scene.spheres[i * 4 + k] - r);
        max[k] = Math.max(max[k], scene.spheres[i * 4 + k] + r);
      }
    }
    return min[0] <= max[0] ? { min, max } : null;
  }

  frameModel() {
    if (!this.stage) return;
    const pts = this.model.points;
    let bounds = { min: [-2, 0, -2], max: [2, 2, 2] };
    if (pts.length || this.contentBounds) {
      const min = this.contentBounds ? this.contentBounds.min.slice() : [Infinity, Infinity, Infinity];
      const max = this.contentBounds ? this.contentBounds.max.slice() : [-Infinity, -Infinity, -Infinity];
      for (const p of pts) {
        [p.x, p.y, p.z].forEach((v, k) => {
          min[k] = Math.min(min[k], v);
          max[k] = Math.max(max[k], v);
        });
      }
      for (let k = 0; k < 3; k++) {
        if (max[k] - min[k] < 1) {
          const c = (max[k] + min[k]) / 2;
          min[k] = c - 0.5;
          max[k] = c + 0.5;
        }
      }
      bounds = { min, max };
    }
    this.stage.camera.frame(bounds);
    this.stage.invalidate();
  }

  /** Frame the model again when a point is outside the view (typed points can land anywhere). */
  keepInView() {
    if (!this.stage || !this.updateCamera()) return;
    const m = this.stage.camera.viewProj;
    const outside = this.model.points.some((p) => {
      const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
      if (w <= 1e-9) return true;
      const x = (m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w;
      const y = (m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / w;
      return Math.abs(x) > 0.92 || Math.abs(y) > 0.85;
    });
    if (outside) this.frameModel();
  }

  /** Point handles: one per point, keyed by id. */
  syncHandles() {
    const layer = $('#labels');
    const ids = new Set(this.model.points.map((p) => p.id));
    for (const [id, el] of this.handles) {
      if (!ids.has(id)) {
        el.remove();
        this.handles.delete(id);
      }
    }
    for (const p of this.model.points) {
      let el = this.handles.get(p.id);
      if (!el) {
        el = h('div', { class: 'handle', 'data-id': p.id }, h('span', { class: 'dot' }), h('span', { class: 'text' }));
        el.addEventListener('pointerdown', (e) => this.startDrag(e, p.id));
        el.addEventListener('wheel', (e) => $('#viewport').dispatchEvent(new WheelEvent('wheel', e)), { passive: true });
        layer.append(el);
        this.handles.set(p.id, el);
      }
      const at = this.picked.indexOf(p.id);
      el.classList.toggle('sel', at >= 0);
      el.querySelector('.text').textContent = at >= 0 ? `${M.pointLabel(p.id)} ·${at + 1}` : M.pointLabel(p.id);
    }
    // the selected element gets a handle at its position
    const f = this.object !== null && O.findObject(this.model.objects, this.object);
    if (f && O.anchorOf(this.model, this.object)) {
      if (!this.objectHandle) {
        this.objectHandle = h('div', { class: 'handle object', title: 'Drag to move; Shift: up and down' }, h('span', { class: 'dot' }), h('span', { class: 'text' }));
        this.objectHandle.addEventListener('pointerdown', (e) => this.startObjectDrag(e));
        this.objectHandle.addEventListener('wheel', (e) => $('#viewport').dispatchEvent(new WheelEvent('wheel', e)), { passive: true });
        layer.append(this.objectHandle);
      }
      this.objectHandle.querySelector('.text').textContent = `<${f.node.name}>`;
    } else if (this.objectHandle) {
      this.objectHandle.remove();
      this.objectHandle = null;
    }
  }

  viewSize() {
    const wrap = $('#viewport-wrap');
    return [wrap.clientWidth, wrap.clientHeight];
  }

  /** Camera matrices for the current view size. */
  updateCamera() {
    const [w, hgt] = this.viewSize();
    if (!w || !hgt || !this.stage.result) return null;
    this.stage.camera.update(w / hgt, this.stage.renderer.backend.zeroToOne, this.stage.result.scene.bounds);
    return [w, hgt];
  }

  ray(clientX, clientY) {
    const size = this.updateCamera();
    if (!size) return null;
    const r = $('#viewport').getBoundingClientRect();
    return this.stage.camera.ray(clientX - r.left, clientY - r.top, size[0], size[1], this.stage.renderer.backend.zeroToOne);
  }

  /** Called every animation frame: move the handles when the camera or the model changed. */
  placeHandles() {
    const cam = this.stage.camera;
    const [w, hgt] = this.viewSize();
    const key = `${cam.position.join()},${cam.target.join()},${cam.fov},${cam.orthoHeight},${w}x${hgt},${this.version},${this.handles.size},${this.object}`;
    if (key === this.labelKey || !this.updateCamera()) return;
    this.labelKey = key;
    const m = cam.viewProj;
    const eye = cam.position;
    const size = Math.max(1, M.modelExtent(this.model));
    const occlusion = this.faces.length * this.model.points.length <= 250000;
    const anchor = this.objectHandle && O.anchorOf(this.model, this.object);
    if (anchor) {
      const [x, y, z] = anchor.world;
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      this.objectHandle.style.display = cw > 1e-9 ? '' : 'none';
      if (cw > 1e-9) {
        const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw) * 0.5 + 0.5;
        const sy = 0.5 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 0.5;
        this.objectHandle.style.transform = `translate(${(sx * w).toFixed(1)}px, ${(sy * hgt).toFixed(1)}px)`;
      }
    }
    for (const p of this.model.points) {
      const el = this.handles.get(p.id);
      if (!el) continue;
      const cw = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
      if (cw <= 1e-9) {
        el.style.display = 'none';
        continue;
      }
      const sx = ((m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / cw) * 0.5 + 0.5;
      const sy = 0.5 - ((m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / cw) * 0.5;
      el.style.display = '';
      el.style.transform = `translate(${(sx * w).toFixed(1)}px, ${(sy * hgt).toFixed(1)}px)`;
      let hidden = false;
      if (occlusion) {
        const to = sub([p.x, p.y, p.z], eye);
        const dist = Math.hypot(to[0], to[1], to[2]);
        const d = [to[0] / dist, to[1] / dist, to[2] / dist];
        const limit = dist - 1e-4 * size;
        hidden = this.faces.some((f) => rayTriangle(eye, d, f.tri) < limit);
      }
      el.classList.toggle('hidden', hidden);
    }
  }

  /** The plane or element under the pointer: {plane} or {object}, or null. */
  hitUnder(clientX, clientY) {
    const ray = this.ray(clientX, clientY);
    const res = this.stage.result;
    if (!ray || !res) return null;
    const hit = raycast(res.scene, (entry, lod) => res.cache.mesh(entry, lod), ray.origin, ray.dir, { skipFlags: FLAG_NO_COLLIDE });
    if (!hit) return null;
    // the hit element, or the nearest of its ancestors the modeller knows
    for (let el = res.doc.byUid.get(hit.uid); el; el = el.parent) {
      const known = this.uids.get(el.uid);
      if (known) return known;
    }
    return null;
  }

  clickScene(x, y, e) {
    const hit = this.hitUnder(e.clientX, e.clientY);
    if (this.tool === 'paint') {
      if (hit && hit.plane !== undefined) {
        this.change(() => {
          const p = this.model.planes.find((q) => q.id === hit.plane);
          if (p) p.paint = this.paint;
        });
      } else if (hit && hit.object !== undefined) {
        const f = O.findObject(this.model.objects, hit.object);
        if (f && this.paintable(f.node)) this.change(() => this.paintObject(f.node, this.paint));
      }
      return;
    }
    if (!hit) {
      if (this.selected.size || this.object !== null) {
        this.selected.clear();
        this.object = null;
        this.refreshSelection();
      }
      return;
    }
    if (hit.object !== undefined) return this.selectObject(hit.object);
    this.object = null;
    this.selectPlane(hit.plane, e.shiftKey || e.ctrlKey || e.metaKey);
  }

  showGroundPoint(e) {
    if (!this.stage || e.buttons) return;
    const ray = this.ray(e.clientX, e.clientY);
    if (!ray || Math.abs(ray.dir[1]) < 1e-6) return;
    const t = -ray.origin[1] / ray.dir[1];
    if (t <= 0) {
      $('#hud').textContent = '';
      return;
    }
    const at = (k) => formatNumber(ray.origin[k] + t * ray.dir[k], 2);
    $('#hud').textContent = `ground x ${at(0)}  z ${at(2)}`;
  }

  /** Where the pointer ray meets the drag plane through `origin`: level, or upright facing the camera. */
  dragHit(e, origin, upright) {
    const ray = this.ray(e.clientX, e.clientY);
    if (!ray) return null;
    let n = [0, 1, 0];
    if (upright) {
      const cam = this.stage.camera;
      const f = [cam.target[0] - cam.position[0], 0, cam.target[2] - cam.position[2]];
      const l = Math.hypot(f[0], f[2]);
      n = l > 1e-9 ? [f[0] / l, 0, f[2] / l] : [0, 0, 1];
    }
    const denom = dot(ray.dir, n);
    if (Math.abs(denom) < 1e-3) return null;
    const t = dot(sub(origin, ray.origin), n) / denom;
    if (t <= 0) return null;
    return [ray.origin[0] + t * ray.dir[0], ray.origin[1] + t * ray.dir[1], ray.origin[2] + t * ray.dir[2]];
  }

  /**
   * Drag a handle over the ground, or up and down with Shift, snapping to the grid.
   * @param {PointerEvent} e
   * @param {{get: () => number[], set: (p: number[]) => void, click: () => void, done: (moved: boolean) => void}} t
   */
  drag(e, t) {
    if (e.button !== 0 || !this.stage) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = [e.clientX, e.clientY];
    let moved = false;
    let upright = null;
    let origin = null;
    let grab = null;
    const snap = (v) => (this.view.snap ? Number(formatNumber(Math.round(v / this.view.snap) * this.view.snap, 9)) : v);

    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) < 4) return;
      if (!moved) {
        moved = true;
        this.beginLive();
      }
      // Shift switches between moving over the ground and moving up and down
      if (upright !== ev.shiftKey) {
        upright = ev.shiftKey;
        origin = t.get();
        grab = this.dragHit(ev, origin, upright);
      }
      const hit = grab && this.dragHit(ev, origin, upright);
      if (!hit) return;
      const next = origin.slice();
      if (upright) next[1] = snap(origin[1] + hit[1] - grab[1]);
      else {
        next[0] = snap(origin[0] + hit[0] - grab[0]);
        next[2] = snap(origin[2] + hit[2] - grab[2]);
      }
      t.set(next);
      this.version++;
      this.updatePreview();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!moved) return t.click();
      t.done();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** A point's handle: click to pick it, drag to move it. */
  startDrag(e, id) {
    const p = this.model.points.find((q) => q.id === id);
    const row = () => $(`#points tr[data-id="${id}"]`);
    this.drag(e, {
      get: () => [p.x, p.y, p.z],
      set: ([x, y, z]) => {
        p.x = x;
        p.y = y;
        p.z = z;
        const r = row();
        if (r) {
          r.classList.add('drag');
          for (const input of r.querySelectorAll('input')) input.value = fmt(p[input.dataset.k]);
        }
      },
      click: () => this.togglePick(id),
      done: () => {
        if (row()) row().classList.remove('drag');
        const notes = M.repairPlanes(this.model, new Set([id]));
        this.endLive();
        for (const n of notes) this.toast(n, 'warning');
      },
    });
  }

  /** The selected element's handle: drag it to move the element (its position attribute). */
  startObjectDrag(e) {
    const f = this.object !== null && O.findObject(this.model.objects, this.object);
    const anchor = f && O.anchorOf(this.model, this.object);
    if (!anchor) return;
    const digits = M.decimalsFor(Math.max(1, M.modelExtent(this.model)));
    let at = anchor.world.slice();
    this.drag(e, {
      get: () => at.slice(),
      set: (w) => {
        at = w;
        const local = mat4.transformPoint([0, 0, 0], anchor.inverse, w[0], w[1], w[2]);
        f.node.attrs.position = local.map((v) => formatNumber(v, digits)).join(',');
      },
      click: () => {},
      done: () => this.endLive(),
    });
  }
}
