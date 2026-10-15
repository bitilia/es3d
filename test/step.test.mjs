// STEP (ISO 10303-21) import and export: tessellated AP242, planar faces, circles and cylinders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/pipeline.js';
import { exportSTEP, parseSTEP, stepToScene } from '../src/io/step.js';
import { detectKind, importFiles, exportFormat } from '../src/io/convert.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const enc = (s) => new TextEncoder().encode(s);

function stepFile(data) {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'),'2;1');
FILE_NAME('t.step','2026-10-05T00:00:00',(''),(''),'ES3D','ES3D','');
FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'));
ENDSEC;
DATA;
${data}
ENDSEC;
END-ISO-10303-21;
`;
}

function boundsClose(a, b, eps = 1e-4) {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(a.min[i] - b.min[i]) < eps, `min[${i}] ${a.min[i]} vs ${b.min[i]}`);
    assert.ok(Math.abs(a.max[i] - b.max[i]) < eps, `max[${i}] ${a.max[i]} vs ${b.max[i]}`);
  }
}

function takeMesh(built, entry) {
  return typeof built.meshOf === 'function' ? built.meshOf(entry) : built.cache.mesh(entry, 0);
}

function worldPoints(built) {
  const mesh = takeMesh(built, built.scene.geometries[0]);
  const M = built.scene.matrices;
  const out = [];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out.push([
      M[0] * x + M[4] * y + M[8] * z + M[12],
      M[1] * x + M[5] * y + M[9] * z + M[13],
      M[2] * x + M[6] * y + M[10] * z + M[14],
    ]);
  }
  return out;
}

function near(pts, x, y, z, eps = 1e-5) {
  return pts.some((p) => Math.abs(p[0] - x) < eps && Math.abs(p[1] - y) < eps && Math.abs(p[2] - z) < eps);
}

test('an AP242 box round-trips, including one world-space corner', async () => {
  const src = '<es3d version="1"><box size="2,4,6"/></es3d>';
  const r = compile(src);
  assert.ok(r.ok, r.diagnostics.map((d) => d.message).join('\n'));
  const step = exportSTEP(r.scene, (e, l) => r.cache.mesh(e, l), { name: 'box' });
  assert.equal(step.triangles, 12);
  assert.match(step.data, /ISO-10303-21/);
  assert.match(step.data, /TRIANGULATED_SURFACE_SET/);
  assert.match(step.data, /SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
  assert.match(step.data, /\(1\.,-3\.,2\.\)/);
  const back = stepToScene(step.data);
  assert.equal(back.info.triangles, 12);
  assert.equal(back.info.unit, 'millimetres');
  boundsClose(r.scene.bounds, back.scene.bounds);
  const imported = await importFiles([{ name: 'box.step', bytes: enc(step.data) }]);
  assert.match(imported.text, /<mesh/);
  assert.match(imported.notes.join('\n'), /millimetre/);
  assert.match(imported.notes.join('\n'), /Z-up/);
  const c = compile(imported.text);
  assert.ok(c.ok, c.diagnostics.map((d) => d.message).join('\n'));
  boundsClose(r.scene.bounds, c.scene.bounds, 1e-3);
  const out = exportFormat(src, 'step', { baseName: 'box', compiled: r });
  assert.equal(out.files[0].name, 'box.step');
  assert.equal(out.triangles, 12);
});

test('POLY_LOOP triangle, quad, reversed bound and two shells', () => {
  const tri = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=CARTESIAN_POINT('',(0.,1.,0.));
#4=POLY_LOOP('',(#1,#2,#3));
#5=FACE_OUTER_BOUND('',#4,.T.);
#6=FACE('',(#5));
`), { up: 'y' });
  assert.equal(tri.info.triangles, 1);
  assert.equal(tri.scene.geometries.length, 1);
  assert.ok(tri.meshOf(tri.scene.geometries[0]).normals[2] > 0);

  const quad = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(2.,0.,0.));
#3=CARTESIAN_POINT('',(2.,2.,0.));
#4=CARTESIAN_POINT('',(0.,2.,0.));
#5=POLY_LOOP('',(#1,#2,#3,#4));
#6=FACE_OUTER_BOUND('',#5,.T.);
#7=FACE('',(#6));
#8=CLOSED_SHELL('',(#7));
`), { up: 'y' });
  const q = quad.meshOf(quad.scene.geometries[0]);
  assert.equal(q.primitiveCount, 2);
  assert.equal(q.vertexCount, 4);

  const flipped = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=CARTESIAN_POINT('',(0.,1.,0.));
#4=POLY_LOOP('',(#1,#2,#3));
#5=FACE_OUTER_BOUND('',#4,.F.);
#6=FACE('',(#5));
`), { up: 'y' });
  assert.ok(flipped.meshOf(flipped.scene.geometries[0]).normals[2] < 0);

  const shells = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=CARTESIAN_POINT('',(0.,1.,0.));
