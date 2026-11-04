// USD ASCII, as read by OpenUSD's USDA parser.
//
// Specification: Universal Scene Description, schema version used by OpenUSD
// 24.x (the crate magic and the composition rules are stable back to the 1.0
// documents). This module writes `#usda 1.0`. USDC is smaller and is accepted
// by stock USD readers, but a correct crate cannot be produced without the
// OpenUSD library, and that library cannot run in the browser. USDA is the
// encoding a stock reader accepts without it. The size comparison should say
// so: a USDC file of the same scene would be smaller.
//
// Stage: upAxis = "Y" (ES3D is Y-up). metersPerUnit is always written;
// the fallback is 0.01, which would silently turn metres into centimetres.
// metres → 1, centimetres → 0.01, millimetres → 0.001, kilometres → 1000,
// inches → 0.0254, feet → 0.3048.
//
// Prims (UsdGeom):
//   Cube.size is one edge length, default 2, so the cube extends ±size/2.
//   A box that is not a cube is a Cube of size 1 (extent ±0.5, the ES3D unit
//   cube) plus a scale.
//   Sphere.radius defaults to 1.
//   Cylinder, Cone, Capsule and Plane default to axis "Z"; ES3D axes are Y,
//   so axis is always written. Cylinder has one radius (a frustum is a mesh).
//   Cone's apex is along +axis and its base is at the negative end.
//   Capsule.height is the cylindrical portion only. ES3D height includes the
//   hemispheres, so the written height is h − 2r.
//   Plane axis "Y": width runs along X and length along Z (UsdGeomPlane).
//   The plane is double-sided by default.
//   Extent is the local bound, excluding the prim's own transform, and is
//   written whenever a size is written.
//   Mesh subdivisionScheme = "none", orientation = "rightHanded" (counter-clockwise).
//
// Transforms (UsdGeomXformable): xformOpOrder lists the least-local op first.
// The documented TRS order is translate, rotate, scale, so a column vector
// sees scale, then rotation, then translation. A matrix4d is stored for row
// vectors (p' = p · M): the translation is the last row.
//
// Materials: UsdPreviewSurface. diffuseColor is linear. There is no unlit
// preview shader; an unlit material is written as a diffuse colour and noted.
// Lights and cameras are counted in the notes and left out. This module does
// not write UsdLux lights or UsdGeomCamera.
//
// Reuse: a geometry used more than once is a prototype under an invisible
// Xform, referenced by the instances. Repeat and scatter become a
// PointInstancer (prototypes, protoIndices, positions, orientations as
// quatf real-first, scales). A copy whose transform shears is an ordinary
// Xform with a matrix4d instead.

import * as mat4 from '../math/mat4.js';
import { matrixToTransformString } from '../transform/transform.js';
import { colorToShortHex } from '../format/colors.js';
import { n, trsOf, usdRows, metresPerUnit } from './text-encode.js';
import { repeatCopies, scatterCopies, paint } from './export-model.js';

function vec3(v) {
  return `(${n(v[0])}, ${n(v[1])}, ${n(v[2])})`;
}

function extent(min, max) {
  return `[${vec3(min)}, ${vec3(max)}]`;
}

function pointsOf(flat) {
  const parts = [];
  for (let i = 0; i < flat.length; i += 3) parts.push(vec3([flat[i], flat[i + 1], flat[i + 2]]));
  return parts.join(', ');
}

function matrixText(m) {
  const rows = usdRows(m).map((r) => `(${r.map(n).join(', ')})`);
  return `(${rows.join(', ')})`;
}

