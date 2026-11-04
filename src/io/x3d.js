// X3D 4, Classic VRML encoding.
//
// Specification: ISO/IEC 19775-1:2023 (X3D Architecture, version 4) and the
// Classic VRML encoding of ISO/IEC 19776-2. The header is `#X3D V4.0 utf8`,
// the form X_ITE and the other current browsers accept. XML (19776-1) is a
// larger encoding of the same graph. Binary (19776-3) is not read by the
// usual web viewers, so it is not a fair size baseline. JSON (19776-5) is
// not yet an International Standard.
//
// Geometry (clause 13):
//   Box size is the full edge lengths, default 2 2 2, centred (§13.3.1).
//   Sphere radius defaults to 1 (§13.3.7).
//   Cylinder radius 1, height 2, along Y, caps at ±height/2 (§13.3.3).
//   Cone bottomRadius 1, height 2, apex at +height/2, bottom at −height/2 (§13.3.2).
//   Extrusion (§13.3.5): crossSection is in the Y=0 plane as (x, z). A straight
//   spine along +Y is collinear, so the spine-aligned plane is the rotation of
//   +Y onto that spine, which is the identity (§13.3.5.4.3). A closed spine
//   repeats its first point; the first and last planes match (§13.3.5.3 b, e).
//   IndexedFaceSet is counter-clockwise from the outside when ccw is TRUE
//   (§13.3.6, §11.2.3). ccw FALSE reverses each face. A face list that does
//   not end in −1 still keeps its last face.
//   Import tessellates an Extrusion in the node's coordinates and writes a
//   mesh, so a parent rotation is applied once. A spine along Y uses the
//   identity frame; a closed spine uses the frame above. IndexedFaceSet and
//   IndexedLineSet are read from Classic and from XML. A line set becomes
//   polylines. XML lights and viewpoints use the same mapping as Classic.
// Fields that equal those defaults (size 2 2 2, radius 1, height 2, solid TRUE,
// ccw TRUE, caps TRUE) are left out. creaseAngle 0.8 is written because the
// default is 0, which would facet every edge.
// There is no capsule, torus, plane or repeat. A capsule is an open cylinder
// plus two spheres. A full torus and a revolve are Extrusion nodes. A plane is
// two triangles. Repeat and scatter are expanded; geometry is still DEF/USE.
//
// Materials (clause 12): PhysicalMaterial is the glTF model. Its defaults are
// baseColor 1 1 1, metallic 1, roughness 1 and transparency 0, so baseColor,
// metallic and roughness are written (an ES3D material does not use those
// defaults). transparency is written only when it is not 0. baseColor is
// linear. transparency is 1 − opacity.
// UnlitMaterial carries the colour as emissiveColor. emissiveColor is limited
// to 0..1; a brighter colour is clamped and counted in the notes.

import * as mat4 from '../math/mat4.js';
import { linearToSrgb, colorToShortHex } from '../format/colors.js';
import { matrixToTransformString } from '../transform/transform.js';
import { n, numList, trsOf, axisAngle, metresPerUnit } from './text-encode.js';
import { repeatCopies, scatterCopies, paint } from './export-model.js';

const NO_OWN = { material: null, color: null };
const UNIT_NAME = { cm: 'Centimeters', mm: 'Millimeters', km: 'Kilometers', in: 'Inches', ft: 'Feet' };

function bool(v) {
  return v ? 'TRUE' : 'FALSE';
}

/** An X3D field, or nothing when the value is the specification default. */
function keep(name, value, fallback) {
  return value === fallback ? '' : ` ${name} ${value}`;
}

function rgb(c) {
  return `${n(c[0])} ${n(c[1])} ${n(c[2])}`;
}

