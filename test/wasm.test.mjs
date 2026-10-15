import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { wasmEnabled, setWasmEnabled, instanceKernelEnabled, cosSinWasm } from '../src/wasm/kernels.js';
import { compile } from '../src/pipeline.js';
import { GeometryCache } from '../src/geometry/geometry-cache.js';
import { sweepMesh } from '../src/geometry/sweep.js';
import { computeNormals } from '../src/geometry/mesh.js';
import { extrudeMesh } from '../src/geometry/extrude.js';
import { triangulate } from '../src/path/triangulate.js';
import { buildRegions } from '../src/path/shapes.js';
import { unitSphere, unitCylinder, unitCapsule, unitTorus, roundedBox } from '../src/geometry/primitives.js';
import { catmullRom } from '../src/geometry/sweep.js';
import { gearOutline } from '../src/geometry/gear.js';
import { parseTyped } from '../src/format/values.js';
import { BENCH_SCENES, benchSceneSource } from '../src/bench/scenes.js';
import { updateDynamic } from '../src/scene/flatten.js';
import { es3dCos, es3dSin } from '../src/math/trig.js';

// The WebAssembly kernels must give exactly what the JavaScript versions
// give: every value, every index, every report, in the same order.

const EXAMPLES = new URL('../docs/public/examples/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, EXAMPLES), 'utf8');
const same = (a, b, what) => {
  for (const k of ['positions', 'normals', 'uvs', 'indices']) {
    assert.equal(a[k].constructor, b[k].constructor, `${what}: ${k} type`);
    assert.ok(a[k].length === b[k].length && a[k].every((v, i) => Object.is(v, b[k][i])), `${what}: ${k}`);
  }
};
/** fn() with the kernels and without them. */
const both = (fn) => {
  setWasmEnabled(true);
  const a = fn();
  setWasmEnabled(false);
  try {
    return [a, fn()];
  } finally {
    setWasmEnabled(true);
  }
};

let seed = 1;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;

test('the kernels load in Node', () => {
  assert.ok(wasmEnabled());
  assert.ok(instanceKernelEnabled());
});

test('every mesh of the example and benchmark scenes is identical', async () => {
  const sources = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith('.es3d')).map((f) => [f, read(f)]);
  for (const d of BENCH_SCENES) sources.push([d.id, await benchSceneSource(d, async (f) => read(f))]);
  for (const [name, src] of sources) {
    const [a, b] = both(() => {
      const r = compile(src, { cache: new GeometryCache() });
      // a document with errors has no scene: then its messages must match
      if (!r.scene) return r.diagnostics.map((d) => d.message);
      return r.scene.geometries.map((e) => Array.from({ length: e.lods }, (_, l) => r.cache.mesh(e, l)));
    });
    if (typeof a[0] === 'string' || typeof b[0] === 'string') assert.deepEqual(a, b, name);
    else a.forEach((lods, g) => lods.forEach((m, l) => same(m, b[g][l], `${name} geometry ${g} lod ${l}`)));
  }
});

test('sweeps: open, closed and degenerate spines, twist, taper, shape profiles', () => {
  const square = { kind: 'shape', regions: [{ outer: { points: Float64Array.from([-1, -1, 1, -1, 1, 1, -1, 1]), smooth: new Uint8Array(4), closed: true, isWall: true }, holes: [] }] };
  square.walls = [square.regions[0].outer];
  for (let t = 0; t < 120; t++) {
    const pts = [];
    for (let i = 0, n = 1 + Math.floor(rnd() * 10); i < n; i++) pts.push(...(t % 4 === 0 ? [i % 2, 0, i % 3 ? 1 : 0] : t % 4 === 1 ? [0, 0, 0] : [rnd() * 4, rnd() * 4, rnd() * 4]));
    const spines = [{ points: Float64Array.from(pts), closed: rnd() < 0.4 }];
    const o = { twist: rnd() < 0.5 ? rnd() * 720 - 360 : 0, taper: rnd() < 0.5 ? rnd() * 2 : undefined, caps: rnd() < 0.7 };
    for (const profile of [{ kind: 'circle', radius: 0.1 + rnd(), segments: 3 + Math.floor(rnd() * 20) }, square]) {
      const [a, b] = both(() => {
        const reports = [];
        return { ...sweepMesh(profile, spines, o, (...r) => reports.push(r.join('|'))), reports };
      });
      same(a.mesh, b.mesh, `sweep ${t}`);
      assert.equal(a.doubleSided, b.doubleSided);
      assert.deepEqual(a.reports, b.reports);
    }
  }
});

