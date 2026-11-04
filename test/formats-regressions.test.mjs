// Regressions found in the 1.1.0 converters and fixed in 1.1.1.
// Checked with three.js in Node, and by reading the USD and X3D back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { compile } from '../src/pipeline.js';
import { exportFormat, importFiles } from '../src/io/convert.js';

const enc = new TextEncoder();
const scene = (body) => `<es3d version="1">${body}</es3d>`;
const exported = (src, format, opts) => exportFormat(src, format, opts).files[0].data;

/** Run a three.js module written by the exporter and return its scene. */
function runThree(text) {
  const body = text.replace("import * as THREE from 'three';", '').replace('export function createScene', 'function createScene');
  // eslint-disable-next-line no-new-func
  const root = new Function('THREE', `${body}\nreturn createScene();`)(THREE);
  root.updateMatrixWorld(true);
  return root;
}

function meshes(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n += o.isInstancedMesh ? o.count : 1; });
  return n;
}

test('three.js: a material first used inside a repeat is still defined after it', () => {
  const src = scene('<material id="steel" color="#888"/>'
    + '<repeat count="2" step="translate(3,0,0)"><group><box material="steel"/><sphere material="steel"/></group></repeat>'
    + '<cylinder material="steel" position="0,3,0"/>');
  const root = runThree(exported(src, 'js'));
  assert.equal(meshes(root), 5);
});

test('three.js: flatten writes each geometry once, not once per copy', () => {
  const src = scene('<defs><group id="tree"><cylinder radius="0.2" height="1"/><cone position="0,1,0"/></group></defs>'
    + '<scatter count="40" radius="10" seed="3"><use ref="tree"/></scatter>');
  const text = exported(src, 'js', { structure: 'flatten' });
  assert.equal((text.match(/new THREE\.BufferGeometry\(\)/g) || []).length, 2);
  const root = runThree(text);
  assert.equal(meshes(root), 80);
  const keep = runThree(exported(src, 'js'));
  assert.equal(meshes(keep), 80);
});

test('USD: a prim that references a prototype takes the prototype type', async () => {
  const src = scene('<box/><box position="2,0,0"/>');
  const text = exported(src, 'usda', { structure: 'flatten' });
  // def Xform "X" (references = </Mesh>) would make the copy an Xform, which draws nothing.
  assert.doesNotMatch(text, /def Xform "[^"]+" \(\s*prepend references/);
  assert.match(text, /def "[^"]+" \(\s*prepend references/);
  const back = await importFiles([{ name: 'two.usda', bytes: enc.encode(text) }]);
  assert.equal(compile(back.text).scene.count, 2);
});

test('USD import: a parent takes its own transform, not a child\'s', async () => {
  const text = exported(scene('<group><box/><box position="0,2,0"/></group>'), 'usda');
  const back = await importFiles([{ name: 'stack.usda', bytes: enc.encode(text) }]);
  const r = compile(back.text);
  assert.ok(r.ok);
  const b = r.scene.bounds;
  assert.ok(Math.abs(b.min[1] + 0.5) < 1e-6, `min y ${b.min[1]}`);
  assert.ok(Math.abs(b.max[1] - 2.5) < 1e-6, `max y ${b.max[1]}`);
});

test('X3D Classic import: geometry USE draws the geometry again', async () => {
  const text = '#X3D V4.0 utf8\nGroup { children [\n'
    + '  Shape { geometry DEF G Box { size 1 1 1 } }\n'
    + '  Transform { translation 2 0 0 children [ Shape { geometry USE G } ] }\n] }\n';
  const back = await importFiles([{ name: 'use.x3dv', bytes: enc.encode(text) }]);
  const r = compile(back.text);
  assert.ok(r.ok);
  assert.equal(r.scene.count, 2);
});
