// A document compiled somewhere else (a worker), ready to place.
//
// compile() makes objects that cannot cross to another thread: the scene
// graph's geometry entries hold generator closures over the parsed tree. So a
// worker runs the whole pipeline and also generates the meshes, and sends
// back only plain data, most of it as transferred buffers (nothing copied):
//
//   - the instance table (RenderScene rows, exact length),
//   - each geometry's descriptor fields (key, identity, levels, bounds) as
//     columns and, for keys this worker has not sent before, its generated
//     meshes with the diagnostics generation reported. A level identical to
//     the one before it (a straight-sided extrusion has four) is sent once
//     and shared, and every mesh of the document is packed into four buffers:
//     a few transfers, not four per level (thousands for a large tile, each
//     with a cost of its own when the message arrives).
//   - material parameters, lights, cameras, lod switches, bounds,
//   - the diagnostics as plain fields (Diagnostic is rebuilt here, so the
//     codes, messages and locations are exactly those compile() reports).
//
// The main thread turns that back into a RenderScene whose entries live in
// the stage's GeometryCache (resultFromPayload): an entry whose key the cache
// has is reused, a new one adopts the worker's meshes the way the persistent
// store's are adopted, and a level the worker did not send is generated from
// the document on first use. The parsed tree and the scene graph are never
// sent: unpacking them would cost the main thread about what parsing does.
// When a page needs them (setTransforms on that document, or names for a
// pick), the document is compiled on the main thread then.
//
// A document the payload cannot carry (one with <animate>, which updateDynamic
// rewalks through the graph every frame, or with textures) comes back as
// `main: true`, and the main thread compiles it as it would without workers.

import { compile, elementDiagnostic } from '../pipeline.js';
import { Diagnostic, LineIndex } from '../format/errors.js';
import { GeometryCache } from '../geometry/geometry-cache.js';
import { Mesh } from '../geometry/mesh.js';
import { FINER_FACTORS } from '../geometry/lod-error.js';
import { Material } from '../material/materials.js';
import { RenderScene } from './flatten.js';

/**
 * Code of the stage's own warning for an element a fragment cannot set.
 * It is not a format diagnostic: a document that has these elements is valid,
 * and opened on its own it uses them.
 */
export const HOST_ONLY = 'STAGE_HOST_ONLY';

const HOST_ONLY_ELEMENTS = {
  environment: 'the environment',
  camera: 'a camera',
  controls: 'the controls',
};

/**
 * Warnings for the <environment>, <camera> and <controls> elements of a
 * document shown as a fragment: they belong to the host and are ignored.
 * @param {object} result a compile() result
 * @returns {Diagnostic[]}
 */
export function hostOnlyWarnings(result) {
  const doc = result && result.doc;
  if (!doc || !doc.root) return [];
  const out = [];
  const visit = (el) => {
    if (el.unknown) return;
    const what = HOST_ONLY_ELEMENTS[el.name];
    if (what) {
      out.push(elementDiagnostic(doc, {
        severity: 'warning',
        phase: 'render',
        code: HOST_ONLY,
        message: `A fragment cannot set ${what}: the stage's document does. This element is ignored.`,
        element: el,
      }));
    }
    for (const c of el.children) if (c.type === 'element') visit(c);
  };
  visit(doc.root);
  return out;
}

const DIAGNOSTIC_FIELDS = ['severity', 'phase', 'code', 'message', 'offset', 'length', 'suggestion', 'hint', 'path', 'line', 'column', 'uid'];

/** A Diagnostic as plain fields (structured-clone safe). */
export function plainDiagnostic(d) {
  const o = {};
  for (const k of DIAGNOSTIC_FIELDS) o[k] = d[k] === undefined ? null : d[k];
  return o;
}

/** The Diagnostic those fields describe, located as it was. */
export function diagnosticFrom(o) {
  const d = new Diagnostic(o);
  d.line = o.line ?? 0;
  d.column = o.column ?? 0;
  return d;
}

const KINDS = ['triangles', 'lines'];
const kindCode = (k) => Math.max(0, KINDS.indexOf(k));
const sameArray = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const sameMesh = (a, b) => a.kind === b.kind && sameArray(a.indices, b.indices) && sameArray(a.positions, b.positions) && sameArray(a.normals, b.normals) && sameArray(a.uvs, b.uvs);

