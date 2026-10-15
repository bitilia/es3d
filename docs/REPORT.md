# ES3D: technical report

An honest evaluation of the ES3D format and its reference implementation: what it is good at, where it is the wrong tool, what it costs, and what would have to change before it could be proposed as a standard.

All numbers come from the benchmark harness in this repository and can be regenerated:

- `npm run bench` → [benchmark-results.md](benchmark-results.md): file sizes and the load pipeline in Node 22 on a 4-thread Intel Xeon @ 2.8 GHz.

Every scene starts as an ES3D document. OBJ and glTF files are **exported from the compiled ES3D scene**, so all formats contain exactly the same triangles (the finest level of detail, LOD 0), the same transforms and the same materials. The glTF exports are deliberately generous: meshes are deduplicated (every sphere in a scene shares one mesh, scaled per node), texture coordinates are omitted when nothing is textured, and three variants are measured. One node per instance (`glb`). `EXT_mesh_gpu_instancing` (`glb-inst`). Instancing plus `KHR_mesh_quantization` (`glb-q`, int16 positions, int8 normals). The OBJ exporter deduplicates normals and trims numbers. Not measured: Draco and meshopt compression for glTF (they need codec libraries this project deliberately does not include); they would make the mesh-heavy comparison worse for ES3D, not better.

---

## Verdict first

1. **For scenes that are *made of* parameters** (primitives, extruded or revolved outlines, repetition, procedural placement), **ES3D is two to three orders of magnitude smaller than glTF and up to four orders smaller than OBJ**, and it is *ready to render* faster than instanced glTF as three.js reads it (0.62–0.81× its time for 7,000–26,000 instances when each is measured in its own block of runs, 0.38–0.51× in alternating rounds), because it builds its instance table in a WebAssembly kernel and tessellates only a handful of unique shapes.
2. **For scenes made of arbitrary meshes it has no meaningful advantage and real costs.** On an 82k-triangle scan, ES3D text gzips to roughly the size of quantized glTF (and is only "smaller" than plain glTF because it omits normals), but takes 24 ms to load instead of 1.3–21 ms.
3. **The price is reader complexity.** A reader that turns ES3D into triangles is about 7,700 lines of non-comment JavaScript in this implementation (parsing, validation, path triangulation, offsetting, sweeps, LOD); its optional WebAssembly kernels repeat the hottest loops in about 2,200 lines of C; a static glTF importer is under 300. Every conforming reader has to re-implement all of it, and two readers will not produce identical triangles.
4. **Recommendation:** keep the textual, procedural core. Large meshes stay inline as `<mesh>`, printed to a fixed fraction of the scene size. Do not add a document-level binary encoding, and do not require a glTF file for geometry (section 9).

## 1. How ES3D differs from glTF, OBJ, STL and X3D

| | ES3D | glTF 2.0 | OBJ (+MTL) | STL | X3D / VRML |
|---|---|---|---|---|---|
| Content model | scene description; geometry by parameters | GPU-ready scene with tessellated meshes | geometry (+ Phong materials) | triangle soup | scene graph with primitives and runtime behaviour |
| Geometry | primitives, SVG paths (fill rules) → extrude/revolve/sweep, gears, explicit mesh | triangles, lines, points in binary accessors | polygons with separate v/vt/vn indices | triangles only | primitives, Extrusion, IndexedFaceSet, NURBS (profiles) |
| Who tessellates | the reader, per view (LOD) | the exporter, once | the exporter | the exporter | mostly the reader |
| Reuse / instancing | `defs`/`use`, `repeat`, seeded `scatter`, canonical meshes | mesh reuse by nodes; `EXT_mesh_gpu_instancing` | none (everything baked) | none | `DEF`/`USE`, Inline |
| Procedural placement | yes, part of the format | no | no | no | no (needs scripts) |
| Materials | minimal metallic/roughness, procedural textures, SVG-like inheritance | metallic/roughness core + many extensions, embedded images | Phong (MTL) | none | Phong; PBR in X3D 4 |
| Animation | transform tweens (move, turn, scale) | keyframe channels, skins, morph targets | no | no | interpolators, routes, scripts |
| Encoding | XML-like text (canonical), compact text, JSON, binary | JSON + binary buffers (.gltf/.glb) | text | text or binary | XML, ClassicVRML, JSON, binary (EXI) |
| Validation | strict; every error located with a suggestion | validator exists, loaders vary | lenient | lenient | strict schema |
| Ecosystem | this repository | universal (engines, DCC tools, viewers, CDNs) | universal, legacy | universal for 3D printing | niche, mostly scientific/legacy |

