// ISO 10303-21 (STEP) import and export.
//
// A boundary representation (what CAD tools export) is converted to ES3D
// shapes by step-exact.js, from the exact geometry step-brep.js reads; this
// module provides the parser and the helpers they share.
//
// stepToScene() is the triangle path: tessellated AP242 geometry
// (TRIANGULATED_SURFACE_SET, COMPLEX_TRIANGULATED_SURFACE_SET,
// TRIANGULATED_FACE and the complex face), and boundary solids made of
// POLY_LOOP, or of EDGE_LOOP lines and circles on planes and cylinders.
// The converter uses it for files without a B-rep.
//
// Writers such as Shapr3D emit FACE_BOUND for every loop and never
// FACE_OUTER_BOUND. When no loop is marked outer, the largest is the outer
// boundary and the rest are holes.
//
// Coordinates stay in the file's length unit. The unit is reported and not
// applied. Z-up files are turned Y-up on import, matching STL.
//
// Export writes one AP242 triangulated surface of every instance in world
// space. The file declares millimetres and does not rescale the numbers.
// Z is up by default, again matching STL.

import { computeNormals } from '../geometry/mesh.js';
import { triangulate } from '../path/triangulate.js';
import { buildExternalScene, exportableInstances, InstanceTable } from './external-scene.js';
import { Z_UP_TO_Y_UP } from './stl.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const TESS_TYPES = new Set([
  'TRIANGULATED_SURFACE_SET',
  'COMPLEX_TRIANGULATED_SURFACE_SET',
  'TRIANGULATED_FACE',
  'COMPLEX_TRIANGULATED_FACE',
]);
const SHELL_TYPES = new Set(['CLOSED_SHELL', 'OPEN_SHELL', 'CONNECTED_FACE_SET']);
const FACE_TYPES = new Set(['FACE', 'FACE_SURFACE', 'ADVANCED_FACE']);

const CURVED_MSG = 'This STEP file is a curved solid (NURBS or an analytic surface other than a cylinder). ES3D imports tessellated STEP, planar faces, circles and cylinders. Re-export the model from the CAD tool as a tessellated STEP or as STL.';

const decodeHead = (bytes) => new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 1024))).replace(/^\uFEFF/, '');

function toText(input) {
  if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
  return new TextDecoder('utf-8').decode(input).replace(/^\uFEFF/, '');
}

/** True when the bytes (or a leading slice of text) are an ISO-10303-21 file. */
export function isSTEP(input) {
  const text = typeof input === 'string' ? input : decodeHead(input);
  return /^\uFEFF?\s*(?:\/\*[\s\S]*?\*\/\s*)*ISO-10303-21\b/i.test(text);
}

/**
 * Parse a STEP file into its DATA entities.
 * @param {string|Uint8Array} input
 * @returns {{name: string, schema: string, unit: string|null, entities: Map<number, {id: number, parts: {name: string, args: any[]}[]}>}}
 */
export function parseSTEP(input) {
  const text = toText(input);
  if (!isSTEP(text.slice(0, 1024))) throw new Error('Not a STEP file: expected ISO-10303-21.');
  const dataAt = findData(text);
  const header = text.slice(0, dataAt);
  const entities = parseData(text, dataAt);
  return {
    name: headerString(header, 'FILE_NAME'),
    schema: headerString(header, 'FILE_SCHEMA'),
    unit: lengthUnitName(entities),
    entities,
  };
}

/**
 * Convert a STEP file into a RenderScene. One mesh per shell, or one mesh
 * for faces that belong to no shell. Tessellation is used when the file has it.
 * @param {string|Uint8Array} input
 * @param {{up?: 'z'|'y', smooth?: number}} [opts]
 */
export function stepToScene(input, { up = 'z', smooth = 30 } = {}) {
  const doc = parseSTEP(input);
  const { meshes, curved } = extractMeshes(doc.entities, smooth);
  if (!meshes.length) {
    if (curved) throw new Error(CURVED_MSG);
    throw new Error('The STEP file contains no triangles or supported faces.');
  }
  const matrix = up === 'y' ? IDENTITY : Z_UP_TO_Y_UP;
  const geometries = [];
  const materials = [];
  const instances = new InstanceTable(meshes.length);
  let triangles = 0;
  let vertices = 0;
  const base = productName(doc.entities) || doc.name.replace(/\.[^.]+$/, '') || 'step';
  meshes.forEach((m, i) => {
    geometries.push({ mesh: m.mesh, key: `step:${i}:${m.name}` });
    const name = meshes.length === 1 ? (m.name || base) : (m.name || `${base} ${i + 1}`);
    materials.push({ name, color: m.color || [0.72, 0.74, 0.78, 1], roughness: 0.45, metallic: 0 });
    instances.push(i, i, matrix);
    triangles += m.mesh.primitiveCount;
    vertices += m.mesh.vertexCount;
  });
  const built = buildExternalScene({ geometries, materials, instances });
  return { ...built, info: { name: base, schema: doc.schema, unit: doc.unit, triangles, vertices, meshes: meshes.length, curved } };
}

/**
 * Export the static scene as one tessellated STEP file.
 * @param {import('../scene/flatten.js').RenderScene} scene
 * @param {(entry: object, lod: number) => import('../geometry/mesh.js').Mesh} meshOf
 * @param {{lod?: number, up?: 'z'|'y', name?: string, maxTriangles?: number}} [opts]
 * @returns {{data: string, triangles: number}}
 */
export function exportSTEP(scene, meshOf, { lod = 0, up = 'z', name = 'es3d', maxTriangles = 2e7 } = {}) {
  const list = exportableInstances(scene);
  let total = 0;
  for (const i of list) {
    const m = meshOf(scene.geometries[scene.geom[i]], lod);
    if (m.kind === 'triangles') total += m.primitiveCount;
  }
  if (!total) throw new Error('The scene has no triangles to write as STEP.');
  if (total > maxTriangles) throw new Error(`The scene has ${total.toLocaleString('en-US')} triangles; STEP output is limited to ${maxTriangles.toLocaleString('en-US')}. Export a coarser level of detail, or glTF, which stores repeated shapes once.`);
  const zUp = up === 'z';
  const keyTo = new Map();
  const points = [];
  const tris = [];
  const M = new Float64Array(16);
  const add = (x, y, z) => {
    const k = `${Math.fround(x)},${Math.fround(y)},${Math.fround(z)}`;
    let v = keyTo.get(k);
    if (v == null) {
      v = points.length;
      points.push([Math.fround(x), Math.fround(y), Math.fround(z)]);
      keyTo.set(k, v);
    }
    return v;
  };
  for (const i of list) {
    const mesh = meshOf(scene.geometries[scene.geom[i]], lod);
    if (mesh.kind !== 'triangles') continue;
    for (let k = 0; k < 16; k++) M[k] = scene.matrices[i * 16 + k];
    const det = M[0] * (M[5] * M[10] - M[6] * M[9]) - M[4] * (M[1] * M[10] - M[2] * M[9]) + M[8] * (M[1] * M[6] - M[2] * M[5]);
    const flip = det < 0;
    const p = mesh.positions;
    const idx = mesh.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const tri = [];
      for (let c = 0; c < 3; c++) {
        const v = idx[t + (flip && c ? 3 - c : c)] * 3;
        const x = p[v], y = p[v + 1], z = p[v + 2];
        const wx = M[0] * x + M[4] * y + M[8] * z + M[12];
        const wy = M[1] * x + M[5] * y + M[9] * z + M[13];
        const wz = M[2] * x + M[6] * y + M[10] * z + M[14];
        tri.push(add(wx, zUp ? -wz : wy, zUp ? wy : wz));
      }
      tris.push(tri[0], tri[1], tri[2]);
    }
  }
  return { data: writeStep(name, points, tris), triangles: tris.length / 3 };
}