test('normals for every crease angle, with and without uvs', () => {
  for (let t = 0; t < 60; t++) {
    const nv = 3 + Math.floor(rnd() * 40);
    const p = new Float32Array(nv * 3).map(() => (t % 2 ? Math.round(rnd() * 3) : rnd() * 2 - 1));
    const idx = new Uint32Array(3 * (1 + Math.floor(rnd() * 60))).map(() => Math.floor(rnd() * nv));
    const uv = t % 3 ? new Float32Array(nv * 2).map(() => rnd()) : null;
    for (const crease of [0, 1, 30, 179.9, 180]) {
      const [a, b] = both(() => computeNormals(p, idx, crease, uv));
      same(a, b, `normals ${t} at ${crease}°`);
    }
  }
});

test('triangulation and extrusion of outlines with holes and bevels', () => {
  const ring = (cx, cy, r, n, jitter, cw) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = ((cw ? -1 : 1) * i * Math.PI * 2) / n, rr = r * (1 + (rnd() - 0.5) * jitter);
      out.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    return out;
  };
  for (let t = 0; t < 200; t++) {
    const data = ring(0, 0, 10, 3 + Math.floor(rnd() * (t % 3 ? 40 : 200)), t % 5 ? 0.3 : 1.8, false);
    const holes = [];
    for (let h = 0; h < (t % 4 ? 0 : 3); h++) {
      holes.push(data.length / 2);
      data.push(...ring((rnd() - 0.5) * 8, (rnd() - 0.5) * 8, 1 + rnd() * 2, 3 + Math.floor(rnd() * 10), 0.4, true));
    }
    const [a, b] = both(() => triangulate(data, holes.length ? holes : null));
    assert.deepEqual(a, b, `triangulation ${t}`);
  }
  for (let t = 0; t < 60; t++) {
    const outer = ring(0, 0, 5, 3 + Math.floor(rnd() * 40), t % 3 ? 0.2 : 1.2, false);
    const contours = [{ points: Float64Array.from(outer), smooth: Uint8Array.from({ length: outer.length / 2 }, () => (rnd() < 0.5 ? 1 : 0)), closed: true }];
    if (t % 2) {
      const hole = ring(0.5, 0.2, 1.5, 3 + Math.floor(rnd() * 12), 0.2, true);
      contours.push({ points: Float64Array.from(hole), smooth: new Uint8Array(hole.length / 2), closed: true });
    }
    const shape = buildRegions(contours, 'nonzero');
    const o = { depth: 0.2 + rnd() * 2, bevel: t % 3 ? rnd() * 0.3 : 0, bevelSegments: 1 + Math.floor(rnd() * 3), center: rnd() < 0.5 };
    const [a, b] = both(() => {
      const reports = [];
      return { mesh: extrudeMesh(shape, o, (...r) => reports.push(r.join('|'))), reports };
    });
    same(a.mesh, b.mesh, `extrusion ${t}`);
    assert.deepEqual(a.reports, b.reports);
  }
});

