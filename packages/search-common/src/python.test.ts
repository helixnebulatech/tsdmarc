// Python's int() and truthiness as the DSL's field cleaning applies them.

import { describe, expect, it } from 'vitest';

import {
  markLongIntegers,
  pyBool,
  pyInt,
  restoreLongIntegers,
  ValueError,
} from './python';

describe('pyInt', () => {
  it('converts the values reports carry', () => {
    expect(pyInt('42')).toBe(42);
    expect(pyInt(' -7 ')).toBe(-7);
    expect(pyInt('1_000')).toBe(1000);
    expect(pyInt(3.9)).toBe(3);
    expect(pyInt(true)).toBe(1);
  });

  it('is exact beyond 2^53, like Python ints', () => {
    expect(pyInt('99999999999999999999')).toBe(99_999_999_999_999_999_999n);
    expect(pyInt(99_999_999_999_999_999_999n)).toBe(
      99_999_999_999_999_999_999n,
    );
    expect(pyInt(5n)).toBe(5);
  });

  it('raises ValueError like Python', () => {
    expect(() => pyInt('x')).toThrow(
      new ValueError("invalid literal for int() with base 10: 'x'"),
    );
    expect(() => pyInt(Number.POSITIVE_INFINITY)).toThrow(
      'cannot convert float infinity to integer',
    );
    expect(() => pyInt(Number.NaN)).toThrow(
      'cannot convert float NaN to integer',
    );
  });
});

describe('pyBool', () => {
  it('treats 0n as false and other bigints as true', () => {
    expect(pyBool(0n)).toBe(false);
    expect(pyBool(99_999_999_999_999_999_999n)).toBe(true);
  });
});

describe('markLongIntegers / restoreLongIntegers', () => {
  function parse(text: string): unknown {
    return restoreLongIntegers(JSON.parse(markLongIntegers(text)));
  }

  it('keeps integers beyond 2^53 exact, at any depth', () => {
    expect(parse('{"a":[9007199254740993,{"b":-9007199254740993}]}')).toEqual({
      a: [9_007_199_254_740_993n, { b: -9_007_199_254_740_993n }],
    });
  });

  it('leaves 16-digit integers a double can hold as numbers', () => {
    expect(parse('[1234567890123456]')).toEqual([1_234_567_890_123_456]);
  });

  it.each([
    '{"a":"9007199254740993"}',
    '{"a":"x\\":9007199254740993,"}',
    '{"a":1.2345678901234567}',
    '{"a":1e1234567890123456}',
    '{"9007199254740993":1}',
  ])('leaves %s alone', text => {
    expect(markLongIntegers(text)).toBe(text);
  });

  it('keeps a __proto__ key as an own property', () => {
    const value = parse('{"__proto__":{"a":9007199254740993}}') as object;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(['__proto__']);
  });

  it('scans a long string in linear time', () => {
    const text = `{"a":"${'x'.repeat(20_000_000)}"}`;
    expect(markLongIntegers(text)).toBe(text);
  });
});
