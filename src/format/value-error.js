/** Error raised by attribute value parsers; offsets are relative to the attribute value. */
export class ValueError extends Error {
  constructor(message, offset = 0, length = 0, extra = {}) {
    super(message);
    this.name = 'ValueError';
    this.offset = offset;
    this.length = length;
    this.hint = extra.hint || null;
    this.suggestion = extra.suggestion || null;
    this.code = extra.code || null;
  }
}
