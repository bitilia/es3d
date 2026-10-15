// The ES3D Modeller's other elements: placed from points, edited, read and written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/pipeline.js';
import { parse } from '../src/format/parse.js';
import { treesEqual } from '../src/format/ast.js';
import { formatNumber } from '../src/format/value-format.js';
import { createModel, addPoint, makePlane, deletePoints, toES3D, previewES3D, fromES3D, checkModel, restoreModel, exampleHouse } from '../src/modeller/model.js';
import { CATALOGUE, placeElement, insertObject, findObject, duplicateObject, removeObject, moveObject, toFrame, anchorOf, accepts } from '../src/modeller/objects.js';

const fmt = (v) => formatNumber(v, 7);
const place = (name, points = [], extra = {}) => placeElement(name, { points, fmt, paint: 'clay', ...extra });
const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const boundsOf = (text) => {
  const c = compile(text);
  assert.ok(c.ok, c.diagnostics.map((d) => d.message).join('\n'));
  return c.scene.bounds;
};
const only = (model, name, points) => {
  const r = place(name, points);
  assert.ok(r.node, r.error);
  insertObject(model, r.node);
  return toES3D(model);
};

test('every element in the Add menu can be added, and the file validates', () => {
  const m = createModel();
  const names = CATALOGUE.flatMap((g) => g.items.map((i) => i.name)).filter((n) => n !== 'polygon');
  assert.equal(names.length, 27);
  // use copies something in defs; animate moves something
  const defs = insertObject(m, place('defs').node);
  const ball = place('sphere').node;
  ball.attrs.id = 'ball';
  insertObject(m, ball, defs.oid);
  for (const name of names) {
    if (name === 'defs') continue;
    if (name === 'animate') {
      const box = insertObject(m, place('box').node);
      insertObject(m, place('animate').node, box.oid);
      continue;
    }
    const r = place(name, [], { defsIds: ['ball'] });
    assert.ok(r.node, `${name}: ${r.error}`);
    insertObject(m, r.node);
  }
  const check = checkModel(m);
  assert.equal(check.errors, 0, check.diagnostics.map((d) => d.message).join('\n'));
  const text = toES3D(m);
  const c = compile(text);
  assert.ok(c.ok);
  for (const name of [...names, 'material']) assert.match(text, new RegExp(`<${name}\\b`), name);
});

test('shapes are placed from the picked points', () => {
  // a sphere on a point, its radius to a second
  assert.deepEqual(place('sphere', [[1, 2, 3], [1, 2, 5]]).node.attrs, { position: '1,2,3', radius: '2', material: 'clay' });
  // a cylinder from one point to another, lying along z
  const cyl = place('cylinder', [[1, 0, 0], [1, 0, 4]]).node;
  assert.deepEqual(cyl.attrs, { position: '1,0,2', height: '4', rotation: '90,0,0', material: 'clay' });
  let b = boundsOf(only(createModel(), 'cylinder', [[1, 0, 0], [1, 0, 4]]));
  assert.ok(near(b.min, [0.5, -0.5, 0]) && near(b.max, [1.5, 0.5, 4]), JSON.stringify(b));
  // a cone leaning over: base centre on the first point, tip on the second
  assert.deepEqual(place('cone', [[0, 0, 0], [3, 3, 0]]).node.attrs, { position: '1.5,1.5,0', height: '4.2426407', rotation: '45,90,0', material: 'clay' });
  // a box spanning points; flat points get a thickness
  assert.deepEqual(place('box', [[0, 0, 0], [2, 1, 4]]).node.attrs, { position: '1,0.5,2', size: '2,1,4', material: 'clay' });
  const flat = place('box', [[0, 0, 0], [2, 0, 4]]);
  assert.equal(flat.node.attrs.size, '2,0.4,4');
  assert.match(flat.note, /thickness/);
  // an extrusion of a flat outline at y = 1, pushed up
  b = boundsOf(only(createModel(), 'extrude', [[0, 1, 0], [0, 1, 2], [3, 1, 2], [3, 1, 0]]));
  assert.ok(near(b.min, [0, 1, 0]) && near(b.max, [3, 1.72, 2]), JSON.stringify(b));
  // a revolve around the upright line through the first point
  b = boundsOf(only(createModel(), 'revolve', [[5, 0, 5], [6, 0, 5], [6, 2, 5]]));
  assert.ok(near(b.min, [4, 0, 4], 1e-3) && near(b.max, [6, 2, 6], 1e-3), JSON.stringify(b));
  // lines, tubes, lights and cameras take their ends from the points
  assert.deepEqual(place('line', [[0, 0, 0], [1, 2, 3]]).node.attrs, { from: '0,0,0', to: '1,2,3', material: 'clay' });
  assert.equal(place('sweep', [[0, 0, 0], [0, 10, 0]]).node.attrs.along, '0,0,0 0,10,0');
  assert.deepEqual(place('light', [[0, 5, 0], [0, 0, 0]]).node.attrs, { type: 'spot', position: '0,5,0', target: '0,0,0' });
  assert.deepEqual(place('camera', [[4, 3, 4], [0, 1, 0]]).node.attrs, { position: '4,3,4', target: '0,1,0' });
  assert.equal(place('repeat', [[0, 0, 0], [2, 0, 0]]).node.attrs.step, 'translate(2,0,0)');
});

