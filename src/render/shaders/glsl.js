// GLSL ES 3.00 shaders for the WebGL2 backend. They mirror shaders/wgsl.js.
//
// Instancing: the per-instance world matrix arrives as four vec4 attributes.
// Normals are transformed with the cofactor matrix of the instance matrix
// (proportional to the inverse transpose), so no normal matrix is uploaded and
// non-uniform and mirrored scales are handled correctly.

import {
  MAT_FLAG_MAP, MAT_FLAG_NORMAL_MAP, MAT_FLAG_UNLIT, MAT_FLAG_DOUBLE_SIDED, MAT_FLAG_MR_MAP,
  MAT_FLAG_OCCLUSION, MAT_FLAG_EMISSIVE_MAP, MAT_FLAG_ALPHA_MASK,
} from '../lighting.js';

const FRAME_BLOCK = /* glsl */ `
layout(std140) uniform Frame {
  mat4 uViewProj;
  mat4 uView;
  vec4 uCameraPos;
  vec4 uSky;
  vec4 uGround;
  vec4 uParams;
  vec4 uLightPos[16];
  vec4 uLightDir[16];
  vec4 uLightColor[16];
  vec4 uLightExtra[16];
};
`;

const MATERIAL_BLOCK = /* glsl */ `
layout(std140) uniform Material {
  vec4 mBaseColor;
  vec4 mEmissive;
  vec4 mParams;
  vec4 mUv;
  vec4 mOverlay;
};
`;

const INSTANCE_INPUTS = /* glsl */ `
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec4 iM0;
layout(location = 4) in vec4 iM1;
layout(location = 5) in vec4 iM2;
layout(location = 6) in vec4 iM3;
`;

const COMMON_FS = /* glsl */ `
const float PI = 3.14159265359;
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
`;

/** Vertex shader of the mesh programs; texture coordinates only for textured materials. */
export const meshVertexShader = (textured) => /* glsl */ `#version 300 es
precision highp float;
${FRAME_BLOCK}
${INSTANCE_INPUTS}
out vec3 vWorld;
out vec3 vNormal;
${textured ? 'out vec2 vUv;' : ''}
void main() {
  mat4 M = mat4(iM0, iM1, iM2, iM3);
  vec4 wp = M * vec4(aPosition, 1.0);
  vec3 c0 = iM0.xyz;
  vec3 c1 = iM1.xyz;
  vec3 c2 = iM2.xyz;
  mat3 cof = mat3(cross(c1, c2), cross(c2, c0), cross(c0, c1));
  float det = dot(c0, cross(c1, c2));
  vNormal = cof * aNormal * (det < 0.0 ? -1.0 : 1.0);
  vWorld = wp.xyz;
  ${textured ? 'vUv = aUv;' : ''}
  gl_Position = uViewProj * wp;
}
`;

/** Material flags that need texture coordinates. */
export const TEXTURE_FLAGS = MAT_FLAG_MAP | MAT_FLAG_NORMAL_MAP | MAT_FLAG_MR_MAP | MAT_FLAG_OCCLUSION | MAT_FLAG_EMISSIVE_MAP;

/**
 * Fragment shader for one material feature set (MAT_FLAG_* bits) and one
 * light setup (lightTypes() of the frame: its light types, in order). Everything else is
 * compiled out, as a renderer that specialises its programs does: textures
 * are sampled only when the material has them, `discard` exists only for
 * alpha-masked materials (its mere presence disables early depth testing on
 * many GPUs), and the light loop is unrolled with each light's type known.
 */
