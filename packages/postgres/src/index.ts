// Port of parsedmarc/postgres.py, on node-postgres (pg).

import { Client, type ClientConfig, type QueryResultRow } from 'pg';
import {
  type AggregateReport,
  type FailureReport,
  logger,
  pyJsonDumps,
  pyRepr,
  pyStr,
  redactUrlCredentials,
  sanitizeForLog,
  type SMTPTLSReport,
  toSnakeCaseKeys,
  ValueError,
} from 'tsdmarc';

import { canFallBack, resolveConnection } from './connection';
import { parseConnectionString } from './dsn';
import {
  contactInfoToText,
  ensureUtcSuffix,
  inetOrNull,
  int4,
  jsonWithoutNul,
  naiveLocalToTimestamptz,
  normalizeArrivalDate,
  normalizeTimestamp,
  withoutNul,
} from './helpers';
import { DDL_STATEMENTS, SQL } from './sql';

export { DDL_STATEMENTS, SQL } from './sql';

const DEFAULT_PORT = 5432;
const MS_PER_SECOND = 1000;
/** Far past any save; only meant to end a hung query or a silent network. */
const DEFAULT_QUERY_TIMEOUT = 300;
/** pg's error when `query_timeout` expires. */
const QUERY_TIMEOUT_MESSAGE = 'Query read timeout';
const SAMPLE_ADDRESS_TYPES = [
  ['to', 'to'],
  ['cc', 'cc'],
  ['bcc', 'bcc'],
  ['replyTo', 'reply_to'],
] as const;

/** Raised when a PostgreSQL-level error occurs. */
export class PostgreSQLError extends Error {
  override name = 'PostgreSQLError';
}

/** Raised when an identical report already exists in the database. */
export class AlreadySaved extends ValueError {
  override name = 'AlreadySaved';
}

export interface PostgreSQLClientOptions {
  /**
   * A libpq connection string: a URI (`postgresql://user:pass@host/db`) or
   * `key=value` pairs (`host=db dbname=dmarc sslmode=require`). When
   * present, the individual options below are ignored.
   */
  connectionString?: string | null;
  /** Database server hostname or IP address. */
  host?: string | null;
  /** Database server port (default 5432). */
  port?: number;
  /** Database user name. */
  user?: string | null;
  /** Database user password. */
  password?: string | null;
  /** Database name to connect to. */
  database?: string | null;
  /**
   * Seconds to wait for a connection, like libpq's `connect_timeout` (which
   * wins when set in the connection string). Defaults to
   * `PGCONNECT_TIMEOUT`, then psycopg's 130 s; values below 2 become 2, and
   * `0` or less means the default.
   */
  connectTimeout?: number;
  /**
   * Seconds to wait for each statement's result. On expiry the save fails
   * with {@link PostgreSQLError}, the connection is dropped and the next save
   * reconnects. Default: 300; `0` waits forever (as parsedmarc does).
   */
  queryTimeout?: number;
  /**
   * libpq `sslmode`: `disable`, `allow`, `prefer` (the default), `require`,
   * `verify-ca` or `verify-full`. Defaults to `PGSSLMODE`. The TLS options
   * are ignored with `connectionString` (put `sslmode=...` in it instead).
   */
  sslmode?: string | null;
  /**
   * libpq `sslrootcert`: the CA file to verify the server with, or `system`.
   * Defaults to `PGSSLROOTCERT`, then `~/.postgresql/root.crt` if present.
   */
  sslrootcert?: string | null;
  /** libpq `sslcert`: client certificate (`~/.postgresql/postgresql.crt`). */
  sslcert?: string | null;
  /** libpq `sslkey`: client private key (`~/.postgresql/postgresql.key`). */
  sslkey?: string | null;
}

/** A report as it may arrive: any field can be missing (Python `.get()`). */
type Loose<T> = T extends readonly (infer Item)[]
  ? Loose<Item>[]
  : T extends object
    ? { [K in keyof T]?: Loose<T[K]> | null }
    : T;

type Row = Record<string, unknown>;

/** Python truthiness of a JSON value. */
function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

/** `null` for a missing value, as psycopg sends Python's `None`. */
function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function orEmptyList<T>(value: readonly T[] | null | undefined): readonly T[] {
  return value && value.length > 0 ? value : [];
}

/**
 * A JSONB parameter: JSON text as psycopg's `Jsonb` dumps it
 * (`json.dumps()`, exact integers), or `null` for a falsy value.
 */