// --- Part 21 parser ----------------------------------------------------------

class Scanner {
  constructor(text, at) {
    this.s = text;
    this.n = text.length;
    this.i = at;
  }

  get c() {
    return this.i < this.n ? this.s.charCodeAt(this.i) : -1;
  }

  skip() {
    const s = this.s;
    const n = this.n;
    let i = this.i;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
      if (c === 47 && s.charCodeAt(i + 1) === 42) {
        i += 2;
        while (i < n && !(s.charCodeAt(i) === 42 && s.charCodeAt(i + 1) === 47)) i++;
        if (i >= n) { this.i = i; this.error('unterminated comment'); }
        i += 2;
        continue;
      }
      break;
    }
    this.i = i;
  }

  error(msg) {
    let line = 1;
    for (let k = 0; k < this.i && k < this.n; k++) if (this.s.charCodeAt(k) === 10) line++;
    throw new Error(`STEP: ${msg} (line ${line}).`);
  }

  peekKeyword() {
    const s = this.s;
    let i = this.i;
    while (i < this.n) {
      const c = s.charCodeAt(i);
      const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45;
      if (!ok) break;
      i++;
    }
    return s.slice(this.i, i).toUpperCase();
  }
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

function isIdentStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isIdentPart(c) {
  return isIdentStart(c) || isDigit(c) || c === 95;
}

function findData(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 39) {
      i++;
      while (i < n) {
        if (text.charCodeAt(i) === 39) {
          if (text.charCodeAt(i + 1) === 39) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      i += 2;
      while (i < n && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47)) i++;
      i += 2;
      continue;
    }
    if ((c === 68 || c === 100) && /^data/i.test(text.slice(i, i + 4))) {
      const prev = i > 0 ? text.charCodeAt(i - 1) : 0;
      if (!isIdentPart(prev)) {
        let j = i + 4;
        while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 10 || text.charCodeAt(j) === 13)) j++;
        if (text.charCodeAt(j) === 59) return j + 1;
      }
    }
    i++;
  }
  throw new Error('STEP: the file has no DATA section.');
}

function headerString(header, keyword) {
  const m = new RegExp(`\\b${keyword}\\s*\\(`, 'i').exec(header);
  if (!m) return '';
  let i = m.index + m[0].length;
  while (i < header.length && /\s/.test(header[i])) i++;
  if (header[i] === '(') {
    i++;
    while (i < header.length && /\s/.test(header[i])) i++;
  }
  if (header[i] !== "'") return '';
  i++;
  let out = '';
  while (i < header.length) {
    if (header[i] === "'") {
      if (header[i + 1] === "'") { out += "'"; i += 2; continue; }
      break;
    }
    out += header[i++];
  }
  return out;
}

function parseData(text, at) {
  const sc = new Scanner(text, at);
  const entities = new Map();
  for (;;) {
    sc.skip();
    if (sc.i >= sc.n) break;
    if (isIdentStart(sc.c)) {
      const w = sc.peekKeyword();
      if (w === 'ENDSEC' || w === 'END-ISO-10303-21') break;
      sc.error('expected #id or ENDSEC');
    }
    if (sc.c === 38) sc.error('SCOPE sections are not supported');
    if (sc.c !== 35) sc.error('expected an entity id');
    const id = parseRef(sc);
    sc.skip();
    if (sc.c !== 61) sc.error('expected =');
    sc.i++;
    sc.skip();
    const parts = [];
    if (sc.c === 40 && isIdentStart(sc.s.charCodeAt(skipAhead(sc)))) {
      sc.i++;
      sc.skip();
      while (sc.c !== 41) {
        const name = parseIdent(sc);
        parts.push({ name, args: parseList(sc) });
        sc.skip();
      }
      sc.i++;
    } else {
      const name = parseIdent(sc);
      parts.push({ name, args: parseList(sc) });
    }
    sc.skip();
    if (sc.c !== 59) sc.error('expected ;');
    sc.i++;
    if (entities.has(id)) sc.error(`entity #${id} is defined twice`);
    entities.set(id, { id, parts });
  }
  return entities;
}

/** Index of the next non-space character, without moving the scanner. Comments are not expected here. */
function skipAhead(sc) {
  let i = sc.i + 1;
  const s = sc.s;
  while (i < sc.n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
    return i;
  }
  return i;
}

function parseRef(sc) {
  if (sc.c !== 35) sc.error('expected #');
  sc.i++;
  if (!isDigit(sc.c)) sc.error('expected an entity id');
  const start = sc.i;
  while (isDigit(sc.c)) sc.i++;
  return Number(sc.s.slice(start, sc.i));
}

function parseIdent(sc) {
  if (!isIdentStart(sc.c)) sc.error('expected a type name');
  const start = sc.i;
  sc.i++;
  while (isIdentPart(sc.c)) sc.i++;
  return sc.s.slice(start, sc.i).toUpperCase();
}

function parseList(sc) {
  sc.skip();
  if (sc.c !== 40) sc.error('expected (');
  sc.i++;
  const args = [];
  sc.skip();
  if (sc.c === 41) { sc.i++; return args; }
  for (;;) {
    args.push(parseValue(sc));
    sc.skip();
    if (sc.c === 44) { sc.i++; continue; }
    if (sc.c === 41) { sc.i++; break; }
    sc.error('expected , or )');
  }
  return args;
}

