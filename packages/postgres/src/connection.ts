// libpq connection semantics on top of pg.
//
// psycopg hands the connection parameters to libpq; pg (through
// pg-connection-string) interprets several of them differently: it turns
// `sslmode=prefer|require|verify-ca` into full certificate verification,
// has no `prefer`/`allow` fallback, connects to TCP localhost when no host is
// given, and ignores ~/.postgresql/ certificates. This module resolves the
// libpq parameters (connection string or options, then PG* environment
// variables, then libpq's defaults) into the pg configurations to try.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ConnectionOptions, SecureVersion } from 'node:tls';

import type { ClientConfig } from 'pg';
import { logger } from 'tsdmarc';

const DEFAULT_PORT = 5432;
/** psycopg's `_DEFAULT_CONNECT_TIMEOUT`, used when none is configured. */
export const DEFAULT_CONNECT_TIMEOUT = 130;
/** libpq enforces at least 2 seconds (`connectDBComplete`). */
const MIN_CONNECT_TIMEOUT = 2;
const MS_PER_SECOND = 1000;
/** Owner read/write only (0600), the most libpq accepts for a private key. */
const USER_KEY_MODE_MASK = 0o077;
/** Owner read/write, group read (0640), allowed for root-owned keys. */
const ROOT_KEY_MODE_MASK = 0o037;

/** libpq's compiled-in socket directories (Debian/psycopg, then upstream). */
export const DEFAULT_SOCKET_DIRECTORIES: readonly string[] = [
  '/var/run/postgresql',
  '/tmp',
];

const SSL_MODES = new Set([
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
]);

/** Keywords mapped onto pg; any other libpq keyword is ignored with a warning. */
const SUPPORTED_KEYWORDS = new Set([
  'user',
  'password',
  'connect_timeout',
  'dbname',
  'host',
  'port',
  'client_encoding',
  'options',
  'application_name',
  'fallback_application_name',
  'keepalives',
  'keepalives_idle',
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslcrl',
  'ssl_min_protocol_version',
  'ssl_max_protocol_version',
]);

const TLS_VERSIONS: ReadonlySet<string> = new Set([
  'TLSv1',
  'TLSv1.1',
  'TLSv1.2',
  'TLSv1.3',
]);

/**
 * Requirements libpq enforces by aborting the connection and pg can't: it
 * sends the password to whatever authentication the server asks for (even
 * with `enableChannelBinding`) and has no peer-credential, GSS or
 * client-certificate-request checks. Ignoring them would connect without the
 * protection the operator asked for, so they are refused.
 */
const UNENFORCEABLE_OPTIONS: readonly {
  keyword: string;
  envVar: string;
  enforced: (value: string) => boolean;
}[] = [
  {
    keyword: 'channel_binding',
    envVar: 'PGCHANNELBINDING',
    enforced: value => value === 'require',
  },
  {
    keyword: 'require_auth',
    envVar: 'PGREQUIREAUTH',
    enforced: value => value !== '',
  },
  {
    keyword: 'requirepeer',
    envVar: 'PGREQUIREPEER',
    enforced: value => value !== '',
  },
  {
    keyword: 'sslcertmode',
    envVar: 'PGSSLCERTMODE',
    enforced: value => value === 'require',
  },
  {
    keyword: 'gssencmode',
    envVar: 'PGGSSENCMODE',
    enforced: value => value === 'require',
  },
];

const INTEGER = /^\s*-?\d+\s*$/u;
const NUMBER = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/u;

/** Where defaults come from; replaced in tests. */
export interface ConnectionContext {
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  platform: NodeJS.Platform;
  socketDirectories: readonly string[];
}

