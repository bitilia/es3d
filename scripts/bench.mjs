#!/usr/bin/env node
// ES3D benchmark (Node): file size and load pipeline of equivalent scenes
// stored as ES3D (markup, minified, compact), Wavefront OBJ and glTF
// binary (GLB, with and without EXT_mesh_gpu_instancing).
//
// glTF is read twice: by this project's importer (src/io/gltf.js, small and
// fast because it only needs what ES3D exports) and by three.js's
// GLTFLoader, the loader most web pages use, so that ES3D is compared with
// glTF as it is actually consumed and not only with our own reading of it.
// "ES3D (cached)" is a repeat load: the meshes come from the persistent
// geometry cache (src/cache/), here a store on disk; the browser benchmark
// measures the same with IndexedDB.
//
//   npm run bench                               all scenes, meshes exported at LOD 0
//   npm run bench -- --scenes forest,scan       a subset
//   npm run bench -- --lod 1                    export OBJ/GLB at a coarser LOD
//   npm run bench -- --quick                    fewer repetitions
//   npm run bench -- --out dir | --no-write     where results go
//   npm run bench -- --no-wasm                  the reader without its WebAssembly kernels
//   npm run bench -- --from docs/benchmark-results.json   rewrite the .md from saved results, measuring nothing
//
// Every scene starts as an ES3D document; OBJ and GLB are exported from the
// compiled scene, so all formats contain the same triangles. Load times are
// medians of repeated runs after a warm-up run ("ready" = everything needed
// for the GPU upload exists in memory: for ES3D that includes generating the
// level-0 meshes). Drawing is measured on real devices
// (docs/benchmark-devices.md).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/pipeline.js';
import { GeometryCache } from '../src/geometry/geometry-cache.js';
import { parse } from '../src/format/parse.js';
import { serialize } from '../src/format/serializer.js';
import { exportOBJ, objToScene } from '../src/io/obj.js';
import { exportGLB, glbToScene } from '../src/io/gltf.js';
import { exportableInstances } from '../src/io/external-scene.js';
import { VERTEX_BYTES } from '../src/render/geometry-pool.js';
import { BENCH_SCENES, benchSceneSource } from '../src/bench/scenes.js';
import { setWasmEnabled, wasmEnabled } from '../src/wasm/kernels.js';
import { restoreGeometry, saveGeometry } from '../src/cache/geometry-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = () => performance.now();

// ---------------------------------------------------------------------------
// options

function parseArgs(argv) {
  const o = { scenes: null, lod: 0, quick: false, out: path.join(ROOT, 'docs'), write: true, wasm: true, objLimit: 3e6, budget: 1500, maxRuns: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--scenes') o.scenes = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--lod') o.lod = Number(val());
    else if (a === '--quick') o.quick = true;
    else if (a === '--out') o.out = path.resolve(val());
    else if (a === '--no-write') o.write = false;
    else if (a === '--no-wasm') o.wasm = false;
    else if (a === '--obj-limit') o.objLimit = Number(val());
    else if (a === '--budget') o.budget = Number(val());
    else if (a === '--runs') o.maxRuns = Number(val());
    else if (a === '--from') o.from = path.resolve(val());
    else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/bench.mjs [--scenes a,b] [--lod n] [--quick] [--runs n] [--budget ms] [--obj-limit triangles] [--out dir] [--no-write] [--no-wasm] [--from results.json]');
      console.log('scenes: ' + BENCH_SCENES.map((s) => s.id).join(', '));
      process.exit(0);
    } else throw new Error(`Unknown option ${a} (try --help)`);
  }
  if (o.quick) {
    o.budget = 300;
    o.maxRuns = 3;
  }
  if (!(o.lod >= 0 && o.lod <= 3)) throw new Error('--lod must be 0..3');
  return o;
}

// ---------------------------------------------------------------------------
// measurement helpers

const gc = typeof globalThis.gc === 'function' ? globalThis.gc : () => {};

/**
 * Run fn repeatedly (after one warm-up run) and return the median of every
 * numeric field it reports. fn returns an object of stage timings in ms.
 */