test('primitives, smooth spines and gear outlines', () => {
  const eq = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  for (let s = 0; s <= 40; s += 3) {
    same(...both(() => unitSphere(s)), `sphere ${s}`);
    same(...both(() => unitCapsule(s % 2 ? 0 : 1.7, s)), `capsule ${s}`);
    for (const top of [0, 0.4, 1]) for (const caps of [true, false]) same(...both(() => unitCylinder(top, s, caps)), `cylinder ${top} ${s}`);
    for (const arc of [360, 270, 33.3]) same(...both(() => unitTorus(0.3, arc, s, 3 + (s % 9))), `torus ${arc} ${s}`);
  }
  for (let t = 0; t < 60; t++) {
    const w = rnd() * 3, h = rnd() * 3, d = rnd() * 3, r = t % 7 ? (rnd() * Math.min(w, h, d)) / 2 : 0;
    same(...both(() => roundedBox(w, h, d, r, 1 + (t % 6))), `rounded box ${t}`);
  }
  for (let t = 0; t < 100; t++) {
    const pts = Float64Array.from({ length: 3 * (2 + Math.floor(rnd() * 10)) }, () => (t % 9 ? rnd() * 4 - 2 : Math.round(rnd() * 2)));
    if (t % 11 === 0) pts.set(pts.subarray(0, 3), 3);
    const closed = rnd() < 0.4, subdivisions = 1 + Math.floor(rnd() * 12);
    const [a, b] = both(() => catmullRom(pts, closed, subdivisions));
    assert.ok(eq(a, b), `spline ${t}`);
  }
  for (const teeth of [3, 8, 17, 40]) for (const angle of [14.5, 20, 35]) {
    const [a, b] = both(() => gearOutline(teeth, angle, 4, 2));
    assert.ok(eq(a.outline.points, b.outline.points) && eq(a.outline.smooth, b.outline.smooth), `gear ${teeth} ${angle}`);
    assert.ok(Object.is(a.outerRadius, b.outerRadius) && Object.is(a.rootRadius, b.rootRadius));
  }
});

test('long number lists: values, types and errors', () => {
  const token = () => {
    let s = rnd() < 0.3 ? '-' : '';
    for (let d = Math.floor(rnd() * 6); d >= 0; d--) s += Math.floor(rnd() * 10);
    if (rnd() < 0.7) s += '.' + Math.floor(rnd() * 1e6);
    if (rnd() < 0.1) s += 'e' + (rnd() < 0.5 ? '-' : '') + Math.floor(rnd() * 30);
    return s;
  };
  for (let t = 0; t < 40; t++) {
    let raw = Array.from({ length: 400 }, token).join(t % 2 ? ' ' : ', ');
    if (t % 10 === 3) raw += ',';
    if (t % 10 === 5) raw = raw.replace(/ (\d)/, ' x$1');
    const ints = Array.from({ length: 400 }, () => Math.floor(rnd() * 5000)).join(' ');
    for (const [type, text] of [['floats', raw], ['points3', raw], ['indices', ints], ['indices', raw]]) {
      const run = () => {
        try {
          return parseTyped({ type }, text);
        } catch (e) {
          return e.message;
        }
      };
      const [a, b] = both(run);
      if (typeof a === 'string' || typeof b === 'string') assert.equal(a, b);
      else assert.ok(a.constructor === b.constructor && a.length === b.length && a.every((v, i) => Object.is(v, b[i])), `${type} ${t}`);
    }
  }
});

/** Every instance row, lod switch, bound, geometry and material of two flattened scenes. */
function sameScene(a, b, what) {
  assert.equal(a.count, b.count, `${what}: count`);
  assert.equal(a.capacity, b.capacity, `${what}: capacity`);
  for (const k of ['matrices', 'spheres', 'geom', 'mat', 'uid', 'lodNode', 'lodChild', 'flags']) {
    const n = (a[k].length / a.capacity) * a.count;
    for (let i = 0; i < n; i++) if (!Object.is(a[k][i], b[k][i])) assert.fail(`${what}: ${k}[${i}] ${a[k][i]} != ${b[k][i]}`);
  }
  assert.deepStrictEqual(a.bounds, b.bounds, `${what}: bounds`);
  assert.deepStrictEqual(a.lodSwitches, b.lodSwitches, `${what}: lod switches`);
  assert.deepStrictEqual(a.geometries.map((g) => g.key), b.geometries.map((g) => g.key), `${what}: geometries`);
  assert.deepStrictEqual(a.materials.map((m) => [m.name, m.params]), b.materials.map((m) => [m.name, m.params]), `${what}: materials`);
  assert.deepStrictEqual(a.dynamic.map((d) => [d.start, d.end, d.switchStart, d.switchEnd]), b.dynamic.map((d) => [d.start, d.end, d.switchStart, d.switchEnd]), `${what}: segments`);
}

