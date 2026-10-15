// Scene graph construction: validated AST -> SceneNode tree.
//
// Every renderable element becomes one SceneNode with its static local matrix
// pre-computed. Nodes are memoised per element, so a definition referenced by
// a thousand <use> elements exists once in memory: instancing is resolved by
// traversal, not by copying subtrees. Materials are collected into a table,
// geometry descriptors are interned in the geometry cache (lazy tessellation).

import * as mat4 from '../math/mat4.js';
import { valueOf, elementSpec } from '../format/schema.js';
import { localMatrix } from '../transform/transform.js';
import { describeShape, hasGeometry } from '../geometry/registry.js';
import { MaterialTable, paramsFromElement } from '../material/materials.js';
import { animationFromElement } from './animation.js';
import { MAX_INSTANCES, MAX_DEPTH } from '../format/limits.js';

export { MAX_INSTANCES, MAX_DEPTH };

export class SceneNode {
  constructor(el, kind) {
    this.el = el;
    this.uid = el.uid;
    this.kind = kind;
    this.local = null; // static local matrix (Float64Array) or null for identity
    this.visible = true;
    this.material = null;
    this.color = null;
    this.anims = [];
    this.children = [];
    // shape
    this.geometry = null;
    this.unit = null;
    // use
    this.target = null;
    // repeat
    this.count = 0;
    this.step = null;
    // scatter / lod / light / camera parameters
    this.params = null;
  }

  get animated() {
    return this.anims.length > 0;
  }
}

const ENV_DEFAULTS = {
  background: [0.09, 0.1, 0.12, 1],
  sky: [0.8, 0.86, 0.95, 1],
  ground: [0.25, 0.22, 0.2, 1],
  intensity: 0.5,
  exposure: 1,
};

function isIdentity(m) {
  return mat4.isIdentity(m, 1e-15);
}

/**
 * @param {import('../format/ast.js').Document} doc validated document
 * @param {import('../geometry/geometry-cache.js').GeometryCache} cache
 */