function measure(fn, opts) {
  gc();
  const t0 = now();
  const warm = fn();
  const warmMs = now() - t0;
  const minRuns = warmMs > 2500 ? 1 : warmMs > 600 ? 2 : 3;
  const samples = [];
  const start = now();
  while (samples.length < opts.maxRuns && (samples.length < minRuns || now() - start < opts.budget)) {
    gc();
    samples.push(fn());
  }
  const out = { runs: samples.length };
  for (const k of Object.keys(warm)) {
    if (typeof warm[k] !== 'number') continue;
    const v = samples.map((s) => s[k]).sort((a, b) => a - b);
    out[k] = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  }
  return out;
}

function sizes(data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const quality = bytes.length <= 2e6 ? 11 : 9;
  const gz = zlib.gzipSync(bytes, { level: 9 }).length;
  const br = zlib.brotliCompressSync(bytes, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
  }).length;
  return { bytes: bytes.length, gzip: gz, brotli: br, brotliQuality: quality };
}

/** Triangles and GPU bytes of a RenderScene (unique meshes + 64 B per instance). */
function sceneFigures(scene, meshOf, lod) {
  let triangles = 0;
  const seen = new Set();
  let geometryBytes = 0;
  let uniqueTriangles = 0;
  for (const i of exportableInstances(scene)) {
    const entry = scene.geometries[scene.geom[i]];
    const mesh = meshOf(entry, Math.min(lod, entry.lods - 1));
    if (mesh.kind === 'triangles') triangles += mesh.primitiveCount;
    if (!seen.has(mesh)) {
      seen.add(mesh);
      geometryBytes += mesh.vertexCount * VERTEX_BYTES + mesh.indices.length * 4;
      if (mesh.kind === 'triangles') uniqueTriangles += mesh.primitiveCount;
    }
  }
  return { triangles, uniqueTriangles, uniqueMeshes: seen.size, gpuBytes: geometryBytes + scene.count * 64 };
}

// ---------------------------------------------------------------------------
// per-format loaders (each returns stage timings in ms)

function loadES3D(input, lod) {
  const t0 = now();
  const r = compile(input, { cache: new GeometryCache() });
  if (!r.ok) throw new Error(r.diagnostics.find((d) => d.severity === 'error').message);
  const t1 = now();
  for (const entry of r.scene.geometries) r.cache.mesh(entry, Math.min(lod, entry.lods - 1));
  const t2 = now();
  return { parse: r.timings.parse, build: r.timings.build + r.timings.flatten, geometry: t2 - t1, ready: t2 - t0, result: r };
}

function loadOBJ(obj, mtl) {
  const t0 = now();
  const o = objToScene(obj, mtl);
  const t1 = now();
  return { parse: t1 - t0, build: 0, geometry: 0, ready: t1 - t0, result: o };
}

function loadGLB(bytes) {
  const t0 = now();
  const g = glbToScene(bytes);
  const t1 = now();
  return { parse: t1 - t0, build: 0, geometry: 0, ready: t1 - t0, result: g };
}

const timingsOnly = (fn) => () => {
  const r = fn();
  delete r.result;
  return r;
};

/** measure() for loaders that finish asynchronously. */
async function measureAsync(fn, opts) {
  gc();
  const t0 = now();
  const warm = await fn();
  const warmMs = now() - t0;
  const minRuns = warmMs > 2500 ? 1 : warmMs > 600 ? 2 : 3;
  const samples = [];
  const start = now();
  while (samples.length < opts.maxRuns && (samples.length < minRuns || now() - start < opts.budget)) {
    gc();
    samples.push(await fn());
  }
  const out = { runs: samples.length };
  for (const k of Object.keys(warm)) {
    if (typeof warm[k] !== 'number') continue;
    const v = samples.map((s) => s[k]).sort((a, b) => a - b);
    out[k] = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  }
  return out;
}

/**
 * ES3D against glTF read by three.js in alternating rounds, garbage
 * collected before every load, so that a machine whose speed drifts (a
 * shared or thermally limited one) slows both alike: the median of the
 * per-round ratios, and each side's median ready time.
 */
