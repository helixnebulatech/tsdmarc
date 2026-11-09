// Python semantics the parsers rely on when they walk parsed JSON/XML:
// `d[key]` raising KeyError/TypeError, `x in y`, `type(x)` names, and
// parsedmarc's `_exc_origin()` debug suffix. Errors carry Python's messages
// so wrapped error text matches parsedmarc's.

import { DEBUG, logger } from '../log';
import { pyRepr } from '../utils/python';
import { PY_INT_MAX_STR_DIGITS } from '../utils/timestamps';

/** Python's `KeyError`; `message` is `repr(key)` like `str(KeyError(key))`. */
export class KeyError extends Error {
  override name = 'KeyError';
  readonly key: unknown;

  constructor(key: unknown) {
    super(pyRepr(key));
    this.key = key;
  }
}

/** Python's `TypeError`, for wrong-type subscripts and membership tests. */
export class PyTypeError extends TypeError {
  override name = 'TypeError';
}

/** Python's `AttributeError`, e.g. calling `.lower()` on `None`. */
export class PyAttributeError extends Error {
  override name = 'AttributeError';
}

/** Python's `IndexError`, e.g. `list index out of range`. */
export class PyIndexError extends RangeError {
  override name = 'IndexError';
}

/** Python's `OverflowError`. */
export class PyOverflowError extends RangeError {
  override name = 'OverflowError';
}

/** Python's `ValueError`. */
export class PyValueError extends Error {
  override name = 'ValueError';
}

export type PyDict = Record<string, unknown>;

/** True for a JSON object (Python `dict`), false for arrays, null, scalars. */
export function isDict(value: unknown): value is PyDict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Python's `type(value).__name__` for JSON-like values. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NoneType';
  }
  if (Array.isArray(value)) {
    return 'list';
  }
  switch (typeof value) {
    case 'string':
      return 'str';
    case 'boolean':
      return 'bool';
    case 'bigint':
      return 'int';
    case 'number':
      return Number.isInteger(value) ? 'int' : 'float';
    case 'object':
      return 'dict';
    default:
      return typeof value;
  }
}

/** Python's `repr(type(value))`, e.g. `<class 'dict'>`. */
export function pyTypeRepr(value: unknown): string {
  return `<class '${pyTypeName(value)}'>`;
}

/** Python's `value[key]` on a dict, raising KeyError/TypeError like Python. */
export function getItem(value: unknown, key: string): unknown {
  if (isDict(value)) {
    if (!Object.hasOwn(value, key)) {
      throw new KeyError(key);
    }
    return value[key];
  }
  const type = pyTypeName(value);
  // CPython 3.14 wording: only the str message quotes the key's type.
  if (type === 'str') {
    throw new PyTypeError("string indices must be integers, not 'str'");
  }
  if (type === 'list') {
    throw new PyTypeError('list indices must be integers or slices, not str');
  }
  throw new PyTypeError(`'${type}' object is not subscriptable`);
}

/** Python's `dict.get(key)`; `undefined` (missing) and `null` both mean None. */
export function getOptional(value: unknown, key: string): unknown {
  if (!isDict(value)) {
    throw noAttribute(value, 'get');
  }
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/** Python's `key in container` for dicts, lists and strings. */
export function pyContains(container: unknown, key: unknown): boolean {
  if (isDict(container)) {
    return typeof key === 'string' && Object.hasOwn(container, key);
  }
  if (Array.isArray(container)) {
    return container.includes(key);
  }
  if (typeof container === 'string') {
    if (typeof key !== 'string') {
      throw new PyTypeError(
        `'in <string>' requires string as left operand, not ${pyTypeName(key)}`,
      );
    }
    return container.includes(key);
  }
  throw new PyTypeError(
    `argument of type '${pyTypeName(container)}' is not a container or iterable`,
  );
}

/** Python's `for item in value` over parsed JSON/XML data. */
export function pyIter(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return [...value];
  }
  if (isDict(value)) {
    return Object.keys(value);
  }
  throw new PyTypeError(`'${pyTypeName(value)}' object is not iterable`);
}

/**
 * Python's `value in frozenset_of_strings`: dicts and lists are unhashable,
 * so the membership test itself raises TypeError.
 */
export function pyFrozensetContains(
  set: ReadonlySet<string>,
  value: unknown,
): boolean {
  if (isDict(value) || Array.isArray(value)) {
    const type = pyTypeName(value);
    throw new PyTypeError(
      `cannot use '${type}' as a set element (unhashable type: '${type}')`,
    );
  }
  return typeof value === 'string' && set.has(value);
}

/** Python's `separator.join(items)`: every item must be a str. */
export function pyStrJoin(
  separator: string,
  items: readonly unknown[],
): string {
  for (const [index, item] of items.entries()) {
    if (typeof item !== 'string') {
      throw new PyTypeError(
        `sequence item ${index}: expected str instance, ${pyTypeName(item)} found`,
      );
    }
  }
  return items.join(separator);
}