function jsonb(value: unknown, convertKeys: boolean): string | null {
  if (!isTruthy(value)) {
    return null;
  }
  return jsonWithoutNul(
    pyJsonDumps(convertKeys ? toSnakeCaseKeys(value) : value),
  );
}

/** Raised for a connection string that can't be parsed (parsedmarc's fixed message). */
const INVALID_CONNECTION_STRING_MESSAGE =
  'Invalid PostgreSQL connection_string (details withheld because they may include the password)';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A connection error's message, with the credentials of a URL in it masked. */
function connectErrorMessage(error: unknown): string {
  return redactUrlCredentials(errorMessage(error));
}

/**
 * A client for saving DMARC reports to a PostgreSQL database.
 *
 * Construction doesn't connect; call {@link connect} (or use
 * {@link PostgreSQLClient.create}) to connect up front like parsedmarc.
 * Save methods connect, or reconnect, as needed.
 */
export class PostgreSQLClient {
  readonly #connectionString: string | null;
  readonly #parameters: ReadonlyMap<string, string>;
  readonly #connectTimeout: number | undefined;
  readonly #queryTimeoutMs: number;
  #connection: Client | null = null;
  #closed = true;
  /**
   * Connecting and each transaction run one at a time: they share one pg
   * connection, so concurrent saves would interleave BEGIN/COMMIT (a
   * ROLLBACK undoing another save's rows) or open two connections.
   */
  #lock: Promise<void> = Promise.resolve();

  constructor(options: PostgreSQLClientOptions = {}) {
    this.#connectTimeout = options.connectTimeout;
    this.#queryTimeoutMs =
      (options.queryTimeout ?? DEFAULT_QUERY_TIMEOUT) * MS_PER_SECOND;
    this.#connectionString = options.connectionString || null;
    // Like psycopg's keyword arguments: missing values fall back to the PG*
    // environment variables and libpq's defaults.
    const parameters = new Map<string, string>();
    const keywords = {
      host: options.host,
      port: String(options.port ?? DEFAULT_PORT),
      user: options.user,
      password: options.password,
      dbname: options.database,
      sslmode: options.sslmode,
      sslrootcert: options.sslrootcert,
      sslcert: options.sslcert,
      sslkey: options.sslkey,
    };
    for (const [keyword, value] of Object.entries(keywords)) {
      if (value !== null && value !== undefined) {
        parameters.set(keyword, value);
      }
    }
    this.#parameters = parameters;
  }

  /** Create a client and open its database connection. */
  static async create(
    options: PostgreSQLClientOptions = {},
  ): Promise<PostgreSQLClient> {
    const client = new PostgreSQLClient(options);
    await client.connect();
    return client;
  }

  /**
   * Open a new database connection.
   *
   * @throws {PostgreSQLError} If the connection attempt fails.
   */
  async connect(): Promise<void> {
    await this.#exclusive(() => this.#connect());
  }

