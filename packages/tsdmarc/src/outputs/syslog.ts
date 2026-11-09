// Port of parsedmarc/syslog.py, with the parts of Python's
// `logging.handlers.SysLogHandler` it uses (UDP and TCP to host:port).

import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { isIP, type Socket } from 'node:net';
import { type ConnectionOptions, getCACertificates } from 'node:tls';

import { parsedAggregateReportsToCsvRows } from '../aggregate';
import { parsedFailureReportsToCsvRows } from '../failure';
import { errorText, PyValueError } from '../internal/py';
import { pyJsonDumps } from '../internal/py-json';
import { getLogger, Handler, INFO, Logger, type LogRecord } from '../log';
import { parsedSmtpTlsReportsToCsvRows } from '../smtp-tls';
import type { AggregateReport, FailureReport, SMTPTLSReport } from '../types';
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

/** Connection problems, shared; report rows go through each client's logger. */
const connectionLogger = getLogger('tsdmarc_syslog');

const MS_PER_SECOND = 1000;
/** How long `close()` waits for queued bytes to flush. */
const CLOSE_TIMEOUT_MS = 5000;

/** `LOG_USER`, SysLogHandler's default facility. */
export const LOG_USER = 1;

/** SysLogHandler's `priority_names` for the levels its `priority_map` uses. */
const PRIORITIES: Readonly<Record<string, number>> = {
  DEBUG: 7,
  INFO: 6,
  WARNING: 4,
  ERROR: 3,
  CRITICAL: 2,
};
const DEFAULT_PRIORITY = PRIORITIES.WARNING ?? 4;

export type SyslogSocketType = 'dgram' | 'stream';

export interface SysLogHandlerOptions {
  /** `socket.SOCK_DGRAM` (UDP, the default) or `SOCK_STREAM` (TCP). */
  socktype?: SyslogSocketType;
  /** Seconds for connect and send; `null` (the default) waits forever. */
  timeout?: number | null;
  /** Turns each new TCP connection into the one to use (TLS). */
  wrapSocket?: (socket: Socket) => Promise<Socket>;
}

/**
 * Port of `logging.handlers.SysLogHandler` for a `(host, port)` address:
 * sends `<PRI>message\0` per record, as one datagram (UDP) or on one
 * connection (TCP, no octet counting, like Python). Create it with
 * {@link SysLogHandler.create}, which resolves the host and, for TCP,
 * connects, like Python's constructor. Unlike Python, which keeps using a
 * dead TCP socket forever, a failed send reconnects (with `SocketHandler`'s
 * back-off) and tries once more; what is still lost is in {@link takeFailures}.
 */
export class SysLogHandler extends Handler {
  readonly address: readonly [string, number];
  readonly facility: number = LOG_USER;
  readonly socktype: SyslogSocketType;
  /** Seconds for each send on a stream socket; `null` waits forever. */
  timeout: number | null;
  /** The datagram socket, or the (possibly TLS-wrapped) stream socket. */
  socket: DatagramSocket | Socket | null = null;
  readonly #queue = new SendQueue();
  readonly #failures = new SendFailures();
  readonly #wrapSocket: SysLogHandlerOptions['wrapSocket'];
  /** Epoch ms before which no reconnect is attempted. */
  #retryTime: number | null = null;
  #retryPeriod: number = RETRY_START;
  #connectError: unknown = null;

  protected constructor(
    address: readonly [string, number],
    options: SysLogHandlerOptions,
  ) {
    super();
    this.address = address;
    this.socktype = options.socktype ?? 'dgram';
    this.timeout = options.timeout ?? null;
    this.#wrapSocket = options.wrapSocket;
    // Python's default Formatter: the message, then any traceback.
    this.formatter = (record: LogRecord): string =>
      record.error === undefined
        ? record.message
        : `${record.message}\n${record.error instanceof Error ? (record.error.stack ?? errorText(record.error)) : String(record.error)}`;
  }

  /** Create the handler and its socket (throws if that fails). */
  static async create(
    address: readonly [string, number],
    options: SysLogHandlerOptions = {},
  ): Promise<SysLogHandler> {
    const handler = new SysLogHandler(address, options);
    await handler.createSocket();
    return handler;
  }

