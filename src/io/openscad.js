// OpenSCAD script. The language is documented in the OpenSCAD User Manual
// (the 2021.01 manual, and the same primitives in current builds).
//
// OpenSCAD is Z-up. The file's root `rotate([90, 0, 0])` maps ES3D's Y-up
// coordinates onto Z-up: (x, y, z) becomes (x, −z, y). Everything inside that
// rotation is written in ES3D coordinates.
//
// Primitives: cube(size, center=true) is centred (the default centre is false,
// which would put the box in the first octant). sphere(r). cylinder is along
// Z; r1 is the bottom and r2 the top. `rotate([-90, 0, 0])` maps that Z axis
// onto ES3D Y, and the bottom (negative Z, r1) onto negative Y, so r1 is the
// ES3D bottom radius. OpenSCAD solids are closed: a cylinder with caps off is
// still capped, and the notes say so. There is no capsule primitive; it is a
// cylinder plus two spheres. There is no zero-thickness solid: a plane is a
// 2D square, and the notes say so.
//
// linear_extrude runs along +Z, which is ES3D's extrude direction inside the
// root rotation. rotate_extrude revolves around Z; a further −90° about X puts
// the result around Y. polygon paths are the outline then the holes.
// polyhedron faces are listed clockwise when viewed from outside, so ES3D's
// counter-clockwise triangles are reversed.
//
// multmatrix takes a row-major 4×4 with the translation in the last column,
// the same layout as a column-vector matrix written by rows.
//
// Reuse is a module. A repeat whose step is a pure translation, a pure
// rotation about the origin, or a pure positive scale is a for-loop. Anything
// else is baked. Scatter is baked too, except a plain grid: OpenSCAD has no
// bitwise operators, so it cannot run the mulberry32 placement.

import { n, trsOf, axisAngle, matrixRows } from './text-encode.js';
import { repeatCopies, scatterCopies, paint, surfaceMesh } from './export-model.js';

function indent(text, spaces = 2) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((line) => (line ? pad + line : line)).join('\n');
}

function vec(v) {
  return `[${v.map(n).join(', ')}]`;
}

/**
 * @returns {{text: string, notes: string[]}}
 */
