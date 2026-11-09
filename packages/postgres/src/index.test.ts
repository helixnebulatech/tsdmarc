// Port of tests/test_postgres.py. pg's Client is the SDK boundary: the
// assertions check the SQL and bound parameters a real server would get.
//
// Not ported: TestPsycopgImportFallback and
// test_missing_psycopg_raises_install_hint. pg is a hard dependency of
// @tsdmarc/postgres, so there is no optional-import fallback to test.

import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type AggregateReport,
  captureLogs,
  type FailureReport,
  parseAggregateReportXml,
  parseSmtpTlsReportJson,
  type SMTPTLSReport,
  toCamelCaseKeys,
  ValueError,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AlreadySaved,
  DDL_STATEMENTS,
  PostgreSQLClient,
  PostgreSQLError,
} from './index';

interface Executed {
  text: string;
  values: unknown[];
}

/** What a RETURNING / SELECT query yields next: an id, or `null` (no row). */
type QueuedResult = number | null | Error;

const pg = vi.hoisted(() => {
  const state = {
    clients: [] as FakeClient[],
    queue: [] as QueuedResult[],
    connectError: null as Error | null,
    /** Errors for the next connect() calls, in order. */
    connectErrors: [] as Error[],
    queryError: null as Error | null,
    nextId: 1000,
  };
  const TRANSACTION = new Set(['BEGIN', 'COMMIT', 'ROLLBACK']);
  // A real EventEmitter is needed for on('error'/'end'); import lazily.
  let EmitterClass: typeof EventEmitter | undefined;
  class FakeClient {
    readonly config: Record<string, unknown>;
    readonly log: string[] = [];
    readonly executed: Executed[] = [];
    readonly emitter: EventEmitter;
    readonly connect = vi.fn(() => {
      const error = state.connectErrors.shift() ?? state.connectError;
      return error ? Promise.reject(error) : Promise.resolve();
    });
    readonly end = vi.fn(() => {
      this.emitter.emit('end');
      return Promise.resolve();
    });
    readonly query = vi.fn((text: string, values?: unknown[]) => {
      this.log.push(TRANSACTION.has(text) ? text : 'SQL');
      if (TRANSACTION.has(text)) {
        return Promise.resolve({ rows: [] });
      }
      this.executed.push({ text, values: values ?? [] });
      if (state.queryError) {
        return Promise.reject(state.queryError);
      }
      if (!/\bRETURNING\b|^\s*SELECT\b/u.test(text)) {
        return Promise.resolve({ rows: [] });
      }
      const next =
        state.queue.length > 0
          ? state.queue.shift()
          : text.includes('RETURNING')
            ? (state.nextId += 1)
            : null;
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve({
        rows: next === null || next === undefined ? [] : [{ id: next }],
      });
    });
    constructor(config: Record<string, unknown>) {
      if (!EmitterClass) {
        throw new Error('EventEmitter not set');
      }
      this.config = config;
      this.emitter = new EmitterClass();
      state.clients.push(this);
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.emitter.on(event, listener);
      return this;
    }
  }
  return {
    FakeClient,
    setEmitter(emitter: typeof EventEmitter): void {
      EmitterClass = emitter;
    },
    state,
  };
});

type FakeClient = InstanceType<typeof pg.FakeClient>;

vi.mock('pg', () => ({ Client: pg.FakeClient }));
pg.setEmitter(EventEmitter);

const FIXTURES = new URL('../../../fixtures/', import.meta.url);
const PG_ENV = [
  'PGHOST',
  'PGPORT',
  'PGSSLMODE',
  'PGSSLROOTCERT',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGCONNECT_TIMEOUT',
];

function lastConnection(): FakeClient {
  const connection = pg.state.clients.at(-1);
  if (!connection) {
    throw new Error('no pg Client created');
  }
  return connection;
}

async function makeClient(): Promise<{
  client: PostgreSQLClient;
  connection: FakeClient;
}> {
  const client = await PostgreSQLClient.create({
    host: 'localhost',
    database: 'test',
    user: 'test',
    password: 'test',
  });
  return { client, connection: lastConnection() };
}

function sqlOf(connection: FakeClient): string[] {
  return connection.executed.map(call => call.text);
}

/**
 * Map an INSERT's column names to the bound values, so tests assert by
 * column name instead of fragile positional indices.
 */
function namedParams(call: Executed | undefined): Record<string, unknown> {
  if (!call) {
    throw new Error('statement not executed');
  }
  const match = /\(([^)]*?)\)\s*VALUES/su.exec(call.text);
  if (!match?.[1]) {
    throw new Error(`not an INSERT: ${call.text}`);
  }
  const columns = match[1]
    .split(',')
    .map(column => column.trim())
    .filter(Boolean);
  expect(columns).toHaveLength(call.values.length);
  return Object.fromEntries(
    columns.map((column, index) => [column, call.values[index]]),
  );
}

function placeholdersMatchValues(call: Executed): void {
  const placeholders = new Set(call.text.match(/\$\d+/gu));
  expect(placeholders.size).toBe(call.values.length);
}

function loadFixtures(directory: string): Record<string, unknown>[] {
  const url = new URL(`${directory}/`, FIXTURES);
  return readdirSync(url)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const fixture = JSON.parse(readFileSync(new URL(name, url), 'utf8')) as {
        result?: { report: unknown };
      };
      return fixture.result?.report;
    })
    .filter(report => report !== undefined)
    .flatMap(report => (Array.isArray(report) ? report : [report]))
    .map(report => toCamelCaseKeys(report) as Record<string, unknown>);
}

