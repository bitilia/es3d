// Tokenizer for the ES3D markup syntax (an XML subset).
//
// A hand written, allocation-light scanner: the parser pulls tokens one at a
// time with next(). Every token carries character offsets so the parser and
// validator can report exact line/column positions and the editor can perform
// lossless text edits.

import { Diagnostic, ES3DError } from './errors.js';

export const Tok = Object.freeze({
  OPEN: 'open', // <name
  ATTR: 'attr', // name="value"
  OPEN_END: 'openEnd', // > or />
  CLOSE: 'close', // </name>
  TEXT: 'text',
  COMMENT: 'comment',
  CDATA: 'cdata',
  PI: 'pi', // <?xml ... ?>
  DOCTYPE: 'doctype',
  EOF: 'eof',
});

const LT = 60;
const GT = 62;
const SLASH = 47;
const EQ = 61;
const DQ = 34;
const SQ = 39;
const BANG = 33;
const QM = 63;
const AMP = 38;

function isSpace(c) {
  return c === 32 || c === 10 || c === 9 || c === 13;
}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c > 127;
}

function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46;
}

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode XML entity references; reports bad references with exact offsets. */
export function decodeEntities(raw, baseOffset, fail) {
  if (raw.indexOf('&') < 0) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp < 0) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(';', amp);
    if (semi < 0 || semi - amp > 12) {
      fail('E_BAD_ENTITY', "Unescaped '&'. Write '&amp;' for a literal ampersand.", baseOffset + amp, 1);
    }
    const name = raw.slice(amp + 1, semi);
    let ch;
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        fail('E_BAD_ENTITY', `Invalid character reference '&${name};'.`, baseOffset + amp, semi - amp + 1);
      }
      ch = String.fromCodePoint(code);
    } else {
      ch = NAMED_ENTITIES[name];
      if (ch === undefined) {
        fail('E_BAD_ENTITY', `Unknown entity '&${name};'. Only &lt; &gt; &amp; &quot; &apos; and numeric references are allowed.`, baseOffset + amp, semi - amp + 1);
      }
    }
    out += ch;
    i = semi + 1;
  }
  return out;
}

export class XmlTokenizer {
  constructor(text, lineIndex = null) {
    this.s = text;
    this.i = 0;
    this.inTag = false;
    this.lineIndex = lineIndex;
    this.n = text.length;
    // Skip a UTF-8 byte order mark.
    if (text.charCodeAt(0) === 0xfeff) this.i = 1;
  }

  fail(code, message, offset, length = 1, extra = {}) {
    const d = new Diagnostic({ code, message, offset, length, ...extra });
    d.locate(this.lineIndex);
    throw new ES3DError([d], this.lineIndex);
  }

  next() {
    return this.inTag ? this.nextInTag() : this.nextContent();
  }

  nextContent() {
    const s = this.s;
    const start = this.i;
    if (start >= this.n) return { type: Tok.EOF, start, end: start };
    if (s.charCodeAt(start) !== LT) {
      let end = s.indexOf('<', start);
      if (end < 0) end = this.n;
      this.i = end;
      const raw = s.slice(start, end);
      return { type: Tok.TEXT, raw, text: null, start, end };
    }
    const c1 = s.charCodeAt(start + 1);
    if (c1 === BANG) {
      if (s.startsWith('<!--', start)) {
        const end = s.indexOf('-->', start + 4);
        if (end < 0) this.fail('E_UNTERMINATED_COMMENT', "Unterminated comment: missing '-->'.", start, 4);
        this.i = end + 3;
        return { type: Tok.COMMENT, text: s.slice(start + 4, end), start, end: end + 3 };
      }
      if (s.startsWith('<![CDATA[', start)) {
        const end = s.indexOf(']]>', start + 9);
        if (end < 0) this.fail('E_UNTERMINATED_CDATA', "Unterminated CDATA section: missing ']]>'.", start, 9);
        this.i = end + 3;
        return { type: Tok.CDATA, text: s.slice(start + 9, end), start, end: end + 3 };
      }
      if (s.startsWith('<!DOCTYPE', start) || s.startsWith('<!doctype', start)) {
        const end = s.indexOf('>', start);
        if (end < 0) this.fail('E_UNTERMINATED_DOCTYPE', "Unterminated DOCTYPE: missing '>'.", start, 9);
        this.i = end + 1;
        return { type: Tok.DOCTYPE, start, end: end + 1 };
      }
      this.fail('E_SYNTAX', "Unexpected '<!'. Comments are written <!-- like this -->.", start, 2);
    }
    if (c1 === QM) {
      const end = s.indexOf('?>', start + 2);
      if (end < 0) this.fail('E_UNTERMINATED_PI', "Unterminated processing instruction: missing '?>'.", start, 2);
      this.i = end + 2;
      let j = start + 2;
      while (j < end && isNameChar(s.charCodeAt(j))) j++;
      return { type: Tok.PI, target: s.slice(start + 2, j), start, end: end + 2 };
    }
    if (c1 === SLASH) {
      const nameStart = start + 2;
      let j = nameStart;
      if (!isNameStart(s.charCodeAt(j))) this.fail('E_SYNTAX', "Expected an element name after '</'.", j, 1);
      while (j < this.n && isNameChar(s.charCodeAt(j))) j++;
      const nameEnd = j;
      while (j < this.n && isSpace(s.charCodeAt(j))) j++;
      if (s.charCodeAt(j) !== GT) this.fail('E_SYNTAX', `Expected '>' to finish closing tag </${s.slice(nameStart, nameEnd)}>.`, j, 1);
      this.i = j + 1;
      return { type: Tok.CLOSE, name: s.slice(nameStart, nameEnd), start, end: j + 1, nameStart, nameEnd };
    }
    const nameStart = start + 1;
    if (!isNameStart(c1)) {
      this.fail('E_SYNTAX', "Unexpected '<'. Element names must start with a letter; write '&lt;' for a literal '<'.", start, 1);
    }
    let j = nameStart + 1;
    while (j < this.n && isNameChar(s.charCodeAt(j))) j++;
    this.i = j;
    this.inTag = true;
    return { type: Tok.OPEN, name: s.slice(nameStart, j), start, nameStart, nameEnd: j };
  }

