// Port of parsedmarc's tests/test_cli.py `TestGmailAuthModes`,
// `TestMailboxWatchSince`, `TestMailboxPerTypeDeleteOptions`,
// `TestCliParserConfigWiring` and `TestMailboxPerformance`: what the CLI
// passes to the mailbox connections and the library's mailbox functions.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GmailConnection } from '@tsdmarc/gmail';
import { IMAPConnection } from '@tsdmarc/imap';
import { MSGraphConnection } from '@tsdmarc/msgraph';
import {
  captureLogs,
  CRITICAL,
  ERROR,
  IP_ADDRESS_CACHE,
  logger,
  type ParserConfig,
  REVERSE_DNS_MAP,
  SEEN_AGGREGATE_REPORT_IDS,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from './core';
import { main } from './main';

const EMPTY_RESULTS = {
  aggregateReports: [],
  failureReports: [],
  smtpTlsReports: [],
};

let tmpDir: string;

beforeEach(() => {
  logger.disabled = true;
  SEEN_AGGREGATE_REPORT_IDS.clear();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-mailbox-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(text: string): string {
  const cfgPath = path.join(
    tmpDir,
    `config-${Math.random().toString(36).slice(2)}.ini`,
  );
  writeFileSync(cfgPath, text);
  return cfgPath;
}

/** A connection double: the CLI only closes it itself. */
function fakeConnection<T>(): T {
  return { close: vi.fn(async () => undefined) } as unknown as T;
}

function mockMailboxFetch(): void {
  vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
    ...EMPTY_RESULTS,
  });
}

function lastFetchOptions(): core.GetDmarcReportsFromMailboxOptions {
  const call = vi.mocked(core.getDmarcReportsFromMailbox).mock.calls.at(-1);
  expect(call).toBeDefined();
  return call?.[1] as core.GetDmarcReportsFromMailboxOptions;
}

describe('TestGmailAuthModes', () => {
  it('testCliPassesGmailServiceAccountAuthSettings', async () => {
    const connect = vi
      .spyOn(GmailConnection, 'connect')
      .mockResolvedValue(fakeConnection<GmailConnection>());
    mockMailboxFetch();
    const cfgPath = writeConfig(`[general]
silent = true

[gmail_api]
credentials_file = /tmp/service-account.json
auth_mode = service_account
service_account_user = dmarc@example.com
scopes = https://www.googleapis.com/auth/gmail.modify
`);

    await main(['-c', cfgPath]);

    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      authMode: 'service_account',
      serviceAccountUser: 'dmarc@example.com',
    });
  });

  it('testCliAcceptsDelegatedUserAlias', async () => {
    const connect = vi
      .spyOn(GmailConnection, 'connect')
      .mockResolvedValue(fakeConnection<GmailConnection>());
    mockMailboxFetch();
    const cfgPath = writeConfig(`[general]
silent = true

[gmail_api]
credentials_file = /tmp/service-account.json
auth_mode = service_account
delegated_user = delegated@example.com
scopes = https://www.googleapis.com/auth/gmail.modify
`);

    await main(['-c', cfgPath]);

    expect(connect.mock.calls[0]?.[0].serviceAccountUser).toBe(
      'delegated@example.com',
    );
  });
});

describe('TestMailboxWatchSince', () => {
  // testWatchInboxPassesSinceToMailboxFetch exercises the core's
  // watchInbox() itself: it is ported with the core's mailbox module.

  it('testCliPassesSinceToWatchInbox', async () => {
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue(
      fakeConnection<IMAPConnection>(),
    );
    mockMailboxFetch();
    vi.mocked(core.watchInbox).mockRejectedValue(
      Object.assign(new Error('stop-watch-loop'), { name: 'FileExistsError' }),
    );
    const cfgPath = writeConfig(`[general]
silent = true

[imap]
host = imap.example.com
user = user
password = pass

[mailbox]
watch = true
since = 2d
`);

    await expect(main(['-c', cfgPath])).rejects.toMatchObject({ code: 1 });
    expect(vi.mocked(core.watchInbox).mock.calls.at(-1)?.[0].since).toBe('2d');
  });
});

