// Wavefront OBJ export (fully flattened triangles, the format has no
// instancing) and a reasonably fast OBJ parser used by the benchmark and the
// importer. The exporter is deliberately generous to OBJ: trimmed numbers,
// de-duplicated normals and texture coordinates, one usemtl per material run.

import { Mesh, computeNormals } from '../geometry/mesh.js';
import { linearToSrgb } from '../format/colors.js';
import { exportableInstances, materialNames, fixed, buildExternalScene, InstanceTable } from './external-scene.js';

/**
 * @param {import('../scene/flatten.js').RenderScene} scene
 * @param {(entry:object, lod:number)=>Mesh} meshOf
 * @param {{lod?: number, digits?: number, name?: string, uvs?: 'auto'|boolean}} [opts]
 *        uvs: 'auto' writes texture coordinates only for textured materials
 * @returns {{obj: string, mtl: string, vertices: number, triangles: number}}
 */
export function exportOBJ(scene, meshOf, { lod = 0, digits = 5, name = 'scene', uvs = 'auto' } = {}) {
  const names = materialNames(scene.materials);
  const out = [`# ES3D export: ${name}`, `mtllib ${name}.mtl`];
  const vnIndex = new Map();
  const vtIndex = new Map();
  const vnLines = [];
  const vtLines = [];
  const vLines = [];
  const faces = [];
  let vCount = 0;
  let triangles = 0;
  let currentMat = -1;
  const m = new Float64Array(16);
  for (const i of exportableInstances(scene)) {
    const entry = scene.geometries[scene.geom[i]];
    const mesh = meshOf(entry, Math.min(lod, entry.lods - 1));
    if (!mesh.vertexCount) continue;
    for (let k = 0; k < 16; k++) m[k] = scene.matrices[i * 16 + k];
    const mi = scene.mat[i];
    if (mi !== currentMat) {
      faces.push(`usemtl ${names[mi]}`);
      currentMat = mi;
    }
    // normal matrix = cofactor (sign-corrected)
    const c00 = m[5] * m[10] - m[6] * m[9], c01 = m[6] * m[8] - m[4] * m[10], c02 = m[4] * m[9] - m[5] * m[8];
    const c10 = m[9] * m[2] - m[10] * m[1], c11 = m[10] * m[0] - m[8] * m[2], c12 = m[8] * m[1] - m[9] * m[0];
    const c20 = m[1] * m[6] - m[2] * m[5], c21 = m[2] * m[4] - m[0] * m[6], c22 = m[0] * m[5] - m[1] * m[4];
    const det = m[0] * c00 + m[1] * c01 + m[2] * c02;
    const sg = det < 0 ? -1 : 1;
    const p = mesh.positions, nr = mesh.normals, uv = mesh.uvs;
    const n = mesh.vertexCount;
    const material = scene.materials[mi];
    const withUV = uvs === true || (uvs === 'auto' && !!(material.map || material.normalMap));
    const vt = new Int32Array(n);
    const vn = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const x = p[k * 3], y = p[k * 3 + 1], z = p[k * 3 + 2];
      vLines.push(`v ${fixed(m[0] * x + m[4] * y + m[8] * z + m[12], digits)} ${fixed(m[1] * x + m[5] * y + m[9] * z + m[13], digits)} ${fixed(m[2] * x + m[6] * y + m[10] * z + m[14], digits)}`);
      if (mesh.kind === 'triangles') {
        const a = nr[k * 3], b = nr[k * 3 + 1], c = nr[k * 3 + 2];
        let nx = (c00 * a + c10 * b + c20 * c) * sg, ny = (c01 * a + c11 * b + c21 * c) * sg, nz = (c02 * a + c12 * b + c22 * c) * sg;
        const l = Math.hypot(nx, ny, nz) || 1;
        const key = `${fixed(nx / l, 4)} ${fixed(ny / l, 4)} ${fixed(nz / l, 4)}`;
        let ni = vnIndex.get(key);
        if (ni === undefined) {
          ni = vnLines.length + 1;
          vnIndex.set(key, ni);
          vnLines.push('vn ' + key);
        }
        vn[k] = ni;
        if (!withUV) continue;
        const tkey = `${fixed(uv[k * 2], 4)} ${fixed(uv[k * 2 + 1], 4)}`;
        let ti = vtIndex.get(tkey);
        if (ti === undefined) {
          ti = vtLines.length + 1;
          vtIndex.set(tkey, ti);
          vtLines.push('vt ' + tkey);
        }
        vt[k] = ti;
      }
    }
    const idx = mesh.indices;
    if (mesh.kind === 'lines') {
      for (let k = 0; k < idx.length; k += 2) faces.push(`l ${idx[k] + 1 + vCount} ${idx[k + 1] + 1 + vCount}`);
    } else {
      for (let k = 0; k < idx.length; k += 3) {
        let a = idx[k], b = idx[k + 1], c = idx[k + 2];
        if (det < 0) [b, c] = [c, b];
        if (withUV) faces.push(`f ${a + 1 + vCount}/${vt[a]}/${vn[a]} ${b + 1 + vCount}/${vt[b]}/${vn[b]} ${c + 1 + vCount}/${vt[c]}/${vn[c]}`);
        else faces.push(`f ${a + 1 + vCount}//${vn[a]} ${b + 1 + vCount}//${vn[b]} ${c + 1 + vCount}//${vn[c]}`);
      }
      triangles += idx.length / 3;
    }
    vCount += n;
  }
  const parts = [out, vLines, vtLines, vnLines, faces].filter((a) => a.length).map((a) => a.join('\n'));
  const mtl = [];
  scene.materials.forEach((mat, i) => {
    const kd = mat.baseColor.slice(0, 3).map((c) => fixed(linearToSrgb(c), 4)).join(' ');
    const ke = mat.emissive.map((c) => fixed(Math.min(1, linearToSrgb(c)), 4)).join(' ');
    mtl.push(`newmtl ${names[i]}`, `Kd ${kd}`, `Ke ${ke}`, `d ${fixed(mat.opacity, 4)}`, `Pr ${fixed(mat.roughness, 4)}`, `Pm ${fixed(mat.metallic, 4)}`, '');
  });
  return { obj: parts.join('\n') + '\n', mtl: mtl.join('\n'), vertices: vCount, triangles };
}

