// Timestamp helpers, ported from parsedmarc/utils.py, plus `parseDate`, a
// port of `dateutil.parser.parse` 2.9.0 with its default `parserinfo`
// (no `dayfirst`/`yearfirst`, no `fuzzy`, no `tzinfos`): the lexer
// (`_timelex`), the token loop (`parser._parse`), year/month/day resolution
// (`_ymd`) and the naive/aware result building, with Python's error
// messages.
//
// Every scan here is linear: input comes from report senders. Linear is still
// a minute of CPU and 2.5 GB for a 37 MB token, so `parseDate` rejects text
// that can't be a date before looking at it (dateutil has no such limit).

import { PyDateTime } from './datetime';

/** Raised when a date string cannot be parsed (dateutil's `ParserError`). */
export class DateParseError extends Error {
  override name = 'DateParseError';
}

/** A `ValueError`/`IndexError` inside dateutil's `_parse`: "Unknown string format". */
class TokenError extends Error {}

export interface ParseDateOptions {
  /**
   * Naive datetime supplying the fields the string leaves out (dateutil's
   * `default`). Defaults to today at midnight, local time.
   */
  default?: PyDateTime;
  /**
   * Year that two-digit years are resolved around (dateutil uses the local
   * year when it is imported). Defaults to the current local year.
   */
  currentYear?: number;
}

// --- Python str predicates -------------------------------------------------

const DECIMAL_DIGIT = /^\p{Nd}$/u;
const LETTER = /^\p{L}$/u;
/** `str.isdigit()` characters that are not decimal digits (Unicode 16). */
const EXTRA_DIGIT_RANGES: readonly (readonly [number, number])[] = [
  [0xb2, 0xb3],
  [0xb9, 0xb9],
  [0x13_69, 0x13_71],
  [0x19_da, 0x19_da],
  [0x20_70, 0x20_70],
  [0x20_74, 0x20_79],
  [0x20_80, 0x20_89],
  [0x24_60, 0x24_68],
  [0x24_74, 0x24_7c],
  [0x24_88, 0x24_90],
  [0x24_ea, 0x24_ea],
  [0x24_f5, 0x24_fd],
  [0x24_ff, 0x24_ff],
  [0x27_76, 0x27_7e],
  [0x27_80, 0x27_88],
  [0x27_8a, 0x27_92],
  [0x1_0a_40, 0x1_0a_43],
  [0x1_0e_60, 0x1_0e_68],
  [0x1_10_52, 0x1_10_5a],
  [0x1_f1_00, 0x1_f1_0a],
];
/** `str.isspace()` characters. */
const PY_SPACE: ReadonlySet<string> = new Set(
  [
    0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x16_80,
    0x20_00, 0x20_01, 0x20_02, 0x20_03, 0x20_04, 0x20_05, 0x20_06, 0x20_07,
    0x20_08, 0x20_09, 0x20_0a, 0x20_28, 0x20_29, 0x20_2f, 0x20_5f, 0x30_00,
  ].map(code => String.fromCodePoint(code)),
);

const isWordChar = (char: string): boolean => LETTER.test(char);
const isDecimalChar = (char: string): boolean => DECIMAL_DIGIT.test(char);

function isNumChar(char: string): boolean {
  if (isDecimalChar(char)) {
    return true;
  }
  const code = char.codePointAt(0) ?? 0;
  return EXTRA_DIGIT_RANGES.some(([low, high]) => code >= low && code <= high);
}

/** Python's `str.isdigit()`. */
function isDigitString(value: string): boolean {
  const chars = Array.from(value);
  return chars.length > 0 && chars.every(isNumChar);
}

/** Value of a decimal digit: digits come in runs of ten starting at zero. */
function decimalValue(char: string): number {
  let code = char.codePointAt(0) ?? 0;
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  const original = code;
  while (isDecimalChar(String.fromCodePoint(code - 1))) {
    code -= 1;
  }
  return (original - code) % 10;
}

function asciiDigits(chars: readonly string[]): string {
  return chars.map(char => String(decimalValue(char))).join('');
}

/** Python's `int(str)` on a lexer token: decimal digits only. */
function pyInt(value: string): number {
  const chars = Array.from(value);
  if (
    chars.length === 0 ||
    chars.length > PY_INT_MAX_STR_DIGITS ||
    !chars.every(isDecimalChar)
  ) {
    throw new TokenError();
  }
  return Number(asciiDigits(chars));
}

/** `sys.get_int_max_str_digits()`: longer strings make `int()` raise ValueError. */
export const PY_INT_MAX_STR_DIGITS = 4300;

/** A finite `Decimal` made from a token: integer part and fraction digits. */
interface DecimalValue {
  whole: number;
  fraction: string;
}

/** Python's `float(token)` succeeds: digits with an optional fraction, or inf/nan. */
function isFloatToken(token: string): boolean {
  return splitDecimal(token) !== null || NON_FINITE.test(token);
}

const NON_FINITE = /^(?:inf|infinity|nan)$/iu;

function splitDecimal(token: string): DecimalValue | null {
  const chars = Array.from(token);
  const dot = chars.indexOf('.');
  const wholeChars = dot === -1 ? chars : chars.slice(0, dot);
  const fractionChars = dot === -1 ? [] : chars.slice(dot + 1);
  if (
    wholeChars.length === 0 ||
    !wholeChars.every(isDecimalChar) ||
    !fractionChars.every(isDecimalChar)
  ) {
    return null;
  }
  return {
    whole: Number(asciiDigits(wholeChars)),
    fraction: asciiDigits(fractionChars),
  };
}

