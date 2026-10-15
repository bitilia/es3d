// Parser for the ES3D markup syntax: tokens -> AST (Document of Elements).

import { Attr, Comment, Document, Element } from './ast.js';
import { Diagnostic, ES3DError, LineIndex } from './errors.js';
import { Tok, XmlTokenizer, decodeEntities } from './xml-tokenizer.js';

function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 10 && c !== 9 && c !== 13) return false;
  }
  return true;
}

export function parseXml(text, lineIndex = new LineIndex(text)) {
  const tz = new XmlTokenizer(text, lineIndex);
  const fail = (code, message, offset, length = 1, extra = {}) => {
    const d = new Diagnostic({ code, message, offset, length, ...extra });
    d.locate(lineIndex);
    throw new ES3DError([d], lineIndex);
  };
  const where = (offset) => {
    const p = lineIndex.position(offset);
    return `line ${p.line}, column ${p.column}`;
  };

  const stack = [];
  let root = null;
  const leading = [];
  const trailing = [];

  for (;;) {
    const t = tz.next();
    switch (t.type) {
      case Tok.EOF: {
        if (stack.length) {
          const open = stack[stack.length - 1];
          fail('E_UNCLOSED_ELEMENT', `Unclosed element <${open.name}> (opened at ${where(open.start)}).`, open.start, open.nameEnd - open.start, {
            hint: `Add </${open.name}> or write <${open.name} ... /> for an element without children.`,
          });
        }
        if (!root) fail('E_EMPTY_DOCUMENT', 'Empty document: expected an <es3d> root element.', t.start, 0);
        const doc = new Document({ root, syntax: 'xml', source: text, leading, trailing });
        doc.lineIndex = lineIndex;
        return doc;
      }
      case Tok.PI:
        if (root || stack.length) fail('E_SYNTAX', 'Processing instructions (<?...?>) are only allowed before the root element.', t.start, 2);
        break;
      case Tok.DOCTYPE:
        if (root || stack.length) fail('E_SYNTAX', 'A DOCTYPE is only allowed before the root element.', t.start, 2);
        break;
      case Tok.COMMENT: {
        const c = new Comment(t.text, t.start, t.end);
        if (stack.length) stack[stack.length - 1].appendChild(c);
        else if (root) trailing.push(c);
        else leading.push(c);
        break;
      }
      case Tok.TEXT:
      case Tok.CDATA: {
        const raw = t.type === Tok.TEXT ? t.raw : t.text;
        if (isBlank(raw)) break;
        if (!stack.length) {
          let k = t.start;
          while (k < t.end && /\s/.test(text[k])) k++;
          fail('E_TEXT_OUTSIDE_ROOT', 'Text is not allowed outside the root element.', k, 1);
        }
        const el = stack[stack.length - 1];
        const value = t.type === Tok.TEXT ? decodeEntities(raw, t.start, (code, msg, off, len) => fail(code, msg, off, len)) : raw;
        if (el.text === null) {
          el.text = value;
          el.textStart = t.start;
        } else {
          el.text += value;
        }
        el.textEnd = t.end;
        break;
      }
      case Tok.OPEN: {
        if (!stack.length && root) {
          fail('E_MULTIPLE_ROOTS', `Only one root element is allowed; found a second root <${t.name}>.`, t.start, t.nameEnd - t.start);
        }
        const el = new Element(t.name, t.start);
        el.nameStart = t.nameStart;
        el.nameEnd = t.nameEnd;
        let a = tz.next();
        while (a.type === Tok.ATTR) {
          for (const prev of el.attrs) {
            if (prev.name === a.name) {
              fail('E_DUPLICATE_ATTRIBUTE', `Duplicate attribute '${a.name}' on <${el.name}>.`, a.nameStart, a.nameEnd - a.nameStart);
            }
          }
          const attr = new Attr(a.name, a.value, a.nameStart, a.nameEnd, a.valueStart, a.valueEnd, a.quote);
          attr.decoded = a.decoded;
          el.attrs.push(attr);
          a = tz.next();
        }
        // a is OPEN_END (the tokenizer throws on anything else)
        el.openEnd = a.end;
        if (stack.length) stack[stack.length - 1].appendChild(el);
        else root = el;
        if (a.selfClosing) {
          el.selfClosing = true;
          el.end = a.end;
        } else {
          el.selfClosing = false;
          stack.push(el);
        }
        break;
      }
      case Tok.CLOSE: {
        if (!stack.length) {
          fail('E_UNEXPECTED_CLOSE', `Unexpected closing tag </${t.name}>: no element is open.`, t.start, t.end - t.start);
        }
        const open = stack[stack.length - 1];
        if (open.name !== t.name) {
          const deeper = stack.findIndex((e) => e.name === t.name);
          fail(
            'E_MISMATCHED_TAG',
            `Mismatched closing tag: expected </${open.name}> (opened at ${where(open.start)}) but found </${t.name}>.`,
            t.start,
            t.end - t.start,
            deeper >= 0 ? { hint: `<${open.name}> is not closed before </${t.name}>.` } : {},
          );
        }
        stack.pop();
        open.closeStart = t.start;
        open.end = t.end;
        break;
      }
      default:
        fail('E_SYNTAX', 'Unexpected token.', t.start, 1);
    }
  }
}
