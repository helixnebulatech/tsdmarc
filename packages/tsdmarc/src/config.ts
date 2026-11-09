// Centralized parser configuration, ported from parsedmarc/config.py.
//
// `ParserConfig` carries every parsing/enrichment option plus the three
// caches the parser shares across calls: IP address info, seen aggregate
// report IDs and the reverse DNS map.
//
// - `createParserConfig()` builds a config with fresh, isolated caches.
// - `replaceParserConfig()` derives a variant that keeps sharing the source's
//   caches (Python's `dataclasses.replace`).
// - `resolveParserConfig()` is what public parsing functions call: an
//   explicit `config` wins and individual options are ignored; otherwise a
//   config is built from the options, bound to the module-default caches so
//   option-style calls keep sharing warm caches.
// - `parserConfigToState()` / `parserConfigFromState()` move a config to a
//   worker thread. Cache contents never cross: the worker binds its own
//   module-default caches (Python's `__getstate__` / `__setstate__`).

import { DEFAULT_DNS_MAX_RETRIES, DEFAULT_DNS_TIMEOUT } from './constants';
import type { IPAddressInfo, ReverseDNSMap } from './types';

export interface ExpiringDictOptions {
  maxLen: number;
  maxAgeSeconds: number;
}

/**
 * An insertion-ordered map whose entries expire after `maxAgeSeconds` and
 * which drops its oldest entry when full. Port of Python's `ExpiringDict`.
 */
export class ExpiringDict<K, V> {
  readonly maxLen: number;
  readonly maxAgeSeconds: number;
  private readonly entries = new Map<K, { value: V; setAt: number }>();

  constructor(options: ExpiringDictOptions) {
    if (options.maxLen < 1) {
      throw new RangeError('maxLen must be at least 1');
    }
    if (options.maxAgeSeconds < 0) {
      throw new RangeError('maxAgeSeconds must not be negative');
    }
    this.maxLen = options.maxLen;
    this.maxAgeSeconds = options.maxAgeSeconds;
  }

  private isExpired(setAt: number, now: number): boolean {
    return now - setAt >= this.maxAgeSeconds * 1000;
  }

