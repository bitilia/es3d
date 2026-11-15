// The geometry pool (render/geometry-pool.js) and how the backends upload it
// (syncPool in render/webgl2 and render/webgpu).
//
// Growing the pool keeps its content: the CPU copy adds a chunk without moving
// data, and a backend grows only the buffer that ran out of room by a GPU-side
// copy, then uploads only what is new. Only a reset (or a rebuilt context)
// uploads everything. Regression: in 1.2.0 every growth re-sent the whole pool
// in one frame (42-48 MB, 111-147 ms on a streamed city drive).
//
// The backends run against strict mocks (test/helpers/gpu-mocks.mjs) that keep
// real buffer memory and reject what the real APIs reject.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeometryPool, VERTEX_BYTES, VERTEX_FLOATS } from '../src/render/geometry-pool.js';
import { WebGL2Backend } from '../src/render/webgl2/webgl2-backend.js';
import { installWebGPUGlobals, mockWebGL2, mockWebGPU } from './helpers/gpu-mocks.mjs';

installWebGPUGlobals();
const { WebGPUBackend } = await import('../src/render/webgpu/webgpu-backend.js');

// --- meshes and pool contents --------------------------------------------------

/** A mesh with distinct, recognisable values, so misplaced bytes show up. */
function mesh(vertexCount, indexCount, salt = 0) {
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let i = 0; i < positions.length; i++) positions[i] = salt + i;
  for (let i = 0; i < normals.length; i++) normals[i] = -(salt + i);
  for (let i = 0; i < uvs.length; i++) uvs[i] = (salt + i) / 8;
  const indices = new Uint32Array(indexCount);
  for (let i = 0; i < indexCount; i++) indices[i] = (i * 7 + salt) % vertexCount;
  return { vertexCount, positions, normals, uvs, indices };
}

const meshBytes = (m) => m.vertexCount * VERTEX_BYTES + m.indices.length * 4;

/** The pool's vertices and indices as single byte arrays. */
function poolBytes(pool) {
  const v = new Uint8Array(pool.vertexCount * VERTEX_BYTES);
  pool.forEachVertices(0, pool.vertexCount, (first, d) => v.set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), first * VERTEX_BYTES));
  const i = new Uint8Array(pool.indexCount * 4);
  pool.forEachIndices(0, pool.indexCount, (first, d) => i.set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), first * 4));
  return { v, i };
}

/** Every vertex as the interleaved floats meshRange() should have written. */
function expectedVertex(m, i) {
  return [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2], m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2], m.uvs[i * 2], m.uvs[i * 2 + 1]];
}

function readVertex(pool, v) {
  let out = null;
  pool.forEachVertices(v, v + 1, (_, d) => (out = Array.from(d)));
  return out;
}

function readIndices(pool, first, count) {
  const out = new Uint32Array(count);
  pool.forEachIndices(first, first + count, (at, d) => out.set(d, at - first));
  return out;
}

const chunks = (pool) => [pool.vertexStore.chunks.length, pool.indexStore.chunks.length];

// --- GeometryPool --------------------------------------------------------------

test('pool: growing keeps the generation and what was uploaded; reset discards both', () => {
  const pool = new GeometryPool(64, 64);
  pool.meshRange(mesh(40, 60));
  pool.markUploaded();
  pool.meshRange(mesh(100, 200, 1));
  assert.deepEqual(chunks(pool), [2, 2], 'both stores grew');
  assert.equal(pool.generation, 0);
  assert.deepEqual(pool.pending(), { full: false, vertexStart: 40, vertexEnd: 140, indexStart: 60, indexEnd: 260 });

  pool.reset();
  assert.equal(pool.generation, 1);
  assert.deepEqual(pool.pending(), { full: true, vertexStart: 0, vertexEnd: 0, indexStart: 0, indexEnd: 0 });
  assert.equal(pool.vertexCapacity, 256, 'a reset keeps the capacity');
});

test('pool: growing never moves stored data', () => {
  const pool = new GeometryPool(16, 16);
  pool.meshRange(mesh(10, 12));
  const first = pool.vertexStore.chunks[0].data;
  const before = Array.from(first.subarray(0, 10 * VERTEX_FLOATS));
  for (let k = 0; k < 5; k++) pool.meshRange(mesh(30, 40, k + 1));
  assert.equal(pool.vertexStore.chunks[0].data, first, 'the first chunk is the same array');
  assert.deepEqual(Array.from(first.subarray(0, 10 * VERTEX_FLOATS)), before);
});

test('pool: vertex and index storage grow independently', () => {
  const pool = new GeometryPool(100, 100);
  pool.meshRange(mesh(90, 10));
  pool.meshRange(mesh(5, 300, 1)); // indices only
  assert.deepEqual(chunks(pool), [1, 2]);
  pool.meshRange(mesh(200, 4, 2)); // vertices only
  assert.deepEqual(chunks(pool), [2, 2]);
});

