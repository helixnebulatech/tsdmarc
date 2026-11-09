// IP address enrichment, ported from parsedmarc/utils.py: the IP database
// (`load_ip_db`, `_get_ip_database_path`, `get_ip_address_db_record`,
// `get_ip_address_country`), the IPinfo Lite API (`configure_ipinfo_api`,
// `_ipinfo_api_lookup`, `_normalize_ip_record`), the reverse DNS map
// (`load_reverse_dns_map`, `get_service_from_reverse_dns_base_domain`) and
// `get_ip_address_info`.

import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Reader, type Response as MmdbResponse } from 'maxmind';

import type { IPAddressCache, ParserConfig } from '../config';
import {
  DEFAULT_DNS_MAX_RETRIES,
  DEFAULT_DNS_TIMEOUT,
  USER_AGENT,
} from '../constants';
import { InvalidIPinfoAPIKey, IPDatabaseError } from '../errors';
import { getLogger, logger } from '../log';
import type { IPAddressInfo, ReverseDNSMap, ReverseDNSService } from '../types';
import { readCsvDicts, type CsvDictRow } from './csv-reader';
import { getReverseDns } from './dns';
import { NoAnswer, NXDOMAIN, type DNSException } from './dns-errors';
import { getBaseDomain, loadPslOverrides } from './domains';
import {
  describeHttpError,
  HTTPError,
  httpGet,
  InvalidURL,
  redactUrl,
} from './http';
import { numericHost } from './numeric-host';
import { pyStrip } from './py-str';
import { getBundledIpDbPath, getResourcePath } from './resources';

const DEFAULT_IP_DB_URL =
  'https://github.com/domainaware/parsedmarc/raw/refs/heads/master/parsedmarc/resources/ipinfo/ipinfo_lite.mmdb';
const DEFAULT_REVERSE_DNS_MAP_URL =
  'https://raw.githubusercontent.com/domainaware/parsedmarc/master/parsedmarc/resources/maps/base_reverse_dns_map.csv';

const DOWNLOAD_TIMEOUT_SECONDS = 60;
const MAX_IP_DB_BYTES = 512 * 1024 * 1024;
const MAX_REVERSE_DNS_MAP_BYTES = 64 * 1024 * 1024;
const MAX_IPINFO_RESPONSE_BYTES = 1024 * 1024;
const CACHE_DIRECTORY_NAME = 'tsdmarc';
const IP_DB_FILE_NAME = 'ipinfo_lite.mmdb';
const UNIVERSAL_NEWLINE = /\r\n?/gu;
const IP_DB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Module-level state the loaders write (parsedmarc's `_IP_DB_PATH`,
 * `_LAST_LOGGED_IP_DB_PATH` and `_IPINFO_API_TOKEN` globals). Exposed so a
 * CLI can snapshot and restore it around a configuration reload.
 */
export interface IpInfoState {
  /** The database selected by `loadIpDb()` (downloaded, cached or bundled). */
  ipDbPath: string | null;
  /** The last database path logged, so the selection is logged when it changes. */
  lastLoggedIpDbPath: string | null;
  /** IPinfo Lite API token; `null` disables the API. */
  ipinfoApiToken: string | null;
}

export const ipInfoState: IpInfoState = {
  ipDbPath: null,
  lastLoggedIpDbPath: null,
  ipinfoApiToken: null,
};

/** The IPinfo Lite REST API. Authentication uses the documented `?token=` query parameter. */
export const IPINFO_API_URL = 'https://api.ipinfo.io/lite';
/** IPinfo API request timeout, in seconds. */
export const IPINFO_API_TIMEOUT = 5.0;

/** Country and ASN fields of an IP address. */
export interface IPDatabaseRecord {
  country: string | null;
  asn: number | null;
  asName: string | null;
  asDomain: string | null;
}

export interface LoadIpDbOptions {
  /** Always use a local/bundled database file. */
  alwaysUseLocalFile?: boolean;
  /** Path to a local MMDB file. */
  localFilePath?: string | null;
  /** URL to the MMDB database file. */
  url?: string | null;
  /** Do not make online requests. */
  offline?: boolean;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * The per-user directory downloads are cached in: `$XDG_CACHE_HOME/tsdmarc`
 * or `~/.cache/tsdmarc` (`%LOCALAPPDATA%\tsdmarc` on Windows), falling back
 * to `<tmpdir>/tsdmarc-<uid>`. parsedmarc uses a shared
 * `<tmpdir>/parsedmarc`, where another local user could plant the file or a
 * symlink.
 */
function cacheDirectory(): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  if (xdgCacheHome && path.isAbsolute(xdgCacheHome)) {
    return path.join(xdgCacheHome, CACHE_DIRECTORY_NAME);
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, CACHE_DIRECTORY_NAME);
  }
  let home = '';
  try {
    home = os.homedir();
  } catch {
    // No home directory (some service accounts): use the temp fallback.
  }
  if (home) {
    return path.join(home, '.cache', CACHE_DIRECTORY_NAME);
  }
  const uid = process.getuid?.() ?? 'user';
  return path.join(os.tmpdir(), `${CACHE_DIRECTORY_NAME}-${uid}`);
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const GROUP_OTHER_BITS = 0o077;

