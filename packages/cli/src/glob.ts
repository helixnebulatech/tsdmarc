// Port of Python's `glob.glob()`, `glob.escape()` and `fnmatch` (POSIX
// semantics), so file arguments expand exactly as parsedmarc expands them:
// `*` and `?` never match a leading dot, `**` recurses only with
// `recursive`, and `[...]` is a character class.

import { lstatSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const MAGIC = /[*?[]/u;
const MAGIC_GLOBAL = /([*?[])/gu;

/** Python's `glob.has_magic()`. */
export function hasMagic(pattern: string): boolean {
  return MAGIC.test(pattern);
}

/** Python's `glob.escape()`: wrap `*`, `?` and `[` in brackets. */
export function globEscape(pathname: string): string {
  return pathname.replace(MAGIC_GLOBAL, '[$1]');
}

function escapeClassChar(char: string): string {
  return `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`;
}

/** Python's `fnmatch.translate()` class handling, for `pat[i:j]`. */
function translateClass(pat: string, start: number, end: number): string {
  let i = start;
  let chunks: string[];
  const stuff = pat.slice(start, end);
  if (stuff.includes('-')) {
    chunks = [];
    let k = pat[i] === '!' ? i + 2 : i + 1;
    for (;;) {
      k = pat.indexOf('-', k);
      if (k < 0 || k >= end) {
        break;
      }
      chunks.push(pat.slice(i, k));
      i = k + 1;
      k += 3;
    }
    const chunk = pat.slice(i, end);
    if (chunk) {
      chunks.push(chunk);
    } else if (chunks.length > 0) {
      chunks[chunks.length - 1] += '-';
    }
    // Remove empty ranges (invalid in a regex).
    for (let k2 = chunks.length - 1; k2 > 0; k2 -= 1) {
      const previous = chunks[k2 - 1] ?? '';
      const current = chunks[k2] ?? '';
      if (previous && current && previous.at(-1)! > current.charAt(0)) {
        chunks[k2 - 1] = previous.slice(0, -1) + current.slice(1);
        chunks.splice(k2, 1);
      }
    }
  } else {
    chunks = [stuff];
  }

  // Tokens: characters, with a range between the last character of one
  // chunk and the first of the next.
  let negate = false;
  let first = chunks[0] ?? '';
  const joined = chunks.join('-');
  if (!joined) {
    return '(?!)';
  }
  if (joined === '!') {
    return '[\\s\\S]';
  }
  if (first.startsWith('!')) {
    negate = true;
    first = first.slice(1);
  }
  const parts = [first, ...chunks.slice(1)];
  let body = '';
  parts.forEach((part, index) => {
    const chars = [...part];
    if (index > 0) {
      // The first character closes the range opened by the previous part.
      const head = chars.shift();
      if (head !== undefined) {
        body += `-${escapeClassChar(head)}`;
      }
    }
    for (const char of chars) {
      body += escapeClassChar(char);
    }
  });
  return negate ? `[^${body}]` : `[${body}]`;
}

/** Python's `fnmatch.translate()`, as a JS regex source (with the `u` flag). */
export function fnmatchTranslate(pat: string): string {
  let result = '';
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const c = pat.charAt(i);
    i += 1;
    if (c === '*') {
      if (!result.endsWith('[\\s\\S]*')) {
        result += '[\\s\\S]*';
      }
    } else if (c === '?') {
      result += '[\\s\\S]';
    } else if (c === '[') {
      let j = i;
      if (j < n && pat[j] === '!') {
        j += 1;
      }
      if (j < n && pat[j] === ']') {
        j += 1;
      }
      while (j < n && pat[j] !== ']') {
        j += 1;
      }
      if (j >= n) {
        result += '\\[';
      } else {
        result += translateClass(pat, i, j);
        i = j + 1;
      }
    } else {
      const code = pat.codePointAt(i - 1) ?? 0;
      if (code > 0xff_ff) {
        // Keep astral characters whole.
        result += escapeClassChar(String.fromCodePoint(code));
        i += 1;
      } else {
        result += escapeClassChar(c);
      }
    }
  }
  return `^(?:${result})$`;
}

const translated = new Map<string, RegExp>();

/** Python's `fnmatch.fnmatchcase()` (POSIX `fnmatch` does not fold case). */
export function fnmatch(name: string, pattern: string): boolean {
  let regex = translated.get(pattern);
  if (regex === undefined) {
    regex = new RegExp(fnmatchTranslate(pattern), 'u');
    translated.set(pattern, regex);
  }
  return regex.test(name);
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

function lexists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function join(dirname: string, basename: string): string {
  if (!dirname || !basename) {
    return dirname || basename;
  }
  return path.join(dirname, basename);
}

/** Python's `os.path.join()`: no normalization, `''` adds a separator. */
function pyJoin(dirname: string, basename: string): string {
  if (path.isAbsolute(basename)) {
    return basename;
  }
  if (!dirname || dirname.endsWith(path.sep)) {
    return dirname + basename;
  }
  return `${dirname}${path.sep}${basename}`;
}

/** Python's `os.path.split()`. */
function pySplit(pathname: string): [string, string] {
  const index = pathname.lastIndexOf(path.sep) + 1;
  let head = pathname.slice(0, index);
  const tail = pathname.slice(index);
  if (head && head !== path.sep.repeat(head.length)) {
    while (head.endsWith(path.sep)) {
      head = head.slice(0, -path.sep.length);
    }
  }
  return [head, tail];
}

function listdir(dirname: string, dironly: boolean): string[] {
  try {
    const entries = readdirSync(dirname || '.', { withFileTypes: true });
    return entries
      .filter(entry => {
        if (!dironly) {
          return true;
        }
        if (entry.isDirectory()) {
          return true;
        }
        return entry.isSymbolicLink() && isDir(join(dirname, entry.name));
      })
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

function glob1(dirname: string, pattern: string, dironly: boolean): string[] {
  let names = listdir(dirname, dironly);
  if (!isHidden(pattern)) {
    names = names.filter(name => !isHidden(name));
  }
  return names.filter(name => fnmatch(name, pattern));
}

function glob0(dirname: string, basename: string): string[] {
  if (basename) {
    return lexists(join(dirname, basename)) ? [basename] : [];
  }
  return isDir(dirname) ? [basename] : [];
}

function* rlistdir(dirname: string, dironly: boolean): Generator<string> {
  for (const name of listdir(dirname, dironly)) {
    if (!isHidden(name)) {
      yield name;
      const sub = dirname ? join(dirname, name) : name;
      for (const nested of rlistdir(sub, dironly)) {
        yield join(name, nested);
      }
    }
  }
}

function* glob2(dirname: string, dironly: boolean): Generator<string> {
  if (!dirname || isDir(dirname)) {
    yield '';
  }
  yield* rlistdir(dirname, dironly);
}

function* iglobInner(
  pathname: string,
  recursive: boolean,
  dironly: boolean,
): Generator<string> {
  const [dirname, basename] = pySplit(pathname);
  if (!hasMagic(pathname)) {
    if (basename) {
      if (lexists(pathname)) {
        yield pathname;
      }
    } else if (isDir(dirname)) {
      yield pathname;
    }
    return;
  }
  if (!dirname) {
    if (recursive && basename === '**') {
      yield* glob2('', dironly);
    } else {
      yield* glob1('', basename, dironly);
    }
    return;
  }
  const dirs: Iterable<string> =
    dirname !== pathname && hasMagic(dirname)
      ? iglobInner(dirname, recursive, true)
      : [dirname];
  for (const dir of dirs) {
    let names: Iterable<string>;
    if (hasMagic(basename)) {
      names =
        recursive && basename === '**'
          ? glob2(dir, dironly)
          : glob1(dir, basename, dironly);
    } else {
      names = glob0(dir, basename);
    }
    for (const name of names) {
      yield pyJoin(dir, name);
    }
  }
}

/** Python's `glob.glob(pathname, recursive=recursive)`. */
export function glob(pathname: string, recursive = false): string[] {
  const results = [...iglobInner(pathname, recursive, false)];
  if (recursive && pathname === '**' && results[0] === '') {
    results.shift();
  }
  return results;
}

/** Sort like Python's `sorted()` on `str`: by code point. */
export function sortByCodePoint(values: string[]): string[] {
  return values.sort((a, b) => {
    const left = [...a];
    const right = [...b];
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const difference =
        (left[index]?.codePointAt(0) ?? 0) -
        (right[index]?.codePointAt(0) ?? 0);
      if (difference !== 0) {
        return difference;
      }
    }
    return left.length - right.length;
  });
}
