// Strict stand-ins for a WebGL2 context and a WebGPU device, for testing the
// backends' buffer handling without a GPU.
//
// They keep real buffer memory, so a test can compare what is "on the GPU"
// with what should be there, and they count the bytes sent from the CPU
// (`sent`) apart from the bytes copied GPU-side (`copied`). Every call the
// real API would reject throws instead of being silently ignored:
//
// WebGL2: a buffer's type is fixed on first bind (ELEMENT_ARRAY_BUFFER or
// other; spec 5.1); element and non-element buffers cannot be copied into each
// other; writes and copies must stay in bounds; deleted buffers cannot be used;
// ELEMENT_ARRAY_BUFFER is vertex-array state.
//
// WebGPU: writeBuffer needs COPY_DST, copyBufferToBuffer needs COPY_SRC and
// COPY_DST, offsets and sizes are multiples of 4, everything stays in bounds,
// and a buffer destroyed before a command that reads it is submitted fails the
// submit. Commands run at submit, in order with writeBuffer, as on a queue.

import assert from 'node:assert/strict';

export const GPUBufferUsage = Object.freeze({ MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 });

/** Install the WebGPU globals the backend reads at call time. */
export function installWebGPUGlobals() {
  globalThis.GPUBufferUsage ??= GPUBufferUsage;
}

const GL = Object.freeze({ ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, COPY_READ_BUFFER: 0x8f36, COPY_WRITE_BUFFER: 0x8f37, UNIFORM_BUFFER: 0x8a11, STATIC_DRAW: 0x88e4, FLOAT: 0x1406 });

export function mockWebGL2() {
  const bound = new Map(); // context-wide targets
  const vaos = new Map(); // vao -> its ELEMENT_ARRAY_BUFFER
  let vao = null;
  const attribs = new Map(); // `${vao}:${index}` -> buffer the pointer reads
  const counts = { sent: 0, copied: 0, bufferData: 0 };

  const live = (b, what) => {
    assert.ok(b, `${what}: no buffer bound`);
    assert.ok(!b.deleted, `${what}: buffer was deleted`);
    return b;
  };
  const kindOf = (target) => (target === GL.ELEMENT_ARRAY_BUFFER ? 'element' : 'other');
  const at = (target) => (target === GL.ELEMENT_ARRAY_BUFFER ? (vao ? vaos.get(vao) : bound.get(target)) : bound.get(target));

  const gl = {
    ...GL,
    counts,
    createBuffer: () => ({ data: new Uint8Array(0), kind: null, deleted: false }),
    deleteBuffer(b) {
      if (b) b.deleted = true;
    },
    createVertexArray: () => ({ id: Symbol('vao') }),
    bindVertexArray(v) {
      vao = v;
      if (v && !vaos.has(v)) vaos.set(v, null);
    },
    bindBuffer(target, b) {
      if (b) {
        assert.ok(!b.deleted, 'bindBuffer: buffer was deleted');
        // copy targets take either kind; any other bind fixes the kind once
        if (target !== GL.COPY_READ_BUFFER && target !== GL.COPY_WRITE_BUFFER) {
          const k = kindOf(target);
          assert.ok(b.kind === null || b.kind === k, `INVALID_OPERATION: a buffer first bound as ${b.kind} cannot be bound to ${target === GL.ELEMENT_ARRAY_BUFFER ? 'ELEMENT_ARRAY_BUFFER' : 'a non-element target'}`);
          b.kind = k;
        }
      }
      if (target === GL.ELEMENT_ARRAY_BUFFER && vao) vaos.set(vao, b);
      else bound.set(target, b);
    },
    bufferData(target, size) {
      assert.equal(typeof size, 'number', 'bufferData: the backend allocates by size');
      live(at(target), 'bufferData').data = new Uint8Array(size);
      counts.bufferData++;
    },
    bufferSubData(target, offset, src) {
      const b = live(at(target), 'bufferSubData');
      assert.ok(ArrayBuffer.isView(src), 'bufferSubData: data must be a view');
      const bytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
      assert.ok(offset >= 0 && offset + bytes.length <= b.data.length, `bufferSubData: ${bytes.length} bytes at ${offset} overflow a ${b.data.length}-byte buffer`);
      b.data.set(bytes, offset);
      counts.sent += bytes.length;
    },
    copyBufferSubData(readTarget, writeTarget, readOffset, writeOffset, size) {
      const r = live(bound.get(readTarget), 'copyBufferSubData read');
      const w = live(bound.get(writeTarget), 'copyBufferSubData write');
      assert.notEqual(r, w);
      assert.ok(r.kind && w.kind, 'copyBufferSubData: a buffer that was never bound to a typed target');
      assert.equal(r.kind, w.kind, 'INVALID_OPERATION: copy between an element and a non-element buffer');
      assert.ok(readOffset + size <= r.data.length && writeOffset + size <= w.data.length, 'copyBufferSubData: out of bounds');
      w.data.set(r.data.subarray(readOffset, readOffset + size), writeOffset);
      counts.copied += size;
    },
    enableVertexAttribArray() {},
    vertexAttribPointer(index) {
      assert.ok(vao, 'vertexAttribPointer outside the VAO');
      attribs.set(`${String(vao.id)}:${index}`, live(bound.get(GL.ARRAY_BUFFER), 'vertexAttribPointer'));
    },
    vertexAttribDivisor() {},
    /** The buffer bound to a context-wide target, or null. */
    boundTo: (target) => bound.get(target) ?? null,
    /** What a draw through `v` reads: the buffer behind attribute `index` and the index buffer. */
    drawState(v, index = 0) {
      return { vertices: attribs.get(`${String(v.id)}:${index}`), indices: vaos.get(v) };
    },
  };
  // Everything that is not buffer state (shaders, textures, framebuffers,
  // queries) is accepted and answered with a harmless value, so the backend's
  // own rebuildResources() can run. Buffer calls above stay strict.
  return new Proxy(gl, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) return 1;
      if (key === 'getExtension') return () => null;
      if (/^get\w*Parameter$/.test(key)) return () => true;
      if (key === 'isContextLost') return () => false;
      return () => ({});
    },
  });
}