  /** Run `task` after every earlier connect/transaction/close has settled. */
  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#lock.then(task);
    this.#lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #connect(): Promise<void> {
    logger.debug('Connecting to PostgreSQL');
    let parameters = this.#parameters;
    if (this.#connectionString !== null) {
      try {
        parameters = parseConnectionString(this.#connectionString);
      } catch {
        // libpq reports a malformed connection string by echoing the whole
        // string, or the fragment it could not parse, and either can
        // contain the password, so the detail is withheld entirely.
        throw new PostgreSQLError(INVALID_CONNECTION_STRING_MESSAGE);
      }
    }
    let attempts: ClientConfig[];
    try {
      attempts = await resolveConnection(parameters, this.#connectTimeout);
    } catch (error) {
      throw new PostgreSQLError(connectErrorMessage(error), { cause: error });
    }
    let lastError: unknown;
    for (const [index, config] of attempts.entries()) {
      if (index > 0) {
        const message = `PostgreSQL connection failed (${connectErrorMessage(lastError)}); retrying ${config.ssl ? 'with' : 'without'} TLS`;
        if (config.ssl) {
          logger.debug(message);
        } else {
          // libpq's `prefer`, which an attacker on the network can force.
          logger.warning(
            `${message}: credentials and reports will travel unencrypted (sslmode=verify-full refuses this and verifies the server)`,
          );
        }
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- attempts are sequential
        await this.#open(config);
        return;
      } catch (error) {
        lastError = error;
        if (!canFallBack(error)) {
          break;
        }
      }
    }
    throw new PostgreSQLError(connectErrorMessage(lastError), {
      cause: lastError,
    });
  }

  async #open(config: ClientConfig): Promise<void> {
    const connection = new Client(
      this.#queryTimeoutMs > 0
        ? { ...config, query_timeout: this.#queryTimeoutMs }
        : config,
    );
    // pg emits 'error' when an idle connection drops; without a listener
    // that would crash the process. Mark it closed so the next save
    // reconnects, as parsedmarc's `_ensure_connected()` does.
    connection.on('error', () => {
      if (this.#connection === connection) {
        this.#closed = true;
      }
    });
    connection.on('end', () => {
      if (this.#connection === connection) {
        this.#closed = true;
      }
    });
    await connection.connect();
    this.#connection = connection;
    this.#closed = false;
  }

  /** Whether the database connection is closed (or was never opened). */
  get closed(): boolean {
    return this.#closed;
  }

  /** Close the database connection if it is open. Safe to call repeatedly. */
  async close(): Promise<void> {
    await this.#exclusive(async () => {
      if (this.#connection !== null && !this.#closed) {
        this.#closed = true;
        await this.#connection.end();
      }
    });
  }

  /**
   * Check the connection and reconnect if necessary: in watch mode the
   * process can run for weeks, and PostgreSQL may drop idle connections.
   */
  async #ensureConnected(): Promise<Client> {
    if (this.#connection !== null && this.#closed) {
      logger.warning('PostgreSQL connection lost — attempting to reconnect');
    }
    if (this.#connection === null || this.#closed) {
      await this.#connect();
    }
    return this.#connection as Client;
  }

  /**
   * Run `body` in a transaction: COMMIT on success, ROLLBACK on error.
   * Transactions are serialized (see `#lock`).
   */
  #transaction(body: (connection: Client) => Promise<void>): Promise<void> {
    return this.#exclusive(async () => {
      const connection = await this.#ensureConnected();
      await this.#query(connection, 'BEGIN');
      try {
        await body(connection);
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined);
        // Anything else (an unexpected value in a report) would escape the
        // documented errors, which callers treat as a failed output.
        if (error instanceof AlreadySaved || error instanceof PostgreSQLError) {
          throw error;
        }
        throw new PostgreSQLError(sanitizeForLog(errorMessage(error)), {
          cause: error,
        });
      }
      await this.#query(connection, 'COMMIT');
    });
  }

  async #query(
    connection: Client,
    text: string,
    values?: unknown[],
  ): Promise<QueryResultRow[]> {
    try {
      // A report may hold a NUL (a sender's encoded-word, a JSON \u0000),
      // and one rejected value would fail the save every time.
      const result = await connection.query(text, values?.map(withoutNul));
      return result.rows;
    } catch (error) {
      if (errorMessage(error) === QUERY_TIMEOUT_MESSAGE) {
        this.#discard(connection);
      }
      // PostgreSQL quotes rejected values, which come from the report.
      throw new PostgreSQLError(sanitizeForLog(errorMessage(error)), {
        cause: error,
      });
    }
  }

  /**
   * Drop a connection whose query timed out: the server may still answer it,
   * so it can't be reused. Not awaited: `end()` destroys the socket, and the
   * next save reconnects.
   */
  #discard(connection: Client): void {
    if (this.#connection === connection) {
      this.#closed = true;
    }
    connection.end().catch(() => undefined);
  }

  async #insertReturningId(
    connection: Client,
    text: string,
    values: unknown[],
  ): Promise<unknown> {
    const [row] = await this.#query(connection, text, values);
    return (row as Row | undefined)?.id;
  }

  /**
   * Creates all required tables and indexes if they do not exist.
   * Idempotent and safe to call on every startup.
   *
   * @throws {PostgreSQLError} If table creation fails.
   */
  async createTables(): Promise<void> {
    await this.#transaction(async connection => {
      for (const statement of DDL_STATEMENTS) {
        await this.#query(connection, statement);
      }
    });
    logger.debug('PostgreSQL tables verified / created');
  }

  /**
   * Saves a parsed aggregate DMARC report.
   *
   * @throws {AlreadySaved} If an identical report is already present.
   * @throws {PostgreSQLError} If a database error occurs.
   */
  async saveAggregateReportToPostgresql(
    aggregateReport: AggregateReport,
  ): Promise<void> {
    const report: Loose<AggregateReport> = aggregateReport;
    const meta = report.reportMetadata ?? {};
    const pub = report.policyPublished ?? {};

    await this.#transaction(async connection => {
      const [row] = await this.#query(connection, SQL.insertAggregateReport, [
        orNull(report.xmlSchema),
        orNull(report.xmlNamespace),
        orNull(meta.orgName),
        orNull(meta.orgEmail),
        orNull(meta.orgExtraContactInfo),
        orNull(meta.generator),
        orNull(meta.reportId),
        orNull(naiveLocalToTimestamptz(meta.beginDate)),
        orNull(naiveLocalToTimestamptz(meta.endDate)),
        orEmptyList(meta.errors),
        orNull(pub.domain),
        orNull(pub.adkim),
        orNull(pub.aspf),
        orNull(pub.p),
        orNull(pub.sp),
        orNull(pub.pct),
        orNull(pub.fo),
        orNull(pub.np),
        orNull(pub.testing),
        orNull(pub.discoveryMethod),
      ]);
      if (row === undefined) {
        throw new AlreadySaved(
          sanitizeForLog(
            `Aggregate report ${pyStr(meta.reportId)} from ${pyStr(meta.orgName)} has already been saved`,
          ),
        );
      }
      const reportDbId = (row as Row).id;

      for (const record of report.records ?? []) {
        if (!record) {
          continue;
        }
        const src = record.source ?? {};
        const pol = record.policyEvaluated ?? {};
        const idens = record.identifiers ?? {};
        const alignment = record.alignment ?? {};
        const recordDbId = await this.#insertReturningId(
          connection,
          SQL.insertAggregateRecord,
          [
            reportDbId,
            orNull(ensureUtcSuffix(record.intervalBegin)),
            orNull(ensureUtcSuffix(record.intervalEnd)),
            inetOrNull(src.ipAddress, 'source_ip_address'),
            orNull(src.country),
            orNull(src.reverseDns),
            orNull(src.baseDomain),
            orNull(src.name),
            orNull(src.type),
            orNull(int4(record.count, 'message_count')),
            orNull(alignment.spf),
            orNull(alignment.dkim),
            orNull(alignment.dmarc),
            orNull(pol.disposition),
            orNull(pol.dkim),
            orNull(pol.spf),
            orNull(idens.headerFrom),
            orNull(idens.envelopeFrom),
            orNull(idens.envelopeTo),
          ],
        );

        for (const dkim of record.authResults?.dkim ?? []) {
          await this.#query(connection, SQL.insertAggregateRecordDkim, [
            recordDbId,
            orNull(dkim?.domain),
            orNull(dkim?.selector),
            orNull(dkim?.result),
            orNull(dkim?.humanResult),
          ]);
        }

        for (const spf of record.authResults?.spf ?? []) {
          await this.#query(connection, SQL.insertAggregateRecordSpf, [
            recordDbId,
            orNull(spf?.domain),
            orNull(spf?.scope),
            orNull(spf?.result),
            orNull(spf?.humanResult),
          ]);
        }

        for (const override of pol.policyOverrideReasons ?? []) {
          await this.#query(
            connection,
            SQL.insertAggregateRecordPolicyOverride,
            [recordDbId, orNull(override?.type), orNull(override?.comment)],
          );
        }
      }
    });
  }

  /**
   * Saves a parsed failure (RUF) DMARC report.
   *
   * @throws {AlreadySaved} If a matching failure report is already present.
   * @throws {PostgreSQLError} If a database error occurs.
   */
  async saveFailureReportToPostgresql(
    failureReport: FailureReport,
  ): Promise<void> {
    const report: Loose<FailureReport> = failureReport;
    const sample = (report.parsedSample ?? {}) as Row;
    const src = report.source ?? {};
    const arrivalDateUtc = orNull(ensureUtcSuffix(report.arrivalDateUtc));
    const sampleSubject = orNull(sample.subject);
    // JSONB values are reused by both the dedup check and the INSERT.
    const sampleHeaders = jsonb(sample.headers, false);
    const sampleFrom = jsonb(sample.from, true);
    const sampleTo = jsonb(sample.to, true);

    await this.#transaction(async connection => {
      // Failure reports have no natural primary key, so mirror the
      // Elasticsearch backend's query-then-insert dedup on the same
      // dimensions: arrival date + From + To + Subject. IS NOT DISTINCT FROM
      // is NULL-safe; JSONB equality is semantic, so key order within the
      // From/To objects doesn't matter.
      const duplicates = await this.#query(
        connection,
        SQL.selectFailureDuplicate,
        [arrivalDateUtc, sampleSubject, sampleFrom, sampleTo],
      );
      if (duplicates.length > 0) {
        throw new AlreadySaved(
          sanitizeForLog(
            `A failure report with subject ${pyRepr(sampleSubject)} arriving at ${pyStr(arrivalDateUtc)} has already been saved`,
          ),
        );
      }
      const reportDbId = await this.#insertReturningId(
        connection,
        SQL.insertFailureReport,
        [
          orNull(report.feedbackType),
          orNull(report.userAgent),
          orNull(report.version),
          orNull(report.originalEnvelopeId),
          orNull(report.originalMailFrom),
          orNull(report.originalRcptTo),
          orNull(normalizeArrivalDate(report.arrivalDate)),
          arrivalDateUtc,
          orNull(report.authenticationResults),
          orNull(report.deliveryResult),
          orEmptyList(report.authFailure),
          orEmptyList(report.authenticationMechanisms),
          orNull(report.dkimDomain),
          orNull(report.reportedDomain),
          orNull(report.sampleHeadersOnly),
          inetOrNull(src.ipAddress, 'source_ip_address'),
          orNull(src.country),
          orNull(src.reverseDns),
          orNull(src.baseDomain),
          orNull(src.name),
          orNull(src.type),
          orNull(report.sample),
          orNull(sample.date),
          sampleSubject,
          orNull(sample.body),
          orNull(sample.hasDefects),
          sampleHeaders,
          sampleFrom,
          sampleTo,
        ],
      );

      for (const [key, addressType] of SAMPLE_ADDRESS_TYPES) {
        const value = sample[key];
        let entries: unknown[] = [];
        if (Array.isArray(value)) {
          entries = value;
        } else if (value !== null && typeof value === 'object') {
          // A recipient header parsed as a single address.
          entries = [value];
        }
        for (const entry of entries as Row[]) {
          await this.#query(connection, SQL.insertFailureSampleAddress, [
            reportDbId,
            addressType,
            orNull(entry.displayName),
            orNull(entry.address),
          ]);
        }
      }
    });
  }

  /** Backward-compatible alias of {@link saveFailureReportToPostgresql}. */
  async saveForensicReportToPostgresql(report: FailureReport): Promise<void> {
    await this.saveFailureReportToPostgresql(report);
  }

  /**
   * Saves a parsed SMTP TLS report.
   *
   * @throws {AlreadySaved} If an identical report is already present.
   * @throws {PostgreSQLError} If a database error occurs.
   */
  async saveSmtpTlsReportToPostgresql(
    smtpTlsReport: SMTPTLSReport,
  ): Promise<void> {
    const report: Loose<SMTPTLSReport> = smtpTlsReport;
    await this.#transaction(async connection => {
      const [row] = await this.#query(connection, SQL.insertSmtpTlsReport, [
        orNull(report.organizationName),
        orNull(normalizeTimestamp(report.beginDate)),
        orNull(normalizeTimestamp(report.endDate)),
        contactInfoToText(report.contactInfo),
        orNull(report.reportId),
      ]);
      if (row === undefined) {
        throw new AlreadySaved(
          sanitizeForLog(
            `SMTP TLS report ${pyStr(report.reportId)} from ${pyStr(report.organizationName)} has already been saved`,
          ),
        );
      }
      const reportDbId = (row as Row).id;

      for (const policy of report.policies ?? []) {
        if (!policy) {
          continue;
        }
        const policyDbId = await this.#insertReturningId(
          connection,
          SQL.insertSmtpTlsPolicy,
          [
            reportDbId,
            orNull(policy.policyDomain),
            orNull(policy.policyType),
            orEmptyList(policy.policyStrings),
            orEmptyList(policy.mxHostPatterns),
            orNull(
              int4(policy.successfulSessionCount, 'successful_session_count'),
            ),
            orNull(int4(policy.failedSessionCount, 'failed_session_count')),
          ],
        );

        for (const detail of policy.failureDetails ?? []) {
          await this.#query(connection, SQL.insertSmtpTlsFailureDetail, [
            policyDbId,
            orNull(detail?.resultType),
            orNull(int4(detail?.failedSessionCount, 'failed_session_count')),
            inetOrNull(detail?.sendingMtaIp, 'sending_mta_ip'),
            inetOrNull(detail?.receivingIp, 'receiving_ip'),
            orNull(detail?.receivingMxHostname),
            orNull(detail?.receivingMxHelo),
            orNull(detail?.additionalInfoUri),
            orNull(detail?.failureReasonCode),
          ]);
        }
      }
    });
  }
}
