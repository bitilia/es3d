// Diagnostics: every problem found while reading an ES3D document is reported
// as a Diagnostic with a precise source location, a human readable message and,
// where possible, a "did you mean" suggestion. Nothing is silently ignored.

/** Maps character offsets to 1-based line/column pairs. */
export class LineIndex {
  constructor(text) {
    this.text = text;
    this.lineStarts = null;
  }

  /** Offset of every line start, found on first use: a valid document never asks. */
  get starts() {
    if (!this.lineStarts) {
      const starts = [0];
      for (let i = this.text.indexOf('\n'); i >= 0; i = this.text.indexOf('\n', i + 1)) starts.push(i + 1);
      this.lineStarts = starts;
    }
    return this.lineStarts;
  }

  position(offset) {
    const starts = this.starts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  }

  lineText(line) {
    const start = this.starts[line - 1];
    if (start === undefined) return '';
    const end = line < this.starts.length ? this.starts[line] - 1 : this.text.length;
    return this.text.slice(start, end).replace(/\r$/, '');
  }

  offsetOf(line, column) {
    const start = this.starts[Math.max(0, Math.min(line - 1, this.starts.length - 1))];
    return start + column - 1;
  }
}

const PHASE_TITLES = {
  parse: 'Parse',
  reference: 'Reference',
  geometry: 'Geometry',
  render: 'Render',
  io: 'File',
};

export class Diagnostic {
  /**
   * @param {object} o
   * @param {'error'|'warning'|'info'} [o.severity]
   * @param {'parse'|'reference'|'geometry'|'render'|'io'} [o.phase]
   * @param {string} o.code       stable machine readable code, e.g. E_UNKNOWN_ATTRIBUTE
   * @param {string} o.message    human readable message
   * @param {number} [o.offset]   character offset of the problem in the source text
   * @param {number} [o.length]   length of the offending text
   * @param {string} [o.suggestion] "Did you mean" candidate
   * @param {string} [o.hint]     extra explanation
   * @param {string} [o.path]     structural path when no offsets exist (JSON / binary input)
   */
  constructor(o) {
    this.severity = o.severity || 'error';
    this.phase = o.phase || 'parse';
    this.code = o.code || 'E_GENERIC';
    this.message = o.message;
    this.offset = o.offset ?? -1;
    this.length = o.length ?? 0;
    this.suggestion = o.suggestion || null;
    this.hint = o.hint || null;
    this.path = o.path || null;
    this.line = o.line ?? 0;
    this.column = o.column ?? 0;
    this.uid = o.uid ?? 0;
  }

  /** Resolve line/column from an offset using the given LineIndex. */
  locate(lineIndex) {
    if (lineIndex && this.offset >= 0) {
      const p = lineIndex.position(this.offset);
      this.line = p.line;
      this.column = p.column;
    }
    return this;
  }

  get title() {
    const phase = PHASE_TITLES[this.phase] || 'Parse';
    return this.severity === 'warning' ? `ES3D ${phase} Warning` : this.severity === 'info' ? `ES3D ${phase} Note` : `ES3D ${phase} Error`;
  }

  /** Multi-line report in the canonical ES3D format, optionally with a code frame. */
  format(lineIndex) {
    const lines = [this.title];
    if (this.line > 0) lines.push(`line ${this.line}, column ${this.column}`);
    else if (this.path) lines.push(`at ${this.path}`);
    lines.push('', this.message);
    if (this.suggestion) lines.push('', `Did you mean: ${this.suggestion}?`);
    if (this.hint) lines.push('', this.hint);
    if (lineIndex && this.line > 0) {
      const src = lineIndex.lineText(this.line);
      if (src.length < 400) {
        const gutter = String(this.line).padStart(5) + ' | ';
        const caretLen = Math.max(1, Math.min(this.length || 1, src.length - this.column + 1));
        lines.push('', gutter + src, ' '.repeat(gutter.length + this.column - 1) + '^'.repeat(Math.max(1, caretLen)));
      }
    }
    return lines.join('\n');
  }

  toJSON() {
    return {
      severity: this.severity,
      phase: this.phase,
      code: this.code,
      message: this.message,
      line: this.line,
      column: this.column,
      offset: this.offset,
      length: this.length,
      suggestion: this.suggestion,
      hint: this.hint,
      path: this.path,
    };
  }
}

/** Thrown when a document cannot be read at all (syntax errors). */
export class ES3DError extends Error {
  constructor(diagnostics, lineIndex) {
    const list = Array.isArray(diagnostics) ? diagnostics : [diagnostics];
    super(list.length ? list[0].format(lineIndex) : 'ES3D Error');
    this.name = 'ES3DError';
    this.diagnostics = list;
  }
}

/** Damerau-free Levenshtein distance with an early-exit bound. */
export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb];
}

/**
 * Best "did you mean" candidate for a misspelled name, or null.
 * Case-insensitive matches and transposition-like typos are preferred.
 */
export function suggest(name, candidates) {
  if (!name) return null;
  const lower = name.toLowerCase();
  let best = null;
  let bestScore = Infinity;
  const limit = Math.max(1, Math.min(3, Math.floor(name.length / 3) + 1));
  for (const c of candidates) {
    if (!c) continue;
    const cl = c.toLowerCase();
    if (cl === lower) return c;
    let d = levenshtein(lower, cl, limit);
    // A swapped pair of adjacent letters counts as one edit ("raduis" -> "radius").
    if (d === 2 && lower.length === cl.length && isTransposition(lower, cl)) d = 1;
    // Prefix matches are useful for abbreviations ("rough" -> "roughness")
    // and for over-long names ("spotlight" -> "spot").
    if (d > limit && ((cl.startsWith(lower) && lower.length >= 3) || (lower.startsWith(cl) && cl.length >= 3))) d = limit;
    if (d <= limit && d < bestScore) {
      best = c;
      bestScore = d;
    }
  }
  return best;
}

function isTransposition(a, b) {
  let first = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (first < 0) first = i;
      else return i === first + 1 && a[first] === b[i] && a[i] === b[first] && a.slice(i + 1) === b.slice(i + 1);
    }
  }
  return false;
}

/** Collects diagnostics during a pass; keeps errors and warnings ordered by position. */
export class DiagnosticList {
  constructor(lineIndex = null) {
    this.lineIndex = lineIndex;
    this.items = [];
  }

  add(o) {
    const d = o instanceof Diagnostic ? o : new Diagnostic(o);
    d.locate(this.lineIndex);
    this.items.push(d);
    return d;
  }

  error(code, message, offset, length, extra = {}) {
    return this.add({ severity: 'error', code, message, offset, length, ...extra });
  }

  warning(code, message, offset, length, extra = {}) {
    return this.add({ severity: 'warning', code, message, offset, length, ...extra });
  }

  get errors() {
    return this.items.filter((d) => d.severity === 'error');
  }

  get warnings() {
    return this.items.filter((d) => d.severity === 'warning');
  }

  get hasErrors() {
    return this.items.some((d) => d.severity === 'error');
  }

  sorted() {
    return [...this.items].sort((a, b) => (a.offset - b.offset) || (a.severity === 'error' ? -1 : 1));
  }
}
