// Ported from parsedmarc 11.2.1 tests/test_cli.py: TestParseConfigLoki,
// TestLokiCliWiring, TestParseConfigUseDataStreams,
// TestUseDataStreamsPassthrough and TestInitOutputClientsDoesNotLogCredentials.
// (TestHttpxLogRedaction and TestHttpx2LogRedaction don't apply: tsdmarc
// has no httpx logger; its own HTTP code masks URLs where it logs them.)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as elastic from '@tsdmarc/elasticsearch';
import { IMAPConnection } from '@tsdmarc/imap';
import * as opensearch from '@tsdmarc/opensearch';
import {
  captureLogs,
  DEBUG,
  LokiClient,
  LokiError,
  logger,
  type ParsingResults,
  WARNING,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseConfig } from './config';
import { ConfigParser } from './configparser';
import * as core from './core';
import { resolveSectionKey } from './env';
import { ConfigurationError } from './errors';
import { main } from './main';
import { type CliOptions, createOptions } from './options';
import {
  closeOutputClients,
  initOutputClients,
  type OutputClients,
} from './outputs';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-cli-11-2-'));
  tempDirs.push(dir);
  const configPath = path.join(dir, 'tsdmarc.ini');
  writeFileSync(configPath, content);
  return configPath;
}

/** A ConfigParser holding the given sections (Python's `_config_with`). */
function configWith(
  sections: Record<string, Record<string, string>>,
): ConfigParser {
  const config = new ConfigParser();
  for (const [section, settings] of Object.entries(sections)) {
    config.addSection(section);
    for (const [key, value] of Object.entries(settings)) {
      config.set(section, key, value);
    }
  }
  return config;
}

async function parsed(
  sections: Record<string, Record<string, string>>,
): Promise<CliOptions> {
  const opts = createOptions();
  await parseConfig(configWith(sections), opts);
  return opts;
}

function fetchInvokingSaveCallback(
  reports: ParsingResults,
): typeof core.getDmarcReportsFromMailbox {
  return async (_connection, options) => {
    await options.saveCallback?.(reports);
    return reports;
  };
}

function fakeSearchClient(): never {
  return { close: vi.fn(async () => undefined) } as never;
}

const IMAP_CONFIG = `[imap]
host = imap.example.com
user = test-user
password = imap-password-placeholder
`;

describe('TestParseConfigLoki', () => {
  it('test_loki_complete', async () => {
    const opts = await parsed({
      loki: {
        url: 'https://loki.example.com',
        labels: 'host=mail2.example.com, env = prod',
        label_fields: 'report_type, domain, org_name',
        timestamp: 'report_begin',
        username: 'u',
        password: 'p',
        tenant_id: 'fosdem',
        skip_certificate_verification: 'true',
        timeout: '12.5',
        batch_size: '500',
      },
    });
    expect(opts.lokiUrl).toBe('https://loki.example.com');
    expect(opts.lokiLabels).toEqual({ host: 'mail2.example.com', env: 'prod' });
    expect(opts.lokiLabelFields).toEqual(['report_type', 'domain', 'org_name']);
    expect(opts.lokiTimestamp).toBe('report_begin');
    expect(opts.lokiUsername).toBe('u');
    expect(opts.lokiPassword).toBe('p');
    expect(opts.lokiTenantId).toBe('fosdem');
    expect(opts.lokiSkipCertificateVerification).toBe(true);
    expect(opts.lokiTimeout).toBe(12.5);
    expect(opts.lokiBatchSize).toBe(500);
  });

  it('test_loki_token', async () => {
    const opts = await parsed({ loki: { url: 'http://l:3100', token: 't' } });
    expect(opts.lokiToken).toBe('t');
  });

  it('test_loki_empty_label_fields_means_no_dynamic_labels', async () => {
    const opts = await parsed({
      loki: { url: 'http://l:3100', label_fields: '' },
    });
    expect(opts.lokiLabelFields).toEqual([]);
  });

  it('test_loki_label_fields_strips_whitespace_around_each_field', async () => {
    const opts = await parsed({
      loki: {
        url: 'http://l:3100',
        label_fields: 'report_type , domain ,org_name ',
      },
    });
    expect(opts.lokiLabelFields).toEqual(['report_type', 'domain', 'org_name']);
  });

  it('test_loki_missing_url_raises', async () => {
    await expect(parsed({ loki: { labels: 'a=b' } })).rejects.toThrow(
      new ConfigurationError(
        'url setting missing from the loki config section',
      ),
    );
  });

  it('test_loki_malformed_labels_raise', async () => {
    for (const labels of ['host', '=value']) {
      // oxlint-disable-next-line no-await-in-loop -- one run per case
      await expect(
        parsed({ loki: { url: 'http://l:3100', labels } }),
      ).rejects.toThrow(
        new ConfigurationError(
          `Invalid loki label '${labels}', expected name=value`,
        ),
      );
    }
  });

  it('test_loki_invalid_timestamp_raises', async () => {
    await expect(
      parsed({ loki: { url: 'http://l:3100', timestamp: 'never' } }),
    ).rejects.toThrow(
      new ConfigurationError(
        "Invalid loki timestamp 'never', must be one of: ingest, report_begin",
      ),
    );
  });

  it('test_loki_env_section_resolves', () => {
    expect(resolveSectionKey('LOKI_URL')).toEqual(['loki', 'url']);
    expect(resolveSectionKey('LOKI_PASSWORD')).toEqual(['loki', 'password']);
  });
});

