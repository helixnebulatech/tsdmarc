// Ported from parsedmarc tests/test_utils.py: the IP info / IP database /
// country / reverse DNS map / IPinfo methods of `Test`,
// TestLoadReverseDnsMapReloadsPSLOverrides, TestUtilsIpDbPaths,
// TestUtilsReverseDnsMap, TestLoadIpDb, TestConfigureIpinfoApiProbe,
// TestIpinfoApiLookupFallbacks and TestNormalizeIpRecord.
//
// HTTP is faked with a stubbed global `fetch` and DNS with a fake
// `node:dns/promises` Resolver; the IP database is the real bundled MMDB
// from @tsdmarc/ipinfo-lite.

import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type * as FsModule from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseAggregateReportXml } from '../aggregate';
import {
  createParserConfig,
  ExpiringDict,
  type IPAddressCache,
} from '../config';
import {
  InvalidAggregateReport,
  InvalidIPinfoAPIKey,
  IPDatabaseError,
} from '../errors';
import { captureLogs, DEBUG, INFO, WARNING } from '../log';
import type { ReverseDNSMap } from '../types';
import { getBaseDomain, pslOverrides } from './domains';
import {
  configureIpinfoApi,
  getIpAddressCountry,
  getIpAddressDbRecord,
  getIpAddressInfo,
  getServiceFromReverseDnsBaseDomain,
  ipInfoState,
  loadIpDb,
  loadReverseDnsMap,
  normalizeIpRecord,
} from './ip-info';
import { getBundledIpDbPath } from './resources';
import type * as ResourcesModule from './resources';

const resourcesMock = vi.hoisted(() => ({
  bundledPath: undefined as string | null | undefined,
}));

vi.mock('./resources', async importOriginal => {
  const actual = await importOriginal<typeof ResourcesModule>();
  return {
    ...actual,
    getBundledIpDbPath: async (): Promise<string | null> =>
      resourcesMock.bundledPath === undefined
        ? actual.getBundledIpDbPath()
        : resourcesMock.bundledPath,
  };
});

const fsMock = vi.hoisted(() => ({
  existsSync: null as ((file: string) => boolean) | null,
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    existsSync: (file: string): boolean =>
      fsMock.existsSync === null
        ? actual.existsSync(file)
        : fsMock.existsSync(file),
  };
});

const dnsMock = vi.hoisted(() => ({
  handler: (_name: string, _rrtype: string): unknown => {
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  },
}));

vi.mock('node:dns/promises', () => {
  class Resolver {
    setServers(): void {
      // servers are irrelevant to the fake
    }
    cancel(): void {
      // nothing in flight
    }
    async resolve(name: string, rrtype: string): Promise<unknown> {
      return dnsMock.handler(name, rrtype);
    }
  }
  return { Resolver };
});

const BUNDLED_DB = (await getBundledIpDbPath()) as string;

type FetchHandler = (
  url: URL,
  init: RequestInit,
) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: URL, init: RequestInit) =>
    handler(url, init),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function networkError(): never {
  throw new TypeError('fetch failed', { cause: new Error('no network') });
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-ipinfo-'));
  afterEachCleanups.push(() =>
    rmSync(directory, { recursive: true, force: true }),
  );
  return directory;
}

let afterEachCleanups: (() => void)[] = [];
let savedOverrides: string[] = [];
let savedState = { ...ipInfoState };

beforeEach(() => {
  savedOverrides = [...pslOverrides];
  savedState = { ...ipInfoState };
});

afterEach(() => {
  for (const cleanup of afterEachCleanups.reverse()) {
    cleanup();
  }
  afterEachCleanups = [];
  pslOverrides.splice(0, pslOverrides.length, ...savedOverrides);
  Object.assign(ipInfoState, savedState);
  resourcesMock.bundledPath = undefined;
  dnsMock.handler = () => {
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  };
  vi.unstubAllGlobals();
});

function newCache(maxAgeSeconds = 14_400): IPAddressCache {
  return new ExpiringDict({ maxLen: 100, maxAgeSeconds });
}