export function exportOpenSCAD(model) {
  const notes = model.notes.slice();
  const tally = new Map();
  const add = (key, k = 1) => tally.set(key, (tally.get(key) || 0) + k);
  const modules = [];
  const names = new Map();
  let seq = 0;

  const moduleFor = (solid, doubleSided) => {
    const key = `${solid.key}:${doubleSided ? 1 : 0}`;
    if (names.has(key)) return names.get(key);
    const id = `g${seq++}`;
    names.set(key, id);
    modules.push(`module ${id}() {\n${indent(solidBody(solid, doubleSided))}\n}`);
    return id;
  };

  const solidBody = (solid, doubleSided) => {
    if (solid.kind === 'box') {
      const s = solid.size;
      return `cube([${n(s[0])}, ${n(s[1])}, ${n(s[2])}], center=true);`;
    }
    if (solid.kind === 'sphere') return `sphere(r=${n(solid.radius)}, $fn=${solid.segments});`;
    if (solid.kind === 'cylinder' || solid.kind === 'cone' || solid.kind === 'frustum') {
      if (solid.caps === false) add('caps');
      const r1 = solid.kind === 'cone' ? solid.radius : solid.radius;
      const r2 = solid.kind === 'cone' ? 0 : (solid.radiusTop !== undefined ? solid.radiusTop : solid.radius);
      return `rotate([-90, 0, 0]) cylinder(h=${n(solid.height)}, r1=${n(r1)}, r2=${n(r2)}, center=true, $fn=${solid.segments});`;
    }
    if (solid.kind === 'capsule') {
      add('capsule');
      const r = solid.radius, h = solid.height, mid = Math.max(0, h - 2 * r), y = h / 2 - r;
      return `rotate([-90, 0, 0]) {\n  cylinder(h=${n(mid)}, r=${n(r)}, center=true, $fn=${solid.segments});\n  translate([0, 0, ${n(y)}]) sphere(r=${n(r)}, $fn=${solid.segments});\n  translate([0, 0, ${n(-y)}]) sphere(r=${n(r)}, $fn=${solid.segments});\n}`;
    }
    if (solid.kind === 'plane') {
      add('plane');
      return `rotate([-90, 0, 0]) square([${n(solid.width)}, ${n(solid.depth)}], center=true);`;
    }
    if (solid.kind === 'torus') {
      return `rotate([-90, 0, 0]) rotate_extrude($fn=${solid.segments}) translate([${n(solid.radius)}, 0]) circle(r=${n(solid.tube)}, $fn=${solid.tubeSegments});`;
    }
    if (solid.kind === 'extrude') {
      return `linear_extrude(height=${n(solid.depth)}, center=${solid.center ? 'true' : 'false'})\n${indent(polygon(solid.regions))}`;
    }
    if (solid.kind === 'revolve') {
      add('revolve');
      const pts = [];
      for (let i = 0; i < solid.points.length; i += 2) pts.push(`[${n(solid.points[i])}, ${n(solid.points[i + 1])}]`);
      return `rotate([-90, 0, 0]) rotate_extrude(angle=${n(Math.min(solid.angle, 360))}, $fn=${solid.segments}) polygon([${pts.join(', ')}]);`;
    }
    if (solid.kind === 'surface') {
      add('surface');
      const mesh = surfaceMesh(solid.regions);
      return polyhedron(mesh);
    }
    return `// ${solid.kind}`;
  };

  const call = (node) => {
    if (!node) return '';
    if (node.kind === 'group') {
      const inner = node.children.map(call).filter(Boolean);
      return wrap(node.matrix, block(inner));
    }
    if (node.kind === 'repeat') return repeat(node);
    if (node.kind === 'scatter') return scatter(node);
    const id = node.solid.kind === 'mesh' || node.solid.kind === 'lines'
      ? meshModule(node.solid)
      : moduleFor(node.solid, node.doubleSided);
    const color = model.materials[node.material];
    const c = color.baseColorSrgb;
    const painted = `color([${n(c[0])}, ${n(c[1])}, ${n(c[2])}, ${n(color.opacity)}]) ${id}();`;
    return wrap(node.matrix, painted);
  };

  const meshModule = (mesh) => {
    const key = mesh.key;
    if (names.has(key)) return names.get(key);
    const id = `g${seq++}`;
    names.set(key, id);
    if (mesh.kind === 'lines') {
      add('lines');
      modules.push(`module ${id}() { /* hairline omitted */ }`);
      return id;
    }
    modules.push(`module ${id}() {\n${indent(polyhedron(mesh))}\n}`);
    return id;
  };

  const repeat = (node) => {
    const step = trsOf(node.step);
    const inner = block(node.children.map(call).filter(Boolean));
    if (step && step.noRot && step.noScale) {
      add('loop');
      const body = `for (i = [0:${node.count - 1}])\n${indent(`translate(${vec(step.translation)} * i)\n${indent(inner)}`)}`;
      return wrap(node.matrix, body);
    }
    if (step && step.rotationOnly && step.noTrans) {
      const a = axisAngle(step.rotation);
      if (a.angle > 1e-8) {
        add('loop');
        const body = `for (i = [0:${node.count - 1}])\n${indent(`rotate(a=${n(a.angle * 180 / Math.PI)} * i, v=${vec(a.axis)})\n${indent(inner)}`)}`;
        return wrap(node.matrix, body);
      }
    }
    if (step && step.noRot && step.noTrans && step.scale.every((v) => v > 0)) {
      add('loop');
      const body = `for (i = [0:${node.count - 1}])\n${indent(`scale([pow(${n(step.scale[0])}, i), pow(${n(step.scale[1])}, i), pow(${n(step.scale[2])}, i)])\n${indent(inner)}`)}`;
      return wrap(node.matrix, body);
    }
    add('baked', node.count);
    const copies = repeatCopies(node).map((m) => wrap(m, inner));
    return wrap(node.matrix, block(copies));
  };

  const scatter = (node) => {
    const p = node.params;
    const plain = p.grid && !(p.jitter > 0) && !p.randomScale && !p.randomRotation && !p.randomMaterial;
    const inner = block(node.children.map(call).filter(Boolean));
    if (plain) {
      add('grid');
      const nx = p.grid[0], nz = p.grid[1];
      const body = `for (ix = [0:${nx - 1}], iz = [0:${nz - 1}])\n${indent(`translate([(${n(p.spacing[0])}) * (ix - ${n((nx - 1) / 2)}), 0, (${n(p.spacing[1])}) * (iz - ${n((nz - 1) / 2)})])\n${indent(inner)}`)}`;
      return wrap(node.matrix, body);
    }
    add('scatter', p.count);
    const copies = scatterCopies(node).map((copy) => {
      const kids = copy.material ? node.children.map((c) => paint(c, copy.material, null, model.resolve)) : node.children;
      return wrap(copy.matrix, block(kids.map(call).filter(Boolean)));
    });
    return wrap(node.matrix, block(copies));
  };

  const body = call(model.root) || 'cube(0);';
  if (tally.get('caps')) notes.push(`${tally.get('caps').toLocaleString('en-US')} open cylinder${tally.get('caps') === 1 ? '' : 's'} written closed (OpenSCAD solids have caps).`);
  if (tally.get('capsule')) notes.push(`${tally.get('capsule').toLocaleString('en-US')} capsule${tally.get('capsule') === 1 ? '' : 's'} written as a cylinder and two spheres.`);
  if (tally.get('plane')) notes.push(`${tally.get('plane').toLocaleString('en-US')} plane${tally.get('plane') === 1 ? '' : 's'} written as a 2D square (OpenSCAD has no zero-thickness solid).`);
  if (tally.get('surface')) notes.push(`${tally.get('surface').toLocaleString('en-US')} flat surface${tally.get('surface') === 1 ? '' : 's'} written as a polyhedron.`);
  if (tally.get('revolve')) notes.push(`${tally.get('revolve').toLocaleString('en-US')} revolve${tally.get('revolve') === 1 ? '' : 's'} written with rotate_extrude.`);
  if (tally.get('loop')) notes.push(`${tally.get('loop').toLocaleString('en-US')} repeat${tally.get('loop') === 1 ? '' : 's'} written as a for-loop.`);
  if (tally.get('baked')) notes.push(`${tally.get('baked').toLocaleString('en-US')} repeated copies baked (the step is not a pure translation, rotation or scale).`);
  if (tally.get('grid')) notes.push(`${tally.get('grid').toLocaleString('en-US')} plain grid${tally.get('grid') === 1 ? '' : 's'} written as a for-loop.`);
  if (tally.get('scatter')) notes.push(`${tally.get('scatter').toLocaleString('en-US')} scattered copies baked (OpenSCAD cannot run the mulberry32 placement).`);
  if (tally.get('lines')) notes.push(`${tally.get('lines').toLocaleString('en-US')} hairline${tally.get('lines') === 1 ? '' : 's'} omitted (OpenSCAD has no line primitive).`);
  if (model.lights.length) notes.push(`${model.lights.length.toLocaleString('en-US')} light${model.lights.length === 1 ? '' : 's'} omitted (OpenSCAD describes solids).`);
  if (model.cameras.length) notes.push(`${model.cameras.length.toLocaleString('en-US')} camera${model.cameras.length === 1 ? '' : 's'} omitted.`);

  const text = `// ES3D scene, OpenSCAD 2021.01 primitives.
// OpenSCAD is Z-up. rotate([90, 0, 0]) maps ES3D Y-up onto Z-up.
${modules.join('\n\n')}
rotate([90, 0, 0])
${body}
`;
  return { text, notes };
}

