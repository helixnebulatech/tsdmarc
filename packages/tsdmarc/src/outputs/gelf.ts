// Port of parsedmarc/gelf.py and the pygelf handlers it uses
// (GelfUdpHandler, GelfTcpHandler, GelfTlsHandler, with
// `include_extra_fields=True`).

import { randomBytes } from 'node:crypto';
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { isIP, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { type ConnectionOptions, getCACertificates } from 'node:tls';
import { deflateSync } from 'node:zlib';

import { parsedAggregateReportsToCsvRows } from '../aggregate';
import { parsedFailureReportsToCsvRows } from '../failure';
import {
  errorText,
  KeyError,
  PyAttributeError,
  PyValueError,
} from '../internal/py';
import { pyJsonDumps } from '../internal/py-json';
import {
  CRITICAL,
  DEBUG,
  ERROR,
  Handler,
  INFO,
  Logger,
  type LogRecord,
  WARNING,
} from '../log';
import { parsedSmtpTlsReportsToCsvRows } from '../smtp-tls';
import type { AggregateReport, FailureReport, SMTPTLSReport } from '../types';
import { PyDateTime } from '../utils/datetime';
import {
  closeDatagram,
  closeStream,
  connectTcp,
  connectTls,
  RETRY_FACTOR,
  RETRY_MAX,
  RETRY_START,
  SendFailures,
  SendQueue,
  sendAll,
  sendTo,
} from './socket-io';

const MS_PER_SECOND = 1000;
/** How long `close()` waits for queued bytes to flush. */
const CLOSE_TIMEOUT_MS = 5000;

/** pygelf's `LEVELS`: logging level → syslog severity. */
const LEVELS: ReadonlyMap<number, number> = new Map([
  [DEBUG, 7],
  [INFO, 6],
  [WARNING, 4],
  [ERROR, 3],
  [CRITICAL, 2],
]);

/**
 * pygelf's `SKIP_LIST`: LogRecord attributes never sent as extra fields
 * (plus `id`, which GELF forbids).
 */
const SKIP_LIST: ReadonlySet<string> = new Set([
  'args',
  'asctime',
  'created',
  'exc_info',
  'exc_text',
  'filename',
  'funcName',
  'id',
  'levelname',
  'levelno',
  'lineno',
  'module',
  'msecs',
  'message',
  'msg',
  'name',
  'pathname',
  'process',
  'processName',
  'relativeCreated',
  'thread',
  'threadName',
]);

/**
 * LogRecord attributes of Python 3.12+ that pygelf's `SKIP_LIST` misses, so
 * they always reach the packet as `_stack_info` / `_taskName` (both `None`
 * for parsedmarc's records).
 */
const UNSKIPPED_RECORD_ATTRIBUTES = ['stack_info', 'taskName'] as const;

/** pygelf's `object_to_json`: datetimes as ISO 8601, anything else `str()`. */
function objectToJson(value: unknown): unknown {
  if (value instanceof PyDateTime) {
    return value.isoformat();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function tracebackText(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? errorText(error))
    : String(error);
}

/** pygelf's `gelf.make()` with `debug=False` and no static fields. */
export function makeGelf(
  record: LogRecord,
  domain: string,
  version: string,
  includeExtraFields: boolean,
): Record<string, unknown> {
  const level = LEVELS.get(record.level);
  if (level === undefined) {
    throw new KeyError(record.level);
  }
  const gelf: Record<string, unknown> = {
    version,
    short_message: record.message,
    timestamp: record.created / MS_PER_SECOND,
    level,
    host: domain,
  };
  if (record.error !== undefined) {
    gelf.full_message = tracebackText(record.error);
  }
  if (includeExtraFields) {
    for (const key of UNSKIPPED_RECORD_ATTRIBUTES) {
      gelf[`_${key}`] = null;
    }
    for (const [key, value] of Object.entries(record.extra)) {
      if (!(SKIP_LIST.has(key) || key.startsWith('_'))) {
        gelf[`_${key}`] = value;
      }
    }
  }
  return gelf;
}

/** pygelf's `gelf.pack()`: compact JSON, UTF-8, zlib when compressing. */
export function packGelf(
  gelf: Record<string, unknown>,
  compress: boolean,
): Uint8Array {
  const packed = Buffer.from(
    pyJsonDumps(gelf, { separators: [',', ':'], default: objectToJson }),
    'utf-8',
  );
  return compress ? deflateSync(packed) : packed;
}

const CHUNK_MAGIC = [0x1e, 0x0f] as const;
const MESSAGE_ID_LENGTH = 8;
const MAX_CHUNKS = 127;

/**
 * pygelf's `gelf.split()`: GELF chunks of `chunkSize` bytes, each with the
 * magic bytes, a random 8-byte message id, the sequence number and count.
 */
export function splitGelf(gelf: Uint8Array, chunkSize: number): Uint8Array[] {
  const messageId = randomBytes(MESSAGE_ID_LENGTH);
  const count = Math.ceil(gelf.length / chunkSize);
  if (count > MAX_CHUNKS) {
    // struct.pack('b', number_of_chunks) fails before the first chunk.
    throw new Error(`'b' format requires -128 <= number <= ${MAX_CHUNKS}`);
  }
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const body = gelf.subarray(index * chunkSize, (index + 1) * chunkSize);
    chunks.push(
      Buffer.concat([
        Buffer.from(CHUNK_MAGIC),
        messageId,
        Buffer.from([index, count]),
        body,
      ]),
    );
  }
  return chunks;
}

export interface GelfHandlerOptions {
  /** GELF spec version (default `1.1`). */
  version?: string;
  /** Send the record's extra fields as `_<name>` (default false). */
  includeExtraFields?: boolean;
  /** zlib-compress each message (default: true for UDP, false otherwise). */
  compress?: boolean;
}

/** pygelf's `BaseHandler`: turns records into GELF. */
abstract class BaseGelfHandler extends Handler {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly includeExtraFields: boolean;
  readonly compress: boolean;
  /** The `host` field: this machine's hostname. */
  readonly domain: string = hostname();
  protected readonly queue: SendQueue = new SendQueue();
  protected readonly failures: SendFailures = new SendFailures();

  constructor(
    host: string,
    port: number,
    options: GelfHandlerOptions,
    compressDefault: boolean,
  ) {
    super();
    this.host = host;
    this.port = port;
    this.version = options.version ?? '1.1';
    this.includeExtraFields = options.includeExtraFields ?? false;
    this.compress = options.compress ?? compressDefault;
  }

  convertRecordToGelf(record: LogRecord): Uint8Array {
    return packGelf(
      makeGelf(record, this.domain, this.version, this.includeExtraFields),
      this.compress,
    );
  }

  /** The bytes sent for one record. */
  makePickle(record: LogRecord): Uint8Array {
    return this.convertRecordToGelf(record);
  }

  protected abstract send(data: Uint8Array): Promise<void>;

  emit(record: LogRecord): void {
    const data = this.makePickle(record);
    this.queue.push(
      () => this.send(data),
      error => this.handleError(record, error),
    );
  }

  /** Resolves once every record emitted so far has been sent (or dropped). */
  async drain(): Promise<void> {
    await this.queue.drain();
  }

  /** The messages dropped since the last call (always none over UDP). */
  takeFailures(): { count: number; error: unknown } | null {
    return this.failures.take();
  }

  override close(): void {
    void this.closeAsync();
  }

  abstract closeAsync(): Promise<void>;
}

/** `SocketHandler.makeSocket()`'s timeout, in seconds. */
const SOCKET_TIMEOUT = 1;

/**
 * pygelf's `GelfTcpHandler` over Python's `SocketHandler`: connects on the
 * first record, sends each message NUL-terminated, and on a connection or
 * send error closes the socket and retries later with exponential back-off
 * (1 s doubling up to 30 s). Unlike Python, a message that fails on a stale
 * connection is sent again once over a new one, and one that is still lost
 * is recorded in `failures` (`SocketHandler` drops it without a trace).
 */
export class GelfTcpHandler extends BaseGelfHandler {
  sock: Socket | null = null;
  /** Epoch ms before which no reconnect is attempted. */
  retryTime: number | null = null;
  retryPeriod: number = RETRY_START;
  #connectError: unknown = null;

  constructor(host: string, port: number, options: GelfHandlerOptions = {}) {
    super(host, port, options, false);
  }

  /** NUL-terminated: "if you send the message over tcp, it should always be null terminated". */
  override makePickle(record: LogRecord): Uint8Array {
    return Buffer.concat([this.convertRecordToGelf(record), Buffer.from([0])]);
  }

  /** Open the connection (`SocketHandler.makeSocket`). */
  protected async makeSocket(
    timeout: number = SOCKET_TIMEOUT,
  ): Promise<Socket> {
    return await connectTcp(
      { host: this.host, port: this.port },
      timeout * MS_PER_SECOND,
    );
  }

  /** `SocketHandler.createSocket()`: connect unless backing off. */
  async createSocket(): Promise<void> {
    const now = Date.now();
    if (this.retryTime !== null && now < this.retryTime) {
      return;
    }
    try {
      this.sock = await this.makeSocket();
      this.sock.unref();
      this.retryTime = null;
    } catch (error) {
      this.#connectError = error;
      if (this.retryTime === null) {
        this.retryPeriod = RETRY_START;
      } else {
        this.retryPeriod = Math.min(this.retryPeriod * RETRY_FACTOR, RETRY_MAX);
      }
      this.retryTime = now + this.retryPeriod * MS_PER_SECOND;
    }
  }

  /** Send over the open connection, or a new one; throws if that fails. */
  async #sendOnce(data: Uint8Array): Promise<void> {
    if (this.sock === null) {
      await this.createSocket();
    }
    const { sock } = this;
    if (sock === null) {
      throw this.#connectError;
    }
    try {
      await sendAll(sock, data, SOCKET_TIMEOUT * MS_PER_SECOND);
    } catch (error) {
      // OSError: close, so the next attempt reconnects.
      sock.destroy();
      this.sock = null;
      throw error;
    }
  }

  protected async send(data: Uint8Array): Promise<void> {
    try {
      await this.#sendOnce(data);
    } catch {
      // A server restart only shows on the next send, over the dead socket.
      try {
        await this.#sendOnce(data);
      } catch (error) {
        this.failures.record(error);
      }
    }
  }

  async closeAsync(): Promise<void> {
    await this.drain();
    const { sock } = this;
    this.sock = null;
    if (sock !== null) {
      await closeStream(sock, CLOSE_TIMEOUT_MS);
    }
  }
}