function parseValue(sc) {
  sc.skip();
  const c = sc.c;
  if (c === 36) { sc.i++; return null; }
  if (c === 42) { sc.i++; return '*'; }
  if (c === 35) return { ref: parseRef(sc) };
  if (c === 40) return parseList(sc);
  if (c === 39) return parseString(sc);
  if (c === 46) return isDigit(sc.s.charCodeAt(sc.i + 1)) ? parseNumber(sc) : parseEnum(sc);
  if (c === 43 || c === 45 || isDigit(c)) return parseNumber(sc);
  if (isIdentStart(c)) {
    const name = parseIdent(sc);
    sc.skip();
    if (sc.c === 40) return { typed: name, args: parseList(sc) };
    return name;
  }
  sc.error('unexpected character');
  return null;
}

function parseEnum(sc) {
  if (sc.c !== 46) sc.error('expected an enumeration');
  sc.i++;
  const start = sc.i;
  while (sc.i < sc.n && sc.c !== 46) sc.i++;
  if (sc.c !== 46) sc.error('unterminated enumeration');
  const name = sc.s.slice(start, sc.i).toUpperCase();
  sc.i++;
  if (name === 'T') return true;
  if (name === 'F') return false;
  return { enum: name };
}

function parseString(sc) {
  sc.i++;
  let out = '';
  while (sc.i < sc.n) {
    if (sc.c === 39) {
      if (sc.s.charCodeAt(sc.i + 1) === 39) { out += "'"; sc.i += 2; continue; }
      sc.i++;
      return out;
    }
    out += sc.s[sc.i++];
  }
  sc.error('unterminated string');
  return out;
}

function parseNumber(sc) {
  const start = sc.i;
  if (sc.c === 43 || sc.c === 45) sc.i++;
  let saw = false;
  while (isDigit(sc.c)) { saw = true; sc.i++; }
  if (sc.c === 46) {
    sc.i++;
    while (isDigit(sc.c)) { saw = true; sc.i++; }
  }
  if (sc.c === 69 || sc.c === 101) {
    const e = sc.i;
    sc.i++;
    if (sc.c === 43 || sc.c === 45) sc.i++;
    let exp = false;
    while (isDigit(sc.c)) { exp = true; sc.i++; }
    if (!exp) sc.i = e;
  }
  if (!saw) sc.error('expected a number');
  return Number(sc.s.slice(start, sc.i));
}

function lengthUnitName(entities) {
  for (const e of entities.values()) {
    const si = e.parts.find((p) => p.name === 'SI_UNIT');
    const length = e.parts.some((p) => p.name === 'LENGTH_UNIT');
    const metre = si && si.args.some((a) => a && a.enum === 'METRE');
    if (si && (length || metre)) {
      const prefix = si.args.find((a) => a && a.enum && a.enum !== 'METRE');
      return siLength(prefix && prefix.enum);
    }
    if (length) {
      const conv = e.parts.find((p) => p.name === 'CONVERSION_BASED_UNIT');
      const name = conv && conv.args.find((a) => typeof a === 'string');
      if (name) return name.toLowerCase();
    }
  }
  return null;
}

function siLength(prefix) {
  const map = {
    MICRO: 'micrometres', MILLI: 'millimetres', CENTI: 'centimetres', DECI: 'decimetres',
    DECA: 'decametres', HECTO: 'hectometres', KILO: 'kilometres',
  };
  if (!prefix) return 'metres';
  return map[prefix] || `${prefix.toLowerCase()}metres`;
}

export function productName(entities) {
  for (const e of entities.values()) {
    const p = e.parts.find((x) => x.name === 'PRODUCT');
    if (!p) continue;
    const strings = p.args.filter((a) => typeof a === 'string' && a);
    return strings[1] || strings[0] || '';
  }
  return '';
}

// --- geometry ----------------------------------------------------------------

export function has(e, name) {
  return e.parts.some((p) => p.name === name);
}

export function part(e, name) {
  return e.parts.find((p) => p.name === name) || null;
}

export function coordsOf(entities, v, depth = 0) {
  if (v == null || depth > 8) return null;
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
    return [v[0], v[1], v.length > 2 && typeof v[2] === 'number' ? v[2] : 0];
  }
  if (!v.ref) return null;
  const e = entities.get(v.ref);
  if (!e) return null;
  const cp = part(e, 'CARTESIAN_POINT');
  if (cp) {
    const list = cp.args.find((a) => Array.isArray(a) && typeof a[0] === 'number');
    if (!list) return null;
    return [list[0], list[1], list.length > 2 ? list[2] : 0];
  }
  const vp = part(e, 'VERTEX_POINT');
  if (vp) {
    const ref = [...vp.args].reverse().find((a) => a && a.ref);
    return coordsOf(entities, ref, depth + 1);
  }
  return null;
}

function pointListOf(entities, v) {
  if (Array.isArray(v) && v.length && Array.isArray(v[0]) && typeof v[0][0] === 'number') {
    return v.map((p) => [p[0], p[1], p.length > 2 ? p[2] : 0]);
  }
  if (!v || !v.ref) return null;
  const e = entities.get(v.ref);
  if (!e) return null;
  const p = part(e, 'CARTESIAN_POINT_LIST_3D') || part(e, 'CARTESIAN_POINT_LIST_2D');
  if (!p) return null;
  const lists = p.args.find((a) => Array.isArray(a) && a.length && Array.isArray(a[0]));
  if (!lists) return null;
  return lists.map((q) => [q[0], q[1], q.length > 2 ? q[2] : 0]);
}

function isRowList(a) {
  return Array.isArray(a) && a.length > 0 && Array.isArray(a[0]) && a[0].length >= 3 && typeof a[0][0] === 'number';
}

function takeRows(a) {
  if (a == null) return [];
  if (Array.isArray(a) && a.length === 0) return [];
  if (isRowList(a)) return a;
  return null;
}

function isIndexInto(rows, n) {
  if (!isRowList(rows) || !n) return false;
  let max = 0;
  for (const row of rows) {
    for (const v of row) {
      if (!Number.isInteger(v) || v < 1 || v > n) return false;
      if (v > max) max = v;
    }
  }
  if (rows.length === n && max <= 1) return false;
  return true;
}

function flatIndex(args, n) {
  let best = null;
  for (const a of args) {
    if (!Array.isArray(a) || !a.length || Array.isArray(a[0])) continue;
    if (!a.every((v) => Number.isInteger(v) && v >= 1 && v <= n)) continue;
    if (!best || a.length > best.length) best = a;
  }
  return best;
}

function findPoints(entities, args) {
  for (const a of args) {
    if (a && a.ref) {
      const pts = pointListOf(entities, a);
      if (pts && pts.length) return pts;
    }
  }
  const rows = args.filter(isRowList);
  for (const candidate of rows) {
    const others = rows.filter((r) => r !== candidate);
    if (others.some((r) => isIndexInto(r, candidate.length)) && !others.some((o) => isIndexInto(candidate, o.length))) {
      return candidate.map((p) => [p[0], p[1], p[2] || 0]);
    }
  }
  return null;
}