test('points that do not fit an element say why', () => {
  assert.match(place('extrude', [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 0, 1]]).error, /one flat plane/);
  assert.match(place('extrude', [[0, 0, 0], [1, 0, 0]]).error, /3 or more/);
  assert.match(place('line', [[1, 1, 1], [1, 1, 1]]).error, /two different points/);
  assert.match(place('revolve', [[0, 0, 0], [0, 5, 0]]).error, /nothing to turn/);
  assert.match(place('use').error, /Defs/);
  assert.match(place('mesh', [[0, 0, 0]]).error, /3 or more/);
});

test('an element added inside a moved group is placed at the picked point', () => {
  const m = createModel();
  const g = place('group', [[5, 0, 0]]).node;
  g.attrs.rotation = '0,90,0';
  insertObject(m, g);
  const local = toFrame(m, g.oid, [5, 0, -2]);
  const s = place('sphere', [local]).node;
  insertObject(m, s, g.oid);
  assert.deepEqual(s.attrs.position, '2,0,0');
  const b = boundsOf(toES3D(m));
  assert.ok(near(b.min, [4.5, -0.5, -2.5]) && near(b.max, [5.5, 0.5, -1.5]), JSON.stringify(b));
  // its handle sits there too, and moving the handle writes a local position
  const at = anchorOf(m, s.oid);
  assert.ok(near(at.world, [5, 0, -2]));
});

test('every element is read and written back as it was', () => {
  const text = `<es3d version="1" unit="cm">
  <title>All of it</title>
  <desc>Every element the format has.</desc>
  <environment background="#202830" intensity="0.6"/>
  <controls mode="orbit" maxPolar="90"/>
  <defs>
    <group id="tree">
      <cylinder radius="0.1" height="1" position="0,0.5,0"/>
      <cone radius="0.6" height="1.5" position="0,1.5,0" material="leafy"/>
    </group>
    <path id="tooth" d="M0,0 L1,0 L0.5,1 Z"/>
  </defs>
  <material id="leafy" color="#2d6a4f" roughness="0.9"/>
  <material id="steel" color="#aab" metallic="1" roughness="0.3" map="checker(8)"/>
  <scene material="steel">
    <box size="1,2,3" radius="0.1"/>
    <sphere radius="0.5" segments="12" position="2,0,0"/>
    <capsule position="4,0,0"/>
    <plane size="10,10" position="0,-1,0"/>
    <torus radius="1" tube="0.2" arc="270"/>
    <line from="0,0,0" to="1,1,1" radius="0.02"/>
    <polyline points="0,0,0 1,0,0 1,1,0" smooth="true"/>
    <extrude path="tooth" depth="0.2" bevel="0.05"/>
    <revolve d="M0,0 L1,0 L1,1" angle="180"/>
    <sweep along="helix(1,0.5,3)" radius="0.05"/>
    <gear teeth="18" module="0.1" bore="0.2"/>
    <mesh positions="0 0 0 1 0 0 0 1 0" indices="0 1 2" smooth="0"/>
    <repeat count="4" step="translate(2,0,0) rotateY(10)"><use ref="tree"/></repeat>
    <scatter count="30" radius="8" seed="3" randomScale="0.8..1.2"><use ref="tree"/></scatter>
    <lod distances="10"><sphere segments="32"/><box/></lod>
    <group name="spinner"><box size="0.5"/><animate attr="rotation" to="0,360,0" dur="4s"/></group>
    <light type="spot" position="0,5,0" target="0,0,0" angle="30"/>
    <camera position="6,4,8" target="0,0,0" fov="40"/>
  </scene>
</es3d>`;
  const { model, planes, objects } = fromES3D(text);
  assert.equal(planes, 0);
  assert.ok(objects > 25);
  assert.deepEqual(model.paints.slice(0, 2), [
    { id: 'leafy', color: '#2d6a4f', attrs: { roughness: '0.9' }, keep: true },
    { id: 'steel', color: '#aaaabb', attrs: { metallic: '1', roughness: '0.3', map: 'checker(8)' }, keep: true },
  ]);
  const out = toES3D(model);
  const a = parse(text);
  const b = parse(out);
  assert.ok(b.ok, b.diagnostics.map((d) => d.message).join('\n'));
  // the colour #aab is written in full; otherwise the tree is the same
  const same = parse(text.replace('color="#aab"', 'color="#aaaabb"').replace(' unit="cm"', ''));
  assert.ok(treesEqual(same.root, b.root), out);
  assert.ok(a.ok);
  // and it survives the browser copy
  assert.equal(toES3D(restoreModel(JSON.parse(JSON.stringify(model)))), out);
});

