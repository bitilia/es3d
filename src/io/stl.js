// STL (stereolithography) import and export, binary and ASCII.
//
// STL stores unconnected triangles with one face normal each: no units, no
// colors, no shared vertices. Files from CAD and 3D-printing tools are Z-up
// and usually in millimetres. The importer welds identical corners and
// computes vertex normals with a crease angle, so flat faces stay flat and
// curved surfaces look round; the exporter writes world-space triangles of
// every instance, Z-up by default, as slicers expect.

import { computeNormals, weldMap } from '../geometry/mesh.js';
import { buildExternalScene, exportableInstances, InstanceTable } from './external-scene.js';

/** A binary STL is exactly 84 + 50 · n bytes long; that test is stronger than the header text. */
export function isBinarySTL(bytes) {
  if (bytes.length < 84) return false;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return 84 + n * 50 === bytes.length;
}

/** ASCII STL: "solid <name>" followed by the first facet (or an empty solid). */
export function isAsciiSTL(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  return /^\s*solid\b[^\n]*\n\s*(facet|endsolid)\b/.test(head);
}

/**
 * Parse an STL file.
 * @param {Uint8Array} bytes
 * @returns {{positions: Float32Array, triangles: number, name: string, format: 'binary'|'ascii'}}
 *          positions: 9 floats per triangle, in file order
 */
export function parseSTL(bytes) {
  if (isBinarySTL(bytes)) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    const positions = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12; // skip the face normal
      for (let k = 0; k < 9; k++) positions[t * 9 + k] = dv.getFloat32(o + k * 4, true);
    }
    const header = new TextDecoder().decode(bytes.subarray(0, 80)).replace(/\0[\s\S]*$/, '').trim();
    return { positions, triangles: n, name: header.replace(/^solid\s*/i, ''), format: 'binary' };
  }
  const text = new TextDecoder().decode(bytes);
  if (!/^\s*solid\b/.test(text)) throw new Error('Not an STL file: binary STL size does not match its triangle count, and ASCII STL must start with "solid".');
  const out = [];
  const re = /\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    const x = Number(m[1]), y = Number(m[2]), z = Number(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      const line = text.slice(0, m.index).split('\n').length;
      throw new Error(`STL line ${line}: vertex coordinates must be numbers ("${m[0]}").`);
    }
    out.push(x, y, z);
  }
  if (out.length % 9 !== 0) throw new Error(`STL: found ${out.length / 3} vertices, which is not a multiple of 3 (every facet needs exactly 3).`);
  const name = (/^\s*solid[ \t]*([^\r\n]*)/.exec(text) || [])[1] || '';
  return { positions: Float32Array.from(out), triangles: out.length / 9, name: name.trim(), format: 'ascii' };
}

/** Weld identical corners of a triangle soup: unique positions plus an index list. */
export function weldTriangles(soup) {
  const map = weldMap(soup);
  const n = soup.length / 3;
  const remap = new Int32Array(n).fill(-1);
  const indices = new Uint32Array(n);
  let unique = 0;
  for (let i = 0; i < n; i++) {
    const r = map[i];
    if (remap[r] < 0) remap[r] = unique++;
    indices[i] = remap[r];
  }
  const positions = new Float32Array(unique * 3);
  for (let i = 0; i < n; i++) {
    const v = indices[i] * 3;
    positions[v] = soup[i * 3];
    positions[v + 1] = soup[i * 3 + 1];
    positions[v + 2] = soup[i * 3 + 2];
  }
  // drop triangles that collapsed to a line or a point
  let w = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (a === b || b === c || a === c) continue;
    indices[w++] = a;
    indices[w++] = b;
    indices[w++] = c;
  }
  return { positions, indices: indices.slice(0, w), degenerate: (indices.length - w) / 3 };
}

/** Z-up (STL) to Y-up (ES3D): a -90° rotation about X, column-major. */
export const Z_UP_TO_Y_UP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

/**
 * Convert an STL file into a RenderScene (one mesh, one instance).
 * @param {Uint8Array} bytes
 * @param {{up?: 'z'|'y', smooth?: number}} [opts] up: the file's up axis; smooth: crease angle in degrees
 */
