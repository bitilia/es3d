// The stage's compiler thread.
//
// The stage is one file. A page that calls stage.prepare() starts a worker
// from that same file; there it finds itself in a worker and serves compile
// requests instead of drawing (render/stage.js calls serveCompiler). The
// worker runs preparePayload (scene/prepared.js): parsing, validation,
// building, flattening and mesh generation, and sends the result back as
// transferred buffers.
//
// A worker script must come from the page's origin. A stage loaded from a CDN
// is started through a small module made in the page (a blob URL) that
// imports the stage by its URL, which the CDN's CORS headers allow. Where
// neither works (a content security policy without worker-src blob:, an old
// browser, Node), every request is compiled on the main thread instead, and
// the page does not need to know.

import { preparePayload } from '../scene/prepared.js';
import { early, inWorker } from './worker-boot.js';

/** True inside a dedicated worker. */
export function isWorkerScope() {
  return inWorker;
}

// a worker that has not answered its first request by then is given up on
const FIRST_ANSWER_MS = 10000;

// keys whose meshes this worker sent; capped, so a long session does not grow it forever
const SENT_LIMIT = 200000;

/**
 * Answer compile requests posted to this worker.
 * @param {object} scope the worker's global scope
 */
export function serveCompiler(scope) {
  const sent = new Set();
  const answer = (e) => {
    const { id, input, time, progress, quality } = e.data || {};
    if (sent.size > SENT_LIMIT) sent.clear();
    let reply;
    try {
      reply = preparePayload(input, { time, progress, quality, sent });
    } catch (err) {
      scope.postMessage({ id, error: String(err && err.message ? err.message : err) });
      return;
    }
    try {
      scope.postMessage({ id, ...reply.message }, reply.transfer);
    } catch (err) {
      // something in the scene could not be cloned: the main thread compiles it
      scope.postMessage({ id, ok: reply.message.ok, diagnostics: reply.message.diagnostics, hostOnly: reply.message.hostOnly, timings: reply.message.timings, lineText: reply.message.lineText, lineIndex: reply.message.lineIndex, main: true });
    }
  };
  scope.onmessage = answer;
  // requests that came while the module was still loading (worker-boot.js)
  for (const e of early.splice(0)) answer(e);
}

/** Start a module worker running this file, or null where none can start. */
function startWorker(url) {
  if (typeof Worker !== 'function' || !url) return null;
  const sameOrigin = typeof location === 'undefined' || new URL(url).origin === location.origin;
  try {
    if (sameOrigin) return new Worker(url, { type: 'module' });
  } catch {
    // fall through to the blob module
  }
  try {
    const blob = new Blob([`import ${JSON.stringify(url)};`], { type: 'text/javascript' });
    return new Worker(URL.createObjectURL(blob), { type: 'module' });
  } catch {
    return null;
  }
}

/**
 * The page's side: posts documents to the worker and resolves each request
 * with its payload. A failed worker (it did not load, or it crashed) answers
 * every waiting and later request with null, which means: compile here.
 */
export class CompilerClient {
  /** @param {string} url this module's file (the stage bundle's import.meta.url) */
  constructor(url) {
    this.worker = startWorker(url);
    this.failed = !this.worker;
    this.pending = new Map();
    this.next = 1;
    if (!this.worker) return;
    this.answered = false;
    this.watchdog = 0;
    this.worker.onmessage = (e) => {
      const msg = e.data;
      this.answered = true;
      clearTimeout(this.watchdog);
      const done = this.pending.get(msg.id);
      if (!done) return;
      this.pending.delete(msg.id);
      done(msg.error ? null : msg);
    };
    const fail = () => {
      clearTimeout(this.watchdog);
      this.failed = true;
      for (const done of this.pending.values()) done(null);
      this.pending.clear();
      try { this.worker.terminate(); } catch {}
    };
    this.worker.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      fail();
    };
    this.worker.onmessageerror = fail;
    this.fail = fail;
  }

  /**
   * @param {string|ArrayBuffer|Uint8Array} input copied to the worker, not transferred
   * @param {{time?: number, progress?: number, quality?: number}} opts
   * @returns {Promise<object|null>} the payload, or null: compile on this thread
   */
  compile(input, opts) {
    if (this.failed) return Promise.resolve(null);
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      // a worker that never starts (blocked, or its module failed silently)
      // must not hold the page's documents: compile them here instead
      if (!this.answered && !this.watchdog) this.watchdog = setTimeout(() => this.fail(), FIRST_ANSWER_MS);
      try {
        this.worker.postMessage({ id, input, time: opts.time, progress: opts.progress, quality: opts.quality });
      } catch {
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    for (const done of this.pending.values()) done(null);
    this.pending.clear();
    this.failed = true;
  }
}