// ---------------------------------------------------------------------------
// parsing

const POW10 = Array.from({ length: 23 }, (_, i) => 10 ** i); // exact doubles

function parseMtl(text) {
  const mats = new Map();
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    const k = parts[0];
    if (k === 'newmtl') {
      cur = { name: parts.slice(1).join(' '), color: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.5, opacity: 1, emissive: [0, 0, 0, 1] };
      mats.set(cur.name, cur);
    } else if (cur) {
      const nums = parts.slice(1).map(Number);
      if (k === 'Kd') cur.color = [nums[0], nums[1], nums[2], 1];
      else if (k === 'Ke') cur.emissive = [nums[0], nums[1], nums[2], 1];
      else if (k === 'd') cur.opacity = nums[0];
      else if (k === 'Tr') cur.opacity = 1 - nums[0];
      else if (k === 'Pr') cur.roughness = nums[0];
      else if (k === 'Pm') cur.metallic = nums[0];
      else if (k === 'Ns') cur.roughness = Math.sqrt(2 / (nums[0] + 2));
    }
  }
  return mats;
}

/**
 * Parse OBJ text (and optional MTL text) into meshes grouped by material.
 * Faces are scanned character by character and corners are de-duplicated
 * through per-position linked lists, so large files parse without per-corner
 * string allocations.
 * @returns {{groups: {material: string, mesh: Mesh}[], materials: Map, stats: object}}
 */
