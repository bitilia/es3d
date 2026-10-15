// Flattening: scene graph -> RenderScene (a structure-of-arrays instance table).
//
// The traversal evaluates hierarchical transforms, resolves <use> references,
// expands <repeat>/<scatter>, records <lod> switches, inherits materials and
// collects lights and cameras in world space. Each drawable instance becomes
// one row: world matrix, geometry, material, selectable element and LOD switch.
//
// Animated subtrees are recorded as "dynamic segments": per frame only those
// subtrees are re-traversed and their rows overwritten in place.
//
// <repeat> and <scatter> are expanded by a WebAssembly kernel where they can
// be: the subtree below one placement is recorded once (recordTemplate) and
// the kernel runs it for every placement, with the same operations in the
// same order as the walker, so both give the same rows bit for bit.
//
// The RenderScene is renderer-agnostic; the OBJ and glTF importers produce the
// same structure, which lets the benchmark render all formats identically.

import * as mat4 from '../math/mat4.js';
import { mulberry32 } from '../math/random.js';
import { es3dCos, es3dSin } from '../math/trig.js';
import { localMatrix } from '../transform/transform.js';
import { sampleAnimation } from './animation.js';
import { colorToLinear } from '../format/colors.js';
import { instanceKernelEnabled, instancesWasm, INSTANCE_HEADER as H, INSTANCE_PARAMS as F } from '../wasm/kernels.js';

/** Instance flag bits (RenderScene.flags). */
export const FLAG_MIRRORED = 1;
export const FLAG_NO_COLLIDE = 2; // under collide="false": the camera may pass through it

export class RenderScene {
  constructor(capacity = 256) {
    this.count = 0;
    this.capacity = 0;
    /** GeometryEntry-like objects: {id, kind, lods, doubleSided, bounds, meshes, ...} */
    this.geometries = [];
    this.geomIndex = new Map();
    this.materials = [];
    this.lights = [];
    this.cameras = [];
    this.lodSwitches = [];
    this.environment = null;
    this.controls = null; // <controls> settings, or null for the viewer's defaults
    this.animation = { time: false, scroll: false }; // clocks the animations use
    this.dynamic = [];
    this.bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    this.version = 0; // bumps whenever instance rows change
    this.templates = new Map(); // repeat or scatter node -> its recorded subtree (Walker.template)
    this.alloc(capacity);
  }

  alloc(cap) {
    const grow = (Ctor, old, per) => {
      const a = new Ctor(cap * per);
      if (old) a.set(old.subarray(0, Math.min(old.length, a.length)));
      return a;
    };
    this.matrices = grow(Float32Array, this.matrices, 16);
    this.geom = grow(Uint32Array, this.geom, 1);
    this.mat = grow(Uint32Array, this.mat, 1);
    this.uid = grow(Uint32Array, this.uid, 1);
    this.lodNode = grow(Int32Array, this.lodNode, 1);
    this.lodChild = grow(Uint16Array, this.lodChild, 1);
    this.flags = grow(Uint8Array, this.flags, 1);
    this.spheres = grow(Float32Array, this.spheres, 4);
    this.capacity = cap;
  }

  geometryIndex(entry) {
    let i = this.geomIndex.get(entry);
    if (i === undefined) {
      i = this.geometries.length;
      this.geometries.push(entry);
      this.geomIndex.set(entry, i);
    }
    return i;
  }

