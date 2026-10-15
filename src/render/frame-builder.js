// Backend-independent per-frame work: explicit LOD switches, frustum culling,
// automatic level-of-detail selection, batching and GPU instance data.
//
// Visible instances are grouped by (geometry, LOD level, material, mirrored)
// and every group becomes ONE instanced draw call. Instance matrices are
// written contiguously per batch into a single Float32Array, which the
// backend uploads with one buffer write per frame.

import { colorToLinear } from '../format/colors.js';

// A level is used only while its surface stays within this many pixels of the
// true shape. Each geometry carries that distance in canonical units
// (lodDeviation); the frame scales it by the instance and the projection.
export const SURFACE_ERROR_PX = 1;

// Math.hypot is variadic. V8 builds an argument list for every call, about
// 100 bytes, which at 1e5 instances is ~10 MB of garbage per frame. Scene
// distances are nowhere near the overflow range hypot exists to protect, and
// the level-of-detail use below already clamps tiny distances.
function length3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

/**
 * The level to draw while `lod` is not generated yet: the nearest coarser
 * level that exists, else the nearest finer one, else the coarsest level
 * (the cheapest to generate now).
 */
function standIn(meshes, lod) {
  for (let l = lod + 1; l < meshes.length; l++) if (meshes[l]) return l;
  for (let l = lod - 1; l >= 0; l--) if (meshes[l]) return l;
  return meshes.length - 1;
}

/** Longest column of an instance matrix: a conservative world scale. */
function axisScale(M, i) {
  const o = i * 16;
  let m = 0;
  for (let c = 0; c < 3; c++) {
    const s = length3(M[o + c * 4], M[o + c * 4 + 1], M[o + c * 4 + 2]);
    if (s > m) m = s;
  }
  return m || 1;
}

/**
 * Coarsest level whose chordal error projects to at most one pixel.
 * `deviation[level]` is the error in canonical units. `pixelsPerUnit` is the
 * projected size of one canonical unit after the instance scale is applied
 * separately via `scale`. `bias` above 1 tightens the budget.
 */
export function selectLod(deviation, lods, scale, pixelsPerUnit, bias) {
  if (!(lods > 1) || !deviation) return 0;
  const budget = SURFACE_ERROR_PX / (bias > 0 ? bias : 1);
  const k = scale * pixelsPerUnit;
  let lod = 0;
  const last = Math.min(lods, deviation.length) - 1;
  for (let level = last; level >= 1; level--) {
    if (deviation[level] * k <= budget) {
      lod = level;
      break;
    }
  }
  return lod;
}

function planesFrom(m) {
  // rows of the column-major view-projection matrix
  const r = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = r(0), r1 = r(1), r3 = r(3), r2 = r(2);
  const planes = [
    [r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]],
    [r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]],
    [r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]],
    [r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]],
    [r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]],
  ];
  for (const p of planes) {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    p[0] /= l;
    p[1] /= l;
    p[2] /= l;
    p[3] /= l;
  }
  return planes;
}

export class FrameBuilder {
  constructor() {
    this.instanceData = new Float32Array(16 * 1024);
    this.keys = new Int32Array(1024);
    this.lods = new Uint8Array(1024);
    this.last = null;
    this.lastSignature = '';
  }

  ensure(n) {
    if (this.instanceData.length < n * 16) {
      let cap = this.instanceData.length / 16;
      while (cap < n) cap *= 2;
      this.instanceData = new Float32Array(cap * 16);
    }
    if (this.keys.length < n) {
      let cap = this.keys.length;
      while (cap < n) cap *= 2;
      this.keys = new Int32Array(cap);
      this.lods = new Uint8Array(cap);
    }
  }

  /** Explicit <lod> switch states for the camera position. */
  lodStates(scene, camPos, dist) {
    const sw = scene.lodSwitches;
    const active = new Int32Array(sw.length);
    const visible = new Uint8Array(sw.length);
    for (let s = 0; s < sw.length; s++) {
      const w = sw[s];
      const d = dist(w.pos);
      let c = 0;
      while (c < w.distances.length && d >= w.distances[c]) c++;
      active[s] = c;
      visible[s] = w.parent < 0 ? 1 : visible[w.parent] && active[w.parent] === w.parentChild ? 1 : 0;
    }
    return { active, visible };
  }

