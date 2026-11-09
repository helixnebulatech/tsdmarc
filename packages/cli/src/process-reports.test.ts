// Ported from parsedmarc's tests/test_cli.py:
// TestIndexPrefixDomainMapTlsFiltering, TestMigrateIndexesDomainMapWiring
// and TestMailboxSaveCallbackWiring.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as elastic from '@tsdmarc/elasticsearch';
import { IMAPConnection } from '@tsdmarc/imap';
import * as opensearch from '@tsdmarc/opensearch';
import { PostgreSQLClient } from '@tsdmarc/postgres';
import { emailResults } from '@tsdmarc/smtp';
import {
  type AggregateReport,
  captureLogs,
  DEBUG,
  type FailureReport,
  HECClient,
  logger,
  ParserError,
  type ParsingResults,
  parseReportFile,
  type SMTPTLSReport,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDmarcReportsFromMailbox,
  type GetDmarcReportsFromMailboxOptions,
  type SaveCallback,
  watchInbox,
} from './core';
import { main } from './main';
import { filterSmtpTlsReportsForIndexPrefix, stdout } from './process-reports';

const SAMPLE_AGGREGATE_REPORT_PATH = fileURLToPath(
  new URL(
    '../../../samples/aggregate/!example.com!1538204542!1538463818.xml',
    import.meta.url,
  ),
);

/** Captured before the setup file blocks the network. */
const realFetch = globalThis.fetch;

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-cli-'));
  vi.spyOn(IMAPConnection, 'connect').mockResolvedValue({
    close: vi.fn(async () => undefined),
  } as unknown as IMAPConnection);
  vi.mocked(elastic.setHosts).mockResolvedValue({
    close: vi.fn(async () => undefined),
  } as unknown as Awaited<ReturnType<typeof elastic.setHosts>>);
  vi.mocked(elastic.migrateIndexes).mockResolvedValue(undefined);
  vi.mocked(opensearch.setHosts).mockResolvedValue({
    close: vi.fn(async () => undefined),
  } as unknown as Awaited<ReturnType<typeof opensearch.setHosts>>);
  vi.mocked(opensearch.migrateIndexes).mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeFile(name: string, text: string): string {
  const filePath = path.join(tempDir, name);
  writeFileSync(filePath, text);
  return filePath;
}

function emptyResults(): ParsingResults {
  return { aggregateReports: [], failureReports: [], smtpTlsReports: [] };
}

/**
 * A `getDmarcReportsFromMailbox` implementation honoring the real contract:
 * every fetched batch goes to `saveCallback` before the function returns
 * the accumulated results. `batch` overrides what the callback receives.
 */
function fetchInvokingSaveCallback(
  reports: ParsingResults,
  batch?: ParsingResults,
): (
  connection: unknown,
  options: GetDmarcReportsFromMailboxOptions,
) => Promise<ParsingResults> {
  return async (_connection, options) => {
    await options.saveCallback?.(batch ?? reports);
    return reports;
  };
}

/** A real parsed sample aggregate report (offline). */
async function sampleAggregateReports(): Promise<AggregateReport[]> {
  const result = await parseReportFile(SAMPLE_AGGREGATE_REPORT_PATH, {
    offline: true,
  });
  if (result.reportType !== 'aggregate') {
    throw new Error('expected an aggregate report');
  }
  return [result.report];
}

function domainMapTlsReports(): SMTPTLSReport[] {
  const report = (
    organizationName: string,
    reportId: string,
    contactInfo: string,
    policies: Record<string, unknown>[],
  ): SMTPTLSReport =>
    ({
      organizationName,
      beginDate: '2024-01-01T00:00:00Z',
      endDate: '2024-01-01T23:59:59Z',
      reportId,
      contactInfo,
      policies,
    }) as unknown as SMTPTLSReport;
  const policy = (
    domain: string,
    successful: number,
  ): Record<string, unknown> => ({
    policyDomain: domain,
    policyType: 'sts',
    successfulSessionCount: successful,
    failedSessionCount: 0,
  });
  return [
    report('Allowed Org', 'allowed-1', 'tls@allowed.example.com', [
      policy('allowed.example.com', 1),
    ]),
    report('Unmapped Org', 'unmapped-1', 'tls@unmapped.example.net', [
      policy('unmapped.example.net', 5),
    ]),
    report('Mixed Case Org', 'mixed-case-1', 'tls@mixedcase.example.com', [
      policy('MixedCase.Example.Com', 2),
    ]),
    // parseSmtpTlsReportJson() accepts an empty policies list: unmappable.
    report(
      'No Policies Org',
      'no-policies-1',
      'tls@nopolicies.example.org',
      [],
    ),
  ];
}