class Soup {
  constructor() {
    this.pos = [];
    this.idx = [];
    this.map = new Map();
  }

  add(p, key) {
    const k = key != null ? key : `${p[0]},${p[1]},${p[2]}`;
    let v = this.map.get(k);
    if (v == null) {
      v = this.pos.length / 3;
      this.pos.push(p[0], p[1], p[2]);
      this.map.set(k, v);
    }
    return v;
  }

  tri(a, b, c) {
    if (a === b || b === c || a === c) return;
    const p = this.pos;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const bx = p[b * 3] - ax, by = p[b * 3 + 1] - ay, bz = p[b * 3 + 2] - az;
    const cx = p[c * 3] - ax, cy = p[c * 3 + 1] - ay, cz = p[c * 3 + 2] - az;
    const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
    if (nx * nx + ny * ny + nz * nz < 1e-24) return;
    this.idx.push(a, b, c);
  }

  finish(smooth) {
    if (this.idx.length < 3) return null;
    return computeNormals(Float32Array.from(this.pos), Uint32Array.from(this.idx), smooth);
  }
}

function indexOrigin(groups) {
  for (const g of groups) {
    for (const row of g) {
      for (const v of row) if (v === 0) return 0;
    }
  }
  return 1;
}

function addIndexed(soup, points, triangles, strips, fans, pn, keyPrefix) {
  const groups = [triangles, strips, fans].filter((g) => g && g.length);
  const base = indexOrigin(groups);
  const map = (i) => {
    let v = i;
    if (pn && base === 1) {
      if (v < 1 || v > pn.length) return -1;
      v = pn[v - 1];
      if (!v) return -1;
    }
    const idx = base === 0 ? v : v - 1;
    if (idx < 0 || idx >= points.length) return -1;
    return soup.add(points[idx], `${keyPrefix}:${idx}`);
  };
  const put = (a, b, c) => {
    const ia = map(a), ib = map(b), ic = map(c);
    if (ia < 0 || ib < 0 || ic < 0) return;
    soup.tri(ia, ib, ic);
  };
  for (const t of triangles) if (t.length >= 3) put(t[0], t[1], t[2]);
  for (const strip of strips) {
    for (let i = 0; i + 2 < strip.length; i++) {
      const a = strip[i], b = strip[i + 1], c = strip[i + 2];
      if (i % 2 === 0) put(a, b, c);
      else put(b, a, c);
    }
  }
  for (const fan of fans) {
    for (let i = 1; i + 1 < fan.length; i++) put(fan[0], fan[i], fan[i + 1]);
  }
}

function addTess(soup, entities, e) {
  const args = e.parts.flatMap((p) => p.args);
  const complex = e.parts.some((p) => p.name.startsWith('COMPLEX_TRIANGULATED'));
  const points = findPoints(entities, args);
  if (!points) return;
  let triangles = [];
  let strips = [];
  let fans = [];
  let found = false;
  if (complex && args.length >= 7 && takeRows(args[5]) && takeRows(args[6])) {
    strips = takeRows(args[5]);
    fans = takeRows(args[6]);
    found = true;
  } else if (!complex && args.length >= 6 && takeRows(args[5])) {
    triangles = takeRows(args[5]);
    found = true;
  }
  if (!found) {
    const indexLists = args.filter((a) => isRowList(a) && isIndexInto(a, points.length));
    if (complex) {
      strips = indexLists[0] || [];
      fans = indexLists[1] || [];
    } else triangles = indexLists[0] || [];
  }
  const pn = flatIndex(args, points.length);
  addIndexed(soup, points, triangles, strips, fans, pn, e.id);
}

export function colourMap(entities) {
  const map = new Map();
  for (const e of entities.values()) {
    if (!has(e, 'STYLED_ITEM')) continue;
    const args = e.parts.flatMap((p) => p.args);
    let target = null;
    for (const a of args) if (a && a.ref) target = a.ref;
    if (target == null) continue;
    const colour = findColour(entities, args, 0, new Set());
    if (colour && !map.has(target)) map.set(target, colour);
  }
  return map;
}

function findColour(entities, node, depth, seen) {
  if (node == null || depth > 24) return null;
  if (node.ref) {
    if (seen.has(node.ref)) return null;
    seen.add(node.ref);
    return findColour(entities, entities.get(node.ref), depth + 1, seen);
  }
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = findColour(entities, c, depth, seen);
      if (hit) return hit;
    }
    return null;
  }
  if (node.parts) {
    const rgb = part(node, 'COLOUR_RGB');
    if (rgb) {
      const nums = rgb.args.filter((n) => typeof n === 'number');
      if (nums.length >= 3) return normalizeRgb(nums);
    }
    for (const p of node.parts) {
      const hit = findColour(entities, p.args, depth, seen);
      if (hit) return hit;
    }
  }
  return null;
}

function normalizeRgb(nums) {
  let r = nums[0], g = nums[1], b = nums[2];
  if (r > 1 || g > 1 || b > 1) { r /= 255; g /= 255; b /= 255; }
  return [r, g, b, 1];
}

export function labelOf(e) {
  const s = e.parts.flatMap((p) => p.args).find((a) => typeof a === 'string' && a.trim());
  return s ? s.trim() : '';
}

export function isFaceEntity(e) {
  if (!e || has(e, 'ORIENTED_FACE')) return false;
  return e.parts.some((p) => FACE_TYPES.has(p.name));
}

export function asFace(entities, ref) {
  let e = ref && ref.ref ? entities.get(ref.ref) : null;
  let flip = false;
  if (e && has(e, 'ORIENTED_FACE')) {
    const args = part(e, 'ORIENTED_FACE').args;
    if (args.filter((a) => typeof a === 'boolean').pop() === false) flip = true;
    const next = args.filter((a) => a && a.ref).pop();
    e = next ? entities.get(next.ref) : null;
  }
  return { face: e, flip, id: ref && ref.ref };
}

function faceCurved(entities, face) {
  for (const a of face.parts.flatMap((p) => p.args)) {
    if (!a || !a.ref) continue;
    const g = entities.get(a.ref);
    if (!g) continue;
    const names = g.parts.map((p) => p.name);
    if (names.some((n) => n === 'FACE_BOUND' || n === 'FACE_OUTER_BOUND' || n === 'POLY_LOOP' || n === 'EDGE_LOOP' || n === 'PLANE' || n === 'CYLINDRICAL_SURFACE' || n === 'AXIS2_PLACEMENT_3D')) continue;
    if (names.some((n) => n.includes('SURFACE') || n.includes('CURVE') || n === 'PCURVE')) return true;
  }
  return false;
}

