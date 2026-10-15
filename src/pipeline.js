// The ES3D processing pipeline used by the application, the benchmark, the CLI
// and the tests:
//
//   text/binary --parse--> AST --validate--> typed AST --build--> scene graph
//               --flatten--> RenderScene (instance table) --lazy--> meshes
//
// Each stage is timed so the benchmark and the statistics panel can report
// where time is spent.

import { parse } from './format/parse.js';
import { Diagnostic } from './format/errors.js';
import { buildSceneGraph } from './scene/scene-graph.js';
import { flattenScene } from './scene/flatten.js';
import { GeometryCache } from './geometry/geometry-cache.js';

export const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Convert an element-attached diagnostic into a located Diagnostic. */
export function elementDiagnostic(doc, d) {
  const el = d.element;
  const diag = new Diagnostic({
    severity: d.severity,
    phase: d.phase || 'geometry',
    code: d.code,
    message: el ? `<${el.name}${el.values && el.values.id ? ` id="${el.values.id}"` : ''}>: ${d.message}` : d.message,
    offset: el && el.nameStart >= 0 ? el.nameStart : -1,
    length: el && el.nameStart >= 0 ? el.nameEnd - el.nameStart : 0,
    uid: el ? el.uid : 0,
  });
  diag.locate(doc && doc.lineIndex);
  return diag;
}

/**
 * Parse, validate, build and flatten a document.
 * @param {string|ArrayBuffer|Uint8Array} input
 * @param {{cache?: GeometryCache, time?: number, progress?: number, maxInstances?: number}} [opts]
 */
export function compile(input, opts = {}) {
  const t0 = now();
  const doc = parse(input);
  const t1 = now();
  const timings = { parse: t1 - t0, build: 0, flatten: 0 };
  if (!doc.ok) {
    return { ok: false, doc, graph: null, scene: null, cache: opts.cache || null, diagnostics: doc.diagnostics, timings };
  }
  const cache = opts.cache || new GeometryCache();
  const graph = buildSceneGraph(doc, cache, opts);
  const t2 = now();
  const scene = flattenScene(graph, { time: opts.time || 0, progress: opts.progress || 0 });
  const t3 = now();
  timings.build = t2 - t1;
  timings.flatten = t3 - t2;
  const extra = graph.diagnostics.map((d) => elementDiagnostic(doc, d));
  const diagnostics = [...doc.diagnostics, ...extra];
  const ok = !diagnostics.some((d) => d.severity === 'error');
  return { ok, doc, graph, scene, cache, diagnostics, timings };
}

/** Generate every mesh needed for LOD 0 of a compiled scene (benchmarks, exports). */
export function generateGeometry(result, lod = 0) {
  const t0 = now();
  const { scene, cache } = result;
  let triangles = 0;
  let vertices = 0;
  for (const entry of scene.geometries) {
    const m = cache.mesh(entry, lod);
    vertices += m.vertexCount;
    triangles += m.kind === 'triangles' ? m.primitiveCount : 0;
  }
  return { ms: now() - t0, uniqueVertices: vertices, uniqueTriangles: triangles };
}

export { GeometryCache };
