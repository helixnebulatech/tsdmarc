// email_results() and _build_report_email_content() from parsedmarc,
// including tests/test_init.py TestEmailResultsErrorBranches.

import { AssertionError } from 'node:assert';

import type { ParsingResults } from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildReportEmailContent, emailResults } from './email-results';
import { fakeSmtp, resetFakeSmtp } from './test/fake-smtp-connection';

vi.mock('nodemailer/lib/smtp-connection', async () => {
  const fake = await import('./test/fake-smtp-connection');
  return { default: fake.FakeSMTPConnection };
});

const RESULTS: ParsingResults = {
  aggregateReports: [],
  failureReports: [],
  smtpTlsReports: [],
};
const ZIP = Uint8Array.from([0x50, 0x4b, 0x05, 0x06]);

beforeEach(() => {
  resetFakeSmtp();
  vi.useFakeTimers({ toFake: ['Date'] });
  // Local time (TZ=UTC in tests): the date parsedmarc formats with now().
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('emailResults', () => {
  // A string mail_to would make the SMTP code iterate over its characters.
  it('requires mailTo to be a list', async () => {
    await expect(
      emailResults(
        RESULTS,
        'smtp.example.com',
        'from@example.com',
        'admin@example.com' as unknown as string[],
        { reportZip: ZIP },
      ),
    ).rejects.toThrow(AssertionError);
    expect(fakeSmtp.instances).toEqual([]);
  });

  it('sends the report zip with the default subject and body', async () => {
    const getReportZip = vi.fn((results: ParsingResults) => {
      expect(results).toBe(RESULTS);
      return Promise.resolve(ZIP);
    });
    await emailResults(
      RESULTS,
      'smtp.example.com',
      'from@example.com',
      ['admin@example.com'],
      {
        mailCc: ['cc@example.com'],
        mailBcc: ['bcc@example.com'],
        port: 2525,
        username: 'u',
        password: 'p',
        reportZip: getReportZip,
      },
    );
    const [connection] = fakeSmtp.instances;
    expect(connection?.options).toMatchObject({
      host: 'smtp.example.com',
      port: 2525,
      secure: false,
    });
    expect(connection?.auth).toEqual({ user: 'u', pass: 'p' });
    expect(connection?.envelope).toEqual({
      from: 'from@example.com',
      to: ['admin@example.com', 'cc@example.com', 'bcc@example.com'],
    });
    const message = connection?.message ?? '';
    expect(message).toContain('Subject: DMARC results for 2026-10-24');
    expect(message).toContain('\r\n\r\nDMARC results for 2026-10-24');
    expect(message).toContain(
      'Content-Disposition: attachment; filename="DMARC-2026-10-24.zip"',
    );
    expect(message).toContain(Buffer.from(ZIP).toString('base64'));
    expect(getReportZip).toHaveBeenCalledTimes(1);
  });

  it('applies subject, filename and message overrides', async () => {
    await emailResults(RESULTS, 'h', 'from@example.com', ['to@example.com'], {
      subject: 'Weekly',
      attachmentFilename: 'report',
      message: 'Attached.',
      requireEncryption: true,
      verify: false,
      reportZip: ZIP,
    });
    const [connection] = fakeSmtp.instances;
    expect(connection?.options).toMatchObject({
      port: 465,
      secure: true,
      tls: { rejectUnauthorized: false },
    });
    const message = connection?.message ?? '';
    expect(message).toContain('Subject: Weekly');
    expect(message).toContain('filename="report.zip"');
    expect(message).toContain('Attached.');
  });
});

describe('buildReportEmailContent', () => {
  it('builds the defaults from the local date', async () => {
    expect(await buildReportEmailContent(RESULTS, { reportZip: ZIP })).toEqual({
      subject: 'DMARC results for 2026-10-24',
      message: 'DMARC results for 2026-10-24',
      attachments: [['DMARC-2026-10-24.zip', ZIP]],
    });
  });

  it('appends .zip only when missing (case-insensitive)', async () => {
    const named = async (
      attachmentFilename: string,
    ): Promise<string | undefined> =>
      (
        await buildReportEmailContent(RESULTS, {
          attachmentFilename,
          reportZip: ZIP,
        })
      ).attachments[0]?.[0];
    expect(await named('report')).toBe('report.zip');
    expect(await named('report.ZIP')).toBe('report.ZIP');
  });

  it('keeps an empty subject or message (only null means default)', async () => {
    const content = await buildReportEmailContent(RESULTS, {
      subject: '',
      message: '',
      reportZip: ZIP,
    });
    expect(content.subject).toBe('');
    expect(content.message).toBe('');
  });
});