  /** Write an instance row at index i (growing as needed). */
  setInstance(i, gi, mi, world, uid, lodNode, lodChild, flags = 0) {
    if (i >= this.capacity) this.alloc(Math.max(this.capacity * 2, i + 1));
    const m = this.matrices;
    const o = i * 16;
    for (let k = 0; k < 16; k++) m[o + k] = world[k];
    this.geom[i] = gi;
    this.mat[i] = mi;
    this.uid[i] = uid;
    this.lodNode[i] = lodNode;
    this.lodChild[i] = lodChild;
    const det = mat4.determinant3(world);
    this.flags[i] = (det < 0 ? FLAG_MIRRORED : 0) | flags;
    // world bounding sphere from the canonical bounds
    const b = this.geometries[gi].bounds;
    let cx = 0, cy = 0, cz = 0, r = 0;
    if (b) {
      const lx = (b.min[0] + b.max[0]) / 2, ly = (b.min[1] + b.max[1]) / 2, lz = (b.min[2] + b.max[2]) / 2;
      cx = world[0] * lx + world[4] * ly + world[8] * lz + world[12];
      cy = world[1] * lx + world[5] * ly + world[9] * lz + world[13];
      cz = world[2] * lx + world[6] * ly + world[10] * lz + world[14];
      const hx = (b.max[0] - b.min[0]) / 2, hy = (b.max[1] - b.min[1]) / 2, hz = (b.max[2] - b.min[2]) / 2;
      // half extents of the transformed box
      const ex = Math.abs(world[0]) * hx + Math.abs(world[4]) * hy + Math.abs(world[8]) * hz;
      const ey = Math.abs(world[1]) * hx + Math.abs(world[5]) * hy + Math.abs(world[9]) * hz;
      const ez = Math.abs(world[2]) * hx + Math.abs(world[6]) * hy + Math.abs(world[10]) * hz;
      // a culling bound, not output: plain sqrt is several times faster than Math.hypot
      r = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const bb = this.bounds;
      if (cx - ex < bb.min[0]) bb.min[0] = cx - ex;
      if (cy - ey < bb.min[1]) bb.min[1] = cy - ey;
      if (cz - ez < bb.min[2]) bb.min[2] = cz - ez;
      if (cx + ex > bb.max[0]) bb.max[0] = cx + ex;
      if (cy + ey > bb.max[1]) bb.max[1] = cy + ey;
      if (cz + ez > bb.max[2]) bb.max[2] = cz + ez;
    }
    const s = this.spheres;
    s[i * 4] = cx;
    s[i * 4 + 1] = cy;
    s[i * 4 + 2] = cz;
    s[i * 4 + 3] = r;
  }

  /** Room for n rows, grown as setInstance grows it row by row. */
  reserve(n) {
    let cap = this.capacity;
    while (cap < n) cap = Math.max(cap * 2, cap + 1);
    if (cap !== this.capacity) this.alloc(cap);
  }

  /** Release unused capacity (after a full build). */
  trim() {
    if (this.capacity > this.count * 2 + 64) this.alloc(Math.max(this.count, 1));
  }

  get empty() {
    return this.count === 0;
  }
}

const IDENTITY = mat4.createF64();

class Walker {
  constructor(scene, graph, time, progress = 0) {
    this.scene = scene;
    this.graph = graph;
    this.time = time;
    this.progress = progress;
    this.noCollide = 0; // depth of collide="false" ancestors
    this.cursor = 0;
    this.lightCursor = 0;
    this.cameraCursor = 0;
    this.switchCursor = 0;
    this.overwrite = false;
    this.stack = [];
    this.tmp = mat4.createF64();
    this.segmentDepth = 0;
  }

  mat(depth) {
    while (this.stack.length <= depth) this.stack.push(new Float64Array(16));
    return this.stack[depth];
  }

  /** Local matrix of a node at the current time. */
  localOf(node, out) {
    if (!node.anims.length) {
      if (node.local) out.set(node.local);
      else mat4.identity(out);
      return out;
    }
    const ov = {};
    for (const a of node.anims) {
      const v = sampleAnimation(a, this.time, this.progress);
      if (v) ov[a.attr] = v;
    }
    return localMatrix(node.el.values, out, ov);
  }