export function directionOf(entities, ref) {
  const e = ref && ref.ref ? entities.get(ref.ref) : null;
  const d = e && part(e, 'DIRECTION');
  if (!d) return null;
  const list = d.args.find((a) => Array.isArray(a) && typeof a[0] === 'number');
  if (!list) return null;
  const v = [list[0], list[1], list.length > 2 ? list[2] : 0];
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-15) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function placementFrame(entities, ref) {
  const e = ref && ref.ref ? entities.get(ref.ref) : null;
  const pl = e && part(e, 'AXIS2_PLACEMENT_3D');
  if (!pl) return null;
  const refs = pl.args.filter((a) => a && a.ref);
  const origin = coordsOf(entities, refs[0]);
  if (!origin) return null;
  const z = directionOf(entities, refs[1]) || [0, 0, 1];
  const refDir = directionOf(entities, refs[2]) || [1, 0, 0];
  let x0 = refDir[0] - z[0] * (refDir[0] * z[0] + refDir[1] * z[1] + refDir[2] * z[2]);
  let x1 = refDir[1] - z[1] * (refDir[0] * z[0] + refDir[1] * z[1] + refDir[2] * z[2]);
  let x2 = refDir[2] - z[2] * (refDir[0] * z[0] + refDir[1] * z[1] + refDir[2] * z[2]);
  if (Math.hypot(x0, x1, x2) < 1e-12) {
    const t = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const d = t[0] * z[0] + t[1] * z[1] + t[2] * z[2];
    x0 = t[0] - z[0] * d;
    x1 = t[1] - z[1] * d;
    x2 = t[2] - z[2] * d;
  }
  const xl = Math.hypot(x0, x1, x2);
  x0 /= xl; x1 /= xl; x2 /= xl;
  return { origin, x: [x0, x1, x2], y: [z[1] * x2 - z[2] * x1, z[2] * x0 - z[0] * x2, z[0] * x1 - z[1] * x0], z };
}

function pointAngle(frame, p) {
  const dx = p[0] - frame.origin[0], dy = p[1] - frame.origin[1], dz = p[2] - frame.origin[2];
  const x = dx * frame.x[0] + dy * frame.x[1] + dz * frame.x[2];
  const y = dx * frame.y[0] + dy * frame.y[1] + dz * frame.y[2];
  return Math.atan2(y, x);
}

function pointHeight(frame, p) {
  return (p[0] - frame.origin[0]) * frame.z[0] + (p[1] - frame.origin[1]) * frame.z[1] + (p[2] - frame.origin[2]) * frame.z[2];
}

function circleAt(frame, radius, t) {
  const c = Math.cos(t), s = Math.sin(t);
  return [
    frame.origin[0] + radius * (c * frame.x[0] + s * frame.y[0]),
    frame.origin[1] + radius * (c * frame.x[1] + s * frame.y[1]),
    frame.origin[2] + radius * (c * frame.x[2] + s * frame.y[2]),
  ];
}

const ARC_STEP = Math.PI / 36;
const ARC_MAX = 128;

function sampleCircle(entities, geom, start, end, increase) {
  const args = part(geom, 'CIRCLE').args;
  const radius = args.find((a) => typeof a === 'number');
  const place = args.find((a) => a && a.ref);
  if (!(radius > 0) || !place) return null;
  const frame = placementFrame(entities, place);
  if (!frame) return null;
  let a0 = pointAngle(frame, start);
  let a1 = pointAngle(frame, end);
  const dx = start[0] - end[0], dy = start[1] - end[1], dz = start[2] - end[2];
  if (dx * dx + dy * dy + dz * dz < 1e-16) a1 = a0 + (increase ? Math.PI * 2 : -Math.PI * 2);
  else if (increase) {
    while (a1 < a0 - 1e-7) a1 += Math.PI * 2;
  } else {
    while (a1 > a0 + 1e-7) a1 -= Math.PI * 2;
  }
  const sweep = a1 - a0;
  const n = Math.min(ARC_MAX, Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP)));
  const pts = [start];
  for (let i = 1; i < n; i++) pts.push(circleAt(frame, radius, a0 + sweep * (i / n)));
  return pts;
}

function orientedEdge(entities, item) {
  let e = item && item.ref ? entities.get(item.ref) : null;
  if (!e) return null;
  let orientFlip = false;
  if (has(e, 'ORIENTED_EDGE')) {
    const args = part(e, 'ORIENTED_EDGE').args;
    if (args.filter((a) => typeof a === 'boolean').pop() === false) orientFlip = true;
    const ref = args.filter((a) => a && a.ref).pop();
    e = ref ? entities.get(ref.ref) : null;
    if (!e) return null;
  }
  const edge = part(e, 'EDGE_CURVE') || part(e, 'EDGE');
  if (!edge) return { curved: true };
  const refs = edge.args.filter((a) => a && a.ref);
  const sameSense = edge.args.filter((a) => typeof a === 'boolean').pop();
  const geom = refs[2] ? entities.get(refs[2].ref) : null;
  const startRef = orientFlip ? refs[1] : refs[0];
  const endRef = orientFlip ? refs[0] : refs[1];
  const start = coordsOf(entities, startRef);
  if (!start) return { curved: true };
  const startId = startRef && startRef.ref;
  if (!geom || has(geom, 'LINE')) return { curved: false, pts: [start], ids: [startId] };
  if (has(geom, 'CIRCLE')) {
    const end = coordsOf(entities, endRef);
    if (!end) return { curved: true };
    let increase = sameSense !== false;
    if (orientFlip) increase = !increase;
    const pts = sampleCircle(entities, geom, start, end, increase);
    if (!pts) return { curved: true };
    return { curved: false, pts, ids: pts.map((_, i) => (i === 0 ? startId : null)) };
  }
  return { curved: true };
}

function readLoop(entities, loop) {
  if (!loop) return null;
  if (has(loop, 'POLY_LOOP')) {
    const list = part(loop, 'POLY_LOOP').args.find((a) => Array.isArray(a));
    if (!list) return { pts: [], ids: [], curved: false };
    const pts = [];
    const ids = [];
    for (const item of list) {
      const p = coordsOf(entities, item);
      if (!p) return { pts: [], ids: [], curved: false };
      pts.push(p);
      ids.push(item && item.ref);
    }
    return { pts, ids, curved: false };
  }
  if (has(loop, 'EDGE_LOOP')) {
    const list = part(loop, 'EDGE_LOOP').args.find((a) => Array.isArray(a));
    if (!list) return { pts: [], ids: [], curved: false };
    const pts = [];
    const ids = [];
    for (const item of list) {
      const edge = orientedEdge(entities, item);
      if (!edge || edge.curved) return { pts: [], ids: [], curved: true };
      for (let i = 0; i < edge.pts.length; i++) {
        pts.push(edge.pts[i]);
        ids.push(edge.ids[i]);
      }
    }
    return { pts, ids, curved: false };
  }
  return { pts: [], ids: [], curved: true };
}

