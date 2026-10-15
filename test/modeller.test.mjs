// The ES3D Modeller's model: planes from typed points, and its ES3D output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/pipeline.js';
import { parse } from '../src/format/parse.js';
import { walk } from '../src/format/ast.js';
import { localMatrix } from '../src/transform/transform.js';
import { mulberry32 } from '../src/math/random.js';
import * as mat4 from '../src/math/mat4.js';
import {
  createModel,
  addPoint,
  makePlane,
  analysePlane,
  repairPlanes,
  deletePoints,
  renamePaint,
  toES3D,
  previewES3D,
  fromES3D,
  parsePointList,
  restoreModel,
  exampleHouse,
  modelExtent,
} from '../src/modeller/model.js';

const modelWith = (pts) => {
  const m = createModel();
  for (const p of pts) addPoint(m, p);
  return m;
};
const tags = (text, name) => [...text.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((x) => x[0]);
const coords = (m) => m.points.map((p) => [p.x, p.y, p.z]);
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalizeV = (a) => a.map((x) => x / Math.hypot(...a));
const near = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);

test('the example house is written as polygons grouped by paint, and validates without a warning', () => {
  const text = toES3D(exampleHouse());
  const c = compile(text);
  assert.ok(c.ok, c.diagnostics.map((d) => d.message).join('\n'));
  assert.deepEqual(c.diagnostics, []);
  assert.equal(tags(text, 'polygon').length, 7);
  assert.equal(tags(text, 'mesh').length, 0);
  assert.deepEqual(tags(text, 'material'), ['<material id="chalk" color="#e9e4d8"/>', '<material id="clay" color="#c8553d"/>', '<material id="slate" color="#5c677d"/>']);
  assert.deepEqual(tags(text, 'group'), ['<group material="chalk">', '<group material="clay">', '<group material="slate">']);
  // walls get whole-number turns, outward; the floor faces down
  assert.match(text, /<polygon position="2,0,-1.5" rotation="0,180,0" points="0,0 4,0 4,2 0,2"\/>/);
  assert.match(text, /<polygon position="-2,0,-1.5" rotation="0,-90,0" points="0,0 3,0 3,2 1.5,3 0,2"\/>/);
  assert.match(text, /<polygon position="-2,0,-1.5" rotation="90,0,0" points="0,0 4,0 4,3 0,3"\/>/);
  assert.deepEqual(c.scene.bounds, { min: [-2, 0, -1.5], max: [2, 3, 1.5] });
});

test('reading the output back gives the same points and planes', () => {
  const house = exampleHouse();
  const { model, objects } = fromES3D(toES3D(house));
  assert.equal(objects, 0);
  const key = (p) => `${p[0]},${p[1]},${p[2]}`;
  assert.deepEqual(new Set(coords(model).map(key)), new Set(coords(house).map(key)));
  assert.equal(model.planes.length, 7);
  const byPos = (m) => new Map(m.points.map((p) => [p.id, key([p.x, p.y, p.z])]));
  const faceSet = (m) => new Set(m.planes.map((pl) => `${pl.paint}:${pl.points.map((id) => byPos(m).get(id)).sort().join('|')}`));
  assert.deepEqual(faceSet(model), faceSet(house));
});

test('faces at any angle keep their corners through ES3D', () => {
  // a pentagon on a tilted, turned plane, and a triangle under it
  const u = [0.6, 0.48, -0.64];
  const v = [0, 0.8, 0.6];
  const at = (a, b, o = [1.25, -0.5, 3]) => [o[0] + a * u[0] + b * v[0], o[1] + a * u[1] + b * v[1], o[2] + a * u[2] + b * v[2]];
  const m = modelWith([at(0, 0), at(2, 0), at(2.5, 1), at(1, 2.2), at(-0.5, 1), [0, -3, 0], [2, -3.5, 1], [1, -2, 2]]);
  assert.equal(makePlane(m, [1, 2, 3, 4, 5], 'sky').split, false);
  makePlane(m, [6, 7, 8], 'clay');
  const text = toES3D(m);
  assert.ok(compile(text).ok);
  const back = fromES3D(text).model;
  for (const p of m.points) assert.ok(back.points.some((q) => near([q.x, q.y, q.z], [p.x, p.y, p.z])), `${p.x},${p.y},${p.z} lost`);
  assert.equal(back.points.length, 8);
});