  walk(node, parent, material, color, sel, lodNode, lodChild, depth) {
    if (!node || !node.visible) return;
    const g = this.graph;
    const isSegmentRoot = node.anims.length > 0 && this.segmentDepth === 0 && !this.overwrite;
    let seg = null;
    if (isSegmentRoot) {
      seg = {
        node,
        parent: new Float64Array(parent),
        material,
        color,
        sel,
        lodNode,
        lodChild,
        noCollide: this.noCollide,
        start: this.cursor,
        end: 0,
        lightStart: this.lightCursor,
        cameraStart: this.cameraCursor,
        switchStart: this.switchCursor,
      };
    }
    if (node.anims.length) this.segmentDepth++;
    if (node.collide === false) this.noCollide++;

    // inherited style: an element that sets a material starts from that material's own color
    let mat = material;
    let col = color;
    if (node.material !== null) {
      mat = node.material;
      col = null;
    }
    if (node.color !== null) col = node.color;

    if (node.kind === 'light') this.emitLight(node, parent);
    else if (node.kind === 'camera') this.emitCamera(node, parent);
    else {
      let world;
      if (!node.local && !node.anims.length) {
        // identity local transform: children write only to deeper stack slots, so the parent can be shared
        world = parent;
      } else {
        world = this.mat(depth);
        // static nodes multiply by their stored matrix directly (no copy)
        const local = node.anims.length ? this.localOf(node, this.tmp) : node.local;
        mat4.multiply(world, parent, local);
      }
      switch (node.kind) {
        case 'shape':
          this.emitShape(node, world, mat, col, sel === 0 ? node.uid : sel, lodNode, lodChild, depth);
          break;
        case 'group':
          for (const c of node.children) this.walk(c, world, mat, col, sel, lodNode, lodChild, depth + 1);
          break;
        case 'use':
          if (node.target) this.walk(node.target, world, mat, col, sel === 0 ? node.uid : sel, lodNode, lodChild, depth + 1);
          for (const c of node.children) this.walk(c, world, mat, col, sel, lodNode, lodChild, depth + 1);
          break;
        case 'repeat':
          this.emitRepeat(node, world, mat, col, sel, lodNode, lodChild, depth);
          break;
        case 'scatter':
          this.emitScatter(node, world, mat, col, sel, lodNode, lodChild, depth);
          break;
        case 'lod':
          this.emitLod(node, world, mat, col, sel, lodNode, lodChild, depth);
          break;
        default:
          break;
      }
    }

    if (node.anims.length) this.segmentDepth--;
    if (node.collide === false) this.noCollide--;
    if (seg) {
      seg.end = this.cursor;
      seg.lightEnd = this.lightCursor;
      seg.cameraEnd = this.cameraCursor;
      seg.switchEnd = this.switchCursor;
      this.scene.dynamic.push(seg);
    }
  }

  emitShape(node, world, material, color, uid, lodNode, lodChild, depth) {
    if (!node.geometry) return;
    const s = this.scene;
    let w = world;
    if (node.unit) {
      w = this.mat(depth + 1);
      mat4.multiply(w, world, node.unit);
    }
    const gi = s.geometryIndex(node.geometry);
    const mi = this.graph.materials.resolve(material, color);
    s.setInstance(this.cursor++, gi, mi, w, uid, lodNode, lodChild, this.noCollide ? FLAG_NO_COLLIDE : 0);
  }

  emitRepeat(node, world, material, color, sel, lodNode, lodChild, depth) {
    if (this.expand(node, node.count, world, material, color, sel, lodNode, lodChild)) return;
    const acc = mat4.createF64();
    const tmp = mat4.createF64();
    // children use stack slots from depth + 2 on, so slot depth + 1 stays intact
    const childWorld = this.mat(depth + 1);
    for (let i = 0; i < node.count; i++) {
      mat4.multiply(childWorld, world, acc);
      for (const c of node.children) this.walk(c, childWorld, material, color, sel, lodNode, lodChild, depth + 2);
      mat4.multiply(tmp, acc, node.step);
      acc.set(tmp);
    }
  }

