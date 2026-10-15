// Material system: a deliberately small metallic/roughness model.
//
// <material> elements define named parameter sets. Shapes reference them by
// id, and `material` / `color` are inherited down the tree like SVG's fill.
// The effective material of a shape is (inherited material, inherited color
// override); identical parameter sets are deduplicated into one Material, so
// the renderer binds each distinct material exactly once.

import { colorToLinear, colorToHex } from '../format/colors.js';
import { valueOf } from '../format/schema.js';

export const DEFAULT_MATERIAL_PARAMS = {
  color: [0.8, 0.8, 0.8, 1],
  metallic: 0,
  roughness: 0.5,
  opacity: 1,
  emissive: [0, 0, 0, 1],
  emissiveIntensity: 1,
  map: null,
  normalMap: null,
  normalScale: 1,
  occlusionMap: null,
  occlusionStrength: 1,
  metallicRoughnessMap: null,
  emissiveMap: null,
  alphaMode: 'auto',
  alphaCutoff: 0.5,
  uvScale: [1, 1],
  doubleSided: false,
  unlit: false,
};

export class Material {
  constructor(params, index, name = null) {
    this.index = index;
    this.name = name;
    this.params = params;
    this.baseColor = colorToLinear(params.color);
    this.baseColorSrgb = params.color;
    this.metallic = params.metallic;
    this.roughness = params.roughness;
    this.opacity = params.opacity * params.color[3];
    const e = colorToLinear(params.emissive);
    this.emissive = [e[0] * params.emissiveIntensity, e[1] * params.emissiveIntensity, e[2] * params.emissiveIntensity];
    this.map = params.map;
    this.normalMap = params.normalMap;
    this.normalScale = params.normalScale;
    this.occlusionMap = params.occlusionMap;
    this.occlusionStrength = params.occlusionStrength;
    this.metallicRoughnessMap = params.metallicRoughnessMap;
    this.emissiveMap = params.emissiveMap;
    this.alphaCutoff = params.alphaCutoff;
    const coverage = params.opacity * params.color[3];
    const requested = params.alphaMode || 'auto';
    this.alphaMode = requested === 'auto' ? (coverage < 0.999 ? 'blend' : 'opaque') : requested;
    this.uvScale = params.uvScale;
    this.doubleSided = params.doubleSided;
    this.unlit = params.unlit;
    this.key = materialKey(params);
  }

  get transparent() {
    return this.alphaMode === 'blend' && this.opacity < 0.999;
  }
}

export function materialKey(p) {
  return [
    colorToHex(p.color),
    p.metallic,
    p.roughness,
    p.opacity,
    colorToHex(p.emissive),
    p.emissiveIntensity,
    p.map ? p.map.key : '',
    p.normalMap ? p.normalMap.key : '',
    p.normalScale,
    p.occlusionMap ? p.occlusionMap.key : '',
    p.occlusionStrength,
    p.metallicRoughnessMap ? p.metallicRoughnessMap.key : '',
    p.emissiveMap ? p.emissiveMap.key : '',
    p.alphaMode,
    p.alphaCutoff,
    p.uvScale.join(','),
    p.doubleSided ? 1 : 0,
    p.unlit ? 1 : 0,
  ].join('|');
}

/** Parameters of a <material> element with schema defaults applied. */
export function paramsFromElement(el) {
  const p = {};
  for (const k of Object.keys(DEFAULT_MATERIAL_PARAMS)) {
    const v = valueOf(el, k);
    p[k] = v === undefined ? DEFAULT_MATERIAL_PARAMS[k] : v;
  }
  return p;
}

export class MaterialTable {
  constructor() {
    /** @type {Material[]} */
    this.list = [];
    this.byKey = new Map();
    this.defs = new Map(); // material id -> params
    this.resolved = new Map(); // "id|color" -> index
    this.fast = new Map(); // id -> Map(color array object -> index), identity cache for hot loops
  }

  define(id, params) {
    this.defs.set(id, params);
  }

  intern(params, name) {
    const key = materialKey(params);
    let idx = this.byKey.get(key);
    if (idx === undefined) {
      idx = this.list.length;
      this.list.push(new Material(params, idx, name));
      this.byKey.set(key, idx);
    }
    return idx;
  }

  /**
   * Effective material index for an inherited (material id, color override) pair.
   * @param {string|null} id
   * @param {number[]|null} color sRGB rgba
   */
  resolve(id, color) {
    let byColor = this.fast.get(id);
    if (byColor === undefined) {
      byColor = new Map();
      this.fast.set(id, byColor);
    }
    let fast = byColor.get(color);
    if (fast !== undefined) return fast;
    fast = this.resolveSlow(id, color);
    byColor.set(color, fast);
    return fast;
  }

  resolveSlow(id, color) {
    const ck = color ? colorToHex(color) : '';
    const rk = (id || '') + '|' + ck;
    let idx = this.resolved.get(rk);
    if (idx !== undefined) return idx;
    const base = (id && this.defs.get(id)) || DEFAULT_MATERIAL_PARAMS;
    const params = color ? { ...base, color } : base;
    idx = this.intern(params, id || (color ? ck : 'default'));
    this.resolved.set(rk, idx);
    return idx;
  }
}