/** Closed-spine point of an Extrusion, ISO/IEC 19775-1:2023 §13.3.5.3. `spine` repeats its first point. */
export function extrusionVertex(spine, sx, sz, index) {
  const nPts = spine.length / 3;
  const at = (i) => [spine[i * 3], spine[i * 3 + 1], spine[i * 3 + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const last = nPts - 1;
  const i = index === last ? 0 : index;
  const yAxis = norm(i === 0 ? sub(at(1), at(last - 1)) : sub(at(i + 1), at(i - 1)));
  let zAxis;
  if (i === 0) zAxis = cross(sub(at(1), at(0)), sub(at(last - 1), at(0)));
  else zAxis = cross(sub(at(i + 1), at(i)), sub(at(i - 1), at(i)));
  zAxis = norm(zAxis);
  if (i > 0) {
    const prev = extrusionVertex._z(spine, i - 1);
    if (dot(zAxis, prev) < 0) zAxis = [-zAxis[0], -zAxis[1], -zAxis[2]];
  }
  extrusionVertex._cache = extrusionVertex._cache || new Map();
  const xAxis = norm(cross(yAxis, zAxis));
  const p = at(i);
  return [p[0] + sx * xAxis[0] + sz * zAxis[0], p[1] + sx * xAxis[1] + sz * zAxis[1], p[2] + sx * xAxis[2] + sz * zAxis[2]];
}

extrusionVertex._z = function zOnly(spine, index) {
  const nPts = spine.length / 3;
  const at = (i) => [spine[i * 3], spine[i * 3 + 1], spine[i * 3 + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const last = nPts - 1;
  const i = index === last ? 0 : index;
  let z = i === 0 ? cross(sub(at(1), at(0)), sub(at(last - 1), at(0))) : cross(sub(at(i + 1), at(i)), sub(at(i - 1), at(i)));
  z = norm(z);
  if (i > 0 && dot(z, zOnly(spine, i - 1)) < 0) z = [-z[0], -z[1], -z[2]];
  return z;
};

/** Circular spine of a torus or revolve. θ = 0 is +X and the sweep goes toward −Z, matching revolve.js. */
export function circularSpine(radius, segments) {
  const m = Math.max(3, segments | 0);
  const spine = [];
  for (let i = 0; i <= m; i++) {
    const a = ((i % m) / m) * Math.PI * 2;
    spine.push(radius * Math.cos(a), 0, -radius * Math.sin(a));
  }
  return spine;
}

function circle2(radius, segments) {
  const m = Math.max(3, segments | 0);
  const out = [];
  for (let i = 0; i <= m; i++) {
    const a = ((i % m) / m) * Math.PI * 2;
    out.push(radius * Math.cos(a), radius * Math.sin(a));
  }
  return out;
}

function close2(points) {
  const out = points.slice();
  if (out.length >= 2 && (out[0] !== out[out.length - 2] || out[1] !== out[out.length - 1])) out.push(out[0], out[1]);
  return out;
}

function bakeMesh(mesh, matrix) {
  const m = matrix;
  const inv = mat4.createF64();
  if (!mat4.invert(inv, m)) return mesh;
  const p = mesh.positions;
  const srcN = mesh.normals;
  const pos = new Float32Array(p.length);
  const norms = srcN ? new Float32Array(srcN.length) : null;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    pos[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    pos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    pos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (norms) {
      const nx = srcN[i], ny = srcN[i + 1], nz = srcN[i + 2];
      let ox = inv[0] * nx + inv[1] * ny + inv[2] * nz;
      let oy = inv[4] * nx + inv[5] * ny + inv[6] * nz;
      let oz = inv[8] * nx + inv[9] * ny + inv[10] * nz;
      const l = Math.hypot(ox, oy, oz) || 1;
      norms[i] = ox / l;
      norms[i + 1] = oy / l;
      norms[i + 2] = oz / l;
    }
  }
  return { kind: mesh.kind, key: `${mesh.key}:baked`, positions: pos, normals: norms, indices: mesh.indices };
}

/**
 * @param {import('./export-model.js').buildExportModel extends Function ? object : object} model
 * @returns {{text: string, notes: string[]}}
 */
export function exportX3D(model) {
  const notes = model.notes.slice();
  const tally = new Map();
  const add = (key, n = 1) => tally.set(key, (tally.get(key) || 0) + n);
  const geos = new Map();
  const apps = new Map();
  let seq = 0;
  const name = (prefix) => `${prefix}${seq++}`;
  let emissiveClamped = 0;

  const appearance = (index) => {
    const hit = apps.get(index);
    if (hit) return `USE ${hit}`;
    const id = name('A');
    apps.set(index, id);
    const m = model.materials[index];
    const c = m.baseColor;
    if (m.unlit) {
      const e = c.map((v) => Math.min(1, Math.max(0, v)));
      return `DEF ${id} Appearance { material UnlitMaterial { emissiveColor ${rgb(e)} } }`;
    }
    const e = m.emissive.map((v) => {
      if (v > 1 || v < 0) emissiveClamped++;
      return Math.min(1, Math.max(0, v));
    });
    const fields = [`baseColor ${rgb(c)}`, `metallic ${n(m.metallic)}`, `roughness ${n(m.roughness)}`];
    if (m.opacity < 0.999) fields.push(`transparency ${n(1 - m.opacity)}`);
    if (e.some((v) => v > 1e-6)) fields.push(`emissiveColor ${rgb(e)}`);
    return `DEF ${id} Appearance { material PhysicalMaterial { ${fields.join(' ')} } }`;
  };

  const define = (key, body) => {
    const hit = geos.get(key);
    if (hit) return `USE ${hit}`;
    const id = name('G');
    geos.set(key, id);
    return `DEF ${id} ${body}`;
  };

  const indexed = (mesh, doubleSided) => {
    const solid = !doubleSided;
    if (mesh.kind === 'lines') {
      const idx = [];
      for (let i = 0; i < mesh.indices.length; i += 2) idx.push(mesh.indices[i], mesh.indices[i + 1], -1);
      return `IndexedLineSet { coord Coordinate { point [ ${numList(mesh.positions)} ] } coordIndex [ ${numList(idx, 16)} ] }`;
    }
    const idx = [];
    for (let i = 0; i < mesh.indices.length; i += 3) idx.push(mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2], -1);
    const normal = mesh.normals ? ` normal Normal { vector [ ${numList(mesh.normals)} ] }` : '';
    return `IndexedFaceSet {${keep('solid', bool(solid), 'TRUE')} coord Coordinate { point [ ${numList(mesh.positions)} ] }${normal} coordIndex [ ${numList(idx, 16)} ] }`;
  };

  const geometryOf = (solid, doubleSided) => {
    const key = `${solid.key}:${doubleSided ? 1 : 0}`;
    if (solid.kind === 'box') {
      const s = solid.size;
      return define(key, `Box {${keep('size', `${n(s[0])} ${n(s[1])} ${n(s[2])}`, '2 2 2')}${keep('solid', bool(!doubleSided), 'TRUE')} }`);
    }
    if (solid.kind === 'sphere') return define(key, `Sphere {${keep('radius', n(solid.radius), '1')}${keep('solid', bool(!doubleSided), 'TRUE')} }`);
    if (solid.kind === 'cylinder') {
      const caps = solid.caps !== false;
      return define(key, `Cylinder {${keep('radius', n(solid.radius), '1')}${keep('height', n(solid.height), '2')}${keep('top', bool(caps), 'TRUE')}${keep('bottom', bool(caps), 'TRUE')}${keep('solid', bool(caps && !doubleSided), 'TRUE')} }`);
    }
    if (solid.kind === 'cone') {
      const caps = solid.caps !== false;
      return define(key, `Cone {${keep('bottomRadius', n(solid.radius), '1')}${keep('height', n(solid.height), '2')}${keep('bottom', bool(caps), 'TRUE')}${keep('solid', bool(caps && !doubleSided), 'TRUE')} }`);
    }
    const extrusion = (o) => {
      const scale = o.scale ? ` scale [ ${o.scale} ]` : '';
      return `Extrusion {${keep('solid', bool(o.solid), 'TRUE')} creaseAngle 0.8${keep('beginCap', bool(o.begin), 'TRUE')}${keep('endCap', bool(o.end), 'TRUE')} crossSection [ ${numList(o.cross)} ] spine [ ${numList(o.spine, 9)} ]${scale} }`;
    };
    if (solid.kind === 'frustum') {
      const cross = circle2(1, solid.segments);
      const h = solid.height;
      const caps = solid.caps !== false;
      return define(key, extrusion({
        solid: caps && !doubleSided,
        begin: caps,
        end: caps,
        cross,
        spine: [0, -h / 2, 0, 0, h / 2, 0],
        scale: `${n(solid.radius)} ${n(solid.radius)} ${n(solid.radiusTop)} ${n(solid.radiusTop)}`,
      }));
    }
    if (solid.kind === 'torus') {
      add('torus');
      return define(key, extrusion({ solid: true, begin: false, end: false, cross: circle2(solid.tube, solid.tubeSegments), spine: circularSpine(solid.radius, solid.segments) }));
    }
    if (solid.kind === 'revolve') {
      add('revolve');
      const cs = [];
      for (let i = 0; i < solid.points.length; i += 2) cs.push(solid.points[i] - 1, solid.points[i + 1]);
      const cross = solid.closed ? close2(cs) : cs;
      const full = solid.angle >= 360 - 1e-6;
      const steps = Math.max(3, solid.segments | 0);
      const spine = [];
      for (let i = 0; i <= steps; i++) {
        const a = (Math.min(solid.angle, 360) * Math.PI / 180) * (full ? (i % steps) / steps : i / steps);
        spine.push(Math.cos(a), 0, -Math.sin(a));
      }
      const cap = !full && solid.closed;
      return define(key, extrusion({ solid: !doubleSided, begin: cap, end: cap, cross, spine }));
    }
    if (solid.kind === 'extrude') {
      const holed = solid.regions.length !== 1 || solid.regions[0].holes.length > 0;
      if (holed) return null;
      add('extrude');
      const loop = solid.regions[0].outer;
      const cs = [];
      for (let i = 0; i < loop.length; i += 2) cs.push(loop[i], -loop[i + 1]);
      return define(key, extrusion({ solid: true, begin: true, end: true, cross: close2(cs), spine: [0, 0, 0, 0, solid.depth, 0] }));
    }
    if (solid.kind === 'plane') {
      add('plane');
      const w = solid.width, d = solid.depth;
      const pos = [-w / 2, 0, d / 2, w / 2, 0, d / 2, w / 2, 0, -d / 2, -w / 2, 0, -d / 2];
      const mesh = { kind: 'mesh', positions: pos, normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 1, 2, 0, 2, 3] };
      return define(key, indexed(mesh, true));
    }
    return null;
  };

  const meshGeometry = (mesh, doubleSided) => define(`${mesh.key}:${doubleSided ? 1 : 0}`, indexed(mesh, doubleSided));

  const transformOf = (matrix) => {
    if (!matrix) return '';
    const t = trsOf(matrix);
    if (!t || t.identity) return t ? '' : null;
    const parts = [];
    if (!t.noTrans) parts.push(`translation ${n(t.translation[0])} ${n(t.translation[1])} ${n(t.translation[2])}`);
    if (!t.noRot) {
      const a = axisAngle(t.rotation);
      parts.push(`rotation ${n(a.axis[0])} ${n(a.axis[1])} ${n(a.axis[2])} ${n(a.angle)}`);
    }
    if (!t.noScale) parts.push(`scale ${n(t.scale[0])} ${n(t.scale[1])} ${n(t.scale[2])}`);
    return parts.join(' ');
  };

  const lines = [];
  const emit = (node, depth) => {
    if (!node) return;
    const pad = '  '.repeat(depth);
    if (node.kind === 'repeat') {
      add('repeat', node.count);
      for (const acc of repeatCopies(node)) {
        emit({ kind: 'group', matrix: acc, children: node.children, own: node.own }, depth);
      }
      return;
    }
    if (node.kind === 'scatter') {
      add('scatter', node.params.count);
      for (const copy of scatterCopies(node)) {
        const children = copy.material ? node.children.map((c) => paint(c, copy.material, null, model.resolve)) : node.children;
        emit({ kind: 'group', matrix: copy.matrix, children, own: node.own }, depth);
      }
      return;
    }
    if (node.kind === 'group') {
      const fields = transformOf(node.matrix);
      if (fields === null) {
        add('shear');
        for (const c of node.children) emit(bakedUnder(c, node.matrix), depth);
        return;
      }
      const saved = lines.length;
      for (const c of node.children) emit(c, depth + 1);
      const body = lines.splice(saved);
      if (!body.length) return;
      if (!fields) {
        lines.push(...body.map((l) => (l.startsWith('  ') ? l.slice(2) : l)));
        return;
      }
      lines.push(`${pad}Transform { ${fields} children [`);
      lines.push(...body);
      lines.push(`${pad}] }`);
      return;
    }
    emitShape(node, depth);
  };

  const bakedUnder = (node, parent) => {
    const local = node.matrix || null;
    const world = mat4.createF64();
    if (local) mat4.multiply(world, parent, local);
    else world.set(parent);
    if (node.kind === 'shape') {
      const space = mat4.createF64();
      const basis = node.solid.kind === 'mesh' || node.solid.kind === 'lines' ? local : (node.meshMatrix || local);
      if (basis) mat4.multiply(space, parent, basis);
      else space.set(parent);
      const mesh = node.solid.kind === 'mesh' || node.solid.kind === 'lines' ? node.solid : model.bakedMesh(node.entry);
      return { ...node, matrix: null, meshMatrix: null, solid: bakeMesh(mesh, space) };
    }
    if (node.kind === 'repeat') {
      const copies = repeatCopies(node).map((acc) => {
        const m = mat4.createF64();
        mat4.multiply(m, world, acc);
        return { kind: 'group', matrix: null, children: node.children.map((c) => bakedUnder(c, m)), own: NO_OWN };
      });
      return { kind: 'group', matrix: null, children: copies, own: node.own };
    }
    if (node.kind === 'scatter') {
      const copies = scatterCopies(node).map((copy) => {
        const m = mat4.createF64();
        mat4.multiply(m, world, copy.matrix);
        const kids = copy.material ? node.children.map((c) => paint(c, copy.material, null, model.resolve)) : node.children;
        return { kind: 'group', matrix: null, children: kids.map((c) => bakedUnder(c, m)), own: NO_OWN };
      });
      return { kind: 'group', matrix: null, children: copies, own: node.own };
    }
    const children = (node.children || []).map((c) => bakedUnder(c, world));
    return { kind: 'group', matrix: null, children, own: node.own };
  };

  const emitShape = (node, depth) => {
    const pad = '  '.repeat(depth);
    let shape = node;
    let fields = transformOf(shape.matrix);
    if (fields === null) {
      add('shear');
      const mesh = shape.solid.kind === 'mesh' || shape.solid.kind === 'lines' ? shape.solid : model.bakedMesh(shape.entry);
      const baked = bakeMesh(mesh, shape.solid.kind === 'mesh' || shape.solid.kind === 'lines' ? shape.matrix : shape.meshMatrix);
      shape = { ...shape, matrix: null, solid: baked };
      fields = '';
    }
    const app = appearance(shape.material);
    let geom = geometryOf(shape.solid, shape.doubleSided);
    let matrix = shape.matrix;
    if (shape.solid.kind === 'capsule') {
      add('capsule');
      geom = capsule(shape, app);
    } else if (shape.solid.kind === 'extrude' && geom) {
      matrix = composeExtrude(matrix, shape.solid);
      fields = transformOf(matrix);
      if (fields === null && matrix) {
        add('shear');
        const mesh = model.bakedMesh(shape.entry);
        const baked = bakeMesh(mesh, shape.meshMatrix || matrix);
        geom = meshGeometry(baked, shape.doubleSided);
        fields = '';
      }
    } else if (!geom) {
      const mesh = shape.solid.kind === 'mesh' || shape.solid.kind === 'lines' ? shape.solid : model.bakedMesh(shape.entry);
      geom = meshGeometry(mesh, shape.doubleSided);
      if (shape.solid.kind !== 'mesh' && shape.solid.kind !== 'lines') {
        matrix = shape.meshMatrix;
      }
      fields = transformOf(matrix);
      if (fields === null && matrix) {
        const baked = bakeMesh(mesh, matrix);
        geom = meshGeometry(baked, shape.doubleSided);
        fields = '';
      }
    } else {
      fields = transformOf(matrix);
      if (fields === null && matrix) {
        add('shear');
        const mesh = model.bakedMesh(shape.entry);
        const baked = bakeMesh(mesh, shape.meshMatrix || matrix);
        geom = meshGeometry(baked, shape.doubleSided);
        fields = '';
      }
    }
    const inner = shape.solid.kind === 'capsule'
      ? geom
      : `Shape { geometry ${geom} appearance ${app} }`;
    if (!fields) lines.push(`${pad}${inner}`);
    else lines.push(`${pad}Transform { ${fields} children [ ${inner} ] }`);
  };

  function composeExtrude(matrix, solid) {
    const r = mat4.createF64();
    mat4.fromEulerDeg(r, 90, 0, 0);
    if (solid.center) {
      const t = mat4.createF64();
      t[14] = -solid.depth / 2;
      const tr = mat4.createF64();
      mat4.multiply(tr, t, r);
      r.set(tr);
    }
    if (!matrix) return r;
    const out = mat4.createF64();
    mat4.multiply(out, matrix, r);
    return out;
  }

  const capsule = (shape, app) => {
    const r = shape.solid.radius;
    const h = shape.solid.height;
    const mid = h - 2 * r;
    if (mid <= 1e-6) {
      const geom = define(`sphere:${r}`, `Sphere { radius ${n(r)} }`);
      return `Shape { geometry ${geom} appearance ${app} }`;
    }
    const y = h / 2 - r;
    const cyl = define(`capcyl:${r}:${mid}`, `Cylinder { radius ${n(r)} height ${n(mid)} top FALSE bottom FALSE solid FALSE }`);
    const sph = define(`sphere:${r}`, `Sphere { radius ${n(r)} }`);
    return `Group { children [
      Shape { geometry ${cyl} appearance ${app} }
      Transform { translation 0 ${n(y)} 0 children [ Shape { geometry ${sph} appearance ${app} } ] }
      Transform { translation 0 ${n(-y)} 0 children [ Shape { geometry ${sph} appearance ${app} } ] }
    ] }`;
  };

  emit(model.root, 1);
  for (const light of model.lights) {
    const node = lightNode(light, add);
    if (node) lines.push(`  ${node}`);
  }
  for (const camera of model.cameras) lines.push('  ' + cameraNode(camera, add));
  if (model.environment && model.environment.explicit) {
    const s = model.environment.sky || model.environment.background;
    lines.push(`  Background { skyColor [ ${rgb(s)} ] }`);
  }

  if (emissiveClamped) notes.push(`${emissiveClamped.toLocaleString('en-US')} emissive colour${emissiveClamped === 1 ? '' : 's'} clamped to 0..1 (X3D emissiveColor).`);
  const say = (key, text) => { if (tally.get(key)) notes.push(text(tally.get(key))); };
  say('capsule', (k) => `${k.toLocaleString('en-US')} capsule${k === 1 ? '' : 's'} written as an open cylinder and two spheres (X3D has no capsule).`);
  say('torus', (k) => `${k.toLocaleString('en-US')} torus${k === 1 ? '' : 'es'} written as Extrusion (X3D has no torus).`);
  say('revolve', (k) => `${k.toLocaleString('en-US')} revolve${k === 1 ? '' : 's'} written as Extrusion along a circular spine.`);
  say('extrude', (k) => `${k.toLocaleString('en-US')} extrusion${k === 1 ? '' : 's'} written as Extrusion; a +90° rotation about X turns the spine from Y onto Z.`);
  say('plane', (k) => `${k.toLocaleString('en-US')} plane${k === 1 ? '' : 's'} written as two triangles (X3D has no plane primitive).`);
  say('repeat', (k) => `${k.toLocaleString('en-US')} repeated copies expanded into transforms (X3D has no repeat node); the geometry is shared.`);
  say('scatter', (k) => `${k.toLocaleString('en-US')} scattered copies expanded into transforms (X3D has no scatter node); the geometry is shared.`);
  say('shear', (k) => `${k.toLocaleString('en-US')} sheared transform${k === 1 ? '' : 's'} baked into vertices (an X3D Transform is translation, rotation and scale).`);
  say('ambient', (k) => `${k.toLocaleString('en-US')} ambient or hemisphere light${k === 1 ? '' : 's'} omitted (X3D has no such light).`);
  say('range', (k) => `${k.toLocaleString('en-US')} unlimited point or spot light${k === 1 ? '' : 's'} given a radius of 1000000 (X3D lights cut off at their radius).`);

  const head = ['#X3D V4.0 utf8', 'PROFILE Immersive', 'COMPONENT Shape:2'];
  if (model.unit !== 'm') head.push(`UNIT length ${UNIT_NAME[model.unit] || 'Unit'} ${n(metresPerUnit(model.unit))}`);
  const body = lines.join('\n');
  const text = `${head.join('\n')}\nGroup {\n  children [\n${body}\n  ]\n}\n`;
  return { text, notes };
}

function lightNode(light, add) {
  const max = Math.max(light.color[0], light.color[1], light.color[2], 1e-8);
  const col = light.color.map((v) => v / max);
  const intensity = n(max);
  const colour = rgb(col);
  if (light.type === 'ambient' || light.type === 'hemisphere') {
    add('ambient');
    return '';
  }
  if (light.type === 'directional') {
    const d = light.direction;
    return `DirectionalLight { direction ${n(d[0])} ${n(d[1])} ${n(d[2])} color ${colour} intensity ${intensity} global TRUE }`;
  }
  const p = light.position;
  let radius = light.range;
  if (!(radius > 0)) {
    radius = 1e6;
    add('range');
  }
  if (light.type === 'spot') {
    const d = light.direction;
    const cut = Math.acos(Math.min(1, Math.max(-1, light.outer)));
    const beam = Math.acos(Math.min(1, Math.max(-1, light.inner)));
    return `SpotLight { location ${n(p[0])} ${n(p[1])} ${n(p[2])} direction ${n(d[0])} ${n(d[1])} ${n(d[2])} cutOffAngle ${n(cut)} beamWidth ${n(beam)} radius ${n(radius)} color ${colour} intensity ${intensity} }`;
  }
  return `PointLight { location ${n(p[0])} ${n(p[1])} ${n(p[2])} radius ${n(radius)} color ${colour} intensity ${intensity} }`;
}

function cameraNode(camera, add) {
  const eye = camera.position;
  const q = viewQuat(eye, camera.target, camera.up);
  const a = axisAngle(q);
  const ori = `${n(a.axis[0])} ${n(a.axis[1])} ${n(a.axis[2])} ${n(a.angle)}`;
  const pos = `${n(eye[0])} ${n(eye[1])} ${n(eye[2])}`;
  if (camera.type === 'orthographic') {
    const hh = camera.height / 2;
    const hw = hh * (camera.aspect || 1);
    return `OrthoViewpoint { position ${pos} orientation ${ori} fieldOfView [ ${n(-hw)} ${n(-hh)} ${n(hw)} ${n(hh)} ] }`;
  }
  if (camera.aspect && Math.abs(camera.aspect - 1) > 1e-6) add('aspect');
  const fov = ((camera.fov || 45) * Math.PI) / 180;
  return `Viewpoint { position ${pos} orientation ${ori} fieldOfView ${n(fov)} }`;
}

/** Quaternion [x, y, z, w] rotating the default camera (−Z forward, +Y up) onto this view. */
function viewQuat(eye, target, up) {
  const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const fl = Math.hypot(...f) || 1;
  f[0] /= fl; f[1] /= fl; f[2] /= fl;
  const z = [-f[0], -f[1], -f[2]];
  let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
  const xl = Math.hypot(...x);
  if (xl < 1e-8) x = [1, 0, 0];
  else { x[0] /= xl; x[1] /= xl; x[2] /= xl; }
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const m = mat4.createF64();
  m.set([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1]);
  return mat4.quatFromRotationMatrix(m);
}

const HEADER = /^\s*#X3D[^\n]*\n?/;

/**
 * Read a Classic VRML X3D file into ES3D markup. XML X3D is accepted for the
 * same node subset. USDC-style binary is rejected by the caller.
 * @returns {{text: string, notes: string[]}}
 */
export function importX3D(text) {
  const notes = [];
  const trimmed = String(text).replace(/^\uFEFF/, '');
  if (/^\s*<\?xml|^\s*<X3D[\s>]/i.test(trimmed)) return importX3DXml(trimmed, notes);
  const body = trimmed.replace(HEADER, '');
  const tokens = tokenize(body);
  const defs = new Map();
  let i = 0;
  const nodes = [];
  while (i < tokens.length) {
    if (tokens[i].t === 'word' && (tokens[i].v === 'PROFILE' || tokens[i].v === 'COMPONENT' || tokens[i].v === 'UNIT' || tokens[i].v === 'META')) {
      i = skipStatement(tokens, i);
      continue;
    }
    if (tokens[i].t === 'word' && tokens[i].v === 'ROUTE') {
      notes.push('A ROUTE was ignored.');
      i = skipStatement(tokens, i);
      continue;
    }
    const step = parseNode(tokens, i, defs);
    if (!step) break;
    nodes.push(step.node);
    i = step.i;
  }
  materialAttrs.materials = [];
  const parts = nodes.map((node) => emitEs3d(node, notes)).filter(Boolean);
  const mats = materialAttrs.materials;
  materialAttrs.materials = [];
  const markup = `<es3d version="1">\n${mats.join('\n')}${mats.length ? '\n' : ''}${parts.join('\n')}\n</es3d>\n`;
  return { text: markup, notes };
}

function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') { i++; continue; }
    if (c === '{' || c === '}' || c === '[' || c === ']') { out.push({ t: c, v: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { s += text[j + 1] || ''; j += 2; continue; }
        s += text[j++];
      }
      out.push({ t: 'string', v: s });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s,{}[\]"#]/.test(text[j])) j++;
    const word = text.slice(i, j);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(word)) out.push({ t: 'num', v: Number(word) });
    else out.push({ t: 'word', v: word });
    i = j;
  }
  return out;
}

function skipStatement(tokens, i) {
  const word = tokens[i] && tokens[i].v;
  i++;
  if (word === 'PROFILE' || word === 'COMPONENT' || word === 'META' || word === 'UNIT' || word === 'ROUTE') {
    while (i < tokens.length) {
      const t = tokens[i];
      const next = tokens[i + 1];
      if (t.t === 'word' && (t.v === 'PROFILE' || t.v === 'COMPONENT' || t.v === 'UNIT' || t.v === 'META' || t.v === 'DEF' || t.v === 'ROUTE' || (next && next.t === '{'))) break;
      i++;
    }
  }
  return i;
}

function parseNode(tokens, i, defs) {
  if (i >= tokens.length || tokens[i].t !== 'word') return null;
  let def = null;
  if (tokens[i].v === 'DEF') {
    def = tokens[i + 1] && tokens[i + 1].v;
    i += 2;
  } else if (tokens[i].v === 'USE') {
    const id = tokens[i + 1] && tokens[i + 1].v;
    return { node: { use: id }, i: i + 2 };
  }
  if (!tokens[i] || tokens[i].t !== 'word') return null;
  const name = tokens[i].v;
  i++;
  if (!tokens[i] || tokens[i].t !== '{') return { node: { name, fields: {}, def }, i };
  i++;
  const fields = {};
  while (i < tokens.length && tokens[i].t !== '}') {
    if (tokens[i].t !== 'word') { i++; continue; }
    const key = tokens[i++].v;
    if (VEC[key] && tokens[i] && tokens[i].t === 'num') {
      const got = takeNumbers(tokens, i, VEC[key] || undefined);
      fields[key] = VEC[key] === 1 ? got.list[0] : got.list;
      i = got.i;
      continue;
    }
    const value = parseValue(tokens, i, defs);
    fields[key] = value.v;
    i = value.i;
  }
  if (tokens[i] && tokens[i].t === '}') i++;
  const node = { name, fields, def };
  if (def) defs.set(def, node);
  return { node, i };
}

function parseValue(tokens, i, defs) {
  const tok = tokens[i];
  if (!tok) return { v: null, i };
  if (tok.t === '{' ) return { v: null, i };
  if (tok.t === '[') {
    i++;
    const list = [];
    while (i < tokens.length && tokens[i].t !== ']') {
      if (tokens[i].t === 'word' && tokens[i + 1] && tokens[i + 1].t === '{') {
        const step = parseNode(tokens, i, defs);
        if (!step) break;
        list.push(step.node);
        i = step.i;
        continue;
      }
      if (tokens[i].t === 'word' && (tokens[i].v === 'DEF' || tokens[i].v === 'USE')) {
        const step = parseNode(tokens, i, defs);
        if (!step) break;
        list.push(step.node);
        i = step.i;
        continue;
      }
      if (tokens[i].t === 'num') list.push(tokens[i++].v);
      else if (tokens[i].t === 'word') list.push(tokens[i++].v);
      else if (tokens[i].t === 'string') list.push(tokens[i++].v);
      else i++;
    }
    if (tokens[i] && tokens[i].t === ']') i++;
    return { v: list, i };
  }
  if (tok.t === 'word' && (tok.v === 'DEF' || tok.v === 'USE' || (tokens[i + 1] && tokens[i + 1].t === '{'))) {
    const step = parseNode(tokens, i, defs);
    return { v: step ? step.node : null, i: step ? step.i : i + 1 };
  }
  if (tok.t === 'num' || tok.t === 'word' || tok.t === 'string') return { v: tok.v, i: i + 1 };
  return { v: null, i: i + 1 };
}

const VEC = {
  translation: 3, rotation: 4, scale: 3, size: 3, center: 3, point: 0,
  baseColor: 3, emissiveColor: 3, diffuseColor: 3, color: 3,
  location: 3, direction: 3, position: 3,
};

function takeNumbers(tokens, i, count) {
  const list = [];
  const limit = count || 1e9;
  while (list.length < limit && tokens[i] && tokens[i].t === 'num') list.push(tokens[i++].v);
  return { list, i };
}

function numAttr(list, count) {
  if (typeof list === 'number') return [list];
  if (!Array.isArray(list)) return null;
  const nums = list.filter((v) => typeof v === 'number');
  return nums.slice(0, count);
}

function emitEs3d(node, notes) {
  if (!node) return '';
  if (node.use) return `<use ref="${esc(node.use)}"/>`;
  const f = node.fields || {};
  const id = node.def ? ` id="${esc(node.def)}"` : '';
  const kids = listNodes(f.children);
  if (node.name === 'Transform' || node.name === 'Group' || node.name === 'Anchor' || node.name === 'Collision' || node.name === 'Switch' || node.name === 'Billboard') {
    if (node.name !== 'Transform' && node.name !== 'Group') notes.push(`<${node.name}> was written as a group.`);
    const tr = x3dTransform(f);
    const body = kids.map((c) => emitEs3d(c, notes)).filter(Boolean).join('\n');
    return `<group${id}${tr}>\n${body}\n</group>`;
  }
  if (node.name === 'Shape') {
    const geom = f.geometry && f.geometry.name ? f.geometry : null;
    const style = materialAttrs(f.appearance, notes);
    if (!geom) return '';
    return emitGeom(geom, id, style, notes);
  }
  if (isGeom(node.name)) return emitGeom(node, id, '', notes);
  if (node.name === 'DirectionalLight' || node.name === 'PointLight' || node.name === 'SpotLight') return emitLight(node, id);
  if (node.name === 'Viewpoint' || node.name === 'OrthoViewpoint') return emitCamera(node, id, notes);
  if (node.name === 'WorldInfo' || node.name === 'Background' || node.name === 'NavigationInfo') return '';
  notes.push(`${node.name} was omitted.`);
  return '';
}

function listNodes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v) => v && v.name);
  if (value.name) return [value];
  return [];
}