function xformBlock(matrix, pad) {
  if (!matrix) return '';
  const t = trsOf(matrix);
  if (!t) {
    return `${pad}matrix4d xformOp:transform = ${matrixText(matrix)}\n${pad}uniform token[] xformOpOrder = ["xformOp:transform"]\n`;
  }
  if (t.identity) return '';
  const order = [];
  let body = '';
  if (!t.noTrans) {
    order.push('"xformOp:translate"');
    body += `${pad}double3 xformOp:translate = ${vec3(t.translation)}\n`;
  }
  if (!t.noRot) {
    return `${pad}matrix4d xformOp:transform = ${matrixText(matrix)}\n${pad}uniform token[] xformOpOrder = ["xformOp:transform"]\n`;
  }
  if (!t.noScale) {
    order.push('"xformOp:scale"');
    body += `${pad}float3 xformOp:scale = ${vec3(t.scale)}\n`;
  }
  if (!order.length) return '';
  return `${body}${pad}uniform token[] xformOpOrder = [${order.join(', ')}]\n`;
}

function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return extent(min, max);
}

/**
 * @returns {{text: string, notes: string[]}}
 */
export function exportUSD(model) {
  const notes = model.notes.slice();
  const tally = new Map();
  const add = (key, k = 1) => tally.set(key, (tally.get(key) || 0) + k);
  const uses = new Map();
  const countUses = (node) => {
    if (!node) return;
    if (node.kind === 'shape') uses.set(node.solid.key, (uses.get(node.solid.key) || 0) + 1);
    for (const c of node.children || []) countUses(c);
  };
  countUses(model.root);

  const protos = [];
  const protoName = new Map();
  let seq = 0;
  const fresh = (prefix) => `${prefix}${seq++}`;

  const materialName = new Map();
  const materials = [];
  let unlit = 0;
  const materialPath = (index) => {
    if (materialName.has(index)) return materialName.get(index);
    const id = fresh('M');
    materialName.set(index, id);
    const m = model.materials[index];
    if (m.unlit) unlit++;
    const c = m.baseColor;
    const e = m.emissive;
    const extra = e.some((v) => v > 1e-6) ? `\n            color3f inputs:emissiveColor = ${vec3(e)}` : '';
    materials.push(`        def Material "${id}" {
            token outputs:surface.connect = </World/Materials/${id}/Surface.outputs:surface>
            def Shader "Surface" {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = ${vec3(c)}
                float inputs:metallic = ${n(m.metallic)}
                float inputs:roughness = ${n(m.roughness)}
                float inputs:opacity = ${n(m.opacity)}${extra}
                token outputs:surface
            }
        }`);
    return id;
  };

  const gprim = (shape) => {
    const s = shape.solid;
    if (s.kind === 'box') {
      const size = s.size;
      if (Math.abs(size[0] - size[1]) < 1e-9 && Math.abs(size[1] - size[2]) < 1e-9) {
        const h = size[0] / 2;
        return { type: 'Cube', body: `double size = ${n(size[0])}\nfloat3[] extent = ${extent([-h, -h, -h], [h, h, h])}\n`, local: null };
      }
      return {
        type: 'Cube',
        body: `double size = 1\nfloat3[] extent = ${extent([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5])}\n`,
        local: scaleMatrix(size),
      };
    }
    if (s.kind === 'sphere') {
      const r = s.radius;
      return { type: 'Sphere', body: `double radius = ${n(r)}\nfloat3[] extent = ${extent([-r, -r, -r], [r, r, r])}\n`, local: null };
    }
    if (s.kind === 'cylinder') {
      const r = s.radius, h = s.height;
      return { type: 'Cylinder', body: `uniform token axis = "Y"\ndouble radius = ${n(r)}\ndouble height = ${n(h)}\nfloat3[] extent = ${extent([-r, -h / 2, -r], [r, h / 2, r])}\n`, local: null };
    }
    if (s.kind === 'cone') {
      const r = s.radius, h = s.height;
      return { type: 'Cone', body: `uniform token axis = "Y"\ndouble radius = ${n(r)}\ndouble height = ${n(h)}\nfloat3[] extent = ${extent([-r, -h / 2, -r], [r, h / 2, r])}\n`, local: null };
    }
    if (s.kind === 'capsule') {
      const r = s.radius, h = s.height;
      const mid = h - 2 * r;
      if (mid <= 1e-6) {
        return { type: 'Sphere', body: `double radius = ${n(r)}\nfloat3[] extent = ${extent([-r, -r, -r], [r, r, r])}\n`, local: null };
      }
      return { type: 'Capsule', body: `uniform token axis = "Y"\ndouble radius = ${n(r)}\ndouble height = ${n(mid)}\nfloat3[] extent = ${extent([-r, -h / 2, -r], [r, h / 2, r])}\n`, local: null, note: 'capsule' };
    }
    if (s.kind === 'plane') {
      const w = s.width, d = s.depth;
      return { type: 'Plane', body: `uniform token axis = "Y"\ndouble width = ${n(w)}\ndouble length = ${n(d)}\nfloat3[] extent = ${extent([-w / 2, 0, -d / 2], [w / 2, 0, d / 2])}\n`, local: null };
    }
    if (s.kind === 'frustum' || s.kind === 'torus' || s.kind === 'extrude' || s.kind === 'revolve' || s.kind === 'surface') {
      const mesh = model.bakedMesh(shape.entry);
      return { type: 'Mesh', body: meshBody(mesh, shape.doubleSided), local: null, matrix: shape.meshMatrix, note: s.kind };
    }
    if (s.kind === 'mesh' || s.kind === 'lines') {
      return { type: s.kind === 'lines' ? 'BasisCurves' : 'Mesh', body: meshBody(s, shape.doubleSided), local: null, matrix: null, note: null };
    }
    return { type: 'Mesh', body: meshBody(model.bakedMesh(shape.entry), shape.doubleSided), local: null, matrix: shape.meshMatrix, note: s.kind };
  };

  const ensureProto = (shape) => {
    const key = shape.solid.key;
    if (protoName.has(key)) return protoName.get(key);
    const id = fresh('G');
    protoName.set(key, id);
    const g = gprim(shape);
    const local = g.local;
    protos.push(`        def ${g.type} "${id}" {\n${indent(g.body, 12)}${local ? indent(xformBlock(local, ''), 12) : ''}        }`);
    return id;
  };

  const direct = (name, shape, matrix) => {
    const key = shape.solid.key;
    const g = gprim(shape);
    if (g.note) add(g.note);
    const bind = `rel material:binding = </World/Materials/${materialPath(shape.material)}>\n`;
    const inst = g.matrix || matrix;
    if ((uses.get(key) || 0) > 1) {
      const id = ensureProto(shape);
      return `        def Xform "${name}" (\n            prepend references = </World/Prototypes/${id}>\n        ) {\n            token visibility = "inherited"\n${indent(xformBlock(inst, ''), 12)}${indent(bind, 12)}        }`;
    }
    const combined = g.matrix ? inst : combine(matrix, g.local);
    return `        def ${g.type} "${name}" {\n${indent(g.body, 12)}${indent(xformBlock(combined, ''), 12)}${indent(bind, 12)}        }`;
  };

  const chunks = [];
  const emit = (node) => {
    if (!node) return;
    if (node.kind === 'group') {
      const id = fresh('X');
      const saved = chunks.length;
      for (const c of node.children) emit(c);
      const body = chunks.splice(saved);
      if (!body.length && !node.matrix) return;
      chunks.push(`        def Xform "${id}" {\n${indent(xformBlock(node.matrix, ''), 12)}${body.map((b) => indent(b, 4)).join('\n')}\n        }`);
      return;
    }
    if (node.kind === 'repeat' || node.kind === 'scatter') {
      chunks.push(instancer(node));
      return;
    }
    chunks.push(direct(fresh('S'), node, node.matrix));
  };

  const instancer = (node) => {
    const copies = node.kind === 'repeat'
      ? repeatCopies(node).map((matrix) => ({ matrix, material: null }))
      : scatterCopies(node);
    add(node.kind, copies.length);
    const positions = [];
    const orients = [];
    const scales = [];
    const indices = [];
    const kept = [];
    let baked = 0;
    const bakedPrims = [];
    copies.forEach((copy) => {
      if (!trsOf(copy.matrix)) {
        baked++;
        const shape = firstShape(node);
        if (shape) bakedPrims.push(direct(fresh('S'), shape, copy.matrix));
        return;
      }
      kept.push(copy);
    });
    const groups = new Map();
    kept.forEach((copy, index) => {
      const id = copy.material || '';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(index);
    });
    const protoIds = [];
    for (const [matId, groupIndices] of groups) {
      const kids = matId ? node.children.map((c) => paint(c, matId, null, model.resolve)) : node.children;
      const pid = fresh('P');
      const saved = chunks.length;
      for (const c of kids) emit(c);
      const body = chunks.splice(saved);
      protos.push(`        def Xform "${pid}" {\n${body.map((b) => indent(b, 4)).join('\n')}\n        }`);
      protoIds.push({ pid, groupIndices });
    }
    const indexOf = new Array(kept.length);
    let pi = 0;
    for (const group of protoIds) {
      for (const index of group.groupIndices) indexOf[index] = pi;
      pi++;
    }
    kept.forEach((copy, index) => {
      const t = trsOf(copy.matrix);
      positions.push(vec3(t.translation));
      const q = t.rotation;
      orients.push(`(${n(q[3])}, ${n(q[0])}, ${n(q[1])}, ${n(q[2])})`);
      scales.push(vec3(t.scale));
      indices.push(indexOf[index]);
    });
    if (baked) notes.push(`${baked.toLocaleString('en-US')} instanced cop${baked === 1 ? 'y was' : 'ies were'} written as its own prim because the transform shears.`);
    const id = fresh('I');
    const rel = protoIds.map((p) => `</World/Prototypes/${p.pid}>`).join(', ');
    return `        def PointInstancer "${id}" {\n            rel prototypes = [${rel}]\n            int[] protoIndices = [${indices.join(', ')}]\n            point3f[] positions = [${positions.join(', ')}]\n            quatf[] orientations = [${orients.join(', ')}]\n            float3[] scales = [${scales.join(', ')}]\n${xformBlock(node.matrix, '            ')}        }${bakedPrims.length ? '\n' + bakedPrims.join('\n') : ''}`;
  };

  emit(model.root);

  if (unlit) notes.push(`${unlit.toLocaleString('en-US')} unlit material${unlit === 1 ? '' : 's'} written as a diffuse colour (UsdPreviewSurface has no unlit shader).`);
  const say = (key, text) => { if (tally.get(key)) notes.push(text(tally.get(key))); };
  say('frustum', (k) => `${k.toLocaleString('en-US')} frustum${k === 1 ? '' : 's'} written as a mesh (USD Cylinder has one radius).`);
  say('torus', (k) => `${k.toLocaleString('en-US')} torus${k === 1 ? '' : 'es'} written as a mesh (USD has no torus).`);
  say('extrude', (k) => `${k.toLocaleString('en-US')} extrusion${k === 1 ? '' : 's'} written as a mesh (USD has no extrusion).`);
  say('revolve', (k) => `${k.toLocaleString('en-US')} revolve${k === 1 ? '' : 's'} written as a mesh (USD has no lathe).`);
  say('surface', (k) => `${k.toLocaleString('en-US')} flat surface${k === 1 ? '' : 's'} written as a mesh.`);
  say('capsule', (k) => `${k.toLocaleString('en-US')} capsule${k === 1 ? '' : 's'} written with height excluding the hemispheres, which is the USD convention.`);
  say('repeat', (k) => `${k.toLocaleString('en-US')} repeated copies written as a PointInstancer.`);
  say('scatter', (k) => `${k.toLocaleString('en-US')} scattered copies written as a PointInstancer.`);
  if (model.lights.length) notes.push(`${model.lights.length.toLocaleString('en-US')} light${model.lights.length === 1 ? '' : 's'} omitted (this USDA file does not write UsdLux lights).`);
  if (model.cameras.length) notes.push(`${model.cameras.length.toLocaleString('en-US')} camera${model.cameras.length === 1 ? '' : 's'} omitted.`);

  const protoBlock = protos.length ? `    def Xform "Prototypes" {\n        token visibility = "invisible"\n${protos.join('\n')}\n    }\n` : '';
  const matBlock = materials.length ? `    def Scope "Materials" {\n${materials.join('\n')}\n    }\n` : '';
  const text = `#usda 1.0
(
    defaultPrim = "World"
    upAxis = "Y"
    metersPerUnit = ${n(metresPerUnit(model.unit))}
)

def Xform "World" {
${protoBlock}${matBlock}${chunks.join('\n')}
}
`;
  return { text, notes };
}

