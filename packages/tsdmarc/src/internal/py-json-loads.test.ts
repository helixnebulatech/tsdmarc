import { describe, expect, it } from 'vitest';

import { cpuMsSince, cpuStart } from '../test/cpu-time';
import cases from './__fixtures__/py-json-loads.json' with { type: 'json' };
import { PyValueError } from './py';
import { pyJsonDumps } from './py-json';
import { JSONDecodeError, JSONDepthError, pyJsonLoads } from './py-json-loads';

// Python prints integral floats as `1.0`; JS numbers can't tell them apart.
const normalize = (text: string): string =>
  text
    .replaceAll(/(\d)\.0(?=[,\]} ]|$)/gu, '$1')
    .replaceAll(/(\d)\.0e/gu, '$1e');

describe('pyJsonLoads matches json.loads on a differential corpus', () => {
  it('agrees on every value and error message', () => {
    const mismatches: string[] = [];
    for (const [input, kind, expected] of cases as [string, string, string][]) {
      let actual: [string, string];
      try {
        actual = ['OK', pyJsonDumps(pyJsonLoads(input))];
      } catch (error) {
        actual =
          error instanceof JSONDecodeError
            ? ['ERR', error.message]
            : ['EXC', String(error)];
      }
      if (actual[0] !== kind || normalize(actual[1]) !== normalize(expected)) {
        mismatches.push(
          `${JSON.stringify(input)}: ${expected} != ${actual[1]}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
    expect(cases.length).toBeGreaterThan(1000);
  });
});

describe('pyJsonLoads', () => {
  it('reports positions like Python', () => {
    expect(() => pyJsonLoads('  \n {"x": 01}')).toThrow(
      "Expecting ',' delimiter: line 2 column 9 (char 11)",
    );
    try {
      pyJsonLoads('not json {{{');
    } catch (error) {
      expect(error).toMatchObject({ colno: 1, lineno: 1, pos: 0 });
    }
  });

  it("applies Python's 4300-digit limit to integers in every mode", () => {
    for (const options of [{}, { bigIntegers: true }, { exactNumbers: true }]) {
      expect(() => pyJsonLoads('1'.repeat(4301), options)).toThrow(
        'Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits; use sys.set_int_max_str_digits() to increase the limit',
      );
      expect(() => pyJsonLoads(`[-${'1'.repeat(5000)}]`, options)).toThrow(
        PyValueError,
      );
      expect(() => pyJsonLoads('1'.repeat(4300), options)).not.toThrow();
      // Floats have no such limit.
      expect(() => pyJsonLoads(`${'1'.repeat(5000)}.5`, options)).not.toThrow();
      expect(() => pyJsonLoads(`${'1'.repeat(5000)}e1`, options)).not.toThrow();
    }
  });

  it('does not convert a huge integer before rejecting it', () => {
    const start = cpuStart();
    expect(() =>
      pyJsonLoads('1'.repeat(10_000_000), { bigIntegers: true }),
    ).toThrow(PyValueError);
    expect(cpuMsSince(start)).toBeLessThan(2000);
  });

  it('stops at maxDepth without building the tree', () => {
    expect(() => pyJsonLoads('[[[]]]', { maxDepth: 1 })).toThrow(
      JSONDepthError,
    );
    expect(pyJsonLoads('[[1]]', { maxDepth: 2 })).toEqual([[1]]);
    expect(() => pyJsonLoads('{"a":{"b":{"c":1}}}', { maxDepth: 2 })).toThrow(
      JSONDepthError,
    );
    expect(() => pyJsonLoads('['.repeat(30_000_000), { maxDepth: 10 })).toThrow(
      JSONDepthError,
    );
  });

  it('accepts NaN and Infinity and keeps __proto__ as data', () => {
    expect(pyJsonLoads('[NaN, Infinity, -Infinity]')).toEqual([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
    const value = pyJsonLoads('{"__proto__": {"polluted": true}}') as object;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(['__proto__']);
  });

  it('parses deep nesting without overflowing the stack', () => {
    const depth = 200_000;
    const value = pyJsonLoads(`${'['.repeat(depth)}${']'.repeat(depth)}`);
    expect(Array.isArray(value)).toBe(true);
  });
});