function isGeom(name) {
  return name === 'Box' || name === 'Sphere' || name === 'Cylinder' || name === 'Cone' || name === 'Extrusion' || name === 'IndexedFaceSet' || name === 'IndexedLineSet';
}

function x3dMatrix(f) {
  const full = (list, count) => {
    const nums = numAttr(Array.isArray(list) ? list : null, count);
    return nums && nums.length >= count ? nums : null;
  };
  const t = full(f.translation, 3);
  const s = full(f.scale, 3);
  const r = full(f.rotation, 4);
  if (!t && !s && !r) return null;
  const sm = mat4.createF64();
  const scale = s || [1, 1, 1];
  sm[0] = scale[0];
  sm[5] = scale[1];
  sm[10] = scale[2];
  const rm = mat4.createF64();
  if (r) {
    const q = quatFromAxis(r[0], r[1], r[2], r[3]);
    mat4.fromQuat(rm, q[0], q[1], q[2], q[3]);
  }
  const tm = mat4.createF64();
  const pos = t || [0, 0, 0];
  tm[12] = pos[0];
  tm[13] = pos[1];
  tm[14] = pos[2];
  const rs = mat4.createF64();
  mat4.multiply(rs, rm, sm);
  const out = mat4.createF64();
  mat4.multiply(out, tm, rs);
  return out;
}

