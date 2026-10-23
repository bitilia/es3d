// Packed glTF binary written by the file converter (`es3d glb`).
//
// The binary is the same world as the document: every instance, material,
// light, camera and animation. Meshes are instanced, quantized
// (KHR_mesh_quantization), meshopt-compressed, and textures are WebP.
// Tessellation levels are MSFT_lod. Explicit <lod> switches and the scroll
// flight are the extras the castle glTF stage reads.
//
// Node only. The in-browser download stays on exportGLB, so the site bundle
// does not load meshoptimizer or sharp.

import fs from 'node:fs';
import path from 'node:path';
import { compile } from '../pipeline.js';
import { sampleAnimation } from '../scene/animation.js';
import { localMatrix } from '../transform/transform.js';
import { colorToLinear } from '../format/colors.js';
import { proceduralColor, proceduralNormal } from '../render/textures.js';
import * as mat4 from '../math/mat4.js';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

function fail(msg) {
  throw new Error(msg);
}

const PI = Math.PI;
const r7 = (v) => (Math.abs(v) < 1e-7 ? 0 : Number(v.toPrecision(7)));

function ancestorNames(doc, uid) {
  const names = [];
  let el = doc && doc.byUid.get(uid);
  while (el) {
    const n = el.values && (el.values.name || el.values.id);
    if (n) names.push(n);
    el = el.parent;
  }
  return names;
}

