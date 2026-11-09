// Ported from parsedmarc tests/test_cli.py: TestParseConfigS3,
// TestParseConfigPostgreSQL, TestParseConfigSyslog, TestParseConfigGmailApi,
// TestParseConfigLogAnalytics, TestParseConfigGelf, TestParseConfigWebhook,
// and the parts of TestOptionalIntegrationExtras that apply to tsdmarc.

import * as elastic from '@tsdmarc/elasticsearch';
import { KafkaClient } from '@tsdmarc/kafka';
import * as opensearch from '@tsdmarc/opensearch';
import { PostgreSQLClient } from '@tsdmarc/postgres';
import { describe, expect, it, vi } from 'vitest';

import { parseConfig } from './config';
import { ConfigParser } from './configparser';
import { ConfigurationError } from './errors';
import { type CliOptions, createOptions } from './options';
import { closeOutputClients, initOutputClients } from './outputs';

/** A ConfigParser holding exactly one section. */
function configWith(
  section: string,
  settings: Record<string, string>,
): ConfigParser {
  const config = new ConfigParser();
  config.addSection(section);
  for (const [key, value] of Object.entries(settings)) {
    config.set(section, key, value);
  }
  return config;
}

async function parsed(
  section: string,
  settings: Record<string, string>,
): Promise<CliOptions> {
  const opts = createOptions();
  await parseConfig(configWith(section, settings), opts);
  return opts;
}

async function expectConfigurationError(
  section: string,
  settings: Record<string, string>,
): Promise<ConfigurationError> {
  const error: unknown = await parseConfig(
    configWith(section, settings),
    createOptions(),
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ConfigurationError);
  return error as ConfigurationError;
}

describe('TestParseConfigS3', () => {
  it('test_s3_complete', async () => {
    const opts = await parsed('s3', {
      bucket: 'my-bucket',
      path: '/dmarc/',
      region_name: 'us-east-1',
      endpoint_url: 'https://s3.example.com',
      access_key_id: 'AKIA-x',
      secret_access_key: 'secret',
    });
    expect(opts.s3Bucket).toBe('my-bucket');
    // Leading and trailing slashes are stripped.
    expect(opts.s3Path).toBe('dmarc');
    expect(opts.s3RegionName).toBe('us-east-1');
    expect(opts.s3EndpointUrl).toBe('https://s3.example.com');
    expect(opts.s3AccessKeyId).toBe('AKIA-x');
    expect(opts.s3SecretAccessKey).toBe('secret');
  });

  it('test_s3_default_path_is_empty', async () => {
    expect((await parsed('s3', { bucket: 'b' })).s3Path).toBe('');
  });

  it('test_s3_missing_bucket_raises', async () => {
    await expectConfigurationError('s3', { path: 'x' });
  });
});

describe('TestParseConfigPostgreSQL', () => {
  it('test_postgresql_individual_params', async () => {
    const opts = await parsed('postgresql', {
      host: 'db.example.com',
      port: '6543',
      user: 'pmarc',
      password: 'secret',
      database: 'dmarc',
    });
    expect(opts.postgresqlHost).toBe('db.example.com');
    expect(opts.postgresqlPort).toBe(6543);
    expect(opts.postgresqlUser).toBe('pmarc');
    expect(opts.postgresqlPassword).toBe('secret');
    expect(opts.postgresqlDatabase).toBe('dmarc');
  });

  // connection_string is read and the host branch is skipped entirely.
  it('test_postgresql_connection_string_takes_precedence', async () => {
    const opts = await parsed('postgresql', {
      connection_string: 'postgresql://u:p@h/db',
      host: 'ignored.example.com',
    });
    expect(opts.postgresqlConnectionString).toBe('postgresql://u:p@h/db');
    // Python asserts the attribute is never set; here it keeps its default.
    expect(opts.postgresqlHost).toBeNull();
  });

  it('test_postgresql_missing_host_and_dsn_raises', async () => {
    const error = await expectConfigurationError('postgresql', {
      port: '5432',
    });
    expect(error.message).toContain('postgresql');
  });
});

