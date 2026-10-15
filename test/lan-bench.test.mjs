import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { csvCell, csvLine } from '../benchmark/lib/csv.mjs';
import { describeDevice } from '../benchmark/lib/device.mjs';
import { createBenchServer, parseArgs } from '../benchmark/server.mjs';
import { matches, negotiate } from '../benchmark/lib/http-cache.mjs';
import { comparisonColumns, comparisonRows } from '../benchmark/lib/compare.mjs';
import { summaryRows } from '../benchmark/lib/summary.mjs';

test('csv cells are quoted, rounded and safe to open in a spreadsheet', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(NaN), '');
  assert.equal(csvCell(12.34567), '12.346');
  assert.equal(csvCell(-3), '-3');
  assert.equal(csvCell(true), 'true');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvLine([1, 'a', null]), '1,a,\r\n');
});

const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

test('device description: Chrome on Android over http (reduced user agent)', () => {
  const d = describeDevice({ userAgent: CHROME_ANDROID, uaData: { mobile: true, platform: 'Android', brands: [{ brand: 'Not)A;Brand', version: '8' }, { brand: 'Chromium', version: '141' }, { brand: 'Google Chrome', version: '141' }] }, webgl: { renderer: 'PowerVR B-Series BXM-8-256' } });
  assert.equal(d.deviceType, 'mobile');
  assert.equal(d.os, 'Android');
  assert.equal(d.browser, 'Google Chrome');
  assert.equal(d.browserVersion, '141');
  assert.equal(d.model, '');
  assert.equal(d.gpu, 'PowerVR B-Series BXM-8-256');
  assert.equal(d.label, 'Android mobile · Google Chrome 141');
});

test('device description: high-entropy client hints give the model and versions', () => {
  const d = describeDevice({
    userAgent: CHROME_ANDROID,
    uaData: { mobile: true, platform: 'Android', platformVersion: '14.0.0', model: 'moto g54 5G', fullVersionList: [{ brand: 'Not)A;Brand', version: '8.0.0.0' }, { brand: 'Chromium', version: '141.0.7390.122' }, { brand: 'Google Chrome', version: '141.0.7390.122' }] },
  });
  assert.equal(d.model, 'moto g54 5G');
  assert.equal(d.osVersion, '14.0.0');
  assert.equal(d.browserVersion, '141.0.7390.122');
  assert.equal(d.label, 'moto g54 5G · Google Chrome 141');
});

test('device description: Windows 11, iPhone, iPad in desktop mode, Firefox, and a chosen name', () => {
  const win = describeDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', uaData: { mobile: false, platform: 'Windows', platformVersion: '15.0.0', brands: [{ brand: 'Google Chrome', version: '141' }] } });
  assert.deepEqual([win.deviceType, win.os, win.osVersion], ['desktop', 'Windows', '11']);
  const iphone = describeDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  assert.deepEqual([iphone.deviceType, iphone.os, iphone.osVersion, iphone.browser, iphone.model], ['mobile', 'iOS', '18.0', 'Safari', 'iPhone']);
  const ipad = describeDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', maxTouchPoints: 5 });
  assert.equal(ipad.deviceType, 'tablet');
  const fx = describeDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0' });
  assert.deepEqual([fx.browser, fx.browserVersion, fx.os], ['Firefox', '131.0', 'Windows']);
  assert.equal(describeDevice({ userAgent: CHROME_ANDROID, name: 'Lab phone' }).label, 'Lab phone');
});

