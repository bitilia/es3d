// The page is docs/modeller/index.html. This file stays in docs/site/ so its
// import of src/modeller/app.js resolves from the repository.
import { Modeller } from '../../src/modeller/app.js';

const app = new Modeller();
window.modeller = app;
app.init().then(
  () => {
    window.__modellerReady = true;
  },
  (err) => {
    console.error(err);
    window.__modellerError = String(err && err.stack ? err.stack : err);
  },
);
