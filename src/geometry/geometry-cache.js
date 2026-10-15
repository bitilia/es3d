// Geometry cache: deduplicated, lazily generated meshes.
//
// Geometry is identified by its descriptor key, so identical shapes anywhere
// in a document (and across live edits of the document) share one entry.
// Meshes are generated on first use and per level of detail; an entry that is
// never drawn is never tessellated. Entries unused by the latest scene build
// are evicted.

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
    this.epoch = 0;
    this.useCount = 0;
    this.failed = false;
    this.failedLods = 0; // bit per level whose generation failed (never persisted)
  }
}

export class GeometryCache {
  constructor() {
    this.entries = new Map();
    this.quality = 1;
    this.epoch = 0;
    this.version = 0; // bumps when meshes are invalidated
    this.stats = { generated: 0, generateMs: 0, triangles: 0, restored: 0 };
    this.diagnostics = [];
    this.onDiagnostic = null;
  }

  beginBuild() {
    this.epoch++;
    for (const e of this.entries.values()) e.useCount = 0;
  }

  /** Get or create the entry for a descriptor. */
  acquire(desc, owner) {
    let e = this.entries.get(desc.key);
    if (!e) {
      e = new GeometryEntry(desc, owner);
      this.entries.set(desc.key, e);
    } else if (e.epoch !== this.epoch) {
      // the descriptor closure may reference a newer AST; keep it current
      e.desc = desc;
      e.identity = desc.identity || null;
      e.owner = owner;
      e.bounds = desc.bounds;
      e.doubleSided = desc.doubleSided;
    }
    e.epoch = this.epoch;
    e.useCount++;
    return e;
  }

  /** Drop entries that the latest build did not use. Returns the evicted entries. */
  endBuild() {
    const evicted = [];
    for (const [k, e] of this.entries) {
      if (e.epoch !== this.epoch) {
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
