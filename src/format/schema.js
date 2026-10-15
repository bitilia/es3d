// The ES3D v1 schema: elements, attributes, value types, defaults, aliases and
// cross-attribute rules. The validator, the serializer (short aliases), the
// inspector (editable fields) and the specification generator all read this table.
//
// Design rule: every primitive's default size fits in the unit cube centred at
// the origin, so <box/>, <sphere/>, <cylinder/> ... are all visible and comparable.

import { MAX_COPIES } from './limits.js';

const ident = {
  id: { type: 'id', desc: 'Unique identifier, referenced by <use ref>, material="…" and path="…".' },
  name: { type: 'string', desc: 'Human readable label shown in tools.' },
};

const placement = {
  transform: { type: 'transform', alias: 't', desc: 'SVG-style transform list; applied outside position/rotation/scale.' },
  position: { type: 'vec3', alias: 'p', default: [0, 0, 0], desc: 'Translation x,y,z.' },
  rotation: { type: 'vec3', alias: 'rot', default: [0, 0, 0], desc: 'Euler angles in degrees, applied about X, then Y, then Z.' },
  scale: { type: 'scale3', alias: 'sc', default: [1, 1, 1], desc: 'Uniform scale or x,y,z.' },
  visible: { type: 'bool', default: true, desc: 'When false the element and its children are not rendered.' },
};

const style = {
  material: { type: 'ref', ref: 'material', alias: 'm', desc: 'Material id. Inherited by descendants, like SVG fill.' },
  color: { type: 'color', alias: 'c', desc: 'Base colour override. Inherited by descendants.' },
};

const node = {
  ...ident,
  ...placement,
  ...style,
  collide: { type: 'bool', default: true, desc: 'When false the camera may pass through the element and its children (see <controls collide>).' },
};

const pathSource = {
  d: { type: 'path2d', desc: 'SVG path data in the local XY plane (y up): M L H V C S Q T A Z.' },
  path: { type: 'ref', ref: 'path', desc: 'Id of a <path> element whose d is used.' },
  fillRule: { type: 'enum', values: ['nonzero', 'evenodd'], default: 'nonzero', desc: 'How nested contours become holes (SVG fill-rule).' },
};

const positive = { exclusiveMin: 0 };

function requirePathSource(v, err, el, given = (k) => v[k] !== undefined) {
  if (!given('d') && !given('path')) err(null, "Missing path data: give either d=\"…\" or path=\"id\".", 'E_MISSING_ATTRIBUTE');
  else if (given('d') && given('path')) err('path', "Give either d or path, not both.", 'E_CONFLICTING_ATTRIBUTES');
}

/** Children categories */
export const SHAPES = [
  'box', 'sphere', 'cylinder', 'cone', 'capsule', 'plane', 'torus',
  'line', 'polyline', 'polygon', 'path', 'extrude', 'revolve', 'sweep', 'gear', 'mesh',
];
export const CONTAINERS = ['group', 'repeat', 'scatter', 'lod'];
export const SCENE_NODES = [...SHAPES, ...CONTAINERS, 'use', 'light', 'camera', 'material'];