const IMAP = `
[imap]
host = imap.example.com
user = test-user
password = test-password
`;

describe('TestIndexPrefixDomainMapTlsFiltering', () => {
  it('testTlsReportsFilteredByDomainMap', async () => {
    vi.mocked(getDmarcReportsFromMailbox).mockImplementation(
      fetchInvokingSaveCallback({
        ...emptyResults(),
        smtpTlsReports: domainMapTlsReports(),
      }),
    );
    const mapPath = writeFile('map.yaml', 'tenant_a:\n- example.com\n');
    const configPath = writeFile(
      'config.ini',
      `[general]
save_smtp_tls = true
silent = false
index_prefix_domain_map = ${mapPath}
${IMAP}`,
    );
    let captured = '';
    vi.spyOn(stdout, 'write').mockImplementation((text: string) => {
      captured += text;
    });

    await main(['-c', configPath]);

    // A single JSON document: a mailbox-only run saves inside the callback
    // and skips the second, empty pass.
    const output = JSON.parse(captured) as {
      smtp_tls_reports: { report_id: string }[];
    };
    const reportIds = new Set(output.smtp_tls_reports.map(r => r.report_id));
    expect(output.smtp_tls_reports).toHaveLength(2);
    expect(reportIds).toContain('allowed-1');
    expect(reportIds).toContain('mixed-case-1');
    expect(reportIds).not.toContain('unmapped-1');
    expect(reportIds).not.toContain('no-policies-1');
  });

  it('testTlsReportsFilteredForEmailResults', async () => {
    // getDmarcReportsFromMailbox() returns its own accumulated lists, not the
    // batch it filtered in place, so the combined results must be filtered.
    const reports: ParsingResults = {
      ...emptyResults(),
      smtpTlsReports: domainMapTlsReports(),
    };
    vi.mocked(getDmarcReportsFromMailbox).mockImplementation(
      fetchInvokingSaveCallback(reports, {
        ...emptyResults(),
        smtpTlsReports: [...reports.smtpTlsReports],
      }),
    );
    vi.mocked(emailResults).mockResolvedValue(undefined);
    const mapPath = writeFile('map.yaml', 'tenant_a:\n- example.com\n');
    const configPath = writeFile(
      'config.ini',
      `[general]
save_smtp_tls = true
silent = true
index_prefix_domain_map = ${mapPath}
${IMAP}
[smtp]
host = smtp.example.com
user = smtp-user
password = smtp-password
from = dmarc@example.com
to = admin@example.com
`,
    );

    await main(['-c', configPath]);

    expect(emailResults).toHaveBeenCalledOnce();
    const emailed = vi.mocked(emailResults).mock.calls[0]?.[0];
    expect(new Set(emailed?.smtpTlsReports.map(r => r.reportId))).toEqual(
      new Set(['allowed-1', 'mixed-case-1']),
    );
  });
});

