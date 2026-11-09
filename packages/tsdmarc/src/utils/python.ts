// Python's str()/repr() for the values parsedmarc writes into CSV cells and
// text payloads. JS numbers don't keep Python's int/float distinction, so
// integral numbers print as ints; use `pyFloatRepr()` where Python has a float.

import { pyRepr as pyStrRepr } from './py-str';

/** Python's `repr(float)`: shortest round-trip digits, `1.0`, `1e-05`, `inf`. */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) {
    return 'nan';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'inf' : '-inf';
  }
  if (value === 0) {
    return Object.is(value, -0) ? '-0.0' : '0.0';
  }
  // The exponent of the shortest round-trip digits (Math.log10 rounds
  // 9999999999999998 up to 16).
  const [mantissa = '', power = '0'] = value.toExponential().split('e');
  const exponent = Number(power);
  if (exponent < -4 || exponent >= 16) {
    const sign = power.startsWith('-') ? '-' : '+';
    const digits = power.replace(/^[+-]/u, '').padStart(2, '0');
    return `${mantissa}e${sign}${digits}`;
  }
  const text = String(value);
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

/** A list or dict {@link pyRepr} is writing: its children with key prefixes. */
interface ReprContainer {
  open: string;
  close: string;
  entries: [prefix: string, child: unknown][];
  /** The next child to write. */
  index: number;
}

/** The repr of a scalar, or the container to open. */
function reprScalar(value: unknown): string | ReprContainer {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'string') {
    // The one `repr(str)` implementation: escapes every character
    // `str.isprintable()` rejects (controls, DEL, NEL, NBSP, ZWSP, ...).
    return pyStrRepr(value);
  }
  if (Array.isArray(value)) {
    return {
      open: '[',
      close: ']',
      entries: value.map((item): [string, unknown] => ['', item]),
      index: 0,
    };
  }
  const object =
    value instanceof Map ? (Object.fromEntries(value) as object) : value;
  if (typeof object === 'object' && !(object instanceof Date)) {
    if (typeof (object as { toJSON?: unknown }).toJSON === 'function') {
      return pyStr(object);
    }
    return {
      open: '{',
      close: '}',
      entries: Object.entries(object).map(([key, item]): [string, unknown] => [
        `${pyStrRepr(key)}: `,
        item,
      ]),
      index: 0,
    };
  }
  return pyStr(value);
}

/**
 * Python's `repr()` for JSON-like values (strings use single quotes).
 * Written in one pass with an explicit stack: linear in the output, and data
 * nested deeper than the call stack allows still prints.
 */
export function pyRepr(value: unknown): string {
  const out: string[] = [];
  const stack: ReprContainer[] = [];
  const write = (repr: string | ReprContainer): void => {
    if (typeof repr === 'string') {
      out.push(repr);
    } else {
      out.push(repr.open);
      stack.push(repr);
    }
  };
  write(reprScalar(value));
  for (let frame = stack.at(-1); frame; frame = stack.at(-1)) {
    const entry = frame.entries[frame.index];
    if (entry === undefined) {
      stack.pop();
      out.push(frame.close);
      continue;
    }
    if (frame.index > 0) {
      out.push(', ');
    }
    frame.index += 1;
    out.push(entry[0]);
    write(reprScalar(entry[1]));
  }
  return out.join('');
}

/** Python's `str()` for JSON-like values. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      return pyFloatRepr(value);
    }
    // Python ints print every digit exactly; String() gives the shortest
    // round-trip digits past 2**53 and 1e+21 notation from 1e21.
    return Math.abs(value) >= Number.MAX_SAFE_INTEGER
      ? BigInt(value).toString()
      : String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) || value instanceof Map) {
    return pyRepr(value);
  }
  if (typeof value === 'object') {
    // Objects with their own toString (PyDateTime) print with it; plain and
    // null-prototype objects (parsed XML/JSON) print like a Python dict.
    const { toString } = value as { toString?: unknown };
    if (
      typeof toString === 'function' &&
      toString !== Object.prototype.toString
    ) {
      return (value as { toString: () => string }).toString();
    }
    return pyRepr(value);
  }
  return String(value);
}
