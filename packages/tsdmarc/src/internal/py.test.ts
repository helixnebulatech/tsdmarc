import { describe, expect, it } from 'vitest';

import { pyIntExact, PyValueError } from './py';

// Expected messages were produced by CPython 3.14.
describe('pyIntExact', () => {
  it("applies Python's 4300-digit limit for int(str)", () => {
    expect(pyIntExact('1'.repeat(4300))).toBe(BigInt('1'.repeat(4300)));
    const limit = (digits: number): string =>
      `Exceeds the limit (4300 digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`;
    expect(() => pyIntExact('1'.repeat(4301))).toThrow(limit(4301));
    expect(() => pyIntExact(`-${'1'.repeat(4301)}`)).toThrow(PyValueError);
    // Underscores don't count; leading zeros and surrounding spaces do not
    // help either.
    expect(() => pyIntExact(`${'1_'.repeat(4300)}1`)).toThrow(limit(4301));
    expect(() => pyIntExact(` 000${'0'.repeat(4301)} `)).toThrow(limit(4304));
    expect(() => pyIntExact('١'.repeat(4301))).toThrow(limit(4301));
  });

  it('checks the syntax before the length', () => {
    expect(() => pyIntExact(`${'1'.repeat(4301)}x`)).toThrow(
      `invalid literal for int() with base 10: '${'1'.repeat(199)}`,
    );
  });

  it('cuts the repr in the error message to 200 characters (%.200R)', () => {
    expect(() => pyIntExact('é'.repeat(300))).toThrow(
      new RegExp(
        `^invalid literal for int\\(\\) with base 10: '${'é'.repeat(199)}$`,
        'u',
      ),
    );
    expect(() => pyIntExact('😀'.repeat(300))).toThrow(
      new RegExp(
        `^invalid literal for int\\(\\) with base 10: '${'😀'.repeat(199)}$`,
        'u',
      ),
    );
    expect(() => pyIntExact('abc')).toThrow(
      "invalid literal for int() with base 10: 'abc'",
    );
  });
});
