// Python's `json.loads()` for text, ported from CPython 3.14's scanner
// (Modules/_json.c and Lib/json/decoder.py). Unlike `JSON.parse`, it accepts
// `NaN`/`Infinity`, and its `JSONDecodeError` messages and positions match
// Python's, which end up in parsedmarc's error messages
// (e.g. `Expecting value: line 1 column 1 (char 0)`).
//
// The scan is iterative (an explicit stack), so deeply nested input cannot
// overflow the call stack. Integers beyond 2^53 lose precision, as any JS
// number does, unless `exactNumbers` keeps them as `PyJsonNumber`s or
// `bigIntegers` as `bigint`s. Integer literals over Python's 4300 digits raise
// its ValueError in every mode. Unlike Python, any nesting depth is accepted
// unless `maxDepth` is set (Python raises RecursionError at a depth that
// depends on the stack). Every open container costs about 80 bytes of heap, so
// `maxDepth` is needed on untrusted text: it stops the scan, not just the
// result.

import { pyFloatRepr } from '../utils/python';
import { PY_INT_MAX_STR_DIGITS } from '../utils/timestamps';
import { intDigitsError } from './py';
import { PyJsonNumber } from './py-json';
import { setOwn } from './set-own';

/** Python's `json.JSONDecodeError` (a `ValueError`). */
export class JSONDecodeError extends Error {
  override name = 'JSONDecodeError';
  readonly msg: string;
  readonly doc: string;
  readonly pos: number;
  readonly lineno: number;
  readonly colno: number;

  constructor(msg: string, doc: string, pos: number) {
    let lineno = 1;
    let lastNewline = -1;
    for (let index = 0; index < pos; index += 1) {
      if (doc.charCodeAt(index) === 0x0a) {
        lineno += 1;
        lastNewline = index;
      }
    }
    const colno = pos - lastNewline;
    super(`${msg}: line ${lineno} column ${colno} (char ${pos})`);
    this.msg = msg;
    this.doc = doc;
    this.pos = pos;
    this.lineno = lineno;
    this.colno = colno;
  }
}

/** The text nests containers deeper than `maxDepth`. Not in Python. */
export class JSONDepthError extends Error {
  override name = 'JSONDepthError';

  constructor(maxDepth: number) {
    super(`report data nested more than ${maxDepth} levels deep`);
  }
}

/** Raised by `scanValue` where Python raises StopIteration. */
class NoValue {
  readonly pos: number;
  constructor(pos: number) {
    this.pos = pos;
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/uy;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '/': '/',
  '\\': '\\',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};
const HEX4 = /^[0-9a-fA-F]{4}$/u;

function skipWhitespace(text: string, index: number): number {
  let position = index;
  while (position < text.length) {
    const code = text.charCodeAt(position);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      break;
    }
    position += 1;
  }
  return position;
}

/** `scanstring`: `end` is just after the opening quote. */
function scanString(text: string, end: number): [string, number] {
  const begin = end - 1;
  let result = '';
  let position = end;
  for (;;) {
    let chunkEnd = position;
    while (chunkEnd < text.length) {
      const code = text.charCodeAt(chunkEnd);
      if (code === 0x22 || code === 0x5c || code < 0x20) {
        break;
      }
      chunkEnd += 1;
    }
    if (chunkEnd >= text.length) {
      throw new JSONDecodeError('Unterminated string starting at', text, begin);
    }
    result += text.slice(position, chunkEnd);
    const code = text.charCodeAt(chunkEnd);
    if (code === 0x22) {
      return [result, chunkEnd + 1];
    }
    if (code < 0x20) {
      throw new JSONDecodeError('Invalid control character at', text, chunkEnd);
    }
    // Backslash escape.
    const escape = text.charAt(chunkEnd + 1);
    if (escape === '') {
      throw new JSONDecodeError('Unterminated string starting at', text, begin);
    }
    if (escape !== 'u') {
      const decoded = ESCAPES[escape];
      if (decoded === undefined) {
        throw new JSONDecodeError('Invalid \\escape', text, chunkEnd);
      }
      result += decoded;
      position = chunkEnd + 2;
      continue;
    }
    const hex = text.slice(chunkEnd + 2, chunkEnd + 6);
    if (!HEX4.test(hex)) {
      throw new JSONDecodeError('Invalid \\uXXXX escape', text, chunkEnd + 1);
    }
    let codePoint = Number.parseInt(hex, 16);
    position = chunkEnd + 6;
    if (
      codePoint >= 0xd8_00 &&
      codePoint <= 0xdb_ff &&
      text.slice(position, position + 2) === '\\u'
    ) {
      const lowHex = text.slice(position + 2, position + 6);
      if (!HEX4.test(lowHex)) {
        throw new JSONDecodeError('Invalid \\uXXXX escape', text, position + 1);
      }
      const low = Number.parseInt(lowHex, 16);
      if (low >= 0xdc_00 && low <= 0xdf_ff) {
        codePoint = 0x1_00_00 + ((codePoint - 0xd8_00) << 10) + (low - 0xdc_00);
        position += 6;
      }
    }
    result += String.fromCodePoint(codePoint);
  }
}