async function versusThree(source, lod, loader, bytes, opts) {
  const es3d = () => loadES3D(source, lod).ready;
  const three = async () => (await loadGLBThree(loader, bytes)).ready;
  es3d();
  await three();
  const a = [], b = [], ratios = [];
  const start = now();
  while (ratios.length < opts.maxRuns && (ratios.length < 5 || now() - start < opts.budget * 2)) {
    let x, y;
    gc();
    if (ratios.length % 2) {
      x = es3d();
      gc();
      y = await three();
    } else {
      y = await three();
      gc();
      x = es3d();
    }
    a.push(x);
    b.push(y);
    ratios.push(x / y);
  }
  const median = (v) => {
    const s = [...v].sort((p, q) => p - q);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  return { reference: 'three-glb-inst', es3d: median(a), three: median(b), ratio: median(ratios), rounds: ratios.length };
}

/**
 * A geometry store in files: what the browser's IndexedDB is for the cached
 * ES3D load. Read synchronously, one read for the whole record (Node's
 * asynchronous readFile reads in chunks on another thread and costs several
 * times as much for a record this size).
 */
function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key) => path.join(dir, `${key}.es3g`);
  return {
    kind: 'files',
    async get(key) {
      let fd;
      try {
        fd = fs.openSync(file(key), 'r');
      } catch {
        return null;
      }
      try {
        const out = new ArrayBuffer(fs.fstatSync(fd).size);
        fs.readSync(fd, new Uint8Array(out), 0, out.byteLength, 0);
        return out;
      } finally {
        fs.closeSync(fd);
      }
    },
    async put(key, data) {
      fs.writeFileSync(file(key), new Uint8Array(data));
    },
    async delete(key) {
      await fs.promises.rm(file(key), { force: true });
    },
  };
}

/** ES3D with its meshes read from the store instead of generated. */
async function loadES3DCached(input, lod, store) {
  const t0 = now();
  const r = compile(input, { cache: new GeometryCache() });
  if (!r.ok) throw new Error(r.diagnostics.find((d) => d.severity === 'error').message);
  const t1 = now();
  const restored = await restoreGeometry(r.cache, store, { timeout: Infinity });
  const t2 = now();
  for (const entry of r.scene.geometries) r.cache.mesh(entry, Math.min(lod, entry.lods - 1));
  const t3 = now();
  return { parse: r.timings.parse, build: r.timings.build + r.timings.flatten, restore: t2 - t1, geometry: t3 - t2, ready: t3 - t0, hit: restored.hit, generated: r.cache.stats.generated, bytes: restored.bytes };
}

let threeLoader = null;
/** three.js's GLTFLoader (a dev dependency), or null when it is not installed. */
async function gltfLoader() {
  if (threeLoader === null) {
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      threeLoader = new GLTFLoader();
    } catch {
      threeLoader = false;
    }
  }
  return threeLoader || null;
}

/** GLB parsed by three.js into a scene of BufferGeometry, ready to upload. */
async function loadGLBThree(loader, bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const t0 = now();
  await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
  const t1 = now();
  return { parse: t1 - t0, build: 0, geometry: 0, ready: t1 - t0 };
}

// ---------------------------------------------------------------------------

/** Link speed of the download estimate in the report (Mbit/s). */
const DOWNLOAD_MBIT = 25;

const FORMAT_LABELS = {
  es3d: 'ES3D markup (as authored)',
  'es3d-min': 'ES3D markup, minified',
  'es3d-compact': 'ES3D compact syntax',
  obj: 'OBJ + MTL',
  glb: 'glTF binary (GLB)',
  'glb-inst': 'GLB + EXT_mesh_gpu_instancing',
  'glb-q': 'GLB + instancing + KHR_mesh_quantization',
  'es3d-cached': 'ES3D, meshes from the geometry cache',
  'three-glb': 'GLB, read by three.js',
  'three-glb-inst': 'GLB + instancing, read by three.js',
};