  emitScatter(node, world, material, color, sel, lodNode, lodChild, depth) {
    const p = node.params;
    if (this.expand(node, p.count, world, material, color, sel, lodNode, lodChild)) return;
    const rand = mulberry32(p.seed);
    const place = mat4.createF64();
    const u = new Float64Array(9);
    const lerp = (r, t) => r[0] + (r[1] - r[0]) * t;
    const nx = p.grid ? p.grid[0] : 0;
    const nz = p.grid ? p.grid[1] : 0;
    const childWorld = new Float64Array(16);
    const pos = [0, 0, 0];
    const rot = [0, 0, 0];
    const scl = [1, 1, 1];
    for (let i = 0; i < p.count; i++) {
      for (let k = 0; k < 9; k++) u[k] = rand();
      if (p.grid) {
        const ix = i % nx, iz = Math.floor(i / nx);
        pos[0] = (ix - (nx - 1) / 2) * p.spacing[0] + (u[0] - 0.5) * p.jitter * p.spacing[0];
        pos[2] = (iz - (nz - 1) / 2) * p.spacing[1] + (u[1] - 0.5) * p.jitter * p.spacing[1];
      } else if (p.radius) {
        const r = p.radius * Math.sqrt(u[0]);
        const a = u[1] * Math.PI * 2;
        pos[0] = r * es3dCos(a);
        pos[2] = r * es3dSin(a);
      } else {
        pos[0] = (u[0] - 0.5) * p.area[0];
        pos[2] = (u[1] - 0.5) * p.area[1];
      }
      if (p.randomRotation) {
        const rr = p.randomRotation.ranges;
        rot[0] = lerp(rr[0], u[2]);
        rot[1] = lerp(rr[1], u[3]);
        rot[2] = lerp(rr[2], u[4]);
      }
      if (p.randomScale) {
        const rs = p.randomScale.ranges;
        if (p.randomScale.uniform) scl[0] = scl[1] = scl[2] = lerp(rs[0], u[5]);
        else {
          scl[0] = lerp(rs[0], u[5]);
          scl[1] = lerp(rs[1], u[6]);
          scl[2] = lerp(rs[2], u[7]);
        }
      }
      mat4.compose(place, pos, rot, scl);
      mat4.multiply(childWorld, world, place);
      let m = material;
      let c = color;
      if (p.randomMaterial) {
        m = p.randomMaterial[Math.min(p.randomMaterial.length - 1, Math.floor(u[8] * p.randomMaterial.length))];
        c = null;
      }
      for (const ch of node.children) this.walk(ch, childWorld, m, c, sel, lodNode, lodChild, depth + 1);
    }
  }

  /**
   * A <repeat> or <scatter> expanded by the instance kernel
   * (wasm/simd/instances.c). False when the walker must expand it: no
   * kernel, few rows, or a subtree or parameters the kernel does not handle.
   */
  expand(node, count, world, material, color, sel, lodNode, lodChild) {
    if (!instanceKernelEnabled() || !Number.isInteger(count) || count < 1) return false;
    const t = this.template(node, sel, lodChild);
    if (!t || t.rows.length * count < KERNEL_ROWS) return false;
    const scatter = node.kind === 'scatter';
    const p = node.params;
    const h = new Int32Array(H.SIZE);
    const f = new Float64Array(F.SIZE);
    if (scatter && !scatterHeader(p, h, f)) return false;

    const s = this.scene;
    const nrows = t.rows.length;
    const nlods = t.lods.length;
    if (!t.geometries) {
      // where the walker would add them: before the first row of the first placement
      t.geometries = true;
      t.rows.forEach((r, k) => {
        const b = r.entry.bounds;
        t.table.set([s.geometryIndex(r.entry), r.uid, r.lod, r.child, r.flags, b ? 1 : 0], k * 6);
        if (b) {
          const half = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2];
          t.bounds.set([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2, ...half], k * 6);
        }
      });
    }
    h[H.KIND] = scatter ? SCATTER : REPEAT;
    h[H.NOPS] = t.ops.length;
    h[H.NROWS] = nrows;
    h[H.LODS] = nlods;
    h[H.OUTER_LOD] = lodNode;
    h[H.SLOTS] = t.slots;
    f.set(world, F.WORLD);
    if (!scatter) {
      f.set(IDENTITY, F.ACC);
      f.set(node.step, F.STEP);
    }
    const bb = s.bounds;
    f.set(bb.min, F.BOUNDS);
    f.set(bb.max, F.BOUNDS + 3);

    // the kernel asks for each material where the walker would: at the first row that needs it
    const choices = scatter && p.randomMaterial;
    const materials = new Int32Array(nrows * (choices ? choices.length : 1)).fill(-1);
    const resolveMaterial = (code) => {
      const choice = Math.floor(code / nrows);
      const r = t.rows[code - choice * nrows];
      const m = choices ? choices[choice] : material;
      const c = choices ? null : color;
      return this.graph.materials.resolve(r.material === INHERIT ? m : r.material, r.color === INHERIT ? c : r.color);
    };

