# Stage API

The stage puts an ES3D document on a canvas in a web page. It compiles the document, draws it with WebGPU or WebGL2, and handles what a page needs around that: resizing, the document's `<controls>`, scroll-driven animation, picking, and keeping meshes between visits.

```js
import { createStage } from '@es3d/es3d/stage';

const stage = await createStage(document.querySelector('canvas'));
stage.show(source);
```

`@es3d/es3d/stage` is one minified file, `browser/es3d-stage.min.js`, so a page loads it in one request, also from a CDN. `@es3d/es3d/browser` has the same stage plus the rest of the library (file conversion included), and `createStage` is also in `@es3d/es3d`. The canvas takes the size of its parent element.

## Options

`createStage(canvas, options)`. Every option can be left out.

| Option | Default | What it does |
|---|---|---|
| `playing` | `true` | Play clock animations. |
| `autoOrbit` | `true` | Turn slowly around the target until someone drags. |
| `orbitSpeed` | `0.22` | Radians per second. |
| `interactive` | `true` | `false`: no dragging, whatever the document says. Touch scrolling then passes through the canvas to the page. |
| `background` | `false` | A still camera and a running clock, for a page that moves shapes itself. |
| `clock` | `'document'` | `'always'` runs the clock in a document with no `<animate>`. |
| `scroll` | the page | The section whose scroll position drives `timeline="scroll"` animations. |
| `backend` | `'auto'` | `'webgpu'` or `'webgl2'` to choose. |
| `geometryStore` | IndexedDB | Where generated meshes are kept between visits. `false` keeps nothing. |
| `changeBudget` | `4` | Milliseconds per frame for compiling and placing fragments. |
| `workers` | `1` | `0` compiles `prepare()` on the main thread. |
| `onFrame(dt, stage)` | | Called every animation frame. |
| `onPick(hit)` | | A click on the scene. `hit.names` lists name and id up the tree; `hit.fragment` names the fragment hit. |
| `onInteract()` | | The visitor moved the camera. |
| `onError(message, result)` | | A document or fragment did not compile, or a fragment has elements only the stage's document can set. |

With `prefers-reduced-motion`, the clock and the automatic orbit stand still and a scroll-driven camera jumps from stop to stop. `stage.reducedMotion` says whether that is on.

## Showing a document

`stage.show(source, { keepCamera, time, keepFragments })` compiles and shows a document in any of the three syntaxes, and returns the compile result. On errors the previous document stays on screen and `onError` is called. A new document reuses the geometry of the last one, so a colour change re-tessellates nothing.

`stage.result` is the compile result on screen. `stage.camera`, `stage.controls` and `stage.renderer` are the parts the stage drives. `stage.time`, `stage.progress` (the scroll timeline, 0 to 1) and `stage.playing` can be read and set. `stage.invalidate()` draws the next frame even if nothing changed. `stage.dispose()` releases everything.

## Moving shapes

`stage.setTransform(id, matrix)` replaces the local matrix of the element with that id. The matrix is column-major, 16 numbers, the layout of `matrix()`. `stage.setTransforms([[id, matrix], ...])` does the same for many elements, walks each affected part of the scene once, and returns a boolean for each entry.

An entry is `false` when the id is missing or the element is drawn in more than one place: a shared definition, or a copy made by `<repeat>` or `<scatter>`. Give each shape you move its own id.

## Fragments

A fragment is another complete document shown inside the stage's document: a map tile, a room, a route. Only that document is compiled when it is added, replaced or removed.

```js
const tile = stage.add(source, { id: '16/32748/21789' });   // returns at once
const { ok, diagnostics } = await tile.ready;               // placed
tile.visible = false;                                       // kept, draws nothing
tile.replace(newSource);                                    // only this fragment is rebuilt
tile.setTransforms([['pier', matrix]]);                     // ids of this fragment's document
tile.remove();
```

| Call | What it does |
|---|---|
| `stage.add(source, { id, immediate })` | Adds a fragment and returns it. It is compiled and placed in the frame loop, within `changeBudget`; `immediate: true` does it now. Until then it draws nothing. |
| `fragment.ready` | Resolves with `{ ok, diagnostics, fragment }` once placed, or once it failed. |
| `fragment.visible` | `false` hides it without recompiling: it adds no rows to the frame. |
| `fragment.replace(source)` | New content in the same place. Bad input keeps what is on screen. Returns a promise like `ready`. |
| `fragment.setTransforms(entries)`, `setTransform(id, matrix)` | As on the stage, with the fragment's own ids. |
| `fragment.remove()` | Takes it out at once and frees what only it used. |
| `fragment.placed`, `fragment.diagnostics`, `fragment.id` | Its state. |
| `stage.fragment(id)`, `stage.fragments` | One fragment, or all of them in the order added. |

Each fragment is a complete, valid document, and any version-1 reader can open it on its own. Its shapes, groups, `<use>` with its own `<defs>`, `<repeat>`, `<scatter>`, `<lod>`, lights and `<animate>` are drawn as `show()` draws them. `<environment>`, `<camera>` and `<controls>` belong to the stage's document: in a fragment they are ignored, with a warning (code `STAGE_HOST_ONLY`). Two fragments may use the same ids. Materials with identical parameters are one material across all documents, and a shape repeated across fragments is generated and uploaded once.

The stage's document and its fragments draw the same picture as one document that holds the document's children and then each fragment's, in the order added. `show(source)` keeps the fragments; `show(source, { keepFragments: false })` removes them.

## Compiling off the main thread

```js
const prepared = await stage.prepare(source);           // { as: 'document' } for show()
const tile = stage.add(prepared, { id });
```

`stage.prepare(source, { as })` compiles in a worker the stage starts from its own file, and generates the meshes there too. Adding the result costs the main thread about a millisecond for a tile of a thousand buildings. A stage loaded from another origin starts its worker through a small module made in the page. Where no worker can start (a content security policy, `workers: 0`), `prepare()` compiles on the main thread, so a page needs no special case. The diagnostics are the same either way. A prepared document is added or shown once.

## Knowing what is on screen

`stage.drawn()` resolves after the first frame that shows every change queued before the call, fully refined. It resolves with `stage.stats`.

`stage.stats` describes the last drawn frame, in main-thread milliseconds: `frameMs` (the whole frame), `changeMs` (fragment changes since the frame before), `compileMs` (the compiling part of that), `tessellateMs` (mesh generation while drawing) and `renderMs` (drawing without it). Also `instances`, `drawCalls`, `uploadBytes`, `refining` (levels still being refined) and `queued` (changes waiting).

## Placement functions

`mulberry32`, `es3dSin` and `es3dCos` are exported too: the random generator and the sine and cosine the reader uses for `<scatter>`, so a script can place things exactly where a document would.
