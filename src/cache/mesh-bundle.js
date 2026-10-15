// Mesh bundle: the binary record the persistent geometry cache stores, one
// per document. ES3D's own layout, little-endian:
//
//   0   "ES3G"                         magic
//   4   u32 layout version (1)
//   8   u32 byte length of the description
//   12  description, UTF-8 JSON, padded with spaces to a multiple of 4 bytes
//   ..  data: per stored level, at the offset its description gives from the
//       start of the data (a multiple of 4): positions f32[3v], normals
//       f32[3v], uvs f32[2v], then indices, u16[i] when every index fits in
//       16 bits (`w` 2) else u32[i] (`w` 4)
//
// The description:
//   { key, entries: [[{ lod, kind, v, i, w, at, reports }, ...], ...] }
// with one list of levels per cached shape, in the order of the shapes'
// identities (the record's key covers that order). `reports` lists the
// diagnostics generation reported, as [severity, code, message].
//
// Decoding returns views into the stored buffer (only 16-bit indices are
// widened, by a native copy) and checks the structure it relies on: magic,
// layout, lengths, offsets and primitive counts. It does not check that every
// index names a vertex: only code of the same origin can write the store, and
// an index out of range cannot reach memory outside the arrays, in
// JavaScript or on the GPU.

import { Mesh } from '../geometry/mesh.js';

const MAGIC = 0x47335345; // "ES3G" read as a little-endian u32
export const BUNDLE_VERSION = 1;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const align4 = (n) => (n + 3) & ~3;

/**
 * @param {string} key
 * @param {{lod: number, mesh: Mesh, reports?: object[]|null}[][]} entries levels per shape
 * @returns {ArrayBuffer}
 */
export function encodeBundle(key, entries) {
  // lay the arrays out first, then the description that points at them
  const plan = [];
  let dataBytes = 0;
  const description = { key, entries: [] };
  for (const list of entries) {
    const levels = [];
    for (const { lod, mesh, reports } of list) {
      const v = mesh.positions.length / 3, i = mesh.indices.length;
      const w = v <= 0x10000 ? 2 : 4;
      levels.push({ lod, kind: mesh.kind, v, i, w, at: dataBytes, reports: reports ? reports.map((r) => [r.severity, r.code, r.message]) : [] });
      plan.push({ mesh, at: dataBytes, w });
      dataBytes += v * 32 + align4(i * w);
    }
    description.entries.push(levels);
  }
  const meta = encoder.encode(JSON.stringify(description));
  const head = 12 + align4(meta.length);
  const buffer = new ArrayBuffer(head + dataBytes);
  const u8 = new Uint8Array(buffer);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, BUNDLE_VERSION, true);
  view.setUint32(8, head - 12, true);
  u8.set(meta, 12);
  u8.fill(0x20, 12 + meta.length, head);
  for (const { mesh, at, w } of plan) {
    const v = mesh.positions.length / 3;
    const base = head + at;
    new Float32Array(buffer, base, v * 3).set(mesh.positions);
    new Float32Array(buffer, base + v * 12, v * 3).set(mesh.normals);
    new Float32Array(buffer, base + v * 24, v * 2).set(mesh.uvs);
    new (w === 2 ? Uint16Array : Uint32Array)(buffer, base + v * 32, mesh.indices.length).set(mesh.indices);
  }
  return buffer;
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * @param {ArrayBuffer} buffer
 * @returns {{key: string, entries: {lod: number, mesh: Mesh, reports: object[]}[][]}|null}
 *   null when the buffer is not a valid bundle of this layout
 */
export function decodeBundle(buffer) {
  if (!littleEndian || !(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== BUNDLE_VERSION) return null;
  const metaBytes = view.getUint32(8, true);
  if (metaBytes % 4 || 12 + metaBytes > buffer.byteLength) return null;
  let description;
  try {
    description = JSON.parse(decoder.decode(new Uint8Array(buffer, 12, metaBytes)));
  } catch {
    return null;
  }
  if (!description || typeof description.key !== 'string' || !Array.isArray(description.entries)) return null;
  const data = 12 + metaBytes;
  const entries = [];
  for (const list of description.entries) {
    if (!Array.isArray(list)) return null;
    const levels = [];
    for (const l of list) {
      if (!l || !isCount(l.lod) || !isCount(l.v) || !isCount(l.i) || !isCount(l.at) || l.at % 4) return null;
      if ((l.kind !== 'triangles' && l.kind !== 'lines') || (l.w !== 2 && l.w !== 4) || (l.w === 2 && l.v > 0x10000)) return null;
      if (l.i % (l.kind === 'lines' ? 2 : 3)) return null;
      const at = data + l.at;
      if (at + l.v * 32 + l.i * l.w > buffer.byteLength) return null;
      const indices = l.w === 2 ? new Uint32Array(new Uint16Array(buffer, at + l.v * 32, l.i)) : new Uint32Array(buffer, at + l.v * 32, l.i);
      const mesh = new Mesh({
        positions: new Float32Array(buffer, at, l.v * 3),
        normals: new Float32Array(buffer, at + l.v * 12, l.v * 3),
        uvs: new Float32Array(buffer, at + l.v * 24, l.v * 2),
        indices,
        kind: l.kind,
      });
      const reports = Array.isArray(l.reports) ? l.reports.filter((r) => Array.isArray(r) && r.length === 3).map(([severity, code, message]) => ({ severity: String(severity), code: String(code), message: String(message) })) : [];
      levels.push({ lod: l.lod, mesh, reports });
    }
    entries.push(levels);
  }
  return { key: description.key, entries };
}