/** How numbers are returned: JS numbers, `PyJsonNumber`s, or exact ints. */
type NumberMode = 'number' | 'exact' | 'bigint';

type Container =
  | { kind: 'array'; value: unknown[] }
  | { kind: 'object'; value: Record<string, unknown>; key: string };

/** Scan a scalar at `index`, or open a container. */
function scanScalar(
  text: string,
  index: number,
  numbers: NumberMode,
): { value: unknown; end: number } | { open: '[' | '{'; end: number } {
  const char = text.charAt(index);
  if (char === '') {
    throw new NoValue(index);
  }
  if (char === '"') {
    const [value, end] = scanString(text, index + 1);
    return { end, value };
  }
  if (char === '{' || char === '[') {
    return { end: index + 1, open: char };
  }
  const literals: [string, unknown][] = [
    ['null', null],
    ['true', true],
    ['false', false],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ];
  for (const [literal, value] of literals) {
    if (text.startsWith(literal, index)) {
      return { end: index + literal.length, value };
    }
  }
  NUMBER.lastIndex = index;
  const match = NUMBER.exec(text);
  if (match === null) {
    throw new NoValue(index);
  }
  const isFloat = match[1] !== undefined || match[2] !== undefined;
  if (!isFloat) {
    // Before any conversion: BigInt() is superlinear in the digits.
    const digits = match[0].length - (match[0].startsWith('-') ? 1 : 0);
    if (digits > PY_INT_MAX_STR_DIGITS) {
      throw intDigitsError(digits);
    }
  }
  const value = Number(match[0]);
  if (numbers === 'exact') {
    return {
      end: index + match[0].length,
      value: new PyJsonNumber(
        isFloat ? pyJsonFloatText(value) : BigInt(match[0]).toString(),
      ),
    };
  }
  if (numbers === 'bigint' && !isFloat && !Number.isSafeInteger(value)) {
    return { end: index + match[0].length, value: BigInt(match[0]) };
  }
  return {
    end: index + match[0].length,
    value: Object.is(value, -0) && !isFloat ? 0 : value,
  };
}

