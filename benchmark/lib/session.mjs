// One benchmark session: the folder of CSV files a server run writes, and the
// bookkeeping of every device (a "run") that takes part.
//
// A device that reloads, or whose tab crashes, comes back with the run id it
// keeps in localStorage. The measurement that was in progress is then written
// as "crashed" and skipped, so a phone that cannot survive one scene still
// finishes the rest.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CsvFile } from './csv.mjs';
import { describeDevice } from './device.mjs';
import { comparisonColumns, comparisonRows } from './compare.mjs';
import { SUMMARY_COLUMNS, summaryRows } from './summary.mjs';

export const RESULT_COLUMNS = [
  'session', 'commit', 'time', 'run', 'device', 'device_type', 'os', 'os_version', 'browser', 'browser_version', 'model', 'gpu', 'ip', 'secure_context',
  'repeat', 'backend', 'adapter', 'present', 'viewport', 'scene', 'scene_label', 'scene_instances', 'scene_triangles', 'format', 'format_label', 'status', 'note',
  'size_bytes', 'gzip_bytes', 'load_ms', 'geometry_ms', 'first_frame_ms', 'ready_ms', 'full_detail_ms', 'refine_frames', 'upload_bytes', 'gpu_geometry_bytes',
  'frame_ms', 'frame_p95_ms', 'fps', 'cpu_ms', 'draw_calls', 'triangles', 'triangles_min', 'triangles_max', 'instances', 'frames', 'interrupted',
  'engine', 'msaa_samples', 'restore_ms', 'stored_bytes',
];

export const DEVICE_COLUMNS = [
  'session', 'run', 'device', 'device_type', 'os', 'os_version', 'browser', 'browser_version', 'model', 'gpu',
  'webgl_vendor', 'webgl_renderer', 'webgpu_adapter', 'webgpu_fallback_adapter', 'webgpu_status', 'cores', 'memory_gb',
  'screen', 'dpr', 'window', 'touch_points', 'secure_context', 'language', 'timezone', 'battery', 'charging', 'connection',
  'ip', 'first_seen', 'last_seen', 'state', 'planned', 'done', 'user_agent',
];

const KEY = /^r\d{1,3}\|(webgpu|webgl2)\|[\w*-]{1,40}\|[\w*-]{1,40}$/;
const STATUSES = new Set(['ok', 'skipped', 'error', 'unavailable']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '');
const bool = (v) => (typeof v === 'boolean' ? v : null);

/** A folder name from the local time, e.g. 2026-10-07_14-03-22. */
export function sessionName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

export class Session {
  /**
   * @param {{outDir: string, config: object, commit?: string, name?: string, log?: (s: string) => void}} opts
   */
  constructor(opts) {
    this.name = opts.name || sessionName();
    this.dir = path.join(opts.outDir, this.name);
    fs.mkdirSync(this.dir, { recursive: true });
    this.config = opts.config;
    this.commit = opts.commit || '';
    this.log = opts.log || (() => {});
    this.results = new CsvFile(path.join(this.dir, 'results.csv'), RESULT_COLUMNS);
    this.devices = new CsvFile(path.join(this.dir, 'devices.csv'), DEVICE_COLUMNS);
    // side by side per device, backend and scene (compare.mjs), rewritten as results arrive
    this.formatIds = (this.config.formats || []).map((f) => (typeof f === 'string' ? f : f.id));
    this.comparison = new CsvFile(path.join(this.dir, 'comparison.csv'), comparisonColumns(this.formatIds));
    this.summaryFile = new CsvFile(path.join(this.dir, 'summary.csv'), SUMMARY_COLUMNS);
    this.okRows = [];
    this.eventsFile = path.join(this.dir, 'events.jsonl');
    /** @type {Map<string, object>} */
    this.runs = new Map();
    fs.writeFileSync(path.join(this.dir, 'config.json'), JSON.stringify({ session: this.name, commit: this.commit, started: new Date().toISOString(), ...this.config }, null, 1) + '\n');
  }

  event(type, data) {
    fs.appendFileSync(this.eventsFile, JSON.stringify({ time: new Date().toISOString(), type, ...data }) + '\n');
  }