function x3dTransform(f) {
  const m = x3dMatrix(f);
  if (!m) return '';
  const text = matrixToTransformString(m, (v) => n(v));
  return text ? ` transform="${text}"` : '';
}

function quatFromAxis(x, y, z, angle) {
  const l = Math.hypot(x, y, z) || 1;
  const h = angle / 2;
  const s = Math.sin(h);
  return [(x / l) * s, (y / l) * s, (z / l) * s, Math.cos(h)];
}

function materialAttrs(appearance, notes) {
  if (!appearance || !appearance.fields) return '';
  const mat = appearance.fields.material;
  if (!mat || !mat.fields) return '';
  const f = mat.fields;
  if (mat.name === 'Material') notes.push('A Phong Material was read as a colour (X3D Material is not the glTF model).');
  const physical = mat.name === 'PhysicalMaterial';
  let base = numAttr(f.baseColor || f.diffuseColor || f.emissiveColor, 3);
  if (!base) {
    if (!physical && mat.name !== 'UnlitMaterial') return '';
    base = [1, 1, 1];
  }
  const srgb = base.slice(0, 3).map((v) => linearToSrgb(v));
  const color = `color="${colorToShortHex(srgb)}"`;
  const metallic = typeof f.metallic === 'number' ? f.metallic : (physical ? 1 : 0);
  const roughness = typeof f.roughness === 'number' ? f.roughness : (physical ? 1 : 0.5);
  const opacity = typeof f.transparency === 'number' ? 1 - f.transparency : 1;
  if (Math.abs(metallic) < 1e-6 && Math.abs(roughness - 0.5) < 1e-6 && opacity > 0.999) return ` ${color}`;
  const id = `m${materialAttrs.materials.length}`;
  const bits = [color];
  if (Math.abs(metallic) >= 1e-6) bits.push(`metallic="${n(metallic)}"`);
  if (Math.abs(roughness - 0.5) >= 1e-6) bits.push(`roughness="${n(roughness)}"`);
  if (opacity <= 0.999) bits.push(`opacity="${n(opacity)}"`);
  materialAttrs.materials.push(`<material id="${id}" ${bits.join(' ')}/>`);
  return ` material="${id}"`;
}
materialAttrs.materials = [];