    const per = Math.max(1, Math.floor(CHUNK_ROWS / nrows));
    let cursor = this.cursor;
    let sw = this.switchCursor;
    for (let first = 0; first < count; first += per) {
      h[H.FIRST] = first;
      h[H.COUNT] = Math.min(per, count - first);
      h[H.SWITCH] = sw;
      const out = instancesWasm(h, f, t, materials, resolveMaterial);
      if (!out) {
        if (first > 0) throw new Error('WebAssembly memory ran out while expanding instances');
        return false;
      }
      const n = out.mat.length;
      s.reserve(cursor + n);
      s.matrices.set(out.matrices, cursor * 16);
      s.spheres.set(out.spheres, cursor * 4);
      s.geom.set(out.geom, cursor);
      s.mat.set(out.mat, cursor);
      s.uid.set(out.uid, cursor);
      s.lodNode.set(out.lodNode, cursor);
      s.lodChild.set(out.lodChild, cursor);
      s.flags.set(out.flags, cursor);
      const v = out.switches;
      for (let k = 0; k < v.length / 4; k++) {
        const lod = t.lods[k % nlods];
        const scale = Math.cbrt(Math.abs(v[k * 4 + 3]) || 1);
        s.lodSwitches[sw + k] = {
          pos: [v[k * 4], v[k * 4 + 1], v[k * 4 + 2]],
          distances: lod.distances.map((d) => d * scale),
          parent: lod.ref >= 0 ? sw + k - (k % nlods) + lod.ref : lodNode,
          parentChild: lod.child,
        };
      }
      cursor += n;
      sw += v.length / 4;
    }
    for (let k = 0; k < 3; k++) {
      bb.min[k] = f[F.BOUNDS + k];
      bb.max[k] = f[F.BOUNDS + 3 + k];
    }
    this.cursor = cursor;
    this.switchCursor = sw;
    return true;
  }

  /** The subtree below one placement of a repeat or scatter node (recordTemplate), recorded once per scene. */
  template(node, sel, lodChild) {
    const noCollide = this.noCollide > 0;
    let e = this.scene.templates.get(node);
    if (!e || e.sel !== sel || e.lodChild !== lodChild || e.noCollide !== noCollide) {
      e = { sel, lodChild, noCollide, template: recordTemplate(node.children, sel, lodChild, noCollide) };
      this.scene.templates.set(node, e);
    }
    return e.template;
  }

  emitLod(node, world, material, color, sel, lodNode, lodChild, depth) {
    const s = this.scene;
    const sw = {
      pos: [world[12], world[13], world[14]],
      // distances are measured in the lod node's coordinate system: scale them to world units
      distances: node.params.distances.map((d) => d * Math.cbrt(Math.abs(mat4.determinant3(world)) || 1)),
      parent: lodNode,
      parentChild: lodChild,
    };
    const si = this.switchCursor++;
    s.lodSwitches[si] = sw;
    node.children.forEach((c, ci) => this.walk(c, world, material, color, sel, si, ci, depth + 1));
  }

  emitLight(node, parent) {
    const p = node.params;
    const lw = mat4.createF64();
    lw.set(parent);
    if (p.transform) mat4.multiply(lw, lw, p.transform);
    const pos = node.anims.length ? sampleAnimations(node, this, 'position', p.position) : p.position;
    const rotation = node.anims.length ? sampleAnimations(node, this, 'rotation', p.rotation || [0, 0, 0]) : p.rotation;
    const placed = mat4.createF64();
    mat4.compose(placed, pos, rotation || [0, 0, 0], [1, 1, 1]);
    mat4.multiply(placed, lw, placed);
    const P = [placed[12], placed[13], placed[14]];
    let dirLocal = p.direction;
    let dirSpace = placed;
    if (!dirLocal && p.target) {
      // target is given in the parent's coordinate system
      const t = [0, 0, 0];
      mat4.transformPoint(t, lw, p.target[0], p.target[1], p.target[2]);
      dirLocal = [t[0] - P[0], t[1] - P[1], t[2] - P[2]];
      dirSpace = IDENTITY;
    }
    if (!dirLocal) dirLocal = [0, -1, 0];
    const D = [0, 0, 0];
    mat4.transformDir(D, dirSpace, dirLocal[0], dirLocal[1], dirLocal[2]);
    const dl = Math.hypot(D[0], D[1], D[2]) || 1;
    const lin = colorToLinear(p.color);
    const light = {
      type: p.type,
      color: [lin[0] * p.intensity, lin[1] * p.intensity, lin[2] * p.intensity],
      position: P,
      direction: [D[0] / dl, D[1] / dl, D[2] / dl],
      range: p.range,
      outer: Math.cos(((p.angle / 2) * Math.PI) / 180),
      inner: Math.cos((((p.angle / 2) * (1 - p.penumbra)) * Math.PI) / 180),
      ground: colorToLinear(p.groundColor).map((v) => v * p.intensity),
      uid: node.uid,
    };
    this.scene.lights[this.lightCursor++] = light;
  }

  emitCamera(node, parent) {
    const p = node.params;
    const cw = mat4.createF64();
    cw.set(parent);
    if (p.transform) mat4.multiply(cw, cw, p.transform);
    const animated = node.anims.length > 0;
    const pos = animated ? sampleAnimations(node, this, 'position', p.position) : p.position;
    const eye = [0, 0, 0];
    mat4.transformPoint(eye, cw, pos[0], pos[1], pos[2]);
    let target;
    const up = [0, 0, 0];
    const aim = animated ? sampleAnimations(node, this, 'target', p.target) : p.target;
    if (aim) {
      target = [0, 0, 0];
      mat4.transformPoint(target, cw, aim[0], aim[1], aim[2]);
      mat4.transformDir(up, cw, p.up[0], p.up[1], p.up[2]);
    } else {
      const r = mat4.createF64();
      const rot = animated ? sampleAnimations(node, this, 'rotation', p.rotation || [0, 0, 0]) : p.rotation || [0, 0, 0];
      mat4.fromEulerDeg(r, rot[0], rot[1], rot[2]);
      mat4.multiply(r, cw, r);
      const f = [0, 0, 0];
      mat4.transformDir(f, r, 0, 0, -1);
      target = [eye[0] + f[0], eye[1] + f[1], eye[2] + f[2]];
      mat4.transformDir(up, r, p.up[0], p.up[1], p.up[2]);
    }
    this.scene.cameras[this.cameraCursor++] = {
      type: p.type,
      position: eye,
      target,
      up: up.map((v) => v / (Math.hypot(up[0], up[1], up[2]) || 1)),
      fov: animated ? sampleAnimations(node, this, 'fov', [p.fov])[0] : p.fov,
      height: p.height,
      near: p.near,
      far: p.far,
      aspect: p.aspect,
      fit: p.fit,
      name: p.name,
      uid: node.uid,
    };
  }
}

