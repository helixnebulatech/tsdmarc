// A simplified IMAP client, ported from mailsuite.imap.IMAPClient.
//
// mailsuite subclasses imapclient's `IMAPClient`; this class wraps an
// imapflow `ImapFlow` instead. The small "base" methods (`selectFolder`,
// `search`, `copy`, `move`, `addFlags`, `expunge`, `idle`, ...) translate
// imapclient's calls into imapflow's; on top of them sit mailsuite's
// behaviors, ported 1:1: `/`-delimited folder normalisation with the
// server's hierarchy separator and namespace prefix, the fetch fallbacks,
// UIDPLUS-aware deletes, chunked moves with a COPY + delete fallback,
// timeouts retried after reconnecting, OAuth2 login, and the IDLE loop.

import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ConnectionOptions } from 'node:tls';

import {
  type ExistsEvent,
  type ExpungeEvent,
  type FetchMessageObject,
  type FlagsEvent,
  ImapFlow,
  type ImapFlowOptions,
  type ListResponse,
  type SearchObject,
} from 'imapflow';
import {
  EmailTooLargeError,
  emailTooLargeError,
  logger,
  ValueError,
} from 'tsdmarc';

import {
  errorMessage,
  FetchKeyError,
  IMAPClientAbortError,
  IMAPClientError,
  IMAPTimeoutError,
  isOsOrKeyError,
  isRetryableError,
  MaxRetriesExceeded,
  stripErrorText,
  toImapError,
} from './errors';

const MILLISECONDS_PER_SECOND = 1000;
/** The longest delay a Node timer (and so `socket.setTimeout()`) accepts. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;
/** Refresh the IDLE session this often, to stay connected. */
const IDLE_REFRESH_SECONDS = 5 * 60;
/**
 * Waits before the IDLE loop reconnects: none the first time, then from the
 * minimum, doubling up to the maximum while connections keep failing within
 * IDLE_STABLE_CONNECTION_SECONDS. mailsuite reconnects at once every time.
 */
const IDLE_RECONNECT_MIN_DELAY_SECONDS = 1;
const IDLE_RECONNECT_MAX_DELAY_SECONDS = 60;
/** A connection that lasted this long resets the reconnect delay. */
const IDLE_STABLE_CONNECTION_SECONDS = 60;
/** UIDs per MOVE/COPY command. */
const MOVE_CHUNK_SIZE = 100;
/** Room for what surrounds the message in a FETCH response (UID, FLAGS...). */
const FETCH_RESPONSE_HEADROOM = 1024 * 1024;
/**
 * How often a size-limited fetch checks the bytes received for the whole
 * command (imapflow has no event for them): each check runs between two
 * turns of the event loop, which read a bounded amount from the socket.
 */
const FETCH_BUDGET_CHECK_MS = 1;
/** imapflow's errors for a response over its limits, with the size field. */
const OVERSIZED_RESPONSE_FIELDS: ReadonlyMap<string, string> = new Map([
  ['LiteralTooLarge', 'literalSize'],
  ['LineTooLarge', 'lineLength'],
  ['ResponseTooLarge', 'responseSize'],
]);
const SPECIAL_FOLDERS: ReadonlySet<string> = new Set(['', '*', 'INBOX']);
const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;
/** `SINCE 01-Jan-2026`: the search mailsuite's callers send. */
const SINCE_CRITERIA = /^SINCE (\d{1,2})-([A-Za-z]{3})-(\d{4})$/u;

/**
 * imapflow's error for a required STARTTLS the server can't do (not
 * offered, refused, or a PREAUTH greeting): `tlsFailed` without a code.
 */
function isStartTlsUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const fields = error as { tlsFailed?: unknown; code?: unknown };
  return fields.tlsFailed === true && fields.code === undefined;
}

/**
 * The limits of imapflow's response parser. They are options of its
 * constructor, but `maxSize` comes with each fetch, so they are set on the
 * parser, which reads them for every response. It is not in imapflow's
 * types; `client.socket.test.ts` covers it with the real imapflow.
 */
interface ResponseLimits {
  maxLineLength: number;
  maxLiteralSize: number;
  maxResponseSize: number;
}

function responseLimits(flow: ImapFlow): ResponseLimits {
  return (flow as unknown as { streamer: ResponseLimits }).streamer;
}

/** Called with the client when IDLE reports new mail (and on each timeout). */
export type IdleCallback = (client: IMAPClient) => Promise<void> | void;

/** An untagged IDLE response: `[count, "EXISTS"]`, `[seq, "EXPUNGE"]`, `[seq, "FETCH"]`. */
export type IdleResponse = [number, string];

/** Returns a current OAuth2 access token. Called on every (re)connect. */
export type OAuth2TokenProvider = () => Promise<string> | string;