/** Far over any date, and about 0.7 s of CPU at worst. */
const MAX_DATE_LENGTH = 1024 * 1024;

/** dateutil's `_to_decimal`: a finite Decimal, else ValueError. */
function toDecimal(token: string): DecimalValue {
  const value = splitDecimal(token);
  if (value === null) {
    throw new TokenError();
  }
  return value;
}

const hasFraction = (value: DecimalValue): boolean =>
  /[1-9]/u.test(value.fraction);
/** `value > limit` for an integer limit, exactly. */
const decimalAbove = (value: DecimalValue, limit: number): boolean =>
  value.whole > limit || (value.whole === limit && hasFraction(value));
/** `int(60 * (value % 1))`, exactly. */
function sixtiethsOfFraction(value: DecimalValue): number {
  if (!hasFraction(value)) {
    return 0;
  }
  const scale = 10n ** BigInt(value.fraction.length);
  return Number((60n * BigInt(value.fraction)) / scale);
}

// --- parserinfo ------------------------------------------------------------

const toIndex = (groups: readonly (readonly string[])[]): Map<string, number> =>
  new Map(
    groups.flatMap((names, index) =>
      names.map(name => [name.toLowerCase(), index] as const),
    ),
  );

const JUMP: ReadonlySet<string> = new Set([
  ' ',
  '.',
  ',',
  ';',
  '-',
  '/',
  "'",
  'at',
  'on',
  'and',
  'ad',
  'm',
  't',
  'of',
  'st',
  'nd',
  'rd',
  'th',
]);
const WEEKDAYS = toIndex([
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
  ['Sun', 'Sunday'],
]);
const MONTHS = toIndex([
  ['Jan', 'January'],
  ['Feb', 'February'],
  ['Mar', 'March'],
  ['Apr', 'April'],
  ['May', 'May'],
  ['Jun', 'June'],
  ['Jul', 'July'],
  ['Aug', 'August'],
  ['Sep', 'Sept', 'September'],
  ['Oct', 'October'],
  ['Nov', 'November'],
  ['Dec', 'December'],
]);
const HMS = toIndex([
  ['h', 'hour', 'hours'],
  ['m', 'minute', 'minutes'],
  ['s', 'second', 'seconds'],
]);
const AMPM = toIndex([
  ['am', 'a'],
  ['pm', 'p'],
]);
const UTCZONE: readonly string[] = ['UTC', 'GMT', 'Z', 'z'];
const UTCZONE_LOWER: ReadonlySet<string> = new Set(['utc', 'gmt', 'z']);
const ASCII_UPPERCASE = /^[A-Z]+$/u;

const isJump = (name: string): boolean => JUMP.has(name.toLowerCase());
const weekdayOf = (name: string): number | undefined =>
  WEEKDAYS.get(name.toLowerCase());
const monthOf = (name: string): number | undefined => {
  const index = MONTHS.get(name.toLowerCase());
  return index === undefined ? undefined : index + 1;
};
const hmsOf = (name: string): number | undefined => HMS.get(name.toLowerCase());
const ampmOf = (name: string): number | undefined =>
  AMPM.get(name.toLowerCase());
const isPertain = (name: string): boolean => name.toLowerCase() === 'of';
const isUtcZone = (name: string): boolean =>
  UTCZONE_LOWER.has(name.toLowerCase());
/** `parserinfo.tzoffset`: note the case-sensitive lookup in lowercase keys. */
const tzOffsetOf = (name: string): number | null =>
  UTCZONE_LOWER.has(name) ? 0 : null;

function convertYear(
  year: number,
  centurySpecified: boolean,
  currentYear: number,
): number {
  if (year >= 100 || centurySpecified) {
    return year;
  }
  let full = year + Math.floor(currentYear / 100) * 100;
  if (full >= currentYear + 50) {
    full -= 100;
  } else if (full < currentYear - 50) {
    full += 100;
  }
  return full;
}

// --- _timelex --------------------------------------------------------------

type LexState = 'a' | '0' | 'a.' | '0.';

const SPLIT_DECIMAL = /([.,])/u;

function countDots(token: string): number {
  return token.split('.').length - 1;
}

