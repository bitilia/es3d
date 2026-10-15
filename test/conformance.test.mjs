// Chordal-error bounds, placement polynomials, resource limits and material alpha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/pipeline.js';
import { es3dSin, es3dCos } from '../src/math/trig.js';
import { unitSphere, unitCylinder, unitTorus } from '../src/geometry/primitives.js';
import { sphereDeviation, sphereMeshError, cylinderDeviation, torusDeviation } from '../src/geometry/lod-error.js';
import { selectLod } from '../src/render/frame-builder.js';
import { sceneToMeshDocument } from '../src/io/mesh-import.js';
import { MAX_DEPTH, MAX_PATH_COMMANDS } from '../src/format/limits.js';

const SLACK = 1e-5;

test('sphere, cylinder and torus meshes stay within their chordal bounds', () => {
  for (const n of [48, 24, 12, 8]) {
    const mesh = unitSphere(n);
    const bound = sphereDeviation(n);
    const err = sphereMeshError(mesh.positions, mesh.indices);
    assert.ok(err <= bound + SLACK, `${n} segments: ${err} > ${bound}`);
    assert.ok(err > bound * 0.5, `${n} segments: bound ${bound} is far above the mesh`);
  }
  for (const n of [48, 8]) {
    const mesh = unitCylinder(1, n, true);
    const bound = cylinderDeviation(1, n);
    const p = mesh.positions;
    const ring = [];
    for (let i = 0; i < p.length / 3; i++) {
      if (Math.abs(p[i * 3 + 1] + 0.5) < 1e-3 && Math.hypot(p[i * 3], p[i * 3 + 2]) > 0.5) ring.push([p[i * 3], p[i * 3 + 2]]);
    }
    ring.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
    const uniq = [];
    for (const v of ring) {
      const prev = uniq[uniq.length - 1];
      if (!prev || Math.hypot(v[0] - prev[0], v[1] - prev[1]) > 1e-4) uniq.push(v);
    }
    let err = 0;
    for (let i = 0; i < uniq.length; i++) {
      const a = uniq[i];
      const b = uniq[(i + 1) % uniq.length];
      const mid = 1 - Math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (mid > err) err = mid;
    }
    assert.ok(err <= bound + SLACK && err > bound * 0.5, `cylinder ${n}: ${err} vs ${bound}`);
  }
  const tube = 0.25;
  const torus = unitTorus(tube, 360, 64, 24);
  const bound = torusDeviation(tube, 360, 64, 24);
  const p = torus.positions;
  const idx = torus.indices;
  const seen = new Set();
  let err = 0;
  const edge = (i, j) => {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    const x = (p[i * 3] + p[j * 3]) / 2;
    const y = (p[i * 3 + 1] + p[j * 3 + 1]) / 2;
    const z = (p[i * 3 + 2] + p[j * 3 + 2]) / 2;
    const d = Math.abs(Math.hypot(Math.hypot(x, z) - 1, y) - tube);
    if (d > err) err = d;
  };
  for (let t = 0; t < idx.length; t += 3) {
    edge(idx[t], idx[t + 1]);
    edge(idx[t + 1], idx[t + 2]);
    edge(idx[t + 2], idx[t]);
  }
  assert.ok(err <= bound + SLACK && err > 0, `torus edge ${err} vs ${bound}`);
});

test('automatic LOD switches a sphere near 59, 15 and 7 pixels of its radius', () => {
  const r = compile('<es3d version="1"><sphere radius="1"/></es3d>');
  assert.ok(r.ok);
  const g = r.scene.geometries[0];
  const lod = (px) => selectLod(g.lodDeviation, g.lods, 1, px, 1);
  assert.equal(lod(80), 0);
  assert.equal(lod(59), 1);
  assert.equal(lod(60), 0);
  assert.equal(lod(15), 2);
  assert.equal(lod(16), 1);
  assert.equal(lod(7), 3);
  assert.equal(lod(8), 2);
  assert.equal(selectLod(g.lodDeviation, g.lods, 1, 80, 2), 0);
});

