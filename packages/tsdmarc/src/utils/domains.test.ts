// Ported from parsedmarc tests/test_utils.py: Test.testPSLDownload,
// TestLoadPSLOverrides, TestGetBaseDomainWithOverrides, TestPslOverrides,
// plus parity checks against publicsuffixlist.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureLogs, DEBUG } from '../log';
import {
  getBaseDomain,
  loadPslOverrides,
  privateSuffix,
  pslOverrides,
} from './domains';

function snapshotOverrides(): void {
  let saved: string[] = [];
  beforeEach(() => {
    saved = [...pslOverrides];
  });
  afterEach(() => {
    pslOverrides.splice(0, pslOverrides.length, ...saved);
    vi.unstubAllGlobals();
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe('getBaseDomain (Test)', () => {
  it('testPSLDownload: Public Suffix List domain lookups', () => {
    expect(getBaseDomain('foo.example.com')).toBe('example.com');
    // psl_overrides.txt intentionally folds CDN-customer PTRs so every
    // sender on the same network clusters under one display key.
    // .akamaiedge.net is an override, so its subdomains collapse to
    // akamaiedge.net even though the live PSL carries c.akamaiedge.net.
    expect(getBaseDomain('e3191.c.akamaiedge.net')).toBe('akamaiedge.net');
  });
});

describe('TestLoadPSLOverrides', () => {
  snapshotOverrides();

  it('test_offline_loads_bundled_file', async () => {
    const result = await loadPslOverrides({ offline: true });
    expect(result).toBe(pslOverrides);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('.linode.com');
  });

  it('test_local_file_path_overrides_bundled', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-psl-'));
    try {
      const file = path.join(directory, 'overrides.txt');
      writeFileSync(
        file,
        '-custom-brand.com\n.another-brand.net\n\n   \n',
        'utf8',
      );
      const result = await loadPslOverrides({
        offline: true,
        localFilePath: file,
      });
      expect(result).toEqual(['-custom-brand.com', '.another-brand.net']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('test_clear_before_reload', async () => {
    pslOverrides.splice(0, pslOverrides.length, '.stale-entry.com');
    await loadPslOverrides({ offline: true });
    expect(pslOverrides).not.toContain('.stale-entry.com');
  });

  it('test_url_success', async () => {
    const fetchMock = vi.fn(async () =>
      textResponse('-fetched-brand.com\n.cdn-fetched.net\n'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadPslOverrides({ url: 'https://example.test/ov' });
    expect(result).toEqual(['-fetched-brand.com', '.cdn-fetched.net']);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(String(url)).toBe('https://example.test/ov');
    expect(init.headers).toEqual({
      'User-Agent': expect.stringMatching(/^tsdmarc\//u),
    });
  });

  it('test_url_failure_falls_back_to_local', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: new Error('nope') });
      }),
    );
    const result = await loadPslOverrides({ url: 'https://example.test/ov' });
    // Bundled file still loaded.
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('.linode.com');
  });

  it('a non-2xx response falls back to local', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => textResponse('gone', 404)),
    );
    const result = await loadPslOverrides({ url: 'https://example.test/ov' });
    expect(result).toContain('.linode.com');
  });

  it('test_always_use_local_skips_network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await loadPslOverrides({ alwaysUseLocalFile: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('TestGetBaseDomainWithOverrides', () => {
  snapshotOverrides();
  beforeEach(() => {
    pslOverrides.splice(
      0,
      pslOverrides.length,
      '.cprapid.com',
      '-nobre.com.br',
    );
  });

  it('test_dot_prefixed_override_folds_subdomain', () => {
    expect(getBaseDomain('74-208-244-234.cprapid.com')).toBe('cprapid.com');
  });

  it('test_dash_prefixed_override_folds_subdomain', () => {
    expect(getBaseDomain('host-1-2-3-4-nobre.com.br')).toBe('nobre.com.br');
  });

  it('test_unmatched_domain_falls_through_to_psl', () => {
    expect(getBaseDomain('sub.example.com')).toBe('example.com');
  });
});

describe('TestPslOverrides', () => {
  it('testOverrideMatch', () => {
    expect(getBaseDomain('sub.example.com')).toBe('example.com');
  });
});

describe('privateSuffix matches publicsuffixlist', () => {
  // Expected values from publicsuffixlist 1.1.2 (the venv parsedmarc uses):
  // PublicSuffixList().privatesuffix(domain)
  const cases: [string, string | null][] = [
    ['foo.example.com', 'example.com'],
    ['example.com', 'example.com'],
    ['com', null],
    ['e3191.c.akamaiedge.net', 'c.akamaiedge.net'],
    ['foo.github.io', 'foo.github.io'],
    ['github.io', null],
    ['foo.bar.invalidtld', 'bar.invalidtld'],
    ['invalidtld', null],
    ['1.2.3.4', '3.4'],
    ['1.0.0.1.in-addr.arpa', '1.in-addr.arpa'],
    ['foo.example.com.', 'example.com'],
    ['', null],
    ['a..b.com', null],
    ['.example.com', null],
    ['foo.co.uk', 'foo.co.uk'],
    ['co.uk', null],
    ['пример.рф', 'пример.рф'],
    ['sub.пример.рф', 'пример.рф'],
    ['sub.xn--e1afmkfd.xn--p1ai', 'xn--e1afmkfd.xn--p1ai'],
    ['host_name.example.com', 'example.com'],
    ['-foo.example.com', 'example.com'],
    ['foo.blogspot.com', 'foo.blogspot.com'],
    ['dns.google', 'dns.google'],
    ['localhost', null],
    ['a.b.c.kawasaki.jp', 'b.c.kawasaki.jp'],
    ['city.kawasaki.jp', 'city.kawasaki.jp'],
    ['foo.city.kawasaki.jp', 'city.kawasaki.jp'],
    ['foo bar.com', 'foo bar.com'],
    ['2001:db8::1', null],
    ['foo.example.com:80', 'example.com:80'],
    ['*.example.com', 'example.com'],
    ['mail-ed1-f45.google.com', 'google.com'],
    ['foo.EXAMPLE.com', 'example.com'],
    ['x.compute.amazonaws.com', null],
    ['ec2-1-2-3-4.compute-1.amazonaws.com', null],
    ['a.ck', null],
    ['www.ck', 'www.ck'],
    ['a.b.ck', 'a.b.ck'],
    // The parent of a wildcard rule is public in publicsuffixlist
    ['awsapprunner.com', null],
    ['x.awsapprunner.com', null],
    ['y.x.awsapprunner.com', 'y.x.awsapprunner.com'],
    ['user.fm', null],
    ['a.user.fm', null],
    ['b.a.user.fm', 'b.a.user.fm'],
    ['kawasaki.jp', null],
  ];

  it.each(cases)('privateSuffix(%j) = %j', (domain, expected) => {
    expect(privateSuffix(domain)).toBe(expected);
  });
});

describe('loadPslOverrides URL handling', () => {
  snapshotOverrides();

  it('a URL that is not HTTP(S) is not fetched and falls back to local', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadPslOverrides({
      url: 'data:text/plain,.evil.example',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toContain('.linode.com');
    expect(result).not.toContain('.evil.example');
  });

  it.each([
    ['https://admin:p4ssw0rd/x@downloads.example.test/map.dat', 'p4ssw0rd'],
    ['https://admin:p4ss?w0rd@downloads.example.test/map.dat', 'p4ss'],
    ['https://admin:p4ss#w0rd@downloads.example.test/map.dat', 'p4ss'],
  ])(
    'test_psl_overrides_loader_invalid_url: %s falls back to the local file',
    async (url, secret) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const capture = captureLogs(undefined, DEBUG);
      let result: string[];
      try {
        result = await loadPslOverrides({ url });
      } finally {
        capture.restore();
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toContain('.linode.com');
      expect(capture.output.join('\n')).not.toContain(secret);
      expect(capture.output).toContain(
        'DEBUG:tsdmarc:Trying to fetch PSL overrides from https://***@downloads.example.test/map.dat...',
      );
      expect(capture.output).toContain(
        'WARNING:tsdmarc:Failed to fetch PSL overrides: invalid URL (details withheld because they may include credentials)',
      );
    },
  );

  it('does not log the password of the URL', async () => {
    // What undici does with credentials in the URL.
    const fetchMock = vi.fn(async (url: URL) => {
      if (url.username !== '') {
        throw new TypeError(
          `Request cannot be constructed from a URL that includes credentials: ${url.href}`,
        );
      }
      return new Response('nope', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const capture = captureLogs(undefined, DEBUG);
    try {
      await loadPslOverrides({ url: 'https://u:s3cret@psl.example/o.txt' });
    } finally {
      capture.restore();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capture.output.join('\n')).not.toContain('s3cret');
    expect(capture.output.join('\n')).toContain(
      "Failed to fetch PSL overrides: HTTP 404 for url 'https://u:***@psl.example/o.txt'",
    );
  });
});