export function mockWebGPU() {
  const counts = { sent: 0, copied: 0, created: 0, submits: 0 };
  const aligned = (n, what) => assert.equal(n % 4, 0, `${what} (${n}) is not a multiple of 4`);
  const inBounds = (b, off, n, what) => assert.ok(off >= 0 && off + n <= b.size, `${what}: ${n} bytes at ${off} overflow a ${b.size}-byte buffer`);

  const device = {
    counts,
    createBuffer({ size, usage }) {
      aligned(size, 'buffer size');
      counts.created++;
      return {
        size,
        usage,
        data: new Uint8Array(size),
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
    },
    createCommandEncoder() {
      const commands = [];
      let finished = false;
      return {
        copyBufferToBuffer(src, srcOffset, dst, dstOffset, size) {
          assert.ok(!finished);
          assert.ok(src.usage & GPUBufferUsage.COPY_SRC, 'copy source lacks COPY_SRC');
          assert.ok(dst.usage & GPUBufferUsage.COPY_DST, 'copy destination lacks COPY_DST');
          assert.notEqual(src, dst);
          for (const [n, what] of [[srcOffset, 'source offset'], [dstOffset, 'destination offset'], [size, 'copy size']]) aligned(n, what);
          inBounds(src, srcOffset, size, 'copy source');
          inBounds(dst, dstOffset, size, 'copy destination');
          commands.push(() => {
            assert.ok(!src.destroyed && !dst.destroyed, 'submitted a copy that uses a destroyed buffer');
            dst.data.set(src.data.subarray(srcOffset, srcOffset + size), dstOffset);
            counts.copied += size;
          });
        },
        finish() {
          finished = true;
          return commands;
        },
      };
    },
    queue: {
      submit(buffers) {
        counts.submits++;
        for (const commands of buffers) for (const run of commands) run();
      },
      writeBuffer(b, offset, data, dataOffset = 0, size) {
        assert.ok(!b.destroyed, 'writeBuffer to a destroyed buffer');
        assert.ok(b.usage & GPUBufferUsage.COPY_DST, 'writeBuffer target lacks COPY_DST');
        assert.ok(data instanceof ArrayBuffer, 'this backend passes an ArrayBuffer with offsets');
        aligned(offset, 'writeBuffer offset');
        aligned(size, 'writeBuffer size');
        inBounds(b, offset, size, 'writeBuffer');
        b.data.set(new Uint8Array(data, dataOffset, size), offset);
        counts.sent += size;
      },
    },
  };
  return device;
}
