// Ported from parsedmarc's tests/test_cli.py: TestMSGraphCliValidation,
// TestMSGraphConnectionLogging, TestMSGraphEmailResults and
// TestMSGraphFailureLogging.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLogLevel, setLogLevel } from '@azure/logger';
import { IMAPConnection } from '@tsdmarc/imap';
import { MSGraphConnection, ODataError } from '@tsdmarc/msgraph';
import { emailResults } from '@tsdmarc/smtp';
import {
  type AggregateReport,
  captureLogs,
  CRITICAL,
  DEBUG,
  ERROR,
  getLogger,
  type Handler,
  INFO,
  type LogCapture,
  logger,
  parseReportFile,
  type ParsingResults,
  WARNING,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from './core';
import { DEPENDENCY_LOGGERS } from './logging';
import { main } from './main';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SAMPLE_AGGREGATE_REPORT_PATH = path.join(
  REPO_ROOT,
  'samples/aggregate/!example.com!1538204542!1538463818.xml',
);

const CERT_CONFIG = `[general]
silent = true

[msgraph]
auth_method = Certificate
client_id = client-id-1234
tenant_id = tenant-id-5678
mailbox = shared@example.com
certificate_path = /tmp/msgraph-cert.pem
certificate_password = s3cret-cert-pass
`;

const EMPTY_RESULTS: ParsingResults = {
  aggregateReports: [],
  failureReports: [],
  smtpTlsReports: [],
};

/** A real parsed sample, so the summary zip/CSV code paths run for real. */
async function sampleAggregateReports(): Promise<AggregateReport[]> {
  const result = await parseReportFile(SAMPLE_AGGREGATE_REPORT_PATH, {
    offline: true,
  });
  if (result.reportType !== 'aggregate') {
    throw new Error('expected an aggregate report');
  }
  return [result.report];
}

/** azure-identity's credential error (Python's ClientAuthenticationError). */
class AuthenticationError extends Error {
  override name = 'AuthenticationError';
}

interface FakeGraphConnection {
  kind: 'msgraph';
  mailboxName: string;
  sendMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeGraphConnection(): FakeGraphConnection {
  return {
    kind: 'msgraph',
    mailboxName: 'shared@example.com',
    sendMessage: vi.fn(async () => null),
    close: vi.fn(async () => undefined),
  };
}

let tempDir: string;
let graphConnect: ReturnType<typeof vi.spyOn>;
let graphConnection: FakeGraphConnection;
let logs: LogCapture | null = null;

function writeConfig(text: string): string {
  const configPath = path.join(
    mkdtempSync(path.join(tempDir, 'cfg-')),
    'config.ini',
  );
  writeFileSync(configPath, text);
  return configPath;
}

async function runMain(
  configPath: string,
  ...cliArgs: string[]
): Promise<void> {
  await main(['-c', configPath, ...cliArgs]);
}

function capture(level: number = DEBUG): LogCapture {
  logs = captureLogs(logger, level);
  return logs;
}

function output(capture_: LogCapture, level: number = DEBUG): string {
  return capture_.records
    .filter(record => record.level >= level)
    .map(record => `${record.levelName}:${record.name}:${record.message}`)
    .join('\n');
}

function criticalMessages(capture_: LogCapture): string[] {
  return capture_.records
    .filter(record => record.level === CRITICAL)
    .map(record => record.message);
}

function graphOptions(): Record<string, unknown> {
  return graphConnect.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

const savedDependencyLoggers = new Map<string, [number, Handler[]]>();
let savedAzureLevel: ReturnType<typeof getLogLevel>;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-msgraph-'));
  // Keep main()'s console log handler quiet.
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  graphConnection = fakeGraphConnection();
  graphConnect = vi
    .spyOn(MSGraphConnection, 'connect')
    .mockResolvedValue(graphConnection as unknown as MSGraphConnection);
  vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue(EMPTY_RESULTS);
  // configureDependencyLogging() changes process-wide loggers.
  for (const name of DEPENDENCY_LOGGERS) {
    const dep = getLogger(name);
    savedDependencyLoggers.set(name, [dep.level, [...dep.handlers]]);
  }
  savedAzureLevel = getLogLevel();
});

afterEach(() => {
  logs?.restore();
  logs = null;
  for (const [name, [level, handlers]] of savedDependencyLoggers) {
    const dep = getLogger(name);
    dep.setLevel(level);
    for (const handler of [...dep.handlers]) {
      dep.removeHandler(handler);
    }
    for (const handler of handlers) {
      dep.addHandler(handler);
    }
  }
  setLogLevel(savedAzureLevel);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('TestMSGraphCliValidation', () => {
  /** Runs a config that must fail parsing with `message`, exit status -1. */
  async function expectConfigError(
    configText: string,
    message: string,
  ): Promise<void> {
    const configPath = writeConfig(configText);
    const capture_ = capture();
    await expect(runMain(configPath)).rejects.toMatchObject({ code: -1 });
    expect(criticalMessages(capture_)).toEqual([message]);
    expect(graphConnect).not.toHaveBeenCalled();
    expect(core.getDmarcReportsFromMailbox).not.toHaveBeenCalled();
  }

  it('testCliPassesMsGraphClientSecretAuthSettings', async () => {
    await runMain(
      writeConfig(`[general]
silent = true

[msgraph]
auth_method = ClientSecret
client_id = client-id
client_secret = client-secret
tenant_id = tenant-id
mailbox = shared@example.com
`),
    );
    expect(graphOptions()).toMatchObject({
      authMethod: 'ClientSecret',
      clientSecret: 'client-secret',
      tenantId: 'tenant-id',
      mailbox: 'shared@example.com',
    });
  });

  it('testCliRequiresMsGraphClientSecretForClientSecretAuth', async () => {
    await expectConfigError(
      `[general]
silent = true

[msgraph]
auth_method = ClientSecret
client_id = client-id
tenant_id = tenant-id
mailbox = shared@example.com
`,
      'client_secret setting missing from the msgraph config section',
    );
  });

  it('testCliRequiresMsGraphTenantIdForClientSecretAuth', async () => {
    await expectConfigError(
      `[general]
silent = true

[msgraph]
auth_method = ClientSecret
client_id = client-id
client_secret = client-secret
mailbox = shared@example.com
`,
      'tenant_id setting missing from the msgraph config section',
    );
  });

  it('testCliRequiresMsGraphMailboxForClientSecretAuth', async () => {
    await expectConfigError(
      `[general]
silent = true

[msgraph]
auth_method = ClientSecret
client_id = client-id
client_secret = client-secret
tenant_id = tenant-id
`,
      'mailbox setting missing from the msgraph config section',
    );
  });

  it('testCliAllowsMsGraphDeviceCodeWithoutUser', async () => {
    await runMain(
      writeConfig(`[general]
silent = true

[msgraph]
auth_method = DeviceCode
client_id = client-id
tenant_id = tenant-id
mailbox = shared@example.com
`),
    );
    expect(graphOptions()).toMatchObject({
      authMethod: 'DeviceCode',
      mailbox: 'shared@example.com',
      username: null,
    });
  });

  it('testCliRequiresMsGraphTenantIdForDeviceCodeAuth', async () => {
    await expectConfigError(
      `[general]
silent = true

[msgraph]
auth_method = DeviceCode
client_id = client-id
mailbox = shared@example.com
`,
      'tenant_id setting missing from the msgraph config section',
    );
  });

  it('testCliRequiresMsGraphMailboxForDeviceCodeAuth', async () => {
    await expectConfigError(
      `[general]
silent = true

[msgraph]
auth_method = DeviceCode
client_id = client-id
tenant_id = tenant-id
`,
      'mailbox setting missing from the msgraph config section',
    );
  });

  it('testCliRequiresMsGraphTenantIdForCertificateAuth', async () => {
    await expectConfigError(
      `[general]
silent = true

[msgraph]
auth_method = Certificate
client_id = client-id
mailbox = shared@example.com
certificate_path = /tmp/msgraph-cert.pem
`,
      'tenant_id setting missing from the msgraph config section',
    );
  });

  it('testCliRequiresMsGraphMailboxForCertificateAuth', async () => {
    await expectConfigError(
      `[general]
silent = true

[msgraph]
auth_method = Certificate
client_id = client-id
tenant_id = tenant-id
certificate_path = /tmp/msgraph-cert.pem
`,
      'mailbox setting missing from the msgraph config section',
    );
  });

  it('testCliPassesMsGraphClientAssertionAuthSettings', async () => {
    await runMain(
      writeConfig(`[general]
silent = true

[msgraph]
auth_method = ClientAssertion
client_id = client-id
client_assertion = signed-jwt-assertion
tenant_id = tenant-id
mailbox = shared@example.com
`),
    );
    expect(graphOptions()).toMatchObject({
      authMethod: 'ClientAssertion',
      clientAssertion: 'signed-jwt-assertion',
      tenantId: 'tenant-id',
      mailbox: 'shared@example.com',
    });
  });

  it('testCliRequiresMsGraphClientAssertionForClientAssertionAuth', async () => {
    await expectConfigError(
      `[general]
silent = true

[msgraph]
auth_method = ClientAssertion
client_id = client-id
tenant_id = tenant-id
mailbox = shared@example.com
`,
      'client_assertion setting missing from the msgraph config section',
    );
  });

  it('testCliRequiresMsGraphTenantIdForClientAssertionAuth', async () => {
    await expectConfigError(
      `[general]
silent = true

[msgraph]
auth_method = ClientAssertion
client_id = client-id
client_assertion = signed-jwt-assertion
mailbox = shared@example.com
`,
      'tenant_id setting missing from the msgraph config section',
    );
  });

  it('testCliRequiresMsGraphMailboxForClientAssertionAuth', async () => {
    await expectConfigError(
      `[general]
silent = true

[msgraph]
auth_method = ClientAssertion
client_id = client-id
client_assertion = signed-jwt-assertion
tenant_id = tenant-id
`,
      'mailbox setting missing from the msgraph config section',
    );
  });

  it('testCliAcceptsLowercaseMsGraphCertificateAuthMethod', async () => {
    await runMain(
      writeConfig(`[general]
silent = true

[msgraph]
auth_method = certificate
client_id = client-id
tenant_id = tenant-id
mailbox = shared@example.com
certificate_path = /tmp/msgraph-cert.pem
certificate_password = cert-pass
`),
    );
    expect(graphOptions()).toMatchObject({
      authMethod: 'Certificate',
      mailbox: 'shared@example.com',
      certificatePath: '/tmp/msgraph-cert.pem',
      certificatePassword: 'cert-pass',
    });
  });

  it('testCliRejectsInvalidMsGraphAuthMethod', async () => {
    const configPath = writeConfig(`[general]
silent = true

[msgraph]
auth_method = NotARealMethod
client_id = client-id
tenant_id = tenant-id
mailbox = shared@example.com
certificate_path = /tmp/msgraph-cert.pem
`);
    const capture_ = capture();
    await expect(runMain(configPath)).rejects.toMatchObject({ code: -1 });
    const critical = criticalMessages(capture_);
    expect(critical).toHaveLength(1);
    expect(critical[0]).toContain('Invalid msgraph auth_method');
    expect(critical[0]).toContain('NotARealMethod');
    expect(graphConnect).not.toHaveBeenCalled();
    expect(core.getDmarcReportsFromMailbox).not.toHaveBeenCalled();
  });
});

describe('TestMSGraphConnectionLogging', () => {
  it('testCliLogsMsGraphConnectionSummaryAndTiming', async () => {
    const configPath = writeConfig(CERT_CONFIG);
    const capture_ = capture(INFO);
    await runMain(configPath, '--verbose');

    const text = output(capture_, INFO);
    expect(text).toContain('Connecting to Microsoft Graph');
    expect(text).toContain('auth_method=Certificate');
    expect(text).toContain('tenant_id=tenant-id-5678');
    expect(text).toContain('client_id=client-id-1234');
    expect(text).toContain('mailbox=shared@example.com');
    expect(text).toContain('graph_url=https://graph.microsoft.com');
    expect(text).toContain('Microsoft Graph connection initialized in');
  });

  it('testCliMsGraphLoggingNeverLogsSecretValues', async () => {
    let capture_ = capture();
    await runMain(writeConfig(CERT_CONFIG), '--debug');
    let text = output(capture_);
    expect(text).not.toContain('s3cret-cert-pass');
    expect(text).toContain('certificate_path=/tmp/msgraph-cert.pem');
    expect(text).toContain('certificate_password set');
    expect(text).toContain('client_assertion not set');
    capture_.restore();

    const assertionConfig = `[general]
silent = true

[msgraph]
auth_method = ClientAssertion
client_id = client-id-1234
tenant_id = tenant-id-5678
mailbox = shared@example.com
client_assertion = s3cret-signed-jwt-assertion
`;
    capture_ = capture();
    await runMain(writeConfig(assertionConfig), '--debug');
    text = output(capture_);
    expect(text).not.toContain('s3cret-signed-jwt-assertion');
    expect(text).toContain('client_assertion set');
    // The connection still receives the secret itself.
    expect(graphOptions()).toMatchObject({
      clientAssertion: 's3cret-signed-jwt-assertion',
    });
  });

  it('testCliDebugEnablesDependencyLoggers', async () => {
    await runMain(writeConfig(CERT_CONFIG), '--debug');

    expect(logger.handlers.length).toBeGreaterThan(0);
    for (const name of DEPENDENCY_LOGGERS) {
      const dep = getLogger(name);
      expect(dep.level, name).toBe(DEBUG);
      for (const wanted of logger.handlers) {
        expect(dep.handlers, name).toContain(wanted);
      }
    }
    // The Azure SDK's own logger follows the same level.
    expect(getLogLevel()).toBe('verbose');
  });

  it('testCliDefaultKeepsDependencyLoggersAtWarning', async () => {
    await runMain(writeConfig(CERT_CONFIG));

    for (const name of DEPENDENCY_LOGGERS) {
      expect(getLogger(name).level, name).toBe(WARNING);
    }
    expect(getLogLevel()).toBe('warning');
  });
});

describe('TestMSGraphEmailResults', () => {
  it('testCliSendsSummaryEmailViaMsGraphWhenNoSmtpHost', async () => {
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: await sampleAggregateReports(),
      failureReports: [],
      smtpTlsReports: [],
    });
    await runMain(
      writeConfig(`${CERT_CONFIG}
[smtp]
to = admin@example.com
subject = DMARC Summary
`),
    );

    expect(graphConnection.sendMessage).toHaveBeenCalledTimes(1);
    const sent = graphConnection.sendMessage.mock.calls[0]?.[0] as {
      messageTo: string[];
      subject: string;
      attachments: [string, Uint8Array][];
    };
    expect(sent.messageTo).toEqual(['admin@example.com']);
    expect(sent.subject).toBe('DMARC Summary');

    const [filename, payload] = sent.attachments[0] ?? ['', new Uint8Array()];
    expect(filename).toMatch(/^DMARC-\d{4}-\d{2}-\d{2}\.zip$/u);
    // A zip archive holding the aggregate CSV.
    expect([...payload.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(Buffer.from(payload).includes('aggregate.csv')).toBe(true);
  });

  it('testCliSkipsMsGraphSummaryEmailWhenNothingWasParsed', async () => {
    const configPath = writeConfig(`${CERT_CONFIG.replace(
      'silent = true',
      'silent = true\nverbose = true',
    )}
[smtp]
to = admin@example.com
subject = DMARC Summary
`);
    const capture_ = capture(INFO);
    await runMain(configPath);

    expect(graphConnection.sendMessage).not.toHaveBeenCalled();
    expect(
      capture_.output.some(line => line.includes('skipping the results email')),
    ).toBe(true);
  });

  it('testCliPrefersSmtpWhenBothSmtpAndMsGraphConfigured', async () => {
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: await sampleAggregateReports(),
      failureReports: [],
      smtpTlsReports: [],
    });
    vi.mocked(emailResults).mockResolvedValue(undefined);
    await runMain(
      writeConfig(`${CERT_CONFIG}
[smtp]
host = smtp.example.com
user = smtp-user
password = smtp-password
from = dmarc@example.com
to = admin@example.com
`),
    );

    expect(emailResults).toHaveBeenCalledTimes(1);
    const call = vi.mocked(emailResults).mock.calls[0];
    expect(call?.[1]).toBe('smtp.example.com');
    expect(call?.[2]).toBe('dmarc@example.com');
    expect(call?.[3]).toEqual(['admin@example.com']);
    expect(call?.[4]).toMatchObject({
      username: 'smtp-user',
      password: 'smtp-password',
    });
    expect(graphConnection.sendMessage).not.toHaveBeenCalled();
  });

  it('testCliSkipsGraphSendWithoutSmtpSection', async () => {
    await runMain(writeConfig(CERT_CONFIG));
    expect(graphConnection.sendMessage).not.toHaveBeenCalled();
  });

  it('testCliSmtpWithoutHostRequiresMsGraph', async () => {
    const configPath = writeConfig(`[general]
silent = true

[smtp]
to = admin@example.com
`);
    const capture_ = capture();
    await expect(runMain(configPath)).rejects.toMatchObject({ code: -1 });
    expect(criticalMessages(capture_)).toEqual([
      'host setting missing from the smtp config section',
    ]);
    expect(graphConnect).not.toHaveBeenCalled();
    expect(core.getDmarcReportsFromMailbox).not.toHaveBeenCalled();
  });

  it('testCliLogsMsGraphSendFailure', async () => {
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: await sampleAggregateReports(),
      failureReports: [],
      smtpTlsReports: [],
    });
    graphConnection.sendMessage.mockRejectedValue(
      new ODataError(
        {
          code: null,
          message: 'Access is denied',
          innerError: {
            requestId: 'rid-1',
            clientRequestId: 'crid-1',
            date: null,
          },
        },
        { responseStatusCode: 403, responseHeaders: {} },
      ),
    );
    const configPath = writeConfig(`${CERT_CONFIG}
[smtp]
to = admin@example.com
subject = DMARC Summary
`);
    const capture_ = capture(ERROR);
    await expect(runMain(configPath)).rejects.toMatchObject({ code: 1 });

    const text = output(capture_, ERROR);
    expect(text).toContain('Microsoft Graph message send failed');
    expect(text).toContain('mailbox=');
    expect(text).toContain('tenant_id=');
    expect(text).toContain('auth_method=Certificate');
    expect(text).toContain('status=403');
    expect(text).toContain('Access is denied');
    expect(text).toContain('request-id=rid-1');
    expect(text).toContain('client-request-id=crid-1');
  });

  it('testCliPassesSmtpAttachmentAndMessageToMsGraphSend', async () => {
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: await sampleAggregateReports(),
      failureReports: [],
      smtpTlsReports: [],
    });
    await runMain(
      writeConfig(`${CERT_CONFIG}
[smtp]
to = admin@example.com
attachment = custom-report.zip
message = Custom body text
`),
    );

    expect(graphConnection.sendMessage).toHaveBeenCalledTimes(1);
    const sent = graphConnection.sendMessage.mock.calls[0]?.[0] as {
      attachments: [string, Uint8Array][];
      plainMessage: string;
    };
    expect(sent.attachments[0]?.[0]).toBe('custom-report.zip');
    expect(sent.plainMessage).toBe('Custom body text');
  });
});