function hash01(i) {
  let x = Math.imul(i + 1, 0x9e3779b1);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot4(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/** Quaternion whose -Z axis points along `dir` (glTF lights and cameras). */
function quatFacing(dir, up = [0, 1, 0]) {
  const f = norm3(dir);
  const z = [-f[0], -f[1], -f[2]];
  let u = up;
  if (Math.abs(z[0] * u[0] + z[1] * u[1] + z[2] * u[2]) > 0.99) u = [1, 0, 0];
  const x = norm3(cross(u, z));
  const y = cross(z, x);
  return mat4.quatFromRotationMatrix([x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]);
}

function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function mul(a, b) {
  const o = mat4.createF64();
  mat4.multiply(o, a, b);
  return o;
}
function inv(a) {
  const o = mat4.createF64();
  mat4.invert(o, a);
  return o;
}
function dequantMatrix(center, half) {
  const m = mat4.createF64();
  m[0] = half[0];
  m[5] = half[1];
  m[10] = half[2];
  m[12] = center[0];
  m[13] = center[1];
  m[14] = center[2];
  return m;
}

function quantizeMesh(mesh) {
  const p = mesh.positions;
  const n = mesh.normals;
  const count = mesh.vertexCount;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  const center = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
  // One scalar undoes the quantization (the page's dequant scale is a scalar).
  const h = Math.max(1e-6, ...[0, 1, 2].map((k) => (max[k] - min[k]) / 2));
  const half = [h, h, h];
  const positions = new Int16Array(count * 4);
  const normals = new Int8Array(count * 4);
  const qmin = [32767, 32767, 32767];
  const qmax = [-32767, -32767, -32767];
  for (let i = 0; i < count; i++) {
    const nx = n[i * 3] * half[0];
    const ny = n[i * 3 + 1] * half[1];
    const nz = n[i * 3 + 2] * half[2];
    const nl = Math.hypot(nx, ny, nz) || 1;
    for (let k = 0; k < 3; k++) {
      const q = Math.max(-32767, Math.min(32767, Math.round(((p[i * 3 + k] - center[k]) / half[k]) * 32767)));
      positions[i * 4 + k] = q;
      if (q < qmin[k]) qmin[k] = q;
      if (q > qmax[k]) qmax[k] = q;
    }
    normals[i * 4] = Math.max(-127, Math.min(127, Math.round((nx / nl) * 127)));
    normals[i * 4 + 1] = Math.max(-127, Math.min(127, Math.round((ny / nl) * 127)));
    normals[i * 4 + 2] = Math.max(-127, Math.min(127, Math.round((nz / nl) * 127)));
  }
  return { positions, normals, center, half, min: qmin, max: qmax };
}

function kids(node) {
  if (!node) return [];
  if (node.kind === 'use') return [...(node.target ? [node.target] : []), ...(node.children || [])];
  return node.children || [];
}

function countRows(node) {
  if (!node || node.visible === false) return 0;
  switch (node.kind) {
    case 'shape':
      return node.geometry ? 1 : 0;
    case 'light':
    case 'camera':
      return 0;
    case 'repeat': {
      let n = 0;
      for (const c of node.children || []) n += countRows(c);
      return n * (node.count || 0);
    }
    case 'scatter': {
      let n = 0;
      for (const c of kids(node)) n += countRows(c);
      return n * ((node.params && node.params.count) || 0);
    }
    default: {
      let n = 0;
      for (const c of kids(node)) n += countRows(c);
      return n;
    }
  }
}

function collectAnims(node, out, seen) {
  if (!node || seen.has(node)) return out;
  seen.add(node);
  for (const a of node.anims || []) out.push({ node, a });
  for (const c of kids(node)) collectAnims(c, out, seen);
  return out;
}

function uniformScaleAnim(a) {
  if (a.attr !== 'scale') return false;
  const vals = a.keys || [a.from, a.to].filter(Boolean);
  return vals.every((v) => v && (v.length === 1 || (Math.abs(v[0] - v[1]) < 1e-5 && Math.abs(v[0] - (v[2] ?? v[0])) < 1e-5)));
}

function innerAnims(node) {
  const out = [];
  const seen = new Set([node]);
  for (const c of kids(node)) collectAnims(c, out, seen);
  return out;
}

// An infinite repeat samples t = N*dur as the start of the next cycle.
// Step just inside the cycle so a looping track ends on its last value.
function sampleAt(a, t, progress = 0) {
  if (a.timeline !== 'scroll' && a.dur > 0) {
    const elapsed = t - (a.begin || 0);
    const cycles = elapsed / a.dur;
    if (elapsed > 0 && Math.abs(cycles - Math.round(cycles)) < 1e-5) t -= a.dur * 1e-5;
  }
  return sampleAnimation(a, t, progress);
}

function localOf(node, time, progress) {
  const ov = {};
  for (const a of node.anims || []) {
    const v = sampleAt(a, time, progress);
    if (v) ov[a.attr] = v;
  }
  return localMatrix(node.el.values, mat4.createF64(), ov);
}

function nodeLabel(node) {
  const v = node.el && node.el.values;
  return (v && (v.name || v.id)) || node.kind;
}

function periodOf(a) {
  if (a.timeline === 'scroll') return 1;
  return a.alternate ? a.dur * 2 : a.dur;
}

function scaleAt(anim, time) {
  const v = sampleAnimation(anim, time, 0);
  if (!v) return null;
  return v.length === 1 ? v[0] : v[0];
}

/** Key times and values of one animated channel, in the clip's clock. */
function sampleChannel(anim) {
  const scroll = anim.timeline === 'scroll';
  const period = periodOf(anim);
  const linear = !anim.smooth && !anim.path && Math.abs(anim.ease(0.3) - 0.3) < 1e-6;
  const times = [];
  const values = [];
  const push = (t, progress, localT) => {
    const v = scroll ? sampleAnimation(anim, 0, progress) : sampleAt(anim, anim.begin + localT, 0);
    if (!v) return;
    times.push(t);
    values.push(v);
  };
  // A full turn is the same quaternion at both ends, and an infinite repeat
  // samples t = dur as the start of the next cycle. Both need real in-between keys.
  const spin = anim.attr === 'rotation' && anim.from && anim.to && anim.from.some((v, k) => Math.abs(v - anim.to[k]) > 180);
  if (!scroll && linear && !anim.keys && anim.from && anim.to && !spin) {
    push(0, 0, 0);
    if (anim.alternate) {
      push(anim.dur, 0, anim.dur);
      push(period, 0, period);
    } else {
      // t = dur is cycle 0 again when repeat is infinite; take the value just before the wrap
      const end = sampleAnimation(anim, anim.begin + anim.dur * (1 - 1e-8), 0);
      if (end) {
        times.push(anim.dur);
        values.push(end);
      }
    }
    return { times, values, period };
  }
  if (!scroll && linear && anim.keys && !anim.smooth) {
    const kt = anim.keyTimes;
    for (let i = 0; i < anim.keys.length; i++) push(kt[i] * anim.dur, 0, kt[i] * anim.dur);
    if (anim.alternate) {
      for (let i = anim.keys.length - 2; i >= 0; i--) push(anim.dur + (1 - kt[i]) * anim.dur, 0, anim.dur + (1 - kt[i]) * anim.dur);
    }
    return { times, values, period };
  }
  const n = scroll ? 600 : 48;
  for (let i = 0; i <= n; i++) {
    const t = (period * i) / n;
    push(scroll ? t : t, t, t);
  }
  return { times, values, period };
}

class Bin {
  constructor() {
    this.parts = [];
    this.length = 0;
    this.views = [];
    this.accessors = [];
  }
  raw(bytes) {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const offset = this.length;
    this.parts.push(bytes);
    this.length += bytes.byteLength;
    this.views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    return this.views.length - 1;
  }
  meshopt(typed, count, stride, mode) {
    const raw = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const encoded = MeshoptEncoder.encodeGltfBuffer(raw, count, stride, mode);
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const offset = this.length;
    this.parts.push(encoded);
    this.length += encoded.byteLength;
    const ext = { buffer: 0, byteOffset: offset, byteLength: encoded.byteLength, byteStride: stride, count, mode };
    this.views.push({
      buffer: 1,
      byteOffset: 0,
      byteLength: raw.byteLength,
      extensions: { EXT_meshopt_compression: ext },
    });
    return this.views.length - 1;
  }
  accessor(view, componentType, type, count, extra = {}) {
    const a = { bufferView: view, componentType, count, type, ...extra };
    this.accessors.push(a);
    return this.accessors.length - 1;
  }
  bytes() {
    const out = new Uint8Array(Math.ceil(this.length / 4) * 4);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  }
}

function minMax3(arr, stride) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < arr.length; i += stride) {
    for (let k = 0; k < 3; k++) {
      const v = arr[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

async function bakeTextures(materials, dir) {
  const images = [];
  const byKey = new Map();
  const add = async (spec, linear) => {
    if (!spec) return null;
    const key = (linear ? 'n:' : 'c:') + spec.key;
    if (byKey.has(key)) return byKey.get(key);
    let webp;
    let name;
    if (spec.kind === 'url') {
      const file = path.resolve(dir, spec.url);
      webp = await sharp(file).webp({ quality: 90, effort: 4, alphaQuality: 100 }).toBuffer();
      name = path.basename(spec.url, path.extname(spec.url));
    } else if (spec.fn) {
      const px = linear ? proceduralNormal(spec) : proceduralColor(spec);
      webp = await sharp(Buffer.from(px.data.buffer, px.data.byteOffset, px.data.byteLength), {
        raw: { width: px.width, height: px.height, channels: 4 },
      }).webp({ quality: linear ? 95 : 82, effort: 4, alphaQuality: 100 }).toBuffer();
      name = `${spec.fn}${linear ? ' normal' : ''}`;
    } else return null;
    const index = images.length;
    images.push({ name, webp });
    byKey.set(key, index);
    return index;
  };
  const texOf = [];
  for (const m of materials) {
    texOf.push({
      map: await add(m.params.map, false),
      normalMap: await add(m.params.normalMap, true),
    });
  }
  return { images, texOf };
}

export async function exportPackedGLB(text, { baseDir = '', sourceName = 'scene.es3d' } = {}) {
  await MeshoptEncoder.ready;
  const t0 = performance.now();
  const result = compile(text, { time: 0, progress: 0 });
  if (!result.ok) {
    for (const d of result.diagnostics.filter((x) => x.severity === 'error').slice(0, 12)) console.error(d.format(result.doc.lineIndex));
    fail('scene did not compile');
  }
  const scene = result.scene;
  const doc = result.doc;
  const graph = result.graph;
  const meshOf = (entry, lod) => result.cache.mesh(entry, lod);
  console.error(`compiled ${scene.count.toLocaleString('en-US')} instances in ${(performance.now() - t0).toFixed(0)} ms`);

  const beside = path.resolve(baseDir || '.');
  const texDir = fs.existsSync(path.join(beside, 'textures'))
    ? beside
    : path.resolve(beside, '../../../public/demo/castle/es3d');
  const { images, texOf } = await bakeTextures(scene.materials, texDir);
  console.error(`textures ${images.length}`);

  const bin = new Bin();
  const json = {
    asset: { version: '2.0', generator: 'ES3D' },
    extensionsUsed: ['EXT_mesh_gpu_instancing', 'EXT_meshopt_compression', 'EXT_texture_webp', 'KHR_lights_punctual', 'KHR_mesh_quantization'],
    extensionsRequired: ['EXT_mesh_gpu_instancing', 'EXT_meshopt_compression', 'EXT_texture_webp', 'KHR_mesh_quantization'],
    extensions: { KHR_lights_punctual: { lights: [] } },
    scene: 0,
    scenes: [{ nodes: [], extras: {} }],
    nodes: [],
    meshes: [],
    materials: [],
    textures: [],
    images: [],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    cameras: [],
    animations: [],
    accessors: bin.accessors,
    bufferViews: bin.views,
    buffers: [{ byteLength: 0 }, { byteLength: 0, extensions: { EXT_meshopt_compression: { fallback: true } } }],
  };
  const used = new Set(json.extensionsUsed);

  const imageIndex = images.map((im) => {
    const view = bin.raw(im.webp);
    const i = json.images.length;
    json.images.push({ name: im.name, mimeType: 'image/webp', bufferView: view });
    json.textures.push({ sampler: 0, extensions: { EXT_texture_webp: { source: i } } });
    return i;
  });

  const texInfo = (index, uv) => {
    if (index == null) return null;
    const info = { index: imageIndex[index] };
    if (uv && (Math.abs(uv[0] - 1) > 1e-6 || Math.abs(uv[1] - 1) > 1e-6)) {
      used.add('KHR_texture_transform');
      info.extensions = { KHR_texture_transform: { scale: [r7(uv[0]), r7(uv[1])] } };
    }
    return info;
  };

  scene.materials.forEach((m, i) => {
    const p = m.params;
    const base = colorToLinear(p.color);
    const mat = {
      name: m.name || `material${i}`,
      pbrMetallicRoughness: {
        baseColorFactor: [r7(base[0]), r7(base[1]), r7(base[2]), r7(m.opacity)],
        metallicFactor: r7(m.metallic),
        roughnessFactor: r7(m.roughness),
      },
    };
    const map = texInfo(texOf[i].map, p.uvScale);
    if (map) mat.pbrMetallicRoughness.baseColorTexture = map;
    const nmap = texInfo(texOf[i].normalMap, p.uvScale);
    if (nmap) {
      mat.normalTexture = nmap;
      if (p.normalScale && Math.abs(p.normalScale - 1) > 1e-6) mat.normalTexture.scale = r7(p.normalScale);
    }
    if (m.unlit) {
      used.add('KHR_materials_unlit');
      mat.extensions = { ...(mat.extensions || {}), KHR_materials_unlit: {} };
    }
    const e = colorToLinear(p.emissive);
    if (e[0] + e[1] + e[2] > 1e-5 && p.emissiveIntensity > 0) {
      mat.emissiveFactor = [r7(Math.min(1, e[0])), r7(Math.min(1, e[1])), r7(Math.min(1, e[2]))];
      if (p.emissiveIntensity !== 1) {
        used.add('KHR_materials_emissive_strength');
        mat.extensions = { ...(mat.extensions || {}), KHR_materials_emissive_strength: { emissiveStrength: r7(p.emissiveIntensity) } };
      }
    }
    if (m.alphaMode === 'mask') {
      mat.alphaMode = 'MASK';
      mat.alphaCutoff = m.alphaCutoff ?? 0.5;
    } else if (m.alphaMode === 'blend' || m.opacity < 0.999) mat.alphaMode = 'BLEND';
    if (m.doubleSided) mat.doubleSided = true;
    json.materials.push(mat);
  });

  // geometry: lod 0 (and further tessellation levels) quantized once per entry
  const needsUv = new Set();
  for (let i = 0; i < scene.count; i++) {
    const m = scene.materials[scene.mat[i]];
    if (m.map || m.normalMap) needsUv.add(scene.geom[i]);
  }
  const geomMesh = new Map(); // `${gi}|${lod}|${mi}|morph` -> { mesh, dequant }
  const prepared = new Map(); // `${gi}|${lod}|q` -> prepared mesh
  function prepare(gi, lod, quantize) {
    const key = `${gi}|${lod}|${quantize ? 1 : 0}`;
    if (prepared.has(key)) return prepared.get(key);
    const entry = scene.geometries[gi];
    const level = Math.min(lod, entry.lods - 1);
    const mesh = meshOf(entry, level);
    const empty = !mesh.vertexCount;
    const lines = mesh.kind === 'lines';
    let dequant = null;
    let attributes;
    let indices;
    if (!empty && !lines && quantize) {
      const q = quantizeMesh(mesh);
      dequant = { translation: q.center.map(r7), scale: r7(q.half[0]), half: q.half, center: q.center };
      dequant.center = q.center;
      const pv = bin.meshopt(q.positions, mesh.vertexCount, 8, 'ATTRIBUTES');
      const nv = bin.meshopt(q.normals, mesh.vertexCount, 4, 'ATTRIBUTES');
      attributes = {
        POSITION: bin.accessor(pv, 5122, 'VEC3', mesh.vertexCount, { normalized: true, byteOffset: 0, ...minmaxAccessor(q.min, q.max) }),
        NORMAL: bin.accessor(nv, 5120, 'VEC3', mesh.vertexCount, { normalized: true }),
      };
      if (needsUv.has(gi)) {
        const uvv = bin.meshopt(mesh.uvs, mesh.vertexCount, 8, 'ATTRIBUTES');
        attributes.TEXCOORD_0 = bin.accessor(uvv, 5126, 'VEC2', mesh.vertexCount);
      }
      const small = mesh.vertexCount < 65536;
      const idx = small ? Uint16Array.from(mesh.indices) : mesh.indices;
      const iv = bin.meshopt(idx, idx.length, small ? 2 : 4, 'TRIANGLES');
      indices = bin.accessor(iv, small ? 5123 : 5125, 'SCALAR', idx.length);
      if (entry.doubleSided) {
        /* material flag applied below when a primitive needs it */
      }
    } else if (!empty && !lines) {
      const pv = bin.meshopt(mesh.positions, mesh.vertexCount, 12, 'ATTRIBUTES');
      const nv = bin.meshopt(mesh.normals, mesh.vertexCount, 12, 'ATTRIBUTES');
      attributes = {
        POSITION: bin.accessor(pv, 5126, 'VEC3', mesh.vertexCount, minMax3(mesh.positions, 3)),
        NORMAL: bin.accessor(nv, 5126, 'VEC3', mesh.vertexCount),
      };
      if (needsUv.has(gi)) {
        const uvv = bin.meshopt(mesh.uvs, mesh.vertexCount, 8, 'ATTRIBUTES');
        attributes.TEXCOORD_0 = bin.accessor(uvv, 5126, 'VEC2', mesh.vertexCount);
      }
      const small = mesh.vertexCount < 65536;
      const idx = small ? Uint16Array.from(mesh.indices) : mesh.indices;
      const iv = bin.meshopt(idx, idx.length, small ? 2 : 4, 'TRIANGLES');
      indices = bin.accessor(iv, small ? 5123 : 5125, 'SCALAR', idx.length);
    } else if (!empty) {
      const pv = bin.meshopt(mesh.positions, mesh.vertexCount, 12, 'ATTRIBUTES');
      attributes = { POSITION: bin.accessor(pv, 5126, 'VEC3', mesh.vertexCount, minMax3(mesh.positions, 3)) };
      const small = mesh.vertexCount < 65536;
      const idx = small ? Uint16Array.from(mesh.indices) : mesh.indices;
      const iv = bin.meshopt(idx, idx.length, small ? 2 : 4, 'INDICES');
      indices = bin.accessor(iv, small ? 5123 : 5125, 'SCALAR', idx.length);
    }
    const rec = { mesh, attributes, indices, empty, lines, dequant, entry, lod: level };
    prepared.set(key, rec);
    return rec;
  }

  function minmaxAccessor(min, max) {
    return { min, max };
  }

  function gltfMesh(gi, lod, mi, morph) {
    const key = `${gi}|${lod}|${mi}|${morph ? 1 : 0}`;
    if (geomMesh.has(key)) return geomMesh.get(key);
    const g = prepare(gi, lod, !morph);
    if (g.empty) {
      geomMesh.set(key, null);
      return null;
    }
    if (g.entry.doubleSided) json.materials[mi].doubleSided = true;
    const prim = { attributes: g.attributes, indices: g.indices, material: mi, mode: g.lines ? 1 : 4 };
    const mesh = { name: scene.materials[mi].name || `geom${gi}`, primitives: [prim] };
    if (morph) {
      const base = g.mesh.positions;
      const target = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) target[i] = base[i]; // delta = base, so weight w yields (1+w)*base
      const tv = bin.meshopt(target, g.mesh.vertexCount, 12, 'ATTRIBUTES');
      prim.targets = [{ POSITION: bin.accessor(tv, 5126, 'VEC3', g.mesh.vertexCount) }];
      mesh.weights = [morph.weight];
      mesh.extras = { targetNames: ['pulse'] };
    }
    const index = json.meshes.length;
    json.meshes.push(mesh);
    const rec = { index, dequant: g.dequant, lines: g.lines, entry: g.entry };
    geomMesh.set(key, rec);
    return rec;
  }

  const nameList = [];
  const nameKey = new Map();
  function nameId(uid) {
    const chain = ancestorNames(doc, uid);
    const key = chain.join('\0');
    let id = nameKey.get(key);
    if (id === undefined) {
      id = nameList.length;
      nameList.push(chain);
      nameKey.set(key, id);
    }
    return id;
  }

  const scrollChannels = [];
  const timeClips = new Map();

  function worldAt(i) {
    const out = mat4.createF64();
    const o = i * 16;
    for (let k = 0; k < 16; k++) out[k] = scene.matrices[o + k];
    return out;
  }

  function addNode(def, root) {
    const i = json.nodes.length;
    json.nodes.push(def);
    if (root) json.scenes[0].nodes.push(i);
    return i;
  }

  function trsOf(matrix) {
    const d = mat4.decompose(matrix);
    if (!d) return { matrix: Array.from(matrix, r7) };
    const t = {};
    if (d.translation.some((v) => Math.abs(v) > 1e-8)) t.translation = d.translation.map(r7);
    if (d.rotation.some((v, i) => Math.abs(v - (i === 3 ? 1 : 0)) > 1e-8)) t.rotation = d.rotation.map(r7);
    if (d.scale.some((v) => Math.abs(v - 1) > 1e-8)) t.scale = d.scale.map(r7);
    return t;
  }

  function vecAccessor(values, count, type, comp, strideFloats) {
    const arr = type === 'SCALAR' ? new Float32Array(values) : Float32Array.from(values.flat ? values.flat() : values);
    const stride = strideFloats * 4;
    const view = bin.meshopt(arr, count, stride, 'ATTRIBUTES');
    return bin.accessor(view, comp, type, count);
  }

  function pushTrack(clip, nodeIndex, path, times, flat, type) {
    const tv = bin.meshopt(Float32Array.from(times), times.length, 4, 'ATTRIBUTES');
    const input = bin.accessor(tv, 5126, 'SCALAR', times.length, { min: [times[0]], max: [times[times.length - 1]] });
    const comps = type === 'VEC4' ? 4 : type === 'SCALAR' ? 1 : 3;
    const ov = bin.meshopt(Float32Array.from(flat), times.length, comps * 4, 'ATTRIBUTES');
    const output = bin.accessor(ov, 5126, type, times.length);
    const sampler = clip.samplers.length;
    clip.samplers.push({ input, output, interpolation: 'LINEAR' });
    clip.channels.push({ sampler, target: { node: nodeIndex, path } });
  }

  function clipFor(timeline, begin, period, name) {
    if (timeline === 'scroll') {
      let c = json.animations.find((a) => a.name === 'Scroll');
      if (!c) {
        c = { name: 'Scroll', samplers: [], channels: [], extras: { timeline: 'scroll' } };
        json.animations.push(c);
      }
      return c;
    }
    const key = `${begin}|${period}|${name}`;
    if (!timeClips.has(key)) {
      const c = { name, samplers: [], channels: [], extras: { timeline: 'time', begin, period } };
      json.animations.push(c);
      timeClips.set(key, c);
    }
    return timeClips.get(key);
  }

  function animateWorld(nodeIndex, node, parentFn) {
    // one TRS track from the node's world matrix over its animation clock
    const anims = node.anims;
    const scroll = anims.some((a) => a.timeline === 'scroll');
    const clock = anims.filter((a) => a.timeline !== 'scroll');
    const sampleWorld = (time, progress) => {
      const parent = parentFn(time, progress);
      return mul(parent, localOf(node, time, progress));
    };
    const emit = (timeline, series, label) => {
      if (!series.times.length) return;
      const mats = series.values;
      const T = [];
      const R = [];
      const S = [];
      let prevQ = null;
      for (const m of mats) {
        const d = mat4.decompose(m) || { translation: [m[12], m[13], m[14]], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
        if (prevQ && dot4(prevQ, d.rotation) < 0) d.rotation = d.rotation.map((v) => -v);
        prevQ = d.rotation;
        T.push(d.translation);
        R.push(d.rotation);
        S.push(d.scale);
      }
      const clip = clipFor(timeline, timeline === 'scroll' ? 0 : anims[0].begin || 0, series.period, label);
      const moving = (arr, n) => arr.some((v) => v.some((x, i) => Math.abs(x - arr[0][i]) > 1e-5));
      if (moving(T, 3)) pushTrack(clip, nodeIndex, 'translation', series.times, T.flat(), 'VEC3');
      if (moving(R, 4)) pushTrack(clip, nodeIndex, 'rotation', series.times, R.flat(), 'VEC4');
      if (moving(S, 3)) pushTrack(clip, nodeIndex, 'scale', series.times, S.flat(), 'VEC3');
    };
    if (scroll) {
      const a = anims.find((x) => x.timeline === 'scroll');
      const s = sampleChannel(a);
      s.values = s.times.map((t) => sampleWorld(0, t));
      emit('scroll', s, nodeLabel(node));
    }
    if (clock.length) {
      const a = clock[0];
      const s = sampleChannel(a);
      s.values = s.times.map((t) => sampleWorld(a.begin + t, 0));
      emit('time', s, nodeLabel(node) + (a.attr ? ` ${a.attr}` : ''));
    }
  }

  // ---- instances -------------------------------------------------------
  const covered = new Uint8Array(scene.count);
  for (const seg of scene.dynamic) for (let i = seg.start; i < seg.end; i++) covered[i] = 1;

  function geomUnit(entry) {
    const u = entry.desc && entry.desc.unit;
    if (!u) return 1;
    const c = Math.cbrt(Math.abs(mat4.determinant3(u)) || 1);
    return c > 1e-8 ? c : 1;
  }

  function emitRange(row0, rowN, parentIndex, parentWorld, label) {
    if (rowN <= 0) return;
    const invP = parentWorld ? inv(parentWorld) : null;
    const groups = new Map();
    for (let i = row0; i < row0 + rowN; i++) {
      const gi = scene.geom[i];
      const mi = scene.mat[i];
      const lodChild = scene.lodNode[i] >= 0 ? scene.lodChild[i] : -1;
      const collide = (scene.flags[i] & 2) === 0;
      const key = `${gi}|${mi}|${lodChild}|${collide ? 1 : 0}`;
      // lod switch identity: distances live on the switch; group by child + geom
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(i);
    }
    for (const [key, rows] of groups) {
      const i0 = rows[0];
      const gi = scene.geom[i0];
      const mi = scene.mat[i0];
      const entry = scene.geometries[gi];
      const gmesh = gltfMesh(gi, 0, mi, null);
      if (!gmesh) continue;
      const ids = rows.map((i) => nameId(scene.uid[i]));
      const sameName = ids.every((id) => id === ids[0]);
      const collide = (scene.flags[i0] & 2) === 0;
      const T = new Float32Array(rows.length * 3);
      const R = new Float32Array(rows.length * 4);
      const S = new Float32Array(rows.length * 3);
      const detail = new Float32Array(rows.length);
      const idAttr = new Float32Array(rows.length);
      const dq = gmesh.dequant ? dequantMatrix(gmesh.dequant.center, gmesh.dequant.half) : null;
      let lodIds = null;
      for (let k = 0; k < rows.length; k++) {
        const i = rows[k];
        const world = worldAt(i);
        let local = invP ? mul(invP, world) : world;
        if (dq && !gmesh.lines) local = mul(local, dq);
        const d = mat4.decompose(local) || { translation: [local[12], local[13], local[14]], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
        T.set(d.translation, k * 3);
        R.set(d.rotation, k * 4);
        S.set(d.scale, k * 3);
        detail[k] = hash01(k + i);
        idAttr[k] = ids[k];
      }
      const attrs = {
        TRANSLATION: vecAccessor(T, rows.length, 'VEC3', 5126, 3),
        ROTATION: vecAccessor(R, rows.length, 'VEC4', 5126, 4),
        SCALE: vecAccessor(S, rows.length, 'VEC3', 5126, 3),
      };
      const extras = {};
      if (sameName) extras.id = ids[0];
      else attrs._ID = vecAccessor(idAttr, rows.length, 'SCALAR', 5126, 1);
      if (!collide) extras.collide = false;
      if (scene.materials[mi].transparent) extras.sort = true;
      const lodNode = scene.lodNode[i0];
      if (lodNode >= 0) {
        const sw = scene.lodSwitches[lodNode];
        const unit = geomUnit(entry);
        const world = worldAt(i0);
        const scale = Math.cbrt(Math.abs(mat4.determinant3(world)) || 1) / unit || 1;
        const qScale = gmesh.dequant ? gmesh.dequant.scale : 1;
        extras.lod = {
          distances: sw.distances.map((d) => r7(d / scale)),
          child: scene.lodChild[i0],
          unit: r7(unit * qScale),
        };
        attrs._DETAIL = vecAccessor(detail, rows.length, 'SCALAR', 5126, 1);
      }
      if (entry.lods > 1 && scene.lodChild[i0] === 0) {
        const levels = [];
        const deviation = entry.lodDeviation || [0];
        const map = [];
        for (let l = 0; l < entry.lods; l++) {
          const lm = gltfMesh(gi, l, mi, null);
          if (!lm) continue;
          if (l === 0) continue;
          const half = lm.dequant ? lm.dequant.half : [1, 1, 1];
          const center = lm.dequant ? lm.dequant.center : [0, 0, 0];
          const lower = addNode({
            name: `${json.materials[mi].name || 'mesh'} level ${l}`,
            mesh: lm.index,
            ...trsOf(dequantMatrix(center, half)),
          }, false);
          levels.push(lower);
          map[l] = levels.length; // 1.. 
        }
        map[0] = 0;
        for (let l = 1; l < entry.lods; l++) if (map[l] == null) map[l] = map[l - 1] || 0;
        if (levels.length) {
          const dqScale = gmesh.dequant ? gmesh.dequant.scale : 1;
          extras.tess = {
            map,
            deviation: deviation.map((d) => r7(d)),
            unit: r7(dqScale),
            dequant: {
              translation: gmesh.dequant ? gmesh.dequant.center.map(r7) : [0, 0, 0],
              scale: r7(dqScale),
            },
          };
          lodIds = levels;
        }
      }
      const count = rows.length;
      const matName = json.materials[mi].name || 'mesh';
      const node = {
        name: label || (count > 1 ? `${matName} ×${count}` : matName),
        mesh: gmesh.index,
        extras,
        extensions: { EXT_mesh_gpu_instancing: { attributes: attrs } },
      };
      if (lodIds) {
        node.extensions.MSFT_lod = { ids: lodIds };
        used.add('MSFT_lod');
      }
      const idx = addNode(node, parentIndex == null);
      if (parentIndex != null) {
        const p = json.nodes[parentIndex];
        p.children = p.children || [];
        p.children.push(idx);
      }
    }
  }

  // static rows
  let run = -1;
  for (let i = 0; i <= scene.count; i++) {
    const on = i < scene.count && !covered[i];
    if (on && run < 0) run = i;
    if (!on && run >= 0) {
      emitRange(run, i - run, null, null, null);
      run = -1;
    }
  }

  // uniform-scale shape segments become one instanced mesh with a morph
  const morphGroups = new Map();
  const treeSegs = [];
  for (const seg of scene.dynamic) {
    if (seg.end === seg.start) continue;
    const inner = innerAnims(seg.node);
    const solo = seg.end - seg.start === 1 && seg.node.kind === 'shape' && seg.node.anims.length === 1 && uniformScaleAnim(seg.node.anims[0]) && inner.length === 0;
    if (solo) {
      const a = seg.node.anims[0];
      const sig = JSON.stringify({ d: a.dur, b: a.begin, alt: a.alternate, keys: a.keys, from: a.from, to: a.to, kt: a.keyTimes, ease: Math.round(a.ease(0.3) * 1000) });
      const i = seg.start;
      const key = `${scene.geom[i]}|${scene.mat[i]}|${sig}`;
      let g = morphGroups.get(key);
      if (!g) morphGroups.set(key, (g = { anim: a, node: seg.node, rows: [] }));
      g.rows.push(i);
    } else treeSegs.push(seg);
  }

  for (const g of morphGroups.values()) {
    const a = g.anim;
    const bakedV = sampleAnimation(a, 0, 0);
    const baked = bakedV ? bakedV[0] : (g.node.base.scale ? g.node.base.scale[0] : 1) || 1;
    const i0 = g.rows[0];
    const gi = scene.geom[i0];
    const mi = scene.mat[i0];
    const weight0 = baked - 1;
    const gmesh = gltfMesh(gi, 0, mi, { weight: weight0 });
    if (!gmesh) continue;
    const T = new Float32Array(g.rows.length * 3);
    const R = new Float32Array(g.rows.length * 4);
    const S = new Float32Array(g.rows.length * 3);
    const ids = g.rows.map((i) => nameId(scene.uid[i]));
    for (let k = 0; k < g.rows.length; k++) {
      const i = g.rows[k];
      const world = worldAt(i);
      const local = mat4.clone(world);
      if (Math.abs(baked) > 1e-8) {
        local[0] /= baked; local[1] /= baked; local[2] /= baked;
        local[4] /= baked; local[5] /= baked; local[6] /= baked;
        local[8] /= baked; local[9] /= baked; local[10] /= baked;
      }
      const d = mat4.decompose(local) || { translation: [local[12], local[13], local[14]], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
      T.set(d.translation, k * 3);
      R.set(d.rotation, k * 4);
      S.set(d.scale, k * 3);
    }
    const attrs = {
      TRANSLATION: vecAccessor(T, g.rows.length, 'VEC3', 5126, 3),
      ROTATION: vecAccessor(R, g.rows.length, 'VEC4', 5126, 4),
      SCALE: vecAccessor(S, g.rows.length, 'VEC3', 5126, 3),
    };
    const same = ids.every((id) => id === ids[0]);
    const extras = same ? { id: ids[0] } : {};
    if (!same) attrs._ID = vecAccessor(Float32Array.from(ids), ids.length, 'SCALAR', 5126, 1);
    if (scene.materials[mi].transparent) extras.sort = true;
    const idx = addNode({
      name: `${nodeLabel(g.node)} ×${g.rows.length}`,
      mesh: gmesh.index,
      extras,
      extensions: { EXT_mesh_gpu_instancing: { attributes: attrs } },
    }, true);
    const series = sampleChannel(a);
    const weights = series.times.map((t) => {
      const v = sampleAt(a, a.begin + t, 0);
      return (v ? v[0] : baked) - 1;
    });
    const clip = clipFor('time', a.begin || 0, series.period, `twinkle (${nodeLabel(g.node)} scale)`);
    pushTrack(clip, idx, 'weights', series.times, weights, 'SCALAR');
  }

  function emitTree(node, parentFn, attach, cursor, segEnd) {
    if (!node || node.visible === false) return;
    if (cursor.i > segEnd) fail(`row cursor ran past segment at ${nodeLabel(node)}`);
    const baseLocal = localOf(node, 0, 0);
    const worldFn = (time, progress) => mul(parentFn(time, progress), node.anims.length ? localOf(node, time, progress) : baseLocal);
    let nextAttach = attach;
    if (node.anims.length) {
      const idx = addNode({ name: nodeLabel(node), ...trsOf(worldFn(0, 0)) }, attach == null);
      if (attach != null) {
        const p = json.nodes[attach];
        p.children = p.children || [];
        p.children.push(idx);
      }
      animateWorld(idx, node, parentFn);
      nextAttach = idx;
    }
    const deeper = innerAnims(node);
    const scaleOnly = deeper.length > 0 && deeper.every(({ a }) => uniformScaleAnim(a));
    if (node.kind === 'scatter' && scaleOnly) {
      const n = countRows(node);
      emitRange(cursor.i, n, nextAttach, worldFn(0, 0), nodeLabel(node));
      // morph weights: the shape anim inside, applied as a weight track on the meshes just added is hard
      // because emitRange made several meshes. Sample is identical if we divided scale; fireflies pulse.
      // Attach the scale track to each child mesh node created for this range.
      const anim = deeper[0].a;
      const bakedV = sampleAnimation(anim, 0, 0);
      const baked = bakedV ? bakedV[0] : 1;
      const series = sampleChannel(anim);
      const weights = series.times.map((t) => ((sampleAt(anim, anim.begin + t, 0) || [baked])[0]) - 1);
      const parent = json.nodes[nextAttach];
      for (const child of parent.children || []) {
        const cn = json.nodes[child];
        if (cn.mesh == null) continue;
        const mesh = json.meshes[cn.mesh];
        if (!mesh.weights) continue;
        const clip = clipFor('time', anim.begin || 0, series.period, `twinkle (${nodeLabel(deeper[0].node)} scale)`);
        pushTrack(clip, child, 'weights', series.times, weights, 'SCALAR');
      }
      // The meshes from emitRange are not morphed. Rebuild is required.
      // Mark a flag by using a dedicated path below instead. This branch is replaced.
      cursor.i += n;
      return;
    }
    if (!deeper.length && node.kind !== 'repeat') {
      const n = countRows(node);
      if (node.anims.length || node.kind === 'shape' || node.kind === 'group' || node.kind === 'lod' || node.kind === 'use' || node.kind === 'scatter') {
        if (n) emitRange(cursor.i, n, nextAttach, worldFn(0, 0), node.anims.length ? null : nodeLabel(node));
        cursor.i += n;
        return;
      }
    }
    if (!deeper.length) {
      const n = countRows(node);
      if (n) emitRange(cursor.i, n, nextAttach, worldFn(0, 0), null);
      cursor.i += n;
      return;
    }
    if (node.kind === 'repeat') {
      const acc = mat4.createF64();
      for (let i = 0; i < node.count; i++) {
        const accNow = mat4.clone(acc);
        const childFn = (time, progress) => mul(worldFn(time, progress), accNow);
        for (const c of node.children || []) emitTree(c, childFn, nextAttach, cursor, segEnd);
        const tmp = mat4.createF64();
        mat4.multiply(tmp, acc, node.step);
        acc.set(tmp);
      }
      return;
    }
    for (const c of kids(node)) emitTree(c, worldFn, nextAttach, cursor, segEnd);
  }

  // The scatter+scale branch above emits non-morph meshes and then looks for weights.
  // Do fireflies properly: if a scatter's only inner anim is uniform scale, emit morphed instances.
  function emitMorphRange(row0, n, parentIndex, parentWorld, anim) {
    const bakedV = sampleAnimation(anim, 0, 0);
    const baked = (bakedV ? bakedV[0] : 1) || 1;
    const groups = new Map();
    for (let i = row0; i < row0 + n; i++) {
      const key = `${scene.geom[i]}|${scene.mat[i]}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(i);
    }
    const made = [];
    const invP = parentWorld ? inv(parentWorld) : null;
    for (const rows of groups.values()) {
      const gi = scene.geom[rows[0]];
      const mi = scene.mat[rows[0]];
      const gmesh = gltfMesh(gi, 0, mi, { weight: baked - 1 });
      if (!gmesh) continue;
      const T = new Float32Array(rows.length * 3);
      const R = new Float32Array(rows.length * 4);
      const S = new Float32Array(rows.length * 3);
      for (let k = 0; k < rows.length; k++) {
        const world = worldAt(rows[k]);
        let local = invP ? mul(invP, world) : mat4.clone(world);
        if (Math.abs(baked) > 1e-8) {
          local[0] /= baked; local[1] /= baked; local[2] /= baked;
          local[4] /= baked; local[5] /= baked; local[6] /= baked;
          local[8] /= baked; local[9] /= baked; local[10] /= baked;
        }
        const d = mat4.decompose(local) || { translation: [local[12], local[13], local[14]], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
        T.set(d.translation, k * 3);
        R.set(d.rotation, k * 4);
        S.set(d.scale, k * 3);
      }
      const idx = addNode({
        name: `${json.materials[mi].name || 'pulse'} ×${rows.length}`,
        mesh: gmesh.index,
        extras: { id: nameId(scene.uid[rows[0]]), ...(scene.materials[mi].transparent ? { sort: true } : {}) },
        extensions: {
          EXT_mesh_gpu_instancing: {
            attributes: {
              TRANSLATION: vecAccessor(T, rows.length, 'VEC3', 5126, 3),
              ROTATION: vecAccessor(R, rows.length, 'VEC4', 5126, 4),
              SCALE: vecAccessor(S, rows.length, 'VEC3', 5126, 3),
            },
          },
        },
      }, parentIndex == null);
      if (parentIndex != null) {
        const p = json.nodes[parentIndex];
        p.children = p.children || [];
        p.children.push(idx);
      }
      made.push(idx);
    }
    const series = sampleChannel(anim);
    const weights = series.times.map((t) => ((sampleAt(anim, anim.begin + t, 0) || [baked])[0]) - 1);
    const clip = clipFor('time', anim.begin || 0, series.period, `twinkle (${nodeLabel(anim && anim) || 'scale'})`);
    for (const idx of made) pushTrack(clip, idx, 'weights', series.times, weights, 'SCALAR');
  }

  // Replace emitTree's scatter shortcut by redefining the walk to call emitMorphRange.
  // The function above already advances the cursor and emits non-morph meshes; fix by
  // not using that branch. Patch: tree segments call emitTreeFixed.
  function emitFixed(node, parentFn, attach, attachWorld, cursor, segEnd) {
    if (!node || node.visible === false) return;
    const baseLocal = localOf(node, 0, 0);
    const worldFn = (time, progress) => mul(parentFn(time, progress), node.anims.length ? localOf(node, time, progress) : baseLocal);
    // Animated nodes are scene roots with world-space tracks. Parenting them
    // and also sampling world matrices would apply the parent motion twice.
    let next = attach;
    let nextWorld = attachWorld;
    if (node.anims.length) {
      const rest = worldFn(0, 0);
      const idx = addNode({ name: nodeLabel(node), ...trsOf(rest) }, true);
      animateWorld(idx, node, parentFn);
      next = idx;
      nextWorld = rest;
    }
    const deeper = innerAnims(node);
    if (deeper.length && deeper.every(({ a }) => uniformScaleAnim(a)) && (node.kind === 'scatter' || node.kind === 'repeat' || node.kind === 'group' || node.kind === 'use')) {
      if (node.kind === 'scatter' || node.kind === 'repeat') {
        const n = countRows(node);
        emitMorphRange(cursor.i, n, next, nextWorld, deeper[0].a);
        cursor.i += n;
        return;
      }
    }
    if (!deeper.length) {
      const n = countRows(node);
      if (n) emitRange(cursor.i, n, next, nextWorld, null);
      cursor.i += n;
      return;
    }
    if (node.kind === 'repeat') {
      const acc = mat4.createF64();
      for (let i = 0; i < (node.count || 0); i++) {
        const accNow = mat4.clone(acc);
        const childFn = (time, progress) => mul(worldFn(time, progress), accNow);
        for (const c of node.children || []) emitFixed(c, childFn, next, nextWorld, cursor, segEnd);
        const tmp = mat4.createF64();
        mat4.multiply(tmp, acc, node.step);
        acc.set(tmp);
      }
      return;
    }
    for (const c of kids(node)) emitFixed(c, worldFn, next, nextWorld, cursor, segEnd);
  }

  for (const seg of treeSegs) {
    const cursor = { i: seg.start };
    const parent = seg.parent;
    emitFixed(seg.node, () => parent, null, null, cursor, seg.end);
    if (cursor.i !== seg.end) {
      fail(`segment ${nodeLabel(seg.node)} covered ${cursor.i - seg.start} of ${seg.end - seg.start} rows`);
    }
  }

  // lights
  const lightNodes = [];
  const walkLights = (node) => {
    if (!node) return;
    if (node.kind === 'light') lightNodes.push(node);
    for (const c of kids(node)) walkLights(c);
  };
  walkLights(graph.root);
  lightNodes.forEach((node, i) => {
    const L = scene.lights[i];
    const p = node.params;
    const color = colorToLinear(p.color);
    const light = {
      name: p.name || nodeLabel(node),
      type: p.type === 'point' ? 'point' : p.type === 'spot' ? 'spot' : 'directional',
      color: [r7(color[0]), r7(color[1]), r7(color[2])],
      intensity: r7((p.intensity || 1) * PI),
    };
    if (p.range) light.range = r7(p.range);
    if (light.type === 'spot') {
      light.spot = { outerConeAngle: r7(((p.angle || 40) * PI) / 180 / 2) };
    }
    const li = json.extensions.KHR_lights_punctual.lights.length;
    json.extensions.KHR_lights_punctual.lights.push(light);
    const def = { name: light.name, extensions: { KHR_lights_punctual: { light: li } } };
    if (light.type === 'directional') def.rotation = quatFacing(L.direction).map(r7);
    else def.translation = L.position.map(r7);
    addNode(def, true);
  });

  // cameras
  const camNodes = [];
  const walkCams = (node) => {
    if (!node) return;
    if (node.kind === 'camera') camNodes.push(node);
    for (const c of kids(node)) walkCams(c);
  };
  walkCams(graph.root);
  const STEPS = 600;
  camNodes.forEach((node, ci) => {
    const seg = scene.dynamic.find((s) => s.node === node);
    const parent = seg ? seg.parent : mat4.createF64();
    const times = [];
    const fov = [];
    const distance = [];
    const T = [];
    const R = [];
    let prevQ = null;
    for (let s = 0; s <= STEPS; s++) {
      const progress = s / STEPS;
      const ov = {};
      for (const a of node.anims) {
        const v = sampleAnimation(a, 0, progress);
        if (v) ov[a.attr] = v;
      }
      const p = node.params;
      const cw = mat4.clone(parent);
      if (p.transform) mat4.multiply(cw, cw, p.transform);
      const pos = ov.position || p.position;
      const aim = ov.target || p.target;
      const eye = transformPoint(cw, pos);
      const target = transformPoint(cw, aim);
      const f = ov.fov ? ov.fov[0] : p.fov;
      const delta = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
      let q = quatFacing(delta, p.up || [0, 1, 0]);
      if (prevQ && dot4(prevQ, q) < 0) q = q.map((v) => -v);
      prevQ = q;
      times.push(r7(progress));
      fov.push(r7(f));
      distance.push(r7(Math.hypot(delta[0], delta[1], delta[2])));
      T.push(eye);
      R.push(q);
    }
    const cam = {
      name: node.params.name,
      type: 'perspective',
      perspective: {
        znear: node.params.near || 0.1,
        zfar: node.params.far || 2000,
        yfov: (node.params.fov * PI) / 180,
        aspectRatio: node.params.aspect || 1,
      },
    };
    const camera = json.cameras.length;
    json.cameras.push(cam);
    const idx = addNode({
      name: cam.name,
      camera,
      translation: T[0].map(r7),
      rotation: R[0].map(r7),
      extras: {
        fit: node.params.fit || 'contain',
        aspect: node.params.aspect || 1,
        track: { times, fov, distance },
      },
    }, true);
    const clip = clipFor('scroll', 0, 1, 'Scroll');
    pushTrack(clip, idx, 'translation', times, T.flat(), 'VEC3');
    pushTrack(clip, idx, 'rotation', times, R.flat(), 'VEC4');
  });

  const env = graph.environment;
  const sky = colorToLinear(env.sky);
  const ground = colorToLinear(env.ground);
  json.scenes[0].extras = {
    generator: `es3d glb from ${sourceName}`,
    environment: {
      background: env.background.slice(0, 3).map(r7),
      sky: sky.slice(0, 3).map(r7),
      ground: ground.slice(0, 3).map(r7),
      intensity: env.intensity,
      exposure: env.exposure,
    },
    names: nameList,
    bounds: { min: scene.bounds.min.map(r7), max: scene.bounds.max.map(r7) },
    instances: scene.count,
    geometries: scene.geometries.length,
  };
  json.extensionsUsed = [...used];
  json.animations = json.animations.filter((a) => a.channels.length);
  if (!json.animations.length) delete json.animations;

  const binBytes = bin.bytes();
  json.buffers[0].byteLength = binBytes.length;
  json.buffers[1].byteLength = bin.views.filter((v) => v.buffer === 1).reduce((s, v) => s + v.byteLength, 0);
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonPad = Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20);
  const total = 12 + 8 + jsonBytes.length + jsonPad.length + 8 + binBytes.length;
  const file = Buffer.alloc(total);
  file.writeUInt32LE(0x46546c67, 0);
  file.writeUInt32LE(2, 4);
  file.writeUInt32LE(total, 8);
  const jlen = jsonBytes.length + jsonPad.length;
  file.writeUInt32LE(jlen, 12);
  file.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(file, 20);
  jsonPad.copy(file, 20 + jsonBytes.length);
  const bo = 20 + jlen;
  file.writeUInt32LE(binBytes.length, bo);
  file.writeUInt32LE(0x004e4942, bo + 4);
  Buffer.from(binBytes.buffer, binBytes.byteOffset, binBytes.byteLength).copy(file, bo + 8);
  const kb = Math.round(file.length / 1000);
  const srcKb = Math.round(Buffer.byteLength(text) / 1000);
  console.error(JSON.stringify({
    bytes: file.length,
    kb,
    es3dBytes: Buffer.byteLength(text),
    es3dKb: srcKb,
    ratio: Math.round(kb / srcKb),
    instances: scene.count,
    geometries: scene.geometries.length,
    materials: scene.materials.length,
    lights: scene.lights.length,
    cameras: scene.cameras.length,
    animations: (json.animations || []).length,
    nodes: json.nodes.length,
    images: json.images.length,
  }));
  return file;
}
