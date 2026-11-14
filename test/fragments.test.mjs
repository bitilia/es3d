// Stage fragments (scene/fragments.js, scene/scene-set.js, scene/prepared.js):
// a host document plus fragments draws what one merged document draws, ids
// and setTransforms are scoped to a fragment, materials are shared, hiding
// and removing free what they should, and a document prepared off the main
// thread places the same rows with the same diagnostics.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { compile, GeometryCache } from '../src/pipeline.js';
import { DOCUMENT } from '../src/geometry/geometry-cache.js';
import { formatDiagnostics } from '../src/format/parse.js';
import { FrameBuilder } from '../src/render/frame-builder.js';
import { GeometryPool } from '../src/render/geometry-pool.js';
import { Camera } from '../src/render/camera.js';
import { raycast } from '../src/scene/picking.js';
import { FragmentStage } from '../src/scene/fragments.js';
import { HOST_ONLY, Prepared, preparePayload } from '../src/scene/prepared.js';
import { memoryStore, restoreGeometry, saveGeometry } from '../src/cache/geometry-store.js';
import { BENCH_SCENES, benchSceneSource } from '../src/bench/scenes.js';

const EXAMPLES = new URL('../docs/public/examples/', import.meta.url);
const FIXTURES = new URL('./fixtures/', import.meta.url);

// --- documents ----------------------------------------------------------------

// Each part is {defs, body}. A fragment is a document of its own; the merged
// document holds every part's defs in one <defs> and the bodies in order.
const doc = (parts) => {
  const defs = parts.map((p) => p.defs || '').join('');
  return `<es3d version="1">${defs ? `<defs>${defs}</defs>` : ''}${parts.map((p) => p.body).join('')}</es3d>`;
};

const HOST = {
  defs: '<group id="h-post"><cylinder radius="0.1" height="2"/></group>',
  body: `
    <environment background="#202830"/>
    <camera position="0,8,20" target="0,0,0"/>
    <light type="directional" direction="-1,-2,-1" intensity="2"/>
    <material id="h-ground" color="#556b2f" roughness="0.9"/>
    <material id="h-brick" color="#a0522d" roughness="0.8"/>
    <plane id="ground" material="h-ground" scale="40,1,40"/>
    <box id="hall" material="h-brick" size="4,3,4" position="0,1.5,0"/>
    <use ref="h-post" position="3,1,3"/>
    <use ref="h-post" position="-3,1,3"/>`,
};

// a tile: shared material parameters, its own ids, a definition, a repeat
// (long enough for the instance kernel), a scatter, a lod, a mirrored copy,
// a transparent pane and a light
const tile = (k, dx) => ({
  defs: `<group id="t${k}-tree"><cylinder radius="0.15" height="1" position="0,0.5,0"/><sphere radius="0.6" position="0,1.4,0" material="t${k}-leaf"/></group>`,
  body: `
    <material id="t${k}-brick" color="#a0522d" roughness="0.8"/>
    <material id="t${k}-leaf" color="#2e8b57" roughness="0.7"/>
    <material id="t${k}-glass" color="#88ccff" opacity="0.4"/>
    <group id="t${k}" position="${dx},0,-6">
      <box id="t${k}-house" material="t${k}-brick" size="2,2,2" position="0,1,0"/>
      <box id="t${k}-mirror" material="t${k}-brick" size="1,1,1" position="2,0.5,0" scale="-1,1,1"/>
      <repeat id="t${k}-fence" count="24" step="translate(0.5,0,0)"><box size="0.1,0.6,0.1" position="-6,0.3,2"/></repeat>
      <scatter id="t${k}-park" count="12" area="6,4" seed="${k}"><use ref="t${k}-tree"/></scatter>
      <lod id="t${k}-tower" distances="30"><cylinder radius="0.5" height="6" position="-3,3,0" material="t${k}-brick"/><box size="1,6,1" position="-3,3,0"/></lod>
      <plane id="t${k}-pane" material="t${k}-glass" rotation="90,0,0" position="0,1,1.05" scale="1.5,1,1.5"/>
      <light type="point" position="0,3,0" color="#ffddaa" intensity="1" range="8"/>
    </group>`,
});

const TILES = [tile(1, -10), tile(2, 0), tile(3, 10)];

function ok(result, what = 'document') {
  assert.equal(result.ok, true, `${what}: ${formatDiagnostics(result)}`);
  return result;
}

