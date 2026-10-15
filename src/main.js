// Entry point of ES3D Studio (docs/studio/).
import { App } from './ui/app.js';

const app = new App();
window.es3d = app;
app.init().then(
  () => {
    window.__es3dReady = true;
  },
  (err) => {
    console.error(err);
    window.__es3dError = String(err && err.stack ? err.stack : err);
    const el = document.getElementById('toasts');
    if (el) el.textContent = `Startup failed: ${err.message}`;
  },
);
