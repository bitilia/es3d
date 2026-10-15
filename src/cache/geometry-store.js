// Persistent geometry cache: the meshes a document's shapes produced, kept
// between page loads so that a repeat visit reads them instead of
// tessellating again.
//
// - One record per document (one read on load), in ES3D's own binary layout
//   (mesh-bundle.js), named by content: one SHA-256 over every cached shape's
//   identity (its parameters and the full text of its path or point data),
//   the generator revision, the quality setting and what the engine's Math
//   functions return, which the generators use. Change any of them and the
//   name changes; nothing is ever invalidated by date. Web Crypto computes
//   the digest where the page has it, sha256.js where it does not.
// - Stored in IndexedDB, which pages served over plain http (a local
//   network) have too, unlike Cache Storage and crypto.subtle. A store is
//   only a get/put interface, so other places work as well (memoryStore,
//   or a file store in Node).
// - Bounded: least recently used records go first once the store holds more
//   than `maxBytes` or `maxRecords`; records of another generator revision go
//   before anything else.
// - Advisory: a missing, unreadable, slow or invalid record means the meshes
//   are generated as before. Nothing it stores changes what is drawn: the
//   restored meshes are bit-identical to the ones generation would produce.
//
// Authored <mesh> data is not cached: hashing it costs about what computing
// its normals does.

import { sha256 } from './sha256.js';
import { encodeBundle, decodeBundle } from './mesh-bundle.js';

/**
 * Bump whenever any generator's output changes, even by one bit
 * (test/geometry-cache.test.mjs fails until the recorded digest of every
 * example's meshes matches this revision).
 */
export const GEOMETRY_REVISION = 1;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

let fingerprint = null;

/**
 * What this engine's Math functions return for a fixed set of arguments
 * (bytes). IEEE 754 does not pin them down, and the generators use them, so
 * meshes made by one engine are only reused by an engine that agrees.
 */
export function mathFingerprint() {
  if (fingerprint) return fingerprint;
  const out = new Float64Array(9 * 24);
  let k = 0;
  for (let i = 0; i < 24; i++) {
    const x = (i - 11.5) * 0.8284271247461902;
    out[k++] = Math.sin(x);
    out[k++] = Math.cos(x);
    out[k++] = Math.tan(x);
    out[k++] = Math.atan2(x, 1.7 - i * 0.11);
    out[k++] = Math.acos(Math.max(-1, Math.min(1, x / 10)));
    out[k++] = Math.hypot(x, i * 0.3);
    out[k++] = Math.hypot(x, i * 0.3, 1 / (i + 1));
    out[k++] = Math.cbrt(x);
    out[k++] = Math.sqrt(i + 0.1);
  }
  fingerprint = new Uint8Array(out.buffer);
  return fingerprint;
}

const subtle = typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function' ? crypto.subtle : null;
const utf8 = new TextEncoder();

async function digest(bytes, native) {
  if (native && subtle) {
    try {
      const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
      let hex = '';
      for (const b of d) hex += (b < 16 ? '0' : '') + b.toString(16);
      return hex;
    } catch {
      // fall through to the script version
    }
  }
  return sha256(bytes);
}

/**
 * The cacheable entries of a cache, ordered by identity (so the order in
 * which a long-lived cache first saw them does not matter), and the name of
 * their record.
 * @param {import('../geometry/geometry-cache.js').GeometryCache} cache
 * @param {{native?: boolean}} [opts] native: false always uses sha256.js
 */
export async function geometryKey(cache, opts = {}) {
  const entries = [];
  for (const e of cache.entries.values()) if (e.identity) entries.push(e);
  if (!entries.length) return { key: null, entries };
  entries.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  // identities are length-prefixed (registry.js), so their concatenation is unambiguous
  const text = utf8.encode(`es3d-geometry:${GEOMETRY_REVISION}:${cache.quality}:${entries.length}:${entries.map((e) => e.identity).join('')}`);
  const math = mathFingerprint();
  const bytes = new Uint8Array(text.length + math.length);
  bytes.set(text);
  bytes.set(math, text.length);
  return { key: await digest(bytes, opts.native !== false), entries };
}

/** Levels worth storing: generated, not failed, and not a stand-in. */
function storedLevels(entry) {
  const levels = [];
  for (let l = 0; l < entry.lods; l++) {
    const mesh = entry.meshes[l];
    if (mesh && !(entry.failedLods & (1 << l))) levels.push({ lod: l, mesh, reports: entry.reports[l] });
  }
  return levels;
}

const withTimeout = (promise, ms) =>
  ms > 0 && ms < Infinity ? Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(undefined), ms))]) : promise;

