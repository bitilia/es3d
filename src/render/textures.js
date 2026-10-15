// Texture sources: procedural textures generated on the CPU (portable, no
// image files needed) and image URLs (browser only). Procedural textures are
// tileable so they repeat seamlessly with uvScale.

import { hash2 } from '../math/random.js';

const SIZE = 256;

function rgba8(c) {
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), Math.round((c[3] ?? 1) * 255)];
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Tileable value noise (period = `period` cells) with fBm octaves. */
function valueNoise(u, v, period, seed) {
  const x = u * period, y = v * period;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (i, j) => hash2(((i % period) + period) % period, ((j % period) + period) % period, seed);
  const a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(u, v, period, seed) {
  let sum = 0, amp = 0.5, p = Math.max(1, Math.round(period)), norm = 0;
  for (let o = 0; o < 5; o++) {
    sum += valueNoise(u, v, p, seed + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

function fill(size, fn) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = fn((x + 0.5) / size, (y + 0.5) / size);
      const o = (y * size + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = c[3];
    }
  }
  return { width: size, height: size, data };
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

/** Base color textures (sRGB values). */
export function proceduralColor(spec, size = SIZE) {
  const p = spec.params;
  switch (spec.fn) {
    case 'checker': {
      const a = rgba8(p.color1), b = rgba8(p.color2);
      const n = Math.max(1, Math.round(p.count));
      return fill(size, (u, v) => ((Math.floor(u * n) + Math.floor(v * n)) % 2 === 0 ? a : b));
    }
    case 'stripes': {
      const a = rgba8(p.color1), b = rgba8(p.color2);
      const n = Math.max(1, Math.round(p.count));
      return fill(size, (u) => (Math.floor(u * n * 2) % 2 === 0 ? a : b));
    }
    case 'grid': {
      const line = rgba8(p.line), bg = rgba8(p.background);
      const n = Math.max(1, Math.round(p.count));
      const w = p.width / 2;
      return fill(size, (u, v) => {
        const fu = (u * n) % 1, fv = (v * n) % 1;
        const d = Math.min(fu, 1 - fu, fv, 1 - fv);
        return mix(line, bg, smoothstep(w * 0.6, w, d));
      });
    }
    case 'noise': {
      const a = rgba8(p.color1), b = rgba8(p.color2);
      return fill(size, (u, v) => mix(b, a, fbm(u, v, p.scale, p.seed)));
    }
    case 'bricks': {
      const brick = rgba8(p.brick), mortar = rgba8(p.mortar);
      const rows = Math.max(1, Math.round(p.count));
      return fill(size, (u, v) => {
        const row = Math.floor(v * rows);
        const uu = (u * rows * 0.5 + (row % 2) * 0.5) % 1;
        const fv = (v * rows) % 1;
        const d = Math.min(uu, 1 - uu, fv, 1 - fv);
        const shade = 0.88 + 0.24 * hash2(Math.floor(u * rows * 0.5 + (row % 2) * 0.5), row, 7);
        const b = [brick[0] * shade, brick[1] * shade, brick[2] * shade, 255];
        return mix(mortar, b, smoothstep(0.03, 0.06, d));
      });
    }
    default:
      throw new Error(`unknown procedural texture ${spec.fn}`);
  }
}

/** Height functions for normal maps (0..1 range, tileable). */
function heightFn(spec) {
  const p = spec.params;
  switch (spec.fn) {
    case 'bumps': {
      const n = Math.max(1, Math.round(p.count));
      return (u, v) => {
        const fu = (u * n) % 1 - 0.5, fv = (v * n) % 1 - 0.5;
        const r = Math.hypot(fu, fv) * 2.4;
        return r < 1 ? Math.sqrt(1 - r * r) : 0;
      };
    }
    case 'tiles': {
      const n = Math.max(1, Math.round(p.count));
      return (u, v) => {
        const fu = (u * n) % 1, fv = (v * n) % 1;
        const d = Math.min(fu, 1 - fu, fv, 1 - fv);
        return smoothstep(p.gap * 0.5, p.gap * 1.5, d);
      };
    }
    case 'noise':
      return (u, v) => fbm(u, v, p.scale, p.seed);
    case 'waves': {
      const n = Math.max(1, Math.round(p.count));
      return (u) => 0.5 + 0.5 * Math.sin(u * n * Math.PI * 2);
    }
    case 'bricks': {
      const rows = Math.max(1, Math.round(p.count));
      return (u, v) => {
        const row = Math.floor(v * rows);
        const uu = (u * rows * 0.5 + (row % 2) * 0.5) % 1;
        const fv = (v * rows) % 1;
        return smoothstep(0.02, 0.07, Math.min(uu, 1 - uu, fv, 1 - fv));
      };
    }
    default:
      throw new Error(`unknown procedural normal map ${spec.fn}`);
  }
}

/** Tangent-space normal map (RGB = n * 0.5 + 0.5) from a procedural height field. */
export function proceduralNormal(spec, size = SIZE) {
  const h = heightFn(spec);
  const strength = spec.params.strength ?? 1;
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) heights[y * size + x] = h((x + 0.5) / size, (y + 0.5) / size);
  const data = new Uint8ClampedArray(size * size * 4);
  const scale = strength * size * 0.02;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (i, j) => heights[((j + size) % size) * size + ((i + size) % size)];
      const dx = (at(x + 1, y) - at(x - 1, y)) * scale;
      const dy = (at(x, y + 1) - at(x, y - 1)) * scale;
      // image row y corresponds to texture coordinate v, so the tangent-space
      // normal of the height field h(u, v) is (-dh/du, -dh/dv, 1)
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const o = (y * size + x) * 4;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

/** Box-filtered mip chain (level 0 is the input). */
export function buildMips(img) {
  const levels = [img];
  let cur = img;
  while (cur.width > 1 || cur.height > 1) {
    const w = Math.max(1, cur.width >> 1), h = Math.max(1, cur.height >> 1);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let s = 0, k = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const sx = Math.min(cur.width - 1, x * 2 + dx), sy = Math.min(cur.height - 1, y * 2 + dy);
              s += cur.data[(sy * cur.width + sx) * 4 + c];
              k++;
            }
          }
          out[(y * w + x) * 4 + c] = s / k;
        }
      }
    }
    cur = { width: w, height: h, data: out };
    levels.push(cur);
  }
  return levels;
}

/** Load an image URL into RGBA pixels (browser only). */
export async function loadImagePixels(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  // power-of-two size keeps mipmapping and repeat wrapping valid everywhere
  const pot = (v) => Math.min(2048, 2 ** Math.round(Math.log2(Math.max(1, v))));
  const w = pot(bmp.width), h = pot(bmp.height);
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: id.data };
}

/** Resolve a texture spec into pixels (sync for procedural, async for URLs). */
export function texturePixels(spec, kind) {
  if (spec.kind === 'procedural') return Promise.resolve(kind === 'normal' ? proceduralNormal(spec) : proceduralColor(spec));
  return loadImagePixels(spec.url);
}