function stageWith(host, fragments, o = {}) {
  const cache = new GeometryCache();
  const reports = [];
  const fs_ = new FragmentStage({ cache, report: (m, r) => reports.push({ m, r }), ...o });
  if (host) {
    const r = ok(compile(doc([host]), { cache, owner: DOCUMENT }), 'host');
    fs_.setHost(r, DOCUMENT);
  }
  const frags = fragments.map((f, i) => fs_.add(typeof f === 'string' ? f : doc([f]), { id: `f${i}`, immediate: true }));
  return { stage: fs_, cache, frags, reports };
}

/** What a frame draws, by value: batches in order with their rows' matrices. */
function frame(scene, cache, camPos = [6, 9, 24]) {
  const camera = new Camera();
  camera.position = camPos.slice();
  camera.target = [0, 1, -3];
  camera.update(16 / 9, false, scene.bounds);
  const draw = new FrameBuilder().build({
    scene,
    camera,
    pool: new GeometryPool(),
    meshOf: (e, l) => cache.mesh(e, l),
    viewportHeight: 720,
    options: { autoLod: true, culling: true, lodBias: 1, selection: new Set(), tessellationBudget: Infinity },
  });
  return {
    batches: draw.batches.map((b) => ({ key: b.entry.key, lod: b.lod, material: b.material.key, mirrored: b.mirrored, count: b.count, first: b.firstInstance })),
    instances: Array.from(draw.instanceData.subarray(0, draw.instanceCount * 16)),
    stats: draw.stats,
    lights: JSON.stringify(scene.lights.map(({ uid, ...l }) => l)),
    bounds: JSON.stringify(scene.bounds),
  };
}

// --- 1. same picture -------------------------------------------------------------

test('host plus fragments draws what the merged document draws', () => {
  const { stage, cache } = stageWith(HOST, TILES);
  const merged = ok(compile(doc([HOST, ...TILES]), { cache: new GeometryCache() }), 'merged');
  for (const pos of [[6, 9, 24], [-30, 4, 2], [0, 60, 0.1]]) {
    const a = frame(stage.set, cache, pos);
    const b = frame(merged.scene, merged.cache, pos);
    assert.ok(a.stats.visible > 50, 'the view shows the scene');
    assert.deepEqual(a.batches, b.batches);
    assert.deepEqual(a.instances, b.instances);
    assert.deepEqual(a.stats, b.stats);
    assert.equal(a.lights, b.lights);
    assert.equal(a.bounds, b.bounds);
  }
  // same distinct materials and meshes
  assert.deepEqual(stage.set.materials.map((m) => m.key), merged.scene.materials.map((m) => m.key));
  assert.deepEqual(stage.set.geometries.map((e) => e.key), merged.scene.geometries.map((e) => e.key));
});

test('a fragment shows its scene nodes, lights and animation, not the host-only elements', () => {
  const src = '<es3d version="1"><environment background="#ff0000"/><camera id="c" position="0,0,5"/><controls mode="none"/><box id="b"/><light type="point" position="0,2,0"/></es3d>';
  const { stage, frags, reports } = stageWith(HOST, [src]);
  const f = frags[0];
  assert.equal(f.placed, true);
  const warnings = f.diagnostics.filter((d) => d.code === HOST_ONLY);
  assert.deepEqual(warnings.map((d) => d.message.slice(0, d.message.indexOf('>') + 1)), ['<environment>', '<camera id="c">', '<controls>']);
  assert.ok(warnings.every((d) => d.severity === 'warning' && d.line === 1 && d.column > 1));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].r.ok, true);
  assert.match(reports[0].m, /A fragment cannot set the environment/);
  assert.equal(stage.set.environment, stage.hostResult.scene.environment);
  assert.equal(stage.set.cameras, stage.hostResult.scene.cameras);
  assert.equal(stage.set.controls, null);
  assert.equal(stage.set.lights.length, stage.hostResult.scene.lights.length + 1);

  const anim = '<es3d version="1"><box id="spin"><animate attr="rotation" from="0,0,0" to="0,360,0" dur="4s"/></box></es3d>';
  const a = stageWith(null, [anim]);
  const part = a.frags[0].result.scene;
  assert.equal(a.stage.set.animation.time, true);
  const before = Array.from(part.matrices.subarray(0, 16));
  assert.equal(a.stage.updateDynamic(1, 0), true);
  assert.notDeepEqual(Array.from(part.matrices.subarray(0, 16)), before);
  assert.equal(a.stage.updateDynamic(1, 0), false, 'nothing to do at the same clock');
});