export interface GelfUdpHandlerOptions extends GelfHandlerOptions {
  /** Maximum datagram size before chunking (default 1300). */
  chunkSize?: number;
}

/**
 * pygelf's `GelfUdpHandler`: zlib-compressed datagrams (IPv4, like Python's
 * `DatagramHandler`), split into GELF chunks above `chunkSize` bytes.
 */
export class GelfUdpHandler extends BaseGelfHandler {
  readonly chunkSize: number;
  sock: DatagramSocket | null = null;

  constructor(host: string, port: number, options: GelfUdpHandlerOptions = {}) {
    super(host, port, options, true);
    this.chunkSize = options.chunkSize ?? 1300;
  }

  protected async send(data: Uint8Array): Promise<void> {
    if (this.sock === null) {
      const sock = createSocket('udp4');
      sock.on('error', () => undefined);
      sock.unref();
      this.sock = sock;
    }
    const chunks =
      data.length <= this.chunkSize ? [data] : splitGelf(data, this.chunkSize);
    for (const chunk of chunks) {
      await sendTo(this.sock, chunk, this.port, this.host);
    }
  }

  async closeAsync(): Promise<void> {
    await this.drain();
    const { sock } = this;
    this.sock = null;
    if (sock !== null) {
      await closeDatagram(sock);
    }
  }
}