/** dateutil's `_timelex.split`: runs of letters, of digits, and single other characters. */
function timelexSplit(input: string): string[] {
  const chars = Array.from(input).filter(char => char !== '\0');
  const tokens: string[] = [];
  let position = 0;
  while (position < chars.length) {
    const first = chars[position] ?? '';
    position += 1;
    let state: LexState;
    if (isWordChar(first)) {
      state = 'a';
    } else if (isNumChar(first)) {
      state = '0';
    } else {
      tokens.push(PY_SPACE.has(first) ? ' ' : first);
      continue;
    }
    let token = first;
    let tokenLength = 1;
    let seenLetters = false;
    while (position < chars.length) {
      const char = chars[position] ?? '';
      let accepted = true;
      if (state === 'a') {
        seenLetters = true;
        if (isWordChar(char)) {
          // stays a word
        } else if (char === '.') {
          state = 'a.';
        } else {
          accepted = false;
        }
      } else if (state === '0') {
        if (isNumChar(char)) {
          // stays a number
        } else if (char === '.' || (char === ',' && tokenLength >= 2)) {
          state = '0.';
        } else {
          accepted = false;
        }
      } else if (state === 'a.') {
        seenLetters = true;
        if (char === '.' || isWordChar(char)) {
          // stays
        } else if (isNumChar(char) && token.endsWith('.')) {
          state = '0.';
        } else {
          accepted = false;
        }
      } else if (char === '.' || isNumChar(char)) {
        // '0.' stays
      } else if (isWordChar(char) && token.endsWith('.')) {
        state = 'a.';
      } else {
        accepted = false;
      }
      if (!accepted) {
        break;
      }
      token += char;
      tokenLength += 1;
      position += 1;
    }

    let rest: string[] = [];
    if (
      (state === 'a.' || state === '0.') &&
      (seenLetters ||
        countDots(token) > 1 ||
        token.endsWith('.') ||
        token.endsWith(','))
    ) {
      const parts = token.split(SPLIT_DECIMAL);
      token = parts[0] ?? '';
      rest = parts.slice(1).filter(Boolean);
    }
    if (state === '0.' && !token.includes('.')) {
      token = token.replaceAll(',', '.');
    }
    tokens.push(token, ...rest);
  }
  return tokens;
}

// --- _ymd ------------------------------------------------------------------

type YmdLabel = 'Y' | 'M' | 'D' | null;

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** `calendar.monthrange(year, month)[1]`. */
function monthLength(year: number, month: number): number {
  if (!(month >= 1 && month <= 12)) {
    throw new RangeError(`bad month number ${month}; must be 1-12`);
  }
  return month === 2 && isLeap(year) ? 29 : (MONTH_DAYS[month - 1] ?? 31);
}

class Ymd {
  readonly values: number[] = [];
  centurySpecified = false;
  dstridx: number | null = null;
  mstridx: number | null = null;
  ystridx: number | null = null;

  get length(): number {
    return this.values.length;
  }

  at(index: number): number {
    // Python's negative indexing (`self[mstridx - 1]`).
    const value = this.values.at(index);
    if (value === undefined) {
      throw new TokenError();
    }
    return value;
  }

  couldBeDay(value: DecimalValue): boolean {
    if (this.dstridx !== null) {
      return false;
    }
    if (value.whole < 1) {
      return false;
    }
    if (this.mstridx === null) {
      return !decimalAbove(value, 31);
    }
    const month = this.at(this.mstridx);
    const year = this.ystridx === null ? 2000 : this.at(this.ystridx);
    return !decimalAbove(value, monthLength(year, month));
  }

  appendString(value: string, label: YmdLabel = null): void {
    let finalLabel = label;
    if (isDigitString(value) && Array.from(value).length > 2) {
      this.centurySpecified = true;
      if (label !== null && label !== 'Y') {
        throw new TokenError();
      }
      finalLabel = 'Y';
    }
    this.push(pyInt(value), finalLabel);
  }

  appendNumber(value: DecimalValue | number, label: YmdLabel = null): void {
    const decimal =
      typeof value === 'number' ? { whole: value, fraction: '' } : value;
    let finalLabel = label;
    if (decimalAbove(decimal, 100)) {
      this.centurySpecified = true;
      if (label !== null && label !== 'Y') {
        throw new TokenError();
      }
      finalLabel = 'Y';
    }
    this.push(decimal.whole, finalLabel);
  }

  private push(value: number, label: YmdLabel): void {
    this.values.push(value);
    const index = this.values.length - 1;
    if (label === 'M') {
      if (this.mstridx !== null) {
        throw new TokenError();
      }
      this.mstridx = index;
    } else if (label === 'D') {
      if (this.dstridx !== null) {
        throw new TokenError();
      }
      this.dstridx = index;
    } else if (label === 'Y') {
      if (this.ystridx !== null) {
        throw new TokenError();
      }
      this.ystridx = index;
    }
  }

  private resolveFromStridxs(
    strids: Map<string, number>,
  ): [number | null, number | null, number | null] {
    if (this.length === 3 && strids.size === 2) {
      const used = new Set(strids.values());
      const missing = [0, 1, 2].find(index => !used.has(index)) ?? 0;
      const key = ['y', 'm', 'd'].find(name => !strids.has(name)) ?? 'y';
      strids.set(key, missing);
    }
    const get = (key: string): number | null => {
      const index = strids.get(key);
      return index === undefined ? null : this.at(index);
    };
    return [get('y'), get('m'), get('d')];
  }