/**
 * Geometry descriptors as columns, and the meshes of keys not sent before
 * packed into four buffers. levels[g * maxLods + l] is the mesh index of
 * level l of geometry g, -1 when it is not sent.
 */
function packGeometries(entries, cache, sent) {
  const n = entries.length;
  const maxLods = entries.reduce((m, e) => Math.max(m, e.lods), 1);
  const keys = new Array(n);
  const identities = new Array(n);
  const lods = new Uint8Array(n);
  const flags = new Uint8Array(n); // 1 double-sided, 2 has bounds, 4 failed somewhere, 8 has finer levels
  const kinds = new Uint8Array(n);
  const bounds = new Float64Array(n * 6);
  const deviation = new Float64Array(n * maxLods);
  const devLength = new Uint8Array(n);
  // bounds of the levels finer than level 0 (made on demand, never sent)
  const F = FINER_FACTORS.length;
  const finer = new Float64Array(n * F);
  const levels = new Int32Array(n * maxLods).fill(-1);
  const reports = []; // [g, l, reports] for levels that reported something
  const failed = []; // [g, l]
  const meshes = [];
  entries.forEach((e, g) => {
    keys[g] = e.key;
    identities[g] = e.identity;
    lods[g] = e.lods;
    kinds[g] = kindCode(e.kind);
    flags[g] = (e.doubleSided ? 1 : 0) | (e.bounds ? 2 : 0) | (e.finerDeviation ? 8 : 0);
    if (e.finerDeviation) for (let i = 0; i < F; i++) finer[g * F + i] = e.finerDeviation[i];
    if (e.bounds) bounds.set([...e.bounds.min, ...e.bounds.max], g * 6);
    devLength[g] = Math.min(e.lodDeviation.length, maxLods);
    for (let l = 0; l < devLength[g]; l++) deviation[g * maxLods + l] = e.lodDeviation[l];
    const tag = `${cache.quality}:${e.key}`;
    if (sent && sent.has(tag)) return;
    let prev = null;
    for (let l = 0; l < e.lods; l++) {
      const m = cache.mesh(e, l);
      if (e.reports[l]) reports.push([g, l, e.reports[l]]);
      if (e.failedLods & (1 << l)) failed.push([g, l]);
      if (prev && sameMesh(prev, m)) {
        levels[g * maxLods + l] = levels[g * maxLods + l - 1];
        continue;
      }
      levels[g * maxLods + l] = meshes.length;
      meshes.push(m);
      prev = m;
    }
    if (sent) sent.add(tag);
  });
  // one buffer per attribute; a mesh is a range of each (offsets in elements)
  const table = new Uint32Array(meshes.length * 8);
  const meshKinds = new Uint8Array(meshes.length);
  const total = [0, 0, 0, 0];
  meshes.forEach((m, k) => {
    const arrays = [m.positions, m.normals, m.uvs, m.indices];
    arrays.forEach((a, j) => {
      table[k * 8 + j * 2] = total[j];
      table[k * 8 + j * 2 + 1] = a.length;
      total[j] += a.length;
    });
    meshKinds[k] = kindCode(m.kind);
  });
  const positions = new Float32Array(total[0]);
  const normals = new Float32Array(total[1]);
  const uvs = new Float32Array(total[2]);
  const indices = new Uint32Array(total[3]);
  meshes.forEach((m, k) => {
    positions.set(m.positions, table[k * 8]);
    normals.set(m.normals, table[k * 8 + 2]);
    uvs.set(m.uvs, table[k * 8 + 4]);
    indices.set(m.indices, table[k * 8 + 6]);
  });
  const columns = { keys, identities, lods, flags, kinds, bounds, deviation, devLength, finer, levels, maxLods, reports, failed };
  const packed = { table, meshKinds, positions, normals, uvs, indices };
  const buffers = [lods, flags, kinds, bounds, deviation, devLength, finer, levels, table, meshKinds, positions, normals, uvs, indices].map((a) => a.buffer);
  return { columns, packed, buffers };
}

/** The meshes of a packed payload, as views into its four buffers. */
function unpackMeshes(packed) {
  const { table, meshKinds, positions, normals, uvs, indices } = packed;
  const out = new Array(meshKinds.length);
  for (let k = 0; k < out.length; k++) {
    const o = k * 8;
    out[k] = new Mesh({
      positions: positions.subarray(table[o], table[o] + table[o + 1]),
      normals: normals.subarray(table[o + 2], table[o + 2] + table[o + 3]),
      uvs: uvs.subarray(table[o + 4], table[o + 4] + table[o + 5]),
      indices: indices.subarray(table[o + 6], table[o + 6] + table[o + 7]),
      kind: KINDS[meshKinds[k]],
    });
  }
  return out;
}

