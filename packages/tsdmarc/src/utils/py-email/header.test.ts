// `decode_header()` and the `ecre` / `_embedded_header` scans, against
// Python 3.14 and against the regular expressions they replace.

import { describe, expect, it } from 'vitest';

import { HeaderParseError } from './errors';
import {
  decodeHeader,
  encodeHeaderValue,
  hasEmbeddedHeader,
  hasEncodedWord,
  splitEncodedWords,
} from './header';

/** CPU milliseconds since `start`: a loaded machine doesn't make bounds flaky. */
function cpuMsSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}

/** A deterministic pseudo-random generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = Math.trunc(state + 0x6d_2b_79_f5);
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomTexts(alphabet: string, count: number, seed: number): string[] {
  const draw = random(seed);
  const chars = [...alphabet];
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = Math.floor(draw() * 24);
    let text = '';
    for (let position = 0; position < length; position += 1) {
      text += chars[Math.floor(draw() * chars.length)];
    }
    texts.push(text);
  }
  return texts;
}

// The regular expressions the scans replace (`ecre` and `_embedded_header`).
const ECRE_SEARCH = /=\?[^?]*?\?[qQbB]\?[^\n]*?\?=/u;
const ECRE_SPLIT = /=\?([^?]*?)\?([qQbB])\?([^\n]*?)\?=/u;
const EMBEDDED_HEADER = /\n[^ \t]+:/u;

function latin1(bytes: Uint8Array | string): string {
  if (typeof bytes === 'string') {
    return bytes;
  }
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}

describe('ecre scan', () => {
  it('finds and splits exactly like the regular expression', () => {
    const texts = [
      ...randomTexts('=?qQbBa\n\r ', 20_000, 1),
      ...randomTexts('=??qb', 20_000, 2),
      ...randomTexts('=?Qx\n', 20_000, 3),
      '=??B?B'.repeat(5),
      '=?a?q?x?==?b?B?y?=',
      '=?a\n?q?x?=',
      '=?a?q?\n?=',
      '=?a?q?=',
      '=?a?q??=',
      '=?\u{1f600}?b?\u{1f600}?=',
    ];
    for (const text of texts) {
      expect(hasEncodedWord(text), JSON.stringify(text)).toBe(
        ECRE_SEARCH.test(text),
      );
      expect(splitEncodedWords(text), JSON.stringify(text)).toEqual(
        text.split(ECRE_SPLIT),
      );
    }
  });

  it('is linear on `=?` without a closing `?=`', () => {
    // The lazy regular expression took 47 s on 240 KB.
    const prefix = '=??B?B'.repeat(40_000);
    const start = process.cpuUsage();
    expect(hasEncodedWord(prefix)).toBe(false);
    expect(splitEncodedWords(prefix)).toEqual([prefix]);
    expect(decodeHeader(prefix)).toEqual([[prefix, null]]);
    // The charset may span lines: only the last `=?` matches.
    const text = `${prefix}=?\n?B??=`;
    expect(hasEncodedWord(text)).toBe(true);
    expect(splitEncodedWords(text)).toEqual([prefix, '\n', 'B', '', '']);
    expect(cpuMsSince(start)).toBeLessThan(2000);
  });
});

describe('embedded header scan', () => {
  it('matches the regular expression', () => {
    const texts = [
      ...randomTexts('\n: \ta\u001c', 40_000, 4),
      ...randomTexts('\n:a', 20_000, 5),
      '\n:',
      '\n::',
      '\n\n:',
      'a\nb:',
      'a\n b:',
      'a\nb\t:',
      'a\n\t\n:',
    ];
    for (const text of texts) {
      expect(hasEmbeddedHeader(text), JSON.stringify(text)).toBe(
        EMBEDDED_HEADER.test(text),
      );
    }
  });

  it('is linear on many lines without a colon', () => {
    // `str.splitlines()` also splits on \x1c: 80 KB took 22.5 s.
    const value = `a${'\u001cb'.repeat(100_000)}`;
    const start = process.cpuUsage();
    expect(encodeHeaderValue('X', value)).toBe(`a${'\nb'.repeat(100_000)}`);
    expect(() => encodeHeaderValue('X', `${value}\u001cc:`)).toThrow(
      HeaderParseError,
    );
    expect(cpuMsSince(start)).toBeLessThan(3000);
  });
});

describe('decodeHeader', () => {
  // [header, Python 3.14's decode_header() with bytes as latin-1 text]
  const cases: [string, [string, string | null][]][] = [
    ['=?utf-8?q?a?= =?utf-8?q?b?=', [['ab', 'utf-8']]],
    [
      'x =?utf-8?q?a?=  =?iso-8859-1?b?YQ==?= y z',
      [
        ['x ', null],
        ['a', 'utf-8'],
        ['a', 'iso-8859-1'],
        [' y z', null],
      ],
    ],
    ['=?a?q?x?= \n =?a?q?y?=', [['xy', 'a']]],
    ['=??q?a?=', [['a', '']]],
    [
      'a =?utf-8?Q?b_c?=\td',
      [
        ['a ', null],
        ['b c', 'utf-8'],
        ['\td', null],
      ],
    ],
    ['  =?x?b?YWI?= =?x?b?Yw==?=', [['abc', 'x']]],
  ];

  it.each(cases)('decodes %j like Python', (header, expected) => {
    expect(
      decodeHeader(header).map(([data, charset]) => [latin1(data), charset]),
    ).toEqual(expected);
  });

  it('is linear in the number of encoded words', () => {
    // 20,000 words took 23 s and 80,000 (1.1 MB) 523 s (Python: 150 s).
    const words = 80_000;
    const header = Array.from({ length: words }, () => '=?utf-8?q?a?=').join(
      ' ',
    );
    const start = process.cpuUsage();
    const decoded = decodeHeader(header);
    expect(cpuMsSince(start)).toBeLessThan(3000);
    expect(decoded).toHaveLength(1);
    expect(latin1(decoded[0]?.[0] ?? '')).toBe('a'.repeat(words));
  });
});