function scaleMatrix(size) {
  const m = mat4.createF64();
  m[0] = size[0];
  m[5] = size[1];
  m[10] = size[2];
  return m;
}

function combine(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const o = mat4.createF64();
  mat4.multiply(o, a, b);
  return o;
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((line) => (line ? pad + line : line)).join('\n');
}

function meshBody(mesh, doubleSided) {
  if (!mesh) return `uniform token subdivisionScheme = "none"\n`;
  if (mesh.kind === 'lines') {
    const counts = [];
    const idx = [];
    for (let i = 0; i < mesh.indices.length; i += 2) {
      counts.push(2);
      idx.push(mesh.indices[i], mesh.indices[i + 1]);
    }
    return `int[] curveVertexCounts = [${counts.join(', ')}]\npoint3f[] points = [${pointsOf(mesh.positions)}]\nuniform token type = "linear"\nfloat3[] extent = ${boundsOf(mesh.positions)}\n`;
  }
  const counts = new Array(mesh.indices.length / 3).fill(3);
  const normals = mesh.normals ? `normal3f[] normals = [${pointsOf(mesh.normals)}]\nuniform token normals:interpolation = "vertex"\n` : '';
  const side = doubleSided ? 'uniform bool doubleSided = 1\n' : '';
  return `int[] faceVertexCounts = [${counts.join(', ')}]\nint[] faceVertexIndices = [${Array.from(mesh.indices).join(', ')}]\npoint3f[] points = [${pointsOf(mesh.positions)}]\n${normals}${side}uniform token subdivisionScheme = "none"\nuniform token orientation = "rightHanded"\nfloat3[] extent = ${boundsOf(mesh.positions)}\n`;
}

