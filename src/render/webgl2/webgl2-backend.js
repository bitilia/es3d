// WebGL2 rendering backend.
//
// One VAO, one shared vertex buffer and one shared 32-bit index buffer (from
// the GeometryPool), one instance buffer per frame. Each batch is a single
// drawElementsInstanced call; the per-instance attribute pointers are moved to
// the batch's first instance (WebGL2 has no firstInstance parameter). Mesh
// programs are specialised per material feature set and light setup
// (meshFragmentShader) and compiled on first use.
//
// Frames are drawn with 4x multisampling, as in the WebGPU backend, so edges
// look the same everywhere. The canvas is asked for antialiasing; when the
// browser grants at least 4 samples (the usual case) frames go straight into
// it. The request is only a hint, though: with fewer samples, frames are drawn
// into our own 4x framebuffer and resolved into the canvas, which costs two
// full-screen copies per frame.

import { meshVertexShader, meshFragmentShader, TEXTURE_FLAGS, LINE_VS, NORMAL_VS, LINE_FS } from '../shaders/glsl.js';
import { FRAME_BYTES, MATERIAL_FLOATS, packMaterial, packOverlay, lightTypes } from '../lighting.js';
import { VERTEX_BYTES } from '../geometry-pool.js';

export const MSAA_SAMPLES = 4;
const ANISOTROPY = 8;

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`WebGL2 ${label} shader compile error: ${log}`);
  }
  return sh;
}

function program(gl, vs, fs, label) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, label + ' vertex'));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, label + ' fragment'));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`WebGL2 ${label} link error: ${gl.getProgramInfoLog(p)}`);
  const frameIdx = gl.getUniformBlockIndex(p, 'Frame');
  if (frameIdx !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, frameIdx, 0);
  const matIdx = gl.getUniformBlockIndex(p, 'Material');
  if (matIdx !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, matIdx, 1);
  gl.useProgram(p);
  const bindSampler = (name, unit) => {
    const loc = gl.getUniformLocation(p, name);
    if (loc) gl.uniform1i(loc, unit);
  };
  bindSampler('uMap', 0);
  bindSampler('uNormalMap', 1);
  bindSampler('uMrMap', 2);
  bindSampler('uOcclusionMap', 3);
  bindSampler('uEmissiveMap', 4);
  return p;
}

export class WebGL2Backend {
  constructor(canvas) {
    this.canvas = canvas;
    this.kind = 'webgl2';
    this.zeroToOne = false;
    this.gl = null;
    this.vertexCapacity = 0;
    this.indexCapacity = 0;
    this.instanceCapacity = 0;
    this.poolGeneration = -1;
    this.materialUbos = new Map();
    this.overlayUbos = new Map();
    this.gpuBytes = 0;
    this.lost = false;
    this.info = '';
  }

  async init() {
    const gl = this.canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    // colours are written already encoded as sRGB; say so, so wide-gamut screens do not stretch them
    if ('drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = 'srgb';
    const granted = gl.getParameter(gl.SAMPLES) || 0;
    this.direct = granted >= MSAA_SAMPLES;
    this.samples = this.direct ? granted : Math.min(MSAA_SAMPLES, gl.getParameter(gl.MAX_SAMPLES) || 0);
    if (!this.direct) {
      this.fbo = gl.createFramebuffer();
      this.colorRb = gl.createRenderbuffer();
      this.depthRb = gl.createRenderbuffer();
      // A multisample resolve must blit between identical formats, and the
      // canvas of an opaque context is RGB8, RGBA8 or BGRA8 depending on the
      // driver. So samples are resolved into a single-sample RGBA8 buffer, and
      // that is copied to the canvas (a single-sample copy may convert formats).
      this.resolveFbo = gl.createFramebuffer();
      this.resolveRb = gl.createRenderbuffer();
    }
    this.targetSize = [0, 0];
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.info = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');

    this.meshPrograms = new Map();
    this.lineProgram = program(gl, LINE_VS, LINE_FS, 'line');
    this.normalProgram = program(gl, NORMAL_VS, LINE_FS, 'normals');

    this.vertexBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.instanceBuffer = gl.createBuffer();
    this.frameUbo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, FRAME_BYTES, gl.DYNAMIC_DRAW);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, VERTEX_BYTES, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, VERTEX_BYTES, 24);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    for (let k = 0; k < 4; k++) {
      gl.enableVertexAttribArray(3 + k);
      gl.vertexAttribPointer(3 + k, 4, gl.FLOAT, false, 64, k * 16);
      gl.vertexAttribDivisor(3 + k, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);

    this.whiteTex = this.createTexture({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }, true);
    this.flatNormalTex = this.createTexture({ width: 1, height: 1, data: new Uint8Array([128, 128, 255, 255]) }, false);
    this.matData = new Float32Array(MATERIAL_FLOATS);
  }