The honest summary: **ES3D re-discovers much of X3D** (primitives, extrusion along a spine, DEF/USE, LOD, interpolated animation) with a smaller scope, SVG's path syntax and fill rules instead of X3D's cross-sections, deterministic procedural placement, a compact syntax, PBR materials and much stricter, friendlier diagnostics. It is **not a competitor to glTF** for what glTF does, which is delivering finished, tessellated, textured, animated assets to a GPU with zero processing. It is strictly more capable than OBJ and STL, which are geometry carriers rather than scene formats.

## 2. Scenes ES3D represents extremely efficiently

Anything whose information content is small even though its triangle count is large:

| Scene | Rendered triangles | ES3D minified, gzip | GLB + instancing, gzip | Ratio | OBJ, gzip |
|---|---:|---:|---:|---:|---:|
| Primitive test (every shape type) | 44,936 | 1.2 kB | 654 kB | 540× | 653 kB |
| Extruded logo (SVG paths, bevels) | 8,224 | 0.8 kB | 83 kB | 100× | 99 kB |
| Gearbox (gears, springs, revolves) | 94,212 | 0.9 kB | 685 kB | 790× | 1.23 MB |
| Forest (2,400 objects, 7,401 instances) | 1.94 M | 0.6 kB | 187 kB | 310× | 24 MB |
| City (10,926 instances) | 8.7 M | 0.7 kB | 174 kB | 250× | ≈ 670 MB raw (est.) |
| LOD stress (25,728 instances) | 39 M | 0.6 kB | 441 kB | 760× | ≈ 3 GB raw (est.) |

Typical good fits:

- **Mechanical and architectural content built from primitives and profiles**: gears, shafts, brackets, stairs, facades, furniture, piping (`sweep` along a path), bolts arranged with `repeat`.
- **Instanced and procedural environments**: vegetation, crowds of simple props, city blocks, particle-like decorations. The file size does not grow with the instance count, and the instances arrive pre-grouped for GPU instancing.
- **Logos, signage and 2D-to-3D graphics**: an SVG outline plus `extrude` is the whole asset, and it stays crisp at any zoom because tessellation follows the projected size.
- **Data visualisation and diagrams**: bars, glyphs and connectors are primitives with parameters, and generating them is string templating.
- **Hand-written and generated content**: the format is diffable, reviewable and template-friendly; errors point at a line and column.

Two caveats even here. The ratio is between *descriptions*, not *visual results*. An ES3D sphere has an unbounded level of detail. A glTF sphere has the tessellation it was exported with. The comparison uses the finest ES3D level (48 segments) so the glTF files would look as good up close. And the advantage depends on actually using the procedural features. The same forest written out as 2,400 explicit `<use>` elements (what a DCC exporter would produce) is 55 kB gzipped. That is still smaller than glTF, because the shapes stay parametric, but only **3.4×**, not 310×.

## 3. Scenes ES3D represents poorly

- **Scanned, sculpted, photogrammetric or organic meshes.** There is nothing to parameterise, so ES3D degrades to its `<mesh>` escape hatch (numbers as text):

  | Scanned mesh, 81,920 triangles | Raw | gzip | brotli | Ready (ms) |
  |---|---:|---:|---:|---:|
  | ES3D markup (5 decimals, normals computed) | 2.43 MB | 709 kB | 699 kB | 24.0 |
  | OBJ (+ normals) | 5.36 MB | 1.31 MB | 1.23 MB | 130 |
  | GLB (float32 positions and normals) | 1.48 MB | 1.23 MB | 1.03 MB | 1.3 |
  | GLB + KHR_mesh_quantization | 984 kB | 744 kB | 555 kB | 21.4* |

  \* about 1 ms to parse. The rest is this importer converting int16 to float32. An engine can upload quantized attributes directly.

  ES3D only looks competitive because it *omits normals* and recomputes them on load (8 ms of the 24), which glTF cannot do (a glTF mesh without normals must be shaded flat). Against quantized glTF it is about the same size (709 kB against 744 kB gzipped) at 1–18× the load time; against Draco/meshopt-compressed glTF it would lose clearly. A binary encoding of the document was measured as well (section 8).