describe('Test (IP info)', () => {
  it('testIpAddressInfoSurfacesASNFields', async () => {
    const info = await getIpAddressInfo('8.8.8.8', { offline: true });
    expect(info.asn).toBe(15_169);
    expect(Number.isInteger(info.asn)).toBe(true);
    expect(info.asDomain).toBe('google.com');
    expect(info.asName).toBeTruthy();
  });

  it('testIpAddressInfoFallsBackToASNMapEntryWhenNoPTR', async () => {
    const info = await getIpAddressInfo('8.8.8.8', { offline: true });
    expect(info.reverseDns).toBeNull();
    expect(info.baseDomain).toBeNull();
    expect(info.name).toBe('Google (Including Gmail and Google Workspace)');
    expect(info.type).toBe('Email Provider');
  });

  it('testIpAddressInfoFallsBackToRawASNameOnMapMiss', async () => {
    // parsedmarc patches get_ip_address_db_record; here the record comes
    // from a faked IPinfo API response (the lookup's first source).
    stubFetch(() =>
      jsonResponse(200, {
        country_code: 'US',
        asn: 'AS64496',
        as_name: 'Some Unmapped Org, Inc.',
        as_domain: 'unmapped-for-this-test.example',
      }),
    );
    await configureIpinfoApi('fake-token', { probe: false });
    const info = await getIpAddressInfo('192.0.2.1', {
      offline: true,
      cache: null,
    });
    expect(info.reverseDns).toBeNull();
    expect(info.baseDomain).toBeNull();
    expect(info.type).toBeNull();
    expect(info.name).toBe('Some Unmapped Org, Inc.');
    expect(info.asDomain).toBe('unmapped-for-this-test.example');
  });

  it('testWeakFallbackAttributionIsNotCached', async () => {
    const cache = newCache();
    await configureIpinfoApi('fake-token', { probe: false });

    // Scenario 1: weak fallback (no PTR, unmapped as_domain, raw as_name used)
    stubFetch(() =>
      jsonResponse(200, {
        country_code: 'US',
        asn: 'AS64496',
        as_name: 'Some Unmapped Org, Inc.',
        as_domain: 'unmapped-for-this-test.example',
      }),
    );
    await getIpAddressInfo('192.0.2.1', { offline: true, cache });
    expect(cache.has('192.0.2.1')).toBe(false);

    // Scenario 2: ASN-domain match: a stable attribution, still cached
    stubFetch(() =>
      jsonResponse(200, {
        country_code: 'US',
        asn: 'AS15169',
        as_name: 'Google LLC',
        as_domain: 'google.com',
      }),
    );
    await getIpAddressInfo('192.0.2.2', { offline: true, cache });
    expect(cache.has('192.0.2.2')).toBe(true);
  });

  it('testIPinfoAPIPrimarySourceAndInvalidKeyIsFatal', async () => {
    const apiJson = {
      ip: '8.8.8.8',
      asn: 'AS15169',
      as_name: 'Google LLC',
      as_domain: 'google.com',
      country_code: 'US',
    };
    // Success: the record comes from the API
    const fetchMock = stubFetch(() => jsonResponse(200, apiJson));
    await configureIpinfoApi('fake-token', { probe: false });
    let record = await getIpAddressDbRecord('8.8.8.8');
    expect(record.country).toBe('US');
    expect(record.asn).toBe(15_169);
    expect(record.asDomain).toBe('google.com');
    // Auth must use the documented query param, not a Bearer header.
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe(
      'https://api.ipinfo.io/lite/8.8.8.8',
    );
    expect(url.searchParams.get('token')).toBe('fake-token');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.headers).toMatchObject({ Accept: 'application/json' });

    // Invalid key: 401 raises a fatal exception even on a random lookup.
    stubFetch(() => jsonResponse(401));
    await configureIpinfoApi('bad-token', { probe: false });
    await expect(getIpAddressDbRecord('8.8.8.8')).rejects.toBeInstanceOf(
      InvalidIPinfoAPIKey,
    );

    // Any other non-2xx falls back to the MMDB silently.
    await configureIpinfoApi('fake-token', { probe: false });
    stubFetch(() => jsonResponse(500));
    record = await getIpAddressDbRecord('8.8.8.8');
    expect(record.asn).toBe(15_169);
    await configureIpinfoApi(null);
  });

  it('testGetIpAddressCountry', async () => {
    expect(await getIpAddressCountry('8.8.8.8')).toBe('US');
  });

  it('testGetIpAddressCountryNotFound', async () => {
    expect(await getIpAddressCountry('127.0.0.1')).toBeNull();
  });

  it('testGetServiceFromReverseDnsBaseDomainOffline', async () => {
    const result = await getServiceFromReverseDnsBaseDomain('google.com', {
      offline: true,
    });
    expect(result.name).toContain('Google');
    expect(result.type).not.toBeNull();
  });

  it('testGetServiceFromReverseDnsBaseDomainUnknown', async () => {
    const result = await getServiceFromReverseDnsBaseDomain(
      'unknown-domain-xyz.example',
      {
        offline: true,
      },
    );
    expect(result).toEqual({ name: 'unknown-domain-xyz.example', type: null });
  });

  it('testGetIpAddressInfoOffline', async () => {
    const info = await getIpAddressInfo('8.8.8.8', { offline: true });
    expect(info.ipAddress).toBe('8.8.8.8');
    expect(info.country).toBe('US');
    expect(info.reverseDns).toBeNull();
  });

  it('testGetIpAddressInfoCache', async () => {
    const cache = newCache(60);
    dnsMock.handler = () => ['dns.google'];
    const info1 = await getIpAddressInfo('8.8.8.8', {
      offline: false,
      cache,
      alwaysUseLocalFiles: true,
    });
    expect(cache.has('8.8.8.8')).toBe(true);
    expect(info1.reverseDns).toBe('dns.google');
    expect(info1.baseDomain).toBe('dns.google');
    dnsMock.handler = () => {
      throw new Error('the cache must answer');
    };
    const info2 = await getIpAddressInfo('8.8.8.8', { offline: false, cache });
    expect(info2.ipAddress).toBe(info1.ipAddress);
    expect(info2.reverseDns).toBe('dns.google');
  });

  it('getIpAddressInfo takes every option from a ParserConfig', async () => {
    const config = createParserConfig({ offline: true });
    const info = await getIpAddressInfo('8.8.8.8', { config });
    expect(info.name).toBe('Google (Including Gmail and Google Workspace)');
    expect(config.ipAddressCache.get('8.8.8.8')).toBe(info);
    // The config's reverse DNS map was loaded in place
    expect(config.reverseDnsMap.size).toBeGreaterThan(0);
  });
});

describe('TestLoadReverseDnsMapReloadsPSLOverrides', () => {
  function writeOverridesFile(): string {
    const file = path.join(makeTempDir(), 'overrides.txt');
    writeFileSync(file, '.internal.example-503.net\n', 'utf8');
    return file;
  }

  it('test_map_load_triggers_psl_reload', async () => {
    const fetchMock = stubFetch(networkError);
    pslOverrides.splice(0, pslOverrides.length, '.stale-from-before.com');
    await loadReverseDnsMap(new Map(), { offline: true });
    expect(pslOverrides).not.toContain('.stale-from-before.com');
    expect(pslOverrides).toContain('.linode.com');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test_map_load_forwards_psl_overrides_kwargs (path)', async () => {
    const file = writeOverridesFile();
    const fetchMock = stubFetch(networkError);
    await loadReverseDnsMap(new Map(), {
      offline: true,
      alwaysUseLocalFile: true,
      pslOverridesPath: file,
      pslOverridesUrl: 'https://example.test/ov',
    });
    expect([...pslOverrides]).toEqual(['.internal.example-503.net']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test_map_load_forwards_psl_overrides_kwargs (url)', async () => {
    const fetchMock = stubFetch(url =>
      String(url) === 'https://example.test/ov'
        ? new Response('.from-url.example\n')
        : new Response(
            'base_reverse_dns,name,type\nexample.org,Example,Test\n',
          ),
    );
    const rdm: ReverseDNSMap = new Map();
    await loadReverseDnsMap(rdm, {
      pslOverridesUrl: 'https://example.test/ov',
      url: 'https://example.test/map.csv',
    });
    expect([...pslOverrides]).toEqual(['.from-url.example']);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://example.test/ov',
      'https://example.test/map.csv',
    ]);
    expect([...rdm]).toEqual([
      ['example.org', { name: 'Example', type: 'Test' }],
    ]);
  });

  it('test_lazy_reverse_dns_map_load_applies_psl_overrides', async () => {
    const file = writeOverridesFile();
    await getServiceFromReverseDnsBaseDomain('something.example', {
      reverseDnsMap: new Map(),
      alwaysUseLocalFile: true,
      offline: true,
      pslOverridesPath: file,
    });
    expect(getBaseDomain('deep.sub.internal.example-503.net')).toBe(
      'internal.example-503.net',
    );
  });

  it('test_get_ip_address_info_lazy_load_applies_psl_overrides', async () => {
    const file = writeOverridesFile();
    await getIpAddressInfo('192.0.2.1', {
      offline: true,
      reverseDnsMap: new Map(),
      alwaysUseLocalFiles: true,
      pslOverridesPath: file,
    });
    expect(getBaseDomain('deep.sub.internal.example-503.net')).toBe(
      'internal.example-503.net',
    );
  });
});