export function stlToScene(bytes, { up = 'z', smooth = 30 } = {}) {
  const parsed = parseSTL(bytes);
  if (!parsed.triangles) throw new Error('The STL file contains no triangles.');
  const { positions, indices, degenerate } = weldTriangles(parsed.positions);
  const mesh = computeNormals(positions, indices, smooth);
  const instances = new InstanceTable(1);
  instances.push(0, 0, up === 'z' ? Z_UP_TO_Y_UP : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const materials = [{ name: 'stl', color: [0.72, 0.74, 0.78, 1], roughness: 0.45, metallic: 0 }];
  const built = buildExternalScene({ geometries: [{ mesh }], materials, instances });
  return { ...built, info: { name: parsed.name, format: parsed.format, triangles: parsed.triangles, vertices: positions.length / 3, degenerate, smooth } };
}

/**
 * Export the static scene as STL: every instance's triangles in world space.
 * @param {import('../scene/flatten.js').RenderScene} scene
 * @param {(entry: object, lod: number) => import('../geometry/mesh.js').Mesh} meshOf
 * @param {{lod?: number, up?: 'z'|'y', binary?: boolean, name?: string, maxTriangles?: number}} [opts]
 * @returns {{data: Uint8Array|string, triangles: number}}
 */
export function exportSTL(scene, meshOf, { lod = 0, up = 'z', binary = true, name = 'es3d', maxTriangles = 2e7 } = {}) {
  const list = exportableInstances(scene);
  let total = 0;
  for (const i of list) {
    const m = meshOf(scene.geometries[scene.geom[i]], lod);
    if (m.kind === 'triangles') total += m.primitiveCount;
  }
  if (total > maxTriangles) throw new Error(`The scene has ${total.toLocaleString('en-US')} triangles; STL output is limited to ${maxTriangles.toLocaleString('en-US')}. Export a coarser level of detail.`);
  const tri = new Float64Array(9);
  const M = new Float64Array(16);
  const zUp = up === 'z';
  let dv = null, o = 84;
  const lines = [];
  if (binary) {
    const out = new Uint8Array(84 + total * 50);
    const head = new TextEncoder().encode(`ES3D export: ${name}`.slice(0, 79));
    out.set(head);
    dv = new DataView(out.buffer);
    dv.setUint32(80, total, true);
  } else lines.push(`solid ${name}`);
  const f = (v) => {
    if (Math.abs(v) < 1e-30) return '0';
    const s = Math.fround(v).toPrecision(7);
    return s.includes('.') ? s.replace(/0+(?=e|$)/, '').replace(/\.(?=e|$)/, '') : s;
  };
  for (const i of list) {
    const mesh = meshOf(scene.geometries[scene.geom[i]], lod);
    if (mesh.kind !== 'triangles') continue;
    for (let k = 0; k < 16; k++) M[k] = scene.matrices[i * 16 + k];
    const det = M[0] * (M[5] * M[10] - M[6] * M[9]) - M[4] * (M[1] * M[10] - M[2] * M[9]) + M[8] * (M[1] * M[6] - M[2] * M[5]);
    const flip = det < 0;
    const p = mesh.positions, idx = mesh.indices;
    for (let t = 0; t < idx.length; t += 3) {
      for (let c = 0; c < 3; c++) {
        const v = idx[t + (flip && c ? 3 - c : c)] * 3;
        const x = p[v], y = p[v + 1], z = p[v + 2];
        const wx = M[0] * x + M[4] * y + M[8] * z + M[12];
        const wy = M[1] * x + M[5] * y + M[9] * z + M[13];
        const wz = M[2] * x + M[6] * y + M[10] * z + M[14];
        // Y-up to Z-up: (x, y, z) -> (x, -z, y)
        tri[c * 3] = wx;
        tri[c * 3 + 1] = zUp ? -wz : wy;
        tri[c * 3 + 2] = zUp ? wy : wz;
      }
      const e1x = tri[3] - tri[0], e1y = tri[4] - tri[1], e1z = tri[5] - tri[2];
      const e2x = tri[6] - tri[0], e2y = tri[7] - tri[1], e2z = tri[8] - tri[2];
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      if (binary) {
        dv.setFloat32(o, nx, true);
        dv.setFloat32(o + 4, ny, true);
        dv.setFloat32(o + 8, nz, true);
        for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, tri[k], true);
        o += 50;
      } else {
        lines.push(
          ` facet normal ${f(nx)} ${f(ny)} ${f(nz)}`,
          '  outer loop',
          `   vertex ${f(tri[0])} ${f(tri[1])} ${f(tri[2])}`,
          `   vertex ${f(tri[3])} ${f(tri[4])} ${f(tri[5])}`,
          `   vertex ${f(tri[6])} ${f(tri[7])} ${f(tri[8])}`,
          '  endloop',
          ' endfacet',
        );
      }
    }
  }
  if (binary) return { data: new Uint8Array(dv.buffer), triangles: total };
  lines.push(`endsolid ${name}`);
  return { data: lines.join('\n') + '\n', triangles: total };
}
