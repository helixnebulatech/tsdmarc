// Ported from parsedmarc tests/test_cli.py: TestPostgreSQLCliWiring. A
// [postgresql] config reaches PostgreSQLClient.create() and createTables(),
// and reports reach the client's save methods; save errors are logged, not
// fatal.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { IMAPConnection } from '@tsdmarc/imap';
import {
  AlreadySaved,
  PostgreSQLClient,
  PostgreSQLError,
} from '@tsdmarc/postgres';
import {
  type AggregateReport,
  captureLogs,
  type FailureReport,
  type ParsingResults,
  type SMTPTLSReport,
  WARNING,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from './core';
import { main } from './main';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-cli-pg-'));
  vi.spyOn(IMAPConnection, 'connect').mockResolvedValue({
    close: vi.fn(async () => undefined),
  } as unknown as IMAPConnection);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(text: string): string {
  const configPath = path.join(tempDir, 'config.ini');
  writeFileSync(configPath, text);
  return configPath;
}

interface FakeClient {
  createTables: ReturnType<typeof vi.fn>;
  saveAggregateReportToPostgresql: ReturnType<typeof vi.fn>;
  saveFailureReportToPostgresql: ReturnType<typeof vi.fn>;
  saveSmtpTlsReportToPostgresql: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** Mock PostgreSQLClient.create() at the SDK boundary. */
function mockPostgres(saveError?: Error): {
  client: FakeClient;
  create: ReturnType<typeof vi.spyOn>;
} {
  const save = (): ReturnType<typeof vi.fn> =>
    vi.fn(async () => {
      if (saveError) {
        throw saveError;
      }
    });
  const client: FakeClient = {
    createTables: vi.fn(async () => undefined),
    saveAggregateReportToPostgresql: save(),
    saveFailureReportToPostgresql: save(),
    saveSmtpTlsReportToPostgresql: save(),
    close: vi.fn(async () => undefined),
  };
  const create = vi
    .spyOn(PostgreSQLClient, 'create')
    .mockResolvedValue(client as unknown as PostgreSQLClient);
  return { client, create };
}

/** getDmarcReportsFromMailbox honoring the contract: batches go to saveCallback first. */
function fetchInvokingSaveCallback(reports: ParsingResults): void {
  vi.mocked(core.getDmarcReportsFromMailbox).mockImplementation(
    async (_connection, options) => {
      await options.saveCallback?.(reports);
      return reports;
    },
  );
}

const IMAP = `[imap]
host = imap.example.com
user = test-user
password = test-password
`;

describe('TestPostgreSQLCliWiring', () => {
  it('test_postgresql_config_constructs_client_and_creates_tables', async () => {
    const { client, create } = mockPostgres();
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: [],
      failureReports: [],
      smtpTlsReports: [],
    });
    const configPath = writeConfig(`[general]
save_aggregate = true
silent = true

${IMAP}
[postgresql]
host = db.example.com
port = 6543
user = pmarc
password = secret
database = dmarc
`);

    await main(['-c', configPath]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      host: 'db.example.com',
      port: 6543,
      user: 'pmarc',
      password: 'secret',
      database: 'dmarc',
    });
    expect(client.createTables).toHaveBeenCalledTimes(1);
    // Closed on the way out, like Python's atexit handler.
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  // An aggregate report reaches the client's save method via the loop.
  it('test_postgresql_aggregate_report_is_saved', async () => {
    const { client } = mockPostgres();
    const report = {
      policyPublished: { domain: 'example.com' },
      records: [],
    } as unknown as AggregateReport;
    fetchInvokingSaveCallback({
      aggregateReports: [report],
      failureReports: [],
      smtpTlsReports: [],
    });
    const configPath = writeConfig(`[general]
save_aggregate = true
silent = true

${IMAP}
[postgresql]
host = db.example.com
`);

    await main(['-c', configPath]);

    expect(client.saveAggregateReportToPostgresql).toHaveBeenCalledTimes(1);
    expect(client.saveAggregateReportToPostgresql).toHaveBeenCalledWith(report);
  });

  const ALL_TYPES = `[general]
save_aggregate = true
save_failure = true
save_smtp_tls = true
silent = true

${IMAP}
[postgresql]
host = db.example.com
`;

  function reports(tlsPolicies: unknown[]): {
    agg: AggregateReport;
    fail: FailureReport;
    tls: SMTPTLSReport;
    results: ParsingResults;
  } {
    const agg = {
      policyPublished: { domain: 'example.com' },
      records: [],
    } as unknown as AggregateReport;
    const fail = {
      reportedDomain: 'example.com',
      parsedSample: {},
    } as unknown as FailureReport;
    const tls = {
      organizationName: 'Org',
      policies: tlsPolicies,
    } as unknown as SMTPTLSReport;
    return {
      agg,
      fail,
      tls,
      results: {
        aggregateReports: [agg],
        failureReports: [fail],
        smtpTlsReports: [tls],
      },
    };
  }

  // Failure and SMTP TLS reports also reach their save methods.
  it('test_postgresql_all_report_types_saved', async () => {
    const { client } = mockPostgres();
    const { agg, fail, tls, results } = reports([{ policyDomain: 'd' }]);
    fetchInvokingSaveCallback(results);

    await main(['-c', writeConfig(ALL_TYPES)]);

    expect(client.saveAggregateReportToPostgresql).toHaveBeenCalledTimes(1);
    expect(client.saveAggregateReportToPostgresql).toHaveBeenCalledWith(agg);
    expect(client.saveFailureReportToPostgresql).toHaveBeenCalledTimes(1);
    expect(client.saveFailureReportToPostgresql).toHaveBeenCalledWith(fail);
    expect(client.saveSmtpTlsReportToPostgresql).toHaveBeenCalledTimes(1);
    expect(client.saveSmtpTlsReportToPostgresql).toHaveBeenCalledWith(tls);
  });

  // AlreadySaved from any save is logged as a warning, not propagated.
  it('test_postgresql_already_saved_is_warned_not_fatal', async () => {
    const { client } = mockPostgres(new AlreadySaved('dup'));
    fetchInvokingSaveCallback(reports([]).results);

    const logs = captureLogs('tsdmarc', WARNING);
    try {
      // `warnings` so the level the CLI sets lets the warnings through.
      await main([
        '-c',
        writeConfig(
          ALL_TYPES.replace('silent = true', 'silent = true\nwarnings = true'),
        ),
      ]);
    } finally {
      logs.restore();
    }

    expect(client.saveSmtpTlsReportToPostgresql).toHaveBeenCalledTimes(1);
    expect(
      logs.output.filter(line => line === 'WARNING:tsdmarc:dup'),
    ).toHaveLength(3);
    expect(logs.output.some(line => line.startsWith('ERROR:'))).toBe(false);
  });

  // PostgreSQLError from any save is logged as an output error, not fatal.
  it('passes the TLS options and query_timeout to the client', async () => {
    const { create } = mockPostgres();
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: [],
      failureReports: [],
      smtpTlsReports: [],
    });
    const configPath = writeConfig(`[general]
silent = true

${IMAP}
[postgresql]
host = db.example.com
sslmode = verify-full
sslrootcert = system
sslcert = /etc/ssl/client.crt
sslkey = /etc/ssl/client.key
query_timeout = 30
`);

    await main(['-c', configPath]);

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      sslmode: 'verify-full',
      sslrootcert: 'system',
      sslcert: '/etc/ssl/client.crt',
      sslkey: '/etc/ssl/client.key',
      queryTimeout: 30,
    });
  });

  it('keeps the client defaults for the options left out', async () => {
    const { create } = mockPostgres();
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: [],
      failureReports: [],
      smtpTlsReports: [],
    });
    const configPath = writeConfig(`[general]
silent = true

${IMAP}
[postgresql]
host = db.example.com
`);

    await main(['-c', configPath]);

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('queryTimeout');
  });

  it('test_postgresql_error_is_logged_not_fatal', async () => {
    const { client } = mockPostgres(new PostgreSQLError('boom'));
    fetchInvokingSaveCallback(reports([]).results);

    const logs = captureLogs('tsdmarc', WARNING);
    try {
      await main(['-c', writeConfig(ALL_TYPES)]);
    } finally {
      logs.restore();
    }

    expect(client.saveSmtpTlsReportToPostgresql).toHaveBeenCalledTimes(1);
    expect(
      logs.output.filter(
        line => line === 'ERROR:tsdmarc:PostgreSQL Error: boom',
      ),
    ).toHaveLength(3);
  });
});