/** Parse one value starting at `index` (`scan_once`), iteratively. */
function scanValue(
  text: string,
  start: number,
  numbers: NumberMode,
  maxDepth: number,
): [unknown, number] {
  const stack: Container[] = [];
  let index = start;
  let pending: unknown;
  let havePending = false;

  for (;;) {
    if (!havePending) {
      const scanned = scanScalar(text, index, numbers);
      index = scanned.end;
      if ('open' in scanned) {
        if (stack.length >= maxDepth) {
          throw new JSONDepthError(maxDepth);
        }
        if (scanned.open === '[') {
          index = skipWhitespace(text, index);
          if (text.charAt(index) === ']') {
            pending = [];
            havePending = true;
            index += 1;
          } else {
            stack.push({ kind: 'array', value: [] });
          }
          continue;
        }
        index = skipWhitespace(text, index);
        if (text.charAt(index) === '}') {
          pending = {};
          havePending = true;
          index += 1;
          continue;
        }
        if (text.charAt(index) !== '"') {
          throw new JSONDecodeError(
            'Expecting property name enclosed in double quotes',
            text,
            index,
          );
        }
        const [key, keyEnd] = scanString(text, index + 1);
        index = skipWhitespace(text, keyEnd);
        if (text.charAt(index) !== ':') {
          throw new JSONDecodeError("Expecting ':' delimiter", text, index);
        }
        index = skipWhitespace(text, index + 1);
        stack.push({ key, kind: 'object', value: {} });
        continue;
      }
      pending = scanned.value;
      havePending = true;
    }

    const top = stack.at(-1);
    if (top === undefined) {
      return [pending, index];
    }
    havePending = false;
    if (top.kind === 'array') {
      top.value.push(pending);
      index = skipWhitespace(text, index);
      const char = text.charAt(index);
      if (char === ']') {
        stack.pop();
        pending = top.value;
        havePending = true;
        index += 1;
        continue;
      }
      if (char !== ',') {
        throw new JSONDecodeError("Expecting ',' delimiter", text, index);
      }
      const comma = index;
      index = skipWhitespace(text, index + 1);
      if (text.charAt(index) === ']') {
        throw new JSONDecodeError(
          'Illegal trailing comma before end of array',
          text,
          comma,
        );
      }
      continue;
    }

    setOwn(top.value, top.key, pending);
    index = skipWhitespace(text, index);
    const char = text.charAt(index);
    if (char === '}') {
      stack.pop();
      pending = top.value;
      havePending = true;
      index += 1;
      continue;
    }
    if (char !== ',') {
      throw new JSONDecodeError("Expecting ',' delimiter", text, index);
    }
    const comma = index;
    index = skipWhitespace(text, index + 1);
    if (text.charAt(index) === '}') {
      throw new JSONDecodeError(
        'Illegal trailing comma before end of object',
        text,
        comma,
      );
    }
    if (text.charAt(index) !== '"') {
      throw new JSONDecodeError(
        'Expecting property name enclosed in double quotes',
        text,
        index,
      );
    }
    const [key, keyEnd] = scanString(text, index + 1);
    index = skipWhitespace(text, keyEnd);
    if (text.charAt(index) !== ':') {
      throw new JSONDecodeError("Expecting ':' delimiter", text, index);
    }
    index = skipWhitespace(text, index + 1);
    top.key = key;
  }
}

export interface PyJsonLoadsOptions {
  /**
   * Return numbers as `PyJsonNumber`s holding the text Python's
   * `json.dumps()` would write back (exact ints, float reprs), for
   * load/dump round trips. Default: false (JS numbers).
   */
  exactNumbers?: boolean;
  /**
   * Return integers beyond ±2^53 as exact `bigint`s; other numbers stay JS
   * numbers. Ignored with `exactNumbers`.
   */
  bigIntegers?: boolean;
  /**
   * Most containers open at once; deeper text raises {@link JSONDepthError}
   * as soon as the scan gets there. Default: no limit.
   */
  maxDepth?: number;
}

/** A float's text in `json.dumps()`: its `repr`, or `Infinity` on overflow. */
function pyJsonFloatText(value: number): string {
  if (!Number.isFinite(value)) {
    return value > 0 ? 'Infinity' : '-Infinity';
  }
  return pyFloatRepr(value);
}

/** Python's `json.loads(text)`. */
export function pyJsonLoads(
  text: string,
  options: PyJsonLoadsOptions = {},
): unknown {
  if (text.startsWith('﻿')) {
    throw new JSONDecodeError(
      'Unexpected UTF-8 BOM (decode using utf-8-sig)',
      text,
      0,
    );
  }
  const start = skipWhitespace(text, 0);
  let value: unknown;
  let end: number;
  try {
    let numbers: NumberMode = 'number';
    if (options.exactNumbers) {
      numbers = 'exact';
    } else if (options.bigIntegers) {
      numbers = 'bigint';
    }
    [value, end] = scanValue(
      text,
      start,
      numbers,
      options.maxDepth ?? Number.POSITIVE_INFINITY,
    );
  } catch (error) {
    if (error instanceof NoValue) {
      throw new JSONDecodeError('Expecting value', text, error.pos);
    }
    throw error;
  }
  end = skipWhitespace(text, end);
  if (end !== text.length) {
    throw new JSONDecodeError('Extra data', text, end);
  }
  return value;
}