function emitGeom(node, id, style, notes) {
  const f = node.fields || {};
  if (node.name === 'Box') {
    const s = numAttr(f.size, 3) || [2, 2, 2];
    return `<box${id}${style} size="${n(s[0])} ${n(s[1])} ${n(s[2])}"/>`;
  }
  if (node.name === 'Sphere') {
    const r = typeof f.radius === 'number' ? f.radius : 1;
    return `<sphere${id}${style} radius="${n(r)}"/>`;
  }
  if (node.name === 'Cylinder') {
    const r = typeof f.radius === 'number' ? f.radius : 1;
    const h = typeof f.height === 'number' ? f.height : 2;
    const caps = f.top !== 'FALSE' && f.bottom !== 'FALSE';
    return `<cylinder${id}${style} radius="${n(r)}" height="${n(h)}"${caps ? '' : ' caps="false"'}/>`;
  }
  if (node.name === 'Cone') {
    const r = typeof f.bottomRadius === 'number' ? f.bottomRadius : 1;
    const h = typeof f.height === 'number' ? f.height : 2;
    const caps = f.bottom !== 'FALSE';
    return `<cone${id}${style} radius="${n(r)}" height="${n(h)}"${caps ? '' : ' caps="false"'}/>`;
  }
  if (node.name === 'Extrusion') return emitExtrusion(node, id, style, notes);
  if (node.name === 'IndexedFaceSet' || node.name === 'IndexedLineSet') return emitIndexed(node, id, style, notes);
  notes.push(`${node.name} was omitted.`);
  return '';
}