describe('TestMailboxPerTypeDeleteOptions', () => {
  const IMAP_CONFIG = `[general]
silent = true

[imap]
host = imap.example.com
user = user
password = pass

[mailbox]
delete = true
delete_failure = false
`;

  function assertPerTypeDeleteOptions(
    options: core.GetDmarcReportsFromMailboxOptions,
  ): void {
    expect(options.delete).toBe(true);
    expect(options.deleteFailure).toBe(false);
    // Unset options stay null so the library applies the inheritance.
    expect(options.deleteAggregate).toBeNull();
    expect(options.deleteSmtpTls).toBeNull();
    expect(options.deleteInvalid).toBeNull();
  }

  it('testCliPassesPerTypeDeleteToWatchInbox', async () => {
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue(
      fakeConnection<IMAPConnection>(),
    );
    mockMailboxFetch();
    vi.mocked(core.watchInbox).mockRejectedValue(
      Object.assign(new Error('stop-watch-loop'), { code: 'EEXIST' }),
    );
    const cfgPath = writeConfig(`${IMAP_CONFIG}watch = true\n`);

    await expect(main(['-c', cfgPath])).rejects.toMatchObject({ code: 1 });
    const options = vi.mocked(core.watchInbox).mock.calls.at(-1)?.[0];
    expect(options).toBeDefined();
    assertPerTypeDeleteOptions(options as core.WatchInboxOptions);
  });

  it('testCliPassesPerTypeDeleteToOneShotMailboxRun', async () => {
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue(
      fakeConnection<IMAPConnection>(),
    );
    mockMailboxFetch();
    const cfgPath = writeConfig(IMAP_CONFIG);

    await main(['-c', cfgPath]);

    assertPerTypeDeleteOptions(lastFetchOptions());
  });

  it('testGmailScopeGuardForcesAllDeleteFlagsOff', async () => {
    vi.spyOn(GmailConnection, 'connect').mockResolvedValue(
      fakeConnection<GmailConnection>(),
    );
    mockMailboxFetch();
    const cfgPath = writeConfig(`[general]
silent = true

[gmail_api]
credentials_file = /tmp/gmail-credentials.json
scopes = https://www.googleapis.com/auth/gmail.modify

[mailbox]
delete_aggregate = true
`);

    logger.disabled = false;
    const logs = captureLogs(logger, ERROR);
    try {
      await main(['-c', cfgPath]);
    } finally {
      logs.restore();
    }

    expect(
      logs.records.some(record =>
        record.message.includes('Message deletion requires scope'),
      ),
    ).toBe(true);
    const options = lastFetchOptions();
    for (const option of [
      'delete',
      'deleteAggregate',
      'deleteFailure',
      'deleteSmtpTls',
      'deleteInvalid',
    ] as const) {
      expect(options[option], option).toBe(false);
    }
  });
});

