// Tests of the configparser port, against the behavior of Python 3.14's
// `configparser.ConfigParser(interpolation=None)` (checked with the venv).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConfigParser,
  ConfigValueError,
  DuplicateOptionError,
  DuplicateSectionError,
  MissingSectionHeaderError,
  NoSectionError,
  ParsingError,
  pyRepr,
} from './configparser';

function parse(text: string): ConfigParser {
  const config = new ConfigParser();
  config.readString(text, '<s>');
  return config;
}

function dump(config: ConfigParser): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const name of ['DEFAULT', ...config.sections()]) {
    const section = config.section(name);
    result[name] = Object.fromEntries(
      section.keys().map(key => [key, section.getItem(key)]),
    );
  }
  return result;
}

describe('ConfigParser.readString', () => {
  it('joins continuation lines, keeping empty lines inside the value', () => {
    expect(dump(parse('[a]\nk = v\n  cont\n\n  more\n# c\nx: y\n'))).toEqual({
      DEFAULT: {},
      a: { k: 'v\ncont\n\nmore', x: 'y' },
    });
  });

  it('keeps a continuation line after a comment line', () => {
    expect(dump(parse('[a]\nk = v\n# comment\n  cont\n'))).toEqual({
      DEFAULT: {},
      a: { k: 'v\ncont' },
    });
  });

  it('lower-cases option names and inherits DEFAULT values', () => {
    const config = parse('[a]\nK=V\n[DEFAULT]\nd=1\n[b]\n');
    expect(dump(config)).toEqual({
      DEFAULT: { d: '1' },
      a: { k: 'V', d: '1' },
      b: { d: '1' },
    });
    expect(config.sections()).toEqual(['a', 'b']);
    expect(config.section('a').has('K')).toBe(true);
    expect(config.has('DEFAULT')).toBe(true);
  });

  it('accepts empty values and keeps inline ";" text (no inline comments)', () => {
    expect(dump(parse('[a]\nk =\n; comment\nj= a ; b\n'))).toEqual({
      DEFAULT: {},
      a: { k: '', j: 'a ; b' },
    });
  });

  it('splits on the first delimiter only', () => {
    expect(
      parse('[a]\nurl = http://x:80/a=b\n').section('a').getItem('url'),
    ).toBe('http://x:80/a=b');
  });

  it('keeps sections separate', () => {
    expect(dump(parse('[a]\nk = v\n[b]\nk=1\n'))).toEqual({
      DEFAULT: {},
      a: { k: 'v' },
      b: { k: '1' },
    });
  });

  it("rejects a repeated section with Python's message", () => {
    expect(() => parse('[a]\n[a]\n')).toThrow(DuplicateSectionError);
    expect(() => parse('[a]\n[a]\n')).toThrow(
      "While reading from '<s>' [line  2]: section 'a' already exists",
    );
  });

  it('rejects a repeated option, case-insensitively', () => {
    expect(() => parse('[a]\nk=1\nK=2\n')).toThrow(DuplicateOptionError);
    expect(() => parse('[a]\nk=1\nK=2\n')).toThrow(
      "While reading from '<s>' [line  3]: option 'k' in section 'a' already exists",
    );
  });

  it('rejects an option before any section header', () => {
    expect(() => parse('k=1\n')).toThrow(MissingSectionHeaderError);
    expect(() => parse('k=1\n')).toThrow(
      "File contains no section headers.\nfile: '<s>', line: 1\n'k=1\\n'",
    );
  });

  it('collects lines without a delimiter or name as a ParsingError', () => {
    expect(() => parse('[a]\nnovalue\n')).toThrow(ParsingError);
    expect(() => parse('[a]\nnovalue\n')).toThrow(
      "Source contains parsing errors: '<s>'\n\t[line  2]: 'novalue\\n'",
    );
    expect(() => parse('[a]\n=x\n')).toThrow(
      "Source contains parsing errors: '<s>'\n\t[line  2]: '=x\\n'",
    );
  });

  it('reads files and skips the ones it cannot open', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'configparser-'));
    const file = path.join(dir, 'c.ini');
    writeFileSync(file, '[general]\nsilent = true\n');
    const config = new ConfigParser();
    expect(config.read([file, path.join(dir, 'missing.ini')])).toEqual([file]);
    expect(config.section('general').getboolean('silent')).toBe(true);
  });
});

describe('SectionProxy conversions', () => {
  const section = parse('[a]\nb=Yes\nn= 12_3 \nf=1e3\nbad=maybe\n').section(
    'a',
  );

  it('converts like getboolean/getint/getfloat', () => {
    expect(section.getboolean('b')).toBe(true);
    expect(section.getint('n')).toBe(123);
    expect(section.getfloat('f')).toBe(1000);
  });

  it("raises Python's ValueError messages", () => {
    expect(() => section.getboolean('bad')).toThrow(ConfigValueError);
    expect(() => section.getboolean('bad')).toThrow('Not a boolean: maybe');
    expect(() => section.getint('bad')).toThrow(
      "invalid literal for int() with base 10: 'maybe'",
    );
    expect(() => section.getfloat('bad')).toThrow(
      "could not convert string to float: 'maybe'",
    );
  });

  it('returns the fallback for a missing option', () => {
    expect(section.get('missing', 'fb')).toBe('fb');
    expect(section.getboolean('missing', false)).toBe(false);
    expect(section.get('missing')).toBeUndefined();
    expect(() => section.getItem('missing')).toThrow("KeyError: 'missing'");
  });

  it('accepts every boolean spelling Python does', () => {
    const config = parse(
      '[a]\nt1=1\nt2=yes\nt3=TRUE\nt4=on\nf1=0\nf2=no\nf3=False\nf4=off\n',
    );
    const values = config
      .section('a')
      .keys()
      .map(key => config.section('a').getboolean(key));
    expect(values).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('parses floats like Python', () => {
    const config = parse('[a]\na=.5\nb=5.\nc=-inf\nd=1_0.2_5\ne=1__0\n');
    const a = config.section('a');
    expect(a.getfloat('a')).toBe(0.5);
    expect(a.getfloat('b')).toBe(5);
    expect(a.getfloat('c')).toBe(-Infinity);
    expect(a.getfloat('d')).toBe(10.25);
    expect(() => a.getfloat('e')).toThrow(ConfigValueError);
  });
});

describe('ConfigParser.set / addSection', () => {
  it('sets values with lower-cased option names', () => {
    const config = new ConfigParser();
    config.addSection('imap');
    config.set('imap', 'PASSWORD', 'x');
    expect(config.section('imap').getItem('password')).toBe('x');
  });

  it('rejects unknown and duplicate sections', () => {
    const config = new ConfigParser();
    expect(() => config.set('nope', 'k', 'v')).toThrow(NoSectionError);
    config.addSection('a');
    expect(() => config.addSection('a')).toThrow("Section 'a' already exists");
    expect(() => config.addSection('DEFAULT')).toThrow(
      "Invalid section name: 'DEFAULT'",
    );
  });
});

describe('pyRepr', () => {
  it('quotes like Python', () => {
    expect(pyRepr('a')).toBe("'a'");
    expect(pyRepr("it's")).toBe('"it\'s"');
    expect(pyRepr('a\nb\t\\')).toBe("'a\\nb\\t\\\\'");
  });
});
