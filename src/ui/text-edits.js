// Lossless source edits for the inspector and the scene tree.
//
// Instead of re-serializing the whole document after a change (which would
// reformat the user's text and drop their layout), edits are computed against
// the attribute and element ranges recorded by the parsers and applied as
// minimal text replacements. Works for both the markup and compact syntaxes.

import { attrSpec } from '../format/schema.js';

function escXml(v) {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function quoteCompact(v) {
  if (v !== '' && !/[\s{};"\\]/.test(v)) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

/** Edit that sets an attribute (by canonical name) to a raw value. */
export function setAttributeEdit(doc, el, canonical, raw) {
  const a = el.attrIndex ? el.attrIndex[canonical] : null;
  const compact = doc.syntax === 'compact';
  if (a && a.valueStart >= 0) {
    if (!compact) {
      return { start: a.valueStart, end: a.valueEnd, text: a.quote === "'" ? raw.replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;') : escXml(raw) };
    }
    if (a.quote === '#' || a.quote === '@') {
      if (/^[A-Za-z_][\w.:-]*$/.test(raw)) return { start: a.valueStart, end: a.valueEnd, text: raw };
      // not representable as a header token: rewrite as a normal attribute
      return { start: a.nameStart, end: a.valueEnd, text: `${canonical}=${quoteCompact(raw)}` };
    }
    if (a.quote === '"') return { start: a.valueStart - 1, end: a.valueEnd + 1, text: quoteCompact(raw) === raw ? `"${raw}"` : quoteCompact(raw) };
    return { start: a.valueStart, end: a.valueEnd, text: quoteCompact(raw) };
  }
  const name = canonical;
  if (!compact) {
    const lastAttr = el.attrs.length ? el.attrs[el.attrs.length - 1] : null;
    const pos = lastAttr && lastAttr.valueEnd >= 0 ? lastAttr.valueEnd + 1 : el.nameEnd;
    return { start: pos, end: pos, text: ` ${name}="${escXml(raw)}"` };
  }
  const pos = el.openEnd >= 0 ? el.openEnd : el.nameEnd;
  return { start: pos, end: pos, text: ` ${name}=${quoteCompact(raw)}` };
}

/** Edit that removes an attribute. */
export function removeAttributeEdit(doc, el, canonical) {
  const a = el.attrIndex ? el.attrIndex[canonical] : null;
  if (!a || a.nameStart < 0) return null;
  const src = doc.source;
  let start = a.nameStart;
  while (start > 0 && (src[start - 1] === ' ' || src[start - 1] === '\t')) start--;
  if (start > 0 && src[start - 1] === '\n') {
    // attribute on its own line: remove the line break too
    let s2 = start - 1;
    if (s2 > 0 && src[s2 - 1] === '\r') s2--;
    start = s2;
  }
  let end = a.valueEnd;
  if (a.quote === '"' || a.quote === "'") end += 1;
  return { start, end, text: '' };
}

/** Edit that deletes an element (and its line, when it is alone on it). */
export function deleteElementEdit(doc, el) {
  const src = doc.source;
  let start = el.start;
  let end = el.end;
  if (start < 0 || end < 0) return null;
  const ls = src.lastIndexOf('\n', start - 1) + 1;
  let le = src.indexOf('\n', end);
  if (le < 0) le = src.length;
  if (/^[ \t]*$/.test(src.slice(ls, start)) && /^[ \t;]*\r?$/.test(src.slice(end, le))) {
    start = ls;
    end = Math.min(src.length, le + 1);
  }
  return { start, end, text: '' };
}

function indentOf(src, offset) {
  const ls = src.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(src.slice(ls))[0];
}

/**
 * Edit that appends an element snippet as the last child of `parent`.
 * `snippet` is given in markup form ({xml}) and compact form ({compact}).
 */
export function appendChildEdit(doc, parent, snippet) {
  const src = doc.source;
  const compact = doc.syntax === 'compact';
  const kids = parent.children.filter((c) => c.type === 'element');
  const lastKid = kids[kids.length - 1];
  const childIndent = lastKid ? indentOf(src, lastKid.start) : indentOf(src, parent.start) + '  ';
  const text = compact ? snippet.compact : snippet.xml;
  if (compact) {
    if (parent.headerForm) {
      const pos = src.length;
      const nl = src.endsWith('\n') ? '' : '\n';
      return { start: pos, end: pos, text: `${nl}${childIndent}${text}\n` };
    }
    if (parent.closeStart >= 0) {
      const pos = src.lastIndexOf('\n', parent.closeStart - 1) + 1;
      return { start: pos, end: pos, text: `${childIndent}${text}\n` };
    }
    // element without a block: add one
    const pos = parent.openEnd;
    const base = indentOf(src, parent.start);
    return { start: pos, end: pos, text: ` {\n${base}  ${text}\n${base}}` };
  }
  if (parent.selfClosing) {
    // <group .../>  ->  <group ...>\n  child\n</group>
    const close = src.lastIndexOf('/>', parent.end);
    const base = indentOf(src, parent.start);
    return { start: close, end: parent.end, text: `>\n${base}  ${text}\n${base}</${parent.name}>` };
  }
  const pos = src.lastIndexOf('\n', parent.closeStart - 1) + 1;
  const sameLine = pos <= parent.openEnd;
  if (sameLine) {
    const base = indentOf(src, parent.start);
    return { start: parent.closeStart, end: parent.closeStart, text: `\n${base}  ${text}\n${base}` };
  }
  return { start: pos, end: pos, text: `${childIndent}${text}\n` };
}

/** Snippets for "add element" actions. */
export const SNIPPETS = {
  box: { xml: '<box size="1" position="0,0.5,0"/>', compact: 'box s=1 p=0,0.5,0' },
  sphere: { xml: '<sphere radius="0.5" position="0,0.5,0"/>', compact: 'sphere r=.5 p=0,.5,0' },
  cylinder: { xml: '<cylinder radius="0.5" height="1" position="0,0.5,0"/>', compact: 'cylinder r=.5 h=1 p=0,.5,0' },
  cone: { xml: '<cone radius="0.5" height="1" position="0,0.5,0"/>', compact: 'cone r=.5 h=1 p=0,.5,0' },
  torus: { xml: '<torus radius="0.4" tube="0.12" position="0,0.5,0"/>', compact: 'torus r=.4 tube=.12 p=0,.5,0' },
  light: { xml: '<light type="point" position="0,3,0" intensity="10"/>', compact: 'light type=point p=0,3,0 intensity=10' },
};

/** Typed-value hint for an attribute (used to choose inspector widgets). */
export function widgetFor(elName, canonical) {
  const s = attrSpec(elName, canonical);
  if (!s) return 'text';
  if (s.type === 'bool') return 'bool';
  if (s.type === 'enum') return 'enum';
  if (s.type === 'color') return 'color';
  if (s.type === 'number' || s.type === 'int' || s.type === 'angle') return 'number';
  return 'text';
}
