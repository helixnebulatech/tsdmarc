import { describe, expect, it } from 'vitest';

import {
  maskNameserverSecrets,
  redactUrlCredentials,
  urlSecrets,
} from './redact';

describe('redactUrlCredentials', () => {
  // parsedmarc's TestRedactUrlCredentials.testMasksUserinfoAndKeepsHost
  it.each([
    ['https://user:secret@host', 'https://user:***@host'],
    ['https://user:secret@host:9200/', 'https://user:***@host:9200/'],
    ['localhost:9200', 'localhost:9200'],
    ['192.0.2.1:9299', '192.0.2.1:9299'],
    ['user:secret@localhost:9200', 'user:***@localhost:9200'],
    // A "://" in the path or query of a scheme-less value is not the
    // scheme separator; the userinfo at offset 0 is still masked
    ['user:secret@host:9200/x?r=http://y', 'user:***@host:9200/x?r=http://y'],
    ['user:secret@host?r=a://b', 'user:***@host?r=a://b'],
    ['https://user:p@ss@host/x', 'https://user:***@host/x'],
    ['https://user:p:w@[::1]:9200/', 'https://user:***@[::1]:9200/'],
    ['https://[::1]:9200', 'https://[::1]:9200'],
    ['//user:pw@host', '//user:***@host'],
    // A URL quoted in free text
    [
      'connection to "postgresql://u:PGSECRET@db.example/x" failed',
      'connection to "postgresql://u:***@db.example/x" failed',
    ],
    // With no "@" in the authority, an "@" later in the value is masked
    // through, since it may end a password that contains "/", "?" or "#"
    ['http://host/path?e=a@b.com', 'http://***@b.com'],
    ['https://host/path@file', 'https://***@file'],
    ['https://host/?redirect=https://u:p@evil', 'https://***@evil'],
    ['https://tok@host', 'https://***@host'],
    ['user@host:9200', '***@host:9200'],
    ['https://user:@host', 'https://user:***@host'],
    ['https://u%40x:p%3Aw@h', 'https://u%40x:***@h'],
    ['not a url @ all', '***@ all'],
    ['', ''],
    ['::::', '::::'],
  ])('masks the password and keeps the host: %s', (value, expected) => {
    expect(redactUrlCredentials(value)).toBe(expected);
  });

  // parsedmarc's testMasksPasswordsThatEndTheAuthorityEarly
  it.each([
    ['https://admin:p4ssw0rd/extra@host:3100', 'https://***@host:3100'],
    ['https://admin:p4ss?w0rd@host', 'https://***@host'],
    ['https://admin:p4ss#w0rd@host', 'https://***@host'],
    ['admin:p4ss/w0rd@host:9200', '***@host:9200'],
    ['//admin:p4ss/w0rd@host', '//***@host'],
    // The password may itself contain "@"; the last one is used
    ['https://admin:p4ss/w@rd@host:3100/x', 'https://***@host:3100/x'],
    // A "://" after the "/" is not the scheme separator
    ['admin:p4ss/w0rd@host/x?r=http://y', '***@host/x?r=http://y'],
  ])('masks passwords that end the authority early: %s', (value, expected) => {
    const result = redactUrlCredentials(value);
    expect(result).toBe(expected);
    expect(result).not.toContain('p4ss');
  });

  // Deliberate differences from parsedmarc, which keeps "ss/word", the
  // query's credentials and "p" in these.
  it.each([
    ['https://user:p@ss/word@host', 'https://***@host'],
    ['https://a:b@host/?redirect=https://u:p@evil', 'https://***@evil'],
    ['user:p://w@host:9200', '***@host:9200'],
    ['HTTPS://u:p#w@h', 'HTTPS://***@h'],
    ['postgresql://u:p#w@[::1]x/db', 'postgresql://***@[::1]x/db'],
  ])('masks through the last @ of the value: %s', (value, expected) => {
    expect(redactUrlCredentials(value)).toBe(expected);
  });

  it('masks a list element by element into a new list', () => {
    const original = [
      'a:b@h1',
      'https://h2',
      'https://admin:p4ss/w0rd@h3:9200',
    ];
    const result = redactUrlCredentials(original);
    expect(result).toEqual(['a:***@h1', 'https://h2', 'https://***@h3:9200']);
    expect(result).not.toBe(original);
    expect(original).toEqual([
      'a:b@h1',
      'https://h2',
      'https://admin:p4ss/w0rd@h3:9200',
    ]);
    expect(redactUrlCredentials(['a:b@h1', null])).toEqual(['a:***@h1', null]);
  });

  it('is linear on adversarial input', () => {
    for (const value of [
      '://'.repeat(350_000),
      '@'.repeat(200_000),
      'a:b@'.repeat(250_000),
      `${'a:b/'.repeat(250_000)}@`,
      '/@'.repeat(500_000),
    ]) {
      const started = performance.now();
      redactUrlCredentials(value);
      expect(performance.now() - started).toBeLessThan(5000);
    }
  });
});