#4=POLY_LOOP('',(#1,#2,#3));
#5=FACE_OUTER_BOUND('',#4,.T.);
#6=FACE('',(#5));
#7=CLOSED_SHELL('',(#6));
#8=CARTESIAN_POINT('',(0.,0.,5.));
#9=CARTESIAN_POINT('',(1.,0.,5.));
#10=CARTESIAN_POINT('',(0.,1.,5.));
#11=POLY_LOOP('',(#8,#9,#10));
#12=FACE_OUTER_BOUND('',#11,.T.);
#13=FACE('',(#12));
#14=CLOSED_SHELL('',(#13));
`), { up: 'y' });
  assert.equal(shells.scene.geometries.length, 2);
  assert.equal(shells.info.triangles, 2);
});

test('EDGE_LOOP of straight edges and a Z-up point land on the Y axis', () => {
  const edge = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(3.,0.,0.));
#3=CARTESIAN_POINT('',(0.,0.,4.));
#4=VERTEX_POINT('',#1);
#5=VERTEX_POINT('',#2);
#6=VERTEX_POINT('',#3);
#7=EDGE_CURVE('',#4,#5,$,.T.);
#8=EDGE_CURVE('',#5,#6,$,.T.);
#9=EDGE_CURVE('',#6,#4,$,.T.);
#10=ORIENTED_EDGE('',*,*,#7,.T.);
#11=ORIENTED_EDGE('',*,*,#8,.T.);
#12=ORIENTED_EDGE('',*,*,#9,.T.);
#13=EDGE_LOOP('',(#10,#11,#12));
#14=FACE_OUTER_BOUND('',#13,.T.);
#15=ADVANCED_FACE('',(#14),$,.T.);
#16=CLOSED_SHELL('',(#15));
`), { up: 'y' });
  assert.equal(edge.info.triangles, 1);
  assert.ok(near(worldPoints(edge), 0, 0, 4));

  const z = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=CARTESIAN_POINT('',(0.,0.,1.));
#4=POLY_LOOP('',(#1,#2,#3));
#5=FACE_OUTER_BOUND('',#4,.T.);
#6=FACE('',(#5));
`));
  const pts = worldPoints(z);
  assert.ok(near(pts, 0, 1, 0), JSON.stringify(pts));
  assert.ok(!near(pts, 0, 0, 1));
});

test('strips, fans and an inline coordinate list', () => {
  const strip = stepToScene(stepFile(`
#10=CARTESIAN_POINT_LIST_3D('',((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(1.,1.,0.)));
#11=COMPLEX_TRIANGULATED_SURFACE_SET('',#10,0,$,$,((1,2,3,4)),());
`), { up: 'y' });
  assert.equal(strip.info.triangles, 2);
  assert.equal(strip.meshOf(strip.scene.geometries[0]).vertexCount, 4);

  const fan = stepToScene(stepFile(`
#10=CARTESIAN_POINT_LIST_3D('',((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.)));
#11=COMPLEX_TRIANGULATED_SURFACE_SET('',#10,0,$,$,(),((1,2,3,4)));
`), { up: 'y' });
  assert.equal(fan.info.triangles, 2);

  const inline = stepToScene(stepFile(`
#1=TRIANGULATED_SURFACE_SET('',((0.,0.,0.),(1.,0.,0.),(0.,2.,0.)),0,$,$,((1,2,3)));
`), { up: 'y' });
  assert.equal(inline.info.triangles, 1);
  assert.ok(near(worldPoints(inline), 0, 2, 0));
});

test('comments, doubled quotes and odd number spellings survive', () => {
  const text = stepFile(`
#1=CARTESIAN_POINT('it''s a point',(0.,0.,0.));
/* comment (with parentheses) and a fake #99=CARTESIAN_POINT('',(9.,9.,9.)); */
#2=CARTESIAN_POINT('',(1.E-1,.5,1.));
#3=CARTESIAN_POINT('',(0.,1.,0.));
#4=POLY_LOOP('',(#1,#2,#3));
#5=FACE_OUTER_BOUND('',#4,.T.);
#6=FACE('',(#5));
`);
  const doc = parseSTEP(text);
  assert.equal(doc.entities.has(99), false);
  assert.equal(doc.entities.get(1).parts[0].args[0], "it's a point");
  const coords = doc.entities.get(2).parts[0].args[1];
  assert.equal(coords[0], 0.1);
  assert.equal(coords[1], 0.5);
  assert.equal(coords[2], 1);
  const s = stepToScene(text, { up: 'y' });
  assert.ok(near(worldPoints(s), 0.1, 0.5, 1, 1e-6));
  assert.ok(!worldPoints(s).some((p) => Math.abs(p[0] - 9) < 1e-6));
});

test('a styled face keeps its colour', () => {
  const s = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=CARTESIAN_POINT('',(0.,1.,0.));
#4=POLY_LOOP('',(#1,#2,#3));
#5=FACE_OUTER_BOUND('',#4,.T.);
#6=FACE('',(#5));
#20=COLOUR_RGB('',1.,0.,0.);
#21=FILL_AREA_STYLE_COLOUR('',#20);
#22=FILL_AREA_STYLE('',(#21));
#23=SURFACE_STYLE_FILL_AREA(#22);
#24=SURFACE_SIDE_STYLE(.BOTH.,(#23));
#25=SURFACE_STYLE_USAGE(.BOTH.,#24);
#26=PRESENTATION_STYLE_ASSIGNMENT((#25));
#27=STYLED_ITEM('',(#26),#6);
`), { up: 'y' });
  const color = s.scene.materials[0].baseColorSrgb;
  assert.ok(Math.abs(color[0] - 1) < 1e-6 && color[1] === 0 && color[2] === 0);
});

