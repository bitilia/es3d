// Mesh data structure and building helpers.
//
// A Mesh is an indexed triangle (or line) list with interleavable attributes:
// positions (xyz), normals (xyz), uvs (uv). Generators produce meshes in a
// canonical local space; the renderer packs them into shared GPU buffers.

import { computeNormalsWasm } from '../wasm/kernels.js';

export class Mesh {
  /**
   * @param {{positions: Float32Array, normals?: Float32Array, uvs?: Float32Array, indices: Uint32Array, kind?: 'triangles'|'lines'}} o
   */
  constructor(o) {
    this.positions = o.positions;
    const n = this.positions.length / 3;
    this.normals = o.normals || new Float32Array(n * 3);
    this.uvs = o.uvs || new Float32Array(n * 2);
    this.indices = o.indices;
    this.kind = o.kind || 'triangles';
    this._bounds = null;
    this._edges = null;
    this._normalLines = null;
  }

  get vertexCount() {
    return this.positions.length / 3;
  }

  get primitiveCount() {
    return this.kind === 'lines' ? this.indices.length / 2 : this.indices.length / 3;
  }

  get byteSize() {
    return this.positions.byteLength + this.normals.byteLength + this.uvs.byteLength + this.indices.byteLength;
  }

  get bounds() {
    if (!this._bounds) {
      const p = this.positions;
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = p[i + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
      if (p.length === 0) {
        min.fill(0);
        max.fill(0);
      }
      this._bounds = { min, max };
    }
    return this._bounds;
  }

  /** Unique edges as a line index list (for wireframe display). */
  edges() {
    if (this._edges) return this._edges;
    if (this.kind === 'lines') return (this._edges = this.indices);
    // weld positions so that seams do not show as edges twice
    const weld = weldMap(this.positions);
    const seen = new Set();
    const out = [];
    const idx = this.indices;
    const nv = this.vertexCount;
    for (let i = 0; i < idx.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = idx[i + k];
        const b = idx[i + ((k + 1) % 3)];
        const wa = weld[a], wb = weld[b];
        if (wa === wb) continue;
        const key = wa < wb ? wa * nv + wb : wb * nv + wa;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a, b);
      }
    }
    this._edges = Uint32Array.from(out);
    return this._edges;
  }

  /** Line vertices for normal display: [p, n, flag] where flag 0 = base, 1 = tip. */
  normalLines() {
    if (this._normalLines) return this._normalLines;
    const n = this.vertexCount;
    const positions = new Float32Array(n * 6);
    const normals = new Float32Array(n * 6);
    const uvs = new Float32Array(n * 4);
    const indices = new Uint32Array(n * 2);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        positions[i * 6 + k] = this.positions[i * 3 + k];
        positions[i * 6 + 3 + k] = this.positions[i * 3 + k];
        normals[i * 6 + k] = this.normals[i * 3 + k];
        normals[i * 6 + 3 + k] = this.normals[i * 3 + k];
      }
      uvs[i * 4 + 2] = 1; // tip flag in u
      indices[i * 2] = i * 2;
      indices[i * 2 + 1] = i * 2 + 1;
    }
    this._normalLines = new Mesh({ positions, normals, uvs, indices, kind: 'lines' });
    return this._normalLines;
  }
}