/**
 * Throws unless `directory` is a real directory (not a symlink) owned by
 * this user and closed to group/others. Fixes the mode of our own
 * directory when it is too open.
 */
async function checkCacheDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory()) {
    throw new Error(`Cache path is not a directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    return; // Windows: no POSIX owner/mode to check.
  }
  if (info.uid !== uid) {
    throw new Error(`Cache directory is owned by another user: ${directory}`);
  }
  if ((info.mode & GROUP_OTHER_BITS) !== 0) {
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
  }
}

/** The cache directory, created private and checked. */
async function ensureCacheDirectory(): Promise<string> {
  const directory = cacheDirectory();
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await checkCacheDirectory(directory);
  return directory;
}

/** A cached file, only from a directory that passes the checks. */
async function existingCachedFile(fileName: string): Promise<string | null> {
  const directory = cacheDirectory();
  try {
    await checkCacheDirectory(directory);
  } catch {
    return null;
  }
  const filePath = path.join(directory, fileName);
  return isFile(filePath) ? filePath : null;
}

/** Write `data` to `filePath` through a fresh, uniquely named temp file. */
async function writeFileAtomically(
  filePath: string,
  data: Uint8Array,
): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, data, { flag: 'wx', mode: 0o600 });
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

/** Throws unless `body` opens as a MMDB database. */
function assertValidIpDb(body: Uint8Array): void {
  try {
    const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    new Reader<MmdbResponse>(buffer);
  } catch (error) {
    throw new Error(
      `Downloaded file is not a valid MMDB database: ${(error as Error).message}`,
    );
  }
}

/**
 * Downloads the IP-to-country MMDB database from a URL and caches it
 * locally. An existing `localFilePath` is used as-is, with no download. On
 * download failure (or when offline), a previously cached download is used
 * if available, falling back to the bundled copy from `@tsdmarc/ipinfo-lite`.
 * A download that isn't a MMDB database counts as a failure: parsedmarc
 * saves it over the cached copy, and every lookup fails from then on.
 */
export async function loadIpDb(options: LoadIpDbOptions = {}): Promise<void> {
  const url = options.url ?? DEFAULT_IP_DB_URL;
  const localFilePath = options.localFilePath ?? null;

  if (localFilePath !== null && isFile(localFilePath)) {
    ipInfoState.ipDbPath = localFilePath;
    logger.info(`Using local IP database at ${localFilePath}`);
    return;
  }

  if (!(options.offline || options.alwaysUseLocalFile)) {
    try {
      logger.debug(`Trying to fetch IP database from ${redactUrl(url)}...`);
      const response = await httpGet(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: DOWNLOAD_TIMEOUT_SECONDS,
        maxBytes: MAX_IP_DB_BYTES,
      });
      response.raiseForStatus();
      assertValidIpDb(response.body);
      const cachedPath = path.join(
        await ensureCacheDirectory(),
        IP_DB_FILE_NAME,
      );
      await writeFileAtomically(cachedPath, response.body);
      ipInfoState.ipDbPath = cachedPath;
      logger.info('IP database updated successfully');
      return;
    } catch (error) {
      if (error instanceof HTTPError || error instanceof InvalidURL) {
        logger.warning(
          `Failed to fetch IP database: ${describeHttpError(error)}`,
        );
      } else {
        logger.warning(
          `Failed to save IP database: ${(error as Error).message}`,
        );
      }
    }
  }

  // Fall back to a previously cached copy if available
  const cachedPath = await existingCachedFile(IP_DB_FILE_NAME);
  if (cachedPath !== null) {
    ipInfoState.ipDbPath = cachedPath;
    logger.info('Using cached IP database');
    return;
  }

  // Final fallback: bundled copy
  const bundledPath = await getBundledIpDbPath();
  if (bundledPath === null) {
    logger.warning(
      'No bundled IP database found; install @tsdmarc/ipinfo-lite or set ip_db_path',
    );
    return;
  }
  ipInfoState.ipDbPath = bundledPath;
  logger.info('Using bundled IP database');
}

/**
 * Configure the IPinfo Lite REST API as the primary source for IP lookups.
 *
 * With a token, `getIpAddressDbRecord()` queries the API first and falls
 * back to the MMDB on network errors or non-2xx responses. An invalid token
 * raises `InvalidIPinfoAPIKey`.
 *
 * With `probe` (the default), the token is verified by looking up
 * `1.1.1.1`: a 401/403 raises `InvalidIPinfoAPIKey`; other errors are
 * logged and the token is still accepted so per-request fallback can take
 * over.
 */
export async function configureIpinfoApi(
  token: string | null,
  options: { probe?: boolean } = {},
): Promise<void> {
  ipInfoState.ipinfoApiToken = token || null;

  if (!ipInfoState.ipinfoApiToken || options.probe === false) {
    return;
  }

  // ipinfoApiLookup() raises InvalidIPinfoAPIKey on 401/403 (which must
  // propagate) and returns null on any other failure.
  if ((await ipinfoApiLookup('1.1.1.1')) === null) {
    logger.warning('IPinfo API probe failed (will fall back per-request)');
  } else {
    logger.info('IPinfo API configured');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Look up an IP via the IPinfo Lite REST API. Returns `null` when no token
 * is configured, on network error, on a malformed response body, or on any
 * non-2xx response other than 401/403, which raise `InvalidIPinfoAPIKey`.
 */
export async function ipinfoApiLookup(
  ipAddress: string,
): Promise<IPDatabaseRecord | null> {
  const token = ipInfoState.ipinfoApiToken;
  if (!token) {
    return null;
  }

  const url = `${IPINFO_API_URL}/${encodeURIComponent(ipAddress)}`;
  let response: Awaited<ReturnType<typeof httpGet>>;
  try {
    response = await httpGet(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      params: { token },
      timeout: IPINFO_API_TIMEOUT,
      maxBytes: MAX_IPINFO_RESPONSE_BYTES,
    });
  } catch (error) {
    if (!(error instanceof HTTPError)) {
      throw error;
    }
    logger.debug(
      `IPinfo API request for ${ipAddress} failed: ${error.message}`,
    );
    return null;
  }

  if (response.status === 401 || response.status === 403) {
    throw new InvalidIPinfoAPIKey(
      `IPinfo API rejected the configured token (HTTP ${response.status})`,
    );
  }
  if (!response.isSuccess) {
    logger.debug(
      `IPinfo API returned HTTP ${response.status} for ${ipAddress}`,
    );
    return null;
  }

  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    logger.debug(`IPinfo API returned non-JSON for ${ipAddress}`);
    return null;
  }
  if (!isPlainObject(payload)) {
    return null;
  }

  return normalizeIpRecord(payload);
}

// Python's str.isdigit() also accepts non-ASCII digits; real ASNs are ASCII.
const ASN_DIGITS_RE = /^[0-9]+$/u;

function isPyInt(value: unknown): value is number {
  // Python's isinstance(x, int): JSON/MMDB integers (bool is not expected here).
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Normalize an IPinfo / MaxMind / DBIP record to the internal shape: country
 * as ISO code, ASN as a plain number, AS name, AS domain lowercased.
 */
export function normalizeIpRecord(
  record: Record<string, unknown>,
): IPDatabaseRecord {
  let country: string | null = null;
  let asn: number | null = null;
  let asName: string | null = null;
  let asDomain: string | null = null;

  let code = record.country_code;
  if (code === undefined || code === null) {
    const nested = record.country;
    if (isPlainObject(nested)) {
      code = nested.iso_code;
    }
  }
  if (typeof code === 'string') {
    country = code;
  }

  const rawAsn = record.asn;
  if (isPyInt(rawAsn)) {
    asn = rawAsn;
  } else if (typeof rawAsn === 'string' && rawAsn) {
    let digits = rawAsn;
    if (digits.startsWith('AS')) {
      digits = digits.slice(2);
    }
    if (digits.startsWith('as')) {
      digits = digits.slice(2);
    }
    if (ASN_DIGITS_RE.test(digits)) {
      asn = Number(digits);
    }
  }
  if (asn === null) {
    const mmAsn = record.autonomous_system_number;
    if (isPyInt(mmAsn)) {
      asn = mmAsn;
    }
  }

  const name = record.as_name || record.autonomous_system_organization;
  if (typeof name === 'string' && name) {
    asName = name;
  }
  const domain = record.as_domain;
  if (typeof domain === 'string' && domain) {
    asDomain = domain.toLowerCase();
  }

  return { country, asn, asName, asDomain };
}

// Last-resort fallbacks for unusual installs where the bundled database is
// missing. Country-only databases (GeoLite2 / DBIP) lack the ASN fields
// source attribution depends on, so an incidental system GeoIP file must
// never shadow the managed database
// (https://github.com/domainaware/parsedmarc/issues/810). To use MaxMind or
// DBIP data deliberately, set the ip_db_path option.
const SYSTEM_DB_PATHS: readonly string[] = [
  'ipinfo_lite.mmdb',
  'GeoLite2-Country.mmdb',
  '/usr/local/share/GeoIP/GeoLite2-Country.mmdb',
  '/usr/share/GeoIP/GeoLite2-Country.mmdb',
  '/var/lib/GeoIP/GeoLite2-Country.mmdb',
  '/var/local/lib/GeoIP/GeoLite2-Country.mmdb',
  '/usr/local/var/GeoIP/GeoLite2-Country.mmdb',
  '%SystemDrive%\\ProgramData\\MaxMind\\GeoIPUpdate\\GeoIP\\GeoLite2-Country.mmdb',
  'C:\\GeoIP\\GeoLite2-Country.mmdb',
  'dbip-country-lite.mmdb',
  'dbip-country.mmdb',
];

const MISSING_BUNDLED_DB = path.join(
  'node_modules',
  '@tsdmarc',
  'ipinfo-lite',
  'data',
  IP_DB_FILE_NAME,
);

/** Select the database file for a lookup (parsedmarc's `_get_ip_database_path`). */
export async function getIpDatabasePath(
  dbPath: string | null,
): Promise<string> {
  let selected = dbPath;
  if (selected !== null && !isFile(selected)) {
    logger.warning(
      `No file exists at ${selected}. Falling back to an ` +
        'included copy of the IPinfo IP to Country ' +
        'Lite database.',
    );
    selected = null;
  }

  // The managed database takes precedence: the one selected by loadIpDb()
  // (downloaded, cached, or bundled), or the bundled copy directly for
  // library callers that never call loadIpDb().
  if (selected === null && ipInfoState.ipDbPath !== null) {
    selected = ipInfoState.ipDbPath;
  }

  if (selected === null) {
    const bundledPath =
      (await getBundledIpDbPath()) ?? path.resolve(MISSING_BUNDLED_DB);
    if (isFile(bundledPath)) {
      selected = bundledPath;
    } else {
      // Nothing found anywhere: keep the bundled path so the stat() below
      // throws an ENOENT error naming the expected install location.
      selected =
        SYSTEM_DB_PATHS.find(systemPath => existsSync(systemPath)) ??
        bundledPath;
    }
  }

  if (selected !== ipInfoState.lastLoggedIpDbPath) {
    // Log per selected path, not per lookup: this runs on every uncached
    // IP lookup and would flood debug output.
    logger.debug(`Using IP database at ${selected}`);
    ipInfoState.lastLoggedIpDbPath = selected;
  }

  const { mtimeMs } = await stat(selected);
  if (Date.now() - mtimeMs > IP_DB_MAX_AGE_MS) {
    logger.warning('IP database is more than a month old');
  }

  return selected;
}

interface OpenReader {
  path: string;
  mtimeMs: number;
  size: number;
  reader: Reader<MmdbResponse>;
}

// parsedmarc opens the database on every lookup; reading a 25 MB file per
// IP is too slow here, so the open reader is reused while the file is
// unchanged.
let openReader: OpenReader | null = null;

// The last file that failed to open: without this, every lookup would read
// it again and warn again.
let unreadableDb: Omit<OpenReader, 'reader'> | null = null;

/** The reader of a database file, or `null` when it can't be opened. */
async function getReader(dbPath: string): Promise<Reader<MmdbResponse> | null> {
  const { mtimeMs, size } = await stat(dbPath);
  if (
    openReader !== null &&
    openReader.path === dbPath &&
    openReader.mtimeMs === mtimeMs &&
    openReader.size === size
  ) {
    return openReader.reader;
  }
  if (
    unreadableDb !== null &&
    unreadableDb.path === dbPath &&
    unreadableDb.mtimeMs === mtimeMs &&
    unreadableDb.size === size
  ) {
    return null;
  }
  try {
    const reader = new Reader<MmdbResponse>(await readFile(dbPath));
    openReader = { path: dbPath, mtimeMs, size, reader };
    return reader;
  } catch (error) {
    unreadableDb = { path: dbPath, mtimeMs, size };
    logger.warning(
      `Could not open IP database ${dbPath}: ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * The reader for a lookup: the selected database, else the cached download,
 * else the bundled copy. parsedmarc raises from the lookup, which its
 * per-record handler turns into a report without those records.
 */
async function openIpDatabase(
  dbPath: string | null,
): Promise<Reader<MmdbResponse>> {
  let selected: string;
  try {
    selected = await getIpDatabasePath(dbPath);
  } catch (error) {
    throw new IPDatabaseError((error as Error).message, {
      cause: error,
      code: (error as NodeJS.ErrnoException).code,
    });
  }
  const reader = await getReader(selected);
  if (reader !== null) {
    return reader;
  }
  const fallbacks = [
    await existingCachedFile(IP_DB_FILE_NAME),
    await getBundledIpDbPath(),
  ];
  for (const fallback of fallbacks) {
    if (fallback !== null && fallback !== selected && isFile(fallback)) {
      // oxlint-disable-next-line no-await-in-loop -- tried in order
      const fallbackReader = await getReader(fallback);
      if (fallbackReader !== null) {
        return fallbackReader;
      }
    }
  }
  throw new IPDatabaseError(
    `No usable IP database: could not open ${selected}`,
  );
}

/**
 * Look up an IP and return country and ASN fields.
 *
 * If the IPinfo Lite API is configured (`configureIpinfoApi()`), it is
 * queried first; any non-fatal failure falls through to the MMDB. An
 * invalid API token raises `InvalidIPinfoAPIKey`. MaxMind/DBIP
 * country-only databases carry only the country, so the ASN fields come
 * back `null` for them.
 */
export async function getIpAddressDbRecord(
  ipAddress: string,
  options: { dbPath?: string | null; skipApi?: boolean } = {},
): Promise<IPDatabaseRecord> {
  // parsedmarc only finds out in the MMDB lookup, after asking the API: a
  // sender's source_ip of `me` returns the data of this host's own network.
  const address = numericHost(ipAddress);
  const apiRecord = options.skipApi ? null : await ipinfoApiLookup(ipAddress);
  if (apiRecord !== null) {
    return apiRecord;
  }

  const reader = await openIpDatabase(options.dbPath ?? null);
  const record: unknown = reader.get(address);
  if (!isPlainObject(record)) {
    return { country: null, asn: null, asName: null, asDomain: null };
  }
  return normalizeIpRecord(record);
}

/**
 * The ISO code of the country of an IPv4 or IPv6 address, or `null` when
 * unknown. `dbPath` is a MMDB file from IPinfo, MaxMind or DBIP.
 */
export async function getIpAddressCountry(
  ipAddress: string,
  options: { dbPath?: string | null } = {},
): Promise<string | null> {
  return (await getIpAddressDbRecord(ipAddress, options)).country;
}

export interface LoadReverseDnsMapOptions {
  /** Always use a local map file. */
  alwaysUseLocalFile?: boolean;
  /** Path to a local map file. */
  localFilePath?: string | null;
  /** URL to a reverse DNS map. */
  url?: string | null;
  /** Do not make online requests. */
  offline?: boolean;
  /** Path to a local PSL overrides file. */
  pslOverridesPath?: string | null;
  /** URL to a PSL overrides file. */
  pslOverridesUrl?: string | null;
}

function requiredField(row: CsvDictRow, key: string): string {
  if (!row.has(key)) {
    throw new Error(`KeyError: '${key}'`);
  }
  const value = row.get(key);
  if (typeof value !== 'string') {
    throw new TypeError(`'NoneType' object has no attribute 'strip'`);
  }
  return value;
}

function loadCsv(reverseDnsMap: ReverseDNSMap, text: string): void {
  for (const row of readCsvDicts(text)) {
    const key = pyStrip(requiredField(row, 'base_reverse_dns').toLowerCase());
    reverseDnsMap.set(key, {
      name: pyStrip(requiredField(row, 'name')),
      type: pyStrip(requiredField(row, 'type')),
    });
  }
}

/**
 * Loads the reverse DNS map from a URL or local file.
 *
 * Repopulates the given map in place. The URL is tried first; on
 * failure (or when `offline` / `alwaysUseLocalFile` is set) the local path
 * is used, defaulting to the bundled CSV. The PSL overrides are reloaded
 * first with the same flags, so map entries that depend on a folded base
 * domain resolve against the current overrides.
 *
 * parsedmarc clears the map before downloading; here the new entries are
 * built aside and swapped in at once, so concurrent lookups never see a
 * half-loaded map (and never cache results computed from it). Concurrent
 * loads of the same map share one download.
 */
export function loadReverseDnsMap(
  reverseDnsMap: ReverseDNSMap,
  options: LoadReverseDnsMapOptions = {},
): Promise<void> {
  const running = reverseDnsMapLoads.get(reverseDnsMap);
  if (running !== undefined) {
    return running;
  }
  const load = fetchReverseDnsMap(reverseDnsMap, options).finally(() => {
    reverseDnsMapLoads.delete(reverseDnsMap);
  });
  reverseDnsMapLoads.set(reverseDnsMap, load);
  return load;
}

const reverseDnsMapLoads = new WeakMap<ReverseDNSMap, Promise<void>>();

async function fetchReverseDnsMap(
  reverseDnsMap: ReverseDNSMap,
  options: LoadReverseDnsMapOptions,
): Promise<void> {
  const alwaysUseLocalFile = options.alwaysUseLocalFile ?? false;
  const offline = options.offline ?? false;
  await loadPslOverrides({
    alwaysUseLocalFile,
    localFilePath: options.pslOverridesPath ?? null,
    url: options.pslOverridesUrl ?? null,
    offline,
  });

  const url = options.url ?? DEFAULT_REVERSE_DNS_MAP_URL;

  const loaded: ReverseDNSMap = new Map();
  try {
    if (!(offline || alwaysUseLocalFile)) {
      let body = '';
      try {
        logger.debug(
          `Trying to fetch reverse DNS map from ${redactUrl(url)}...`,
        );
        const response = await httpGet(url, {
          headers: { 'User-Agent': USER_AGENT },
          timeout: DOWNLOAD_TIMEOUT_SECONDS,
          maxBytes: MAX_REVERSE_DNS_MAP_BYTES,
        });
        response.raiseForStatus();
        body = response.text();
        loadCsv(loaded, body);
      } catch (error) {
        if (error instanceof HTTPError || error instanceof InvalidURL) {
          logger.warning(
            `Failed to fetch reverse DNS map: ${describeHttpError(error)}`,
          );
        } else {
          logger.warning('Not a valid CSV file');
          // parsedmarc logs this line through the root logger.
          getLogger('root').debug('Response body:');
          logger.debug(body);
        }
      }
    }

    if (loaded.size === 0) {
      logger.info('Loading included reverse DNS map...');
      const filePath =
        options.localFilePath ?? getResourcePath('base_reverse_dns_map.csv');
      // Python's text-mode open() translates \r\n and \r to \n (universal
      // newlines); the downloaded text goes to csv untranslated.
      const text = await readFile(filePath, 'utf8');
      loadCsv(loaded, text.replaceAll(UNIVERSAL_NEWLINE, '\n'));
    }
  } finally {
    // Swap synchronously, keeping what was loaded even when a bad local
    // file throws part-way (Python fills the map in place).
    reverseDnsMap.clear();
    for (const [key, value] of loaded) {
      reverseDnsMap.set(key, value);
    }
  }
}

export interface GetServiceOptions extends LoadReverseDnsMapOptions {
  /** A reverse DNS map; loaded into when empty. */
  reverseDnsMap?: ReverseDNSMap | null;
}

/**
 * The service of a base domain from reverse DNS. Unknown services have the
 * base domain as name and a `null` type.
 */
export async function getServiceFromReverseDnsBaseDomain(
  baseDomain: string,
  options: GetServiceOptions = {},
): Promise<ReverseDNSService> {
  const key = pyStrip(baseDomain.toLowerCase());
  const reverseDnsMap =
    options.reverseDnsMap ?? new Map<string, ReverseDNSService>();

  if (reverseDnsMap.size === 0) {
    await loadReverseDnsMap(reverseDnsMap, {
      alwaysUseLocalFile: options.alwaysUseLocalFile ?? false,
      localFilePath: options.localFilePath ?? null,
      url: options.url ?? null,
      offline: options.offline ?? false,
      pslOverridesPath: options.pslOverridesPath ?? null,
      pslOverridesUrl: options.pslOverridesUrl ?? null,
    });
  }

  return reverseDnsMap.get(key) ?? { name: key, type: null };
}

/**
 * The network lookups one aggregate report may still make. parsedmarc has no
 * such limit: records are resolved one at a time, a failed lookup takes
 * seconds, and a sender choosing addresses that fail can hold a small
 * report for days. Past a limit the report keeps all its records, without
 * reverse DNS.
 */
export class ReportLookupBudget {
  private readonly maxLookups: number;
  private readonly maxFailures: number;
  private readonly maxTimeMs: number;
  private lookups = 0;
  private failures = 0;
  private spentMs = 0;
  private warned = false;
  /**
   * What this report's lookups found for IPs the shared cache doesn't keep
   * (no PTR record, ASN not in the map): a repeated address costs one
   * lookup per report, not one per record.
   */
  private readonly uncached = new Map<string, IPAddressInfo>();

  constructor(config: ParserConfig) {
    this.maxLookups = config.maxLookupsPerReport;
    this.maxFailures = config.maxFailedLookupsPerReport;
    this.maxTimeMs = config.maxLookupTimePerReport * 1000;
  }

  /** Whether one more IP may use the network; counts it if so. */
  take(): boolean {
    const exhausted =
      (this.maxLookups > 0 && this.lookups >= this.maxLookups) ||
      (this.maxFailures > 0 && this.failures >= this.maxFailures) ||
      (this.maxTimeMs > 0 && this.spentMs >= this.maxTimeMs);
    if (!exhausted) {
      this.lookups += 1;
      return true;
    }
    if (!this.warned) {
      this.warned = true;
      logger.warning(
        `Report reached its limit of network lookups (${this.lookups} made, ${this.failures} failed, ${Math.round(this.spentMs / 1000)} s): ` +
          'the remaining source IPs get no reverse DNS',
      );
    }
    return false;
  }

  /** Count the time of a lookup against the report. */
  charge(elapsedMs: number): void {
    this.spentMs += elapsedMs;
  }

  /** What an earlier record of this report found for `ipAddress`. */
  recall(ipAddress: string): IPAddressInfo | undefined {
    return this.uncached.get(ipAddress);
  }

  /** Keep what was found for an IP the shared cache doesn't keep. */
  remember(info: IPAddressInfo): void {
    this.uncached.set(info.ipAddress, info);
  }

  /** Count a DNS error, unless it is a real answer that there is no PTR. */
  recordError(error: DNSException): void {
    if (!(error instanceof NXDOMAIN || error instanceof NoAnswer)) {
      this.failures += 1;
    }
  }
}

export interface GetIpAddressInfoOptions {
  /**
   * Take every option below from this config (its IP address cache,
   * reverse DNS map, DNS settings, ...), the way parsedmarc's parsers call
   * `get_ip_address_info()`. Options given alongside it are ignored.
   */
  config?: ParserConfig | null;
  /** Limits on the network lookups of the report this IP comes from. */
  lookupBudget?: ReportLookupBudget | null;
  /** Path to a MMDB file from IPinfo, MaxMind, or DBIP. */
  ipDbPath?: string | null;
  /** Path to a reverse DNS map file. */
  reverseDnsMapPath?: string | null;
  /** Do not download files. */
  alwaysUseLocalFiles?: boolean;
  /** URL to the reverse DNS map file. */
  reverseDnsMapUrl?: string | null;
  /** Cache storage. */
  cache?: IPAddressCache | null;
  /** A reverse DNS map. */
  reverseDnsMap?: ReverseDNSMap | null;
  /** Do not make online queries for geolocation or DNS. */
  offline?: boolean;
  /** Nameservers to use (Cloudflare's public DNS resolvers by default). */
  nameservers?: readonly string[] | null;
  /** DNS timeout, in seconds. */
  timeout?: number;
  /** Times to retry on timeout or other transient DNS errors. */
  retries?: number;
  /** Path to a local PSL overrides file. */
  pslOverridesPath?: string | null;
  /** URL to a PSL overrides file. */
  pslOverridesUrl?: string | null;
}

/** The `getIpAddressInfo()` options parsedmarc's parsers pass from a config. */
function optionsFromConfig(config: ParserConfig): GetIpAddressInfoOptions {
  return {
    cache: config.ipAddressCache,
    ipDbPath: config.ipDbPath,
    alwaysUseLocalFiles: config.alwaysUseLocalFiles,
    reverseDnsMapPath: config.reverseDnsMapPath,
    reverseDnsMapUrl: config.reverseDnsMapUrl,
    reverseDnsMap: config.reverseDnsMap,
    offline: config.offline,
    nameservers: config.nameservers,
    timeout: config.dnsTimeout,
    retries: config.dnsRetries,
    pslOverridesPath: config.pslOverridesPath,
    pslOverridesUrl: config.pslOverridesUrl,
  };
}

/**
 * Reverse DNS, country, ASN, and service information for an IP address.
 */
export async function getIpAddressInfo(
  ip: string,
  input: GetIpAddressInfoOptions = {},
): Promise<IPAddressInfo> {
  const options = input.config ? optionsFromConfig(input.config) : input;
  const ipAddress = ip.toLowerCase();
  // Before the logs and lookups below: `ip` comes from the report's sender.
  numericHost(ipAddress);
  const cache = options.cache ?? null;
  const offline = options.offline ?? false;
  const alwaysUseLocalFiles = options.alwaysUseLocalFiles ?? false;
  if (cache !== null) {
    const cachedInfo = cache.get(ipAddress);
    if (cachedInfo && isPlainObject(cachedInfo) && 'ipAddress' in cachedInfo) {
      logger.debug(`IP address ${ipAddress} was found in cache`);
      return cachedInfo;
    }
  }
  const info: IPAddressInfo = {
    ipAddress,
    reverseDns: null,
    country: null,
    baseDomain: null,
    name: null,
    type: null,
    asn: null,
    asName: null,
    asDomain: null,
  };
  const lookupBudget = input.lookupBudget ?? null;
  const recalled = lookupBudget?.recall(ipAddress);
  if (recalled !== undefined) {
    return { ...recalled };
  }
  const useNetwork = lookupBudget?.take() ?? true;
  const lookupStart = performance.now();
  let reverseDns: string | null = null;
  if (!offline && useNetwork) {
    reverseDns = await getReverseDns(ipAddress, {
      nameservers: options.nameservers ?? null,
      timeout: options.timeout ?? DEFAULT_DNS_TIMEOUT,
      retries: options.retries ?? DEFAULT_DNS_MAX_RETRIES,
      onError: error => lookupBudget?.recordError(error),
    });
  }
  const dbRecord = await getIpAddressDbRecord(ipAddress, {
    dbPath: options.ipDbPath ?? null,
    skipApi: !useNetwork,
  });
  if (useNetwork) {
    lookupBudget?.charge(performance.now() - lookupStart);
  }
  info.country = dbRecord.country;
  info.asn = dbRecord.asn;
  info.asName = dbRecord.asName;
  info.asDomain = dbRecord.asDomain;
  info.reverseDns = reverseDns;

  const mapOptions: LoadReverseDnsMapOptions = {
    alwaysUseLocalFile: alwaysUseLocalFiles,
    localFilePath: options.reverseDnsMapPath ?? null,
    url: options.reverseDnsMapUrl ?? null,
    offline,
    pslOverridesPath: options.pslOverridesPath ?? null,
    pslOverridesUrl: options.pslOverridesUrl ?? null,
  };

  if (reverseDns === null) {
    logger.debug(`IP address ${ipAddress} reverse_dns not found`);
    // Fall back to ASN data for source attribution. reverseDns and
    // baseDomain stay null so consumers can tell an ASN-derived row apart
    // from one resolved via a real PTR.
    const mapValue =
      options.reverseDnsMap ?? new Map<string, ReverseDNSService>();
    if (mapValue.size === 0) {
      await loadReverseDnsMap(mapValue, mapOptions);
    }
    const service = info.asDomain ? mapValue.get(info.asDomain) : undefined;
    if (service !== undefined) {
      info.name = service.name;
      info.type = service.type;
    } else if (info.asName) {
      // ASN domain not in the map: surface the raw AS name with no
      // classification. Better than leaving the row unattributed.
      info.name = info.asName;
    }
  } else {
    const baseDomain = getBaseDomain(reverseDns);
    if (baseDomain !== null) {
      const service = await getServiceFromReverseDnsBaseDomain(baseDomain, {
        ...mapOptions,
        reverseDnsMap: options.reverseDnsMap ?? null,
      });
      info.baseDomain = baseDomain;
      info.type = service.type;
      info.name = service.name;
    }
  }

  // Don't cache weak-fallback attributions: rows with no PTR whose ASN
  // domain wasn't in the map, so the name is just the raw AS name.
  // getReverseDns() turns every DNS error into null, so a transient PTR
  // failure looks like a real no-PTR case here; caching it would lock in a
  // misattribution for the cache's 4 hours.
  const weakFallback =
    info.reverseDns === null &&
    info.type === null &&
    info.name !== null &&
    info.name === info.asName;
  if (cache !== null && !weakFallback && useNetwork) {
    cache.set(ipAddress, info);
    logger.debug(`IP address ${ipAddress} added to cache`);
  } else if (useNetwork) {
    lookupBudget?.remember({ ...info });
  }

  return info;
}