test('a colour on the solid reaches the shell, and a face colour wins', () => {
  const styled = (target) => stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=CARTESIAN_POINT('',(0.,1.,0.));
#4=POLY_LOOP('',(#1,#2,#3));
#5=FACE_BOUND('',#4,.T.);
#6=FACE('',(#5));
#7=CLOSED_SHELL('',(#6));
#8=MANIFOLD_SOLID_BREP('',#7);
#20=COLOUR_RGB('',0.,0.,1.);
#21=FILL_AREA_STYLE_COLOUR('',#20);
#22=FILL_AREA_STYLE('',(#21));
#23=SURFACE_STYLE_FILL_AREA(#22);
#24=SURFACE_SIDE_STYLE(.BOTH.,(#23));
#25=SURFACE_STYLE_USAGE(.BOTH.,#24);
#26=PRESENTATION_STYLE_ASSIGNMENT((#25));
#27=STYLED_ITEM('',(#26),${target});
`), { up: 'y' });
  const solid = styled('#8').scene.materials[0].baseColorSrgb;
  assert.ok(solid[2] > 0.9 && solid[0] < 0.1, JSON.stringify(solid));

  const both = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=CARTESIAN_POINT('',(0.,1.,0.));
#4=POLY_LOOP('',(#1,#2,#3));
#5=FACE_BOUND('',#4,.T.);
#6=FACE('',(#5));
#7=CLOSED_SHELL('',(#6));
#8=MANIFOLD_SOLID_BREP('',#7);
#20=COLOUR_RGB('',0.,0.,1.);
#21=FILL_AREA_STYLE_COLOUR('',#20);
#22=FILL_AREA_STYLE('',(#21));
#23=SURFACE_STYLE_FILL_AREA(#22);
#24=SURFACE_SIDE_STYLE(.BOTH.,(#23));
#25=SURFACE_STYLE_USAGE(.BOTH.,#24);
#26=PRESENTATION_STYLE_ASSIGNMENT((#25));
#27=STYLED_ITEM('',(#26),#8);
#30=COLOUR_RGB('',1.,0.,0.);
#31=FILL_AREA_STYLE_COLOUR('',#30);
#32=FILL_AREA_STYLE('',(#31));
#33=SURFACE_STYLE_FILL_AREA(#32);
#34=SURFACE_SIDE_STYLE(.BOTH.,(#33));
#35=SURFACE_STYLE_USAGE(.BOTH.,#34);
#36=PRESENTATION_STYLE_ASSIGNMENT((#35));
#37=STYLED_ITEM('',(#36),#6);
`), { up: 'y' });
  const face = both.scene.materials[0].baseColorSrgb;
  assert.ok(face[0] > 0.9 && face[2] < 0.1, JSON.stringify(face));
});

function meshArea(built) {
  const pts = worldPoints(built);
  const ix = takeMesh(built, built.scene.geometries[0]).indices;
  let area = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const p = pts[ix[i]], q = pts[ix[i + 1]], r = pts[ix[i + 2]];
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
    const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * 0.5;
  }
  return area;
}

/** Bounds of the triangles the scene draws (scene.bounds is a looser box around rotated shapes). */
function tightBounds(built) {
  const sc = built.scene;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < sc.count; i++) {
    const m = sc.matrices.subarray(i * 16, i * 16 + 16);
    const p = takeMesh(built, sc.geometries[sc.geom[i]]).positions;
    for (let k = 0; k < p.length; k += 3) {
      const w = [m[0] * p[k] + m[4] * p[k + 1] + m[8] * p[k + 2] + m[12], m[1] * p[k] + m[5] * p[k + 1] + m[9] * p[k + 2] + m[13], m[2] * p[k] + m[6] * p[k + 1] + m[10] * p[k + 2] + m[14]];
      for (let j = 0; j < 3; j++) {
        min[j] = Math.min(min[j], w[j]);
        max[j] = Math.max(max[j], w[j]);
      }
    }
  }
  return { min, max };
}