describe('TestUtilsIpDbPaths', () => {
  let oldCwd = '';
  beforeEach(() => {
    // Pin the managed path and the log-dedup marker to a known state.
    ipInfoState.ipDbPath = null;
    ipInfoState.lastLoggedIpDbPath = null;
    oldCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(oldCwd);
  });

  it('testCustomPathFallsBack', async () => {
    const capture = captureLogs(undefined, WARNING);
    try {
      const result = await getIpAddressCountry('1.1.1.1', {
        dbPath: '/nonexistent/path.mmdb',
      });
      expect(result === null || typeof result === 'string').toBe(true);
    } finally {
      capture.restore();
    }
    expect(capture.output[0]).toContain(
      'No file exists at /nonexistent/path.mmdb',
    );
  });

  it('testBundledDbWorks', async () => {
    expect(await getIpAddressCountry('8.8.8.8')).toBe('US');
  });

  it('testSystemGeoIpFileDoesNotShadowBundledDb', async () => {
    const directory = makeTempDir();
    writeFileSync(path.join(directory, 'GeoLite2-Country.mmdb'), '');
    process.chdir(directory);
    const record = await getIpAddressDbRecord('8.8.8.8');
    expect(record.asn).toBe(15_169);
    expect(record.asName).toBe('Google LLC');
    expect(record.asDomain).toBe('google.com');
  });

  it('testLoadedDbPathTakesPrecedenceOverSystemFiles', async () => {
    const directory = makeTempDir();
    writeFileSync(path.join(directory, 'GeoLite2-Country.mmdb'), '');
    const loadedCopy = path.join(directory, 'loaded.mmdb');
    copyFileSync(BUNDLED_DB, loadedCopy);
    ipInfoState.ipDbPath = loadedCopy;
    process.chdir(directory);
    const capture = captureLogs(undefined, DEBUG);
    let record;
    try {
      record = await getIpAddressDbRecord('8.8.8.8');
    } finally {
      capture.restore();
    }
    expect(record.asn).toBe(15_169);
    expect(capture.output).toContain(
      `DEBUG:tsdmarc:Using IP database at ${loadedCopy}`,
    );
  });

  it('testDbSelectionIsLoggedOncePerPath', async () => {
    const capture = captureLogs(undefined, DEBUG);
    try {
      await getIpAddressDbRecord('8.8.8.8');
      await getIpAddressDbRecord('1.1.1.1');
    } finally {
      capture.restore();
    }
    expect(
      capture.output.filter(message =>
        message.includes('Using IP database at'),
      ),
    ).toHaveLength(1);
  });

  it('testSystemPathUsedWhenBundledDbMissing', async () => {
    const directory = makeTempDir();
    copyFileSync(BUNDLED_DB, path.join(directory, 'GeoLite2-Country.mmdb'));
    process.chdir(directory);
    resourcesMock.bundledPath = path.join(directory, 'does-not-exist.mmdb');
    const capture = captureLogs(undefined, DEBUG);
    let record;
    try {
      record = await getIpAddressDbRecord('8.8.8.8');
    } finally {
      capture.restore();
    }
    expect(record.country).toBe('US');
    expect(capture.output).toContain(
      'DEBUG:tsdmarc:Using IP database at GeoLite2-Country.mmdb',
    );
  });

  it('testMissingEverythingRaisesFileNotFoundError', async () => {
    const directory = makeTempDir();
    process.chdir(directory);
    const missing = path.join(directory, 'does-not-exist.mmdb');
    resourcesMock.bundledPath = missing;
    // Make every system path look absent, whatever is installed here.
    fsMock.existsSync = () => false;
    try {
      const error = await getIpAddressDbRecord('8.8.8.8').catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: 'ENOENT' });
      expect(String((error as Error).message)).toContain(missing);
    } finally {
      fsMock.existsSync = null;
    }
  });

  it('testOldDatabaseFileWarns', async () => {
    const directory = makeTempDir();
    const oldCopy = path.join(directory, 'old.mmdb');
    copyFileSync(BUNDLED_DB, oldCopy);
    const fortyDaysAgo = Date.now() / 1000 - 40 * 24 * 3600;
    utimesSync(oldCopy, fortyDaysAgo, fortyDaysAgo);
    const capture = captureLogs(undefined, WARNING);
    let record;
    try {
      record = await getIpAddressDbRecord('8.8.8.8', { dbPath: oldCopy });
    } finally {
      capture.restore();
    }
    expect(record.asn).toBe(15_169);
    expect(capture.output).toContain(
      'WARNING:tsdmarc:IP database is more than a month old',
    );
  });
});

