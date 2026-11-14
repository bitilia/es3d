// A scene set: the instance tables a stage draws together, the host
// document's and one per fragment (stage.add).
//
// Each part keeps the RenderScene that compile() made for it, unchanged, so
// setTransforms, animation and ids work inside a part exactly as in a single
// document. Rows refer to their own document's geometry and material lists;
// the set keeps one list of each for all parts and a small map per part from
// its indices to the set's. The frame builder and picking read every placed,
// visible part through those maps (frame-builder.js, picking.js), so adding,
// hiding or removing a part never copies, moves or renumbers anyone's rows.
//
// Materials with identical parameters are one material across all parts (the
// specification asks readers to deduplicate them), and a geometry entry the
// host and several tiles use is one entry. Both lists count their users: a
// slot no part uses is freed, and its geometry is reported to the renderer
// (takeReleased) so the pool can repack once enough of it is unused.
//
// While nothing but the host is placed, the order of both lists is the order
// the host's own lists have, and parts placed in turn extend them in the order
// one merged document would: the picture is the same as showing that document.

import { Material } from '../material/materials.js';

const EMPTY_BOUNDS = () => ({ min: [-1, -1, -1], max: [1, 1, 1] });

/** One document drawn by a scene set: the host, or a fragment. */
export class ScenePart {
  /**
   * @param {string|null} id fragment id (null for the host)
   * @param {'host'|'fragment'} kind
   */
  constructor(id, kind = 'fragment') {
    this.id = id;
    this.kind = kind;
    /** @type {import('./flatten.js').RenderScene|null} null until placed */
    this.scene = null;
    this.geomMap = null; // Uint32Array: part geometry index -> set index
    this.matMap = null; // Uint32Array: part material index -> set index
    this.visible = true;
    // renderer.selection holds the host's element uids; fragments have their own
    this.selectable = kind === 'host';
  }

  /** Placed and drawn. */
  get drawn() {
    return !!(this.scene && this.visible);
  }
}

export class SceneSet {
  constructor() {
    /** @type {ScenePart[]} host first, then fragments in the order added */
    this.parts = [];
    this.host = null;
    this.geometries = [];
    this.geomIndex = new Map(); // entry -> set index
    this.geomUsers = [];
    this.freeGeometries = [];
    this.materials = [];
    this.matIndex = new Map(); // material key -> set index
    this.matUsers = [];
    this.freeMaterials = [];
    this.released = []; // geometry entries no part uses any more
    this.version = 0; // bumps when parts are placed, hidden or removed
    this.boundsDirty = true;
    this.cachedBounds = EMPTY_BOUNDS();
  }

  /** Add a part at the end (fragments) or at the front (the host). */
  insert(part) {
    if (part.kind === 'host') {
      if (this.host) throw new Error('A scene set has one host.');
      this.host = part;
      this.parts.unshift(part);
    } else this.parts.push(part);
    this.changed();
    return part;
  }

  /** Take a part out of the set and free what only it used. */
  remove(part) {
    const i = this.parts.indexOf(part);
    if (i < 0) return false;
    this.unplace(part);
    this.parts.splice(i, 1);
    if (part === this.host) this.host = null;
    this.changed();
    return true;
  }

  /**
   * Draw a compiled scene as this part (replacing what it drew before).
   * Costs what the part's own geometry and material lists do.
   * @param {ScenePart} part
   * @param {import('./flatten.js').RenderScene} scene
   */
  place(part, scene) {
    const geomMap = new Uint32Array(scene.geometries.length);
    for (let k = 0; k < scene.geometries.length; k++) geomMap[k] = this.useGeometry(scene.geometries[k]);
    const matMap = new Uint32Array(scene.materials.length);
    for (let k = 0; k < scene.materials.length; k++) matMap[k] = this.useMaterial(scene.materials[k]);
    // release the old content after taking the new, so what both use stays
    this.unplace(part);
    part.scene = scene;
    part.geomMap = geomMap;
    part.matMap = matMap;
    this.changed();
  }