/** Area of every triangle the scene draws, all instances, in world space. */
function surfaceArea(built) {
  const sc = built.scene;
  let area = 0;
  for (let i = 0; i < sc.count; i++) {
    const m = sc.matrices.subarray(i * 16, i * 16 + 16);
    const mesh = takeMesh(built, sc.geometries[sc.geom[i]]);
    const P = (k) => {
      const x = mesh.positions[k * 3], y = mesh.positions[k * 3 + 1], z = mesh.positions[k * 3 + 2];
      return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    };
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const p = P(mesh.indices[k]), q = P(mesh.indices[k + 1]), r = P(mesh.indices[k + 2]);
      const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
  }
  return area;
}

function nearest(pts, x, y, z) {
  let best = Infinity;
  for (const p of pts) best = Math.min(best, Math.hypot(p[0] - x, p[1] - y, p[2] - z));
  return best;
}

function pointTri(p, [a, b, c]) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const n = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  const plane = Math.abs(ap[0] * n[0] + ap[1] * n[1] + ap[2] * n[2]) / nl;
  const dots = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const c0 = dots(ab, ab), c1 = dots(ab, ac), c2 = dots(ac, ac);
  const d0 = dots(ap, ab), d1 = dots(ap, ac);
  const den = c0 * c2 - c1 * c1 || 1;
  const u = (d0 * c2 - d1 * c1) / den;
  const v = (d1 * c0 - d0 * c1) / den;
  if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) return plane;
  const seg = (q, e) => {
    const ev = [e[0] - q[0], e[1] - q[1], e[2] - q[2]];
    const el = dots(ev, ev) || 1;
    const t = Math.min(1, Math.max(0, dots([p[0] - q[0], p[1] - q[1], p[2] - q[2]], ev) / el));
    return Math.hypot(p[0] - (q[0] + ev[0] * t), p[1] - (q[1] + ev[1] * t), p[2] - (q[2] + ev[2] * t));
  };
  return Math.min(seg(a, b), seg(b, c), seg(c, a));
}

test('FACE_BOUND is the outer loop, and a second bound is a hole', () => {
  const quad = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(2.,0.,0.));
#3=CARTESIAN_POINT('',(2.,1.,0.));
#4=CARTESIAN_POINT('',(0.,1.,0.));
#5=POLY_LOOP('',(#1,#2,#3,#4));
#6=FACE_BOUND('',#5,.T.);
#7=FACE('',(#6));
`), { up: 'y' });
  assert.equal(quad.info.triangles, 2);

  const holed = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(4.,0.,0.));
#3=CARTESIAN_POINT('',(4.,4.,0.));
#4=CARTESIAN_POINT('',(0.,4.,0.));
#5=POLY_LOOP('',(#1,#2,#3,#4));
#6=CARTESIAN_POINT('',(1.,1.,0.));
#7=CARTESIAN_POINT('',(2.,1.,0.));
#8=CARTESIAN_POINT('',(2.,2.,0.));
#9=CARTESIAN_POINT('',(1.,2.,0.));
#10=POLY_LOOP('',(#6,#9,#8,#7));
#11=FACE_BOUND('',#10,.T.);
#12=FACE_BOUND('',#5,.T.);
#13=FACE('',(#11,#12));
`), { up: 'y' });
  assert.ok(Math.abs(meshArea(holed) - 15) < 1e-4, `area ${meshArea(holed)}`);
});

