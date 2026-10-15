// File conversion to and from ES3D, shared by the website's converter and
// the command-line tool. Works in browsers and in Node.
//
//   const r = await importFiles([{ name: 'logo.svg', bytes }]);   // → ES3D markup in r.text
//   const out = exportFormat(r.text, 'glb', { baseName: 'logo' });  // → { files: [{ name, data, mime }] }

import { isGzip, gunzip } from './compression.js';
import { parse } from '../format/parse.js';
import { serialize } from '../format/serializer.js';
import { isGLB, glbToScene, gltfToScene, exportGLB } from './gltf.js';
import { objToScene, exportOBJ } from './obj.js';
import { isBinarySTL, isAsciiSTL, stlToScene, exportSTL } from './stl.js';
import { isSTEP, stepToScene, exportSTEP } from './step.js';
import { stepToExact } from './step-exact.js';
import { svgToES3D } from './svg-import.js';
import { sceneToMeshDocument } from './mesh-import.js';
import { compile } from '../pipeline.js';
import { exportableInstances } from './external-scene.js';

/** OBJ and STL repeat every copy's triangles; beyond this the file gets too large for a browser tab. */
const OBJ_TRIANGLE_LIMIT = 4e6;

export const INPUT_KINDS = {
  es3d: 'ES3D text',
  svg: 'SVG drawing',
  obj: 'Wavefront OBJ',
  stl: 'STL',
  gltf: 'glTF (JSON)',
  glb: 'glTF binary (GLB)',
  step: 'STEP',
};

export const OUTPUT_FORMATS = {
  es3d: { label: 'ES3D markup (.es3d)', ext: '.es3d', mime: 'model/vnd.es3d', text: true },
  'es3d-min': { label: 'ES3D markup, minified (.es3d)', ext: '.es3d', mime: 'model/vnd.es3d', text: true },
  'es3d-compact': { label: 'ES3D compact syntax (.es3d)', ext: '.es3d', mime: 'model/vnd.es3d', text: true },
  glb: { label: 'glTF binary (.glb)', ext: '.glb', mime: 'model/gltf-binary' },
  obj: { label: 'Wavefront OBJ + MTL (.obj)', ext: '.obj', mime: 'model/obj', text: true },
  stl: { label: 'STL for 3D printing (.stl)', ext: '.stl', mime: 'model/stl' },
  step: { label: 'STEP, tessellated (.step)', ext: '.step', mime: 'model/step', text: true },
};

/** Files that only accompany a main file (OBJ materials, glTF buffers and textures). */
const COMPANION = /\.(mtl|bin|png|jpe?g|webp|gif|ktx2|dds|tga|bmp)$/i;

const decode = (bytes) => new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');

/**
 * The kind of a file, from its content first and its extension second.
 * @returns {keyof INPUT_KINDS | null}
 */
