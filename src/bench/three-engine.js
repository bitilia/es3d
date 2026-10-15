// Reference engine for the benchmark: three.js, the renderer most web pages
// that show glTF use, loaded only when a three.js format is measured (it is
// a dev dependency of this repository, never part of the ES3D package).
//
// It measures the same steps as the ES3D renderer does: load (parse into
// the engine's scene), first frame (GPU upload, shader compilation, drawing,
// waiting for the GPU) and the frames while the camera orbits. Two inputs:
//
// - GLB, parsed by three.js's GLTFLoader (EXT_mesh_gpu_instancing becomes
//   InstancedMesh): glTF as a page would really consume it;
// - ES3D, compiled by this project's reader and handed to three.js as
//   BufferGeometry and InstancedMesh (finest level only: three.js has no
//   automatic level of detail): the format without our renderer.
//
// Together with the ES3D and GLB rows of our own renderer, that separates
// what the format costs from what the engine costs. Both engines draw the
// same materials, textures, lights and sky (GLB files carry no lights and no
// procedural textures, so three.js gets the ES3D scene's, as our renderer
// does): MeshStandardMaterial, 8x anisotropic filtering, ACES tone mapping.

import { DEFAULT_LIGHTS } from '../render/lighting.js';
import { texturePixels } from '../render/textures.js';

let THREE = null;
let GLTFLoaderClass = null;
let WEBGPU = null;

async function three() {
  if (!THREE) {
    THREE = await import('three');
    ({ GLTFLoader: GLTFLoaderClass } = await import('three/addons/loaders/GLTFLoader.js'));
  }
  return THREE;
}

/**
 * A three.js renderer on its own canvas, the same size as `beside`, inserted
 * after it. `backend` 'webgl2' uses WebGLRenderer, 'webgpu' three's
 * WebGPURenderer on the given GPUDevice (the ES3D renderer's: one device per
 * page, as an application would have; `kind` says what three.js ended up on).
 */
export async function createThreeEngine(beside, backend, width, height, device) {
  const T = await three();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.display = 'none';
  canvas.className = beside.className;
  beside.after(canvas);
  let renderer, kind, finish;
  if (backend === 'webgpu') {
    identitySwizzleShim();
    WEBGPU = WEBGPU || (await import('three/webgpu'));
    renderer = new WEBGPU.WebGPURenderer({ canvas, antialias: true, device });
    await renderer.init();
    kind = renderer.backend && renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
    const gpu = renderer.backend && renderer.backend.device;
    finish = gpu ? () => gpu.queue.onSubmittedWorkDone() : () => readPixel(renderer.getContext && renderer.getContext());
  } else {
    renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    kind = 'webgl2';
    const gl = renderer.getContext();
    finish = () => readPixel(gl);
  }
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.outputColorSpace = T.SRGBColorSpace;
  const info = () => renderer.info.render;
  // multisampling the browser granted three.js (ours always draws with 4x)
  let msaaSamples = 4;
  if (kind === 'webgl2' && renderer.getContext) {
    const gl = renderer.getContext();
    if (gl && gl.getParameter) msaaSamples = gl.getParameter(gl.SAMPLES) || 1;
  }
  return {
    kind,
    msaaSamples,
    canvas,
    renderer,
    async finish() {
      await finish();
    },
    show(on) {
      canvas.style.display = on ? '' : 'none';
      beside.style.display = on ? 'none' : '';
    },
    stats: () => ({ drawCalls: info().calls || info().drawCalls || 0, triangles: info().triangles || 0 }),
    dispose() {
      renderer.dispose();
      canvas.remove();
      beside.style.display = '';
    },
  };
}

/**
 * three.js asks for texture views with `swizzle: 'rgba'` (the identity, as in
 * the current WebGPU specification); browsers that implement an earlier
 * draft reject the field. Leave it out there: the identity is the default.
 */
function identitySwizzleShim() {
  if (typeof GPUTexture === 'undefined' || GPUTexture.prototype.createView.identitySwizzleShim) return;
  const createView = GPUTexture.prototype.createView;
  let drop = false;
  const shim = function (descriptor) {
    if (descriptor && descriptor.swizzle === 'rgba') {
      if (drop) return createView.call(this, { ...descriptor, swizzle: undefined });
      try {
        return createView.call(this, descriptor);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        drop = true;
        return createView.call(this, { ...descriptor, swizzle: undefined });
      }
    }
    return createView.call(this, descriptor);
  };
  shim.identitySwizzleShim = true;
  GPUTexture.prototype.createView = shim;
}

