// Port of parsedmarc's TestConfigAliases, _StrToListTests and the
// TestParseConfig* classes for [mailbox], [general], [elasticsearch],
// [opensearch], [splunk_hec], [kafka] and [smtp] (tests/test_cli.py).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as elastic from '@tsdmarc/elasticsearch';
import { IMAPConnection } from '@tsdmarc/imap';
import { captureLogs, NoAnswer, NXDOMAIN, queryDns } from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, parseConfig, strToList } from './config';
import { ConfigParser } from './configparser';
import * as core from './core';
import { ConfigurationError } from './errors';
import { main } from './main';
import { type CliOptions, createOptions } from './options';
import { buildParserConfig } from './outputs';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cli-config-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A ConfigParser holding exactly one section (Python's `_config_with`). */
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

/** Python's `_opts()`: the options a parse starts from. */
function opts(): CliOptions {
  return createOptions();
}

async function parsed(config: ConfigParser): Promise<CliOptions> {
  const options = opts();
  await parseConfig(config, options);
  return options;
}

describe('TestConfigAliases', () => {
  it('test_maildir_create_alias', async () => {
    process.env.PARSEDMARC_MAILDIR_CREATE = 'true';
    process.env.PARSEDMARC_MAILDIR_PATH = '/tmp/test';
    const options = await parsed(loadConfig(null));
    expect(options.maildirCreate).toBe(true);
  });

  it('test_maildir_path_alias', async () => {
    process.env.PARSEDMARC_MAILDIR_PATH = '/var/mail/dmarc';
    const options = await parsed(loadConfig(null));
    expect(options.maildirPath).toBe('/var/mail/dmarc');
  });

  it('test_msgraph_url_alias', async () => {
    Object.assign(process.env, {
      PARSEDMARC_MSGRAPH_AUTH_METHOD: 'ClientSecret',
      PARSEDMARC_MSGRAPH_CLIENT_ID: 'test-id',
      PARSEDMARC_MSGRAPH_CLIENT_SECRET: 'test-secret',
      PARSEDMARC_MSGRAPH_TENANT_ID: 'test-tenant',
      PARSEDMARC_MSGRAPH_MAILBOX: 'test@example.com',
      PARSEDMARC_MSGRAPH_URL: 'https://custom.graph.example.com',
    });
    const options = await parsed(loadConfig(null));
    expect(options.graphUrl).toBe('https://custom.graph.example.com');
  });

  it('accepts the TSDMARC_ prefix for the same aliases', async () => {
    process.env.TSDMARC_MAILDIR_PATH = '/var/mail/tsdmarc';
    process.env.TSDMARC_MAILDIR_CREATE = 'yes';
    const options = await parsed(loadConfig(null));
    expect(options.maildirPath).toBe('/var/mail/tsdmarc');
    expect(options.maildirCreate).toBe(true);
  });

  it('test_original_keys_still_work', async () => {
    const config = new ConfigParser();
    config.addSection('maildir');
    config.set('maildir', 'maildir_path', '/original/path');
    config.set('maildir', 'maildir_create', 'true');
    const options = await parsed(config);
    expect(options.maildirPath).toBe('/original/path');
    expect(options.maildirCreate).toBe(true);
  });

  it('prefers maildir_path over path and maildir_create over create', async () => {
    const options = await parsed(
      configWith('maildir', {
        maildir_path: '/new',
        path: '/old',
        maildir_create: 'false',
        create: 'true',
      }),
    );
    expect(options.maildirPath).toBe('/new');
    expect(options.maildirCreate).toBe(false);
  });

  it('test_ipinfo_url_option', async () => {
    const options = await parsed(
      configWith('general', { ipinfo_url: 'https://mirror.example/mmdb' }),
    );
    expect(options.ipinfoUrl).toBe('https://mirror.example/mmdb');
  });

  it('reads csv_formula_escape (tsdmarc only, on by default)', async () => {
    expect((await parsed(configWith('general', {}))).csvFormulaEscape).toBe(
      true,
    );
    const options = await parsed(
      configWith('general', { csv_formula_escape: 'false' }),
    );
    expect(options.csvFormulaEscape).toBe(false);
  });

  it('test_ip_db_url_deprecated_alias', async () => {
    const logs = captureLogs();
    let options: CliOptions;
    try {
      options = await parsed(
        configWith('general', { ip_db_url: 'https://old.example/mmdb' }),
      );
    } finally {
      logs.restore();
    }
    expect(options.ipinfoUrl).toBe('https://old.example/mmdb');
    expect(
      logs.records.some(
        record =>
          record.levelName === 'WARNING' &&
          record.message.includes('ip_db_url') &&
          record.message.includes('deprecated'),
      ),
    ).toBe(true);
  });
});

describe('_StrToListTests', () => {
  it('test_str_to_list_strips_leading_whitespace_per_element', () => {
    expect(strToList('a, b ,c')).toEqual(['a', 'b ', 'c']);
  });

  it('test_str_to_list_single_value', () => {
    expect(strToList('solo')).toEqual(['solo']);
  });
});

describe('TestParseConfigMailbox', () => {
  it('test_mailbox_full_section', async () => {
    const options = await parsed(
      configWith('mailbox', {
        reports_folder: 'Reports',
        archive_folder: 'Processed',
        watch: 'true',
        delete: 'true',
        delete_aggregate: 'true',
        delete_failure: 'false',
        delete_smtp_tls: 'true',
        delete_invalid: 'false',
        test: 'false',
        batch_size: '25',
        check_timeout: '60',
        max_unsaved_retries: '5',
        since: '3d',
      }),
    );
    expect(options.mailboxReportsFolder).toBe('Reports');
    expect(options.mailboxArchiveFolder).toBe('Processed');
    expect(options.mailboxWatch).toBe(true);
    expect(options.mailboxDelete).toBe(true);
    expect(options.mailboxDeleteAggregate).toBe(true);
    // Explicitly false, not null: this type opts out of delete = true.
    expect(options.mailboxDeleteFailure).toBe(false);
    expect(options.mailboxDeleteSmtpTls).toBe(true);
    expect(options.mailboxDeleteInvalid).toBe(false);
    expect(options.mailboxTest).toBe(false);
    expect(options.mailboxBatchSize).toBe(25);
    expect(options.mailboxCheckTimeout).toBe(60);
    expect(options.mailboxMaxUnsavedRetries).toBe(5);
    expect(options.mailboxSince).toBe('3d');
  });

  it('test_mailbox_max_unsaved_retries_from_env_var', async () => {
    process.env.PARSEDMARC_MAILBOX_MAX_UNSAVED_RETRIES = '0';
    const options = await parsed(loadConfig(null));
    expect(options.mailboxMaxUnsavedRetries).toBe(0);
  });

  it('test_mailbox_absent_per_type_delete_keys_are_not_set', async () => {
    const options = await parsed(configWith('mailbox', { delete: 'true' }));
    expect(options.mailboxDelete).toBe(true);
    // Left at null ("unset", inheriting delete), never written as false.
    expect(options.mailboxDeleteAggregate).toBeNull();
    expect(options.mailboxDeleteFailure).toBeNull();
    expect(options.mailboxDeleteSmtpTls).toBeNull();
    expect(options.mailboxDeleteInvalid).toBeNull();
  });

  it('uses Inbox as the reports folder when [msgraph] is configured', async () => {
    const config = configWith('mailbox', { watch: 'false' });
    config.addSection('msgraph');
    for (const [key, value] of Object.entries({
      auth_method: 'ClientSecret',
      client_id: 'id',
      client_secret: 's',
      tenant_id: 't',
      mailbox: 'm@example.com',
    })) {
      config.set('msgraph', key, value);
    }
    expect((await parsed(config)).mailboxReportsFolder).toBe('Inbox');
  });
});

describe('TestParseConfigGeneral', () => {
  it('test_general_filenames_and_output', async () => {
    const options = await parsed(
      configWith('general', {
        silent: 'false',
        output: '/tmp/dmarc-out',
        aggregate_json_filename: 'agg.json',
        failure_json_filename: 'fail.json',
        smtp_tls_json_filename: 'tls.json',
        aggregate_csv_filename: 'agg.csv',
        failure_csv_filename: 'fail.csv',
        smtp_tls_csv_filename: 'tls.csv',
        save_aggregate: 'true',
        save_failure: 'true',
        save_smtp_tls: 'true',
        debug: 'false',
        verbose: 'false',
        warnings: 'false',
        fail_on_output_error: 'false',
        offline: 'true',
        strip_attachment_payloads: 'true',
        n_procs: '4',
      }),
    );
    expect(options.output).toBe('/tmp/dmarc-out');
    expect(options.aggregateJsonFilename).toBe('agg.json');
    expect(options.failureJsonFilename).toBe('fail.json');
    expect(options.smtpTlsCsvFilename).toBe('tls.csv');
    expect(options.saveAggregate).toBe(true);
    expect(options.saveFailure).toBe(true);
    expect(options.saveSmtpTls).toBe(true);
    expect(options.offline).toBe(true);
    expect(options.stripAttachmentPayloads).toBe(true);
    expect(options.nProcs).toBe(4);
    expect(options.silent).toBe(false);
    expect(options.debug).toBe(false);
  });

  it('implies silent when a configuration is parsed', async () => {
    expect((await parsed(configWith('general', {}))).silent).toBe(true);
  });

  it('test_general_save_forensic_alias_sets_save_failure', async () => {
    const options = await parsed(
      configWith('general', { save_forensic: 'true' }),
    );
    expect(options.saveFailure).toBe(true);
  });

  it('test_general_forensic_filename_aliases_set_failure', async () => {
    const options = await parsed(
      configWith('general', {
        forensic_json_filename: 'fa.json',
        forensic_csv_filename: 'fa.csv',
      }),
    );
    expect(options.failureJsonFilename).toBe('fa.json');
    expect(options.failureCsvFilename).toBe('fa.csv');
  });

  function indexPrefixDomainMapConfig(yamlText: string): ConfigParser {
    const mapPath = path.join(tmpDir, 'map.yaml');
    writeFileSync(mapPath, yamlText);
    return configWith('general', { index_prefix_domain_map: mapPath });
  }

  it('test_index_prefix_domain_map_accepts_a_mapping_of_lists', async () => {
    const config = indexPrefixDomainMapConfig(
      'tenant_a:\n  - example.com\n  - example.net\n',
    );
    expect(await parseConfig(config, opts())).toEqual(
      new Map([['tenant_a', ['example.com', 'example.net']]]),
    );
  });

  it('keeps the tenants in file order, numeric-looking names included', async () => {
    const config = indexPrefixDomainMapConfig(
      'zeta:\n  - z.example\n"2024":\n  - y.example\n',
    );
    const map = await parseConfig(config, opts());
    expect([...(map?.keys() ?? [])]).toEqual(['zeta', '2024']);
  });

  it('test_index_prefix_domain_map_empty_file_is_unset', async () => {
    expect(
      await parseConfig(indexPrefixDomainMapConfig(''), opts()),
    ).toBeNull();
  });

  it('test_index_prefix_domain_map_rejects_a_non_mapping', async () => {
    const config = indexPrefixDomainMapConfig('- example.com\n- example.net\n');
    const error = await parseConfig(config, opts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain('index_prefix_domain_map');
  });

  it('test_index_prefix_domain_map_rejects_a_scalar_domain_value', async () => {
    const config = indexPrefixDomainMapConfig('tenant_a: example.co\n');
    const error = await parseConfig(config, opts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain('list of domain names');
  });

  it('test_index_prefix_domain_map_rejects_a_non_string_domain', async () => {
    const config = indexPrefixDomainMapConfig('tenant_a:\n  - 42\n');
    const error = await parseConfig(config, opts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain('all strings');
  });

  it('rejects a YAML 1.1 boolean domain like PyYAML does', async () => {
    const config = indexPrefixDomainMapConfig('tenant_a:\n  - yes\n');
    await expect(parseConfig(config, opts())).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it('test_index_prefix_domain_map_rejects_a_non_string_key', async () => {
    const config = indexPrefixDomainMapConfig('42:\n  - example.com\n');
    await expect(parseConfig(config, opts())).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it('test_general_dns_settings_with_defaults', async () => {
    // Python runs the real pre-flight query here; tests never use the
    // network, so the reverse lookup answers from a fake.
    vi.mocked(queryDns).mockResolvedValue(['one.one.one.one.']);
    const options = await parsed(
      configWith('general', {
        dns_timeout: '5.0',
        dns_retries: '2',
        dns_test_address: '1.1.1.1',
        nameservers: '1.1.1.1, 8.8.8.8',
      }),
    );
    expect(options.dnsTimeout).toBe(5.0);
    expect(options.dnsRetries).toBe(2);
    expect(options.nameservers).toEqual(['1.1.1.1', '8.8.8.8']);
    expect(vi.mocked(queryDns)).toHaveBeenCalledWith(
      '1.1.1.1.in-addr.arpa.',
      'PTR',
      {
        nameservers: ['1.1.1.1', '8.8.8.8'],
        timeout: 5.0,
      },
    );
  });

  it('test_general_nameservers_accept_doh_and_dot_entries', async () => {
    vi.mocked(queryDns).mockResolvedValue(['one.one.one.one.']);
    const options = await parsed(
      configWith('general', {
        dns_test_address: '1.1.1.1',
        dns_timeout: '5.0',
        nameservers:
          'https://cloudflare-dns.com/dns-query, tls://9.9.9.9#dns.quad9.net',
      }),
    );
    expect(options.nameservers).toEqual([
      'https://cloudflare-dns.com/dns-query',
      'tls://9.9.9.9#dns.quad9.net',
    ]);
    expect(vi.mocked(queryDns).mock.calls[0]?.[2]?.nameservers).toEqual(
      options.nameservers,
    );
  });

  it('test_general_nameservers_malformed_dot_entry_fails_pre_flight', async () => {
    const config = configWith('general', {
      dns_test_address: '1.1.1.1',
      dns_timeout: '2.0',
      nameservers: 'tls://not-an-ip',
    });
    const error = await parseConfig(config, opts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain('pre-flight');
    expect((error as Error).message).toContain('tls://not-an-ip');
  });

  // Messages from parsedmarc 11.2.1 with the same entries: the error type
  // is Python's ValueError, not the JS RangeError behind it.
  it.each([
    [
      'tls://not-an-ip',
      'Invalid DNS over TLS nameserver tls://not-an-ip: not-an-ip is not an IP address. Use tls://ip[:port][#hostname], where the optional #hostname is the TLS certificate identity of the server',
    ],
    ['tls://', 'Invalid DNS over TLS nameserver tls://: missing IP address'],
    [
      'https://doh:p4ss/w0rd@dns.example/dns-query',
      'Invalid DNS over HTTPS nameserver https://***@dns.example/dns-query: the port is not an integer from 0 to 65535 (percent-encode any /, ? or # in a password)',
    ],
    [
      'not-an-ip',
      'nameserver not-an-ip is not a dns.nameserver.Nameserver instance or text form, IP address, nor a valid https URL',
    ],
  ])(
    'test_general_nameservers_malformed_entry_is_a_value_error: %s',
    async (nameservers, detail) => {
      const { message } = await preFlightError(preFlightConfig(nameservers));
      expect(message).toBe(
        `DNS pre-flight check failed: ValueError: ${detail}`,
      );
    },
  );

  it('fails the pre-flight when the test address has no PTR record', async () => {
    vi.mocked(queryDns).mockRejectedValue(new NXDOMAIN(['x.in-addr.arpa.']));
    const config = configWith('general', {
      dns_test_address: '192.0.2.1',
      nameservers: '1.1.1.1',
    });
    await expect(parseConfig(config, opts())).rejects.toThrow(
      "DNS pre-flight check failed: no PTR record for 192.0.2.1 from ['1.1.1.1']",
    );
  });

  // parsedmarc 11.2.1: the pre-flight check queries the PTR record itself,
  // so a broken transport is reported as such (issue #935).
  function preFlightConfig(
    nameservers: string,
    address = '192.0.2.1',
  ): ConfigParser {
    return configWith('general', {
      dns_test_address: address,
      dns_timeout: '0.2',
      nameservers,
    });
  }

  async function preFlightError(config: ConfigParser): Promise<Error> {
    const error = await parseConfig(config, opts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    return error as Error;
  }

  it('test_general_nameservers_pre_flight_reports_the_resolver_error', async () => {
    vi.mocked(queryDns).mockRejectedValue(
      new Error('session parameter must be an httpx2.Client'),
    );
    const { message } = await preFlightError(
      preFlightConfig('https://dns.example/dns-query'),
    );
    expect(message).toContain('DNS pre-flight check failed');
    expect(message).toContain('session parameter must be an httpx2.Client');
    expect(message).not.toContain('no PTR record');
  });

  it('test_general_nameservers_pre_flight_reports_a_missing_ptr_record', async () => {
    for (const error of [
      new NXDOMAIN(['1.2.0.192.in-addr.arpa.']),
      new NoAnswer('1.2.0.192.in-addr.arpa. IN PTR'),
    ]) {
      vi.mocked(queryDns).mockRejectedValue(error);
      // oxlint-disable-next-line no-await-in-loop -- one run per case
      const { message } = await preFlightError(
        preFlightConfig('https://dns.example/dns-query'),
      );
      expect(message).toContain(
        "DNS pre-flight check failed: no PTR record for 192.0.2.1 from ['https://dns.example/dns-query']",
      );
    }
  });

  it('test_general_nameservers_pre_flight_errors_mask_url_credentials', async () => {
    const url = 'https://doh:S3CRETPW@dns.example/dns-query';
    for (const error of [
      new NXDOMAIN(['1.2.0.192.in-addr.arpa.']),
      new Error(`Server error '502' for url '${url}'`),
    ]) {
      vi.mocked(queryDns).mockRejectedValue(error);
      // oxlint-disable-next-line no-await-in-loop -- one run per case
      const caught = await preFlightError(preFlightConfig(url));
      expect(caught.message).toContain('https://doh:***@dns.example/dns-query');
      expect(caught.message).not.toContain('S3CRETPW');
      expect(
        String((caught.cause as Error | undefined)?.message),
      ).not.toContain('S3CRETPW');
    }
  });

  it('test_general_nameservers_pre_flight_masks_malformed_url_passwords', async () => {
    for (const [url, expected] of [
      [
        'https://doh:p4ss/w0rd@dns.example/dns-query',
        'https://***@dns.example/dns-query',
      ],
      [
        'https://doh:p4ss?w0rd@dns.example/dns-query',
        'https://***@dns.example/dns-query',
      ],
      [
        'https://doh:p4ss#w0rd@dns.example/dns-query',
        'https://***@dns.example/dns-query',
      ],
      ['tls://dot:p4ss/w0rd@192.0.2.53', 'tls://***@192.0.2.53'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one run per case
      const caught = await preFlightError(preFlightConfig(url));
      for (const secret of ['p4ss', 'w0rd']) {
        expect(caught.message).not.toContain(secret);
        expect(
          String((caught.cause as Error | undefined)?.message),
        ).not.toContain(secret);
      }
      expect(caught.message).toContain(expected);
      expect(caught.message).toContain('DNS pre-flight check failed: ');
      expect(caught.message).not.toContain('network is disabled');
    }
  });

  it('test_general_nameservers_pre_flight_rejects_invalid_test_address', async () => {
    for (const address of ['not-an-ip', '1.1.1']) {
      // oxlint-disable-next-line no-await-in-loop -- one run per case
      const { message } = await preFlightError(
        preFlightConfig('https://dns.example/dns-query', address),
      );
      expect(message).toBe(
        `DNS pre-flight check failed: dns_test_address '${address}' is not a valid IP address`,
      );
    }
    expect(queryDns).not.toHaveBeenCalled();
  });

  it('test_general_normalize_timespan_threshold', async () => {
    const options = await parsed(
      configWith('general', { normalize_timespan_threshold_hours: '48' }),
    );
    expect(options.normalizeTimespanThresholdHours).toBe(48.0);
  });

  // Not in parsedmarc.
  it('reads max_email_size and max_mime_parts, defaulting to 50 MiB and 10,000', async () => {
    const defaults = await parsed(configWith('general', {}));
    expect(defaults.maxEmailSize).toBe(50 * 1024 * 1024);
    expect(defaults.maxMimeParts).toBe(10_000);
    const options = await parsed(
      configWith('general', { max_email_size: '1048576', max_mime_parts: '0' }),
    );
    expect(options.maxEmailSize).toBe(1_048_576);
    expect(options.maxMimeParts).toBe(0);
    const config = buildParserConfig(options);
    expect(config.maxEmailSize).toBe(1_048_576);
    expect(config.maxMimeParts).toBe(0);
  });

  it.each([
    ['max_normalized_records', 'maxNormalizedRecords', 250_000],
    ['max_xml_depth', 'maxXmlDepth', 100_000],
    ['max_xml_nodes', 'maxXmlNodes', 5_000_000],
    ['max_smtp_tls_report_size', 'maxSmtpTlsReportSize', 10 * 1024 * 1024],
    ['max_header_lines', 'maxHeaderLines', 100_000],
    ['max_expanded_email_size', 'maxExpandedEmailSize', 512 * 1024 * 1024],
    ['job_timeout', 'jobTimeout', 3600],
    ['max_lookups_per_report', 'maxLookupsPerReport', 100_000],
    ['max_failed_lookups_per_report', 'maxFailedLookupsPerReport', 256],
    ['max_lookup_time_per_report', 'maxLookupTimePerReport', 600],
    ['max_worker_heap_mb', 'maxWorkerHeapMb', 2048],
  ] as const)(
    'reads [general] %s into the parser configuration',
    async (key, option, defaultValue) => {
      expect(buildParserConfig(createOptions())[option]).toBe(defaultValue);
      for (const value of [1234, 0]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        const options = await parsed(
          configWith('general', { [key]: String(value) }),
        );
        expect(buildParserConfig(options)[option]).toBe(value);
      }
      await expect(
        parsed(configWith('general', { [key]: '-1' })),
      ).rejects.toThrow(
        new ConfigurationError(`${key} must be 0 or a positive integer`),
      );
    },
  );

  it.each([
    ['elasticsearch', 'elasticsearchMaxIndexesPerReport'],
    ['opensearch', 'opensearchMaxIndexesPerReport'],
  ] as const)(
    'reads max_indexes_per_report from [%s]',
    async (section, key) => {
      expect(createOptions()[key]).toBeNull();
      const options = await parsed(
        configWith(section, {
          hosts: 'localhost',
          max_indexes_per_report: '7',
        }),
      );
      expect(options[key]).toBe(7);
      await expect(
        parsed(
          configWith(section, {
            hosts: 'localhost',
            max_indexes_per_report: '-1',
          }),
        ),
      ).rejects.toThrow(
        new ConfigurationError(
          'max_indexes_per_report must be 0 or a positive integer',
        ),
      );
    },
  );

  it('reads the TLS options and query_timeout of [postgresql]', async () => {
    const options = await parsed(
      configWith('postgresql', {
        host: 'db.example.com',
        sslmode: 'verify-full',
        sslrootcert: 'system',
        sslcert: '/etc/ssl/client.crt',
        sslkey: '/etc/ssl/client.key',
        query_timeout: '30',
      }),
    );
    expect(options.postgresqlSslmode).toBe('verify-full');
    expect(options.postgresqlSslrootcert).toBe('system');
    expect(options.postgresqlSslcert).toBe('/etc/ssl/client.crt');
    expect(options.postgresqlSslkey).toBe('/etc/ssl/client.key');
    expect(options.postgresqlQueryTimeout).toBe(30);
  });

  it('says so when [postgresql] TLS options meet a connection_string', async () => {
    const logs = captureLogs();
    let options: CliOptions;
    try {
      options = await parsed(
        configWith('postgresql', {
          connection_string: 'postgresql://db.example.com/dmarc',
          sslmode: 'verify-full',
          query_timeout: '30',
        }),
      );
    } finally {
      logs.restore();
    }
    expect(options.postgresqlQueryTimeout).toBe(30);
    expect(
      logs.records.some(
        record =>
          record.levelName === 'ERROR' &&
          record.message.includes('sslmode') &&
          record.message.includes('connection_string'),
      ),
    ).toBe(true);
  });

  it('ignores keys it does not know, as parsedmarc does', async () => {
    const config = new ConfigParser();
    for (const section of ['general', 'postgresql', 'not_a_section']) {
      config.addSection(section);
      config.set(section, 'some_future_option', 'value');
    }
    config.set('postgresql', 'host', 'db.example.com');
    const options = await parsed(config);
    expect(options.postgresqlHost).toBe('db.example.com');
  });

  it('rejects a negative max_email_size', async () => {
    await expect(
      parsed(configWith('general', { max_email_size: '-1' })),
    ).rejects.toThrow(
      new ConfigurationError('max_email_size must be 0 or a positive integer'),
    );
  });

  it('test_general_archive_directory_expands_env_var', async () => {
    process.env.SOME_ARCHIVE_VAR = '/opt/dmarc';
    const options = await parsed(
      configWith('general', {
        archive_directory: '$SOME_ARCHIVE_VAR/reports-archive',
      }),
    );
    expect(options.archiveDirectory).toBe('/opt/dmarc/reports-archive');
  });

  it('test_general_archive_directory_unset_leaves_attribute_absent', async () => {
    const options = await parsed(configWith('general', { silent: 'false' }));
    expect(options.archiveDirectory).toBeNull();
  });
});

describe('TestParseConfigElasticsearch', () => {
  it('test_elasticsearch_basic', async () => {
    const options = await parsed(
      configWith('elasticsearch', {
        hosts: 'es1:9200, es2:9200',
        timeout: '30.0',
        number_of_shards: '3',
        number_of_replicas: '1',
        index_suffix: 'tenant_a',
        index_prefix: 'cust_',
        monthly_indexes: 'true',
        ssl: 'true',
        cert_path: '/etc/ca.pem',
        skip_certificate_verification: 'true',
        user: 'alice',
        password: 'secret',
        api_key: 'base64key',
      }),
    );
    expect(options.elasticsearchHosts).toEqual(['es1:9200', 'es2:9200']);
    expect(options.elasticsearchTimeout).toBe(30.0);
    expect(options.elasticsearchNumberOfShards).toBe(3);
    expect(options.elasticsearchNumberOfReplicas).toBe(1);
    expect(options.elasticsearchIndexSuffix).toBe('tenant_a');
    expect(options.elasticsearchIndexPrefix).toBe('cust_');
    expect(options.elasticsearchMonthlyIndexes).toBe(true);
    expect(options.elasticsearchSsl).toBe(true);
    expect(options.elasticsearchSslCertPath).toBe('/etc/ca.pem');
    expect(options.elasticsearchSkipCertificateVerification).toBe(true);
    expect(options.elasticsearchUsername).toBe('alice');
    expect(options.elasticsearchPassword).toBe('secret');
    expect(options.elasticsearchApiKey).toBe('base64key');
  });

  it('test_elasticsearch_number_of_replicas_without_shards', async () => {
    const options = await parsed(
      configWith('elasticsearch', {
        hosts: 'es:9200',
        number_of_replicas: '2',
      }),
    );
    expect(options.elasticsearchNumberOfReplicas).toBe(2);
    // Untouched: still the createOptions() default.
    expect(options.elasticsearchNumberOfShards).toBe(
      createOptions().elasticsearchNumberOfShards,
    );
  });

  it('test_elasticsearch_apikey_camelcase_alias_pre_8_20', async () => {
    const config = configWith('elasticsearch', { hosts: 'es:9200' });
    // ConfigParser lower-cases option names, so `apiKey` is `apikey`.
    config.set('elasticsearch', 'apiKey', 'legacy');
    expect((await parsed(config)).elasticsearchApiKey).toBe('legacy');
  });

  it('prefers api_key over the legacy apiKey', async () => {
    const options = await parsed(
      configWith('elasticsearch', {
        hosts: 'es:9200',
        apiKey: 'legacy',
        api_key: 'current',
      }),
    );
    expect(options.elasticsearchApiKey).toBe('current');
  });

  it('test_elasticsearch_missing_hosts_raises', async () => {
    const error = await parseConfig(
      configWith('elasticsearch', { timeout: '30' }),
      opts(),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain('hosts');
  });

  it('test_elasticsearch_serverless_flag', async () => {
    const options = await parsed(
      configWith('elasticsearch', { hosts: 'es:9200', serverless: 'true' }),
    );
    expect(options.elasticsearchServerless).toBe(true);
  });

  it('test_elasticsearch_serverless_passed_to_set_hosts', async () => {
    const configPath = path.join(tmpDir, 'serverless.ini');
    writeFileSync(
      configPath,
      `[general]
save_aggregate = true
silent = true

[imap]
host = imap.example.com
user = test-user
password = test-password

[elasticsearch]
hosts = localhost
serverless = true
`,
    );
    const fakeClient = { close: vi.fn(async () => undefined) };
    vi.mocked(elastic.setHosts).mockResolvedValue(
      fakeClient as unknown as Awaited<ReturnType<typeof elastic.setHosts>>,
    );
    vi.mocked(elastic.migrateIndexes).mockResolvedValue(undefined);
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: [],
      failureReports: [],
      smtpTlsReports: [],
    });
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue({
      close: vi.fn(async () => undefined),
    } as unknown as IMAPConnection);

    const logs = captureLogs();
    try {
      await main(['-c', configPath]);
    } finally {
      logs.restore();
    }

    expect(vi.mocked(elastic.setHosts)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(elastic.setHosts).mock.calls[0]?.[1]?.serverless).toBe(
      true,
    );
  });
});

describe('TestParseConfigOpenSearch', () => {
  it('test_opensearch_basic', async () => {
    const options = await parsed(
      configWith('opensearch', {
        hosts: 'os1:9200',
        timeout: '45.0',
        number_of_shards: '2',
        number_of_replicas: '0',
        index_suffix: 'x',
        index_prefix: 'y_',
        monthly_indexes: 'true',
        ssl: 'true',
        cert_path: '/etc/ca.pem',
        skip_certificate_verification: 'true',
        user: 'u',
        password: 'p',
        api_key: 'k',
        auth_type: 'BASIC',
        aws_region: 'us-east-1',
        aws_service: 'es',
      }),
    );
    expect(options.opensearchHosts).toEqual(['os1:9200']);
    expect(options.opensearchTimeout).toBe(45.0);
    expect(options.opensearchNumberOfShards).toBe(2);
    expect(options.opensearchNumberOfReplicas).toBe(0);
    expect(options.opensearchIndexSuffix).toBe('x');
    expect(options.opensearchIndexPrefix).toBe('y_');
    expect(options.opensearchMonthlyIndexes).toBe(true);
    expect(options.opensearchSsl).toBe(true);
    expect(options.opensearchSslCertPath).toBe('/etc/ca.pem');
    expect(options.opensearchSkipCertificateVerification).toBe(true);
    expect(options.opensearchUsername).toBe('u');
    expect(options.opensearchPassword).toBe('p');
    expect(options.opensearchApiKey).toBe('k');
    // auth_type is lowercased/stripped.
    expect(options.opensearchAuthType).toBe('basic');
    expect(options.opensearchAwsRegion).toBe('us-east-1');
    expect(options.opensearchAwsService).toBe('es');
  });

  it('test_opensearch_number_of_replicas_without_shards', async () => {
    const options = await parsed(
      configWith('opensearch', { hosts: 'os:9200', number_of_replicas: '3' }),
    );
    expect(options.opensearchNumberOfReplicas).toBe(3);
    expect(options.opensearchNumberOfShards).toBe(
      createOptions().opensearchNumberOfShards,
    );
  });

  it('test_opensearch_authentication_type_legacy_alias', async () => {
    const options = await parsed(
      configWith('opensearch', {
        hosts: 'os:9200',
        authentication_type: 'AWSSigV4',
      }),
    );
    expect(options.opensearchAuthType).toBe('awssigv4');
  });

  it('test_opensearch_apikey_camelcase_alias', async () => {
    const options = await parsed(
      configWith('opensearch', { hosts: 'os:9200', apiKey: 'legacy' }),
    );
    expect(options.opensearchApiKey).toBe('legacy');
  });

  it('test_opensearch_missing_hosts_raises', async () => {
    await expect(
      parseConfig(configWith('opensearch', { timeout: '30' }), opts()),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe('TestParseConfigSplunkHec', () => {
  it('test_splunk_hec_complete', async () => {
    const options = await parsed(
      configWith('splunk_hec', {
        url: 'https://splunk:8088',
        token: 'abc-token',
        index: 'dmarc',
        skip_certificate_verification: 'true',
      }),
    );
    expect(options.hec).toBe('https://splunk:8088');
    expect(options.hecToken).toBe('abc-token');
    expect(options.hecIndex).toBe('dmarc');
    expect(options.hecSkipCertificateVerification).toBe(true);
  });

  it('test_splunk_hec_missing_url_raises', async () => {
    await expect(
      parseConfig(configWith('splunk_hec', { token: 't', index: 'i' }), opts()),
    ).rejects.toThrow('url setting missing from the splunk_hec config section');
  });

  it('test_splunk_hec_missing_token_raises', async () => {
    await expect(
      parseConfig(
        configWith('splunk_hec', { url: 'https://splunk:8088', index: 'i' }),
        opts(),
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('test_splunk_hec_missing_index_raises', async () => {
    await expect(
      parseConfig(
        configWith('splunk_hec', { url: 'https://splunk:8088', token: 't' }),
        opts(),
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe('TestParseConfigKafka', () => {
  it('test_kafka_complete', async () => {
    const options = await parsed(
      configWith('kafka', {
        hosts: 'kafka1:9092, kafka2:9092',
        user: 'u',
        password: 'p',
        ssl: 'true',
        skip_certificate_verification: 'true',
        aggregate_topic: 'dmarc-aggregate',
        failure_topic: 'dmarc-failure',
        smtp_tls_topic: 'smtp-tls',
      }),
    );
    expect(options.kafkaHosts).toEqual(['kafka1:9092', 'kafka2:9092']);
    expect(options.kafkaUsername).toBe('u');
    expect(options.kafkaPassword).toBe('p');
    expect(options.kafkaSsl).toBe(true);
    expect(options.kafkaSkipCertificateVerification).toBe(true);
    expect(options.kafkaAggregateTopic).toBe('dmarc-aggregate');
    expect(options.kafkaFailureTopic).toBe('dmarc-failure');
    expect(options.kafkaSmtpTlsTopic).toBe('smtp-tls');
  });

  it('test_kafka_forensic_topic_alias_sets_failure_topic', async () => {
    const options = await parsed(
      configWith('kafka', {
        hosts: 'k:9092',
        aggregate_topic: 'agg',
        forensic_topic: 'old-fail',
        smtp_tls_topic: 'tls',
      }),
    );
    expect(options.kafkaFailureTopic).toBe('old-fail');
  });

  it('test_kafka_missing_hosts_raises', async () => {
    await expect(
      parseConfig(
        configWith('kafka', {
          aggregate_topic: 'a',
          failure_topic: 'f',
          smtp_tls_topic: 't',
        }),
        opts(),
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('test_kafka_missing_aggregate_topic_raises', async () => {
    await expect(
      parseConfig(
        configWith('kafka', {
          hosts: 'k:9092',
          failure_topic: 'f',
          smtp_tls_topic: 't',
        }),
        opts(),
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('test_kafka_missing_failure_topic_raises', async () => {
    await expect(
      parseConfig(
        configWith('kafka', {
          hosts: 'k:9092',
          aggregate_topic: 'a',
          smtp_tls_topic: 't',
        }),
        opts(),
      ),
    ).rejects.toThrow(
      'failure_topic setting missing from the kafka config section',
    );
  });

  it('test_kafka_missing_smtp_tls_topic_raises', async () => {
    await expect(
      parseConfig(
        configWith('kafka', {
          hosts: 'k:9092',
          aggregate_topic: 'a',
          failure_topic: 'f',
        }),
        opts(),
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe('TestParseConfigSmtp', () => {
  it('test_smtp_complete', async () => {
    const options = await parsed(
      configWith('smtp', {
        host: 'smtp.example.com',
        port: '587',
        ssl: 'true',
        skip_certificate_verification: 'true',
        user: 'u',
        password: 'p',
        from: 'dmarc@example.com',
        to: 'admin@example.com, alert@example.com',
        subject: 'DMARC Report',
        attachment: '/tmp/dmarc.zip',
        message: 'See attached',
      }),
    );
    expect(options.smtpHost).toBe('smtp.example.com');
    expect(options.smtpPort).toBe(587);
    expect(options.smtpSsl).toBe(true);
    expect(options.smtpSkipCertificateVerification).toBe(true);
    expect(options.smtpUser).toBe('u');
    expect(options.smtpPassword).toBe('p');
    expect(options.smtpFrom).toBe('dmarc@example.com');
    expect(options.smtpTo).toEqual(['admin@example.com', 'alert@example.com']);
    expect(options.smtpSubject).toBe('DMARC Report');
    expect(options.smtpAttachment).toBe('/tmp/dmarc.zip');
    expect(options.smtpMessage).toBe('See attached');
  });

  it('test_smtp_missing_host_raises', async () => {
    await expect(
      parseConfig(configWith('smtp', { user: 'u', password: 'p' }), opts()),
    ).rejects.toThrow('host setting missing from the smtp config section');
  });

  it('test_smtp_missing_user_raises', async () => {
    await expect(
      parseConfig(
        configWith('smtp', { host: 'smtp.example.com', password: 'p' }),
        opts(),
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('test_smtp_missing_password_raises', async () => {
    await expect(
      parseConfig(
        configWith('smtp', { host: 'smtp.example.com', user: 'u' }),
        opts(),
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('logs a critical message when from or to is missing', async () => {
    const logs = captureLogs();
    try {
      await parsed(
        configWith('smtp', {
          host: 'smtp.example.com',
          user: 'u',
          password: 'p',
        }),
      );
    } finally {
      logs.restore();
    }
    expect(logs.output).toEqual([
      'CRITICAL:tsdmarc:from setting missing from the smtp config section',
      'CRITICAL:tsdmarc:to setting missing from the smtp config section',
    ]);
  });
});