export function buildSceneGraph(doc, cache, opts = {}) {
  const maxInstances = opts.maxInstances || MAX_INSTANCES;
  const diagnostics = [];
  const materials = new MaterialTable();
  const memo = new Map();
  let environment = { ...ENV_DEFAULTS, explicit: false };
  let envFound = false;
  let controls = null;
  // which clocks drive the document: viewers skip per-frame work for the ones it does not use
  const animation = { time: false, scroll: false };
  const stats = { nodes: 0, shapes: 0, uses: 0, defs: 0, lights: 0, cameras: 0, materials: 0 };

  const report = (el, severity, code, message, phase = 'reference') => {
    diagnostics.push({ severity, code, message, element: el, phase });
  };

  // materials and environment are document-wide
  const collect = (el) => {
    if (el.unknown) return;
    if (el.name === 'material' && el.values && el.values.id !== undefined) {
      materials.define(el.values.id, paramsFromElement(el));
      stats.materials++;
    }
    if (el.name === 'environment' && !envFound) {
      envFound = true;
      environment = {
        background: valueOf(el, 'background'),
        sky: valueOf(el, 'sky'),
        ground: valueOf(el, 'ground'),
        intensity: valueOf(el, 'intensity'),
        exposure: valueOf(el, 'exposure'),
        explicit: true,
        uid: el.uid,
      };
    }
    if (el.name === 'controls' && !controls) controls = controlsFromElement(el);
    if (el.name === 'defs') stats.defs += el.children.filter((c) => c.type === 'element').length;
    for (const c of el.children) if (c.type === 'element') collect(c);
  };
  collect(doc.root);

  cache.beginBuild();

  const nodeFor = (el, depth = 0) => {
    if (memo.has(el)) return memo.get(el);
    if (depth > MAX_DEPTH) {
      report(el, 'error', 'E_TOO_DEEP', `Nesting is deeper than ${MAX_DEPTH}. Flatten the tree or shorten the use chain.`);
      memo.set(el, null);
      return null;
    }
    if (el.unknown || !elementSpec(el.name)) {
      memo.set(el, null);
      return null;
    }
    const name = el.name;
    let kind;
    if (name === 'es3d' || name === 'v3d' || name === 'scene' || name === 'group') kind = 'group';
    else if (name === 'use') kind = 'use';
    else if (name === 'repeat') kind = 'repeat';
    else if (name === 'scatter') kind = 'scatter';
    else if (name === 'lod') kind = 'lod';
    else if (name === 'light') kind = 'light';
    else if (name === 'camera') kind = 'camera';
    else if (hasGeometry(name)) kind = 'shape';
    else {
      memo.set(el, null);
      return null;
    }
    const node = new SceneNode(el, kind);
    memo.set(el, node);
    stats.nodes++;
    const v = el.values || {};
    if (kind !== 'camera' && kind !== 'light') {
      const m = localMatrix(v);
      node.local = isIdentity(m) ? null : m;
    }
    node.visible = valueOf(el, 'visible') !== false;
    node.collide = v.collide !== false;
    node.material = v.material !== undefined ? v.material : null;
    node.color = v.color !== undefined ? v.color : null;
    const position = valueOf(el, 'position') || [0, 0, 0];
    node.base = {
      position,
      rotation: valueOf(el, 'rotation') || [0, 0, 0],
      scale: valueOf(el, 'scale') || [1, 1, 1],
    };
    if (kind === 'camera') {
      // a camera without a target looks down -Z: start a target animation from there
      node.base.target = v.target || [position[0], position[1], position[2] - 1];
      node.base.fov = [valueOf(el, 'fov')];
    }

    for (const c of el.children) {
      if (c.type !== 'element') continue;
      if (c.name === 'animate') {
        if (!c.unknown && c.values && c.values.attr) {
          const a = animationFromElement(c, node.base);
          node.anims.push(a);
          animation[a.timeline === 'scroll' ? 'scroll' : 'time'] = true;
        }
        continue;
      }
      if (name === 'es3d' || name === 'v3d') {
        if (c.name === 'defs' || c.name === 'title' || c.name === 'desc' || c.name === 'environment' || c.name === 'material') continue;
      }
      if (c.name === 'material' || c.name === 'environment' || c.name === 'controls') continue;
      const child = nodeFor(c, depth + 1);
      if (child) node.children.push(child);
    }

    switch (kind) {
      case 'shape': {
        stats.shapes++;
        let desc = null;
        try {
          desc = describeShape(el, {});
        } catch (err) {
          report(el, 'error', 'E_GEOMETRY', `Cannot describe <${name}>: ${err.message}`, 'geometry');
        }
        if (desc) {
          node.geometry = cache.acquire(desc, el);
          node.unit = desc.unit && !isIdentity(desc.unit) ? desc.unit : null;
        } else if (!diagnostics.some((d) => d.element === el)) {
          report(el, 'error', 'E_GEOMETRY', `<${name}> has no usable geometry source.`, 'geometry');
        }
        break;
      }
      case 'use':
        stats.uses++;
        if (el.target && !el.circular) node.target = nodeFor(el.target, depth + 1);
        break;
      case 'repeat':
        node.count = v.count || 0;
        node.step = v.step ? v.step.matrix : mat4.createF64();
        break;
      case 'scatter':
        node.params = {
          grid: v.grid || null,
          count: v.grid ? v.grid[0] * v.grid[1] : v.count || 0,
          spacing: valueOf(el, 'spacing'),
          area: v.area || null,
          radius: v.radius || null,
          seed: valueOf(el, 'seed'),
          jitter: valueOf(el, 'jitter'),
          randomScale: v.randomScale || null,
          randomRotation: v.randomRotation || null,
          randomMaterial: v.randomMaterial || null,
        };
        break;
      case 'lod':
        node.params = { distances: v.distances || [] };
        break;
      case 'light': {
        stats.lights++;
        const m = mat4.createF64();
        if (v.transform) m.set(v.transform.matrix);
        node.params = {
          type: v.type,
          color: valueOf(el, 'color'),
          intensity: valueOf(el, 'intensity'),
          position: valueOf(el, 'position'),
          rotation: v.rotation || null,
          direction: v.direction || null,
          target: v.target || null,
          range: valueOf(el, 'range'),
          angle: valueOf(el, 'angle'),
          penumbra: valueOf(el, 'penumbra'),
          groundColor: valueOf(el, 'groundColor'),
          transform: v.transform ? m : null,
        };
        break;
      }
      case 'camera': {
        stats.cameras++;
        node.params = {
          type: valueOf(el, 'type'),
          position: valueOf(el, 'position'),
          target: v.target || null,
          rotation: v.rotation || null,
          up: valueOf(el, 'up'),
          fov: valueOf(el, 'fov'),
          height: valueOf(el, 'height'),
          near: v.near || null,
          far: v.far || null,
          aspect: valueOf(el, 'aspect'),
          fit: valueOf(el, 'fit'),
          transform: v.transform ? v.transform.matrix : null,
          name: v.name || v.id || `camera ${stats.cameras}`,
        };
        break;
      }
      default:
        break;
    }
    return node;
  };

  const root = doc.root ? nodeFor(doc.root) : null;
  cache.endBuild();

  // expanded instance count (memoised per node) guards against accidental explosions
  const counts = new Map();
  const countOf = (node) => {
    if (!node) return 0;
    if (counts.has(node)) return counts.get(node);
    counts.set(node, 0); // cycle guard
    let n = 0;
    const kids = () => node.children.reduce((s, c) => s + countOf(c), 0);
    switch (node.kind) {
      case 'shape':
        n = node.geometry ? 1 : 0;
        break;
      case 'use':
        n = countOf(node.target);
        break;
      case 'repeat':
        n = node.count * kids();
        break;
      case 'scatter':
        n = node.params.count * kids();
        break;
      case 'light':
      case 'camera':
        n = 0;
        break;
      default:
        n = kids();
    }
    if (!node.visible) n = 0;
    counts.set(node, n);
    return n;
  };
  const expanded = countOf(root);
  stats.expandedInstances = expanded;
  if (expanded > maxInstances) {
    report(doc.root, 'error', 'E_TOO_MANY_INSTANCES', `The scene expands to ${expanded.toLocaleString('en-US')} instances, more than the limit of ${maxInstances.toLocaleString('en-US')}. Reduce repeat or scatter counts.`, 'render');
  }

  return { doc, root, materials, environment, controls, animation, cache, diagnostics, stats, tooLarge: expanded > maxInstances, expanded };
}

/** Viewer settings from a <controls> element (angles in degrees, as written). */
function controlsFromElement(el) {
  const v = el.values || {};
  return {
    mode: valueOf(el, 'mode'),
    zoom: valueOf(el, 'zoom'),
    pan: valueOf(el, 'pan'),
    minDistance: v.minDistance ?? null,
    maxDistance: v.maxDistance ?? null,
    minPolar: valueOf(el, 'minPolar'),
    maxPolar: valueOf(el, 'maxPolar'),
    targetMin: v.targetMin && v.targetMax ? v.targetMin : null,
    targetMax: v.targetMin && v.targetMax ? v.targetMax : null,
    collide: valueOf(el, 'collide'),
    uid: el.uid,
  };
}