function emitExtrusion(node, id, style, notes) {
  const f = node.fields || {};
  const cross = numAttr(f.crossSection, 1e9) || [];
  const spine = numAttr(f.spine, 1e9) || [];
  if (cross.length < 4 || spine.length < 6) {
    notes.push('An Extrusion had no cross section to import.');
    return '';
  }
  const mesh = tessellateExtrusion(cross, spine, numAttr(f.scale, 1e9), f.beginCap !== 'FALSE', f.endCap !== 'FALSE');
  notes.push('An Extrusion was imported as a mesh.');
  return `<mesh${id}${style} positions="${mesh.positions.map((v) => n(v)).join(' ')}" indices="${mesh.indices.join(' ')}"/>`;
}

/** Spine cross-section product. A spine along Y uses the identity frame from §13.3.5; a closed spine uses extrusionVertex. */
function tessellateExtrusion(cross, spine, scale, beginCap, endCap) {
  const loop = [];
  for (let i = 0; i + 1 < cross.length; i += 2) loop.push([cross[i], cross[i + 1]]);
  if (loop.length > 1 && Math.hypot(loop[0][0] - loop[loop.length - 1][0], loop[0][1] - loop[loop.length - 1][1]) < 1e-8) loop.pop();
  const pts = [];
  for (let i = 0; i + 2 < spine.length; i += 3) pts.push([spine[i], spine[i + 1], spine[i + 2]]);
  const closed = pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1], pts[0][2] - pts[pts.length - 1][2]) < 1e-6;
  const alongY = pts.every((p) => Math.abs(p[0]) < 1e-6 && Math.abs(p[2]) < 1e-6);
  const ringsN = closed ? pts.length - 1 : pts.length;
  const atScale = (i) => {
    if (!scale || scale.length < 2) return [1, 1];
    return scale.length >= pts.length * 2 ? [scale[i * 2], scale[i * 2 + 1]] : [scale[0], scale[1]];
  };
  const place = (i, sx, sz) => {
    const sc = atScale(i);
    const x = sx * sc[0];
    const z = sz * sc[1];
    const p = pts[i];
    if (alongY) return [p[0] + x, p[1], p[2] + z];
    if (closed) return extrusionVertex(spine, x, z, i);
    return openExtrusionPoint(pts, x, z, i);
  };
  const positions = [];
  const rings = [];
  for (let i = 0; i < ringsN; i++) {
    const ring = [];
    for (const [sx, sz] of loop) {
      const p = place(i, sx, sz);
      ring.push(positions.length / 3);
      positions.push(p[0], p[1], p[2]);
    }
    rings.push(ring);
  }
  // Signed area of the cross section in its (x, z) plane. The wall order
  // follows it, so a clockwise outline and a counter-clockwise one both
  // face outward.
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    area += p[0] * q[1] - q[0] * p[1];
  }
  const ccw = area > 0;
  const indices = [];
  const segs = closed ? rings.length : rings.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = rings[i];
    const b = rings[closed ? (i + 1) % rings.length : i + 1];
    for (let j = 0; j < a.length; j++) {
      const j2 = (j + 1) % a.length;
      if (ccw) indices.push(a[j], b[j], b[j2], a[j], b[j2], a[j2]);
      else indices.push(a[j], a[j2], b[j2], a[j], b[j2], b[j]);
    }
  }
  const fan = (ring, flip) => {
    for (let j = 1; j < ring.length - 1; j++) indices.push(ring[0], ...(flip ? [ring[j + 1], ring[j]] : [ring[j], ring[j + 1]]));
  };
  if (!closed && beginCap) fan(rings[0], !ccw);
  if (!closed && endCap) fan(rings[rings.length - 1], ccw);
  return { positions, indices };
}