function readPixel(gl) {
  // reading one pixel waits until the GPU has finished drawing (gl.finish() may not)
  if (gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
}

/** Parse a GLB with three.js's GLTFLoader. */
export async function glbToThree(bytes) {
  await three();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise((resolve, reject) => new GLTFLoaderClass().parse(buffer, '', resolve, reject));
  return gltf.scene;
}

/**
 * A compiled ES3D scene as three.js objects: one BufferGeometry per used
 * mesh (finest level), one InstancedMesh per (geometry, material, mirrored).
 */
export function es3dToThree(scene, meshOf, instances) {
  const T = THREE;
  const root = new T.Group();
  const geometries = new Map();
  const materials = new Map();
  const groups = new Map();
  for (const i of instances) {
    const gi = scene.geom[i], mi = scene.mat[i], mirrored = scene.flags[i] & 1;
    const key = (gi * scene.materials.length + mi) * 2 + mirrored;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { gi, mi, mirrored, list: [] }));
    g.list.push(i);
  }
  for (const g of groups.values()) {
    const entry = scene.geometries[g.gi];
    let geometry = geometries.get(g.gi);
    if (!geometry) {
      const m = meshOf(entry, 0);
      geometry = new T.BufferGeometry();
      geometry.setAttribute('position', new T.BufferAttribute(m.positions, 3));
      geometry.setAttribute('normal', new T.BufferAttribute(m.normals, 3));
      geometry.setAttribute('uv', new T.BufferAttribute(m.uvs, 2));
      geometry.setIndex(new T.BufferAttribute(m.indices, 1));
      geometry.userData.lines = m.kind === 'lines';
      geometries.set(g.gi, geometry);
    }
    const mk = `${g.mi}|${entry.doubleSided ? 2 : g.mirrored}`;
    let material = materials.get(mk);
    if (!material) {
      material = threeMaterial(scene.materials[g.mi], entry.doubleSided ? T.DoubleSide : g.mirrored ? T.BackSide : T.FrontSide);
      materials.set(mk, material);
    }
    if (geometry.userData.lines) {
      for (const i of g.list) {
        const line = new T.LineSegments(geometry, new T.LineBasicMaterial({ color: material.color }));
        line.matrixAutoUpdate = false;
        line.matrix.fromArray(scene.matrices, i * 16);
        root.add(line);
      }
      continue;
    }
    const mesh = new T.InstancedMesh(geometry, material, g.list.length);
    const m4 = new T.Matrix4();
    g.list.forEach((i, k) => mesh.setMatrixAt(k, m4.fromArray(scene.matrices, i * 16)));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    root.add(mesh);
  }
  return root;
}

// a texture per use: the repeat is part of the three.js texture, the uv scale part of the ES3D material
const textureKey = (spec, kind, m) => `${kind}:${spec.key}:${m.uvScale[0]},${m.uvScale[1]}`;

/** An ES3D material as MeshStandardMaterial, with its textures (from threeTextures). */
export function threeMaterial(m, side, textures) {
  const T = THREE;
  const tex = (spec, kind) => (spec && textures ? textures.get(textureKey(spec, kind, m)) || null : null);
  const material = new T.MeshStandardMaterial({
    color: new T.Color().setRGB(m.baseColor[0], m.baseColor[1], m.baseColor[2], T.LinearSRGBColorSpace),
    metalness: m.metallic,
    roughness: m.roughness,
    emissive: new T.Color().setRGB(m.emissive[0], m.emissive[1], m.emissive[2], T.LinearSRGBColorSpace),
    map: tex(m.map, 'color'),
    normalMap: tex(m.normalMap, 'normal'),
    roughnessMap: tex(m.metallicRoughnessMap, 'linear'),
    metalnessMap: tex(m.metallicRoughnessMap, 'linear'),
    aoMap: tex(m.occlusionMap, 'linear'),
    emissiveMap: tex(m.emissiveMap, 'color'),
    side,
  });
  if (material.normalMap) material.normalScale.set(m.normalScale, m.normalScale);
  if (material.aoMap) material.aoMapIntensity = m.occlusionStrength ?? 1;
  if (m.alphaMode === 'mask') material.alphaTest = m.alphaCutoff ?? 0.5;
  if (m.transparent) {
    material.transparent = true;
    material.opacity = m.opacity;
  }
  material.userData.es3d = m;
  return material;
}

/**
 * three.js textures for the maps of these ES3D materials, generated the way
 * our renderer generates them. Not part of a timed load: both engines make
 * textures alike.
 */
