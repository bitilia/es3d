import test from 'node:test';
import assert from 'node:assert/strict';
import { meshVertexShader, meshFragmentShader, TEXTURE_FLAGS } from '../src/render/shaders/glsl.js';
import { meshShader } from '../src/render/shaders/wgsl.js';
import {
  FRAME_FLOATS, lightTypes, packFrameUniforms,
  MAT_FLAG_MAP, MAT_FLAG_NORMAL_MAP, MAT_FLAG_DOUBLE_SIDED, MAT_FLAG_UNLIT, MAT_FLAG_ALPHA_MASK, MAT_FLAG_EMISSIVE_MAP,
} from '../src/render/lighting.js';

// Mesh shaders are generated per material feature set and light setup: what a
// material does not use must not be in its shader. (`npm run test:shaders`
// compiles every combination with WebGL2 and WebGPU in a browser.)

const count = (s, re) => (s.match(re) || []).length;

test('a plain material samples nothing, cannot discard and shades each light once', () => {
  for (const make of [meshFragmentShader, meshShader]) {
    const s = make(0, '0,1,2');
    assert.equal(count(s, /texture\w*\(/g), 0);
    assert.equal(count(s, /discard/g), 0);
    assert.equal(count(s, /shade\(N, V,/g), 3);
    assert.equal(count(s, /dFdx|dpdx/g), 0);
  }
});

test('features appear only with their flags', () => {
  const glsl = meshFragmentShader(MAT_FLAG_MAP | MAT_FLAG_ALPHA_MASK, '0');
  assert.match(glsl, /textureGrad\(uMap/); // after a discard, lookups need explicit gradients
  assert.match(glsl, /discard/);
  assert.doesNotMatch(glsl, /uNormalMap/);
  assert.match(meshFragmentShader(MAT_FLAG_MAP, '0'), /texture\(uMap, uv\)/);
  assert.match(meshFragmentShader(MAT_FLAG_NORMAL_MAP, '0'), /dFdx\(vWorld\)/);
  assert.match(meshFragmentShader(MAT_FLAG_DOUBLE_SIDED, ''), /gl_FrontFacing \? N : -N/);
  assert.match(meshShader(MAT_FLAG_DOUBLE_SIDED, ''), /select\(-N, N, frontFacing\)/);
  const unlit = meshFragmentShader(MAT_FLAG_UNLIT | MAT_FLAG_EMISSIVE_MAP, '0,0');
  assert.doesNotMatch(unlit, /shade|D_GGX/);
  assert.match(unlit, /uEmissiveMap/);
  // texture coordinates travel from the vertex stage only when a texture needs them
  assert.doesNotMatch(meshVertexShader(false), /vUv/);
  assert.match(meshVertexShader(true), /vUv = aUv/);
  assert.ok(TEXTURE_FLAGS & MAT_FLAG_MAP && !(TEXTURE_FLAGS & MAT_FLAG_DOUBLE_SIDED));
});

test('light setups: types in order, ambient and hemisphere lights add to the ambient term', () => {
  const s = meshFragmentShader(0, '3,4,1');
  assert.match(s, /ambient \+= uLightColor\[0\]/);
  assert.match(s, /ambient \+= mix\(uLightExtra\[1\]/);
  assert.match(s, /uLightPos\[2\]/);
  assert.equal(count(s, /smoothstep\(uLightColor/g), 0, 'no spot cone for a point light');
  assert.equal(count(meshFragmentShader(0, '2'), /smoothstep\(uLightColor\[0\]/g), 1);
  const frame = new Float32Array(FRAME_FLOATS);
  const lights = [
    { type: 'directional', color: [1, 1, 1], direction: [0, -1, 0], position: [0, 0, 0], range: 0, outer: 0, inner: 0, ground: [0, 0, 0] },
    { type: 'spot', color: [1, 1, 1], direction: [0, -1, 0], position: [0, 5, 0], range: 10, outer: 0.9, inner: 0.95, ground: [0, 0, 0] },
  ];
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  packFrameUniforms(frame, { viewProj: identity, view: identity, cameraPos: [0, 0, 5], lights, environment: { sky: [1, 1, 1, 1], ground: [0, 0, 0, 1], intensity: 1, exposure: 1 } });
  assert.equal(lightTypes(frame), '0,2');
});