function block(lines) {
  const items = lines.filter(Boolean);
  if (!items.length) return 'cube(0);';
  if (items.length === 1) return items[0];
  return `union() {\n${items.map((l) => indent(l)).join('\n')}\n}`;
}

function wrap(matrix, inner) {
  if (!matrix || !inner) return inner || '';
  const t = trsOf(matrix);
  if (!t) {
    const rows = matrixRows(matrix).map((r) => `[${r.map(n).join(', ')}]`).join(', ');
    return `multmatrix([${rows}])\n${indent(inner)}`;
  }
  if (t.identity) return inner;
  let s = inner;
  if (!t.noScale) s = `scale(${vec(t.scale)})\n${indent(s)}`;
  if (!t.noRot) {
    const a = axisAngle(t.rotation);
    s = `rotate(a=${n((a.angle * 180) / Math.PI)}, v=${vec(a.axis)})\n${indent(s)}`;
  }
  if (!t.noTrans) s = `translate(${vec(t.translation)})\n${indent(s)}`;
  return s;
}

function polygon(regions) {
  const pts = [];
  const paths = [];
  const addLoop = (loop) => {
    const path = [];
    const nPts = loop.length / 2;
    for (let i = 0; i < nPts; i++) {
      path.push(pts.length);
      pts.push(`[${n(loop[i * 2])}, ${n(loop[i * 2 + 1])}]`);
    }
    paths.push(`[${path.join(', ')}]`);
  };
  for (const region of regions) {
    addLoop(region.outer);
    for (const hole of region.holes) addLoop(hole);
  }
  return `polygon(points=[${pts.join(', ')}], paths=[${paths.join(', ')}]);`;
}

function polyhedron(mesh) {
  const pts = [];
  for (let i = 0; i < mesh.positions.length; i += 3) pts.push(`[${n(mesh.positions[i])}, ${n(mesh.positions[i + 1])}, ${n(mesh.positions[i + 2])}]`);
  const faces = [];
  for (let i = 0; i < mesh.indices.length; i += 3) faces.push(`[${mesh.indices[i]}, ${mesh.indices[i + 2]}, ${mesh.indices[i + 1]}]`);
  return `polyhedron(points=[${pts.join(', ')}], faces=[${faces.join(', ')}], convexity=8);`;
}