function firstShape(node) {
  if (!node) return null;
  if (node.kind === 'shape') return node;
  for (const c of node.children || []) {
    const hit = firstShape(c);
    if (hit) return hit;
  }
  return null;
}

/**
 * Read the USDA this module writes: Cube, Sphere, Cylinder, Cone, Capsule,
 * Plane, Mesh, references to prototypes, and PointInstancer copies.
 * Transforms are translate, scale and matrix4d (row-vector, translation in the
 * last row, which is how usdRows lays a column-major matrix out).
 * Crate files are rejected by the caller.
 * @returns {{text: string, notes: string[]}}
 */
export function importUSD(text) {
  const notes = [];
  const src = String(text).replace(/^\uFEFF/, '');
  if (!/^\s*#usda\b/.test(src)) notes.push('The file does not start with #usda; it was read as USDA anyway.');
  const meters = /metersPerUnit\s*=\s*([0-9.eE+-]+)/.exec(src);
  const unit = unitFromMetres(meters ? Number(meters[1]) : 1);
  if (!meters) notes.push('metersPerUnit was missing; USD defaults to centimetres, and this file was read as metres.');
  const world = blockNamed(src, 'Xform', 'World') || src;
  const lib = new Map();
  const materials = new Map();
  const lines = [];
  const matLines = [];
  const paint = makePaint(matLines);
  for (const prim of listPrims(world)) {
    if (prim.type === 'Xform' && prim.name === 'Prototypes') {
      for (const child of listPrims(prim.body)) lib.set(child.name, child);
      continue;
    }
    if (prim.type === 'Scope' && prim.name === 'Materials') {
      for (const mat of listPrims(prim.body)) if (mat.type === 'Material') materials.set(mat.name, readPreview(mat.body));
      continue;
    }
    lines.push(...emitPrim(prim, lib, materials, paint, notes, null));
  }
  const body = [...matLines, ...lines].filter(Boolean);
  return { text: `<es3d version="1" unit="${unit}">\n${body.join('\n')}\n</es3d>\n`, notes };
}

function sliceBlock(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return '';
}

const GPRIMS = new Set(['Cube', 'Sphere', 'Cylinder', 'Cone', 'Capsule', 'Plane', 'Mesh']);

function blockNamed(text, type, name) {
  const re = new RegExp(`def\\s+${type}\\s+"${name}"\\s*(?:\\([^)]*\\))?\\s*\\{`);
  const hit = re.exec(text);
  if (!hit) return null;
  const open = text.indexOf('{', hit.index);
  return sliceBlock(text, open);
}

function listPrims(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('def ', i);
    if (at < 0) break;
    const before = text.slice(i, at);
    if ((before.match(/\{/g) || []).length !== (before.match(/\}/g) || []).length) { i = at + 4; continue; }
    const head = /^def\s+([A-Za-z0-9_]+)\s+"([^"]+)"\s*(\([^)]*\))?/.exec(text.slice(at));
    if (!head) { i = at + 4; continue; }
    const open = text.indexOf('{', at + head[0].length - 1);
    if (open < 0) break;
    const body = sliceBlock(text, open);
    out.push({ type: head[1], name: head[2], meta: head[3] || '', body });
    i = open + body.length + 2;
  }
  return out;
}