/** Python's `bool(value)` for JSON-like values. */
export function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isDict(value)) {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

/** Python's `str(error)`. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * parsedmarc's `_exc_origin()`: ` (raised at <file>:<line>)` for the frame
 * that threw, only when the library logger is at DEBUG; `""` otherwise.
 */
export function excOrigin(error: unknown): string {
  if (!logger.isEnabledFor(DEBUG) || !(error instanceof Error)) {
    return '';
  }
  const frame = (error.stack ?? '')
    .split('\n')
    .slice(1)
    .find(line => line.trimStart().startsWith('at '));
  if (frame === undefined) {
    return '';
  }
  const location = frame.includes('(')
    ? frame.slice(frame.lastIndexOf('(') + 1, frame.lastIndexOf(')'))
    : frame.trim().slice(3);
  const match = /^(?<file>.*):(?<line>\d+):\d+$/u.exec(location);
  if (!match?.groups) {
    return '';
  }
  return ` (raised at ${match.groups.file}:${match.groups.line})`;
}

/** Python's `AttributeError` for `value.<attribute>`. */
export function noAttribute(
  value: unknown,
  attribute: string,
): PyAttributeError {
  return new PyAttributeError(
    `'${pyTypeName(value)}' object has no attribute '${attribute}'`,
  );
}

/** Python's `value.lower()`: only strings have it. */
export function pyLower(value: unknown): string {
  if (typeof value !== 'string') {
    throw noAttribute(value, 'lower');
  }
  return value.toLowerCase();
}

/** Python's `value.split(separator)`: only strings have it. */
export function pySplit(value: unknown, separator: string): string[] {
  if (typeof value !== 'string') {
    throw noAttribute(value, 'split');
  }
  return value.split(separator);
}

/**
 * Python's `value.copy()` (shallow) for dicts and lists; other types have
 * no `copy`. A list copy is typed as a dict because the callers go on to
 * subscript it, which raises TypeError for a list as in Python.
 */
export function dictCopy(value: unknown): PyDict {
  if (Array.isArray(value)) {
    return [...value] as unknown as PyDict;
  }
  if (!isDict(value)) {
    throw noAttribute(value, 'copy');
  }
  return { ...value };
}

/**
 * The characters `int()` strips around its argument (CPython's
 * `Py_UNICODE_ISSPACE` minus the C0 separators `\x1c`-`\x1f`, which
 * `_PyUnicode_TransformDecimalAndSpaceToASCII` doesn't map to a space).
 * Unlike JS `trim()`, U+FEFF is not whitespace and U+0085 is.
 */
const INT_WHITESPACE: ReadonlySet<string> = new Set(
  '\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000',
);

/** Strip {@link INT_WHITESPACE} from both ends (a loop: no regex backtracking). */
function stripIntWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && INT_WHITESPACE.has(text.charAt(start))) {
    start += 1;
  }
  while (end > start && INT_WHITESPACE.has(text.charAt(end - 1))) {
    end -= 1;
  }
  return text.slice(start, end);
}

/** Python's base-10 int literal: any Unicode decimal digits, `_` between. */
const INT_LITERAL = /^[+-]?\p{Nd}+(?:_\p{Nd}+)*$/u;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const ASCII_ZERO = 0x30;
const DIGITS_PER_RUN = 10;

/**
 * The value of a Unicode decimal digit. Unicode encodes every `Nd` digit in
 * runs of ten consecutive code points, 0 to 9, so the value is the offset
 * from the start of its run modulo 10.
 */
function decimalDigitValue(codePoint: number): number {
  if (codePoint < ASCII_ZERO + DIGITS_PER_RUN) {
    return codePoint - ASCII_ZERO;
  }
  let start = codePoint;
  while (DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) {
    start -= 1;
  }
  return (codePoint - start) % DIGITS_PER_RUN;
}

/** A safe integer as a number, anything larger as an exact bigint. */
export function intValue(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

/** Code points of `repr()` that CPython's `%.200R` keeps in error messages. */
const ERROR_REPR_LENGTH = 200;

/** `"%.200R" % value`: the repr cut to its first 200 code points. */
function truncatedRepr(value: unknown): string {
  const repr = pyRepr(value);
  let end = 0;
  for (let kept = 0; kept < ERROR_REPR_LENGTH && end < repr.length; kept += 1) {
    end += (repr.codePointAt(end) ?? 0) > 0xff_ff ? 2 : 1;
  }
  return repr.slice(0, end);
}

/** Python's error for a decimal integer over `sys.get_int_max_str_digits()`. */
export function intDigitsError(digits: number): PyValueError {
  return new PyValueError(
    `Exceeds the limit (${PY_INT_MAX_STR_DIGITS} digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`,
  );
}

/**
 * Python's `int(value)` for strings, numbers and booleans, exact: values
 * beyond ±2^53 come back as a `bigint` (Python ints are unbounded).
 */
export function pyIntExact(value: unknown): number | bigint {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'bigint') {
    return intValue(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PyValueError(
        `cannot convert float ${Number.isNaN(value) ? 'NaN' : 'infinity'} to integer`,
      );
    }
    return intValue(BigInt(Math.trunc(value)));
  }
  if (typeof value === 'string') {
    const text = stripIntWhitespace(value);
    if (!INT_LITERAL.test(text)) {
      throw new PyValueError(
        `invalid literal for int() with base 10: ${truncatedRepr(value)}`,
      );
    }
    // sys.get_int_max_str_digits(): every digit counts, leading zeros too.
    let digitCount = 0;
    for (const char of text) {
      if (char !== '_' && char !== '+' && char !== '-') {
        digitCount += 1;
      }
    }
    if (digitCount > PY_INT_MAX_STR_DIGITS) {
      throw intDigitsError(digitCount);
    }
    let digits = '';
    for (const char of text) {
      if (char === '_' || char === '+' || char === '-') {
        digits += char === '-' ? '-' : '';
        continue;
      }
      digits += String(decimalDigitValue(char.codePointAt(0) as number));
    }
    return intValue(BigInt(digits));
  }
  throw new PyTypeError(
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(value)}'`,
  );
}

/**
 * Python's `int(value)` as a JS number, for values that are small in
 * practice (message UIDs); see {@link pyIntExact} for the exact form.
 */
export function pyInt(value: unknown): number {
  return Number(pyIntExact(value));
}