function openExtrusionPoint(pts, sx, sz, index) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const y = index <= 0 ? norm(sub(pts[1], pts[0])) : index >= pts.length - 1 ? norm(sub(pts[pts.length - 1], pts[pts.length - 2])) : norm(sub(pts[index + 1], pts[index - 1]));
  const ref = Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const xAxis = norm(cross(y, ref));
  const zAxis = norm(cross(xAxis, y));
  const p = pts[index];
  return [p[0] + sx * xAxis[0] + sz * zAxis[0], p[1] + sx * xAxis[1] + sz * zAxis[1], p[2] + sx * xAxis[2] + sz * zAxis[2]];
}

function faceIndices(index, ccw) {
  const faces = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= 3) {
      for (let k = 1; k < cur.length - 1; k++) {
        if (ccw) faces.push(cur[0], cur[k], cur[k + 1]);
        else faces.push(cur[0], cur[k + 1], cur[k]);
      }
    }
    cur = [];
  };
  for (const v of index) {
    if (v < 0) flush();
    else cur.push(v);
  }
  if (cur.length) flush();
  return faces;
}

function lineStrips(coord, index) {
  const strips = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= 2) {
      const pts = [];
      for (const i of cur) {
        const o = i * 3;
        if (o + 2 < coord.length) pts.push(coord[o], coord[o + 1], coord[o + 2]);
      }
      if (pts.length >= 6) strips.push(pts);
    }
    cur = [];
  };
  for (const v of index) {
    if (v < 0) flush();
    else cur.push(v);
  }
  if (cur.length) flush();
  return strips;
}

function emitIndexed(node, id, style, notes) {
  const f = node.fields || {};
  const coord = f.coord && f.coord.fields ? numAttr(f.coord.fields.point, 1e9) : numAttr(f.point, 1e9);
  const index = numAttr(f.coordIndex, 1e9) || [];
  return indexedMarkup(node.name, coord, index, f.ccw !== 'FALSE', id, style, notes);
}

function indexedMarkup(name, coord, index, ccw, id, style, notes) {
  if (!coord || coord.length < 3) {
    notes.push(`An ${name} had no coordinates.`);
    return '';
  }
  if (name === 'IndexedLineSet') {
    const strips = lineStrips(coord, index);
    if (!strips.length) {
      notes.push('An IndexedLineSet had no lines.');
      return '';
    }
    notes.push('An IndexedLineSet was imported as polylines.');
    const one = (pts, withId) => `<polyline${withId ? id : ''}${style} points="${pts.map((v) => n(v)).join(' ')}"/>`;
    if (strips.length === 1) return one(strips[0], true);
    return `<group${id}>\n${strips.map((pts) => one(pts, false)).join('\n')}\n</group>`;
  }
  const faces = faceIndices(index, ccw);
  notes.push('An IndexedFaceSet was imported as a mesh.');
  return `<mesh${id}${style} positions="${coord.map((v) => n(v)).join(' ')}" indices="${faces.join(' ')}"/>`;
}

function emitLight(node, id) {
  const f = node.fields || {};
  const type = node.name === 'DirectionalLight' ? 'directional' : node.name === 'SpotLight' ? 'spot' : 'point';
  const color = numAttr(f.color, 3);
  const pos = numAttr(f.location, 3);
  const dir = numAttr(f.direction, 3);
  const parts = [`type="${type}"`];
  if (color) parts.push(`color="${colorToShortHex(color.slice(0, 3).map((v) => linearToSrgb(v)))}"`);
  if (typeof f.intensity === 'number' && f.intensity !== 1) parts.push(`intensity="${n(f.intensity)}"`);
  if (pos) parts.push(`position="${pos.map(n).join(' ')}"`);
  if (dir) parts.push(`direction="${dir.map(n).join(' ')}"`);
  return `<light${id} ${parts.join(' ')}/>`;
}

