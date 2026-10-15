# WebAssembly kernels

The reader's hottest loops also exist as freestanding C compiled to two small
WebAssembly modules: the geometry kernels (51 kB) and the instance kernel
(10 kB), which uses 128-bit SIMD and is a module of its own so that a browser
without WebAssembly SIMD loses only that kernel. Each kernel computes exactly
what the JavaScript it replaces computes, so a document produces the same
meshes and the same instance table, bit for bit, with or without WebAssembly.

| Kernel | Replaces | Used for |
|---|---|---|
| `numbers.c` | `readNumberList` (values.js) | mesh positions, normals, uvs, indices and point lists of 1,024 characters or more |
| `normals.c` | `weldMap` + `computeNormals` (mesh.js) | `<mesh>` without normals, OBJ/STL/STEP import |
| `sweep.c` | `spineFrames` and `sweepMesh` (sweep.js) | `<sweep>`, tubes (`<polyline radius>`): frames, profile, walls and caps in one call |
| `extrude.c` | `extrudeMesh` (extrude.js) | `<extrude>`, `<path depth>`, `<gear>`: inset, caps, walls in one call |
| `contour.c` | `contourFrames`, `insetPoints`, `triangulateRegion`, `triangulationError` | the 2D outlines of sweeps and extrusions |
| `earcut.c` | `triangulate` (path/triangulate.js) | every filled outline |
| `prims.c` | `unitSphere`, `unitCylinder`, `unitCapsule`, `unitTorus`, `roundedBox` (primitives.js), `catmullRom` (sweep.js), `gearOutline` (gear.js) | the analytic primitives, smooth spines, gear profiles |
| `sphere.c` | `measureSphereDeviation` (lod-error.js) | the error bound of every sphere's levels of detail |
| `simd/instances.c` | `Walker.emitRepeat`, `emitScatter`, `emitLod`, `RenderScene.setInstance` (flatten.js); `es3dSin`, `es3dCos` (trig.js); `mulberry32` (random.js) | the instance rows of `<repeat>` and `<scatter>` |

`src/wasm/kernels.js` loads both modules (a top-level `await`, so they are
ready before any reader code runs) and offers one function per kernel. Each
returns null when it cannot help, and the caller then runs its JavaScript
version: WebAssembly missing or blocked (a content security policy without
`'wasm-unsafe-eval'`), no SIMD (the instance kernel only), memory exhausted,
input outside what the kernel handles. `setWasmEnabled(false)` switches the
kernels off, which is what the tests use to compare both paths.

The instance kernel works from a template: for each `<repeat>` or
`<scatter>` the walker records the subtree below one placement once, as a
small program (multiply into a matrix slot, write an instance row, record a
level-of-detail switch; a nested `<repeat>` is unrolled), and the kernel runs
it for every placement. Subtrees with animation, lights, cameras or a nested
`<scatter>`, and elements with fewer than 16 rows, stay with the walker. Long
elements are expanded 16,384 rows per call, so the kernel's memory stays
small. Materials are created where the walker creates them, on first use:
the kernel calls back into JavaScript the first time a row needs one.

## Rules that keep the bits identical

- The same IEEE 754 operations in the same order. WebAssembly has no fused
  multiply-add and nothing is compiled with fast-math (`-ffp-contract=off`).
- `sin`, `cos`, `tan`, `acos` and `atan2` are imported from the page's own
  `Math`: their results are up to the engine, and the JavaScript path uses
  the same engine. `hypot` is computed in the module with V8's algorithm
  (largest magnitude first, Kahan-summed squares), but only after the loader
  has checked that it gives this engine's `Math.hypot` results; elsewhere the
  kernels call `Math.hypot`, which is slower (each call leaves WebAssembly
  and allocates).
- SIMD lanes are scalar operations: every vector instruction the instance
  kernel uses (add, subtract, multiply, divide, ceiling, comparisons, bit
  selects, absolute value, negation, conversion to float32) is the IEEE
  operation per lane, applied to the values the scalar code would combine.
  Branches on data are bit selects, which compute both sides; the result is
  the side the scalar code takes.
- JavaScript semantics where C differs: `Math.round` (ties towards +∞, -0
  kept), `Math.max`/`Math.min` (`f64.max`/`f64.min`: NaN wins, +0 > -0),
  `x || 1` for numbers (0, -0 and NaN are falsy), `ToInt32` for `| 0` and
  Int32Array stores, float32 stores rounding to nearest even.