  /**
   * Resolve the address and create the socket; for TCP, connect to the
   * first address that accepts, like Python's `createSocket()`.
   */
  async createSocket(): Promise<void> {
    const [host, port] = this.address;
    const addresses = await lookup(host, { all: true, order: 'verbatim' });
    if (addresses.length === 0) {
      throw new Error('getaddrinfo returns an empty list');
    }
    const timeoutMs = this.timeout ? this.timeout * MS_PER_SECOND : null;
    let lastError: unknown = null;
    for (const { address, family } of addresses) {
      if (this.socktype === 'dgram') {
        const socket = createSocket(family === 6 ? 'udp6' : 'udp4');
        socket.on('error', () => undefined);
        socket.unref();
        this.socket = socket;
        return;
      }
      try {
        const plain = await connectTcp(
          { host: address, port, family },
          timeoutMs,
        );
        plain.unref();
        const socket = (await this.#wrapSocket?.(plain)) ?? plain;
        socket.unref();
        this.socket = socket;
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /** `SysLogHandler.encodePriority()` with `mapPriority()`. */
  encodePriority(levelName: string): number {
    // Python: (facility << 3) | priority
    return this.facility * 8 + (PRIORITIES[levelName] ?? DEFAULT_PRIORITY);
  }

  emit(record: LogRecord): void {
    // Python appends a NUL ("some old syslog daemons expect" it), on UDP
    // and TCP alike, and frames TCP messages by nothing else.
    const message = `<${this.encodePriority(record.levelName)}>${this.format(record)}\0`;
    const data = Buffer.from(message, 'utf-8');
    this.#queue.push(
      () => this.#send(data),
      error => {
        this.handleError(record, error);
        if (this.socktype === 'stream') {
          this.#failures.record(error);
        }
      },
    );
  }

  async #send(data: Uint8Array): Promise<void> {
    if (this.socktype === 'stream') {
      try {
        await this.#sendOverStream(data);
      } catch {
        // A server restart only shows on the next send, over the dead socket.
        await this.#sendOverStream(data);
      }
      return;
    }
    if (this.socket === null) {
      await this.createSocket();
    }
    const [host, port] = this.address;
    await sendTo(this.socket as DatagramSocket, data, port, host);
  }

  /** Send over the open connection, or a new one; throws if that fails. */
  async #sendOverStream(data: Uint8Array): Promise<void> {
    if (this.socket === null) {
      await this.#reconnect();
    }
    const socket = this.socket as Socket;
    const timeoutMs = this.timeout ? this.timeout * MS_PER_SECOND : null;
    try {
      await sendAll(socket, data, timeoutMs);
    } catch (error) {
      socket.destroy();
      this.socket = null;
      throw error;
    }
  }

  /** `createSocket()` with the back-off of Python's `SocketHandler`. */
  async #reconnect(): Promise<void> {
    const now = Date.now();
    if (this.#retryTime !== null && now < this.#retryTime) {
      throw this.#connectError;
    }
    try {
      await this.createSocket();
      this.#retryTime = null;
    } catch (error) {
      this.#retryPeriod =
        this.#retryTime === null
          ? RETRY_START
          : Math.min(this.#retryPeriod * RETRY_FACTOR, RETRY_MAX);
      this.#retryTime = now + this.#retryPeriod * MS_PER_SECOND;
      this.#connectError = error;
      throw error;
    }
  }

  /** Resolves once every record emitted so far has been sent (or failed). */
  async drain(): Promise<void> {
    await this.#queue.drain();
  }

  /** The messages lost over TCP/TLS since the last call (UDP has no record). */
  takeFailures(): { count: number; error: unknown } | null {
    return this.#failures.take();
  }

  /** Close the socket (after the queued sends). Use {@link closeAsync} to wait. */
  override close(): void {
    void this.closeAsync();
  }

  /** Send what is queued, then close the socket. */
  async closeAsync(): Promise<void> {
    await this.drain();
    const { socket } = this;
    this.socket = null;
    if (socket === null) {
      return;
    }
    if (this.socktype === 'dgram') {
      await closeDatagram(socket as DatagramSocket);
    } else {
      await closeStream(socket as Socket, CLOSE_TIMEOUT_MS);
    }
  }
}

export interface SyslogClientOptions {
  /** `udp` (default), `tcp` or `tls`; case-insensitive. */
  protocol?: string;
  /** CA certificate file for TLS server verification, added to the system CAs. */
  cafilePath?: string | null;
  /** Client certificate file for TLS authentication. */
  certfilePath?: string | null;
  /** Client private key file for TLS authentication. */
  keyfilePath?: string | null;
  /** Connection timeout in seconds for TCP/TLS (default 5). */
  timeout?: number;
  /** Connection attempts for TCP/TLS (default 3). */
  retryAttempts?: number;
  /** Seconds between connection attempts (default 5). */
  retryDelay?: number;
}

/** Hooks for tests: the delay between connection attempts. */
export const syslogTimers: { sleep: (seconds: number) => Promise<void> } = {
  async sleep(seconds: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, seconds * MS_PER_SECOND));
  },
};