describe('TestUtilsReverseDnsMap', () => {
  it('testLoadReverseDnsMapOffline', async () => {
    const rdnsMap: ReverseDNSMap = new Map();
    await loadReverseDnsMap(rdnsMap, { offline: true });
    expect(rdnsMap.size).toBeGreaterThan(0);
  });

  it('testLoadReverseDnsMapLocalOverride', async () => {
    const file = path.join(makeTempDir(), 'map.csv');
    writeFileSync(
      file,
      'base_reverse_dns,name,type\ncustom.example.com,Custom Service,hosting\n',
    );
    const rdnsMap: ReverseDNSMap = new Map();
    await loadReverseDnsMap(rdnsMap, { offline: true, localFilePath: file });
    expect(rdnsMap.get('custom.example.com')?.name).toBe('Custom Service');
  });

  it('testLoadReverseDnsMapNetworkFailureFallback', async () => {
    stubFetch(networkError);
    const rdnsMap: ReverseDNSMap = new Map();
    await loadReverseDnsMap(rdnsMap);
    expect(rdnsMap.size).toBeGreaterThan(0);
  });

  it('testLoadReverseDnsMapInvalidCsvFallback', async () => {
    stubFetch(url =>
      String(url).endsWith('psl_overrides.txt')
        ? new Response('.linode.com\n')
        : new Response('not,the,map\nfoo,bar,baz\n'),
    );
    const rdnsMap: ReverseDNSMap = new Map();
    const capture = captureLogs(undefined, WARNING);
    try {
      await loadReverseDnsMap(rdnsMap);
    } finally {
      capture.restore();
    }
    expect(capture.output).toContain('WARNING:tsdmarc:Not a valid CSV file');
    expect(rdnsMap.size).toBeGreaterThan(0);
  });

  it('quoted CSV fields and CRLF line endings are read like Python csv', async () => {
    stubFetch(url =>
      String(url).endsWith('psl_overrides.txt')
        ? new Response('.linode.com\n')
        : new Response(
            'base_reverse_dns,name,type\r\n"Quoted.Example "," Name, with ""comma"" ",ISP\r\n\r\nplain.example,Plain,Web Host',
          ),
    );
    const rdnsMap: ReverseDNSMap = new Map();
    await loadReverseDnsMap(rdnsMap);
    expect([...rdnsMap]).toEqual([
      ['quoted.example', { name: 'Name, with "comma"', type: 'ISP' }],
      ['plain.example', { name: 'Plain', type: 'Web Host' }],
    ]);
  });

  it('testGetServiceUsesProvidedMap', async () => {
    const fetchMock = stubFetch(networkError);
    pslOverrides.splice(0, pslOverrides.length, '.sentinel.example');
    const provided: ReverseDNSMap = new Map([
      ['custom.example', { name: 'Custom Co', type: 'SaaS' }],
    ]);
    const service = await getServiceFromReverseDnsBaseDomain('Custom.Example', {
      reverseDnsMap: provided,
    });
    // Nothing was loaded: no download and the overrides were not reloaded
    expect(fetchMock).not.toHaveBeenCalled();
    expect([...pslOverrides]).toEqual(['.sentinel.example']);
    expect(service).toEqual({ name: 'Custom Co', type: 'SaaS' });
  });
});

