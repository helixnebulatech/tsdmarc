// Ported from parsedmarc tests/test_cli.py: TestSmtpAttachmentAndMessageWiring
// and TestSkipsResultsEmailWhenNoReportsParsed.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { IMAPConnection } from '@tsdmarc/imap';
import {
  buildReportEmailContent,
  emailResults,
  type ReportEmailContent,
} from '@tsdmarc/smtp';
import {
  type AggregateReport,
  captureLogs,
  INFO,
  parseReportFile,
  type ParsingResults,
  WARNING,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from './core';
import { main } from './main';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SAMPLE_AGGREGATE_REPORT_PATH = path.join(
  REPO_ROOT,
  'samples/aggregate/!example.com!1538204542!1538463818.xml',
);

async function sampleAggregateReports(): Promise<AggregateReport[]> {
  const result = await parseReportFile(SAMPLE_AGGREGATE_REPORT_PATH, {
    offline: true,
  });
  if (result.reportType !== 'aggregate') {
    throw new Error('expected an aggregate report');
  }
  return [result.report];
}

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-cli-email-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(text: string): string {
  const configPath = path.join(tempDir, 'config.ini');
  writeFileSync(configPath, text);
  return configPath;
}

function mockImap(): void {
  vi.spyOn(IMAPConnection, 'connect').mockResolvedValue({
    close: vi.fn(async () => undefined),
  } as unknown as IMAPConnection);
}

const IMAP_AND_SMTP = `[general]
silent = true

[imap]
host = imap.example.com
user = test-user
password = test-password

[smtp]
host = smtp.example.com
user = smtp-user
password = smtp-password
from = dmarc@example.com
to = admin@example.com
`;

/** The entries of a zip archive (stored or deflated), by name. */
function readZip(zip: Uint8Array): Map<string, Buffer> {
  const buffer = Buffer.from(zip);
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (
    offset + 30 <= buffer.length &&
    buffer.readUInt32LE(offset) === 0x04_03_4b_50
  ) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset = dataStart + compressedSize;
  }
  return entries;
}