export function parseOBJ(text, mtlText = '') {
  const pos = [];
  const nrm = [];
  const tex = [];
  const groups = new Map();
  let group = null;
  const groupList = [];
  const useGroup = (name) => {
    group = groups.get(name);
    if (!group) {
      group = { material: name, id: groupList.length, p: [], n: [], t: [], idx: [], lines: [], hasNormals: true, hasUV: true };
      groups.set(name, group);
      groupList.push(group);
    }
  };
  useGroup('default');
  // corner de-duplication: for every position index a linked list of the
  // (group, texcoord, normal) combinations already emitted
  let head = new Int32Array(1024).fill(-1);
  let cap = 1024;
  let nextE = new Int32Array(cap), gE = new Int32Array(cap), tE = new Int32Array(cap), nE = new Int32Array(cap), outE = new Int32Array(cap);
  let entries = 0;
  const growEntries = () => {
    cap *= 2;
    const grow = (a) => {
      const b = new Int32Array(cap);
      b.set(a);
      return b;
    };
    nextE = grow(nextE);
    gE = grow(gE);
    tE = grow(tE);
    nE = grow(nE);
    outE = grow(outE);
  };
  const corner = (v, t, n) => {
    if (v < 0) v = pos.length / 3 + v + 1;
    if (t < 0) t = tex.length / 2 + t + 1;
    if (n < 0) n = nrm.length / 3 + n + 1;
    if (v < 1 || v > pos.length / 3) throw new Error(`OBJ face references vertex ${v}, but only ${pos.length / 3} are defined.`);
    if (v > head.length) {
      let len = head.length;
      while (len < v) len *= 2;
      const h = new Int32Array(len).fill(-1);
      h.set(head);
      head = h;
    }
    for (let e = head[v - 1]; e >= 0; e = nextE[e]) {
      if (gE[e] === group.id && tE[e] === t && nE[e] === n) return outE[e];
    }
    const idx = group.p.length / 3;
    group.p.push(pos[(v - 1) * 3], pos[(v - 1) * 3 + 1], pos[(v - 1) * 3 + 2]);
    if (n) group.n.push(nrm[(n - 1) * 3], nrm[(n - 1) * 3 + 1], nrm[(n - 1) * 3 + 2]);
    else {
      group.hasNormals = false;
      group.n.push(0, 0, 0);
    }
    if (t) group.t.push(tex[(t - 1) * 2], tex[(t - 1) * 2 + 1]);
    else {
      group.hasUV = false;
      group.t.push(0, 0);
    }
    if (entries === cap) growEntries();
    gE[entries] = group.id;
    tE[entries] = t;
    nE[entries] = n;
    outE[entries] = idx;
    nextE[entries] = head[v - 1];
    head[v - 1] = entries++;
    return idx;
  };
  let i = 0;
  const L = text.length;
  // plain decimals (the common case) are converted with one exact division,
  // which gives the same correctly rounded double as Number(); anything else
  // (exponents, very long mantissas) goes through Number()
  const decimal = (start, end) => {
    let k = start;
    let neg = false;
    const c0 = text.charCodeAt(k);
    if (c0 === 45 || c0 === 43) {
      neg = c0 === 45;
      k++;
    }
    let mant = 0, scale = 0, dot = false, digits = 0;
    for (; k < end; k++) {
      const c = text.charCodeAt(k);
      if (c >= 48 && c <= 57) {
        if (mant > 9e14) return +text.slice(start, end);
        mant = mant * 10 + (c - 48);
        digits++;
        if (dot) scale++;
      } else if (c === 46 && !dot) dot = true;
      else return +text.slice(start, end);
    }
    if (!digits || scale > 22) return +text.slice(start, end);
    const v = scale ? mant / POW10[scale] : mant;
    return neg ? -v : v;
  };
  const readFloats = (start, end, out, count) => {
    let k = start;
    for (let c = 0; c < count; c++) {
      while (k < end && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
      let e = k;
      while (e < end && text.charCodeAt(e) !== 32 && text.charCodeAt(e) !== 9) e++;
      out.push(k < e ? decimal(k, e) : 0);
      k = e;
    }
  };
  // signed integer scanner for face records; `at` is the cursor
  let at = 0;
  const int = (end) => {
    let sign = 1;
    if (text.charCodeAt(at) === 45) {
      sign = -1;
      at++;
    }
    let v = 0;
    let digits = 0;
    for (let c = text.charCodeAt(at); at < end && c >= 48 && c <= 57; c = text.charCodeAt(++at)) {
      v = v * 10 + (c - 48);
      digits++;
    }
    return digits ? sign * v : 0;
  };
  // the corners of one face / line record, as output indices
  const refs = [];
  const readRefs = (start, end) => {
    refs.length = 0;
    at = start;
    for (;;) {
      while (at < end && (text.charCodeAt(at) === 32 || text.charCodeAt(at) === 9)) at++;
      if (at >= end) break;
      const v = int(end);
      let t = 0, n = 0;
      if (text.charCodeAt(at) === 47) {
        at++;
        t = int(end);
        if (text.charCodeAt(at) === 47) {
          at++;
          n = int(end);
        }
      }
      const c = text.charCodeAt(at);
      if (at < end && c !== 32 && c !== 9) throw new Error(`Invalid OBJ vertex reference near "${text.slice(start, Math.min(end, start + 40))}".`);
      refs.push(corner(v, t, n));
    }
  };
  while (i < L) {
    let e = text.indexOf('\n', i);
    if (e < 0) e = L;
    let s = i;
    while (s < e && (text.charCodeAt(s) === 32 || text.charCodeAt(s) === 9)) s++;
    const c0 = text.charCodeAt(s);
    const c1 = text.charCodeAt(s + 1);
    let end = e;
    if (text.charCodeAt(end - 1) === 13) end--;
    if (c0 === 118) {
      // v, vn, vt
      if (c1 === 32 || c1 === 9) readFloats(s + 2, end, pos, 3);
      else if (c1 === 110) readFloats(s + 3, end, nrm, 3);
      else if (c1 === 116) readFloats(s + 3, end, tex, 2);
    } else if (c0 === 102 && (c1 === 32 || c1 === 9)) {
      readRefs(s + 2, end);
      for (let k = 2; k < refs.length; k++) group.idx.push(refs[0], refs[k - 1], refs[k]);
    } else if (c0 === 108 && (c1 === 32 || c1 === 9)) {
      readRefs(s + 2, end);
      for (let k = 0; k + 1 < refs.length; k++) group.lines.push(refs[k], refs[k + 1]);
    } else if (text.startsWith('usemtl', s)) {
      useGroup(text.slice(s + 6, end).trim() || 'default');
    }
    i = e + 1;
  }
  const result = [];
  let triangles = 0;
  for (const g of groups.values()) {
    if (g.idx.length) {
      let mesh;
      if (g.hasNormals) {
        mesh = new Mesh({ positions: Float32Array.from(g.p), normals: Float32Array.from(g.n), uvs: Float32Array.from(g.t), indices: Uint32Array.from(g.idx) });
      } else {
        mesh = computeNormals(Float32Array.from(g.p), Uint32Array.from(g.idx), 30, g.hasUV ? Float32Array.from(g.t) : null);
      }
      result.push({ material: g.material, mesh });
      triangles += g.idx.length / 3;
    }
    if (g.lines.length) {
      result.push({ material: g.material, mesh: new Mesh({ positions: Float32Array.from(g.p), indices: Uint32Array.from(g.lines), kind: 'lines' }) });
    }
  }
  return { groups: result, materials: mtlText ? parseMtl(mtlText) : new Map(), stats: { vertices: pos.length / 3, triangles } };
}

/** Parse OBJ into a RenderScene (one identity instance per material group). */
export function objToScene(text, mtlText = '') {
  const parsed = parseOBJ(text, mtlText);
  const matIndex = new Map();
  const materials = [];
  const geometries = [];
  const instances = new InstanceTable();
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const g of parsed.groups) {
    let mi = matIndex.get(g.material);
    if (mi === undefined) {
      mi = materials.length;
      matIndex.set(g.material, mi);
      const m = parsed.materials.get(g.material);
      materials.push(m ? { ...m } : { name: g.material });
    }
    geometries.push({ mesh: g.mesh });
    instances.push(geometries.length - 1, mi, I);
  }
  return { ...buildExternalScene({ geometries, materials, instances }), parsed };
}