  /** Stop drawing a part's content and free what only it used. */
  unplace(part) {
    if (!part.scene) return;
    for (const gi of part.geomMap) this.dropGeometry(gi);
    for (const mi of part.matMap) this.dropMaterial(mi);
    part.scene = null;
    part.geomMap = null;
    part.matMap = null;
    this.changed();
  }

  setVisible(part, visible) {
    const v = !!visible;
    if (part.visible === v) return;
    part.visible = v;
    this.changed();
  }

  /** Something that changes bounds, lights or the drawn rows happened. */
  changed() {
    this.version++;
    this.boundsDirty = true;
  }

  /** Bounds moved inside a part (setTransforms, animation). */
  invalidateBounds() {
    this.boundsDirty = true;
  }

  useGeometry(entry) {
    let i = this.geomIndex.get(entry);
    if (i === undefined) {
      i = this.freeGeometries.length ? this.freeGeometries.pop() : this.geometries.length;
      this.geometries[i] = entry;
      this.geomUsers[i] = 0;
      this.geomIndex.set(entry, i);
    }
    this.geomUsers[i]++;
    return i;
  }

  dropGeometry(i) {
    if (--this.geomUsers[i] > 0) return;
    const entry = this.geometries[i];
    this.geomIndex.delete(entry);
    this.geometries[i] = null;
    this.freeGeometries.push(i);
    this.released.push(entry);
  }

  useMaterial(m) {
    let i = this.matIndex.get(m.key);
    if (i === undefined) {
      i = this.freeMaterials.length ? this.freeMaterials.pop() : this.materials.length;
      this.materials[i] = new Material(m.params, i, m.name);
      this.matUsers[i] = 0;
      this.matIndex.set(m.key, i);
    }
    this.matUsers[i]++;
    return i;
  }

  dropMaterial(i) {
    if (--this.matUsers[i] > 0) return;
    this.matIndex.delete(this.materials[i].key);
    this.materials[i] = null;
    this.freeMaterials.push(i);
  }

  /** Geometry entries no part uses since the last call. */
  takeReleased() {
    const r = this.released;
    this.released = [];
    return r;
  }

  /** Placed, visible parts in drawing order. */
  drawnParts() {
    const out = [];
    for (const p of this.parts) if (p.scene && p.visible) out.push(p);
    return out;
  }

  /** Instance rows drawn. */
  get count() {
    let n = 0;
    for (const p of this.parts) if (p.scene && p.visible) n += p.scene.count;
    return n;
  }

  /** Union of the drawn parts' bounds, recomputed when something changed. */
  get bounds() {
    if (!this.boundsDirty) return this.cachedBounds;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of this.parts) {
      // an empty part reports the ±1 stand-in flattenScene gives an empty scene
      if (!p.scene || !p.visible || !p.scene.count) continue;
      const b = p.scene.bounds;
      for (let k = 0; k < 3; k++) {
        if (b.min[k] < min[k]) min[k] = b.min[k];
        if (b.max[k] > max[k]) max[k] = b.max[k];
      }
    }
    this.cachedBounds = min[0] <= max[0] ? { min, max } : EMPTY_BOUNDS();
    this.boundsDirty = false;
    return this.cachedBounds;
  }

  /** Lights of the drawn parts, host first, as one merged document lists them. */
  get lights() {
    const parts = this.parts;
    if (parts.length === 1 && parts[0].scene && parts[0].visible) return parts[0].scene.lights;
    const out = [];
    for (const p of parts) if (p.scene && p.visible) for (const l of p.scene.lights) out.push(l);
    return out;
  }

  /** Clocks the drawn parts' animations use. */
  get animation() {
    const a = { time: false, scroll: false };
    for (const p of this.parts) {
      if (!p.scene || !p.visible) continue;
      if (p.scene.animation.time) a.time = true;
      if (p.scene.animation.scroll) a.scroll = true;
    }
    return a;
  }

  // the host's alone: a fragment's <environment>, <camera> and <controls> are ignored
  get environment() {
    return this.host && this.host.scene ? this.host.scene.environment : null;
  }

  get controls() {
    return this.host && this.host.scene ? this.host.scene.controls : null;
  }

  get cameras() {
    return this.host && this.host.scene ? this.host.scene.cameras : [];
  }
}