  /** `resolve_ymd(yearfirst=False, dayfirst=False)`. */
  resolve(): [number | null, number | null, number | null] {
    const length = this.length;
    const strids = new Map<string, number>();
    if (this.ystridx !== null) {
      strids.set('y', this.ystridx);
    }
    if (this.mstridx !== null) {
      strids.set('m', this.mstridx);
    }
    if (this.dstridx !== null) {
      strids.set('d', this.dstridx);
    }
    if (
      (length === strids.size && length > 0) ||
      (length === 3 && strids.size === 2)
    ) {
      return this.resolveFromStridxs(strids);
    }

    let year: number | null = null;
    let month: number | null = null;
    let day: number | null = null;
    const { mstridx } = this;
    if (length > 3) {
      throw new TokenError();
    }
    if (length === 1 || (mstridx !== null && length === 2)) {
      let other: number;
      if (mstridx === null) {
        other = this.at(0);
      } else {
        month = this.at(mstridx);
        other = this.at(mstridx - 1);
      }
      if (length > 1 || mstridx === null) {
        if (other > 31) {
          year = other;
        } else {
          day = other;
        }
      }
    } else if (length === 2) {
      const [first, second] = [this.at(0), this.at(1)];
      if (first > 31) {
        [year, month] = [first, second];
      } else if (second > 31) {
        [month, year] = [first, second];
      } else {
        [month, day] = [first, second];
      }
    } else if (length === 3) {
      const [first, second, third] = [this.at(0), this.at(1), this.at(2)];
      if (mstridx === 0) {
        if (second > 31) {
          [month, year, day] = [first, second, third];
        } else {
          [month, day, year] = [first, second, third];
        }
      } else if (mstridx === 1) {
        if (first > 31) {
          [year, month, day] = [first, second, third];
        } else {
          [day, month, year] = [first, second, third];
        }
      } else if (mstridx === 2) {
        if (second > 31) {
          [day, year, month] = [first, second, third];
        } else {
          [year, day, month] = [first, second, third];
        }
      } else if (first > 31 || this.ystridx === 0) {
        [year, month, day] = [first, second, third];
      } else if (first > 12) {
        [day, month, year] = [first, second, third];
      } else {
        [month, day, year] = [first, second, third];
      }
    }
    return [year, month, day];
  }
}

// --- parser._parse ---------------------------------------------------------

interface ParseResult {
  year: number | null;
  month: number | null;
  day: number | null;
  weekday: number | null;
  hour: number | null;
  minute: number | null;
  second: number | null;
  microsecond: number | null;
  tzname: string | null;
  tzoffset: number | null;
  ampm: number | null;
  centurySpecified: boolean;
}

function couldBeTzname(
  res: ParseResult,
  token: string,
  ignoreOffset = false,
): boolean {
  return (
    res.hour !== null &&
    res.tzname === null &&
    (ignoreOffset || res.tzoffset === null) &&
    Array.from(token).length <= 5 &&
    (ASCII_UPPERCASE.test(token) || UTCZONE.includes(token))
  );
}

function adjustAmpm(hour: number, ampm: number): number {
  if (hour < 12 && ampm === 1) {
    return hour + 12;
  }
  if (hour === 12 && ampm === 0) {
    return 0;
  }
  return hour;
}

/** `_parsems`: "I[.F]" seconds → [seconds, microseconds]. */
function parseMs(value: string): [number, number] {
  if (!value.includes('.')) {
    return [pyInt(value), 0];
  }
  const parts = value.split('.');
  if (parts.length !== 2) {
    throw new TokenError();
  }
  const [whole = '', fraction = ''] = parts;
  const fractionChars = Array.from(fraction);
  while (fractionChars.length < 6) {
    fractionChars.push('0');
  }
  return [pyInt(whole), pyInt(fractionChars.slice(0, 6).join(''))];
}

/** `_parse_min_sec`: minutes plus a fraction turned into seconds (or null). */
function parseMinSec(value: DecimalValue): [number, number | null] {
  return [value.whole, hasFraction(value) ? sixtiethsOfFraction(value) : null];
}

class Tokens {
  readonly items: string[];

  // No parameter property: worker threads load this file with Node's
  // type stripping, which rejects them.
  constructor(items: string[]) {
    this.items = items;
  }

  get length(): number {
    return this.items.length;
  }

  /** `l[index]`, raising (IndexError → "Unknown string format") when out of range. */
  get(index: number): string {
    const token = this.items[index];
    if (token === undefined) {
      throw new TokenError();
    }
    return token;
  }
}

function findHmsIndex(index: number, tokens: Tokens): number | null {
  const { length } = tokens;
  if (index + 1 < length && hmsOf(tokens.get(index + 1)) !== undefined) {
    return index + 1;
  }
  if (
    index + 2 < length &&
    tokens.get(index + 1) === ' ' &&
    hmsOf(tokens.get(index + 2)) !== undefined
  ) {
    return index + 2;
  }
  if (index > 0 && hmsOf(tokens.get(index - 1)) !== undefined) {
    return index - 1;
  }
  if (
    index > 1 &&
    index === length - 1 &&
    tokens.get(index - 1) === ' ' &&
    hmsOf(tokens.get(index - 2)) !== undefined
  ) {
    return index - 2;
  }
  return null;
}

function assignHms(res: ParseResult, valueRepr: string, hms: number): void {
  const value = toDecimal(valueRepr);
  if (hms === 0) {
    res.hour = value.whole;
    if (hasFraction(value)) {
      res.minute = sixtiethsOfFraction(value);
    }
  } else if (hms === 1) {
    [res.minute, res.second] = parseMinSec(value);
  } else if (hms === 2) {
    [res.second, res.microsecond] = parseMs(valueRepr);
  }
}

