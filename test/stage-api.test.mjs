import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../src/pipeline.js';
import { applyLocalMatrices, applyLocalMatrix, updateDynamic } from '../src/scene/flatten.js';
import { clockAdvances, orbitAdvances, stageOptions } from '../src/render/stage.js';
import { mulberry32 } from '../src/math/random.js';
import { es3dSin, es3dCos } from '../src/math/trig.js';
import * as api from '../src/index.js';
import * as stageEntry from '../src/stage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function translation(x, y, z) {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function rowOf(scene, uid) {
  for (let i = 0; i < scene.count; i++) if (scene.uid[i] === uid) return i;
  return -1;
}

function at(scene, uid) {
  const i = rowOf(scene, uid);
  assert.ok(i >= 0);
  const o = i * 16;
  return [scene.matrices[o + 12], scene.matrices[o + 13], scene.matrices[o + 14]];
}

function load(src) {
  const result = compile(src);
  assert.equal(result.ok, true, result.diagnostics.map((d) => d.message).join('\n'));
  return result;
}

test('stage options: background runs the clock and leaves the camera still', () => {
  assert.deepEqual(stageOptions({}), { clock: 'document', playing: true, auto: true });
  assert.deepEqual(stageOptions({ background: true }), { clock: 'always', playing: true, auto: false });
  assert.deepEqual(stageOptions({ background: true, autoOrbit: true }), { clock: 'always', playing: true, auto: true });
  assert.deepEqual(stageOptions({ background: true, clock: 'document' }), { clock: 'document', playing: true, auto: false });
  assert.deepEqual(stageOptions({ clock: 'always' }), { clock: 'always', playing: true, auto: true });
  assert.deepEqual(stageOptions({ background: true }, true), { clock: 'always', playing: false, auto: false });
  assert.equal(clockAdvances({ playing: true, clock: 'always' }, { animation: { time: false } }, false), true);
  assert.equal(clockAdvances({ playing: true, clock: 'document' }, { animation: { time: false } }, false), false);
  assert.equal(clockAdvances({ playing: true, clock: 'always' }, { animation: { time: true } }, true), false);
  assert.equal(clockAdvances({ playing: false, clock: 'always' }, { animation: {} }, false), false);
  assert.equal(orbitAdvances({ auto: true }, false), true);
  assert.equal(orbitAdvances({ auto: true }, true), false);
});

test('setTransform moves one id and leaves the other', () => {
  const result = load('<es3d version="1"><box id="a"/><box id="b" position="2,0,0"/></es3d>');
  const a = result.graph.byId.get('a');
  const b = result.graph.byId.get('b');
  assert.equal(applyLocalMatrix(result.scene, result.graph, a, translation(5, 0, 0)), true);
  assert.deepEqual(at(result.scene, a.uid), [5, 0, 0]);
  assert.deepEqual(at(result.scene, b.uid), [2, 0, 0]);
  assert.equal(applyLocalMatrix(result.scene, result.graph, a, translation(1, 2, 3)), true);
  assert.deepEqual(at(result.scene, a.uid), [1, 2, 3]);
  assert.equal(applyLocalMatrix(result.scene, result.graph, null, translation(0, 0, 0)), false);
  assert.equal(applyLocalMatrix(result.scene, result.graph, a, [1, 2, 3]), false);
  assert.deepEqual(at(result.scene, a.uid), [1, 2, 3]);
});

test('setTransform moves a group and one use, and refuses a shared definition', () => {
  const grouped = load('<es3d version="1"><group id="g" position="10,0,0"><box id="b"/></group><box id="other" position="0,7,0"/></es3d>');
  const g = grouped.graph.byId.get('g');
  const b = grouped.graph.byId.get('b');
  const other = grouped.graph.byId.get('other');
  assert.equal(applyLocalMatrix(grouped.scene, grouped.graph, b, translation(0, 2, 0)), true);
  assert.deepEqual(at(grouped.scene, b.uid), [10, 2, 0]);
  assert.equal(applyLocalMatrix(grouped.scene, grouped.graph, g, translation(3, 0, 0)), true);
  assert.deepEqual(at(grouped.scene, b.uid), [3, 2, 0]);
  assert.deepEqual(at(grouped.scene, other.uid), [0, 7, 0]);

  const used = load('<es3d version="1"><defs><box id="proto"/></defs><use id="a" ref="proto"/><use id="c" ref="proto" position="2,0,0"/></es3d>');
  const useA = used.graph.byId.get('a');
  const useC = used.graph.byId.get('c');
  const proto = used.graph.byId.get('proto');
  assert.equal(applyLocalMatrix(used.scene, used.graph, proto, translation(9, 0, 0)), false);
  assert.equal(applyLocalMatrix(used.scene, used.graph, useA, translation(5, 0, 0)), true);
  assert.deepEqual(at(used.scene, useA.uid), [5, 0, 0]);
  assert.deepEqual(at(used.scene, useC.uid), [2, 0, 0]);
});