// --- 3. ids ---------------------------------------------------------------------------

test('ids are scoped to a fragment, and fragment.setTransforms writes only its rows', () => {
  const same = '<es3d version="1"><defs><box id="part" size="1,1,1"/></defs><group id="g"><box id="a"/><use ref="part" position="2,0,0"/><use ref="part" position="4,0,0"/></group></es3d>';
  const { stage, frags } = stageWith(HOST, [same, same]);
  const [f, g] = frags;
  const rowsOf = (fr) => Array.from(fr.result.scene.matrices.subarray(0, fr.result.scene.count * 16));
  const gBefore = rowsOf(g);
  const host = stage.hostResult.scene;
  const hostBefore = Array.from(host.matrices.subarray(0, host.count * 16));
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1];
  assert.deepEqual(f.setTransforms([['a', m], ['missing', m], ['part', m], { id: 'g', matrix: m }]), [true, false, false, true]);
  const fs0 = f.result.scene;
  const row = (s, uid) => {
    for (let i = 0; i < s.count; i++) if (s.uid[i] === uid) return i;
    return -1;
  };
  const a = row(fs0, f.result.graph.byId.get('a').uid);
  assert.deepEqual(Array.from(fs0.matrices.subarray(a * 16 + 12, a * 16 + 15)), [14, 16, 18]);
  assert.deepEqual(rowsOf(g), gBefore, 'the other fragment, with the same ids, did not move');
  assert.deepEqual(Array.from(host.matrices.subarray(0, host.count * 16)), hostBefore, 'nor did the host');
  assert.equal(f.setTransform('a', [1, 2, 3]), false, 'not 16 numbers');
});

// --- 4. materials -----------------------------------------------------------------------

test('a thousand tiles defining the same eight materials bind eight', () => {
  const mats = Array.from({ length: 8 }, (_, k) => `<material id="m${k}" color="#${(0x203040 + k * 0x111111).toString(16)}" roughness="0.${k + 1}"/>`).join('');
  const shapes = (i) => Array.from({ length: 8 }, (_, k) => `<box material="m${k}" position="${i},${k},0"/>`).join('');
  const { stage, cache } = stageWith(null, []);
  for (let i = 0; i < 1000; i++) stage.add(`<es3d version="1">${mats}${shapes(i)}</es3d>`, { id: `t${i}`, immediate: true });
  assert.equal(stage.set.materials.filter(Boolean).length, 8);
  assert.equal(stage.set.geometries.filter(Boolean).length, 1, 'one box entry');
  assert.equal(cache.entries.size, 1);
  assert.equal(stage.set.count, 8000);
});

// --- 5. visibility and removal ---------------------------------------------------------------

test('a hidden fragment draws no rows; a removed one frees its rows, materials and meshes', () => {
  const { stage, cache, frags } = stageWith(HOST, TILES);
  const all = frame(stage.set, cache).stats.instances;
  const one = frags[1].result.scene.count;
  frags[1].visible = false;
  assert.equal(frame(stage.set, cache).stats.instances, all - one);
  assert.equal(stage.set.lights.length, stage.hostResult.scene.lights.length + 2);
  frags[1].visible = true;
  assert.equal(frame(stage.set, cache).stats.instances, all);

  const unique = '<es3d version="1"><material id="only" color="#123456"/><torus id="donut" material="only" radius="3" tube="0.5"/></es3d>';
  const f = stage.add(unique, { id: 'unique', immediate: true });
  const entry = f.result.scene.geometries[0];
  assert.ok(cache.entries.get(entry.key) === entry);
  const materials = stage.set.materials.filter(Boolean).length;
  f.remove();
  assert.equal(stage.byId.has('unique'), false);
  assert.equal(cache.entries.has(entry.key), false, 'evicted: no owner holds it');
  assert.equal(stage.set.materials.filter(Boolean).length, materials - 1);
  assert.ok(stage.set.takeReleased().includes(entry), 'reported to the renderer for repacking');
  assert.equal(frame(stage.set, cache).stats.instances, all);
  // a box the host and the tiles share stays
  frags.forEach((fr) => fr.remove());
  assert.ok([...cache.entries.values()].some((e) => e.key === 'box'));
  assert.equal(frame(stage.set, cache).stats.instances, stage.hostResult.scene.count);
});