function cleanRing(pts, ids) {
  const p = [];
  const d = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = p[p.length - 1];
    if (prev && prev[0] === pts[i][0] && prev[1] === pts[i][1] && prev[2] === pts[i][2]) continue;
    p.push(pts[i]);
    d.push(ids[i]);
  }
  if (p.length > 1) {
    const a = p[0], b = p[p.length - 1];
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) { p.pop(); d.pop(); }
  }
  return { pts: p, ids: d };
}

function newell(pts) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

function basis(n) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const t = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  let ux = n[1] * t[2] - n[2] * t[1];
  let uy = n[2] * t[0] - n[0] * t[2];
  let uz = n[0] * t[1] - n[1] * t[0];
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  const nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;
  return { u: [ux, uy, uz], v: [ny * uz - nz * uy, nz * ux - nx * uz, nx * uy - ny * ux] };
}

function project(pts, origin, u, v) {
  const flat = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    const d0 = pts[i][0] - origin[0], d1 = pts[i][1] - origin[1], d2 = pts[i][2] - origin[2];
    flat[i * 2] = d0 * u[0] + d1 * u[1] + d2 * u[2];
    flat[i * 2 + 1] = d0 * v[0] + d1 * v[1] + d2 * v[2];
  }
  return flat;
}

function isConvex(flat) {
  const n = flat.length / 2;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, q = (i + 1) % n;
    const c = (flat[i * 2] - flat[p * 2]) * (flat[q * 2 + 1] - flat[i * 2 + 1]) - (flat[i * 2 + 1] - flat[p * 2 + 1]) * (flat[q * 2] - flat[i * 2]);
    if (Math.abs(c) < 1e-12) continue;
    const s = c > 0 ? 1 : -1;
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function ringArea(flat, n) {
  let s = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) s += (flat[j * 2] - flat[i * 2]) * (flat[i * 2 + 1] + flat[j * 2 + 1]);
  return s;
}

function polygonIndices(outerPts, holePts) {
  const nrm = newell(outerPts);
  if (Math.hypot(nrm[0], nrm[1], nrm[2]) < 1e-18) return [];
  const { u, v } = basis(nrm);
  if (!holePts.length) {
    const flat = project(outerPts, outerPts[0], u, v);
    if (isConvex(flat)) {
      const idx = [];
      for (let i = 1; i + 1 < outerPts.length; i++) idx.push(0, i, i + 1);
      return idx;
    }
  }
  const all = outerPts.concat(...holePts);
  const flat = project(all, outerPts[0], u, v);
  const holes = [];
  let acc = outerPts.length;
  for (const h of holePts) {
    if (h.length >= 3) holes.push(acc);
    acc += h.length;
  }
  let ix = [];
  try { ix = triangulate(flat, holes.length ? holes : null) || []; } catch { ix = []; }
  if (!ix.length) {
    const fan = [];
    for (let i = 1; i + 1 < outerPts.length; i++) fan.push(0, i, i + 1);
    return fan;
  }
  if (ringArea(flat, outerPts.length) < 0) {
    for (let i = 0; i < ix.length; i += 3) {
      const t = ix[i + 1];
      ix[i + 1] = ix[i + 2];
      ix[i + 2] = t;
    }
  }
  return ix;
}

function surfaceEntity(entities, face) {
  const args = (part(face, 'ADVANCED_FACE') || part(face, 'FACE_SURFACE') || part(face, 'FACE') || face.parts[face.parts.length - 1]).args;
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (!a || !a.ref) continue;
    const e = entities.get(a.ref);
    if (e && e.parts.some((p) => p.name.includes('SURFACE') || p.name === 'PLANE')) return e;
  }
  return null;
}

function unwrapCylinder(pts, frame) {
  const uv = new Array(pts.length);
  let prev = null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    let th = pointAngle(frame, pts[i]);
    if (prev != null) {
      while (th - prev > Math.PI) th -= Math.PI * 2;
      while (prev - th > Math.PI) th += Math.PI * 2;
    }
    uv[i] = [th, pointHeight(frame, pts[i])];
    if (th < min) min = th;
    if (th > max) max = th;
    prev = th;
  }
  if (!(max > min + 1e-8)) return null;
  return uv;
}

function cylinderIndices(pts, frame) {
  const uv = unwrapCylinder(pts, frame);
  if (!uv) return null;
  const n = pts.length;
  let iMin = 0;
  let iMax = 0;
  for (let i = 1; i < n; i++) {
    if (uv[i][0] < uv[iMin][0] - 1e-9) iMin = i;
    if (uv[i][0] > uv[iMax][0] + 1e-9) iMax = i;
  }
  if (iMin === iMax) return null;
  const walk = (step) => {
    const chain = [];
    for (let i = iMin, guard = 0; guard <= n; guard++) {
      chain.push(i);
      if (i === iMax) return chain;
      i = (i + step + n) % n;
    }
    return null;
  };
  const rising = (chain) => {
    for (let i = 1; i < chain.length; i++) if (uv[chain[i]][0] < uv[chain[i - 1]][0] - 1e-5) return false;
    return true;
  };
  const a = walk(1);
  const b = walk(-1);
  if (!a || !b || a.length < 2 || b.length < 2 || !rising(a) || !rising(b)) return null;
  let ring = 0;
  for (let i = 0; i < n; i++) {
    const p = uv[i], q = uv[(i + 1) % n];
    ring += p[0] * q[1] - q[0] * p[1];
  }
  const sign = ring < 0 ? -1 : 1;
  const ix = [];
  let ia = 0;
  let ib = 0;
  while (ia < a.length - 1 || ib < b.length - 1) {
    let p, q, r;
    if (ia >= a.length - 1) { p = a[ia]; q = b[ib]; r = b[ib + 1]; ib++; }
    else if (ib >= b.length - 1) { p = a[ia]; q = b[ib]; r = a[ia + 1]; ia++; }
    else if (uv[a[ia + 1]][0] <= uv[b[ib + 1]][0] + 1e-12) { p = a[ia]; q = b[ib]; r = a[ia + 1]; ia++; }
    else { p = a[ia]; q = b[ib]; r = b[ib + 1]; ib++; }
    if (p === q || q === r || p === r) continue;
    const pa = uv[p], pb = uv[q], pc = uv[r];
    const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
    if (Math.abs(area) < 1e-14) continue;
    if ((area < 0 ? -1 : 1) === sign) ix.push(p, q, r);
    else ix.push(p, r, q);
  }
  if (ix.length < 3) return null;
  const nrm = newell(pts);
  for (let i = 0; i < ix.length; i += 3) {
    const a0 = pts[ix[i]], b0 = pts[ix[i + 1]], c0 = pts[ix[i + 2]];
    const ux = b0[0] - a0[0], uy = b0[1] - a0[1], uz = b0[2] - a0[2];
    const vx = c0[0] - a0[0], vy = c0[1] - a0[1], vz = c0[2] - a0[2];
    const dot = (uy * vz - uz * vy) * nrm[0] + (uz * vx - ux * vz) * nrm[1] + (ux * vy - uy * vx) * nrm[2];
    if (Math.abs(dot) < 1e-12) continue;
    if (dot < 0) {
      for (let k = 0; k < ix.length; k += 3) {
        const t = ix[k + 1];
        ix[k + 1] = ix[k + 2];
        ix[k + 2] = t;
      }
    }
    break;
  }
  return ix;
}