  /**
   * A device opened the page. Starts a run, or resumes the one it remembers.
   * @param {Record<string, any>} body {runId?, name?, device, plan, unavailable?}
   * @param {{ip: string, headers: object}} req
   */
  hello(body, req) {
    const known = typeof body.runId === 'string' ? this.runs.get(body.runId) : null;
    if (known) {
      known.lastSeen = new Date();
      // a reload can be the moment WebGPU becomes available; keep the device row current
      if (body.device && typeof body.device === 'object') {
        const info = body.device;
        const sent = typeof body.name === 'string' ? body.name.trim() : '';
        // a reload often omits the label; keep the one this run already has
        if (sent) info.name = sent;
        else if (known.info && known.info.name) info.name = known.info.name;
        known.info = info;
        known.summary = describeDevice(info, req.headers);
      }
      const plan = Math.max(0, Math.min(10000, Math.round(num(body.plan) || 0)));
      if (plan > known.planned) known.planned = plan;
      let crashed = null;
      if (known.pending) {
        crashed = known.pending;
        this.writeRow(known, { key: crashed, status: 'crashed', note: 'the page was closed, reloaded or crashed during this measurement' });
        known.done.add(crashed);
        known.pending = null;
        this.log(`${known.summary.label}: ${crashed} crashed or was interrupted; skipping it`);
      }
      known.state = 'running';
      this.event('resume', { run: known.id, crashed });
      this.saveDevices();
      return { runId: known.id, summary: known.summary, resumed: true, crashed, done: [...known.done] };
    }
    const info = body.device && typeof body.device === 'object' ? body.device : {};
    if (typeof body.name === 'string' && body.name.trim()) info.name = body.name;
    const summary = describeDevice(info, req.headers);
    const run = {
      id: crypto.randomBytes(4).toString('hex'),
      summary,
      info,
      ip: req.ip,
      firstSeen: new Date(),
      lastSeen: new Date(),
      planned: Math.max(0, Math.min(10000, Math.round(num(body.plan) || 0))),
      done: new Set(),
      pending: null,
      state: 'running',
      last: '',
    };
    this.runs.set(run.id, run);
    this.event('hello', { run: run.id, ip: run.ip, summary, info });
    this.log(`new device ${run.id}: ${summary.label} [${summary.deviceType}, ${summary.os} ${summary.osVersion}, ${summary.gpu || 'GPU unknown'}] from ${run.ip}`);
    for (const u of Array.isArray(body.unavailable) ? body.unavailable.slice(0, 4) : []) {
      if (!u || typeof u.key !== 'string' || !KEY.test(u.key)) continue;
      this.writeRow(run, { key: u.key, status: 'unavailable', note: str(u.reason, 300) });
      run.done.add(u.key);
    }
    this.saveDevices();
    return { runId: run.id, summary, resumed: false, crashed: null, done: [...run.done] };
  }

  /** A measurement is about to start (so a crash during it can be detected). */
  start(body) {
    const run = this.runOf(body);
    if (!KEY.test(body.key)) throw new HttpError(400, 'bad key');
    run.pending = body.key;
    run.lastSeen = new Date();
    return { ok: true };
  }

  /** One finished measurement. */
  result(body) {
    const run = this.runOf(body);
    if (!KEY.test(body.key)) throw new HttpError(400, 'bad key');
    const status = STATUSES.has(body.status) ? body.status : 'error';
    this.writeRow(run, { ...body, status });
    run.done.add(body.key);
    if (run.pending === body.key) run.pending = null;
    run.lastSeen = new Date();
    const r = body.result || {};
    const backend = body.key.split('|')[1];
    const backendName = backend === 'webgpu' ? 'WebGPU' : backend === 'webgl2' ? 'WebGL2' : backend;
    run.last = status === 'ok' ? `${backendName} ${str(body.scene && body.scene.id, 40)} ${str(body.format && body.format.id, 40)}: ready ${fmt(num(r.readyMs))} ms, frame ${fmt(num(r.frameMs))} ms` : `${backendName} ${body.key}: ${status}`;
    this.log(`${run.summary.label} (${measured(run)}/${run.planned || '?'}) ${run.last}`);
    this.saveDevices();
    return { ok: true };
  }

  finish(body) {
    const run = this.runOf(body);
    run.state = 'done';
    run.pending = null;
    run.lastSeen = new Date();
    this.event('finish', { run: run.id });
    this.log(`${run.summary.label}: finished, ${measured(run)} measurements`);
    this.saveDevices();
    return { ok: true };
  }

  runOf(body) {
    const run = body && typeof body.runId === 'string' ? this.runs.get(body.runId) : null;
    if (!run) throw new HttpError(404, 'unknown run; reload the page');
    return run;
  }

