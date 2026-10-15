// The converter page. Files come in. ES3D, glTF, OBJ, STL or STEP goes out.
// All of that happens in the browser. The conversion itself lives in
// src/io/convert.js and is shared with the command-line tool.

import { importFiles, exportFormat, detectKind, INPUT_KINDS, OUTPUT_FORMATS } from '../../src/io/convert.js';
import { compile, generateGeometry } from '../../src/pipeline.js';
import { exportableInstances } from '../../src/io/external-scene.js';
import { gzip, gunzip, isGzip } from '../../src/io/compression.js';
import { download } from '../../src/io/download.js';
import { createViewer } from './viewer.js';
import { writeHandoff, HANDOFF_LIMIT } from './handoff.js';

const $ = (s) => document.querySelector(s);

const SAMPLES = {
  svg: ['../samples/es3d-badge.svg'],
  obj: ['../samples/rock.obj', '../samples/rock.mtl'],
  stl: ['../samples/gem.stl'],
  glb: ['../samples/stairs.glb'],
  es3d: ['../es3d-logo.es3d'],
};

/** Formats offered first for each kind of input. */
const ES3D_OUTPUTS = ['es3d', 'es3d-min', 'es3d-compact'];
const MESH_OUTPUTS = ['glb', 'obj', 'stl', 'step'];
const TEXT_PREVIEW_LIMIT = 300_000;

const state = { files: [], kind: null, result: null, viewer: null, viewerFailed: false, busy: false, again: false };

const fmtBytes = (n) => (n < 1000 ? `${n} bytes` : n < 1e6 ? `${(n / 1e3).toFixed(1)} kB` : `${(n / 1e6).toFixed(2)} MB`);
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const byteLength = (data) => (typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c instanceof Node ? c : String(c));
  return e;
}

function setStatus(msg, error = false) {
  const s = $('#status');
  s.textContent = msg;
  s.classList.toggle('error', error);
  s.style.whiteSpace = error ? 'pre-wrap' : '';
}

function populateFormats() {
  const sel = $('#format');
  const es3dInput = state.kind === 'es3d';
  const order = es3dInput ? [...MESH_OUTPUTS, ...ES3D_OUTPUTS] : [...ES3D_OUTPUTS, ...MESH_OUTPUTS];
  const previous = sel.value;
  sel.replaceChildren(...order.map((id) => el('option', { value: id }, OUTPUT_FORMATS[id].label)));
  sel.value = previous && order.includes(previous) && state.kind === state.formatKind ? previous : order[0];
  state.formatKind = state.kind;
  updateLodBox();
}

function updateLodBox() {
  $('#lod-box').hidden = !MESH_OUTPUTS.includes($('#format').value);
}

function updateOptionGroups() {
  const k = state.kind;
  for (const g of document.querySelectorAll('.option-group')) {
    const f = g.dataset.for;
    g.hidden = !((f === 'svg' && k === 'svg') || (f === 'mesh' && ['obj', 'stl', 'step', 'gltf', 'glb'].includes(k)) || (f === 'stl' && (k === 'stl' || k === 'step')));
  }
}

function numberInput(sel, fallback, min = -Infinity, max = Infinity) {
  const v = Number($(sel).value);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}

function options() {
  const precision = $('#mesh-precision').value;
  const normals = $('#mesh-normals').value;
  return {
    svg: {
      size: numberInput('#svg-size', 10, 1e-6) || 10,
      depth: numberInput('#svg-depth', 4, 0, 100) / 100,
      bevel: numberInput('#svg-bevel', 0, 0, 50) / 100,
      strokes: $('#svg-strokes').checked,
      base: $('#svg-base').checked,
    },
    mesh: {
      precision: precision === 'auto' || precision === 'exact' ? precision : Number(precision),
      normals: normals === 'auto' ? 'auto' : normals === 'true',
      uvs: $('#mesh-uvs').checked,
      smooth: numberInput('#mesh-smooth', 30, 0, 180),
    },
    stl: { up: (document.querySelector('input[name="stl-up"]:checked') || {}).value || 'z' },
  };
}

