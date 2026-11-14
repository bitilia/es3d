// The first module the stage evaluates (render/stage.js imports it before
// anything else). In the compiler worker it keeps every message that arrives
// before the compiler is ready: the WebAssembly kernels (wasm/kernels.js) are
// instantiated with a top-level await, and a module worker delivers messages
// while it waits, so a handler installed after that would miss the first
// requests. compile-worker.js answers the kept messages once it takes over.

/** True inside a dedicated worker. */
export const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;

/** Messages that arrived before the compiler was ready, oldest first. */
export const early = [];

if (inWorker) self.onmessage = (e) => early.push(e);
