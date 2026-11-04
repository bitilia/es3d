// Exporters for X3D, USD, OpenSCAD and three.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/pipeline.js';
import { exportFormat, importFiles } from '../src/io/convert.js';
import { circularSpine, extrusionVertex, importX3D } from '../src/io/x3d.js';

const enc = new TextEncoder();

function scene(body) {
  return `<es3d version="1">${body}</es3d>`;
}

function textOf(src, format, opts) {
  const out = exportFormat(src, format, opts);
  return { text: out.files[0].data, notes: out.notes || [], out };
}

test('a box keeps its edge lengths and is not scaled twice', () => {
  const src = scene('<box size="2 3 4"/>');
  const x3d = textOf(src, 'x3dv');
  assert.match(x3d.text, /Box \{ size 2 3 4 \}/);
  assert.doesNotMatch(x3d.text, /scale /);
  const usd = textOf(src, 'usda');
  assert.match(usd.text, /metersPerUnit = 1/);
  assert.match(usd.text, /upAxis = "Y"/);
  assert.match(usd.text, /def Cube /);
  assert.match(usd.text, /xformOp:scale = \(2, 3, 4\)/);
  const scad = textOf(src, 'scad');
  assert.match(scad.text, /rotate\(\[90, 0, 0\]\)/);
  assert.match(scad.text, /cube\(\[2, 3, 4\], center=true\)/);
  const js = textOf(src, 'js');
  assert.match(js.text, /new THREE\.BoxGeometry\(2, 3, 4\)/);
  assert.match(js.text, /export function createScene\(\)/);
});

