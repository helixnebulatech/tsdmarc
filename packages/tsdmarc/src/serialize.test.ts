import { describe, expect, it } from 'vitest';

import {
  camelToSnake,
  markRaw,
  snakeToCamel,
  toCamelCaseKeys,
  toSnakeCaseKeys,
} from './serialize';

describe('key conversion', () => {
  it('converts single keys both ways', () => {
    expect(camelToSnake('ipAddress')).toBe('ip_address');
    expect(camelToSnake('orgExtraContactInfo')).toBe('org_extra_contact_info');
    expect(camelToSnake('sha256')).toBe('sha256');
    expect(camelToSnake('x-mailer')).toBe('x-mailer');
    expect(snakeToCamel('ip_address')).toBe('ipAddress');
    expect(snakeToCamel('org_extra_contact_info')).toBe('orgExtraContactInfo');
    expect(snakeToCamel('x-mailer')).toBe('x-mailer');
  });

  it('converts nested objects and arrays but leaves headers untouched', () => {
    const report = {
      reportMetadata: { orgName: 'Example', errors: ['a'] },
      records: [{ source: { ipAddress: '192.0.2.1', asName: null } }],
      parsedSample: {
        headers: { 'X-Mailer': 'x', Received: ['r1'], someKey: 1 },
        filenameSafeSubject: 's',
      },
    };
    const snake = toSnakeCaseKeys(report);
    expect(snake).toEqual({
      report_metadata: { org_name: 'Example', errors: ['a'] },
      records: [{ source: { ip_address: '192.0.2.1', as_name: null } }],
      parsed_sample: {
        headers: { 'X-Mailer': 'x', Received: ['r1'], someKey: 1 },
        filename_safe_subject: 's',
      },
    });
    expect(toCamelCaseKeys(snake)).toEqual(report);
  });

  it('does not mutate or share the input', () => {
    const headers = { From: ['a'] };
    const input = { parsedSample: { headers } };
    const output = toSnakeCaseKeys(input) as {
      parsed_sample: { headers: { From: string[] } };
    };
    output.parsed_sample.headers.From.push('b');
    expect(headers.From).toEqual(['a']);
  });

  it('converts Map values to plain objects', () => {
    const value = new Map([['fooBar', { bazQux: 1 }]]);
    expect(toSnakeCaseKeys({ someMap: value })).toEqual({
      some_map: { foo_bar: { baz_qux: 1 } },
    });
  });
});

describe('keys that are report data', () => {
  it('leaves keys that are not plain camelCase or snake_case unchanged', () => {
    for (const key of [
      'Header_From',
      '@lang',
      '#text',
      'x-mailer',
      'ip_4',
      '_private',
      'ABC',
    ]) {
      expect(camelToSnake(key)).toBe(key);
      expect(snakeToCamel(key)).toBe(key);
    }
  });

  it('round-trips report data keys through both conversions', () => {
    const data = { Header_From: 1, ip_4: 2, '@lang': 3, envelope_from: 4 };
    expect(toSnakeCaseKeys(toCamelCaseKeys(data))).toEqual(data);
  });
});

describe('integers beyond 2^53', () => {
  it('keeps bigints exact in every place they can appear', () => {
    const huge = 99_999_999_999_999_999_999n;
    const report = {
      records: [{ count: huge }],
      parsedSample: { headers: { 'X-Count': huge } },
      contactInfo: markRaw({ someCount: huge }),
    };
    expect(toSnakeCaseKeys(report)).toEqual({
      records: [{ count: huge }],
      parsed_sample: { headers: { 'X-Count': huge } },
      contact_info: { someCount: huge },
    });
  });

  it('copies nesting deeper than the call stack', () => {
    const depth = 50_000;
    let converted: unknown = 'v';
    let raw: unknown = 'v';
    for (let level = 0; level < depth; level += 1) {
      converted = level % 2 === 0 ? { someKey: converted } : [converted];
      raw = level % 2 === 0 ? { someKey: raw } : [raw];
    }
    const snake = toSnakeCaseKeys({
      deep: converted,
      raw: markRaw(raw),
    }) as Record<string, unknown>;
    let item: unknown = snake.deep;
    let rawItem: unknown = snake.raw;
    for (let level = depth - 1; level >= 0; level -= 1) {
      if (level % 2 === 0) {
        item = (item as Record<string, unknown>).some_key;
        rawItem = (rawItem as Record<string, unknown>).someKey;
      } else {
        expect(Array.isArray(item) && item.length === 1).toBe(true);
        [item] = item as unknown[];
        [rawItem] = rawItem as unknown[];
      }
    }
    expect([item, rawItem]).toEqual(['v', 'v']);
    expect(snake.raw === raw).toBe(false);
  });
});
