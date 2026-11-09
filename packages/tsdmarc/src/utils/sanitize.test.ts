// Port of tests/test_utils.py::TestSanitizeForLog, plus the characters where
// Python's str.isprintable() differs from a plain control-character check.

import { describe, expect, it } from 'vitest';

import { sanitizeForLog } from './sanitize';

// Written out, a raw U+2028 would end the string literal's line.
const LINE_SEPARATOR = String.fromCodePoint(0x20_28);

describe('TestSanitizeForLog', () => {
  it.each([
    ['plain ASCII', 'plain ASCII'],
    ['', ''],
    ['line1\r\nINJECTED fake log', 'line1\\r\\nINJECTED fake log'],
    ['a\tb', 'a\\tb'],
    ['\u001B[31mred', '\\x1b[31mred'],
    [`a${LINE_SEPARATOR}b`, 'a\\u2028b'],
    ['nul\u0000byte', 'nul\\x00byte'],
    ['日本語 report', '日本語 report'],
    ['ok \u{1F600}', 'ok \u{1F600}'],
  ])('testEscapesNonPrintableAndKeepsPrintable(%j)', (value, expected) => {
    expect(sanitizeForLog(value)).toBe(expected);
  });

  it('testResultHasNoRawControlCharacters', () => {
    const result = sanitizeForLog('a\r\nb\nc\rd');
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\n');
  });

  // Expected values from Python 3.14: `ch.encode("unicode_escape")` for
  // every character `str.isprintable()` rejects.
  it.each([
    [' ', '\\xa0'],
    ['\u0085', '\\x85'],
    ['\u007F', '\\x7f'],
    ['　', '\\u3000'],
    ['‍', '\\u200d'],
    ['­', '\\xad'],
    ['‮', '\\u202e'],
    ['﻿', '\\ufeff'],
    ['', '\\ue000'],
    ['\uD800', '\\ud800'],
    ['\u{E0001}', '\\U000e0001'],
    ['\u{10FFFF}', '\\U0010ffff'],
  ])('escapes %j like unicode_escape', (value, expected) => {
    expect(sanitizeForLog(`<${value}>`)).toBe(`<${expected}>`);
  });

  it('keeps printable characters that a control-character filter might not', () => {
    expect(sanitizeForLog('\\ "quoted" é ☃ \u{1D11E}')).toBe(
      '\\ "quoted" é ☃ \u{1D11E}',
    );
  });
});