  createTexture(px, srgb) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, px.width, px.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, px.data instanceof Uint8Array ? px.data : new Uint8Array(px.data.buffer, px.data.byteOffset, px.data.byteLength));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (px.width > 1) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, ANISOTROPY);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    this.gpuBytes += px.width * px.height * 4 * (px.width > 1 ? 1.33 : 1);
    return t;
  }

  destroyTexture(t) {
    this.gl.deleteTexture(t);
  }

  /** Upload geometry appended to the pool since the last sync. */
  syncPool(pool) {
    const gl = this.gl;
    const vBytes = pool.vertices.byteLength;
    const iBytes = pool.indices.byteLength;
    const realloc = pool.generation !== this.poolGeneration || vBytes !== this.vertexCapacity || iBytes !== this.indexCapacity;
    let uploaded = 0;
    if (realloc) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vBytes, gl.STATIC_DRAW);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, iBytes, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.vertexCapacity = vBytes;
      this.indexCapacity = iBytes;
      this.poolGeneration = pool.generation;
      pool.uploadedVertices = 0;
      pool.uploadedIndices = 0;
    }
    const p = pool.pending();
    if (p.vertexEnd > p.vertexStart) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      const f = 8;
      gl.bufferSubData(gl.ARRAY_BUFFER, p.vertexStart * VERTEX_BYTES, pool.vertices.subarray(p.vertexStart * f, p.vertexEnd * f));
      uploaded += (p.vertexEnd - p.vertexStart) * VERTEX_BYTES;
    }
    if (p.indexEnd > p.indexStart) {
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, p.indexStart * 4, pool.indices.subarray(p.indexStart, p.indexEnd));
      gl.bindVertexArray(null);
      uploaded += (p.indexEnd - p.indexStart) * 4;
    }
    pool.markUploaded();
    return uploaded;
  }

  uploadInstances(data, count) {
    const gl = this.gl;
    const bytes = count * 64;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (bytes > this.instanceCapacity) {
      let cap = Math.max(this.instanceCapacity, 64 * 256);
      while (cap < bytes) cap *= 2;
      gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
      this.instanceCapacity = cap;
    }
    if (bytes) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * 16));
    return bytes;
  }

  readyTexture(entry, srgb) {
    if (entry && entry.status === 'ready' && !entry.gpu) entry.gpu = this.createTexture(entry.pixels, srgb);
    return entry && entry.gpu ? entry.gpu : null;
  }

  materialBinding(material, textures) {
    const gl = this.gl;
    let b = this.materialUbos.get(material);
    if (!b) {
      b = { ubo: gl.createBuffer(), map: null, normalMap: null, mrMap: null, occlusionMap: null, emissiveMap: null, key: '' };
      this.materialUbos.set(material, b);
    }
    // texture state may change asynchronously (downloads)
    const mapGpu = this.readyTexture(material.map ? textures.get(material.map, 'color') : null, true);
    const nrmGpu = this.readyTexture(material.normalMap ? textures.get(material.normalMap, 'normal') : null, false);
    const mrGpu = this.readyTexture(material.metallicRoughnessMap ? textures.get(material.metallicRoughnessMap, 'linear') : null, false);
    const occGpu = this.readyTexture(material.occlusionMap ? textures.get(material.occlusionMap, 'linear') : null, false);
    const emGpu = this.readyTexture(material.emissiveMap ? textures.get(material.emissiveMap, 'color') : null, true);
    const hasMap = !!mapGpu;
    const hasNormalMap = !!nrmGpu;
    const hasMrMap = !!mrGpu;
    const hasOcclusionMap = !!occGpu;
    const hasEmissiveMap = !!emGpu;
    const key = `${hasMap}|${hasNormalMap}|${hasMrMap}|${hasOcclusionMap}|${hasEmissiveMap}`;
    if (b.key !== key) {
      packMaterial(this.matData, material, { hasMap, hasNormalMap, hasMrMap, hasOcclusionMap, hasEmissiveMap, doubleSided: material.doubleSided });
      gl.bindBuffer(gl.UNIFORM_BUFFER, b.ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, this.matData, gl.STATIC_DRAW);
      b.key = key;
      b.flags = this.matData[10];
    }
    b.map = mapGpu || this.whiteTex;
    b.normalMap = nrmGpu || this.flatNormalTex;
    b.mrMap = mrGpu || this.whiteTex;
    b.occlusionMap = occGpu || this.whiteTex;
    b.emissiveMap = emGpu || this.whiteTex;
    return b;
  }

  /** Per-batch uniform buffer for double-sided geometry that uses a single-sided material. */
  doubleSidedBinding(material, textures) {
    const base = this.materialBinding(material, textures);
    let ds = base.doubleSidedUbo;
    const key = base.key;
    if (!ds || base.dsKey !== key) {
      if (!ds) ds = base.doubleSidedUbo = this.gl.createBuffer();
      const hasMap = base.map !== this.whiteTex;
      const hasNormalMap = base.normalMap !== this.flatNormalTex;
      const hasMrMap = base.mrMap !== this.whiteTex;
      const hasOcclusionMap = base.occlusionMap !== this.whiteTex;
      const hasEmissiveMap = base.emissiveMap !== this.whiteTex;
      packMaterial(this.matData, material, { hasMap, hasNormalMap, hasMrMap, hasOcclusionMap, hasEmissiveMap, doubleSided: true });
      this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, ds);
      this.gl.bufferData(this.gl.UNIFORM_BUFFER, this.matData, this.gl.STATIC_DRAW);
      base.dsKey = key;
      base.dsFlags = this.matData[10];
    }
    // one object per material, so the draw loop can tell when nothing needs rebinding
    const out = base.dsBinding || (base.dsBinding = {});
    out.ubo = ds;
    out.flags = base.dsFlags;
    out.map = base.map;
    out.normalMap = base.normalMap;
    out.mrMap = base.mrMap;
    out.occlusionMap = base.occlusionMap;
    out.emissiveMap = base.emissiveMap;
    return out;
  }

  overlayUbo(name, rgba) {
    let u = this.overlayUbos.get(name);
    if (!u) {
      u = this.gl.createBuffer();
      this.overlayUbos.set(name, u);
      packOverlay(this.matData, rgba);
      this.gl.bindBuffer(this.gl.UNIFORM_BUFFER, u);
      this.gl.bufferData(this.gl.UNIFORM_BUFFER, this.matData, this.gl.STATIC_DRAW);
    }
    return u;
  }

  /** Free uniform buffers of materials that are no longer used. */
  releaseMaterials(keep) {
    for (const [m, b] of this.materialUbos) {
      if (keep.has(m)) continue;
      this.gl.deleteBuffer(b.ubo);
      if (b.doubleSidedUbo) this.gl.deleteBuffer(b.doubleSidedUbo);
      this.materialUbos.delete(m);
    }
  }

  setInstanceOffset(first) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const base = first * 64;
    for (let k = 0; k < 4; k++) gl.vertexAttribPointer(3 + k, 4, gl.FLOAT, false, 64, base + k * 16);
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /** What this backend renders with (Renderer.caps). */
  get caps() {
    const gl = this.gl;
    return {
      msaaSamples: this.samples,
      anisotropy: this.aniso ? Math.min(ANISOTROPY, gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 1,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      colorSpace: gl.drawingBufferColorSpace || 'srgb',
    };
  }

  /** The program for a material's feature flags under the frame's lights, compiled on first use. */
  meshProgram(flags, lights) {
    const key = `${flags}|${lights}`;
    let p = this.meshPrograms.get(key);
    if (!p) {
      p = program(this.gl, meshVertexShader((flags & TEXTURE_FLAGS) !== 0), meshFragmentShader(flags, lights), 'mesh');
      this.meshPrograms.set(key, p);
    }
    return p;
  }

  /** The multisampled framebuffer frames are drawn into without a multisampled canvas. */
  ensureTarget() {
    if (this.direct) return;
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    if (this.targetSize[0] === w && this.targetSize[1] === h) return;
    this.targetSize = [w, h];
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.colorRb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA8, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.colorRb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.resolveRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolveFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.resolveRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Resolve the multisampled frame into the canvas. */
  present(w, h) {
    if (this.direct) return;
    const gl = this.gl;
    const blit = (from, to) => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    };
    blit(this.fbo, this.resolveFbo);
    blit(this.resolveFbo, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * @param {object} draw result of FrameBuilder.build
   * @param {Float32Array} frameData packed frame uniforms
   * @param {object} ctx {background:[r,g,b], textures, overlayColors, cubeRange}
   */
  render(draw, frameData, ctx) {
    const gl = this.gl;
    if (this.lost) return;
    const w = this.canvas.width, h = this.canvas.height;
    this.ensureTarget();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.direct ? null : this.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(ctx.background[0], ctx.background[1], ctx.background[2], 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);

    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, frameData);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.frameUbo);

    this.uploadInstances(draw.instanceData, draw.instanceCount);
    gl.bindVertexArray(this.vao);
    const lights = lightTypes(frameData);

    let current = null;
    const use = (p) => {
      if (current !== p) {
        gl.useProgram(p);
        current = p;
      }
    };
    let blending = false;
    // Batches arrive sorted by pipeline state, then material, so most of
    // this state carries over from the previous batch and is not set again.
    let cull = -1; // 0 none, 1 back faces of CCW triangles, 2 of CW (mirrored)
    let bound = null;
    gl.cullFace(gl.BACK);
    for (const b of draw.batches) {
      const lines = b.kind === 'lines';
      const binding = b.doubleSided && !b.material.doubleSided ? this.doubleSidedBinding(b.material, ctx.textures) : this.materialBinding(b.material, ctx.textures);
      use(lines ? this.lineProgram : this.meshProgram(binding.flags, lights));
      const c = b.doubleSided || lines ? 0 : b.mirrored ? 2 : 1;
      if (c !== cull) {
        if (c === 0) gl.disable(gl.CULL_FACE);
        else {
          if (cull <= 0) gl.enable(gl.CULL_FACE);
          gl.frontFace(c === 2 ? gl.CW : gl.CCW);
        }
        cull = c;
      }
      if (b.transparent !== blending) {
        blending = b.transparent;
        if (blending) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
        } else {
          gl.disable(gl.BLEND);
          gl.depthMask(true);
        }
      }
      if (binding !== bound) {
        bound = binding;
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, binding.ubo);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, binding.map);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, binding.normalMap);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, binding.mrMap);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, binding.occlusionMap);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, binding.emissiveMap);
      }
      this.setInstanceOffset(b.firstInstance);
      gl.drawElementsInstanced(lines ? gl.LINES : gl.TRIANGLES, b.range.indexCount, gl.UNSIGNED_INT, b.range.firstIndex * 4, b.count);
    }

    // overlays
    const ov = draw.overlays;
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    const drawLines = (prog, uboName, color, list) => {
      if (!list.length) return;
      use(prog);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.overlayUbo(uboName, color));
      for (const o of list) {
        this.setInstanceOffset(o.firstInstance);
        gl.drawElementsInstanced(gl.LINES, o.range.indexCount, gl.UNSIGNED_INT, o.range.firstIndex * 4, o.count);
      }
    };
    drawLines(this.lineProgram, 'wireframe', ctx.overlayColors.wireframe, ov.wireframe);
    drawLines(this.normalProgram, 'normals', ctx.overlayColors.normals, ov.normals);
    if (ov.bbox && ov.bbox.count) drawLines(this.lineProgram, 'bbox', ctx.overlayColors.bbox, [{ ...ov.bbox, range: ctx.cubeRange }]);
    if (ov.selection && ov.selection.count) {
      gl.disable(gl.DEPTH_TEST);
      drawLines(this.lineProgram, 'selection', ctx.overlayColors.selection, [{ ...ov.selection, range: ctx.cubeRange }]);
      gl.enable(gl.DEPTH_TEST);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);

    this.present(w, h);
  }

  /** Block until the GPU has finished (benchmarks). */
  async finish() {
    this.gl.finish();
    // a 1-pixel read forces completion on implementations where finish() is a no-op
    const px = new Uint8Array(4);
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteBuffer(this.frameUbo);
    for (const b of this.materialUbos.values()) {
      gl.deleteBuffer(b.ubo);
      if (b.doubleSidedUbo) gl.deleteBuffer(b.doubleSidedUbo);
    }
    for (const u of this.overlayUbos.values()) gl.deleteBuffer(u);
    for (const p of this.meshPrograms.values()) gl.deleteProgram(p);
    gl.deleteVertexArray(this.vao);
    if (!this.direct) {
      gl.deleteFramebuffer(this.fbo);
      gl.deleteRenderbuffer(this.colorRb);
      gl.deleteRenderbuffer(this.depthRb);
      gl.deleteFramebuffer(this.resolveFbo);
      gl.deleteRenderbuffer(this.resolveRb);
    }
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
