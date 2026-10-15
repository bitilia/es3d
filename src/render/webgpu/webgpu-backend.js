// WebGPU rendering backend.
//
// Same architecture as the WebGL2 backend: one shared vertex buffer, one
// shared uint32 index buffer, one instance buffer, explicit bind group
// layouts and a cache of pipeline variants (shader specialised per material
// features and light setup, cull mode, winding, blending, topology). Each
// batch is one drawIndexed call using firstInstance.

import { meshShader, LINE_WGSL } from '../shaders/wgsl.js';
import { FRAME_BYTES, MATERIAL_FLOATS, packMaterial, packOverlay, lightTypes } from '../lighting.js';
import { VERTEX_BYTES } from '../geometry-pool.js';
import { buildMips } from '../textures.js';

const SAMPLE_COUNT = 4;

const VERTEX_LAYOUTS = [
  {
    arrayStride: VERTEX_BYTES,
    stepMode: 'vertex',
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x2' },
    ],
  },
  {
    arrayStride: 64,
    stepMode: 'instance',
    attributes: [
      { shaderLocation: 3, offset: 0, format: 'float32x4' },
      { shaderLocation: 4, offset: 16, format: 'float32x4' },
      { shaderLocation: 5, offset: 32, format: 'float32x4' },
      { shaderLocation: 6, offset: 48, format: 'float32x4' },
    ],
  },
];

const pow2 = (n, min) => {
  let c = min;
  while (c < n) c *= 2;
  return c;
};

