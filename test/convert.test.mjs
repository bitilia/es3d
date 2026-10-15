// File conversion: SVG, STL, glTF JSON and the shared converter module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/pipeline.js';
import { svgToES3D, parseSvgTransform, parseCss, parseSvgColor } from '../src/io/svg-import.js';
import { parseSTL, stlToScene, exportSTL, isBinarySTL, weldTriangles } from '../src/io/stl.js';
import { detectKind, importFiles, exportFormat } from '../src/io/convert.js';
import { parseGLTF, gltfToScene } from '../src/io/gltf.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const sample = (f) => new Uint8Array(fs.readFileSync(`${root}docs/public/samples/${f}`));
const svg = (body, attrs = 'viewBox="0 0 100 100"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const elementsOf = (text, name) => [...text.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => m[0]);
const attrOf = (tag, name) => (new RegExp(`\\s${name}="([^"]*)"`).exec(tag) || [])[1];

test('SVG shapes become extrusions with materials, flipped to y up and centred', () => {
  const r = svgToES3D(svg('<rect x="0" y="0" width="100" height="20" fill="#ff0000"/><circle cx="50" cy="80" r="10" fill="blue"/>'), { size: 10 });
  const c = compile(r.text);
  assert.ok(c.ok, c.diagnostics.map((d) => d.message).join('\n'));
  const ex = elementsOf(r.text, 'extrude');
  assert.equal(ex.length, 2);
  assert.match(r.text, /<material id="cff0000" color="#ff0000"/);
  assert.match(r.text, /<material id="c0000ff" color="#0000ff"/);
  // the rectangle was at the top of the viewBox: in ES3D (y up) it is above the centre
  const b = c.scene.bounds;
  assert.ok(Math.abs(b.max[1] - 5) < 1e-3 && Math.abs(b.min[1] + 4) < 1e-3, JSON.stringify(b));
  // the circle comes later, so it is stacked in front
  assert.ok(attrOf(ex[1], 'position'));
  assert.equal(r.stats.fills, 2);
});

test('SVG transforms: similarity transforms keep arcs, skews turn them into curves', () => {
  const t = parseSvgTransform('translate(10,20) rotate(90) scale(2)');
  const [x, y] = [t[0] * 1 + t[2] * 0 + t[4], t[1] * 1 + t[3] * 0 + t[5]];
  assert.ok(Math.abs(x - 10) < 1e-12 && Math.abs(y - 22) < 1e-12);
  assert.equal(parseSvgTransform('rotate(30'), null);
  const similar = svgToES3D(svg('<circle cx="50" cy="50" r="40" transform="rotate(30 50 50)"/>'));
  assert.match(attrOf(elementsOf(similar.text, 'extrude')[0], 'd'), /[Aa]/);
  const skewed = svgToES3D(svg('<circle cx="50" cy="50" r="40" transform="skewX(20)"/>'));
  const d = attrOf(elementsOf(skewed.text, 'extrude')[0], 'd');
  assert.doesNotMatch(d, /[Aa]/);
  assert.match(d, /[CcSs]/);
  assert.ok(compile(skewed.text).ok);
});

test('SVG styles: style sheets, presentation attributes and inline styles in CSS order', () => {
  const css = parseCss('.a { fill: red } #b { fill: lime } rect.a { fill: blue } g > rect { fill: black } @media print { .c { fill: #123456 } }');
  assert.equal(css.unsupported, 1);
  assert.equal(css.rules.length, 4);
  const r = svgToES3D(
    svg(`<style>.a { fill: red } #b { fill: lime } rect.a { fill: blue }</style>
      <rect class="a" width="10" height="10"/>
      <rect class="a" id="b" x="20" width="10" height="10"/>
      <rect class="a" x="40" width="10" height="10" style="fill: #ffff00"/>
      <circle class="a" fill="green" cx="80" cy="5" r="5"/>`),
  );
  const mats = elementsOf(r.text, 'extrude').map((e) => attrOf(e, 'material'));
  assert.deepEqual(mats, ['c0000ff', 'c00ff00', 'cffff00', 'cff0000']);
  assert.deepEqual(parseSvgColor('hsl(120, 100%, 50%)').map((v) => Math.round(v * 255)), [0, 255, 0, 255]);
});

test('SVG strokes become tubes, <use> and symbols are expanded, unsupported content is reported', () => {
  const r = svgToES3D(
    svg(`<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
      <symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></defs>
      <path d="M10 10 L90 10" stroke="#333" stroke-width="4" fill="none"/>
      <use href="#s" x="0" y="50" width="20" height="20"/>
      <use xlink:href="#s" x="40" y="50" width="20" height="20" fill="url(#g)"/>
      <text x="0" y="90">hello</text>`),
    { size: 100 },
  );
  const tubes = elementsOf(r.text, 'polyline');
  assert.equal(tubes.length, 1);
  assert.equal(Number(attrOf(tubes[0], 'radius')), 2);
  assert.equal(elementsOf(r.text, 'extrude').length, 2);
  assert.ok(r.warnings.some((w) => /Gradients/.test(w)));
  assert.ok(r.warnings.some((w) => /text/.test(w)));
  assert.match(r.text, /c808080/); // the gradient's average color
  assert.ok(compile(r.text).ok);
});

test('SVG input: flat output, DOCTYPE entities, and precise errors for broken files', () => {
  const flat = svgToES3D(svg('<rect width="50" height="50"/>'), { depth: 0 });
  assert.equal(elementsOf(flat.text, 'path').length, 1);
  assert.ok(compile(flat.text).ok);
  const illustrator = `<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
  <!ENTITY ns_svg "http://www.w3.org/2000/svg">
  <!ENTITY st0 "fill:#336699;">
]>
<svg xmlns="&ns_svg;" viewBox="0 0 10 10"><rect width="10" height="10" style="&st0;"/></svg>`;
  assert.match(svgToES3D(illustrator).text, /#336699/);
  const bomb = `<!DOCTYPE svg [<!ENTITY a "&b;&b;&b;&b;"><!ENTITY b "&a;&a;&a;&a;">]>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="&a;"/></svg>`;
  const exploded = svgToES3D(bomb);
  assert.ok(exploded.text.length < 8000, 'nested SVG entities must not expand');
  assert.throws(() => svgToES3D('<svg><rect></svg>'), /line 1, column \d+/);
  assert.throws(() => svgToES3D('<html/>'), /root element is <html>/);
  const none = svgToES3D(svg('<rect width="10" height="10" fill="none"/>'));
  assert.ok(none.warnings.some((w) => /no shapes/.test(w)));
});

test('the sample SVG badge converts without diagnostics', () => {
  const r = svgToES3D(new TextDecoder().decode(sample('es3d-badge.svg')), { name: 'es3d-badge.svg', bevel: 0.004 });
  const c = compile(r.text);
  assert.ok(c.ok);
  assert.equal(c.diagnostics.length, 0, c.diagnostics.map((d) => d.message).join('\n'));
  assert.equal(r.stats.fills, 8);
  assert.equal(r.stats.strokes, 5);
});

const asciiTetra = `solid tetra
facet normal 0 0 -1
 outer loop
  vertex 0 0 0
  vertex 0 1 0
  vertex 1 0 0
 endloop
endfacet
facet normal 0 -1 0
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 0 1
 endloop
endfacet
facet normal -1 0 0
 outer loop
  vertex 0 0 0
  vertex 0 0 1
  vertex 0 1 0
 endloop
endfacet
facet normal 1 1 1
 outer loop
  vertex 1 0 0
  vertex 0 1 0
  vertex 0 0 1
 endloop
endfacet
endsolid tetra
`;

test('STL: binary and ASCII parsing, welding, Z-up to Y-up', () => {
  const bin = sample('gem.stl');
  assert.ok(isBinarySTL(bin));
  assert.equal(parseSTL(bin).triangles, 128);
  const ascii = new TextEncoder().encode(asciiTetra);
  const p = parseSTL(ascii);
  assert.equal(p.format, 'ascii');
  assert.equal(p.name, 'tetra');
  assert.equal(p.triangles, 4);
  const w = weldTriangles(p.positions);
  assert.equal(w.positions.length / 3, 4);
  const s = stlToScene(ascii);
  // z (up in the file) becomes y
  assert.ok(Math.abs(s.scene.bounds.max[1] - 1) < 1e-6 && Math.abs(s.scene.bounds.min[2] + 1) < 1e-6, JSON.stringify(s.scene.bounds));
  assert.throws(() => parseSTL(new TextEncoder().encode('solid x\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 1 0 0\n endloop\n endfacet\nendsolid')), /multiple of 3/);
});

test('STL export writes world-space triangles, Z-up, binary or ASCII', () => {
  const c = compile('es3d version=1 { box size=2,4,6 position=10,0,0 }');
  const meshOf = (e, l) => c.cache.mesh(e, l);
  const bin = exportSTL(c.scene, meshOf);
  assert.equal(bin.triangles, 12);
  const back = parseSTL(bin.data);
  assert.equal(back.triangles, 12);
  let maxZ = -Infinity, maxY = -Infinity, minX = Infinity;
  for (let i = 0; i < back.positions.length; i += 3) {
    minX = Math.min(minX, back.positions[i]);
    maxY = Math.max(maxY, back.positions[i + 1]);
    maxZ = Math.max(maxZ, back.positions[i + 2]);
  }
  // the box is 4 high along ES3D's y, which is z in the Z-up file; its depth 6 runs along -y
  assert.equal(minX, 9);
  assert.equal(maxZ, 2);
  assert.equal(maxY, 3);
  const ascii = exportSTL(c.scene, meshOf, { binary: false, name: 'box' });
  assert.match(ascii.data, /^solid box\n facet normal/);
  assert.match(ascii.data, /endsolid box\n$/);
  assert.equal(parseSTL(new TextEncoder().encode(ascii.data)).triangles, 12);
});

/** A .gltf document (JSON + one buffer) built from the GLB sample. */
function gltfFromGlb(glb) {
  const dv = new DataView(glb.buffer, glb.byteOffset);
  const jlen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jlen)));
  const blen = dv.getUint32(20 + jlen, true);
  return { json, bin: glb.subarray(28 + jlen, 28 + jlen + blen) };
}

