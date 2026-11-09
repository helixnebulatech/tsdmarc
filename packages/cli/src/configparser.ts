// Port of the parts of Python's `configparser.ConfigParser` that parsedmarc
// uses, with `interpolation=None` and the default dialect: `=` and `:`
// delimiters, full-line `#`/`;` comments, indented continuation lines,
// lower-cased option names, a `DEFAULT` section and strict duplicate checks.

import { readFileSync } from 'node:fs';

/** Base class of configparser errors. */
export class ConfigParserError extends Error {
  override name = 'ConfigParserError';
}

/** Raised when a configuration file does not follow legal syntax. */
export class ParsingError extends ConfigParserError {
  override name = 'ParsingError';
  readonly source: string;
  readonly errors: [number, string][] = [];

  constructor(source: string) {
    super(`Source contains parsing errors: ${pyRepr(source)}`);
    this.source = source;
  }

  append(lineno: number, line: string): void {
    this.errors.push([lineno, line]);
    this.message += `\n\t[line ${String(lineno).padStart(2)}]: ${pyRepr(line)}`;
  }
}

/** Raised when a file has an option line before any section header. */
export class MissingSectionHeaderError extends ParsingError {
  override name = 'MissingSectionHeaderError';

  constructor(source: string, lineno: number, line: string) {
    super(source);
    this.message = `File contains no section headers.\nfile: ${pyRepr(source)}, line: ${lineno}\n${pyRepr(line)}`;
  }
}

function whileReading(source: string | null, lineno: number | null): string {
  if (source === null) {
    return '';
  }
  const line = lineno === null ? '' : ` [line ${String(lineno).padStart(2)}]`;
  return `While reading from ${pyRepr(source)}${line}: `;
}

/** Raised when a section is repeated in one source. */
export class DuplicateSectionError extends ConfigParserError {
  override name = 'DuplicateSectionError';

  constructor(section: string, source: string | null, lineno: number | null) {
    const prefix = whileReading(source, lineno);
    super(
      prefix
        ? `${prefix}section ${pyRepr(section)} already exists`
        : `Section ${pyRepr(section)} already exists`,
    );
  }
}

/** Raised when an option is repeated in one section of one source. */
export class DuplicateOptionError extends ConfigParserError {
  override name = 'DuplicateOptionError';

  constructor(
    section: string,
    option: string,
    source: string | null,
    lineno: number | null,
  ) {
    const prefix = whileReading(source, lineno);
    const what = `${pyRepr(option)} in section ${pyRepr(section)} already exists`;
    super(prefix ? `${prefix}option ${what}` : `Option ${what}`);
  }
}

/** Raised for a missing section (`config.set()` on an unknown section). */
export class NoSectionError extends ConfigParserError {
  override name = 'NoSectionError';

  constructor(section: string) {
    super(`No section: ${pyRepr(section)}`);
  }
}

/** Python's `ValueError` from `getboolean()`/`getint()`/`getfloat()`. */
export class ConfigValueError extends Error {
  override name = 'ValueError';
}

/** Python's `repr()` of a string (single quotes unless it contains one). */
export function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\') {
      out += '\\\\';
    } else if (char === quote) {
      out += `\\${quote}`;
    } else if (char === '\n') {
      out += '\\n';
    } else if (char === '\r') {
      out += '\\r';
    } else if (char === '\t') {
      out += '\\t';
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += char;
    }
  }
  return out + quote;
}

