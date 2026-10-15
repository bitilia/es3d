#!/usr/bin/env node
// LAN benchmark server.
//
//   npm run bench:lan                     serve on every network interface, port 8090
//   npm run bench:lan -- --https          self-signed HTTPS (WebGPU on other devices; see README)
//   npm run bench:lan -- --help           all options
//
// Every device that opens the printed address reports what it is (browser,
// operating system, GPU, screen, cores, memory) and then runs the renderer
// benchmark by itself: the same scenes, formats and measurement. Each measurement is sent back as soon as it is
// done and appended to benchmark/results/<session>/results.csv, with the
// device in every row, so one file holds all devices.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Session, HttpError } from './lib/session.mjs';
import { sendStatic } from './lib/http-cache.mjs';
import { BENCH_SCENES } from '../src/bench/scenes.js';
import { BROWSER_FORMATS } from '../src/bench/runner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXAMPLES = path.join(ROOT, 'docs', 'public', 'examples');
const DEFAULT_SCENES = BENCH_SCENES.map((s) => s.id).filter((id) => !['lod-stress', 'forest-explicit'].includes(id));

const HELP = `node benchmark/server.mjs [options]

  --port <n>          port (default 8090)
  --host <addr>       interface to listen on (default 0.0.0.0, every interface)
  --https             serve HTTPS with a self-signed certificate (needs openssl)
  --cert <file> --key <file>   serve HTTPS with this certificate, e.g. from mkcert
  --scenes <a,b>      scenes (default ${DEFAULT_SCENES.join(',')})
                      all: ${BENCH_SCENES.map((s) => s.id).join(', ')}
  --formats <a,b>     formats (default all: ${BROWSER_FORMATS.map((f) => f.id).join(', ')})
  --backends <a,b>    webgpu, webgl2 or both, in this order (default webgpu,webgl2)
  --frames <n>        measured frames per run (default 40)
  --size <WxH>        canvas size in CSS pixels at device pixel ratio 1 (default 960x540)
  --repeat <n>        run the whole set n times per device (default 1; npm run bench:lan:10 uses 10). summary.csv is the median and the mean
  --cooldown <s>      pause between measurements, for phones that throttle (default 0)
  --obj-limit <n>     skip OBJ for scenes with more triangles (default 3000000)
  --out <dir>         results folder (default benchmark/results)
  --no-build          serve the last client build instead of building it again
`;

export function parseArgs(argv) {
  const o = {
    port: 8090, host: '0.0.0.0', https: false, cert: null, key: null,
    scenes: DEFAULT_SCENES, formats: BROWSER_FORMATS.map((f) => f.id), backends: ['webgpu', 'webgl2'],
    frames: 40, size: '960x540', repeat: 1, cooldown: 0, objLimit: 3e6,
    out: path.join(HERE, 'results'), build: true,
  };
  const list = (v, allowed, what) => {
    const items = v.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = items.filter((s) => !allowed.includes(s));
    if (bad.length || !items.length) throw new Error(`unknown ${what}: ${bad.join(', ') || '(none)'}; choose from ${allowed.join(', ')}`);
    return items;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    const int = (lo, hi) => {
      const n = Number(val());
      if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${a} must be a whole number from ${lo} to ${hi}`);
      return n;
    };
    if (a === '--port') o.port = int(1, 65535);
    else if (a === '--host') o.host = val();
    else if (a === '--https') o.https = true;
    else if (a === '--cert') o.cert = path.resolve(val());
    else if (a === '--key') o.key = path.resolve(val());
    else if (a === '--scenes') o.scenes = list(val(), BENCH_SCENES.map((s) => s.id), 'scene');
    else if (a === '--formats') o.formats = list(val(), BROWSER_FORMATS.map((f) => f.id), 'format');
    else if (a === '--backends') o.backends = list(val(), ['webgpu', 'webgl2'], 'backend');
    else if (a === '--frames') o.frames = int(5, 2000);
    else if (a === '--size') {
      o.size = val();
      if (!/^\d{2,4}x\d{2,4}$/.test(o.size)) throw new Error('--size must look like 960x540');
    } else if (a === '--repeat') o.repeat = int(1, 50);
    else if (a === '--cooldown') o.cooldown = int(0, 600);
    else if (a === '--obj-limit') o.objLimit = int(0, 1e9);
    else if (a === '--out') o.out = path.resolve(val());
    else if (a === '--no-build') o.build = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown option ${a} (try --help)`);
  }
  if (!!o.cert !== !!o.key) throw new Error('--cert and --key go together');
  return o;
}