export const ELEMENTS = {
  es3d: {
    category: 'root',
    children: ['title', 'desc', 'defs', 'scene', 'environment', 'controls', ...SCENE_NODES],
    desc: 'Root element of an ES3D document.',
    attrs: {
      version: { type: 'string', required: true, desc: 'Format version; this implementation reads version 1.' },
      unit: { type: 'enum', values: ['m', 'cm', 'mm', 'km', 'in', 'ft'], default: 'm', desc: 'Length unit (informative).' },
      xmlns: { type: 'string', desc: 'Optional. Ignored if present. A namespace is not required.' },
      name: ident.name,
    },
    check(v, err) {
      if (v.version !== undefined && !/^1(\.\d+)?$/.test(String(v.version).trim())) {
        err('version', `Unsupported ES3D version '${v.version}'. This reader supports version 1.`, 'E_VERSION');
      }
    },
  },
  title: { category: 'meta', children: 'text', desc: 'Document title.', attrs: {} },
  desc: { category: 'meta', children: 'text', desc: 'Free text description.', attrs: {} },
  defs: {
    category: 'defs',
    children: [...SCENE_NODES],
    desc: 'Definitions that are not rendered directly; referenced with <use ref>.',
    attrs: {},
  },
  scene: {
    category: 'container',
    children: [...SCENE_NODES, 'environment', 'controls'],
    desc: 'Optional wrapper for scene content; behaves like a group.',
    attrs: { ...node },
  },
  environment: {
    category: 'meta',
    children: [],
    desc: 'Background and ambient (hemisphere) lighting.',
    attrs: {
      background: { type: 'color', default: [0.09, 0.1, 0.12, 1], desc: 'Clear colour.' },
      sky: { type: 'color', default: [0.8, 0.86, 0.95, 1], desc: 'Ambient light colour from above.' },
      ground: { type: 'color', default: [0.25, 0.22, 0.2, 1], desc: 'Ambient light colour from below.' },
      intensity: { type: 'number', min: 0, default: 0.5, desc: 'Ambient / environment intensity.' },
      exposure: { type: 'number', exclusiveMin: 0, default: 1, desc: 'Tone mapping exposure.' },
    },
  },
  controls: {
    category: 'meta',
    children: [],
    desc: 'How a viewer lets people move the camera: orbit limits, collision with the scene, or a camera driven by page scroll.',
    attrs: {
      mode: { type: 'enum', values: ['orbit', 'scroll', 'none'], default: 'orbit', desc: 'orbit: drag to orbit, pan and zoom. scroll: the first camera follows its scroll-timeline animations and dragging is off. none: a fixed view.' },
      zoom: { type: 'bool', default: true, desc: 'Allow zooming (orbit mode).' },
      pan: { type: 'bool', default: true, desc: 'Allow panning (orbit mode).' },
      minDistance: { type: 'number', ...positive, desc: 'Closest the camera may get to its target.' },
      maxDistance: { type: 'number', ...positive, desc: 'Farthest the camera may get from its target.' },
      minPolar: { type: 'angle', min: 0, max: 180, default: 0, desc: 'Smallest angle between the view from the target and straight up, in degrees (0 = from directly above).' },
      maxPolar: { type: 'angle', min: 0, max: 180, default: 180, desc: 'Largest angle from straight up, in degrees (90 = never below the target).' },
      targetMin: { type: 'vec3', desc: 'Lower corner of the box the orbit target must stay in (limits panning).' },
      targetMax: { type: 'vec3', desc: 'Upper corner of the box the orbit target must stay in.' },
      collide: { type: 'bool', default: false, desc: 'Stop the camera at surfaces instead of letting it pass into objects. Elements with collide="false" are ignored.' },
    },
    check(v, err, el, given = (k) => v[k] !== undefined) {
      if (v.minDistance !== undefined && v.maxDistance !== undefined && v.maxDistance < v.minDistance) err('maxDistance', 'maxDistance must not be smaller than minDistance.', 'E_RANGE');
      if (v.minPolar !== undefined && v.maxPolar !== undefined && v.maxPolar < v.minPolar) err('maxPolar', 'maxPolar must not be smaller than minPolar.', 'E_RANGE');
      if (given('targetMin') !== given('targetMax')) err(given('targetMin') ? 'targetMin' : 'targetMax', 'Give both targetMin and targetMax.', 'E_MISSING_ATTRIBUTE');
      if (v.targetMin && v.targetMax && v.targetMin.some((x, k) => x > v.targetMax[k])) err('targetMax', 'targetMax must not be smaller than targetMin on any axis.', 'E_RANGE');
    },
  },
  material: {
    category: 'resource',
    children: [],
    desc: 'Minimal physically based material (metallic/roughness).',
    attrs: {
      ...ident,
      color: { type: 'color', alias: 'c', default: [0.8, 0.8, 0.8, 1], desc: 'Base colour (sRGB).' },
      metallic: { type: 'number', min: 0, max: 1, default: 0, desc: '0 = dielectric, 1 = metal.' },
      roughness: { type: 'number', min: 0, max: 1, default: 0.5, desc: '0 = mirror, 1 = fully rough.' },
      opacity: { type: 'number', min: 0, max: 1, default: 1, desc: 'Alpha; values below 1 are blended.' },
      emissive: { type: 'color', default: [0, 0, 0, 1], desc: 'Emitted colour.' },
      emissiveIntensity: { type: 'number', min: 0, default: 1, desc: 'Multiplier for emissive.' },
      map: { type: 'texture', desc: 'Base colour texture: image URL or checker(), grid(), stripes(), noise(), bricks().' },
      normalMap: { type: 'normalTexture', desc: 'Normal map: image URL or bumps(), tiles(), noise(), waves(), bricks().' },
      normalScale: { type: 'number', default: 1, desc: 'Normal map strength.' },
      uvScale: { type: 'vec2', default: [1, 1], desc: 'Texture repeat in u and v.' },
      doubleSided: { type: 'bool', default: false, desc: 'Render back faces too.' },
      unlit: { type: 'bool', default: false, desc: 'Ignore lighting; output the base colour.' },
      occlusionMap: { type: 'texture', desc: 'Occlusion texture. The red channel darkens indirect light. Image URL or a procedural texture.' },
      occlusionStrength: { type: 'number', min: 0, max: 1, default: 1, desc: 'Strength of occlusionMap. 0 disables it, 1 uses the texture as stored.' },
      metallicRoughnessMap: { type: 'texture', desc: 'Packed texture: green multiplies roughness, blue multiplies metallic.' },
      emissiveMap: { type: 'texture', desc: 'sRGB texture multiplied with emissive.' },
      alphaMode: { type: 'enum', values: ['auto', 'opaque', 'mask', 'blend'], default: 'auto', desc: 'auto blends when opacity is below 1 and is opaque otherwise. mask discards fragments below alphaCutoff. blend uses opacity as coverage. opaque ignores alpha.' },
      alphaCutoff: { type: 'number', min: 0, max: 1, default: 0.5, desc: 'Mask threshold.' },
    },
  },
  group: { category: 'container', children: [...SCENE_NODES, 'animate'], desc: 'Groups children under a common transform and style.', attrs: { ...node } },
  use: {
    category: 'instance',
    children: ['animate'],
    desc: 'Instantiates the element with the given id (like SVG <use>).',
    attrs: {
      ...node,
      ref: { type: 'ref', ref: 'node', required: true, alias: 'href', desc: 'Id of the element to instantiate.' },
    },
  },
  repeat: {
    category: 'container',
    children: [...SCENE_NODES, 'animate'],
    desc: 'Repeats its children count times; copy i is transformed by step applied i times.',
    attrs: {
      ...node,
      count: { type: 'int', alias: 'n', required: true, min: 0, max: MAX_COPIES, desc: 'Number of copies.' },
      step: { type: 'transform', required: true, desc: 'Transform applied cumulatively between copies.' },
    },
  },
  scatter: {
    category: 'container',
    children: [...SCENE_NODES, 'animate'],
    desc: 'Deterministic pseudo-random or grid placement of its children (seeded mulberry32).',
    attrs: {
      ...node,
      count: { type: 'int', alias: 'n', min: 0, max: MAX_COPIES, desc: 'Number of random copies (random layout).' },
      grid: { type: 'count2', desc: 'Grid layout nx,nz (instead of count).' },
      spacing: { type: 'vec2', default: [1, 1], desc: 'Grid cell size x,z.' },
      area: { type: 'size2', desc: 'Random layout: rectangle width,depth centred at the origin (XZ plane).' },
      radius: { type: 'number', ...positive, desc: 'Random layout: disc radius (XZ plane).' },
      seed: { type: 'int', default: 1, min: 0, desc: 'Random seed.' },
      jitter: { type: 'number', min: 0, max: 1, default: 0, desc: 'Grid layout: random offset as a fraction of the cell.' },
      randomScale: { type: 'range3', desc: 'Per-copy scale: a range (uniform, e.g. 0.8..1.2) or x,y,z ranges.' },
      randomRotation: { type: 'range3', uniform: false, desc: 'Per-copy Euler ranges in degrees, e.g. 0,0..360,0.' },
      randomMaterial: { type: 'idlist', ref: 'material', desc: 'Per-copy material chosen from this list of ids.' },
    },
    check(v, err, el, given = (k) => v[k] !== undefined) {
      const hasGrid = given('grid');
      const hasCount = given('count');
      if (hasGrid && hasCount) err('grid', 'Give either count (random layout) or grid (grid layout), not both.', 'E_CONFLICTING_ATTRIBUTES');
      else if (!hasGrid && !hasCount) err(null, 'scatter needs count="…" (random layout) or grid="nx,nz" (grid layout).', 'E_MISSING_ATTRIBUTE');
      if (hasCount && !given('area') && !given('radius')) err(null, 'Random scatter needs area="w,d" or radius="r".', 'E_MISSING_ATTRIBUTE');
      if (given('area') && given('radius')) err('radius', 'Give either area or radius, not both.', 'E_CONFLICTING_ATTRIBUTES');
      if (v.area && (v.area[0] < 0 || v.area[1] < 0)) err('area', 'area must not be negative.', 'E_RANGE');
      if (v.randomScale && v.randomScale.ranges.some((r) => r[0] < 0)) err('randomScale', 'Scale ranges must not be negative.', 'E_RANGE');
    },
  },
  lod: {
    category: 'container',
    children: [...SCENE_NODES, 'animate'],
    desc: 'Level of detail switch: child i is shown while the camera distance is below distances[i].',
    attrs: {
      ...node,
      distances: { type: 'numbers', required: true, desc: 'Increasing switch distances; one fewer than the number of children.' },
    },
    check(v, err, el) {
      const d = v.distances;
      if (!d) return;
      for (let i = 1; i < d.length; i++) if (d[i] <= d[i - 1]) err('distances', 'distances must be strictly increasing.', 'E_RANGE');
      if (d.some((x) => x <= 0)) err('distances', 'distances must be positive.', 'E_RANGE');
      const kids = el.children.filter((c) => c.type === 'element' && c.name !== 'animate').length;
      if (kids !== d.length + 1) err('distances', `lod has ${kids} children but ${d.length} distances; it needs exactly one distance fewer than children.`, 'E_LOD_CHILDREN');
    },
  },
  animate: {
    category: 'anim',
    children: [],
    desc: 'Animates a transform of its parent (position, rotation, scale; target and fov of a camera) over time or over page scroll.',
    attrs: {
      attr: { type: 'enum', values: ['position', 'rotation', 'scale', 'target', 'fov'], required: true, desc: 'Animated attribute. target and fov apply to <camera> only.' },
      from: { type: 'animValue', desc: 'Start value (defaults to the parent value).' },
      to: { type: 'animValue', desc: 'End value.' },
      values: { type: 'keyframes', desc: 'Key values separated by semicolons, e.g. 0,1,0; 2,1,0; 2,3,0 (instead of from/to).' },
      keyTimes: { type: 'numbers', desc: 'Progress (0 to 1) at which each of values is reached; evenly spaced when omitted.' },
      along: { type: 'spine', desc: 'Path to move along at constant speed (position and target): x,y,z points, 3D path data or helix().' },
      smooth: { type: 'bool', default: false, desc: 'Pass through values or along points on a smooth (centripetal Catmull-Rom) curve.' },
      dur: { type: 'duration', desc: 'Duration of one cycle, e.g. 4s or 500ms (required unless timeline="scroll").' },
      begin: { type: 'duration', default: 0, min: 0, desc: 'Delay before the animation starts.' },
      repeat: { type: 'repeatCount', default: Infinity, desc: "Number of cycles or 'indefinite'." },
      alternate: { type: 'bool', default: false, desc: 'Play every second cycle backwards.' },
      easing: { type: 'enum', values: ['linear', 'ease-in', 'ease-out', 'ease-in-out'], default: 'linear', desc: 'Timing function.' },
      timeline: { type: 'enum', values: ['time', 'scroll'], default: 'time', desc: 'time: plays by the clock. scroll: progress follows page scroll from 0 to 1 (dur, begin, repeat and alternate are not used).' },
    },
    check(v, err, el, given = (k) => v[k] !== undefined) {
      const sources = ['to', 'values', 'along'].filter((k) => given(k));
      if (!sources.length) err(null, 'animate needs to="…", values="…" or along="…".', 'E_MISSING_ATTRIBUTE');
      else if (sources.length > 1) err(sources[1], `Give only one of to, values and along (found ${sources.join(' and ')}).`, 'E_CONFLICTING_ATTRIBUTES');
      if (given('from') && (given('values') || given('along'))) err('from', 'from is only used with to.', 'E_CONFLICTING_ATTRIBUTES');
      const scroll = v.timeline === 'scroll';
      if (!scroll && !given('dur')) err(null, "animate requires the attribute 'dur' (or timeline=\"scroll\").", 'E_MISSING_ATTRIBUTE');
      if (v.dur !== undefined && v.dur <= 0) err('dur', 'dur must be positive.', 'E_RANGE');
      const parent = el && el.parent;
      if ((v.attr === 'target' || v.attr === 'fov') && parent && parent.name !== 'camera') {
        err('attr', `attr="${v.attr}" can only animate a <camera>.`, 'E_INVALID_VALUE');
      }
      if (v.attr === 'target' && parent && parent.name === 'camera' && parent.attrIndex && parent.attrIndex.rotation) {
        err('attr', 'This camera is oriented by rotation; give it a target instead to animate the target.', 'E_CONFLICTING_ATTRIBUTES');
      }
      if (given('along') && v.attr && v.attr !== 'position' && v.attr !== 'target') err('along', 'along can only move position or target.', 'E_INVALID_VALUE');
      const n = v.attr === 'scale' ? [1, 3] : v.attr === 'fov' ? [1, 1] : [3, 3];
      const need = `${v.attr || 'value'} animation values need ${n[0] === n[1] ? n[0] : '1 or 3'} number${n[1] === 1 ? '' : 's'}`;
      for (const k of ['from', 'to']) {
        if (v[k] !== undefined && !n.includes(v[k].length)) err(k, `${need}.`, 'E_TYPE');
      }
      if (v.values) {
        if (v.values.length < 2) err('values', 'values needs at least 2 key values.', 'E_RANGE');
        const bad = v.values.findIndex((x) => !n.includes(x.length));
        if (bad >= 0) err('values', `${need}; key value ${bad + 1} has ${v.values[bad].length}.`, 'E_TYPE');
      }
      if (given('keyTimes') && !given('values')) err('keyTimes', 'keyTimes needs values.', 'E_MISSING_ATTRIBUTE');
      const kt = v.keyTimes;
      if (kt && v.values) {
        if (kt.length !== v.values.length) err('keyTimes', `keyTimes has ${kt.length} entries but values has ${v.values.length}.`, 'E_RANGE');
        else if (kt[0] !== 0 || kt[kt.length - 1] !== 1) err('keyTimes', 'keyTimes must start at 0 and end at 1.', 'E_RANGE');
        else if (kt.some((t, i) => i > 0 && t < kt[i - 1])) err('keyTimes', 'keyTimes must not decrease.', 'E_RANGE');
      }
    },
  },
  camera: {
    category: 'camera',
    children: ['animate'],
    desc: 'Perspective or orthographic camera. The first camera is the initial view.',
    attrs: {
      ...ident,
      transform: placement.transform,
      position: { type: 'vec3', alias: 'p', default: [0, 0, 10], desc: 'Eye position.' },
      rotation: { type: 'vec3', alias: 'rot', desc: 'Euler orientation (used when no target is given; the camera looks down -Z).' },
      target: { type: 'vec3', desc: 'Point the camera looks at.' },
      up: { type: 'vec3', default: [0, 1, 0], desc: 'Up vector.' },
      type: { type: 'enum', values: ['perspective', 'orthographic'], default: 'perspective', desc: 'Projection.' },
      fov: { type: 'angle', min: 1, max: 179, default: 45, desc: 'Vertical field of view in degrees (perspective).' },
      height: { type: 'number', ...positive, default: 10, desc: 'Visible height (orthographic).' },
      near: { type: 'number', ...positive, desc: 'Near clip distance (automatic when omitted).' },
      far: { type: 'number', ...positive, desc: 'Far clip distance (automatic when omitted).' },
      aspect: { type: 'number', ...positive, default: 1, desc: 'Width / height of the view the author framed (e.g. 1.778 for 16:9). fov is the vertical angle at this aspect ratio.' },
      fit: { type: 'enum', values: ['contain', 'cover', 'width', 'height'], default: 'contain', desc: 'How the framed view adapts to other screens: contain keeps all of it visible, cover fills the screen, width and height keep that extent fixed.' },
    },
    check(v, err) {
      if (v.near !== undefined && v.far !== undefined && v.far <= v.near) err('far', 'far must be greater than near.', 'E_RANGE');
      if (v.target !== undefined && v.rotation !== undefined) err('rotation', 'Give either target or rotation, not both.', 'E_CONFLICTING_ATTRIBUTES');
    },
  },
  light: {
    category: 'light',
    children: ['animate'],
    desc: 'Directional, point, spot, ambient or hemisphere light.',
    attrs: {
      ...ident,
      transform: placement.transform,
      position: { type: 'vec3', alias: 'p', default: [0, 0, 0], desc: 'Light position (point/spot).' },
      rotation: placement.rotation,
      visible: placement.visible,
      type: { type: 'enum', values: ['directional', 'point', 'spot', 'ambient', 'hemisphere'], required: true, desc: 'Light kind.' },
      color: { type: 'color', alias: 'c', default: [1, 1, 1, 1], desc: 'Light colour.' },
      intensity: { type: 'number', min: 0, default: 1, desc: 'Intensity multiplier.' },
      direction: { type: 'vec3', alias: 'dir', desc: 'Direction the light travels (directional/spot).' },
      target: { type: 'vec3', desc: 'Point the light aims at (alternative to direction).' },
      range: { type: 'number', min: 0, default: 0, desc: 'Point/spot cut-off distance (0 = unlimited).' },
      angle: { type: 'angle', min: 1, max: 179, default: 45, desc: 'Spot cone angle in degrees.' },
      penumbra: { type: 'number', min: 0, max: 1, default: 0.2, desc: 'Spot edge softness.' },
      groundColor: { type: 'color', default: [0.25, 0.22, 0.2, 1], desc: 'Hemisphere light colour from below.' },
    },
    check(v, err) {
      if (v.direction && Math.hypot(...v.direction) < 1e-12) err('direction', 'direction must not be the zero vector.', 'E_RANGE');
      if (v.direction !== undefined && v.target !== undefined) err('target', 'Give either direction or target, not both.', 'E_CONFLICTING_ATTRIBUTES');
    },
  },

  // ---- shapes -------------------------------------------------------------
  box: {
    category: 'shape',
    children: ['animate'],
    desc: 'Axis aligned box centred at the origin, optionally with rounded edges.',
    attrs: {
      ...node,
      size: { type: 'size3', alias: 's', default: [1, 1, 1], desc: 'Edge lengths (one value for a cube).' },
      radius: { type: 'number', alias: 'r', min: 0, default: 0, desc: 'Edge rounding radius.' },
      segments: { type: 'int', min: 1, max: 32, desc: 'Rounding segments (automatic when omitted).' },
    },
    check(v, err) {
      if (v.size && v.size.some((x) => x <= 0)) err('size', 'size must be positive.', 'E_RANGE');
      if (v.size && v.radius > 0 && v.radius * 2 > Math.min(...v.size) + 1e-12) err('radius', `radius ${v.radius} is larger than half the smallest edge (${Math.min(...v.size) / 2}).`, 'E_RANGE');
    },
  },
  sphere: {
    category: 'shape',
    children: ['animate'],
    desc: 'Sphere centred at the origin.',
    attrs: {
      ...node,
      radius: { type: 'number', alias: 'r', ...positive, default: 0.5, desc: 'Radius.' },
      segments: { type: 'int', min: 3, max: 512, desc: 'Fixed tessellation (automatic level of detail when omitted).' },
    },
  },
  cylinder: {
    category: 'shape',
    children: ['animate'],
    desc: 'Cylinder (or truncated cone) along Y, centred at the origin.',
    attrs: {
      ...node,
      radius: { type: 'number', alias: 'r', ...positive, default: 0.5, desc: 'Bottom radius (and top radius unless radiusTop is set).' },
      radiusTop: { type: 'number', min: 0, desc: 'Top radius.' },
      height: { type: 'number', alias: 'h', ...positive, default: 1, desc: 'Height.' },
      segments: { type: 'int', min: 3, max: 512, desc: 'Fixed number of sides, e.g. 6 for a hexagonal prism.' },
      caps: { type: 'bool', default: true, desc: 'Close the ends.' },
    },
  },
  cone: {
    category: 'shape',
    children: ['animate'],
    desc: 'Cone along Y with its base at -height/2 and apex at +height/2.',
    attrs: {
      ...node,
      radius: { type: 'number', alias: 'r', ...positive, default: 0.5, desc: 'Base radius.' },
      height: { type: 'number', alias: 'h', ...positive, default: 1, desc: 'Height.' },
      segments: { type: 'int', min: 3, max: 512, desc: 'Fixed number of sides.' },
      caps: { type: 'bool', default: true, desc: 'Close the base.' },
    },
  },
  capsule: {
    category: 'shape',
    children: ['animate'],
    desc: 'Capsule along Y; height is the total height including both caps.',
    attrs: {
      ...node,
      radius: { type: 'number', alias: 'r', ...positive, default: 0.25, desc: 'Radius.' },
      height: { type: 'number', alias: 'h', ...positive, default: 1, desc: 'Total height (at least 2 × radius).' },
      segments: { type: 'int', min: 3, max: 512, desc: 'Fixed tessellation.' },
    },
    check(v, err) {
      const r = v.radius ?? 0.25;
      const h = v.height ?? 1;
      if (h < 2 * r - 1e-12) err('height', `capsule height (${h}) must be at least twice the radius (${2 * r}).`, 'E_RANGE');
    },
  },
  plane: {
    category: 'shape',
    children: ['animate'],
    desc: 'Flat rectangle in the XZ plane facing +Y (rendered double sided).',
    attrs: {
      ...node,
      size: { type: 'size2', alias: 's', default: [1, 1], desc: 'Width (x) and depth (z).' },
    },
    check(v, err) {
      if (v.size && v.size.some((x) => x <= 0)) err('size', 'size must be positive.', 'E_RANGE');
    },
  },
  torus: {
    category: 'shape',
    children: ['animate'],
    desc: 'Torus around the Y axis.',
    attrs: {
      ...node,
      radius: { type: 'number', alias: 'r', ...positive, default: 0.35, desc: 'Distance from the centre to the tube centre.' },
      tube: { type: 'number', ...positive, default: 0.15, desc: 'Tube radius.' },
      arc: { type: 'angle', exclusiveMin: 0, max: 360, default: 360, desc: 'Swept angle in degrees (partial torus / pipe elbow).' },
      segments: { type: 'int', min: 3, max: 1024, desc: 'Fixed segments around the ring.' },
      tubeSegments: { type: 'int', min: 3, max: 512, desc: 'Fixed segments around the tube.' },
    },
  },
  line: {
    category: 'shape',
    children: ['animate'],
    desc: 'Straight line segment; rendered as a tube when radius > 0.',
    attrs: {
      ...node,
      from: { type: 'vec3', required: true, desc: 'Start point.' },
      to: { type: 'vec3', required: true, desc: 'End point.' },
      radius: { type: 'number', alias: 'r', min: 0, default: 0, desc: 'Tube radius (0 = hairline).' },
      segments: { type: 'int', min: 3, max: 256, desc: 'Tube sides.' },
    },
    check(v, err) {
      if (v.from && v.to && Math.hypot(v.to[0] - v.from[0], v.to[1] - v.from[1], v.to[2] - v.from[2]) < 1e-12) {
        err('to', 'A line needs two distinct points.', 'E_DEGENERATE');
      }
    },
  },
  polyline: {
    category: 'shape',
    children: ['animate'],
    desc: '3D polyline or 2D path outline; rendered as a tube when radius > 0.',
    attrs: {
      ...node,
      points: { type: 'points3', desc: 'x,y,z x,y,z …' },
      d: { type: 'path2d', desc: 'Outline of 2D path data in the XY plane (alternative to points).' },
      closed: { type: 'bool', default: false, desc: 'Connect the last point to the first.' },
      smooth: { type: 'bool', default: false, desc: 'Interpolate the points with a Catmull-Rom spline.' },
      radius: { type: 'number', alias: 'r', min: 0, default: 0, desc: 'Tube radius (0 = hairline).' },
      segments: { type: 'int', min: 3, max: 256, desc: 'Tube sides.' },
    },
    check(v, err, el, given = (k) => v[k] !== undefined) {
      if (!given('points') && !given('d')) err(null, 'polyline needs points="…" or d="…".', 'E_MISSING_ATTRIBUTE');
      if (given('points') && given('d')) err('d', 'Give either points or d, not both.', 'E_CONFLICTING_ATTRIBUTES');
      if (v.points && v.points.length < 6) err('points', 'A polyline needs at least 2 points.', 'E_DEGENERATE');
    },
  },
  polygon: {
    category: 'shape',
    children: ['animate'],
    desc: 'Filled flat polygon in the XY plane (rendered double sided).',
    attrs: {
      ...node,
      points: { type: 'points2', required: true, desc: 'x,y x,y … (at least 3 points).' },
    },
    check(v, err) {
      if (v.points && v.points.length < 6) err('points', 'A polygon needs at least 3 points.', 'E_DEGENERATE');
    },
  },
  path: {
    category: 'shape',
    children: ['animate'],
    desc: 'Filled flat 2D path in the XY plane (rendered double sided). In <defs> it is a reusable outline.',
    attrs: { ...node, ...pathSource },
    check: requirePathSource,
  },
  extrude: {
    category: 'shape',
    children: ['animate'],
    desc: 'Extrudes a 2D path along +Z, optionally with a rounded bevel.',
    attrs: {
      ...node,
      ...pathSource,
      depth: { type: 'number', ...positive, default: 1, desc: 'Extrusion depth along Z.' },
      bevel: { type: 'number', min: 0, default: 0, desc: 'Bevel radius on the front and back edges.' },
      bevelSegments: { type: 'int', min: 1, max: 16, default: 3, desc: 'Segments per bevel.' },
      center: { type: 'bool', default: false, desc: 'Centre the extrusion on z = 0.' },
    },
    check(v, err, el, given) {
      requirePathSource(v, err, el, given);
      const depth = v.depth ?? 1;
      if (v.bevel && v.bevel * 2 > depth + 1e-12) err('bevel', `bevel (${v.bevel}) must be at most half the depth (${depth / 2}).`, 'E_RANGE');
    },
  },
  revolve: {
    category: 'shape',
    children: ['animate'],
    desc: 'Revolves (lathes) a 2D profile around the Y axis; x is the distance from the axis.',
    attrs: {
      ...node,
      ...pathSource,
      angle: { type: 'angle', exclusiveMin: 0, max: 360, default: 360, desc: 'Revolution angle in degrees.' },
      segments: { type: 'int', min: 3, max: 1024, desc: 'Fixed number of radial segments.' },
    },
    check: requirePathSource,
  },
  sweep: {
    category: 'shape',
    children: ['animate'],
    desc: 'Sweeps a profile (circle or 2D path) along a 3D spine with rotation minimising frames.',
    attrs: {
      ...node,
      ...pathSource,
      radius: { type: 'number', alias: 'r', ...positive, desc: 'Circular profile radius (alternative to d/path).' },
      along: { type: 'spine', required: true, desc: 'Spine: x,y,z points, 3D path data (M L C S Q T Z) or helix(r,pitch,turns).' },
      smooth: { type: 'bool', default: false, desc: 'Interpolate spine points with a Catmull-Rom spline.' },
      twist: { type: 'angle', default: 0, desc: 'Profile rotation in degrees from start to end.' },
      taper: { type: 'number', min: 0, default: 1, desc: 'Profile scale at the end (1 = constant).' },
      caps: { type: 'bool', default: true, desc: 'Close open ends.' },
      segments: { type: 'int', min: 3, max: 256, desc: 'Circle profile sides.' },
    },
    check(v, err, el, given = (k) => v[k] !== undefined) {
      const hasPath = given('d') || given('path');
      if (!hasPath && !given('radius')) err(null, 'sweep needs a profile: radius="…" or d="…" / path="…".', 'E_MISSING_ATTRIBUTE');
      if (hasPath && given('radius')) err('radius', 'Give either radius or a path profile, not both.', 'E_CONFLICTING_ATTRIBUTES');
      if (given('d') && given('path')) err('path', 'Give either d or path, not both.', 'E_CONFLICTING_ATTRIBUTES');
    },
  },
  gear: {
    category: 'shape',
    children: ['animate'],
    desc: 'Involute spur gear in the XY plane, extruded along Z.',
    attrs: {
      ...node,
      teeth: { type: 'int', min: 5, max: 400, default: 24, desc: 'Number of teeth.' },
      module: { type: 'number', ...positive, default: 0.04, desc: 'Module: pitch diameter / teeth.' },
      pressureAngle: { type: 'angle', min: 10, max: 35, default: 20, desc: 'Pressure angle in degrees.' },
      depth: { type: 'number', ...positive, default: 0.2, desc: 'Face width (extrusion depth).' },
      bore: { type: 'number', min: 0, default: 0, desc: 'Radius of the centre hole.' },
      bevel: { type: 'number', min: 0, default: 0, desc: 'Edge bevel radius.' },
      center: { type: 'bool', default: true, desc: 'Centre the gear on z = 0.' },
    },
    check(v, err) {
      const teeth = v.teeth ?? 24;
      const m = v.module ?? 0.04;
      const root = (m * teeth) / 2 - 1.25 * m;
      if (v.bore && v.bore >= root * 0.95) err('bore', `bore (${v.bore}) must be smaller than the root radius (${(root * 0.95).toFixed(4)}).`, 'E_RANGE');
      const depth = v.depth ?? 0.2;
      if (v.bevel && v.bevel * 2 > depth + 1e-12) err('bevel', `bevel must be at most half the depth (${depth / 2}).`, 'E_RANGE');
    },
  },
  mesh: {
    category: 'shape',
    children: ['animate'],
    desc: 'Explicit indexed triangle mesh (escape hatch for data that is not procedural).',
    attrs: {
      ...node,
      positions: { type: 'floats', required: true, desc: 'x y z for every vertex.' },
      indices: { type: 'indices', desc: 'Triangle vertex indices (3 per triangle); omitted = non-indexed triangles.' },
      normals: { type: 'floats', desc: 'Optional x y z normal per vertex (computed when omitted).' },
      uvs: { type: 'floats', desc: 'Optional u v per vertex.' },
      smooth: { type: 'angle', min: 0, max: 180, default: 30, desc: 'Crease angle for computed normals (0 = flat).' },
    },
    check(v, err) {
      const p = v.positions;
      if (!p) return;
      if (p.length % 3 !== 0) err('positions', `positions needs 3 numbers per vertex; found ${p.length} numbers.`, 'E_MESH');
      const nv = Math.floor(p.length / 3);
      if (nv < 3) err('positions', 'A mesh needs at least 3 vertices.', 'E_MESH');
      if (v.indices) {
        if (v.indices.length % 3 !== 0) err('indices', `indices must contain 3 entries per triangle; found ${v.indices.length}.`, 'E_MESH');
        for (let i = 0; i < v.indices.length; i++) {
          if (v.indices[i] >= nv) {
            err('indices', `Index ${v.indices[i]} at position ${i} is out of range (the mesh has ${nv} vertices).`, 'E_MESH');
            break;
          }
        }
      } else if (nv % 3 !== 0) err('positions', 'Without indices the vertex count must be a multiple of 3.', 'E_MESH');
      if (v.normals && v.normals.length !== p.length) err('normals', `normals must have one x y z per vertex (${p.length} numbers); found ${v.normals.length}.`, 'E_MESH');
      if (v.uvs && v.uvs.length !== nv * 2) err('uvs', `uvs must have one u v per vertex (${nv * 2} numbers); found ${v.uvs.length}.`, 'E_MESH');
      for (let i = 0; i < p.length; i++) {
        if (!Number.isFinite(p[i])) {
          err('positions', `Non-finite coordinate at position ${i}.`, 'E_MESH');
          break;
        }
      }
    },
  },
};

