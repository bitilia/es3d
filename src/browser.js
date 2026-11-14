// The browser entry: the whole browser-safe API in one file
// (browser/es3d.min.js, `npm run build:browser`, published as
// @es3d/es3d/browser), so a page loads ES3D in a single request: parse,
// validate and compile documents, draw them (createRenderer, createStage),
// and convert files on the visitor's own computer.
//
//   import { importFiles, exportFormat } from '@es3d/es3d/browser';
//
//   const doc = await importFiles(input.files);            // SVG, OBJ (+.mtl), STL, STEP, glTF, X3D, USDA, OpenSCAD
//   const { files } = exportFormat(doc.text, 'glb');       // nothing is uploaded
//
// It is the package entry (src/index.js) as it is: everything there runs in a
// browser. Node-only code (the glTF packer behind scripts/, zlib in
// io/compression.js) is not part of it; the build checks that.

export * from './index.js';
