// Shared vertex / index buffers.
//
// All meshes (every geometry, every level of detail, wireframe edge lists and
// normal-visualisation lines) are packed into ONE interleaved vertex array and
// ONE 32-bit index array. Indices are stored pre-offset (absolute), so a draw
// is just (firstIndex, indexCount). No per-draw buffer binding, and no base
// vertex. That keeps the WebGL2 and WebGPU paths the same.
//
// The pool is CPU-side; backends upload the ranges appended since their last
// sync (or everything after a reallocation).

export const VERTEX_FLOATS = 8; // position xyz, normal xyz, uv
export const VERTEX_BYTES = VERTEX_FLOATS * 4;

export class GeometryPool {
  constructor(vertexCapacity = 1 << 16, indexCapacity = 1 << 17) {
    this.vertices = new Float32Array(vertexCapacity * VERTEX_FLOATS);
    this.indices = new Uint32Array(indexCapacity);
    this.vertexCount = 0;
    this.indexCount = 0;
    this.ranges = new Map(); // key object -> {firstIndex, indexCount}
    this.edgeRanges = new Map();
    this.normalRanges = new Map();
    // dirty tracking for incremental uploads
    this.generation = 0; // bumps on reallocation
    this.uploadedVertices = 0;
    this.uploadedIndices = 0;
  }

  reset() {
    this.vertexCount = 0;
    this.indexCount = 0;
    this.ranges.clear();
    this.edgeRanges.clear();
    this.normalRanges.clear();
    this.generation++;
    this.uploadedVertices = 0;
    this.uploadedIndices = 0;
  }

  get byteSize() {
    return this.vertexCount * VERTEX_BYTES + this.indexCount * 4;
  }

  ensure(extraV, extraI) {
    let grew = false;
    if ((this.vertexCount + extraV) * VERTEX_FLOATS > this.vertices.length) {
      let cap = this.vertices.length / VERTEX_FLOATS;
      while (cap < this.vertexCount + extraV) cap *= 2;
      const v = new Float32Array(cap * VERTEX_FLOATS);
      v.set(this.vertices.subarray(0, this.vertexCount * VERTEX_FLOATS));
      this.vertices = v;
      grew = true;
    }
    if (this.indexCount + extraI > this.indices.length) {
      let cap = this.indices.length;
      while (cap < this.indexCount + extraI) cap *= 2;
      const i = new Uint32Array(cap);
      i.set(this.indices.subarray(0, this.indexCount));
      this.indices = i;
      grew = true;
    }
    if (grew) {
      this.generation++;
      this.uploadedVertices = 0;
      this.uploadedIndices = 0;
    }
  }

  appendVertices(mesh) {
    const n = mesh.vertexCount;
    const base = this.vertexCount;
    const v = this.vertices;
    const p = mesh.positions, nr = mesh.normals, t = mesh.uvs;
    let o = base * VERTEX_FLOATS;
    for (let i = 0; i < n; i++) {
      v[o] = p[i * 3];
      v[o + 1] = p[i * 3 + 1];
      v[o + 2] = p[i * 3 + 2];
      v[o + 3] = nr[i * 3];
      v[o + 4] = nr[i * 3 + 1];
      v[o + 5] = nr[i * 3 + 2];
      v[o + 6] = t[i * 2];
      v[o + 7] = t[i * 2 + 1];
      o += VERTEX_FLOATS;
    }
    this.vertexCount += n;
    return base;
  }

  appendIndices(src, base) {
    const first = this.indexCount;
    const dst = this.indices;
    for (let i = 0; i < src.length; i++) dst[first + i] = src[i] + base;
    this.indexCount += src.length;
    return first;
  }

  /** Range of a mesh's primitives (triangles or lines). */
  meshRange(mesh) {
    let r = this.ranges.get(mesh);
    if (r) return r;
    this.ensure(mesh.vertexCount, mesh.indices.length);
    const base = this.appendVertices(mesh);
    const first = this.appendIndices(mesh.indices, base);
    r = { firstIndex: first, indexCount: mesh.indices.length, baseVertex: base, kind: mesh.kind };
    this.ranges.set(mesh, r);
    return r;
  }

  /** Line range with the unique edges of a mesh (wireframe). */
  edgeRange(mesh) {
    let r = this.edgeRanges.get(mesh);
    if (r) return r;
    const base = this.meshRange(mesh).baseVertex;
    const edges = mesh.edges();
    this.ensure(0, edges.length);
    const first = this.appendIndices(edges, base);
    r = { firstIndex: first, indexCount: edges.length, kind: 'lines' };
    this.edgeRanges.set(mesh, r);
    return r;
  }

  /** Line range visualising vertex normals (uv.x = 0 at the base, 1 at the tip). */
  normalRange(mesh) {
    let r = this.normalRanges.get(mesh);
    if (r) return r;
    const lines = mesh.normalLines();
    r = this.meshRange(lines);
    this.normalRanges.set(mesh, r);
    return r;
  }

  /** Pending upload ranges since the last sync. */
  pending() {
    return {
      full: this.uploadedVertices === 0 && this.uploadedIndices === 0,
      vertexStart: this.uploadedVertices,
      vertexEnd: this.vertexCount,
      indexStart: this.uploadedIndices,
      indexEnd: this.indexCount,
    };
  }

  markUploaded() {
    this.uploadedVertices = this.vertexCount;
    this.uploadedIndices = this.indexCount;
  }
}