  /**
   * @param {object} p
   * @param {import('../scene/flatten.js').RenderScene} p.scene
   * @param {import('./camera.js').Camera} p.camera (matrices already updated)
   * @param {number} p.viewportHeight
   * @param {(entry:object, lod:number)=>object} p.meshOf
   * @param {import('./geometry-pool.js').GeometryPool} p.pool
   * @param {object} p.options {autoLod, fixedLod, culling, lodBias, bbox, wireframe, normals, selection:Set<number>,
   *   tessellationBudget: ms of mesh generation per frame before levels are drawn coarser and refined later}
   */
  build(p) {
    const { scene, camera, pool, meshOf, options } = p;
    const n = scene.count;
    // reserve instance rows for: batches (<= n), bounding boxes (<= n), selection boxes
    let selCount = 0;
    if (options.selection && options.selection.size) {
      for (let i = 0; i < n; i++) if (options.selection.has(scene.uid[i])) selCount++;
    }
    this.ensure(n + (options.bbox ? n : 0) + selCount + 64);
    const camPos = camera.position;
    const dist = (c) => Math.hypot(c[0] - camPos[0], c[1] - camPos[1], c[2] - camPos[2]);
    const sw = this.lodStates(scene, camPos, dist);
    const planes = options.culling === false ? null : planesFrom(camera.viewProj);
    const S = scene.spheres;
    const keys = this.keys;
    const lods = this.lods;
    const batchMap = new Map();
    const batches = [];
    const nMat = Math.max(1, scene.materials.length);
    const lodHist = [0, 0, 0, 0];
    let visibleCount = 0;
    let culled = 0;
    const vh = p.viewportHeight;
    const bias = options.lodBias || 1;
    const fixedLod = options.autoLod === false ? options.fixedLod || 0 : -1;
    // pixels per world unit at distance 1 (perspective) or everywhere (orthographic)
    const ppuFactor = camera.pixelsPerUnit(1, vh);

    for (let i = 0; i < n; i++) {
      keys[i] = -1;
      const ln = scene.lodNode[i];
      if (ln >= 0 && !(sw.visible[ln] && sw.active[ln] === scene.lodChild[i])) continue;
      const cx = S[i * 4], cy = S[i * 4 + 1], cz = S[i * 4 + 2], r = S[i * 4 + 3];
      if (planes) {
        let out = false;
        for (let k = 0; k < 5; k++) {
          const pl = planes[k];
          if (pl[0] * cx + pl[1] * cy + pl[2] * cz + pl[3] < -r) {
            out = true;
            break;
          }
        }
        if (out) {
          culled++;
          continue;
        }
      }
      const gi = scene.geom[i];
      const entry = scene.geometries[gi];
      let lod = 0;
      if (entry.lods > 1) {
        if (fixedLod >= 0) lod = Math.min(fixedLod, entry.lods - 1);
        else {
          const dx = cx - camPos[0], dy = cy - camPos[1], dz = cz - camPos[2];
          const d = length3(dx, dy, dz);
          const ppu = camera.type === 'orthographic' ? ppuFactor : ppuFactor / Math.max(d, 1e-6);
          lod = selectLod(entry.lodDeviation, entry.lods, axisScale(scene.matrices, i), ppu, bias);
        }
      }
      lods[i] = lod;
      lodHist[lod]++;
      const mirrored = scene.flags[i] & 1;
      const mi = scene.mat[i];
      const key = ((gi * 4 + lod) * nMat + mi) * 2 + mirrored;
      let b = batchMap.get(key);
      if (b === undefined) {
        b = batches.length;
        batchMap.set(key, b);
        const material = scene.materials[mi];
        batches.push({ gi, entry, lod, mi, material, mirrored: !!mirrored, count: 0, firstInstance: 0, depth: 0, instances: null });
      }
      batches[b].count++;
      keys[i] = b;
      visibleCount++;
    }

    // resolve meshes / pool ranges. Once this frame has spent its tessellation
    // budget, a level that is not generated yet is drawn with a stand-in and
    // refined on a later frame: the first frame comes at once, full detail
    // follows within a few frames (each frame generates at least one).
    const budget = options.tessellationBudget;
    const progressive = budget >= 0 && budget < Infinity;
    const start = progressive ? performance.now() : 0;
    let generated = 0;
    let refining = 0;
    let triangles = 0;
    for (const b of batches) {
      let lod = b.lod;
      const have = b.entry.meshes;
      if (progressive && have && !have[lod]) {
        if (generated && performance.now() - start >= budget) {
          lod = standIn(have, lod);
          refining++;
        } else generated++;
      }
      const mesh = meshOf(b.entry, lod);
      b.mesh = mesh;
      b.kind = mesh.kind;
      b.range = pool.meshRange(mesh);
      b.doubleSided = !!(b.entry.doubleSided || b.material.doubleSided);
      b.transparent = b.material.transparent;
      if (b.kind === 'triangles') triangles += (b.range.indexCount / 3) * b.count;
    }

    // order: opaque by pipeline then material, transparent back to front
    let offset = 0;
    const order = batches.slice().sort((a, b) => {
      if (a.transparent !== b.transparent) return a.transparent ? 1 : -1;
      if (a.kind !== b.kind) return a.kind === 'triangles' ? -1 : 1;
      if (a.doubleSided !== b.doubleSided) return a.doubleSided ? 1 : -1;
      if (a.mirrored !== b.mirrored) return a.mirrored ? 1 : -1;
      return a.mi - b.mi;
    });
    for (const b of order) {
      b.firstInstance = offset;
      offset += b.count;
      b.cursor = b.firstInstance;
    }
    const data = this.instanceData;
    const M = scene.matrices;
    const transparentInstances = [];
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      if (k < 0) continue;
      const b = batches[k];
      if (b.transparent) {
        transparentInstances.push(i);
        continue;
      }
      const o = b.cursor++ * 16;
      for (let j = 0; j < 16; j++) data[o + j] = M[i * 16 + j];
    }
    if (transparentInstances.length) {
      const depthOf = (i) => -length3(S[i * 4] - camPos[0], S[i * 4 + 1] - camPos[1], S[i * 4 + 2] - camPos[2]);
      transparentInstances.sort((a, b) => depthOf(a) - depthOf(b));
      for (const i of transparentInstances) {
        const b = batches[keys[i]];
        const o = b.cursor++ * 16;
        for (let j = 0; j < 16; j++) data[o + j] = M[i * 16 + j];
        b.depth = Math.max(b.depth, -depthOf(i));
      }
      // farthest transparent batches first
      const opaque = order.filter((b) => !b.transparent);
      const transp = order.filter((b) => b.transparent).sort((a, b) => b.depth - a.depth);
      order.length = 0;
      order.push(...opaque, ...transp);
    }

