import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, parseNumberList } from '../src/format/values.js';
import { readNumber, numberValue, scanNumber, parsePathData } from '../src/path/path-parser.js';

// readNumber turns digits into a value without a substring; it must give the
// same binary64 value as Number() for everything the number grammar accepts.
const parse = (s) => {
  assert.equal(scanNumber(s, 0), s.length, `scanNumber accepts ${s}`);
  assert.equal(readNumber(s, 0), s.length, `readNumber accepts ${s}`);
  const v = numberValue;
  const list = parseNumberList(` ${s},${s} `);
  assert.ok(list.length === 2 && Object.is(list[0], v) && Object.is(list[1], v), `list of ${s}`);
  assert.ok(Object.is(parseNumber(s), v), `single ${s}`);
  return v;
};

test('readNumber matches Number() on edge cases', () => {
  const cases = ['0', '-0', '+0', '-0.0', '.5', '-.5', '5.', '1e5', '1E-5', '1e+22', '1e23', '1e-22', '1e-23', '0.1', '0.3', '123456789012345', '1234567890123456',
    '9007199254740993', '0.000001', '-1.5e-7', '00012.500', '1e400', '-1e400', '1e-400', '4.9e-324', '1.7976931348623157e308', '12345.6789e-3', '100e-2', '999999999999999.9', '0.1e1'];
  for (const s of cases) assert.ok(Object.is(parse(s), Number(s)), s);
});

test('readNumber matches Number() on random decimals (deterministic)', () => {
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let k = 0; k < 100000; k++) {
    const intDigits = Math.floor(rnd() * 9), fracDigits = Math.floor(rnd() * 14);
    let s = rnd() < 0.5 ? '-' : '';
    for (let d = 0; d < intDigits; d++) s += Math.floor(rnd() * 10);
    if (fracDigits || !intDigits) {
      s += '.';
      for (let d = 0; d < Math.max(1, fracDigits); d++) s += Math.floor(rnd() * 10);
    }
    if (rnd() < 0.2) s += 'e' + (rnd() < 0.5 ? '-' : '') + Math.floor(rnd() * 30);
    const a = parse(s), b = Number(s);
    if (!Object.is(a, b)) assert.fail(`${s}: ${a} !== ${b}`);
  }
});

test('number lists keep their values and errors', () => {
  assert.deepEqual(parseNumberList('1, -2.5 3e2 .25'), [1, -2.5, 300, 0.25]);
  assert.throws(() => parseNumberList('1, x'), /Expected a number/);
  assert.throws(() => parseNumberList('1,'), /Trailing comma/);
  assert.throws(() => parseNumberList('1e5x'), /Expected a separator/);
  assert.throws(() => parseNumberList('1.5.5'), /Expected a separator/);
  assert.throws(() => parseNumberList('1e 2'), /Expected a separator/);
  // an "e" without exponent digits ends the number
  assert.equal(readNumber('2e+', 0), 1);
  assert.equal(numberValue, 2);
  assert.equal(readNumber('-.', 0), -1);
  // longer than the shared buffer: the list grows and keeps every value
  const long = Array.from({ length: 10000 }, (_, i) => `${i}.5`).join(' ');
  const values = parseNumberList(long);
  assert.equal(values.length, 10000);
  assert.ok(values.every((v, i) => v === i + 0.5));
  // path data reads its numbers the same way
  const p = parsePathData('M0.1 0.2L1e-3,-4.25');
  assert.deepEqual([p.segments[0].x, p.segments[0].y], [0.1, 0.2]);
});
