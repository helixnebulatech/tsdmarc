import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createParserConfig,
  DEFAULT_JOB_TIMEOUT,
  DEFAULT_MAX_WORKER_HEAP_MB,
  ExpiringDict,
  IP_ADDRESS_CACHE,
  parserConfigFromState,
  parserConfigToState,
  replaceParserConfig,
  resolveParserConfig,
  REVERSE_DNS_MAP,
  SEEN_AGGREGATE_REPORT_IDS,
} from './config';
import {
  IP_ADDRESS_CACHE as PUBLIC_IP_ADDRESS_CACHE,
  REVERSE_DNS_MAP as PUBLIC_REVERSE_DNS_MAP,
  SEEN_AGGREGATE_REPORT_IDS as PUBLIC_SEEN_AGGREGATE_REPORT_IDS,
} from './index';
import type { IPAddressInfo } from './types';

const ipInfo = (ipAddress: string): IPAddressInfo => ({
  ipAddress,
  country: null,
  reverseDns: null,
  baseDomain: null,
  name: null,
  type: null,
  asn: null,
  asName: null,
  asDomain: null,
});

describe('ParserConfig caches', () => {
  it('gives each instance isolated caches', () => {
    const a = createParserConfig();
    const b = createParserConfig();
    expect(a.ipAddressCache).not.toBe(b.ipAddressCache);
    expect(a.seenAggregateReportIds).not.toBe(b.seenAggregateReportIds);
    expect(a.reverseDnsMap).not.toBe(b.reverseDnsMap);
    for (const config of [a, b]) {
      expect(config.ipAddressCache).not.toBe(IP_ADDRESS_CACHE);
      expect(config.seenAggregateReportIds).not.toBe(SEEN_AGGREGATE_REPORT_IDS);
      expect(config.reverseDnsMap).not.toBe(REVERSE_DNS_MAP);
    }

    a.ipAddressCache.set('1.2.3.4', ipInfo('1.2.3.4'));
    a.seenAggregateReportIds.set('report-id-a', true);
    a.reverseDnsMap.set('example.com', { name: 'Example', type: null });

    expect(b.ipAddressCache.has('1.2.3.4')).toBe(false);
    expect(b.seenAggregateReportIds.has('report-id-a')).toBe(false);
    expect(b.reverseDnsMap.has('example.com')).toBe(false);
    expect(IP_ADDRESS_CACHE.has('1.2.3.4')).toBe(false);
    expect(SEEN_AGGREGATE_REPORT_IDS.has('report-id-a')).toBe(false);
    expect(REVERSE_DNS_MAP.has('example.com')).toBe(false);
  });

  it('binds option-style calls to the module-default caches', () => {
    const config = resolveParserConfig({ offline: true, dnsTimeout: 3 });
    expect(config.offline).toBe(true);
    expect(config.dnsTimeout).toBe(3);
    expect(config.ipAddressCache).toBe(IP_ADDRESS_CACHE);
    expect(config.seenAggregateReportIds).toBe(SEEN_AGGREGATE_REPORT_IDS);
    expect(config.reverseDnsMap).toBe(REVERSE_DNS_MAP);
  });

  it('limits a job to one hour by default', () => {
    expect(createParserConfig().jobTimeout).toBe(DEFAULT_JOB_TIMEOUT);
    expect(DEFAULT_JOB_TIMEOUT).toBe(3600);
    expect(createParserConfig({ jobTimeout: 0 }).jobTimeout).toBe(0);
    expect(createParserConfig().maxWorkerHeapMb).toBe(2048);
    expect(DEFAULT_MAX_WORKER_HEAP_MB).toBe(2048);
    expect(createParserConfig({ maxWorkerHeapMb: 0 }).maxWorkerHeapMb).toBe(0);
    expect(
      parserConfigFromState(
        parserConfigToState(createParserConfig({ jobTimeout: 5 })),
      ).jobTimeout,
    ).toBe(5);
  });

  it('returns an explicit config unchanged and ignores individual options', () => {
    const explicit = createParserConfig({ dnsTimeout: 9 });
    expect(
      resolveParserConfig({ config: explicit, dnsTimeout: 1, offline: true }),
    ).toBe(explicit);
  });
});

describe('module default caches', () => {
  it('test_module_default_caches_are_the_public_globals', () => {
    // The package entry point re-exports the very same cache objects.
    expect(PUBLIC_IP_ADDRESS_CACHE).toBe(IP_ADDRESS_CACHE);
    expect(PUBLIC_SEEN_AGGREGATE_REPORT_IDS).toBe(SEEN_AGGREGATE_REPORT_IDS);
    expect(PUBLIC_REVERSE_DNS_MAP).toBe(REVERSE_DNS_MAP);
  });
});