export class WebGPUBackend {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{present?: 'canvas'|'readback'}} [opts] 'readback' renders offscreen and
   *   copies pixels into a 2D canvas (headless testing, screenshots without a swap chain)
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.present = opts.present || 'canvas';
    this.kind = 'webgpu';
    this.zeroToOne = true;
    this.pipelines = new Map();
    this.meshModules = new Map();
    this.materialBindings = new Map();
    this.overlayBindings = new Map();
    this.poolGeneration = -1;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.instanceBuffer = null;
    this.gpuBytes = 0;
    this.lost = false;
    this.info = '';
    this.errors = [];
  }

  async init() {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    this.adapter = adapter;
    const info = adapter.info || {};
    this.info = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'WebGPU adapter';
    const device = await adapter.requestDevice();
    this.device = device;
    device.lost.then((i) => {
      this.lost = true;
      this.errors.push(`WebGPU device lost: ${i.message}`);
    });
    device.onuncapturederror = (e) => {
      this.errors.push(e.error && e.error.message ? e.error.message : String(e));
    };
    if (this.present === 'readback') {
      this.format = 'rgba8unorm';
      this.ctx2d = this.canvas.getContext('2d');
      if (!this.ctx2d) throw new Error('Cannot create a 2D context for WebGPU readback presentation.');
    } else {
      const ctx = this.canvas.getContext('webgpu');
      if (!ctx) throw new Error('Cannot create a WebGPU canvas context.');
      this.context = ctx;
      this.format = navigator.gpu.getPreferredCanvasFormat();
      // colours are written already encoded as sRGB and tone mapped to 0..1: pin the
      // colour space and standard range so HDR and wide-gamut screens show them unchanged
      ctx.configure({ device, format: this.format, alphaMode: 'opaque', colorSpace: 'srgb', toneMapping: { mode: 'standard' } });
    }

    this.frameLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.materialLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.materialLayout] });
    device.pushErrorScope('validation');
    this.lineModule = device.createShaderModule({ code: LINE_WGSL, label: 'es3d lines' });
    for (const [name, mod] of [['mesh', this.meshModule(0, '0')], ['lines', this.lineModule]]) {
      const info2 = await mod.getCompilationInfo();
      const errs = info2.messages.filter((m) => m.type === 'error');
      if (errs.length) throw new Error(`WGSL ${name} shader error: ${errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    }
    const err = await device.popErrorScope();
    if (err) throw new Error(`WebGPU initialisation error: ${err.message}`);

    this.frameBuffer = device.createBuffer({ size: FRAME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.frameBindGroup = device.createBindGroup({ layout: this.frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }] });
    this.sampler = device.createSampler({
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 8,
    });
    this.whiteTex = this.createTexture({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }, true);
    this.flatNormalTex = this.createTexture({ width: 1, height: 1, data: new Uint8Array([128, 128, 255, 255]) }, false);
    this.matData = new Float32Array(MATERIAL_FLOATS);
  }

  createTexture(px, srgb) {
    const levels = px.width > 1 || px.height > 1 ? buildMips(px) : [px];
    const tex = this.device.createTexture({
      size: [px.width, px.height],
      format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
      mipLevelCount: levels.length,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    levels.forEach((lv, i) => {
      const data = lv.data instanceof Uint8Array ? lv.data : new Uint8Array(lv.data.buffer, lv.data.byteOffset, lv.data.byteLength);
      this.device.queue.writeTexture({ texture: tex, mipLevel: i }, data, { bytesPerRow: lv.width * 4, rowsPerImage: lv.height }, [lv.width, lv.height]);
      this.gpuBytes += lv.width * lv.height * 4;
    });
    return { texture: tex, view: tex.createView() };
  }

  destroyTexture(t) {
    t.texture.destroy();
  }

  /** The shader module for a material's feature flags under the frame's lights, compiled on first use. */
  meshModule(flags, lights) {
    const key = `${flags}|${lights}`;
    let m = this.meshModules.get(key);
    if (!m) {
      m = this.device.createShaderModule({ code: meshShader(flags, lights), label: `es3d mesh ${key}` });
      this.meshModules.set(key, m);
    }
    return m;
  }

  pipeline(kind, { cull = 'back', frontFace = 'ccw', blend = false, depthWrite = true, depthCompare = 'less-equal', flags = 0, lights = '' } = {}) {
    const isMesh = kind === 'mesh';
    const key = `${kind}|${cull}|${frontFace}|${blend}|${depthWrite}|${depthCompare}${isMesh ? `|${flags}|${lights}` : ''}`;
    let p = this.pipelines.get(key);
    if (p) return p;
    const module = isMesh ? this.meshModule(flags, lights) : this.lineModule;
    const entry = isMesh ? 'vs_main' : kind === 'normals' ? 'vs_normals' : 'vs_line';
    p = this.device.createRenderPipeline({
      label: key,
      layout: this.pipelineLayout,
      vertex: { module, entryPoint: entry, buffers: VERTEX_LAYOUTS },
      fragment: {
        module,
        entryPoint: isMesh ? 'fs_main' : 'fs_line',
        targets: [
          {
            format: this.format,
            blend: blend
              ? {
                  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                }
              : undefined,
          },
        ],
      },
      primitive: { topology: isMesh ? 'triangle-list' : 'line-list', cullMode: isMesh ? cull : 'none', frontFace },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: depthWrite, depthCompare },
      multisample: { count: SAMPLE_COUNT },
    });
    this.pipelines.set(key, p);
    return p;
  }

  ensureTargets() {
    const w = this.canvas.width, h = this.canvas.height;
    if (this.targetW === w && this.targetH === h && this.msaa) return;
    if (this.msaa) this.msaa.destroy();
    if (this.depth) this.depth.destroy();
    this.msaa = this.device.createTexture({ size: [w, h], sampleCount: SAMPLE_COUNT, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depth = this.device.createTexture({ size: [w, h], sampleCount: SAMPLE_COUNT, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.msaaView = this.msaa.createView();
    this.depthView = this.depth.createView();
    if (this.present === 'readback') {
      if (this.offscreen) this.offscreen.destroy();
      if (this.readBuffer && !this.readPending) this.readBuffer.destroy();
      this.offscreen = this.device.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      this.offscreenView = this.offscreen.createView();
      this.readStride = Math.ceil((w * 4) / 256) * 256;
      this.readBuffer = this.device.createBuffer({ size: this.readStride * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    this.targetW = w;
    this.targetH = h;
  }

  /** Copy the offscreen frame into the 2D canvas (readback presentation). */
  readback(encoder) {
    if (this.readPending) return false;
    const w = this.targetW, h = this.targetH;
    encoder.copyTextureToBuffer({ texture: this.offscreen }, { buffer: this.readBuffer, bytesPerRow: this.readStride }, [w, h]);
    return true;
  }

  startReadback() {
    const buf = this.readBuffer;
    const w = this.targetW, h = this.targetH, stride = this.readStride;
    this.readPending = buf.mapAsync(GPUMapMode.READ).then(() => {
      const raw = new Uint8Array(buf.getMappedRange());
      const px = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) px.set(raw.subarray(y * stride, y * stride + w * 4), y * w * 4);
      buf.unmap();
      this.ctx2d.putImageData(new ImageData(px, w, h), 0, 0);
      this.readPending = null;
      // A frame drawn while this copy was in flight was not copied. A page that
      // draws only on change may draw nothing more, so show that frame now.
      if (!this.lastFrameCopied && this.offscreen && !this.lost) {
        const encoder = this.device.createCommandEncoder();
        this.readback(encoder);
        this.device.queue.submit([encoder.finish()]);
        this.lastFrameCopied = true;
        this.startReadback();
      }
    });
  }

  syncPool(pool) {
    const d = this.device;
    const vBytes = pool.vertices.byteLength;
    const iBytes = pool.indices.byteLength;
    let uploaded = 0;
    if (pool.generation !== this.poolGeneration || !this.vertexBuffer || this.vertexBuffer.size < vBytes || this.indexBuffer.size < iBytes) {
      if (this.vertexBuffer) this.vertexBuffer.destroy();
      if (this.indexBuffer) this.indexBuffer.destroy();
      this.vertexBuffer = d.createBuffer({ size: pow2(vBytes, 1 << 16), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.indexBuffer = d.createBuffer({ size: pow2(iBytes, 1 << 16), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      this.poolGeneration = pool.generation;
      pool.uploadedVertices = 0;
      pool.uploadedIndices = 0;
    }
    const p = pool.pending();
    if (p.vertexEnd > p.vertexStart) {
      const src = pool.vertices.subarray(p.vertexStart * 8, p.vertexEnd * 8);
      d.queue.writeBuffer(this.vertexBuffer, p.vertexStart * VERTEX_BYTES, src.buffer, src.byteOffset, src.byteLength);
      uploaded += src.byteLength;
    }
    if (p.indexEnd > p.indexStart) {
      const src = pool.indices.subarray(p.indexStart, p.indexEnd);
      d.queue.writeBuffer(this.indexBuffer, p.indexStart * 4, src.buffer, src.byteOffset, src.byteLength);
      uploaded += src.byteLength;
    }
    pool.markUploaded();
    return uploaded;
  }

  uploadInstances(data, count) {
    const bytes = Math.max(64, count * 64);
    if (!this.instanceBuffer || this.instanceBuffer.size < bytes) {
      if (this.instanceBuffer) this.instanceBuffer.destroy();
      this.instanceBuffer = this.device.createBuffer({ size: pow2(bytes, 64 * 256), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (count) this.device.queue.writeBuffer(this.instanceBuffer, 0, data.buffer, data.byteOffset, count * 64);
    return count * 64;
  }

  readyTexture(entry, srgb) {
    if (entry && entry.status === 'ready' && !entry.gpu) entry.gpu = this.createTexture(entry.pixels, srgb);
    return entry && entry.gpu ? entry.gpu : null;
  }

  materialEntries(buffer, map, normal, mr, occlusion, emissive) {
    return [
      { binding: 0, resource: { buffer } },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: map.view },
      { binding: 3, resource: normal.view },
      { binding: 4, resource: mr.view },
      { binding: 5, resource: occlusion.view },
      { binding: 6, resource: emissive.view },
    ];
  }

  materialBinding(material, textures, doubleSided) {
    const id = doubleSided ? 'ds' : 'ss';
    let rec = this.materialBindings.get(material);
    if (!rec) {
      rec = {};
      this.materialBindings.set(material, rec);
    }
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
    let b = rec[id];
    if (!b || b.key !== key) {
      if (b) b.buffer.destroy();
      packMaterial(this.matData, material, { hasMap, hasNormalMap, hasMrMap, hasOcclusionMap, hasEmissiveMap, doubleSided: doubleSided || material.doubleSided });
      const buffer = this.device.createBuffer({ size: MATERIAL_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buffer, 0, this.matData);
      const bindGroup = this.device.createBindGroup({
        layout: this.materialLayout,
        entries: this.materialEntries(buffer, mapGpu || this.whiteTex, nrmGpu || this.flatNormalTex, mrGpu || this.whiteTex, occGpu || this.whiteTex, emGpu || this.whiteTex),
      });
      b = rec[id] = { key, buffer, bindGroup, flags: this.matData[10] };
    }
    return b;
  }

  overlayBinding(name, rgba) {
    let b = this.overlayBindings.get(name);
    if (b) return b;
    packOverlay(this.matData, rgba);
    const buffer = this.device.createBuffer({ size: MATERIAL_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, this.matData);
    b = this.device.createBindGroup({
      layout: this.materialLayout,
      entries: this.materialEntries(buffer, this.whiteTex, this.flatNormalTex, this.whiteTex, this.whiteTex, this.whiteTex),
    });
    this.overlayBindings.set(name, b);
    return b;
  }

  releaseMaterials(keep) {
    for (const [m, rec] of this.materialBindings) {
      if (keep.has(m)) continue;
      for (const b of Object.values(rec)) b.buffer.destroy();
      this.materialBindings.delete(m);
    }
  }

  /** What this backend renders with (Renderer.caps). */
  get caps() {
    return {
      msaaSamples: SAMPLE_COUNT,
      anisotropy: 8,
      maxTextureSize: this.device ? this.device.limits.maxTextureDimension2D : 0,
      colorSpace: 'srgb',
    };
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  render(draw, frameData, ctx) {
    if (this.lost) return;
    const d = this.device;
    this.ensureTargets();
    d.queue.writeBuffer(this.frameBuffer, 0, frameData.buffer, frameData.byteOffset, frameData.byteLength);
    this.uploadInstances(draw.instanceData, draw.instanceCount);
    const encoder = d.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.msaaView,
          resolveTarget: this.present === 'readback' ? this.offscreenView : this.context.getCurrentTexture().createView(),
          clearValue: { r: ctx.background[0], g: ctx.background[1], b: ctx.background[2], a: 1 },
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
      depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setBindGroup(0, this.frameBindGroup);
    if (this.vertexBuffer) {
      pass.setVertexBuffer(0, this.vertexBuffer);
      pass.setIndexBuffer(this.indexBuffer, 'uint32');
    }
    pass.setVertexBuffer(1, this.instanceBuffer);
    let currentPipeline = null;
    const setPipe = (p) => {
      if (p !== currentPipeline) {
        pass.setPipeline(p);
        currentPipeline = p;
      }
    };
    if (this.vertexBuffer) {
      let boundGroup = null;
      const lights = lightTypes(frameData);
      for (const b of draw.batches) {
        const lines = b.kind === 'lines';
        const binding = this.materialBinding(b.material, ctx.textures, b.doubleSided && !b.material.doubleSided);
        const pipe = lines
          ? this.pipeline('lines', { blend: b.transparent, depthWrite: !b.transparent })
          : this.pipeline('mesh', {
              cull: b.doubleSided ? 'none' : 'back',
              frontFace: b.mirrored ? 'cw' : 'ccw',
              blend: b.transparent,
              depthWrite: !b.transparent,
              flags: binding.flags,
              lights,
            });
        setPipe(pipe);
        const group = binding.bindGroup;
        if (group !== boundGroup) {
          pass.setBindGroup(1, group);
          boundGroup = group;
        }
        pass.drawIndexed(b.range.indexCount, b.count, b.range.firstIndex, 0, b.firstInstance);
      }
      const ov = draw.overlays;
      const drawLines = (kind, name, color, list, depthCompare = 'less-equal') => {
        if (!list.length) return;
        setPipe(this.pipeline(kind, { blend: true, depthWrite: false, depthCompare }));
        pass.setBindGroup(1, this.overlayBinding(name, color));
        for (const o of list) pass.drawIndexed(o.range.indexCount, o.count, o.range.firstIndex, 0, o.firstInstance);
      };
      drawLines('lines', 'wireframe', ctx.overlayColors.wireframe, ov.wireframe);
      drawLines('normals', 'normals', ctx.overlayColors.normals, ov.normals);
      if (ov.bbox && ov.bbox.count) drawLines('lines', 'bbox', ctx.overlayColors.bbox, [{ ...ov.bbox, range: ctx.cubeRange }]);
      if (ov.selection && ov.selection.count) drawLines('lines', 'selection', ctx.overlayColors.selection, [{ ...ov.selection, range: ctx.cubeRange }], 'always');
    }
    pass.end();
    const copied = this.present === 'readback' && this.readback(encoder);
    d.queue.submit([encoder.finish()]);
    if (copied) this.startReadback();
    this.lastFrameCopied = copied;
  }

  async finish() {
    await this.device.queue.onSubmittedWorkDone();
    if (this.readPending) await this.readPending;
    if (this.present === 'readback' && !this.lastFrameCopied && this.offscreen) {
      // the latest frame was rendered while an older readback was in flight
      const encoder = this.device.createCommandEncoder();
      this.readback(encoder);
      this.device.queue.submit([encoder.finish()]);
      this.startReadback();
      await this.readPending;
      this.lastFrameCopied = true;
    }
  }

  dispose() {
    if (!this.device) return;
    for (const b of [this.vertexBuffer, this.indexBuffer, this.instanceBuffer, this.frameBuffer]) if (b) b.destroy();
    for (const rec of this.materialBindings.values()) for (const b of Object.values(rec)) b.buffer.destroy();
    if (this.msaa) this.msaa.destroy();
    if (this.depth) this.depth.destroy();
    this.device.destroy();
  }
}