test('pool: capacity doubles to fit, in one chunk per growth', () => {
  const pool = new GeometryPool(16, 16);
  pool.meshRange(mesh(1000, 3));
  assert.equal(pool.vertexCapacity, 1024);
  assert.deepEqual(pool.vertexStore.chunks.map((c) => [c.start, c.length]), [[0, 16], [16, 1008]]);
  assert.equal(pool.vertexCapacityBytes, 1024 * VERTEX_BYTES);
  assert.equal(pool.indexCapacityBytes, 16 * 4);
});

test('pool: a mesh written across chunk boundaries reads back exactly', () => {
  const pool = new GeometryPool(50, 50);
  pool.meshRange(mesh(37, 41));
  const m = mesh(300, 500, 1000); // its first 13 vertices and 9 indices end chunk 0
  const r = pool.meshRange(m);
  assert.deepEqual(chunks(pool), [2, 2]);
  assert.equal(pool.vertexStore.chunks[1].start, 50);
  for (const i of [0, 12, 13, 14, 299]) assert.deepEqual(readVertex(pool, r.baseVertex + i), expectedVertex(m, i), `vertex ${i}`);
  const idx = readIndices(pool, r.firstIndex, m.indices.length);
  for (let i = 0; i < m.indices.length; i++) assert.equal(idx[i], m.indices[i] + r.baseVertex, `index ${i}`);
});

test('pool: a zero capacity grows instead of looping forever', () => {
  const pool = new GeometryPool(0, 0);
  const r = pool.meshRange(mesh(3, 3));
  assert.deepEqual([pool.vertexCapacity, pool.indexCapacity], [4, 4]);
  assert.deepEqual(readIndices(pool, r.firstIndex, 3), mesh(3, 3).indices);
});

test('pool: ranges are cached and edge lists reuse the mesh vertices', () => {
  const pool = new GeometryPool();
  const m = Object.assign(mesh(8, 12), { edges: () => new Uint32Array([0, 1, 1, 2]) });
  const r = pool.meshRange(m);
  assert.equal(pool.meshRange(m), r);
  const bytes = pool.byteSize;
  const e = pool.edgeRange(m);
  assert.equal(pool.vertexCount, 8, 'no new vertices');
  assert.equal(pool.byteSize, bytes + 4 * 4);
  assert.deepEqual(readIndices(pool, e.firstIndex, 4), new Uint32Array([0, 1, 1, 2]).map((i) => i + r.baseVertex));
});

// --- backends --------------------------------------------------------------------

/** A WebGL2 backend set up by its own rebuildResources() on the strict mock. */
function webgl2() {
  const be = new WebGL2Backend({});
  be.gl = mockWebGL2();
  be.rebuildResources();
  return {
    be,
    counts: be.gl.counts,
    buffers: () => ({ vertices: be.vertexBuffer, indices: be.indexBuffer }),
    drawn: () => be.gl.drawState(be.vao),
    released: (b) => b.deleted,
    restore() {
      be.rebuildResources(); // what webglcontextrestored does
    },
  };
}

function webgpu() {
  const be = new WebGPUBackend({});
  be.device = mockWebGPU();
  return {
    be,
    counts: be.device.counts,
    buffers: () => ({ vertices: be.vertexBuffer, indices: be.indexBuffer }),
    drawn: () => ({ vertices: be.vertexBuffer, indices: be.indexBuffer }), // set per pass from these fields
    released: (b) => b.destroyed,
  };
}

/** Sync and return the bytes sent from the CPU (checked against the return value). */
function sync(gpu, pool) {
  const sent = gpu.counts.sent;
  const reported = gpu.be.syncPool(pool);
  assert.equal(reported, gpu.counts.sent - sent, 'syncPool reports the bytes it sent');
  return reported;
}

/** The GPU buffers hold exactly the pool, and draws read those buffers. */
function assertMirrors(gpu, pool) {
  const { v, i } = poolBytes(pool);
  const { vertices, indices } = gpu.buffers();
  assert.ok(vertices.data.length >= pool.vertexCapacityBytes && indices.data.length >= pool.indexCapacityBytes, 'buffers hold the whole capacity');
  assert.ok(Buffer.from(vertices.data.subarray(0, v.length)).equals(v), 'vertex buffer equals the pool');
  assert.ok(Buffer.from(indices.data.subarray(0, i.length)).equals(i), 'index buffer equals the pool');
  const drawn = gpu.drawn();
  assert.equal(drawn.vertices, vertices, 'draws read the current vertex buffer');
  assert.equal(drawn.indices, indices, 'draws read the current index buffer');
}