describe('urlSecrets', () => {
  // parsedmarc's test_url_secrets_finds_the_password_and_its_port_like_prefix
  it.each([
    ['https://doh:p4ss@dns.example/q', ['p4ss']],
    ['https://doh:p4ss/w0rd@dns.example/q', ['p4ss/w0rd', 'p4ss']],
    ['https://doh:p4ss?w0rd@dns.example/q', ['p4ss?w0rd', 'p4ss']],
    ['https://doh:p4ss#w0rd@dns.example/q', ['p4ss#w0rd', 'p4ss']],
    // The prefix ends at the first of the three delimiters
    ['https://doh:ab#cd/ef@dns.example/q', ['ab#cd/ef', 'ab']],
    ['https://doh:p:w@dns.example/q', ['p:w']],
    ['https://doh:p@ss@dns.example/q', ['p@ss']],
    ['https://S3CRETTOKEN@dns.example/q', ['S3CRETTOKEN']],
    ['tls://dot:p4ss/w0rd@192.0.2.1', ['p4ss/w0rd', 'p4ss']],
    // Empty secrets are never returned: replacing "" would insert the mask
    // between every character
    ['https://doh:@dns.example/q', []],
    ['https://doh:/x@dns.example/q', ['/x']],
    ['https://dns.example/dns-query', []],
    ['192.0.2.1', []],
    ['', []],
  ])('%s', (value, expected) => {
    expect(urlSecrets(value)).toEqual(expected);
  });
});

describe('maskNameserverSecrets', () => {
  it('masks entries, passwords and their port-like prefixes', () => {
    const url = 'https://doh:p4ss/w0rd@dns.example/dns-query';
    const text =
      `Server ${url} answered x; ` +
      "Port could not be cast to integer value as 'p4ss'; " +
      "Invalid port: 'p4ss/w0rd'";
    expect(maskNameserverSecrets(text, [url, '192.0.2.1'])).toBe(
      'Server https://***@dns.example/dns-query answered x; ' +
        "Port could not be cast to integer value as '***'; " +
        "Invalid port: '***'",
    );
    expect(
      maskNameserverSecrets(
        'Server https://u:PW123@h.example/q failed (PW123)',
        ['https://u:PW123@h.example/q'],
      ),
    ).toBe('Server https://u:***@h.example/q failed (***)');
    expect(maskNameserverSecrets('abc', null)).toBe('abc');
    expect(maskNameserverSecrets('abc', ['https://u:@h'])).toBe('abc');
  });

  it('handles entries a URL parser rejects', () => {
    const text = 'Server https://[x failed; Server https://u:PW@[x failed';
    expect(maskNameserverSecrets(text, ['https://[x', 'https://u:PW@[x'])).toBe(
      'Server https://[x failed; Server https://u:***@[x failed',
    );
  });
});