function emitPrim(prim, lib, materials, paint, notes, parent, inherited) {
  const local = readXform(prim.body);
  const matrix = combine(parent, local);
  const style = paint(prim.body, materials) || inherited || '';
  if (prim.type === 'Xform') {
    const ref = /references\s*=\s*<([^>]+)>/.exec(prim.meta);
    const target = ref ? lib.get(ref[1].split('/').pop()) : null;
    if (target) return emitPrim(target, lib, materials, paint, notes, matrix, style);
    const out = [];
    for (const child of listPrims(prim.body)) out.push(...emitPrim(child, lib, materials, paint, notes, matrix, style));
    return out;
  }
  if (prim.type === 'PointInstancer') return emitInstancer(prim, lib, materials, paint, notes, matrix);
  if (!GPRIMS.has(prim.type)) {
    if (prim.type !== 'Shader' && prim.type !== 'Material' && prim.type !== 'Scope') notes.push(`${prim.type} ${prim.name} was omitted.`);
    return [];
  }
  const tag = gprimTag(prim, notes, matrix, style);
  return tag ? [tag] : [];
}

function emitInstancer(prim, lib, materials, paint, notes, parent) {
  const names = [...prim.body.matchAll(/<([^>]+)>/g)].map((m) => m[1].split('/').pop());
  const rel = /prototypes\s*=\s*\[([^\]]*)\]/.exec(prim.body);
  const protoNames = rel ? [...rel[1].matchAll(/<([^>]+)>/g)].map((m) => m[1].split('/').pop()) : names;
  const indices = intList(prim.body, 'protoIndices');
  const positions = tupleList(prim.body, 'positions');
  const orients = tupleList(prim.body, 'orientations');
  const scales = tupleList(prim.body, 'scales');
  const count = Math.max(indices.length, positions.length);
  if (!count || !protoNames.length) { notes.push(`PointInstancer ${prim.name} had no instances.`); return []; }
  const out = [];
  for (let i = 0; i < count; i++) {
    const proto = lib.get(protoNames[indices[i] || 0]);
    if (!proto) continue;
    const trs = trsMatrix(positions[i] || [0, 0, 0], orients[i] || [1, 0, 0, 0], scales[i] || [1, 1, 1]);
    out.push(...emitPrim(proto, lib, materials, paint, notes, combine(parent, trs)));
  }
  if (!out.length) notes.push(`PointInstancer ${prim.name} did not resolve its prototypes.`);
  return out;
}