test('a circular edge is tessellated and a cylindrical face follows the arc', () => {
  const disk = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=DIRECTION('',(0.,0.,1.));
#3=DIRECTION('',(1.,0.,0.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#5=CIRCLE('',#4,1.);
#6=CARTESIAN_POINT('',(1.,0.,0.));
#7=CARTESIAN_POINT('',(-1.,0.,0.));
#8=VERTEX_POINT('',#6);
#9=VERTEX_POINT('',#7);
#10=EDGE_CURVE('',#8,#9,#5,.T.);
#11=LINE('',#7,#13);
#12=DIRECTION('',(1.,0.,0.));
#13=VECTOR('',#12,1.);
#14=EDGE_CURVE('',#9,#8,#11,.T.);
#15=ORIENTED_EDGE('',*,*,#10,.T.);
#16=ORIENTED_EDGE('',*,*,#14,.T.);
#17=EDGE_LOOP('',(#15,#16));
#18=FACE_BOUND('',#17,.T.);
#19=PLANE('',#4);
#20=ADVANCED_FACE('',(#18),#19,.T.);
`), { up: 'y' });
  const crown = nearest(worldPoints(disk), 0, 1, 0);
  assert.ok(crown < 0.02, `crown ${crown}`);
  assert.ok(disk.info.triangles > 2);

  const cyl = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=DIRECTION('',(0.,0.,1.));
#3=DIRECTION('',(1.,0.,0.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#5=CYLINDRICAL_SURFACE('',#4,1.);
#6=CIRCLE('',#4,1.);
#7=CARTESIAN_POINT('',(0.,0.,1.));
#8=AXIS2_PLACEMENT_3D('',#7,#2,#3);
#9=CIRCLE('',#8,1.);
#10=CARTESIAN_POINT('',(1.,0.,0.));
#11=CARTESIAN_POINT('',(0.,1.,0.));
#12=CARTESIAN_POINT('',(0.,1.,1.));
#13=CARTESIAN_POINT('',(1.,0.,1.));
#14=VERTEX_POINT('',#10);
#15=VERTEX_POINT('',#11);
#16=VERTEX_POINT('',#12);
#17=VERTEX_POINT('',#13);
#18=EDGE_CURVE('',#14,#15,#6,.T.);
#19=DIRECTION('',(0.,0.,1.));
#20=VECTOR('',#19,1.);
#21=LINE('',#11,#20);
#22=EDGE_CURVE('',#15,#16,#21,.T.);
#23=EDGE_CURVE('',#16,#17,#9,.F.);
#24=DIRECTION('',(0.,0.,-1.));
#25=VECTOR('',#24,1.);
#26=LINE('',#13,#25);
#27=EDGE_CURVE('',#17,#14,#26,.T.);
#28=ORIENTED_EDGE('',*,*,#18,.T.);
#29=ORIENTED_EDGE('',*,*,#22,.T.);
#30=ORIENTED_EDGE('',*,*,#23,.T.);
#31=ORIENTED_EDGE('',*,*,#27,.T.);
#32=EDGE_LOOP('',(#28,#29,#30,#31));
#33=FACE_BOUND('',#32,.T.);
#34=ADVANCED_FACE('',(#33),#5,.T.);
`), { up: 'y' });
  const mid = Math.SQRT1_2;
  assert.ok(nearest(worldPoints(cyl), mid, mid, 0) < 0.02, 'arc samples stay on the cylinder');
  const onArc = [mid, mid, 0.5];
  let gap = Infinity;
  {
    const pts = worldPoints(cyl);
    const ix = cyl.meshOf(cyl.scene.geometries[0]).indices;
    for (let i = 0; i < ix.length; i += 3) {
      const tri = [pts[ix[i]], pts[ix[i + 1]], pts[ix[i + 2]]];
      gap = Math.min(gap, pointTri(onArc, tri));
    }
  }
  assert.ok(gap < 0.02, `cylinder surface gap ${gap}`);
  let outward = 0;
  const mesh = cyl.meshOf(cyl.scene.geometries[0]);
  const M = cyl.scene.matrices;
  const p = mesh.positions;
  const ix = mesh.indices;
  for (let i = 0; i < ix.length; i += 3) {
    const at = (k) => {
      const x = p[k * 3], y = p[k * 3 + 1], z = p[k * 3 + 2];
      return [
        M[0] * x + M[4] * y + M[8] * z + M[12],
        M[1] * x + M[5] * y + M[9] * z + M[13],
        M[2] * x + M[6] * y + M[10] * z + M[14],
      ];
    };
    const a = at(ix[i]), b = at(ix[i + 1]), c = at(ix[i + 2]);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3;
    outward += nx * cx + ny * cy;
  }
  assert.ok(outward > 0, `normals point out of the cylinder (${outward})`);
});