    // overlays
    const overlays = { wireframe: [], normals: [], bbox: null, selection: null };
    if (options.wireframe || options.normals) {
      for (const b of order) {
        if (b.kind !== 'triangles') continue;
        if (options.wireframe) overlays.wireframe.push({ range: pool.edgeRange(b.mesh), firstInstance: b.firstInstance, count: b.count, mirrored: b.mirrored });
        if (options.normals) overlays.normals.push({ range: pool.normalRange(b.mesh), firstInstance: b.firstInstance, count: b.count });
      }
    }
    const boxMatrix = (i, o) => {
      const e = scene.geometries[scene.geom[i]];
      const bb = e.bounds;
      const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2, cz = (bb.min[2] + bb.max[2]) / 2;
      const sx = Math.max(bb.max[0] - bb.min[0], 1e-4), sy = Math.max(bb.max[1] - bb.min[1], 1e-4), sz = Math.max(bb.max[2] - bb.min[2], 1e-4);
      const m = M.subarray(i * 16, i * 16 + 16);
      // world * T(c) * S(s)
      for (let k = 0; k < 3; k++) {
        data[o + k] = m[k] * sx;
        data[o + 4 + k] = m[4 + k] * sy;
        data[o + 8 + k] = m[8 + k] * sz;
        data[o + 12 + k] = m[k] * cx + m[4 + k] * cy + m[8 + k] * cz + m[12 + k];
      }
      data[o + 3] = 0;
      data[o + 7] = 0;
      data[o + 11] = 0;
      data[o + 15] = 1;
    };
    if (options.bbox) {
      const first = offset;
      for (let i = 0; i < n; i++) {
        if (keys[i] < 0) continue;
        boxMatrix(i, offset * 16);
        offset++;
      }
      overlays.bbox = { firstInstance: first, count: offset - first };
    }
    if (selCount) {
      const first = offset;
      const sel = options.selection;
      for (let i = 0; i < n; i++) {
        if (!sel.has(scene.uid[i])) continue;
        // hidden level-of-detail alternatives are not highlighted
        if (keys[i] < 0 && scene.lodNode[i] >= 0) continue;
        boxMatrix(i, offset * 16);
        offset++;
      }
      overlays.selection = { firstInstance: first, count: offset - first };
    }

    const result = {
      batches: order,
      overlays,
      instanceData: this.instanceData,
      instanceCount: offset,
      lights: scene.lights,
      environment: scene.environment,
      stats: {
        instances: n,
        visible: visibleCount,
        culled,
        batches: order.length,
        drawCalls: order.length + overlays.wireframe.length + overlays.normals.length + (overlays.bbox ? 1 : 0) + (overlays.selection ? 1 : 0),
        triangles,
        lodHistogram: lodHist,
        refining,
      },
    };
    this.last = result;
    return result;
  }
}

/** Environment defaults in linear space for the shaders. */
export function environmentUniforms(env) {
  const sky = colorToLinear(env.sky);
  const ground = colorToLinear(env.ground);
  return { sky, ground, intensity: env.intensity, exposure: env.exposure, background: env.background };
}
