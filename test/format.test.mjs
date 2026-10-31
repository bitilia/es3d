// Parsing, validation and diagnostics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, detectSyntax, formatDiagnostics } from '../src/format/parse.js';
import { suggest, levenshtein } from '../src/format/errors.js';

const ok = (src) => {
  const doc = parse(src);
  assert.ok(doc.ok, formatDiagnostics(doc));
  return doc;
};
const errors = (src) => parse(src).diagnostics.filter((d) => d.severity === 'error');

test('detects the surface syntax', () => {
  assert.equal(detectSyntax('  <es3d version="1"/>'), 'xml');
  assert.equal(detectSyntax('// c\nes3d version=1'), 'compact');
  assert.equal(detectSyntax('["es3d",{}]'), 'json');
});

test('parses the markup syntax with typed values', () => {
  const doc = ok(`<?xml version="1.0"?>
<!-- c -->
<es3d version="1"><box size="1,2,3" position="0,1,0" material="m"/><material id="m" color="red"/></es3d>`);
  const box = doc.root.children.find((c) => c.name === 'box');
  assert.deepEqual(box.values.size, [1, 2, 3]);
  assert.deepEqual(box.values.position, [0, 1, 0]);
  assert.equal(doc.leading.length, 1);
});

test('parses the compact syntax into the same AST', () => {
  const a = ok('<es3d version="1"><group p="1,2,3"><sphere r="2" m="x"/></group><material id="x" color="#f00"/></es3d>');
  const b = ok('es3d version=1\ngroup p=1,2,3 { sphere r=2 m=x }\nmaterial#x color=#f00');
  const ga = a.root.children.find((c) => c.name === 'group');
  const gb = b.root.children.find((c) => c.name === 'group');
  assert.deepEqual(ga.values.position, gb.values.position);
  assert.equal(ga.children[0].values.radius, gb.children[0].values.radius);
  assert.equal(b.ids.get('x').name, 'material');
});

test('compact syntax: @ref, text content, quoted values and block root', () => {
  const doc = ok('es3d version=1 { title "A \\"quoted\\" title" defs { box#b } use @b t="translate(1,0,0) rotate(0,90,0)" }');
  const title = doc.root.children.find((c) => c.name === 'title');
  assert.equal(title.text, 'A "quoted" title');
  const use = doc.root.children.find((c) => c.name === 'use');
  assert.equal(use.values.ref, 'b');
  assert.equal(use.values.transform.ops.length, 2);
});

test('JSON syntax parses', () => {
  const doc = ok('["es3d", {"version": "1"}, ["box", {"size": "2"}]]');
  assert.deepEqual(doc.root.children[0].values.size, [2, 2, 2]);
});

test('unknown attribute reports line, column and a suggestion', () => {
  const src = '<es3d version="1">\n  <sphere raduis="1"/>\n</es3d>';
  const [e] = errors(src);
  assert.equal(e.code, 'E_UNKNOWN_ATTRIBUTE');
  assert.equal(e.line, 2);
  assert.equal(e.column, 11);
  assert.equal(e.suggestion, 'radius');
  const text = e.format();
  assert.match(text, /^ES3D Parse Error\nline 2, column 11\n\nUnknown attribute: raduis\n\nDid you mean: radius\?/);
});

test('syntax errors are fatal and located', () => {
  const doc = parse('<es3d version="1">\n<group>\n<box/>\n</es3d>');
  assert.equal(doc.ok, false);
  const d = doc.diagnostics[0];
  assert.equal(d.code, 'E_MISMATCHED_TAG');
  assert.equal(d.line, 4);
  assert.match(d.message, /expected <\/group> \(opened at line 2, column 1\)/);
  assert.equal(parse('<es3d version="1"><box size="1/></es3d>').diagnostics[0].code, 'E_UNTERMINATED_ATTRIBUTE');
  assert.equal(parse('es3d version=1 { box s=1').diagnostics[0].code, 'E_UNCLOSED_ELEMENT');
  assert.equal(parse('box s=1').diagnostics[0].code, 'E_COMPACT_ROOT');
});

test('value errors point inside attribute values', () => {
  const src = '<es3d version="1"><extrude d="M0,0 L1,0 L1 Z"/></es3d>';
  const [e] = errors(src);
  assert.equal(e.code, 'E_INVALID_VALUE');
  assert.equal(src.slice(e.offset, e.offset + 1), 'Z');
});

test('range, required and cross-attribute checks', () => {
  assert.equal(errors('<es3d version="1"><sphere radius="-1"/></es3d>')[0].code, 'E_RANGE');
  assert.equal(errors('<es3d version="1"><use/></es3d>')[0].code, 'E_MISSING_ATTRIBUTE');
  assert.equal(errors('<es3d version="1"><capsule radius="1" height="1"/></es3d>')[0].code, 'E_RANGE');
  assert.equal(errors('<es3d version="1"><extrude d="M0,0 L1,0 L0,1Z" depth="1" bevel="0.6"/></es3d>')[0].code, 'E_RANGE');
  assert.equal(errors('<es3d version="1"><scatter count="3"><box/></scatter></es3d>')[0].code, 'E_MISSING_ATTRIBUTE');
  assert.equal(errors('<es3d version="1"><mesh positions="0 0 0 1 0 0 0 1 0" indices="0 1 5"/></es3d>')[0].code, 'E_MESH');
  assert.equal(errors('<es3d version="2"/>')[0].code, 'E_VERSION');
});