test('same_sense false keeps a loop that already opposes the surface', () => {
  const s = stepToScene(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=DIRECTION('',(0.,0.,1.));
#3=DIRECTION('',(1.,0.,0.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#5=PLANE('',#4);
#6=CARTESIAN_POINT('',(0.,0.,0.));
#7=CARTESIAN_POINT('',(0.,1.,0.));
#8=CARTESIAN_POINT('',(1.,0.,0.));
#9=POLY_LOOP('',(#6,#7,#8));
#10=FACE_BOUND('',#9,.T.);
#11=ADVANCED_FACE('',(#10),#5,.F.);
`), { up: 'y' });
  assert.ok(s.meshOf(s.scene.geometries[0]).normals[2] < 0);
});

test('a curved solid is refused, and detection follows the contents', async () => {
  const curved = stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=DIRECTION('',(0.,0.,1.));
#3=DIRECTION('',(1.,0.,0.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#5=CYLINDRICAL_SURFACE('',#4,1.);
#6=ADVANCED_FACE('',(),#5,.T.);
#7=CLOSED_SHELL('',(#6));
#8=MANIFOLD_SOLID_BREP('',#7);
`);
  assert.throws(() => stepToScene(curved), /curved solid/);
  await assert.rejects(importFiles([{ name: 'cyl.step', bytes: enc(curved) }]), /curved solid/);

  const tri = enc(stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(1.,0.,0.));
#3=CARTESIAN_POINT('',(0.,1.,0.));
#4=POLY_LOOP('',(#1,#2,#3));
#5=FACE_OUTER_BOUND('',#4,.T.);
#6=FACE('',(#5));
`));
  assert.equal(detectKind('model.step', tri), 'step');
  assert.equal(detectKind('model.stp', tri), 'step');
  assert.equal(detectKind('model.p21', tri), 'step');
  assert.equal(detectKind('wrong.obj', tri), 'step');
  const stl = enc('solid x\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n');
  assert.equal(detectKind('model.step', stl), 'stl');
});

test('the CLI writes STEP and imports it back', () => {
  const run = (args, input) => spawnSync(process.execPath, ['scripts/es3d-cli.mjs', ...args], { cwd: root, encoding: 'utf8', input });
  const exp = run(['step', '-'], '<es3d version="1"><box size="2"/></es3d>');
  assert.equal(exp.status, 0, exp.stderr);
  assert.match(exp.stdout, /ISO-10303-21/);
  assert.match(exp.stdout, /TRIANGULATED_SURFACE_SET/);
  const imp = run(['import', '-'], exp.stdout);
  assert.equal(imp.status, 0, imp.stderr);
  assert.match(imp.stdout, /<mesh/);
  assert.match(imp.stderr, /millimetre/);
});

function stepReal(v) {
  const r = Math.round(v * 1e9) / 1e9;
  return Number.isInteger(r) ? r.toFixed(1) : String(r);
}

function brepStep(shells, extra = '') {
  const lines = [];
  let n = 1;
  const next = () => n++;
  const point = (p) => {
    const i = next();
    lines.push(`#${i}=CARTESIAN_POINT('',(${p.map(stepReal).join(',')}));`);
    return i;
  };
  for (const faces of shells) {
    const faceIds = [];
    for (const loops of faces) {
      const boundIds = [];
      for (const loop of loops) {
        const pts = loop.map(point);
        const loopId = next();
        lines.push(`#${loopId}=POLY_LOOP('',(${pts.map((i) => `#${i}`).join(',')}));`);
        const boundId = next();
        lines.push(`#${boundId}=FACE_BOUND('',#${loopId},.T.);`);
        boundIds.push(boundId);
      }
      const faceId = next();
      lines.push(`#${faceId}=FACE('',(${boundIds.map((i) => `#${i}`).join(',')}));`);
      faceIds.push(faceId);
    }
    const shell = next();
    lines.push(`#${shell}=CLOSED_SHELL('',(${faceIds.map((i) => `#${i}`).join(',')}));`);
  }
  if (extra) lines.push(extra);
  return stepFile(lines.join('\n'));
}

function boxFaces(x0, y0, z0, x1, y1, z1) {
  const p = (x, y, z) => [x, y, z];
  return [
    [[p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)]],
    [[p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)]],
    [[p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)]],
    [[p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0)]],
    [[p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)]],
    [[p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)]],
  ];
}

function uniquePoints(built, eps = 1e-4) {
  const out = [];
  const scene = built.scene;
  for (let i = 0; i < scene.count; i++) {
    const mesh = takeMesh(built, scene.geometries[scene.geom[i]]);
    const p = mesh.positions;
    const M = scene.matrices;
    const base = i * 16;
    for (let v = 0; v < p.length; v += 3) {
      const x = p[v], y = p[v + 1], z = p[v + 2];
      const w = [
        M[base] * x + M[base + 4] * y + M[base + 8] * z + M[base + 12],
        M[base + 1] * x + M[base + 5] * y + M[base + 9] * z + M[base + 13],
        M[base + 2] * x + M[base + 6] * y + M[base + 10] * z + M[base + 14],
      ];
      if (!out.some((q) => Math.hypot(w[0] - q[0], w[1] - q[1], w[2] - q[2]) < eps)) out.push(w);
    }
  }
  return out;
}

function sameCloud(a, b, eps = 1e-3) {
  assert.equal(a.length, b.length, `point count ${a.length} vs ${b.length}`);
  for (const p of a) {
    assert.ok(b.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < eps), `missing ${p}`);
  }
}

test('a closed rectangular prism becomes a box, in the file unit', async () => {
  const src = brepStep([boxFaces(0, 0, 0, 2, 4, 6)], `
#900=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#901=PRODUCT('box','Widget','',());
`);
  const imported = await importFiles([{ name: 'widget.step', bytes: enc(src) }]);
  assert.match(imported.text, /<box[\s>]/);
  assert.doesNotMatch(imported.text, /<mesh/);
  assert.match(imported.text, /unit="mm"/);
  assert.match(imported.text, /Widget/);
  assert.match(imported.notes.join('\n'), /STEP B-rep: 1 box\. All 6 faces are ES3D shapes; nothing is a mesh/);
  assert.match(imported.notes.join('\n'), /millimetre/);
  assert.match(imported.notes.join('\n'), /Z-up/);
  const mesh = stepToScene(src);
  const solid = compile(imported.text);
  assert.ok(solid.ok, solid.diagnostics.map((d) => d.message).join('\n'));
  boundsClose(mesh.scene.bounds, solid.scene.bounds, 1e-4);
  sameCloud(uniquePoints(mesh), uniquePoints(solid));
});

