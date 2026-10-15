// Entry point for reading ES3D documents in any of the surface syntaxes:
//   markup  (XML-like, canonical)      <es3d version="1"> ... </es3d>
//   compact (ES3D-C)                   es3d version=1  box s=2 ...
//   JSON    (JsonML-style)             ["es3d", {"version":"1"}, ...]
// All of them produce the same AST, which is then validated against the schema.

import { Document } from './ast.js';
import { Diagnostic, ES3DError, LineIndex } from './errors.js';
import { parseXml } from './xml-parser.js';
import { parseCompact } from './compact-parser.js';
import { validate } from './validator.js';
import { fromJsonTree } from './json.js';

/** Detect the surface syntax of a text document. */
export function detectSyntax(text) {
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (;;) {
    while (i < n && /\s/.test(text[i])) i++;
    if (text.startsWith('//', i)) {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    break;
  }
  const c = text[i];
  if (c === '<') return 'xml';
  if (c === '[' || c === '{') return 'json';
  return 'compact';
}

function failedDocument(err, syntax, text, lineIndex) {
  const doc = new Document({ root: null, syntax, source: text });
  doc.lineIndex = lineIndex;
  doc.diagnostics = err instanceof ES3DError ? err.diagnostics : [new Diagnostic({ code: 'E_INTERNAL', message: String(err && err.message ? err.message : err) })];
  return doc;
}

/**
 * Parse (and by default validate) an ES3D document.
 * Never throws for malformed input: problems are reported in doc.diagnostics.
 * @param {string|ArrayBuffer|Uint8Array} input
 * @param {{syntax?: 'xml'|'compact'|'json', validate?: boolean}} [opts]
 * @returns {Document}
 */
export function parse(input, opts = {}) {
  if (typeof input !== 'string') input = new TextDecoder('utf-8').decode(input instanceof Uint8Array ? input : new Uint8Array(input));
  const text = input;
  const syntax = opts.syntax || detectSyntax(text);
  const lineIndex = new LineIndex(text);
  let doc;
  try {
    if (syntax === 'xml') doc = parseXml(text, lineIndex);
    else if (syntax === 'compact') doc = parseCompact(text, lineIndex);
    else if (syntax === 'json') {
      let tree;
      try {
        tree = JSON.parse(text);
      } catch (e) {
        const m = /position (\d+)/.exec(e.message);
        const d = new Diagnostic({ code: 'E_JSON', message: `Invalid JSON: ${e.message}`, offset: m ? Number(m[1]) : 0, length: 1 });
        d.locate(lineIndex);
        throw new ES3DError([d], lineIndex);
      }
      doc = fromJsonTree(tree);
      doc.source = text;
    } else throw new Error(`Unknown syntax '${syntax}'`);
  } catch (e) {
    return failedDocument(e, syntax, text, lineIndex);
  }
  if (!doc.lineIndex && syntax !== 'json') doc.lineIndex = lineIndex;
  return opts.validate === false ? doc : validate(doc);
}

/** Parse and throw an ES3DError when the document has errors. */
export function parseStrict(input, opts = {}) {
  const doc = parse(input, opts);
  if (!doc.ok) throw new ES3DError(doc.errors, doc.lineIndex);
  return doc;
}

/** Human readable report of all diagnostics. */
export function formatDiagnostics(doc) {
  return doc.diagnostics.map((d) => d.format(doc.lineIndex)).join('\n\n');
}