function emitFace(soup, pts, ids, ix) {
  let n = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const va = ix[i], vb = ix[i + 1], vc = ix[i + 2];
    if (va == null || vb == null || vc == null) continue;
    soup.tri(
      soup.add(pts[va], ids[va] != null ? `p${ids[va]}` : null),
      soup.add(pts[vb], ids[vb] != null ? `p${ids[vb]}` : null),
      soup.add(pts[vc], ids[vc] != null ? `p${ids[vc]}` : null),
    );
    n++;
  }
  return n;
}

function faceRings(entities, face, extraFlip) {
  if (!face) return null;
  const args = (part(face, 'ADVANCED_FACE') || part(face, 'FACE_SURFACE') || part(face, 'FACE') || face.parts[face.parts.length - 1]).args;
  // FACE_BOUND orientation already follows the face. same_sense only says
  // whether that face normal agrees with the surface, so it must not reverse
  // the loop a second time.
  const flip = extraFlip;
  let outer = null;
  const holes = [];
  for (const a of args) {
    const refs = Array.isArray(a) ? a.filter((x) => x && x.ref) : (a && a.ref ? [a] : []);
    for (const ref of refs) {
      const bound = entities.get(ref.ref);
      if (!bound || (!has(bound, 'FACE_BOUND') && !has(bound, 'FACE_OUTER_BOUND'))) continue;
      const ba = (part(bound, 'FACE_OUTER_BOUND') || part(bound, 'FACE_BOUND')).args;
      const loopRef = ba.find((x) => x && x.ref);
      const loop = readLoop(entities, loopRef ? entities.get(loopRef.ref) : null);
      if (!loop) continue;
      if (loop.curved) return { curved: true };
      const reversed = ba.find((x) => typeof x === 'boolean') === false;
      let ring = cleanRing(loop.pts, loop.ids);
      if (reversed !== flip && ring.pts.length) ring = { pts: ring.pts.slice().reverse(), ids: ring.ids.slice().reverse() };
      else if (reversed && flip) ring = cleanRing(loop.pts, loop.ids);
      if (has(bound, 'FACE_OUTER_BOUND')) {
        if (!outer) outer = ring;
        else holes.push(ring);
      } else holes.push(ring);
    }
  }
  if (!outer) {
    let best = -1;
    let bestAt = -1;
    for (let i = 0; i < holes.length; i++) {
      const n = newell(holes[i].pts);
      const area = Math.hypot(n[0], n[1], n[2]);
      if (area > best) { best = area; bestAt = i; }
    }
    if (bestAt >= 0) outer = holes.splice(bestAt, 1)[0];
  }
  return { curved: false, outer, holes };
}

function addFace(soup, entities, face, extraFlip) {
  if (!face) return 'skip';
  if (faceCurved(entities, face)) return 'curved';
  const surf = surfaceEntity(entities, face);
  const cylindrical = !!(surf && has(surf, 'CYLINDRICAL_SURFACE'));
  const rings = faceRings(entities, face, extraFlip);
  if (!rings) return 'skip';
  if (rings.curved) return 'curved';
  const { outer, holes } = rings;
  if (cylindrical) {
    const holePts = holes.filter((h) => h.pts.length >= 3);
    if (!outer || outer.pts.length < 3 || holePts.length) return 'curved';
    const place = part(surf, 'CYLINDRICAL_SURFACE').args.find((a) => a && a.ref);
    const frame = place && placementFrame(entities, place);
    const ix = frame && cylinderIndices(outer.pts, frame);
    if (!ix || !emitFace(soup, outer.pts, outer.ids, ix)) return 'curved';
    return 'ok';
  }
  if (!outer || outer.pts.length < 3) return 'skip';
  const holePts = holes.filter((h) => h.pts.length >= 3);
  const ix = polygonIndices(outer.pts, holePts.map((h) => h.pts));
  const all = outer.pts.concat(...holePts.map((h) => h.pts));
  const ids = outer.ids.concat(...holePts.map((h) => h.ids));
  emitFace(soup, all, ids, ix);
  return 'ok';
}

export function hasTessellation(entities) {
  for (const e of entities.values()) {
    if (e.parts.some((p) => TESS_TYPES.has(p.name))) return true;
  }
  return false;
}

/**
 * Analytic shells for solid recognition. Empty when the file is tessellated
 * (that geometry is already triangles) or has no boundary faces.
 * Each face is { kind:'plane'|'cylinder'|'other', normal, outer, holes, radius?, frame? }.
 * Normals and loops follow the face orientation used by the tessellator.
 * @param {Map<number, object>} entities
 */
function paint(ids, colours) {
  for (const id of ids) if (colours.has(id)) return colours.get(id);
  return null;
}

export function ownerIndex(entities) {
  const map = new Map();
  const add = (id, owner) => {
    let list = map.get(id);
    if (!list) map.set(id, list = []);
    list.push(owner);
  };
  for (const e of entities.values()) {
    for (const a of e.parts.flatMap((p) => p.args)) {
      if (a && a.ref) add(a.ref, e.id);
      else if (Array.isArray(a)) for (const x of a) if (x && x.ref) add(x.ref, e.id);
    }
  }
  return map;
}

export function inheritedColour(colours, owners, ids) {
  const direct = paint(ids, colours);
  if (direct) return direct;
  let frontier = ids;
  const seen = new Set(ids);
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next = [];
    for (const id of frontier) {
      const ups = owners.get(id);
      if (!ups) continue;
      for (const owner of ups) {
        if (seen.has(owner)) continue;
        seen.add(owner);
        if (colours.has(owner)) return colours.get(owner);
        next.push(owner);
      }
    }
    frontier = next;
  }
  return null;
}