export function detectKind(name, bytes) {
  if (isGLB(bytes)) return 'glb';
  const ext = ((/\.([a-z0-9]+)$/i.exec(name) || [])[1] || '').toLowerCase();
  const head = decode(bytes.subarray(0, 4096));
  if (isSTEP(head)) return 'step';
  if (isBinarySTL(bytes) && !['es3d', 'svg', 'obj', 'gltf'].includes(ext)) return 'stl';
  const es3dText = /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<es3d[\s>/]/.test(head) || /^\s*((\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*es3d\b/.test(head);
  if (ext === 'es3d' || es3dText) return 'es3d';
  if (ext === 'svg' || /<svg[\s>/]/.test(head)) return 'svg';
  if (ext === 'stl' || isAsciiSTL(bytes)) return 'stl';
  if (ext === 'gltf' || /^\s*\{[\s\S]*"asset"\s*:/.test(head)) return 'gltf';
  if (ext === 'obj' || /^\s*(#[^\n]*\n\s*)*(mtllib|o|g|v|vt|vn|f|usemtl|s)\s/.test(head)) return 'obj';
  if (ext === 'step' || ext === 'stp' || ext === 'p21') return 'step';
  return null;
}

/** Options of the importers, with their defaults. */
export const IMPORT_DEFAULTS = {
  svg: { size: 10, depth: 0.04, bevel: 0, strokes: true, base: false },
  mesh: { precision: 'auto', normals: 'auto', uvs: true, smooth: 30 },
  stl: { up: 'z' },
};

/**
 * Convert input files into an ES3D document.
 * @param {{name: string, bytes: Uint8Array}[]} files the main file plus companions (.mtl, .bin)
 * @param {{svg?: object, mesh?: object, stl?: object}} [opts] see IMPORT_DEFAULTS
 * @returns {Promise<{kind: string, name: string, title: string, text: string, warnings: string[], notes: string[]}>}
 */
export async function importFiles(files, opts = {}) {
  if (!files.length) throw new Error('No file was given.');
  const list = [];
  for (const f of files) {
    let bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
    let name = f.name || 'untitled';
    if (isGzip(bytes)) {
      bytes = await gunzip(bytes);
      name = name.replace(/\.svgz$/i, '.svg').replace(/\.gz$/i, '');
    }
    list.push({ name, bytes });
  }
  const main = list.find((f) => !COMPANION.test(f.name)) || list[0];
  const companions = list.filter((f) => f !== main);
  const kind = detectKind(main.name, main.bytes);
  if (!kind) throw new Error(`${main.name}: unknown file type. The converter reads SVG, OBJ, STL, STEP (.step, .stp) and glTF (.gltf, .glb) and ES3D (.es3d) files.`);
  const title = main.name.replace(/\.[^.]+$/, '') || 'untitled';
  const svgOpts = { ...IMPORT_DEFAULTS.svg, ...(opts.svg || {}) };
  const meshOpts = { ...IMPORT_DEFAULTS.mesh, ...(opts.mesh || {}) };
  const stlOpts = { ...IMPORT_DEFAULTS.stl, ...(opts.stl || {}) };
  const warnings = [];
  const notes = [];
  const meshDocument = (s, sourceHasNormals) => {
    const normals = meshOpts.normals === 'auto' ? sourceHasNormals : !!meshOpts.normals;
    const digits = meshOpts.precision === 'exact' ? null : meshOpts.precision;
    if (!normals) notes.push(`Normals are not stored; viewers compute them with a ${meshOpts.smooth}° crease angle.`);
    return sceneToMeshDocument(s.scene, s.meshOf, title, { digits, normals, uvs: meshOpts.uvs ? 'auto' : false, smooth: meshOpts.smooth });
  };
  let text;
  switch (kind) {
    case 'es3d':
      text = decode(main.bytes);
      break;
    case 'svg': {
      const r = svgToES3D(decode(main.bytes), { name: main.name, ...svgOpts });
      text = r.text;
      warnings.push(...r.warnings);
      notes.push(`${r.stats.fills} filled shape${r.stats.fills === 1 ? '' : 's'} extruded, ${r.stats.strokes} stroke${r.stats.strokes === 1 ? '' : 's'} turned into tubes, ${r.stats.materials} material${r.stats.materials === 1 ? '' : 's'}.`);
      break;
    }
    case 'obj': {
      const objText = decode(main.bytes);
      const lib = (/^mtllib\s+(.+?)\s*$/m.exec(objText) || [])[1];
      const mtlFile = companions.find((f) => /\.mtl$/i.test(f.name) && (!lib || f.name.toLowerCase() === lib.split(/[\\/]/).pop().toLowerCase())) || companions.find((f) => /\.mtl$/i.test(f.name));
      if (lib && !mtlFile) warnings.push(`The material library ${lib} was not given; default colors are used. Select the .obj and .mtl files together to keep the materials.`);
      if (companions.some((f) => /\.(png|jpe?g|webp|gif|tga|bmp)$/i.test(f.name)) || /^\s*map_/m.test(mtlFile ? decode(mtlFile.bytes) : '')) warnings.push('Textures are not converted; the materials keep their base colors.');
      const s = objToScene(objText, mtlFile ? decode(mtlFile.bytes) : '');
      const hasNormals = /^vn\s/m.test(objText);
      text = meshDocument(s, hasNormals);
      break;
    }
    case 'stl': {
      const s = stlToScene(main.bytes, { up: stlOpts.up, smooth: meshOpts.smooth });
      if (s.info.degenerate) warnings.push(`${s.info.degenerate} degenerate triangle${s.info.degenerate === 1 ? '' : 's'} (with two identical corners) ${s.info.degenerate === 1 ? 'was' : 'were'} dropped.`);
      notes.push(`${s.info.format === 'binary' ? 'Binary' : 'ASCII'} STL with ${s.info.triangles.toLocaleString('en-US')} triangles, welded to ${s.info.vertices.toLocaleString('en-US')} vertices${stlOpts.up === 'z' ? '; turned from Z-up to Y-up' : ''}.`);
      text = meshDocument(s, false);
      break;
    }
    case 'step': {
      // a B-rep (what CAD tools export) becomes ES3D shapes; tessellated STEP stays a mesh
      const exact = stepToExact(main.bytes, { up: stlOpts.up, name: title });
      if (exact) {
        notes.push(exact.note);
        text = exact.text;
        break;
      }
      const s = stepToScene(main.bytes, { up: stlOpts.up, smooth: meshOpts.smooth });
      if (s.info.curved) warnings.push(`${s.info.curved} curved face${s.info.curved === 1 ? '' : 's'} skipped. ES3D tessellates planar faces, circles and cylinders; re-export other curved solids as tessellated STEP or STL to keep them.`);
      const unit = s.info.unit ? ` Coordinates are in ${s.info.unit} and were not rescaled.` : ' The file does not name a length unit; coordinates were used as written.';
      notes.push(`STEP with ${s.info.triangles.toLocaleString('en-US')} triangles in ${s.info.meshes} mesh${s.info.meshes === 1 ? '' : 'es'}${stlOpts.up === 'z' ? '; turned from Z-up to Y-up' : ''}.${unit}`);
      text = meshDocument(s, false);
      break;
    }
    case 'gltf':
    case 'glb': {
      const resources = Object.fromEntries(companions.map((f) => [f.name, f.bytes]));
      const s = kind === 'glb' ? glbToScene(main.bytes) : gltfToScene(decode(main.bytes), resources);
      if (s.skipped.textures) warnings.push(`Textures are not converted (${s.skipped.textures} textured material${s.skipped.textures === 1 ? '' : 's'}); the materials keep their base colors.`);
      if (s.skipped.points) warnings.push(`${s.skipped.points} point cloud primitive${s.skipped.points === 1 ? ' was' : 's were'} skipped.`);
      const lines = s.scene.geometries.filter((g) => g.kind === 'lines').length;
      if (lines) warnings.push(`${lines} line primitive${lines === 1 ? ' was' : 's were'} skipped (ES3D meshes hold triangles).`);
      if ((s.json.skins || []).length || (s.json.animations || []).length) warnings.push('Skins and animations are not converted; the model is shown in its rest pose.');
      if (s.json.extensionsRequired && s.json.extensionsRequired.length) warnings.push(`The file requires extensions that are not supported: ${s.json.extensionsRequired.join(', ')}.`);
      const hasNormals = (s.json.meshes || []).some((m) => m.primitives.some((p) => p.attributes && p.attributes.NORMAL !== undefined));
      text = meshDocument(s, hasNormals);
      break;
    }
  }
  return { kind, name: main.name, title, text, warnings, notes };
}

/** Parse and validate ES3D text; throws with the first diagnostics on errors. */
function validDocument(source) {
  const doc = parse(source);
  if (!doc.ok) throw new Error(describeErrors(doc.diagnostics, doc.lineIndex));
  return doc;
}

function describeErrors(diagnostics, lineIndex) {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const shown = errors.slice(0, 3).map((d) => d.format(lineIndex)).join('\n\n');
  return `The ES3D document has ${errors.length} error${errors.length === 1 ? '' : 's'}:\n\n${shown}${errors.length > 3 ? `\n\n… and ${errors.length - 3} more` : ''}`;
}

/**
 * Write an ES3D document in another format.
 * @param {string|Uint8Array} source ES3D text
 * @param {keyof OUTPUT_FORMATS} format
 * @param {{baseName?: string, lod?: number, compiled?: object, instancing?: boolean}} [opts]
 *        compiled: an existing compile() result for the same source (saves compiling twice)
 * @returns {{files: {name: string, data: Uint8Array|string, mime: string}[], triangles?: number}}
 */
export function exportFormat(source, format, { baseName = 'scene', lod = 0, compiled = null, instancing = true } = {}) {
  const spec = OUTPUT_FORMATS[format];
  if (!spec) throw new Error(`Unknown output format ${format}.`);
  const name = baseName + spec.ext;
  const one = (data) => ({ files: [{ name, data, mime: spec.mime }] });
  switch (format) {
    case 'es3d':
      return one(serialize(validDocument(source), { syntax: 'xml', pretty: true, comments: true }));
    case 'es3d-min':
      return one(serialize(validDocument(source), { syntax: 'xml', pretty: false }));
    case 'es3d-compact':
      return one(serialize(validDocument(source), { syntax: 'compact', pretty: true, comments: true }));
    default: {
      const r = compiled || compile(source);
      if (!r.ok) throw new Error(describeErrors(r.diagnostics, r.doc && r.doc.lineIndex));
      const meshOf = (e, l) => r.cache.mesh(e, Math.min(l, e.lods - 1));
      if (format === 'glb') return one(exportGLB(r.scene, meshOf, { lod, instancing }));
      if (format === 'obj') {
        let triangles = 0;
        for (const i of exportableInstances(r.scene)) {
          const m = meshOf(r.scene.geometries[r.scene.geom[i]], lod);
          if (m.kind === 'triangles') triangles += m.primitiveCount;
        }
        if (triangles > OBJ_TRIANGLE_LIMIT) throw new Error(`At this level of detail the scene has ${triangles.toLocaleString('en-US')} triangles, too many for an OBJ file (limit ${OBJ_TRIANGLE_LIMIT.toLocaleString('en-US')}). Choose a coarser detail, or glTF, which stores repeated shapes once.`);
      }
      if (format === 'stl') {
        const s = exportSTL(r.scene, meshOf, { lod, name: baseName, maxTriangles: OBJ_TRIANGLE_LIMIT });
        return { ...one(s.data), triangles: s.triangles };
      }
      if (format === 'step') {
        const s = exportSTEP(r.scene, meshOf, { lod, name: baseName, maxTriangles: OBJ_TRIANGLE_LIMIT });
        return { ...one(s.data), triangles: s.triangles };
      }
      const o = exportOBJ(r.scene, meshOf, { lod, name: baseName });
      return {
        files: [
          { name, data: o.obj, mime: spec.mime },
          { name: `${baseName}.mtl`, data: o.mtl, mime: 'text/plain' },
        ],
        triangles: o.triangles,
      };
    }
  }
}
