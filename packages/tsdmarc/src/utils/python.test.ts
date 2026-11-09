import { describe, expect, it } from 'vitest';

import { pyFloatRepr, pyRepr, pyStr } from './python';

// Expected strings were produced by CPython 3.14.
describe('Python str/repr', () => {
  it('formats floats like repr(float)', () => {
    const cases: [number, string][] = [
      [1, '1.0'],
      [0.1, '0.1'],
      [1e-5, '1e-05'],
      [1e16, '1e+16'],
      [123_456_789_012_345.6, '123456789012345.6'],
      [2.5e-7, '2.5e-07'],
      [-0, '-0.0'],
      [Number.POSITIVE_INFINITY, 'inf'],
      [1 / 3, '0.3333333333333333'],
    ];
    for (const [value, expected] of cases) {
      expect(pyFloatRepr(value)).toBe(expected);
    }
  });

  it('formats containers and strings like repr()', () => {
    expect(pyRepr(['a', "it's", null, true, { k: 1 }])).toBe(
      `['a', "it's", None, True, {'k': 1}]`,
    );
    expect(pyRepr('say "x"')).toBe(`'say "x"'`);
    expect(pyRepr(`both ' "`)).toBe(`'both \\' "'`);
  });

  it('picks fixed or exponent notation from the shortest digits', () => {
    expect(pyFloatRepr(9_999_999_999_999_998)).toBe('9999999999999998.0');
    expect(pyFloatRepr(1e16)).toBe('1e+16');
    expect(pyFloatRepr(9.999_999_999_999_999e-5)).toBe('9.999999999999999e-05');
    expect(pyFloatRepr(0.0001)).toBe('0.0001');
    expect(pyFloatRepr(1.5e300)).toBe('1.5e+300');
    expect(pyFloatRepr(2 ** 70)).toBe('1.1805916207174113e+21');
  });

  it('prints large integers with every digit like str(int)', () => {
    expect(pyStr(1e21)).toBe('1000000000000000000000');
    expect(pyStr(2 ** 70)).toBe('1180591620717411303424');
  });

  it('escapes non-printable characters like repr(str)', () => {
    // Expected text from repr() of the same string in CPython 3.14.
    const input = String.fromCodePoint(
      0x61,
      0x00,
      0x62,
      0x1b,
      0x5b,
      0x33,
      0x31,
      0x6d,
      0x20_0b,
      0x7f,
      0x85,
      0xa0,
      0x20_28,
      0xd8_00,
      0x20,
      0x1_f6_00,
      0xe_00_01,
    );
    expect(pyRepr(input)).toBe(
      "'a\\x00b\\x1b[31m\\u200b\\x7f\\x85\\xa0\\u2028\\ud800 \u{1F600}\\U000e0001'",
    );
  });

  it('formats scalars like str()', () => {
    expect(pyStr(true)).toBe('True');
    expect(pyStr(null)).toBe('None');
    expect(pyStr(15_169)).toBe('15169');
    expect(pyStr(0.5)).toBe('0.5');
    expect(pyStr('text')).toBe('text');
  });
});

describe('null-prototype objects (parsed XML)', () => {
  it('prints them like a Python dict', () => {
    const value = Object.assign(Object.create(null) as object, {
      '#text': 'x',
      '@lang': 'en',
    });
    expect(pyStr(value)).toBe("{'#text': 'x', '@lang': 'en'}");
    expect(pyRepr([value])).toBe("[{'#text': 'x', '@lang': 'en'}]");
  });

  it('prints nesting deeper than the call stack', () => {
    const depth = 50_000;
    let value: unknown = 'v';
    for (let level = 0; level < depth; level += 1) {
      value = level % 2 === 0 ? { x: value, n: null } : [1, value, new Map()];
    }
    expect(pyRepr(value)).toBe(
      `${"[1, {'x': ".repeat(depth / 2)}'v'${", 'n': None}, {}]".repeat(depth / 2)}`,
    );
  });
});
