// Python `str` semantics that differ from JavaScript's built-ins.
//
// mail-parser and Python's `email` package lean on `str.strip()`,
// `str.splitlines()`, `str.isspace()`, `str.split()` and `repr()`. Their
// notions of whitespace and line boundaries are not JavaScript's (`trim()`
// strips U+FEFF but not U+001C-U+001F or U+0085), so they are ported here.

/** Characters for which Python's `str.isspace()` is true. */
export const PY_WHITESPACE_CHARS: string =
  '\t\n\v\f\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680\u2000\u2001\u2002' +
  '\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';

/** Regex character-class body matching Python's `\s` on `str`. */
export const PY_WS_CLASS: string =
  '\\t\\n\\v\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

const WHITESPACE_SET: ReadonlySet<string> = new Set(PY_WHITESPACE_CHARS);

// Line boundaries of `str.splitlines()`; `\r\n` counts as one.
// oxlint-disable-next-line no-control-regex -- U+001C-U+001E are line boundaries in Python.
const LINE_BOUNDARY = /\r\n|[\n\v\f\r\u001c\u001d\u001e\u0085\u2028\u2029]/gu;
const WHITESPACE_RUN = new RegExp(`[${PY_WS_CLASS}]+`, 'u');
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python's `s.isspace()`: non-empty and only whitespace. */
export function pyIsSpace(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  for (const char of text) {
    if (!WHITESPACE_SET.has(char)) {
      return false;
    }
  }
  return true;
}

function stripSet(chars: string | undefined): (char: string) => boolean {
  if (chars === undefined) {
    return char => WHITESPACE_SET.has(char);
  }
  const set = new Set(chars);
  return char => set.has(char);
}

/** Python's `s.lstrip(chars)` (whitespace when `chars` is omitted). */
export function pyLStrip(text: string, chars?: string): string {
  const strip = stripSet(chars);
  let start = 0;
  while (start < text.length && strip(text.charAt(start))) {
    start += 1;
  }
  return text.slice(start);
}

/** Python's `s.rstrip(chars)` (whitespace when `chars` is omitted). */
export function pyRStrip(text: string, chars?: string): string {
  const strip = stripSet(chars);
  let end = text.length;
  while (end > 0 && strip(text.charAt(end - 1))) {
    end -= 1;
  }
  return text.slice(0, end);
}

/** Python's `s.strip(chars)` (whitespace when `chars` is omitted). */
export function pyStrip(text: string, chars?: string): string {
  return pyRStrip(pyLStrip(text, chars), chars);
}

/** Python's `s.splitlines(keepends)`. */
export function pySplitlines(text: string, keepends = false): string[] {
  const lines: string[] = [];
  let start = 0;
  for (const match of text.matchAll(LINE_BOUNDARY)) {
    const end = match.index + match[0].length;
    lines.push(text.slice(start, keepends ? end : match.index));
    start = end;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/** Python's `s.split(None, maxsplit)`: split on whitespace runs. */
export function pySplitWhitespace(text: string, maxsplit = -1): string[] {
  const parts: string[] = [];
  let rest = pyLStrip(text);
  while (rest.length > 0) {
    if (maxsplit >= 0 && parts.length === maxsplit) {
      parts.push(rest);
      break;
    }
    const match = WHITESPACE_RUN.exec(rest);
    if (match === null) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, match.index));
    rest = pyLStrip(rest.slice(match.index));
  }
  return parts;
}

/** Python's `len(s)`: the number of code points. */
export function pyLen(text: string): number {
  let count = 0;
  for (const _char of text) {
    count += 1;
  }
  return count;
}

/** Python's `s[:n]`, counting code points. */
export function pySliceStart(text: string, count: number): string {
  let index = 0;
  let seen = 0;
  for (const char of text) {
    if (seen === count) {
      break;
    }
    index += char.length;
    seen += 1;
  }
  return text.slice(0, index);
}

function escapeCodePoint(code: number): string {
  if (code < 0x100) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }
  if (code < 0x10000) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `\\U${code.toString(16).padStart(8, '0')}`;
}

const REPR_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** Python's `repr()` of a `str`. */
export function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let output = quote;
  for (const char of text) {
    const escaped = REPR_ESCAPES[char];
    if (escaped !== undefined) {
      output += escaped;
    } else if (char === quote) {
      output += `\\${char}`;
    } else if (char !== ' ' && NON_PRINTABLE.test(char)) {
      output += escapeCodePoint(char.codePointAt(0) ?? 0);
    } else {
      output += char;
    }
  }
  return output + quote;
}
