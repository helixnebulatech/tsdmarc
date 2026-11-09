// Small Python semantics the port needs: `int()` / truthiness as the DSL's
// field cleaning applies them, and dict lookups that raise `KeyError`.
// `repr()`/`str()` come from the core (`pyRepr`, `pyStr`).
//
// Shared by @tsdmarc/elasticsearch and @tsdmarc/opensearch, which both bundle
// it (parsedmarc duplicates elastic.py and opensearch.py instead).

import { camelToSnake, pyRepr } from 'tsdmarc';

const ASCII_INT = /^[+-]?\d+(?:_\d+)*$/u;

/** Python's `KeyError`: a missing key in a report dict. */
export class KeyError extends Error {
  override name = 'KeyError';
  readonly key: string;

  constructor(key: string) {
    // str(KeyError('x')) is the repr of the key: 'x'
    super(pyRepr(key));
    this.key = key;
  }
}

/**
 * `target[key] = value` as a Python dict does it: an own enumerable
 * property even for keys from report data like `__proto__`, which plain
 * assignment would turn into a prototype change (and drop).
 */
export function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Python's `ValueError`. */
export class ValueError extends Error {
  override name = 'ValueError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `obj[key]` with Python's KeyError for a missing key. `key` is the camelCase
 * key of the report object; the error names the snake_case key, as parsedmarc
 * reports it.
 */
export function getKey(obj: unknown, key: string): unknown {
  if (!isRecord(obj) || !(key in obj)) {
    throw new KeyError(camelToSnake(key));
  }
  return obj[key];
}

/** Python's truthiness (`bool(value)`). */
export function pyBool(value: unknown): boolean {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (typeof value === 'number') {
    return value !== 0 && !Number.isNaN(value);
  }
  if (typeof value === 'bigint') {
    return value !== 0n;
  }
  if (typeof value === 'string' || Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

/** A safe integer as a number, anything larger as an exact bigint. */
function exactInt(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

/**
 * Python's `int(value)` for the values reports carry (ASCII digits). Exact,
 * like Python's unbounded ints: beyond 2^53 the result is a `bigint`.
 */
export function pyInt(value: unknown): number | bigint {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'bigint') {
    return exactInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValueError(
        `cannot convert float ${Number.isNaN(value) ? 'NaN' : 'infinity'} to integer`,
      );
    }
    return exactInt(BigInt(Math.trunc(value)));
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (ASCII_INT.test(text)) {
      return exactInt(BigInt(text.replaceAll('_', '')));
    }
    throw new ValueError(
      `invalid literal for int() with base 10: ${pyRepr(value)}`,
    );
  }
  throw new ValueError(
    `int() argument must be a string, a bytes-like object or a real number, not '${typeof value}'`,
  );
}

const EXACT_INTEGER_KEY = '__tsdmarc_exact_integer__';
// Strings are matched first so that digits inside them are left alone; an
// integer is only taken between JSON delimiters, never inside a float.
const JSON_STRING_OR_LONG_INTEGER =
  /"[^"\\]*(?:\\.[^"\\]*)*"|(?<=[:,[\s])-?\d{16,}(?=[,\]}\s])/gu;

/**
 * JSON text with integers that a double may not hold (16 digits or more)
 * wrapped, so that {@link restoreLongIntegers} can undo it after parsing.
 * Returns `text` itself when there are none.
 */
export function markLongIntegers(text: string): string {
  return text.replaceAll(JSON_STRING_OR_LONG_INTEGER, match =>
    match.startsWith('"') ? match : `{"${EXACT_INTEGER_KEY}":"${match}"}`,
  );
}

/** A parsed value of {@link markLongIntegers} with exact integers back. */
export function restoreLongIntegers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => restoreLongIntegers(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const exact = value[EXACT_INTEGER_KEY];
  if (typeof exact === 'string' && Object.keys(value).length === 1) {
    return pyInt(exact);
  }
  for (const [key, item] of Object.entries(value)) {
    setOwn(value, key, restoreLongIntegers(item));
  }
  return value;
}

/** `str(error)`: the message of an error, or the value itself. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
