// Packing of per-frame uniforms (camera, environment and lights) into the
// layout shared by the GLSL uniform block and the WGSL uniform struct:
//
//   mat4 viewProj; mat4 view; vec4 cameraPos(time); vec4 sky(envIntensity);
//   vec4 ground(exposure); vec4 params(lightCount, normalLength, lineBias, viewportH);
//   vec4 lightPos[16]   xyz = position, w = type (0 dir, 1 point, 2 spot, 3 ambient, 4 hemisphere)
//   vec4 lightDir[16]   xyz = direction, w = range
//   vec4 lightColor[16] rgb = color * intensity, w = cos(outer cone)
//   vec4 lightExtra[16] x = cos(inner cone), yzw = hemisphere ground color

import { colorToLinear } from '../format/colors.js';

export const MAX_LIGHTS = 16;
export const FRAME_FLOATS = 48 + MAX_LIGHTS * 16;
export const FRAME_BYTES = FRAME_FLOATS * 4;

const TYPE_CODE = { directional: 0, point: 1, spot: 2, ambient: 3, hemisphere: 4 };

/** Lights used when a document defines none: a key and a fill light. */
// Light intensity convention: a white directional light of intensity 1 lights a
// white diffuse surface it faces head-on to full brightness (radiance * PI in the shader).
export const DEFAULT_LIGHTS = [
  { type: 'directional', color: [1.1, 1.08, 1.04], direction: norm([-0.45, -0.85, -0.35]), position: [0, 0, 0], range: 0, outer: 0, inner: 0, ground: [0, 0, 0] },
  { type: 'directional', color: [0.22, 0.25, 0.32], direction: norm([0.6, -0.2, 0.75]), position: [0, 0, 0], range: 0, outer: 0, inner: 0, ground: [0, 0, 0] },
];

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * @returns {{data: Float32Array, lightCount: number, truncated: number}}
 */
export function packFrameUniforms(out, { viewProj, view, cameraPos, time, environment, lights, normalLength = 0.1, lineBias = 0.0015, viewportHeight = 1 }) {
  out.fill(0);
  out.set(viewProj, 0);
  out.set(view, 16);
  out[32] = cameraPos[0];
  out[33] = cameraPos[1];
  out[34] = cameraPos[2];
  out[35] = time || 0;
  const sky = colorToLinear(environment.sky);
  const ground = colorToLinear(environment.ground);
  out[36] = sky[0];
  out[37] = sky[1];
  out[38] = sky[2];
  out[39] = environment.intensity;
  out[40] = ground[0];
  out[41] = ground[1];
  out[42] = ground[2];
  out[43] = environment.exposure;
  const list = lights && lights.length ? lights : DEFAULT_LIGHTS;
  const count = Math.min(list.length, MAX_LIGHTS);
  out[44] = count;
  out[45] = normalLength;
  out[46] = lineBias;
  out[47] = viewportHeight;
  for (let i = 0; i < count; i++) {
    const l = list[i];
    const p = 48 + i * 4;
    const d = 48 + MAX_LIGHTS * 4 + i * 4;
    const c = 48 + MAX_LIGHTS * 8 + i * 4;
    const e = 48 + MAX_LIGHTS * 12 + i * 4;
    out[p] = l.position[0];
    out[p + 1] = l.position[1];
    out[p + 2] = l.position[2];
    out[p + 3] = TYPE_CODE[l.type] ?? 0;
    out[d] = l.direction[0];
    out[d + 1] = l.direction[1];
    out[d + 2] = l.direction[2];
    out[d + 3] = l.range || 0;
    out[c] = l.color[0];
    out[c + 1] = l.color[1];
    out[c + 2] = l.color[2];
    out[c + 3] = l.outer || 0;
    // smoothstep needs edge0 < edge1: keep the inner cone strictly inside the outer one
    out[e] = Math.max(l.inner || 0, (l.outer || 0) + 1e-4);
    out[e + 1] = l.ground ? l.ground[0] : 0;
    out[e + 2] = l.ground ? l.ground[1] : 0;
    out[e + 3] = l.ground ? l.ground[2] : 0;
  }
  return { data: out, lightCount: count, truncated: Math.max(0, list.length - MAX_LIGHTS), usedDefaults: !(lights && lights.length) };
}

/**
 * The light types of packed frame uniforms, in order, as a short key ("0,0",
 * "0,1,2"): the light setup that mesh shaders are specialised for.
 */
export function lightTypes(frameData) {
  const n = Math.round(frameData[44]);
  let key = '';
  for (let i = 0; i < n; i++) key += (i ? ',' : '') + Math.round(frameData[48 + i * 4 + 3]);
  return key;
}

/** Material uniform block: baseColor, emissive(normalScale), params(metallic, roughness, flags), uvScale, overlay color. */
export const MATERIAL_FLOATS = 20;

export const MAT_FLAG_MAP = 1;
export const MAT_FLAG_NORMAL_MAP = 2;
export const MAT_FLAG_DOUBLE_SIDED = 4;
export const MAT_FLAG_UNLIT = 8;
export const MAT_FLAG_OVERLAY = 16;
export const MAT_FLAG_MR_MAP = 32;
export const MAT_FLAG_OCCLUSION = 64;
export const MAT_FLAG_EMISSIVE_MAP = 128;
export const MAT_FLAG_ALPHA_MASK = 256;

export function packMaterial(out, m, { hasMap = false, hasNormalMap = false, hasMrMap = false, hasOcclusionMap = false, hasEmissiveMap = false, doubleSided = false } = {}) {
  out.fill(0);
  out[0] = m.baseColor[0];
  out[1] = m.baseColor[1];
  out[2] = m.baseColor[2];
  out[3] = m.alphaMode === 'opaque' ? 1 : m.opacity;
  out[4] = m.emissive[0];
  out[5] = m.emissive[1];
  out[6] = m.emissive[2];
  out[7] = m.normalScale;
  out[8] = m.metallic;
  out[9] = m.roughness;
  out[10] =
    (hasMap ? MAT_FLAG_MAP : 0) |
    (hasNormalMap ? MAT_FLAG_NORMAL_MAP : 0) |
    (doubleSided ? MAT_FLAG_DOUBLE_SIDED : 0) |
    (m.unlit ? MAT_FLAG_UNLIT : 0) |
    (hasMrMap ? MAT_FLAG_MR_MAP : 0) |
    (hasOcclusionMap ? MAT_FLAG_OCCLUSION : 0) |
    (hasEmissiveMap ? MAT_FLAG_EMISSIVE_MAP : 0) |
    (m.alphaMode === 'mask' ? MAT_FLAG_ALPHA_MASK : 0);
  out[11] = m.alphaCutoff ?? 0.5;
  out[12] = m.uvScale[0];
  out[13] = m.uvScale[1];
  out[14] = m.occlusionStrength ?? 1;
  return out;
}

/** Uniforms for debug line overlays (sRGB color, drawn unlit). */
export function packOverlay(out, rgba) {
  out.fill(0);
  out[16] = rgba[0];
  out[17] = rgba[1];
  out[18] = rgba[2];
  out[19] = rgba[3];
  out[10] = MAT_FLAG_OVERLAY;
  out[12] = 1;
  out[13] = 1;
  return out;
}