const textured = (m) => {
  const p = m.params;
  return !!(p.map || p.normalMap || p.occlusionMap || p.metallicRoughnessMap || p.emissiveMap);
};

// A typed array that owns its whole buffer can be transferred; a view into a
// larger one (a WebAssembly heap, a shared pool) is copied first.
const own = (a) => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : a.slice());

/**
 * Compile a document and describe the result as transferable data. Runs in
 * the worker (compile-worker.js); tests run it on one thread.
 * @param {string|ArrayBuffer|Uint8Array} input
 * @param {{time?: number, progress?: number, quality?: number, sent?: Set<string>}} [opts]
 *   sent: keys (with quality) whose meshes this worker already sent; their meshes are not sent again
 * @returns {{message: object, transfer: ArrayBuffer[]}}
 */
export function preparePayload(input, opts = {}) {
  const cache = new GeometryCache();
  if (opts.quality) cache.quality = opts.quality;
  const result = compile(input, { cache, time: opts.time || 0, progress: opts.progress || 0 });
  const lineIndex = result.doc && result.doc.lineIndex;
  const base = {
    ok: result.ok,
    diagnostics: result.diagnostics.map(plainDiagnostic),
    hostOnly: result.ok ? hostOnlyWarnings(result).map(plainDiagnostic) : [],
    timings: result.timings,
    // the text diagnostics point into, when it is not the input itself (decoded bytes)
    lineText: lineIndex && typeof lineIndex.text === 'string' && lineIndex.text !== input ? lineIndex.text : null,
    lineIndex: !!lineIndex,
  };
  if (!result.ok) return { message: base, transfer: [] };
  const scene = result.scene;
  if (scene.dynamic.length || scene.materials.some(textured)) return { message: { ...base, main: true }, transfer: [] };

  const transfer = new Set();
  const take = (a) => {
    const o = own(a);
    transfer.add(o.buffer);
    return o;
  };
  const n = scene.count;
  const rows = {
    count: n,
    matrices: take(scene.matrices.slice(0, n * 16)),
    geom: take(scene.geom.slice(0, n)),
    mat: take(scene.mat.slice(0, n)),
    uid: take(scene.uid.slice(0, n)),
    lodNode: take(scene.lodNode.slice(0, n)),
    lodChild: take(scene.lodChild.slice(0, n)),
    flags: take(scene.flags.slice(0, n)),
    spheres: take(scene.spheres.slice(0, n * 4)),
  };
  const sent = opts.sent;
  const geometries = packGeometries(scene.geometries, cache, sent);
  for (const b of geometries.buffers) transfer.add(b);
  const message = {
    ...base,
    scene: {
      rows,
      geometries: geometries.columns,
      meshes: geometries.packed,
      materials: scene.materials.map((m) => ({ params: m.params, name: m.name })),
      lights: scene.lights,
      cameras: scene.cameras,
      lodSwitches: scene.lodSwitches,
      environment: scene.environment,
      controls: scene.controls,
      animation: scene.animation,
      bounds: scene.bounds,
    },
  };
  return { message, transfer: [...transfer] };
}

/**
 * A document compiled by prepare(), ready for stage.add() or stage.show().
 * `ok` and `diagnostics` are known at once; diagnostics are those compile()
 * reports (and, for `as: 'fragment'`, the stage's warnings for elements a
 * fragment cannot set).
 */
export class Prepared {
  /**
   * @param {object} o
   * @param {'fragment'|'document'} o.as
   * @param {string|ArrayBuffer|Uint8Array} o.source
   * @param {object|null} [o.payload] from preparePayload (a worker)
   * @param {object|null} [o.result] a compile() result made on this thread
   * @param {*} [o.owner] the cache owner holding that result's geometry
   * @param {Diagnostic[]} [o.hostOnly]
   */
  constructor(o) {
    this.as = o.as || 'fragment';
    this.source = o.source;
    this.payload = o.payload || null;
    this.result = o.result || null;
    this.owner = o.owner ?? null;
    this.used = false;
    const p = this.payload;
    if (p) {
      this.ok = p.ok;
      this.documentDiagnostics = p.diagnostics.map(diagnosticFrom);
      this.hostOnly = p.hostOnly.map(diagnosticFrom);
      this.timings = p.timings;
      this.lineText = p.lineText;
      this.hasLineIndex = p.lineIndex;
    } else {
      this.ok = this.result.ok;
      this.documentDiagnostics = this.result.diagnostics;
      this.hostOnly = o.hostOnly || [];
      this.timings = this.result.timings;
      this.lineText = null;
      this.hasLineIndex = !!(this.result.doc && this.result.doc.lineIndex);
    }
    this.lineIndexCache = undefined;
  }