export const DEFAULT_CONTEXT: ConnectionContext = {
  get env() {
    return process.env;
  },
  get homeDir() {
    return homedir();
  },
  get platform() {
    return process.platform;
  },
  socketDirectories: DEFAULT_SOCKET_DIRECTORIES,
};

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readOrThrow(file: string, what: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${what} "${file}": ${reason}`, {
      cause: error,
    });
  }
}

/**
 * psycopg's `timeout_from_conninfo()`: the configured seconds, at least 2;
 * missing, zero or negative means its 130 s default.
 */
export function resolveConnectTimeout(
  value: string | number | undefined,
): number {
  if (value === undefined) {
    return DEFAULT_CONNECT_TIMEOUT;
  }
  const seconds =
    typeof value === 'number'
      ? Math.trunc(value)
      : NUMBER.test(value)
        ? Math.trunc(Number(value))
        : Number.NaN;
  if (Number.isNaN(seconds)) {
    throw new Error(`bad value for connect_timeout: '${String(value)}'`);
  }
  if (seconds <= 0) {
    return DEFAULT_CONNECT_TIMEOUT;
  }
  return Math.max(seconds, MIN_CONNECT_TIMEOUT);
}

/**
 * libpq's default host when none is configured: the Unix socket directory.
 * libpq has one compiled-in directory; psycopg's is `/var/run/postgresql`.
 * `/tmp` (upstream PostgreSQL's default) is used when only its socket
 * exists. On Windows libpq connects to localhost.
 */
async function defaultHost(
  port: number,
  context: ConnectionContext,
): Promise<string> {
  if (context.platform === 'win32') {
    return 'localhost';
  }
  for (const directory of context.socketDirectories) {
    if (await exists(path.join(directory, `.s.PGSQL.${port}`))) {
      return directory;
    }
  }
  return context.socketDirectories[0] ?? 'localhost';
}

/**
 * libpq refuses private keys others can read (`fe-secure-openssl.c`), except
 * on Windows, where the mode bits say nothing about access.
 */
async function checkKeyPermissions(
  keyFile: string,
  context: ConnectionContext,
): Promise<void> {
  if (context.platform === 'win32') {
    return;
  }
  const { mode, uid } = await stat(keyFile);
  const mask = uid === 0 ? ROOT_KEY_MODE_MASK : USER_KEY_MODE_MASK;
  if ((mode & mask) !== 0) {
    throw new Error(
      `private key file "${keyFile}" has group or world access; file must have permissions u=rw (0600) or less if owned by the current user, or permissions u=rw,g=r (0640) or less if owned by root`,
    );
  }
}

function tlsVersion(
  keyword: string,
  value: string | undefined,
): SecureVersion | undefined {
  if (value === undefined || value === '') {
    return;
  }
  if (!TLS_VERSIONS.has(value)) {
    throw new Error(`invalid ${keyword} value: "${value}"`);
  }
  return value as SecureVersion;
}

/**
 * The TLS options libpq would use for `sslmode`: certificates are verified
 * when a root certificate is available (`~/.postgresql/root.crt` or
 * `sslrootcert`), required for verify-ca/verify-full; the host name is
 * checked only for verify-full. A client certificate is sent when present.
 */
async function tlsOptions(
  sslMode: string,
  get: (keyword: string, envVar: string) => string | undefined,
  context: ConnectionContext,
): Promise<ConnectionOptions> {
  const postgresDir = path.join(context.homeDir, '.postgresql');
  const options: ConnectionOptions = { rejectUnauthorized: false };
  const verify = sslMode === 'verify-ca' || sslMode === 'verify-full';
  const rootCert =
    get('sslrootcert', 'PGSSLROOTCERT') ?? path.join(postgresDir, 'root.crt');
  if (rootCert === 'system') {
    // Node's trusted roots (resolveConnection() enforces verify-full).
    options.rejectUnauthorized = true;
  } else if (await isFile(rootCert)) {
    options.ca = await readOrThrow(rootCert, 'root certificate file');
    options.rejectUnauthorized = true;
  } else if (verify) {
    throw new Error(
      `root certificate file "${rootCert}" does not exist\nEither provide the file, use the system's trusted roots with sslrootcert=system, or change sslmode to disable server certificate verification.`,
    );
  }
  if (options.rejectUnauthorized && sslMode !== 'verify-full') {
    // Verify the chain only, like libpq below verify-full.
    options.checkServerIdentity = () => undefined;
  }
  if (get('sslcrldir', 'PGSSLCRLDIR')) {
    throw new Error(
      'sslcrldir is not supported: revocation would not be checked (use sslcrl)',
    );
  }
  if (options.rejectUnauthorized) {
    // Like libpq, a revocation list only applies when verifying. The default
    // file is optional; a configured one must be readable.
    const crlFile = get('sslcrl', 'PGSSLCRL');
    const defaultCrl = path.join(postgresDir, 'root.crl');
    if (crlFile) {
      options.crl = await readOrThrow(crlFile, 'certificate revocation list');
    } else if (await isFile(defaultCrl)) {
      options.crl = await readOrThrow(
        defaultCrl,
        'certificate revocation list',
      );
    }
  }
  const minVersion = tlsVersion(
    'ssl_min_protocol_version',
    get('ssl_min_protocol_version', 'PGSSLMINPROTOCOLVERSION'),
  );
  const maxVersion = tlsVersion(
    'ssl_max_protocol_version',
    get('ssl_max_protocol_version', 'PGSSLMAXPROTOCOLVERSION'),
  );
  if (minVersion !== undefined) {
    options.minVersion = minVersion;
  }
  if (maxVersion !== undefined) {
    options.maxVersion = maxVersion;
  }

  const certFile =
    get('sslcert', 'PGSSLCERT') ?? path.join(postgresDir, 'postgresql.crt');
  if (await isFile(certFile)) {
    const keyFile =
      get('sslkey', 'PGSSLKEY') ?? path.join(postgresDir, 'postgresql.key');
    if (!(await isFile(keyFile))) {
      throw new Error(
        `certificate present, but not private key file "${keyFile}"`,
      );
    }
    await checkKeyPermissions(keyFile, context);
    options.cert = await readOrThrow(certFile, 'certificate file');
    options.key = await readOrThrow(keyFile, 'private key file');
  }
  return options;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') {
    return DEFAULT_PORT;
  }
  if (!INTEGER.test(value)) {
    // Not quoted: a password with an unencoded `/` ends up here in a URI.
    throw new Error('invalid integer value for connection option "port"');
  }
  return Math.trunc(Number(value));
}

