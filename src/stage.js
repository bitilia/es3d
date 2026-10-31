// The page entry. The published file is one minified build of this module
// (browser/es3d-stage.min.js, `npm run build:stage`), so a page loads the
// stage in a single request. createStage, ancestorNames and the placement
// functions a script shares with the reader are the exports.

export { createStage, ancestorNames } from './render/stage.js';
export { mulberry32 } from './math/random.js';
export { es3dSin, es3dCos } from './math/trig.js';
