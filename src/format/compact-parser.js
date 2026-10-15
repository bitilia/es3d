// Parser for the ES3D compact syntax: tokens -> the same AST as the markup syntax.
//
// Grammar (newlines are whitespace):
//   document  := comment* root
//   root      := 'es3d' header ( '{' statement* '}' | statement* )
//   statement := element | comment | ';'
//   element   := NAME header ( '{' statement* '}' )?
//   header    := ('#' ID)? ('@' REF)? STRING? (NAME '=' VALUE)*

import { Attr, Comment, Document, Element } from './ast.js';
import { Diagnostic, ES3DError, LineIndex } from './errors.js';
import { CTok, CompactTokenizer } from './compact-tokenizer.js';

const ROOT_NAMES = new Set(['es3d', 'v3d']);

export function parseCompact(text, lineIndex = new LineIndex(text)) {
  const tz = new CompactTokenizer(text, lineIndex);
  const buf = [];
  const peek = (k = 0) => {
    while (buf.length <= k) buf.push(tz.next());
    return buf[k];
  };
  const take = () => (buf.length ? buf.shift() : tz.next());
  const fail = (code, message, offset, length = 1, extra = {}) => {
    const d = new Diagnostic({ code, message, offset, length, ...extra });
    d.locate(lineIndex);
    throw new ES3DError([d], lineIndex);
  };
  const where = (offset) => {
    const p = lineIndex.position(offset);
    return `line ${p.line}, column ${p.column}`;
  };

  function parseHeader(el) {
    let last = el.nameEnd;
    for (;;) {
      const t = peek();
      if (t.type === CTok.ID || t.type === CTok.REF) {
        take();
        const name = t.type === CTok.ID ? 'id' : 'ref';
        if (el.attrNode(name)) fail('E_DUPLICATE_ATTRIBUTE', `Duplicate attribute '${name}' on ${el.name}.`, t.start, t.end - t.start);
        el.attrs.push(new Attr(name, t.value, t.start, t.start + 1, t.start + 1, t.end, t.type === CTok.ID ? '#' : '@'));
        last = t.end;
      } else if (t.type === CTok.STRING) {
        take();
        if (el.text !== null) fail('E_SYNTAX', `${el.name} already has text content.`, t.start, t.end - t.start);
        el.text = t.value;
        el.textStart = t.start;
        el.textEnd = t.end;
        last = t.end;
      } else if (t.type === CTok.NAME && peek(1).type === CTok.EQ) {
        take();
        take();
        const v = take();
        if (v.type !== CTok.VALUE) fail('E_MISSING_VALUE', `Expected a value for attribute '${t.value}'.`, v.start, 1);
        for (const prev of el.attrs) {
          if (prev.name === t.value) fail('E_DUPLICATE_ATTRIBUTE', `Duplicate attribute '${t.value}' on ${el.name}.`, t.start, t.end - t.start);
        }
        const a = new Attr(t.value, v.value, t.start, t.end, v.valueStart, v.valueEnd, v.quote);
        a.decoded = !!v.escaped;
        el.attrs.push(a);
        last = v.end;
      } else {
        break;
      }
    }
    el.openEnd = last;
  }

  function parseStatements(parent, closeTok) {
    for (;;) {
      const t = peek();
      if (t.type === CTok.EOF) {
        if (closeTok) {
          fail('E_UNCLOSED_ELEMENT', `Unclosed block of '${parent.name}' (opened at ${where(closeTok.start)}): missing '}'.`, closeTok.start, 1);
        }
        return;
      }
      if (t.type === CTok.RBRACE) {
        if (!closeTok) fail('E_UNEXPECTED_CLOSE', "Unexpected '}': no block is open.", t.start, 1);
        take();
        parent.closeStart = t.start;
        parent.end = t.end;
        return;
      }
      if (t.type === CTok.SEMI) {
        take();
        continue;
      }
      if (t.type === CTok.COMMENT) {
        take();
        parent.appendChild(new Comment(t.text, t.start, t.end));
        continue;
      }
      if (t.type === CTok.NAME) {
        if (peek(1).type === CTok.EQ) {
          fail('E_SYNTAX', `Attribute '${t.value}' must follow an element name.`, t.start, t.end - t.start, {
            hint: 'Attributes belong to the element written before them on the same statement.',
          });
        }
        parent.appendChild(parseElement());
        continue;
      }
      if (t.type === CTok.LBRACE) fail('E_SYNTAX', "Unexpected '{': a block must follow an element name.", t.start, 1);
      if (t.type === CTok.STRING || t.type === CTok.ID || t.type === CTok.REF) {
        fail('E_SYNTAX', 'Expected an element name.', t.start, t.end - t.start);
      }
      fail('E_SYNTAX', 'Unexpected token.', t.start, Math.max(1, t.end - t.start));
    }
  }

  function parseElement() {
    const t = take();
    const el = new Element(t.value, t.start);
    el.nameStart = t.start;
    el.nameEnd = t.end;
    parseHeader(el);
    el.end = el.openEnd;
    if (peek().type === CTok.LBRACE) {
      const open = take();
      el.selfClosing = false;
      parseStatements(el, open);
    } else {
      el.selfClosing = true;
    }
    return el;
  }

  const leading = [];
  while (peek().type === CTok.COMMENT || peek().type === CTok.SEMI) {
    const c = take();
    if (c.type === CTok.COMMENT) leading.push(new Comment(c.text, c.start, c.end));
  }
  const first = peek();
  if (first.type === CTok.EOF) fail('E_EMPTY_DOCUMENT', "Empty document: expected 'es3d version=1'.", first.start, 0);
  if (first.type !== CTok.NAME || !ROOT_NAMES.has(first.value)) {
    fail('E_COMPACT_ROOT', "An ES3D compact document must start with the root element 'es3d'.", first.start, Math.max(1, first.end - first.start), {
      hint: "Begin the file with: es3d version=1",
    });
  }
  const rt = take();
  const root = new Element(rt.value, rt.start);
  root.nameStart = rt.start;
  root.nameEnd = rt.end;
  parseHeader(root);
  root.end = root.openEnd;
  const trailing = [];
  if (peek().type === CTok.LBRACE) {
    const open = take();
    root.selfClosing = false;
    parseStatements(root, open);
    for (;;) {
      const t = peek();
      if (t.type === CTok.EOF) break;
      if (t.type === CTok.COMMENT) {
        take();
        trailing.push(new Comment(t.text, t.start, t.end));
      } else if (t.type === CTok.SEMI) take();
      else fail('E_MULTIPLE_ROOTS', 'Content after the end of the root block.', t.start, Math.max(1, t.end - t.start));
    }
  } else {
    // Header form: everything after the root header belongs to the root.
    root.headerForm = true;
    parseStatements(root, null);
    root.selfClosing = root.children.length === 0;
    root.end = text.length;
  }
  const doc = new Document({ root, syntax: 'compact', source: text, leading, trailing });
  doc.lineIndex = lineIndex;
  return doc;
}
