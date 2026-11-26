// Public entry point and command-line tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as es3d from '../src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, ['scripts/es3d-cli.mjs', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

test('the package entry exposes the pipeline and runs without a browser', () => {
  const r = es3d.compile('es3d version=1 { repeat n=3 step="translate(2,0,0)" { box s=0.5 } }');
  assert.ok(r.ok);
  assert.equal(r.scene.count, 3);
  const back = es3d.parse(es3d.serialize(r.doc, { syntax: 'json', pretty: false }));
  assert.equal(es3d.serialize(back, { syntax: 'compact', pretty: false }), es3d.serialize(r.doc, { syntax: 'compact', pretty: false }));
  assert.equal(typeof es3d.createRenderer, 'function');
  const camera = new es3d.Camera().frame(r.scene.bounds);
  assert.ok(camera.distance > 0);
});

test('es3d CLI: validate exit codes and canonical diagnostics', () => {
  const ok = cli('validate', 'docs/public/examples/02-primitives.es3d');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /0 errors/);
  const bad = cli('validate', 'docs/public/examples/13-error-demo.es3d');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /ES3D Parse Error\nline \d+, column \d+\n\nUnknown attribute: raduis\n\nDid you mean: radius\?/);
  const usage = cli('frobnicate', 'x.es3d');
  assert.equal(usage.status, 2);
});

test('es3d CLI: repeated warnings group in text and stay in json', () => {
  const src = `<es3d version="1.1">${'<polygon points="0,0 1,0 0,1"><x-anchors nodes="a b c"/></polygon>'.repeat(4)}</es3d>`;
  const run = (args) => spawnSync(process.execPath, ['scripts/es3d-cli.mjs', ...args], { cwd: root, encoding: 'utf8', input: src });
  const text = run(['validate', '-']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stderr.split('Extension element <x-anchors>').length - 1, 1);
  assert.match(text.stderr, /Reported 4 times\. Showing the first\./);
  assert.match(text.stdout, /0 errors, 4 warnings, 4 instances/);
  const json = run(['validate', '-', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.diagnostics.filter((d) => d.code === 'W_EXTENSION').length, 4);
});

test('es3d CLI: every documented export command runs, and glb honours its options', () => {
  const ex = 'docs/public/examples/02-primitives.es3d';
  for (const cmd of ['x3d', 'usd', 'scad', 'js']) {
    const r = cli(cmd, ex);
    assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, cmd);
  }
  const help = cli('--help').stdout;
  for (const cmd of help.split('Options')[0].matchAll(/^ {2}(\w+) {2,}/gm)) {
    const r = cli(cmd[1]);
    assert.doesNotMatch(r.stderr, /unknown command/, `${cmd[1]} is in --help but rejected`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es3d-cli-'));
  try {
    const glb = (...args) => {
      const out = path.join(tmp, `${args.join('_') || 'plain'}.glb`);
      const r = cli('glb', ex, '-o', out, ...args);
      assert.equal(r.status, 0, r.stderr);
      return es3d.parseGLB(new Uint8Array(fs.readFileSync(out))).json;
    };
    assert.ok(!(glb().extensionsUsed || []).includes('KHR_mesh_quantization'));
    assert.ok(glb('--quantize').extensionsRequired.includes('KHR_mesh_quantization'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('es3d CLI: bad option values fail instead of being ignored', () => {
  const ex = 'docs/public/examples/02-primitives.es3d';
  for (const args of [['--lod', 'abc'], ['--lod', '7'], ['--precision', 'x'], ['--up', 'q']]) {
    const r = cli('obj', ex, ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, new RegExp(args[0]));
  }
  const one = spawnSync(process.execPath, ['scripts/es3d-cli.mjs', 'validate', '-'], { cwd: root, encoding: 'utf8', input: 'es3d version=1 { box }' });
  assert.match(one.stdout, /, 1 instance$/m);
});

test('es3d CLI: fmt keeps the JSON syntax', () => {
  const json = cli('json', 'docs/public/examples/02-primitives.es3d');
  const r = spawnSync(process.execPath, ['scripts/es3d-cli.mjs', 'fmt', '-'], { cwd: root, encoding: 'utf8', input: json.stdout });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(es3d.detectSyntax(r.stdout), 'json');
});

test('es3d CLI: conversions are readable again', () => {
  const compact = cli('compact', 'docs/public/examples/04-forest.es3d', '--min');
  assert.equal(compact.status, 0, compact.stderr);
  const r = es3d.compile(compact.stdout);
  assert.ok(r.ok);
  assert.equal(r.scene.count, 7401);
  const stats = cli('stats', 'docs/public/examples/04-forest.es3d', '--json');
  assert.equal(JSON.parse(stats.stdout).instances, 7401);
});