test('placement sine matches the published polynomial and scatter vectors', () => {
  assert.equal(es3dSin(1), 0.8414709848078965);
  assert.equal(es3dCos(1), 0.5403023058681397);
  for (let d = 0; d <= 360; d += 1) {
    const rad = (d * Math.PI) / 180;
    assert.ok(Math.abs(es3dSin(rad) - Math.sin(rad)) < 1e-12, `sin ${d}`);
    assert.ok(Math.abs(es3dCos(rad) - Math.cos(rad)) < 1e-12, `cos ${d}`);
  }
  assert.ok(Math.abs(es3dSin(Math.PI / 2) - 1) < 1e-15);
  assert.equal(es3dSin(Number.NaN), Number.NaN);
  const r = compile('<es3d version="1"><scatter count="3" radius="2" seed="1"><box/></scatter></es3d>');
  assert.ok(r.ok);
  const pos = (i) => [12, 13, 14].map((k) => r.scene.matrices[i * 16 + k]);
  assert.deepEqual(pos(0).map((v) => v.toFixed(12)), ['1.583526015282', '0.000000000000', '0.027221977711']);
  assert.deepEqual(pos(1).map((v) => v.toFixed(12)), ['-1.916554689407', '0.000000000000', '0.553271830082']);
  assert.deepEqual(pos(2).map((v) => v.toFixed(12)), ['0.134791418910', '0.000000000000', '-1.249123096466']);
  const rot = compile('<es3d version="1"><box rotation="0,90,0"/></es3d>');
  const m = rot.scene.matrices;
  assert.ok(Math.abs(m[0]) < 1e-12 && Math.abs(m[8] - 1) < 1e-12 && Math.abs(m[2] + 1) < 1e-12);
});

test('nesting and path size past the limit are errors', () => {
  const nest = (groups) => {
    let s = '<box/>';
    for (let i = 0; i < groups; i++) s = `<group>${s}</group>`;
    return compile(`<es3d version="1">${s}</es3d>`);
  };
  assert.ok(nest(MAX_DEPTH - 1).ok);
  const deep = nest(MAX_DEPTH);
  assert.equal(deep.ok, false);
  assert.ok(deep.diagnostics.some((d) => d.code === 'E_TOO_DEEP'));

  const path = (commands) => {
    const d = `M0 0 ${'L1 0 '.repeat(commands - 1)}`;
    return compile(`<es3d version="1"><path d="${d}"/></es3d>`);
  };
  assert.ok(path(1000).ok);
  const huge = path(MAX_PATH_COMMANDS + 1);
  assert.equal(huge.ok, false);
  assert.ok(huge.diagnostics.some((d) => d.code === 'E_PATH_LIMIT'));
});

test('alphaMode auto follows opacity, and mesh writers quantize to the scene extent', () => {
  const glass = compile('<es3d version="1"><material id="g" opacity="0.4"/><box material="g"/></es3d>');
  assert.equal(glass.scene.materials[0].alphaMode, 'blend');
  assert.equal(glass.scene.materials[0].transparent, true);
  const solid = compile('<es3d version="1"><box/></es3d>');
  assert.equal(solid.scene.materials[0].alphaMode, 'opaque');
  const mask = compile('<es3d version="1"><material id="m" alphaMode="mask" alphaCutoff="0.2"/><box material="m"/></es3d>');
  assert.equal(mask.scene.materials[0].alphaMode, 'mask');
  assert.equal(mask.scene.materials[0].alphaCutoff, 0.2);
  assert.equal(mask.scene.materials[0].transparent, false);

  const glassText = sceneToMeshDocument(glass.scene, (e, l) => glass.cache.mesh(e, l));
  assert.match(glassText, /alphaMode="blend"/);

  const big = compile('<es3d version="1"><sphere radius="500"/></es3d>');
  const text = sceneToMeshDocument(big.scene, (e, l) => big.cache.mesh(e, l));
  const fracDigits = (token) => (token.split('.')[1] || '').replace(/e.*$/, '').length;
  const normals = /normals="([^"]+)"/.exec(text)[1].split(' ');
  assert.ok(normals.every((n) => fracDigits(n) <= 2));
  assert.ok(normals.some((n) => n !== '0' && n !== '1' && n !== '-1'));
  const positions = /positions="([^"]+)"/.exec(text)[1].split(' ');
  assert.ok(positions.every((n) => fracDigits(n) <= 2));
});