export interface IMAPClientOptions {
  /** The username (or OAuth2 identity / email address). */
  username?: string | null;
  /** The password (omit when using OAuth2). */
  password?: string | null;
  /** Default: 993. */
  port?: number;
  /**
   * Use TLS from the start. Without it the connection starts in plain text
   * and `starttls` decides whether it is upgraded. Default: true.
   */
  ssl?: boolean;
  /**
   * Whether to upgrade a plain-text (`ssl: false`) connection with STARTTLS
   * (mailsuite 2.3.4). `null`/`undefined` (default) upgrades when the server
   * advertises STARTTLS, and throws `IMAPClientError` before authenticating
   * when it does not, so credentials are never sent in plain text. `false`
   * never upgrades, so the connection stays plain text even when STARTTLS
   * is advertised and credentials are sent unencrypted (a warning is
   * logged). `true` requires the upgrade and throws `IMAPClientError
   * ("STARTTLS required but not supported by the server")` if the server
   * does not advertise STARTTLS. Ignored with `ssl: true`, because the
   * connection is already TLS.
   */
  starttls?: boolean | null;
  /** Extra TLS options (mailsuite's `ssl_context`). */
  tls?: ConnectionOptions | null;
  /** Verify the server's TLS certificate. Default: true. */
  verify?: boolean;
  /**
   * Seconds to wait for the connection and the greeting, and for the server
   * to answer while a command is in flight (imaplib's socket timeout). An
   * idle connection is never timed out. Default: 30.
   */
  timeout?: number;
  /** The maximum number of retries after a timeout. Default: 4. */
  maxRetries?: number;
  /** The folder to select after connecting. Default: `"INBOX"`. */
  initialFolder?: string;
  /**
   * Start an IDLE loop after connecting; `connect()` resolves when it ends,
   * leaving the connection open (call `close()`).
   */
  idleCallback?: IdleCallback | null;
  /** Seconds to wait for an IDLE response. Default: 30. */
  idleTimeout?: number;
  /** A static OAuth2 access token. Prefer `oauth2TokenProvider` for long-running connections. */
  oauth2Token?: string | null;
  /** Returns a current OAuth2 access token; invoked on every (re)connect. */
  oauth2TokenProvider?: OAuth2TokenProvider | null;
  /**
   * `"XOAUTH2"` (default) or `"OAUTHBEARER"`. Kept for API parity: imapflow
   * picks the mechanism from the server's capabilities (OAUTHBEARER when
   * offered, else XOAUTH2) and can't be forced to one.
   */
  oauth2Mechanism?: string;
  /** Yahoo's XOAUTH2 vendor string. Not supported by imapflow: setting it throws. */
  oauth2Vendor?: string | null;
  /** When it returns true, the IDLE loop exits so the caller can reload config. */
  configReloading?: (() => boolean) | null;
  /** Aborts the IDLE loop (Python's `KeyboardInterrupt`). */
  signal?: AbortSignal | null;
}

export interface StartIdleOptions {
  /** Seconds to wait for an IDLE response. Default: 30. */
  idleTimeout?: number;
  configReloading?: (() => boolean) | null;
  signal?: AbortSignal | null;
}

/**
 * Yield successive `n`-sized chunks of a list.
 *
 * @yields {T[]} The next chunk.
 */
export function* chunks<T>(list: readonly T[], n: number): Generator<T[]> {
  for (let index = 0; index < list.length; index += n) {
    yield list.slice(index, index + n);
  }
}

function toUidList(
  messages: number | string | readonly (number | string)[],
): number[] {
  if (typeof messages === 'number' || typeof messages === 'string') {
    return [Number(messages)];
  }
  return messages.map(Number);
}

/** Python's `str(list)` of UIDs: `[1, 2, 3]`. */
function pythonList(uids: readonly number[]): string {
  return `[${uids.join(', ')}]`;
}

function monotonicSeconds(): number {
  return performance.now() / MILLISECONDS_PER_SECOND;
}

/** Translate the IMAP search strings mailsuite uses into imapflow queries. */
function parseSearchCriteria(criteria: string): SearchObject {
  if (criteria.toUpperCase() === 'ALL') {
    return { all: true };
  }
  const match = SINCE_CRITERIA.exec(criteria);
  const month = match
    ? MONTHS.indexOf(match[2]?.toLowerCase() as (typeof MONTHS)[number])
    : -1;
  if (match === null || month === -1) {
    throw new IMAPClientError(`Unsupported search criteria: ${criteria}`);
  }
  // imapflow formats dates in UTC, so build the day in UTC.
  return {
    since: new Date(Date.UTC(Number(match[3]), month, Number(match[1]))),
  };
}

async function readStream(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array));
  }
  return Buffer.concat(parts);
}

/** One way of fetching a full message. */
interface FetchAttempt {
  name: string;
  run: (flow: ImapFlow, uid: number, maxSize: number) => Promise<FetchResult>;
}

/** The message bytes, or the keys of a response that lacked them. */
type FetchResult =
  | { found: true; content: Buffer }
  | { found: false; keys: string[] | null };

