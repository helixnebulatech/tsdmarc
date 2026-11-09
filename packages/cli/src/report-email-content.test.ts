// parsedmarc's TestEmailResultsViaMsGraph
// (testEmailResultsViaMsGraphBuildsSameContentAsEmailResults): in Python,
// email_results() and email_results_via_msgraph() share one
// _build_report_email_content(). @tsdmarc/smtp and @tsdmarc/msgraph each
// have a copy (neither package depends on the other); this test, in the
// package that depends on both, keeps the two copies in lockstep.

import {
  buildReportEmailContent as buildViaMsgraph,
  emailResultsViaMsgraph,
  type MSGraphConnection,
} from '@tsdmarc/msgraph';
import {
  buildReportEmailContent as buildViaSmtp,
  type ReportEmailContentOptions,
} from '@tsdmarc/smtp';
import type { ParsingResults } from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);

function results(): ParsingResults {
  return { aggregateReports: [], failureReports: [], smtpTlsReports: [] };
}

const CASES: [string, ReportEmailContentOptions][] = [
  ['defaults', { reportZip: ZIP }],
  ['a filename without .zip', { attachmentFilename: 'report', reportZip: ZIP }],
  [
    'a filename with an upper-case .ZIP',
    { attachmentFilename: 'Report.ZIP', reportZip: ZIP },
  ],
  ['an empty filename', { attachmentFilename: '', reportZip: ZIP }],
  [
    'subject and message overrides',
    { subject: 'Custom', message: 'Body', reportZip: ZIP },
  ],
  ['empty subject and message', { subject: '', message: '', reportZip: ZIP }],
  [
    'null overrides',
    { subject: null, message: null, attachmentFilename: null, reportZip: ZIP },
  ],
  ['a zip builder', { reportZip: () => Promise.resolve(ZIP) }],
];

describe('buildReportEmailContent: @tsdmarc/smtp and @tsdmarc/msgraph agree', () => {
  beforeEach(() => {
    // A fixed local date, so both copies can't straddle midnight.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2024, 0, 2, 3, 4, 5));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const [name, options] of CASES) {
    it(name, async () => {
      const viaSmtp = await buildViaSmtp(results(), options);
      const viaMsgraph = await buildViaMsgraph(results(), options);
      expect(viaMsgraph).toEqual(viaSmtp);
    });
  }

  it('uses the local date in the defaults', async () => {
    const content = await buildViaSmtp(results(), { reportZip: ZIP });
    expect(content.subject).toBe('DMARC results for 2024-01-02');
    expect(content.message).toBe('DMARC results for 2024-01-02');
    expect(content.attachments[0]?.[0]).toBe('DMARC-2024-01-02.zip');
  });

  it('emailResultsViaMsgraph sends the SMTP content, from the mailbox', async () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    const connection = {
      mailboxName: 'mb@example.com',
      sendMessage,
    } as unknown as MSGraphConnection;
    await emailResultsViaMsgraph(results(), connection, ['admin@example.com'], {
      reportZip: ZIP,
    });
    const expected = await buildViaSmtp(results(), { reportZip: ZIP });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expected.subject,
        plainMessage: expected.message,
        attachments: expected.attachments,
        messageTo: ['admin@example.com'],
        messageFrom: 'mb@example.com',
      }),
    );
  });
});
