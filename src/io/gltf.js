// glTF 2.0 binary (GLB) export and import.
//
// Export modes:
//   nodes      one node per instance referencing a shared mesh (glTF's native
//              reuse; hierarchy is flattened because glTF nodes cannot be shared)
//   instanced  EXT_mesh_gpu_instancing: one node per (mesh, material) with
//              TRANSLATION / ROTATION / SCALE instance accessors
// The importer understands both, plus node hierarchies, TRS and matrices.

import * as mat4 from '../math/mat4.js';
import { Mesh } from '../geometry/mesh.js';
import { linearToSrgb } from '../format/colors.js';
import { exportableInstances, materialNames, buildExternalScene, texturedGeometries, InstanceTable } from './external-scene.js';

const FLOAT = 5126;
const INT8 = 5120;
const INT16 = 5122;
const UINT16 = 5123;
const UINT32 = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

const r7 = (v) => (Math.abs(v) < 1e-12 ? 0 : Number(v.toPrecision(7)));

class BinWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.views = [];
    this.accessors = [];
  }
  add(typed, target, byteStride = 0) {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const view = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength };
    if (byteStride) view.byteStride = byteStride;
    if (target) view.target = target;
    this.chunks.push(bytes.slice());
    this.length += bytes.byteLength;
    this.views.push(view);
    return this.views.length - 1;
  }
  accessor(typed, componentType, type, count, target, minmax = null, { byteStride = 0, normalized = false } = {}) {
    const bufferView = this.add(typed, target, byteStride);
    const a = { bufferView, componentType, count, type };
    if (normalized) a.normalized = true;
    if (minmax) {
      a.min = minmax.min;
      a.max = minmax.max;
    }
    this.accessors.push(a);
    return this.accessors.length - 1;
  }
  bytes() {
    const out = new Uint8Array(Math.ceil(this.length / 4) * 4);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }
}

function minMax3(p) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  if (!p.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: min.map((v) => Math.fround(v)), max: max.map((v) => Math.fround(v)) };
}

/**
 * KHR_mesh_quantization: positions as normalized int16 in the mesh's bounding
 * box (the box's centre and half extent go into the node transform), normals
 * as normalized int8. Both padded to 4-byte strides as glTF requires.
 * @returns {{positions: Int16Array, normals: Int8Array, center: number[], half: number[], min: number[], max: number[]}}
 */
function quantizeMesh(mesh) {
  const p = mesh.positions, n = mesh.normals, count = mesh.vertexCount;
  const { min, max } = minMax3(p);
  const center = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
  const half = [0, 1, 2].map((k) => Math.max((max[k] - min[k]) / 2, 1e-12));
  const positions = new Int16Array(count * 4);
  const normals = new Int8Array(count * 4);
  const qmin = [32767, 32767, 32767], qmax = [-32767, -32767, -32767];
  for (let i = 0; i < count; i++) {
    // normals live in the quantized (non-uniformly scaled) space as well: the
    // node's normal matrix undoes S(half), so store normalize(half * n)
    const nx = n[i * 3] * half[0], ny = n[i * 3 + 1] * half[1], nz = n[i * 3 + 2] * half[2];
    const nl = Math.hypot(nx, ny, nz) || 1;
    const nn = [nx / nl, ny / nl, nz / nl];
    for (let k = 0; k < 3; k++) {
      const q = Math.max(-32767, Math.min(32767, Math.round(((p[i * 3 + k] - center[k]) / half[k]) * 32767)));
      positions[i * 4 + k] = q;
      if (q < qmin[k]) qmin[k] = q;
      if (q > qmax[k]) qmax[k] = q;
      normals[i * 4 + k] = Math.max(-127, Math.min(127, Math.round(nn[k] * 127)));
    }
  }
  return { positions, normals, center, half, min: qmin, max: qmax };
}