test('references: unknown ids with suggestions, wrong kinds, duplicates and cycles', () => {
  const unknown = errors('<es3d version="1"><material id="red"/><box material="redd"/></es3d>')[0];
  assert.equal(unknown.code, 'E_UNKNOWN_REFERENCE');
  assert.equal(unknown.suggestion, 'red');
  assert.equal(errors('<es3d version="1"><material id="m"/><use ref="m"/></es3d>')[0].code, 'E_REFERENCE_KIND');
  assert.equal(errors('<es3d version="1"><box id="a"/><box id="a"/></es3d>')[0].code, 'E_DUPLICATE_ID');
  const cyc = errors('<es3d version="1"><defs><group id="a"><use ref="b"/></group><group id="b"><use ref="a"/></group></defs><use ref="a"/></es3d>');
  assert.ok(cyc.some((e) => e.code === 'E_CIRCULAR_REFERENCE'));
});

test('misplaced elements and text are reported', () => {
  assert.equal(errors('<es3d version="1"><box><sphere/></box></es3d>')[0].code, 'E_MISPLACED_ELEMENT');
  assert.equal(errors('<es3d version="1"><box>hello</box></es3d>')[0].code, 'E_TEXT_NOT_ALLOWED');
  const unknown = errors('<es3d version="1"><sphear/></es3d>')[0];
  assert.equal(unknown.code, 'E_UNKNOWN_ELEMENT');
  assert.equal(unknown.suggestion, 'sphere');
  const ext = parse('<es3d version="1"><x-vendor-thing/></es3d>');
  assert.ok(ext.ok);
  assert.equal(ext.warnings[0].code, 'W_EXTENSION');
});

test('aliases resolve to canonical names and duplicates are caught', () => {
  const doc = ok('<es3d version="1"><sphere r="2" p="1,2,3"/></es3d>');
  assert.equal(doc.root.children[0].values.radius, 2);
  assert.equal(errors('<es3d version="1"><sphere r="2" radius="3"/></es3d>')[0].code, 'E_DUPLICATE_ATTRIBUTE');
});

test('entities are decoded', () => {
  const doc = ok('<es3d version="1"><title>A &amp; B &#x263A;</title></es3d>');
  assert.equal(doc.root.children[0].text, 'A & B ☺');
});

test('version 1.x is accepted; a new attribute or a new value is not', () => {
  const doc = ok('<es3d version="1.1"><box size="1"/></es3d>');
  assert.equal(doc.warnings.length, 0);
  assert.equal(errors('<es3d version="1.1"><box shine="1"/></es3d>')[0].code, 'E_UNKNOWN_ATTRIBUTE');
  assert.equal(errors('<es3d version="1.1"><polyline points="0,0,0 1,0,0" smooth="uniform"/></es3d>')[0].code, 'E_INVALID_VALUE');
});

test('repeated extension warnings group in the text report and stay in the list', () => {
  const anchors = 6;
  const polys = Array.from({ length: anchors }, () => '<polygon points="0,0 1,0 0,1"><x-anchors nodes="a b c"/></polygon>').join('');
  const waves = '<line from="0,0,0" to="1,0,0"><x-wave axis="y"/></line>'.repeat(2);
  const doc = parse(`<es3d version="1.1">${polys}${waves}</es3d>`);
  assert.ok(doc.ok, formatDiagnostics(doc));
  assert.equal(doc.warnings.length, anchors + 2);
  const text = formatDiagnostics(doc);
  assert.equal(text.split('Extension element <x-anchors>').length - 1, 1);
  assert.equal(text.split('Extension element <x-wave>').length - 1, 1);
  assert.match(text, new RegExp(`Reported ${anchors} times\\. Showing the first\\.`));
  assert.match(text, /Reported 2 times\. Showing the first\./);
  const one = parse('<es3d version="1"><x-once/></es3d>');
  assert.equal(one.warnings.length, 1);
  assert.doesNotMatch(formatDiagnostics(one), /Reported/);
});

test('errors are listed one by one', () => {
  const text = formatDiagnostics(parse('<es3d version="1"><box foo="1"/><sphere foo="1"/></es3d>'));
  assert.equal(text.split('Unknown attribute: foo').length - 1, 2);
});

test('suggestion helper', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(suggest('raduis', ['radius', 'height']), 'radius');
  assert.equal(suggest('spotlight', ['directional', 'point', 'spot']), 'spot');
  assert.equal(suggest('xyz', ['radius']), null);
});
