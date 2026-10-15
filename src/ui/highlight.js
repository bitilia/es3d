// Lenient syntax highlighting for both ES3D syntaxes. It never throws on
// invalid input: unrecognised text is emitted unstyled.

import { escapeHtml } from './dom.js';

const span = (cls, text) => `<span class="tk-${cls}">${escapeHtml(text)}</span>`;

function highlightValue(v) {
  // numbers and path command letters inside attribute values
  return escapeHtml(v).replace(/(-?\d*\.?\d+(?:[eE][+-]?\d+)?)|(#[0-9a-fA-F]{3,8}\b)/g, (m, num, hex) => (num ? `<span class="tk-n">${num}</span>` : `<span class="tk-h">${hex}</span>`));
}

const XML_RE = /(<!--[\s\S]*?(?:-->|$))|(<\?[\s\S]*?(?:\?>|$))|(<\/?)([A-Za-z_:][\w:.-]*)|([A-Za-z_:][\w:.-]*)(\s*=\s*)("[^"]*"?|'[^']*'?)|(\/?>)/g;

export function highlightXml(text) {
  let out = '';
  let last = 0;
  XML_RE.lastIndex = 0;
  let m;
  while ((m = XML_RE.exec(text))) {
    if (m.index > last) out += escapeHtml(text.slice(last, m.index));
    if (m[1]) out += span('c', m[1]);
    else if (m[2]) out += span('c', m[2]);
    else if (m[3]) out += span('p', m[3]) + span('t', m[4]);
    else if (m[5]) {
      const q = m[7];
      const closed = q.length > 1 && q.endsWith(q[0]);
      const inner = closed ? q.slice(1, -1) : q.slice(1);
      out += span('a', m[5]) + span('p', m[6]) + `<span class="tk-v">${q[0]}${highlightValue(inner)}${closed ? q[0] : ''}</span>`;
    } else if (m[8]) out += span('p', m[8]);
    last = XML_RE.lastIndex;
    if (m[0].length === 0) XML_RE.lastIndex++;
  }
  if (last < text.length) out += escapeHtml(text.slice(last));
  return out;
}

const C_RE = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?)|([A-Za-z_][\w.:-]*)(=)("(?:[^"\\]|\\.)*"?|[^\s{};"]*)|([#@][A-Za-z_][\w.:-]*)|([{};])|([A-Za-z_][\w.:-]*)/g;

export function highlightCompact(text) {
  let out = '';
  let last = 0;
  C_RE.lastIndex = 0;
  let m;
  while ((m = C_RE.exec(text))) {
    if (m.index > last) out += escapeHtml(text.slice(last, m.index));
    if (m[1]) out += span('c', m[1]);
    else if (m[2]) out += span('s', m[2]);
    else if (m[3]) out += span('a', m[3]) + span('p', m[4]) + `<span class="tk-v">${highlightValue(m[5])}</span>`;
    else if (m[6]) out += span('i', m[6]);
    else if (m[7]) out += span('p', m[7]);
    else if (m[8]) out += span('t', m[8]);
    last = C_RE.lastIndex;
    if (m[0].length === 0) C_RE.lastIndex++;
  }
  if (last < text.length) out += escapeHtml(text.slice(last));
  return out;
}

export function highlight(text, syntax) {
  return syntax === 'compact' ? highlightCompact(text) : highlightXml(text);
}
