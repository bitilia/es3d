// JsonML-style JSON representation of the ES3D AST (experimental surface syntax).
//
//   ["es3d", {"version": "1"},
//     ["box", {"size": "2", "material": "red"}],
//     ["#comment", " text "],
//     ["title", {}, "Text content"]]
//
// Attribute values stay strings so the mapping to the markup syntax is exact.

import { Attr, Comment, Document, Element } from './ast.js';
import { Diagnostic, ES3DError } from './errors.js';

export function toJsonTree(doc, { comments = false } = {}) {
  const conv = (el) => {
    const attrs = {};
    for (const a of el.attrs) attrs[a.name] = a.value;
    const arr = [el.name, attrs];
    if (el.text !== null && el.text !== undefined && el.text !== '') arr.push(el.text);
    for (const c of el.children) {
      if (c.type === 'element') arr.push(conv(c));
      else if (comments) arr.push(['#comment', c.text]);
    }
    return arr;
  };
  return conv(doc.root);
}

export function fromJsonTree(tree) {
  const fail = (message, path) => {
    throw new ES3DError([new Diagnostic({ code: 'E_JSON_STRUCTURE', message, path })]);
  };
  const conv = (node, path) => {
    if (!Array.isArray(node) || typeof node[0] !== 'string') fail('Expected an element array ["name", {attributes}, ...children].', path);
    if (node[0] === '#comment') return new Comment(String(node[1] ?? ''));
    const el = new Element(node[0]);
    let i = 1;
    if (node.length > 1 && node[1] !== null && typeof node[1] === 'object' && !Array.isArray(node[1])) {
      for (const [k, v] of Object.entries(node[1])) {
        if (typeof v === 'object' && v !== null) fail(`Attribute '${k}' must be a string or number.`, `${path} > @${k}`);
        el.attrs.push(new Attr(k, String(v)));
      }
      i = 2;
    }
    for (; i < node.length; i++) {
      const c = node[i];
      if (typeof c === 'string') el.text = (el.text || '') + c;
      else el.appendChild(conv(c, `${path} > ${Array.isArray(c) ? c[0] : '?'}[${i}]`));
    }
    el.selfClosing = el.children.length === 0 && el.text === null;
    return el;
  };
  const root = conv(tree, Array.isArray(tree) ? String(tree[0]) : 'root');
  if (root.type !== 'element') fail('The root must be an element.', 'root');
  return new Document({ root, syntax: 'json' });
}