test('setTransform refuses a scattered shape and keeps its rows', () => {
  const result = load('<es3d version="1"><scatter count="4" seed="1" radius="2"><box id="c"/></scatter></es3d>');
  const before = result.scene.matrices.slice(0, result.scene.count * 16);
  const node = result.graph.byId.get('c');
  assert.equal(applyLocalMatrix(result.scene, result.graph, node, translation(5, 0, 0)), false);
  assert.deepEqual(result.scene.matrices.slice(0, result.scene.count * 16), before);
});

test('setTransforms stores every matrix and walks once', () => {
  const moved = load('<es3d version="1"><group id="g" position="10,0,0"><box id="a"/><box id="b"/></group><box id="stay" position="0,7,0"/></es3d>');
  const version = moved.scene.version;
  const a = moved.graph.byId.get('a');
  const b = moved.graph.byId.get('b');
  const applied = applyLocalMatrices(
    moved.scene, moved.graph,
    [a, b, a, undefined],
    [translation(0, 1, 0), translation(0, 2, 0), translation(0, 9, 0), translation(0, 0, 0)],
  );
  assert.deepEqual(applied, [true, true, true, false]);
  assert.equal(moved.scene.version, version + 1);
  assert.deepEqual(at(moved.scene, a.uid), [10, 9, 0]);
  assert.deepEqual(at(moved.scene, b.uid), [10, 2, 0]);
  assert.deepEqual(at(moved.scene, moved.graph.byId.get('stay').uid), [0, 7, 0]);

  const animated = load('<es3d version="1"><group id="g"><animate attr="position" to="4,0,0" dur="1s"/><box id="a"/><box id="b"/></group></es3d>');
  const v2 = animated.scene.version;
  const again = applyLocalMatrices(
    animated.scene, animated.graph,
    [animated.graph.byId.get('a'), animated.graph.byId.get('b')],
    [translation(0, 3, 0), translation(0, 0, 5)],
    0.5, 0,
  );
  assert.deepEqual(again, [true, true]);
  assert.equal(animated.scene.version, v2 + 1);
  assert.deepEqual(at(animated.scene, animated.graph.byId.get('a').uid), [2, 3, 0]);
  assert.deepEqual(at(animated.scene, animated.graph.byId.get('b').uid), [2, 0, 5]);
});

test('a script matrix survives the animation walk', () => {
  const result = load('<es3d version="1"><group id="g"><animate attr="position" to="4,0,0" dur="1s" repeat="1"/><box id="b"/></group></es3d>');
  const b = result.graph.byId.get('b');
  assert.equal(applyLocalMatrix(result.scene, result.graph, b, translation(0, 4, 0), 0.5, 0), true);
  assert.deepEqual(at(result.scene, b.uid), [2, 4, 0]);
  updateDynamic(result.scene, result.graph, 0, 0);
  assert.deepEqual(at(result.scene, b.uid), [0, 4, 0]);
  updateDynamic(result.scene, result.graph, 1, 0);
  assert.deepEqual(at(result.scene, b.uid), [4, 4, 0]);
});

test('the package exports the placement functions', () => {
  assert.equal(api.mulberry32, mulberry32);
  assert.equal(api.es3dSin, es3dSin);
  assert.equal(api.es3dCos, es3dCos);
  assert.equal(typeof api.applyLocalMatrix, 'function');
  assert.equal(typeof api.applyLocalMatrices, 'function');
  assert.equal(stageEntry.createStage, api.createStage);
  assert.equal(stageEntry.mulberry32, mulberry32);
  assert.equal(stageEntry.es3dSin, es3dSin);
  assert.equal(stageEntry.es3dCos, es3dCos);
  const rand = mulberry32(1);
  assert.equal(rand(), mulberry32(1)());
  assert.equal(typeof es3dSin(0), 'number');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./stage'], './browser/es3d-stage.min.js');
  assert.equal(pkg.version, '1.1.1');
});

test('the stage bundle is one file', async () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-stage.mjs')], { cwd: root, stdio: 'pipe' });
  const dir = path.join(root, 'browser');
  assert.deepEqual(fs.readdirSync(dir), ['es3d-stage.min.js']);
  const text = fs.readFileSync(path.join(dir, 'es3d-stage.min.js'), 'utf8');
  assert.doesNotMatch(text, /from\s*["']\./);
  assert.doesNotMatch(text, /sourceMappingURL/);
  const mod = await import(pathToFileURL(path.join(dir, 'es3d-stage.min.js')).href);
  assert.equal(typeof mod.createStage, 'function');
  assert.equal(typeof mod.ancestorNames, 'function');
  assert.equal(typeof mod.mulberry32, 'function');
  assert.equal(typeof mod.es3dSin, 'function');
  assert.equal(typeof mod.es3dCos, 'function');
  assert.equal(mod.mulberry32(1)(), mulberry32(1)());
  assert.equal(mod.es3dSin(0.3), es3dSin(0.3));
});