- Anything a kernel cannot reproduce exactly goes back to JavaScript: a
  syntax error in a number list (JavaScript then reports it), mesh indices
  out of range, two triangulation holes that tie for the sort order, very
  deep triangulation recursion, repeat counts and grid sizes that are not
  whole numbers.

`test/wasm.test.mjs` compiles every example and benchmark scene with and
without the kernels and compares every level of every mesh and every
instance row, level-of-detail switch, bound and material; then random
documents of nested `<repeat>` and `<scatter>` elements (every placement
mode, random scale, rotation and material, `<use>`, `<lod>`, colours,
mirroring, several kernel calls for one element, animation), random sweeps,
normals, triangulations, extrusions (with their reports), primitives, smooth
spines, gear outlines, number lists (including errors) and the placement
sine and cosine (zeros, infinities, NaN, multiples of π/4 and their
neighbours, 20,000 random values).

## Building

    npm run wasm             # clang (wasm32 target) and wasm-ld, writes src/wasm/kernels-binary.js
    npm run wasm -- --check  # fails when the committed modules are not what the sources build

`wasm/*.c` build the geometry module and `wasm/simd/*.c` (with
`wasm/runtime.c`, compiled with `-msimd128`) the instance module. Both are
embedded in `src/wasm/kernels-binary.js` as base64, so Node, Vite builds and
the published package need no separate file. Change a kernel and its
JavaScript twin together; the test fails otherwise.

## Measurements

The reader alone (parse, build, instance table, every finest-level mesh),
medians in ms of three processes per mode, 25 loads each after 10 to warm up
(4 vCPU Xeon @ 2.8 GHz, Node 22.22, October 2026; this machine varies by
±15 % between runs):

| Scene | JavaScript | WebAssembly | After `gc()`: JS | Wasm |
|---|---:|---:|---:|---:|
| Rotating cube | 1.8 | 0.6 | 2.8 | 1.3 |
| Primitive test | 9.2 | 5.3 | 9.0 | 6.6 |
| Extruded logo | 3.6 | 2.2 | 4.9 | 3.2 |
| Gearbox | 13.8 | 5.1 | 14.8 | 6.4 |
| Forest (7,401 instances) | 8.3 | 2.5 | 23.6 | 3.7 |
| City (10,926 instances) | 11.5 | 4.0 | 30.8 | 4.4 |
| LOD stress (25,728 instances) | 22.7 | 8.1 | 49.3 | 10.5 |
| Scanned mesh | 78 | 32 | 88 | 33 |

The instance kernel alone takes the instance table of the forest from
3.8 ms to 1.3 ms, the city from 6.5 ms to 1.8 ms and the LOD stress test from
20.3 ms to 5.3 ms, and leaves almost no garbage, which is why the scenes stay
fast after a collection. SIMD gave about a quarter of that: a 4×4 product in
two lanes takes 12 ns instead of 26 ns in V8. What remains is arithmetic the
walker also does: three matrix products per row (placement, element,
geometry unit), the bounds, and four normative sines or cosines per placement
when a scatter turns its copies (about 30 ns per pair, its divide and
polynomial being one dependent chain).

What made the difference against the first version of the module (sweeps,
normals and number lists only; primitive test 9–10 ms, gearbox 9–11 ms):
`hypot` inside the module instead of a call out to `Math.hypot` (each such
call allocated a heap number), and one call per extrusion or sweep instead
of one per contour, so a load leaves about 0.7 MB of garbage instead of
1.7 MB.

First load in a fresh Chromium page with the first version of the module
(production build, new browser context each time, 4 vCPU Xeon @ 2.1 GHz,
Chromium 141 headless; the module adds no measurable time to page
start-up):

| Scene | JavaScript | WebAssembly |
|---|---:|---:|
| Rotating cube | 14.5 | 16.8 |
| Primitive test | 87 | 64 |
| Gearbox | 91 | 52 |
| Extruded logo | 47 | 42 |
| Scanned mesh | 162 | 91 |

The gain is largest where JavaScript is slowest: before the engine has
optimised the reader (a first load) and in long numeric loops (mesh data).
The rest of a load (parsing, validation, the scene graph, the instance
table outside `<repeat>` and `<scatter>`) is still JavaScript.