function gprimTag(prim, notes, matrix, style) {
  const num = (name, fallback) => {
    const hit = new RegExp(`(?:double|float)\\s+${name}\\s*=\\s*([0-9.eE+-]+)`).exec(prim.body);
    return hit ? Number(hit[1]) : fallback;
  };
  const axis = ((/axis\s*=\s*"([XYZ])"/.exec(prim.body) || [])[1]) || (prim.type === 'Cylinder' || prim.type === 'Cone' || prim.type === 'Capsule' || prim.type === 'Plane' ? 'Z' : 'Y');
  const posed = prim.type === 'Cube' ? matrix : combine(matrix, axisFix(axis));
  if (prim.type === 'Cube') {
    const edge = num('size', 2);
    const info = posed ? trsOf(posed) : null;
    if (info && info.scale.every((v) => v > 0)) {
      return `<box${xformAttr(rigid(info))}${style} size="${n(edge * info.scale[0])} ${n(edge * info.scale[1])} ${n(edge * info.scale[2])}"/>`;
    }
    return `<box${xformAttr(posed)}${style} size="${n(edge)} ${n(edge)} ${n(edge)}"/>`;
  }
  if (prim.type === 'Sphere') return `<sphere${xformAttr(posed)}${style} radius="${n(num('radius', 1))}"/>`;
  if (prim.type === 'Cylinder') return `<cylinder${xformAttr(posed)}${style} radius="${n(num('radius', 1))}" height="${n(num('height', 2))}"/>`;
  if (prim.type === 'Cone') return `<cone${xformAttr(posed)}${style} radius="${n(num('radius', 1))}" height="${n(num('height', 2))}"/>`;
  if (prim.type === 'Capsule') {
    const r = num('radius', 0.5);
    const h = num('height', 1);
    return `<capsule${xformAttr(posed)}${style} radius="${n(r)}" height="${n(h + 2 * r)}"/>`;
  }
  if (prim.type === 'Plane') return `<plane${xformAttr(posed)}${style} size="${n(num('width', 2))} ${n(num('length', 2))}"/>`;
  if (prim.type === 'Mesh') return meshTag(prim, notes, posed, style);
  return '';
}