/** Elements accepted as the root (v3d is a legacy alias). */
export const ROOT_ELEMENTS = ['es3d', 'v3d'];

// alias tables --------------------------------------------------------------
const aliasCache = new Map();

/** Map alias -> canonical attribute name for an element. */
export function aliasesFor(elementName) {
  let m = aliasCache.get(elementName);
  if (m) return m;
  m = new Map();
  const spec = ELEMENTS[elementName === 'v3d' ? 'es3d' : elementName];
  if (spec) {
    for (const [name, a] of Object.entries(spec.attrs)) {
      m.set(name, name);
      if (a.alias) m.set(a.alias, name);
    }
  }
  aliasCache.set(elementName, m);
  return m;
}

export function elementSpec(name) {
  return ELEMENTS[name === 'v3d' ? 'es3d' : name] || null;
}

export function attrSpec(elementName, canonical) {
  const e = elementSpec(elementName);
  return e ? e.attrs[canonical] || null : null;
}

/** Typed value of an attribute, falling back to the schema default. */
export function valueOf(el, name) {
  const v = el.values ? el.values[name] : undefined;
  if (v !== undefined) return v;
  const a = attrSpec(el.name, name);
  return a ? a.default : undefined;
}

export const ALL_ELEMENT_NAMES = Object.keys(ELEMENTS);
