// Port of parsedmarc's TestExpandPath (tests/test_cli.py).

import { describe, expect, it } from 'vitest';

import { expandPath, expandUser, expandVars } from './paths';

describe('TestExpandPath', () => {
  it('test_expand_tilde', () => {
    const result = expandPath('~/some/path');
    expect(result.startsWith('~')).toBe(false);
    expect(result.endsWith('/some/path')).toBe(true);
  });

  it('test_expand_env_var', () => {
    process.env.PARSEDMARC_TEST_DIR = '/opt/data';
    expect(expandPath('$PARSEDMARC_TEST_DIR/tokens/.token')).toBe(
      '/opt/data/tokens/.token',
    );
  });

  it('test_expand_both', () => {
    process.env.MY_APP = 'parsedmarc';
    const result = expandPath('~/$MY_APP/config');
    expect(result).not.toContain('~');
    expect(result).toContain('parsedmarc/config');
  });

  it('test_no_expansion_needed', () => {
    expect(expandPath('/absolute/path')).toBe('/absolute/path');
    expect(expandPath('relative/path')).toBe('relative/path');
  });
});

describe('expandVars / expandUser (Python os.path semantics)', () => {
  it('expands ${VAR} and leaves unknown variables alone', () => {
    const env = { A: 'x' };
    expect(expandVars('${A}/$A/$UNKNOWN/${}', env)).toBe('x/x/$UNKNOWN/${}');
  });

  it('uses $HOME for ~ and leaves ~otheruser alone', () => {
    process.env.HOME = '/home/tester/';
    expect(expandUser('~')).toBe('/home/tester');
    expect(expandUser('~/a')).toBe('/home/tester/a');
    expect(expandUser('~no-such-user-xyz/a')).toBe('~no-such-user-xyz/a');
    expect(expandUser('a/~')).toBe('a/~');
  });
});