test('a reader rebuilds every corner to within 10⁻⁷ of the model size, at any angle and scale', () => {
  const rand = mulberry32(7);
  for (const scale of [0.01, 1, 250]) {
    const m = createModel();
    for (let f = 0; f < 12; f++) {
      // a convex outline on a random plane through a random centre
      const n = normalizeV([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
      const u = normalizeV(crossV(n, [rand(), rand(), rand()]));
      const v = crossV(n, u);
      const c = [rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2];
      const k = 3 + Math.floor(rand() * 4);
      const ids = [];
      for (let i = 0; i < k; i++) {
        const a = (i / k) * Math.PI * 2;
        const r = 0.5 + rand();
        ids.push(addPoint(m, [0, 1, 2].map((j) => (c[j] + r * (Math.cos(a) * u[j] + Math.sin(a) * v[j])) * scale)).id);
      }
      assert.equal(makePlane(m, ids, 'sky').planes.length, 1);
    }
    const extent = modelExtent(m);
    let worst = 0;
    const doc = parse(toES3D(m));
    let f = 0;
    walk(doc.root, (el) => {
      if (el.name !== 'polygon') return;
      const world = localMatrix(el.values);
      const corners = [];
      for (let i = 0; i < el.values.points.length; i += 2) corners.push(mat4.transformPoint([0, 0, 0], world, el.values.points[i], el.values.points[i + 1], 0));
      for (const id of m.planes[f++].points) {
        const p = m.points.find((q) => q.id === id);
        worst = Math.max(worst, Math.min(...corners.map((q) => Math.hypot(q[0] - p.x, q[1] - p.y, q[2] - p.z))));
      }
    });
    assert.equal(f, 12);
    assert.ok(worst <= 1e-7 * extent, `scale ${scale}: ${worst / extent} of the size`);
  }
});

test('congruent faces are written with one outline, so the renderer keeps one shape for all of them', () => {
  const m = modelWith([[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2], [1, 1.5, 1]]);
  for (const t of [[1, 2, 5], [2, 3, 5], [3, 4, 5], [4, 1, 5]]) makePlane(m, t, 'sand');
  const text = toES3D(m);
  const polygons = tags(text, 'polygon');
  // each outline starts at its lowest, leftmost corner
  assert.deepEqual(new Set(polygons.map((t) => /points="([^"]*)"/.exec(t)[1])), new Set(['0,0 2,0 1,1.8027756']));
  assert.deepEqual(polygons.map((t) => /rotation="([^"]*)"/.exec(t)[1]).sort(), ['-33.690068,-90,0', '-33.690068,0,0', '-33.690068,180,0', '-33.690068,90,0']);
  const c = compile(text);
  assert.equal(c.scene.count, 4);
  assert.equal(c.scene.geometries.length, 1);
});

test('points that are not on one flat plane are split into triangles along the short diagonal', () => {
  const m = modelWith([[0, 0, 0], [2, 0, 0], [2, 0.5, 2], [0, 0, 2]]);
  const r = makePlane(m, [1, 2, 3, 4], 'clay');
  assert.equal(r.split, true);
  assert.deepEqual(r.planes.map((p) => p.points), [[4, 1, 2], [2, 3, 4]]);
  assert.ok(r.planes.every((p) => p.paint === 'clay'));
  // a flat quad stays one plane
  const f = modelWith([[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]]);
  assert.equal(makePlane(f, [1, 2, 3, 4], 'clay').planes.length, 1);
});

test('points picked out of order are put in order around the outline', () => {
  const m = modelWith([[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]]);
  const r = makePlane(m, [1, 3, 2, 4], 'sea');
  assert.equal(r.reordered, true);
  assert.equal(r.planes.length, 1);
  assert.equal(analysePlane(m, r.planes[0].points).reordered, false);
  assert.match(makePlane(m, [4, 2, 1, 3], 'sea').error, /already make Plane 1/);
});

test('planes that cannot be made say why', () => {
  const m = modelWith([[0, 0, 0], [1, 1, 1], [2, 2, 2], [0, 0, 0], [5, 0, 0]]);
  assert.match(makePlane(m, [1, 2], 'sea').error, /at least 3/);
  assert.match(makePlane(m, [1, 2, 3], 'sea').error, /on one line/);
  assert.match(makePlane(m, [1, 4, 5], 'sea').error, /P1 and P4 are at the same place/);
  assert.match(makePlane(m, [1, 2, 1], 'sea').error, /once/);
  assert.equal(m.planes.length, 0);
});

test('moving a point out of a flat plane splits it; deleting points removes planes left with fewer than 3', () => {
  const m = modelWith([[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2], [1, 2, 1]]);
  makePlane(m, [1, 2, 3, 4], 'sand');
  makePlane(m, [1, 2, 5], 'leaf');
  m.points[2].y = 1;
  const notes = repairPlanes(m, new Set([3]));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Plane 1 was no longer flat, so it is now 2 triangles/);
  assert.equal(m.planes.length, 3);
  assert.equal(m.planes[0].id, 1);
  // the triangle P1 P2 P5 goes with P5; the split quad's triangles stay
  const { removedPlanes } = deletePoints(m, [5]);
  assert.equal(removedPlanes, 1);
  assert.deepEqual(m.planes.map((p) => p.points), [[4, 1, 2], [2, 3, 4]]);
  // a pentagon that loses a corner is a quad
  const p = modelWith([[0, 0, 0], [2, 0, 0], [3, 0, 1], [1, 0, 2], [-1, 0, 1]]);
  makePlane(p, [1, 2, 3, 4, 5], 'sand');
  assert.equal(deletePoints(p, [3]).removedPlanes, 0);
  assert.deepEqual(p.planes[0].points, [1, 2, 4, 5]);
});

test('renaming a paint renames its material, and planes follow', () => {
  const m = exampleHouse();
  assert.equal(renamePaint(m, 'clay', 'roof tiles'), 'roof-tiles');
  assert.equal(renamePaint(m, 'chalk', 'roof-tiles'), 'roof-tiles2');
  assert.equal(renamePaint(m, 'slate', '3d'), 'paint3d');
  const text = toES3D(m);
  assert.match(text, /<material id="roof-tiles" color="#c8553d"\/>/);
  assert.match(text, /<group material="roof-tiles">/);
  assert.ok(compile(text).ok);
});

test('the preview adds markers, edges and a grid; the saved file has none of them', () => {
  const m = exampleHouse();
  const preview = previewES3D(m, { selectedPoints: [1, 2, 3], selectedPlanes: [5] });
  const c = compile(preview);
  assert.ok(c.ok, c.diagnostics.map((d) => d.message).join('\n'));
  assert.deepEqual(c.diagnostics, []);
  assert.equal(tags(preview, 'sphere').length, 10);
  assert.equal(tags(preview, 'repeat').length, 2);
  assert.ok(tags(preview, 'line').length >= 17 + 4 + 3);
  const saved = toES3D(m);
  assert.doesNotMatch(saved, /sphere|line|repeat|_pt|editing aids/);
  // a lone point, or two at one place, still make a valid preview
  const lone = modelWith([[0, 0, 0], [0, 0, 0]]);
  assert.ok(compile(previewES3D(lone, { selectedPoints: [1, 2] })).ok);
  assert.ok(compile(previewES3D(createModel())).ok);
});

test('polygons are read with their group transforms, materials and colours; every other element is kept', () => {
  const text = `<es3d version="1">
    <material id="red" color="#ff0000"/>
    <group transform="translate(10,0,0)" material="red">
      <polygon points="0,0 1,0 0,1"/>
      <polygon points="0,0 1,0 0,1" rotation="-90,0,0" color="#00ff00"/>
    </group>
    <box/>
    <defs><polygon id="hidden" points="0,0 1,0 0,1"/></defs>
  </es3d>`;
  const { model, objects } = fromES3D(text);
  // the box and the defs (with its polygon, which has an id) stay elements; the emptied group goes
  assert.equal(objects, 3);
  assert.deepEqual(model.objects.map((n) => n.name), ['box', 'defs']);
  assert.deepEqual(model.objects[1].children[0].attrs, { id: 'hidden', points: '0,0 1,0 0,1' });
  assert.equal(model.planes.length, 2);
  assert.deepEqual(model.planes.map((p) => p.paint), ['red', 'c00ff00']);
  assert.ok(model.paints.some((p) => p.id === 'red' && p.color === '#ff0000'));
  const pos = new Set(coords(model).map((p) => p.join(',')));
  // the first corner is shared; the turned triangle lies flat, pointing to -z
  assert.deepEqual([...pos].sort(), ['10,0,-1', '10,0,0', '10,1,0', '11,0,0'].sort());
  assert.throws(() => fromES3D('<es3d version="1"><boks/></es3d>'), /error/);
  // material ids that start with '_' are the preview's own, so they are renamed
  const own = fromES3D('<es3d version="1"><material id="_pt" color="#f00"/><polygon material="_pt" points="0,0 1,0 0,1"/></es3d>').model;
  assert.equal(own.planes[0].paint, 'm_pt');
  assert.ok(compile(previewES3D(own)).ok);
});

test('pasted point lists: separators, labels and headers', () => {
  const r = parsePointList('x, y, z\nP1: 1, 2, 3\n(4 5 6)\n\n7;8;9 10 11 12\n1e1\t-2\t.5\n1 2\n');
  assert.deepEqual(r.points, [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [10, -2, 0.5]]);
  assert.deepEqual(r.errors, [{ line: 7, text: '1 2' }]);
});

test('saved editor state is checked when it is read back', () => {
  const m = exampleHouse();
  assert.deepEqual(restoreModel(JSON.parse(JSON.stringify(m))), m);
  assert.equal(restoreModel({ points: 'no' }), null);
  const r = restoreModel({ title: 1, points: [{ id: 1, x: 0, y: 0, z: 0 }, { id: 2, x: 'a' }], planes: [{ id: 1, points: [1, 2, 3] }], paints: [{ id: '9bad', color: 'red' }], nextPoint: 0 });
  assert.equal(r.points.length, 1);
  assert.equal(r.planes.length, 0);
  assert.equal(r.paints[0].id, 'chalk');
  assert.equal(r.nextPoint, 2);
});