const DEFAULT_SECTION = 'DEFAULT';
const BOOLEAN_STATES: ReadonlyMap<string, boolean> = new Map([
  ['1', true],
  ['yes', true],
  ['true', true],
  ['on', true],
  ['0', false],
  ['no', false],
  ['false', false],
  ['off', false],
]);
const COMMENT_PREFIXES = ['#', ';'] as const;
const SECTION_HEADER = /^\[(.+)\]/u;
const NON_SPACE = /\S/u;
// Python's int(): optional sign, digits with single underscores between them.
const PY_INT = /^[+-]?\d(?:_?\d)*$/u;
// Python's float(): [sign] (digits[.[digits]] | .digits) [exponent], or
// inf/infinity/nan; underscores only between digits.
const PY_FLOAT =
  /^[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/iu;

/** Python's `int(str)`; throws `ConfigValueError` like Python. */
export function pyInt(value: string): number {
  const text = value.trim();
  if (!PY_INT.test(text)) {
    throw new ConfigValueError(
      `invalid literal for int() with base 10: ${pyRepr(value)}`,
    );
  }
  return Number(text.replaceAll('_', ''));
}

/** Python's `float(str)`; throws `ConfigValueError` like Python. */
export function pyFloat(value: string): number {
  const text = value.trim();
  if (!PY_FLOAT.test(text)) {
    throw new ConfigValueError(
      `could not convert string to float: ${pyRepr(value)}`,
    );
  }
  const lower = text.toLowerCase().replaceAll('_', '');
  if (lower.endsWith('inf') || lower.endsWith('infinity')) {
    return lower.startsWith('-') ? -Infinity : Infinity;
  }
  if (lower.endsWith('nan')) {
    return Number.NaN;
  }
  return Number(lower);
}

/** Whether {@link pyBoolean} accepts `value`. */
export function isPyBoolean(value: string): boolean {
  return BOOLEAN_STATES.has(value.toLowerCase());
}

/** Python's `ConfigParser._convert_to_boolean()`. */
export function pyBoolean(value: string): boolean {
  const state = BOOLEAN_STATES.get(value.toLowerCase());
  if (state === undefined) {
    throw new ConfigValueError(`Not a boolean: ${value}`);
  }
  return state;
}

/** One section of a {@link ConfigParser} (Python's `SectionProxy`). */
export class SectionProxy {
  readonly parser: ConfigParser;
  readonly name: string;

  constructor(parser: ConfigParser, name: string) {
    this.parser = parser;
    this.name = name;
  }

  /** `key in section`: the option is set here or in `DEFAULT`. */
  has(key: string): boolean {
    return this.parser.hasOption(this.name, key);
  }

  /** `section[key]`; throws `KeyError` (as an `Error`) when missing. */
  getItem(key: string): string {
    const value = this.parser.getRaw(this.name, key);
    if (value === undefined) {
      throw new Error(`KeyError: ${pyRepr(key)}`);
    }
    return value;
  }

  /** `section.get(key, fallback)`. */
  get(key: string): string | undefined;
  get<T>(key: string, fallback: T): string | T;
  get<T>(key: string, fallback?: T): string | T | undefined {
    return this.parser.getRaw(this.name, key) ?? fallback;
  }

  /** `section.getboolean(key, fallback)`. */
  getboolean(key: string): boolean | undefined;
  getboolean<T>(key: string, fallback: T): boolean | T;
  getboolean<T>(key: string, fallback?: T): boolean | T | undefined {
    const value = this.parser.getRaw(this.name, key);
    return value === undefined ? fallback : pyBoolean(value);
  }

  /** `section.getint(key, fallback)`. */
  getint(key: string): number | undefined;
  getint<T>(key: string, fallback: T): number | T;
  getint<T>(key: string, fallback?: T): number | T | undefined {
    const value = this.parser.getRaw(this.name, key);
    return value === undefined ? fallback : pyInt(value);
  }

  /** `section.getfloat(key, fallback)`. */
  getfloat(key: string): number | undefined;
  getfloat<T>(key: string, fallback: T): number | T;
  getfloat<T>(key: string, fallback?: T): number | T | undefined {
    const value = this.parser.getRaw(this.name, key);
    return value === undefined ? fallback : pyFloat(value);
  }

  /** Option names, including those inherited from `DEFAULT`. */
  keys(): string[] {
    return this.parser.options(this.name);
  }
}

/** Python's `ConfigParser(interpolation=None)`. */
export class ConfigParser {
  private readonly defaults = new Map<string, string>();
  private readonly sectionMap = new Map<string, Map<string, string>>();

  /** Python's `optionxform()`: option names are case-insensitive. */
  optionxform(option: string): string {
    return option.toLowerCase();
  }

  /** Section names, without `DEFAULT`, in the order they were added. */
  sections(): string[] {
    return [...this.sectionMap.keys()];
  }

  hasSection(section: string): boolean {
    return this.sectionMap.has(section);
  }

  /** `name in config`: `DEFAULT` or an existing section. */
  has(name: string): boolean {
    return name === DEFAULT_SECTION || this.sectionMap.has(name);
  }

  addSection(section: string): void {
    if (section === DEFAULT_SECTION) {
      throw new ConfigValueError(`Invalid section name: ${pyRepr(section)}`);
    }
    if (this.sectionMap.has(section)) {
      throw new DuplicateSectionError(section, null, null);
    }
    this.sectionMap.set(section, new Map());
  }

  /** `config[section]`; throws `KeyError` (as an `Error`) when missing. */
  section(name: string): SectionProxy {
    if (!this.has(name)) {
      throw new Error(`KeyError: ${pyRepr(name)}`);
    }
    return new SectionProxy(this, name);
  }

  hasOption(section: string, option: string): boolean {
    return this.getRaw(section, option) !== undefined;
  }

  options(section: string): string[] {
    const own = this.sectionMap.get(section);
    if (own === undefined && section !== DEFAULT_SECTION) {
      throw new NoSectionError(section);
    }
    return [...new Set([...(own?.keys() ?? []), ...this.defaults.keys()])];
  }

  /** The raw value of an option, falling back to `DEFAULT`. */
  getRaw(section: string, option: string): string | undefined {
    const key = this.optionxform(option);
    const own =
      section === DEFAULT_SECTION
        ? this.defaults
        : this.sectionMap.get(section);
    return own?.get(key) ?? this.defaults.get(key);
  }

  set(section: string, option: string, value: string): void {
    const target =
      section === DEFAULT_SECTION
        ? this.defaults
        : this.sectionMap.get(section);
    if (target === undefined) {
      throw new NoSectionError(section);
    }
    target.set(this.optionxform(option), value);
  }

  /**
   * Read and parse files, skipping those that cannot be opened (Python's
   * `ConfigParser.read()`). Returns the files that were read.
   */
  read(filenames: string | string[]): string[] {
    const read: string[] = [];
    for (const filename of Array.isArray(filenames) ? filenames : [filenames]) {
      let text: string;
      try {
        text = readFileSync(filename, 'utf8');
      } catch {
        continue;
      }
      this.readString(text, filename);
      read.push(filename);
    }
    return read;
  }

  /** Parse configuration text (Python's `read_string()`). */
  readString(text: string, source = '<string>'): void {
    const elementsAdded = new Set<string>();
    let cursect: Map<string, string[]> | null = null;
    let sectname: string | null = null;
    let optname: string | null = null;
    let indentLevel = 0;
    let errors: ParsingError | null = null;
    // Values are collected as lists of lines and joined at the end.
    const collected = new Map<Map<string, string>, Map<string, string[]>>();
    const collectorFor = (
      target: Map<string, string>,
    ): Map<string, string[]> => {
      let lines = collected.get(target);
      if (lines === undefined) {
        lines = new Map();
        collected.set(target, lines);
      }
      return lines;
    };

    const lines = text.split(/\r\n|\r|\n/u);
    if (lines.at(-1) === '') {
      lines.pop();
    }
    lines.forEach((rawLine, index) => {
      const lineno = index + 1;
      const trimmed = rawLine.trim();
      const isComment = COMMENT_PREFIXES.some(prefix =>
        trimmed.startsWith(prefix),
      );
      const clean = isComment ? '' : trimmed;
      if (!clean) {
        // An empty line (not a comment) is part of a multi-line value.
        if (!isComment && cursect !== null && optname) {
          cursect.get(optname)?.push('');
        }
        return;
      }
      const curIndentLevel = NON_SPACE.exec(rawLine)?.index ?? 0;

      if (cursect !== null && optname && curIndentLevel > indentLevel) {
        cursect.get(optname)?.push(clean);
        return;
      }

      indentLevel = curIndentLevel;
      const header = SECTION_HEADER.exec(clean);
      if (header === null && cursect === null) {
        throw new MissingSectionHeaderError(source, lineno, `${rawLine}\n`);
      }
      if (header !== null) {
        const name = header[1] ?? '';
        sectname = name;
        const existing = this.sectionMap.get(name);
        if (existing !== undefined) {
          if (elementsAdded.has(name)) {
            throw new DuplicateSectionError(name, source, lineno);
          }
          cursect = collectorFor(existing);
          elementsAdded.add(name);
        } else if (name === DEFAULT_SECTION) {
          cursect = collectorFor(this.defaults);
        } else {
          const created = new Map<string, string>();
          this.sectionMap.set(name, created);
          cursect = collectorFor(created);
          elementsAdded.add(name);
        }
        optname = null;
        return;
      }

      // An option line: the option name ends at the first delimiter.
      const delimiter = clean.search(/[=:]/u);
      if (delimiter === -1) {
        errors ??= new ParsingError(source);
        errors.append(lineno, `${rawLine}\n`);
        return;
      }
      const rawName = clean.slice(0, delimiter).trimEnd();
      if (!rawName) {
        errors ??= new ParsingError(source);
        errors.append(lineno, `${rawLine}\n`);
      }
      optname = this.optionxform(rawName);
      const key = `${sectname ?? ''}\u0000${optname}`;
      if (elementsAdded.has(key)) {
        throw new DuplicateOptionError(sectname ?? '', optname, source, lineno);
      }
      elementsAdded.add(key);
      cursect?.set(optname, [clean.slice(delimiter + 1).trim()]);
    });

    for (const [target, values] of collected) {
      for (const [name, value] of values) {
        target.set(name, value.join('\n').trimEnd());
      }
    }
    if (errors !== null) {
      throw errors;
    }
  }
}