describe('TestMigrateIndexesDomainMapWiring', () => {
  // The startup index migrations must fan out over index_prefix_domain_map
  // (issue #868); these assert the names handed to migrateIndexes().

  function writeConfig(config: string, domainMap?: string): string {
    let text = config;
    if (domainMap !== undefined) {
      text = text.replace('{map_path}', writeFile('map.yaml', domainMap));
    }
    return writeFile('config.ini', text);
  }

  beforeEach(() => {
    vi.mocked(getDmarcReportsFromMailbox).mockResolvedValue(emptyResults());
  });

  it('testElasticsearchMigrationFansOutOverDomainMap', async () => {
    const configPath = writeConfig(
      `[general]
save_aggregate = true
save_smtp_tls = true
silent = true
index_prefix_domain_map = {map_path}
${IMAP}
[elasticsearch]
hosts = localhost
`,
      'Tenant-A:\n- example.com\ntenant_b:\n- example.net\n',
    );

    await main(['-c', configPath]);

    const options = vi.mocked(elastic.migrateIndexes).mock.calls.at(-1)?.[0];
    expect(options?.aggregateIndexes).toEqual([
      'dmarc_aggregate',
      'tenant_a_dmarc_aggregate',
      'tenant_b_dmarc_aggregate',
    ]);
    expect(options?.failureIndexes).toEqual([
      'dmarc_failure',
      'tenant_a_dmarc_failure',
      'tenant_b_dmarc_failure',
    ]);
    expect(options?.smtpTlsIndexes).toEqual([
      'smtp_tls',
      'tenant_a_smtp_tls',
      'tenant_b_smtp_tls',
    ]);
    // The legacy fo migration does not fan out over the map.
    expect(options?.legacyFoIndexes).toEqual(['dmarc_aggregate']);
  });

  it('testOpenSearchMigrationFansOutWithSuffix', async () => {
    const configPath = writeConfig(
      `[general]
save_aggregate = true
silent = true
index_prefix_domain_map = {map_path}
${IMAP}
[opensearch]
hosts = localhost
index_suffix = prod
`,
      'Tenant-A:\n- example.com\n',
    );

    await main(['-c', configPath]);

    const options = vi.mocked(opensearch.migrateIndexes).mock.calls.at(-1)?.[0];
    expect(options?.aggregateIndexes).toEqual([
      'dmarc_aggregate_prod',
      'dmarc_aggregate',
      'tenant_a_dmarc_aggregate_prod',
      'tenant_a_dmarc_aggregate',
    ]);
    expect(options?.smtpTlsIndexes).toEqual([
      'smtp_tls_prod',
      'smtp_tls',
      'tenant_a_smtp_tls_prod',
      'tenant_a_smtp_tls',
    ]);
  });

  it('testConfiguredPrefixSuppressesDomainMapFanout', async () => {
    const configPath = writeConfig(
      `[general]
save_aggregate = true
silent = true
index_prefix_domain_map = {map_path}
${IMAP}
[elasticsearch]
hosts = localhost
index_prefix = corp_
`,
      'Tenant-A:\n- example.com\n',
    );

    await main(['-c', configPath]);

    const options = vi.mocked(elastic.migrateIndexes).mock.calls.at(-1)?.[0];
    expect(options?.aggregateIndexes).toEqual(['corp_dmarc_aggregate']);
    expect(options?.failureIndexes).toEqual(['corp_dmarc_failure']);
    expect(options?.smtpTlsIndexes).toEqual(['corp_smtp_tls']);
  });

  it('testLegacyFoMigrationHonorsPrefixAndSuffixButNotTheDomainMap', async () => {
    const configPath = writeConfig(
      `[general]
save_aggregate = true
silent = true
index_prefix_domain_map = {map_path}
${IMAP}
[elasticsearch]
hosts = localhost
index_prefix = corp_
index_suffix = prod
`,
      'Tenant-A:\n- example.com\n',
    );

    await main(['-c', configPath]);

    expect(
      vi.mocked(elastic.migrateIndexes).mock.calls.at(-1)?.[0]?.legacyFoIndexes,
    ).toEqual(['corp_dmarc_aggregate_prod', 'corp_dmarc_aggregate']);
  });

  it('testMigrationTargetsMatchSaveTimePrefix', async () => {
    const [report] = await sampleAggregateReports();
    if (report === undefined) {
      throw new Error('no sample report');
    }
    report.policyPublished.domain = 'example.com';
    vi.mocked(getDmarcReportsFromMailbox).mockImplementation(
      fetchInvokingSaveCallback({
        ...emptyResults(),
        aggregateReports: [report],
      }),
    );
    vi.mocked(elastic.saveAggregateReportToElasticsearch).mockResolvedValue(
      undefined,
    );
    const configPath = writeConfig(
      `[general]
save_aggregate = true
silent = true
index_prefix_domain_map = {map_path}
${IMAP}
[elasticsearch]
hosts = localhost
`,
      'Tenant-A:\n- example.com\n',
    );

    await main(['-c', configPath]);

    expect(
      vi
        .mocked(elastic.saveAggregateReportToElasticsearch)
        .mock.calls.at(-1)?.[1]?.indexPrefix,
    ).toBe('tenant_a_');
    expect(
      vi.mocked(elastic.migrateIndexes).mock.calls.at(-1)?.[0]
        ?.aggregateIndexes,
    ).toContain('tenant_a_dmarc_aggregate');
  });
});