- **Characters and anything deformable**: no skins, no morph targets, no keyframe channels beyond simple transform tweens.
- **Textured assets**: images are referenced by URL, not embedded; procedural shapes get default UVs with no way to author them; there are no texture atlases, vertex colours or multiple UV sets.
- **Exact engineering geometry**: no booleans (CSG), no fillets beyond the extrude bevel, no NURBS, no tolerances. Tessellation is implementation-defined, so ES3D cannot be a CAD exchange format.
- **Terrain, point clouds, volumes, large heightfields**: no primitives for them; they fall back to `<mesh>`.
- **Shapes that are "almost" procedural**: one irregular detail forces the whole object into `<mesh>` and forfeits every advantage.

## 4. File-size comparison

Full tables: [benchmark-results.md](benchmark-results.md). Observations:

- **Encodings of the same ES3D document** (forest; raw / gzip): indented markup with comments 2.2 kB / 886 B, minified markup 1.4 kB / 598 B, compact syntax 1.1 kB / 535 B. Across the procedural scenes the compact syntax is 15–23 % smaller than minified markup before compression and 6–12 % after. A binary encoding of the whole document compressed worse than text (section 8).
- **Compression is not optional for any text format.** OBJ shrinks 5–6× under gzip, ES3D markup 2.3–2.8×. Compression does not close structural gaps: OBJ of the forest is still 24 MB gzipped because it writes out all 2,400 objects in full.
- **glTF's own instancing matters**: one node per instance (`glb`) costs 232 kB for the forest; `EXT_mesh_gpu_instancing` brings it to 187 kB. Quantization (`glb-q`) saves 18–40 % on mesh-dominated files and nothing on instance-dominated ones.
- **OBJ is not viable beyond a few million triangles**: the city would be ≈ 670 MB and the LOD stress test ≈ 3 GB (estimated by a least-squares fit on the exported files; not written).

## 5. Rendering performance

### Time to a renderable scene (Node, medians)

"Ready" = parse + build + all finest-level meshes in memory (a renderer can start uploading). For ES3D the build includes expanding `repeat`/`scatter` into the instance table; geometry is generated for the finest level here, although the renderer generates levels lazily.

| Scene | ES3D markup | ES3D, stored meshes | ES3D compact | OBJ | GLB | GLB + inst. | GLB, three.js | GLB + inst., three.js | ES3D split: parse / build / meshes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Primitive test | 7.0 ms | 4.4 | 8.1 | 88.8 | 1.6 | 1.7 | 4.0 | 3.3 | 1.0 / 1.5 / 4.5 |
| Gearbox | 5.3 | 3.5 | 6.1 | 170 | 2.2 | 1.6 | 4.4 | 4.0 | 0.75 / 0.97 / 3.6 |
| Forest (7,401 instances) | 3.1 | 3.5 | 4.6 | 5,041 | 21.8 | 9.9 | 231 | 3.8 | 0.57 / 2.3 / 0.17 |
| City (10,926 instances) | 2.9 | 2.8 | 3.2 | – | 20.1 | 16.8 | 297 | 4.6 | 0.55 / 2.1 / 0.26 |
| LOD stress (25,728 instances) | 6.1 | 6.2 | 6.2 | – | 54.5 | 39.3 | 757 | 8.8 | 0.48 / 5.3 / 0.39 |
| Scanned mesh | 24.0 | – | 40.6 | 130 | 1.3 | 1.7 | 1.9 | 1.6 | 13.3 / 2.4 / 8.4 |