async function benchScene(desc, opts, shared) {
  const source = await benchSceneSource(desc, async (file) => fs.readFileSync(path.join(ROOT, 'docs', 'public', 'examples', file), 'utf8'));
  const doc = parse(source);
  if (!doc.ok) throw new Error(`${desc.id}: ${doc.diagnostics[0].message}`);
  const lod = opts.lod;
  const base = compile(source);
  const meshOf = (e, l) => base.cache.mesh(e, l);
  const fig = sceneFigures(base.scene, meshOf, lod);
  const result = {
    id: desc.id,
    label: desc.label,
    note: desc.note,
    instances: base.scene.count,
    exportedInstances: exportableInstances(base.scene).length,
    geometries: base.scene.geometries.length,
    materials: base.scene.materials.length,
    elements: doc.byUid.size,
    triangles: fig.triangles,
    uniqueTriangles: fig.uniqueTriangles,
    formats: [],
  };
  const log = (f) => {
    const s = (n) => (n === undefined || n === null ? '-' : n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} kB`);
    const t = (n) => (n === undefined ? '-' : `${n.toFixed(n < 10 ? 2 : 1)} ms`);
    if (f.skipped) console.log(`  ${f.format.padEnd(13)} skipped: ${f.skipped}`);
    else console.log(`  ${f.format.padEnd(13)} ${s(f.bytes).padStart(10)} gz ${s(f.gzip).padStart(10)} br ${s(f.brotli).padStart(10)}   parse ${t(f.load.parse).padStart(9)}  ready ${t(f.load.ready).padStart(9)}  (${f.load.runs} runs)`);
  };

  // ES3D variants: identical documents in different encodings
  const variants = [
    ['es3d', source],
    ['es3d-min', serialize(doc, { syntax: 'xml', pretty: false })],
    ['es3d-compact', serialize(doc, { syntax: 'compact', pretty: false })],
  ];
  let geometryMs = null;
  for (const [format, data] of variants) {
    const load = measure(timingsOnly(() => loadES3D(data, lod)), opts);
    if (geometryMs === null) geometryMs = load.geometry;
    else {
      // build and geometry do not depend on the encoding: report the canonical figures
      load.geometry = geometryMs;
    }
    load.ready = load.parse + load.build + load.geometry;
    const f = { format, label: FORMAT_LABELS[format], ...sizes(data), load, gpuBytes: fig.gpuBytes, lossless: true };
    result.formats.push(f);
    log(f);
  }

  // a repeat load: the meshes of the first one, stored and read back
  {
    const store = fileStore(shared.storeDir);
    const first = loadES3D(source, lod).result;
    const saved = await saveGeometry(first.cache, store);
    if (saved.saved || saved.reason === 'up to date') {
      const load = await measureAsync(() => loadES3DCached(source, lod, store), opts);
      const f = { format: 'es3d-cached', label: FORMAT_LABELS['es3d-cached'], ...sizes(source), load, cacheBytes: saved.bytes, gpuBytes: fig.gpuBytes, lossless: true };
      result.formats.push(f);
      log(f);
    } else {
      const f = { format: 'es3d-cached', label: FORMAT_LABELS['es3d-cached'], skipped: `nothing to cache (${saved.reason})` };
      result.formats.push(f);
      log(f);
    }
  }

  // mesh formats (shared between scenes that render the same content)
  const key = `${desc.file || desc.id}|${lod}`;
  let meshFormats = shared.get(key);
  if (meshFormats) {
    for (const f of meshFormats) {
      result.formats.push({ ...f, sameAs: meshFormats.sceneId });
      log(f);
    }
    await compareWithThree(result, source, lod, meshFormats.instanced, opts);
    return result;
  }
  meshFormats = [];
  meshFormats.sceneId = desc.id;
  if (fig.triangles > opts.objLimit) {
    const f = { format: 'obj', label: FORMAT_LABELS.obj, skipped: `${(fig.triangles / 1e6).toFixed(1)} M triangles exceed --obj-limit ${opts.objLimit / 1e6} M`, triangles: fig.triangles, vertices: null };
    meshFormats.push(f);
    log(f);
  } else {
    const t0 = now();
    const o = exportOBJ(base.scene, meshOf, { lod });
    const exportMs = now() - t0;
    const load = measure(timingsOnly(() => loadOBJ(o.obj, o.mtl)), opts);
    const check = loadOBJ(o.obj, o.mtl).result;
    const imported = sceneFigures(check.scene, check.meshOf, 0);
    const f = {
      format: 'obj',
      label: FORMAT_LABELS.obj,
      ...sizes(o.obj + o.mtl),
      load,
      exportMs,
      gpuBytes: imported.gpuBytes,
      vertices: o.vertices,
      triangles: o.triangles,
      equivalent: imported.triangles === fig.triangles,
      lossless: false,
    };
    meshFormats.push(f);
    log(f);
  }
  for (const [format, glbOpts] of [['glb', { instancing: false }], ['glb-inst', { instancing: true }], ['glb-q', { instancing: true, quantize: true }]]) {
    const t0 = now();
    const bytes = exportGLB(base.scene, meshOf, { lod, ...glbOpts });
    const exportMs = now() - t0;
    const load = measure(timingsOnly(() => loadGLB(bytes)), opts);
    const g = loadGLB(bytes).result;
    const imported = sceneFigures(g.scene, g.meshOf, 0);
    const f = {
      format,
      label: FORMAT_LABELS[format],
      ...sizes(bytes),
      load,
      exportMs,
      gpuBytes: imported.gpuBytes,
      equivalent: imported.triangles === fig.triangles,
      lossless: false,
    };
    meshFormats.push(f);
    log(f);
    // the same file through three.js
    if (format === 'glb-inst') meshFormats.instanced = bytes;
    const three = format === 'glb-q' ? null : await gltfLoader();
    if (three) {
      const tf = `three-${format}`;
      const tload = await measureAsync(() => loadGLBThree(three, bytes), opts);
      const t = { format: tf, label: FORMAT_LABELS[tf], ...sizes(bytes), load: tload, gpuBytes: imported.gpuBytes, equivalent: f.equivalent, lossless: false };
      meshFormats.push(t);
      log(t);
    }
  }
  shared.set(key, meshFormats);
  result.formats.push(...meshFormats);
  await compareWithThree(result, source, lod, meshFormats.instanced, opts);
  return result;
}

async function compareWithThree(result, source, lod, bytes, opts) {
  const loader = bytes ? await gltfLoader() : null;
  if (!loader) return;
  result.versusThree = await versusThree(source, lod, loader, bytes, opts);
  const v = result.versusThree;
  console.log(`  es3d ÷ three-glb-inst, alternating rounds: ${v.ratio.toFixed(2)} (${v.es3d.toFixed(2)} ms against ${v.three.toFixed(2)} ms, ${v.rounds} rounds)`);
}

/** Least-squares fit bytes ~ a*vertices + b*triangles over the OBJ files that were written. */
function estimateSkippedOBJ(results) {
  const pts = [];
  for (const s of results) {
    const f = s.formats.find((x) => x.format === 'obj' && !x.skipped && !x.sameAs);
    if (f && f.triangles > 1000) pts.push([f.vertices, f.triangles, f.bytes]);
  }
  if (pts.length < 2) return;
  let vv = 0, vt = 0, tt = 0, vs = 0, ts = 0;
  for (const [v, t, s] of pts) {
    vv += v * v;
    vt += v * t;
    tt += t * t;
    vs += v * s;
    ts += t * s;
  }
  const det = vv * tt - vt * vt;
  if (!det) return;
  const a = (vs * tt - ts * vt) / det;
  const b = (ts * vv - vs * vt) / det;
  for (const s of results) {
    const f = s.formats.find((x) => x.format === 'obj' && x.skipped);
    if (!f) continue;
    // vertices of the exported meshes are not counted for skipped scenes; use the triangle ratio of the fit
    const ratio = pts.reduce((acc, [v, t]) => acc + v / t, 0) / pts.length;
    f.estimatedBytes = Math.round(a * f.triangles * ratio + b * f.triangles);
  }
}

// ---------------------------------------------------------------------------
// reporting

const kB = (n) => (n === null || n === undefined ? '–' : n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(1)} kB` : `${(n / 1e6).toFixed(2)} MB`);
const ms = (n) => (n === null || n === undefined ? '–' : n < 1 ? `${n.toFixed(2)}` : n < 100 ? n.toFixed(1) : Math.round(n).toLocaleString('en-US'));
const ratio = (a, b) => (a && b ? (a >= b ? `${(a / b).toFixed(a / b < 10 ? 1 : 0)}×` : `1/${(b / a).toFixed(b / a < 10 ? 1 : 0)}`) : '–');

function markdown(report) {
  const L = [];
  const e = report.environment;
  L.push('# ES3D benchmark results', '');
  L.push(`Generated by \`npm run bench\` on ${report.generated.slice(0, 10)}. Node ${e.node}, ${e.cpu} (${e.cores} threads), ${e.platform}. ES3D reader ${e.wasm ? 'with its WebAssembly kernels' : 'in JavaScript only (--no-wasm)'}.`);
  L.push(`OBJ and GLB are exported from the compiled ES3D scenes at level of detail ${report.settings.lod}, so every format holds the same triangles.`);
  L.push('Sizes: gzip level 9, brotli quality 11 (quality 9 above 2 MB). Times are medians in milliseconds after a warm-up run.', '');
  L.push('**Ready** = parse + scene build + mesh generation: everything needed for the GPU upload is in memory. For glTF read by three.js: GLTFLoader has built its scene of BufferGeometry. For *ES3D (cached)*: parse + build + reading the meshes an earlier load stored (geometry cache, here on disk; in browsers IndexedDB).');
  L.push('**GPU data** = unique vertex/index data (32 B per vertex, 4 B per index) + 64 B per instance in this renderer.', '');

  L.push('## Compressed size (gzip)', '');
  const fmts = ['es3d', 'es3d-min', 'es3d-compact', 'obj', 'glb', 'glb-inst', 'glb-q'];
  L.push(`| Scene | Triangles | ${fmts.map((f) => f).join(' | ')} | GLB-inst ÷ ES3D |`);
  L.push(`|---|---:|${fmts.map(() => '---:').join('|')}|---:|`);
  for (const s of report.scenes) {
    const g = (f) => s.formats.find((x) => x.format === f);
    const cell = (f) => {
      const x = g(f);
      if (!x) return '–';
      if (x.skipped) return x.estimatedBytes ? `~${kB(x.estimatedBytes)} raw*` : 'skipped';
      return kB(x.gzip);
    };
    const es = g('es3d-min'), gi = g('glb-inst');
    L.push(`| ${s.label} | ${s.triangles.toLocaleString('en-US')} | ${fmts.map(cell).join(' | ')} | ${gi && es ? ratio(gi.gzip, es.gzip) : '–'} |`);
  }
  L.push('', '\\* OBJ not written (see `--obj-limit`); the raw size is estimated from the other OBJ exports.', '');

  L.push('## Time to ready (ms)', '');
  const tf = ['es3d', 'es3d-cached', 'es3d-compact', 'obj', 'glb', 'glb-inst', 'three-glb', 'three-glb-inst', 'glb-q'].filter((f) => report.scenes.some((s) => s.formats.some((x) => x.format === f)));
  L.push(`| Scene | ${tf.join(' | ')} | ES3D parse / build / geometry |`);
  L.push(`|---|${tf.map(() => '---:').join('|')}|---|`);
  for (const s of report.scenes) {
    const g = (f) => s.formats.find((x) => x.format === f);
    const cell = (f) => {
      const x = g(f);
      return !x || x.skipped ? '–' : ms(x.load.ready);
    };
    const es = g('es3d');
    L.push(`| ${s.label} | ${tf.map(cell).join(' | ')} | ${ms(es.load.parse)} / ${ms(es.load.build)} / ${ms(es.load.geometry)} |`);
  }
  L.push('');

  // ES3D against glTF as most pages read it
  if (report.scenes.some((s) => s.formats.some((x) => x.format.startsWith('three-')))) {
    L.push('## ES3D against glTF in three.js', '');
    L.push('Ready time of ES3D divided by the faster of plain and instanced GLB read by three.js\'s GLTFLoader (below 1: ES3D is ready first). *Alternating*: ES3D against instanced GLB in three.js measured in alternating rounds (the median of the per-round ratios), which a machine whose speed drifts between the measurements above does not skew. Size: GLB + instancing ÷ ES3D, gzip.', '');
    L.push('| Scene | ES3D | Alternating | ES3D (cached) | GLB, our importer | Size |');
    L.push('|---|---:|---:|---:|---:|---:|');
    for (const s of report.scenes) {
      const g = (f) => s.formats.find((x) => x.format === f && !x.skipped);
      const refs = ['three-glb', 'three-glb-inst'].map(g).filter(Boolean);
      if (!refs.length) continue;
      const ref = Math.min(...refs.map((x) => x.load.ready));
      const r = (f) => (g(f) ? `${(g(f).load.ready / ref).toFixed(2)}×` : '–');
      const gi = g('glb-inst'), es = g('es3d');
      const alt = s.versusThree ? `${s.versusThree.ratio.toFixed(2)}×` : '–';
      L.push(`| ${s.label} | ${r('es3d')} | ${alt} | ${r('es3d-cached')} | ${r('glb-inst')} | ${gi && es ? ratio(gi.gzip, es.gzip) : '–'} |`);
    }
    L.push('');
    // a visitor downloads the file first: an estimate from the compressed sizes
    const link = DOWNLOAD_MBIT;
    const dl = (bytes) => (bytes * 8) / (link * 1e3);
    L.push(`### With the download (estimate at ${link} Mbit/s)`, '');
    L.push(`Ready time plus the gzip-compressed file at ${link} Mbit/s, ignoring latency, which both pay alike. A first visit downloads; a repeat visit with a fresh HTTP cache does not (then the table above applies).`, '');
    L.push('| Scene | ES3D (gzip) | ES3D: download + ready | GLB + inst. (gzip) | three.js: download + ready |');
    L.push('|---|---:|---:|---:|---:|');
    for (const s of report.scenes) {
      const g = (f) => s.formats.find((x) => x.format === f && !x.skipped);
      const es = g('es3d'), gi = g('glb-inst'), t = g('three-glb-inst');
      if (!es || !gi || !t) continue;
      L.push(`| ${s.label} | ${kB(es.gzip)} | ${ms(dl(es.gzip) + es.load.ready)} | ${kB(gi.gzip)} | ${ms(dl(gi.gzip) + t.load.ready)} |`);
    }
    L.push('');
  }

  for (const s of report.scenes) {
    L.push(`## ${s.label}`, '');
    L.push(`${s.note} ${s.instances.toLocaleString('en-US')} instances, ${s.geometries} unique geometries, ${s.materials} materials, ${s.elements.toLocaleString('en-US')} elements; ${s.triangles.toLocaleString('en-US')} triangles rendered at LOD ${report.settings.lod} (${s.uniqueTriangles.toLocaleString('en-US')} unique).`, '');
    L.push('| Format | Raw | gzip | brotli | Parse | Ready | GPU data |');
    L.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const f of s.formats) {
      if (f.skipped) {
        L.push(`| ${f.label} | ${f.estimatedBytes ? `~${kB(f.estimatedBytes)} (est.)` : '–'} | – | – | – | – | – |`);
        continue;
      }
      L.push(`| ${f.label}${f.format === 'glb-q' ? ' (lossy)' : ''} | ${kB(f.bytes)} | ${kB(f.gzip)} | ${kB(f.brotli)} | ${ms(f.load.parse)} | ${ms(f.load.ready)} | ${kB(f.gpuBytes)} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.from) {
    const md = opts.from.replace(/\.json$/, '.md');
    fs.writeFileSync(md, markdown(JSON.parse(fs.readFileSync(opts.from, 'utf8'))) + '\n');
    console.log(`wrote ${path.relative(process.cwd(), md)}`);
    return;
  }
  setWasmEnabled(opts.wasm);
  const list = opts.scenes ? opts.scenes.map((id) => BENCH_SCENES.find((s) => s.id === id) || (() => { throw new Error(`Unknown scene ${id}`); })()) : BENCH_SCENES;
  if (!globalThis.gc) console.log('(run with node --expose-gc for steadier timings; npm run bench does this)');
  const shared = new Map();
  // the cached ES3D load's store, emptied first so that every record is this run's
  shared.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es3d-geometry-'));
  const scenes = [];
  const t0 = now();
  for (const desc of list) {
    console.log(`\n${desc.label} (${desc.id})`);
    scenes.push(await benchScene(desc, opts, shared));
  }
  fs.rmSync(shared.storeDir, { recursive: true, force: true });
  estimateSkippedOBJ(scenes);
  const cpu = os.cpus()[0];
  const report = {
    generated: new Date().toISOString(),
    environment: { node: process.versions.node, platform: `${os.platform()} ${os.arch()}`, cpu: cpu ? cpu.model.trim() : 'unknown', cores: os.cpus().length, wasm: wasmEnabled() },
    settings: { lod: opts.lod, objTriangleLimit: opts.objLimit, gzipLevel: 9, brotliQuality: '11 (9 above 2 MB)', budgetMs: opts.budget, maxRuns: opts.maxRuns, vertexBytes: VERTEX_BYTES },
    scenes,
  };
  console.log(`\nfinished in ${((now() - t0) / 1000).toFixed(1)} s`);
  if (opts.write) {
    fs.mkdirSync(opts.out, { recursive: true });
    // runs without the WebAssembly kernels go to their own files, next to the default results
    const suffix = (opts.lod ? `-lod${opts.lod}` : '') + (opts.wasm ? '' : '-js');
    const jsonFile = path.join(opts.out, `benchmark-results${suffix}.json`);
    const mdFile = path.join(opts.out, `benchmark-results${suffix}.md`);
    fs.writeFileSync(jsonFile, JSON.stringify(report, null, 1) + '\n');
    fs.writeFileSync(mdFile, markdown(report) + '\n');
    console.log(`wrote ${path.relative(process.cwd(), jsonFile)} and ${path.relative(process.cwd(), mdFile)}`);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