export interface GelfTlsOptions {
  /**
   * Verify the server certificate and hostname (default true). pygelf
   * defaults to false; see the deviations in the architecture notes.
   */
  validate?: boolean;
  /** CA bundle file, added to the system CAs. */
  caCerts?: string | null;
  /** Client certificate file (may also hold the key). */
  certfile?: string | null;
  /** Client private key file. */
  keyfile?: string | null;
}

/** pygelf's `GelfTlsHandler`: {@link GelfTcpHandler} over TLS (IPv4). */
export class GelfTlsHandler extends GelfTcpHandler {
  readonly tlsOptions: ConnectionOptions;

  constructor(
    host: string,
    port: number,
    options: GelfHandlerOptions & GelfTlsOptions = {},
  ) {
    const { validate = true, caCerts, certfile, keyfile } = options;
    if (keyfile && !certfile) {
      throw new PyValueError('certfile must be specified');
    }
    super(host, port, options);
    const tlsOptions: ConnectionOptions = { rejectUnauthorized: validate };
    if (caCerts) {
      tlsOptions.ca = [
        ...getCACertificates('default'),
        readFileSync(caCerts, 'utf-8'),
      ];
    }
    if (certfile) {
      tlsOptions.cert = readFileSync(certfile);
      tlsOptions.key = readFileSync(keyfile || certfile);
    }
    this.tlsOptions = tlsOptions;
  }

  protected override async makeSocket(
    timeout: number = SOCKET_TIMEOUT,
  ): Promise<Socket> {
    const timeoutMs = timeout * MS_PER_SECOND;
    // Like pygelf: an IPv4 socket, wrapped, then connected.
    const plain = await connectTcp(
      { host: this.host, port: this.port, family: 4 },
      timeoutMs,
    );
    // The handshake's timeout timer keeps the event loop alive meanwhile.
    plain.unref();
    try {
      return await connectTls(
        {
          ...this.tlsOptions,
          socket: plain,
          host: this.host,
          // Python sends no SNI for IP addresses; Node refuses one.
          ...(isIP(this.host) === 0 && { servername: this.host }),
        },
        timeoutMs,
      );
    } catch (error) {
      plain.destroy();
      throw error;
    }
  }
}

