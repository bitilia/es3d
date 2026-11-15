// Shared vertex / index buffers.
//
// All meshes (every geometry, every level of detail, wireframe edge lists and
// normal-visualisation lines) are packed into ONE interleaved vertex array and
// ONE 32-bit index array. Indices are stored pre-offset (absolute), so a draw
// is just (firstIndex, indexCount). No per-draw buffer binding, and no base
// vertex. That keeps the WebGL2 and WebGPU paths the same.
//
// The pool is CPU-side; backends upload the ranges appended since their last
// sync. The CPU copy is kept so a lost GPU context can be rebuilt.
//
// Growing and resetting are different events:
// - Growing keeps every byte and adds room. The CPU side adds a chunk (old
//   chunks are never copied), and backends grow their buffers with a GPU-side
//   copy of what they already hold, then upload only what is new. Vertex and
//   index storage grow independently.
// - Resetting (reset(), a repack) throws the content away. It bumps
//   `generation`, and backends reallocate and upload from zero.

export const VERTEX_FLOATS = 8; // position xyz, normal xyz, uv
export const VERTEX_BYTES = VERTEX_FLOATS * 4;

/**
 * A growable typed array stored as chunks. Element `i` of the whole array is
 * in the chunk whose `start <= i < start + length`. Growing appends a chunk
 * and never moves existing data.
 */
class ChunkedArray {
  constructor(Type, stride, capacity) {
    this.Type = Type;
    this.stride = stride; // array entries per element (8 floats per vertex, 1 per index)
    this.chunks = [{ start: 0, length: capacity, data: new Type(capacity * stride) }];
    this.capacity = capacity; // elements
  }

  /** Make room for `count` elements in total. Returns true when it grew. */
  reserve(count) {
    if (count <= this.capacity) return false;
    let cap = Math.max(1, this.capacity); // a zero capacity would never double
    while (cap < count) cap *= 2;
    const length = cap - this.capacity;
    this.chunks.push({ start: this.capacity, length, data: new this.Type(length * this.stride) });
    this.capacity = cap;
    return true;
  }

  /**
   * Visit the parts of elements [start, end) chunk by chunk:
   * fn(firstElement, view), where view is the chunk's typed array restricted
   * to that part.
   */
  forEach(start, end, fn) {
    const s = this.stride;
    for (const c of this.chunks) {
      const a = Math.max(start, c.start);
      const b = Math.min(end, c.start + c.length);
      if (a < b) fn(a, c.data.subarray((a - c.start) * s, (b - c.start) * s));
    }
  }
}

export class GeometryPool {
  constructor(vertexCapacity = 1 << 16, indexCapacity = 1 << 17) {
    this.vertexStore = new ChunkedArray(Float32Array, VERTEX_FLOATS, vertexCapacity);
    this.indexStore = new ChunkedArray(Uint32Array, 1, indexCapacity);
    this.vertexCount = 0;
    this.indexCount = 0;
    this.ranges = new Map(); // key object -> {firstIndex, indexCount}
    this.edgeRanges = new Map();
    this.normalRanges = new Map();
    // dirty tracking for incremental uploads
    this.generation = 0; // bumps when the content is thrown away (reset, repack); NOT on growth
    this.uploadedVertices = 0;
    this.uploadedIndices = 0;
  }

  /** Vertex capacity in vertices. Backends size their vertex buffer to at least this. */
  get vertexCapacity() {
    return this.vertexStore.capacity;
  }

  /** Index capacity in indices. */
  get indexCapacity() {
    return this.indexStore.capacity;
  }

  /** Capacity in bytes of the vertex storage. */
  get vertexCapacityBytes() {
    return this.vertexStore.capacity * VERTEX_BYTES;
  }

  /** Capacity in bytes of the index storage. */
  get indexCapacityBytes() {
    return this.indexStore.capacity * 4;
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

  /** Make room for more vertices and indices. Growing keeps what is stored and uploaded. */
  ensure(extraV, extraI) {
    this.vertexStore.reserve(this.vertexCount + extraV);
    this.indexStore.reserve(this.indexCount + extraI);
  }

  appendVertices(mesh) {
    const n = mesh.vertexCount;
    const base = this.vertexCount;
    const p = mesh.positions, nr = mesh.normals, t = mesh.uvs;
    this.vertexStore.forEach(base, base + n, (first, v) => {
      const count = v.length / VERTEX_FLOATS;
      let o = 0;
      for (let i = first - base, end = i + count; i < end; i++) {
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
    });
    this.vertexCount += n;
    return base;
  }

  appendIndices(src, base) {
    const first = this.indexCount;
    this.indexStore.forEach(first, first + src.length, (at, dst) => {
      const off = at - first;
      for (let i = 0; i < dst.length; i++) dst[i] = src[off + i] + base;
    });
    this.indexCount += src.length;
    return first;
  }

  /** Visit stored vertices [start, end) chunk by chunk: fn(firstVertex, Float32Array). */
  forEachVertices(start, end, fn) {
    this.vertexStore.forEach(start, end, fn);
  }

  /** Visit stored indices [start, end) chunk by chunk: fn(firstIndex, Uint32Array). */
  forEachIndices(start, end, fn) {
    this.indexStore.forEach(start, end, fn);
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