beforeEach(() => {
  pg.state.clients.length = 0;
  pg.state.queue = [];
  pg.state.connectError = null;
  pg.state.connectErrors = [];
  pg.state.queryError = null;
  // Keep the developer's ~/.postgresql and PG* variables out of the tests.
  vi.stubEnv('HOME', mkdtempSync(path.join(tmpdir(), 'tsdmarc-pg-home-')));
  for (const name of PG_ENV) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PostgreSQL client construction', () => {
  it('connects with the individual parameters', async () => {
    const { connection } = await makeClient();
    // libpq's default sslmode=prefer: TLS first, without verification.
    expect(connection.config).toEqual({
      connectionTimeoutMillis: 130_000,
      query_timeout: 300_000,
      keepAlive: true,
      host: 'localhost',
      port: 5432,
      user: 'test',
      password: 'test',
      database: 'test',
      ssl: { rejectUnauthorized: false },
    });
    expect(pg.state.clients).toHaveLength(1);
    expect(connection.connect).toHaveBeenCalledTimes(1);
  });

  it('leaves missing parameters to the PG* environment defaults', async () => {
    await PostgreSQLClient.create({ connectTimeout: 5 });
    const { config } = lastConnection();
    expect(config).toMatchObject({
      connectionTimeoutMillis: 5000,
      query_timeout: 300_000,
      port: 5432,
      user: undefined,
      password: undefined,
      database: undefined,
      ssl: false,
    });
    // Like libpq: the Unix socket directory, not TCP localhost.
    expect(config.host).toMatch(/^\//u);
  });

  it('takes the host and TLS settings from PG* variables', async () => {
    vi.stubEnv('PGHOST', 'db.example');
    vi.stubEnv('PGSSLMODE', 'require');
    await PostgreSQLClient.create();
    expect(pg.state.clients).toHaveLength(1);
    expect(lastConnection().config).toMatchObject({
      host: 'db.example',
      ssl: { rejectUnauthorized: false },
    });
  });

  it('accepts sslmode and sslrootcert options', async () => {
    await expect(
      PostgreSQLClient.create({ host: 'db', sslmode: 'verify-full' }),
    ).rejects.toThrow(/^root certificate file ".*root\.crt" does not exist/u);
    await PostgreSQLClient.create({ host: 'db', sslmode: 'disable' });
    expect(lastConnection().config.ssl).toBe(false);
  });

  it('falls back to plain when the server refuses TLS (prefer)', async () => {
    pg.state.connectErrors = [
      new Error('The server does not support SSL connections'),
    ];
    const client = await PostgreSQLClient.create({ host: 'db' });
    expect(client.closed).toBe(false);
    expect(pg.state.clients.map(connection => connection.config.ssl)).toEqual([
      { rejectUnauthorized: false },
      false,
    ]);
  });

  it('does not retry without TLS when the server is unreachable', async () => {
    pg.state.connectErrors = [
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), {
        syscall: 'connect',
      }),
    ];
    await expect(PostgreSQLClient.create({ host: 'db' })).rejects.toThrow(
      new PostgreSQLError('connect ECONNREFUSED 10.0.0.1:5432'),
    );
    expect(pg.state.clients).toHaveLength(1);
  });

  it('closes an open connection and is a no-op once closed', async () => {
    const { client, connection } = await makeClient();
    expect(client.closed).toBe(false);
    await client.close();
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(true);
    await client.close();
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  it('reconnects when the connection was lost', async () => {
    const { client, connection } = await makeClient();
    // pg emits 'error' then 'end' when the server drops the connection.
    connection.emitter.emit('error', new Error('terminating connection'));
    expect(client.closed).toBe(true);
    const logs = captureLogs();
    try {
      await client.saveSmtpTlsReportToPostgresql({
        policies: [],
      } as unknown as SMTPTLSReport);
      expect(logs.output).toContain(
        'WARNING:tsdmarc:PostgreSQL connection lost — attempting to reconnect',
      );
    } finally {
      logs.restore();
    }
    expect(pg.state.clients).toHaveLength(2);
    expect(lastConnection().executed).toHaveLength(1);
    expect(connection.executed).toHaveLength(0);
  });

  it('connects on first use without the reconnect warning', async () => {
    const client = new PostgreSQLClient({ host: 'h' });
    expect(pg.state.clients).toHaveLength(0);
    const logs = captureLogs();
    try {
      await client.createTables();
      expect(logs.output.some(line => line.startsWith('WARNING'))).toBe(false);
    } finally {
      logs.restore();
    }
    expect(pg.state.clients).toHaveLength(1);
  });

  it('uses a URI connection string instead of the options', async () => {
    await PostgreSQLClient.create({
      connectionString: 'postgresql://u:p@h/db?sslmode=disable',
      host: 'ignored',
    });
    expect(lastConnection().config).toEqual({
      connectionTimeoutMillis: 130_000,
      query_timeout: 300_000,
      keepAlive: true,
      host: 'h',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'db',
      ssl: false,
    });
  });

  it('applies libpq semantics to a key=value connection string', async () => {
    await PostgreSQLClient.create({
      connectionString:
        "host=db.example port=5433 user=dmarc password='p w\\'d' dbname=reports sslmode=require connect_timeout=5",
      connectTimeout: 60,
    });
    // pg-connection-string would verify the certificate for
    // sslmode=require; libpq only encrypts.
    expect(lastConnection().config).toEqual({
      connectionTimeoutMillis: 5000,
      query_timeout: 300_000,
      keepAlive: true,
      host: 'db.example',
      port: 5433,
      user: 'dmarc',
      password: "p w'd",
      database: 'reports',
      ssl: { rejectUnauthorized: false },
    });
  });

  // parsedmarc's test_malformed_connection_string_detail_withheld and
  // test_real_psycopg_malformed_connection_string_withheld: libpq quotes the
  // string, or the fragment it could not parse, so the detail is withheld.
  it.each([
    'host',
    'postgresql://u:PGSECRET@[::1/db',
    'postgresql://u:PG%ZZSECRET@h/db',
    'postgresql://u:PGSECRET@[::1]x/db',
    "host=h password='PGSECRET",
  ])('withholds the detail of a malformed connection string: %s', async dsn => {
    const error: unknown = await PostgreSQLClient.create({
      connectionString: dsn,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgreSQLError);
    expect((error as PostgreSQLError).message).toBe(
      'Invalid PostgreSQL connection_string (details withheld because they may include the password)',
    );
    expect((error as PostgreSQLError).cause).toBeUndefined();
    expect(String((error as PostgreSQLError).stack)).not.toContain('SECRET');
    expect(pg.state.clients).toHaveLength(0);
  });

  it('wraps a connection failure in PostgreSQLError', async () => {
    pg.state.connectError = new Error('refused');
    await expect(
      PostgreSQLClient.create({ host: 'localhost' }),
    ).rejects.toThrow(new PostgreSQLError('refused'));
  });

  it('test_connect_failure_detail_is_url_redacted', async () => {
    pg.state.connectError = new Error(
      'connection to "postgresql://u:PGSECRET@db.example/x" failed',
    );
    const error: unknown = await PostgreSQLClient.create({
      connectionString: 'postgresql://u:PGSECRET@h/db?sslmode=disable',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgreSQLError);
    expect((error as PostgreSQLError).message).not.toContain('PGSECRET');
    expect((error as PostgreSQLError).message).toContain('u:***@db.example/x');
  });

  it('AlreadySaved is a ValueError, like Python', () => {
    expect(new AlreadySaved('x')).toBeInstanceOf(ValueError);
  });
});

describe('PostgreSQL TLS fallback', () => {
  it('warns when sslmode=prefer falls back to plain text', async () => {
    pg.state.connectErrors = [new Error('The server does not support SSL')];
    const logs = captureLogs();
    try {
      await PostgreSQLClient.create({ host: 'db', password: 'S3cret' });
    } finally {
      logs.restore();
    }
    expect(pg.state.clients.map(client => client.config.ssl)).toEqual([
      { rejectUnauthorized: false },
      false,
    ]);
    expect(logs.output).toContain(
      'WARNING:tsdmarc:PostgreSQL connection failed (The server does not support SSL); retrying without TLS: credentials and reports will travel unencrypted (sslmode=verify-full refuses this and verifies the server)',
    );
  });
});

describe('PostgreSQL concurrency', () => {
  const smtpTls = (reportId: string): SMTPTLSReport =>
    ({
      organizationName: 'org',
      reportId,
      policies: [{ policyDomain: 'example.com', failureDetails: [] }],
    }) as unknown as SMTPTLSReport;

  it('runs concurrent saves one transaction at a time', async () => {
    const { client, connection } = await makeClient();
    await Promise.all([
      client.saveSmtpTlsReportToPostgresql(smtpTls('a')),
      client.saveSmtpTlsReportToPostgresql(smtpTls('b')),
      client.createTables(),
    ]);
    const log = connection.log.join(' ');
    const ddl = Array.from(DDL_STATEMENTS, () => 'SQL').join(' ');
    expect(log).toBe(
      `BEGIN SQL SQL COMMIT BEGIN SQL SQL COMMIT BEGIN ${ddl} COMMIT`,
    );
  });

  it("a failed save's ROLLBACK doesn't undo a concurrent save", async () => {
    const { client, connection } = await makeClient();
    // The first report's INSERT finds a duplicate (no row returned).
    pg.state.queue = [null];
    const results = await Promise.allSettled([
      client.saveSmtpTlsReportToPostgresql(smtpTls('dup')),
      client.saveSmtpTlsReportToPostgresql(smtpTls('new')),
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]?.status).toBe('fulfilled');
    expect(connection.log).toEqual([
      'BEGIN',
      'SQL',
      'ROLLBACK',
      'BEGIN',
      'SQL',
      'SQL',
      'COMMIT',
    ]);
  });

  it('opens one connection for concurrent saves on a closed client', async () => {
    const client = new PostgreSQLClient({ host: 'h', sslmode: 'disable' });
    await Promise.all([
      client.saveSmtpTlsReportToPostgresql(smtpTls('a')),
      client.saveSmtpTlsReportToPostgresql(smtpTls('b')),
    ]);
    expect(pg.state.clients).toHaveLength(1);
  });

  it('createTables issues every CREATE TABLE and the indexes', async () => {
    const { client, connection } = await makeClient();
    await client.createTables();
    const executed = sqlOf(connection).join(' ');
    for (const table of [
      'dmarc_aggregate_report',
      'dmarc_aggregate_record',
      'dmarc_aggregate_record_dkim',
      'dmarc_aggregate_record_spf',
      'dmarc_aggregate_record_policy_override',
      'dmarc_failure_report',
      'dmarc_failure_sample_address',
      'smtp_tls_report',
      'smtp_tls_policy',
      'smtp_tls_failure_detail',
    ]) {
      expect(executed).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(executed).toContain('CREATE INDEX IF NOT EXISTS');
    expect(sqlOf(connection)).toEqual(DDL_STATEMENTS);
    // All DDL runs in one transaction.
    expect(connection.log[0]).toBe('BEGIN');
    expect(connection.log.at(-1)).toBe('COMMIT');
  });

  it('createTables indexes every foreign key', async () => {
    // PostgreSQL does not index the referencing column of a foreign key
    // (PostgreSQL docs, "Foreign Keys"), so without an index a per-record
    // lookup scans the whole child table.
    const { client, connection } = await makeClient();
    await client.createTables();
    const statements = sqlOf(connection);
    const foreignKeys = new Set<string>();
    for (const statement of statements) {
      const table = /CREATE TABLE IF NOT EXISTS (\w+)/u.exec(statement);
      if (table) {
        for (const match of statement.matchAll(
          /^\s*(\w+)[^\n]*\n?\s*REFERENCES/gimu,
        )) {
          foreignKeys.add(`${table[1]}.${match[1]}`);
        }
      }
    }
    const indexed = new Set(
      statements
        .map(statement => /ON (\w+) \((\w+)\)/u.exec(statement))
        .filter(match => match !== null)
        .map(match => `${match[1]}.${match[2]}`),
    );
    // Every REFERENCES must be attributed to a column, so a layout the
    // column regex misses fails here instead of passing.
    const references = statements.reduce(
      (total, statement) =>
        total + (statement.match(/\bREFERENCES\b/giu)?.length ?? 0),
      0,
    );
    expect(foreignKeys.size).toBe(references);
    expect([...foreignKeys].filter(key => !indexed.has(key))).toEqual([]);
  });

  it('createTables wraps a driver error and rolls back', async () => {
    const { client, connection } = await makeClient();
    pg.state.queryError = new Error('ddl boom');
    await expect(client.createTables()).rejects.toThrow(
      new PostgreSQLError('ddl boom'),
    );
    expect(connection.log).toEqual(['BEGIN', 'SQL', 'ROLLBACK']);
  });
});

describe('PostgreSQL saves', () => {
  it('saves an aggregate report with its records and auth results', async () => {
    const { client, connection } = await makeClient();
    pg.state.queue = [1, 10];
    const report = {
      xmlSchema: '1.0',
      xmlNamespace: 'urn:ietf:params:xml:ns:dmarc-2.0',
      reportMetadata: {
        orgName: 'Example Inc.',
        orgEmail: 'dmarc@example.com',
        orgExtraContactInfo: null,
        reportId: 'rpt-123',
        beginDate: '2024-01-15 00:00:00',
        endDate: '2024-01-15 23:59:59',
        errors: [],
        generator: 'ExampleReporter/2.0',
      },
      policyPublished: {
        domain: 'example.com',
        adkim: 'r',
        aspf: 'r',
        p: 'none',
        sp: 'none',
        pct: '100',
        fo: '0',
        np: 'reject',
        testing: 'y',
        discoveryMethod: 'treewalk',
      },
      records: [
        {
          source: {
            ipAddress: '203.0.113.1',
            country: 'US',
            reverseDns: 'mail.example.com',
            baseDomain: 'example.com',
            name: null,
            type: null,
          },
          count: 5,
          alignment: { spf: true, dkim: true, dmarc: true },
          policyEvaluated: {
            disposition: 'none',
            dkim: 'pass',
            spf: 'pass',
            policyOverrideReasons: [
              { type: 'local_policy', comment: 'forwarded' },
            ],
          },
          identifiers: {
            headerFrom: 'example.com',
            envelopeFrom: 'example.com',
            envelopeTo: null,
          },
          intervalBegin: '2024-01-15 00:00:00',
          intervalEnd: '2024-01-15 23:59:59',
          authResults: {
            dkim: [
              {
                domain: 'example.com',
                selector: 's1',
                result: 'pass',
                humanResult: 'valid signature',
              },
            ],
            spf: [
              {
                domain: 'example.com',
                scope: 'mfrom',
                result: 'pass',
                humanResult: null,
              },
            ],
          },
        },
      ],
    } as unknown as AggregateReport;

    await client.saveAggregateReportToPostgresql(report);

    const sqls = sqlOf(connection);
    expect(sqls[0]).toContain('dmarc_aggregate_report');
    expect(sqls[1]).toContain('dmarc_aggregate_record');
    for (const call of connection.executed) {
      placeholdersMatchValues(call);
    }
    expect(connection.log).toEqual([
      'BEGIN',
      'SQL',
      'SQL',
      'SQL',
      'SQL',
      'SQL',
      'COMMIT',
    ]);

    // Every report column, including the RFC 9990 fields.
    expect(namedParams(connection.executed[0])).toEqual({
      xml_schema: '1.0',
      xml_namespace: 'urn:ietf:params:xml:ns:dmarc-2.0',
      org_name: 'Example Inc.',
      org_email: 'dmarc@example.com',
      org_extra_contact_info: null,
      generator: 'ExampleReporter/2.0',
      report_id: 'rpt-123',
      begin_date: '2024-01-15T00:00:00+00:00',
      end_date: '2024-01-15T23:59:59+00:00',
      errors: [],
      domain: 'example.com',
      adkim: 'r',
      aspf: 'r',
      policy: 'none',
      subdomain_policy: 'none',
      pct: '100',
      fo: '0',
      np: 'reject',
      testing: 'y',
      discovery_method: 'treewalk',
    });
    expect(connection.executed[0]?.text).toMatch(
      /ON CONFLICT \(org_name, report_id, domain,\s+begin_date, end_date\)\s+DO NOTHING\s+RETURNING id/u,
    );

    expect(namedParams(connection.executed[1])).toEqual({
      report_id: 1,
      interval_begin: '2024-01-15 00:00:00+00',
      interval_end: '2024-01-15 23:59:59+00',
      source_ip_address: '203.0.113.1',
      source_country: 'US',
      source_reverse_dns: 'mail.example.com',
      source_base_domain: 'example.com',
      source_name: null,
      source_type: null,
      message_count: 5,
      spf_aligned: true,
      dkim_aligned: true,
      dmarc_passed: true,
      disposition: 'none',
      policy_dkim: 'pass',
      policy_spf: 'pass',
      header_from: 'example.com',
      envelope_from: 'example.com',
      envelope_to: null,
    });

    const dkim = connection.executed.find(call =>
      call.text.includes('dmarc_aggregate_record_dkim'),
    );
    expect(namedParams(dkim)).toEqual({
      record_id: 10,
      domain: 'example.com',
      selector: 's1',
      result: 'pass',
      human_result: 'valid signature',
    });
    const spf = connection.executed.find(call =>
      call.text.includes('dmarc_aggregate_record_spf'),
    );
    expect(namedParams(spf)).toEqual({
      record_id: 10,
      domain: 'example.com',
      scope: 'mfrom',
      result: 'pass',
      human_result: null,
    });
    const override = connection.executed.find(call =>
      call.text.includes('dmarc_aggregate_record_policy_override'),
    );
    expect(namedParams(override)).toEqual({
      record_id: 10,
      override_type: 'local_policy',
      comment: 'forwarded',
    });
  });

  it('raises AlreadySaved when ON CONFLICT returns no row', async () => {
    const { client, connection } = await makeClient();
    pg.state.queue = [null];
    const report = {
      reportMetadata: {
        orgName: 'Dup Inc.',
        reportId: 'dup-001',
        beginDate: '2024-01-01 00:00:00',
        endDate: '2024-01-01 23:59:59',
      },
      policyPublished: { domain: 'example.com' },
      records: [],
    } as unknown as AggregateReport;
    await expect(
      client.saveAggregateReportToPostgresql(report),
    ).rejects.toThrow(
      new AlreadySaved(
        'Aggregate report dup-001 from Dup Inc. has already been saved',
      ),
    );
    expect(connection.log).toEqual(['BEGIN', 'SQL', 'ROLLBACK']);
  });

  it('normalizes report and record timestamps', async () => {
    // Report dates get the local offset; record intervals get +00.
    const previous = process.env.TZ;
    process.env.TZ = 'Europe/Warsaw';
    const { client, connection } = await makeClient();
    try {
      await client.saveAggregateReportToPostgresql({
        reportMetadata: {
          orgName: 'TZ Test',
          reportId: 'tz-001',
          beginDate: '2024-01-15 00:00:00',
          endDate: '2024-07-15 23:59:59',
        },
        policyPublished: { domain: 'example.com' },
        records: [
          {
            source: {},
            count: 1,
            alignment: {},
            policyEvaluated: {},
            identifiers: { headerFrom: 'example.com' },
            intervalBegin: '2024-01-15 00:00:00',
            intervalEnd: '2024-01-15 23:59:59',
            authResults: { dkim: [], spf: [] },
          },
        ],
      } as unknown as AggregateReport);
    } finally {
      process.env.TZ = previous;
    }
    const reportParams = namedParams(connection.executed[0]);
    expect(reportParams.begin_date).toBe('2024-01-15T00:00:00+01:00');
    expect(reportParams.end_date).toBe('2024-07-15T23:59:59+02:00');
    const recordParams = namedParams(connection.executed[1]);
    expect(recordParams.interval_begin).toBe('2024-01-15 00:00:00+00');
    expect(recordParams.interval_end).toBe('2024-01-15 23:59:59+00');
  });

  it('saves a failure report after the dedup check', async () => {
    const { client, connection } = await makeClient();
    // Dedup SELECT finds nothing, then the INSERT returns id 1.
    pg.state.queue = [null, 1];
    const report = {
      feedbackType: 'auth-failure',
      userAgent: 'test/1.0',
      version: '1',
      originalEnvelopeId: null,
      originalMailFrom: 'sender@example.com',
      originalRcptTo: 'receiver@example.com',
      arrivalDate: 'Mon, 15 Jan 2024 10:30:00 +0000',
      arrivalDateUtc: '2024-01-15 10:30:00',
      authenticationResults: 'spf=pass',
      deliveryResult: null,
      authFailure: ['dkim'],
      authenticationMechanisms: [],
      dkimDomain: 'example.com',
      reportedDomain: 'example.com',
      sampleHeadersOnly: false,
      source: {
        ipAddress: '203.0.113.1',
        country: 'US',
        reverseDns: 'mail.example.com',
        baseDomain: 'example.com',
        name: null,
        type: null,
      },
      sample: 'raw email content',
      parsedSample: {
        date: '2024-01-15',
        subject: 'Test',
        body: 'Hello',
        hasDefects: false,
        headers: { From: 'sender@example.com', 'X-Mailer_Name': 'x' },
        from: { displayName: 'Sender', address: 'sender@example.com' },
        to: [{ displayName: 'Receiver', address: 'receiver@example.com' }],
        cc: [],
        bcc: [],
        replyTo: [],
      },
    } as unknown as FailureReport;

    await client.saveFailureReportToPostgresql(report);

    const sqls = sqlOf(connection);
    expect(sqls[0]).toContain('SELECT');
    expect(sqls[0]).toContain('dmarc_failure_report');
    expect(connection.executed[0]?.values).toEqual([
      '2024-01-15 10:30:00+00',
      'Test',
      // psycopg's Jsonb dumps with json.dumps() (default separators).
      '{"display_name": "Sender", "address": "sender@example.com"}',
      '[{"display_name": "Receiver", "address": "receiver@example.com"}]',
    ]);
    const insert = connection.executed.find(call =>
      call.text.includes('INSERT INTO dmarc_failure_report'),
    );
    expect(insert).toBeDefined();
    if (insert) {
      placeholdersMatchValues(insert);
    }
    expect(namedParams(insert)).toEqual({
      feedback_type: 'auth-failure',
      user_agent: 'test/1.0',
      version: '1',
      original_envelope_id: null,
      original_mail_from: 'sender@example.com',
      original_rcpt_to: 'receiver@example.com',
      arrival_date: '2024-01-15 10:30:00+00',
      arrival_date_utc: '2024-01-15 10:30:00+00',
      authentication_results: 'spf=pass',
      delivery_result: null,
      auth_failure: ['dkim'],
      authentication_mechanisms: [],
      dkim_domain: 'example.com',
      reported_domain: 'example.com',
      sample_headers_only: false,
      source_ip_address: '203.0.113.1',
      source_country: 'US',
      source_reverse_dns: 'mail.example.com',
      source_base_domain: 'example.com',
      source_name: null,
      source_type: null,
      sample: 'raw email content',
      sample_date: '2024-01-15',
      sample_subject: 'Test',
      sample_body: 'Hello',
      sample_has_defects: false,
      // Header names are data and keep their case and punctuation.
      sample_headers: '{"From": "sender@example.com", "X-Mailer_Name": "x"}',
      sample_from:
        '{"display_name": "Sender", "address": "sender@example.com"}',
      sample_to:
        '[{"display_name": "Receiver", "address": "receiver@example.com"}]',
    });
    const addresses = connection.executed.filter(call =>
      call.text.includes('dmarc_failure_sample_address'),
    );
    expect(addresses.map(call => namedParams(call))).toEqual([
      {
        report_id: 1,
        address_type: 'to',
        display_name: 'Receiver',
        address: 'receiver@example.com',
      },
    ]);
  });

  it('raises AlreadySaved for a duplicate failure report', async () => {
    const { client, connection } = await makeClient();
    // The dedup SELECT returns a row.
    pg.state.queue = [1];
    await expect(
      client.saveFailureReportToPostgresql({
        arrivalDateUtc: '2024-01-15 10:30:00',
        reportedDomain: 'example.com',
        source: { ipAddress: '203.0.113.1' },
        parsedSample: { subject: "It's a test" },
      } as unknown as FailureReport),
    ).rejects.toThrow(
      new AlreadySaved(
        `A failure report with subject "It's a test" arriving at 2024-01-15 10:30:00+00 has already been saved`,
      ),
    );
    expect(connection.executed).toHaveLength(1);
    expect(connection.executed[0]?.values).toEqual([
      '2024-01-15 10:30:00+00',
      "It's a test",
      null,
      null,
    ]);
  });

  it('uses None in the duplicate message for a missing subject', async () => {
    const { client } = await makeClient();
    pg.state.queue = [1];
    await expect(
      client.saveFailureReportToPostgresql({
        parsedSample: {},
      } as unknown as FailureReport),
    ).rejects.toThrow(
      new AlreadySaved(
        'A failure report with subject None arriving at None has already been saved',
      ),
    );
  });

  it('saves an SMTP TLS report with policies and failure details', async () => {
    const { client, connection } = await makeClient();
    pg.state.queue = [1, 10];
    const report = {
      organizationName: 'Example Inc.',
      beginDate: '2024-01-15T00:00:00Z',
      endDate: '2024-01-16T00:00:00Z',
      contactInfo: 'admin@example.com',
      reportId: 'tls-001',
      policies: [
        {
          policyDomain: 'example.com',
          policyType: 'sts',
          policyStrings: ['version: STSv1'],
          mxHostPatterns: ['*.example.com'],
          successfulSessionCount: 100,
          failedSessionCount: 2,
          failureDetails: [
            {
              resultType: 'certificate-expired',
              failedSessionCount: 2,
              sendingMtaIp: '203.0.113.1',
              receivingIp: '198.51.100.1',
              receivingMxHostname: 'mx.example.com',
              receivingMxHelo: 'mx.example.com',
              additionalInfoUri: null,
              failureReasonCode: null,
            },
          ],
        },
      ],
    } as unknown as SMTPTLSReport;

    await client.saveSmtpTlsReportToPostgresql(report);

    const sqls = sqlOf(connection);
    expect(sqls[0]).toContain('smtp_tls_report');
    expect(sqls[1]).toContain('smtp_tls_policy');
    expect(sqls[2]).toContain('smtp_tls_failure_detail');
    expect(namedParams(connection.executed[0])).toEqual({
      organization_name: 'Example Inc.',
      begin_date: '2024-01-15T00:00:00Z',
      end_date: '2024-01-16T00:00:00Z',
      contact_info: 'admin@example.com',
      report_id: 'tls-001',
    });
    // Policy field mapping must reach the INSERT (regression guard).
    expect(namedParams(connection.executed[1])).toEqual({
      report_id: 1,
      policy_domain: 'example.com',
      policy_type: 'sts',
      policy_strings: ['version: STSv1'],
      mx_host_patterns: ['*.example.com'],
      successful_session_count: 100,
      failed_session_count: 2,
    });
    expect(namedParams(connection.executed[2])).toEqual({
      policy_id: 10,
      result_type: 'certificate-expired',
      failed_session_count: 2,
      sending_mta_ip: '203.0.113.1',
      receiving_ip: '198.51.100.1',
      receiving_mx_hostname: 'mx.example.com',
      receiving_mx_helo: 'mx.example.com',
      additional_info_uri: null,
      failure_reason_code: null,
    });
  });

  it('sends blank failure-detail fields as NULL (parsedmarc #915)', async () => {
    // samples/smtp_tls/empty_failure_detail_fields.json has sending-mta-ip,
    // receiving-ip, ... sent as "": not a valid INET value. The parser turns
    // them into null; this goes through parsedmarc's own parsed output.
    const { client, connection } = await makeClient();
    pg.state.queue = [1, 10];
    const fixture = JSON.parse(
      readFileSync(
        new URL('smtp_tls/empty_failure_detail_fields.json.json', FIXTURES),
        'utf8',
      ),
    ) as { result: { report: unknown } };
    await client.saveSmtpTlsReportToPostgresql(
      toCamelCaseKeys(fixture.result.report) as SMTPTLSReport,
    );
    expect(sqlOf(connection)[2]).toContain('smtp_tls_failure_detail');
    const detail = namedParams(connection.executed[2]);
    expect(detail.sending_mta_ip).toBeNull();
    expect(detail.receiving_ip).toBeNull();
    expect(detail.receiving_mx_hostname).toBeNull();
    expect(detail.additional_info_uri).toBeNull();
    // A non-blank optional field is preserved.
    expect(detail.failure_reason_code).toBe('no-policy-served');
    // Required fields are preserved.
    expect(detail.result_type).toBe('sts-policy-fetch-error');
    expect(detail.failed_session_count).toBe(1);
  });

  it('raises AlreadySaved for a duplicate SMTP TLS report', async () => {
    const { client } = await makeClient();
    pg.state.queue = [null];
    await expect(
      client.saveSmtpTlsReportToPostgresql({
        organizationName: 'Dup Inc.',
        beginDate: '2024-01-01T00:00:00Z',
        endDate: '2024-01-02T00:00:00Z',
        contactInfo: 'admin@dup.com',
        reportId: 'dup-tls-001',
        policies: [],
      }),
    ).rejects.toThrow(
      new AlreadySaved(
        'SMTP TLS report dup-tls-001 from Dup Inc. has already been saved',
      ),
    );
  });

  it('joins a contact_info list before the insert', async () => {
    const { client, connection } = await makeClient();
    pg.state.queue = [1];
    await client.saveSmtpTlsReportToPostgresql({
      organizationName: 'Multi Inc.',
      beginDate: '2024-01-15T00:00:00Z',
      endDate: '2024-01-16T00:00:00Z',
      contactInfo: ['admin@multi.com', 'abuse@multi.com'],
      reportId: 'multi-001',
      policies: [],
    });
    expect(connection.executed[0]?.values[3]).toBe(
      'admin@multi.com, abuse@multi.com',
    );
  });

  it('wraps a recipient parsed as a single address', async () => {
    const { client, connection } = await makeClient();
    pg.state.queue = [null, 1];
    await client.saveFailureReportToPostgresql({
      arrivalDateUtc: '2024-01-15 10:30:00',
      reportedDomain: 'example.com',
      source: { ipAddress: '203.0.113.1' },
      parsedSample: {
        subject: 'Single',
        // 'to' as a lone object rather than a list.
        to: { displayName: 'Solo', address: 'solo@example.com' },
      },
    } as unknown as FailureReport);
    const addresses = connection.executed.filter(call =>
      call.text.includes('dmarc_failure_sample_address'),
    );
    expect(addresses).toHaveLength(1);
    expect(addresses[0]?.values).toContain('solo@example.com');
  });

  it('indexes the Reply-To address', async () => {
    // The Grafana PostgreSQL failure panel aggregates these rows for its
    // 'Reply To' column.
    const { client, connection } = await makeClient();
    pg.state.queue = [null, 1];
    await client.saveFailureReportToPostgresql({
      arrivalDateUtc: '2024-01-15 10:30:00',
      reportedDomain: 'example.com',
      source: { ipAddress: '203.0.113.1' },
      parsedSample: {
        subject: 'Test',
        replyTo: [{ displayName: 'Real One', address: 'real@phish.example' }],
      },
    } as unknown as FailureReport);
    const replyTo = connection.executed
      .filter(
        call =>
          call.text.includes('dmarc_failure_sample_address') &&
          call.values[1] === 'reply_to',
      )
      .map(call => namedParams(call));
    expect(replyTo).toEqual([
      {
        report_id: 1,
        address_type: 'reply_to',
        display_name: 'Real One',
        address: 'real@phish.example',
      },
    ]);
  });

  it('keeps the backward-compatible forensic alias', async () => {
    const { client, connection } = await makeClient();
    pg.state.queue = [null, 1];
    await client.saveForensicReportToPostgresql({
      parsedSample: { subject: 'x' },
    } as unknown as FailureReport);
    expect(
      sqlOf(connection).some(sql =>
        sql.includes('INSERT INTO dmarc_failure_report'),
      ),
    ).toBe(true);
  });
});

describe('PostgreSQL save errors', () => {
  // Driver errors raised mid-save are wrapped in PostgreSQLError, and the
  // transaction is rolled back.
  async function expectWrapped(
    save: (client: PostgreSQLClient) => Promise<void>,
  ): Promise<void> {
    const { client, connection } = await makeClient();
    pg.state.queryError = new Error('db boom');
    await expect(save(client)).rejects.toThrow(new PostgreSQLError('db boom'));
    expect(connection.log.at(-1)).toBe('ROLLBACK');
  }

  it('wraps aggregate save errors', async () => {
    await expectWrapped(client =>
      client.saveAggregateReportToPostgresql({
        reportMetadata: {},
        policyPublished: {},
        records: [],
      } as unknown as AggregateReport),
    );
  });

  it('wraps failure save errors', async () => {
    await expectWrapped(client =>
      client.saveFailureReportToPostgresql({
        parsedSample: {},
        source: {},
      } as unknown as FailureReport),
    );
  });

  it('wraps SMTP TLS save errors', async () => {
    await expectWrapped(client =>
      client.saveSmtpTlsReportToPostgresql({
        policies: [],
      } as unknown as SMTPTLSReport),
    );
  });
});

describe('PostgreSQL values from the report', () => {
  function smtpTlsReport(detail: Record<string, unknown>): SMTPTLSReport {
    return {
      organizationName: 'o',
      beginDate: '2024-09-03T00:00:00+16:00',
      endDate: 'Jan 5 2024',
      contactInfo: 'c',
      reportId: 'r',
      policies: [{ policyDomain: 'd', failureDetails: [detail] }],
    } as unknown as SMTPTLSReport;
  }

  it('binds no NUL, which PostgreSQL rejects in text and JSONB', async () => {
    const { client, connection } = await makeClient();
    await client.saveFailureReportToPostgresql({
      feedbackType: 'auth-failure',
      arrivalDateUtc: '2024-01-01 00:00:00',
      reportedDomain: 'example.com',
      source: { ipAddress: '192.0.2.1' },
      authenticationResults: 'a\u0000b',
      sample: 'sample\u0000',
      parsedSample: {
        subject: 'a\u0000b',
        from: { address: 'x\u0000@example.com' },
        to: [],
        // An escaped backslash before `u0000` is not a NUL.
        headers: { 'x-text': 'c\u0000d\\u0000' },
      },
    } as unknown as FailureReport);

    const bound = connection.executed.flatMap(({ values }) => values);
    for (const value of bound) {
      if (typeof value === 'string') {
        expect(value).not.toContain('\u0000');
        expect(value.replaceAll('\\\\', '')).not.toContain(String.raw`\u0000`);
      }
    }
    expect(bound).toContain('a�b');
    expect(
      bound.some(
        value => typeof value === 'string' && value.includes('\\\\u0000'),
      ),
    ).toBe(true);
  });

  it('binds what PostgreSQL accepts instead of failing the batch', async () => {
    const { client, connection } = await makeClient();
    const logs = captureLogs();
    try {
      await client.saveSmtpTlsReportToPostgresql(
        smtpTlsReport({
          sendingMtaIp: 'mx.example.com',
          receivingIp: '192.0.2.1',
          failedSessionCount: 2_147_483_648,
        }),
      );
    } finally {
      logs.restore();
    }
    const report = namedParams(connection.executed[0]);
    expect(report.begin_date).toBe('2024-09-02 08:00:00+00');
    expect(report.end_date).toBe('2024-01-05 00:00:00+00');
    const detail = namedParams(connection.executed[2]);
    expect(detail.sending_mta_ip).toBeNull();
    expect(detail.receiving_ip).toBe('192.0.2.1');
    expect(detail.failed_session_count).toBe(2_147_483_647);
    expect(connection.log.at(-1)).toBe('COMMIT');
    expect(logs.output).toHaveLength(2);
  });

  it('turns an unexpected error while saving into PostgreSQLError', async () => {
    const { client, connection } = await makeClient();
    await expect(
      client.saveAggregateReportToPostgresql({
        reportMetadata: { beginDate: 'not-a-date' },
        policyPublished: {},
        records: [],
      } as unknown as AggregateReport),
    ).rejects.toBeInstanceOf(PostgreSQLError);
    expect(connection.log.at(-1)).toBe('ROLLBACK');
  });

  it('does not throw TypeError on values of the wrong type', async () => {
    const { client } = await makeClient();
    await client.saveSmtpTlsReportToPostgresql({
      ...smtpTlsReport({}),
      beginDate: 5,
      contactInfo: { toString: 1 },
    } as unknown as SMTPTLSReport);
  });

  it('sanitizes server errors quoting a reported value', async () => {
    const { client } = await makeClient();
    pg.state.queryError = new Error(
      'invalid input syntax for type inet: "x\nFORGED\u001B[31m"',
    );
    const save = client.saveSmtpTlsReportToPostgresql(smtpTlsReport({}));
    await expect(save).rejects.toThrow(
      new PostgreSQLError(
        'invalid input syntax for type inet: "x\\nFORGED\\x1b[31m"',
      ),
    );
    await expect(save.catch((error: Error) => error.cause)).resolves.toBe(
      pg.state.queryError,
    );
  });

  it('sanitizes the IDs in AlreadySaved', async () => {
    const { client } = await makeClient();
    pg.state.queue = [null, null];
    await expect(
      client.saveSmtpTlsReportToPostgresql({
        ...smtpTlsReport({}),
        reportId: 'a\nb',
      }),
    ).rejects.toThrow(
      new AlreadySaved('SMTP TLS report a\\nb from o has already been saved'),
    );
    await expect(
      client.saveAggregateReportToPostgresql({
        reportMetadata: { reportId: 'a\nb', orgName: 'o\u001B' },
        policyPublished: {},
        records: [],
      } as unknown as AggregateReport),
    ).rejects.toThrow(
      new AlreadySaved(
        'Aggregate report a\\nb from o\\x1b has already been saved',
      ),
    );
  });
});

describe('PostgreSQL query timeout', () => {
  it('bounds each query by default, and 0 turns it off', async () => {
    const { connection } = await makeClient();
    expect(connection.config.query_timeout).toBe(300_000);
    await PostgreSQLClient.create({ host: 'h', queryTimeout: 2 });
    expect(lastConnection().config.query_timeout).toBe(2000);
    await PostgreSQLClient.create({ host: 'h', queryTimeout: 0 });
    expect(lastConnection().config.query_timeout).toBeUndefined();
  });

  it('drops the connection on timeout, and the next save reconnects', async () => {
    const { client, connection } = await makeClient();
    pg.state.queue = [new Error('Query read timeout')];
    const report = {
      organizationName: 'o',
      reportId: 'r',
      policies: [],
    } as unknown as SMTPTLSReport;
    await expect(client.saveSmtpTlsReportToPostgresql(report)).rejects.toThrow(
      new PostgreSQLError('Query read timeout'),
    );
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(true);

    await client.saveSmtpTlsReportToPostgresql(report);
    expect(pg.state.clients).toHaveLength(2);
    expect(lastConnection().log.at(-1)).toBe('COMMIT');
  });

  it('keeps the connection after any other query error', async () => {
    const { client, connection } = await makeClient();
    pg.state.queue = [new Error('db boom')];
    await expect(
      client.saveSmtpTlsReportToPostgresql({
        policies: [],
      } as unknown as SMTPTLSReport),
    ).rejects.toThrow('db boom');
    expect(connection.end).not.toHaveBeenCalled();
    expect(client.closed).toBe(false);
  });
});

describe('PostgreSQL with real samples', () => {
  // parsedmarc's parsed samples (fixtures/) through the save methods.
  it('saves every aggregate sample', async () => {
    const { client, connection } = await makeClient();
    const reports = loadFixtures('aggregate');
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      connection.executed.length = 0;
      await client.saveAggregateReportToPostgresql(
        report as unknown as AggregateReport,
      );
      const records = (report as unknown as AggregateReport).records;
      const recordInserts = connection.executed.filter(call =>
        call.text.includes('INSERT INTO dmarc_aggregate_record ('),
      );
      expect(recordInserts).toHaveLength(records.length);
      for (const call of connection.executed) {
        placeholdersMatchValues(call);
      }
    }
  });

  it('saves every failure sample', async () => {
    const { client, connection } = await makeClient();
    const reports = loadFixtures('failure');
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      connection.executed.length = 0;
      pg.state.queue = [null];
      await client.saveFailureReportToPostgresql(
        report as unknown as FailureReport,
      );
      const insert = connection.executed.find(call =>
        call.text.includes('INSERT INTO dmarc_failure_report'),
      );
      const params = namedParams(insert);
      const failure = report as unknown as FailureReport;
      expect(params.reported_domain).toBe(failure.reportedDomain);
      expect(params.source_ip_address).toBe(failure.source.ipAddress);
      expect(params.sample_subject).toBe(failure.parsedSample.subject);
    }
  });

  it('saves every SMTP TLS sample', async () => {
    const { client, connection } = await makeClient();
    const reports = loadFixtures('smtp_tls');
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      connection.executed.length = 0;
      await client.saveSmtpTlsReportToPostgresql(
        report as unknown as SMTPTLSReport,
      );
      const { policies } = report as unknown as SMTPTLSReport;
      expect(
        connection.executed.filter(call =>
          call.text.includes('INSERT INTO smtp_tls_policy'),
        ),
      ).toHaveLength(policies.length);
    }
  });
});

describe('integers beyond 2^53', () => {
  // Past INTEGER, the column every count goes to, PostgreSQL refuses the
  // value and the whole batch fails, so it is clamped (see int4()).
  it('clamps a record count past INTEGER', async () => {
    const { client, connection } = await makeClient();
    pg.state.queue = [1, 10];
    const xml = readFileSync(
      new URL(
        '../../../samples/aggregate/!example.com!1538204542!1538463818.xml',
        import.meta.url,
      ),
      'utf8',
    ).replace('<count>1</count>', '<count>99999999999999999999</count>');
    const report = await parseAggregateReportXml(xml, { offline: true });
    await client.saveAggregateReportToPostgresql(report);
    expect(namedParams(connection.executed[1]).message_count).toBe(
      2_147_483_647,
    );
  });

  it('clamps SMTP TLS session counts past INTEGER', async () => {
    const { client, connection } = await makeClient();
    pg.state.queue = [1, 10];
    const json = readFileSync(
      new URL('../../../samples/smtp_tls/smtp_tls.json', import.meta.url),
      'utf8',
    ).replace(
      '"failed-session-count":2',
      '"failed-session-count":99999999999999999999',
    );
    await client.saveSmtpTlsReportToPostgresql(parseSmtpTlsReportJson(json));
    expect(namedParams(connection.executed[2]).failed_session_count).toBe(
      2_147_483_647,
    );
  });

  it('dumps JSONB values with exact integers', async () => {
    const { client, connection } = await makeClient();
    pg.state.queue = [null, 1];
    await client.saveFailureReportToPostgresql({
      feedbackType: 'auth-failure',
      arrivalDateUtc: '2024-01-15 10:30:00',
      source: { ipAddress: '203.0.113.1' },
      parsedSample: {
        subject: 'Test',
        headers: { 'X-Count': 99_999_999_999_999_999_999n },
        from: { address: 'a@example.com' },
        to: [],
        cc: [],
        bcc: [],
        replyTo: [],
      },
    } as unknown as FailureReport);
    const insert = connection.executed.find(call =>
      call.text.includes('INSERT INTO dmarc_failure_report'),
    );
    expect(insert?.values).toContain('{"X-Count": 99999999999999999999}');
  });
});