describe('TestSmtpAttachmentAndMessageWiring', () => {
  // A configured attachment filename and message body reach emailResults()
  // rather than being silently dropped.
  it('testSmtpAttachmentAndMessageArePassedToEmailResults', async () => {
    mockImap();
    const reports: ParsingResults = {
      aggregateReports: await sampleAggregateReports(),
      failureReports: [],
      smtpTlsReports: [],
    };
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue(reports);
    vi.mocked(emailResults).mockResolvedValue(undefined);
    const configPath = writeConfig(
      `${IMAP_AND_SMTP}attachment = custom-report.zip\nmessage = Custom body text\n`,
    );

    await main(['-c', configPath]);

    expect(emailResults).toHaveBeenCalledTimes(1);
    const options = vi.mocked(emailResults).mock.calls[0]?.[4];
    // Passed through expandPath(), a no-op without ~ or $VAR.
    expect(options?.attachmentFilename?.endsWith('custom-report.zip')).toBe(
      true,
    );
    expect(options?.message).toBe('Custom body text');
  });

  // parsedmarc 11.2.1 TestCliStartTLS (GHSA-3588-2mr7-vrcm), with the
  // IMAP and SMTP clients mocked: the end-to-end STARTTLS behavior is
  // tested in @tsdmarc/imap and @tsdmarc/smtp.
  const PLAIN_IMAP_AND_SMTP = `[general]
silent = true

[imap]
host = imap.example.com
port = 143
ssl = false
user = test-user
password = Sup3rSecret-placeholder

[smtp]
host = smtp.example.com
port = 587
user = smtp-user
password = Sup3rSecret-placeholder
from = dmarc@example.com
to = admin@example.com
`;

  async function runStartTls(
    config: string,
  ): Promise<{ imap: unknown; smtp: unknown; output: string }> {
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: await sampleAggregateReports(),
      failureReports: [],
      smtpTlsReports: [],
    });
    vi.mocked(emailResults).mockResolvedValue(undefined);
    mockImap();
    const logs = captureLogs(undefined, WARNING);
    try {
      await main(['-c', writeConfig(config)]);
    } finally {
      logs.restore();
    }
    return {
      imap: vi.mocked(IMAPConnection.connect).mock.calls.at(-1)?.[2],
      smtp: vi.mocked(emailResults).mock.calls.at(-1)?.[4],
      output: logs.output.join('\n'),
    };
  }

  it('testImapStartTLSDefaultsToNone (and SMTP)', async () => {
    const { imap, smtp, output } = await runStartTls(PLAIN_IMAP_AND_SMTP);
    expect(imap).toMatchObject({ ssl: false, starttls: null });
    expect(smtp).toMatchObject({ requireEncryption: false, starttls: null });
    expect(output).not.toContain('plain text');
  });

  it('testImapStartTLSFalseFromIni / testSmtpStartTLSFalseOptsOutWithWarning', async () => {
    const config = PLAIN_IMAP_AND_SMTP.replace(
      'port = 143\n',
      'port = 143\nstarttls = false\n',
    ).concat('starttls = false\n');
    const { imap, smtp, output } = await runStartTls(config);
    expect(imap).toMatchObject({ starttls: false });
    expect(smtp).toMatchObject({ starttls: false });
    expect(output).toContain(
      'WARNING:tsdmarc:[imap] starttls = False and ssl = False: the IMAP connection will not be encrypted, and the IMAP credentials will be sent in plain text',
    );
    expect(output).toContain(
      'WARNING:tsdmarc:[smtp] starttls = False and ssl = False: the SMTP connection will not be encrypted, and the SMTP credentials and the results email will be sent in plain text',
    );
    expect(output).not.toContain('Sup3rSecret-placeholder');
  });

  it('testImapStartTLSFalseWithSslLogsNoWarning (and SMTP)', async () => {
    const config = PLAIN_IMAP_AND_SMTP.replace(
      'ssl = false\n',
      'ssl = true\nstarttls = false\n',
    ).concat('ssl = true\nstarttls = false\n');
    const { imap, smtp, output } = await runStartTls(config);
    expect(imap).toMatchObject({ ssl: true, starttls: false });
    expect(smtp).toMatchObject({ requireEncryption: true, starttls: false });
    expect(output).not.toContain('plain text');
  });

  it('testImapStartTLSFromEnvVar', async () => {
    for (const [value, expected] of [
      ['false', false],
      ['true', true],
    ] as const) {
      vi.stubEnv('PARSEDMARC_IMAP_STARTTLS', value);
      vi.stubEnv('TSDMARC_SMTP_STARTTLS', value);
      try {
        // oxlint-disable-next-line no-await-in-loop -- one run per case
        const { imap, smtp } = await runStartTls(PLAIN_IMAP_AND_SMTP);
        expect(imap).toMatchObject({ starttls: expected });
        expect(smtp).toMatchObject({ starttls: expected });
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  // Without [smtp] attachment/message, emailResults() still gets the
  // documented defaults.
  it('testSmtpDefaultsFlowThroughWhenNotConfigured', async () => {
    mockImap();
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: await sampleAggregateReports(),
      failureReports: [],
      smtpTlsReports: [],
    });
    vi.mocked(emailResults).mockResolvedValue(undefined);
    const configPath = writeConfig(IMAP_AND_SMTP);

    await main(['-c', configPath]);

    expect(emailResults).toHaveBeenCalledTimes(1);
    const call = vi.mocked(emailResults).mock.calls[0];
    expect(call?.slice(1, 4)).toEqual([
      'smtp.example.com',
      'dmarc@example.com',
      ['admin@example.com'],
    ]);
    expect(call?.[4].attachmentFilename).toBeNull();
    expect(call?.[4].message).toBe('Please see the attached DMARC results.');
  });
});

describe('TestSkipsResultsEmailWhenNoReportsParsed', () => {
  // #200: an empty inbox must not send a results email with data-free
  // CSVs; an INFO line explains why.
  it('testSkipsResultsEmailWhenNothingWasParsed', async () => {
    mockImap();
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: [],
      failureReports: [],
      smtpTlsReports: [],
    });
    const configPath = writeConfig(
      IMAP_AND_SMTP.replace('silent = true', 'silent = true\nverbose = true'),
    );

    const logs = captureLogs('tsdmarc', INFO);
    try {
      await main(['-c', configPath]);
    } finally {
      logs.restore();
    }

    expect(emailResults).not.toHaveBeenCalled();
    expect(
      logs.output.some(line => line.includes('skipping the results email')),
    ).toBe(true);
  });

  // With at least one report the email is sent, and the attached zip's
  // aggregate.csv holds data rows, not just a header.
  it('testSendsResultsEmailWithRealPayloadWhenReportsExist', async () => {
    // The SMTP transport is the boundary: build the message content
    // exactly as emailResults() does, from the options the CLI passed.
    let sent: ReportEmailContent | null = null;
    vi.mocked(emailResults).mockImplementation(
      async (results, _host, _from, _to, options) => {
        sent = await buildReportEmailContent(results, options);
      },
    );
    const configPath = writeConfig(`[general]
silent = true
offline = true

[smtp]
host = smtp.example.com
user = smtp-user
password = smtp-password
from = dmarc@example.com
to = admin@example.com
`);

    await main(['-c', configPath, SAMPLE_AGGREGATE_REPORT_PATH]);

    expect(emailResults).toHaveBeenCalledTimes(1);
    const content = sent as ReportEmailContent | null;
    const [, zipBytes] = content?.attachments[0] ?? ['', new Uint8Array()];
    const csvText = readZip(zipBytes).get('aggregate.csv')?.toString('utf8');
    expect(csvText?.trim().split(/\r?\n/u).length).toBeGreaterThan(1);
  });
});