for (const [name, make] of [['WebGL2', webgl2], ['WebGPU', webgpu]]) {
  test(`${name}: the first sync uploads the pool, a sync with nothing new uploads nothing`, () => {
    const pool = new GeometryPool(1 << 10, 1 << 10);
    const gpu = make();
    for (let k = 0; k < 4; k++) pool.meshRange(mesh(500, 700, k * 10000)); // grew before any sync
    assert.equal(sync(gpu, pool), pool.byteSize);
    assert.equal(gpu.counts.copied, 0, 'nothing to copy yet');
    assertMirrors(gpu, pool);
    const held = gpu.buffers();
    assert.equal(sync(gpu, pool), 0);
    assert.deepEqual(gpu.buffers(), held, 'no buffer replaced');
  });

  test(`${name}: growing uploads only the new mesh (issue repro: 80 tiles of 0.7 MB)`, () => {
    const pool = new GeometryPool(); // the renderer's default capacities
    const gpu = make();
    let growths = 0;
    let largest = 0;
    for (let tile = 1; tile <= 80; tile++) {
      const m = mesh(20000, 30000, tile);
      const before = chunks(pool).join();
      pool.meshRange(m);
      const sent = sync(gpu, pool);
      assert.equal(sent, meshBytes(m), `tile ${tile}`);
      largest = Math.max(largest, sent);
      if (chunks(pool).join() !== before) {
        growths++;
        assertMirrors(gpu, pool);
      }
    }
    assert.ok(growths >= 8, `the pool grew ${growths} times`);
    assert.equal(largest, meshBytes(mesh(20000, 30000)), 'no frame sends more than one tile');
    assert.ok(gpu.counts.copied > 0);
  });

  // capacities above WebGPU's 64 kB minimum buffer, so growing the pool grows the buffers
  test(`${name}: only the store that ran out of room is reallocated`, () => {
    const pool = new GeometryPool(4096, 1 << 15);
    const gpu = make();
    pool.meshRange(mesh(3000, 3000));
    sync(gpu, pool);
    const a = gpu.buffers();

    pool.meshRange(mesh(2000, 4, 1)); // vertices grow
    assert.equal(sync(gpu, pool), meshBytes(mesh(2000, 4)));
    const b = gpu.buffers();
    assert.notEqual(b.vertices, a.vertices);
    assert.equal(b.indices, a.indices, 'index buffer untouched');
    assert.ok(gpu.released(a.vertices), 'the old vertex buffer is released');
    assert.ok(!gpu.released(a.indices));
    assertMirrors(gpu, pool);

    pool.meshRange(mesh(4, 40000, 2)); // indices grow
    assert.equal(sync(gpu, pool), meshBytes(mesh(4, 40000)));
    const c = gpu.buffers();
    assert.equal(c.vertices, b.vertices, 'vertex buffer untouched');
    assert.notEqual(c.indices, b.indices);
    assert.ok(gpu.released(b.indices));
    assertMirrors(gpu, pool);
  });

  test(`${name}: a reset after growth reallocates and uploads from zero`, () => {
    const pool = new GeometryPool(1 << 10, 1 << 10);
    const gpu = make();
    for (let k = 0; k < 8; k++) {
      pool.meshRange(mesh(400, 800, k));
      sync(gpu, pool);
    }
    pool.reset();
    const m = mesh(123, 456, 99);
    pool.meshRange(m);
    const copied = gpu.counts.copied;
    assert.equal(sync(gpu, pool), meshBytes(m));
    assert.equal(gpu.counts.copied, copied, 'reset content is not copied');
    assertMirrors(gpu, pool);
  });
}

test('WebGL2: growth copies exactly the uploaded bytes and leaves the copy targets unbound', () => {
  const gpu = webgl2();
  const gl = gpu.be.gl;
  const pool = new GeometryPool(64, 64);
  pool.meshRange(mesh(50, 50));
  sync(gpu, pool);
  pool.meshRange(mesh(50, 50, 1));
  sync(gpu, pool);
  assert.equal(gpu.counts.copied, 50 * VERTEX_BYTES + 50 * 4);
  assert.equal(gl.boundTo(gl.COPY_READ_BUFFER), null, 'no binding keeps a deleted buffer alive');
  assert.equal(gl.boundTo(gl.COPY_WRITE_BUFFER), null);
});

test('WebGL2: a restored context uploads the whole pool from the CPU copy', () => {
  const gpu = webgl2();
  const pool = new GeometryPool(1 << 10, 1 << 10);
  for (let k = 0; k < 12; k++) {
    pool.meshRange(mesh(400, 800, k));
    sync(gpu, pool);
  }
  gpu.restore();
  assert.equal(sync(gpu, pool), pool.byteSize);
  assertMirrors(gpu, pool);
});

test('WebGPU: a growing sync submits one copy; others submit nothing', () => {
  const gpu = webgpu();
  const pool = new GeometryPool(4096, 1 << 15);
  pool.meshRange(mesh(3000, 30000));
  sync(gpu, pool);
  assert.equal(gpu.counts.submits, 0);
  pool.meshRange(mesh(3000, 30000, 1)); // both stores grow
  sync(gpu, pool);
  assert.equal(gpu.counts.submits, 1, 'vertex and index copies share one submit');
  pool.meshRange(mesh(2, 2, 2));
  sync(gpu, pool);
  assert.equal(gpu.counts.submits, 1);
  for (const b of Object.values(gpu.buffers())) assert.ok(b.usage & GPUBufferUsage.COPY_SRC, 'pool buffers can be copied from');
});