describe('TestLoadIpDb', () => {
  let cacheRoot = '';
  let savedCacheHome: string | undefined;
  beforeEach(() => {
    ipInfoState.ipDbPath = null;
    // Redirect the per-user download cache into a per-test directory.
    cacheRoot = makeTempDir();
    savedCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheRoot;
  });
  afterEach(() => {
    if (savedCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = savedCacheHome;
    }
  });

  it('testExistingLocalFileIsUsedDirectly', async () => {
    const localPath = path.join(cacheRoot, 'local.mmdb');
    writeFileSync(localPath, 'local db');
    const fetchMock = stubFetch(networkError);
    await loadIpDb({ localFilePath: localPath });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ipInfoState.ipDbPath).toBe(localPath);
  });

  it('testDownloadSuccessWritesCacheFile', async () => {
    const fetchMock = stubFetch(() => new Response(readFileSync(BUNDLED_DB)));
    await loadIpDb({ url: 'https://example.com/db.mmdb' });
    expect(String((fetchMock.mock.calls[0] as [URL])[0])).toBe(
      'https://example.com/db.mmdb',
    );
    const cachedPath = path.join(cacheRoot, 'tsdmarc', 'ipinfo_lite.mmdb');
    expect(ipInfoState.ipDbPath).toBe(cachedPath);
    expect(readFileSync(cachedPath).equals(readFileSync(BUNDLED_DB))).toBe(
      true,
    );
  });

  it('testDownloadFailureFallsBackToCachedCopy', async () => {
    const cacheDir = path.join(cacheRoot, 'tsdmarc');
    mkdirSync(cacheDir);
    const cachedPath = path.join(cacheDir, 'ipinfo_lite.mmdb');
    writeFileSync(cachedPath, 'stale cached db');
    stubFetch(networkError);
    const capture = captureLogs(undefined, WARNING);
    try {
      await loadIpDb();
    } finally {
      capture.restore();
    }
    expect(capture.output).toContain(
      'WARNING:tsdmarc:Failed to fetch IP database: ConnectError: no network',
    );
    expect(ipInfoState.ipDbPath).toBe(cachedPath);
  });

  it('testDownloadFailureFallsBackToBundledCopy', async () => {
    stubFetch(networkError);
    await loadIpDb();
    expect(ipInfoState.ipDbPath).toBe(BUNDLED_DB);
  });

  it('a non-2xx download falls back like a network error', async () => {
    stubFetch(() => new Response('nope', { status: 404 }));
    const capture = captureLogs(undefined, WARNING);
    try {
      await loadIpDb({ url: 'https://example.com/db.mmdb?sig=secret' });
    } finally {
      capture.restore();
    }
    expect(capture.output[0]).toBe(
      "WARNING:tsdmarc:Failed to fetch IP database: HTTP 404 for url 'https://example.com/db.mmdb'",
    );
    expect(ipInfoState.ipDbPath).toBe(BUNDLED_DB);
  });

  it('testSaveFailureFallsBackToBundledCopy', async () => {
    const blocker = path.join(cacheRoot, 'blocker');
    writeFileSync(blocker, 'not a directory');
    process.env.XDG_CACHE_HOME = blocker;
    stubFetch(() => new Response(readFileSync(BUNDLED_DB)));
    const capture = captureLogs(undefined, WARNING);
    try {
      await loadIpDb();
    } finally {
      capture.restore();
    }
    expect(
      capture.output.some(message =>
        message.includes('Failed to save IP database'),
      ),
    ).toBe(true);
    expect(ipInfoState.ipDbPath).toBe(BUNDLED_DB);
  });

  it('offline uses the bundled copy without downloading', async () => {
    const fetchMock = stubFetch(networkError);
    await loadIpDb({ offline: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ipInfoState.ipDbPath).toBe(BUNDLED_DB);
  });

  it.skipIf(process.platform === 'win32')(
    'creates a private cache directory and leaves no temp files',
    async () => {
      stubFetch(() => new Response(readFileSync(BUNDLED_DB)));
      await loadIpDb({ url: 'https://example.com/db.mmdb' });
      const cacheDir = path.join(cacheRoot, 'tsdmarc');
      expect(lstatSync(cacheDir).mode & 0o777).toBe(0o700);
      expect(readdirSync(cacheDir)).toEqual(['ipinfo_lite.mmdb']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tightens a cache directory open to other users',
    async () => {
      const cacheDir = path.join(cacheRoot, 'tsdmarc');
      mkdirSync(cacheDir, { mode: 0o777 });
      chmodSync(cacheDir, 0o777);
      stubFetch(() => new Response(readFileSync(BUNDLED_DB)));
      await loadIpDb({ url: 'https://example.com/db.mmdb' });
      expect(lstatSync(cacheDir).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked cache directory',
    async () => {
      const elsewhere = makeTempDir();
      writeFileSync(path.join(elsewhere, 'ipinfo_lite.mmdb'), 'planted db');
      symlinkSync(elsewhere, path.join(cacheRoot, 'tsdmarc'));
      stubFetch(() => new Response(readFileSync(BUNDLED_DB)));
      const capture = captureLogs(undefined, WARNING);
      try {
        await loadIpDb({ url: 'https://example.com/db.mmdb' });
      } finally {
        capture.restore();
      }
      expect(capture.output).toContain(
        `WARNING:tsdmarc:Failed to save IP database: Cache path is not a directory: ${path.join(cacheRoot, 'tsdmarc')}`,
      );
      // Neither written through the link nor read from it.
      expect(
        readFileSync(path.join(elsewhere, 'ipinfo_lite.mmdb'), 'utf8'),
      ).toBe('planted db');
      expect(ipInfoState.ipDbPath).toBe(BUNDLED_DB);
    },
  );
});

/** An aggregate report with one minimal record per source IP. */
function reportWith(ips: readonly string[]): string {
  const records = ips.map(
    ip =>
      `<record><row><source_ip>${ip}</source_ip><count>1</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers><auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results></record>`,
  );
  return `<?xml version="1.0"?><feedback><report_metadata><org_name>o</org_name><email>a@b.c</email><report_id>r</report_id><date_range><begin>1700000000</begin><end>1700086400</end></date_range></report_metadata><policy_published><domain>example.com</domain><p>none</p></policy_published>${records.join('')}</feedback>`;
}

describe('source_ip validation', () => {
  it.each(['me', '../me?x=1', '8.8.8.8\nforged line'])(
    'rejects %j before any network lookup',
    async ip => {
      await configureIpinfoApi('fake-token', { probe: false });
      const fetchMock = stubFetch(() =>
        jsonResponse(200, { country_code: 'ES', asn: 'AS3352' }),
      );
      const dnsHandler = vi.fn(() => {
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      });
      dnsMock.handler = dnsHandler;
      const capture = captureLogs(undefined, DEBUG);
      try {
        await expect(
          getIpAddressInfo(ip, { cache: newCache() }),
        ).rejects.toThrow('does not appear to be an IPv4 or IPv6 address');
        await expect(getIpAddressDbRecord(ip)).rejects.toThrow(
          'does not appear to be an IPv4 or IPv6 address',
        );
      } finally {
        capture.restore();
        await configureIpinfoApi(null);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(dnsHandler).not.toHaveBeenCalled();
      expect(capture.output).toEqual([]);
    },
  );

  it('the classic inet_aton forms maxminddb accepts still work', async () => {
    const info = await getIpAddressInfo('8.8.8.8', { offline: true });
    expect(info.country).toBe('US');
    const short = await getIpAddressInfo('8.8.2056', { offline: true });
    expect(short.ipAddress).toBe('8.8.2056');
    expect(short.country).toBe('US');
  });
});

describe('network lookups per report', () => {
  const uniqueIps = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `8.8.4.${index + 1}`);
  const dnsOptions = {
    nameservers: ['192.0.2.1'],
    dnsTimeout: 0.05,
    dnsRetries: 0,
  };

  function failDns(code: string): { calls: number } {
    const counter = { calls: 0 };
    dnsMock.handler = () => {
      counter.calls += 1;
      throw Object.assign(new Error(code), { code });
    };
    return counter;
  }

  it('stops resolving after too many failed lookups, keeping every record', async () => {
    const counter = failDns('ESERVFAIL');
    const cache = newCache();
    const capture = captureLogs(undefined, WARNING);
    let report: Awaited<ReturnType<typeof parseAggregateReportXml>>;
    try {
      report = await parseAggregateReportXml(reportWith(uniqueIps(10)), {
        config: createParserConfig({
          ...dnsOptions,
          ipAddressCache: cache,
          maxFailedLookupsPerReport: 3,
        }),
      });
    } finally {
      capture.restore();
    }
    expect(counter.calls).toBe(3);
    expect(report.records).toHaveLength(10);
    expect(report.records[9]?.source.reverseDns).toBeNull();
    expect(report.records[9]?.source.country).toBe('US');
    expect(
      capture.output.filter(line => line.includes('network lookups')),
    ).toHaveLength(1);
    // A later report must not inherit the unresolved result.
    expect(cache.get('8.8.4.10')).toBeUndefined();
  });

  it('caps all lookups of a report', async () => {
    const counter = failDns('ENOTFOUND');
    const report = await parseAggregateReportXml(reportWith(uniqueIps(10)), {
      config: createParserConfig({ ...dnsOptions, maxLookupsPerReport: 2 }),
    });
    expect(counter.calls).toBe(2);
    expect(report.records).toHaveLength(10);
  });

  it('stops calling the IPinfo API past the cap', async () => {
    failDns('ENOTFOUND');
    await configureIpinfoApi('fake-token', { probe: false });
    const fetchMock = stubFetch(() => jsonResponse(500));
    try {
      await parseAggregateReportXml(reportWith(uniqueIps(5)), {
        config: createParserConfig({ ...dnsOptions, maxLookupsPerReport: 2 }),
      });
    } finally {
      await configureIpinfoApi(null);
    }
    const apiCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith('https://api.ipinfo.io/'),
    );
    expect(apiCalls).toHaveLength(2);
  });

  it('an address with no PTR is an answer, not a failure', async () => {
    const counter = failDns('ENOTFOUND');
    await parseAggregateReportXml(reportWith(uniqueIps(10)), {
      config: createParserConfig({
        ...dnsOptions,
        maxFailedLookupsPerReport: 1,
      }),
    });
    expect(counter.calls).toBe(10);
  });

  it('each report starts with a full budget', async () => {
    const counter = failDns('ESERVFAIL');
    const options = {
      config: createParserConfig({
        ...dnsOptions,
        maxFailedLookupsPerReport: 2,
      }),
    };
    await parseAggregateReportXml(reportWith(uniqueIps(5)), options);
    await parseAggregateReportXml(reportWith(uniqueIps(5)), options);
    expect(counter.calls).toBe(4);
  });

  it('0 disables the limits, and the defaults let a large report through', async () => {
    const counter = failDns('ESERVFAIL');
    const unlimited = await parseAggregateReportXml(reportWith(uniqueIps(20)), {
      config: createParserConfig({
        ...dnsOptions,
        maxFailedLookupsPerReport: 0,
        maxLookupsPerReport: 0,
      }),
    });
    expect(counter.calls).toBe(20);
    expect(unlimited.records).toHaveLength(20);

    const ok = failDns('ENOTFOUND');
    const ips = Array.from(
      { length: 3000 },
      (_, index) => `2001:db8::${index.toString(16)}`,
    );
    const large = await parseAggregateReportXml(reportWith(ips), {
      config: createParserConfig(dnsOptions),
    });
    expect(ok.calls).toBe(3000);
    expect(large.records).toHaveLength(3000);
  });
});

describe('lookup time per report (not in parsedmarc)', () => {
  const uniqueIps = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `8.8.4.${index + 1}`);
  const dnsOptions = {
    nameservers: ['192.0.2.1'],
    dnsTimeout: 2,
    dnsRetries: 0,
  };

  /** NXDOMAIN after `delayMs`: an answer, so not a failure, but slow. */
  function slowNxdomain(delayMs: number): { calls: number } {
    const counter = { calls: 0 };
    dnsMock.handler = async () => {
      counter.calls += 1;
      await new Promise(resolve => {
        setTimeout(resolve, delayMs);
      });
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    return counter;
  }

  it('stops resolving once the report used its time, keeping every record', async () => {
    const counter = slowNxdomain(20);
    const capture = captureLogs(undefined, WARNING);
    let report: Awaited<ReturnType<typeof parseAggregateReportXml>>;
    try {
      report = await parseAggregateReportXml(reportWith(uniqueIps(100)), {
        config: createParserConfig({
          ...dnsOptions,
          maxLookupTimePerReport: 0.2,
        }),
      });
    } finally {
      capture.restore();
    }
    expect(counter.calls).toBeGreaterThan(0);
    expect(counter.calls).toBeLessThan(30);
    expect(report.records).toHaveLength(100);
    expect(report.records[99]?.source.country).toBe('US');
    expect(
      capture.output.filter(line => line.includes('network lookups')),
    ).toHaveLength(1);
  });

  it('is off with 0', async () => {
    const counter = slowNxdomain(1);
    await parseAggregateReportXml(reportWith(uniqueIps(20)), {
      config: createParserConfig({ ...dnsOptions, maxLookupTimePerReport: 0 }),
    });
    expect(counter.calls).toBe(20);
  });

  it('looks up an address the cache does not keep once per report', async () => {
    // Google's ASN domain isn't in this map, so a failed PTR lookup is a
    // weak attribution the shared cache doesn't keep.
    const counter = slowNxdomain(0);
    const reverseDnsMap = new Map([
      ['example.invalid', { name: 'Example', type: 'Test' }],
    ]);
    const config = createParserConfig({ ...dnsOptions, reverseDnsMap });
    const ips = Array.from({ length: 50 }, () => '8.8.4.4');
    const report = await parseAggregateReportXml(reportWith(ips), { config });
    expect(counter.calls).toBe(1);
    expect(report.records).toHaveLength(50);
    expect(new Set(report.records.map(r => r.source.name)).size).toBe(1);
    // The next report looks it up again.
    await parseAggregateReportXml(reportWith(ips.slice(0, 2)), { config });
    expect(counter.calls).toBe(2);
  });
});

describe('unusable enrichment sources', () => {
  let cacheRoot = '';
  let savedCacheHome: string | undefined;

  beforeEach(() => {
    ipInfoState.ipDbPath = null;
    cacheRoot = makeTempDir();
    savedCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheRoot;
  });
  afterEach(() => {
    if (savedCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = savedCacheHome;
    }
  });

  it('a download that is not a database keeps the cached copy', async () => {
    const cacheDir = path.join(cacheRoot, 'tsdmarc');
    mkdirSync(cacheDir, { mode: 0o700 });
    const cachedPath = path.join(cacheDir, 'ipinfo_lite.mmdb');
    copyFileSync(BUNDLED_DB, cachedPath);
    stubFetch(() => new Response('<html>captive portal</html>'));
    const capture = captureLogs(undefined, WARNING);
    try {
      await loadIpDb({ url: 'https://example.com/db.mmdb' });
    } finally {
      capture.restore();
    }
    expect(ipInfoState.ipDbPath).toBe(cachedPath);
    expect(readFileSync(cachedPath).equals(readFileSync(BUNDLED_DB))).toBe(
      true,
    );
    expect(capture.output.join('\n')).toContain(
      'Failed to save IP database: Downloaded file is not a valid MMDB database',
    );
  });

  it('a corrupt database falls back to the bundled copy, warning once', async () => {
    const corrupt = path.join(cacheRoot, 'corrupt.mmdb');
    writeFileSync(corrupt, 'not a database');
    ipInfoState.ipDbPath = corrupt;
    const capture = captureLogs(undefined, WARNING);
    try {
      expect((await getIpAddressDbRecord('8.8.8.8')).country).toBe('US');
      expect((await getIpAddressDbRecord('1.1.1.1')).asn).toBe(13_335);
    } finally {
      capture.restore();
    }
    expect(capture.output.filter(line => line.includes(corrupt))).toHaveLength(
      1,
    );
  });

  it('no readable database at all rejects the report instead of emptying it', async () => {
    const corrupt = path.join(cacheRoot, 'corrupt.mmdb');
    writeFileSync(corrupt, 'not a database');
    ipInfoState.ipDbPath = corrupt;
    resourcesMock.bundledPath = null;
    await expect(getIpAddressDbRecord('8.8.8.8')).rejects.toBeInstanceOf(
      IPDatabaseError,
    );
    await expect(
      parseAggregateReportXml(reportWith(['8.8.8.8', '1.1.1.1']), {
        config: createParserConfig({ offline: true }),
      }),
    ).rejects.toThrow(/No usable IP database/u);
  });

  it('a token rejected mid-run rejects the report instead of emptying it', async () => {
    await configureIpinfoApi('revoked', { probe: false });
    stubFetch(() => jsonResponse(401));
    try {
      const error = await parseAggregateReportXml(
        reportWith(['8.8.8.8', '1.1.1.1']),
        { config: createParserConfig({ offline: true }) },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InvalidAggregateReport);
      expect((error as Error).cause).toBeInstanceOf(InvalidIPinfoAPIKey);
    } finally {
      await configureIpinfoApi(null);
    }
  });

  it('a bad record is still skipped on its own', async () => {
    const capture = captureLogs(undefined, WARNING);
    let report: Awaited<ReturnType<typeof parseAggregateReportXml>>;
    try {
      report = await parseAggregateReportXml(
        reportWith(['not-an-ip', '8.8.8.8']),
        { config: createParserConfig({ offline: true }) },
      );
    } finally {
      capture.restore();
    }
    expect(report.records).toHaveLength(1);
    expect(capture.output.join('\n')).toContain('Could not parse record');
  });
});

describe('credentials and tokens in download URLs', () => {
  function stubRefusedCredentials(): void {
    // What undici does with credentials in the URL.
    stubFetch(url => {
      if (url.username !== '') {
        throw new TypeError(
          `Request cannot be constructed from a URL that includes credentials: ${url.href}`,
        );
      }
      return new Response('nope', { status: 403 });
    });
  }

  it('the IP database warning has no password', async () => {
    stubRefusedCredentials();
    const capture = captureLogs(undefined, DEBUG);
    try {
      await loadIpDb({ url: 'https://u:s3cret@db.example/ip.mmdb' });
    } finally {
      capture.restore();
    }
    const logged = capture.output.join('\n');
    expect(logged).not.toContain('s3cret');
    expect(logged).toContain(
      "Failed to fetch IP database: HTTP 403 for url 'https://u:***@db.example/ip.mmdb'",
    );
  });

  it('the reverse DNS map warning has no password', async () => {
    stubRefusedCredentials();
    const capture = captureLogs(undefined, DEBUG);
    try {
      await loadReverseDnsMap(new Map(), {
        url: 'https://u:s3cret@map.example/map.csv',
        pslOverridesUrl: 'https://u:s3cret@map.example/psl.txt',
      });
    } finally {
      capture.restore();
    }
    const logged = capture.output.join('\n');
    expect(logged).not.toContain('s3cret');
    expect(logged).toContain(
      "Failed to fetch reverse DNS map: HTTP 403 for url 'https://u:***@map.example/map.csv'",
    );
  });

  // parsedmarc's TestDownloadUrlCredentialsNotLogged: a password with an
  // unencoded "/", "?" or "#" ends the authority early, so httpx raises
  // InvalidURL quoting part of it; the warning has a fixed message instead.
  const malformedUrls: [string, string][] = [
    ['https://admin:p4ssw0rd/x@downloads.example.test/map.dat', 'p4ssw0rd'],
    ['https://admin:p4ss?w0rd@downloads.example.test/map.dat', 'p4ss'],
    ['https://admin:p4ss#w0rd@downloads.example.test/map.dat', 'p4ss'],
  ];
  const invalidUrlMessage =
    'invalid URL (details withheld because they may include credentials)';

  it.each(malformedUrls)(
    'test_ip_db_loader_invalid_url: %s',
    async (url, secret) => {
      stubFetch(networkError);
      const capture = captureLogs(undefined, DEBUG);
      try {
        await loadIpDb({ url });
      } finally {
        capture.restore();
      }
      const logged = capture.output.join('\n');
      expect(logged).not.toContain(secret);
      expect(capture.output).toContain(
        'DEBUG:tsdmarc:Trying to fetch IP database from https://***@downloads.example.test/map.dat...',
      );
      expect(capture.output).toContain(
        `WARNING:tsdmarc:Failed to fetch IP database: ${invalidUrlMessage}`,
      );
      expect(logged).not.toContain('Failed to save IP database');
    },
  );

  it.each(malformedUrls)(
    'test_reverse_dns_map_loader_invalid_url: %s',
    async (url, secret) => {
      stubFetch(networkError);
      const capture = captureLogs(undefined, DEBUG);
      try {
        await loadReverseDnsMap(new Map(), { url });
      } finally {
        capture.restore();
      }
      const logged = capture.output.join('\n');
      expect(logged).not.toContain(secret);
      expect(capture.output).toContain(
        'DEBUG:tsdmarc:Trying to fetch reverse DNS map from https://***@downloads.example.test/map.dat...',
      );
      expect(capture.output).toContain(
        `WARNING:tsdmarc:Failed to fetch reverse DNS map: ${invalidUrlMessage}`,
      );
      expect(logged).not.toContain('Not a valid CSV file');
    },
  );

  // parsedmarc logs the query string, where IPinfo's download URL carries
  // its token.
  it('keeps the query string out of the download debug lines', async () => {
    stubFetch(networkError);
    const url = 'https://downloads.example.test/map.dat?token=SECRET';
    const capture = captureLogs(undefined, DEBUG);
    try {
      await loadIpDb({ url });
      await loadReverseDnsMap(new Map(), { url });
    } finally {
      capture.restore();
    }
    expect(capture.output.join('\n')).not.toContain('SECRET');
    expect(capture.output).toContain(
      'DEBUG:tsdmarc:Trying to fetch IP database from https://downloads.example.test/map.dat...',
    );
    expect(capture.output).toContain(
      'DEBUG:tsdmarc:Trying to fetch reverse DNS map from https://downloads.example.test/map.dat...',
    );
  });

  it('test_ip_db_loader_transport_error', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed', {
        cause: new Error('connection refused'),
      });
    });
    const capture = captureLogs(undefined, WARNING);
    try {
      await loadIpDb({
        url: 'https://dluser:DLSECRET@downloads.example.test/map.dat',
      });
    } finally {
      capture.restore();
    }
    const logged = capture.output.join('\n');
    expect(logged).not.toContain('DLSECRET');
    expect(logged).toContain(
      'Failed to fetch IP database: ConnectError: connection refused',
    );
  });

  it('a failed IPinfo request does not log the token', async () => {
    await configureIpinfoApi('s3cret-token', { probe: false });
    // A refused connection in Deno: the cause quotes the full URL.
    stubFetch(url => {
      throw new TypeError('fetch failed', {
        cause: new Error(`error sending request for url (${url.href})`),
      });
    });
    const capture = captureLogs(undefined, DEBUG);
    try {
      await getIpAddressDbRecord('8.8.8.8');
    } finally {
      capture.restore();
      await configureIpinfoApi(null);
    }
    const logged = capture.output.join('\n');
    expect(logged).not.toContain('s3cret-token');
    expect(logged).toContain(
      'IPinfo API request for 8.8.8.8 failed: error sending request for url (https://api.ipinfo.io/lite/8.8.8.8)',
    );
  });
});