/** The scene compiled from src with and without the kernels, and again after updateDynamic at `times`. */
function bothScenes(src, what, times = []) {
  const [a, b] = both(() => {
    const r = compile(src, { cache: new GeometryCache() });
    if (!r.scene) return { messages: r.diagnostics.map((d) => d.message) };
    const frames = [];
    for (const t of times) {
      updateDynamic(r.scene, r.graph, t);
      const sc = r.scene;
      const copy = { count: sc.count, capacity: sc.capacity, geometries: sc.geometries, materials: sc.materials, dynamic: sc.dynamic };
      for (const k of ['matrices', 'spheres', 'geom', 'mat', 'uid', 'lodNode', 'lodChild', 'flags']) copy[k] = sc[k].slice();
      frames.push({ ...copy, bounds: structuredClone(sc.bounds), lodSwitches: structuredClone(sc.lodSwitches) });
    }
    return { scene: r.scene, frames };
  });
  if (a.messages || b.messages) return assert.deepEqual(a.messages, b.messages, what);
  sameScene(a.scene, b.scene, what);
  a.frames.forEach((f, k) => sameScene(f, b.frames[k], `${what} at ${times[k]} s`));
}

test('the instance table of every example and benchmark scene is identical', async () => {
  const sources = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith('.es3d')).map((f) => [f, read(f)]);
  for (const d of BENCH_SCENES) sources.push([d.id, await benchSceneSource(d, async (f) => read(f))]);
  for (const [name, src] of sources) bothScenes(src, name, name.includes('solar') ? [0.7, 13.1] : []);
});