test('building a fragment does not evict the host\'s meshes, and the host\'s show keeps the fragments\'', () => {
  const cache = new GeometryCache();
  const host = ok(compile('<es3d version="1"><sphere/><torus radius="2" tube="0.2"/></es3d>', { cache }));
  const torus = host.scene.geometries.find((e) => e.key.startsWith('torus'));
  cache.mesh(torus, 0);
  const owner = { owner: 'fragment' };
  ok(compile('<es3d version="1"><capsule height="2"/></es3d>', { cache, owner }));
  assert.equal(cache.entries.get(torus.key), torus, 'the host keeps its torus');
  // the next document (no torus) evicts the torus, not the fragment's capsule
  ok(compile('<es3d version="1"><sphere/></es3d>', { cache }));
  assert.equal(cache.entries.has(torus.key), false);
  assert.ok([...cache.entries.keys()].some((k) => k.startsWith('capsule')));
  cache.release(owner);
  assert.equal([...cache.entries.keys()].some((k) => k.startsWith('capsule')), false);
});

// --- 7. errors -------------------------------------------------------------------------------

test('a fragment that fails is not placed, and a bad replace keeps the old content', async () => {
  const { stage, frags, reports } = stageWith(HOST, [TILES[0]]);
  const before = stage.set.count;
  const bad = stage.add('<es3d version="1"><box sise="1,1,1"/></es3d>', { id: 'bad', immediate: true });
  const r = await bad.ready;
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].code, 'E_UNKNOWN_ATTRIBUTE');
  assert.equal(bad.placed, false);
  assert.equal(stage.set.count, before);
  assert.equal(reports.at(-1).r.ok, false);
  assert.match(reports.at(-1).m, /sise/);

  const f = frags[0];
  const rows = f.result.scene;
  const res = await f.replace('<es3d version="1"><nonsense/></es3d>', { immediate: true });
  assert.equal(res.ok, false);
  assert.equal(f.result.scene, rows, 'still the old content');
  assert.equal(stage.set.count, before);
  const good = await f.replace('<es3d version="1"><box id="x"/></es3d>', { immediate: true });
  assert.equal(good.ok, true);
  assert.equal(stage.set.count, before - rows.count + 1);
});

// --- 8 and 9. picking and bounds -----------------------------------------------------------------

test('picking names the fragment and the element from its own document; bounds cover visible fragments', () => {
  const far = '<es3d version="1"><group name="tower"><box id="top" name="roof" size="2,2,2" position="100,0,0"/></group></es3d>';
  const { stage, cache, frags } = stageWith(HOST, [far]);
  const hit = raycast(stage.set, (e, l) => cache.mesh(e, l), [100, 10, 0], [0, -1, 0]);
  assert.ok(hit && hit.part === frags[0].part);
  assert.deepEqual(stage.names(hit.part, hit.uid), ['roof', 'tower']);
  const hostHit = raycast(stage.set, (e, l) => cache.mesh(e, l), [0, 10, 0], [0, -1, 0]);
  assert.equal(hostHit.part, stage.host);
  assert.deepEqual(stage.names(hostHit.part, hostHit.uid), ['hall']);
  assert.ok(stage.set.bounds.max[0] >= 101);
  frags[0].visible = false;
  assert.ok(stage.set.bounds.max[0] < 30, 'recomputed without the hidden fragment');
  assert.equal(raycast(stage.set, (e, l) => cache.mesh(e, l), [100, 10, 0], [0, -1, 0]), null);
});

// --- the queue ---------------------------------------------------------------------------------