  nextInTag() {
    const s = this.s;
    let i = this.i;
    const hadSpace = i < this.n && isSpace(s.charCodeAt(i));
    while (i < this.n && isSpace(s.charCodeAt(i))) i++;
    if (i >= this.n) this.fail('E_UNEXPECTED_EOF', "Unexpected end of file inside a tag: missing '>'.", i, 0);
    const c = s.charCodeAt(i);
    if (c === GT) {
      this.i = i + 1;
      this.inTag = false;
      return { type: Tok.OPEN_END, selfClosing: false, start: i, end: i + 1 };
    }
    if (c === SLASH) {
      if (s.charCodeAt(i + 1) !== GT) this.fail('E_SYNTAX', "Expected '/>' to close the tag.", i, 1);
      this.i = i + 2;
      this.inTag = false;
      return { type: Tok.OPEN_END, selfClosing: true, start: i, end: i + 2 };
    }
    if (!isNameStart(c)) {
      if (c === DQ || c === SQ) this.fail('E_SYNTAX', 'Unexpected quoted value: an attribute name is missing.', i, 1);
      if (c === LT) this.fail('E_SYNTAX', "Unexpected '<': the previous tag is missing its '>'.", i, 1);
      this.fail('E_SYNTAX', `Unexpected character '${s[i]}' in tag.`, i, 1);
    }
    if (!hadSpace) this.fail('E_SYNTAX', 'Attributes must be separated by whitespace.', i, 1);
    const nameStart = i;
    while (i < this.n && isNameChar(s.charCodeAt(i))) i++;
    const nameEnd = i;
    const name = s.slice(nameStart, nameEnd);
    while (i < this.n && isSpace(s.charCodeAt(i))) i++;
    if (s.charCodeAt(i) !== EQ) {
      this.fail('E_SYNTAX', `Attribute '${name}' has no value. Write ${name}="...".`, nameStart, nameEnd - nameStart);
    }
    i++;
    while (i < this.n && isSpace(s.charCodeAt(i))) i++;
    const q = s.charCodeAt(i);
    if (q !== DQ && q !== SQ) {
      this.fail('E_UNQUOTED_ATTRIBUTE', `The value of attribute '${name}' must be quoted.`, i, 1, { hint: `Write ${name}="value".` });
    }
    const valueStart = i + 1;
    const close = s.indexOf(q === DQ ? '"' : "'", valueStart);
    if (close < 0) {
      this.fail('E_UNTERMINATED_ATTRIBUTE', `Unterminated value for attribute '${name}': missing closing quote.`, i, 1);
    }
    const lt = s.indexOf('<', valueStart);
    if (lt >= 0 && lt < close) {
      this.fail('E_UNTERMINATED_ATTRIBUTE', `Unterminated value for attribute '${name}': found '<' before the closing quote.`, i, 1);
    }
    this.i = close + 1;
    const raw = s.slice(valueStart, close);
    let value = raw;
    let decoded = false;
    if (raw.indexOf('&') >= 0) {
      value = decodeEntities(raw, valueStart, (code, msg, off, len) => this.fail(code, msg, off, len));
      decoded = true;
    }
    return {
      type: Tok.ATTR,
      name,
      nameStart,
      nameEnd,
      value,
      valueStart,
      valueEnd: close,
      quote: q === DQ ? '"' : "'",
      decoded,
    };
  }
}

// keeps the tokenizer's hidden class alive between documents (see MeshBuilder.shapeKeeper)
XmlTokenizer.shapeKeeper = new XmlTokenizer('', null);