- glTF's binary buffers are effectively free to parse (views into the file). **ES3D pays for tessellation**: 3.6–4.5 ms for the scenes of curved primitives at full detail (primitive test, gearbox), in JavaScript and WebAssembly on a server-class core, and proportionally longer on slower devices, on every load. Phones are measured in [benchmark-devices.md](benchmark-devices.md). In instance-heavy scenes the time goes into building the instance table instead, and there ES3D is 2.0–2.6× faster than instanced glTF read by three.js (measured in alternating rounds) and is 7.0–8.9× faster than one-node-per-instance glTF, whose node list must be parsed from JSON.
- The reader's load path was tuned without changing its output: every mesh, level of detail, bound and instance row is bit-identical to what it produced before. Generators count their vertices first and fill arrays of the exact size; spine frames, sphere bounds and normals are computed in flat arrays instead of small vectors; number lists are read in one pass with a correctly rounded fast path; smooth meshes skip the crease search; and the reader keeps one instance of its short-lived classes alive, so the engine does not discard the optimised generator code at the next full garbage collection. The hottest loops (number lists, crease normals, sweeps, triangulation, extrusion, the analytic primitives and gear outlines, the sphere bound, the instance rows of `repeat` and `scatter`) also run as WebAssembly kernels that give the same bits as the JavaScript ([wasm/README.md](../wasm/README.md)). With the kernels switched off (`npm run bench -- --no-wasm`, [benchmark-results-js.md](benchmark-results-js.md)) the same machine needs 0.9–2.8× as long for the tessellated scenes and 3.5× for the scanned mesh, and 1.7–2.9× for the instance-heavy scenes, whose instance tables a SIMD kernel builds.
- **glTF as pages read it.** The GLB columns marked three.js are the same files parsed by three.js's GLTFLoader (to a scene of BufferGeometry ready to upload), the loader most pages that show glTF use; this project's own importer is faster because it reads only what ES3D exports. Against three.js, ES3D needs 1.3–2.1× as long for the primitive test, the gearbox and the logo when each is measured in its own block of runs, but 0.84–1.12× when the two are loaded in alternating rounds (each then also disturbs the other's caches, which a page loading one model does not), and 0.9–1.8× when its meshes come from the geometry cache (*stored meshes*: a repeat load reading what an earlier one stored, here from disk; in browsers from IndexedDB, [ARCHITECTURE.md](ARCHITECTURE.md) section 8). With the download counted, ES3D is ready far sooner: at 25 Mbit/s the primitive test's GLB alone takes about 209 ms to arrive ([benchmark-results.md](benchmark-results.md)).
- Interactive views need not wait for full detail: the studio, the site viewer and the stage stop tessellating after 4 ms per frame, draw a coarser level in place of any level not generated yet, and refine it on the following frames (renderer option `tessellationBudget`; the device tables measure it as Progressive). A single `render()` call still draws full detail.
- **OBJ is unusable at scale**: 5.8 s to parse 150 MB for the forest (≈ 26 MB/s with a reasonably optimised parser), plus a 77 MB GPU footprint, against 0.56 MB for ES3D and glTF, because OBJ cannot express reuse.

### GPU memory

| | Forest | City | Gearbox |
|---|---:|---:|---:|
| ES3D (unique meshes + 64 B/instance) | 0.56 MB | 0.81 MB | 2.24 MB |
| GLB / GLB + instancing | 0.56 MB | 0.81 MB | 2.24 MB |
| OBJ (everything baked) | 77.1 MB | (≈ 270 MB, not written) | 4.23 MB |

Once loaded, ES3D and glTF scenes are the same thing on the GPU: instanced canonical meshes. ES3D's runtime advantage is not the format. It is what the reader is allowed to do with it, which is to choose the tessellation per instance and per frame.

### Real graphics chips

WebGL2, Chrome, 960×540. Median of ten passes. three.js is the GLB with one node per instance. Full tables: [benchmark-devices.md](benchmark-devices.md).

| Scene | PC build, RTX 5060 Ti | Phone, Galaxy S25+, Adreno 830 | Phone, moto g54 5G |
|---|---:|---:|---:|
| Forest, ES3D automatic LOD | 1.36 | 4.96 | 12.6 |
| Forest, three.js | 8.18 | 68.0 | 50.7 |
| City, ES3D automatic LOD | 0.71 | 9.28 | 11.8 |
| City, three.js | 10.1 | 68.2 | 55.5 |
| Scan, ES3D ready (not the frame) | 24.4 | 37.9 | 56.3 |
| Scan, instanced three.js ready | 9.70 | 17.0 | 21.1 |

- **Once the triangles match, the format does not matter, and the level of detail does.** On the PC (RTX 5060 Ti), the forest at full detail through our renderer is 0.78 ms, and the same triangles as a GLB are 0.79 ms. three.js drawing every triangle of that forest, without instancing, takes 8.18 ms. Automatic detail on that forest is 1.36 ms. The city is where the level of detail pays, 0.71 ms against 1.46 ms at full detail and 10.1 ms in three.js. Both phones show the same shape, with a wider gap.
- **The scan is still the case ES3D loses.** Ready time on the 5060 Ti is 24.4 ms for ES3D against 9.70 ms for instanced glTF in three.js. The Galaxy S25+ is 37.9 ms against 17.0 ms. There is nothing to parameterise, so the reader parses text and builds normals.

## 6. Parser complexity

Non-blank, non-comment lines of the reference implementation:

| Component | Lines |
|---|---:|
| Markup reading, value parsing, schema, validation, diagnostics | 2,167 |
| SVG path parsing, flattening, fill-rule regions, triangulation | 1,127 |
| Geometry generators (primitives, extrude/bevel, revolve, sweep, gear, mesh, LOD cache) | 2,264 |
| Scene graph, flattening, `repeat`/`scatter`, materials, transforms, animation | 1,558 |
| Matrix and vector math | 547 |
| **A reader that produces triangles from markup** | **≈ 7,700** |
| WebAssembly kernels: C twins of the hottest loops (optional, same results) and their loader | 2,199 + 286 |
| Compact syntax / JSON readers | 298 / 44 |
| glTF importer (static meshes, nodes, instancing, quantization, external buffers) | 275 |
| OBJ and MTL parser | 228 |

The *syntax* is cheap. A strict markup parser is ~350 lines and the compact syntax ~300. The *semantics* are not. A conforming reader needs robust polygon triangulation with holes and fill rules, contour offsetting for bevels, rotation-minimising frames, arc conversion, involute gear profiles, crease-angle normals and a level-of-detail policy. Each of these has edge cases (self-intersections, degenerate contours, near-zero bevels) where implementations will disagree. Consequences:

- **Two readers will never produce identical meshes.** That is acceptable for visualisation and fatal for engineering, measurement, collision or anything that hashes geometry. glTF has no such problem because it ships the triangles.
- **Procedural placement is only mostly deterministic.** `<scatter>` specifies its random sequence exactly (integer arithmetic), but positions on a disc and Euler rotations use `sin`/`cos`, which IEEE 754 does not require to be correctly rounded; different math libraries can differ in the last bit.
- **Cost moves from the producer to every consumer.** glTF puts the work in the exporter, once; ES3D asks every viewer, on every device, to do it on every load.

On the positive side, strictness is cheap and valuable: the validator reports every problem with a line, column, code and suggestion (`Unknown attribute: raduis. Did you mean: radius?`), never repairs input silently, and costs about a millisecond for a typical document. Text parsing speed is adequate (1 ms for typical documents, 183 MB/s for number-heavy mesh data), but it is a cost that binary buffers do not have.

## 7. Should the format stay textual?

**Yes, for everything except bulk mesh data.**

- For procedural scenes the text form is already tiny (0.5–1.5 kB gzipped). No binary encoding can make a meaningful difference at that size. Text is what justifies the format: readability, diffs, code review, templating, and error messages with line numbers.
- The compact syntax earns its place as an authoring convenience (about half the size of indented markup, much less noise to type), but **three text syntaxes are too many for a standard**. Markup should be canonical. The compact syntax can stay only as a second spelling of that same tree, implemented in full or not at all. The JsonML form should be dropped: it is larger than markup and adds nothing for tools that can parse XML.
- For mesh data, text is the wrong representation: it is 3× larger than binary before compression, parsing numbers costs ~13 ms per 2.4 MB, and normals or attributes become impractical. The `<mesh>` escape hatch should stay for small hand-written meshes and point at binary buffers for anything larger.

## 8. Is the binary encoding worthwhile?

The measurements below are historical. Version 1 no longer includes ES3DB. The numbers are why.

**As implemented here, a binary encoding of the whole document, no.** The measurements:

- Procedural scenes: ES3DB is 17–45 % smaller than minified markup *uncompressed*, but 10–28 % *larger* than the compact text after gzip (5–27 % after brotli), and it decodes no faster (both take about a millisecond).
- Mesh-heavy scenes: ES3DB is 3.2× smaller raw and 21 % smaller after gzip than ES3D text, and decodes 2.2× faster (35 vs 80 ms). That is a real gain. Quantized glTF is only a third larger (744 vs 557 kB gzipped, and it carries normals that ES3DB leaves to the reader), decodes in under a millisecond, and is supported everywhere.

It also has a structural cost: the binary must stay in lockstep with the schema (typed payloads per attribute type), so every schema change is a binary-format change. The lesson of glTF applies: **binary is worthwhile for the bulk arrays, not for the structure**. The right design is a textual document plus binary buffers (glTF-style accessors, or simply glTF files) for large meshes, with HTTP compression for the text.

## 9. Decisions for version 1

1. **Meshes stay in the document.** `<mesh>` is the escape hatch for scans and sculpted shapes. A writer prints positions to 10⁻⁵ of the scene extent and normals to two decimal places. There is no ES3DB encoding, and a document does not point at a glTF or OBJ file for its geometry. Importers and exporters for those formats remain separate tools.
2. **Geometry is an error bound.** Each generator stores a chordal-error bound per level of detail. A conforming mesh stays inside that bound. The frame uses the bound, scaled by the instance, and keeps a level only while the error is at most one pixel.
3. **Placement is bit-specified.** Disc positions and rotation matrices use a binary64 polynomial (`es3dSin` / `es3dCos`). `sqrt` stays correctly rounded. Tessellation may use the platform sine and cosine, because those meshes are bounded rather than hashed.
4. **Limits are errors.** 2,000,000 instances, depth 64, 100,000 path commands, and 1,000,000 copies in one `repeat` or `scatter`. Past a limit the document is not valid.
5. **Materials use the glTF channel layout inside the element:** occlusion map, metallic-roughness map (green roughness, blue metallic), emissive map, and `alphaMode` (`auto`, `opaque`, `mask`, `blend`). UV layouts for the analytic primitives are in the specification. Texture files stay URLs or procedural textures.
6. **Coordinates stay as they are.** Path data is y-up. `unit` stays informative and does not rescale.
7. **Three syntaxes, one tree.** Markup is canonical. Compact syntax and JsonML spell the same document. They are not profiles.
8. **Extensibility stays small.** Elements named `x-` are skipped with a warning. Anything else unknown is an error.
9. **This is not an X3D profile.** The overlap is real, and version 1 does not retarget the format onto X3D.

## Threats to validity

- One implementation of each importer, written for this project; production loaders (e.g. engine glTF loaders in WebAssembly) may be faster, which would favour glTF further.
- Node load times vary by up to 1.5× between runs on this shared virtual machine, and between formats measured minutes apart. The *alternating* comparison with three.js ([benchmark-results.md](benchmark-results.md)) loads ES3D and the GLB in turns, so both see the same machine. Compare runs, not single numbers.
- The Node benchmark forces a full garbage collection before every sample. Such a collection skips V8's usual retention of hidden classes, so the optimised code of anything whose objects are all gone is thrown away; the reader works around this for its own short-lived classes, but the measured loads are still not fully warm. A first load in a fresh process or page runs before the engine has optimised the reader at all and takes several times longer than these medians, while a glTF load is mostly native work (JSON parsing and typed-array views) and changes much less.
- The scenes were written to exercise ES3D's features; real-world assets are mostly meshes, where ES3D has no advantage.
- Tessellation density at LOD 0 (48 segments for spheres and cylinders) determines the size of the mesh-format exports; coarser exports would shrink glTF and OBJ proportionally (see `npm run bench -- --lod 1`).