test('changes wait for the frame loop and stop at the budget', async () => {
  let t = 0;
  const { stage } = stageWith(HOST, [], { now: () => (t += 1) });
  const tiles = TILES.map((d, i) => stage.add(doc([d]), { id: `q${i}` }));
  assert.equal(stage.queued, 3);
  assert.equal(tiles[0].placed, false, 'not drawn until placed');
  const drawnBefore = stage.set.count;
  // each compile reads the clock twice: a 1 ms budget runs exactly one change
  assert.equal(stage.applyQueued(1).applied, 1);
  assert.equal(tiles[0].placed, true);
  assert.equal(tiles[1].placed, false);
  assert.ok(stage.set.count > drawnBefore);
  assert.equal(stage.applyQueued(Infinity).applied, 2);
  assert.deepEqual((await Promise.all(tiles.map((f) => f.ready))).map((r) => r.ok), [true, true, true]);

  // a replace that has not started gives way to the next one, and both resolve with it
  const f = tiles[0];
  const first = f.replace('<es3d version="1"><box/></es3d>');
  const second = f.replace('<es3d version="1"><sphere/><sphere position="2,0,0"/></es3d>');
  assert.equal(stage.queued, 1);
  stage.applyQueued();
  assert.deepEqual([(await first).ok, (await second).ok], [true, true]);
  assert.equal(f.result.scene.count, 2);

  // removing a queued fragment cancels it
  const gone = stage.add('<es3d version="1"><box/></es3d>', { id: 'gone' });
  gone.remove();
  assert.equal((await gone.ready).removed, true);
  assert.equal(stage.queued, 0);
  assert.throws(() => stage.add('<es3d version="1"/>', { id: 'q1' }), /already/);
});

test('a queued fragment reads its stored meshes before it is placed', async () => {
  const store = memoryStore();
  const src = '<es3d version="1"><torus id="t" radius="2" tube="0.3"/></es3d>';
  // an earlier visit stored this fragment's meshes
  const earlier = new GeometryCache();
  const owner0 = { owner: 'fragment' };
  const prev = ok(compile(src, { cache: earlier, owner: owner0 }));
  earlier.mesh(prev.scene.geometries[0], 0);
  assert.equal((await saveGeometry(earlier, store, { entries: earlier.owned(owner0) })).saved, true);

  const { stage, cache } = stageWith(null, [], { restore: (c, owner) => restoreGeometry(c, store, { entries: c.owned(owner) }) });
  const f = stage.add(src, { id: 'stored' });
  stage.applyQueued();
  assert.equal(f.placed, false, 'waiting for the store');
  await new Promise((r) => setTimeout(r, 20));
  stage.applyQueued();
  assert.equal(f.placed, true);
  assert.ok(f.result.scene.geometries[0].meshes[0], 'restored, not generated');
  assert.equal(cache.stats.generated, 0);
  assert.equal(cache.stats.restored, 1);
});

// --- prepared off the main thread ---------------------------------------------------------------------

/** What a worker answers, through structured cloning as postMessage does. */
function viaWorker(source, sent) {
  const { message, transfer } = preparePayload(source, { time: 0, progress: 0, quality: 1, sent });
  return structuredClone(message, { transfer });
}

test('a prepared fragment places the same rows as compiling it here', async () => {
  const a = stageWith(HOST, TILES);
  const b = stageWith(HOST, []);
  const sent = new Set();
  for (const [i, t] of TILES.entries()) {
    const p = new Prepared({ as: 'fragment', source: doc([t]), payload: viaWorker(doc([t]), sent) });
    assert.equal(p.payload.main, undefined, 'carried by the payload');
    const f = b.stage.add(p, { id: `f${i}`, immediate: true });
    assert.equal(f.placed, true);
    assert.equal(f.result.graph, null, 'no graph until it is needed');
  }
  assert.deepEqual(frame(b.stage.set, b.cache), frame(a.stage.set, a.cache));
  // the meshes came with the payload: nothing was generated here
  assert.equal(b.cache.stats.generated, 0);
  // setTransforms compiles that fragment here, in place
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1];
  assert.deepEqual(b.stage.byId.get('f1').setTransforms([['t2-house', m]]), [true]);
  assert.deepEqual(a.frags[1].setTransforms([['t2-house', m]]), [true]);
  assert.deepEqual(frame(b.stage.set, b.cache), frame(a.stage.set, a.cache));
  // a key sent before is not sent again; its entry is reused here
  const again = viaWorker(doc([TILES[0]]), sent);
  assert.ok(Array.from(again.scene.geometries.levels).every((k) => k < 0), "no meshes sent twice");
  assert.equal(again.scene.meshes.positions.length, 0);
  const f = b.stage.add(new Prepared({ as: 'fragment', source: doc([TILES[0]]), payload: again }), { id: 'again', immediate: true });
  assert.equal(f.placed, true);
  assert.equal(b.cache.stats.generated, 0);
});