describe('concurrent reloads', () => {
  it('keep the previous map and overrides visible and share one download', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const fetchMock = stubFetch(async url => {
      await gate;
      return String(url).includes('psl')
        ? new Response('.new-override.example\n')
        : new Response('base_reverse_dns,name,type\nnew.example,New,hosting\n');
    });
    pslOverrides.splice(0, pslOverrides.length, '.old-override.example');
    const rdnsMap: ReverseDNSMap = new Map([
      ['old.example', { name: 'Old', type: 'hosting' }],
    ]);
    const options = {
      url: 'https://example.com/map.csv',
      pslOverridesUrl: 'https://example.com/psl.txt',
    };
    const first = loadReverseDnsMap(rdnsMap, options);
    const second = loadReverseDnsMap(rdnsMap, options);
    await new Promise(resolve => setTimeout(resolve, 10));
    // Mid-download: the old data is still there.
    expect([...pslOverrides]).toEqual(['.old-override.example']);
    expect([...rdnsMap.keys()]).toEqual(['old.example']);
    release();
    await Promise.all([first, second]);
    expect([...pslOverrides]).toEqual(['.new-override.example']);
    expect([...rdnsMap.keys()]).toEqual(['new.example']);
    // One PSL download and one map download for both callers.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('TestConfigureIpinfoApiProbe', () => {
  afterEach(async () => {
    await configureIpinfoApi(null);
  });

  it('testProbeSuccessLogsConfigured', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(200, { ip: '1.1.1.1', asn: 'AS13335', country_code: 'US' }),
    );
    const capture = captureLogs(undefined, INFO);
    try {
      await configureIpinfoApi('fake-token', { probe: true });
    } finally {
      capture.restore();
    }
    expect(capture.output).toContain('INFO:tsdmarc:IPinfo API configured');
    expect((fetchMock.mock.calls[0] as [URL])[0].pathname).toBe(
      '/lite/1.1.1.1',
    );
  });

  it('testProbeNetworkErrorKeepsToken', async () => {
    stubFetch(networkError);
    const capture = captureLogs(undefined, WARNING);
    try {
      await configureIpinfoApi('fake-token', { probe: true });
    } finally {
      capture.restore();
    }
    expect(capture.output).toContain(
      'WARNING:tsdmarc:IPinfo API probe failed (will fall back per-request)',
    );
    expect(ipInfoState.ipinfoApiToken).toBe('fake-token');
  });

  it('testProbeInvalidKeyRaises', async () => {
    stubFetch(() => jsonResponse(401));
    await expect(
      configureIpinfoApi('bad-token', { probe: true }),
    ).rejects.toThrow(
      new InvalidIPinfoAPIKey(
        'IPinfo API rejected the configured token (HTTP 401)',
      ),
    );
  });

  it('the token never appears in debug logs', async () => {
    stubFetch(() => jsonResponse(502));
    await configureIpinfoApi('secret-token', { probe: false });
    const capture = captureLogs(undefined, DEBUG);
    try {
      await getIpAddressDbRecord('8.8.8.8');
    } finally {
      capture.restore();
    }
    expect(capture.output).toContain(
      'DEBUG:tsdmarc:IPinfo API returned HTTP 502 for 8.8.8.8',
    );
    expect(capture.output.join('\n')).not.toContain('secret-token');
  });
});

