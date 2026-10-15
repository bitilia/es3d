// Backend-independent texture bookkeeping: each distinct texture spec (by key
// and usage) is generated or downloaded once; backends turn ready pixel data
// into GPU textures. Failures are reported, never silently ignored.

import { texturePixels } from './textures.js';

export class TextureCache {
  constructor() {
    this.entries = new Map(); // `${kind}:${key}` -> {status, pixels, error, gpu, spec, kind}
    this.onReady = null; // called when an async texture finishes (request a redraw)
    this.onError = null;
  }

  /** Get (and start loading) a texture; returns the entry (status 'pending'|'ready'|'failed'). */
  get(spec, kind) {
    const id = `${kind}:${spec.key}`;
    let e = this.entries.get(id);
    if (e) return e;
    e = { id, spec, kind, status: 'pending', pixels: null, error: null, gpu: null };
    this.entries.set(id, e);
    texturePixels(spec, kind).then(
      (px) => {
        e.pixels = px;
        e.status = 'ready';
        if (this.onReady) this.onReady(e);
      },
      (err) => {
        e.status = 'failed';
        e.error = err;
        if (this.onError) this.onError(e, err);
      },
    );
    return e;
  }

  clear(destroy) {
    for (const e of this.entries.values()) if (e.gpu && destroy) destroy(e.gpu);
    this.entries.clear();
  }
}
