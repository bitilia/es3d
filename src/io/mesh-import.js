// Conversion of tessellated scenes (OBJ / STL / glTF imports) into ES3D documents.
//
// Every distinct mesh becomes one <mesh> definition in <defs>, every instance
// a <use> with its transform, every material a <material>. This is the
// "escape hatch" path: the result is valid ES3D but not procedural, so it is
// about as large as the source mesh format (see the report).

import { h, Document } from '../format/ast.js';
import { serialize } from '../format/serializer.js';
import { formatNumber, formatFloat32 } from '../format/value-format.js';
import { matrixToTransformString } from '../transform/transform.js';
import { linearToSrgb, colorToHex } from '../format/colors.js';
import { weldMap } from '../geometry/mesh.js';
import { materialNames } from './external-scene.js';

/** Decimals that keep coordinates to `relative` of the scene size (e.g. 1e-5). */
export function decimalsFor(bounds, relative) {
  const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  if (!(size > 0) || !Number.isFinite(size)) return 5;
  return Math.max(0, Math.min(9, Math.ceil(-Math.log10(size * relative))));
}

/** Merge vertices with equal positions (when neither normals nor UVs are written, they are redundant). */
function welded(mesh) {
  const map = weldMap(mesh.positions);
  const n = mesh.vertexCount;
  const remap = new Int32Array(n).fill(-1);
  let unique = 0;
  for (let i = 0; i < n; i++) if (remap[map[i]] < 0) remap[map[i]] = unique++;
  if (unique === n) return { positions: mesh.positions, indices: mesh.indices };
  const positions = new Float32Array(unique * 3);
  for (let i = 0; i < n; i++) {
    const r = remap[map[i]] * 3;
    positions[r] = mesh.positions[i * 3];
    positions[r + 1] = mesh.positions[i * 3 + 1];
    positions[r + 2] = mesh.positions[i * 3 + 2];
  }
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = remap[map[mesh.indices[i]]];
  return { positions, indices };
}

/**
 * @param {import('../scene/flatten.js').RenderScene} scene
 * @param {(entry: object, lod: number) => import('../geometry/mesh.js').Mesh} meshOf
 * @param {string} [title]
 * @param {{digits?: number|null|'auto', normals?: boolean, uvs?: boolean|'auto', smooth?: number, relative?: number}} [opts]
 *        digits: decimals for positions ('auto' = relative precision of the scene size, null = exact float32);
 *        normals: false omits them, and the reader recomputes them with the crease angle `smooth`;
 *        uvs: 'auto' writes texture coordinates only when they are not all zero
 * @returns {string} ES3D markup
 */
export function sceneToMeshDocument(scene, meshOf, title = 'Imported mesh', { digits = 'auto', normals = true, uvs = 'auto', smooth = 30, relative = 1e-5 } = {}) {
  const decimals = digits === 'auto' ? decimalsFor(scene.bounds, relative) : digits;
  const fmt = decimals === null ? (v) => formatFloat32(v) : (v) => formatNumber(v, decimals);
  const names = materialNames(scene.materials);
  const defs = h('defs');
  scene.materials.forEach((m, i) => {
    const attrs = { id: names[i], color: colorToHex([linearToSrgb(m.baseColor[0]), linearToSrgb(m.baseColor[1]), linearToSrgb(m.baseColor[2]), 1]) };
    if (m.metallic) attrs.metallic = formatNumber(m.metallic, 3);
    if (m.roughness !== 0.5) attrs.roughness = formatNumber(m.roughness, 3);
    if (m.opacity < 1) attrs.opacity = formatNumber(m.opacity, 3);
    if (m.alphaMode === 'mask') {
      attrs.alphaMode = 'mask';
      if (m.alphaCutoff !== 0.5) attrs.alphaCutoff = formatNumber(m.alphaCutoff, 3);
    } else if (m.alphaMode === 'blend') attrs.alphaMode = 'blend';
    const peak = Math.max(...m.emissive);
    if (peak > 0) {
      // emissive is stored linear and pre-multiplied by its intensity
      const k = peak > 1 ? 1 / peak : 1;
      attrs.emissive = colorToHex([linearToSrgb(m.emissive[0] * k), linearToSrgb(m.emissive[1] * k), linearToSrgb(m.emissive[2] * k), 1]);
      if (peak > 1) attrs.emissiveIntensity = formatNumber(peak, 3);
    }
    if (m.doubleSided) attrs.doubleSided = 'true';
    defs.appendChild(h('material', attrs));
  });
  const meshIds = new Map();
  scene.geometries.forEach((entry, gi) => {
    const mesh = meshOf(entry, 0);
    if (mesh.kind !== 'triangles' || !mesh.vertexCount) return;
    const id = `mesh${gi}`;
    meshIds.set(gi, id);
    const writeUvs = uvs === true || (uvs === 'auto' && mesh.uvs.some((v) => v !== 0));
    const data = !normals && !writeUvs ? welded(mesh) : mesh;
    const attrs = { id, positions: Array.from(data.positions, fmt).join(' ') };
    if (normals) attrs.normals = Array.from(mesh.normals, (v) => formatNumber(v, 2)).join(' ');
    if (writeUvs) attrs.uvs = Array.from(mesh.uvs, (v) => formatNumber(v, 4)).join(' ');
    attrs.indices = Array.from(data.indices).join(' ');
    if (!normals && smooth !== 30) attrs.smooth = formatNumber(smooth, 2);
    defs.appendChild(h('mesh', attrs));
  });
  const root = h('es3d', { version: '1' }, h('title', {}, String(title)), defs);
  const m = new Float64Array(16);
  for (let i = 0; i < scene.count; i++) {
    const id = meshIds.get(scene.geom[i]);
    if (!id) continue;
    for (let k = 0; k < 16; k++) m[k] = scene.matrices[i * 16 + k];
    const attrs = { ref: id, material: names[scene.mat[i]] };
    const t = matrixToTransformString(m, (v) => formatNumber(v, 6));
    if (t) attrs.transform = t;
    root.appendChild(h('use', attrs));
  }
  return serialize(new Document({ root, syntax: 'xml' }), { pretty: true });
}