describe('TestMailboxSaveCallbackWiring', () => {
  // The callback the CLI hands to getDmarcReportsFromMailbox() (and to
  // watchInbox()) reports whether a batch reached every output destination.

  it('testSaveCallbackIsFalseOnlyWhenAnOutputDestinationFailed', async () => {
    vi.mocked(getDmarcReportsFromMailbox).mockResolvedValue(emptyResults());
    vi.mocked(elastic.saveAggregateReportToElasticsearch).mockResolvedValue(
      undefined,
    );
    const configPath = writeFile(
      'config.ini',
      `[general]
save_aggregate = true
silent = true
${IMAP}
[elasticsearch]
hosts = localhost
`,
    );

    await main(['-c', configPath]);

    const saveCallback = vi.mocked(getDmarcReportsFromMailbox).mock
      .calls[0]?.[1].saveCallback as SaveCallback;
    expect(typeof saveCallback).toBe('function');

    const report = {
      policyPublished: { domain: 'example.com' },
    } as unknown as AggregateReport;
    const batch: ParsingResults = {
      ...emptyResults(),
      aggregateReports: [report],
    };
    expect(await saveCallback(batch)).toBe(true);
    expect(
      vi
        .mocked(elastic.saveAggregateReportToElasticsearch)
        .mock.calls.at(-1)?.[0],
    ).toBe(report);

    vi.mocked(elastic.saveAggregateReportToElasticsearch).mockRejectedValue(
      new elastic.ElasticsearchError('simulated output failure'),
    );
    expect(await saveCallback(batch)).toBe(false);
  });

  it('testWatchCallbackIsTheSameAdapterAndRetryCapReachesBothCallSites', async () => {
    vi.mocked(getDmarcReportsFromMailbox).mockResolvedValue(emptyResults());
    vi.mocked(watchInbox).mockRejectedValue(
      Object.assign(new Error('stop-watch-loop'), { code: 'EEXIST' }),
    );
    const configPath = writeFile(
      'config.ini',
      `[general]
silent = true

[imap]
host = imap.example.com
user = user
password = pass

[mailbox]
watch = true
max_unsaved_retries = 7
`,
    );
    const logs = captureLogs();
    try {
      await expect(main(['-c', configPath])).rejects.toMatchObject({ code: 1 });
    } finally {
      logs.restore();
    }

    const singleShot = vi.mocked(getDmarcReportsFromMailbox).mock.calls[0]?.[1];
    const watchOptions = vi.mocked(watchInbox).mock.calls[0]?.[0];
    expect(typeof singleShot?.saveCallback).toBe('function');
    expect(watchOptions?.callback).toBe(singleShot?.saveCallback);
    expect(singleShot?.maxUnsavedRetries).toBe(7);
    expect(watchOptions?.maxUnsavedRetries).toBe(7);
  });

  it('testFileOutputFailureIsRecordedAndReportsTheBatchUnsaved', async () => {
    // `output` pointing at a regular file makes saveOutput() throw its real
    // ValueError for a non-directory path.
    const outputPath = writeFile('not-a-directory.txt', '');
    const reports: ParsingResults = {
      ...emptyResults(),
      aggregateReports: [
        {
          policyPublished: { domain: 'example.com' },
        } as unknown as AggregateReport,
      ],
    };
    const verdicts: boolean[] = [];
    vi.mocked(getDmarcReportsFromMailbox).mockImplementation(
      async (_connection, options) => {
        verdicts.push(Boolean(await options.saveCallback?.(reports)));
        return reports;
      },
    );
    const configPath = writeFile(
      'config.ini',
      `[general]
silent = true
output = ${outputPath}
${IMAP}`,
    );
    const logs = captureLogs();
    try {
      await main(['-c', configPath]);
    } finally {
      logs.restore();
    }

    expect(verdicts).toEqual([false]);
    expect(
      logs.records.some(
        record =>
          record.levelName === 'ERROR' &&
          record.message.includes('File output Error'),
      ),
    ).toBe(true);
  });

  it('testMailboxAndFileReportsAreEachSavedExactlyOnce', async () => {
    // The mailbox batch is saved inside saveCallback, the file reports
    // afterward; the final pass must run on the file snapshot alone.
    const mailboxReport = {
      policyPublished: { domain: 'mailbox.example.com' },
    } as unknown as AggregateReport;
    vi.mocked(getDmarcReportsFromMailbox).mockImplementation(
      fetchInvokingSaveCallback({
        ...emptyResults(),
        aggregateReports: [mailboxReport],
      }),
    );
    vi.mocked(elastic.saveAggregateReportToElasticsearch).mockResolvedValue(
      undefined,
    );
    const configPath = writeFile(
      'config.ini',
      `[general]
save_aggregate = true
silent = true
offline = true
${IMAP}
[elasticsearch]
hosts = localhost
`,
    );

    await main(['-c', configPath, SAMPLE_AGGREGATE_REPORT_PATH]);

    const savedDomains = vi
      .mocked(elastic.saveAggregateReportToElasticsearch)
      .mock.calls.map(call => call[0].policyPublished.domain);
    expect(
      savedDomains.filter(domain => domain === 'mailbox.example.com'),
    ).toHaveLength(1);
    expect(savedDomains).toHaveLength(2);
  });

  it('testFailOnOutputErrorExitsForFileDerivedReports', async () => {
    // Without a mailbox there is no save callback to throw inside: the
    // failure surfaces from the final pass over the file snapshot.
    vi.mocked(elastic.saveAggregateReportToElasticsearch).mockRejectedValue(
      new elastic.ElasticsearchError('simulated output failure'),
    );
    const configPath = writeFile(
      'config.ini',
      `[general]
save_aggregate = true
fail_on_output_error = true
silent = true
offline = true

[elasticsearch]
hosts = localhost
`,
    );
    const logs = captureLogs();
    try {
      await expect(
        main(['-c', configPath, SAMPLE_AGGREGATE_REPORT_PATH]),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      logs.restore();
    }

    expect(elastic.saveAggregateReportToElasticsearch).toHaveBeenCalledOnce();
    expect(
      logs.records.some(record =>
        record.message.startsWith('Output destination failures detected:'),
      ),
    ).toBe(true);
  });
});

describe('one report failing in one output', () => {
  const failureReport = (subject: string): FailureReport =>
    ({
      reportedDomain: 'example.com',
      arrivalDateUtc: '2024-01-01 00:00:00',
      sample: 'x',
      parsedSample: { subject },
    }) as unknown as FailureReport;

  const CONFIG = `[general]
save_aggregate = true
save_failure = true
save_smtp_tls = true
silent = true
${IMAP}`;

  /** Run a mailbox batch through main(); returns the callback's verdict. */
  async function saveBatch(
    config: string,
    batch: ParsingResults,
    args: string[] = [],
  ): Promise<boolean[]> {
    const verdicts: boolean[] = [];
    vi.mocked(getDmarcReportsFromMailbox).mockImplementation(
      async (_connection, options) => {
        verdicts.push(Boolean(await options.saveCallback?.(batch)));
        return batch;
      },
    );
    await main(['-c', writeFile('config.ini', config), ...args]);
    return verdicts;
  }

  it('goes on with the next report and counts the batch as not saved', async () => {
    vi.mocked(elastic.saveFailureReportToElasticsearch)
      .mockRejectedValueOnce(new Error('list index out of range'))
      .mockResolvedValue(undefined);
    const logs = captureLogs();
    let verdicts: boolean[] = [];
    try {
      verdicts = await saveBatch(
        `${CONFIG}\n[elasticsearch]\nhosts = localhost\n`,
        {
          ...emptyResults(),
          failureReports: [failureReport('first'), failureReport('second')],
          smtpTlsReports: domainMapTlsReports().slice(0, 1),
        },
      );
    } finally {
      logs.restore();
    }

    expect(verdicts).toEqual([false]);
    expect(elastic.saveFailureReportToElasticsearch).toHaveBeenCalledTimes(2);
    expect(elastic.saveSmtpTlsReportToElasticsearch).toHaveBeenCalledOnce();
    expect(
      logs.records.some(record =>
        record.message.includes(
          'Elasticsearch exception Error: list index out of range',
        ),
      ),
    ).toBe(true);
  });

  it('does the same for OpenSearch', async () => {
    vi.mocked(opensearch.saveSmtpTlsReportToOpenSearch).mockRejectedValue(
      new Error('bad date'),
    );
    const verdicts = await saveBatch(
      `${CONFIG}\n[opensearch]\nhosts = localhost\n`,
      { ...emptyResults(), smtpTlsReports: domainMapTlsReports() },
    );

    expect(verdicts).toEqual([false]);
    expect(
      vi.mocked(opensearch.saveSmtpTlsReportToOpenSearch).mock.calls.length,
    ).toBe(domainMapTlsReports().length);
  });

  it('does the same for an unknown PostgreSQL error', async () => {
    const save = vi.fn(async () => {
      throw new TypeError('not a PostgreSQLError');
    });
    vi.spyOn(PostgreSQLClient, 'create').mockResolvedValue({
      createTables: vi.fn(async () => undefined),
      saveSmtpTlsReportToPostgresql: save,
      close: vi.fn(async () => undefined),
    } as unknown as PostgreSQLClient);
    const verdicts = await saveBatch(
      `${CONFIG}\n[postgresql]\nhost = localhost\n`,
      { ...emptyResults(), smtpTlsReports: domainMapTlsReports() },
    );

    expect(verdicts).toEqual([false]);
    expect(save.mock.calls.length).toBe(domainMapTlsReports().length);
  });

  it('does the same for an unknown Splunk error', async () => {
    vi.spyOn(
      HECClient.prototype,
      'saveSmtpTlsReportsToSplunk',
    ).mockRejectedValue(new TypeError('not a SplunkError'));
    const verdicts = await saveBatch(
      `${CONFIG}\n[splunk_hec]\nurl = https://localhost\ntoken = t\nindex = i\n`,
      { ...emptyResults(), smtpTlsReports: domainMapTlsReports() },
    );

    expect(verdicts).toEqual([false]);
  });

  describe('a webhook that does not take the reports', () => {
    let server: Server;
    let status = 200;
    let url = '';

    beforeEach(async () => {
      // The setup file blocks the network; let this local server through.
      vi.stubGlobal(
        'fetch',
        (input: string | URL | Request, init?: RequestInit) =>
          String(input).startsWith(url)
            ? realFetch(input, init)
            : Promise.reject(
                new TypeError('fetch failed (not the test server)'),
              ),
      );
      status = 200;
      server = createServer((_request, response) => {
        response.writeHead(status).end();
      });
      await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', resolve);
      });
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    });

    afterEach(async () => {
      await new Promise(resolve => {
        server.close(resolve);
      });
    });

    const webhookConfig = (hookUrl: string): string =>
      `${CONFIG}\n[webhook]\naggregate_url = ${hookUrl}\nfailure_url = ${hookUrl}\nsmtp_tls_url = ${hookUrl}\ntimeout = 5\n`;

    it('counts the batch as saved when it answers 2xx', async () => {
      const verdicts = await saveBatch(webhookConfig(url), {
        ...emptyResults(),
        aggregateReports: await sampleAggregateReports(),
      });

      expect(verdicts).toEqual([true]);
    });

    it.each([
      ['aggregate', 500],
      ['failure', 503],
      ['SMTP TLS', 404],
    ] as const)(
      'counts a batch of %s reports as not saved on HTTP %i',
      async (type, code) => {
        status = code;
        const batches: Record<typeof type, () => Promise<ParsingResults>> = {
          aggregate: async () => ({
            ...emptyResults(),
            aggregateReports: await sampleAggregateReports(),
          }),
          failure: async () => ({
            ...emptyResults(),
            failureReports: [failureReport('subject')],
          }),
          'SMTP TLS': async () => ({
            ...emptyResults(),
            smtpTlsReports: domainMapTlsReports().slice(0, 1),
          }),
        };
        const logs = captureLogs();
        let verdicts: boolean[] = [];
        try {
          verdicts = await saveBatch(webhookConfig(url), await batches[type]());
        } finally {
          logs.restore();
        }

        expect(verdicts).toEqual([false]);
        expect(logs.output).toContain(
          `ERROR:tsdmarc:Webhook Error: Webhook responded with HTTP ${code}`,
        );
      },
    );

    it('counts the batch as not saved when it is down', async () => {
      await new Promise(resolve => {
        server.close(resolve);
      });
      server = createServer();
      const logs = captureLogs();
      let verdicts: boolean[] = [];
      try {
        verdicts = await saveBatch(webhookConfig(url), {
          ...emptyResults(),
          aggregateReports: await sampleAggregateReports(),
        });
      } finally {
        logs.restore();
      }

      expect(verdicts).toEqual([false]);
      expect(
        logs.output.some(line =>
          line.startsWith('ERROR:tsdmarc:Webhook Error: fetch failed'),
        ),
      ).toBe(true);
    });
  });

  it('writes the other reports to the files', async () => {
    const outputDir = path.join(tempDir, 'output');
    const unserializable = {
      policyPublished: Symbol('not JSON'),
    } as unknown as AggregateReport;
    const verdicts = await saveBatch(
      CONFIG.replace('[imap]', `output = ${outputDir}\n\n[imap]`),
      {
        ...emptyResults(),
        aggregateReports: [unserializable],
        smtpTlsReports: domainMapTlsReports().slice(0, 1),
      },
    );

    expect(verdicts).toEqual([false]);
    const written = JSON.parse(
      readFileSync(path.join(outputDir, 'smtp_tls.json'), 'utf8'),
    ) as unknown[];
    expect(written).toHaveLength(1);
  });

  it('counts a report over the string limit as not saved', async () => {
    const tooLarge = {
      get policyPublished(): never {
        throw new RangeError('Invalid string length');
      },
    } as unknown as AggregateReport;
    const logs = captureLogs();
    let verdicts: boolean[] = [];
    try {
      verdicts = await saveBatch(
        CONFIG.replace('silent = true', 'silent = false'),
        {
          ...emptyResults(),
          aggregateReports: [tooLarge],
        },
      );
    } finally {
      logs.restore();
    }

    expect(verdicts).toEqual([false]);
    expect(
      logs.records.some(record =>
        record.message.includes('Invalid string length'),
      ),
    ).toBe(true);
  });

  it('does not serialize the batch when silent', async () => {
    const tooLarge = {
      get policyPublished(): never {
        throw new RangeError('Invalid string length');
      },
    } as unknown as AggregateReport;
    const verdicts = await saveBatch(
      CONFIG.replace('save_aggregate = true', 'save_aggregate = false'),
      {
        ...emptyResults(),
        aggregateReports: [tooLarge],
      },
    );

    expect(verdicts).toEqual([true]);
  });

  it('records a UnicodeDecodeError from a JSON file as a file output error', async () => {
    const outputDir = path.join(tempDir, 'output');
    mkdirSync(outputDir);
    writeFileSync(
      path.join(outputDir, 'smtp_tls.json'),
      Buffer.from([0x5b, 0xff, 0x5d]),
    );
    const logs = captureLogs();
    let verdicts: boolean[] = [];
    try {
      verdicts = await saveBatch(
        CONFIG.replace('[imap]', `output = ${outputDir}\n\n[imap]`),
        {
          ...emptyResults(),
          smtpTlsReports: domainMapTlsReports().slice(0, 1),
        },
      );
    } finally {
      logs.restore();
    }

    expect(verdicts).toEqual([false]);
    expect(
      logs.records.some(record =>
        record.message.startsWith('File output Error: '),
      ),
    ).toBe(true);
  });
});

