// Geometry cache: deduplicated, lazily generated meshes.
//
// Geometry is identified by its descriptor key, so identical shapes anywhere
// in a document (and across live edits of the document) share one entry.
// Meshes are generated on first use and per level of detail; an entry that is
// never drawn is never tessellated.
//
// Each build belongs to an owner. A page showing one document has one owner
// (DOCUMENT), and an entry its latest build did not use is evicted, as before.
// A stage that shows fragments next to its document builds each of them under
// an owner of its own (any object), so building one tile does not evict the
// meshes of the host or of other tiles: an entry goes once no owner holds it.

import { Mesh } from './mesh.js';

let nextEntryId = 1;

export class GeometryEntry {
  constructor(desc, owner) {
    this.id = nextEntryId++;
    this.key = desc.key;
    // name of the shape in the persistent cache (src/cache/), null if none
    this.identity = desc.identity || null;
    this.desc = desc;
    this.kind = desc.kind;
    this.lods = desc.lods;
    this.doubleSided = desc.doubleSided;
    this.bounds = desc.bounds;
    this.lodDeviation = desc.lodDeviation || [0];
    this.meshes = new Array(desc.lods).fill(null);
    // diagnostics reported while generating each level, kept so that a mesh
    // restored from the persistent cache reports them again
    this.reports = new Array(desc.lods).fill(null);
    this.owner = owner; // first element using this geometry (diagnostics)
    this.owners = new Set(); // build owners holding this entry (GeometryCache.held)
    this.epoch = 0;
    this.useCount = 0;
    this.failed = false;
    this.failedLods = 0; // bit per level whose generation failed (never persisted)
  }
}

/** The owner of builds that name none: the one document a page shows. */
export const DOCUMENT = 'document';

export class GeometryCache {
  constructor() {
    this.entries = new Map();
    this.held = new Map(); // owner -> Set of the entries its latest build used
    this.building = null; // owner of the build in progress
    this.buildSet = null;
    // called with each entry a level was generated for (the stage stores them per owner)
    this.onGenerate = null;
    this.quality = 1;
    this.epoch = 0;
    this.version = 0; // bumps when meshes are invalidated
    this.stats = { generated: 0, generateMs: 0, triangles: 0, restored: 0 };
    this.diagnostics = [];
    this.onDiagnostic = null;
  }

  /**
   * Start a build. Entries acquired until endBuild() belong to `owner`.
   * @param {*} [owner] DOCUMENT, or any object for a fragment's build
   */
  beginBuild(owner = DOCUMENT) {
    this.epoch++;
    this.building = owner;
    this.buildSet = new Set();
    if (owner === DOCUMENT) for (const e of this.entries.values()) e.useCount = 0;
  }

  /** Get or create the entry for a descriptor. */
  acquire(desc, owner) {
    let e = this.entries.get(desc.key);
    if (!e) {
      e = new GeometryEntry(desc, owner);
      this.entries.set(desc.key, e);
    } else if (e.epoch !== this.epoch && !this.heldByOthers(e)) {
      // the descriptor closure may reference a newer AST; keep it current.
      // An entry another owner holds keeps its descriptor and owner element,
      // so its diagnostics stay in that owner's document.
      e.desc = desc;
      e.identity = desc.identity || null;
      e.owner = owner;
      e.bounds = desc.bounds;
      e.doubleSided = desc.doubleSided;
    }
    e.epoch = this.epoch;
    e.useCount++;
    if (this.buildSet) this.buildSet.add(e);
    return e;
  }

  heldByOthers(e) {
    for (const o of e.owners) if (o !== this.building) return true;
    return false;
  }