describe('TestLokiCliWiring', () => {
  beforeEach(() => {
    // The CLI's console handler would write every record to stderr.
    logger.disabled = true;
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue({
      close: vi.fn(async () => undefined),
    } as unknown as IMAPConnection);
  });

  const reports = (): ParsingResults =>
    ({
      aggregateReports: [{ policyPublished: { domain: 'example.com' } }],
      failureReports: [{ reportedDomain: 'example.com' }],
      smtpTlsReports: [{ organizationName: 'Org', policies: [] }],
    }) as unknown as ParsingResults;

  function lokiConfig(extraGeneral = ''): string {
    return writeConfig(`[general]
save_aggregate = true
save_failure = true
save_smtp_tls = true
silent = true
offline = true
${extraGeneral}

${IMAP_CONFIG}
[loki]
url = http://loki.example.com:3100
labels = host=mail2.example.com
timestamp = report_begin
tenant_id = fosdem
`);
  }

  function spyOnSaves(
    implementation: () => Promise<void> = async () => undefined,
  ): Record<
    | 'saveAggregateReportToLoki'
    | 'saveFailureReportToLoki'
    | 'saveSmtpTlsReportToLoki',
    ReturnType<typeof vi.fn>
  > {
    return {
      saveAggregateReportToLoki: vi
        .spyOn(LokiClient.prototype, 'saveAggregateReportToLoki')
        .mockImplementation(implementation),
      saveFailureReportToLoki: vi
        .spyOn(LokiClient.prototype, 'saveFailureReportToLoki')
        .mockImplementation(implementation),
      saveSmtpTlsReportToLoki: vi
        .spyOn(LokiClient.prototype, 'saveSmtpTlsReportToLoki')
        .mockImplementation(implementation),
    } as never;
  }

  it('test_client_constructed_from_config', async () => {
    spyOnSaves();
    let built: LokiClient | undefined;
    vi.mocked(core.getDmarcReportsFromMailbox).mockImplementation(
      async (_connection, options) => {
        await options.saveCallback?.(reports());
        return reports();
      },
    );
    vi.spyOn(LokiClient.prototype, 'close').mockImplementation(function (
      this: LokiClient,
    ) {
      built = this;
    });
    await main(['-c', lokiConfig()]);
    expect(built).toBeInstanceOf(LokiClient);
    expect(built?.url).toBe('http://loki.example.com:3100/loki/api/v1/push');
    expect(built?.labels).toMatchObject({
      job: 'parsedmarc',
      host: 'mail2.example.com',
    });
    expect(built?.labelFields).toEqual(['report_type', 'domain']);
    expect(built?.timestamp).toBe('report_begin');
    expect(built?.headers['X-Scope-OrgID']).toBe('fosdem');
    expect(built?.verify).toBe(true);
    expect(built?.timeout).toBe(60);
    expect(built?.batchSize).toBe(1000);
  });

  it('test_all_report_types_saved_and_client_closed', async () => {
    const saves = spyOnSaves();
    const close = vi.spyOn(LokiClient.prototype, 'close');
    const results = reports();
    vi.mocked(core.getDmarcReportsFromMailbox).mockImplementation(
      fetchInvokingSaveCallback(results),
    );
    await main(['-c', lokiConfig()]);
    expect(saves.saveAggregateReportToLoki).toHaveBeenCalledExactlyOnceWith(
      results.aggregateReports[0],
    );
    expect(saves.saveFailureReportToLoki).toHaveBeenCalledExactlyOnceWith(
      results.failureReports[0],
    );
    expect(saves.saveSmtpTlsReportToLoki).toHaveBeenCalledExactlyOnceWith(
      results.smtpTlsReports[0],
    );
    expect(close).toHaveBeenCalled();
  });

  it('test_loki_error_is_an_output_error', async () => {
    spyOnSaves(async () => {
      throw new LokiError('HTTP 503');
    });
    vi.mocked(core.getDmarcReportsFromMailbox).mockImplementation(
      fetchInvokingSaveCallback(reports()),
    );
    await expect(
      main(['-c', lokiConfig('fail_on_output_error = true')]),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('test_rejected_client_config_names_the_loki_section', async () => {
    const opts = await parsed({
      loki: { url: 'http://loki.example.com:3100', token: 't', username: 'u' },
    });
    const error: unknown = await initOutputClients(opts).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      name: 'RuntimeError',
      message: 'Loki: Loki token and username/password are exclusive',
    });
    expect((error as Error).cause).toMatchObject({ name: 'ValueError' });
  });
});

describe('TestParseConfigUseDataStreams', () => {
  const SECTIONS = ['elasticsearch', 'opensearch'] as const;

  it('test_option_parsed_for_each_section', async () => {
    const opts = await parsed({
      elasticsearch: { hosts: 'localhost', use_data_streams: 'true' },
      opensearch: { hosts: 'localhost', use_data_streams: 'true' },
    });
    expect(opts.elasticsearchUseDataStreams).toBe(true);
    expect(opts.opensearchUseDataStreams).toBe(true);
  });

  it('test_option_absent_leaves_the_default', async () => {
    const opts = await parsed({
      elasticsearch: { hosts: 'localhost' },
      opensearch: { hosts: 'localhost' },
    });
    expect(opts.elasticsearchUseDataStreams).toBe(false);
    expect(opts.opensearchUseDataStreams).toBe(false);
  });

  it('test_monthly_indexes_with_data_streams_warns', async () => {
    for (const section of SECTIONS) {
      const logs = captureLogs(undefined, WARNING);
      try {
        // oxlint-disable-next-line no-await-in-loop -- one run per case
        await parsed({
          [section]: {
            hosts: 'localhost',
            monthly_indexes: 'true',
            use_data_streams: 'true',
          },
        });
      } finally {
        logs.restore();
      }
      expect(logs.output).toEqual([
        `WARNING:tsdmarc:[${section}] monthly_indexes is ignored because use_data_streams is enabled`,
      ]);
    }
  });

  it('test_no_warning_unless_both_are_enabled', async () => {
    for (const section of SECTIONS) {
      for (const [monthly, streams] of [
        ['true', 'false'],
        ['false', 'true'],
      ]) {
        const logs = captureLogs(undefined, WARNING);
        try {
          // oxlint-disable-next-line no-await-in-loop -- one run per case
          await parsed({
            [section]: {
              hosts: 'localhost',
              monthly_indexes: monthly ?? '',
              use_data_streams: streams ?? '',
            },
          });
        } finally {
          logs.restore();
        }
        expect(logs.output).toEqual([]);
      }
    }
  });
});

describe('TestUseDataStreamsPassthrough', () => {
  beforeEach(() => {
    logger.disabled = true;
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue({
      close: vi.fn(async () => undefined),
    } as unknown as IMAPConnection);
    vi.mocked(core.getDmarcReportsFromMailbox).mockImplementation(
      fetchInvokingSaveCallback({
        aggregateReports: [{ policyPublished: { domain: 'example.com' } }],
        failureReports: [{ reportedDomain: 'example.com' }],
        smtpTlsReports: [{ organizationName: 'Org', policies: [] }],
      } as unknown as ParsingResults),
    );
    vi.mocked(elastic.setHosts).mockResolvedValue(fakeSearchClient());
    vi.mocked(elastic.migrateIndexes).mockResolvedValue();
    vi.mocked(opensearch.setHosts).mockResolvedValue(fakeSearchClient());
    vi.mocked(opensearch.migrateIndexes).mockResolvedValue();
    for (const save of [
      elastic.saveAggregateReportToElasticsearch,
      elastic.saveFailureReportToElasticsearch,
      elastic.saveSmtpTlsReportToElasticsearch,
      opensearch.saveAggregateReportToOpenSearch,
      opensearch.saveFailureReportToOpenSearch,
      opensearch.saveSmtpTlsReportToOpenSearch,
    ]) {
      vi.mocked(save).mockResolvedValue(undefined as never);
    }
  });

  async function run(sections: string): Promise<void> {
    await main([
      '-c',
      writeConfig(`[general]
save_aggregate = true
save_failure = true
save_smtp_tls = true
silent = true
offline = true

${IMAP_CONFIG}
${sections}`),
    ]);
  }

  function useDataStreams(save: unknown): unknown[] {
    return vi
      .mocked(save as (report: unknown, options: unknown) => unknown)
      .mock.calls.map(
        ([, options]) =>
          (options as { useDataStreams?: unknown }).useDataStreams,
      );
  }

  const ES_SAVES = [
    elastic.saveAggregateReportToElasticsearch,
    elastic.saveFailureReportToElasticsearch,
    elastic.saveSmtpTlsReportToElasticsearch,
  ];
  const OS_SAVES = [
    opensearch.saveAggregateReportToOpenSearch,
    opensearch.saveFailureReportToOpenSearch,
    opensearch.saveSmtpTlsReportToOpenSearch,
  ];

  it('test_enabled_in_both_sections_reaches_every_save_call', async () => {
    await run(`[elasticsearch]
hosts = localhost
use_data_streams = true

[opensearch]
hosts = localhost
use_data_streams = true
`);
    for (const save of [...ES_SAVES, ...OS_SAVES]) {
      expect(useDataStreams(save)).toEqual([true]);
    }
  });

  it('test_elasticsearch_section_only_reaches_elasticsearch_saves', async () => {
    await run(`[elasticsearch]
hosts = localhost
use_data_streams = true

[opensearch]
hosts = localhost
`);
    for (const save of ES_SAVES) {
      expect(useDataStreams(save)).toEqual([true]);
    }
    for (const save of OS_SAVES) {
      expect(useDataStreams(save)).toEqual([false]);
    }
  });

  it('test_opensearch_section_only_reaches_opensearch_saves', async () => {
    await run(`[elasticsearch]
hosts = localhost

[opensearch]
hosts = localhost
use_data_streams = true
`);
    for (const save of ES_SAVES) {
      expect(useDataStreams(save)).toEqual([false]);
    }
    for (const save of OS_SAVES) {
      expect(useDataStreams(save)).toEqual([true]);
    }
  });
});

describe('TestInitOutputClientsDoesNotLogCredentials', () => {
  const SECRET = 'S3cretPassw0rd-placeholder';

  async function init(
    overrides: Partial<CliOptions>,
  ): Promise<{ output: string; error: unknown }> {
    const opts = { ...createOptions(), ...overrides };
    const logs = captureLogs(undefined, DEBUG);
    let clients: OutputClients | null = null;
    let error: unknown = null;
    try {
      clients = await initOutputClients(opts);
    } catch (caught) {
      error = caught;
    } finally {
      logs.restore();
      if (clients !== null) {
        await closeOutputClients(clients);
      }
    }
    return { output: logs.output.join('\n'), error };
  }

  it('test_hec_url_password_is_masked', async () => {
    const { output } = await init({
      hec: `https://hecuser:${SECRET}@hec.example:8088`,
      hecToken: 'tok',
      hecIndex: 'email',
    });
    expect(output).not.toContain(SECRET);
    expect(output).toContain('url=https://hecuser:***@hec.example:8088');
  });

  it('test_hec_malformed_url_password_is_masked', async () => {
    for (const password of ['p4ssw0rd/extra', 'p4ss?w0rd', 'p4ss#w0rd']) {
      // oxlint-disable-next-line no-await-in-loop -- one run per case
      const { output } = await init({
        hec: `https://hecuser:${password}@hec.example:8088`,
        hecToken: 'tok',
        hecIndex: 'email',
      });
      expect(output).not.toContain('p4ss');
      expect(output).toContain('url=https://***@hec.example:8088');
    }
  });

  it('test_loki_url_password_is_masked', async () => {
    const { output } = await init({
      lokiUrl: `https://lokiuser:${SECRET}@loki.example:3100`,
      lokiTimeout: 1.0,
      lokiBatchSize: 100,
    });
    expect(output).not.toContain(SECRET);
    expect(output).toContain('url=https://lokiuser:***@loki.example:3100');
  });

  it('test_loki_malformed_url_error_has_no_password', async () => {
    for (const [url, secret] of [
      ['https://admin:p4ssw0rd/extra@loki.example:3100', 'p4ssw0rd'],
      ['https://admin:p4ss?w0rd@loki.example:3100', 'p4ss'],
      ['https://admin:p4ss#w0rd@loki.example:3100', 'p4ss'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one run per case
      const { output, error } = await init({
        lokiUrl: url,
        lokiTimeout: 1.0,
        lokiBatchSize: 100,
      });
      expect(error).toMatchObject({
        name: 'RuntimeError',
        message:
          'Loki: Invalid Loki URL (details withheld because they may include credentials)',
      });
      expect(String((error as Error).cause)).not.toContain(secret);
      expect(output).not.toContain(secret);
      expect(output).toContain('url=https://***@loki.example:3100');
    }
  });

  it('test_elasticsearch_hosts_password_is_masked', async () => {
    vi.mocked(elastic.setHosts).mockResolvedValue(fakeSearchClient());
    vi.mocked(elastic.migrateIndexes).mockResolvedValue();
    const host = `https://u:${SECRET}@search.example:9299`;
    const { output } = await init({
      saveAggregate: true,
      elasticsearchHosts: [host],
      elasticsearchTimeout: 1.0,
    });
    expect(output).not.toContain(SECRET);
    expect(output).toContain(
      "Initializing Elasticsearch client: hosts=['https://u:***@search.example:9299']",
    );
    // Redaction is log-only: the client still gets the real credentials.
    expect(vi.mocked(elastic.setHosts).mock.calls[0]?.[0]).toEqual([host]);
  });

  it('test_opensearch_hosts_password_is_masked', async () => {
    vi.mocked(opensearch.setHosts).mockResolvedValue(fakeSearchClient());
    vi.mocked(opensearch.migrateIndexes).mockResolvedValue();
    const host = `https://u:${SECRET}@search.example:9299`;
    const { output } = await init({
      saveAggregate: true,
      opensearchHosts: [host],
      opensearchTimeout: 1.0,
    });
    expect(output).not.toContain(SECRET);
    expect(output).toContain(
      "Initializing OpenSearch client: hosts=['https://u:***@search.example:9299']",
    );
    expect(vi.mocked(opensearch.setHosts).mock.calls[0]?.[0]).toEqual([host]);
  });
});