/** The commit the results belong to, with "-dirty" for uncommitted changes. */
export function gitCommit() {
  try {
    const run = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return run('rev-parse', '--short', 'HEAD') + (run('status', '--porcelain', '--untracked-files=no') ? '-dirty' : '');
  } catch {
    return '';
  }
}

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

/** Build the benchmark page with Vite, the same production bundle as the site. */
export async function buildClient(outDir) {
  let vite;
  try {
    vite = await import('vite');
  } catch {
    throw new Error('Vite is not installed. Run `npm ci` in the repository first.');
  }
  await vite.build({
    configFile: false,
    root: path.join(HERE, 'client'),
    base: './',
    publicDir: false,
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true, sourcemap: false },
  });
}

/** A self-signed certificate for this machine's addresses (kept for 30 days). */
function selfSigned(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const fresh = fs.existsSync(cert) && Date.now() - fs.statSync(cert).mtimeMs < 25 * 864e5;
  if (!fresh) {
    fs.mkdirSync(dir, { recursive: true });
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map((a) => `IP:${a}`)].join(',');
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30', '-subj', '/CN=ES3D LAN benchmark',
        '-addext', `subjectAltName=${san}`, '-keyout', key, '-out', cert], { stdio: 'ignore' });
    } catch {
      throw new Error('--https needs openssl to make a certificate. Install it, or pass --cert and --key (for example from mkcert).');
    }
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.es3d': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
const MAX_BODY = 1 << 20;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // past the limit the rest is read and dropped, so the client gets its 413
      if (size <= MAX_BODY) chunks.push(c);
      else if (size > 16 * MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, 'request too large'));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, 'expected a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

function statusPage(session, opts) {
  const rows = session.status().map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.gpu || '')}</td><td>${escapeHtml(r.ip)}</td>
    <td>${r.done}${r.planned ? ` / ${r.planned}` : ''}</td><td>${escapeHtml(r.state)}${r.pending ? ` (${escapeHtml(r.pending)})` : ''}</td><td>${escapeHtml(r.last)}</td>
    <td>${escapeHtml(r.lastSeen.toLocaleTimeString('en-GB'))}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3"><title>ES3D benchmark status</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1a1a1a}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f4f6}code{background:#f3f4f6;padding:1px 4px}</style></head>
<body><h1>ES3D LAN benchmark</h1><p>Session <code>${escapeHtml(session.name)}</code> · commit <code>${escapeHtml(session.commit || 'unknown')}</code> ·
${escapeHtml(opts.scenes.join(', '))} · ${escapeHtml(opts.formats.join(', '))} · ${escapeHtml(opts.backends.join(', '))} · ${opts.frames} frames at ${escapeHtml(opts.size)}</p>
<p>Results: <a href="summary">median of the passes</a> · <a href="comparison">side by side</a> · <a href="results.csv">results.csv</a> (${session.results.rows} rows) · <a href="summary.csv">summary.csv</a> · <a href="comparison.csv">comparison.csv</a> · <a href="devices.csv">devices.csv</a> · folder <code>${escapeHtml(session.dir)}</code></p>
<p>${opts.repeat > 1 ? `Each device runs the set <b>${opts.repeat}</b> times. The number to quote is the <a href="summary">median</a>; the mean is next to it.` : 'One pass per device. <code>npm run bench:lan:10</code> runs ten and writes the median.'}</p>
<table><thead><tr><th>Device</th><th>Type</th><th>GPU</th><th>Address</th><th>Done</th><th>State</th><th>Last result</th><th>Last seen</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8">No device yet. Open the address this server printed on each device.</td></tr>'}</tbody></table></body></html>`;
}