async function startServer(t, extra = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es3d-lan-'));
  const clientDir = path.join(tmp, 'client');
  fs.mkdirSync(clientDir);
  fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>bench</title>');
  const opts = parseArgs(['--scenes', 'cube', '--formats', 'es3d,glb', '--out', path.join(tmp, 'results'), ...extra]);
  const { server, session } = createBenchServer({ ...opts, clientDir, commit: 'test', log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { base, post, session };
}

const readCsv = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim().split('\r\n');

test('LAN server: a device reports itself, sends results, and a crash is recorded on resume', async (t) => {
  const { base, post, session } = await startServer(t);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(config.scenes.map((s) => s.id), ['cube']);
  assert.deepEqual(config.formats.map((f) => f.id), ['es3d', 'glb']);

  const device = { userAgent: CHROME_ANDROID, secureContext: false, webgl: { renderer: 'Mali-G57 MC2' }, webgpu: { status: 'needs a secure context' }, screenWidth: 412, screenHeight: 915, devicePixelRatio: 2.625 };
  const hello = await (await post('/api/hello', { device, plan: 2, name: '<b>phone</b>', unavailable: [{ key: 'r0|webgpu|*|*', reason: 'needs a secure context' }] })).json();
  assert.match(hello.runId, /^[0-9a-f]{8}$/);
  assert.equal(hello.summary.label, '<b>phone</b>');
  assert.deepEqual(hello.done, ['r0|webgpu|*|*']);

  assert.equal((await post('/api/start', { runId: hello.runId, key: 'r0|webgl2|cube|es3d' })).status, 200);
  const result = { readyMs: 12.5, frameMs: 4, frameP95: 5, triangles: 974, drawCalls: 2, frames: 40, bytes: 775, gzip: 453 };
  const ok = await post('/api/result', { runId: hello.runId, key: 'r0|webgl2|cube|es3d', status: 'ok', adapter: 'Mali-G57 MC2', scene: { id: 'cube', label: 'Rotating cube', instances: 2, triangles: 974 }, format: { id: 'es3d', label: 'ES3D (auto LOD)' }, result, interrupted: false });
  assert.equal(ok.status, 200);

  // the page reloads in the middle of the next measurement
  await post('/api/start', { runId: hello.runId, key: 'r0|webgl2|cube|glb' });
  const again = await (await post('/api/hello', { runId: hello.runId, device, plan: 2 })).json();
  assert.equal(again.resumed, true);
  assert.equal(again.crashed, 'r0|webgl2|cube|glb');
  assert.ok(again.done.includes('r0|webgl2|cube|glb'));
  assert.equal((await post('/api/finish', { runId: hello.runId })).status, 200);

  const rows = readCsv(path.join(session.dir, 'results.csv'));
  const header = rows[0].split(',');
  assert.equal(rows.length, 4); // header, unavailable WebGPU, the result, the crash
  const col = (line, name) => line.split(',')[header.indexOf(name)];
  assert.equal(col(rows[1], 'status'), 'unavailable');
  assert.equal(col(rows[2], 'status'), 'ok');
  assert.equal(col(rows[2], 'fps'), '250');
  assert.equal(col(rows[2], 'device_type'), 'mobile');
  assert.equal(col(rows[2], 'gpu'), 'Mali-G57 MC2');
  assert.equal(col(rows[2], 'commit'), 'test');
  assert.equal(col(rows[3], 'status'), 'crashed');
  const devices = readCsv(path.join(session.dir, 'devices.csv'));
  assert.equal(devices.length, 2);
  assert.match(devices[1], /done/);

  // the status page escapes what devices send
  const status = await (await fetch(`${base}/status`)).text();
  assert.ok(status.includes('&lt;b&gt;phone&lt;/b&gt;'));
  const summary = await (await fetch(`${base}/summary.csv`)).text();
  assert.match(summary, /ready_median_ms/);
  assert.match(summary, /,12\.5,/);
  const summaryPage = await (await fetch(`${base}/summary`)).text();
  assert.match(summaryPage, /Median of the passes/);
  assert.match(summaryPage, /12\.5/);
  assert.ok(!status.includes('<b>phone</b>'));
  // results can be downloaded from the server
  assert.equal((await fetch(`${base}/results.csv`)).status, 200);
  // and seen side by side, escaped too
  const comparison = readCsv(path.join(session.dir, 'comparison.csv'));
  assert.equal(comparison.length, 2);
  assert.equal(comparison[1].split(',')[comparison[0].split(',').indexOf('es3d_ready_ms')], '12.5');
  const page = await (await fetch(`${base}/comparison`)).text();
  assert.ok(page.includes('&lt;b&gt;phone&lt;/b&gt;') && !page.includes('<b>phone</b>'));
  assert.equal((await fetch(`${base}/comparison.csv`)).status, 200);
});

test('side by side: every format per device, backend and scene, ES3D against glTF in three.js', () => {
  const formats = ['es3d', 'es3d-cached', 'glb-inst', 'three-glb', 'three-glb-inst'];
  const row = (run, scene, format, ready, frame) => ({ session: 's', run, device: run, device_type: 'desktop', gpu: '', repeat: 0, backend: 'webgl2', scene, scene_label: scene, format, ready_ms: ready, frame_ms: frame });
  const rows = comparisonRows([
    row('a', 'gearbox', 'es3d', 20, 5),
    row('a', 'gearbox', 'es3d-cached', 12, 5),
    row('a', 'gearbox', 'three-glb', 40, 4),
    row('a', 'gearbox', 'three-glb-inst', 25, 4),
    row('b', 'gearbox', 'es3d', 30, 9),
  ], formats);
  assert.equal(rows.length, 2);
  const [a, b] = rows;
  assert.equal(a.reference, 'three-glb-inst');
  assert.equal(a.es3d_vs_reference, 0.8);
  assert.equal(a.es3d_cached_vs_reference, 12 / 25);
  assert.equal(a['three-glb_frame_ms'], 4);
  assert.equal(a['glb-inst_ready_ms'], null);
  assert.equal(b.reference, '');
  assert.equal(b.es3d_vs_reference, null);
  assert.ok(comparisonColumns(formats).includes('es3d-cached_ready_ms'));
});

test('ten passes: the median ignores one hitch, the mean shows it', () => {
  const pass = (repeat, ready, frame, interrupted = false) => ({
    session: 's', run: 'a', device: 'PC build', device_type: 'desktop', gpu: 'RTX 5060 Ti',
    backend: 'webgl2', scene: 'forest', scene_label: 'Forest', format: 'es3d', format_label: 'ES3D',
    repeat, ready_ms: ready, frame_ms: frame, interrupted,
  });
  const rows = [1, 1, 1, 1, 1, 1, 1, 1, 1].map((v, i) => pass(i, v, 0.8));
  rows.push(pass(9, 100, 0.8));
  rows.push(pass(10, 50, 9, true));
  const [s] = summaryRows(rows);
  assert.equal(s.n, 10);
  assert.equal(s.ready_median_ms, 1);
  assert.equal(s.ready_mean_ms, 10.9);
  assert.equal(s.ready_max_ms, 100);
  assert.equal(s.frame_median_ms, 0.8);
});

test('LAN server: rejects bad input and serves only its own files', async (t) => {
  const { base, post } = await startServer(t);
  assert.equal((await post('/api/hello', 'not json')).status, 400);
  assert.equal((await post('/api/result', { runId: 'nope', key: 'r0|webgl2|cube|es3d' })).status, 404);
  const { runId } = await (await post('/api/hello', { device: {}, plan: 1 })).json();
  assert.equal((await post('/api/result', { runId, key: '../../etc' })).status, 400);
  assert.equal((await post('/api/hello', { pad: 'x'.repeat(1.2e6) })).status, 413);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/examples/01-rotating-cube.es3d`)).status, 200);
  assert.equal((await fetch(`${base}/examples/%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${base}/api/config`, { method: 'DELETE' })).status, 405);
});

test('LAN server: files are revalidated with ETags and compressed, the API is never cached', async (t) => {
  const { base } = await startServer(t);
  const url = `${base}/examples/02-primitives.es3d`;
  const first = await fetch(url, { headers: { 'accept-encoding': 'br' } });
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.match(etag, /^"[A-Za-z0-9_-]{27}"$/);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  assert.equal(first.headers.get('content-encoding'), 'br');
  assert.equal(first.headers.get('vary'), 'Accept-Encoding');
  assert.equal(await first.text(), fs.readFileSync(new URL('../docs/public/examples/02-primitives.es3d', import.meta.url), 'utf8'));
  const again = await fetch(url, { headers: { 'if-none-match': `W/${etag}, "other"` } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('etag'), etag);
  assert.equal((await fetch(url, { headers: { 'if-none-match': '"other"' } })).status, 200);
  assert.equal((await fetch(url, { headers: { 'accept-encoding': 'gzip, br;q=0' } })).headers.get('content-encoding'), 'gzip');
  assert.equal((await fetch(`${base}/api/config`)).headers.get('cache-control'), 'no-store');
  assert.equal(negotiate('identity'), 'identity');
  assert.equal(negotiate('*'), 'br');
  assert.ok(matches('*', '"x"') && !matches('', '"x"'));
});

test('LAN server options are validated', () => {
  assert.throws(() => parseArgs(['--scenes', 'nope']), /unknown scene/);
  assert.throws(() => parseArgs(['--frames', '2']), /from 5 to 2000/);
  assert.throws(() => parseArgs(['--cert', 'a.pem']), /go together/);
  assert.deepEqual(parseArgs(['--backends', 'webgl2']).backends, ['webgl2']);
});
