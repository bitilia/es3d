// The demo sites' stage: the library's createStage, plus the status and
// error slots the demo pages put next to the canvas.

import { createStage as createLibraryStage, ancestorNames } from '../../src/render/stage.js';

export { ancestorNames };

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} [opts] see createStage in src/render/stage.js
 */
export async function createStage(canvas, opts = {}) {
  const parent = canvas.parentElement;
  const status = parent && parent.querySelector('.stage-status');
  const slot = parent && parent.querySelector('.stage-error');
  let stage;
  try {
    stage = await createLibraryStage(canvas, {
      ...opts,
      onError(message) {
        console.error(message);
        if (slot) {
          slot.hidden = false;
          slot.textContent = message;
        }
      },
    });
  } catch (err) {
    if (status) status.textContent = err.message || String(err);
    throw err;
  }
  const show = stage.show.bind(stage);
  stage.show = (source, showOpts) => {
    const result = show(source, showOpts);
    if (result.ok) {
      if (slot) slot.hidden = true;
      if (status) status.hidden = true;
    }
    return result;
  };
  return stage;
}