describe('TestCliParserConfigWiring', () => {
  async function runOneShotMailbox(
    options: {
      dnsTimeout?: number;
      dnsRetries?: number;
      extraArgv?: string[];
    } = {},
  ): Promise<ParserConfig> {
    const configLines = ['[general]', 'silent = true'];
    if (options.dnsTimeout !== undefined) {
      configLines.push(`dns_timeout = ${options.dnsTimeout}`);
    }
    if (options.dnsRetries !== undefined) {
      configLines.push(`dns_retries = ${options.dnsRetries}`);
    }
    configLines.push(
      '',
      '[imap]',
      'host = imap.example.com',
      'user = user',
      'password = pass',
    );
    const cfgPath = writeConfig(`${configLines.join('\n')}\n`);
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue(
      fakeConnection<IMAPConnection>(),
    );
    mockMailboxFetch();

    await main(['-c', cfgPath, ...(options.extraArgv ?? [])]);

    const config = lastFetchOptions().config;
    expect(config).toBeTruthy();
    return config as ParserConfig;
  }

  it('test_one_shot_mailbox_run_honors_general_dns_timeout', async () => {
    const config = await runOneShotMailbox({ dnsTimeout: 11.5, dnsRetries: 3 });
    expect(config.dnsTimeout).toBe(11.5);
    expect(config.dnsRetries).toBe(3);
  });

  it('test_dns_timeout_hyphenated_alias_reaches_parser_config', async () => {
    let config = await runOneShotMailbox({ extraArgv: ['--dns-timeout', '7'] });
    expect(config.dnsTimeout).toBe(7.0);
    config = await runOneShotMailbox({ extraArgv: ['--dns_timeout', '9'] });
    expect(config.dnsTimeout).toBe(9.0);
  });

  it('test_cli_config_binds_module_default_caches', async () => {
    const config = await runOneShotMailbox();
    expect(config.ipAddressCache).toBe(IP_ADDRESS_CACHE);
    expect(config.seenAggregateReportIds).toBe(SEEN_AGGREGATE_REPORT_IDS);
    expect(config.reverseDnsMap).toBe(REVERSE_DNS_MAP);
  });
});

describe('TestMailboxPerformance', () => {
  // testBatchModeAvoidsExtraFullFetch exercises the core's
  // getDmarcReportsFromMailbox() itself: it is ported with the core's
  // mailbox module.

  it('testCliPassesMsGraphCertificateAuthSettings', async () => {
    const connect = vi
      .spyOn(MSGraphConnection, 'connect')
      .mockResolvedValue(fakeConnection<MSGraphConnection>());
    mockMailboxFetch();
    const cfgPath = writeConfig(`[general]
silent = true

[msgraph]
auth_method = Certificate
client_id = client-id
tenant_id = tenant-id
mailbox = shared@example.com
certificate_path = /tmp/msgraph-cert.pem
certificate_password = cert-pass
`);

    await main(['-c', cfgPath]);

    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      authMethod: 'Certificate',
      certificatePath: '/tmp/msgraph-cert.pem',
      certificatePassword: 'cert-pass',
    });
  });

  async function expectGraphConfigError(
    configText: string,
    message: string,
  ): Promise<void> {
    const connect = vi.spyOn(MSGraphConnection, 'connect');
    const cfgPath = writeConfig(configText);
    logger.disabled = false;
    const logs = captureLogs(logger, CRITICAL);
    try {
      await expect(main(['-c', cfgPath])).rejects.toMatchObject({ code: -1 });
    } finally {
      logs.restore();
    }
    expect(logs.records.map(record => record.message)).toEqual([message]);
    expect(connect).not.toHaveBeenCalled();
    expect(core.getDmarcReportsFromMailbox).not.toHaveBeenCalled();
  }

  it('testCliRequiresMsGraphCertificatePath', async () => {
    await expectGraphConfigError(
      `[general]
silent = true

[msgraph]
auth_method = Certificate
client_id = client-id
tenant_id = tenant-id
mailbox = shared@example.com
`,
      'certificate_path setting missing from the msgraph config section',
    );
  });

  it('testCliUsesMsGraphUserAsMailboxForUsernamePasswordAuth', async () => {
    const connect = vi
      .spyOn(MSGraphConnection, 'connect')
      .mockResolvedValue(fakeConnection<MSGraphConnection>());
    mockMailboxFetch();
    const cfgPath = writeConfig(`[general]
silent = true

[msgraph]
auth_method = UsernamePassword
client_id = client-id
client_secret = client-secret
user = owner@example.com
password = test-password
`);

    await main(['-c', cfgPath]);

    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      mailbox: 'owner@example.com',
      username: 'owner@example.com',
    });
  });

  it('testCliRequiresMsGraphPasswordForUsernamePasswordAuth', async () => {
    await expectGraphConfigError(
      `[general]
silent = true

[msgraph]
auth_method = UsernamePassword
client_id = client-id
client_secret = client-secret
user = owner@example.com
`,
      'password setting missing from the msgraph config section',
    );
  });
});