test('a cylinder uses the element radius and height, on Y', () => {
  const src = scene('<cylinder radius="2" height="4"/>');
  const x3d = textOf(src, 'x3dv');
  assert.match(x3d.text, /Cylinder \{ radius 2 height 4 /);
  const usd = textOf(src, 'usda');
  assert.match(usd.text, /axis = "Y"/);
  assert.match(usd.text, /double radius = 2/);
  assert.match(usd.text, /double height = 4/);
  const scad = textOf(src, 'scad');
  assert.match(scad.text, /rotate\(\[-90, 0, 0\]\) cylinder\(h=4, r1=2, r2=2/);
  const js = textOf(src, 'js');
  assert.match(js.text, /new THREE\.CylinderGeometry\(2, 2, 4,/);
});

test('a USD file says when lights and cameras are left out', () => {
  const out = textOf(scene('<light type="directional" direction="0 -1 0"/><camera position="0 2 4"/>'), 'usda');
  assert.match(out.notes.join('\n'), /1 light omitted/);
  assert.match(out.notes.join('\n'), /1 camera omitted/);
  assert.doesNotMatch(out.text, /Light/);
});

test('a USD capsule height excludes the hemispheres', () => {
  const usd = textOf(scene('<capsule radius="0.25" height="1"/>'), 'usda');
  assert.match(usd.text, /def Capsule /);
  assert.match(usd.text, /double height = 0.5/);
  assert.match(usd.text, /double radius = 0.25/);
  assert.match(usd.notes.join('\n'), /excluding the hemispheres/);
});

test('two uses share one geometry definition', () => {
  const src = scene('<defs><sphere id="s" radius="0.5"/></defs><use ref="s"/><use ref="s" position="2 0 0"/>');
  const x3d = textOf(src, 'x3dv').text;
  assert.equal((x3d.match(/DEF G\d+ Sphere/g) || []).length, 1);
  assert.match(x3d, /USE G\d+/);
  const scad = textOf(src, 'scad').text;
  assert.equal((scad.match(/module g\d+\(\)/g) || []).length, 1);
  assert.ok((scad.match(/g\d+\(\)/g) || []).length >= 3);
  const js = textOf(src, 'js').text;
  assert.equal((js.match(/new THREE\.SphereGeometry/g) || []).length, 1);
  const usd = textOf(src, 'usda').text;
  assert.equal((usd.match(/def Sphere /g) || []).length, 1);
  assert.match(usd, /references = <\/World\/Prototypes\//);
});

test('a translated repeat is a loop, a point instancer, or shared transforms', () => {
  const src = scene('<repeat count="3" step="translate(2, 0, 0)"><box size="1"/></repeat>');
  const x3d = textOf(src, 'x3dv');
  assert.equal((x3d.text.match(/Box \{/g) || []).length, 1);
  assert.match(x3d.text, /USE /);
  assert.match(x3d.notes.join('\n'), /expanded into transforms/);
  const usd = textOf(src, 'usda');
  assert.match(usd.text, /def PointInstancer /);
  const scad = textOf(src, 'scad');
  assert.match(scad.text, /for \(i = \[0:2\]\)/);
  const js = textOf(src, 'js');
  assert.match(js.text, /InstancedMesh/);
});

test('flatten writes indexed faces and the same note in every format', () => {
  const src = scene('<sphere radius="0.5"/>');
  for (const format of ['x3dv', 'usda', 'scad', 'js']) {
    const out = textOf(src, format, { structure: 'flatten' });
    assert.match(out.notes.join('\n'), /Flattened to the triangles/);
  }
  const x3d = textOf(src, 'x3dv', { structure: 'flatten' }).text;
  assert.match(x3d, /IndexedFaceSet/);
  assert.doesNotMatch(x3d, /\bSphere \{/);
});

test('output is deterministic', () => {
  const src = scene('<box size="2 3 4"/><sphere radius="0.25" position="1 0 0"/>');
  for (const format of ['x3dv', 'usda', 'scad', 'js']) {
    const a = textOf(src, format).text;
    const b = textOf(src, format).text;
    assert.equal(a, b);
  }
});

test('a bevelled gear is reported as tessellated', () => {
  const out = textOf(scene('<gear bevel="0.01"/>'), 'scad');
  assert.match(out.notes.join('\n'), /bevelled gear/);
});

test('an X3D extrusion is turned from Y onto Z', () => {
  const out = textOf(scene('<extrude d="M0 0 L1 0 L1 1 Z" depth="2"/>'), 'x3dv');
  assert.match(out.text, /spine \[ 0 0 0 0 2 0 \]/);
  assert.match(out.text, /rotation 1 0 0 1\.570796/);
});

test('an X3D revolve cross-section lands on the swept profile', () => {
  const steps = 8;
  const spine = [];
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI * 2 * ((i % steps) / steps);
    spine.push(Math.cos(a), 0, -Math.sin(a));
  }
  const x = 1.5;
  const y = 0.25;
  for (let i = 0; i < steps; i++) {
    const a = Math.PI * 2 * (i / steps);
    const p = extrusionVertex(spine, x - 1, y, i);
    assert.ok(Math.abs(p[0] - x * Math.cos(a)) < 1e-6, p.join(','));
    assert.ok(Math.abs(p[1] - y) < 1e-6, p.join(','));
    assert.ok(Math.abs(p[2] + x * Math.sin(a)) < 1e-6, p.join(','));
  }
});

test('an X3D torus extrusion lies on the torus', () => {
  const radius = 1;
  const tube = 0.25;
  const spine = circularSpine(radius, 16);
  for (let i = 0; i < 16; i++) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const p = extrusionVertex(spine, tube * Math.cos(a), tube * Math.sin(a), i);
      const radial = Math.hypot(p[0], p[2]);
      const err = (radial - radius) ** 2 + p[1] ** 2 - tube ** 2;
      assert.ok(Math.abs(err) < 1e-6, `point ${i},${k} err ${err} at ${p}`);
    }
  }
});

test('X3D classic import round-trips a box', async () => {
  const out = textOf(scene('<box size="2 3 4"/>'), 'x3dv');
  const back = await importFiles([{ name: 'box.x3dv', bytes: enc.encode(out.text) }]);
  const c = compile(back.text);
  assert.ok(c.ok, c.diagnostics.map((d) => d.message).join('\n'));
  assert.match(back.text, /size="2 3 4"/);
});

test('OpenSCAD programs are imported as shapes', async () => {
  const box = textOf(scene('<box size="2 3 4"/>'), 'scad');
  const boxBack = await importFiles([{ name: 'box.scad', bytes: enc.encode(box.text) }]);
  const boxScene = compile(boxBack.text);
  assert.ok(boxScene.ok, boxScene.diagnostics.map((d) => d.message).join('\n'));
  assert.match(boxBack.text, /size="2 3 4"/);
  near(boxScene.scene.bounds, { min: [-1, -1.5, -2], max: [1, 1.5, 2] });

  const cyl = textOf(scene('<cylinder radius="2" height="4"/>'), 'scad');
  const cylBack = await importFiles([{ name: 'cyl.scad', bytes: enc.encode(cyl.text) }]);
  const cylScene = compile(cylBack.text);
  assert.ok(cylScene.ok, cylScene.diagnostics.map((d) => d.message).join('\n'));
  assert.match(cylBack.text, /radius="2"/);
  assert.match(cylBack.text, /height="4"/);
  near(cylScene.scene.bounds, { min: [-2, -2, -2], max: [2, 2, 2] });

  const native = await importFiles([{ name: 'a.scad', bytes: enc.encode('cube([2, 4, 6], center=true);') }]);
  const nativeScene = compile(native.text);
  assert.ok(nativeScene.ok, nativeScene.diagnostics.map((d) => d.message).join('\n'));
  near(nativeScene.scene.bounds, { min: [-1, -3, -2], max: [1, 3, 2] });

  const diff = await importFiles([{ name: 'a.scad', bytes: enc.encode('difference() { cube(2, center=true); sphere(1); }') }]);
  assert.match(diff.notes.join('\n'), /not subtracted/);
  assert.match(diff.text, /<box /);
  assert.match(diff.text, /<sphere /);

  const loop = await importFiles([{ name: 'a.scad', bytes: enc.encode('for (i = [0:2]) translate([i * 3, 0, 0]) cube(1, center=true);') }]);
  const loopScene = compile(loop.text);
  assert.ok(loopScene.ok, loopScene.diagnostics.map((d) => d.message).join('\n'));
  assert.equal((loop.text.match(/<use /g) || []).length, 3);
  near(loopScene.scene.bounds, { min: [-0.5, -0.5, -0.5], max: [6.5, 0.5, 0.5] });

  const mod = await importFiles([{ name: 'a.scad', bytes: enc.encode('module bolt() { cylinder(h=2, r=0.5, center=true); }\nbolt();\ntranslate([3, 0, 0]) bolt();') }]);
  assert.match(mod.text, /<defs>/);
  assert.equal((mod.text.match(/<use /g) || []).length, 2);

  const hole = await importFiles([{ name: 'a.scad', bytes: enc.encode('linear_extrude(height=2) difference() { square(10, center=true); circle(2); }') }]);
  assert.match(hole.text, /fillRule="evenodd"/);
  assert.match(hole.text, / A /);
  const holeScene = compile(hole.text);
  assert.ok(holeScene.ok, holeScene.diagnostics.map((d) => d.message).join('\n'));

  const red = await importFiles([{ name: 'a.scad', bytes: enc.encode('color("red") cube(1, center=true);') }]);
  assert.match(red.text, /color="#f00"/);

  const fn = await importFiles([{ name: 'a.scad', bytes: enc.encode('cylinder(h=2, r=1, $fn=6, center=true);') }]);
  assert.match(fn.text, /segments="6"/);

  const positional = await importFiles([{ name: 'a.scad', bytes: enc.encode('cylinder(10, 5);') }]);
  assert.match(positional.text, /radius="5"/);
  assert.match(positional.text, /radiusTop="1"/);
  assert.match(positional.text, /height="10"/);

  const included = await importFiles([
    { name: 'main.scad', bytes: enc.encode('include <parts/bolt.scad>\nbolt();') },
    { name: 'bolt.scad', bytes: enc.encode('module bolt() { sphere(r=2); }') },
  ]);
  assert.match(included.text, /radius="2"/);
  assert.doesNotMatch(included.notes.join('\n'), /Missing/);
});

test('USD and X3D import the solids their exporters write', async () => {
  const box = await roundTrip(scene('<box size="2 3 4"/>'), 'usda', 'box.usda');
  assert.match(box.text, /size="2 3 4"/);
  near(compile(box.text).scene.bounds, { min: [-1, -1.5, -2], max: [1, 1.5, 2] });

  const cyl = await roundTrip(scene('<cylinder radius="2" height="4"/>'), 'usda', 'cyl.usda');
  assert.match(cyl.text, /radius="2"/);
  assert.match(cyl.text, /height="4"/);
  near(compile(cyl.text).scene.bounds, { min: [-2, -2, -2], max: [2, 2, 2] });

  const cap = await roundTrip(scene('<capsule radius="0.25" height="1"/>'), 'usda', 'cap.usda');
  assert.match(cap.text, /radius="0.25"/);
  assert.match(cap.text, /height="1"/);

  const plane = await roundTrip(scene('<plane size="2 4"/>'), 'usda', 'plane.usda');
  assert.match(plane.text, /size="2 4"/);

  const repeated = await roundTrip(scene('<repeat count="3" step="translate(2, 0, 0)"><box size="1 1 1"/></repeat>'), 'usda', 'rep.usda');
  assert.equal((repeated.text.match(/<box /g) || []).length, 3);
  near(compile(repeated.text).scene.bounds, { min: [-0.5, -0.5, -0.5], max: [4.5, 0.5, 0.5] });

  const shared = await roundTrip(scene('<defs><sphere id="s" radius="0.5"/></defs><use ref="s"/><use ref="s" position="2 0 0"/>'), 'usda', 'share.usda');
  assert.equal((shared.text.match(/<sphere /g) || []).length, 2);

  const extruded = scene('<extrude d="M 0 0 L 2 0 L 2 1 L 0 1 Z" depth="3"/>');
  const x3d = textOf(extruded, 'x3dv');
  assert.match(x3d.text, /Extrusion/);
  const back = await importFiles([{ name: 'e.x3dv', bytes: enc.encode(x3d.text) }]);
  const built = compile(back.text);
  assert.ok(built.ok, built.diagnostics.map((d) => d.message).join('\n'));
  assert.match(back.text, /<mesh /);
  assert.match(back.notes.join('\n'), /Extrusion was imported as a mesh/);
  near(built.scene.bounds, { min: [0, 0, 0], max: [2, 1, 3] });

  const xml = importX3D(`<?xml version="1.0"?>
<X3D><Scene><Transform rotation="1 0 0 1.570796"><Shape><Extrusion crossSection="0 0 2 0 2 -1 0 -1 0 0" spine="0 0 0 0 3 0"/></Shape></Transform></Scene></X3D>`);
  const xmlBuilt = compile(xml.text);
  assert.ok(xmlBuilt.ok, xmlBuilt.diagnostics.map((d) => d.message).join('\n'));
  near(xmlBuilt.scene.bounds, { min: [0, 0, 0], max: [2, 1, 3] });

  const faces = importX3D(`<?xml version="1.0"?>
<X3D><Scene>
  <Shape><IndexedFaceSet coordIndex="0 1 2 -1" ccw="false"><Coordinate point="0 0 0 1 0 0 0 1 0"/></IndexedFaceSet></Shape>
  <IndexedLineSet coordIndex="0 1 -1 1 2"><Coordinate point="0 0 0 1 0 0 1 1 0"/></IndexedLineSet>
  <DirectionalLight direction="0 -1 0"/>
  <Viewpoint position="0 2 4"/>
</Scene></X3D>`);
  assert.match(faces.text, /<mesh [^>]*indices="0 2 1"/);
  assert.match(faces.text, /<polyline /);
  assert.match(faces.text, /<light /);
  assert.match(faces.text, /<camera /);
  assert.match(faces.notes.join('\n'), /IndexedFaceSet was imported as a mesh/);
  assert.match(faces.notes.join('\n'), /IndexedLineSet was imported as polylines/);
  const faceBuilt = compile(faces.text);
  assert.ok(faceBuilt.ok, faceBuilt.diagnostics.map((d) => d.message).join('\n'));
});

test('three.js keeps an extrusion and a revolve as geometry', () => {
  const extruded = textOf(scene('<extrude d="M -1 -1 L 1 -1 L 1 1 L -1 1 Z" depth="2" center="true"/>'), 'js');
  assert.match(extruded.text, /ExtrudeGeometry/);
  assert.doesNotMatch(extruded.text, /BufferGeometry/);
  const turned = textOf(scene('<revolve d="M 1 0 L 2 0 L 2 1 L 1 1 Z"/>'), 'js');
  assert.match(turned.text, /LatheGeometry/);
  assert.doesNotMatch(turned.text, /BufferGeometry/);
  const wedge = textOf(scene('<revolve d="M 1 0 L 2 0 L 2 1 L 1 1 Z" angle="90"/>'), 'js');
  assert.match(wedge.text, /LatheGeometry\(\[[^\]]+\], \d+, 1\.570796, 1\.570796\)/);
  const holed = textOf(scene('<extrude d="M -2 -2 L 2 -2 L 2 2 L -2 2 Z M -1 -1 L 1 -1 L 1 1 L -1 1 Z" depth="1"/>'), 'js');
  assert.match(holed.text, /ExtrudeGeometry/);
  assert.match(holed.text, /\.holes\.push/);
});

async function roundTrip(src, format, name) {
  const out = textOf(src, format);
  const back = await importFiles([{ name, bytes: enc.encode(out.text) }]);
  const built = compile(back.text);
  assert.ok(built.ok, back.text + '\n' + built.diagnostics.map((d) => d.message).join('\n'));
  return back;
}

test('a three.js file and a USD crate are not executed on import', async () => {
  await assert.rejects(importFiles([{ name: 'a.js', bytes: enc.encode('cube(1);') }]), /unknown file type/);
  await assert.rejects(importFiles([{ name: 'a.usdc', bytes: enc.encode('PXR-USDC') }]), /USDA/);
});

function near(bounds, expect, eps = 1e-3) {
  for (const end of ['min', 'max']) {
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(bounds[end][i] - expect[end][i]) < eps, `${end}[${i}] ${bounds[end][i]} vs ${expect[end][i]}`);
  }
}

test('existing glTF output is unchanged by a second call', () => {
  const src = scene('<box size="1 2 3"/>');
  const a = exportFormat(src, 'glb');
  const b = exportFormat(src, 'glb');
  assert.deepEqual(a.files[0].data, b.files[0].data);
  assert.equal(a.notes, undefined);
});