describe('TestMSGraphFailureLogging', () => {
  it('testCliLogsMsGraphConnectionAuthFailureContext', async () => {
    graphConnect.mockRejectedValue(
      new AuthenticationError('AADSTS7000215: Invalid client secret'),
    );
    const configPath = writeConfig(CERT_CONFIG);
    const capture_ = capture(ERROR);
    await expect(runMain(configPath)).rejects.toMatchObject({ code: 1 });

    const text = output(capture_, ERROR);
    expect(text).toContain('Microsoft Graph connection failed');
    expect(text).toContain('mailbox=shared@example.com');
    expect(text).toContain('tenant_id=tenant-id-5678');
    expect(text).toContain('auth_method=Certificate');
    expect(text).toContain('AADSTS7000215');
    expect(core.getDmarcReportsFromMailbox).not.toHaveBeenCalled();
  });

  it('testCliLogsMsGraphMailboxFetchFailureWithRequestId', async () => {
    vi.mocked(core.getDmarcReportsFromMailbox).mockRejectedValue(
      new ODataError(
        {
          code: null,
          message: 'Service unavailable',
          innerError: {
            requestId: 'rid-2',
            clientRequestId: 'crid-2',
            date: null,
          },
        },
        { responseStatusCode: 503, responseHeaders: {} },
      ),
    );
    const configPath = writeConfig(CERT_CONFIG);
    const capture_ = capture(ERROR);
    await expect(runMain(configPath)).rejects.toMatchObject({ code: 1 });

    const text = output(capture_, ERROR);
    expect(text).toContain('Microsoft Graph mailbox fetch failed');
    expect(text).toContain('request-id=rid-2');
    expect(text).toContain('client-request-id=crid-2');
  });

  it('testCliMsGraphErrorFallsBackToResponseHeaderRequestId', async () => {
    vi.mocked(core.getDmarcReportsFromMailbox).mockRejectedValue(
      new ODataError(
        { code: null, message: null, innerError: null },
        {
          responseStatusCode: 503,
          responseHeaders: { 'request-id': 'hdr-rid' },
        },
      ),
    );
    const configPath = writeConfig(CERT_CONFIG);
    const capture_ = capture(ERROR);
    await expect(runMain(configPath)).rejects.toMatchObject({ code: 1 });

    expect(output(capture_, ERROR)).toContain('request-id=hdr-rid');
  });

  it('testCliMsGraphErrorOmitsRequestIdWhenAbsent', async () => {
    vi.mocked(core.getDmarcReportsFromMailbox).mockRejectedValue(
      new ODataError(
        { code: null, message: null, innerError: null },
        { responseStatusCode: 500, responseHeaders: {} },
      ),
    );
    const configPath = writeConfig(CERT_CONFIG);
    const capture_ = capture(ERROR);
    await expect(runMain(configPath)).rejects.toMatchObject({ code: 1 });

    const text = output(capture_, ERROR);
    expect(text).toContain('Microsoft Graph mailbox fetch failed');
    expect(text).toContain('status=500');
    expect(text).not.toContain('request-id=');
  });

  it('testWatchModeLogsMsGraphErrorAndExits', async () => {
    // httpx.ConnectError's counterpart: fetch's network failure.
    vi.mocked(core.watchInbox).mockRejectedValue(new TypeError('fetch failed'));
    const configPath = writeConfig(`${CERT_CONFIG}\n[mailbox]\nwatch = true\n`);
    const capture_ = capture(ERROR);
    await expect(runMain(configPath)).rejects.toMatchObject({ code: 1 });

    const text = output(capture_, ERROR);
    expect(text).toContain('Microsoft Graph mailbox watch failed');
    expect(text).toContain('TypeError: fetch failed');
    expect(core.watchInbox).toHaveBeenCalledTimes(1);
  });

  it('testNonGraphMailboxErrorIsNotMislabeledAsMsGraph', async () => {
    const imapConnection = { close: vi.fn(async () => undefined) };
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue(
      imapConnection as unknown as IMAPConnection,
    );
    vi.mocked(core.getDmarcReportsFromMailbox).mockRejectedValue(
      new TypeError('fetch failed'),
    );
    const configPath = writeConfig(`[general]
silent = true

[imap]
host = imap.example.com
user = test-user
password = test-password
`);
    const capture_ = capture(ERROR);
    await expect(runMain(configPath)).rejects.toMatchObject({ code: 1 });

    const text = output(capture_, ERROR);
    expect(text).toContain('Mailbox Error');
    expect(text).not.toContain('Microsoft Graph');
    expect(imapConnection.close).toHaveBeenCalled();
  });
});