  writeRow(run, body) {
    const [, backend, sceneKey, formatKey] = body.key.split('|');
    const r = body.result && typeof body.result === 'object' ? body.result : {};
    const scene = body.scene && typeof body.scene === 'object' ? body.scene : {};
    const format = body.format && typeof body.format === 'object' ? body.format : {};
    const s = run.summary;
    const frameMs = num(r.frameMs);
    const row = {
      session: this.name, commit: this.commit, time: new Date().toISOString(), run: run.id,
      device: s.label, device_type: s.deviceType, os: s.os, os_version: s.osVersion, browser: s.browser, browser_version: s.browserVersion,
      model: s.model, gpu: s.gpu, ip: run.ip, secure_context: bool(run.info.secureContext),
      repeat: Number(body.key.slice(1, body.key.indexOf('|'))), backend, adapter: str(body.adapter, 160), present: body.present === 'readback' ? 'readback' : body.present === 'canvas' ? 'canvas' : '', viewport: str(body.viewport, 20),
      scene: sceneKey === '*' ? '' : sceneKey, scene_label: str(scene.label, 80), scene_instances: num(scene.instances), scene_triangles: num(scene.triangles),
      format: formatKey === '*' ? '' : formatKey, format_label: str(format.label, 80), status: body.status, note: str(body.note || r.skipped || r.error || (Array.isArray(r.errors) ? r.errors.join('; ') : ''), 300),
      size_bytes: num(r.bytes), gzip_bytes: num(r.gzip), load_ms: num(r.loadMs), geometry_ms: num(r.geometryMs), first_frame_ms: num(r.firstFrameMs),
      ready_ms: num(r.readyMs), full_detail_ms: num(r.fullMs), refine_frames: num(r.refineFrames), upload_bytes: num(r.uploadBytes), gpu_geometry_bytes: num(r.gpuGeometryBytes),
      frame_ms: frameMs, frame_p95_ms: num(r.frameP95), fps: frameMs ? 1000 / frameMs : null, cpu_ms: num(r.cpuMs),
      draw_calls: num(r.drawCalls), triangles: num(r.triangles), triangles_min: num(r.trianglesMin), triangles_max: num(r.trianglesMax),
      instances: num(r.instances), frames: num(r.frames), interrupted: bool(body.interrupted),
      engine: str(r.engine, 60), msaa_samples: num(r.msaaSamples), restore_ms: num(r.restoreMs), stored_bytes: num(r.storedBytes),
    };
    this.results.append(row);
    if (row.status === 'ok') {
      this.okRows.push(row);
      this.comparison.rewrite(this.comparisonTable());
      this.summaryFile.rewrite(this.summaryTable());
    }
    this.event('result', { run: run.id, key: body.key, row });
  }

  deviceRow(run) {
    const i = run.info, s = run.summary, gl = i.webgl || {}, gpu = i.webgpu || {}, b = i.battery || {};
    return {
      session: this.name, run: run.id, device: s.label, device_type: s.deviceType, os: s.os, os_version: s.osVersion,
      browser: s.browser, browser_version: s.browserVersion, model: s.model, gpu: s.gpu,
      webgl_vendor: str(gl.vendor), webgl_renderer: str(gl.renderer), webgpu_adapter: [gpu.vendor, gpu.architecture, gpu.description || gpu.device].map((x) => str(x, 80)).filter(Boolean).join(' '),
      webgpu_fallback_adapter: bool(gpu.isFallbackAdapter), webgpu_status: str(gpu.status, 300),
      cores: num(i.hardwareConcurrency), memory_gb: num(i.deviceMemory),
      screen: num(i.screenWidth) && num(i.screenHeight) ? `${i.screenWidth}x${i.screenHeight}` : '', dpr: num(i.devicePixelRatio),
      window: num(i.innerWidth) && num(i.innerHeight) ? `${i.innerWidth}x${i.innerHeight}` : '', touch_points: num(i.maxTouchPoints),
      secure_context: bool(i.secureContext), language: str(i.language, 40), timezone: str(i.timeZone, 60),
      battery: num(b.level), charging: bool(b.charging), connection: str(i.connection, 20), ip: run.ip,
      first_seen: run.firstSeen.toISOString(), last_seen: run.lastSeen.toISOString(), state: run.state,
      planned: run.planned, done: measured(run), user_agent: s.userAgent,
    };
  }

  saveDevices() {
    this.devices.rewrite([...this.runs.values()].map((r) => this.deviceRow(r)));
  }

  /** comparison.csv's rows (compare.mjs). */
  comparisonTable() {
    return comparisonRows(this.okRows, this.formatIds);
  }

  /** summary.csv: median and mean of the passes (summary.mjs). */
  summaryTable() {
    return summaryRows(this.okRows);
  }

  /** Rows for the status page. */
  status() {
    return [...this.runs.values()].map((r) => ({ id: r.id, label: r.summary.label, type: r.summary.deviceType, gpu: r.summary.gpu, ip: r.ip, done: measured(r), planned: r.planned, state: r.state, pending: r.pending, last: r.last, lastSeen: r.lastSeen }));
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Finished measurements, without scene preparation and unavailable-backend markers. */
function measured(run) {
  let n = 0;
  for (const k of run.done) if (!/\|prepare(-retry)?$/.test(k) && !k.includes('|*|')) n++;
  return n;
}

function fmt(v) {
  return v === null ? '–' : v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : Math.round(v).toLocaleString('en-GB');
}