/** `_parse_numeric_token`; returns the index of the last token consumed. */
function parseNumericToken(
  tokens: Tokens,
  start: number,
  ymd: Ymd,
  res: ParseResult,
): number {
  let index = start;
  const valueRepr = tokens.get(index);
  let value = toDecimal(valueRepr);
  const chars = Array.from(valueRepr);
  const tokenLength = chars.length;
  const slice = (from: number, to?: number): string =>
    chars.slice(from, to).join('');
  const { length } = tokens;

  if (
    ymd.length === 3 &&
    (tokenLength === 2 || tokenLength === 4) &&
    res.hour === null &&
    (index + 1 >= length ||
      (tokens.get(index + 1) !== ':' &&
        hmsOf(tokens.get(index + 1)) === undefined))
  ) {
    // 19990101T23[59]
    res.hour = pyInt(slice(0, 2));
    if (tokenLength === 4) {
      res.minute = pyInt(slice(2));
    }
  } else if (
    tokenLength === 6 ||
    (tokenLength > 6 && chars.indexOf('.') === 6)
  ) {
    // YYMMDD or HHMMSS[.ss]
    if (ymd.length === 0 && !valueRepr.includes('.')) {
      ymd.appendString(slice(0, 2));
      ymd.appendString(slice(2, 4));
      ymd.appendString(slice(4));
    } else {
      res.hour = pyInt(slice(0, 2));
      res.minute = pyInt(slice(2, 4));
      [res.second, res.microsecond] = parseMs(slice(4));
    }
  } else if (tokenLength === 8 || tokenLength === 12 || tokenLength === 14) {
    // YYYYMMDD[hhmm[ss]]
    ymd.appendString(slice(0, 4), 'Y');
    ymd.appendString(slice(4, 6));
    ymd.appendString(slice(6, 8));
    if (tokenLength > 8) {
      res.hour = pyInt(slice(8, 10));
      res.minute = pyInt(slice(10, 12));
      if (tokenLength > 12) {
        res.second = pyInt(slice(12));
      }
    }
  } else if (findHmsIndex(index, tokens) !== null) {
    // HH[ ]h or MM[ ]m or SS[.ss][ ]s
    const hmsIndex = findHmsIndex(index, tokens) ?? index;
    let hms: number;
    if (hmsIndex > index) {
      hms = hmsOf(tokens.get(hmsIndex)) ?? 0;
      index = hmsIndex;
    } else {
      hms = (hmsOf(tokens.get(hmsIndex)) ?? 0) + 1;
    }
    assignHms(res, valueRepr, hms);
  } else if (index + 2 < length && tokens.get(index + 1) === ':') {
    // HH:MM[:SS[.ss]]
    res.hour = value.whole;
    value = toDecimal(tokens.get(index + 2));
    [res.minute, res.second] = parseMinSec(value);
    if (index + 4 < length && tokens.get(index + 3) === ':') {
      [res.second, res.microsecond] = parseMs(tokens.get(index + 4));
      index += 2;
    }
    index += 2;
  } else if (
    index + 1 < length &&
    ['-', '/', '.'].includes(tokens.get(index + 1))
  ) {
    const separator = tokens.get(index + 1);
    ymd.appendString(valueRepr);
    if (index + 2 < length && !isJump(tokens.get(index + 2))) {
      const next = tokens.get(index + 2);
      if (isDigitString(next)) {
        // 01-01[-01]
        ymd.appendString(next);
      } else {
        // 01-Jan[-01]
        const month = monthOf(next);
        if (month === undefined) {
          throw new TokenError();
        }
        ymd.appendNumber(month, 'M');
      }
      if (index + 3 < length && tokens.get(index + 3) === separator) {
        // three members
        const last = tokens.get(index + 4);
        const month = monthOf(last);
        if (month === undefined) {
          ymd.appendString(last);
        } else {
          ymd.appendNumber(month, 'M');
        }
        index += 2;
      }
      index += 1;
    }
    index += 1;
  } else if (index + 1 >= length || isJump(tokens.get(index + 1))) {
    const ampm = index + 2 < length ? ampmOf(tokens.get(index + 2)) : undefined;
    if (ampm === undefined) {
      // year, month or day
      ymd.appendNumber(value);
    } else {
      // 12 am
      res.hour = adjustAmpm(value.whole, ampm);
      index += 1;
    }
    index += 1;
  } else if (ampmOf(tokens.get(index + 1)) !== undefined && value.whole < 24) {
    // 12am
    res.hour = adjustAmpm(value.whole, ampmOf(tokens.get(index + 1)) ?? 0);
    index += 1;
  } else if (ymd.couldBeDay(value)) {
    ymd.appendNumber(value);
  } else {
    throw new TokenError();
  }
  return index;
}

function emptyResult(): ParseResult {
  return {
    year: null,
    month: null,
    day: null,
    weekday: null,
    hour: null,
    minute: null,
    second: null,
    microsecond: null,
    tzname: null,
    tzoffset: null,
    ampm: null,
    centurySpecified: false,
  };
}

