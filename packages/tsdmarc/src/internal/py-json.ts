// Python's `json.dumps()`, for output whose exact bytes matter: syslog
// messages, GELF packets, Splunk and Kafka events (default
// `ensure_ascii=True`), and the JSON output files (`ensure_ascii=False,
// indent=2`). Python ints are unbounded and dumped exactly, so `bigint`s
// (counts beyond 2^53) are written as exact integers too.

import { pyFloatRepr } from '../utils/python';
import { PyTypeError } from './py';
import { setOwn } from './set-own';

export interface PyJsonDumpsOptions {
  /** `(item_separator, key_separator)`; Python's default is `(', ', ': ')`. */
  separators?: readonly [string, string];
  /**
   * Called for values JSON can't represent, like Python's `default=`; its
   * result is serialized instead. Without it they throw `TypeError`.
   */
  default?: (value: unknown) => unknown;
  /** Pretty-print with this many spaces per level, like `indent=`. */
  indent?: number | null;
  /** Escape non-ASCII as `\uXXXX`, like `ensure_ascii=`. Default: true. */
  ensureAscii?: boolean;
  /**
   * Write `NaN`, `Infinity` and `-Infinity` as `null`, for a consumer that
   * expects standard JSON. Python writes them bare (`allow_nan=True`).
   */
  nonFiniteAsNull?: boolean;
}

const NON_FINITE_TEXTS: ReadonlySet<string> = new Set([
  'NaN',
  'Infinity',
  '-Infinity',
]);

/**
 * A number as Python's `json.dumps()` writes it back after `json.loads()`
 * (an exact int, or a float's `repr`), so values a JS number can't keep
 * (`12345678901234567890`, `1.0`) survive a load/dump round trip.
 */
export class PyJsonNumber {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

const PRINTABLE_ASCII_FIRST = 0x20;
const PRINTABLE_ASCII_LAST = 0x7e;

const HIGH_SURROGATE_FIRST = 0xd8_00;
const LOW_SURROGATE_FIRST = 0xdc_00;
const LOW_SURROGATE_LAST = 0xdf_ff;

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST;
}

function isLoneSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code < HIGH_SURROGATE_FIRST || code > LOW_SURROGATE_LAST) {
    return false;
  }
  if (code < LOW_SURROGATE_FIRST) {
    return !isLowSurrogate(text.charCodeAt(index + 1));
  }
  const previous = text.charCodeAt(index - 1);
  return !(previous >= HIGH_SURROGATE_FIRST && previous < LOW_SURROGATE_FIRST);
}

/**
 * `ensure_ascii=False`: only `"`, `\\` and control characters are escaped.
 * Lone surrogates are escaped as well; Python can't write them as UTF-8.
 */
function encodeStringUnicode(text: string): string {
  let result = '"';
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    const code = text.charCodeAt(index);
    const short = SHORT_ESCAPES[char];
    if (short !== undefined) {
      result += short;
    } else if (code < PRINTABLE_ASCII_FIRST || isLoneSurrogate(text, index)) {
      result += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      result += char;
    }
  }
  return `${result}"`;
}

/** A JSON string with every non-printable-ASCII UTF-16 unit as `\uXXXX`. */
function encodeString(text: string): string {
  let result = '"';
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    const code = text.charCodeAt(index);
    const short = SHORT_ESCAPES[char];
    if (short !== undefined) {
      result += short;
    } else if (code < PRINTABLE_ASCII_FIRST || code > PRINTABLE_ASCII_LAST) {
      result += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      result += char;
    }
  }
  return `${result}"`;
}

function encodeNumber(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'Infinity' : '-Infinity';
  }
  // JS numbers lose Python's int/float distinction: integral values print
  // as ints (BigInt avoids exponent notation for large ones).
  return Number.isInteger(value)
    ? BigInt(value).toString()
    : pyFloatRepr(value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function typeName(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    return value.constructor?.name ?? 'object';
  }
  return typeof value;
}