describe('ParserConfig worker state', () => {
  it("drops cache contents and binds the receiving thread's defaults", () => {
    const config = createParserConfig({
      dnsTimeout: 9.5,
      nameservers: ['192.0.2.53'],
    });
    config.ipAddressCache.set('sentinel-ip', ipInfo('sentinel-ip'));
    config.seenAggregateReportIds.set('sentinel-report-id', true);
    config.reverseDnsMap.set('sentinel.example', {
      name: 'Sentinel',
      type: null,
    });

    const restored = parserConfigFromState(
      structuredClone(parserConfigToState(config)),
    );

    expect(parserConfigToState(restored)).toEqual(parserConfigToState(config));
    expect(restored.dnsTimeout).toBe(9.5);
    expect(restored.nameservers).toEqual(['192.0.2.53']);
    expect(restored.ipAddressCache).toBe(IP_ADDRESS_CACHE);
    expect(restored.seenAggregateReportIds).toBe(SEEN_AGGREGATE_REPORT_IDS);
    expect(restored.reverseDnsMap).toBe(REVERSE_DNS_MAP);
    expect(IP_ADDRESS_CACHE.has('sentinel-ip')).toBe(false);
    expect(SEEN_AGGREGATE_REPORT_IDS.has('sentinel-report-id')).toBe(false);
    expect(REVERSE_DNS_MAP.has('sentinel.example')).toBe(false);
  });

  it('defaults options missing from older state', () => {
    const restored = parserConfigFromState({ offline: true, dnsTimeout: 7.5 });
    expect(restored.offline).toBe(true);
    expect(restored.dnsTimeout).toBe(7.5);
    expect(restored.ipDbPath).toBeNull();
    expect(restored.nameservers).toBeNull();
    expect(restored.normalizeTimespanThresholdHours).toBe(24.0);
    expect(restored.ipAddressCache).toBe(IP_ADDRESS_CACHE);
    expect(restored.seenAggregateReportIds).toBe(SEEN_AGGREGATE_REPORT_IDS);
    expect(restored.reverseDnsMap).toBe(REVERSE_DNS_MAP);
  });
});

describe('ParserConfig immutability', () => {
  it('is frozen and replace shares caches', () => {
    const config = createParserConfig();
    expect(() => {
      (config as { offline: boolean }).offline = true;
    }).toThrow(TypeError);

    const variant = replaceParserConfig(config, { offline: true });
    expect(variant.offline).toBe(true);
    expect(config.offline).toBe(false);
    expect(variant.ipAddressCache).toBe(config.ipAddressCache);
    expect(variant.seenAggregateReportIds).toBe(config.seenAggregateReportIds);
    expect(variant.reverseDnsMap).toBe(config.reverseDnsMap);
  });

  it('freezes the nameserver list', () => {
    const config = createParserConfig({ nameservers: ['1.1.1.1'] });
    expect(() => (config.nameservers as string[]).push('8.8.8.8')).toThrow(
      TypeError,
    );
  });
});

describe('ExpiringDict', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires entries after maxAgeSeconds', () => {
    vi.useFakeTimers();
    const cache = new ExpiringDict<string, number>({
      maxLen: 10,
      maxAgeSeconds: 60,
    });
    cache.set('a', 1);
    vi.advanceTimersByTime(59_000);
    expect(cache.get('a')).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('drops the oldest entry when full', () => {
    const cache = new ExpiringDict<string, number>({
      maxLen: 2,
      maxAgeSeconds: 60,
    });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect([...cache.keys()]).toEqual(['b', 'c']);
    cache.set('b', 20);
    expect([...cache.keys()]).toEqual(['c', 'b']);
    expect(cache.get('b')).toBe(20);
  });

  it('releases expired entries on set, without a full cache', () => {
    vi.useFakeTimers();
    const cache = new ExpiringDict<string, number>({
      maxLen: 100,
      maxAgeSeconds: 60,
    });
    const has = (key: string): boolean =>
      (cache as unknown as { entries: Map<string, unknown> }).entries.has(key);
    cache.set('a', 1);
    cache.set('b', 2);
    vi.advanceTimersByTime(30_000);
    // Rewriting an entry restarts its clock, so it must leave the front of
    // the queue: entries older than it still expire first.
    cache.set('a', 10);
    vi.advanceTimersByTime(30_000);
    cache.set('c', 3);
    expect(has('b')).toBe(false);
    expect(has('a')).toBe(true);
    vi.advanceTimersByTime(30_000);
    cache.set('d', 4);
    expect(has('a')).toBe(false);
    expect(has('c')).toBe(true);
  });

  it('rejects invalid limits', () => {
    expect(() => new ExpiringDict({ maxLen: 0, maxAgeSeconds: 1 })).toThrow(
      RangeError,
    );
    expect(() => new ExpiringDict({ maxLen: 1, maxAgeSeconds: -1 })).toThrow(
      RangeError,
    );
  });
});
