// Geometry generators: winding, closedness, normals, LOD and deduplication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, formatDiagnostics } from '../src/format/parse.js';
import { describeShape } from '../src/geometry/registry.js';
import { GeometryCache } from '../src/geometry/geometry-cache.js';
import { weldMap, computeNormals } from '../src/geometry/mesh.js';
import { gearOutline } from '../src/geometry/gear.js';
import { spineFrames, helixPoints } from '../src/geometry/sweep.js';

function meshesOf(src) {
  const doc = parse(`<es3d version="1">${src}</es3d>`);
  assert.ok(doc.ok, formatDiagnostics(doc));
  const cache = new GeometryCache();
  cache.beginBuild();
  return doc.root.children
    .filter((c) => c.type === 'element' && c.name !== 'defs')
    .map((el) => {
      const entry = cache.acquire(describeShape(el, {}), el);
      return { el, entry, cache, mesh: cache.mesh(entry, 0) };
    });
}

function analyse(mesh) {
  const p = mesh.positions, n = mesh.normals, idx = mesh.indices;
  let bad = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.hypot(...f) < 1e-10) continue;
    const vn = [n[a] + n[b] + n[c], n[a + 1] + n[b + 1] + n[c + 1], n[a + 2] + n[b + 2] + n[c + 2]];
    if (f[0] * vn[0] + f[1] * vn[1] + f[2] * vn[2] <= 0) bad++;
  }
  const w = weldMap(p);
  const edges = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = w[idx[i + k]], b = w[idx[i + ((k + 1) % 3)]];
      if (a === b) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let boundary = 0;
  for (const v of edges.values()) if (v === 1) boundary++;
  return { bad, boundary };
}

test('closed solids are outward facing and watertight', () => {
  const list = meshesOf(`
    <box/><box size="2,1,1" radius="0.2"/><sphere/><cylinder/><cylinder radiusTop="0.2"/><cone/>
    <capsule radius="0.3" height="2"/><torus/><torus arc="120"/>
    <extrude d="M0,0 L30,0 A40,50 0 0,1 30,100 L0,100 Z M16,16 L30,16 A24,34 0 0,1 30,84 L16,84 Z" fillRule="evenodd" depth="20" bevel="3"/>
    <revolve d="M0.5,0 L1,0 L1,1 L0.5,1 Z" angle="270"/>
    <sweep radius="0.1" along="0,0,0 1,0,0 1,1,0 0,1,0 0,0,0"/>
    <sweep radius="0.2" along="helix(1,0.5,2)"/>
    <gear teeth="20" module="0.1" bore="0.2" bevel="0.02"/>`);
  for (const { el, mesh } of list) {
    const r = analyse(mesh);
    assert.equal(r.bad, 0, `${el.name} has inward facing triangles`);
    assert.equal(r.boundary, 0, `${el.name} is not closed`);
  }
});

test('open and flat surfaces are flagged double sided', () => {
  const list = meshesOf(`<plane/><polygon points="0,0 1,0 0,1"/><revolve d="M0,0 L1,0 L1,1"/><cylinder caps="false"/><sweep radius="0.1" along="0,0,0 1,0,0" caps="false"/>`);
  for (const { el, entry } of list) assert.ok(entry.doubleSided, el.name);
});

test('primitives share canonical meshes; sizes move into the instance transform', () => {
  const list = meshesOf('<sphere radius="1"/><sphere radius="5"/><box size="1"/><box size="3,1,2"/><cylinder radius="2" height="9"/><cylinder radius="1" height="1"/>');
  assert.equal(list[0].entry, list[1].entry);
  assert.equal(list[2].entry, list[3].entry);
  assert.equal(list[4].entry, list[5].entry);
  assert.equal(list[0].cache.entries.size, 3);
});

test('levels of detail reduce triangle counts and are generated lazily', () => {
  const [{ entry, cache }] = meshesOf('<sphere/>');
  assert.equal(entry.lods, 4);
  assert.equal(entry.meshes.filter(Boolean).length, 1);
  const counts = [0, 1, 2, 3].map((l) => cache.mesh(entry, l).primitiveCount);
  for (let i = 1; i < 4; i++) assert.ok(counts[i] < counts[i - 1]);
  const fixed = meshesOf('<sphere segments="12"/>')[0];
  assert.equal(fixed.entry.lods, 1);
});

test('normals are unit length', () => {
  for (const { el, mesh } of meshesOf('<sphere/><torus/><gear/><capsule/><extrude d="M0,0 C5,10 10,-10 15,0 Z"/>')) {
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const l = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]);
      assert.ok(Math.abs(l - 1) < 1e-3, `${el.name} normal ${i / 3} has length ${l}`);
    }
  }
});

test('crease-angle normals split hard edges and keep smooth ones', () => {
  // two triangles folded at 90 degrees share an edge
  const p = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0]);
  const idx = Uint32Array.from([0, 2, 1, 0, 1, 3]);
  assert.equal(computeNormals(p, idx, 30).vertexCount, 6);
  assert.equal(computeNormals(p, idx, 100).vertexCount, 4);
});

test('gear outline is a simple closed counter-clockwise contour', () => {
  const g = gearOutline(24, 20, 6, 3);
  const pts = g.outline.points;
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (pts[j * 2] - pts[i * 2]) * (pts[j * 2 + 1] + pts[i * 2 + 1]);
  assert.ok(a > 0);
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(pts[i * 2], pts[i * 2 + 1]);
    assert.ok(r >= g.rootRadius - 1e-9 && r <= g.outerRadius + 1e-9);
  }
});

test('rotation minimising frames stay orthonormal and close seamlessly', () => {
  const f = spineFrames(helixPoints(1, 0.4, 3, 48), false);
  const at = (a, i) => a.subarray(i * 3, i * 3 + 3);
  for (let i = 0; i < f.count; i++) {
    const [T, N, B] = [at(f.T, i), at(f.N, i), at(f.B, i)];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.ok(Math.abs(dot(T, N)) < 1e-6 && Math.abs(dot(T, B)) < 1e-6 && Math.abs(dot(N, N) - 1) < 1e-6);
  }
  const ring = [];
  for (let i = 0; i < 16; i++) ring.push(Math.cos((i / 16) * 6.283), Math.sin((i / 16) * 6.283), Math.sin((i / 8) * 6.283) * 0.3);
  const closed = spineFrames(Float64Array.from(ring), true);
  const a = at(closed.N, 0), b = at(closed.N, closed.count - 1);
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9);
});