  /** Diagnostics as the stage reports them for this use. */
  get diagnostics() {
    return this.as === 'fragment' ? [...this.documentDiagnostics, ...this.hostOnly] : this.documentDiagnostics;
  }

  /** Line positions for formatDiagnostics (made on first use; errors only need them). */
  get lineIndex() {
    if (this.lineIndexCache !== undefined) return this.lineIndexCache;
    if (this.result && this.result.doc) return (this.lineIndexCache = this.result.doc.lineIndex);
    const text = this.lineText || (typeof this.source === 'string' ? this.source : null);
    return (this.lineIndexCache = this.hasLineIndex && text ? new LineIndex(text) : null);
  }
}

/**
 * Rebuild a worker's scene on this thread, with its geometry in `cache` held
 * by `owner`. Costs what the scene's rows and geometry list are: the rows are
 * the transferred arrays themselves.
 * @param {object} payload a preparePayload message with ok and scene
 * @param {GeometryCache} cache
 * @param {*} owner
 * @param {(key: string) => object} realDescriptor descriptor of a key, from the document compiled
 *   here, for a level the worker did not send (called on first use only)
 * @returns {import('./flatten.js').RenderScene}
 */
export function sceneFromPayload(payload, cache, owner, realDescriptor) {
  const p = payload.scene;
  const scene = new RenderScene(1);
  const r = p.rows;
  scene.count = r.count;
  scene.capacity = r.count;
  scene.matrices = r.matrices;
  scene.geom = r.geom;
  scene.mat = r.mat;
  scene.uid = r.uid;
  scene.lodNode = r.lodNode;
  scene.lodChild = r.lodChild;
  scene.flags = r.flags;
  scene.spheres = r.spheres;
  const c = p.geometries;
  const meshes = unpackMeshes(p.meshes);
  const M = c.maxLods;
  const reports = new Map(c.reports.map(([g, l, r]) => [g * M + l, r]));
  const failed = new Set(c.failed.map(([g, l]) => g * M + l));
  cache.beginBuild(owner);
  for (let g = 0; g < c.keys.length; g++) {
    const key = c.keys[g];
    const lodDeviation = Array.from(c.deviation.subarray(g * M, g * M + c.devLength[g]));
    const b = c.bounds;
    const desc = {
      key,
      identity: c.identities[g],
      kind: KINDS[c.kinds[g]],
      lods: c.lods[g],
      doubleSided: !!(c.flags[g] & 1),
      bounds: c.flags[g] & 2 ? { min: [b[g * 6], b[g * 6 + 1], b[g * 6 + 2]], max: [b[g * 6 + 3], b[g * 6 + 4], b[g * 6 + 5]] } : null,
      lodDeviation,
      finerDeviation: c.flags[g] & 8 ? Array.from(c.finer.subarray(g * FINER_FACTORS.length, (g + 1) * FINER_FACTORS.length)) : null,
      generate: (lod, quality, report) => realDescriptor(key).generate(lod, quality, report),
    };
    const entry = cache.acquire(desc, null);
    for (let l = 0; l < desc.lods; l++) {
      const k = c.levels[g * M + l];
      if (k < 0 || entry.meshes[l]) continue;
      if (failed.has(g * M + l)) {
        entry.failed = true;
        entry.failedLods |= 1 << l;
      }
      cache.adopt(entry, l, meshes[k], reports.get(g * M + l) || null);
    }
    scene.geometryIndex(entry);
  }
  cache.endBuild();
  scene.materials = p.materials.map((m, i) => new Material(m.params, i, m.name));
  scene.lights = p.lights;
  scene.cameras = p.cameras;
  scene.lodSwitches = p.lodSwitches;
  scene.environment = p.environment;
  scene.controls = p.controls;
  scene.animation = p.animation;
  scene.bounds = p.bounds;
  scene.version = 1;
  return scene;
}
