// Tokenizer for the ES3D compact syntax ("ES3D-C").
//
//   es3d version=1
//   material#red c=#e53935
//   box s=2 m=red
//   group p=0,2,0 { sphere r=1 }
//   use @tree p=10,0,5
//
// Newlines are insignificant: an element header ends where the next token is
// not an attribute (NAME '='), so the grammar is LL(2) and needs no schema.

import { Diagnostic, ES3DError } from './errors.js';

export const CTok = Object.freeze({
  NAME: 'name',
  ID: 'id', // #name
  REF: 'ref', // @name
  EQ: 'eq',
  VALUE: 'value', // bare or quoted attribute value
  STRING: 'string', // quoted text content in header position
  LBRACE: 'lbrace',
  RBRACE: 'rbrace',
  SEMI: 'semi',
  COMMENT: 'comment',
  EOF: 'eof',
});

function isSpace(c) {
  return c === 32 || c === 10 || c === 9 || c === 13;
}
function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 58;
}
// characters that terminate a bare value
function isValueStop(c) {
  return isSpace(c) || c === 123 || c === 125 || c === 59 || c === 34;
}

export class CompactTokenizer {
  constructor(text, lineIndex = null) {
    this.s = text;
    this.n = text.length;
    this.i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    this.lineIndex = lineIndex;
    this.afterEq = false;
  }

  fail(code, message, offset, length = 1, extra = {}) {
    const d = new Diagnostic({ code, message, offset, length, ...extra });
    d.locate(this.lineIndex);
    throw new ES3DError([d], this.lineIndex);
  }

  readQuoted(start) {
    const s = this.s;
    let i = start + 1;
    let out = '';
    let segStart = i;
    for (;;) {
      if (i >= this.n) this.fail('E_UNTERMINATED_STRING', 'Unterminated string: missing closing quote.', start, 1);
      const c = s.charCodeAt(i);
      if (c === 34) break;
      if (c === 92) {
        out += s.slice(segStart, i);
        const e = s[i + 1];
        if (e === '"' || e === '\\') out += e;
        else if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else this.fail('E_BAD_ESCAPE', `Unknown escape sequence '\\${e ?? ''}'. Use \\" \\\\ \\n or \\t.`, i, 2);
        i += 2;
        segStart = i;
        continue;
      }
      i++;
    }
    out += s.slice(segStart, i);
    return { value: out, end: i + 1, escaped: segStart !== start + 1 };
  }

  next() {
    const s = this.s;
    let i = this.i;
    while (i < this.n && isSpace(s.charCodeAt(i))) i++;
    if (i >= this.n) {
      this.i = i;
      if (this.afterEq) this.fail('E_MISSING_VALUE', "Expected a value after '='.", i, 0);
      return { type: CTok.EOF, start: i, end: i };
    }
    const c = s.charCodeAt(i);
    const start = i;

    if (this.afterEq) {
      this.afterEq = false;
      if (c === 34) {
        const q = this.readQuoted(i);
        this.i = q.end;
        return { type: CTok.VALUE, value: q.value, start, end: q.end, valueStart: start + 1, valueEnd: q.end - 1, quote: '"', escaped: q.escaped };
      }
      if (c === 123 || c === 125 || c === 59) this.fail('E_MISSING_VALUE', "Expected a value after '='.", i, 1);
      while (i < this.n && !isValueStop(s.charCodeAt(i))) i++;
      this.i = i;
      return { type: CTok.VALUE, value: s.slice(start, i), start, end: i, valueStart: start, valueEnd: i, quote: '' };
    }

    // comments
    if (c === 47) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 === 47) {
        let end = s.indexOf('\n', i);
        if (end < 0) end = this.n;
        this.i = end;
        return { type: CTok.COMMENT, text: s.slice(i + 2, end).replace(/\r$/, ''), start, end, line: true };
      }
      if (c2 === 42) {
        const end = s.indexOf('*/', i + 2);
        if (end < 0) this.fail('E_UNTERMINATED_COMMENT', "Unterminated comment: missing '*/'.", i, 2);
        this.i = end + 2;
        return { type: CTok.COMMENT, text: s.slice(i + 2, end), start, end: end + 2, line: false };
      }
    }
    switch (c) {
      case 123:
        this.i = i + 1;
        return { type: CTok.LBRACE, start, end: i + 1 };
      case 125:
        this.i = i + 1;
        return { type: CTok.RBRACE, start, end: i + 1 };
      case 59:
        this.i = i + 1;
        return { type: CTok.SEMI, start, end: i + 1 };
      case 61:
        this.i = i + 1;
        this.afterEq = true;
        return { type: CTok.EQ, start, end: i + 1 };
      case 34: {
        const q = this.readQuoted(i);
        this.i = q.end;
        return { type: CTok.STRING, value: q.value, start, end: q.end, valueStart: start + 1, valueEnd: q.end - 1 };
      }
      case 35: // #id
      case 64: {
        // @ref
        let j = i + 1;
        if (!isNameStart(s.charCodeAt(j))) {
          this.fail('E_SYNTAX', c === 35 ? "Expected an id after '#'." : "Expected a reference id after '@'.", i, 1);
        }
        while (j < this.n && isNameChar(s.charCodeAt(j))) j++;
        this.i = j;
        return { type: c === 35 ? CTok.ID : CTok.REF, value: s.slice(i + 1, j), start, end: j };
      }
      default:
        break;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < this.n && isNameChar(s.charCodeAt(j))) j++;
      this.i = j;
      return { type: CTok.NAME, value: s.slice(i, j), start, end: j };
    }
    this.fail('E_SYNTAX', `Unexpected character '${s[i]}'.`, i, 1);
  }
}