describe('text from reports in log lines', () => {
  it('escapes the policy domain of a dropped SMTP TLS report', () => {
    const logs = captureLogs(logger, DEBUG);
    logger.setLevel(DEBUG);
    try {
      filterSmtpTlsReportsForIndexPrefix(
        [
          {
            policies: [
              { policyDomain: 'unmapped.invalid\nFAKE CRITICAL LINE' },
            ],
          } as unknown as SMTPTLSReport,
        ],
        new Map([['tenant', ['example.com']]]),
      );
    } finally {
      logs.restore();
    }
    const line = logs.records.find(record =>
      record.message.startsWith('Ignoring SMTP TLS report'),
    );
    expect(line?.message).toContain(String.raw`\nFAKE CRITICAL LINE`);
    expect(line?.message).not.toContain('\n');
  });

  it('escapes an output error logged through fail_on_output_error', async () => {
    vi.mocked(elastic.saveAggregateReportToElasticsearch).mockRejectedValue(
      new elastic.ElasticsearchError('bad value\r\nFAKE CRITICAL LINE'),
    );
    const configPath = writeFile(
      'config.ini',
      `[general]
save_aggregate = true
fail_on_output_error = true
silent = true
offline = true

[elasticsearch]
hosts = localhost
`,
    );
    const logs = captureLogs();
    try {
      await expect(
        main(['-c', configPath, SAMPLE_AGGREGATE_REPORT_PATH]),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      logs.restore();
    }

    const final = logs.records.find(record =>
      record.message.startsWith('Output destination failures detected:'),
    );
    expect(final?.message).toContain(String.raw`\r\nFAKE CRITICAL LINE`);
    expect(final?.message).not.toMatch(/[\r\n]/u);
  });

  it('escapes the output errors in the ParserError the mailbox gets', async () => {
    vi.mocked(getDmarcReportsFromMailbox).mockResolvedValue(emptyResults());
    vi.mocked(elastic.saveAggregateReportToElasticsearch).mockRejectedValue(
      new elastic.ElasticsearchError('bad value\r\nFAKE CRITICAL LINE'),
    );
    const configPath = writeFile(
      'config.ini',
      `[general]
save_aggregate = true
fail_on_output_error = true
silent = true
${IMAP}
[elasticsearch]
hosts = localhost
`,
    );
    await main(['-c', configPath]);
    const saveCallback = vi.mocked(getDmarcReportsFromMailbox).mock
      .calls[0]?.[1].saveCallback as SaveCallback;

    const error: unknown = await Promise.resolve(
      saveCallback({
        ...emptyResults(),
        aggregateReports: await sampleAggregateReports(),
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ParserError);
    expect((error as ParserError).message).toContain(
      String.raw`\r\nFAKE CRITICAL LINE`,
    );
    expect((error as ParserError).message).not.toMatch(/[\r\n]/u);
  });

  it('escapes the error of a thrown ParserError from the mailbox', async () => {
    vi.mocked(getDmarcReportsFromMailbox).mockRejectedValue(
      new ParserError('a\nFAKE CRITICAL LINE'),
    );
    const configPath = writeFile(
      'config.ini',
      `[general]\nsilent = true\n${IMAP}`,
    );
    const logs = captureLogs();
    try {
      await expect(main(['-c', configPath])).rejects.toMatchObject({ code: 1 });
    } finally {
      logs.restore();
    }

    for (const record of logs.records) {
      expect(record.message).not.toContain('\nFAKE');
    }
  });
});