/** parsedmarc's thread-local `log_context_data`: the row being logged. */
export const logContextData: { parsedmarc?: unknown } = {};

/** Copies `logContextData.parsedmarc` onto each record as `parsedmarc`. */
export class ContextFilter {
  readonly filter = (record: LogRecord): boolean => {
    if (!('parsedmarc' in logContextData)) {
      // Python reads an attribute the thread-local doesn't have yet.
      throw new PyAttributeError(
        "'_thread._local' object has no attribute 'parsedmarc'",
      );
    }
    record.extra.parsedmarc = logContextData.parsedmarc;
    return true;
  };
}

/** Raised when messages could not be delivered over TCP or TLS. */
export class GelfError extends Error {
  override name = 'GelfError';
}

export type GelfMode = 'udp' | 'tcp' | 'tls';

export interface GelfClientOptions {
  /** TLS settings for `tls` mode. */
  tls?: GelfTlsOptions;
}

type GelfHandler = GelfUdpHandler | GelfTcpHandler | GelfTlsHandler;

/** A client for the Graylog Extended Log Format. */
export class GelfClient {
  readonly host: string;
  readonly port: number;
  readonly logger: Logger;
  readonly gelfMode: Readonly<
    Record<GelfMode, (host: string, port: number) => GelfHandler>
  >;
  /** The GELF handler attached to {@link logger}. */
  handler: Handler;

  /**
   * @param host - The GELF host
   * @param port - The GELF port
   * @param mode - The GELF transport mode: `udp`, `tcp` or `tls`
   */
  constructor(
    host: string,
    port: number,
    mode: string,
    options: GelfClientOptions = {},
  ) {
    this.host = host;
    this.port = port;
    // Its own logger, not parsedmarc's shared `getLogger()` one: a logger
    // sends to all its handlers, so clients sharing it would each send their
    // rows to every other client's server.
    this.logger = new Logger('tsdmarc_gelf');
    this.logger.setLevel(INFO);
    this.logger.addFilter(new ContextFilter().filter);
    this.gelfMode = {
      udp: (h, p) => new GelfUdpHandler(h, p, { includeExtraFields: true }),
      tcp: (h, p) => new GelfTcpHandler(h, p, { includeExtraFields: true }),
      tls: (h, p) =>
        new GelfTlsHandler(h, p, { ...options.tls, includeExtraFields: true }),
    };
    if (!Object.hasOwn(this.gelfMode, mode)) {
      throw new KeyError(mode);
    }
    this.handler = this.gelfMode[mode as GelfMode](this.host, this.port);
    this.logger.addHandler(this.handler);
  }

  async saveAggregateReportToGelf(
    aggregateReports: AggregateReport | AggregateReport[],
  ): Promise<void> {
    const rows = parsedAggregateReportsToCsvRows(aggregateReports);
    for (const row of rows) {
      logContextData.parsedmarc = row;
      this.logger.info('parsedmarc aggregate report');
    }
    logContextData.parsedmarc = null;
    await this.#drain();
  }

  async saveFailureReportToGelf(
    failureReports: FailureReport | FailureReport[],
  ): Promise<void> {
    const rows = parsedFailureReportsToCsvRows(failureReports);
    for (const row of rows) {
      logContextData.parsedmarc = row;
      this.logger.info('parsedmarc failure report');
    }
    await this.#drain();
  }

  /** Backward-compatible alias of {@link saveFailureReportToGelf}. */
  async saveForensicReportToGelf(
    failureReports: FailureReport | FailureReport[],
  ): Promise<void> {
    await this.saveFailureReportToGelf(failureReports);
  }

  async saveSmtpTlsReportToGelf(
    smtpTlsReports: SMTPTLSReport | SMTPTLSReport[],
  ): Promise<void> {
    const rows = parsedSmtpTlsReportsToCsvRows(smtpTlsReports);
    for (const row of rows) {
      logContextData.parsedmarc = row;
      this.logger.info('parsedmarc smtptls report');
    }
    await this.#drain();
  }

  /**
   * Wait until the messages logged so far have been sent.
   *
   * @throws {GelfError} When some could not be delivered over TCP or TLS.
   */
  async #drain(): Promise<void> {
    if (this.handler instanceof BaseGelfHandler) {
      await this.handler.drain();
      const failures = this.handler.takeFailures();
      if (failures !== null) {
        throw new GelfError(
          `${failures.count} message(s) not sent to ${this.host}:${this.port}: ${errorText(failures.error)}`,
          { cause: failures.error },
        );
      }
    }
  }

  /** Remove and close the GELF handler, releasing its connection. */
  async close(): Promise<void> {
    this.logger.removeHandler(this.handler);
    if (this.handler instanceof BaseGelfHandler) {
      await this.handler.closeAsync();
    } else {
      this.handler.close();
    }
  }
}
