// Python's json.dumps() and the bigint bridge for SDK-serialized payloads.

import { describe, expect, it } from 'vitest';

import { PyDateTime } from '../utils/datetime';
import { pyJsonDumps, PyJsonNumber, rawJsonIntegers } from './py-json';

const HUGE = 99_999_999_999_999_999_999n;

describe('pyJsonDumps', () => {
  it('writes ints beyond 2^53 exactly, like Python', () => {
    expect(pyJsonDumps({ count: HUGE, n: -HUGE })).toBe(
      '{"count": 99999999999999999999, "n": -99999999999999999999}',
    );
    expect(pyJsonDumps([new PyJsonNumber('1.0')])).toBe('[1.0]');
  });

  it('indents nested containers like Python', () => {
    const value = { a: [1, { b: [] }, {}], c: { d: null } };
    expect(pyJsonDumps(value, { indent: 2 })).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": []\n    },\n    {}\n  ],\n  "c": {\n    "d": null\n  }\n}',
    );
    expect(pyJsonDumps(value)).toBe(
      '{"a": [1, {"b": []}, {}], "c": {"d": null}}',
    );
    expect(
      pyJsonDumps(new Set([1]), {
        default: item => [...(item as Set<number>)],
      }),
    ).toBe('[1]');
  });

  it('encodes nesting deeper than the call stack', () => {
    const depth = 50_000;
    let value: unknown = 1;
    for (let level = 0; level < depth; level += 1) {
      value = level % 2 === 0 ? { k: value } : [value];
    }
    expect(pyJsonDumps(value)).toBe(
      `${'[{"k": '.repeat(depth / 2)}1${'}]'.repeat(depth / 2)}`,
    );
    // Indented output grows with the square of the depth.
    let shallower: unknown = 1;
    for (let level = 0; level < 2000; level += 1) {
      shallower = [shallower];
    }
    const indented = pyJsonDumps(shallower, { indent: 1 });
    expect(indented).toBe(
      Array.from(
        { length: 2000 },
        (_, level) => `[\n${' '.repeat(level + 1)}`,
      ).join('') +
        '1' +
        Array.from(
          { length: 2000 },
          (_, level) => `\n${' '.repeat(1999 - level)}]`,
        ).join(''),
    );
  });
});

describe('rawJsonIntegers', () => {
  it('lets JSON.stringify() write bigints exactly', () => {
    const value = {
      records: [{ count: HUGE, small: 1 }],
      exact: new PyJsonNumber('12345678901234567890'),
    };
    expect(JSON.stringify(rawJsonIntegers(value))).toBe(
      '{"records":[{"count":99999999999999999999,"small":1}],"exact":12345678901234567890}',
    );
  });

  it('copies plain data, keeps other objects, and owns "__proto__" keys', () => {
    const when = new PyDateTime({ year: 2024, month: 1, day: 2 });
    const source = JSON.parse('{"__proto__": {"a": 1}}') as object;
    const result = rawJsonIntegers({ when, source }) as Record<string, unknown>;
    expect(result.when).toBe(when);
    expect(JSON.stringify(result.source)).toBe('{"__proto__":{"a":1}}');
  });
});
