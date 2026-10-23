// The glTF stage: src/scene/castle.glb drawn with three.js.
//
// castle.glb is the world of castle.es3d, exported with es3d glb.
// The file carries the geometry, materials, lights, cameras and animations.
// This module adds what glTF has no place for, and what three.js does not do
// by itself, so that the page looks and behaves like the ES3D one:
//
// - Shading: ES3D's lighting model (render/shaders/glsl.js in @es3d/es3d) in
//   place of three.js's lighting chunks, with its sky-and-ground environment
//   light and its tone curve. Materials, maps, instancing and morphing stay
//   three.js's own.
// - Scroll: page scroll drives the "Scroll" animation (the camera flight, the
//   portcullis, the seal) the way ES3D's ScrollTimeline does, and the camera
//   is fitted to the screen like ES3D's <camera fit="cover">.
// - Instances: levels of detail (the trees' <lod>, and ES3D's tessellation
//   levels of curved shapes, stored with MSFT_lod), culling and the phone
//   forest thinning per instance, and transparent instances back to front.
// - Explore: orbiting with ES3D's limits and collision, and picking by name.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const now = () => performance.now();

// ---------------------------------------------------------------------------
// ES3D's shading, in three.js's material pipeline

// ES3D's tone curve (the Narkowicz fit of ACES), after its exposure
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
  'vec3 CustomToneMapping( vec3 color ) { return color; }',
  `vec3 CustomToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	return saturate( ( color * ( 2.51 * color + 0.03 ) ) / ( color * ( 2.43 * color + 0.59 ) + 0.14 ) );
}`,
);

const ES3D_FUNCTIONS = /* glsl */ `
uniform vec3 esSky;
uniform vec3 esGround;
uniform float esEnvIntensity;
// one light's contribution (ES3D shade()); radiance includes ES3D's factor of pi
vec3 esShade( vec3 N, vec3 V, vec3 L, vec3 radiance, float NdotV, vec3 f0, vec3 diffuse, float a ) {
	float NdotL = dot( N, L );
	if ( NdotL <= 0.0 ) return vec3( 0.0 );
	vec3 H = normalize( V + L );
	float NdotH = max( dot( N, H ), 0.0 );
	float VdotH = max( dot( V, H ), 0.0 );
	vec3 F = f0 + ( vec3( 1.0 ) - f0 ) * pow( 1.0 - VdotH, 5.0 );
	float a2 = a * a;
	float d = NdotH * NdotH * ( a2 - 1.0 ) + 1.0;
	float D = a2 / ( PI * d * d );
	float gv = NdotL * sqrt( NdotV * NdotV * ( 1.0 - a2 ) + a2 );
	float gl = NdotV * sqrt( NdotL * NdotL * ( 1.0 - a2 ) + a2 );
	float Vis = 0.5 / max( gv + gl, 1e-5 );
	vec3 kd = ( vec3( 1.0 ) - F ) * diffuse / PI;
	return ( kd + D * Vis * F ) * radiance * NdotL;
}
vec3 esEnvBRDF( vec3 f0, float roughness, float NdotV ) {
	const vec4 c0 = vec4( - 1.0, - 0.0275, - 0.572, 0.022 );
	const vec4 c1 = vec4( 1.0, 0.0425, 1.04, - 0.04 );
	vec4 r = roughness * c0 + c1;
	float a004 = min( r.x * r.x, exp2( - 9.28 * NdotV ) ) * r.x + r.y;
	vec2 AB = vec2( - 1.04, 1.04 ) * a004 + r.zw;
	return f0 * AB.x + AB.y;
}
`;

const ES3D_LIGHTING = /* glsl */ `
	// ES3D lighting: the lights, then the sky-and-ground environment and its reflection
	vec3 esN = normal;
	vec3 esV = normalize( vViewPosition );
	float esNdotV = max( dot( esN, esV ), 1e-4 );
	float esRough = clamp( roughnessFactor, 0.045, 1.0 );
	float esMetal = clamp( metalnessFactor, 0.0, 1.0 );
	float esA = esRough * esRough;
	vec3 esF0 = mix( vec3( 0.04 ), diffuseColor.rgb, esMetal );
	vec3 esDiffuse = diffuseColor.rgb * ( 1.0 - esMetal );
	vec3 esDirect = vec3( 0.0 );
	IncidentLight directLight;
	#if NUM_DIR_LIGHTS > 0
		DirectionalLight directionalLight;
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
			directionalLight = directionalLights[ i ];
			getDirectionalLightInfo( directionalLight, directLight );
			esDirect += esShade( esN, esV, directLight.direction, directLight.color, esNdotV, esF0, esDiffuse, esA );
		}
		#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHTS > 0
		PointLight pointLight;
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
			pointLight = pointLights[ i ];
			getPointLightInfo( pointLight, - vViewPosition, directLight );
			esDirect += esShade( esN, esV, directLight.direction, directLight.color, esNdotV, esF0, esDiffuse, esA );
		}
		#pragma unroll_loop_end
	#endif
	#if NUM_SPOT_LIGHTS > 0
		SpotLight spotLight;
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
			spotLight = spotLights[ i ];
			getSpotLightInfo( spotLight, - vViewPosition, directLight );
			esDirect += esShade( esN, esV, directLight.direction, directLight.color, esNdotV, esF0, esDiffuse, esA );
		}
		#pragma unroll_loop_end
	#endif
	vec3 esUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
	vec3 esHemi = mix( esGround, esSky, dot( esN, esUp ) * 0.5 + 0.5 ) * esEnvIntensity;
	vec3 esR = reflect( - esV, esN );
	vec3 esEnvSpec = mix( esGround, esSky, smoothstep( - 0.25 - esRough, 0.25 + esRough, dot( esR, esUp ) ) ) * esEnvIntensity;
	esEnvSpec = mix( esEnvSpec, esHemi, esRough * esRough );
	reflectedLight.directDiffuse += esDirect;
	reflectedLight.indirectDiffuse += esDiffuse * esHemi;
	reflectedLight.indirectSpecular += esEnvSpec * esEnvBRDF( esF0, esRough, esNdotV );
`;