test('a prism rotated in the STEP file keeps its corners', async () => {
  const deg = 30 * Math.PI / 180;
  const c = Math.cos(deg);
  const s = Math.sin(deg);
  const rot = (p) => [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
  const faces = boxFaces(-1, -2, 0, 1, 2, 3).map((loops) => loops.map((loop) => loop.map(rot)));
  const src = brepStep([faces]);
  const imported = await importFiles([{ name: 'turned.step', bytes: enc(src) }]);
  assert.match(imported.text, /<box[\s>]/);
  assert.doesNotMatch(imported.text, /<mesh/);
  const mesh = stepToScene(src);
  const solid = compile(imported.text);
  assert.ok(solid.ok, solid.diagnostics.map((d) => d.message).join('\n'));
  sameCloud(uniquePoints(mesh), uniquePoints(solid));
});

test('a rectangular through-hole is an extrusion, and a pocket is its flat faces', async () => {
  const faces = boxFaces(0, 0, 0, 4, 4, 2);
  faces[0].push([[1, 1, 0], [2, 1, 0], [2, 2, 0], [1, 2, 0]]);
  faces[1].push([[1, 1, 2], [1, 2, 2], [2, 2, 2], [2, 1, 2]]);
  faces.push(
    [[[1, 1, 0], [1, 2, 0], [1, 2, 2], [1, 1, 2]]],
    [[[2, 1, 0], [2, 1, 2], [2, 2, 2], [2, 2, 0]]],
    [[[1, 1, 0], [1, 1, 2], [2, 1, 2], [2, 1, 0]]],
    [[[1, 2, 0], [2, 2, 0], [2, 2, 2], [1, 2, 2]]],
  );
  const src = brepStep([faces]);
  const imported = await importFiles([{ name: 'hole.step', bytes: enc(src) }]);
  assert.match(imported.text, /<extrude[\s>]/);
  assert.doesNotMatch(imported.text, /<mesh/);
  assert.match(imported.text, /fillRule="evenodd"/);
  assert.match(imported.notes.join('\n'), /1 extrusion/);
  const mesh = stepToScene(src);
  const solid = compile(imported.text);
  assert.ok(solid.ok, solid.diagnostics.map((d) => d.message).join('\n'));
  boundsClose(mesh.scene.bounds, solid.scene.bounds, 1e-3);
  assert.ok(Math.abs(meshArea(mesh) - meshArea(solid)) < 1e-2, `area ${meshArea(mesh)} vs ${meshArea(solid)}`);

  const pocket = boxFaces(0, 0, 0, 4, 4, 2);
  pocket[1].push([[1, 1, 2], [1, 3, 2], [3, 3, 2], [3, 1, 2]]);
  pocket.push(
    [[[1, 1, 1], [3, 1, 1], [3, 3, 1], [1, 3, 1]]],
    [[[1, 1, 1], [1, 3, 1], [1, 3, 2], [1, 1, 2]]],
    [[[3, 1, 1], [3, 1, 2], [3, 3, 2], [3, 3, 1]]],
    [[[1, 1, 1], [1, 1, 2], [3, 1, 2], [3, 1, 1]]],
    [[[1, 3, 1], [3, 3, 1], [3, 3, 2], [1, 3, 2]]],
  );
  const pocketSrc = brepStep([pocket]);
  const pocketImport = await importFiles([{ name: 'pocket.step', bytes: enc(pocketSrc) }]);
  assert.doesNotMatch(pocketImport.text, /<mesh/);
  assert.equal(pocketImport.text.match(/<path[\s>]/g).length, 11);
  assert.match(pocketImport.notes.join('\n'), /11 flat faces/);
  const pocketDoc = compile(pocketImport.text);
  assert.ok(pocketDoc.ok, pocketDoc.diagnostics.map((d) => d.message).join('\n'));
  const pocketMesh = stepToScene(pocketSrc);
  boundsClose(tightBounds(pocketMesh), tightBounds(pocketDoc), 1e-6);
  assert.ok(Math.abs(surfaceArea(pocketMesh) - surfaceArea(pocketDoc)) < 1e-2, `area ${surfaceArea(pocketMesh)} vs ${surfaceArea(pocketDoc)}`);
});

test('two prism shells become two boxes', async () => {
  const src = brepStep([boxFaces(0, 0, 0, 1, 1, 1), boxFaces(10, 0, 0, 12, 1, 1)]);
  const imported = await importFiles([{ name: 'pair.step', bytes: enc(src) }]);
  assert.equal(imported.text.match(/<box[\s>]/g).length, 2);
  assert.doesNotMatch(imported.text, /<mesh/);
  assert.match(imported.notes.join('\n'), /2 boxes/);
  const mesh = stepToScene(src);
  const solid = compile(imported.text);
  assert.ok(solid.ok, solid.diagnostics.map((d) => d.message).join('\n'));
  boundsClose(mesh.scene.bounds, solid.scene.bounds, 1e-3);
});

test('a cylindrical solid becomes a cylinder', async () => {
  const src = stepFile(`
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=DIRECTION('',(0.,0.,1.));
#3=DIRECTION('',(1.,0.,0.));
#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);
#5=PLANE('',#4);
#6=CIRCLE('',#4,1.);
#7=CARTESIAN_POINT('',(1.,0.,0.));
#8=VERTEX_POINT('',#7);
#9=EDGE_CURVE('',#8,#8,#6,.T.);
#10=ORIENTED_EDGE('',*,*,#9,.F.);
#11=EDGE_LOOP('',(#10));
#12=FACE_BOUND('',#11,.T.);
#13=ADVANCED_FACE('',(#12),#5,.T.);
#14=CARTESIAN_POINT('',(0.,0.,2.));
#15=AXIS2_PLACEMENT_3D('',#14,#2,#3);
#16=PLANE('',#15);
#17=CIRCLE('',#15,1.);
#18=CARTESIAN_POINT('',(1.,0.,2.));
#19=VERTEX_POINT('',#18);
#20=EDGE_CURVE('',#19,#19,#17,.T.);
#21=ORIENTED_EDGE('',*,*,#20,.T.);
#22=EDGE_LOOP('',(#21));
#23=FACE_BOUND('',#22,.T.);
#24=ADVANCED_FACE('',(#23),#16,.T.);
#25=CYLINDRICAL_SURFACE('',#4,1.);
#26=DIRECTION('',(0.,0.,1.));
#27=VECTOR('',#26,1.);
#28=LINE('',#7,#27);
#29=EDGE_CURVE('',#8,#19,#28,.T.);
#30=ORIENTED_EDGE('',*,*,#9,.T.);
#31=ORIENTED_EDGE('',*,*,#29,.T.);
#32=ORIENTED_EDGE('',*,*,#20,.F.);
#33=ORIENTED_EDGE('',*,*,#29,.F.);
#34=EDGE_LOOP('',(#30,#31,#32,#33));
#35=FACE_BOUND('',#34,.T.);
#36=ADVANCED_FACE('',(#35),#25,.T.);
#37=CLOSED_SHELL('',(#13,#24,#36));
`);
  const imported = await importFiles([{ name: 'cyl.step', bytes: enc(src) }]);
  assert.match(imported.text, /<cylinder[\s>]/);
  assert.doesNotMatch(imported.text, /<mesh/);
  assert.match(imported.text, /radius="1"/);
  assert.match(imported.text, /height="2"/);
  assert.match(imported.notes.join('\n'), /1 cylinder/);
  const mesh = stepToScene(src);
  const solid = compile(imported.text);
  assert.ok(solid.ok, solid.diagnostics.map((d) => d.message).join('\n'));
  boundsClose(mesh.scene.bounds, solid.scene.bounds, 1e-3);
});

test('parcel STEP files from Shapr3D become ES3D shapes, with no mesh and the same surface', async () => {
  for (const name of ['box.step', 'box_top.step', 'side_ties.step', 'top_bowtie.step']) {
    const bytes = readFileSync(fileURLToPath(new URL(`../docs/demo/parcel/models/${name}`, import.meta.url)));
    const imported = await importFiles([{ name, bytes }]);
    const doc = compile(imported.text);
    assert.ok(doc.ok, `${name}: ${doc.diagnostics.map((d) => d.message).join('\n')}`);
    assert.doesNotMatch(imported.text, /<mesh/, name);
    assert.match(imported.notes.join('\n'), /nothing is a mesh/, name);
    // the same solid as the triangle importer's tessellation of the same faces
    const mesh = stepToScene(bytes);
    boundsClose(tightBounds(mesh), tightBounds(doc), 1e-4);
    const a = surfaceArea(mesh);
    const b = surfaceArea(doc);
    assert.ok(Math.abs(a - b) < a * 2e-3, `${name}: area ${a} vs ${b}`);
  }
  const top = readFileSync(fileURLToPath(new URL('../docs/demo/parcel/models/box_top.step', import.meta.url)));
  assert.match((await importFiles([{ name: 'box_top.step', bytes: top }])).text, /<extrude[\s>]/);
  const bow = readFileSync(fileURLToPath(new URL('../docs/demo/parcel/models/top_bowtie.step', import.meta.url)));
  assert.match((await importFiles([{ name: 'top_bowtie.step', bytes: bow }])).text, /<revolve[\s>]/);
});