async function setFiles(files, origin = '') {
  if (!files.length) return;
  const main = files.find((f) => !/\.(mtl|bin|png|jpe?g|webp|gif|tga|bmp|ktx2|dds)$/i.test(f.name)) || files[0];
  let bytes = main.bytes;
  if (isGzip(bytes)) bytes = await gunzip(bytes);
  const kind = detectKind(main.name.replace(/\.gz$/i, '').replace(/\.svgz$/i, '.svg'), bytes);
  state.files = files;
  state.kind = kind;
  const list = files.map((f) => `${f.name} (${fmtBytes(f.bytes.length)})`).join(', ');
  $('#file-info').textContent = kind ? `${origin}${list}: ${INPUT_KINDS[kind]}.` : `${origin}${list}: not a file type the converter knows.`;
  $('#convert').disabled = !kind;
  updateOptionGroups();
  populateFormats();
  if (!kind) {
    setStatus(`${main.name} is not an SVG, OBJ, STL, STEP, glTF or ES3D file.`, true);
    $('#result').hidden = true;
    return;
  }
  await convert();
}

async function readFileList(list) {
  return Promise.all([...list].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

async function loadSample(id) {
  setStatus('Loading the sample…');
  try {
    const files = await Promise.all(
      SAMPLES[id].map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return { name: url.split('/').pop(), bytes: new Uint8Array(await res.arrayBuffer()) };
      }),
    );
    await setFiles(files, 'Sample: ');
  } catch (e) {
    setStatus(`The sample could not be loaded: ${e.message}`, true);
  }
}

function triangleCounts(c) {
  const g = generateGeometry(c, 0);
  let drawn = 0;
  for (const i of exportableInstances(c.scene)) {
    const m = c.cache.mesh(c.scene.geometries[c.scene.geom[i]], 0);
    if (m.kind === 'triangles') drawn += m.primitiveCount;
  }
  return { unique: g.uniqueTriangles, drawn };
}

