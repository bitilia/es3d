// The browser bundle (browser/es3d.min.js, @es3d/es3d/browser): one file with
// the whole browser-safe API, and nothing that only runs in Node. The test
// builds it, imports it, and converts files the way a page does: File objects
// from an <input type="file">, read and converted on the visitor's computer.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as api from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let bundle = null;
async function load() {
  if (bundle) return bundle;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es3d-browser-'));
  execFileSync(process.execPath, [path.join(root, 'scripts/build-browser.mjs')], { cwd: root, stdio: 'pipe', env: { ...process.env, ES3D_BROWSER_OUT: dir } });
  const file = path.join(dir, 'es3d.min.js');
  bundle = { dir, file, text: fs.readFileSync(file, 'utf8'), mod: await import(pathToFileURL(file).href) };
  return bundle;
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect x="2" y="2" width="16" height="16" fill="#e53935"/><circle cx="30" cy="10" r="8" fill="#1e88e5"/></svg>';
const OBJ = 'mtllib cube.mtl\nusemtl red\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nv 1 0 1\nv 1 1 1\nv 0 1 1\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 5 1 4 8\n';
const MTL = 'newmtl red\nKd 0.9 0.1 0.1\n';

test('the browser bundle is one file without Node-only code', async () => {
  const { dir, text } = await load();
  assert.deepEqual(fs.readdirSync(dir), ['es3d.min.js']);
  assert.doesNotMatch(text, /["'`]node:[a-z]/, 'no node: module');
  assert.doesNotMatch(text, /\brequire\(/);
  assert.doesNotMatch(text, /(?:from|import)\s*\(?\s*["']\.\.?\//, 'no import of another file');
  assert.doesNotMatch(text, /sourceMappingURL/);
  assert.doesNotMatch(text, /zlib|sharp|meshoptimizer/);
  // the instance and geometry kernels are in it, as WebAssembly
  assert.match(text, /WebAssembly\.instantiate/);
});

test('the browser bundle exports the package API', async () => {
  const { mod } = await load();
  for (const name of Object.keys(api)) assert.ok(name in mod, `${name} is exported`);
  const r = mod.compile('<es3d version="1"><box/></es3d>');
  assert.equal(r.ok, true);
  assert.equal(r.scene.count, 1);
  assert.equal(typeof mod.createStage, 'function');
});

test('the browser bundle converts local files: File objects in, files out', async () => {
  const { mod } = await load();
  // SVG from an <input type="file">
  const svg = await mod.importFiles([new File([SVG], 'badge.svg', { type: 'image/svg+xml' })]);
  assert.equal(svg.kind, 'svg');
  assert.equal(mod.compile(svg.text).ok, true);
  // gzipped, read through the browser's DecompressionStream (no zlib in the bundle)
  const svgz = await mod.importFiles([new File([zlib.gzipSync(SVG)], 'badge.svgz')]);
  assert.equal(svgz.text, svg.text);
  // an OBJ with its .mtl, as a FileList-like list
  const obj = await mod.importFiles({ length: 2, 0: new File([OBJ], 'cube.obj'), 1: new File([MTL], 'cube.mtl'), *[Symbol.iterator]() { yield this[0]; yield this[1]; } });
  assert.equal(obj.kind, 'obj');
  const compiled = mod.compile(obj.text);
  assert.equal(compiled.ok, true);
  assert.ok(compiled.scene.materials.some((m) => Math.abs(m.baseColorSrgb[0] - 0.9) < 0.01), 'the .mtl colour came along');

  // ES3D out to the binary and text formats, and back in
  const glb = mod.exportFormat(svg.text, 'glb', { baseName: 'badge' });
  const bytes = glb.files[0].data;
  assert.equal(glb.files[0].name, 'badge.glb');
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'glTF');
  const back = await mod.importFiles([new File([bytes], 'badge.glb')]);
  assert.equal(back.kind, 'glb');
  assert.equal(mod.compile(back.text).ok, true);
  const stl = mod.exportFormat(obj.text, 'stl').files[0];
  assert.equal(stl.name, 'scene.stl');
  const stlIn = await mod.importFiles([new File([stl.data], 'cube.stl')]);
  assert.equal(stlIn.kind, 'stl');
  for (const format of ['obj', 'step', 'x3dv', 'usda', 'scad', 'js', 'es3d-compact']) {
    const out = mod.exportFormat(obj.text, format);
    assert.ok(out.files.length >= 1 && out.files[0].data.length > 0, format);
  }
  // the same results as the library in Node
  assert.equal(svg.text, (await api.importFiles([{ name: 'badge.svg', bytes: new TextEncoder().encode(SVG) }])).text);
  await assert.rejects(() => mod.importFiles([42]), /File objects/);
});