  /**
   * Drop expired entries. Python's `ExpiringDict` only does so for a key
   * being read, so unread entries live as long as the process. Entries are
   * kept in `setAt` order (see `set()`), so the expired ones are at the
   * front and each is visited once.
   */
  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (!this.isExpired(entry.setAt, now)) {
        return;
      }
      this.entries.delete(key);
    }
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined || this.entries.has(key);
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this.isExpired(entry.setAt, Date.now())) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): this {
    this.prune();
    // Rewriting restarts the entry's clock, so it goes to the back.
    const isNew = !this.entries.delete(key);
    if (isNew && this.entries.size >= this.maxLen) {
      const oldest = this.entries.keys().next();
      if (oldest.done !== true) {
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { value, setAt: Date.now() });
    return this;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  *keys(): IterableIterator<K> {
    this.prune();
    yield* [...this.entries.keys()];
  }
}

export type IPAddressCache = ExpiringDict<string, IPAddressInfo>;
export type SeenAggregateReportIds = ExpiringDict<string, boolean>;

/** IP address info cache: 10,000 entries, 4 hour expiry. */
export function newIpAddressCache(): IPAddressCache {
  return new ExpiringDict({ maxLen: 10_000, maxAgeSeconds: 14_400 });
}

/** Seen aggregate report ID cache: 100,000,000 entries, 1 hour expiry. */
export function newSeenAggregateReportIds(): SeenAggregateReportIds {
  return new ExpiringDict({ maxLen: 100_000_000, maxAgeSeconds: 3600 });
}

/** Module-default IP address info cache. */
export const IP_ADDRESS_CACHE: IPAddressCache = newIpAddressCache();
/** Module-default seen aggregate report ID cache. */
export const SEEN_AGGREGATE_REPORT_IDS: SeenAggregateReportIds =
  newSeenAggregateReportIds();
/** Module-default reverse DNS map. */
export const REVERSE_DNS_MAP: ReverseDNSMap = new Map();

/** Parsing and enrichment options (everything except the caches). */
export interface ParserOptions {
  /** Do not make online requests (DNS, IP database, reverse DNS map, PSL overrides). */
  offline: boolean;
  /** Path to a local MMDB file from IPinfo, MaxMind or DBIP. */
  ipDbPath: string | null;
  /** Always use local/bundled files instead of downloading them. */
  alwaysUseLocalFiles: boolean;
  /** Path to a local reverse DNS map file. */
  reverseDnsMapPath: string | null;
  /** URL of a reverse DNS map file. */
  reverseDnsMapUrl: string | null;
  /** Path to a local PSL overrides file. */
  pslOverridesPath: string | null;
  /** URL of a PSL overrides file. */
  pslOverridesUrl: string | null;
  /** Nameservers for DNS queries (`null`: Cloudflare's public resolvers). */
  nameservers: string[] | null;
  /** DNS query timeout, in seconds. */
  dnsTimeout: number;
  /** Times to retry a DNS query after a timeout or other transient error. */
  dnsRetries: number;
  /** Remove attachment payloads from parsed email results. */
  stripAttachmentPayloads: boolean;
  /** Aggregate reports spanning more hours than this are normalized/split. */
  normalizeTimespanThresholdHours: number;
  /**
   * Largest email accepted, in bytes (UTF-8 for text input); `0` disables
   * the check. Larger emails raise `EmailTooLargeError` and mailboxes move
   * them to the invalid folder, without downloading them where the backend
   * reports the size first. Not in parsedmarc. Default: 50 MiB.
   */
  maxEmailSize: number;
  /**
   * Most MIME parts accepted in an email; `0` disables the check. Lines
   * starting with `--` (an upper bound on boundary parts) are counted before
   * parsing, and the parser counts every message it creates, so parts that
   * need no boundary line count too. Not in parsedmarc. Default: 10,000.
   */
  maxMimeParts: number;
  /**
   * Most header lines accepted in an email, over all its parts (folded
   * lines included); `0` disables the check. Not in parsedmarc.
   * Default: 100,000.
   */
  maxHeaderLines: number;
  /**
   * Most text, in characters, that re-serializing the parts of one email
   * may produce; text with a character outside Latin-1 counts each of its
   * characters twice, as it takes twice the memory. Every part is counted
   * once per level it is flattened at, so this bounds size × nesting
   * depth, which `maxEmailSize` does not; `0` disables the check. Not in
   * parsedmarc. Default: 512 MiB.
   */
  maxExpandedEmailSize: number;
  /**
   * Most source IPs of one aggregate report looked up over the network
   * (reverse DNS, IPinfo API); `0` disables the check. Later IPs get no
   * reverse DNS and only the IP database. Cached IPs don't count. Not in
   * parsedmarc. Default: 100,000.
   */
  maxLookupsPerReport: number;
  /**
   * Most reverse DNS lookups of one aggregate report that may time out or
   * fail (an address with no PTR is an answer, not a failure); `0`
   * disables the check. Later IPs are handled as in
   * {@link ParserOptions.maxLookupsPerReport}. A failed lookup can take
   * seconds, and the report's sender can choose addresses that fail. Not
   * in parsedmarc. Default: 256.
   */
  maxFailedLookupsPerReport: number;
  /**
   * Seconds of network lookups (reverse DNS, IPinfo API) one aggregate
   * report may use in total; `0` disables the check. Later IPs are handled
   * as in {@link ParserOptions.maxLookupsPerReport}. An answer that is not a
   * failure can still be slow, and a sender can make every record cost one.
   * Not in parsedmarc. Default: 600.
   */
  maxLookupTimePerReport: number;
  /**
   * Most records an aggregate report may have once its timespan is
   * normalized into daily buckets; `0` disables the check. Sender-chosen
   * dates and counts turn one `<record>` into one record per day, for up to
   * 2.9 million days. A record with few messages only takes as many days as
   * it has messages. Larger reports raise `InvalidAggregateReport`. Not in
   * parsedmarc. Default: 250,000.
   */
  maxNormalizedRecords: number;
  /**
   * Deepest element nesting accepted in an aggregate report's XML; `0`
   * disables the check. Deeper reports raise `InvalidAggregateReport`. Not
   * in parsedmarc. Default: 100,000.
   */
  maxXmlDepth: number;
  /**
   * Most elements and attributes accepted in an aggregate report's XML; `0`
   * disables the check. Larger reports raise `InvalidAggregateReport`. Not
   * in parsedmarc. Default: 5,000,000.
   */
  maxXmlNodes: number;
  /**
   * Largest SMTP TLS report accepted, in bytes of JSON (UTF-16 code units
   * for text input); `0` disables the check. Larger reports raise
   * `InvalidSMTPTLSReport`. Not in parsedmarc. Default: 10 MiB.
   */
  maxSmtpTlsReportSize: number;
  /**
   * Seconds one email or file may take to parse; `0` disables the check. A
   * worker past it is stopped. Without workers (`nProcs` 1) only a mailbox
   * applies it, at the next keepalive (every 20 records), so only time
   * spent awaiting counts. A mailbox leaves such a message for retry and
   * then moves it to the `Unsaved` folder, without ever deleting it. Not
   * in parsedmarc. Default: 1 hour.
   */
  jobTimeout: number;
  /**
   * JavaScript heap limit of each parsing worker thread, in MiB; `0` keeps
   * the runtime's limit (about 4 GiB per worker on 64-bit Node). A worker
   * over it dies and only its job fails: a mailbox leaves the message for
   * retry and then moves it to the `Unsaved` folder, without ever deleting
   * it. Bun ignores it. Not in parsedmarc. Default: 2 GiB.
   */
  maxWorkerHeapMb: number;
}

/** Default {@link ParserOptions.maxEmailSize}: 50 MiB. */
export const DEFAULT_MAX_EMAIL_SIZE: number = 50 * 1024 * 1024;
/** Default {@link ParserOptions.maxMimeParts}. */
export const DEFAULT_MAX_MIME_PARTS = 10_000;
/** Default {@link ParserOptions.maxHeaderLines}. */
export const DEFAULT_MAX_HEADER_LINES = 100_000;
/** Default {@link ParserOptions.maxExpandedEmailSize}: 512 MiB. */
export const DEFAULT_MAX_EXPANDED_EMAIL_SIZE: number = 512 * 1024 * 1024;
/** Default {@link ParserOptions.maxNormalizedRecords}. */
export const DEFAULT_MAX_NORMALIZED_RECORDS = 250_000;
/** Default {@link ParserOptions.maxXmlDepth}. */
export const DEFAULT_MAX_XML_DEPTH = 100_000;
/** Default {@link ParserOptions.maxXmlNodes}. */
export const DEFAULT_MAX_XML_NODES = 5_000_000;
/** Default {@link ParserOptions.maxSmtpTlsReportSize}: 10 MiB. */
export const DEFAULT_MAX_SMTP_TLS_REPORT_SIZE: number = 10 * 1024 * 1024;
/** Default {@link ParserOptions.jobTimeout}: one hour. */
export const DEFAULT_JOB_TIMEOUT = 3600;
/** Default {@link ParserOptions.maxWorkerHeapMb}. */
export const DEFAULT_MAX_WORKER_HEAP_MB = 2048;
/** Default {@link ParserOptions.maxLookupsPerReport}. */
export const DEFAULT_MAX_LOOKUPS_PER_REPORT = 100_000;
/** Default {@link ParserOptions.maxFailedLookupsPerReport}. */
export const DEFAULT_MAX_FAILED_LOOKUPS_PER_REPORT = 256;
/** Default {@link ParserOptions.maxLookupTimePerReport}, in seconds. */
export const DEFAULT_MAX_LOOKUP_TIME_PER_REPORT = 600;

/** The limits on an email's structure, applied while parsing it. */
export type EmailLimits = Pick<
  ParserOptions,
  'maxMimeParts' | 'maxHeaderLines' | 'maxExpandedEmailSize'
>;

/** The default {@link EmailLimits}. */
export const DEFAULT_EMAIL_LIMITS: EmailLimits = Object.freeze({
  maxMimeParts: DEFAULT_MAX_MIME_PARTS,
  maxHeaderLines: DEFAULT_MAX_HEADER_LINES,
  maxExpandedEmailSize: DEFAULT_MAX_EXPANDED_EMAIL_SIZE,
});

export interface ParserCaches {
  ipAddressCache: IPAddressCache;
  /** Seen aggregate reports, keyed on reporter, Report-ID and policy domain (`aggregateReportKey()`). */
  seenAggregateReportIds: SeenAggregateReportIds;
  reverseDnsMap: ReverseDNSMap;
}

/** Immutable parser configuration: options plus shared caches. */
export type ParserConfig = Readonly<ParserOptions & ParserCaches>;

export const DEFAULT_PARSER_OPTIONS: Readonly<ParserOptions> = Object.freeze({
  offline: false,
  ipDbPath: null,
  alwaysUseLocalFiles: false,
  reverseDnsMapPath: null,
  reverseDnsMapUrl: null,
  pslOverridesPath: null,
  pslOverridesUrl: null,
  nameservers: null,
  dnsTimeout: DEFAULT_DNS_TIMEOUT,
  dnsRetries: DEFAULT_DNS_MAX_RETRIES,
  stripAttachmentPayloads: false,
  normalizeTimespanThresholdHours: 24.0,
  maxEmailSize: DEFAULT_MAX_EMAIL_SIZE,
  maxMimeParts: DEFAULT_MAX_MIME_PARTS,
  maxHeaderLines: DEFAULT_MAX_HEADER_LINES,
  maxExpandedEmailSize: DEFAULT_MAX_EXPANDED_EMAIL_SIZE,
  maxLookupsPerReport: DEFAULT_MAX_LOOKUPS_PER_REPORT,
  maxFailedLookupsPerReport: DEFAULT_MAX_FAILED_LOOKUPS_PER_REPORT,
  maxLookupTimePerReport: DEFAULT_MAX_LOOKUP_TIME_PER_REPORT,
  maxNormalizedRecords: DEFAULT_MAX_NORMALIZED_RECORDS,
  maxXmlDepth: DEFAULT_MAX_XML_DEPTH,
  maxXmlNodes: DEFAULT_MAX_XML_NODES,
  maxSmtpTlsReportSize: DEFAULT_MAX_SMTP_TLS_REPORT_SIZE,
  jobTimeout: DEFAULT_JOB_TIMEOUT,
  maxWorkerHeapMb: DEFAULT_MAX_WORKER_HEAP_MB,
});

const OPTION_KEYS = Object.keys(
  DEFAULT_PARSER_OPTIONS,
) as (keyof ParserOptions)[];

function pickOptions(source: Partial<ParserOptions>): Partial<ParserOptions> {
  const picked: Partial<Record<keyof ParserOptions, unknown>> = {};
  for (const key of OPTION_KEYS) {
    if (source[key] !== undefined) {
      picked[key] = source[key];
    }
  }
  return picked as Partial<ParserOptions>;
}

function freezeConfig(
  options: ParserOptions,
  caches: ParserCaches,
): ParserConfig {
  const nameservers =
    options.nameservers === null
      ? null
      : Object.freeze([...options.nameservers]);
  return Object.freeze({
    ...options,
    nameservers: nameservers as string[] | null,
    ...caches,
  });
}

/** Build a config. Caches not given are fresh and isolated. */
export function createParserConfig(
  options: Partial<ParserOptions & ParserCaches> = {},
): ParserConfig {
  return freezeConfig(
    { ...DEFAULT_PARSER_OPTIONS, ...pickOptions(options) },
    {
      ipAddressCache: options.ipAddressCache ?? newIpAddressCache(),
      seenAggregateReportIds:
        options.seenAggregateReportIds ?? newSeenAggregateReportIds(),
      reverseDnsMap: options.reverseDnsMap ?? new Map(),
    },
  );
}

/** Derive a variant of `config` that keeps sharing its caches. */
export function replaceParserConfig(
  config: ParserConfig,
  changes: Partial<ParserOptions & ParserCaches>,
): ParserConfig {
  return createParserConfig({ ...config, ...changes });
}

/** Options accepted by public parsing functions (individual options or `config`). */
export interface ParserConfigInput extends Partial<
  Omit<ParserOptions, 'pslOverridesPath' | 'pslOverridesUrl'>
> {
  /** When given, the individual options are ignored. */
  config?: ParserConfig | null;
}

/**
 * Resolve the config for a public parsing call: `input.config` when given,
 * otherwise a config built from the individual options and bound to the
 * module-default caches. PSL override options are only settable through an
 * explicit `config`. The module-default caches ignore the options, so calls
 * with different `offline`, `nameservers` or `ipDbPath` values, or for
 * different tenants, need a `createParserConfig()` each.
 */
export function resolveParserConfig(
  input: ParserConfigInput = {},
): ParserConfig {
  if (input.config) {
    return input.config;
  }
  const {
    pslOverridesPath: _path,
    pslOverridesUrl: _url,
    ...options
  } = pickOptions(input as Partial<ParserOptions>);
  return createParserConfig({
    ...options,
    ipAddressCache: IP_ADDRESS_CACHE,
    seenAggregateReportIds: SEEN_AGGREGATE_REPORT_IDS,
    reverseDnsMap: REVERSE_DNS_MAP,
  });
}

/** The options of a config, without caches, for sending to a worker. */
export function parserConfigToState(config: ParserConfig): ParserOptions {
  const state = { ...DEFAULT_PARSER_OPTIONS, ...pickOptions(config) };
  return {
    ...state,
    nameservers: state.nameservers === null ? null : [...state.nameservers],
  };
}

/**
 * Rebuild a config from worker state. Missing options take their defaults
 * and the caches bind to this thread's module-default caches.
 */
export function parserConfigFromState(
  state: Partial<ParserOptions>,
): ParserConfig {
  return createParserConfig({
    ...pickOptions(state),
    ipAddressCache: IP_ADDRESS_CACHE,
    seenAggregateReportIds: SEEN_AGGREGATE_REPORT_IDS,
    reverseDnsMap: REVERSE_DNS_MAP,
  });
}
