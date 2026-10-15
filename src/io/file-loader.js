// File loading for ES3D Studio: detects the content type from magic bytes and
// extension, transparently decompresses gzip, and converts foreign formats
// (SVG, OBJ, STL, STEP, glTF) into ES3D text with the same importers as the
// converter page, so they can be inspected and edited like any other document.

import { isGzip, gunzip } from './compression.js';
import { detectKind, importFiles, INPUT_KINDS } from './convert.js';

/**
 * @param {File|{name:string, arrayBuffer:()=>Promise<ArrayBuffer>}} file
 * @returns {Promise<{name:string, kind:string, text?:string, bytes:Uint8Array, originalSize:number, note?:string}>}
 */
export async function loadFile(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  const originalSize = bytes.length;
  let name = file.name || 'untitled.es3d';
  let note = '';
  if (isGzip(bytes)) {
    bytes = await gunzip(bytes);
    name = name.replace(/\.svgz$/i, '.svg').replace(/\.gz$/i, '');
    note = `decompressed from ${originalSize.toLocaleString('en-US')} gzip bytes`;
  }
  const kind = detectKind(name, bytes) || 'es3d';
  if (kind === 'es3d') return { name, kind, text: new TextDecoder('utf-8').decode(bytes), bytes, originalSize, note };
  const r = await importFiles([{ name, bytes }]);
  const warn = r.warnings.length ? ` (${r.warnings.join(' ')})` : '';
  return { name, kind, bytes, originalSize, text: r.text, note: (note ? note + '; ' : '') + `converted from ${INPUT_KINDS[kind]} to ES3D${warn}` };
}