/** Python's `_parse`: null where dateutil returns `(None, None)`. */
function parseTokens(input: string, currentYear: number): ParseResult | null {
  const res = emptyResult();
  const tokens = new Tokens(timelexSplit(input));
  const list = tokens.items;
  const ymd = new Ymd();
  const { length } = tokens;
  let index = 0;
  try {
    while (index < length) {
      const token = tokens.get(index);
      if (isFloatToken(token)) {
        index = parseNumericToken(tokens, index, ymd, res);
      } else if (weekdayOf(token) !== undefined) {
        res.weekday = weekdayOf(token) ?? null;
      } else if (monthOf(token) !== undefined) {
        ymd.appendNumber(monthOf(token) ?? 0, 'M');
        if (index + 1 < length) {
          const next = tokens.get(index + 1);
          if (next === '-' || next === '/') {
            // Jan-01[-99]
            ymd.appendString(tokens.get(index + 2));
            if (index + 3 < length && tokens.get(index + 3) === next) {
              // Jan-01-99
              ymd.appendString(tokens.get(index + 4));
              index += 2;
            }
            index += 2;
          } else if (
            index + 4 < length &&
            next === ' ' &&
            tokens.get(index + 3) === ' ' &&
            isPertain(tokens.get(index + 2))
          ) {
            // Jan of 01: clearly a year
            const yearToken = tokens.get(index + 4);
            if (isDigitString(yearToken)) {
              const year = convertYear(pyInt(yearToken), false, currentYear);
              ymd.appendString(String(year), 'Y');
            }
            index += 4;
          }
        }
      } else if (ampmOf(token) !== undefined) {
        // _ampm_valid without fuzzy: the hour must be set and on a 12-hour clock.
        if (res.hour === null || res.hour < 0 || res.hour > 12) {
          throw new TokenError();
        }
        const ampm = ampmOf(token) ?? 0;
        res.hour = adjustAmpm(res.hour, ampm);
        res.ampm = ampm;
      } else if (couldBeTzname(res, token)) {
        res.tzname = token;
        res.tzoffset = tzOffsetOf(token);
        // "GMT+3" means "my time +3 is GMT": reverse the sign for the
        // numeric-offset branch below.
        const next = list[index + 1];
        if (next === '+' || next === '-') {
          list[index + 1] = next === '+' ? '-' : '+';
          res.tzoffset = null;
          if (isUtcZone(token)) {
            // With something like GMT+3, the timezone is *not* GMT.
            res.tzname = null;
          }
        }
      } else if (res.hour !== null && (token === '+' || token === '-')) {
        const sign = token === '+' ? 1 : -1;
        const offsetToken = tokens.get(index + 1);
        const offsetChars = Array.from(offsetToken);
        let hourOffset: number;
        let minuteOffset: number;
        if (offsetChars.length === 4) {
          // -0300
          hourOffset = pyInt(offsetChars.slice(0, 2).join(''));
          minuteOffset = pyInt(offsetChars.slice(2).join(''));
        } else if (index + 2 < length && tokens.get(index + 2) === ':') {
          // -03:00
          hourOffset = pyInt(offsetToken);
          minuteOffset = pyInt(tokens.get(index + 3));
          index += 2;
        } else if (offsetChars.length <= 2) {
          // -[0]3
          hourOffset = pyInt(offsetChars.slice(0, 2).join(''));
          minuteOffset = 0;
        } else {
          throw new TokenError();
        }
        res.tzoffset = sign * (hourOffset * 3600 + minuteOffset * 60);
        // A zone name in parentheses: "-0300 (BRST)".
        if (
          index + 5 < length &&
          isJump(tokens.get(index + 2)) &&
          tokens.get(index + 3) === '(' &&
          tokens.get(index + 5) === ')' &&
          Array.from(tokens.get(index + 4)).length >= 3 &&
          couldBeTzname(res, tokens.get(index + 4), true)
        ) {
          res.tzname = tokens.get(index + 4);
          index += 4;
        }
        index += 1;
      } else if (!isJump(token)) {
        throw new TokenError();
      }
      index += 1;
    }
    [res.year, res.month, res.day] = ymd.resolve();
    res.centurySpecified = ymd.centurySpecified;
  } catch (error) {
    if (error instanceof TokenError || error instanceof RangeError) {
      return null;
    }
    throw error;
  }

  // parserinfo.validate
  if (res.year !== null) {
    res.year = convertYear(res.year, res.centurySpecified, currentYear);
  }
  if (
    (res.tzoffset === 0 && !res.tzname) ||
    res.tzname === 'Z' ||
    res.tzname === 'z'
  ) {
    res.tzname = 'UTC';
    res.tzoffset = 0;
  } else if (res.tzoffset !== 0 && res.tzname && isUtcZone(res.tzname)) {
    res.tzoffset = 0;
  }
  return res;
}

// --- result building -------------------------------------------------------

const C_INT_MAX = 2_147_483_647;

/** `datetime.replace(**fields)` range checks, with CPython 3.14's messages. */
function checkFields(fields: PyDateTimeFieldsLike): void {
  for (const value of Object.values(fields)) {
    if (value > C_INT_MAX) {
      throw new RangeError('Python int too large to convert to C int');
    }
  }
  const { year, month, day, hour, minute, second, microsecond } = fields;
  if (year < 1 || year > 9999) {
    throw new DateFieldError(`year must be in 1..9999, not ${year}`);
  }
  if (month < 1 || month > 12) {
    throw new DateFieldError(`month must be in 1..12, not ${month}`);
  }
  const days = monthLength(year, month);
  if (day < 1 || day > days) {
    throw new DateFieldError(
      `day ${day} must be in range 1..${days} for month ${month} in year ${year}`,
    );
  }
  const ranges = [
    ['hour', hour, 23],
    ['minute', minute, 59],
    ['second', second, 59],
    ['microsecond', microsecond, 999_999],
  ] as const;
  for (const [name, value, max] of ranges) {
    if (value < 0 || value > max) {
      throw new DateFieldError(`${name} must be in 0..${max}, not ${value}`);
    }
  }
}

interface PyDateTimeFieldsLike {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
}

/** A `ValueError` from `datetime.replace`/`monthrange`, reported as `ParserError`. */
class DateFieldError extends Error {}