test('prepare() without a worker compiles here, and the result places once', async () => {
  const { stage } = stageWith(HOST, []);
  const p = await stage.prepare(doc([TILES[0]]));
  assert.equal(p.ok, true);
  const f = stage.add(p, { id: 'p', immediate: true });
  assert.equal(f.placed, true);
  assert.equal((await f.ready).ok, true);
  assert.throws(() => stage.add(p, { id: 'p2', immediate: true }), /once/);
  const bad = await stage.prepare('<es3d version="1"><box sise="1"/></es3d>');
  assert.equal(bad.ok, false);
  assert.equal(bad.diagnostics[0].code, 'E_UNKNOWN_ATTRIBUTE');
});

test('a document with animation or textures is compiled on the main thread', () => {
  const anim = viaWorker('<es3d version="1"><box><animate attr="position" from="0,0,0" to="0,1,0" dur="1s"/></box></es3d>');
  assert.equal(anim.main, true);
  const { stage } = stageWith(null, []);
  const f = stage.add(new Prepared({ as: 'fragment', source: '<es3d version="1"><box><animate attr="position" from="0,0,0" to="0,1,0" dur="1s"/></box></es3d>', payload: anim }), { immediate: true });
  assert.equal(f.placed, true);
  assert.ok(f.result.graph);
  assert.equal(f.result.scene.dynamic.length, 1);
});

// --- diagnostics are identical ----------------------------------------------------------------------------

const INVALID = [
  '<es3d version="1"><box sise="1,1,1"/></es3d>',
  '<es3d version="1"><bocks/></es3d>',
  '<es3d version="1"><box size="1,x,1"/></es3d>',
  '<es3d version="1"><use ref="nowhere"/></es3d>',
  '<es3d version="1"><x-wave amplitude="2"/><box/></es3d>',
  '<es3d version="2"><box/></es3d>',
  '<es3d version="1"><group><defs><box id="a"/></defs></group></es3d>',
  '<es3d version="1"><box id="a"/><box id="a"/></es3d>',
  '<es3d version="1"><box material="missing"/></es3d>',
  '<es3d version="1"><repeat count="2000000"><box/></repeat></es3d>',
  '<es3d version="1"><box',
  'es3d version=1\n  box size=1,1 bad=2\n',
  '["es3d",{"version":"1"},["box",{"sise":"1"}]]',
  '<es3d version="1"><path d="M 0 0 L 1"/></es3d>',
];

async function everyDocument() {
  const out = [];
  for (const f of fs.readdirSync(EXAMPLES).filter((n) => n.endsWith('.es3d'))) out.push([f, fs.readFileSync(new URL(f, EXAMPLES), 'utf8')]);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
      if (e.isDirectory()) walk(u);
      else if (e.name.endsWith('.es3d')) out.push([e.name, fs.readFileSync(u, 'utf8')]);
    }
  };
  walk(FIXTURES);
  for (const d of BENCH_SCENES) out.push([d.id, await benchSceneSource(d, async (f) => fs.readFileSync(new URL(f, EXAMPLES), 'utf8'))]);
  INVALID.forEach((src, i) => out.push([`invalid ${i}`, src]));
  return out;
}

test('prepare() reports exactly the diagnostics compile() reports, for every fixture and example', async () => {
  const docs = await everyDocument();
  assert.ok(docs.length > 25);
  let failing = 0;
  for (const [name, src] of docs) {
    const here = compile(src);
    const p = new Prepared({ as: 'document', source: src, payload: viaWorker(src) });
    assert.equal(p.ok, here.ok, name);
    assert.deepEqual(p.diagnostics.map((d) => d.toJSON()), here.diagnostics.map((d) => d.toJSON()), name);
    assert.equal(formatDiagnostics({ diagnostics: p.diagnostics, lineIndex: p.lineIndex }), formatDiagnostics(here), name);
    if (!here.ok) failing++;
  }
  assert.ok(failing >= INVALID.length - 2, 'the invalid documents fail');
});

test('show() without fragments is unchanged: the document owner keeps the old eviction rule', () => {
  const cache = new GeometryCache();
  const a = ok(compile('<es3d version="1"><sphere/><torus radius="1" tube="0.2"/></es3d>', { cache, owner: DOCUMENT }));
  const b = ok(compile('<es3d version="1"><sphere/></es3d>', { cache }));
  assert.deepEqual([...cache.entries.keys()], b.scene.geometries.map((e) => e.key));
  assert.equal(cache.entries.get(a.scene.geometries[0].key), b.scene.geometries[0], 'the sphere entry is reused');
});