const environment = {
  esSky: { value: new THREE.Color() },
  esGround: { value: new THREE.Color() },
  esEnvIntensity: { value: 0.5 },
};

/** Light a standard material the way ES3D does. */
function es3dShading(material) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, environment);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${ES3D_FUNCTIONS}`)
      .replace('#include <lights_physical_fragment>', '')
      .replace('#include <lights_fragment_begin>', ES3D_LIGHTING)
      .replace('#include <lights_fragment_maps>', '')
      .replace('#include <lights_fragment_end>', '');
  };
  material.customProgramCacheKey = () => 'es3d-lighting';
}

/** Lines are drawn a little towards the camera so they win against the surfaces they lie on (ES3D's line bias). */
function lineBias(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n\tmvPosition.xyz *= 0.9985;\n\tgl_Position = projectionMatrix * mvPosition;');
  };
  material.customProgramCacheKey = () => 'es3d-line-bias';
}

// ---------------------------------------------------------------------------
// Scroll timeline: page scroll -> 0..1, pinned to [data-es3d-stop] markers
// (the same rules as ES3D's ScrollTimeline, so both pages fly alike)

class ScrollTimeline {
  constructor(section, smoothing = 0.12) {
    this.section = section;
    this.smoothing = smoothing;
    this.reducedMotion = reducedMotion();
    this.value = NaN;
    this.target = 0;
    this.stale = true;
    this.markStale = () => (this.stale = true);
    addEventListener('scroll', this.markStale, { passive: true, capture: true });
    addEventListener('resize', this.markStale, { passive: true });
  }

  stops() {
    const els = [...this.section.querySelectorAll('[data-es3d-stop]')];
    return els.map((el, i) => {
      const raw = el.getAttribute('data-es3d-stop');
      const v = raw === null || raw.trim() === '' ? (els.length > 1 ? i / (els.length - 1) : 0) : Number(raw);
      return { el, value: Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0 };
    });
  }

  measure() {
    const vh = innerHeight || 1;
    const stops = this.stops();
    if (!stops.length) {
      const r = this.section.getBoundingClientRect();
      const range = r.height - vh;
      if (range <= 0) return r.top <= 0 ? 1 : 0;
      return Math.min(1, Math.max(0, -r.top / range));
    }
    const d = stops.map((s) => {
      const r = s.el.getBoundingClientRect();
      return r.top + r.height / 2 - vh / 2;
    });
    if (d[0] >= 0) return stops[0].value;
    const last = stops.length - 1;
    if (d[last] <= 0) return stops[last].value;
    let i = 0;
    while (i < last - 1 && d[i + 1] <= 0) i++;
    const u = d[i] === d[i + 1] ? 0 : -d[i] / (d[i + 1] - d[i]);
    if (this.reducedMotion) return u < 0.5 ? stops[i].value : stops[i + 1].value;
    return stops[i].value + (stops[i + 1].value - stops[i].value) * u;
  }

  dispose() {
    this.disposed = true;
    removeEventListener('scroll', this.markStale, { capture: true });
    removeEventListener('resize', this.markStale);
  }

  update(dt) {
    if (this.disposed) return false;
    if (this.stale) {
      this.stale = false;
      this.target = this.measure();
    }
    if (Number.isNaN(this.value) || this.reducedMotion || !(this.smoothing > 0)) {
      if (this.value === this.target) return false;
      this.value = this.target;
      return true;
    }
    const diff = this.target - this.value;
    if (diff === 0) return false;
    if (Math.abs(diff) < 1e-4) this.value = this.target;
    else this.value += diff * (1 - Math.exp(-Math.max(dt, 0) / this.smoothing));
    return true;
  }
}

/** Linear interpolation in a sampled track. */
function sampleTrack(times, values, t) {
  let lo = 0, hi = times.length - 1;
  if (t <= times[0]) return values[0];
  if (t >= times[hi]) return values[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const u = (t - times[lo]) / (times[hi] - times[lo]);
  return values[lo] + (values[hi] - values[lo]) * u;
}

// ---------------------------------------------------------------------------
// Instances: level of detail, culling, thinning and sorting per instance

const _m = new THREE.Matrix4();
const _s = new THREE.Sphere();

const _inv = new THREE.Matrix4();
const _local = new THREE.Frustum();
const _cam = new THREE.Vector3();

/**
 * The instances of one instanced glTF node, chosen every frame: culled one by
 * one against the view (as ES3D does), within their level of detail's
 * distances, ordered back to front when transparent. The tests run in the
 * node's own space, so a node that moves costs no more than one that does
 * not. The meshes of one node (a body of several materials) share one
 * instance buffer, which is uploaded only when the chosen instances change.
 */
class InstanceSet {
  constructor(node, meshes, detailFactor, givenIds = null) {
    this.node = node;
    this.meshes = meshes;
    const first = meshes[0];
    const extras = node.userData;
    this.lod = extras.lod || null;
    this.tess = extras.tess || null;
    this.sort = !!extras.sort;
    const total = first.count;
    const detail = first.geometry.getAttribute('_DETAIL');
    const ids = first.geometry.getAttribute('_ID');
    // the phone forest: instances past the factor are left out for good
    const kept = [];
    for (let i = 0; i < total; i++) if (!detail || detail.getX(i) <= detailFactor + 1e-6) kept.push(i);
    this.count = kept.length;
    this.source = new Float32Array(kept.length * 16);
    kept.forEach((i, k) => this.source.set(first.instanceMatrix.array.subarray(i * 16, i * 16 + 16), k * 16));
    this.ids = givenIds || (ids ? Float32Array.from(kept, (i) => ids.getX(i)) : null);
    this.slots = new Uint32Array(this.count); // drawn slot -> instance, for picking
    this.shown = -1; // instances in the buffer, for telling when it must change
    for (const mesh of meshes) {
      // the CPU has these; the GPU does not need them
      mesh.geometry.deleteAttribute('_DETAIL');
      mesh.geometry.deleteAttribute('_ID');
      if (mesh !== first) mesh.instanceMatrix = first.instanceMatrix;
      mesh.frustumCulled = false; // culled per instance below
      mesh.userData.instanceSet = this;
    }
    first.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // the body's bounding sphere, then each instance's, in the node's space
    const box = new THREE.Box3();
    for (const mesh of meshes) {
      mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox);
    }
    const body = box.getBoundingSphere(new THREE.Sphere());
    // quantize() folds each mesh's dequantization scale into its instances (unit)
    const unit = (this.lod && this.lod.unit) || (this.tess && this.tess.unit) || 1;
    const n = this.count;
    this.centers = new Float32Array(n * 3);
    this.radii = new Float32Array(n);
    this.scales = new Float32Array(n); // ES3D: a level's distances scale with the cube root of the placement's volume
    this.axes = new Float32Array(n); // and a tessellation's error with its longest axis
    const all = new THREE.Box3();
    const e = _m.elements;
    for (let i = 0; i < n; i++) {
      _m.fromArray(this.source, i * 16);
      _s.copy(body).applyMatrix4(_m);
      _s.center.toArray(this.centers, i * 3);
      this.radii[i] = _s.radius;
      all.expandByPoint(_s.center.clone().addScalar(_s.radius)).expandByPoint(_s.center.clone().addScalar(-_s.radius));
      this.scales[i] = (Math.cbrt(Math.abs(_m.determinant())) || 1) / unit;
      this.axes[i] = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])) / unit;
    }
    this.bounds = all.getBoundingSphere(new THREE.Sphere());
    this.order = new Uint32Array(n);
    this.depth = new Float32Array(n);
    this.identity = Uint32Array.from({ length: n }, (_, k) => k);
    this.sortIndex = new Uint32Array(n);
    this.sorted = new Uint32Array(n);
    this.world = new Float32Array(16);
    this.show(this.identity, n);
  }

  /** True when this node's world matrix moved since the last call. */
  worldChanged() {
    const e = this.meshes[0].matrixWorld.elements;
    const w = this.world;
    let changed = false;
    for (let i = 0; i < 16; i++) {
      if (w[i] !== e[i]) {
        w[i] = e[i];
        changed = true;
      }
    }
    return changed;
  }

  /**
   * The frustum and camera in the node's space, for this frame. Returns 1 when
   * every instance is in view, 0 when none is, -1 when each must be tested.
   */
  prepare(camera, frustum) {
    const world = this.meshes[0].matrixWorld;
    _inv.copy(world).invert();
    for (let k = 0; k < 6; k++) _local.planes[k].copy(frustum.planes[k]).applyMatrix4(_inv);
    this.camera = _cam.copy(camera.position).applyMatrix4(_inv);
    this.toWorld = Math.cbrt(Math.abs(world.determinant())) || 1; // node units to world units
    let inside = true;
    for (const plane of _local.planes) {
      const d = plane.distanceToPoint(this.bounds.center);
      if (d < -this.bounds.radius) return 0;
      if (d < this.bounds.radius) inside = false;
    }
    return inside ? 1 : -1;
  }

  /** Instance i against this frame's view (prepare first); sets this.distance in world units. */
  visible(i, test) {
    const C = this.centers;
    const x = C[i * 3], y = C[i * 3 + 1], z = C[i * 3 + 2];
    const dx = x - this.camera.x, dy = y - this.camera.y, dz = z - this.camera.z;
    this.distance = Math.sqrt(dx * dx + dy * dy + dz * dz) * this.toWorld;
    if (test === 1) return true;
    const r = this.radii[i];
    for (const plane of _local.planes) if (plane.normal.x * x + plane.normal.y * y + plane.normal.z * z + plane.constant < -r) return false;
    return true;
  }

  /** Draw instances list[0..n): uploads only when they differ from what is drawn. */
  show(list, n) {
    if (n === this.shown) {
      let same = true;
      for (let k = 0; k < n && same; k++) same = this.slots[k] === list[k];
      if (same) return;
    }
    const out = this.meshes[0].instanceMatrix;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      this.slots[k] = i;
      out.array.set(this.source.subarray(i * 16, i * 16 + 16), k * 16);
    }
    out.clearUpdateRanges();
    out.addUpdateRange(0, n * 16);
    out.needsUpdate = true;
    for (const mesh of this.meshes) mesh.count = n;
    this.shown = n;
  }

  /** Name list of a drawn instance. */
  idOf(slot) {
    return this.ids ? this.ids[this.slots[slot]] : undefined;
  }

  /** Choose and order this frame's instances. Returns the farthest drawn distance (for sorting). */
  update(camera, frustum) {
    const test = this.prepare(camera, frustum);
    if (test === 0) {
      this.show(this.identity, 0);
      return 0;
    }
    const lod = this.lod;
    if (test === 1 && !lod && !this.sort) {
      this.show(this.identity, this.count);
      return 0;
    }
    let n = 0;
    let farthest = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.visible(i, test)) continue;
      const d = this.distance;
      if (lod) {
        // ES3D: child c is shown from distances[c - 1] to distances[c], in the placement's units
        const k = this.scales[i] * this.toWorld;
        const D = lod.distances;
        if ((lod.child > 0 && d < D[lod.child - 1] * k) || (lod.child < D.length && d >= D[lod.child] * k)) continue;
      }
      this.order[n] = i;
      this.depth[n] = d;
      if (d > farthest) farthest = d;
      n++;
    }
    if (this.sort && n > 1) {
      // back to front, as ES3D draws its transparent instances
      const idx = this.sortIndex;
      const depth = this.depth;
      for (let k = 0; k < n; k++) idx[k] = k;
      const heap = (i, size) => {
        for (;;) {
          let m = i;
          const l = i * 2 + 1;
          const r = l + 1;
          if (l < size && depth[idx[l]] > depth[idx[m]]) m = l;
          if (r < size && depth[idx[r]] > depth[idx[m]]) m = r;
          if (m === i) return;
          const t = idx[i];
          idx[i] = idx[m];
          idx[m] = t;
          i = m;
        }
      };
      for (let i = (n >> 1) - 1; i >= 0; i--) heap(i, n);
      for (let end = n - 1; end > 0; end--) {
        const t = idx[0];
        idx[0] = idx[end];
        idx[end] = t;
        heap(0, end);
      }
      for (let a = 0, b = n - 1; a < b; a++, b--) {
        const t = idx[a];
        idx[a] = idx[b];
        idx[b] = t;
      }
      const sorted = this.sorted;
      const order = this.order;
      for (let k = 0; k < n; k++) sorted[k] = order[idx[k]];
      this.show(sorted, n);
    } else this.show(this.order, n);
    return farthest;
  }
}

/**
 * A curved shape at ES3D's tessellation levels: one InstanceSet per exported
 * level, the same instances in each. Every instance is drawn at the coarsest
 * level whose surface stays within a pixel of the true one (ES3D selectLod).
 */
class TessGroup {
  constructor(levels) {
    this.levels = levels; // by exported mesh index
    const t = levels[0].tess;
    this.map = t.map;
    this.deviation = t.deviation;
    this.lists = levels.map((l) => new Uint32Array(l.count));
  }

  update(camera, frustum, pixelsAtUnitDistance) {
    const base = this.levels[0];
    const test = base.prepare(camera, frustum);
    const counts = this.levels.map(() => 0);
    const D = this.deviation;
    if (test !== 0) {
      for (let i = 0; i < base.count; i++) {
        if (!base.visible(i, test)) continue;
        const k = (base.axes[i] * base.toWorld * pixelsAtUnitDistance) / Math.max(base.distance, 1e-6);
        let level = 0;
        for (let l = D.length - 1; l >= 1; l--) {
          if (D[l] * k <= 1) {
            level = l;
            break;
          }
        }
        const m = this.map[level];
        this.lists[m][counts[m]++] = i;
      }
    }
    this.levels.forEach((l, m) => l.show(this.lists[m], counts[m]));
  }
}

/**
 * MSFT_lod: the lower tessellation levels of a curved shape are nodes outside
 * the scene graph, without instances of their own. Each becomes an instanced
 * mesh beside the full-detail one, with its instances: the full detail's,
 * with its dequantization swapped for the level's (the level node's matrix).
 * Returns the levels of every shape: [[full, level 1, ...], ...].
 */
async function expandLevels(gltf) {
  const json = gltf.parser.json;
  const groups = [];
  const d0 = new THREE.Matrix4();
  const m = new THREE.Matrix4();
  for (const [index, def] of json.nodes.entries()) {
    const ids = def.extensions && def.extensions.MSFT_lod && def.extensions.MSFT_lod.ids;
    if (!ids) continue;
    const top = await gltf.parser.getDependency('node', index);
    const tess = top.userData.tess;
    d0.compose(new THREE.Vector3(...tess.dequant.translation), new THREE.Quaternion(), new THREE.Vector3().setScalar(tess.dequant.scale)).invert();
    const levels = [top];
    for (const id of ids) {
      const lower = await gltf.parser.getDependency('node', id);
      lower.updateMatrix();
      const mesh = new THREE.InstancedMesh(lower.geometry, lower.material, top.count);
      mesh.name = lower.name;
      top.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      for (let i = 0; i < top.count; i++) mesh.setMatrixAt(i, m.fromArray(top.instanceMatrix.array, i * 16).multiply(d0).multiply(lower.matrix));
      mesh.userData = { ...top.userData, tess: { ...tess, unit: tess.unit * lower.scale.x / tess.dequant.scale }, lowerLevel: true };
      top.parent.add(mesh);
      levels.push(mesh);
    }
    groups.push(levels);
  }
  return groups;
}

/**
 * Twinkling stars, motes and foam are instanced meshes with a morph target
 * whose weight is animated. three.js morphs an InstancedMesh only per instance
 * (morphTexture), so GLTFLoader gives these no influences and skips their
 * weight tracks. All instances pulse together: one shared influence does it.
 */
async function restorePulses(gltf) {
  const json = gltf.parser.json;
  for (const [a, def] of (json.animations || []).entries()) {
    for (const channel of def.channels) {
      if (channel.target.path !== 'weights') continue;
      const node = await gltf.parser.getDependency('node', channel.target.node);
      const sampler = def.samplers[channel.sampler];
      const [input, output] = await Promise.all([gltf.parser.getDependency('accessor', sampler.input), gltf.parser.getDependency('accessor', sampler.output)]);
      node.traverse((o) => {
        if (!o.isInstancedMesh || !o.geometry.morphAttributes.position || o.morphTargetInfluences) return;
        const rest = json.meshes[json.nodes[channel.target.node].mesh].weights || [0];
        o.morphTargetInfluences = rest.slice();
        o.morphTargetDictionary = { pulse: 0 };
        gltf.animations[a].tracks.push(new THREE.NumberKeyframeTrack(`${o.uuid}.morphTargetInfluences`, input.array, output.array));
      });
    }
    gltf.animations[a].resetDuration();
  }
}

// ---------------------------------------------------------------------------
// Explore: ES3D's <controls> limits and collision for three.js's OrbitControls

const DEG = Math.PI / 180;
const POLE = 1e-3;

/** Keep the target in its box and the camera within distance and angle limits (ES3D applyLimits). */
function applyLimits(position, target, limits) {
  const p = position, t = target;
  for (const k of ['x', 'y', 'z']) {
    const c = Math.min(limits.targetMax[k], Math.max(limits.targetMin[k], t[k]));
    p[k] += c - t[k];
    t[k] = c;
  }
  const off = p.clone().sub(t);
  const r = off.length();
  if (r < 1e-12) return;
  let phi = Math.acos(Math.max(-1, Math.min(1, off.y / r)));
  const theta = Math.atan2(off.x, off.z);
  phi = Math.min(Math.min(limits.maxPolar * DEG, Math.PI - POLE), Math.max(POLE, phi));
  const d = Math.min(limits.maxDistance, Math.max(limits.minDistance, r));
  const s = Math.sin(phi);
  p.set(t.x + d * s * Math.sin(theta), t.y + d * Math.cos(phi), t.z + d * s * Math.cos(theta));
}

// ---------------------------------------------------------------------------
// The stage

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {string} opts.url castle.glb
 * @param {HTMLElement} opts.scroll section whose scroll drives the flight
 * @param {number} [opts.detail] forest density, 0..1
 * @param {boolean} [opts.tall] portrait framing
 * @param {number} [opts.maxPixelRatio]
 * @param {(dt:number, stage:object) => void} [opts.onFrame]
 * @param {(hit: {names: string[]}|null) => void} [opts.onPick]
 */
export async function createGltfStage(canvas, opts) {
  const t0 = now();
  // Same raster setup ES3D asks its WebGL2 backend for: antialiasing, an opaque
  // canvas, and the high-performance GPU. No shadows and no logarithmic depth.
  // The page passes the same pixel-ratio cap the ES3D renderer uses.
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.CustomToneMapping;
  renderer.shadowMap.enabled = false;
  const maxPixelRatio = opts.maxPixelRatio ?? 2;
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  // load: download, then parse (meshopt decoding, images, scene building)
  const response = await fetch(opts.url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${opts.url}`);
  const bytes = await response.arrayBuffer();
  const t1 = now();
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(bytes, '');
  await restorePulses(gltf);
  const levelGroups = await expandLevels(gltf);
  const t2 = now();

  const scene = gltf.scene;
  const extras = scene.userData;
  const env = extras.environment;
  scene.background = new THREE.Color().setRGB(env.background[0], env.background[1], env.background[2], THREE.SRGBColorSpace);
  environment.esSky.value.setRGB(...env.sky, THREE.LinearSRGBColorSpace);
  environment.esGround.value.setRGB(...env.ground, THREE.LinearSRGBColorSpace);
  environment.esEnvIntensity.value = env.intensity;
  renderer.toneMappingExposure = env.exposure;

  // materials, cameras and instance sets
  const cameras = []; // the flight, then its portrait framing
  const instanceNodes = new Map();
  const transparent = [];
  const seen = new Set();
  scene.traverse((o) => {
    if (o.isCamera && o.userData.track) cameras.push(o);
    if (!o.isMesh && !o.isLine) return;
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of materials) {
      if (seen.has(m)) continue;
      seen.add(m);
      if (m.isMeshStandardMaterial) es3dShading(m);
      else if (m.isLineBasicMaterial) {
        m.toneMapped = false;
        lineBias(m);
      } else m.toneMapped = false; // unlit: ES3D draws its colour as it is
      // ES3D draws a transparent two-sided surface in one pass
      if (m.transparent && m.side === THREE.DoubleSide) m.forceSinglePass = true;
      for (const key of ['map', 'normalMap']) if (m[key]) m[key].anisotropy = anisotropy;
    }
    if (o.material.transparent) transparent.push(o);
    if (o.isInstancedMesh && !o.userData.lowerLevel) {
      // the glTF node: the mesh itself, or for a mesh of several primitives the group holding them
      const assoc = gltf.parser.associations.get(o);
      const node = assoc && assoc.nodes !== undefined ? o : o.parent;
      if (!instanceNodes.has(node)) instanceNodes.set(node, []);
      instanceNodes.get(node).push(o);
    }
  });
  const detailFactor = opts.detail > 0 && opts.detail < 1 ? opts.detail : 1;
  // what the animations move
  const moved = new Set();
  for (const clip of gltf.animations) {
    for (const track of clip.tracks) {
      const target = THREE.PropertyBinding.findNode(scene, THREE.PropertyBinding.parseTrackName(track.name).nodeName);
      if (target) moved.add(target);
    }
  }
  // what never moves keeps its matrices: three.js need not recompose them every frame
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!moved.has(o) && !o.isCamera) o.matrixAutoUpdate = false;
  });
  const sets = [];
  const setOf = new Map();
  for (const [node, meshes] of instanceNodes) {
    const set = new InstanceSet(node, meshes, detailFactor);
    sets.push(set);
    setOf.set(meshes[0], set);
  }
  const tessGroups = levelGroups.map((levels) => {
    const full = setOf.get(levels[0]);
    const lower = levels.slice(1).map((mesh) => new InstanceSet(mesh, [mesh], 1, full.ids));
    sets.push(...lower);
    return new TessGroup([full, ...lower]);
  });
  const sortSets = sets.filter((s) => s.sort);
  const plainSets = sets.filter((s) => !s.sort && !s.tess);

  // animations: clock ones loop from their begin time, the scroll one follows the page
  const mixer = new THREE.AnimationMixer(scene);
  const scrollMixer = new THREE.AnimationMixer(scene);
  let scrollAction = null;
  const clockActions = [];
  const json = gltf.parser.json;
  gltf.animations.forEach((clip, i) => {
    const info = (json.animations[i] && json.animations[i].extras) || {};
    if (info.timeline === 'scroll') {
      scrollAction = scrollMixer.clipAction(clip);
      scrollAction.setLoop(THREE.LoopOnce, 1);
      scrollAction.clampWhenFinished = true;
      scrollAction.play();
      scrollAction.paused = true;
    } else {
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      if (info.begin > 0) action.startAt(info.begin);
      action.play();
      clockActions.push({ action, begin: info.begin || 0 });
    }
  });

  // the camera the page sees, fitted from the flight camera every frame
  const view = new THREE.PerspectiveCamera();
  let flight = cameras[0];
  const setFraming = (tall) => {
    flight = (tall && cameras[1]) || cameras[0];
  };
  setFraming(opts.tall);
  const fitFov = (cam, fov, aspect) => {
    // ES3D <camera fit="cover">: the reference view fills the screen
    const A = cam.userData.aspect || 1;
    const s = cam.userData.fit === 'cover' ? Math.min(1, A / aspect) : Math.max(1, A / aspect);
    return (2 * Math.atan(Math.tan((fov * DEG) / 2) * s)) / DEG;
  };

  const state = {
    time: 0,
    progress: 0,
    playing: !reducedMotion(),
    width: 0,
    height: 0,
    onScreen: true,
    exploring: false,
    disposed: false,
    last: 0,
  };
  const timeline = new ScrollTimeline(opts.scroll);
  timeline.update(0);
  state.progress = timeline.value;

  const applyScroll = () => {
    if (!scrollAction) return;
    scrollAction.time = state.progress;
    scrollMixer.update(0);
  };
  applyScroll();

  const parent = canvas.parentElement;
  const resize = (w, h) => {
    if (w === state.width && h === state.height) return;
    state.width = w;
    state.height = h;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, maxPixelRatio));
    renderer.setSize(w, h);
  };
  resize(parent.clientWidth, parent.clientHeight);
  const ro = new ResizeObserver(([entry]) => {
    const box = entry.contentBoxSize && entry.contentBoxSize[0];
    resize(Math.round(box ? box.inlineSize : entry.contentRect.width), Math.round(box ? box.blockSize : entry.contentRect.height));
  });
  ro.observe(parent);
  const io = new IntersectionObserver(([entry]) => (state.onScreen = entry.isIntersecting), { threshold: 0.02 });
  io.observe(parent);

  const updateFlightCamera = () => {
    flight.updateMatrixWorld();
    view.position.setFromMatrixPosition(flight.matrixWorld);
    view.quaternion.setFromRotationMatrix(flight.matrixWorld);
    const track = flight.userData.track;
    view.fov = fitFov(flight, sampleTrack(track.times, track.fov, state.progress), state.width / Math.max(1, state.height));
    view.near = flight.near;
    view.far = flight.far;
  };

  // per-frame instance work and transparent ordering
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const depthOf = new Map();
  const _c = new THREE.Vector3();
  const camNow = new Float64Array(11);
  const camWas = new Float64Array(11);
  let camSeen = false;
  const plainOn = new Uint8Array(plainSets.length);
  const tessOn = new Uint8Array(tessGroups.length);
  const sortOn = new Uint8Array(sortSets.length);
  // The camera, in the same values ES3D's stage watches. A settled view does
  // not recull tens of thousands of instances while the clock animations run.
  const cameraMoved = () => {
    const p = view.position;
    const q = view.quaternion;
    camNow[0] = p.x; camNow[1] = p.y; camNow[2] = p.z;
    camNow[3] = q.x; camNow[4] = q.y; camNow[5] = q.z; camNow[6] = q.w;
    camNow[7] = view.fov; camNow[8] = view.aspect; camNow[9] = view.near; camNow[10] = view.far;
    let moved = !camSeen;
    for (let i = 0; i < 11; i++) {
      if (camWas[i] !== camNow[i]) moved = true;
      camWas[i] = camNow[i];
    }
    camSeen = true;
    return moved;
  };
  const prepareInstances = () => {
    view.updateMatrixWorld();
    const moved = cameraMoved();
    let any = false;
    for (let i = 0; i < plainSets.length; i++) {
      plainOn[i] = moved || plainSets[i].worldChanged() ? 1 : 0;
      if (plainOn[i]) any = true;
    }
    for (let i = 0; i < tessGroups.length; i++) {
      tessOn[i] = moved || tessGroups[i].levels[0].worldChanged() ? 1 : 0;
      if (tessOn[i]) any = true;
    }
    for (let i = 0; i < sortSets.length; i++) {
      sortOn[i] = moved || sortSets[i].worldChanged() ? 1 : 0;
      if (sortOn[i]) any = true;
    }
    if (any) {
      projScreen.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreen);
      for (let i = 0; i < plainSets.length; i++) if (plainOn[i]) plainSets[i].update(view, frustum);
      // pixels per world unit at distance 1, in CSS pixels as ES3D measures it
      const pixelsAtUnitDistance = state.height / (2 * Math.tan((view.fov * DEG) / 2));
      for (let i = 0; i < tessGroups.length; i++) if (tessOn[i]) tessGroups[i].update(view, frustum, pixelsAtUnitDistance);
      // ES3D draws transparent batches farthest first, instances back to front
      for (let i = 0; i < sortSets.length; i++) {
        if (!sortOn[i]) continue;
        const depth = sortSets[i].update(view, frustum);
        for (const mesh of sortSets[i].meshes) depthOf.set(mesh, depth);
      }
    }
    for (const o of transparent) {
      if (o.userData.instanceSet && o.userData.instanceSet.sort) continue;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      _c.copy(o.geometry.boundingSphere.center).applyMatrix4(o.matrixWorld);
      depthOf.set(o, _c.distanceTo(view.position));
    }
    transparent.sort((a, b) => (depthOf.get(b) || 0) - (depthOf.get(a) || 0));
    transparent.forEach((o, i) => (o.renderOrder = i + 1));
  };

  // -- explore: orbit with limits and collision, click to name

  const limits = {
    minDistance: 16,
    maxDistance: 780,
    maxPolar: 88,
    targetMin: new THREE.Vector3(-170, 10, -170),
    targetMax: new THREE.Vector3(170, 230, 170),
  };
  const b = extras.bounds;
  const sceneRadius = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 || 1;
  // Orbit and the collision tree load on the first explore, so the flight
  // does not parse them. Their wheel listener stays off until then.
  let controls = null;
  let arming = null;
  const colliders = [];
  scene.traverse((o) => {
    if (o.isMesh && o.userData.collide !== false && !(o.parent && o.parent.userData.collide === false)) colliders.push(o);
  });
  const armExplore = () => {
    if (controls) return Promise.resolve(controls);
    if (arming) return arming;
    arming = Promise.all([
      import('three/examples/jsm/controls/OrbitControls.js'),
      import('three-mesh-bvh'),
    ]).then(([{ OrbitControls }, bvh]) => {
      THREE.BufferGeometry.prototype.computeBoundsTree = bvh.computeBoundsTree;
      THREE.Mesh.prototype.raycast = bvh.acceleratedRaycast;
      const geometries = new Set();
      scene.traverse((o) => {
        if (o.isMesh && !o.isLine) geometries.add(o.geometry);
      });
      for (const g of geometries) if (!g.boundsTree && !g.morphAttributes.position) g.computeBoundsTree();
      const orbit = new OrbitControls(view, canvas);
      orbit.disconnect();
      orbit.enabled = false;
      orbit.enableDamping = false;
      orbit.rotateSpeed = 0.75;
      orbit.minDistance = limits.minDistance;
      orbit.maxDistance = limits.maxDistance;
      orbit.maxPolarAngle = limits.maxPolar * DEG;
      orbit.addEventListener('start', () => (before = { position: view.position.clone(), target: orbit.target.clone() }));
      orbit.addEventListener('change', onOrbit);
      controls = orbit;
      return orbit;
    });
    return arming;
  };
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const _n = new THREE.Vector3();
  const _nm = new THREE.Matrix3();
  /** First front-facing hit along a move (ES3D sweepCamera: only surfaces facing the camera block it). */
  const sweep = (from, to) => {
    const move = to.clone().sub(from);
    const len = move.length();
    if (len < 1e-9) return to;
    const margin = Math.max(view.near * 2, sceneRadius * 0.01);
    let start = from.clone();
    let rest = move.clone();
    for (let pass = 0; pass < 2; pass++) {
      const l = rest.length();
      if (l < 1e-9) break;
      const dir = rest.clone().divideScalar(l);
      raycaster.set(start, dir);
      raycaster.far = l + margin * 4;
      raycaster.firstHitOnly = false;
      const hits = raycaster.intersectObjects(colliders, false);
      let hit = null;
      for (const h of hits) {
        if (!h.face) continue;
        _nm.getNormalMatrix(h.instanceId !== undefined ? _m.fromArray(h.object.instanceMatrix.array, h.instanceId * 16).premultiply(h.object.matrixWorld) : h.object.matrixWorld);
        _n.copy(h.face.normal).applyMatrix3(_nm).normalize();
        if (_n.dot(dir) < 0) {
          hit = { distance: h.distance, normal: _n.clone() };
          break;
        }
      }
      const cos = hit ? Math.abs(dir.dot(hit.normal)) : 0;
      const allowed = hit ? Math.max(0, hit.distance - margin / Math.max(cos, 0.25)) : l;
      const s = Math.min(1, allowed / l);
      start.addScaledVector(rest, s);
      if (s >= 1) break;
      rest.multiplyScalar(1 - s);
      rest.addScaledVector(hit.normal, -rest.dot(hit.normal));
    }
    return start;
  };
  let before = null;
  const onOrbit = () => {
    if (!state.exploring || !controls) return;
    const prev = before || { position: view.position.clone(), target: controls.target.clone() };
    applyLimits(view.position, controls.target, limits);
    const stopped = sweep(prev.position, view.position);
    if (!stopped.equals(view.position)) {
      const shift = stopped.clone().sub(view.position);
      view.position.copy(stopped);
      // a pan moves both: keep the view direction
      if (prev.target.distanceTo(controls.target) > 1e-6) controls.target.add(shift);
    }
    view.lookAt(controls.target);
    before = { position: view.position.clone(), target: controls.target.clone() };
  };

  // clicks (not drags) pick
  let down = null;
  const onDown = (e) => (down = { x: e.clientX, y: e.clientY });
  const onUp = (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 4 || e.button !== 0) return;
    down = null;
    if (opts.onPick) opts.onPick(pick(e.clientX, e.clientY));
  };
  const names = extras.names;
  const pick = (x, y) => {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, view);
    raycaster.far = Infinity;
    raycaster.firstHitOnly = true;
    const pickable = [];
    scene.traverseVisible((o) => {
      if (o.isMesh) pickable.push(o);
    });
    const hits = raycaster.intersectObjects(pickable, false);
    hits.sort((a, c) => a.distance - c.distance);
    const h = hits[0];
    if (!h) return null;
    // the name list: per vertex of a merged mesh, per instance, or for the node
    let id = h.object.userData.id ?? h.object.parent?.userData.id;
    const set = h.object.userData.instanceSet;
    if (set && h.instanceId !== undefined && set.idOf(h.instanceId) !== undefined) id = set.idOf(h.instanceId);
    const vid = h.object.geometry.getAttribute('_id');
    if (vid && h.face) id = vid.getX(h.face.a);
    return id === undefined ? null : { names: names[id], point: h.point };
  };

  let exploreGen = 0;
  const explore = (on) => {
    if (on === state.exploring) return;
    state.exploring = on;
    const gen = ++exploreGen;
    if (!on) {
      if (controls) {
        controls.enabled = false;
        controls.disconnect();
      }
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      return;
    }
    armExplore().then((orbit) => {
      if (gen !== exploreGen || !state.exploring) return;
      // orbit about the flight's look-at target from where the flight is now
      updateFlightCamera();
      const track = flight.userData.track;
      const distance = sampleTrack(track.times, track.distance, state.progress);
      orbit.target.copy(view.position).add(new THREE.Vector3(0, 0, -1).applyQuaternion(view.quaternion).multiplyScalar(distance));
      orbit.connect(canvas);
      orbit.enabled = true;
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointerup', onUp);
      // no update() here: like ES3D, the limits apply from the first move, so the view does not jump
    });
  };

  // -- frames

  const stats = { drawCalls: 0, triangles: 0, cpuMs: 0 };
  const api = {
    renderer,
    scene,
    camera: view,
    kind: 'webgl2',
    stats,
    gltf,
    load: { bytes: bytes.byteLength, fetchMs: t1 - t0, parseMs: t2 - t1, readyMs: 0 },
    /** Scroll progress 0..1; setting it drives the flight without the page (as ES3D's stage does). */
    get progress() {
      return state.progress;
    },
    set progress(v) {
      timeline.dispose();
      state.progress = Math.min(1, Math.max(0, v));
      applyScroll();
    },
    get playing() {
      return state.playing;
    },
    set playing(v) {
      state.playing = !!v;
    },
    get time() {
      return state.time;
    },
    set time(v) {
      // the clock at v, each animation from its own begin time
      state.time = v;
      for (const { action, begin } of clockActions) {
        action.reset().play();
        if (v < begin) action.startAt(mixer.time + begin - v);
        else action.time = (v - begin) % action.getClip().duration;
      }
      mixer.update(0);
    },
    setFraming,
    explore,
    pick,
    instances: extras.instances,
    geometries: extras.geometries,
    dispose() {
      state.disposed = true;
      ro.disconnect();
      io.disconnect();
      if (controls) controls.dispose();
      renderer.dispose();
    },
  };

  const render = () => {
    const c0 = now();
    if (!state.exploring) updateFlightCamera();
    view.aspect = state.width / Math.max(1, state.height);
    view.updateProjectionMatrix();
    prepareInstances();
    renderer.render(scene, view);
    stats.cpuMs = now() - c0;
    stats.drawCalls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
  };

  // shaders compile before the first frame, as ES3D's do on first use
  updateFlightCamera();
  view.aspect = state.width / Math.max(1, state.height);
  view.updateProjectionMatrix();
  await renderer.compileAsync(scene, view);
  render();
  api.load.readyMs = now() - t0;

  const frame = (t) => {
    if (state.disposed) return;
    requestAnimationFrame(frame);
    const dt = state.last ? Math.min(0.05, (t - state.last) / 1000) : 0;
    state.last = t;
    if (!state.onScreen || !state.width || !state.height) return;
    const dpr = Math.min(devicePixelRatio || 1, maxPixelRatio);
    if (dpr !== renderer.getPixelRatio()) renderer.setPixelRatio(dpr);
    if (state.playing) {
      state.time += dt;
      mixer.update(dt);
    }
    if (timeline.update(dt)) {
      state.progress = timeline.value;
      applyScroll();
    }
    if (opts.onFrame) opts.onFrame(dt, api);
    render();
  };
  requestAnimationFrame(frame);
  return api;
}