function meshTag(prim, notes, matrix, style) {
  const points = tupleList(prim.body, 'points');
  const counts = intList(prim.body, 'faceVertexCounts');
  const indices = intList(prim.body, 'faceVertexIndices');
  if (!points.length || !indices.length) { notes.push(`Mesh ${prim.name} had no points.`); return ''; }
  const left = /orientation\s*=\s*"leftHanded"/.test(prim.body);
  const tris = [];
  let cursor = 0;
  const faces = counts.length ? counts : new Array(indices.length / 3).fill(3);
  for (const count of faces) {
    const face = indices.slice(cursor, cursor + count);
    cursor += count;
    if (left) face.reverse();
    for (let k = 1; k < face.length - 1; k++) tris.push(face[0], face[k], face[k + 1]);
  }
  if (faces.some((c) => c !== 3)) notes.push(`Mesh ${prim.name} had a face that was fanned into triangles.`);
  const pos = points.flatMap((p) => p.slice(0, 3).map((v) => n(v))).join(' ');
  return `<mesh${xformAttr(matrix)}${style} positions="${pos}" indices="${tris.join(' ')}"/>`;
}

function readXform(body) {
  const at = body.indexOf('xformOp:transform');
  if (at >= 0) {
    const nums = body.slice(at).match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
    if (nums && nums.length >= 16) {
      const m = mat4.createF64();
      for (let i = 0; i < 16; i++) m[i] = Number(nums[i]);
      return m;
    }
  }
  const t = vecField(body, 'xformOp:translate');
  const s = vecField(body, 'xformOp:scale');
  if (!t && !s) return null;
  const tm = mat4.createF64();
  if (t) { tm[12] = t[0]; tm[13] = t[1]; tm[14] = t[2]; }
  const sm = mat4.createF64();
  if (s) { sm[0] = s[0]; sm[5] = s[1]; sm[10] = s[2]; }
  return combine(t ? tm : null, s ? sm : null);
}