function responseKeys(result: FetchMessageObject): string[] {
  return Object.entries(result)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

/**
 * The fetch commands to try, in order. mailsuite tries `RFC822`, `BODY[]`
 * and `BODY[NULL]`, because imapclient exposes the server's response keys
 * and some servers answer under a different one. imapflow parses the
 * response itself, so the fallbacks here are its two ways of reading a
 * whole message: one `BODY.PEEK[]` fetch, then a chunked download.
 */
const FETCH_ATTEMPTS: readonly FetchAttempt[] = [
  {
    name: 'BODY.PEEK[]',
    run: async (flow, uid) => {
      const result = await flow.fetchOne(
        String(uid),
        { source: true },
        { uid: true },
      );
      if (result === false) {
        return { found: false, keys: null };
      }
      if (result.source === undefined) {
        return { found: false, keys: responseKeys(result) };
      }
      return { found: true, content: result.source };
    },
  },
  {
    name: 'download',
    run: async (flow, uid, maxSize) => {
      // One byte over the limit is enough to know it is too large.
      const download = await flow.download(String(uid), undefined, {
        uid: true,
        ...(maxSize > 0 ? { maxBytes: maxSize + 1 } : {}),
      });
      if (download.content === undefined) {
        return { found: false, keys: null };
      }
      return { found: true, content: await readStream(download.content) };
    },
  },
];

export class IMAPClient {
  readonly host: string;
  readonly port: number;
  readonly ssl: boolean;
  maxRetries: number;
  idleCallback: IdleCallback | null;
  idleTimeout: number;
  /** Capabilities reported after login. */
  serverCapabilities: string[] = [];
  /** The personal namespace prefix (e.g. `INBOX.`), or `""`. */
  pathPrefix = '';
  /** Prefixes of the other-users and shared namespaces. */
  otherNamespacePrefixes: string[] = [];
  /** The server's hierarchy separator. */
  hierarchySeparator = '';
  moveSupported = false;
  idleSupported: boolean | null = null;

  private readonly options: IMAPClientOptions;
  private readonly usingOauth: boolean;
  private readonly timeoutMs: number;
  /** The folder of the last successful SELECT (as the caller named it). */
  private selectedFolder: string | null = null;
  /** The folder `connect()` selects instead of `initialFolder` (reconnects). */
  private restoreFolder: string | null = null;
  /** Set when imapflow ended the IDLE command without `idleDone()`. */
  private idleEnded = false;
  private flow: ImapFlow | null = null;
  private idleRunning = false;
  /** True between `idle()` and `idleDone()`; only then are responses buffered. */
  private idling = false;
  private idleSession: Promise<void> | null = null;
  private idleResponses: IdleResponse[] = [];
  private connectionError: Error | null = null;
  private wakeIdleCheck: (() => void) | null = null;

  /** Validate the options. Call `connect()` (or use `IMAPClient.connect()`) to connect. */
  constructor(host: string, options: IMAPClientOptions = {}) {
    const usingOauth =
      (options.oauth2Token ?? null) !== null ||
      (options.oauth2TokenProvider ?? null) !== null;
    if (usingOauth && !options.username) {
      throw new ValueError(
        'username is required when authenticating with OAuth2',
      );
    }
    if (
      !usingOauth &&
      ((options.username ?? null) === null ||
        (options.password ?? null) === null)
    ) {
      throw new ValueError(
        'either password or an OAuth2 token / token_provider must be provided',
      );
    }
    if (options.oauth2Vendor) {
      throw new ValueError(
        'oauth2Vendor is not supported: imapflow does not send the XOAUTH2 vendor field',
      );
    }
    this.host = host;
    this.port = options.port ?? 993;
    this.ssl = options.ssl ?? true;
    this.maxRetries = options.maxRetries ?? 4;
    this.idleCallback = options.idleCallback ?? null;
    this.idleTimeout = options.idleTimeout ?? 30;
    this.timeoutMs = (options.timeout ?? 30) * MILLISECONDS_PER_SECOND;
    this.options = options;
    this.usingOauth = usingOauth;
  }

  /** Connect, like constructing mailsuite's `IMAPClient`. */
  static async connect(
    host: string,
    options: IMAPClientOptions = {},
  ): Promise<IMAPClient> {
    const client = new IMAPClient(host, options);
    await client.connect();
    return client;
  }

  /** The current imapflow connection. */
  protected get connection(): ImapFlow {
    if (this.flow === null) {
      throw new IMAPClientError('Not connected to the IMAP server');
    }
    return this.flow;
  }

  private buildFlowOptions(accessToken: string | null): ImapFlowOptions {
    const timeout = this.timeoutMs;
    const username = this.options.username ?? '';
    const tls: ConnectionOptions = { ...this.options.tls };
    if (this.options.verify === false) {
      tls.rejectUnauthorized = false;
    }
    return {
      host: this.host,
      port: this.port,
      secure: this.ssl,
      ...this.startTlsPolicy(),
      tls,
      auth:
        accessToken === null
          ? { user: username, pass: this.options.password ?? '' }
          : { user: username, accessToken },
      logger: false,
      // mailsuite drives IDLE itself and fetches the raw message: no
      // automatic IDLE and no BINARY (which would decode the body).
      disableAutoIdle: true,
      disableBinary: true,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      // imaplib's timeout only bounds blocking reads: a connection with no
      // command in flight (between commands, or idling) stays open
      // however long it is quiet. imapflow's socketTimeout would close it
      // (or break IDLE with a NOOP), so it is pushed out of reach and
      // `command()` bounds each command instead.
      socketTimeout: MAX_TIMER_DELAY,
    };
  }

  /**
   * imapflow's `doSTARTTLS` for this connection. An explicit `starttls`
   * applies as is. By default STARTTLS is required before the credentials
   * are sent, as in mailsuite 2.3.4 (a stripped STARTTLS capability would
   * otherwise leak them). imapflow refuses `doSTARTTLS` with `secure`.
   */
  private startTlsPolicy(): { doSTARTTLS?: boolean } {
    if (this.ssl) {
      return {};
    }
    return { doSTARTTLS: this.options.starttls ?? true };
  }

  /**
   * mailsuite's checks on the advertised (pre-login) capabilities, run
   * where imapflow decides on STARTTLS, before any credentials are sent:
   * with `starttls: false`, an info line when STARTTLS is advertised and a
   * warning that the credentials go unencrypted; otherwise mailsuite's
   * errors when STARTTLS is not advertised.
   */
  private checkStartTls(flow: ImapFlow): void {
    if (this.ssl) {
      return;
    }
    const starttls = this.options.starttls ?? null;
    const upgrade = flow.upgradeToSTARTTLS.bind(flow);
    flow.upgradeToSTARTTLS = async (): Promise<boolean> => {
      const advertised = flow.capabilities.has('STARTTLS');
      if (starttls === false) {
        if (advertised) {
          logger.info(
            'IMAP server supports STARTTLS, but it is disabled ... staying in plain text',
          );
        }
        logger.warning(
          'Sending IMAP credentials unencrypted because starttls=False',
        );
      } else if (!advertised && starttls === true) {
        throw new IMAPClientError(
          'STARTTLS required but not supported by the server',
        );
      } else if (!advertised) {
        // An attacker can strip STARTTLS from the plain-text capabilities
        // (GHSA-2x4j-7g3q-wr6f).
        throw new IMAPClientError(
          'The IMAP server does not advertise STARTTLS, so credentials would be sent in plain text. Use ssl=True for implicit TLS, or pass starttls=False to allow plain-text authentication',
        );
      }
      return upgrade();
    };
  }

  /**
   * Run one IMAP command (or the connect/login sequence) under imaplib's
   * read timeout: it fails with `IMAPTimeoutError("timed out")` when the
   * server sends nothing for `timeout` seconds while it is in flight. The
   * connection is then closed, like a socket left mid-response; callers
   * retry after `resetConnection()`.
   */
  private async command<T>(call: (flow: ImapFlow) => Promise<T>): Promise<T> {
    const flow = this.connection;
    const limit = this.timeoutMs;
    let received = flow.stats().received;
    let lastActivity = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_resolve, reject) => {
      const check = (): void => {
        const now = performance.now();
        const current = flow.stats().received;
        if (current !== received) {
          received = current;
          lastActivity = now;
        }
        const quiet = now - lastActivity;
        if (quiet >= limit) {
          flow.close();
          reject(new IMAPTimeoutError('timed out'));
          return;
        }
        timer = setTimeout(check, limit - quiet);
      };
      timer = setTimeout(check, limit);
    });
    const operation = call(flow);
    try {
      return await Promise.race([operation, watchdog]);
    } finally {
      clearTimeout(timer);
      // A command abandoned by the watchdog rejects once the socket closes.
      operation.catch(() => undefined);
    }
  }

  private attachListeners(flow: ImapFlow): void {
    // Events of a connection that has since been replaced are ignored.
    const current = (): boolean => this.flow === flow;
    const buffer = (response: IdleResponse): void => {
      if (this.idling && current()) {
        this.idleResponses.push(response);
        this.wakeIdleCheck?.();
      }
    };
    flow.on('exists', (event: ExistsEvent) => buffer([event.count, 'EXISTS']));
    flow.on('expunge', (event: ExpungeEvent) =>
      buffer([event.seq ?? event.uid ?? 0, 'EXPUNGE']),
    );
    flow.on('flags', (event: FlagsEvent) => buffer([event.seq, 'FETCH']));
    // Without an 'error' listener an emitted error would crash the process.
    flow.on('error', (error: Error) => {
      if (!current()) {
        return;
      }
      this.connectionError = toImapError(error);
      this.wakeIdleCheck?.();
    });
    flow.on('close', () => {
      if (!current()) {
        return;
      }
      this.connectionError ??= toImapError(
        Object.assign(new Error('Connection closed'), {
          code: 'EConnectionClosed',
        }),
      );
      this.wakeIdleCheck?.();
    });
  }

  /**
   * Connect, authenticate, detect MOVE/IDLE/NAMESPACE support and the
   * hierarchy separator, and select `initialFolder`. With `idleCallback`,
   * then run the IDLE loop (unless one is already running on this client)
   * and resolve when it ends; like mailsuite, the connection then stays
   * open and logged in, so call `close()` when done with it.
   */
  async connect(): Promise<void> {
    if (!this.ssl) {
      logger.info('Connecting to IMAP over plain text');
    }
    this.connectionError = null;
    this.pathPrefix = '';
    this.otherNamespacePrefixes = [];
    this.hierarchySeparator = '';
    try {
      let accessToken: string | null = null;
      if (this.usingOauth) {
        const provider = this.options.oauth2TokenProvider ?? null;
        accessToken =
          provider === null
            ? (this.options.oauth2Token ?? '')
            : await provider();
      }
      const flow = new ImapFlow(this.buildFlowOptions(accessToken));
      this.checkStartTls(flow);
      this.attachListeners(flow);
      this.flow = flow;
      this.selectedFolder = null;
      await this.command(() => flow.connect());
      if (!this.ssl && flow.secureConnection) {
        logger.info('IMAP server supports STARTTLS ... activating now');
      }
      this.serverCapabilities = [...flow.capabilities.keys()];
      this.moveSupported = this.hasCapability('MOVE');
      this.idleSupported = this.hasCapability('IDLE');
      const folders = await this.listFolders();
      this.hierarchySeparator = folders[0]?.delimiter ?? '';
      if (this.hasCapability('NAMESPACE')) {
        const namespaces = flow.namespaces;
        const personal = namespaces?.personal ?? [];
        const [first] = personal;
        if (first !== undefined) {
          this.hierarchySeparator = first.delimiter ?? '';
          if (first.prefix !== '') {
            this.pathPrefix = first.prefix;
          }
        }
        // Non-personal namespace prefixes (other users, shared), so
        // normaliseFolder() can leave paths in those namespaces alone.
        for (const entries of [namespaces?.other, namespaces?.shared]) {
          for (const entry of entries || []) {
            if (entry.prefix) {
              this.otherNamespacePrefixes.push(entry.prefix);
            }
          }
        }
      }
      // On a reconnect, the folder that was selected before (see
      // resetConnection()), else initialFolder.
      const folder =
        this.restoreFolder ?? this.options.initialFolder ?? 'INBOX';
      this.restoreFolder = null;
      await this.selectFolder(folder);
    } catch (error) {
      this.restoreFolder = null;
      this.flow?.close();
      let message = stripErrorText(error);
      if (isStartTlsUnavailable(error)) {
        // imapflow refused a required STARTTLS (answered NO, PREAUTH, ...).
        message += '; refusing to send credentials in plain text';
      }
      throw new IMAPClientError(message, { cause: error });
    }
    // Skip starting IDLE when a loop is already running on this client:
    // resetConnection() reconnects from inside the loop, and a nested
    // startIdle() would stack IDLE loops on every reconnect.
    if (this.idleCallback !== null && !this.idleRunning) {
      try {
        await this.startIdle(this.idleCallback, {
          idleTimeout: this.idleTimeout,
          configReloading: this.options.configReloading ?? null,
          signal: this.options.signal ?? null,
        });
      } catch (error) {
        // The static connect() loses this client when it throws, so nobody
        // else can close the logged-in session.
        this.flow?.close();
        throw error;
      }
    }
  }

  /** Close the socket without logging out (imaplib's `shutdown()`). */
  shutdown(): Promise<void> {
    this.flow?.close();
    return Promise.resolve();
  }

  /** Log out and close the connection. */
  async close(): Promise<void> {
    const flow = this.flow;
    if (flow === null) {
      return;
    }
    try {
      await this.command(() => flow.logout());
    } catch {
      flow.close();
    }
  }

  /**
   * Resets the connection to the IMAP server.
   *
   * Unlike mailsuite, which re-selects `initial_folder` (INBOX), the folder
   * selected before the reset is selected again: the retried move/delete
   * UIDs belong to that folder, not to INBOX.
   */
  async resetConnection(): Promise<void> {
    logger.info('Reconnecting to IMAP');
    try {
      await this.shutdown();
    } catch (error) {
      logger.info(`Failed to log out: ${errorMessage(error)}`);
    }
    this.restoreFolder = this.selectedFolder;
    await this.connect();
  }

  // ---- imapclient-level operations -------------------------------------

  /** Run an imapflow call, raising Python-equivalent errors. */
  private async run<T>(
    command: string,
    call: () => Promise<T | false | undefined>,
  ): Promise<T> {
    let result: T | false | undefined;
    try {
      result = await this.command(call);
    } catch (error) {
      throw toImapError(error);
    }
    if (result === false || result === undefined) {
      throw new IMAPClientError(`${command} command failed`);
    }
    return result;
  }

  hasCapability(capability: string): boolean {
    return this.serverCapabilities.includes(capability.toUpperCase());
  }

  /**
   * Translate a caller's `/`-delimited folder path to the server's form.
   *
   * Callers can always use `/` as the hierarchy separator, even on servers
   * whose native separator is something else (e.g. `.` on some
   * Dovecot/Courier setups): it maps `/` onto the server's separator and
   * applies the personal-namespace prefix. imapflow does the modified
   * UTF-7 encoding that imapclient's base method adds.
   */
  normaliseFolder(folderName: string | Uint8Array): string {
    let name =
      typeof folderName === 'string'
        ? folderName
        : new TextDecoder('utf-8').decode(folderName);
    if (SPECIAL_FOLDERS.has(name)) {
      return name;
    }
    name = name.replace(/\/+$/u, '');
    // A path already inside a non-personal namespace (other users or
    // shared, RFC 2342) passes through without the personal prefix.
    if (this.otherNamespacePrefixes.some(prefix => name.startsWith(prefix))) {
      return name;
    }
    // Strip only a leading prefix before re-adding it: "Projects/INBOX/old"
    // with prefix "INBOX/" must become "INBOX/Projects/INBOX/old".
    if (this.pathPrefix && name.startsWith(this.pathPrefix)) {
      name = name.slice(this.pathPrefix.length);
    }
    if (this.hierarchySeparator !== '/') {
      // Literal native separators are dropped first, since "/" is the
      // delimiter callers are expected to use.
      name = name
        .replaceAll(this.hierarchySeparator, '')
        .replaceAll('/', this.hierarchySeparator);
    }
    return `${this.pathPrefix}${name}`;
  }

  listFolders(): Promise<ListResponse[]> {
    return this.run('LIST', () => this.connection.list({ listOnly: true }));
  }

  async folderExists(folder: string): Promise<boolean> {
    const name = this.normaliseFolder(folder);
    const folders = await this.listFolders();
    const isInbox = name.toUpperCase() === 'INBOX';
    return folders.some(
      entry =>
        entry.path === name ||
        (isInbox && entry.path.toUpperCase() === 'INBOX'),
    );
  }

  async selectFolder(folder: string): Promise<void> {
    // A failed SELECT leaves no folder selected.
    this.selectedFolder = null;
    await this.run('SELECT', () =>
      this.connection.mailboxOpen(this.normaliseFolder(folder)),
    );
    this.selectedFolder = folder;
  }

  /** UID SEARCH: all messages, or an `ALL` / `SINCE dd-Mon-yyyy` criteria string. */
  async search(criteria: string | SearchObject = 'ALL'): Promise<number[]> {
    const query =
      typeof criteria === 'string' ? parseSearchCriteria(criteria) : criteria;
    const result = await this.run('SEARCH', () =>
      this.connection.search(query, { uid: true }),
    );
    return [...result];
  }

  async copy(messages: readonly number[], folder: string): Promise<void> {
    await this.run('COPY', () =>
      this.connection.messageCopy([...messages], this.normaliseFolder(folder), {
        uid: true,
      }),
    );
  }

  async move(messages: readonly number[], folder: string): Promise<void> {
    await this.run('MOVE', () =>
      this.connection.messageMove([...messages], this.normaliseFolder(folder), {
        uid: true,
      }),
    );
  }

  async addFlags(
    messages: readonly number[],
    flags: readonly string[],
    options: { silent?: boolean } = {},
  ): Promise<void> {
    await this.run('STORE', () =>
      this.connection.messageFlagsAdd([...messages], [...flags], {
        uid: true,
        silent: options.silent ?? false,
      }),
    );
  }

  /**
   * EXPUNGE. With UIDs, `UID EXPUNGE` of just those (needs UIDPLUS);
   * without, a plain EXPUNGE of every `\Deleted` message in the folder.
   */
  async expunge(messages?: readonly number[]): Promise<void> {
    if (messages !== undefined) {
      // imapflow's messageDelete() re-adds \Deleted (a no-op here) and sends
      // UID EXPUNGE when the server has UIDPLUS.
      await this.run('EXPUNGE', () =>
        this.connection.messageDelete([...messages], { uid: true }),
      );
      return;
    }
    try {
      // Sequence-number delete of the \Deleted messages: a plain EXPUNGE.
      // It returns false when nothing is flagged, which is not an error, and
      // also when STORE or EXPUNGE failed, so that has to be told apart.
      const expunged = await this.command(flow =>
        flow.messageDelete({ deleted: true }),
      );
      if (expunged) {
        return;
      }
      const flagged = await this.command(flow =>
        flow.search({ deleted: true }),
      );
      if (!flagged || flagged.length > 0) {
        throw new IMAPClientError('EXPUNGE command failed');
      }
    } catch (error) {
      throw toImapError(error);
    }
  }

  async noop(): Promise<void> {
    try {
      await this.command(flow => flow.noop());
    } catch (error) {
      throw toImapError(error);
    }
  }

  async renameFolder(oldName: string, newName: string): Promise<void> {
    await this.run('RENAME', () =>
      this.connection.mailboxRename(
        this.normaliseFolder(oldName),
        this.normaliseFolder(newName),
      ),
    );
  }

  async deleteFolder(folder: string): Promise<void> {
    await this.run('DELETE', () =>
      this.connection.mailboxDelete(this.normaliseFolder(folder)),
    );
  }

  /** Start IDLE. It runs in the background until `idleDone()`. */
  async idle(): Promise<void> {
    const flow = this.connection;
    this.idleResponses = [];
    this.idling = true;
    this.idleEnded = false;
    const session: Promise<void> = flow.idle().then(
      () => {
        // IDLE ended without idleDone() (e.g. the server closed it with a
        // tagged OK): the loop re-enters IDLE.
        this.idleEnded ||=
          this.idling && this.flow === flow && this.idleSession === session;
        return undefined;
      },
      (error: unknown) => {
        if (this.flow !== flow) {
          return;
        }
        this.connectionError ??= toImapError(error);
        this.wakeIdleCheck?.();
      },
    );
    this.idleSession = session;
    await Promise.resolve();
  }

  /** End IDLE (imapflow sends DONE before the next command, a NOOP). */
  async idleDone(): Promise<void> {
    this.idling = false;
    const session = this.idleSession;
    this.idleSession = null;
    await this.noop();
    await session;
  }

  /**
   * Wait up to `timeout` seconds for IDLE responses. Returns what arrived
   * (`[]` on timeout, like imapclient), or `null` when `signal` aborts.
   * Throws when the connection fails.
   */
  idleCheck(
    timeout: number,
    signal?: AbortSignal | null,
  ): Promise<IdleResponse[] | null> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        signal?.removeEventListener('abort', finish);
        this.wakeIdleCheck = null;
        if (this.connectionError !== null) {
          reject(this.connectionError);
          return;
        }
        if (signal?.aborted) {
          resolve(null);
          return;
        }
        const responses = this.idleResponses;
        this.idleResponses = [];
        resolve(responses);
      };
      if (
        this.connectionError !== null ||
        this.idleResponses.length > 0 ||
        signal?.aborted
      ) {
        finish();
        return;
      }
      // Collect what arrives in the same tick as the first response.
      this.wakeIdleCheck = () => setImmediate(finish);
      signal?.addEventListener('abort', finish, { once: true });
      timer = setTimeout(finish, timeout * MILLISECONDS_PER_SECOND);
    });
  }

  // ---- mailsuite behaviors ---------------------------------------------

  /**
   * Run an IMAP IDLE session: call `idleCallback` now, then whenever the
   * server reports new mail and after every `idleTimeout` seconds without
   * a response, until `configReloading()` returns true or `signal` aborts.
   * Lost connections are re-established: the first time at once, then
   * after a delay that doubles from 1 s up to 60 s while connections keep
   * failing within a minute (mailsuite never waits). When the loop ends, IDLE is
   * stopped but the connection stays open and logged in (as in mailsuite):
   * call `close()` to release it, or the open socket keeps the process
   * alive.
   */
  async startIdle(
    idleCallback: IdleCallback,
    options: StartIdleOptions = {},
  ): Promise<void> {
    const idleTimeout = options.idleTimeout ?? 30;
    const { configReloading, signal } = options;
    if (this.idleSupported === false) {
      throw new IMAPClientError('IDLE is not supported by the server');
    }
    // Mark the loop active (before the first callback, which may already
    // reconnect) so a reconnect re-arms this loop in place instead of
    // starting a nested one.
    this.idleRunning = true;
    let idleStartTime = monotonicSeconds();
    let connectedSince = idleStartTime;
    let reconnectDelay = 0;
    /**
     * Reconnect and restart, after the backoff delay (see
     * IDLE_RECONNECT_MIN_DELAY_SECONDS), so a server that drops every
     * connection at once can't make the loop reconnect without pause.
     * Returns false when `signal` aborted the wait.
     */
    const reconnect = async (): Promise<boolean> => {
      if (
        monotonicSeconds() - connectedSince >=
        IDLE_STABLE_CONNECTION_SECONDS
      ) {
        reconnectDelay = 0;
      }
      if (reconnectDelay > 0) {
        logger.debug(`IMAP: Reconnecting in ${reconnectDelay} s`);
        try {
          await sleep(reconnectDelay * MILLISECONDS_PER_SECOND, undefined, {
            signal: signal ?? undefined,
          });
        } catch (error) {
          if (signal?.aborted) {
            return false;
          }
          throw error;
        }
      }
      reconnectDelay = Math.min(
        Math.max(reconnectDelay * 2, IDLE_RECONNECT_MIN_DELAY_SECONDS),
        IDLE_RECONNECT_MAX_DELAY_SECONDS,
      );
      await this.resetConnection();
      connectedSince = monotonicSeconds();
      await restart();
      return true;
    };
    const restart = async (): Promise<void> => {
      // Python's KeyboardInterrupt stops the loop before the next check.
      if (signal?.aborted) {
        return;
      }
      await idleCallback(this);
      idleStartTime = monotonicSeconds();
      await this.idle();
    };
    try {
      await idleCallback(this);
      idleStartTime = monotonicSeconds();
      await this.idle();
      while (true) {
        if (configReloading?.() || signal?.aborted) {
          break;
        }
        try {
          if (monotonicSeconds() - idleStartTime > IDLE_REFRESH_SECONDS) {
            logger.info('IMAP: Refreshing IDLE session');
            await this.idleDone();
            idleStartTime = monotonicSeconds();
            await this.idle();
          } else if (this.idleEnded) {
            // imapflow ended IDLE on its own: keep one IDLE session open.
            logger.debug('IMAP: IDLE ended by the server, restarting it');
            await this.idle();
          }
          const responses = await this.idleCheck(idleTimeout, signal);
          if (responses === null) {
            break;
          }
          if (responses.length === 0) {
            // A timeout (or Gmail's empty response): check anyway.
            await this.idleDone();
            await restart();
          } else {
            for (const [count, kind] of responses) {
              // New mail is signalled by an untagged EXISTS (the new
              // message count); RECENT is optional, react to either.
              if (kind === 'EXISTS' || (kind === 'RECENT' && count !== 0)) {
                await this.idleDone();
                await restart();
                break;
              }
            }
          }
        } catch (error) {
          if (signal?.aborted) {
            break;
          }
          // Python catches OSError (timeouts, resets) and KeyError, also
          // when the callback raises them, and reconnects. A failed connection
          // always reconnects, whatever its error: it stays set until then
          // (Python's fails once), so idleCheck() would reject at once and
          // this loop would spin in microtasks, starving timers, I/O and
          // signal handlers.
          if (
            this.connectionError !== null ||
            isRetryableError(error) ||
            isOsOrKeyError(error)
          ) {
            logger.debug('IMAP error: Connection reset');
            if (!(await reconnect())) {
              break;
            }
          } else if (error instanceof IMAPClientError) {
            const text = stripErrorText(error);
            // Workaround for random Exchange/Microsoft 365 IMAP errors
            if (
              (text.includes('unexpected response') || text.includes('BAD')) &&
              !(await reconnect())
            ) {
              break;
            }
          } else {
            throw error;
          }
        }
      }
    } finally {
      this.idleRunning = false;
    }
    try {
      await this.idleDone();
    } catch {
      // The connection is already gone (Python's BrokenPipeError).
    }
  }

  /**
   * Fetch a message by UID and return its raw contents (UTF-8, invalid
   * bytes replaced). Timeouts are retried after reconnecting, up to
   * `maxRetries` attempts.
   *
   * mailsuite fetches `RFC822`, which also sets `\Seen`; imapflow fetches
   * with `BODY.PEEK[]`, so `\Seen` is added afterwards to match.
   *
   * With `maxSize`, the message's `RFC822.SIZE` is fetched first and a
   * larger message is not downloaded (nor marked seen): `EmailTooLargeError`
   * is thrown. `RFC822.SIZE` is the server's word, so the limit also holds
   * while reading: a response over it is refused at its literal marker
   * (imapflow then closes the connection, and this reconnects) and the
   * chunked download stops at the limit.
   */
  async fetchMessage(
    msgUid: number,
    options: { maxSize?: number | null } = {},
    attempt = 1,
  ): Promise<string> {
    const maxSize = options.maxSize ?? 0;
    if (maxSize > 0 && attempt === 1) {
      const size = await this.messageSize(msgUid, maxSize);
      if (size !== null && size > maxSize) {
        throw emailTooLargeError(size, maxSize);
      }
    }
    let content: Buffer | null = null;
    let lastKeys: string[] | null = null;
    for (const fetchAttempt of FETCH_ATTEMPTS) {
      let result: FetchResult;
      try {
        result = await this.limitedCommand(maxSize, flow =>
          fetchAttempt.run(flow, msgUid, maxSize),
        );
      } catch (rawError) {
        if (rawError instanceof EmailTooLargeError) {
          throw rawError;
        }
        const error = toImapError(rawError);
        if (isRetryableError(error)) {
          const nextAttempt = attempt + 1;
          if (nextAttempt > this.maxRetries) {
            throw new MaxRetriesExceeded('Maximum retries exceeded');
          }
          logger.info(
            `Attempt ${nextAttempt} of ${this.maxRetries} timed out. Retrying...`,
          );
          await this.resetConnection();
          return this.fetchMessage(msgUid, options, nextAttempt);
        }
        // Some IMAP servers may not support a fetch method: try the next.
        logger.debug(
          `Fetch with [${fetchAttempt.name}] failed: ${error.message}`,
        );
        continue;
      }
      if (result.found) {
        content = result.content;
        break;
      }
      // Like Python's raw_msg, keep the last response that arrived.
      if (result.keys !== null) {
        lastKeys = result.keys;
      }
    }

    if (content === null) {
      if (lastKeys !== null && lastKeys.length > 0) {
        throw new FetchKeyError(
          `Message UID ${msgUid} does not contain expected message keys after trying all fetch methods. ` +
            `Last response contained: ${JSON.stringify(lastKeys)}`,
        );
      }
      throw new FetchKeyError(
        `Failed to fetch message UID ${msgUid} using any of the supported fetch methods`,
      );
    }
    if (maxSize > 0 && content.length > maxSize) {
      throw emailTooLargeError(content.length, maxSize);
    }
    try {
      await this.command(flow =>
        flow.messageFlagsAdd(String(msgUid), ['\\Seen'], {
          uid: true,
          silent: true,
        }),
      );
    } catch (error) {
      logger.debug(
        `Failed to mark message UID ${msgUid} as seen: ${toImapError(error).message}`,
      );
    }
    return new TextDecoder('utf-8').decode(content);
  }

  /**
   * Run a fetch with imapflow's response limits lowered to `maxSize` (when
   * above 0), so a response over it is refused before it is read. Throws
   * `EmailTooLargeError` for such a response, after reconnecting: imapflow
   * has closed the connection.
   *
   * Those limits are per response, and imapflow keeps every row of a FETCH
   * until the command ends, so the bytes received for the whole command are
   * also capped at the same `maxSize` + headroom: past it, the connection is
   * closed (a server that answers one FETCH with many rows, each under the
   * limit, is stopped there).
   */
  private async limitedCommand<T>(
    maxSize: number,
    call: (flow: ImapFlow) => Promise<T>,
  ): Promise<T> {
    if (maxSize <= 0) {
      return this.command(call);
    }
    const flow = this.connection;
    const limits = responseLimits(flow);
    const previous = { ...limits };
    const budget = maxSize + FETCH_RESPONSE_HEADROOM;
    limits.maxLiteralSize = maxSize;
    limits.maxLineLength = budget;
    limits.maxResponseSize = budget;
    const start = flow.stats().received;
    const receivedBytes = (): number => flow.stats().received - start;
    const meter = setInterval(() => {
      if (receivedBytes() > budget) {
        clearInterval(meter);
        flow.close();
      }
    }, FETCH_BUDGET_CHECK_MS);
    try {
      const result = await this.command(call);
      if (receivedBytes() > budget) {
        throw new IMAPClientAbortError('FETCH answer over the size limit');
      }
      return result;
    } catch (error) {
      const received = receivedBytes();
      const size =
        this.oversizedResponse() ?? (received > budget ? received : null);
      if (size === null) {
        throw error;
      }
      await this.resetConnection();
      throw emailTooLargeError(size, maxSize);
    } finally {
      clearInterval(meter);
      limits.maxLiteralSize = previous.maxLiteralSize;
      limits.maxLineLength = previous.maxLineLength;
      limits.maxResponseSize = previous.maxResponseSize;
    }
  }

  /** The size of the response imapflow refused, or `null` if it did not. */
  private oversizedResponse(): number | null {
    const cause = this.connectionError?.cause as
      | Record<string, unknown>
      | undefined;
    const field = OVERSIZED_RESPONSE_FIELDS.get(String(cause?.code));
    return field === undefined ? null : Number(cause?.[field]);
  }

  /**
   * A message's `RFC822.SIZE`, or `null` when the server doesn't return it
   * (or the probe fails: the fetch that follows retries and reports errors).
   */
  private async messageSize(
    msgUid: number,
    maxSize: number,
  ): Promise<number | null> {
    try {
      const result = await this.limitedCommand(maxSize, flow =>
        flow.fetchOne(String(msgUid), { size: true }, { uid: true }),
      );
      return result !== false && typeof result.size === 'number'
        ? result.size
        : null;
    } catch (error) {
      if (error instanceof EmailTooLargeError) {
        throw error;
      }
      logger.debug(
        `Fetching the size of message UID ${msgUid} failed: ${toImapError(error).message}`,
      );
      return null;
    }
  }

  /** Deletes the given messages by UID (UID EXPUNGE with UIDPLUS, else EXPUNGE). */
  async deleteMessages(
    messages: number | string | readonly (number | string)[],
    options: { silent?: boolean } = {},
    attempt = 1,
  ): Promise<void> {
    const silent = options.silent ?? true;
    const uids = toUidList(messages);
    logger.info(`Deleting message UID(s) ${uids.join(',')}`);
    try {
      await this.addFlags(uids, ['\\Deleted'], { silent });
      // Expunging specific UIDs (UID EXPUNGE) requires UIDPLUS; without it,
      // fall back to a plain EXPUNGE, which removes every message flagged
      // \Deleted in the folder.
      if (this.hasCapability('UIDPLUS')) {
        await this.expunge(uids);
      } else {
        await this.expunge();
      }
    } catch (error) {
      if (!isRetryableError(error)) {
        throw error;
      }
      const nextAttempt = attempt + 1;
      if (nextAttempt > this.maxRetries) {
        throw new MaxRetriesExceeded('Maximum retries exceeded');
      }
      logger.info(
        `Attempt ${nextAttempt} of ${this.maxRetries} timed out. Retrying...`,
      );
      await this.resetConnection();
      await this.deleteMessages(uids, { silent }, nextAttempt);
    }
  }

  /** Creates a folder at the given path, unless it already exists. */
  async createFolder(folder: string, attempt = 1): Promise<void> {
    if (await this.folderExists(folder)) {
      return;
    }
    logger.info(`Creating folder: ${folder}`);
    try {
      await this.run('CREATE', () =>
        this.connection.mailboxCreate(this.normaliseFolder(folder)),
      );
    } catch (error) {
      if (!isRetryableError(error)) {
        throw error;
      }
      const nextAttempt = attempt + 1;
      if (nextAttempt > this.maxRetries) {
        throw new MaxRetriesExceeded('Maximum retries exceeded');
      }
      logger.info(
        `Attempt ${nextAttempt} of ${this.maxRetries} timed out. Retrying...`,
      );
      await this.resetConnection();
      await this.createFolder(folder, nextAttempt);
    }
  }

  /** Move messages to a folder, 100 UIDs at a time. */
  protected async moveMessagesOnce(
    msgUids: number | readonly number[],
    folderPath: string,
  ): Promise<void> {
    const folder = folderPath.replaceAll('\\', '/').replace(/\/+$/u, '');
    const uids = toUidList(msgUids);
    for (const chunk of chunks(uids, MOVE_CHUNK_SIZE)) {
      const chunkText = chunk.join(',');
      if (this.moveSupported) {
        logger.info(`Moving message UID(s) ${chunkText} to ${folder}`);
        try {
          await this.move(chunk, folder);
        } catch (error) {
          if (!(error instanceof IMAPClientError)) {
            throw error;
          }
          const text = `Error moving message UIDs ${pythonList(uids)}: ${stripErrorText(error)}`;
          logger.info(`IMAP error: ${text}`);
          logger.info(
            `Copying message UID(s) ${chunkText} to ${folder} by copy`,
          );
          await this.copy(chunk, folder);
          await this.deleteMessages(chunk);
        }
      } else {
        logger.info(`Moving message UID(s) ${chunkText} to ${folder} by copy`);
        await this.copy(chunk, folder);
        await this.deleteMessages(chunk);
      }
    }
  }

  /** Move messages to a folder, retrying once after a timeout. */
  async moveMessages(
    msgUids: number | readonly number[],
    folderPath: string,
    attempt = 1,
  ): Promise<void> {
    try {
      await this.moveMessagesOnce(msgUids, folderPath);
    } catch (error) {
      if (!isRetryableError(error)) {
        throw error;
      }
      const nextAttempt = attempt + 1;
      if (nextAttempt > this.maxRetries) {
        throw new MaxRetriesExceeded('Maximum retries exceeded');
      }
      logger.info(
        `Attempt ${nextAttempt} of ${this.maxRetries} timed out. Retrying...`,
      );
      await this.resetConnection();
      await this.moveMessagesOnce(msgUids, folderPath);
    }
  }
}