/**
 * Fill a cache with the meshes stored for its current shapes. Call after
 * compile() and before the first frame; levels that exist already are kept.
 * @param {import('../geometry/geometry-cache.js').GeometryCache} cache
 * @param {object|Promise<object>} store from openGeometryStore() (null: nothing to do)
 * @param {{timeout?: number}} [opts] give up on a store slower than this (ms, default 250)
 * @returns {Promise<{hit: boolean, key: string|null, levels: number, bytes: number, ms: number, reason?: string}>}
 */
export async function restoreGeometry(cache, store, opts = {}) {
  const t0 = now();
  const done = (r) => ({ hit: false, key: null, levels: 0, bytes: 0, ...r, ms: now() - t0 });
  const s = await withTimeout(Promise.resolve(store), opts.timeout ?? 250);
  if (!s) return done({ reason: s === undefined ? 'store timed out' : 'no store' });
  const { key, entries } = await geometryKey(cache);
  if (!key) return done({ reason: 'nothing cacheable' });
  let buffer;
  try {
    buffer = await withTimeout(s.get(key), opts.timeout ?? 250);
  } catch {
    buffer = null;
  }
  if (buffer === undefined) return done({ key, reason: 'store timed out' });
  if (!buffer) {
    cache.persisted = null;
    return done({ key, reason: 'miss' });
  }
  const bundle = decodeBundle(buffer);
  if (!bundle || bundle.key !== key || bundle.entries.length !== entries.length) {
    // unreadable or not what it claims to be: drop it, generate instead
    Promise.resolve(s.delete(key)).catch(() => {});
    return done({ key, reason: 'invalid record' });
  }
  // the key covers the identities in this order, so the lists line up
  let levels = 0, held = 0;
  for (let i = 0; i < entries.length; i++) {
    const stored = bundle.entries[i];
    held += stored.length;
    for (const { lod, mesh, reports } of stored) if (cache.adopt(entries[i], lod, mesh, reports)) levels++;
  }
  // what the store holds: saving is worth it once the cache holds more
  cache.persisted = `${key}:${held}`;
  return { hit: true, key, levels, bytes: buffer.byteLength, ms: now() - t0 };
}

function countLevels(entries) {
  let n = 0;
  for (const e of entries) n += storedLevels(e).length;
  return n;
}

/**
 * Store the meshes a cache holds for its current shapes, if it holds any the
 * store does not have yet. Call when the page is idle after drawing.
 * @param {import('../geometry/geometry-cache.js').GeometryCache} cache
 * @param {object|Promise<object>} store
 * @returns {Promise<{saved: boolean, key: string|null, bytes: number, reason?: string}>}
 */
export async function saveGeometry(cache, store) {
  const s = await store;
  if (!s) return { saved: false, key: null, bytes: 0, reason: 'no store' };
  const { key, entries } = await geometryKey(cache);
  if (!key) return { saved: false, key: null, bytes: 0, reason: 'nothing cacheable' };
  const signature = `${key}:${countLevels(entries)}`;
  if (cache.persisted === signature) return { saved: false, key, bytes: 0, reason: 'up to date' };
  const records = entries.map(storedLevels);
  if (!records.some((levels) => levels.length)) return { saved: false, key, bytes: 0, reason: 'nothing generated' };
  const buffer = encodeBundle(key, records);
  if (s.maxBytes && buffer.byteLength > s.maxBytes / 4) return { saved: false, key, bytes: buffer.byteLength, reason: 'too large' };
  try {
    await s.put(key, buffer);
  } catch (e) {
    return { saved: false, key, bytes: buffer.byteLength, reason: `store failed: ${e && e.message ? e.message : e}` };
  }
  cache.persisted = signature;
  return { saved: true, key, bytes: buffer.byteLength };
}

/**
 * For pages: keep a geometry cache and a store in step. Call restore() after
 * compile() and changed() after drawing; meshes generated since the last save
 * are saved once nothing new has been generated for `delay` ms and the page
 * is idle.
 * @param {object|Promise<object>|null} store null: both calls do nothing
 * @param {{delay?: number}} [opts]
 */
export function persistGeometry(store, opts = {}) {
  const delay = opts.delay ?? 1500;
  const idle = typeof requestIdleCallback === 'function' ? (fn) => requestIdleCallback(fn, { timeout: 5000 }) : (fn) => setTimeout(fn, 0);
  let timer = 0;
  let pending = null;
  let seen = -1;
  return {
    store,
    restore(cache, restoreOpts) {
      return store ? restoreGeometry(cache, store, restoreOpts) : Promise.resolve(null);
    },
    changed(cache) {
      if (!store || (cache === pending && cache.stats.generated === seen)) return;
      pending = cache;
      seen = cache.stats.generated;
      clearTimeout(timer);
      timer = setTimeout(() => idle(() => {
        const c = pending;
        pending = null;
        if (c) saveGeometry(c, store).catch(() => {});
      }), delay);
    },
  };
}

// --- stores ---------------------------------------------------------------------

const DEFAULTS = { maxBytes: 64 * 1024 * 1024, maxRecords: 256 };

