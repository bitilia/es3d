#!/usr/bin/env node
// Writes the sample files for the converter into docs/public/samples/:
//   rock.obj + rock.mtl   a lumpy low-poly rock (Wavefront OBJ, no normals)
//   gem.stl               a faceted gem (binary STL, Z-up, millimetres)
//   stairs.glb            the staircase example exported to glTF binary
// (es3d-badge.svg is written by hand.) The files are deterministic, so
// running the script again produces identical bytes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/pipeline.js';
import { exportGLB } from '../src/io/gltf.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/public/samples');
fs.mkdirSync(OUT, { recursive: true });

const r4 = (v) => Number(v.toFixed(4));

// ---- rock.obj: an icosphere, subdivided twice and displaced by smooth noise
function icosphere(subdivisions) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const norm = (v) => {
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
  };
  verts = verts.map(norm);
  for (let s = 0; s < subdivisions; s++) {
    const mid = new Map();
    const midpoint = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!mid.has(key)) {
        verts.push(norm(verts[a].map((x, k) => (x + verts[b][k]) / 2)));
        mid.set(key, verts.length - 1);
      }
      return mid.get(key);
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
    });
  }
  return { verts, faces };
}

{
  const { verts, faces } = icosphere(2);
  const noise = ([x, y, z]) => 0.16 * Math.sin(3.1 * x + 1.7) * Math.cos(2.3 * y - 0.4) + 0.1 * Math.sin(5.3 * z + 2.9 * x) + 0.05 * Math.cos(7.7 * y + 3.3 * z);
  const lines = ['# A lumpy rock: an icosphere displaced by smooth noise.', '# Written by scripts/make-samples.mjs for the ES3D converter.', 'mtllib rock.mtl', 'o rock'];
  for (const v of verts) {
    const k = 1 + noise(v);
    lines.push(`v ${r4(v[0] * k * 1.3)} ${r4(v[1] * k * 0.8 + 0.8)} ${r4(v[2] * k)}`);
  }
  lines.push('usemtl stone');
  for (const f of faces) lines.push(`f ${f[0] + 1} ${f[1] + 1} ${f[2] + 1}`);
  fs.writeFileSync(path.join(OUT, 'rock.obj'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'rock.mtl'), '# Material of rock.obj\nnewmtl stone\nKd 0.56 0.52 0.47\nKs 0.05 0.05 0.05\nNs 12\n');
}

// ---- gem.stl: a round faceted gem, binary STL, Z-up, millimetres
{
  const n = 16;
  const ring = (r, z, offset = 0) => Array.from({ length: n }, (_, i) => {
    const a = ((i + offset) / n) * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a), z];
  });
  const culet = [0, 0, 0];
  const girdleLow = ring(10, 8.6);
  const girdleHigh = ring(10, 9.2);
  const crown = ring(7.6, 11.4, 0.5);
  const table = ring(5.4, 12.6);
  const top = [0, 0, 12.6];
  const tris = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([culet, girdleLow[j], girdleLow[i]]);
    tris.push([girdleLow[i], girdleLow[j], girdleHigh[j]], [girdleLow[i], girdleHigh[j], girdleHigh[i]]);
    tris.push([girdleHigh[i], girdleHigh[j], crown[i]]);
    tris.push([crown[i], girdleHigh[j], crown[j]]);
    tris.push([crown[i], crown[j], table[j]]);
    tris.push([crown[i], table[j], table[i]]);
    tris.push([table[i], table[j], top]);
  }
  const bytes = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('gem: a faceted round gem for the ES3D converter (mm, Z-up)'));
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, k) => {
    const o = 84 + k * 50;
    const e1 = t[1].map((v, c) => v - t[0][c]), e2 = t[2].map((v, c) => v - t[0][c]);
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...nrm) || 1;
    nrm.forEach((v, c) => dv.setFloat32(o + c * 4, v / l, true));
    t.flat().forEach((v, c) => dv.setFloat32(o + 12 + c * 4, v, true));
  });
  fs.writeFileSync(path.join(OUT, 'gem.stl'), bytes);
}

// ---- stairs.glb: the staircase example as glTF binary (level of detail 1, instanced)
{
  const res = compile(fs.readFileSync(path.join(ROOT, 'docs/public/examples/07-staircases.es3d'), 'utf8'));
  if (!res.ok) throw new Error('the staircase example does not compile');
  const glb = exportGLB(res.scene, (e, lod) => res.cache.mesh(e, lod), { lod: 1, instancing: true });
  fs.writeFileSync(path.join(OUT, 'stairs.glb'), glb);
}

for (const f of fs.readdirSync(OUT).sort()) console.log(`${f.padEnd(16)} ${fs.statSync(path.join(OUT, f)).size.toLocaleString('en-US')} bytes`);