// keeps the walker's hidden class alive between scenes (see MeshBuilder.shapeKeeper);
// fractional clocks, so its fields have the representation an animated scene gives them
Walker.shapeKeeper = new Walker(null, null, 0.5, 0.5);

// --- the instance kernel's input (see Walker.expand and wasm/simd/instances.c) ---

const KERNEL_ROWS = 16; // fewer rows are cheaper to walk than to hand over
const CHUNK_ROWS = 16384; // rows per kernel call, bounding its memory
const TEMPLATE_ROWS = 4096; // larger subtrees are walked per placement
const TEMPLATE_SLOTS = 4 * TEMPLATE_ROWS;
// the enums of wasm/simd/instances.c
const OP_MUL = 0, OP_ROW = 1, OP_LOD = 2;
const REPEAT = 0, SCATTER = 1;
const GRID = 0, RADIUS = 1, AREA = 2;
const RANDOM_ROTATION = 1, RANDOM_SCALE = 2, UNIFORM_SCALE = 4;
/** The material or colour of the placement: what the element inherits, or the scatter's random material. */
const INHERIT = Symbol('inherit');

/** A scatter's placement parameters in the kernel headers; false when the walker must place it. */
function scatterHeader(p, h, f) {
  h[H.STATE] = p.seed >>> 0;
  if (p.grid) {
    const [nx, nz] = p.grid;
    if (!Number.isInteger(nx) || !Number.isInteger(nz) || nx < 1 || !p.spacing) return false;
    h[H.MODE] = GRID;
    h[H.NX] = nx;
    h[H.NZ] = nz;
    f[F.SPACING] = p.spacing[0];
    f[F.SPACING + 1] = p.spacing[1];
    f[F.JITTER] = p.jitter;
  } else if (p.radius) {
    h[H.MODE] = RADIUS;
    f[F.RADIUS] = p.radius;
  } else {
    if (!p.area) return false;
    h[H.MODE] = AREA;
    f[F.AREA] = p.area[0];
    f[F.AREA + 1] = p.area[1];
  }
  const ranges = (r, at) => {
    for (let k = 0; k < r.length; k++) f.set(r[k], at + k * 2);
  };
  if (p.randomRotation) {
    if (p.randomRotation.ranges.length !== 3) return false;
    h[H.RANDOM] |= RANDOM_ROTATION;
    ranges(p.randomRotation.ranges, F.ROTATION);
  }
  if (p.randomScale) {
    const rs = p.randomScale;
    if (rs.ranges.length < (rs.uniform ? 1 : 3)) return false;
    h[H.RANDOM] |= rs.uniform ? RANDOM_SCALE | UNIFORM_SCALE : RANDOM_SCALE;
    ranges(rs.uniform ? rs.ranges.slice(0, 1) : rs.ranges.slice(0, 3), F.SCALE);
  }
  h[H.CHOICES] = p.randomMaterial ? p.randomMaterial.length : 0;
  return true;
}