export async function threeTextures(materials, renderer) {
  const T = THREE;
  const out = new Map();
  const maxAniso = renderer.capabilities && renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 8;
  for (const m of materials) {
    for (const [spec, kind] of [[m.map, 'color'], [m.normalMap, 'normal'], [m.metallicRoughnessMap, 'linear'], [m.occlusionMap, 'linear'], [m.emissiveMap, 'color']]) {
      if (!spec || out.has(textureKey(spec, kind, m))) continue;
      const px = await texturePixels(spec, kind).catch(() => null);
      if (!px) continue;
      const data = px.data instanceof Uint8Array ? px.data : new Uint8Array(px.data.buffer, px.data.byteOffset, px.data.byteLength);
      const t = new T.DataTexture(data, px.width, px.height, T.RGBAFormat);
      t.colorSpace = kind === 'color' ? T.SRGBColorSpace : T.NoColorSpace;
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.repeat.set(m.uvScale[0], m.uvScale[1]);
      t.magFilter = T.LinearFilter;
      t.minFilter = T.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = Math.min(8, maxAniso);
      t.needsUpdate = true;
      out.set(textureKey(spec, kind, m), t);
    }
  }
  return out;
}

/** The ES3D scene's lights (or the renderer's defaults) and sky light, as three.js lights. */
export function threeLights(lights, environment) {
  const T = THREE;
  const out = [];
  if (!lights || !lights.length) lights = DEFAULT_LIGHTS;
  const color = (c) => {
    const k = Math.max(c[0], c[1], c[2], 1e-6);
    return [new T.Color().setRGB(c[0] / k, c[1] / k, c[2] / k, T.LinearSRGBColorSpace), k];
  };
  for (const l of lights) {
    const [c, intensity] = color(l.color);
    if (l.type === 'directional') {
      const d = new T.DirectionalLight(c, intensity * Math.PI);
      d.position.set(-l.direction[0] * 100, -l.direction[1] * 100, -l.direction[2] * 100);
      out.push(d);
    } else if (l.type === 'point') {
      const p = new T.PointLight(c, intensity * Math.PI * 4, l.range || 0, 2);
      p.position.fromArray(l.position);
      out.push(p);
    } else if (l.type === 'spot') {
      const s = new T.SpotLight(c, intensity * Math.PI * 4, l.range || 0, Math.acos(l.outer), 1 - l.inner / Math.max(l.outer, 1e-6), 2);
      s.position.fromArray(l.position);
      s.target.position.set(l.position[0] + l.direction[0], l.position[1] + l.direction[1], l.position[2] + l.direction[2]);
      out.push(s, s.target);
    } else if (l.type === 'hemisphere' || l.type === 'ambient') {
      const [g] = color(l.ground || l.color);
      out.push(new T.HemisphereLight(c, g, intensity));
    }
  }
  if (environment) {
    const sky = environment.sky, ground = environment.ground;
    out.push(new T.HemisphereLight(new T.Color().setRGB(sky[0], sky[1], sky[2], T.SRGBColorSpace), new T.Color().setRGB(ground[0], ground[1], ground[2], T.SRGBColorSpace), environment.intensity * Math.PI));
  }
  return out;
}

/** A three.js camera that frames exactly like an ES3D camera (its matrices are copied). */
export function threeCamera() {
  const cam = new THREE.PerspectiveCamera();
  cam.matrixAutoUpdate = false;
  cam.matrixWorldAutoUpdate = false;
  return cam;
}

const inverse = (m) => new THREE.Matrix4().fromArray(m).invert();

/** Copy an updated ES3D Camera (view and projection matrices) into a three.js camera. */
export function syncCamera(cam, es3dCamera) {
  cam.projectionMatrix.fromArray(es3dCamera.proj);
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  cam.matrixWorldInverse.fromArray(es3dCamera.view);
  cam.matrixWorld.copy(inverse(es3dCamera.view));
  cam.matrix.copy(cam.matrixWorld);
}

/** Bytes of vertex and index data a three.js scene sends to the GPU. */
export function threeGeometryBytes(root) {
  const seen = new Set();
  let bytes = 0;
  root.traverse((o) => {
    if (o.isInstancedMesh) bytes += o.count * 64;
    const g = o.geometry;
    if (!g || seen.has(g)) return;
    seen.add(g);
    for (const a of Object.values(g.attributes)) bytes += a.array.byteLength;
    if (g.index) bytes += g.index.array.byteLength;
  });
  return bytes;
}
