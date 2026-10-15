// Shared helpers for exporters and importers of conventional mesh formats.

import { RenderScene } from '../scene/flatten.js';
import { Material, DEFAULT_MATERIAL_PARAMS } from '../material/materials.js';

/**
 * Instances that a static exporter should write: every instance outside <lod>
 * switches, and the most detailed alternative (child 0) inside them.
 */
export function exportableInstances(scene) {
  const sw = scene.lodSwitches;
  const visible = new Uint8Array(sw.length);
  for (let s = 0; s < sw.length; s++) {
    const w = sw[s];
    visible[s] = w.parent < 0 ? 1 : visible[w.parent] && w.parentChild === 0 ? 1 : 0;
  }
  const out = [];
  for (let i = 0; i < scene.count; i++) {
    const ln = scene.lodNode[i];
    if (ln >= 0 && !(visible[ln] && scene.lodChild[i] === 0)) continue;
    out.push(i);
  }
  return out;
}

/**
 * Geometry indices that are drawn with a textured material. Exporters write
 * texture coordinates only for these (with `uvs: 'auto'`): UVs of untextured
 * procedural geometry are dead weight in a mesh file.
 */
export function texturedGeometries(scene) {
  const out = new Set();
  for (let i = 0; i < scene.count; i++) {
    const m = scene.materials[scene.mat[i]];
    if (m && (m.map || m.normalMap)) out.add(scene.geom[i]);
  }
  return out;
}

/** Stable, unique names for materials (OBJ usemtl / glTF material names). */
export function materialNames(materials) {
  const used = new Set();
  return materials.map((m, i) => {
    let base = String(m.name || `material${i}`).replace(/[^A-Za-z0-9_.-]/g, '_') || `material${i}`;
    let name = base;
    let k = 1;
    while (used.has(name)) name = `${base}_${k++}`;
    used.add(name);
    return name;
  });
}

/** Growable flat instance table (no per-instance allocations for large imports). */
export class InstanceTable {
  constructor(capacity = 64) {
    this.count = 0;
    this.geom = new Int32Array(capacity);
    this.mat = new Int32Array(capacity);
    this.matrices = new Float64Array(capacity * 16);
  }

  push(geom, mat, matrix) {
    if (this.count === this.geom.length) {
      const cap = this.geom.length * 2;
      const g = new Int32Array(cap), m = new Int32Array(cap), x = new Float64Array(cap * 16);
      g.set(this.geom);
      m.set(this.mat);
      x.set(this.matrices);
      this.geom = g;
      this.mat = m;
      this.matrices = x;
    }
    const i = this.count++;
    this.geom[i] = geom;
    this.mat[i] = mat;
    const o = i * 16, x = this.matrices;
    for (let k = 0; k < 16; k++) x[o + k] = matrix[k];
  }
}

/**
 * Build a RenderScene from already tessellated meshes (OBJ / glTF imports).
 * @param {{geometries: {mesh: import('../geometry/mesh.js').Mesh, key?: string}[],
 *          materials: object[], instances: InstanceTable}} data
 *        materials are parameter objects in the ES3D material model (sRGB colors)
 */
export function buildExternalScene(data) {
  const table = data.instances;
  const scene = new RenderScene(Math.max(16, table.count));
  scene.environment = { background: [0.09, 0.1, 0.12, 1], sky: [0.8, 0.86, 0.95, 1], ground: [0.25, 0.22, 0.2, 1], intensity: 0.5, exposure: 1 };
  scene.materials = data.materials.map((p, i) => new Material({ ...DEFAULT_MATERIAL_PARAMS, ...p }, i, p.name || `material${i}`));
  if (!scene.materials.length) scene.materials.push(new Material({ ...DEFAULT_MATERIAL_PARAMS }, 0, 'default'));
  const entries = data.geometries.map((g, i) => ({
    id: i + 1,
    key: g.key || `external:${i}`,
    kind: g.mesh.kind,
    lods: 1,
    doubleSided: false,
    bounds: g.mesh.bounds,
    meshes: [g.mesh],
  }));
  const gIndex = entries.map((e) => scene.geometryIndex(e));
  const lastMat = scene.materials.length - 1;
  const world = new Float64Array(16);
  for (let i = 0; i < table.count; i++) {
    for (let k = 0; k < 16; k++) world[k] = table.matrices[i * 16 + k];
    scene.setInstance(i, gIndex[table.geom[i]], Math.min(table.mat[i], lastMat), world, 0, -1, 0);
  }
  scene.count = table.count;
  if (!(scene.bounds.min[0] <= scene.bounds.max[0])) scene.bounds = { min: [-1, -1, -1], max: [1, 1, 1] };
  scene.version++;
  return { scene, meshOf: (entry) => entry.meshes[0] };
}

/** Trimmed fixed-point number formatting (used by text exporters). */
export function fixed(v, digits) {
  if (!Number.isFinite(v)) return '0';
  let s = v.toFixed(digits);
  if (s.indexOf('.') >= 0) {
    let e = s.length;
    while (s.charCodeAt(e - 1) === 48) e--;
    if (s.charCodeAt(e - 1) === 46) e--;
    s = s.slice(0, e);
  }
  if (s === '-0') return '0';
  return s;
}
