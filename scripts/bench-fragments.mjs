#!/usr/bin/env node
// Stage fragments: what adding, replacing, hiding and removing a tile costs
// the main thread, and what a frame costs while 50 tiles stream in under the
// default change budget. Not part of `npm test`.
//
//   node --expose-gc scripts/bench-fragments.mjs            both tile sizes
//   node scripts/bench-fragments.mjs --extrusions 150        one size
//
// Tiles are generated like map tiles: building footprints (4 to 10 corners)
// extruded to random heights, eight shared materials, a few road segments.
// Two sizes: about 150 extrusions (an OpenStreetMap tile of central London:
// 2,374 extrusions in 16 tiles) and about 1,000.
//
// What runs here is what runs on the page's main thread, without the GPU:
// compile (immediate), the payload a worker would send unpacked into the
// stage (prepared: preparePayload, then a structured clone with transfer, as
// postMessage does), placing, and the frame builder with its tessellation
// budget (renderer.js PROGRESSIVE_BUDGET_MS). Drawing itself (about 1 ms a
// frame for the full scene, measured in Chrome) is not included.

import { compile, GeometryCache } from '../src/pipeline.js';
import { mulberry32 } from '../src/math/random.js';
import { FragmentStage } from '../src/scene/fragments.js';
import { Prepared, preparePayload } from '../src/scene/prepared.js';
import { FrameBuilder } from '../src/render/frame-builder.js';
import { GeometryPool } from '../src/render/geometry-pool.js';
import { Camera } from '../src/render/camera.js';
import { PROGRESSIVE_BUDGET_MS } from '../src/render/renderer.js';
import { CHANGE_BUDGET_MS } from '../src/render/stage.js';

const now = () => performance.now();
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
};
const max = (a) => a.reduce((m, v) => Math.max(m, v), 0);
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2).padStart(7) : '      -');
const gc = () => globalThis.gc && globalThis.gc();

const MATERIALS = ['#b8a48c', '#9c8b7a', '#c9b79c', '#8e8e8e', '#a65e46', '#d9d2c5', '#5f6b73', '#3c3c3c'];

/** A map tile: `n` building extrusions on a 500 m square at (x, z), eight materials, roads. */
function tileSource(seed, n, x = 0, z = 0) {
  const r = mulberry32(seed);
  const L = ['<es3d version="1">'];
  MATERIALS.forEach((c, k) => L.push(`<material id="m${k}" color="${c}" roughness="0.${k + 2}"/>`));
  L.push(`<group id="tile" position="${x},0,${z}">`);
  for (let i = 0; i < n; i++) {
    const k = 4 + Math.floor(r() * 7);
    const rad = 4 + r() * 12;
    const pts = [];
    for (let j = 0; j < k; j++) {
      const a = (j / k) * Math.PI * 2;
      const rr = rad * (0.7 + r() * 0.3);
      pts.push(`${(Math.cos(a) * rr).toFixed(2)} ${(Math.sin(a) * rr).toFixed(2)}`);
    }
    const px = (r() * 500 - 250).toFixed(1), pz = (r() * 500 - 250).toFixed(1);
    L.push(`<extrude id="b${i}" material="m${i % 8}" d="M ${pts.join(' L ')} Z" depth="${(4 + r() * 40).toFixed(1)}" position="${px},0,${pz}" rotation="-90,0,0"/>`);
  }
  for (let i = 0; i < Math.max(4, n / 40); i++) {
    const a = r() * 500 - 250, b = r() * 500 - 250;
    L.push(`<box id="road${i}" material="m7" size="500,0.2,8" position="0,0.1,${a.toFixed(1)}" rotation="0,${(b / 5).toFixed(1)},0"/>`);
  }
  L.push('</group></es3d>');
  return L.join('\n');
}