test('repeat and scatter: placement modes, nesting, lod, colours, mirroring, long elements', () => {
  const r = (lo, hi) => +(lo + rnd() * (hi - lo)).toFixed(3);
  const pick = (...a) => a[Math.floor(rnd() * a.length)];
  const placement = () =>
    (rnd() < 0.5 ? ` position="${r(-3, 3)},${r(-1, 1)},${r(-3, 3)}"` : '') +
    (rnd() < 0.4 ? ` rotation="${r(-90, 90)},${r(0, 360)},${r(-30, 30)}"` : '') +
    (rnd() < 0.3 ? ` scale="${pick(r(0.5, 2), `${r(-2, 2)},${r(0.5, 2)},${r(0.5, 2)}`)}"` : '');
  const style = () => (rnd() < 0.3 ? ` material="m${Math.floor(rnd() * 4)}"` : '') + (rnd() < 0.2 ? ` color="#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')}"` : '') + (rnd() < 0.1 ? ' collide="false"' : '');
  const shape = () => pick(`<box size="${r(0.2, 2)}"`, `<sphere radius="${r(0.2, 1)}"`, `<cylinder radius="${r(0.1, 0.5)}" height="${r(0.5, 2)}"`, `<torus radius="${r(0.5, 1)}" tube="0.1"`, '<cone') + placement() + style() + (rnd() < 0.05 ? ' visible="false"' : '') + '/>';
  const subtree = (depth) => {
    const k = rnd();
    if (depth > 2 || k < 0.45) return shape();
    if (k < 0.65) return `<group${placement()}${style()}>${shape()}${subtree(depth + 1)}</group>`;
    if (k < 0.8) return `<use ref="${pick('t', 'l')}"${placement()}${style()}/>`;
    if (k < 0.9) return `<lod distances="${r(5, 20)},${r(30, 60)}"${placement()}>${shape()}<group>${subtree(depth + 1)}</group><box/></lod>`;
    return pick('<light type="point" position="0,2,0"/>', `<repeat count="3" step="translate(1,0,0)">${shape()}</repeat>`, `<group><animate attr="position" to="0,1,0" dur="2s"/>${shape()}</group>`);
  };
  const children = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => subtree(0)).join('');
  const range = () => pick(`${r(0.5, 1)}..${r(1, 2)}`, `${r(0.5, 1)}..${r(1, 2)},${r(0.1, 0.5)}..${r(0.5, 1)},1`);
  const scatter = (count) => {
    const mode = pick(`grid="${1 + Math.floor(rnd() * 30)},${1 + Math.floor(rnd() * 30)}" spacing="${r(0.5, 3)},${r(0.5, 3)}"` + (rnd() < 0.7 ? ` jitter="${r(0, 1)}"` : ''), `count="${count}" radius="${r(1, 50)}"`, `count="${count}" area="${r(1, 50)},${r(1, 50)}"`);
    return (
      `<scatter ${mode} seed="${Math.floor(rnd() * 2 ** 32)}"` +
      (rnd() < 0.6 ? ` randomScale="${range()}"` : '') +
      (rnd() < 0.6 ? ` randomRotation="${pick(`0,0..360,0`, `${r(-45, 0)}..${r(0, 45)},0..360,${r(-10, 0)}..${r(0, 10)}`)}"` : '') +
      (rnd() < 0.5 ? ` randomMaterial="${pick('m0,m1', 'm1,m2,m3', 'm3')}"` : '') +
      placement() + style() + `>${children()}</scatter>`
    );
  };
  const repeat = (count) => `<repeat count="${count}" step="translate(${r(-2, 2)},${r(0, 1)},${r(-2, 2)}) rotate(${r(-20, 20)},${r(0, 40)},0) scale(${pick(1, r(0.9, 1.1), -1)})"${placement()}${style()}>${children()}</repeat>`;
  const defs = '<defs>' + [0, 1, 2, 3].map((k) => `<material id="m${k}" color="#${(0x305070 + k * 0x203010).toString(16)}"/>`).join('') + `<group id="t">${shape()}${shape()}</group><lod id="l" distances="10,40"><group>${shape()}${shape()}</group>${shape()}<box/></lod></defs>`;
  for (let t = 0; t < 60; t++) {
    const body = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => (rnd() < 0.6 ? scatter(1 + Math.floor(rnd() * 400)) : repeat(1 + Math.floor(rnd() * 60)))).join('');
    const doc = `<es3d version="1">${defs}<group${placement()}${style()}>${body}</group></es3d>`;
    bothScenes(doc, `document ${t}`);
  }
  // several kernel calls for one element, inside an animated group
  const long = `<es3d version="1">${defs}<group><animate attr="rotation" to="0,360,0" dur="4s"/>${scatter(20000).replace(/<scatter count="\d+" (radius|area)/, '<scatter count="20000" $1')}<scatter count="3000" area="80,80" seed="7" randomMaterial="m0,m1,m2"><use ref="l"/><use ref="t" color="#ff0000"/></scatter></group></es3d>`;
  bothScenes(long, 'long elements', [0.5, 2.75]);
});

test('placement sine and cosine', () => {
  const values = [0, -0, 1e-300, -5e-324, 1, -1, 1e10, -1e15, 1e300, Infinity, -Infinity, NaN];
  for (let k = -16; k <= 16; k++) values.push((k * Math.PI) / 4, (k * Math.PI) / 4 + 1e-15, (k * Math.PI) / 4 - 1e-15);
  for (let i = 0; i < 20000; i++) values.push((rnd() - 0.5) * 10 ** (Math.floor(rnd() * 12) - 2));
  for (const x of values) {
    const [c, s] = cosSinWasm(x);
    if (!Object.is(c, es3dCos(x)) || !Object.is(s, es3dSin(x))) assert.fail(`x = ${x}: ${c}, ${s} != ${es3dCos(x)}, ${es3dSin(x)}`);
  }
});