export function meshFragmentShader(flags, lights) {
  const has = (f) => (flags & f) !== 0;
  const map = has(MAT_FLAG_MAP), normalMap = has(MAT_FLAG_NORMAL_MAP), mrMap = has(MAT_FLAG_MR_MAP);
  const occlusion = has(MAT_FLAG_OCCLUSION), emissiveMap = has(MAT_FLAG_EMISSIVE_MAP);
  const textured = map || normalMap || mrMap || occlusion || emissiveMap;
  // explicit gradients only where a discard could leave later lookups without them
  const grad = has(MAT_FLAG_ALPHA_MASK);
  const sample = (sampler) => (grad ? `textureGrad(${sampler}, uv, duv1, duv2)` : `texture(${sampler}, uv)`);
  const L = [];
  L.push(`#version 300 es
precision highp float;
precision highp int;
${FRAME_BLOCK}
${MATERIAL_BLOCK}`);
  if (map) L.push('uniform sampler2D uMap;');
  if (normalMap) L.push('uniform sampler2D uNormalMap;');
  if (mrMap) L.push('uniform sampler2D uMrMap;');
  if (occlusion) L.push('uniform sampler2D uOcclusionMap;');
  if (emissiveMap) L.push('uniform sampler2D uEmissiveMap;');
  L.push(`in vec3 vWorld;
in vec3 vNormal;
${textured ? 'in vec2 vUv;' : ''}
out vec4 outColor;
${COMMON_FS}`);
  if (!has(MAT_FLAG_UNLIT)) L.push(BRDF);
  L.push('void main() {');
  if (textured) L.push('  vec2 uv = vUv * mUv.xy;');
  // derivatives before any discard, so every lookup after it still has them
  if ((textured && grad) || normalMap) L.push('  vec2 duv1 = dFdx(uv);', '  vec2 duv2 = dFdy(uv);');
  L.push('  vec4 base = mBaseColor;');
  if (map) L.push(`  base *= ${sample('uMap')};`);
  if (has(MAT_FLAG_ALPHA_MASK)) L.push('  if (base.a < mParams.w) discard;');
  L.push('  vec3 emitted = mEmissive.rgb;');
  if (emissiveMap) L.push(`  emitted *= ${sample('uEmissiveMap')}.rgb;`);
  if (has(MAT_FLAG_UNLIT)) {
    L.push('  outColor = vec4(linearToSrgb(base.rgb + emitted), base.a);', '}');
    return L.join('\n');
  }
  L.push('  vec3 N = normalize(vNormal);');
  if (has(MAT_FLAG_DOUBLE_SIDED)) L.push('  N = gl_FrontFacing ? N : -N;');
  if (normalMap) {
    L.push(`  vec3 dp1 = dFdx(vWorld);
  vec3 dp2 = dFdy(vWorld);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
  vec3 n = ${sample('uNormalMap')}.xyz * 2.0 - 1.0;
  n.xy *= mEmissive.w;
  N = normalize(mat3(T * invmax, B * invmax, N) * n);`);
  }
  L.push(`  vec3 V = normalize(uCameraPos.xyz - vWorld);
  float NdotV = max(dot(N, V), 1e-4);
  float rough = clamp(mParams.y, 0.045, 1.0);
  float metal = clamp(mParams.x, 0.0, 1.0);`);
  if (mrMap) {
    L.push(`  vec4 mr = ${sample('uMrMap')};
  rough = clamp(rough * mr.g, 0.045, 1.0);
  metal = clamp(metal * mr.b, 0.0, 1.0);`);
  }
  L.push(`  float a = rough * rough;
  vec3 f0 = mix(vec3(0.04), base.rgb, metal);
  vec3 diffuse = base.rgb * (1.0 - metal);
  vec3 color = vec3(0.0);
  vec3 ambient = vec3(0.0);`);
  if (lights) lights.split(',').forEach((type, i) => L.push(lightTerm(Number(type), i)));
  L.push(`  float envI = uSky.w;
  vec3 hemi = mix(uGround.rgb, uSky.rgb, N.y * 0.5 + 0.5) * envI + ambient;
  vec3 R = reflect(-V, N);
  vec3 envSpec = mix(uGround.rgb, uSky.rgb, smoothstep(-0.25 - rough, 0.25 + rough, R.y)) * envI;
  envSpec = mix(envSpec, hemi, rough * rough);`);
  if (occlusion) {
    L.push(`  float ao = mix(1.0, ${sample('uOcclusionMap')}.r, mUv.z);
  hemi *= ao;
  envSpec *= ao;`);
  }
  L.push(`  color += diffuse * hemi + envSpec * envBRDF(f0, rough, NdotV);
  color += emitted;
  color *= uGround.w;
  outColor = vec4(linearToSrgb(aces(color)), base.a);
}`);
  return L.join('\n');
}