/** A route: about 100 elements along a line (markers, segments). */
function routeSource(seed) {
  const r = mulberry32(seed);
  const L = ['<es3d version="1"><material id="route" color="#1e90ff" emissive="#1e90ff" emissiveIntensity="0.4"/><group id="route">'];
  let x = 0, z = 0;
  for (let i = 0; i < 100; i++) {
    const nx = x + r() * 20 - 5, nz = z + r() * 20 - 5;
    if (i % 2) L.push(`<cylinder material="route" radius="1" height="0.5" position="${nx.toFixed(1)},2,${nz.toFixed(1)}"/>`);
    else L.push(`<box material="route" size="${Math.hypot(nx - x, nz - z).toFixed(1)},0.4,2" position="${((x + nx) / 2).toFixed(1)},1,${((z + nz) / 2).toFixed(1)}" rotation="0,${((-Math.atan2(nz - z, nx - x) * 180) / Math.PI).toFixed(1)},0"/>`);
    x = nx;
    z = nz;
  }
  L.push('</group></es3d>');
  return L.join('');
}

const HOST = '<es3d version="1"><environment background="#dfe6ee"/><plane id="ground" color="#cfd8c4" scale="20000,1,20000"/></es3d>';

function freshStage() {
  const cache = new GeometryCache();
  const stage = new FragmentStage({ cache, report: () => {} });
  stage.setHost(compile(HOST, { cache }), 'document');
  return { stage, cache };
}

/** What a worker sends, as the page receives it (structured clone, transferred buffers). */
function received(source, sent) {
  const t0 = now();
  const { message, transfer } = preparePayload(source, { quality: 1, sent });
  const t1 = now();
  const copy = structuredClone(message, { transfer });
  const t2 = now();
  return { prepared: new Prepared({ as: 'fragment', source, payload: copy }), workerMs: t1 - t0, cloneMs: t2 - t1 };
}

function camera(bounds) {
  const c = new Camera();
  c.position = [0, 450, 650];
  c.target = [0, 0, 0];
  c.update(16 / 9, false, bounds);
  return c;
}

function buildFrame(builder, scene, cache, pool, cam) {
  return builder.build({
    scene,
    camera: cam,
    pool,
    meshOf: (e, l) => cache.mesh(e, l),
    viewportHeight: 1080,
    options: { autoLod: true, culling: true, lodBias: 1, selection: new Set(), tessellationBudget: PROGRESSIVE_BUDGET_MS },
  });
}

function measureOps(n, tiles = 24) {
  const out = { add: [], tess: [], prepAdd: [], worker: [], clone: [], hide: [], show: [], remove: [], route: [], compileSplit: [] };
  // immediate: compile and place here
  {
    const { stage, cache } = freshStage();
    for (let i = 0; i < tiles; i++) {
      const src = tileSource(1000 + i, n, (i % 5) * 500, Math.floor(i / 5) * 500);
      gc();
      const t0 = now();
      const f = stage.add(src, { id: `t${i}`, immediate: true });
      const t1 = now();
      // first draw of the tile: generating its meshes (spread over frames by the budget)
      for (const e of f.result.scene.geometries) cache.mesh(e, 0);
      const t2 = now();
      if (i >= 4) {
        out.add.push(t1 - t0);
        out.tess.push(t2 - t1);
        out.compileSplit.push(f.result.timings);
      }
    }
    for (let i = 4; i < tiles; i++) {
      const f = stage.byId.get(`t${i}`);
      let t0 = now();
      f.visible = false;
      out.hide.push(now() - t0);
      t0 = now();
      f.visible = true;
      out.show.push(now() - t0);
    }
    for (let i = 4; i < tiles; i++) {
      const t0 = now();
      stage.byId.get(`t${i}`).remove();
      out.remove.push(now() - t0);
    }
    // a route of about 100 elements, replaced again and again
    const route = stage.add(routeSource(1), { id: 'route', immediate: true });
    for (let i = 0; i < 24; i++) {
      const src = routeSource(2 + i);
      gc();
      const t0 = now();
      route.replace(src, { immediate: true });
      if (i >= 4) out.route.push(now() - t0);
    }
  }
  // prepared: the worker compiled and tessellated
  {
    const { stage } = freshStage();
    const sent = new Set();
    for (let i = 0; i < tiles; i++) {
      const src = tileSource(2000 + i, n, (i % 5) * 500, Math.floor(i / 5) * 500);
      const r = received(src, sent);
      gc();
      const t0 = now();
      stage.add(r.prepared, { id: `p${i}`, immediate: true });
      const t1 = now();
      if (i >= 4) {
        out.prepAdd.push(t1 - t0);
        out.worker.push(r.workerMs);
        out.clone.push(r.cloneMs);
      }
    }
  }
  return out;
}

