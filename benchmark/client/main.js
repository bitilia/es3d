// LAN benchmark page: reports the device to the server, then runs the
// renderer benchmark (src/bench/runner.js) on every backend the device has, sending each measurement
// back as soon as it is done.
//
// URL parameters: name=<label for this device>, fresh=1 (start a new run
// instead of resuming the one this browser remembers), present=readback
// (render offscreen and read back, for headless browsers that cannot
// present WebGPU to a canvas; real devices keep the default).

import { createRenderer } from '../../src/render/renderer.js';
import { BENCH_SCENES } from '../../src/bench/scenes.js';
import { BROWSER_FORMATS, prepareScene, runFormat, releaseEngines } from '../../src/bench/runner.js';
import { collectDeviceInfo, webgpuUnavailableReason } from './device-info.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (repeat, backend, scene, format) => `r${repeat}|${backend}|${scene}|${format}`;
const present = params.get('present') === 'readback' ? 'readback' : 'canvas';
const fmtMs = (v) => (typeof v !== 'number' ? '–' : v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : Math.round(v).toLocaleString('en-GB'));
const fmtInt = (v) => (typeof v !== 'number' ? '–' : Math.round(v).toLocaleString('en-GB'));

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path}: HTTP ${res.status}`);
  return data;
}

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode: the run cannot be resumed after a reload, nothing else changes
    }
  },
};

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

const backendName = (backend) => (backend === 'webgpu' ? 'WebGPU' : 'WebGL2');

function showDevice(summary, info, backends) {
  const gpuState = info.webgpu.status === 'available' ? [info.webgpu.vendor, info.webgpu.architecture, info.webgpu.description].filter(Boolean).join(' ') || 'available' : info.webgpu.status;
  const measured = backends.map(backendName).join(' and ') || 'none';
  const rows = [
    ['Name', summary.label],
    ['Type', summary.deviceType],
    ['System', `${summary.os} ${summary.osVersion}`.trim()],
    ['Browser', `${summary.browser} ${summary.browserVersion}`.trim()],
    ['Measured with', measured],
    ['GPU (WebGL)', info.webgl.renderer || info.webgl.status || '–'],
    ['WebGPU', gpuState],
    ['Screen', `${info.screenWidth}×${info.screenHeight} at ${info.devicePixelRatio}× · ${info.hardwareConcurrency || '?'} threads${info.deviceMemory ? ` · ${info.deviceMemory} GB` : ''}`],
  ];
  $('device').replaceChildren(...rows.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]));
}

function addRow(backend, scene, format, status, res, note, pass) {
  const tr = document.createElement('tr');
  if (status !== 'ok') tr.className = 'bad';
  const what = document.createElement('td');
  what.className = 'what';
  const sub = Object.assign(document.createElement('span'), { className: 'sub', textContent: pass ? `${format} · pass ${pass}` : format });
  what.append(scene, sub);
  const api = document.createElement('td');
  api.textContent = backendName(backend);
  tr.append(what, api);
  const cells = status === 'ok' ? [fmtMs(res.readyMs), fmtMs(res.frameMs), fmtInt(res.triangles)] : [`${status}${note ? `: ${note}` : ''}`];
  for (const c of cells) {
    const td = document.createElement('td');
    td.textContent = c;
    if (status === 'ok') td.className = 'num';
    else {
      td.colSpan = 3;
      td.className = 'note';
    }
    tr.append(td);
  }
  $('results').append(tr);
}

// --- keeping the measurement honest on phones -------------------------------

let hiddenDuring = false;
let wakeLock = null;
// once the page is being reloaded or closed, its aborted requests are not
// results: the next page load reports the interrupted measurement instead
let leaving = false;
addEventListener('pagehide', () => (leaving = true));
addEventListener('beforeunload', () => (leaving = true));
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenDuring = true;
  else keepAwake();
});
const whenVisible = () =>
  document.hidden
    ? new Promise((resolve) => {
        setStatus('Paused: bring this tab back to the front to continue.');
        const f = () => {
          if (!document.hidden) {
            document.removeEventListener('visibilitychange', f);
            resolve();
          }
        };
        document.addEventListener('visibilitychange', f);
      })
    : Promise.resolve();

// --- renderer ----------------------------------------------------------------

let renderer = null;
async function useBackend(backend, width, height) {
  if (renderer && renderer.kind === backend) return renderer;
  let canvas = $('canvas');
  if (renderer) {
    renderer.setScene(null, null);
    releaseEngines(renderer);
    renderer.dispose();
    renderer = null;
    // a canvas keeps its first context type: switch backends on a fresh element
    const fresh = canvas.cloneNode(false);
    canvas.replaceWith(fresh);
    canvas = fresh;
  }
  canvas.width = width;
  canvas.height = height;
  renderer = await createRenderer(canvas, { backend, present });
  if (renderer.kind !== backend) throw new Error(`${backend} unavailable${renderer.fallbackReason ? `: ${renderer.fallbackReason}` : ''}`);
  return renderer;
}

// --- the run -------------------------------------------------------------------

async function main() {
  const config = await api('api/config');
  setStatus('Looking at this device…');
  const info = await collectDeviceInfo();
  const [width, height] = config.size.split('x').map(Number);
  const formats = config.formats.map((f) => BROWSER_FORMATS.find((b) => b.id === f.id));
  const unavailable = [];
  const backends = config.backends.filter((b) => {
    if (b !== 'webgpu' || info.webgpu.status === 'available') return true;
    unavailable.push({ key: keyOf(0, 'webgpu', '*', '*'), reason: info.webgpu.status || webgpuUnavailableReason() });
    return false;
  });
  const planned = config.repeat * backends.length * config.scenes.length * formats.length;
  const storageKey = `es3d-lan-bench:${config.session}`;
  const hello = await api('api/hello', {
    runId: params.get('fresh') === '1' ? null : store.get(storageKey),
    name: params.get('name') || '',
    device: info,
    plan: planned,
    unavailable,
  });
  store.set(storageKey, hello.runId);
  showDevice(hello.summary, info, backends);
  for (const u of unavailable) addRow('webgpu', 'All scenes', 'WebGPU', 'unavailable', null, u.reason);
  const done = new Set(hello.done);
  let count = [...done].filter((k) => !/\|prepare(-retry)?$/.test(k) && !k.includes('|*|')).length;
  const progress = () => {
    $('bar').style.width = `${planned ? (100 * count) / planned : 100}%`;
  };
  progress();
  if (hello.crashed) {
    const [, backend, sceneId, what] = hello.crashed.split('|');
    const label = (BENCH_SCENES.find((x) => x.id === sceneId) || {}).label || sceneId;
    addRow(backend, label, what.startsWith('prepare') ? 'preparation' : (BROWSER_FORMATS.find((f) => f.id === what) || {}).label || what, 'crashed', null, 'interrupted by a reload or crash; skipped');
  }
  if (count >= planned) {
    await api('api/finish', { runId: hello.runId });
    setStatus('This device has already finished. Add ?fresh=1 to the address to run it again.', 'done');
    return;
  }
  await keepAwake();
  $('detail').textContent = `${config.scenes.length} scenes × ${formats.length} formats on ${backends.join(' and ')}, ${config.frames} frames at ${config.size}${config.repeat > 1 ? `, ${config.repeat} times` : ''}${wakeLock ? ' · screen kept on' : ''}`;

  const send = async (key, status, extra) => {
    if (leaving) throw new Error('page is unloading');
    return api('api/result', { runId: hello.runId, key, status, viewport: config.size, present, ...extra });
  };
  for (let rep = 0; rep < config.repeat; rep++) {
    for (const backend of backends) {
      let r = null;
      let backendError = '';
      try {
        r = await useBackend(backend, width, height);
      } catch (e) {
        backendError = e.message;
      }
      for (const s of config.scenes) {
        const keys = formats.map((f) => keyOf(rep, backend, s.id, f.id));
        if (keys.every((k) => done.has(k))) continue;
        const desc = BENCH_SCENES.find((x) => x.id === s.id);
        // Preparing a scene exports it to every format in memory. If that crashed
        // the page (most likely the OBJ text, 150 MB for the forest), try once
        // more without OBJ; after a second crash give up on the scene.
        const firstTry = keyOf(rep, backend, s.id, 'prepare');
        const retry = keyOf(rep, backend, s.id, 'prepare-retry');
        const noObj = done.has(firstTry);
        let prepared = null;
        let failure = backendError;
        if (!failure && done.has(retry)) failure = 'preparing this scene crashed the page twice';
        if (!failure) {
          await whenVisible();
          setStatus(`${config.repeat > 1 ? `Pass ${rep + 1} of ${config.repeat} · ` : ''}Preparing ${desc.label} (${backend})…`);
          await api('api/start', { runId: hello.runId, key: noObj ? retry : firstTry });
          try {
            const wanted = formats.map((f) => f.id).filter((id) => !(noObj && id === 'obj'));
            prepared = await prepareScene(desc, { formats: wanted, objLimit: config.objLimit, examples: 'examples/' });
            if (noObj) prepared.objNote = 'preparing this scene with OBJ crashed the page; retried without OBJ';
            // discarded warm-up pass, as on the benchmark page: shader compilation
            // and JIT warm-up are not charged to the first measured format
            await runFormat(r, prepared, BROWSER_FORMATS[0], { frames: 3, width, height }).catch(() => {});
          } catch (e) {
            failure = e.message;
          }
        }
        const scene = { id: s.id, label: desc.label, instances: prepared ? prepared.instances : null, triangles: prepared ? prepared.triangles : null };
        for (const f of formats) {
          const key = keyOf(rep, backend, s.id, f.id);
          if (done.has(key)) continue;
          let status = 'ok', note = '', res = {};
          if (failure) {
            status = 'error';
            note = failure;
          } else if (f.id === 'obj' && prepared.objNote) {
            status = 'skipped';
            note = prepared.objNote;
          } else {
            await whenVisible();
            if (config.cooldownMs) {
              setStatus(`Cooling down…`);
              await sleep(config.cooldownMs);
            }
            setStatus(`${config.repeat > 1 ? `Pass ${rep + 1} of ${config.repeat} · ` : ''}${desc.label} · ${f.label} · ${backend === 'webgpu' ? 'WebGPU' : 'WebGL2'} (${count + 1} of ${planned})`);
            await api('api/start', { runId: hello.runId, key });
            hiddenDuring = document.hidden;
            try {
              res = await runFormat(r, prepared, f, { frames: config.frames, width, height });
              if (res.skipped) {
                status = 'skipped';
                note = res.skipped;
              } else if (res.errors && res.errors.length) note = res.errors.join('; ');
            } catch (e) {
              status = 'error';
              note = e.message;
            }
          }
          await send(key, status, { note, adapter: r ? r.info : '', scene, format: { id: f.id, label: f.label }, result: res, interrupted: status === 'ok' ? hiddenDuring : null });
          done.add(key);
          count++;
          progress();
          addRow(backend, desc.label, f.label, status, res, note, config.repeat > 1 ? rep + 1 : 0);
        }
        if (prepared) prepared.data.clear();
      }
      if (r) r.setScene(null, null);
    }
  }
  await api('api/finish', { runId: hello.runId });
  if (wakeLock) wakeLock.release().catch(() => {});
  setStatus(config.repeat > 1
    ? `Done. ${count} results are saved. The median of the ${config.repeat} passes is on the benchmark computer, at /summary.`
    : `Done. ${count} results are saved on the benchmark computer. You can close this tab.`, 'done');
}

main().catch((e) => {
  if (leaving) return;
  setStatus(`Stopped: ${e.message}. Reload the page to continue where it stopped.`, 'failed');
  console.error(e);
});