  /**
   * End a build: its owner now holds exactly the entries it acquired. Entries
   * no owner holds are dropped. Returns the evicted entries.
   */
  endBuild() {
    const owner = this.building === null ? DOCUMENT : this.building;
    const used = this.buildSet || new Set();
    const before = this.held.get(owner);
    this.held.set(owner, used);
    for (const e of used) e.owners.add(owner);
    const dropped = [];
    if (before) {
      for (const e of before) {
        if (used.has(e)) continue;
        e.owners.delete(owner);
        dropped.push(e);
      }
    }
    this.building = null;
    this.buildSet = null;
    // the document's build sweeps the whole cache, as it always has; a
    // fragment's build only looks at what it held, so it costs what the fragment does
    if (owner === DOCUMENT) return this.evictUnheld();
    const evicted = [];
    for (const e of dropped) {
      if (e.owners.size === 0 && this.entries.get(e.key) === e) {
        this.entries.delete(e.key);
        evicted.push(e);
      }
    }
    return evicted;
  }

  /**
   * Forget everything an owner holds (a fragment that was removed or
   * replaced). Returns the evicted entries.
   */
  release(owner) {
    const set = this.held.get(owner);
    if (!set) return [];
    this.held.delete(owner);
    for (const e of set) e.owners.delete(owner);
    const evicted = [];
    for (const e of set) {
      if (e.owners.size === 0 && this.entries.get(e.key) === e) {
        this.entries.delete(e.key);
        evicted.push(e);
      }
    }
    return evicted;
  }

  /** The entries an owner's latest build used (empty when it has none). */
  owned(owner = DOCUMENT) {
    return this.held.get(owner) || new Set();
  }

  evictUnheld() {
    const evicted = [];
    for (const [k, e] of this.entries) {
      if (e.owners.size === 0) {
        this.entries.delete(k);
        evicted.push(e);
      }
    }
    return evicted;
  }

  setQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    for (const e of this.entries.values()) {
      e.meshes.fill(null);
      e.reports.fill(null);
      e.failedLods = 0;
    }
    this.version++;
  }

  /** Mesh of an entry at a level of detail, generated on demand. */
  mesh(entry, lod = 0) {
    const l = Math.min(Math.max(lod, 0), entry.lods - 1);
    let m = entry.meshes[l];
    if (m) return m;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const reports = [];
    const report = (severity, code, message) => {
      reports.push({ severity, code, message });
      this.emit(entry, severity, code, message);
    };
    try {
      m = entry.desc.generate(l, this.quality, report);
    } catch (err) {
      report('error', 'E_GEOMETRY', `Geometry generation failed: ${err && err.message ? err.message : err}`);
      m = null;
    }
    if (!m) {
      entry.failed = true;
      entry.failedLods |= 1 << l;
      m = emptyMesh(entry.kind);
    }
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.stats.generated++;
    this.stats.generateMs += t1 - t0;
    entry.meshes[l] = m;
    entry.reports[l] = reports.length ? reports : null;
    if (this.onGenerate) this.onGenerate(entry);
    return m;
  }

  emit(entry, severity, code, message) {
    const d = { severity, code, message, element: entry.owner, phase: 'geometry' };
    this.diagnostics.push(d);
    if (this.onDiagnostic) this.onDiagnostic(d);
  }

  /**
   * Take a mesh made earlier (the persistent cache) as level `lod` of an entry,
   * with the diagnostics its generation reported. A level that exists stays.
   * @returns {boolean} whether the mesh was taken
   */
  adopt(entry, lod, mesh, reports = null) {
    if (lod < 0 || lod >= entry.lods || entry.meshes[lod]) return false;
    entry.meshes[lod] = mesh;
    entry.reports[lod] = reports && reports.length ? reports : null;
    if (reports) for (const r of reports) this.emit(entry, r.severity, r.code, r.message);
    this.stats.restored++;
    return true;
  }

  /** Generate every level of detail of every entry (benchmarks, exports). */
  generateAll(maxLod = 0) {
    for (const e of this.entries.values()) for (let l = 0; l <= Math.min(maxLod, e.lods - 1); l++) this.mesh(e, l);
  }

  takeDiagnostics() {
    const d = this.diagnostics;
    this.diagnostics = [];
    return d;
  }
}

function emptyMesh(kind) {
  return new Mesh({ positions: new Float32Array(0), indices: new Uint32Array(0), kind });
}
