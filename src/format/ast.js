// The ES3D abstract syntax tree.
//
// Every surface syntax (markup, compact, JSON, binary) produces the same tree of
// Element / Comment nodes. Attribute values stay as raw strings in the AST so a
// document can be round-tripped losslessly; typed values are attached by the
// validator in `element.values` (keyed by canonical attribute name).

export class Attr {
  constructor(name, value, nameStart = -1, nameEnd = -1, valueStart = -1, valueEnd = -1, quote = '"') {
    this.name = name;
    this.value = value;
    this.nameStart = nameStart;
    this.nameEnd = nameEnd;
    this.valueStart = valueStart;
    this.valueEnd = valueEnd;
    this.quote = quote;
    /** true when the raw value contained entity references (offsets inside the value are approximate) */
    this.decoded = false;
    /** pre-parsed typed value supplied by a decoder (the validator then skips parsing the text) */
    this.typed = undefined;
  }
}

/**
 * Attribute whose typed value is known and whose text is produced on demand
 * (binary decoding of large arrays: formatting a mesh as text only to parse
 * it again would dominate the load time). Assigning a new text value drops
 * the typed value.
 */
export class LazyAttr extends Attr {
  constructor(name, typed, format) {
    super(name, null);
    this.typed = typed;
    this.format = format;
  }

  get value() {
    if (this._value === null) this._value = this.format();
    return this._value;
  }

  set value(v) {
    this._value = v;
    if (v !== null) this.typed = undefined;
  }
}

export class Comment {
  constructor(text, start = -1, end = -1) {
    this.type = 'comment';
    this.text = text;
    this.start = start;
    this.end = end;
    this.parent = null;
  }
}

export class Element {
  constructor(name, start = -1) {
    this.type = 'element';
    this.name = name;
    /** @type {Attr[]} */
    this.attrs = [];
    /** @type {(Element|Comment)[]} */
    this.children = [];
    this.text = null;
    this.textStart = -1;
    this.textEnd = -1;
    this.start = start;
    this.end = start;
    this.nameStart = start;
    this.nameEnd = start;
    this.openEnd = start;
    this.closeStart = -1;
    this.selfClosing = true;
    this.uid = 0;
    this.parent = null;
    /** canonical name -> typed value (set by the validator) */
    this.values = null;
    /** canonical name -> Attr (set by the validator) */
    this.attrIndex = null;
  }

  attr(name) {
    for (let i = 0; i < this.attrs.length; i++) if (this.attrs[i].name === name) return this.attrs[i].value;
    return undefined;
  }

  attrNode(name) {
    for (let i = 0; i < this.attrs.length; i++) if (this.attrs[i].name === name) return this.attrs[i];
    return null;
  }

  setAttr(name, value) {
    const a = this.attrNode(name);
    if (a) a.value = String(value);
    else this.attrs.push(new Attr(name, String(value)));
    return this;
  }

  removeAttr(name) {
    const i = this.attrs.findIndex((a) => a.name === name);
    if (i >= 0) this.attrs.splice(i, 1);
    return this;
  }

  appendChild(node) {
    node.parent = this;
    this.children.push(node);
    this.selfClosing = false;
    return node;
  }

  get elementChildren() {
    return this.children.filter((c) => c.type === 'element');
  }

  /** The canonical id of this element, if any. */
  get id() {
    return this.values && this.values.id !== undefined ? this.values.id : this.attr('id');
  }
}

export class Document {
  constructor({ root, syntax, source = null, leading = [], trailing = [] }) {
    /** @type {Element} */
    this.root = root;
    /** 'xml' | 'compact' | 'json' | 'binary' */
    this.syntax = syntax;
    this.source = source;
    /** comments before / after the root element */
    this.leading = leading;
    this.trailing = trailing;
    this.lineIndex = null;
    this.diagnostics = [];
    /** id -> Element (set by the validator) */
    this.ids = new Map();
    /** uid -> Element */
    this.byUid = new Map();
    this.elementCount = 0;
  }

  get errors() {
    return this.diagnostics.filter((d) => d.severity === 'error');
  }

  get warnings() {
    return this.diagnostics.filter((d) => d.severity === 'warning');
  }

  get ok() {
    return !this.diagnostics.some((d) => d.severity === 'error');
  }
}

/** Depth-first pre-order traversal of elements. Return false from fn to skip children. */
export function walk(el, fn, parent = null, depth = 0) {
  if (fn(el, parent, depth) === false) return;
  const kids = el.children;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.type === 'element') walk(c, fn, el, depth + 1);
  }
}

/** Assign sequential uids and parent links; returns the number of elements. */
export function indexTree(doc) {
  let uid = 0;
  doc.byUid.clear();
  const visit = (el, parent) => {
    el.uid = ++uid;
    el.parent = parent;
    doc.byUid.set(el.uid, el);
    for (const c of el.children) {
      if (c.type === 'element') visit(c, el);
      else c.parent = el;
    }
  };
  if (doc.root) visit(doc.root, null);
  doc.elementCount = uid;
  return uid;
}

/** Deep copy of an element subtree without source positions or typed values. */
export function cloneElement(el, keepPositions = false) {
  const copy = new Element(el.name, keepPositions ? el.start : -1);
  for (const a of el.attrs) {
    copy.attrs.push(keepPositions ? Object.assign(new Attr(a.name, a.value), a) : new Attr(a.name, a.value));
  }
  copy.text = el.text;
  copy.selfClosing = el.selfClosing;
  for (const c of el.children) {
    if (c.type === 'element') copy.appendChild(cloneElement(c, keepPositions));
    else copy.appendChild(new Comment(c.text));
  }
  copy.selfClosing = el.children.length === 0;
  return copy;
}

/** Convenience constructor: h('box', {size: '2'}, ...children) */
export function h(name, attrs = {}, ...children) {
  const el = new Element(name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    el.attrs.push(new Attr(k, String(v)));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === 'string') el.text = (el.text || '') + c;
    else el.appendChild(c);
  }
  el.selfClosing = el.children.length === 0 && el.text === null;
  return el;
}

/** Structural equality of two subtrees (names, attributes, text, element children). */
export function treesEqual(a, b, { ignoreComments = true, attrOrder = false } = {}) {
  if (a.name !== b.name) return false;
  if ((a.text || '').trim() !== (b.text || '').trim()) return false;
  if (a.attrs.length !== b.attrs.length) return false;
  if (attrOrder) {
    for (let i = 0; i < a.attrs.length; i++) {
      if (a.attrs[i].name !== b.attrs[i].name || a.attrs[i].value !== b.attrs[i].value) return false;
    }
  } else {
    for (const at of a.attrs) if (b.attr(at.name) !== at.value) return false;
  }
  const ka = ignoreComments ? a.children.filter((c) => c.type === 'element') : a.children;
  const kb = ignoreComments ? b.children.filter((c) => c.type === 'element') : b.children;
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i].type !== kb[i].type) return false;
    if (ka[i].type === 'comment') {
      if (ka[i].text !== kb[i].text) return false;
    } else if (!treesEqual(ka[i], kb[i], { ignoreComments, attrOrder })) return false;
  }
  return true;
}