describe('TestParseConfigSyslog', () => {
  it('test_syslog_complete', async () => {
    const opts = await parsed('syslog', {
      server: 'syslog.example.com',
      port: '6514',
      protocol: 'tls',
      cafile_path: '/etc/ca.pem',
      certfile_path: '/etc/c.pem',
      keyfile_path: '/etc/k.pem',
      timeout: '10.0',
      retry_attempts: '5',
      retry_delay: '2',
    });
    expect(opts.syslogServer).toBe('syslog.example.com');
    expect(opts.syslogPort).toBe('6514');
    expect(opts.syslogProtocol).toBe('tls');
    expect(opts.syslogCafilePath).toBe('/etc/ca.pem');
    expect(opts.syslogCertfilePath).toBe('/etc/c.pem');
    expect(opts.syslogKeyfilePath).toBe('/etc/k.pem');
    expect(opts.syslogTimeout).toBe(10.0);
    expect(opts.syslogRetryAttempts).toBe(5);
    expect(opts.syslogRetryDelay).toBe(2);
  });

  it('test_syslog_defaults', async () => {
    const opts = await parsed('syslog', { server: 's' });
    expect(opts.syslogPort).toBe(514);
    expect(opts.syslogProtocol).toBe('udp');
    expect(opts.syslogTimeout).toBe(5.0);
    expect(opts.syslogRetryAttempts).toBe(3);
    expect(opts.syslogRetryDelay).toBe(5);
  });

  it('test_syslog_missing_server_raises', async () => {
    await expectConfigurationError('syslog', { port: '514' });
  });
});

describe('TestParseConfigGmailApi', () => {
  it('test_gmail_api_complete', async () => {
    const opts = await parsed('gmail_api', {
      credentials_file: '/etc/gmail-creds.json',
      token_file: '/var/lib/parsedmarc/gmail.token',
      include_spam_trash: 'true',
      paginate_messages: 'false',
      scopes: 'https://www.googleapis.com/auth/gmail.readonly',
      oauth2_port: '8888',
      auth_mode: 'device_code',
      service_account_user: 'user@example.com',
    });
    expect(opts.gmailApiCredentialsFile).toBe('/etc/gmail-creds.json');
    expect(opts.gmailApiTokenFile).toBe('/var/lib/parsedmarc/gmail.token');
    expect(opts.gmailApiIncludeSpamTrash).toBe(true);
    expect(opts.gmailApiPaginateMessages).toBe(false);
    expect(opts.gmailApiScopes).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
    ]);
    expect(opts.gmailApiOauth2Port).toBe(8888);
    expect(opts.gmailApiAuthMode).toBe('device_code');
    expect(opts.gmailApiServiceAccountUser).toBe('user@example.com');
  });

  // `delegated_user` is the legacy spelling of `service_account_user`.
  it('test_gmail_api_delegated_user_alias', async () => {
    const opts = await parsed('gmail_api', {
      credentials_file: '/c',
      delegated_user: 'legacy@example.com',
    });
    expect(opts.gmailApiServiceAccountUser).toBe('legacy@example.com');
  });

  it('test_gmail_api_default_scope', async () => {
    const opts = await parsed('gmail_api', { credentials_file: '/c' });
    expect(opts.gmailApiScopes).toEqual([
      'https://www.googleapis.com/auth/gmail.modify',
    ]);
  });
});

describe('TestParseConfigLogAnalytics', () => {
  it('test_log_analytics_complete', async () => {
    const opts = await parsed('log_analytics', {
      client_id: 'cid',
      client_secret: 'csec',
      tenant_id: 'tid',
      dce: 'https://dce.example.com',
      dcr_immutable_id: 'dcr-1',
      dcr_aggregate_stream: 'Custom-Aggregate_CL',
      dcr_failure_stream: 'Custom-Failure_CL',
      dcr_smtp_tls_stream: 'Custom-SMTPTLS_CL',
    });
    expect(opts.laClientId).toBe('cid');
    expect(opts.laClientSecret).toBe('csec');
    expect(opts.laTenantId).toBe('tid');
    expect(opts.laDce).toBe('https://dce.example.com');
    expect(opts.laDcrImmutableId).toBe('dcr-1');
    expect(opts.laDcrAggregateStream).toBe('Custom-Aggregate_CL');
    expect(opts.laDcrFailureStream).toBe('Custom-Failure_CL');
    expect(opts.laDcrSmtpTlsStream).toBe('Custom-SMTPTLS_CL');
  });

  it('test_log_analytics_forensic_stream_alias', async () => {
    const opts = await parsed('log_analytics', {
      client_id: 'c',
      dcr_forensic_stream: 'Old-Forensic_CL',
    });
    expect(opts.laDcrFailureStream).toBe('Old-Forensic_CL');
  });
});

describe('TestParseConfigGelf', () => {
  it('test_gelf_complete', async () => {
    const opts = await parsed('gelf', {
      host: 'graylog.example.com',
      port: '12201',
      mode: 'tls',
    });
    expect(opts.gelfHost).toBe('graylog.example.com');
    expect(opts.gelfPort).toBe('12201');
    expect(opts.gelfMode).toBe('tls');
  });

  it('test_gelf_missing_host_raises', async () => {
    await expectConfigurationError('gelf', { port: '12201', mode: 'udp' });
  });

  it('test_gelf_missing_port_raises', async () => {
    await expectConfigurationError('gelf', { host: 'g', mode: 'udp' });
  });

  it('test_gelf_missing_mode_raises', async () => {
    await expectConfigurationError('gelf', { host: 'g', port: '12201' });
  });
});