/** `_build_naive`: the parsed fields over the default, plus the weekday jump. */
function buildNaive(res: ParseResult, defaults: PyDateTime): PyDateTime {
  const fields: PyDateTimeFieldsLike = {
    year: res.year ?? defaults.year,
    month: res.month ?? defaults.month,
    day: res.day ?? defaults.day,
    hour: res.hour ?? defaults.hour,
    minute: res.minute ?? defaults.minute,
    second: res.second ?? defaults.second,
    microsecond: res.microsecond ?? defaults.microsecond,
  };
  if (res.day === null) {
    // If the default day exceeds the last day of the month, fall back to
    // the end of the month.
    let days: number;
    try {
      days = monthLength(fields.year, fields.month);
    } catch (error) {
      throw new DateFieldError((error as Error).message);
    }
    if (fields.day > days) {
      fields.day = days;
    }
  }
  checkFields(fields);
  let naive = new PyDateTime(fields);
  if (res.weekday !== null && !res.day) {
    // relativedelta(weekday=N): forward to the next such weekday.
    const days = (res.weekday - naive.weekday() + 7) % 7;
    if (days) {
      const date = new Date(0);
      date.setUTCFullYear(naive.year, naive.month - 1, naive.day + days);
      if (date.getUTCFullYear() > 9999) {
        throw new RangeError('date value out of range');
      }
      naive = naive.replace({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      });
    }
  }
  return naive;
}

/** `repr(timedelta(seconds=n))`. */
function timedeltaRepr(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const rest = seconds - days * 86_400;
  const parts: string[] = [];
  if (days) {
    parts.push(`days=${days}`);
  }
  if (rest) {
    parts.push(`seconds=${rest}`);
  }
  return `datetime.timedelta(${parts.length ? parts.join(', ') : '0'})`;
}

function withFixedOffset(naive: PyDateTime, seconds: number): PyDateTime {
  if (Math.abs(seconds) >= 86_400) {
    // dateutil returns the datetime; Python fails as soon as it is used.
    throw new RangeError(
      `offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not ${timedeltaRepr(seconds)}`,
    );
  }
  return naive.withOffset(seconds / 60);
}

// --- tz.tzlocal ------------------------------------------------------------

interface LocalZone {
  stdOffset: number;
  dstOffset: number;
  names: [string, string];
}

/**
 * ICU's English short names standing in for tzdata's abbreviations (which
 * Python's `time.tzname` reports): en-US knows the North American ones,
 * other English locales know BST, CET/CEST, WET, IST, AEST, NZST, SAST...
 * The first name that is not a bare "GMT+1"-style offset wins.
 */
const ZONE_NAME_LOCALES = [
  'en-US',
  'en-GB',
  'en-AU',
  'en-IN',
  'en-IE',
  'en-ZA',
  'en-NZ',
  'en-SG',
] as const;
const GMT_OFFSET_NAME = /^GMT[+-]/u;

function zoneName(date: Date): string {
  const tz = process.env.TZ;
  const options: Intl.DateTimeFormatOptions = { timeZoneName: 'short' };
  let name = '';
  for (const locale of ZONE_NAME_LOCALES) {
    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat(
        locale,
        tz ? { ...options, timeZone: tz } : options,
      );
    } catch {
      // An invalid TZ: ICU's default zone.
      format = new Intl.DateTimeFormat(locale, options);
    }
    name =
      format.formatToParts(date).find(part => part.type === 'timeZoneName')
        ?.value ?? '';
    if (!GMT_OFFSET_NAME.test(name)) {
      return name;
    }
  }
  return name;
}

const offsetAt = (ms: number): number => -new Date(ms).getTimezoneOffset();

const localZones = new Map<string, LocalZone>();

/** Python's `time.timezone`/`altzone`/`tzname`, from January and July of this year. */
function localZone(): LocalZone {
  const year = new Date().getFullYear();
  const key = `${process.env.TZ ?? ''}|${year}`;
  let zone = localZones.get(key);
  if (zone === undefined) {
    zone = computeLocalZone(year);
    localZones.set(key, zone);
  }
  return zone;
}

function computeLocalZone(year: number): LocalZone {
  const january = new Date(year, 0, 1);
  const july = new Date(year, 6, 1);
  const januaryOffset = offsetAt(january.getTime());
  const julyOffset = offsetAt(july.getTime());
  if (januaryOffset > julyOffset) {
    // Southern hemisphere: DST is in January.
    return {
      stdOffset: julyOffset,
      dstOffset: januaryOffset,
      names: [zoneName(july), zoneName(january)],
    };
  }
  return {
    stdOffset: januaryOffset,
    dstOffset: julyOffset,
    names: [zoneName(january), zoneName(july)],
  };
}

function wallMs(dt: PyDateTime): number {
  const date = new Date(0);
  date.setUTCFullYear(dt.year, dt.month - 1, dt.day);
  date.setUTCHours(dt.hour, dt.minute, dt.second);
  return date.getTime();
}

/** `tzlocal._isdst(dt)` with `dt.fold = fold`. */
function localIsDst(zone: LocalZone, wall: number, fold: number): boolean {
  const saved = zone.dstOffset - zone.stdOffset;
  if (!saved) {
    return false;
  }
  // _naive_is_dst: `tm_isdst` of the wall time read as standard time. JS
  // has no isdst flag; "at the zone's DST offset" stands in for it (an
  // offset that is neither, like LMT before 1883, is not DST).
  const naiveIsDst = (ms: number): boolean =>
    offsetAt(ms - zone.stdOffset * 60_000) === zone.dstOffset;
  const dst = naiveIsDst(wall);
  const ambiguous = !dst && dst !== naiveIsDst(wall - saved * 60_000);
  return ambiguous ? fold === 0 : dst;
}

