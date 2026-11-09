// Port of parsedmarc's TestEmailResultsViaMsGraph (tests/test_init.py).
// Python compares the Graph call with email_results()'s SMTP call; that
// function lives in @tsdmarc/smtp, so here the defaults it shares are
// asserted directly on the sendMail request.

import type { AccessToken } from '@azure/identity';
import { type ParsingResults, PyDateTime } from 'tsdmarc';
import { describe, expect, it } from 'vitest';

import {
  buildReportEmailContent,
  emailResultsViaMsgraph,
} from './email-results';
import { MSGraphConnection } from './graph';
import { createFakeFetch, type FakeFetch } from './test/fake-fetch';

const SEND_MAIL = '/v1.0/users/mb%40example.com/sendMail';
const ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);

function results(): ParsingResults {
  return { aggregateReports: [], failureReports: [], smtpTlsReports: [] };
}

function connection(): { conn: MSGraphConnection; fake: FakeFetch } {
  const fake = createFakeFetch();
  fake.on('POST', SEND_MAIL, { status: 202 });
  const conn = new MSGraphConnection({
    credential: {
      getToken: (): Promise<AccessToken> =>
        Promise.resolve({
          token: 't',
          expiresOnTimestamp: Date.now() + 60_000,
        }),
    },
    mailbox: 'mb@example.com',
    fetch: fake.fetch,
  });
  return { conn, fake };
}

interface SentMessage {
  Message: {
    subject?: string;
    body: { content: string; contentType: string };
    toRecipients?: { emailAddress: { address: string } }[];
    ccRecipients?: { emailAddress: { address: string } }[];
    bccRecipients?: { emailAddress: { address: string } }[];
    attachments?: { name: string; contentBytes: string }[];
  };
  SaveToSentItems: boolean;
}

function sent(fake: FakeFetch): SentMessage {
  const [request] = fake.find('POST', SEND_MAIL);
  return JSON.parse(request?.body ?? 'null') as SentMessage;
}

describe('TestEmailResultsViaMsGraph', () => {
  it('builds the same content as emailResults()', async () => {
    const { conn, fake } = connection();
    const seen: ParsingResults[] = [];
    const input = results();
    await emailResultsViaMsgraph(input, conn, ['admin@example.com'], {
      reportZip: value => {
        seen.push(value);
        return ZIP;
      },
    });

    const date = PyDateTime.now().strftime('%Y-%m-%d');
    const { Message, SaveToSentItems } = sent(fake);
    expect(Message.subject).toBe(`DMARC results for ${date}`);
    expect(Message.body).toEqual({
      content: `DMARC results for ${date}`,
      contentType: 'text',
    });
    expect(Message.toRecipients).toEqual([
      { emailAddress: { address: 'admin@example.com' } },
    ]);
    expect(Message.attachments).toEqual([
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: `DMARC-${date}.zip`,
        contentBytes: Buffer.from(ZIP).toString('base64'),
      },
    ]);
    expect(SaveToSentItems).toBe(true);
    expect(seen).toEqual([input]);
  });

  it('appends the .zip extension', async () => {
    const { conn, fake } = connection();
    await emailResultsViaMsgraph(results(), conn, ['admin@example.com'], {
      attachmentFilename: 'report',
      reportZip: ZIP,
    });
    expect(sent(fake).Message.attachments?.[0]?.name).toBe('report.zip');
  });

  it('passes overrides, CC and BCC', async () => {
    const { conn, fake } = connection();
    await emailResultsViaMsgraph(results(), conn, ['a@example.com'], {
      mailCc: ['c@example.com'],
      mailBcc: ['b@example.com'],
      subject: 'Custom',
      message: 'Body',
      attachmentFilename: 'Report.ZIP',
      reportZip: () => Promise.resolve(ZIP),
    });
    const { Message } = sent(fake);
    expect(Message.subject).toBe('Custom');
    expect(Message.body.content).toBe('Body');
    expect(Message.ccRecipients).toEqual([
      { emailAddress: { address: 'c@example.com' } },
    ]);
    expect(Message.bccRecipients).toEqual([
      { emailAddress: { address: 'b@example.com' } },
    ]);
    expect(Message.attachments?.[0]?.name).toBe('Report.ZIP');
  });
});

describe('buildReportEmailContent', () => {
  it('keeps an empty subject override', async () => {
    // Python checks `subject is None`, so "" is kept.
    const content = await buildReportEmailContent(results(), {
      subject: '',
      message: '',
      reportZip: ZIP,
    });
    expect(content.subject).toBe('');
    expect(content.message).toBe('');
    expect(content.attachments[0]?.[1]).toBe(ZIP);
  });
});