/** Every format side by side, per device, backend and scene (benchmark/lib/compare.mjs). */
function comparisonPage(session) {
  const ms = (v) => (v == null ? '–' : v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : Math.round(v).toLocaleString('en-GB'));
  const formats = session.config.formats;
  const rows = session.comparisonTable().map((r) => `<tr><td>${escapeHtml(r.device)}</td><td>${escapeHtml(r.backend === 'webgpu' ? 'WebGPU' : 'WebGL2')}</td><td>${escapeHtml(r.scene_label || r.scene)}</td>
    ${formats.map((f) => `<td class="n">${ms(r[`${f.id}_ready_ms`])}<br><span>${ms(r[`${f.id}_frame_ms`])}</span></td>`).join('')}
    <td class="n"><b>${r.es3d_vs_reference == null ? '–' : `${r.es3d_vs_reference.toFixed(2)}×`}</b></td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5"><title>ES3D benchmark: side by side</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1a1a1a}table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f4f6;font-weight:600}.n{text-align:right;white-space:nowrap}span{color:#666}</style></head>
<body><h1>Side by side</h1><p>Per device, backend and scene: <b>ready</b> (load + first frame) and, below it, <span>the median frame</span> while orbiting, in ms.
The last column is ES3D's ready time divided by glTF's as three.js loads and draws it (the faster of plain and instanced GLB): below 1, ES3D was ready first.
<a href="comparison.csv">comparison.csv</a> · <a href="summary">median of the passes</a> · <a href="status">status</a></p>
<table><thead><tr><th>Device</th><th>Backend</th><th>Scene</th>${formats.map((f) => `<th class="n">${escapeHtml(f.label)}</th>`).join('')}<th class="n">ES3D ÷ three.js glTF</th></tr></thead>
<tbody>${rows || `<tr><td colspan="${formats.length + 4}">No results yet.</td></tr>`}</tbody></table></body></html>`;
}

/** Median and mean across passes (benchmark/lib/summary.mjs). */
function summaryPage(session) {
  const ms = (v) => (v == null ? '–' : v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : Math.round(v).toLocaleString('en-GB'));
  const rows = session.summaryTable().map((r) => `<tr><td>${escapeHtml(r.device)}</td><td>${escapeHtml(r.device_type || '')}</td><td>${escapeHtml(r.backend === 'webgpu' ? 'WebGPU' : 'WebGL2')}</td><td>${escapeHtml(r.scene_label || r.scene)}</td><td>${escapeHtml(r.format_label || r.format)}</td><td class="n">${r.n}</td><td class="n"><b>${ms(r.ready_median_ms)}</b><br><span>${ms(r.ready_mean_ms)}</span></td><td class="n"><b>${ms(r.frame_median_ms)}</b><br><span>${ms(r.frame_mean_ms)}</span></td><td class="n">${ms(r.ready_min_ms)}–${ms(r.ready_max_ms)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5"><title>ES3D benchmark: median of the passes</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1a1a1a}table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f4f6;font-weight:600}.n{text-align:right;white-space:nowrap}span{color:#666}</style></head>
<body><h1>Median of the passes</h1>
<p>One row per device, backend, scene and format. <b>Bold</b> is the median of the passes that finished cleanly. The smaller figure under it is the mean. The last column is the slowest and fastest ready time, so a single hitch stays visible. A pass whose tab went to the background is left out. Quote the median.
<a href="summary.csv">summary.csv</a> · <a href="comparison">each pass, side by side</a> · <a href="status">status</a></p>
<table><thead><tr><th>Device</th><th>Type</th><th>Backend</th><th>Scene</th><th>Format</th><th class="n">Passes</th><th class="n">Ready, ms</th><th class="n">Frame, ms</th><th class="n">Ready, min–max</th></tr></thead>
<tbody>${rows || '<tr><td colspan="9">No results yet.</td></tr>'}</tbody></table></body></html>`;
}

/**
 * Create (but do not start) the benchmark server.
 * @param {ReturnType<typeof parseArgs> & {clientDir: string, tls?: {key: Buffer, cert: Buffer}, log?: (s: string) => void, commit?: string}} opts
 */
export function createBenchServer(opts) {
  const log = opts.log || ((s) => console.log(s));
  const config = {
    scenes: opts.scenes.map((id) => ({ id, label: BENCH_SCENES.find((s) => s.id === id).label })),
    formats: opts.formats.map((id) => ({ id, label: BROWSER_FORMATS.find((f) => f.id === id).label })),
    backends: opts.backends, frames: opts.frames, size: opts.size, repeat: opts.repeat, cooldownMs: opts.cooldown * 1000, objLimit: opts.objLimit,
  };
  const session = new Session({ outDir: opts.out, config, commit: opts.commit ?? gitCommit(), log });
  const clientDir = path.resolve(opts.clientDir);

  // cross-origin isolation gives the page full-resolution timers where the
  // browser allows it (secure contexts); every resource here is same-origin
  const isolation = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
  // API answers and live results are never cached
  const send = (res, status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...isolation });
    res.end(body);
  };
  // files: revalidated with an ETag, hashed build assets cached for good, text compressed
  const file = (req, res, type, body, p) => sendStatic(req, res, body, type, { path: p, headers: isolation });
  const json = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let p;
    try {
      p = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'bad URL');
    }
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (p.startsWith('/api/')) {
      if (p === '/api/config' && req.method === 'GET') return json(res, 200, { session: session.name, commit: session.commit, ...config });
      if (req.method !== 'POST') throw new HttpError(405, 'use POST');
      const body = await readJson(req);
      if (p === '/api/hello') return json(res, 200, session.hello(body, { ip, headers: req.headers }));
      if (p === '/api/start') return json(res, 200, session.start(body));
      if (p === '/api/result') return json(res, 200, session.result(body));
      if (p === '/api/finish') return json(res, 200, session.finish(body));
      throw new HttpError(404, 'no such endpoint');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    if (p === '/status') return send(res, 200, TYPES['.html'], statusPage(session, opts));
    if (p === '/comparison') return send(res, 200, TYPES['.html'], comparisonPage(session));
    if (p === '/summary') return send(res, 200, TYPES['.html'], summaryPage(session));
    if (p === '/results.csv' || p === '/devices.csv' || p === '/comparison.csv' || p === '/summary.csv') return send(res, 200, TYPES['.csv'], fs.readFileSync(path.join(session.dir, p.slice(1))));
    const ex = p.match(/^\/examples\/([\w.-]+\.es3d)$/);
    if (ex) {
      const f = path.join(EXAMPLES, ex[1]);
      if (!fs.existsSync(f)) throw new HttpError(404, 'no such example');
      return file(req, res, TYPES['.es3d'], fs.readFileSync(f), p);
    }
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const f = path.resolve(clientDir, rel);
    if (!f.startsWith(clientDir + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) throw new HttpError(404, 'not found');
    return file(req, res, TYPES[path.extname(f)] || 'application/octet-stream', fs.readFileSync(f), p);
  }

  const listener = (req, res) => {
    handle(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`error: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, status, { error: e.message });
    });
  };
  const server = opts.tls ? https.createServer(opts.tls, listener) : http.createServer(listener);
  return { server, session };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }
  const buildRoot = path.join(HERE, '.build');
  const clientDir = path.join(buildRoot, 'client');
  if (opts.build || !fs.existsSync(path.join(clientDir, 'index.html'))) {
    console.log('building the benchmark page…');
    await buildClient(clientDir);
  }
  const tls = opts.cert ? { key: fs.readFileSync(opts.key), cert: fs.readFileSync(opts.cert) } : opts.https ? selfSigned(path.join(buildRoot, 'tls')) : null;
  const { server, session } = createBenchServer({ ...opts, clientDir, tls });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, resolve);
  });
  const scheme = tls ? 'https' : 'http';
  const port = server.address().port;
  const hosts = opts.host === '0.0.0.0' || opts.host === '::' ? lanAddresses() : [opts.host];
  console.log('');
  console.log('ES3D LAN benchmark');
  console.log(`  open on each device:  ${hosts.map((h) => `${scheme}://${h}:${port}/`).join('   ') || '(no network address found)'}`);
  console.log(`  on this computer:     ${scheme}://localhost:${port}/`);
  console.log(`  progress:             ${scheme}://localhost:${port}/status`);
  console.log(`  side by side:         ${scheme}://localhost:${port}/comparison`);
  console.log(`  median of the passes: ${scheme}://localhost:${port}/summary`);
  console.log(`  results:              ${path.join(session.dir, 'results.csv')}`);
  console.log(`  ${opts.scenes.length} scenes × ${opts.formats.length} formats × ${opts.backends.join('+')}, ${opts.frames} frames at ${opts.size}${opts.repeat > 1 ? `, ${opts.repeat} times` : ''}`);
  if (!tls) console.log('  note: over plain http other devices cannot use WebGPU (it needs a secure context); see benchmark/README.md');
  console.log('');
  const stop = () => {
    console.log(`\nstopped. ${session.results.rows} result rows from ${session.runs.size} device(s) in ${session.dir}`);
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