/**
 * @param {import('../scene/flatten.js').RenderScene} scene
 * @param {(entry:object, lod:number)=>Mesh} meshOf
 * @param {{lod?: number, instancing?: boolean, uvs?: 'auto'|boolean, quantize?: boolean}} [opts]
 *        uvs: 'auto' writes TEXCOORD_0 only for geometry drawn with a textured material;
 *        quantize: KHR_mesh_quantization (int16 positions, int8 normals; lossy)
 * @returns {Uint8Array} GLB bytes
 */
export function exportGLB(scene, meshOf, { lod = 0, instancing = false, uvs = 'auto', quantize = false } = {}) {
  const bin = new BinWriter();
  const names = materialNames(scene.materials);
  const json = {
    asset: { version: '2.0', generator: 'ES3D reference implementation' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: scene.materials.map((m, i) => {
      const mat = {
        name: names[i],
        pbrMetallicRoughness: {
          baseColorFactor: [r7(m.baseColor[0]), r7(m.baseColor[1]), r7(m.baseColor[2]), r7(m.opacity)],
          metallicFactor: r7(m.metallic),
          roughnessFactor: r7(m.roughness),
        },
      };
      if (m.emissive.some((v) => v > 0)) mat.emissiveFactor = m.emissive.map((v) => r7(Math.min(1, v)));
      if (m.alphaMode === 'mask') {
        mat.alphaMode = 'MASK';
        mat.alphaCutoff = m.alphaCutoff ?? 0.5;
      } else if (m.alphaMode === 'blend' || (m.alphaMode !== 'opaque' && m.opacity < 1)) mat.alphaMode = 'BLEND';
      if (m.doubleSided) mat.doubleSided = true;
      return mat;
    }),
    accessors: bin.accessors,
    bufferViews: bin.views,
    buffers: [{ byteLength: 0 }],
  };
  // geometry data, once per (geometry entry, lod)
  const geomData = new Map();
  const meshFor = new Map(); // `${geom}|${mat}` -> glTF mesh index
  const textured = uvs === 'auto' ? texturedGeometries(scene) : null;
  const geomAccessors = (gi) => {
    let g = geomData.get(gi);
    if (g) return g;
    const entry = scene.geometries[gi];
    const mesh = meshOf(entry, Math.min(lod, entry.lods - 1));
    let attributes;
    let dequant = null;
    if (quantize && mesh.kind === 'triangles' && mesh.vertexCount) {
      const q = quantizeMesh(mesh);
      attributes = {
        POSITION: bin.accessor(q.positions, INT16, 'VEC3', mesh.vertexCount, ARRAY_BUFFER, { min: q.min, max: q.max }, { byteStride: 8, normalized: true }),
        NORMAL: bin.accessor(q.normals, INT8, 'VEC3', mesh.vertexCount, ARRAY_BUFFER, null, { byteStride: 4, normalized: true }),
      };
      // vertex = centre + half * normalized: folded into every node using this mesh
      dequant = mat4.createF64();
      dequant[0] = q.half[0];
      dequant[5] = q.half[1];
      dequant[10] = q.half[2];
      dequant[12] = q.center[0];
      dequant[13] = q.center[1];
      dequant[14] = q.center[2];
    } else {
      attributes = { POSITION: bin.accessor(mesh.positions, FLOAT, 'VEC3', mesh.vertexCount, ARRAY_BUFFER, minMax3(mesh.positions)) };
      if (mesh.kind === 'triangles') attributes.NORMAL = bin.accessor(mesh.normals, FLOAT, 'VEC3', mesh.vertexCount, ARRAY_BUFFER);
    }
    if (mesh.kind === 'triangles' && (uvs === true || (textured && textured.has(gi)))) {
      attributes.TEXCOORD_0 = bin.accessor(mesh.uvs, FLOAT, 'VEC2', mesh.vertexCount, ARRAY_BUFFER);
    }
    const small = mesh.vertexCount < 65536;
    const idx = small ? Uint16Array.from(mesh.indices) : mesh.indices;
    const indices = bin.accessor(idx, small ? UINT16 : UINT32, 'SCALAR', idx.length, ELEMENT_ARRAY_BUFFER);
    g = { attributes, indices, mode: mesh.kind === 'lines' ? 1 : 4, empty: mesh.vertexCount === 0, dequant };
    geomData.set(gi, g);
    return g;
  };
  const gltfMesh = (gi, mi) => {
    const key = `${gi}|${mi}`;
    let k = meshFor.get(key);
    if (k !== undefined) return k;
    const g = geomAccessors(gi);
    k = json.meshes.length;
    json.meshes.push({ primitives: [{ attributes: g.attributes, indices: g.indices, material: mi, mode: g.mode }] });
    meshFor.set(key, k);
    return k;
  };
  const list = exportableInstances(scene);
  const m = new Float64Array(16);
  // world matrix of instance i, including the mesh's dequantization (KHR_mesh_quantization)
  const instanceMatrix = (i) => {
    for (let k = 0; k < 16; k++) m[k] = scene.matrices[i * 16 + k];
    const dq = geomAccessors(scene.geom[i]).dequant;
    if (dq) mat4.multiply(m, m, dq);
    return m;
  };
  const nodeFor = (i, meshIndex) => {
    instanceMatrix(i);
    const node = { mesh: meshIndex };
    const d = mat4.decompose(m);
    if (d) {
      if (d.translation.some((v) => Math.abs(v) > 1e-9)) node.translation = d.translation.map(r7);
      if (Math.abs(d.rotation[3] - 1) > 1e-9) node.rotation = d.rotation.map(r7);
      if (d.scale.some((v) => Math.abs(v - 1) > 1e-9)) node.scale = d.scale.map(r7);
    } else {
      node.matrix = Array.from(m, r7);
    }
    json.nodes.push(node);
    json.scenes[0].nodes.push(json.nodes.length - 1);
  };
  if (quantize) {
    json.extensionsUsed = ['KHR_mesh_quantization'];
    json.extensionsRequired = ['KHR_mesh_quantization'];
  }
  if (!instancing) {
    for (const i of list) {
      if (geomAccessors(scene.geom[i]).empty) continue;
      nodeFor(i, gltfMesh(scene.geom[i], scene.mat[i]));
    }
  } else {
    json.extensionsUsed = [...(json.extensionsUsed || []), 'EXT_mesh_gpu_instancing'];
    const groups = new Map();
    for (const i of list) {
      const key = `${scene.geom[i]}|${scene.mat[i]}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(i);
    }
    for (const [key, members] of groups) {
      const [gi, mi] = key.split('|').map(Number);
      if (geomAccessors(gi).empty) continue;
      const meshIndex = gltfMesh(gi, mi);
      // instancing requires shear-free transforms
      const trs = [];
      let ok = members.length > 1;
      for (const i of members) {
        const d = mat4.decompose(instanceMatrix(i));
        if (!d) {
          ok = false;
          break;
        }
        trs.push(d);
      }
      if (!ok) {
        for (const i of members) nodeFor(i, meshIndex);
        continue;
      }
      const T = new Float32Array(members.length * 3);
      const R = new Float32Array(members.length * 4);
      const S = new Float32Array(members.length * 3);
      trs.forEach((d, k) => {
        T.set(d.translation, k * 3);
        R.set(d.rotation, k * 4);
        S.set(d.scale, k * 3);
      });
      const attributes = {
        TRANSLATION: bin.accessor(T, FLOAT, 'VEC3', members.length),
        ROTATION: bin.accessor(R, FLOAT, 'VEC4', members.length),
        SCALE: bin.accessor(S, FLOAT, 'VEC3', members.length),
      };
      json.nodes.push({ mesh: meshIndex, extensions: { EXT_mesh_gpu_instancing: { attributes } } });
      json.scenes[0].nodes.push(json.nodes.length - 1);
    }
  }
  const binBytes = bin.bytes();
  json.buffers[0].byteLength = binBytes.byteLength;
  if (!json.meshes.length) {
    delete json.meshes;
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20);
  jsonPadded.set(jsonBytes);
  const total = 12 + 8 + jsonPadded.length + (binBytes.length ? 8 + binBytes.length : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonPadded, 20);
  if (binBytes.length) {
    const o = 20 + jsonPadded.length;
    dv.setUint32(o, binBytes.length, true);
    dv.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
    out.set(binBytes, o + 8);
  }
  return out;
}

// ---------------------------------------------------------------------------
// import

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const TYPED = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const GETTERS = {
  5120: (v, o) => v.getInt8(o),
  5121: (v, o) => v.getUint8(o),
  5122: (v, o) => v.getInt16(o, true),
  5123: (v, o) => v.getUint16(o, true),
  5125: (v, o) => v.getUint32(o, true),
  5126: (v, o) => v.getFloat32(o, true),
};
const NORMALIZE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

export function isGLB(bytes) {
  return bytes.length >= 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

/**
 * Typed views of accessor data over a list of buffers.
 * Vertex attributes (asFloat) come back as Float32Array, normalized integers mapped to [-1,1] / [0,1].
 */
function makeAccessor(json, buffers) {
  const cache = new Map();
  return (i, asFloat = false) => {
    const key = asFloat ? -1 - i : i;
    if (cache.has(key)) return cache.get(key);
    const a = json.accessors[i];
    if (!a) throw new Error(`glTF accessor ${i} does not exist.`);
    if (a.sparse) throw new Error(`glTF accessor ${i} is sparse; sparse accessors are not supported.`);
    const Ctor = TYPED[a.componentType];
    if (!Ctor) throw new Error(`Unsupported accessor component type ${a.componentType}.`);
    const comps = COMPONENTS[a.type];
    const n = comps * a.count;
    let arr;
    if (a.bufferView === undefined) {
      arr = new Ctor(n); // no data: all zeros (glTF 2.0, 3.6.2.1)
    } else {
      const view = json.bufferViews[a.bufferView];
      const buf = buffers[view.buffer];
      if (!buf) throw new Error(`glTF buffer ${view.buffer} is missing.`);
      const byteOffset = buf.byteOffset + (view.byteOffset || 0) + (a.byteOffset || 0);
      const stride = view.byteStride || 0;
      const elemBytes = comps * Ctor.BYTES_PER_ELEMENT;
      const end = byteOffset + (a.count ? (stride || elemBytes) * (a.count - 1) + elemBytes : 0);
      if (end > buf.byteOffset + buf.byteLength) throw new Error(`glTF accessor ${i} reads past the end of buffer ${view.buffer}.`);
      if (stride && stride !== elemBytes) {
        arr = new Ctor(n);
        const src = new DataView(buf.buffer);
        const get = GETTERS[a.componentType];
        for (let k = 0; k < a.count; k++) {
          for (let c = 0; c < comps; c++) arr[k * comps + c] = get(src, byteOffset + k * stride + c * Ctor.BYTES_PER_ELEMENT);
        }
      } else if (byteOffset % Ctor.BYTES_PER_ELEMENT === 0) {
        arr = new Ctor(buf.buffer, byteOffset, n);
      } else {
        arr = new Ctor(buf.buffer.slice(byteOffset, byteOffset + n * Ctor.BYTES_PER_ELEMENT));
      }
    }
    if (asFloat && !(arr instanceof Float32Array)) {
      const f = new Float32Array(arr.length);
      if (a.normalized) {
        const d = NORMALIZE[a.componentType];
        for (let k = 0; k < arr.length; k++) f[k] = Math.max(arr[k] / d, -1);
      } else f.set(arr);
      arr = f;
    }
    cache.set(key, arr);
    return arr;
  };
}

/**
 * Parse a GLB file.
 * @returns {{json: object, accessor: (i:number, asFloat?: boolean)=>ArrayLike<number>}}
 */
export function parseGLB(bytes) {
  if (!isGLB(bytes)) throw new Error('Not a GLB file (missing glTF magic).');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`Unsupported glTF version ${version}.`);
  let o = 12;
  let json = null;
  let bin = null;
  while (o + 8 <= bytes.byteLength) {
    const len = dv.getUint32(o, true);
    const type = dv.getUint32(o + 4, true);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004e4942) bin = data;
    o += 8 + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk.');
  // buffer 0 without a uri is the BIN chunk; any other buffer must be a data: URI
  const buffers = (json.buffers || []).map((b, i) => (i === 0 && b.uri === undefined ? bin : loadBuffer(b, i, null)));
  return { json, accessor: makeAccessor(json, buffers) };
}

function decodeBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Bytes of a glTF buffer: an embedded data: URI, or a file from `resources`
 * (looked up by its URI, then by its file name, ignoring case).
 */
function loadBuffer(buffer, index, resources) {
  const uri = buffer.uri;
  if (uri === undefined) throw new Error(`glTF buffer ${index} has no data (no uri and no GLB binary chunk).`);
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma < 0 || !/;base64$/i.test(uri.slice(0, comma))) throw new Error(`glTF buffer ${index}: only base64 data: URIs are supported.`);
    return decodeBase64(uri.slice(comma + 1));
  }
  const name = decodeURIComponent(uri);
  const files = resources || {};
  const base = name.split('/').pop();
  const key = [name, base].find((k) => files[k]) || Object.keys(files).find((k) => k.toLowerCase() === base.toLowerCase());
  if (!key) throw new Error(`glTF buffer "${name}" is missing: open it together with the .gltf file.`);
  const bytes = files[key];
  if (bytes.byteLength < (buffer.byteLength || 0)) throw new Error(`glTF buffer "${name}" is ${bytes.byteLength} bytes long but should be ${buffer.byteLength}.`);
  return bytes;
}

/**
 * Parse a glTF JSON file (.gltf).
 * @param {string|Uint8Array|object} input the JSON text, its UTF-8 bytes or the parsed object
 * @param {Record<string, Uint8Array>} [resources] external buffers by file name (scene.bin …)
 */
export function parseGLTF(input, resources = {}) {
  const json = typeof input === 'string' ? JSON.parse(input) : input instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(input)) : input;
  const version = json && json.asset && String(json.asset.version);
  if (!version) throw new Error('Not a glTF file: the JSON has no "asset" with a "version".');
  if (!version.startsWith('2')) throw new Error(`Unsupported glTF version ${version} (only 2.0 is supported).`);
  const buffers = (json.buffers || []).map((b, i) => loadBuffer(b, i, resources));
  return { json, accessor: makeAccessor(json, buffers) };
}

/** out = T * R * S (glTF node TRS; R a unit quaternion). */
function composeTRS(out, tx, ty, tz, qx, qy, qz, qw, sx, sy, sz) {
  mat4.fromQuat(out, qx, qy, qz, qw);
  out[0] *= sx;
  out[1] *= sx;
  out[2] *= sx;
  out[4] *= sy;
  out[5] *= sy;
  out[6] *= sy;
  out[8] *= sz;
  out[9] *= sz;
  out[10] *= sz;
  out[12] = tx;
  out[13] = ty;
  out[14] = tz;
  return out;
}

/** Local matrix of a node (matrix or TRS), written into out. */
function nodeLocal(node, out) {
  if (node.matrix) {
    for (let k = 0; k < 16; k++) out[k] = node.matrix[k];
    return out;
  }
  const t = node.translation, r = node.rotation, s = node.scale;
  return composeTRS(out, t ? t[0] : 0, t ? t[1] : 0, t ? t[2] : 0, r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0, r ? r[3] : 1, s ? s[0] : 1, s ? s[1] : 1, s ? s[2] : 1);
}

/** Convert a GLB file into a RenderScene (mesh reuse becomes GPU instancing). */
export function glbToScene(bytes) {
  return sceneFromGltf(parseGLB(bytes));
}

/** Convert a .gltf JSON file (with its external buffers, if any) into a RenderScene. */
export function gltfToScene(input, resources = {}) {
  return sceneFromGltf(parseGLTF(input, resources));
}

/** Triangle (or line) index list of a primitive in any glTF topology; null for points. */
function primitiveIndices(src, mode) {
  const n = src.length;
  switch (mode) {
    case 4: // TRIANGLES
    case 1: // LINES
      return src instanceof Uint32Array ? src : Uint32Array.from(src);
    case 5: { // TRIANGLE_STRIP
      const out = new Uint32Array(Math.max(0, n - 2) * 3);
      for (let i = 0; i + 2 < n; i++) {
        const even = (i & 1) === 0;
        out[i * 3] = src[even ? i : i + 1];
        out[i * 3 + 1] = src[even ? i + 1 : i];
        out[i * 3 + 2] = src[i + 2];
      }
      return out;
    }
    case 6: { // TRIANGLE_FAN
      const out = new Uint32Array(Math.max(0, n - 2) * 3);
      for (let i = 0; i + 2 < n; i++) {
        out[i * 3] = src[0];
        out[i * 3 + 1] = src[i + 1];
        out[i * 3 + 2] = src[i + 2];
      }
      return out;
    }
    case 3: // LINE_STRIP
    case 2: { // LINE_LOOP
      const segs = mode === 2 ? n : n - 1;
      const out = new Uint32Array(Math.max(0, segs) * 2);
      for (let i = 0; i < segs; i++) {
        out[i * 2] = src[i];
        out[i * 2 + 1] = src[(i + 1) % n];
      }
      return out;
    }
    default: // POINTS
      return null;
  }
}

function sceneFromGltf({ json, accessor }) {
  const skipped = { points: 0, textures: 0 };
  const materials = (json.materials || []).map((m, i) => {
    const pbr = m.pbrMetallicRoughness || {};
    const c = pbr.baseColorFactor || [1, 1, 1, 1];
    const e = m.emissiveFactor || [0, 0, 0];
    return {
      name: m.name || `material${i}`,
      color: [linearToSrgb(c[0]), linearToSrgb(c[1]), linearToSrgb(c[2]), 1],
      opacity: c[3],
      metallic: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      alphaMode: (m.alphaMode || 'OPAQUE').toLowerCase() === 'mask' ? 'mask' : (m.alphaMode || 'OPAQUE').toLowerCase() === 'blend' ? 'blend' : 'opaque',
      alphaCutoff: m.alphaCutoff ?? 0.5,
      emissive: [linearToSrgb(e[0]), linearToSrgb(e[1]), linearToSrgb(e[2]), 1],
      doubleSided: !!m.doubleSided,
    };
  });
  const defaultMat = materials.length;
  materials.push({ name: 'default' });
  const geometries = [];
  const meshParts = new Map(); // glTF mesh -> [{geom, mat}] per primitive
  // primitives that share their accessors (one mesh drawn with several
  // materials) share one geometry, so the data is uploaded to the GPU once
  const byAccessors = new Map();
  const geometryOf = (mi, pi) => {
    const prim = json.meshes[mi].primitives[pi];
    const at = prim.attributes;
    const key = [at.POSITION, at.NORMAL, at.TEXCOORD_0, prim.indices, prim.mode].join('|');
    const known = byAccessors.get(key);
    if (known !== undefined) return known;
    const positions = accessor(prim.attributes.POSITION, true);
    let normals = prim.attributes.NORMAL !== undefined ? accessor(prim.attributes.NORMAL, true) : null;
    if (normals && json.accessors[prim.attributes.NORMAL].normalized) {
      // quantized normals: restore unit length
      normals = Float32Array.from(normals);
      for (let k = 0; k < normals.length; k += 3) {
        const l = Math.hypot(normals[k], normals[k + 1], normals[k + 2]) || 1;
        normals[k] /= l;
        normals[k + 1] /= l;
        normals[k + 2] /= l;
      }
    }
    const uvs = prim.attributes.TEXCOORD_0 !== undefined ? accessor(prim.attributes.TEXCOORD_0, true) : null;
    const mode = prim.mode === undefined ? 4 : prim.mode;
    const src = prim.indices !== undefined ? accessor(prim.indices) : Uint32Array.from({ length: positions.length / 3 }, (_, k) => k);
    const indices = primitiveIndices(src, mode);
    if (!indices) {
      skipped.points++;
      byAccessors.set(key, -1);
      return -1;
    }
    const mesh = new Mesh({ positions, normals, uvs, indices, kind: mode >= 1 && mode <= 3 ? 'lines' : 'triangles' });
    geometries.push({ mesh });
    byAccessors.set(key, geometries.length - 1);
    return geometries.length - 1;
  };
  const partsOf = (mi) => {
    let parts = meshParts.get(mi);
    if (!parts) {
      parts = json.meshes[mi].primitives
        .map((prim, pi) => ({ geom: prim.attributes && prim.attributes.POSITION !== undefined ? geometryOf(mi, pi) : -1, mat: prim.material !== undefined ? prim.material : defaultMat }))
        .filter((p) => p.geom >= 0);
      meshParts.set(mi, parts);
    }
    return parts;
  };
  // scratch matrices: one world matrix per hierarchy level, no per-instance allocations
  const instances = new InstanceTable(Math.max(64, json.nodes ? json.nodes.length : 0));
  const worlds = [];
  const local = mat4.createF64();
  const inst = mat4.createF64();
  const visit = (ni, parent, depth) => {
    const node = json.nodes[ni];
    const world = mat4.multiply(worlds[depth] || (worlds[depth] = mat4.createF64()), parent, nodeLocal(node, local));
    if (node.mesh !== undefined) {
      const parts = partsOf(node.mesh);
      const ext = node.extensions && node.extensions.EXT_mesh_gpu_instancing;
      if (ext) {
        const A = ext.attributes;
        const T = A.TRANSLATION !== undefined ? accessor(A.TRANSLATION, true) : null;
        const R = A.ROTATION !== undefined ? accessor(A.ROTATION, true) : null;
        const S = A.SCALE !== undefined ? accessor(A.SCALE, true) : null;
        const count = (T || R || S).length / (T ? 3 : R ? 4 : 3);
        for (let k = 0; k < count; k++) {
          composeTRS(
            local,
            T ? T[k * 3] : 0, T ? T[k * 3 + 1] : 0, T ? T[k * 3 + 2] : 0,
            R ? R[k * 4] : 0, R ? R[k * 4 + 1] : 0, R ? R[k * 4 + 2] : 0, R ? R[k * 4 + 3] : 1,
            S ? S[k * 3] : 1, S ? S[k * 3 + 1] : 1, S ? S[k * 3 + 2] : 1,
          );
          mat4.multiply(inst, world, local);
          for (const p of parts) instances.push(p.geom, p.mat, inst);
        }
      } else {
        for (const p of parts) instances.push(p.geom, p.mat, world);
      }
    }
    if (node.children) for (const c of node.children) visit(c, world, depth + 1);
  };
  const nodes = json.nodes || [];
  const sceneDef = json.scenes && json.scenes.length ? json.scenes[json.scene || 0] : { nodes: nodes.map((_, i) => i).filter((i) => !nodes.some((p) => p.children && p.children.includes(i))) };
  const root = mat4.createF64();
  for (const n of sceneDef.nodes || []) visit(n, root, 0);
  skipped.textures = (json.materials || []).filter((m) => (m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture) || m.normalTexture || m.emissiveTexture).length;
  return { ...buildExternalScene({ geometries, materials, instances }), json, skipped };
}