test('glTF JSON: embedded and external buffers, strips and fans, clear errors', () => {
  const glb = sample('stairs.glb');
  const { json, bin } = gltfFromGlb(glb);
  json.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`;
  const a = gltfToScene(JSON.stringify(json));
  json.buffers[0].uri = 'stairs.bin';
  const b = gltfToScene(JSON.stringify(json), { 'stairs.bin': bin });
  assert.equal(a.scene.count, b.scene.count);
  assert.ok(a.scene.count > 10);
  assert.throws(() => gltfToScene(JSON.stringify(json)), /stairs\.bin" is missing/);
  assert.throws(() => parseGLTF('{"asset":{"version":"1.0"}}'), /only 2\.0/);
  // a quad as a triangle strip and as a fan
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  const uri = `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString('base64')}`;
  for (const mode of [5, 6]) {
    const doc = {
      asset: { version: '2.0' },
      buffers: [{ uri, byteLength: 48 }],
      bufferViews: [{ buffer: 0, byteLength: 48 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode }] }],
      nodes: [{ mesh: 0 }],
    };
    const s = gltfToScene(doc);
    assert.equal(s.meshOf(s.scene.geometries[0]).indices.length, 6, `mode ${mode}`);
  }
});

test('the converter detects, imports and exports every supported kind', async () => {
  const cases = [
    [['es3d-badge.svg'], 'svg'],
    [['rock.obj', 'rock.mtl'], 'obj'],
    [['gem.stl'], 'stl'],
    [['stairs.glb'], 'glb'],
  ];
  for (const [files, kind] of cases) {
    const r = await importFiles(files.map((f) => ({ name: f, bytes: sample(f) })));
    assert.equal(r.kind, kind);
    const c = compile(r.text);
    assert.ok(c.ok, `${files[0]}: ${c.diagnostics.map((d) => d.message).join('\n')}`);
    for (const format of ['es3d', 'es3d-min', 'es3d-compact', 'glb', 'obj', 'stl']) {
      const out = exportFormat(r.text, format, { baseName: 'x', compiled: c });
      assert.ok(out.files.length >= 1 && out.files.every((f) => (typeof f.data === 'string' ? f.data.length : f.data.byteLength) > 0), `${files[0]} -> ${format}`);
    }
    // ES3D encodings round-trip to the same scene
    const min = exportFormat(r.text, 'es3d-min').files[0].data;
    assert.equal(compile(min).scene.count, c.scene.count);
  }
  // materials come from the .mtl given with the .obj
  const withMtl = await importFiles([{ name: 'rock.obj', bytes: sample('rock.obj') }, { name: 'rock.mtl', bytes: sample('rock.mtl') }]);
  assert.match(withMtl.text, /<material id="stone"/);
  const withoutMtl = await importFiles([{ name: 'rock.obj', bytes: sample('rock.obj') }]);
  assert.ok(withoutMtl.warnings.some((w) => /rock\.mtl was not given/.test(w)));
  assert.equal(detectKind('x.txt', new TextEncoder().encode('solid a\nfacet normal 0 0 1\n')), 'stl');
  assert.equal(detectKind('x', new TextEncoder().encode('// note\nes3d version=1')), 'es3d');
  assert.equal(detectKind('x', new TextEncoder().encode('<?xml version="1.0"?><svg/>')), 'svg');
  assert.equal(detectKind('notes.md', new TextEncoder().encode('# hello')), null);
  await assert.rejects(importFiles([{ name: 'notes.md', bytes: new TextEncoder().encode('# hello') }]), /unknown file type/);
  assert.throws(() => exportFormat('es3d version=1 { bx }', 'glb'), /1 error/);
});

test('the CLI imports SVG and exports STL', () => {
  const run = (...args) => spawnSync(process.execPath, ['scripts/es3d-cli.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const r = run('import', 'docs/public/samples/es3d-badge.svg', '--flat');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<path\b/);
  assert.match(r.stderr, /Gradients were replaced/);
  const s = run('stl', 'docs/public/examples/01-rotating-cube.es3d', '--ascii', '--lod', '3');
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /^solid es3d/);
});