/**
 * The subtree below one placement of a <repeat> or <scatter> as a program
 * for the instance kernel: products into matrix slots (slot 0 is the
 * placement's world matrix), instance rows and lod switches, in the order
 * the walker produces them; a nested <repeat> is unrolled. Null when the
 * subtree holds what only the walker handles: animation, lights, cameras,
 * a nested <scatter>, more rows or products than TEMPLATE_ROWS and
 * TEMPLATE_SLOTS allow.
 */
function recordTemplate(children, sel, lodChild, noCollide) {
  const t = { ops: [], matrices: [], index: new Map(), slots: 1, rows: [], lods: [], geometries: false };
  for (const c of children) if (!record(t, c, 0, INHERIT, INHERIT, sel, -1, lodChild, noCollide)) return null;
  t.ops = Int32Array.from(t.ops);
  t.mats = new Float64Array(Math.max(1, t.matrices.length) * 16);
  t.matrices.forEach((m, k) => t.mats.set(m, k * 16));
  t.table = new Int32Array(t.rows.length * 6);
  t.bounds = new Float64Array(Math.max(1, t.rows.length * 6));
  return t;
}

/** slot = src * matrix */
function product(t, src, matrix) {
  let k = t.index.get(matrix);
  if (k === undefined) {
    k = t.matrices.length;
    t.matrices.push(matrix);
    t.index.set(matrix, k);
  }
  const slot = t.slots++;
  t.ops.push(OP_MUL, slot, src, k);
  return slot;
}