export function shellEntries(entities, shell) {
  const out = [];
  const seen = new Set();
  for (const a of shell.parts.flatMap((p) => p.args)) {
    if (!Array.isArray(a)) continue;
    for (const item of a) {
      if (!item || !item.ref) continue;
      const unwrapped = asFace(entities, item);
      if (!unwrapped.face || !isFaceEntity(unwrapped.face) || seen.has(unwrapped.face.id)) continue;
      seen.add(unwrapped.face.id);
      out.push(unwrapped);
    }
  }
  return out;
}

function facesToRecord(entities, entries, colours, owners, smooth, name, extraIds) {
  const soup = new Soup();
  let curved = 0;
  const ids = [];
  for (const entry of entries) {
    ids.push(entry.face.id);
    const status = addFace(soup, entities, entry.face, entry.flip);
    if (status === 'curved') curved++;
  }
  const color = inheritedColour(colours, owners, ids.concat(extraIds));
  const mesh = soup.finish(smooth);
  if (!mesh) return { mesh: null, curved, color };
  return { mesh, curved, color, name };
}

function extractMeshes(entities, smooth) {
  const colours = colourMap(entities);
  const owners = ownerIndex(entities);
  const tess = collectTess(entities, colours, smooth);
  if (tess.length) return { meshes: tess, curved: 0 };
  return collectFaceted(entities, colours, owners, smooth);
}

function collectTess(entities, colours, smooth) {
  const grouped = new Set();
  const meshes = [];
  for (const e of entities.values()) {
    if (!has(e, 'TESSELLATED_SHELL')) continue;
    const items = [];
    for (const a of e.parts.flatMap((p) => p.args)) {
      if (!Array.isArray(a)) continue;
      for (const ref of a) {
        const child = ref && ref.ref ? entities.get(ref.ref) : null;
        if (!child || !child.parts.some((p) => TESS_TYPES.has(p.name))) continue;
        grouped.add(child.id);
        items.push(child);
      }
    }
    const soup = new Soup();
    for (const item of items) addTess(soup, entities, item);
    const mesh = soup.finish(smooth);
    if (mesh) meshes.push({ mesh, name: labelOf(e), color: colours.get(e.id) || items.map((it) => colours.get(it.id)).find(Boolean) || null });
  }
  for (const e of entities.values()) {
    if (grouped.has(e.id) || !e.parts.some((p) => TESS_TYPES.has(p.name))) continue;
    const soup = new Soup();
    addTess(soup, entities, e);
    const mesh = soup.finish(smooth);
    if (mesh) meshes.push({ mesh, name: labelOf(e), color: colours.get(e.id) || null });
  }
  return meshes;
}

function collectFaceted(entities, colours, owners, smooth) {
  const used = new Set();
  const meshes = [];
  let curved = 0;
  for (const e of entities.values()) {
    if (!e.parts.some((p) => SHELL_TYPES.has(p.name))) continue;
    const entries = shellEntries(entities, e);
    for (const entry of entries) {
      used.add(entry.id);
      used.add(entry.face.id);
    }
    const rec = facesToRecord(entities, entries, colours, owners, smooth, labelOf(e), [e.id]);
    curved += rec.curved;
    if (rec.mesh) meshes.push(rec);
  }
  const loose = [];
  for (const e of entities.values()) {
    if (!isFaceEntity(e) || used.has(e.id)) continue;
    loose.push({ face: e, flip: false, id: e.id });
  }
  if (loose.length) {
    const rec = facesToRecord(entities, loose, colours, owners, smooth, '', []);
    curved += rec.curved;
    if (rec.mesh) meshes.push(rec);
  }
  return { meshes, curved };
}

// --- writer ------------------------------------------------------------------

function stepString(s) {
  return `'${String(s).replace(/\\/g, '/').replace(/'/g, "''").replace(/[\r\n]+/g, ' ')}'`;
}

function stepReal(v) {
  if (!Number.isFinite(v) || Object.is(v, -0) || Math.abs(v) < 1e-15) return '0.';
  const a = Math.abs(v);
  let s = a >= 1e7 || a < 1e-4 ? v.toExponential(9).replace('e', 'E') : String(Math.round(v * 1e9) / 1e9);
  s = s.replace(/(\.\d*?)0+E/, '$1E').replace(/\.E/, 'E');
  if (!s.includes('.') && !s.includes('E')) s += '.';
  return s;
}

function wrapList(parts) {
  const lines = [];
  let line = '';
  for (let i = 0; i < parts.length; i++) {
    const piece = (line ? ',' : '') + parts[i];
    if (line && line.length + piece.length > 100) {
      lines.push(`${line},`);
      line = parts[i];
    } else line += piece;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function writeStep(name, points, tris) {
  const safe = String(name || 'es3d').replace(/[^\w.-]+/g, '_').slice(0, 64) || 'es3d';
  const when = new Date().toISOString().replace(/\.\d{3}Z$/, '');
  const pts = wrapList(points.map((p) => `(${stepReal(p[0])},${stepReal(p[1])},${stepReal(p[2])})`));
  const faces = [];
  for (let i = 0; i < tris.length; i += 3) faces.push(`(${tris[i] + 1},${tris[i + 1] + 1},${tris[i + 2] + 1})`);
  const triText = wrapList(faces);
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ES3D tessellated shape'),'2;1');
FILE_NAME(${stepString(`${safe}.step`)},${stepString(when)},('ES3D'),('ES3D'),'ES3D 0.1','ES3D','');
FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('managed model based 3d engineering');
#2=APPLICATION_PROTOCOL_DEFINITION('international standard','ap242_managed_model_based_3d_engineering',2014,#1);
#3=PRODUCT_CONTEXT('',#1,'mechanical');
#4=PRODUCT(${stepString(safe)},${stepString(safe)},'',(#3));
#5=PRODUCT_DEFINITION_FORMATION('','',#4);
#6=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#7=PRODUCT_DEFINITION('design','',#5,#6);
#8=PRODUCT_DEFINITION_SHAPE('','',#7);
#9=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#10=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#11=(NAMED_UNIT(*)SOLID_ANGLE_UNIT()SI_UNIT($,.STERADIAN.));
#12=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-7),#9,'distance_accuracy_value','confusion accuracy');
#13=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#12))GLOBAL_UNIT_ASSIGNED_CONTEXT((#9,#10,#11))REPRESENTATION_CONTEXT('','3D'));
#14=CARTESIAN_POINT_LIST_3D('',(
${pts}
));
#15=TRIANGULATED_SURFACE_SET('',#14,0,$,$,(
${triText}
));
#16=TESSELLATED_SHAPE_REPRESENTATION('',(#15),#13);
#17=SHAPE_DEFINITION_REPRESENTATION(#8,#16);
ENDSEC;
END-ISO-10303-21;
`;
}