/** Map each vertex to the first vertex with the same position (quantized to 1e-6). */
export function weldMap(positions) {
  const n = positions.length / 3;
  const map = new Uint32Array(n);
  // open addressing hash table over quantized coordinates (no string keys)
  let size = 16;
  while (size < n * 2) size *= 2;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const q = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) q[i] = Math.round(positions[i] * 1e6);
  for (let i = 0; i < n; i++) {
    const x = q[i * 3], y = q[i * 3 + 1], z = q[i * 3 + 2];
    let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & mask;
    for (;;) {
      const f = table[h];
      if (f < 0) {
        table[h] = i;
        map[i] = i;
        break;
      }
      if (q[f * 3] === x && q[f * 3 + 1] === y && q[f * 3 + 2] === z) {
        map[i] = f;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return map;
}

/** Growable mesh builder. */
export class MeshBuilder {
  /**
   * @param {'triangles'|'lines'} kind
   * @param {number} vertexCapacity vertices to allocate for; a generator that
   *   knows its exact counts passes them, so nothing grows or is copied
   * @param {number} indexCapacity
   */
  constructor(kind = 'triangles', vertexCapacity = 256, indexCapacity = 768) {
    this.kind = kind;
    vertexCapacity = Math.max(1, vertexCapacity);
    indexCapacity = Math.max(1, indexCapacity);
    this.p = new Float32Array(vertexCapacity * 3);
    this.n = new Float32Array(vertexCapacity * 3);
    this.t = new Float32Array(vertexCapacity * 2);
    this.i = new Uint32Array(indexCapacity);
    this.vc = 0;
    this.ic = 0;
  }

  growV(extra) {
    const need = this.vc + extra;
    if (need * 3 <= this.p.length) return;
    let cap = this.p.length / 3;
    while (cap < need) cap *= 2;
    const p = new Float32Array(cap * 3);
    p.set(this.p);
    const n = new Float32Array(cap * 3);
    n.set(this.n);
    const t = new Float32Array(cap * 2);
    t.set(this.t);
    this.p = p;
    this.n = n;
    this.t = t;
  }

  growI(extra) {
    const need = this.ic + extra;
    if (need <= this.i.length) return;
    let cap = this.i.length;
    while (cap < need) cap *= 2;
    const i = new Uint32Array(cap);
    i.set(this.i);
    this.i = i;
  }

  vertex(px, py, pz, nx = 0, ny = 0, nz = 0, u = 0, v = 0) {
    if (this.vc * 3 >= this.p.length) this.growV(1);
    const k = this.vc;
    this.p[k * 3] = px;
    this.p[k * 3 + 1] = py;
    this.p[k * 3 + 2] = pz;
    this.n[k * 3] = nx;
    this.n[k * 3 + 1] = ny;
    this.n[k * 3 + 2] = nz;
    this.t[k * 2] = u;
    this.t[k * 2 + 1] = v;
    this.vc++;
    return k;
  }

  tri(a, b, c) {
    if (this.ic + 3 > this.i.length) this.growI(3);
    this.i[this.ic++] = a;
    this.i[this.ic++] = b;
    this.i[this.ic++] = c;
  }

  /** Quad a-b-c-d in counter-clockwise order (as seen from the front). */
  quad(a, b, c, d) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  line(a, b) {
    if (this.ic + 2 > this.i.length) this.growI(2);
    this.i[this.ic++] = a;
    this.i[this.ic++] = b;
  }

  get vertexCount() {
    return this.vc;
  }

  build() {
    // a builder sized exactly (generators that count first) hands over its arrays
    const exact = (a, n) => (a.length === n ? a : a.slice(0, n));
    return new Mesh({
      positions: exact(this.p, this.vc * 3),
      normals: exact(this.n, this.vc * 3),
      uvs: exact(this.t, this.vc * 2),
      indices: exact(this.i, this.ic),
      kind: this.kind,
    });
  }
}

// Every generator writes through a builder, and a builder lives only while
// one mesh is made. When a full collection finds no builder alive, V8 drops
// the hidden class of the instances and discards all optimized code that
// relied on it, so the next scene would run the generators unoptimized again.
// This one never dies, and neither does the class.
MeshBuilder.shapeKeeper = new MeshBuilder('triangles', 1, 1);

/**
 * Compute vertex normals for an indexed triangle soup with a crease angle:
 * faces meeting at an angle larger than the crease get split normals.
 * Returns a new mesh (vertices may be duplicated at creases).
 */
export function computeNormals(positions, indices, creaseDeg = 30, uvs = null) {
  const crease = Math.min(Math.max(creaseDeg, 0), 180);
  const cosCrease = Math.cos((crease * Math.PI) / 180);
  if (crease === crease) {
    const w = computeNormalsWasm(positions, indices, crease, cosCrease, uvs);
    if (w) return new Mesh({ ...w, kind: 'triangles' });
  }
  const nt = indices.length / 3;
  const faceN = new Float64Array(nt * 3); // area weighted (not normalized)
  const faceU = new Float64Array(nt * 3); // unit length
  for (let t = 0; t < nt; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    const x = e1y * e2z - e1z * e2y, y = e1z * e2x - e1x * e2z, z = e1x * e2y - e1y * e2x;
    faceN[t * 3] = x;
    faceN[t * 3 + 1] = y;
    faceN[t * 3 + 2] = z;
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    faceU[t * 3] = x / l;
    faceU[t * 3 + 1] = y / l;
    faceU[t * 3 + 2] = z / l;
  }
  const weld = weldMap(positions);
  const nv = positions.length / 3;
  // faces incident to each welded vertex (CSR layout), needed only to test the crease angle
  let counts = null, inc = null;
  if (crease > 0 && crease < 180) {
    counts = new Uint32Array(nv + 1);
    for (let i = 0; i < indices.length; i++) counts[weld[indices[i]] + 1]++;
    for (let i = 0; i < nv; i++) counts[i + 1] += counts[i];
    inc = new Uint32Array(indices.length);
    const fill = counts.slice(0, nv);
    for (let i = 0; i < indices.length; i++) inc[fill[weld[indices[i]]]++] = (i / 3) | 0;
  }
  // without creases every corner of a welded vertex gets the same normal:
  // sum the faces, then normalize once per welded vertex
  let smoothN = null;
  if (crease >= 180) {
    smoothN = new Float64Array(nv * 3);
    for (let i = 0; i < indices.length; i++) {
      const w = weld[indices[i]] * 3, f = ((i / 3) | 0) * 3;
      smoothN[w] += faceN[f];
      smoothN[w + 1] += faceN[f + 1];
      smoothN[w + 2] += faceN[f + 2];
    }
    for (let w = 0; w < nv * 3; w += 3) {
      const x = smoothN[w], y = smoothN[w + 1], z = smoothN[w + 2];
      const l = Math.sqrt(x * x + y * y + z * z) || 1;
      smoothN[w] = x / l;
      smoothN[w + 1] = y / l;
      smoothN[w + 2] = z / l;
    }
  }
  // output vertices: as many as the input until creases split some
  let cap = Math.max(1, nv);
  let outP = new Float32Array(cap * 3), outN = new Float32Array(cap * 3), outT = new Float32Array(cap * 2);
  const outI = new Uint32Array(indices.length);
  let vc = 0;
  let smoothOk = smoothN !== null;
  for (let k = 0; smoothOk && k < nv * 3; k++) if (smoothN[k] !== smoothN[k]) smoothOk = false;
  if (smoothOk) {
    // one normal per welded vertex, so every input vertex becomes exactly one
    // output vertex, in the order the triangles first use it
    const out = new Int32Array(nv).fill(-1);
    for (let i = 0; i < indices.length; i++) {
      const vi = indices[i];
      let idx = out[vi];
      if (idx < 0) {
        idx = out[vi] = vc++;
        const w = weld[vi] * 3;
        outP[idx * 3] = positions[vi * 3];
        outP[idx * 3 + 1] = positions[vi * 3 + 1];
        outP[idx * 3 + 2] = positions[vi * 3 + 2];
        outN[idx * 3] = smoothN[w];
        outN[idx * 3 + 1] = smoothN[w + 1];
        outN[idx * 3 + 2] = smoothN[w + 2];
        if (uvs) {
          outT[idx * 2] = uvs[vi * 2];
          outT[idx * 2 + 1] = uvs[vi * 2 + 1];
        }
      }
      outI[i] = idx;
    }
  } else {
    // output vertices already emitted for each input vertex, as a linked list
    // keyed by the normal quantized to 1e-4 (corners with equal normals share)
    const head = new Int32Array(nv).fill(-1);
    let next = new Int32Array(cap);
    let qn = new Int32Array(cap * 3);
    for (let i = 0; i < indices.length; i++) {
      const t = (i / 3) | 0;
      const vi = indices[i];
      const w = weld[vi];
      let nx = 0, ny = 0, nz = 0;
      if (crease <= 0) {
        nx = faceU[t * 3];
        ny = faceU[t * 3 + 1];
        nz = faceU[t * 3 + 2];
      } else if (smoothN) {
        nx = smoothN[w * 3];
        ny = smoothN[w * 3 + 1];
        nz = smoothN[w * 3 + 2];
      } else {
        // faces within the crease angle of this corner's face
        const fx = faceU[t * 3], fy = faceU[t * 3 + 1], fz = faceU[t * 3 + 2];
        for (let k = counts[w]; k < counts[w + 1]; k++) {
          const f = inc[k];
          if (f === t || faceU[f * 3] * fx + faceU[f * 3 + 1] * fy + faceU[f * 3 + 2] * fz >= cosCrease) {
            nx += faceN[f * 3];
            ny += faceN[f * 3 + 1];
            nz += faceN[f * 3 + 2];
          }
        }
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
      }
      const qx = Math.round(nx * 1e4), qy = Math.round(ny * 1e4), qz = Math.round(nz * 1e4);
      let idx = head[vi];
      while (idx >= 0 && !(qn[idx * 3] === qx && qn[idx * 3 + 1] === qy && qn[idx * 3 + 2] === qz)) idx = next[idx];
      if (idx < 0) {
        idx = vc++;
        if (idx >= cap) {
          cap *= 2;
          const grow = (a, size) => {
            const g = new a.constructor(cap * size);
            g.set(a);
            return g;
          };
          outP = grow(outP, 3);
          outN = grow(outN, 3);
          outT = grow(outT, 2);
          next = grow(next, 1);
          qn = grow(qn, 3);
        }
        outP[idx * 3] = positions[vi * 3];
        outP[idx * 3 + 1] = positions[vi * 3 + 1];
        outP[idx * 3 + 2] = positions[vi * 3 + 2];
        outN[idx * 3] = nx;
        outN[idx * 3 + 1] = ny;
        outN[idx * 3 + 2] = nz;
        if (uvs) {
          outT[idx * 2] = uvs[vi * 2];
          outT[idx * 2 + 1] = uvs[vi * 2 + 1];
        }
        next[idx] = head[vi];
        head[vi] = idx;
        qn[idx * 3] = qx;
        qn[idx * 3 + 1] = qy;
        qn[idx * 3 + 2] = qz;
      }
      outI[i] = idx;
    }
  }
  const exact = (a, n) => (a.length === n ? a : a.slice(0, n));
  return new Mesh({ positions: exact(outP, vc * 3), normals: exact(outN, vc * 3), uvs: exact(outT, vc * 2), indices: outI, kind: 'triangles' });
}

/** Merge meshes transformed by matrices (used by exporters). */
export function mergeTransformed(items) {
  let vc = 0;
  let ic = 0;
  for (const { mesh } of items) {
    vc += mesh.vertexCount;
    ic += mesh.indices.length;
  }
  const positions = new Float32Array(vc * 3);
  const normals = new Float32Array(vc * 3);
  const uvs = new Float32Array(vc * 2);
  const indices = new Uint32Array(ic);
  let vo = 0;
  let io = 0;
  for (const { mesh, matrix: m } of items) {
    const p = mesh.positions, n = mesh.normals;
    // normal matrix = cofactor of the upper 3x3 (with determinant sign)
    const c0 = [m[5] * m[10] - m[6] * m[9], m[6] * m[8] - m[4] * m[10], m[4] * m[9] - m[5] * m[8]];
    const c1 = [m[9] * m[2] - m[10] * m[1], m[10] * m[0] - m[8] * m[2], m[8] * m[1] - m[9] * m[0]];
    const c2 = [m[1] * m[6] - m[2] * m[5], m[2] * m[4] - m[0] * m[6], m[0] * m[5] - m[1] * m[4]];
    const det = m[0] * c0[0] + m[1] * c0[1] + m[2] * c0[2];
    const sgn = det < 0 ? -1 : 1;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      positions[(vo + i) * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      positions[(vo + i) * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      positions[(vo + i) * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      const nx = n[i * 3], ny = n[i * 3 + 1], nz = n[i * 3 + 2];
      let ox = (c0[0] * nx + c1[0] * ny + c2[0] * nz) * sgn;
      let oy = (c0[1] * nx + c1[1] * ny + c2[1] * nz) * sgn;
      let oz = (c0[2] * nx + c1[2] * ny + c2[2] * nz) * sgn;
      const l = Math.hypot(ox, oy, oz) || 1;
      normals[(vo + i) * 3] = ox / l;
      normals[(vo + i) * 3 + 1] = oy / l;
      normals[(vo + i) * 3 + 2] = oz / l;
      uvs[(vo + i) * 2] = mesh.uvs[i * 2];
      uvs[(vo + i) * 2 + 1] = mesh.uvs[i * 2 + 1];
    }
    const flip = det < 0 && mesh.kind === 'triangles';
    for (let i = 0; i < mesh.indices.length; i += 3) {
      if (mesh.kind === 'lines') break;
      indices[io + i] = mesh.indices[i] + vo;
      indices[io + i + 1] = mesh.indices[flip ? i + 2 : i + 1] + vo;
      indices[io + i + 2] = mesh.indices[flip ? i + 1 : i + 2] + vo;
    }
    if (mesh.kind === 'lines') for (let i = 0; i < mesh.indices.length; i++) indices[io + i] = mesh.indices[i] + vo;
    vo += mesh.vertexCount;
    io += mesh.indices.length;
  }
  return new Mesh({ positions, normals, uvs, indices, kind: items.length ? items[0].mesh.kind : 'triangles' });
}
