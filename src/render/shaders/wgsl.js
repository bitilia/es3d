// WGSL shaders for the WebGPU backend. They mirror shaders/glsl.js.

import {
  MAT_FLAG_MAP, MAT_FLAG_NORMAL_MAP, MAT_FLAG_UNLIT, MAT_FLAG_DOUBLE_SIDED, MAT_FLAG_MR_MAP,
  MAT_FLAG_OCCLUSION, MAT_FLAG_EMISSIVE_MAP, MAT_FLAG_ALPHA_MASK,
} from '../lighting.js';

const STRUCTS = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  view: mat4x4f,
  cameraPos: vec4f,
  sky: vec4f,
  ground: vec4f,
  params: vec4f,
  lightPos: array<vec4f, 16>,
  lightDir: array<vec4f, 16>,
  lightColor: array<vec4f, 16>,
  lightExtra: array<vec4f, 16>,
};
struct Material {
  baseColor: vec4f,
  emissive: vec4f,
  params: vec4f,
  uvScale: vec4f,
  overlay: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var samp: sampler;
@group(1) @binding(2) var baseTex: texture_2d<f32>;
@group(1) @binding(3) var normalTex: texture_2d<f32>;
@group(1) @binding(4) var mrTex: texture_2d<f32>;
@group(1) @binding(5) var occlusionTex: texture_2d<f32>;
@group(1) @binding(6) var emissiveTex: texture_2d<f32>;

struct VSIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) m0: vec4f,
  @location(4) m1: vec4f,
  @location(5) m2: vec4f,
  @location(6) m3: vec4f,
};

const PI = 3.14159265359;

fn linearToSrgb(c0: vec3f) -> vec3f {
  let c = max(c0, vec3f(0.0));
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}
fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn worldNormal(inp: VSIn) -> vec3f {
  let c0 = inp.m0.xyz;
  let c1 = inp.m1.xyz;
  let c2 = inp.m2.xyz;
  let cof = mat3x3f(cross(c1, c2), cross(c2, c0), cross(c0, c1));
  let det = dot(c0, cross(c1, c2));
  return cof * inp.normal * select(1.0, -1.0, det < 0.0);
}
`;

/** Vertex stage of the mesh modules; texture coordinates only for textured materials. */
const meshVertex = (textured) => /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  ${textured ? '@location(2) uv: vec2f,' : ''}
};

@vertex
fn vs_main(inp: VSIn) -> VSOut {
  let M = mat4x4f(inp.m0, inp.m1, inp.m2, inp.m3);
  let wp = M * vec4f(inp.position, 1.0);
  var out: VSOut;
  out.pos = frame.viewProj * wp;
  out.world = wp.xyz;
  out.normal = worldNormal(inp);
  ${textured ? 'out.uv = inp.uv;' : ''}
  return out;
}
`;

const BRDF = /* wgsl */ `
fn D_GGX(NdotH: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
fn V_Smith(NdotV: f32, NdotL: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
  let gl = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
fn F_Schlick(f0: vec3f, VdotH: f32) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - VdotH, 5.0);
}
fn envBRDF(f0: vec3f, roughness: f32, NdotV: f32) -> vec3f {
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
  let AB = vec2f(-1.04, 1.04) * a004 + r.zw;
  return f0 * AB.x + AB.y;
}
// one light's contribution, zero when it is behind the surface
fn shade(N: vec3f, V: vec3f, L: vec3f, radiance: vec3f, NdotV: f32, f0: vec3f, diffuse: vec3f, a: f32) -> vec3f {
  let NdotL = dot(N, L);
  if (NdotL <= 0.0) {
    return vec3f(0.0);
  }
  let H = normalize(V + L);
  let NdotH = max(dot(N, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);
  let F = F_Schlick(f0, VdotH);
  let spec = D_GGX(NdotH, a) * V_Smith(NdotV, NdotL, a) * F;
  let kd = (vec3f(1.0) - F) * diffuse / PI;
  return (kd + spec) * radiance * NdotL;
}
`;

