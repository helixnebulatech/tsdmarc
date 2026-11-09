import { describe, expect, it } from 'vitest';

import { decodeUtf8 } from './text';

describe('decodeUtf8', () => {
  it('drops invalid bytes with "ignore", like Python', () => {
    // bytes(...).decode("utf-8", "ignore") on Python 3.14.
    const cases: [number[], string][] = [
      [[0xe2, 0x82, 0x41, 0xf0, 0x9f, 0x98, 0x80, 0xff, 0x42], 'A\u{1f600}B'],
      [[0xc0, 0x80, 0xed, 0xa0, 0x80, 0x41], 'A'],
      [[0x41, 0xf0, 0x9f], 'A'],
      [[0xef, 0xbb, 0xbf, 0xff, 0xc3, 0xa9], '\ufeff\u00e9'],
      [[0xff], ''],
    ];
    for (const [bytes, expected] of cases) {
      expect(decodeUtf8(Uint8Array.from(bytes), 'ignore')).toBe(expected);
    }
  });

  // [hex, Python's bytes.fromhex(hex).decode('utf-8', 'ignore')]
  it.each([
    ['61ff62', 'ab'],
    ['', ''],
    ['61e282', 'a'],
    ['e282ace282', '€'],
    ['f4908080', ''],
    ['ffefbbbf41', '﻿A'],
    ['e2ff82ac', ''],
  ])('decodes %s with "ignore" like Python', (hex, expected) => {
    expect(decodeUtf8(Buffer.from(hex, 'hex'), 'ignore')).toBe(expected);
  });

  it('decodes input alternating with invalid bytes in one piece', () => {
    // A view per valid run: 100 MiB, from a 100 KB gzip, exhausted the heap.
    const pairs = 10_000_000;
    const bytes = new Uint8Array(pairs * 2).fill(0xff);
    for (let index = 0; index < bytes.length; index += 2) {
      bytes[index] = 0x41;
    }
    const start = process.cpuUsage();
    const text = decodeUtf8(bytes, 'ignore');
    const { user, system } = process.cpuUsage(start);
    expect((user + system) / 1000).toBeLessThan(1000);
    expect(text).toBe('A'.repeat(pairs));
  });
});