describe('TestIpinfoApiLookupFallbacks', () => {
  beforeEach(async () => {
    await configureIpinfoApi('fake-token', { probe: false });
  });
  afterEach(async () => {
    await configureIpinfoApi(null);
  });

  async function expectMmdbFallback(handler: FetchHandler): Promise<void> {
    stubFetch(handler);
    const record = await getIpAddressDbRecord('8.8.8.8');
    // The bundled MMDB attributes 8.8.8.8 to Google's ASN.
    expect(record.asn).toBe(15_169);
  }

  it('testNetworkErrorFallsBackToMmdb', async () => {
    await expectMmdbFallback(networkError);
  });

  it('testNonJsonBodyFallsBackToMmdb', async () => {
    await expectMmdbFallback(() => new Response('not JSON', { status: 200 }));
  });

  it('testNonDictPayloadFallsBackToMmdb', async () => {
    await expectMmdbFallback(() => jsonResponse(200, ['not', 'a', 'dict']));
  });
});

describe('TestNormalizeIpRecord', () => {
  it('testMaxMindSchema', () => {
    const record = normalizeIpRecord({
      country: { iso_code: 'US' },
      autonomous_system_number: 15_169,
      autonomous_system_organization: 'Google LLC',
    });
    expect(record).toEqual({
      country: 'US',
      asn: 15_169,
      asName: 'Google LLC',
      asDomain: null,
    });
  });

  it('testIntegerAsnPassesThrough', () => {
    const record = normalizeIpRecord({
      country_code: 'US',
      asn: 64_496,
      as_domain: 'EXAMPLE.com',
    });
    expect(record.asn).toBe(64_496);
    expect(record.asDomain).toBe('example.com');
  });

  it('IPinfo string ASNs lose their AS prefix; malformed ones are dropped', () => {
    expect(normalizeIpRecord({ asn: 'AS13335' }).asn).toBe(13_335);
    expect(normalizeIpRecord({ asn: 'as13335' }).asn).toBe(13_335);
    expect(normalizeIpRecord({ asn: 'ASN13335' }).asn).toBeNull();
    expect(
      normalizeIpRecord({ asn: '', autonomous_system_number: 7 }).asn,
    ).toBe(7);
  });
});