test('the validator speaks per object', () => {
  const m = createModel();
  const s = insertObject(m, place('sphere').node);
  s.attrs.radius = '-1';
  const ok = insertObject(m, place('box').node);
  const check = checkModel(m);
  assert.equal(check.errors, 1);
  assert.equal(check.byObject.get(s.oid)[0].code, 'E_RANGE');
  assert.equal(check.byObject.has(ok.oid), false);
});

test('the preview marks lights and cameras and leaves <controls> out', () => {
  const m = exampleHouse();
  insertObject(m, place('light', [[0, 5, 0]]).node);
  insertObject(m, place('camera', [[6, 4, 8]]).node);
  insertObject(m, place('controls').node);
  const preview = previewES3D(m, {});
  assert.doesNotMatch(preview, /<controls/);
  assert.match(preview, /<sphere [^>]*m="_light"/);
  assert.match(preview, /<box [^>]*m="_camera"/);
  assert.ok(compile(preview).ok);
  assert.match(toES3D(m), /<controls mode="orbit"\/>/);
});

test('tree edits: duplicate drops ids, move, remove; containers accept what the schema allows', () => {
  const m = createModel();
  const a = insertObject(m, place('sphere').node);
  a.attrs.id = 'a';
  const b = insertObject(m, place('box').node);
  const copy = duplicateObject(m, a.oid);
  assert.deepEqual(m.objects.map((n) => n.oid), [a.oid, copy.oid, b.oid]);
  assert.equal(copy.attrs.id, undefined);
  moveObject(m, b.oid, -2);
  assert.deepEqual(m.objects.map((n) => n.oid), [b.oid, a.oid, copy.oid]);
  removeObject(m, a.oid);
  assert.equal(findObject(m.objects, a.oid), null);
  assert.ok(accepts('group', 'sphere') && accepts('sphere', 'animate') && !accepts('sphere', 'box') && !accepts('defs', 'animate'));
});

test('deleting every point removes the planes and keeps the other elements', () => {
  const m = exampleHouse();
  insertObject(m, place('sphere').node);
  const r = deletePoints(m, m.points.map((p) => p.id));
  assert.equal(r.removedPlanes, 7);
  assert.equal(m.points.length + m.planes.length, 0);
  assert.equal(m.objects.length, 1);
  assert.ok(compile(toES3D(m)).ok);
  // a plane and a sphere made later still work
  for (const p of [[0, 0, 0], [1, 0, 0], [0, 1, 0]]) addPoint(m, p);
  assert.equal(makePlane(m, [8 + 3, 8 + 4, 8 + 5].map((x) => x), 'sky').planes.length, 1);
});