async function readOptionalFile(
  filePath: string | null | undefined,
): Promise<Buffer | null> {
  return filePath ? await readFile(filePath) : null;
}

/** Raised when messages could not be delivered over TCP or TLS. */
export class SyslogError extends Error {
  override name = 'SyslogError';
}

/** A client for Syslog. */
export class SyslogClient {
  readonly serverName: string;
  readonly serverPort: number;
  readonly protocol: string;
  readonly timeout: number;
  readonly retryAttempts: number;
  readonly retryDelay: number;
  readonly logger: Logger;
  /** The syslog handler attached to {@link logger}. */
  logHandler!: Handler;

  protected constructor(
    serverName: string,
    serverPort: number,
    options: SyslogClientOptions,
  ) {
    this.serverName = serverName;
    this.serverPort = serverPort;
    this.protocol = (options.protocol ?? 'udp').toLowerCase();
    this.timeout = options.timeout ?? 5;
    this.retryAttempts = options.retryAttempts ?? 3;
    this.retryDelay = options.retryDelay ?? 5;
    // Its own logger, not parsedmarc's shared `getLogger()` one: a logger
    // sends to all its handlers, so clients sharing it would each send their
    // rows to every other client's server.
    this.logger = new Logger('tsdmarc_syslog');
    this.logger.setLevel(INFO);
  }

  /**
   * Create a SyslogClient: resolves the server and, for TCP/TLS, connects
   * (retrying `retryAttempts` times, `retryDelay` seconds apart), so a bad
   * address fails here as Python's constructor does.
   *
   * @param serverName - The Syslog server
   * @param serverPort - The Syslog port
   */
  static async create(
    serverName: string,
    serverPort: number,
    options: SyslogClientOptions = {},
  ): Promise<SyslogClient> {
    const client = new SyslogClient(serverName, serverPort, options);
    client.logHandler = await client.createSyslogHandler(options);
    client.logger.addHandler(client.logHandler);
    return client;
  }