const BRDF = /* glsl */ `
float D_GGX(float NdotH, float a) {
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
float V_Smith(float NdotV, float NdotL, float a) {
  float a2 = a * a;
  float gv = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
  float gl = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
vec3 F_Schlick(vec3 f0, float VdotH) {
  return f0 + (vec3(1.0) - f0) * pow(1.0 - VdotH, 5.0);
}
vec3 envBRDF(vec3 f0, float roughness, float NdotV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = roughness * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
  vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * AB.x + AB.y;
}
// one light's contribution, zero when it is behind the surface
vec3 shade(vec3 N, vec3 V, vec3 L, vec3 radiance, float NdotV, vec3 f0, vec3 diffuse, float a) {
  float NdotL = dot(N, L);
  if (NdotL <= 0.0) return vec3(0.0);
  vec3 H = normalize(V + L);
  float NdotH = max(dot(N, H), 0.0);
  float VdotH = max(dot(V, H), 0.0);
  vec3 F = F_Schlick(f0, VdotH);
  vec3 spec = D_GGX(NdotH, a) * V_Smith(NdotV, NdotL, a) * F;
  vec3 kd = (vec3(1.0) - F) * diffuse / PI;
  return (kd + spec) * radiance * NdotL;
}
`;

/** GLSL for light i of a known type (lighting.js: 0 directional, 1 point, 2 spot, 3 ambient, 4 hemisphere). */
function lightTerm(type, i) {
  if (type === 3) return `  ambient += uLightColor[${i}].rgb;`;
  if (type === 4) return `  ambient += mix(uLightExtra[${i}].yzw, uLightColor[${i}].rgb, N.y * 0.5 + 0.5);`;
  if (type === 0) return `  color += shade(N, V, -uLightDir[${i}].xyz, uLightColor[${i}].rgb * PI, NdotV, f0, diffuse, a);`;
  return `  {
    vec3 Lv = uLightPos[${i}].xyz - vWorld;
    float d = length(Lv);
    vec3 L = Lv / max(d, 1e-5);
    float att = 1.0 / max(d * d, 1e-4);
    float range = uLightDir[${i}].w;
    if (range > 0.0) {
      float x = d / range;
      float w = clamp(1.0 - x * x * x * x, 0.0, 1.0);
      att *= w * w;
    }${type === 2 ? `\n    att *= smoothstep(uLightColor[${i}].w, uLightExtra[${i}].x, dot(-L, uLightDir[${i}].xyz));` : ''}
    color += shade(N, V, L, uLightColor[${i}].rgb * PI * att, NdotV, f0, diffuse, a);
  }`;
}

/** Lines: scene polylines (unlit material color), wireframe and bounding boxes. */
export const LINE_VS = /* glsl */ `#version 300 es
precision highp float;
${FRAME_BLOCK}
${INSTANCE_INPUTS}
void main() {
  mat4 M = mat4(iM0, iM1, iM2, iM3);
  vec4 wp = M * vec4(aPosition, 1.0);
  // pull lines slightly toward the camera so they win the depth test against
  // the surfaces they outline (a relative offset works at every distance)
  wp.xyz = mix(wp.xyz, uCameraPos.xyz, uParams.z);
  gl_Position = uViewProj * wp;
}
`;

/** Normal visualisation: the tip vertex (uv.x = 1) is offset along the world normal. */
export const NORMAL_VS = /* glsl */ `#version 300 es
precision highp float;
${FRAME_BLOCK}
${INSTANCE_INPUTS}
void main() {
  mat4 M = mat4(iM0, iM1, iM2, iM3);
  vec4 wp = M * vec4(aPosition, 1.0);
  vec3 c0 = iM0.xyz;
  vec3 c1 = iM1.xyz;
  vec3 c2 = iM2.xyz;
  mat3 cof = mat3(cross(c1, c2), cross(c2, c0), cross(c0, c1));
  float det = dot(c0, cross(c1, c2));
  vec3 n = normalize(cof * aNormal * (det < 0.0 ? -1.0 : 1.0));
  wp.xyz += n * aUv.x * uParams.y;
  wp.xyz = mix(wp.xyz, uCameraPos.xyz, uParams.z);
  gl_Position = uViewProj * wp;
}
`;

export const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${FRAME_BLOCK}
${MATERIAL_BLOCK}
out vec4 outColor;
${COMMON_FS}
void main() {
  int flags = int(mParams.z + 0.5);
  if ((flags & 16) != 0) {
    outColor = mOverlay;
    return;
  }
  outColor = vec4(linearToSrgb(mBaseColor.rgb + mEmissive.rgb), mBaseColor.a);
}
`;