async function convert() {
  if (!state.files.length || !state.kind) return;
  if (state.busy) {
    state.again = true;
    return;
  }
  state.busy = true;
  $('#convert').disabled = true;
  setStatus('Converting…');
  $('#messages').replaceChildren();
  await nextFrame();
  try {
    const t0 = performance.now();
    const imported = await importFiles(state.files, options());
    const compiled = compile(imported.text);
    if (!compiled.ok) {
      const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
      throw new Error(`The ES3D document has ${errors.length} error${errors.length === 1 ? '' : 's'}:\n\n${errors.slice(0, 5).map((d) => d.format(compiled.doc.lineIndex)).join('\n\n')}`);
    }
    const format = $('#format').value;
    const out = exportFormat(imported.text, format, { baseName: imported.title, lod: Number($('#lod').value), compiled });
    const ms = performance.now() - t0;
    state.result = { imported, compiled, out, format, ms, triangles: triangleCounts(compiled) };
    await showResult();
    setStatus(`Done in ${ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`}: ${out.files.map((f) => f.name).join(' and ')}.`);
  } catch (e) {
    console.error(e);
    state.result = null;
    $('#result').hidden = true;
    setStatus(e.message || String(e), true);
  } finally {
    state.busy = false;
    $('#convert').disabled = !state.kind;
    if (state.again) {
      state.again = false;
      convert();
    }
  }
}

async function showResult() {
  const { imported, compiled, out, format, triangles } = state.result;
  const msgs = $('#messages');
  for (const n of imported.notes) msgs.append(el('li', {}, n));
  for (const w of imported.warnings) msgs.append(el('li', {}, el('b', {}, 'Note: '), w));
  for (const d of compiled.diagnostics.filter((x) => x.severity === 'warning').slice(0, 5)) msgs.append(el('li', {}, el('b', {}, 'Warning: '), d.message));

  $('#result').hidden = false;
  const es3dText = imported.text;
  const es3dBytes = new TextEncoder().encode(es3dText);
  const inputBytes = state.files.reduce((n, f) => n + f.bytes.length, 0);
  const outBytes = out.files.reduce((n, f) => n + byteLength(f.data), 0);
  const [es3dGz, outGz] = await Promise.all([gzip(es3dBytes), Promise.all(out.files.map((f) => gzip(f.data)))]);
  const outGzBytes = outGz.reduce((n, g) => n + g.length, 0);
  const scene = compiled.scene;
  const rows = [
    ['Input', `${state.files.map((f) => f.name).join(' + ')}: ${INPUT_KINDS[imported.kind]}, ${fmtBytes(inputBytes)}`],
    ['ES3D document', `${fmtBytes(es3dBytes.length)} (${fmtBytes(es3dGz.length)} with gzip)`],
    ['Output', `${out.files.map((f) => f.name).join(' + ')}: ${OUTPUT_FORMATS[format].label}, ${fmtBytes(outBytes)} (${fmtBytes(outGzBytes)} with gzip)`],
    ['Scene', `${fmtInt(scene.count)} instance${scene.count === 1 ? '' : 's'} of ${fmtInt(scene.geometries.length)} shape${scene.geometries.length === 1 ? '' : 's'}, ${scene.materials.length} material${scene.materials.length === 1 ? '' : 's'}`],
    ['Triangles', `${fmtInt(triangles.drawn)} at the finest detail (${fmtInt(triangles.unique)} unique)`],
  ];
  $('#stats tbody').replaceChildren(...rows.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, v))));

  const main = out.files[0];
  const textOut = typeof main.data === 'string';
  const shown = textOut ? main.data : es3dText;
  $('#output-label').textContent = textOut
    ? `${main.name}${shown.length > TEXT_PREVIEW_LIMIT ? ` (the first ${fmtInt(TEXT_PREVIEW_LIMIT)} characters; download the file for all of it)` : ''}:`
    : `${main.name} is a binary file. This is the ES3D document it was made from${shown.length > TEXT_PREVIEW_LIMIT ? ` (the first ${fmtInt(TEXT_PREVIEW_LIMIT)} characters)` : ''}:`;
  $('#output').value = shown.length > TEXT_PREVIEW_LIMIT ? shown.slice(0, TEXT_PREVIEW_LIMIT) : shown;
  $('#copy').textContent = textOut ? 'Copy text' : 'Copy ES3D text';
  $('#download').textContent = `Download ${out.files.map((f) => f.name).join(' + ')}`;

  const viewer = await ensureViewer();
  if (viewer) viewer.show(compiled);
}

async function ensureViewer() {
  if (state.viewer || state.viewerFailed) return state.viewer;
  const box = $('#preview');
  try {
    state.viewer = await createViewer(box, { interactive: true });
    box.append(el('span', { class: 'overlay' }, `ES3D renderer · ${state.viewer.kind}`));
  } catch (e) {
    state.viewerFailed = true;
    box.replaceChildren(el('span', { class: 'overlay' }, `No preview: this browser has neither WebGPU nor WebGL2 (${e.message}).`));
  }
  return state.viewer;
}

async function copyText() {
  const r = state.result;
  if (!r) return;
  const main = r.out.files[0];
  const text = typeof main.data === 'string' ? main.data : r.imported.text;
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copied to the clipboard.');
  } catch {
    const ta = $('#output');
    ta.focus();
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    setStatus(ok ? 'Copied to the clipboard.' : 'Copying is blocked here: select the text and copy it yourself.', !ok);
  }
}

function openInStudio() {
  const r = state.result;
  if (!r) return;
  const main = r.out.files[0];
  const es3d = typeof main.data === 'string' && r.format.startsWith('es3d') ? main.data : r.imported.text;
  const name = `${r.imported.title}.es3d`;
  if (es3d.length > HANDOFF_LIMIT) {
    setStatus(`This document is too large to hand over (${fmtBytes(es3d.length)}). Download it and open it in ES3D Studio with Open….`, true);
    return;
  }
  if (!writeHandoff(name, es3d)) {
    setStatus('The browser does not allow storing the document for ES3D Studio here. Download it and open it in ES3D Studio with Open….', true);
    return;
  }
  location.href = '../studio/?handoff=1';
}

function bind() {
  const drop = $('#drop');
  $('#file').addEventListener('change', async (e) => {
    if (e.target.files.length) await setFiles(await readFileList(e.target.files));
    e.target.value = '';
  });
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const ev of ['dragleave', 'dragend']) drop.addEventListener(ev, () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files.length) await setFiles(await readFileList(e.dataTransfer.files));
  });
  // a file dropped next to the drop zone should not navigate away from the page
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  for (const b of document.querySelectorAll('[data-sample]')) b.addEventListener('click', () => loadSample(b.dataset.sample));
  $('#convert').addEventListener('click', () => convert());
  $('#format').addEventListener('change', () => {
    updateLodBox();
    convert();
  });
  $('#lod').addEventListener('change', () => convert());
  let timer = 0;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => convert(), 350);
  };
  for (const input of document.querySelectorAll('.option-group input, .option-group select')) input.addEventListener('change', later);
  $('#download').addEventListener('click', () => {
    const r = state.result;
    if (!r) return;
    r.out.files.forEach((f, i) => setTimeout(() => download(f.name, f.data, f.mime), i * 500));
  });
  $('#copy').addEventListener('click', copyText);
  $('#studio').addEventListener('click', openInStudio);
  populateFormats();
  const sample = new URLSearchParams(location.search).get('sample');
  if (sample && SAMPLES[sample]) loadSample(sample);
}

bind();