/** `naive.replace(tzinfo=tz.tzlocal())` plus `_assign_tzname` and the UTC fallback. */
function withLocalZone(
  naive: PyDateTime,
  zone: LocalZone,
  tzname: string,
): PyDateTime {
  const wall = wallMs(naive);
  let isDst = localIsDst(zone, wall, 0);
  if (zone.names[isDst ? 1 : 0] !== tzname) {
    const folded = localIsDst(zone, wall, 1);
    if (zone.names[folded ? 1 : 0] === tzname) {
      isDst = folded;
    }
  }
  if (zone.names[isDst ? 1 : 0] !== tzname && UTCZONE.includes(tzname)) {
    return naive.withOffset(0);
  }
  return naive.withOffset(isDst ? zone.dstOffset : zone.stdOffset);
}

/** `_build_tzaware` without `tzinfos`. */
function buildAware(naive: PyDateTime, res: ParseResult): PyDateTime {
  if (res.tzname) {
    const zone = localZone();
    if (zone.names.includes(res.tzname)) {
      return withLocalZone(naive, zone, res.tzname);
    }
  }
  if (res.tzoffset === 0) {
    return naive.withOffset(0);
  }
  if (res.tzoffset) {
    return withFixedOffset(naive, res.tzoffset);
  }
  // No zone, or a zone name dateutil doesn't know (it warns and returns a
  // naive datetime).
  return naive;
}

function defaultDatetime(): PyDateTime {
  return PyDateTime.now().startOfDay();
}

/**
 * Parse a date/time string like `dateutil.parser.parse(timestr)`. Missing
 * fields come from `options.default` (today at midnight); a numeric offset
 * or UTC zone name makes the result aware, an unknown zone name is ignored.
 */
export function parseDate(
  input: string,
  options: ParseDateOptions = {},
): PyDateTime {
  if (input.length > MAX_DATE_LENGTH) {
    throw new DateParseError(
      `String of ${input.length} characters is too long to be a date`,
    );
  }
  const currentYear = options.currentYear ?? new Date().getFullYear();
  const res = parseTokens(input, currentYear);
  if (res === null) {
    throw new DateParseError(`Unknown string format: ${input}`);
  }
  const isEmpty =
    res.year === null &&
    res.month === null &&
    res.day === null &&
    res.weekday === null &&
    res.hour === null &&
    res.minute === null &&
    res.second === null &&
    res.microsecond === null &&
    res.tzname === null &&
    res.tzoffset === null &&
    res.ampm === null;
  if (isEmpty) {
    throw new DateParseError(`String does not contain a date: ${input}`);
  }
  let naive: PyDateTime;
  try {
    naive = buildNaive(res, options.default ?? defaultDatetime());
  } catch (error) {
    if (error instanceof DateFieldError) {
      throw new DateParseError(`${error.message}: ${input}`);
    }
    throw error;
  }
  return buildAware(naive, res);
}

/** Python's `datetime.fromtimestamp(int(timestamp))`: naive, local time. */
export function timestampToDatetime(timestamp: number | string): PyDateTime {
  return PyDateTime.fromTimestamp(Math.trunc(Number(timestamp)));
}

/** A UNIX timestamp as local `YYYY-MM-DD HH:MM:SS`. */
export function timestampToHuman(timestamp: number | string): string {
  return timestampToDatetime(timestamp).strftime('%Y-%m-%d %H:%M:%S');
}

/**
 * Remove RFC 5322 comments from a header value. Comments nest and may hold
 * quoted-pairs such as `\)`, so this counts depth instead of using a regex;
 * an unclosed comment runs to the end of the value.
 */
export function stripComments(value: string): string {
  let out = '';
  let depth = 0;
  let escaped = false;
  for (const char of value) {
    if (depth) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
    } else if (char === '(') {
      depth = 1;
    } else {
      out += char;
    }
  }
  return out;
}

export interface HumanTimestampOptions {
  /** Convert the result to UTC. */
  toUtc?: boolean;
  /** Treat a timestamp without a UTC offset as UTC instead of local time. */
  assumeUtc?: boolean;
}

/** Parse a human-readable timestamp (Python's `human_timestamp_to_datetime`). */
export function humanTimestampToDatetime(
  humanTimestamp: string,
  options: HumanTimestampOptions = {},
): PyDateTime {
  const cleaned = stripComments(humanTimestamp.replaceAll('-0000', '')).trim();
  let datetime = parseDate(cleaned);
  if (options.assumeUtc && datetime.isNaive) {
    datetime = datetime.withOffset(0);
  }
  return options.toUtc ? datetime.toUtc() : datetime;
}

/** Parse a human-readable timestamp into a UNIX timestamp (whole seconds). */
export function humanTimestampToUnixTimestamp(
  humanTimestamp: string,
  options: Pick<HumanTimestampOptions, 'assumeUtc'> = {},
): number {
  const datetime = humanTimestampToDatetime(
    humanTimestamp.replaceAll('T', ' '),
    options,
  );
  return Math.trunc(datetime.timestamp());
}