/**
 * A store in memory (tests, Node, one page's lifetime). Keeps copies, as a
 * real store would.
 */
export function memoryStore(opts = {}) {
  const { maxBytes, maxRecords } = { ...DEFAULTS, ...opts };
  const records = new Map();
  let clock = 0;
  const prune = () => {
    let total = 0;
    for (const r of records.values()) total += r.data.byteLength;
    const order = [...records].sort((a, b) => a[1].used - b[1].used);
    while (order.length && (total > maxBytes || records.size > maxRecords)) {
      const [k, r] = order.shift();
      records.delete(k);
      total -= r.data.byteLength;
    }
  };
  return {
    kind: 'memory',
    maxBytes,
    async get(key) {
      const r = records.get(key);
      if (!r) return null;
      r.used = ++clock;
      return r.data.slice(0);
    },
    async put(key, data) {
      records.set(key, { data: data.slice(0), used: ++clock });
      prune();
    },
    async delete(key) {
      records.delete(key);
    },
    async clear() {
      records.clear();
    },
    get size() {
      return records.size;
    },
  };
}

const request = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const transaction = (t) =>
  new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });

/**
 * A store in IndexedDB. Two object stores: `data` (record name -> bundle)
 * and `meta` (record name -> {key, bytes, used, revision}, indexed by `used`),
 * so pruning reads the small records only.
 * @param {{name?: string, maxBytes?: number, maxRecords?: number, timeout?: number}} [opts]
 * @returns {Promise<object|null>} null where IndexedDB is missing or refuses
 */
export async function indexedDBStore(opts = {}) {
  const { name, maxBytes, maxRecords, timeout } = { name: 'es3d-geometry', timeout: 2000, ...DEFAULTS, ...opts };
  const idb = typeof indexedDB !== 'undefined' ? indexedDB : null;
  if (!idb) return null;
  let db;
  try {
    db = await withTimeout(
      new Promise((resolve, reject) => {
        const r = idb.open(name, 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('data')) d.createObjectStore('data');
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' }).createIndex('used', 'used');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => resolve(null);
      }),
      timeout,
    );
  } catch {
    return null;
  }
  if (!db) return null;
  // let another tab upgrade or delete the database
  db.onversionchange = () => db.close();
  const touch = (key) => {
    try {
      const t = db.transaction('meta', 'readwrite');
      const meta = t.objectStore('meta');
      const r = meta.get(key);
      r.onsuccess = () => {
        if (r.result) meta.put({ ...r.result, used: Date.now() });
      };
    } catch {
      // closed or busy: the order of eviction is a hint only
    }
  };
  return {
    kind: 'indexeddb',
    maxBytes,
    async get(key) {
      const t = db.transaction('data', 'readonly');
      const data = await request(t.objectStore('data').get(key));
      if (!(data instanceof ArrayBuffer)) return null;
      (typeof requestIdleCallback === 'function' ? requestIdleCallback : setTimeout)(() => touch(key));
      return data;
    },
    async put(key, data) {
      const t = db.transaction(['data', 'meta'], 'readwrite');
      const store = t.objectStore('data');
      const meta = t.objectStore('meta');
      store.put(data, key);
      meta.put({ key, bytes: data.byteLength, used: Date.now(), revision: GEOMETRY_REVISION });
      // prune in the same transaction: other revisions first, then the least recently used
      const all = await request(meta.getAll());
      all.sort((a, b) => (a.revision === GEOMETRY_REVISION) - (b.revision === GEOMETRY_REVISION) || a.used - b.used);
      let total = all.reduce((s, r) => s + r.bytes, 0);
      let count = all.length;
      for (const r of all) {
        if (r.key === key) continue;
        if (r.revision === GEOMETRY_REVISION && total <= maxBytes && count <= maxRecords) break;
        store.delete(r.key);
        meta.delete(r.key);
        total -= r.bytes;
        count--;
      }
      await transaction(t);
    },
    async delete(key) {
      const t = db.transaction(['data', 'meta'], 'readwrite');
      t.objectStore('data').delete(key);
      t.objectStore('meta').delete(key);
      await transaction(t);
    },
    async clear() {
      const t = db.transaction(['data', 'meta'], 'readwrite');
      t.objectStore('data').clear();
      t.objectStore('meta').clear();
      await transaction(t);
    },
    close() {
      db.close();
    },
  };
}

/**
 * The best store this environment offers (IndexedDB), or null. Open it early,
 * in parallel with fetching the document; restoreGeometry() takes the promise.
 * `persist: true` also asks the browser not to evict the origin's storage
 * under pressure (navigator.storage.persist(); browsers may ask the user).
 */
export async function openGeometryStore(opts = {}) {
  const store = await indexedDBStore(opts).catch(() => null);
  if (store && opts.persist && typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
  return store;
}