/** Python's `json.dumps(value, separators=, default=, indent=, ensure_ascii=)`. */
export function pyJsonDumps(
  value: unknown,
  options: PyJsonDumpsOptions = {},
): string {
  const indent = options.indent ?? null;
  // With an indent, Python's default item separator has no trailing space.
  const [itemSeparator, keySeparator] =
    options.separators ?? (indent === null ? [', ', ': '] : [',', ': ']);
  const encodeText =
    (options.ensureAscii ?? true) ? encodeString : encodeStringUnicode;
  // A scalar's JSON text, or the entries of the container to open, each with
  // its key prefix (`"key": `, empty in an array).
  const encodeScalar = (item: unknown): string | OpenContainer => {
    let current = item;
    for (;;) {
      if (current === null || current === undefined) {
        return 'null';
      }
      if (current === true) {
        return 'true';
      }
      if (current === false) {
        return 'false';
      }
      if (typeof current === 'string') {
        return encodeText(current);
      }
      if (typeof current === 'number') {
        return options.nonFiniteAsNull && !Number.isFinite(current)
          ? 'null'
          : encodeNumber(current);
      }
      if (typeof current === 'bigint') {
        return current.toString();
      }
      if (current instanceof PyJsonNumber) {
        return options.nonFiniteAsNull && NON_FINITE_TEXTS.has(current.text)
          ? 'null'
          : current.text;
      }
      if (Array.isArray(current)) {
        return {
          close: ']',
          entries: current.map((entry): [string, unknown] => ['', entry]),
          index: 0,
          open: '[',
        };
      }
      if (typeof current === 'object' && isPlainObject(current)) {
        return {
          close: '}',
          entries: Object.entries(current).map(
            ([key, entry]): [string, unknown] => [
              `${encodeText(key)}${keySeparator}`,
              entry,
            ],
          ),
          index: 0,
          open: '{',
        };
      }
      if (options.default === undefined) {
        throw new PyTypeError(
          `Object of type ${typeName(current)} is not JSON serializable`,
        );
      }
      current = options.default(current);
    }
  };
  // Written in one pass to a list of pieces, with an explicit stack of open
  // containers: linear in the output, and data nested deeper than the call
  // stack allows is still encoded.
  const out: string[] = [];
  const stack: OpenContainer[] = [];
  const newline = (depth: number): void => {
    if (indent !== null) {
      out.push(`\n${' '.repeat(indent * depth)}`);
    }
  };
  const write = (encoded: string | OpenContainer): void => {
    if (typeof encoded === 'string') {
      out.push(encoded);
    } else if (encoded.entries.length === 0) {
      out.push(`${encoded.open}${encoded.close}`);
    } else {
      out.push(encoded.open);
      stack.push(encoded);
    }
  };
  write(encodeScalar(value));
  for (let frame = stack.at(-1); frame; frame = stack.at(-1)) {
    const entry = frame.entries[frame.index];
    if (entry === undefined) {
      stack.pop();
      newline(stack.length);
      out.push(frame.close);
      continue;
    }
    if (frame.index > 0) {
      out.push(itemSeparator);
    }
    frame.index += 1;
    newline(stack.length);
    out.push(entry[0]);
    write(encodeScalar(entry[1]));
  }
  return out.join('');
}

/** A container {@link pyJsonDumps} is writing: its children with key prefixes. */
interface OpenContainer {
  open: string;
  close: string;
  entries: [prefix: string, child: unknown][];
  /** The next child to write. */
  index: number;
}

/** `JSON.rawJSON()` (Node ≥ 21, Bun, Deno); the ES2026 lib isn't enabled. */
const JSON_WITH_RAW = JSON as JSON & {
  rawJSON: (text: string) => unknown;
};

/**
 * A copy of `value` that `JSON.stringify()` serializes like Python's
 * `json.dumps()` writes ints: every `bigint` (and `PyJsonNumber`) becomes a
 * `JSON.rawJSON()` exact integer, where `JSON.stringify()` would throw on a
 * bigint. For payloads that SDKs serialize themselves (Elasticsearch,
 * OpenSearch, Azure Log Analytics). Arrays and plain objects are copied;
 * other values are kept as they are.
 */
export function rawJsonIntegers(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return JSON_WITH_RAW.rawJSON(value.toString());
  }
  if (value instanceof PyJsonNumber) {
    return JSON_WITH_RAW.rawJSON(value.text);
  }
  if (Array.isArray(value)) {
    return value.map(item => rawJsonIntegers(item));
  }
  if (typeof value === 'object' && value !== null && isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      setOwn(result, key, rawJsonIntegers(item));
    }
    return result;
  }
  return value;
}