function axisFix(axis) {
  if (axis === 'Y') return null;
  const m = mat4.createF64();
  if (axis === 'X') mat4.fromEulerDeg(m, 0, 0, -90);
  else mat4.fromEulerDeg(m, 90, 0, 0);
  return m;
}

function rigid(info) {
  const r = mat4.createF64();
  mat4.fromQuat(r, info.rotation[0], info.rotation[1], info.rotation[2], info.rotation[3]);
  const t = mat4.createF64();
  t[12] = info.translation[0];
  t[13] = info.translation[1];
  t[14] = info.translation[2];
  return combine(t, r);
}

function trsMatrix(t, q, s) {
  const tm = mat4.createF64();
  tm[12] = t[0]; tm[13] = t[1]; tm[14] = t[2];
  const rm = mat4.createF64();
  mat4.fromQuat(rm, q[1], q[2], q[3], q[0]);
  const sm = mat4.createF64();
  sm[0] = s[0]; sm[5] = s[1]; sm[10] = s[2];
  return combine(tm, combine(rm, sm));
}

function xformAttr(m) {
  if (!m) return '';
  const text = matrixToTransformString(m, (v) => n(v));
  return text ? ` transform="${text}"` : '';
}

function vecField(body, name) {
  const hit = new RegExp(`${name}\\s*=\\s*\\(([^)]*)\\)`).exec(body);
  if (!hit) return null;
  const v = hit[1].split(',').map((s) => Number(s.trim()));
  if (v.length < 3 || v.some((x) => !Number.isFinite(x))) return null;
  return v;
}

function tupleList(body, name) {
  const hit = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(body);
  if (!hit) return [];
  const out = [];
  const re = /\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(hit[1]))) {
    const v = m[1].split(',').map((s) => Number(s.trim()));
    if (v.length && v.every((x) => Number.isFinite(x))) out.push(v);
  }
  return out;
}

function intList(body, name) {
  const hit = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(body);
  if (!hit) return [];
  return hit[1].split(/[\s,]+/).filter(Boolean).map(Number).filter((v) => Number.isFinite(v));
}

function readPreview(body) {
  const color = vecField(body, 'inputs:diffuseColor') || [0.8, 0.8, 0.8];
  const num = (name, fallback) => {
    const hit = new RegExp(`inputs:${name}\\s*=\\s*([0-9.eE+-]+)`).exec(body);
    return hit ? Number(hit[1]) : fallback;
  };
  return { color, metallic: num('metallic', 0), roughness: num('roughness', 0.5), opacity: num('opacity', 1) };
}

function makePaint(lines) {
  let seq = 0;
  return (body, materials) => {
    const bind = /material:binding\s*=\s*<([^>]+)>/.exec(body);
    if (!bind) return '';
    const mat = materials.get(bind[1].split('/').pop());
    if (!mat) return '';
    const hex = colorToShortHex(mat.color.map(linearToSrgb));
    if (mat.metallic < 1e-6 && Math.abs(mat.roughness - 0.5) < 1e-6 && mat.opacity > 0.999) return ` color="${hex}"`;
    const id = `m${seq++}`;
    const bits = [`color="${hex}"`];
    if (mat.metallic >= 1e-6) bits.push(`metallic="${n(mat.metallic)}"`);
    if (Math.abs(mat.roughness - 0.5) >= 1e-6) bits.push(`roughness="${n(mat.roughness)}"`);
    if (mat.opacity <= 0.999) bits.push(`opacity="${n(mat.opacity)}"`);
    lines.push(`<material id="${id}" ${bits.join(' ')}/>`);
    return ` material="${id}"`;
  };
}

function linearToSrgb(c) {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

function unitFromMetres(m) {
  const table = [['m', 1], ['cm', 0.01], ['mm', 0.001], ['km', 1000], ['in', 0.0254], ['ft', 0.3048]];
  for (const [name, v] of table) if (Math.abs(m - v) < 1e-8) return name;
  return 'm';
}