/**
 * Resolve libpq connection parameters into the pg configurations to try,
 * in order. `sslmode=prefer` (libpq's default) tries TLS, then plain;
 * `allow` tries plain, then TLS; the others give one configuration.
 *
 * @param parameters - libpq keyword/value parameters.
 * @param connectTimeout - Seconds, when not set in `parameters`.
 * @throws {Error} With libpq's message for invalid parameters.
 */
export async function resolveConnection(
  parameters: ReadonlyMap<string, string>,
  connectTimeout: number | undefined,
  context: ConnectionContext = DEFAULT_CONTEXT,
): Promise<ClientConfig[]> {
  for (const keyword of parameters.keys()) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      logger.warning(
        `PostgreSQL connection option "${keyword}" is not supported and was ignored`,
      );
    }
  }
  const get = (keyword: string, envVar: string): string | undefined =>
    parameters.get(keyword) ?? context.env[envVar];
  for (const { keyword, envVar, enforced } of UNENFORCEABLE_OPTIONS) {
    const value = get(keyword, envVar);
    if (value !== undefined && enforced(value)) {
      throw new Error(
        `${keyword}=${value} is not supported: pg cannot enforce it, so the connection was refused`,
      );
    }
  }

  const port = parsePort(get('port', 'PGPORT'));
  const configuredHost = get('host', 'PGHOST');
  if (configuredHost?.includes(',')) {
    throw new Error('multiple hosts in "host" are not supported');
  }
  const host =
    configuredHost === undefined || configuredHost === ''
      ? await defaultHost(port, context)
      : configuredHost;

  const timeoutSetting =
    parameters.get('connect_timeout') ??
    connectTimeout ??
    context.env.PGCONNECT_TIMEOUT;
  const keepAliveIdle = parameters.get('keepalives_idle');
  const base: ClientConfig = {
    host,
    port,
    user: parameters.get('user'),
    password: parameters.get('password'),
    database: parameters.get('dbname'),
    connectionTimeoutMillis:
      resolveConnectTimeout(timeoutSetting) * MS_PER_SECOND,
    // libpq turns TCP keepalives on unless keepalives=0.
    keepAlive: parameters.get('keepalives')?.trim() !== '0',
  };
  if (keepAliveIdle !== undefined && INTEGER.test(keepAliveIdle)) {
    base.keepAliveInitialDelayMillis =
      Math.trunc(Number(keepAliveIdle)) * MS_PER_SECOND;
  }
  for (const keyword of [
    'application_name',
    'fallback_application_name',
    'options',
    'client_encoding',
  ] as const) {
    const value = parameters.get(keyword);
    if (value !== undefined) {
      base[keyword] = value;
    }
  }

  // With sslrootcert=system, libpq defaults to (and requires) verify-full.
  const systemRoots = get('sslrootcert', 'PGSSLROOTCERT') === 'system';
  const sslMode =
    get('sslmode', 'PGSSLMODE') ?? (systemRoots ? 'verify-full' : 'prefer');
  if (!SSL_MODES.has(sslMode)) {
    throw new Error(`invalid sslmode value: "${sslMode}"`);
  }
  if (systemRoots && sslMode !== 'verify-full') {
    throw new Error(
      `weak sslmode "${sslMode}" may not be used with sslrootcert=system (use "verify-full")`,
    );
  }
  const plain: ClientConfig = { ...base, ssl: false };
  // libpq never uses TLS over a Unix socket, whatever the sslmode.
  if (host.startsWith('/') || sslMode === 'disable') {
    return [plain];
  }
  const tls: ClientConfig = {
    ...base,
    ssl: await tlsOptions(sslMode, get, context),
  };
  if (sslMode === 'prefer') {
    return [tls, plain];
  }
  if (sslMode === 'allow') {
    return [plain, tls];
  }
  return [tls];
}

/**
 * Whether a failed attempt should fall back to the next configuration
 * (prefer/allow). Like libpq, not when the server can't be reached at all.
 */
export function canFallBack(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }
  const { syscall } = error as NodeJS.ErrnoException;
  if (syscall === 'connect' || syscall === 'getaddrinfo') {
    return false;
  }
  return !error.message.includes('connection timeout');
}