describe('TestParseConfigWebhook', () => {
  it('test_webhook_complete', async () => {
    const opts = await parsed('webhook', {
      aggregate_url: 'https://hooks.example.com/agg',
      failure_url: 'https://hooks.example.com/fail',
      smtp_tls_url: 'https://hooks.example.com/tls',
      timeout: '30',
    });
    expect(opts.webhookAggregateUrl).toBe('https://hooks.example.com/agg');
    expect(opts.webhookFailureUrl).toBe('https://hooks.example.com/fail');
    expect(opts.webhookSmtpTlsUrl).toBe('https://hooks.example.com/tls');
    expect(opts.webhookTimeout).toBe(30);
  });

  it('test_webhook_forensic_url_alias_sets_failure_url', async () => {
    const opts = await parsed('webhook', {
      forensic_url: 'https://old.example.com/fail',
    });
    expect(opts.webhookFailureUrl).toBe('https://old.example.com/fail');
  });
});

// parsedmarc's optional extras (#883) do not exist in tsdmarc: every output
// package is a dependency of @tsdmarc/cli, so the missing-extra hints, the
// import blockers and the sentinel error classes have nothing to test. What
// still applies: each configured output builds exactly its own client.
describe('TestOptionalIntegrationExtras', () => {
  const fakeClient = (): { close: ReturnType<typeof vi.fn> } => ({
    close: vi.fn(async () => undefined),
  });

  const cases: [string, Partial<CliOptions>, string | null, () => void][] = [
    [
      'elasticsearch',
      { elasticsearchHosts: ['host:9200'] },
      'elasticsearch',
      () => {
        vi.mocked(elastic.setHosts).mockResolvedValue(
          fakeClient() as unknown as Awaited<
            ReturnType<typeof elastic.setHosts>
          >,
        );
        vi.mocked(elastic.migrateIndexes).mockResolvedValue(undefined);
      },
    ],
    [
      'opensearch',
      { opensearchHosts: ['host:9200'] },
      'opensearch',
      () => {
        vi.mocked(opensearch.setHosts).mockResolvedValue(
          fakeClient() as unknown as Awaited<
            ReturnType<typeof opensearch.setHosts>
          >,
        );
        vi.mocked(opensearch.migrateIndexes).mockResolvedValue(undefined);
      },
    ],
    [
      'kafka',
      { kafkaHosts: ['host:9092'] },
      'kafka_client',
      () => {
        vi.spyOn(KafkaClient, 'create').mockResolvedValue(
          fakeClient() as unknown as KafkaClient,
        );
      },
    ],
    ['s3', { s3Bucket: 'reports' }, 's3_client', () => undefined],
    [
      'gelf',
      { gelfHost: '127.0.0.1', gelfPort: 12_201, gelfMode: 'udp' },
      'gelf_client',
      () => undefined,
    ],
    [
      'log_analytics',
      { laDce: 'https://dce.example.com' },
      null,
      () => undefined,
    ],
  ];

  // test_present_extra_initializes_without_the_hint: the client the section
  // asks for is the only one built (Log Analytics is built per batch).
  it.each(cases)(
    '%s builds only its own client',
    async (_name, overrides, key, mock) => {
      mock();
      const opts = { ...createOptions(), saveAggregate: true, ...overrides };
      const clients = await initOutputClients(opts);
      try {
        expect([...clients.keys()]).toEqual(key === null ? [] : [key]);
      } finally {
        await closeOutputClients(clients);
      }
    },
  );

  // test_log_analytics_extra_is_checked_before_reports_are_parsed: with
  // nothing configured, nothing is built.
  it('builds no client when nothing is configured', async () => {
    const clients = await initOutputClients(createOptions());
    expect(clients.size).toBe(0);
  });

  // The positive half of test_missing_postgresql_extra_raises_configuration_error.
  it('builds the PostgreSQL client for a [postgresql] host', async () => {
    const client = {
      ...fakeClient(),
      createTables: vi.fn(async () => undefined),
    };
    vi.spyOn(PostgreSQLClient, 'create').mockResolvedValue(
      client as unknown as PostgreSQLClient,
    );
    const opts = { ...createOptions(), postgresqlHost: 'db.example.com' };
    const clients = await initOutputClients(opts);
    try {
      expect([...clients.keys()]).toEqual(['postgresql_client']);
      expect(clients.get('postgresql_client')).toBe(client);
      expect(client.createTables).toHaveBeenCalledTimes(1);
    } finally {
      await closeOutputClients(clients);
    }
  });
});