/**
 * Shader module for one material feature set (MAT_FLAG_* bits) and one light
 * setup (lightTypes() of the frame), as meshFragmentShader() in
 * glsl.js: everything the material does not use is compiled out, and the
 * light loop is unrolled. Textures are sampled in uniform control flow (the
 * double-sided normal flip is a select, not a branch); after an alpha-mask
 * discard, lookups use explicit gradients taken before it.
 */
export function meshShader(flags, lights) {
  const has = (f) => (flags & f) !== 0;
  const map = has(MAT_FLAG_MAP), normalMap = has(MAT_FLAG_NORMAL_MAP), mrMap = has(MAT_FLAG_MR_MAP);
  const occlusion = has(MAT_FLAG_OCCLUSION), emissiveMap = has(MAT_FLAG_EMISSIVE_MAP);
  const textured = map || normalMap || mrMap || occlusion || emissiveMap;
  const grad = has(MAT_FLAG_ALPHA_MASK);
  const sample = (tex) => (grad ? `textureSampleGrad(${tex}, samp, uv, ddx, ddy)` : `textureSample(${tex}, samp, uv)`);
  const L = [STRUCTS, meshVertex(textured)];
  if (!has(MAT_FLAG_UNLIT)) L.push(BRDF);
  L.push('@fragment', 'fn fs_main(inp: VSOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {');
  if (textured) L.push('  let uv = inp.uv * material.uvScale.xy;');
  if ((textured && grad) || normalMap) L.push('  let ddx = dpdx(uv);', '  let ddy = dpdy(uv);');
  if (normalMap) {
    // WGSL derivatives use framebuffer y (down); negate dpdy to match GLSL's
    // window-space dFdy (up) so the cotangent frame has the same handedness
    L.push('  let dp1 = dpdx(inp.world);', '  let dp2 = -dpdy(inp.world);', '  let duv1 = ddx;', '  let duv2 = -ddy;');
  }
  L.push('  var base = material.baseColor;');
  if (map) L.push(`  base = base * ${sample('baseTex')};`);
  if (grad) L.push('  if (base.a < material.params.w) {', '    discard;', '  }');
  L.push('  var emitted = material.emissive.rgb;');
  if (emissiveMap) L.push(`  emitted = emitted * ${sample('emissiveTex')}.rgb;`);
  if (has(MAT_FLAG_UNLIT)) {
    L.push('  return vec4f(linearToSrgb(base.rgb + emitted), base.a);', '}');
    return L.join('\n');
  }
  L.push('  var N = normalize(inp.normal);');
  if (has(MAT_FLAG_DOUBLE_SIDED)) L.push('  N = select(-N, N, frontFacing);');
  if (normalMap) {
    L.push(`  let dp2perp = cross(dp2, N);
  let dp1perp = cross(N, dp1);
  let T = dp2perp * duv1.x + dp1perp * duv2.x;
  let B = dp2perp * duv1.y + dp1perp * duv2.y;
  let invmax = inverseSqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
  let n0 = ${sample('normalTex')}.xyz * 2.0 - 1.0;
  let n = vec3f(n0.xy * material.emissive.w, n0.z);
  N = normalize(mat3x3f(T * invmax, B * invmax, N) * n);`);
  }
  L.push(`  let V = normalize(frame.cameraPos.xyz - inp.world);
  let NdotV = max(dot(N, V), 1e-4);
  var rough = clamp(material.params.y, 0.045, 1.0);
  var metal = clamp(material.params.x, 0.0, 1.0);`);
  if (mrMap) {
    L.push(`  let mr = ${sample('mrTex')};
  rough = clamp(rough * mr.g, 0.045, 1.0);
  metal = clamp(metal * mr.b, 0.0, 1.0);`);
  }
  L.push(`  let a = rough * rough;
  let f0 = mix(vec3f(0.04), base.rgb, metal);
  let diffuse = base.rgb * (1.0 - metal);
  var color = vec3f(0.0);
  var ambient = vec3f(0.0);`);
  if (lights) lights.split(',').forEach((type, i) => L.push(lightTerm(Number(type), i)));
  L.push(`  let envI = frame.sky.w;
  var hemi = mix(frame.ground.rgb, frame.sky.rgb, N.y * 0.5 + 0.5) * envI + ambient;
  let R = reflect(-V, N);
  var envSpec = mix(frame.ground.rgb, frame.sky.rgb, smoothstep(-0.25 - rough, 0.25 + rough, R.y)) * envI;
  envSpec = mix(envSpec, hemi, rough * rough);`);
  if (occlusion) {
    L.push(`  let ao = mix(1.0, ${sample('occlusionTex')}.r, material.uvScale.z);
  hemi = hemi * ao;
  envSpec = envSpec * ao;`);
  }
  L.push(`  color = color + diffuse * hemi + envSpec * envBRDF(f0, rough, NdotV);
  color = color + emitted;
  color = color * frame.ground.w;
  return vec4f(linearToSrgb(aces(color)), base.a);
}`);
  return L.join('\n');
}