/** 50 tiles queued at once; frames run until all are placed and refined. */
function stream(n, prepared) {
  const { stage, cache } = freshStage();
  const builder = new FrameBuilder();
  const pool = new GeometryPool();
  const sent = new Set();
  const sources = Array.from({ length: 50 }, (_, i) => tileSource(3000 + i, n, (i % 7) * 500 - 1500, Math.floor(i / 7) * 500 - 1500));
  const inputs = prepared ? sources.map((s) => received(s, sent).prepared) : sources;
  inputs.forEach((src, i) => stage.add(src, { id: `s${i}` }));
  const frames = [];
  for (let f = 0; f < 5000; f++) {
    gc();
    const t0 = now();
    stage.applyQueued(CHANGE_BUDGET_MS);
    const t1 = now();
    const draw = buildFrame(builder, stage.set, cache, pool, camera(stage.set.bounds));
    const t2 = now();
    frames.push({ total: t2 - t0, change: t1 - t0, frame: t2 - t1 });
    if (!stage.queued && !draw.stats.refining) break;
  }
  return frames;
}

function report(n) {
  console.log(`\nTiles of ${n} extrusions (${(tileSource(1, n).length / 1024).toFixed(0)} KB each), main-thread ms, medians of 20`);
  const o = measureOps(n);
  const split = (k) => median(o.compileSplit.map((t) => t[k]));
  console.log(`  add, immediate (compile + place)          ${fmt(median(o.add))}   parse+validate ${split('parse').toFixed(2)}, build ${split('build').toFixed(2)}, flatten ${split('flatten').toFixed(2)}`);
  console.log(`  first draw: its meshes (budgeted)         ${fmt(median(o.tess))}`);
  console.log(`  add, prepared (place what a worker sent)  ${fmt(median(o.prepAdd))}`);
  console.log(`    in the worker: compile + meshes         ${fmt(median(o.worker))}`);
  console.log(`    structured clone (both sides, upper bound of the main thread's share) ${fmt(median(o.clone))}`);
  console.log(`  hide / show                               ${fmt(median(o.hide))} / ${fmt(median(o.show)).trim()}`);
  console.log(`  remove                                    ${fmt(median(o.remove))}`);
  console.log(`  replace a route of 100 elements           ${fmt(median(o.route))}`);
  for (const prepared of [false, true]) {
    const frames = stream(n, prepared);
    const totals = frames.map((f) => f.total);
    console.log(`  50 tiles streaming, ${prepared ? 'prepared' : 'immediate'}: ${frames.length} frames, stage work per frame median ${median(totals).toFixed(2)}, max ${max(totals).toFixed(2)} (changes max ${max(frames.map((f) => f.change)).toFixed(2)}, frame builder + meshes max ${max(frames.map((f) => f.frame)).toFixed(2)}), frames over 16.7 ms: ${totals.filter((t) => t > 16.7).length}`);
  }
}

const arg = process.argv.indexOf('--extrusions');
const sizes = arg > 0 ? [+process.argv[arg + 1]] : [150, 1000];
console.log(`Node ${process.version}${globalThis.gc ? '' : ' (run with --expose-gc for steadier numbers)'}`);
for (const n of sizes) report(n);