/** Walker.walk for a node below a placement, as template operations (lod: a template lod, or -1 for the outer one). */
function record(t, node, slot, material, color, sel, lod, child, noCollide) {
  if (!node || !node.visible) return true;
  const kind = node.kind;
  if (node.anims.length || kind === 'light' || kind === 'camera' || kind === 'scatter') return false;
  if (t.rows.length > TEMPLATE_ROWS || t.slots > TEMPLATE_SLOTS) return false;
  if (node.collide === false) noCollide = true;
  let mat = material;
  let col = color;
  if (node.material !== null) {
    mat = node.material;
    col = null;
  }
  if (node.color !== null) col = node.color;
  const world = node.local ? product(t, slot, node.local) : slot;
  const walk = (c) => record(t, c, world, mat, col, sel, lod, child, noCollide);
  switch (kind) {
    case 'shape':
      if (node.geometry) {
        const w = node.unit ? product(t, world, node.unit) : world;
        t.ops.push(OP_ROW, t.rows.length, w, 0);
        t.rows.push({ entry: node.geometry, uid: sel === 0 ? node.uid : sel, lod, child, flags: noCollide ? FLAG_NO_COLLIDE : 0, material: mat, color: col });
      }
      return true;
    case 'group':
      return node.children.every(walk);
    case 'use':
      if (node.target && !record(t, node.target, world, mat, col, sel === 0 ? node.uid : sel, lod, child, noCollide)) return false;
      return node.children.every(walk);
    case 'repeat': {
      // Walker.emitRepeat: the accumulated steps do not depend on the placement
      const acc = mat4.createF64();
      const tmp = mat4.createF64();
      for (let i = 0; i < node.count; i++) {
        if (t.slots > TEMPLATE_SLOTS) return false;
        const copy = product(t, world, new Float64Array(acc));
        if (!node.children.every((c) => record(t, c, copy, mat, col, sel, lod, child, noCollide))) return false;
        mat4.multiply(tmp, acc, node.step);
        acc.set(tmp);
      }
      return true;
    }
    case 'lod': {
      const k = t.lods.length;
      t.lods.push({ ref: lod, child, distances: node.params.distances });
      t.ops.push(OP_LOD, k, world, 0);
      return node.children.every((c, ci) => record(t, c, world, mat, col, sel, k, ci, noCollide));
    }
    default:
      return true;
  }
}

function sampleAnimations(node, walker, attr, base) {
  let v = base;
  for (const a of node.anims) {
    if (a.attr !== attr) continue;
    const s = sampleAnimation(a, walker.time, walker.progress);
    if (s) v = s;
  }
  return v;
}

/**
 * Flatten a scene graph into a RenderScene.
 * @param {object} graph result of buildSceneGraph
 * @param {{time?: number, progress?: number}} [opts] progress: scroll timeline position 0..1
 */
export function flattenScene(graph, opts = {}) {
  const scene = new RenderScene(Math.min(Math.max(64, graph.expanded || 64), 1 << 20));
  scene.environment = graph.environment;
  scene.controls = graph.controls || null;
  if (graph.animation) scene.animation = { ...graph.animation };
  if (graph.tooLarge || !graph.root) {
    scene.materials = graph.materials.list;
    return scene;
  }
  const w = new Walker(scene, graph, opts.time || 0, opts.progress || 0);
  w.walk(graph.root, IDENTITY, null, null, 0, -1, 0, 0);
  scene.count = w.cursor;
  scene.lights.length = w.lightCursor;
  scene.cameras.length = w.cameraCursor;
  scene.lodSwitches.length = w.switchCursor;
  scene.materials = graph.materials.list;
  scene.trim();
  if (!(scene.bounds.min[0] <= scene.bounds.max[0])) scene.bounds = { min: [-1, -1, -1], max: [1, 1, 1] };
  scene.version++;
  return scene;
}

/** Re-evaluate animated subtrees at time t and scroll progress, overwriting their rows. */
export function updateDynamic(scene, graph, time, progress = 0) {
  if (!scene.dynamic.length) return false;
  const w = new Walker(scene, graph, time, progress);
  w.overwrite = true;
  for (const seg of scene.dynamic) {
    w.cursor = seg.start;
    w.lightCursor = seg.lightStart;
    w.cameraCursor = seg.cameraStart;
    w.switchCursor = seg.switchStart;
    w.segmentDepth = 0;
    w.noCollide = seg.noCollide;
    w.walk(seg.node, seg.parent, seg.material, seg.color, seg.sel, seg.lodNode, seg.lodChild, 0);
  }
  scene.version++;
  return true;
}

/** Instances per geometry (for statistics). */
export function instanceHistogram(scene) {
  const counts = new Uint32Array(scene.geometries.length);
  for (let i = 0; i < scene.count; i++) counts[scene.geom[i]]++;
  return counts;
}