/** WGSL for light i of a known type (lighting.js: 0 directional, 1 point, 2 spot, 3 ambient, 4 hemisphere). */
function lightTerm(type, i) {
  if (type === 3) return `  ambient = ambient + frame.lightColor[${i}].rgb;`;
  if (type === 4) return `  ambient = ambient + mix(frame.lightExtra[${i}].yzw, frame.lightColor[${i}].rgb, N.y * 0.5 + 0.5);`;
  if (type === 0) return `  color = color + shade(N, V, -frame.lightDir[${i}].xyz, frame.lightColor[${i}].rgb * PI, NdotV, f0, diffuse, a);`;
  return `  {
    let Lv = frame.lightPos[${i}].xyz - inp.world;
    let d = length(Lv);
    let L = Lv / max(d, 1e-5);
    var att = 1.0 / max(d * d, 1e-4);
    let range = frame.lightDir[${i}].w;
    if (range > 0.0) {
      let x = d / range;
      let w = clamp(1.0 - x * x * x * x, 0.0, 1.0);
      att = att * w * w;
    }${type === 2 ? `\n    att = att * smoothstep(frame.lightColor[${i}].w, frame.lightExtra[${i}].x, dot(-L, frame.lightDir[${i}].xyz));` : ''}
    color = color + shade(N, V, L, frame.lightColor[${i}].rgb * PI * att, NdotV, f0, diffuse, a);
  }`;
}

export const LINE_WGSL = /* wgsl */ `
${STRUCTS}
@vertex
fn vs_line(inp: VSIn) -> @builtin(position) vec4f {
  let M = mat4x4f(inp.m0, inp.m1, inp.m2, inp.m3);
  let wp = M * vec4f(inp.position, 1.0);
  return frame.viewProj * vec4f(mix(wp.xyz, frame.cameraPos.xyz, frame.params.z), 1.0);
}

@vertex
fn vs_normals(inp: VSIn) -> @builtin(position) vec4f {
  let M = mat4x4f(inp.m0, inp.m1, inp.m2, inp.m3);
  var wp = M * vec4f(inp.position, 1.0);
  let n = normalize(worldNormal(inp));
  wp = vec4f(wp.xyz + n * inp.uv.x * frame.params.y, 1.0);
  return frame.viewProj * vec4f(mix(wp.xyz, frame.cameraPos.xyz, frame.params.z), 1.0);
}

@fragment
fn fs_line() -> @location(0) vec4f {
  let flags = u32(material.params.z + 0.5);
  if ((flags & 16u) != 0u) {
    return material.overlay;
  }
  return vec4f(linearToSrgb(material.baseColor.rgb + material.emissive.rgb), material.baseColor.a);
}
`;