function emitCamera(node, id, notes) {
  const f = node.fields || {};
  const pos = numAttr(f.position, 3) || [0, 0, 10];
  notes.push('A viewpoint was imported as a camera looking along its orientation.');
  return `<camera${id} position="${pos.map(n).join(' ')}"/>`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function importX3DXml(text, notes) {
  notes.push('XML X3D was read with the same node subset as Classic VRML.');
  const tags = parseXml(text);
  const root = tags.find((t) => t.name.toLowerCase() === 'x3d') || { name: 'X3D', children: tags };
  const scene = (root.children || []).find((t) => t.name.toLowerCase() === 'scene') || root;
  const parts = (scene.children || []).map((t) => emitXml(t, notes)).filter(Boolean);
  return { text: `<es3d version="1">\n${parts.join('\n')}\n</es3d>\n`, notes };
}

function parseXml(text) {
  const out = [];
  const stack = [{ children: out }];
  const re = /<!--[\s\S]*?-->|<(\/?)([A-Za-z0-9:_-]+)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].startsWith('<!--')) continue;
    const close = m[1] === '/';
    const name = m[2];
    const self = m[4] === '/';
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { name, attrs: attrsOf(m[3]), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  return out;
}

function attrsOf(raw) {
  const attrs = {};
  const re = /([A-Za-z0-9:_-]+)\s*=\s*"([^"]*)"|([A-Za-z0-9:_-]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(raw))) attrs[m[1] || m[3]] = m[2] !== undefined ? m[2] : m[4];
  return attrs;
}

function nums(s) {
  if (!s) return [];
  return s.trim().split(/[\s,]+/).filter(Boolean).map(Number).filter((v) => Number.isFinite(v));
}

function emitXml(tag, notes) {
  const name = tag.name;
  const a = tag.attrs || {};
  const id = a.DEF ? ` id="${esc(a.DEF)}"` : '';
  if (a.USE) return `<use ref="${esc(a.USE)}"/>`;
  if (name === 'Transform' || name === 'Group') {
    const fake = { translation: nums(a.translation), rotation: nums(a.rotation), scale: nums(a.scale) };
    const tr = x3dTransform(fake);
    const body = (tag.children || []).map((c) => emitXml(c, notes)).filter(Boolean).join('\n');
    return `<group${id}${tr}>\n${body}\n</group>`;
  }
  if (name === 'Shape') {
    const geom = (tag.children || []).find((c) => c.name === 'Box' || c.name === 'Sphere' || c.name === 'Cylinder' || c.name === 'Cone' || (c.name === 'Appearance' ? false : isGeom(c.name)));
    const app = (tag.children || []).find((c) => c.name === 'Appearance');
    const style = app ? xmlMaterial(app, notes) : '';
    if (!geom) return (tag.children || []).map((c) => emitXml(c, notes)).filter(Boolean).join('\n');
    return emitXml({ ...geom, attrs: { ...geom.attrs, __style: style, __id: id } }, notes);
  }
  const style = a.__style || '';
  const ident = a.__id || id;
  if (name === 'Box') {
    const s = nums(a.size);
    const size = s.length >= 3 ? s : [2, 2, 2];
    return `<box${ident}${style} size="${size.slice(0, 3).map(n).join(' ')}"/>`;
  }
  if (name === 'Sphere') return `<sphere${ident}${style} radius="${n(a.radius !== undefined ? Number(a.radius) : 1)}"/>`;
  if (name === 'Cylinder') {
    const caps = a.top !== 'false' && a.bottom !== 'false';
    return `<cylinder${ident}${style} radius="${n(a.radius !== undefined ? Number(a.radius) : 1)}" height="${n(a.height !== undefined ? Number(a.height) : 2)}"${caps ? '' : ' caps="false"'}/>`;
  }
  if (name === 'Cone') {
    const caps = a.bottom !== 'false';
    return `<cone${ident}${style} radius="${n(a.bottomRadius !== undefined ? Number(a.bottomRadius) : 1)}" height="${n(a.height !== undefined ? Number(a.height) : 2)}"${caps ? '' : ' caps="false"'}/>`;
  }
  if (name === 'Extrusion') {
    const cross = nums(a.crossSection);
    const spine = nums(a.spine);
    if (cross.length < 4 || spine.length < 6) {
      notes.push('An Extrusion had no cross section to import.');
      return '';
    }
    const on = (v) => v !== 'false' && v !== 'FALSE';
    const mesh = tessellateExtrusion(cross, spine, nums(a.scale), on(a.beginCap), on(a.endCap));
    notes.push('An Extrusion was imported as a mesh.');
    return `<mesh${ident}${style} positions="${mesh.positions.map((v) => n(v)).join(' ')}" indices="${mesh.indices.join(' ')}"/>`;
  }
  if (name === 'IndexedFaceSet' || name === 'IndexedLineSet') {
    const coordTag = (tag.children || []).find((c) => c.name === 'Coordinate');
    const point = nums((coordTag && coordTag.attrs && coordTag.attrs.point) || a.point);
    const ccw = a.ccw !== 'false' && a.ccw !== 'FALSE';
    return indexedMarkup(name, point, nums(a.coordIndex), ccw, ident, style, notes);
  }
  if (name === 'DirectionalLight' || name === 'PointLight' || name === 'SpotLight') {
    const fields = {};
    const color = nums(a.color);
    const location = nums(a.location);
    const direction = nums(a.direction);
    if (color.length >= 3) fields.color = color;
    if (location.length >= 3) fields.location = location;
    if (direction.length >= 3) fields.direction = direction;
    if (a.intensity !== undefined && a.intensity !== '') fields.intensity = Number(a.intensity);
    return emitLight({ name, fields }, ident);
  }
  if (name === 'Viewpoint' || name === 'OrthoViewpoint') {
    const position = nums(a.position);
    return emitCamera({ fields: { position: position.length >= 3 ? position : undefined } }, ident, notes);
  }
  if (name === 'Scene' || name === 'X3D') return (tag.children || []).map((c) => emitXml(c, notes)).filter(Boolean).join('\n');
  return '';
}

function xmlMaterial(app, notes) {
  const mat = (app.children || []).find((c) => c.name === 'PhysicalMaterial' || c.name === 'Material' || c.name === 'UnlitMaterial');
  if (!mat) return '';
  if (mat.name === 'Material') notes.push('A Phong Material was read as a colour (X3D Material is not the glTF model).');
  const a = mat.attrs || {};
  const base = nums(a.baseColor || a.diffuseColor || a.emissiveColor);
  if (base.length < 3) return '';
  return ` color="${colorToShortHex(base.slice(0, 3).map((v) => linearToSrgb(v)))}"`;
}
