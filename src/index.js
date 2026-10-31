// Public API of the ES3D reference implementation.
//
//   import { compile, createRenderer, Camera, formatDiagnostics } from '@es3d/es3d';
//
//   const result = compile(text);              // parse + validate + build + flatten
//   if (!result.ok) console.error(formatDiagnostics(result));
//   const renderer = await createRenderer(canvas);   // WebGPU, else WebGL2
//   renderer.setScene(result.scene, (entry, lod) => result.cache.mesh(entry, lod));
//   const camera = new Camera().frame(result.scene.bounds);
//   renderer.render(camera, { width: canvas.clientWidth, height: canvas.clientHeight });
//
//   const svg = await importFiles([{ name: 'logo.svg', bytes }]);   // SVG, OBJ, STL, STEP, glTF → ES3D
//   const { files } = exportFormat(svg.text, 'glb');                 // ES3D → glTF, OBJ, STL, STEP
//
// The format, scene, geometry and I/O modules run in Node as well; only the
// renderer and controls need a browser.

// documents
export { parse, parseStrict, detectSyntax, formatDiagnostics } from './format/parse.js';
export { serialize, SERIALIZE_PRESETS } from './format/serializer.js';
export { Document, Element, Attr, Comment, walk, h } from './format/ast.js';
export { Diagnostic, ES3DError } from './format/errors.js';
export { ELEMENTS, elementSpec, attrSpec } from './format/schema.js';

// scene pipeline
export { compile, generateGeometry, GeometryCache } from './pipeline.js';
export { openGeometryStore, indexedDBStore, memoryStore, restoreGeometry, saveGeometry, persistGeometry, geometryKey, GEOMETRY_REVISION } from './cache/geometry-store.js';
export { RenderScene, updateDynamic, FLAG_MIRRORED, FLAG_NO_COLLIDE } from './scene/flatten.js';
export { pick, raycast } from './scene/picking.js';
export { applyLimits, sweepCamera, constrainCamera } from './scene/camera-constraints.js';

// rendering (browser)
export { createRenderer, Renderer } from './render/renderer.js';
export { Camera } from './render/camera.js';
export { OrbitControls } from './render/orbit-controls.js';
export { ScrollTimeline } from './render/scroll-timeline.js';
export { createStage, ancestorNames } from './render/stage.js';

// conversion and optimization
export { importFiles, exportFormat, detectKind, INPUT_KINDS, OUTPUT_FORMATS } from './io/convert.js';
export { svgToES3D } from './io/svg-import.js';
export { exportOBJ, parseOBJ, objToScene } from './io/obj.js';
export { exportGLB, parseGLB, glbToScene, isGLB, parseGLTF, gltfToScene } from './io/gltf.js';
export { exportSTL, parseSTL, stlToScene } from './io/stl.js';
export { exportSTEP, parseSTEP, stepToScene, isSTEP } from './io/step.js';
export { sceneToMeshDocument } from './io/mesh-import.js';
export { optimize, expandProcedural } from './optimize/optimizer.js';