  /** Creates a SysLogHandler with the specified protocol and TLS settings. */
  protected async createSyslogHandler(
    options: SyslogClientOptions,
  ): Promise<SysLogHandler> {
    const { protocol, retryAttempts, retryDelay, timeout } = this;
    const address = [this.serverName, this.serverPort] as const;
    if (protocol === 'udp') {
      // UDP protocol (default, backward compatible)
      return await SysLogHandler.create(address, { socktype: 'dgram' });
    }
    if (protocol !== 'tcp' && protocol !== 'tls') {
      throw new PyValueError(
        `Invalid protocol '${protocol}'. Must be 'udp', 'tcp', or 'tls'.`,
      );
    }
    // TCP or TLS protocol with retry logic
    for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
      try {
        if (protocol === 'tcp') {
          return await SysLogHandler.create(address, {
            socktype: 'stream',
            timeout,
          });
        }
        return await this.createTlsHandler(options);
      } catch (error) {
        if (attempt < retryAttempts) {
          connectionLogger.warning(
            `Syslog connection attempt ${attempt}/${retryAttempts} failed: ${errorText(error)}. ` +
              `Retrying in ${retryDelay} seconds...`,
          );
          await syslogTimers.sleep(retryDelay);
        } else {
          connectionLogger.error(
            `Syslog connection failed after ${retryAttempts} attempts: ${errorText(error)}`,
          );
          throw error;
        }
      }
    }
    // Only reachable when retryAttempts < 1.
    throw new PyValueError('retry_attempts must be at least 1');
  }

  /** TCP connection wrapped in TLS ≥ 1.2, verifying the server. */
  protected async createTlsHandler(
    options: SyslogClientOptions,
  ): Promise<SysLogHandler> {
    const { cafilePath, certfilePath, keyfilePath } = options;
    // ssl.create_default_context(): system CAs plus the given CA file,
    // hostname check, TLS 1.2 minimum.
    const tlsOptions: ConnectionOptions = {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    };
    const ca = await readOptionalFile(cafilePath);
    if (ca !== null) {
      tlsOptions.ca = [...getCACertificates('default'), ca.toString('utf-8')];
    }
    if (certfilePath && keyfilePath) {
      tlsOptions.cert = await readFile(certfilePath);
      tlsOptions.key = await readFile(keyfilePath);
    } else if (certfilePath || keyfilePath) {
      connectionLogger.warning(
        'Both certfile_path and keyfile_path are required for ' +
          'client certificate authentication. Client authentication ' +
          'will not be used.',
      );
    }

    const timeoutMs = this.timeout * MS_PER_SECOND;
    // Every connection is wrapped, reconnections included: plain TCP after a
    // dropped connection would send the reports in the clear.
    const wrapSocket = async (plain: Socket): Promise<Socket> => {
      try {
        return await connectTls(
          {
            ...tlsOptions,
            socket: plain,
            host: this.serverName,
            // Python sends no SNI for IP addresses; Node refuses one.
            ...(isIP(this.serverName) === 0 && { servername: this.serverName }),
          },
          timeoutMs,
        );
      } catch (error) {
        plain.destroy();
        throw error;
      }
    };
    return await SysLogHandler.create([this.serverName, this.serverPort], {
      socktype: 'stream',
      timeout: this.timeout,
      wrapSocket,
    });
  }

  async saveAggregateReportToSyslog(
    aggregateReports: AggregateReport | AggregateReport[],
  ): Promise<void> {
    const rows = parsedAggregateReportsToCsvRows(aggregateReports);
    for (const row of rows) {
      this.logger.info(pyJsonDumps(row));
    }
    await this.#drain();
  }

  async saveFailureReportToSyslog(
    failureReports: FailureReport | FailureReport[],
  ): Promise<void> {
    const rows = parsedFailureReportsToCsvRows(failureReports);
    for (const row of rows) {
      this.logger.info(pyJsonDumps(row));
    }
    await this.#drain();
  }

  /** Backward-compatible alias of {@link saveFailureReportToSyslog}. */
  async saveForensicReportToSyslog(
    failureReports: FailureReport | FailureReport[],
  ): Promise<void> {
    await this.saveFailureReportToSyslog(failureReports);
  }

  async saveSmtpTlsReportToSyslog(
    smtpTlsReports: SMTPTLSReport | SMTPTLSReport[],
  ): Promise<void> {
    const rows = parsedSmtpTlsReportsToCsvRows(smtpTlsReports);
    for (const row of rows) {
      this.logger.info(pyJsonDumps(row));
    }
    await this.#drain();
  }

  /**
   * Wait until the messages logged so far have been sent.
   *
   * @throws {SyslogError} When some could not be delivered over TCP or TLS.
   */
  async #drain(): Promise<void> {
    if (this.logHandler instanceof SysLogHandler) {
      await this.logHandler.drain();
      const failures = this.logHandler.takeFailures();
      if (failures !== null) {
        throw new SyslogError(
          `${failures.count} message(s) not sent to ${this.serverName}:${this.serverPort}: ${errorText(failures.error)}`,
          { cause: failures.error },
        );
      }
    }
  }

  /** Remove and close the syslog handler, releasing its socket. */
  async close(): Promise<void> {
    this.logger.removeHandler(this.logHandler);
    if (this.logHandler instanceof SysLogHandler) {
      await this.logHandler.closeAsync();
    } else {
      this.logHandler.close();
    }
  }
}
