// Public entry point and command-line tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as es3d from '../src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, ['scripts/es3d-cli.mjs', ...args], { cwd: root, encoding: 'utf8' });

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

test('es3d CLI: conversions are readable again', () => {
  const compact = cli('compact', 'docs/public/examples/04-forest.es3d', '--min');
  assert.equal(compact.status, 0, compact.stderr);
  const r = es3d.compile(compact.stdout);
  assert.ok(r.ok);
  assert.equal(r.scene.count, 7401);
  const stats = cli('stats', 'docs/public/examples/04-forest.es3d', '--json');
  assert.equal(JSON.parse(stats.stdout).instances, 7401);
});
