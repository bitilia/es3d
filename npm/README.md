# ES3D

<p align="center">
  <a href="https://www.jsdelivr.com/package/npm/@es3d/es3d"><img src="https://img.shields.io/jsdelivr/npm/hm/@es3d/es3d?label=jsDelivr" alt="jsDelivr"></a>
  <a href="https://www.npmjs.com/package/@es3d/es3d"><img src="https://img.shields.io/npm/v/@es3d/es3d" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@es3d/es3d"><img src="https://img.shields.io/npm/dm/@es3d/es3d" alt="npm downloads"></a>
  <a href="https://github.com/bitilia/es3d/stargazers"><img src="https://img.shields.io/github/stars/bitilia/es3d" alt="GitHub stars"></a>
  <a href="https://github.com/bitilia/es3d/blob/main/LICENSE"><img src="https://img.shields.io/github/license/bitilia/es3d" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/@es3d/es3d" alt="Node.js"></a>
</p>

**A file format for 3D scenes you can write by hand, the way people write SVG.** The file describes objects, not triangles: a rounded box, an outline extruded into a solid, two thousand trees placed by a rule. The viewer builds the triangles, at the detail the screen needs.

This package is the reference implementation:
- a strict parser and validator;
- a WebGPU renderer with a WebGL2 fallback;
- converters from SVG, OBJ, STL, STEP and glTF, and back;
- the `es3d` command.

It has no dependencies.

```xml
<es3d version="1">
  <material id="bark" color="#6d4c41"/>
  <defs>
    <group id="tree">
      <cylinder radius="0.15" height="1.2" position="0,0.6,0" material="bark"/>
      <cone radius="1" height="2.4" position="0,2.4,0" color="#2e7d32"/>
    </group>
  </defs>
  <plane size="140" color="#6b8e3a"/>
  <scatter count="2000" radius="60" seed="7" randomScale="0.7..1.3">
    <use ref="tree"/>
  </scatter>
</es3d>
```

That is a forest of 2,000 trees in under a kilobyte. Every reader places every tree in the same spot.

## Install

```bash
npm install @es3d/es3d
```

The library runs in Node 22+ and in the browser. The renderer needs a browser with WebGPU or WebGL2.

## Show a scene on a page

```js
import { createStage } from '@es3d/es3d';

const stage = await createStage(document.querySelector('canvas'));
stage.show(source); // ES3D markup, compact syntax or JSON
```

The canvas is sized by its parent element. The stage draws only when something changes, plays animations, and follows the document's `<controls>`: orbit limits, collision with the scene, or a camera that follows page scroll.

## Compile, check and convert

```js
import { compile, importFiles, exportFormat } from '@es3d/es3d';

const result = compile(source);
if (!result.ok) console.error(result.diagnostics.map((d) => d.format()).join('\n\n'));

const { text } = await importFiles([{ name: 'logo.svg', bytes }]); // SVG, OBJ, STL, STEP, glTF → ES3D
const { files } = exportFormat(text, 'glb');                         // ES3D → glTF, OBJ, STL, STEP
```

Every error has a line, a column, a code and, where it can, a "did you mean" suggestion. Repeated warnings that share a code, an element name and a message are printed once, with a count. `validate --json` still lists every warning.

## The command

```bash
npx @es3d/es3d validate scene.es3d               # diagnostics, repeated warnings grouped; exit code 1 on errors
npx @es3d/es3d compact scene.es3d                # convert to the compact syntax (also: markup, json, fmt, minify)
npx @es3d/es3d glb scene.es3d -o scene.glb       # export (also: obj, stl, step)
npx @es3d/es3d import logo.svg -o logo.es3d      # SVG, OBJ, STL, STEP or glTF to ES3D
npx @es3d/es3d stats scene.es3d                  # sizes, counts and timings
```

`npx @es3d/es3d --help` lists every command and option.

## Documentation

- [Specification](https://es3d.org/spec/), included in this package as `docs/SPEC.md`.
- [Element reference](https://es3d.org/reference/), included as `docs/REFERENCE.md`.
- [ES3D Studio](https://es3d.org/studio/): edit a scene in the browser and see it as you type.
- [File converter](https://es3d.org/convert/).
- [es3d.org](https://es3d.org).

## License

Apache-2.0.
