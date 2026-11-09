// Tests for report-email.ts, ported from parsedmarc's tests/test_init.py
// (Test, TestParseReportEmail) plus parsedmarc's own output for report
// emails built the same way (__fixtures__/report-email/cases.json, written
// by tools/fixtures/generate_report_email.py).

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { createParserConfig, newSeenAggregateReportIds } from './config';
import {
  EmailTooLargeError,
  InvalidDMARCReport,
  InvalidFailureReport,
  ParserError,
} from './errors';
import { DEBUG, captureLogs, type LogCapture } from './log';
import {
  aggregateReportKey,
  checkEmailLimits,
  classifyParsedEmail,
  decodeMimePayload,
  formatDatetime,
  parseReportEmail,
  TEXT_REPORT_REGEX,
  STR_PART_MAX_NESTING,
} from './report-email';
import { parseReportFile } from './report-file';
import { toSnakeCaseKeys } from './serialize';
import { cpuMsSince, cpuStart } from './test/cpu-time';
import { asJson, SAMPLES_DIR } from './test/fixtures';
import type {
  AggregateReport,
  FailureReport,
  ParsedReport,
  SMTPTLSReport,
} from './types';
import { PyDateTime } from './utils/datetime';
import type { Message } from './utils/py-email/message';
import { messageFromString } from './utils/py-email/parser';

interface Outcome {
  result?: unknown;
  error?: { type: string; message: string };
}

interface EmailCase extends Outcome {
  message: string;
}

interface Cases {
  emails: Record<string, EmailCase>;
}

const CASES = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dirname,
      '__fixtures__',
      'report-email',
      'cases.json',
    ),
    'utf-8',
  ),
) as Cases;

const OFFLINE = { offline: true, alwaysUseLocalFiles: true } as const;

function emailCase(name: string): EmailCase {
  const found = CASES.emails[name];
  if (!found) {
    throw new Error(`no case ${name}`);
  }
  return found;
}

async function parseCase(name: string): Promise<ParsedReport> {
  return parseReportEmail(emailCase(name).message, {
    config: createParserConfig(OFFLINE),
  });
}

async function failureCase(name: string): Promise<FailureReport> {
  const result = await parseCase(name);
  expect(result.reportType).toBe('failure');
  return result.report as FailureReport;
}

async function expectOutcome(
  promise: Promise<ParsedReport>,
  expected: Outcome,
): Promise<void> {
  let result: ParsedReport;
  try {
    result = await promise;
  } catch (error) {
    expect(expected.error, String(error)).toBeDefined();
    expect((error as Error).name).toBe(expected.error?.type);
    expect((error as Error).message).toBe(expected.error?.message ?? '');
    return;
  }
  expect(expected.error).toBeUndefined();
  expect(asJson(toSnakeCaseKeys(result))).toEqual(expected.result);
}

describe('parseReportEmail matches parsedmarc', () => {
  for (const [name, testCase] of Object.entries(CASES.emails)) {
    it(name, async () => {
      await expectOutcome(
        parseReportEmail(testCase.message, {
          config: createParserConfig(OFFLINE),
        }),
        testCase,
      );
    });

    it(`${name} (as bytes)`, async () => {
      await expectOutcome(
        parseReportEmail(new TextEncoder().encode(testCase.message), {
          config: createParserConfig(OFFLINE),
        }),
        testCase,
      );
    });
  }
});

describe('Test (parse_report_email)', () => {
  it('testFailureSamples', async () => {
    const directory = path.join(SAMPLES_DIR, 'failure');
    const samples = readdirSync(directory).filter(name =>
      name.endsWith('.eml'),
    );
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      const samplePath = path.join(directory, sample);
      const emailResult = await parseReportEmail(
        readFileSync(samplePath, 'utf-8'),
        OFFLINE,
      );
      expect(emailResult.reportType, sample).toBe('failure');
      const fileResult = await parseReportFile(samplePath, OFFLINE);
      expect(fileResult.reportType, sample).toBe('failure');
    }
  });

  it('testFailureSampleQuotedPrintableSamplePart', async () => {
    const report = await failureCase('failure-qp-sample');
    expect(report.reportedDomain).toBe('example.com');
    expect(report.parsedSample.from?.address).toBe('victim@example.com');
  });

  it('testFailureSampleBase64SamplePart', async () => {
    const report = await failureCase('failure-base64-sample');
    expect(report.reportedDomain).toBe('example.com');
    expect(report.parsedSample.from?.address).toBe('victim@example.com');
  });

  it('testFailureQuotedPrintableFeedbackReportPart', async () => {
    const report = await failureCase('failure-qp-feedback-report');
    expect(report.authenticationResults).toBe('mx.example.com; dmarc=fail');
    expect(report.authenticationResults).not.toContain('=3D');
  });

  it('testFailureReportWithNoReportedDomainAndNoSampleFrom', async () => {
    const error = await parseCase(
      'failure-no-reported-domain-no-sample-from',
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidFailureReport);
    const message = (error as Error).message;
    expect(message).toContain('Reported-Domain');
    expect(message).toContain('From header');
    expect(message).not.toContain('Unexpected error');
  });

  it('testFailureBase64FeedbackReportBodyWithoutCTE', async () => {
    const report = await failureCase(
      'failure-base64-feedback-body-without-cte',
    );
    expect(report.feedbackType).toBe('auth-failure');
    expect(report.authenticationResults).toBe('mx.example.com; dmarc=fail');
  });

  it('testFailureQuotedPrintableFeedbackReportMissingFeedbackType', async () => {
    const report = await failureCase(
      'failure-qp-feedback-missing-feedback-type',
    );
    expect(report.feedbackType).toBe('auth-failure');
    expect(report.authenticationResults).toBe('mx.example.com; dmarc=fail');
    expect(report.source.ipAddress).toBe('203.0.113.10');
  });

  it('testFailureSampleNonASCIIWithoutTransferEncoding', async () => {
    const report = await failureCase('failure-raw-8bit-sample');
    expect(report.parsedSample.from?.displayName).toBe('Jérôme');
    expect(report.parsedSample.from?.address).toBe('victim@example.com');
    expect(report.parsedSample.subject).toBe('café résumé');
    expect(JSON.stringify(report.parsedSample)).not.toContain('�');
  });

  it('testFailureQuotedPrintableFeedbackReportSoftLineBreak', async () => {
    const { message } = emailCase('failure-qp-feedback-soft-line-break');
    expect(message).toContain('=\n');
    const report = await failureCase('failure-qp-feedback-soft-line-break');
    expect(report.authenticationResults).toBe(
      'mx.example.com; dkim=fail header.d=example.com header.s=selector1 ' +
        'reason="signature verification failed"; spf=fail ' +
        'smtp.mailfrom=bounce@example.com; dmarc=fail',
    );
  });
});

describe('decodeMimePayload', () => {
  it('testDecodeMimePayloadUnknownCharset', () => {
    const part = messageFromString(
      'Content-Type: text/rfc822-headers; charset="x-not-a-real-charset"\n' +
        'Content-Transfer-Encoding: quoted-printable\n\nhello',
    );
    expect(decodeMimePayload(part, 'fallback')).toBe('hello');
  });

  it('testDecodeMimePayloadWithoutTransferEncodingReturnsFallback', () => {
    const part = messageFromString(
      'Content-Type: text/rfc822-headers; charset="us-ascii"\n' +
        'MIME-Version: 1.0\nContent-Transfer-Encoding: 7bit\n\nhello',
    );
    expect(decodeMimePayload(part, 'fallback')).toBe('fallback');
  });

  it('testDecodeMimePayloadUndecodableBase64FallsBack', () => {
    const parsed = messageFromString(
      'Content-Type: multipart/report; report-type="feedback-report"; boundary="X"\n' +
        'MIME-Version: 1.0\n\n--X\nContent-Type: message/feedback-report\n' +
        'MIME-Version: 1.0\nContent-Transfer-Encoding: base64\n\nAAAAA\n--X--\n',
    );
    const parts: Message[] = [...parsed.walk()].filter(
      part => part.getContentType() === 'message/feedback-report',
    );
    expect(parts).toHaveLength(1);
    const [part] = parts as [Message];
    expect(part.getDecodedPayload()).toBeNull();
    expect(decodeMimePayload(part, 'AAAAA')).toBe('AAAAA');
  });

  it('decodes a base64 part with its declared charset', () => {
    const part = messageFromString(
      'Content-Type: text/plain; charset="iso-8859-1"\n' +
        'Content-Transfer-Encoding: base64\n\nY2Fm6Q==\n',
    );
    expect(decodeMimePayload(part, 'fallback')).toBe('café');
  });
});

describe('TestParseReportEmail', () => {
  it('testSmtpTlsEmailReport', async () => {
    const content = readFileSync(
      path.join(SAMPLES_DIR, 'smtp_tls', 'google.com_smtp_tls_report.eml'),
    );
    const result = await parseReportEmail(content, { offline: true });
    expect(result.reportType).toBe('smtp_tls');
  });

  it('testInvalidEmailRaisesError', async () => {
    await expect(
      parseReportEmail(emailCase('not-a-report').message, { offline: true }),
    ).rejects.toBeInstanceOf(InvalidDMARCReport);
  });

  it('testUnparseableDateRaisesParserError', async () => {
    const error = await parseCase('unparseable-date').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ParserError);
    expect((error as Error).message).toContain('not-a-real-date');
  });

  it('testFailureTextReportParses', async () => {
    const report = await failureCase('text-failure-notice');
    expect(report.source.ipAddress).toBe('192.0.2.1');
  });

  it('testFailureTextMissingFieldsRaises', async () => {
    const error = await parseCase('text-failure-notice-missing-fields').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InvalidDMARCReport);
    expect((error as Error).message).toContain('Failure');
  });

  it('testAttachmentMalformedXmlRaises', async () => {
    const error = await parseCase('attachment-malformed-xml').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ParserError);
    expect((error as Error).message).toContain('not a valid DMARC report');
  });

  it('testAttachmentInvalidJsonRaises', async () => {
    const error = await parseCase('attachment-invalid-json').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ParserError);
    expect((error as Error).message).toContain('Tls');
  });

  it('testTextReportRegexRejectsWhitespacePaddingQuickly', async () => {
    // GHSA-7grx-mj6g-qxmc: the old pattern took ~210 s on this body.
    const padding = ' '.repeat(6400);
    const lines: string[] = [];
    for (let index = 0; index < padding.length; index += 70) {
      lines.push(padding.slice(index, index + 70));
    }
    const message =
      'From: mailer-daemon@example.com\nTo: dmarc@example.com\n' +
      'Subject: Failure notice\nDate: Mon, 01 Jan 2024 00:00:00 +0000\n' +
      'Content-Type: text/plain\n\n' +
      `A message claiming to be from you has failed\n${lines.join('\n')}\ndetected.`;
    const start = cpuStart();
    await expect(
      parseReportEmail(message, { offline: true }),
    ).rejects.toBeInstanceOf(InvalidDMARCReport);
    expect(cpuMsSince(start)).toBeLessThan(10_000);
  });

  it('testTextReportFieldNamesMustBeSingleLine', () => {
    const findall = (text: string): [string, string][] =>
      [...text.matchAll(TEXT_REPORT_REGEX)].map(match => [
        match[1] ?? '',
        match[2] ?? '',
      ]);
    expect(
      findall('Sender\nDomain: x').some(([name]) => name.includes('\n')),
    ).toBe(false);
    expect(findall('  Sender IP Address: 1.2.3.4\n')).toEqual([
      ['Sender IP Address', '1.2.3.4'],
    ]);
    expect(
      findall('Received Date: Mon, 01 Jan 2024 00:00:00 +0000\r\n'),
    ).toEqual([['Received Date', 'Mon, 01 Jan 2024 00:00:00 +0000']]);
    // Python's re.MULTILINE `^` does not start a line after a lone CR.
    expect(findall('x\rName: value')).toEqual([]);
  });
});

// GHSA-qxwv-2vwj-v828 fixtures (tests/test_init.py). A failure report
// whose message/rfc822 sample has a header containing \x1c, which
// str.splitlines() treats as a line break, so re-serializing the sample
// raises email.errors.HeaderWriteError.
const POISON_HEADER_EMAIL = new TextEncoder().encode(
  'From: a@example.com\nSubject: x\nDate: Mon, 1 Jan 2024 00:00:00 +0000\n' +
    'MIME-Version: 1.0\n' +
    'Content-Type: multipart/report; report-type=feedback-report; boundary=B\n\n' +
    '--B\nContent-Type: text/plain\n\nhi\n' +
    '--B\nContent-Type: message/feedback-report\n\n' +
    'Feedback-Type: auth-failure\nVersion: 1\nSource-IP: 192.0.2.1\n' +
    'Arrival-Date: Mon, 1 Jan 2024 00:00:00 +0000\nReported-Domain: example.com\n' +
    'Authentication-Results: x\n\n' +
    '--B\nContent-Type: message/rfc822\n\nFrom: a@b\nX-A: a\u001Cb\n\nbody\n--B--\n',
);

// Far past the (emulated) recursion limit wherever the message is
// re-serialized; still parses in milliseconds.
const POISON_NESTING_LEVELS = 400;
const SHALLOW_NESTING_LEVELS = 50;

/** `levels` nested multipart/mixed parts around one text part. */
function nestedMultipartEmail(levels: number): Uint8Array {
  let message = 'Subject: s\n';
  for (let index = 0; index < levels; index += 1) {
    message += `Content-Type: multipart/mixed; boundary=b${index}\n\n--b${index}\n`;
  }
  message += 'Content-Type: text/plain\n\nx\n';
  for (let index = levels - 1; index >= 0; index -= 1) {
    message += `--b${index}--\n`;
  }
  return new TextEncoder().encode(message);
}

/** Like MIMEMultipart + MIMEApplication(payload, subtype).as_string(). */
function emailWithAttachment(payload: Uint8Array, subtype: string): string {
  const base64 = Buffer.from(payload).toString('base64');
  const lines = base64.match(/.{1,76}/gu) ?? [];
  return [
    'Content-Type: multipart/mixed; boundary="===============0000000000000000000=="',
    'MIME-Version: 1.0',
    'From: reports@example.com',
    'Subject: Report',
    'Date: Mon, 01 Jan 2024 00:00:00 +0000',
    '',
    '--===============0000000000000000000==',
    `Content-Type: application/${subtype}`,
    'MIME-Version: 1.0',
    'Content-Transfer-Encoding: base64',
    '',
    ...lines,
    '',
    '--===============0000000000000000000==--',
    '',
  ].join('\n');
}

describe('TestParseReportEmail (11.1.0)', () => {
  it('testSubjectControlCharactersEscapedInErrorMessage', async () => {
    const email =
      'From: test@example.com\n' +
      'Subject: =?utf-8?q?line1=0D=0AINJECTED=20fake=20log?=\n' +
      'Content-Type: text/plain\n\nNot a report.';
    const error = await parseReportEmail(email, { offline: true }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InvalidDMARCReport);
    const { message } = error as Error;
    expect(message).toContain('line1\\r\\nINJECTED fake log');
    expect(message).not.toContain('\r');
    expect(message).not.toContain('\n');
  });

  it('testFromHeaderControlCharactersEscapedInInfoLog', async () => {
    const email =
      'From: "a\u001BFORGED" <test@example.com>\n' +
      'Subject: Hello\n' +
      'Content-Type: text/plain\n\nNot a report.';
    const capture = captureLogs(undefined, DEBUG);
    try {
      await expect(
        parseReportEmail(email, { offline: true }),
      ).rejects.toBeInstanceOf(InvalidDMARCReport);
      const line = capture.output.find(entry =>
        entry.includes('Parsing mail from'),
      );
      expect(line).toContain('\\x1bFORGED');
      expect(line).not.toContain('\u001B');
      expect(line?.split(/\r\n|\r|\n/u)).toHaveLength(1);
    } finally {
      capture.restore();
    }
  });

  it('testUnserializableSubMessageRaisesParserError', async () => {
    const error = await parseReportEmail(POISON_HEADER_EMAIL, {
      offline: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ParserError);
    expect((error as Error).message).toBe(
      'Unable to parse message with subject "x": folded header contains newline: \'X-A: a\\nb\\n\'',
    );
  });

  it('testDeeplyNestedMultipartRaisesParserError', async () => {
    const deep = await parseReportEmail(
      nestedMultipartEmail(POISON_NESTING_LEVELS),
      { offline: true },
    ).catch((caught: unknown) => caught);
    expect(deep).toBeInstanceOf(ParserError);
    expect((deep as Error).message).toContain('recursion');

    const shallow = await parseReportEmail(
      nestedMultipartEmail(SHALLOW_NESTING_LEVELS),
      { offline: true },
    ).catch((caught: unknown) => caught);
    expect(shallow).toBeInstanceOf(InvalidDMARCReport);
    expect((shallow as Error).message).toContain('is not a valid report');
  });

  it('testBase64SmtpTlsJsonPart', async () => {
    const payload = readFileSync(
      path.join(SAMPLES_DIR, 'smtp_tls', 'rfc8460.json'),
    );
    const result = await parseReportEmail(
      emailWithAttachment(payload, 'tlsrpt+json'),
      { offline: true },
    );
    expect(result.reportType).toBe('smtp_tls');
  });

  it('testSmtpTlsJsonInGenericAttachment', async () => {
    const payload = readFileSync(
      path.join(SAMPLES_DIR, 'smtp_tls', 'rfc8460.json'),
    );
    const result = await parseReportEmail(
      emailWithAttachment(payload, 'octet-stream'),
      { offline: true },
    );
    expect(result.reportType).toBe('smtp_tls');
  });

  it('testNonBase64AttachmentIsSkipped', async () => {
    const eml =
      'From: reports@example.com\n' +
      'Subject: Report\n' +
      'Date: Mon, 01 Jan 2024 00:00:00 +0000\n' +
      'Content-Type: application/octet-stream\n\n' +
      // Three base64 characters: b64decode() raises "Incorrect padding".
      'abc\n';
    const error = await parseReportEmail(eml, { offline: true }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InvalidDMARCReport);
    expect((error as Error).message).toBe(
      'Message with subject "Report" is not a valid report',
    );
  });

  it('testInvalidAggregateAttachmentRaisesParserError', async () => {
    const error = await parseReportEmail(
      emailWithAttachment(
        new TextEncoder().encode('<feedback></feedback>'),
        'xml',
      ),
      { offline: true },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ParserError);
    expect((error as Error).message).toContain(
      'Message with subject "Report" is not a valid DMARC report',
    );
  });
});

describe('formatDatetime', () => {
  it('formats like email.utils.format_datetime', () => {
    expect(
      formatDatetime(
        new PyDateTime({ year: 2024, month: 1, day: 1, utcOffsetMinutes: 0 }),
      ),
    ).toBe('Mon, 01 Jan 2024 00:00:00 +0000');
    expect(
      formatDatetime(
        new PyDateTime({
          year: 2018,
          month: 9,
          day: 28,
          hour: 16,
          minute: 48,
          second: 42,
          utcOffsetMinutes: -330,
        }),
      ),
    ).toBe('Fri, 28 Sep 2018 16:48:42 -0530');
    expect(
      formatDatetime(new PyDateTime({ year: 2024, month: 2, day: 29 })),
    ).toBe('Thu, 29 Feb 2024 00:00:00 -0000');
  });
});

describe('parseReportEmail logging', () => {
  let capture: LogCapture | null = null;
  afterEach(() => {
    capture?.restore();
    capture = null;
  });

  // mail-parser's From header is an address list; parsedmarc logs its str().
  it('logs the sender and date at INFO', async () => {
    capture = captureLogs(undefined, DEBUG);
    await parseCase('attachment-gzip-aggregate');
    expect(capture.output).toContain(
      "INFO:tsdmarc:Parsing mail from [['', 'dmarc@example.com']] on Mon, 01 Jan 2024 00:00:00 +0000",
    );
  });
});

describe('keepAlive failures (not in parsedmarc)', () => {
  const failure = new Error('NOOP failed');
  const keepAlive = (): never => {
    throw failure;
  };

  function largeReportEmail(): string {
    const record =
      '<record><row><source_ip>192.0.2.1</source_ip><count>1</count>' +
      '<policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>' +
      '<identifiers><header_from>a.example</header_from></identifiers>' +
      '<auth_results><spf><domain>a.example</domain><result>pass</result></spf></auth_results></record>';
    const xml =
      '<?xml version="1.0"?><feedback><report_metadata><org_name>o</org_name>' +
      '<email>r@o.example</email><report_id>id</report_id>' +
      '<date_range><begin>1700000000</begin><end>1700086399</end></date_range></report_metadata>' +
      `<policy_published><domain>a.example</domain><p>none</p></policy_published>${record.repeat(45)}</feedback>`;
    return [
      'From: r@o.example',
      'Subject: Report',
      'MIME-Version: 1.0',
      'Content-Type: application/gzip',
      'Content-Transfer-Encoding: base64',
      '',
      gzipSync(xml).toString('base64'),
      '',
    ].join('\n');
  }

  it('parseReportEmail rethrows the error as is', async () => {
    await expect(
      parseReportEmail(largeReportEmail(), { offline: true, keepAlive }),
    ).rejects.toBe(failure);
  });

  it('parseReportFile rethrows the error as is', async () => {
    await expect(
      parseReportFile(new TextEncoder().encode(largeReportEmail()), {
        offline: true,
        keepAlive,
      }),
    ).rejects.toBe(failure);
  });

  it('a keepAlive that works changes nothing', async () => {
    const parsed = await parseReportEmail(largeReportEmail(), {
      offline: true,
      keepAlive: () => undefined,
    });
    expect(parsed.reportType).toBe('aggregate');
  });
});

describe('classifyParsedEmail', () => {
  async function aggregate(): Promise<ParsedReport> {
    return parseCase('attachment-gzip-aggregate');
  }

  it('drops aggregate reports already seen', async () => {
    const seen = newSeenAggregateReportIds();
    const aggregates: AggregateReport[] = [];
    const failures: FailureReport[] = [];
    const smtpTls: SMTPTLSReport[] = [];
    const parsed = await aggregate();
    const capture = captureLogs(undefined, DEBUG);
    try {
      expect(
        classifyParsedEmail(parsed, aggregates, failures, smtpTls, {
          seenAggregateReportIds: seen,
        }),
      ).toBe('aggregate');
      classifyParsedEmail(parsed, aggregates, failures, smtpTls, {
        seenAggregateReportIds: seen,
      });
      expect(capture.output).toContain(
        'DEBUG:tsdmarc:Skipping duplicate aggregate report from example.com with ID: mbox-test-123',
      );
    } finally {
      capture.restore();
    }
    expect(aggregates).toHaveLength(1);
    expect(seen.has(aggregateReportKey(aggregates[0] as AggregateReport))).toBe(
      true,
    );
  });

  it('stages new keys in pendingAggregateKeys instead of the cache', async () => {
    const seen = newSeenAggregateReportIds();
    const pending = new Set<string>();
    const aggregates: AggregateReport[] = [];
    const parsed = await aggregate();
    for (let index = 0; index < 2; index += 1) {
      classifyParsedEmail(parsed, aggregates, [], [], {
        seenAggregateReportIds: seen,
        pendingAggregateKeys: pending,
      });
    }
    expect(aggregates).toHaveLength(1);
    const key = aggregateReportKey(aggregates[0] as AggregateReport);
    expect([...pending]).toEqual([key]);
    expect(seen.has(key)).toBe(false);
  });

  it('keys reports on org, ID and policy domain, in bounded memory', async () => {
    const parsed = await aggregate();
    const report = parsed.report as AggregateReport;
    const key = aggregateReportKey(report);
    const variant = (
      metadata: Partial<AggregateReport['reportMetadata']>,
      domain: string | null = report.policyPublished.domain,
    ): AggregateReport => ({
      ...report,
      reportMetadata: { ...report.reportMetadata, ...metadata },
      policyPublished: {
        ...report.policyPublished,
        domain: domain as string,
      },
    });
    expect(aggregateReportKey(variant({}))).toBe(key);
    expect(aggregateReportKey(variant({}, 'other.example'))).not.toBe(key);
    expect(aggregateReportKey(variant({ orgName: 'x' }))).not.toBe(key);
    expect(aggregateReportKey(variant({ reportId: 'x' }))).not.toBe(key);
    // As parsedmarc 11.2: the period is not part of the identity
    expect(aggregateReportKey(variant({ beginDate: 'x' }))).toBe(key);
    expect(aggregateReportKey(variant({ endDate: 'x' }))).toBe(key);
    // ASCII letters of the domain compare without case (RFC 4343), others
    // keep theirs
    expect(aggregateReportKey(variant({}, 'A.Example'))).toBe(
      aggregateReportKey(variant({}, 'a.example')),
    );
    expect(aggregateReportKey(variant({}, 'Ä.example'))).not.toBe(
      aggregateReportKey(variant({}, 'ä.example')),
    );
    expect(
      aggregateReportKey(variant({ orgName: 'o', reportId: 'i' }, null)),
    ).toBe('["o","i",null]');
    expect(
      aggregateReportKey(variant({ orgName: 'a_b', reportId: 'c' })),
    ).not.toBe(aggregateReportKey(variant({ orgName: 'a', reportId: 'b_c' })));

    const hugeId = 'x'.repeat(10_000_000);
    const huge = aggregateReportKey(variant({ reportId: hugeId }));
    expect(huge.length).toBeLessThan(100);
    expect(aggregateReportKey(variant({ reportId: `${hugeId}y` }))).not.toBe(
      huge,
    );
  });

  it('appends failure and SMTP TLS reports', async () => {
    const failures: FailureReport[] = [];
    const smtpTls: SMTPTLSReport[] = [];
    const options = { seenAggregateReportIds: newSeenAggregateReportIds() };
    expect(
      classifyParsedEmail(
        await parseCase('failure-plain'),
        [],
        failures,
        smtpTls,
        options,
      ),
    ).toBe('failure');
    expect(
      classifyParsedEmail(
        await parseCase('tlsrpt-json'),
        [],
        failures,
        smtpTls,
        options,
      ),
    ).toBe('smtp_tls');
    expect(failures).toHaveLength(1);
    expect(smtpTls).toHaveLength(1);
  });
});

describe('deeply nested MIME parts (RecursionError like Python)', () => {
  /** A message of `depth` nested multiparts (or message/rfc822 parts). */
  const nested = (depth: number, kind: 'multipart' | 'rfc822'): string => {
    const lines = [
      'From: a@b.c',
      'To: d@e.f',
      'Subject: test',
      'MIME-Version: 1.0',
    ];
    for (let level = 0; level < depth; level += 1) {
      lines.push(
        ...(kind === 'rfc822'
          ? ['Content-Type: message/rfc822', '']
          : [
              `Content-Type: multipart/mixed; boundary="b${level}"`,
              '',
              `--b${level}`,
            ]),
      );
    }
    lines.push('Content-Type: text/plain', '', 'hello');
    if (kind === 'multipart') {
      for (let level = depth - 1; level >= 0; level -= 1) {
        lines.push(`--b${level}--`);
      }
    }
    return `${lines.join('\r\n')}\r\n`;
  };

  // Measured with parsedmarc on Python 3.14, called from a module's top
  // level: 247 levels parse, 248 raise RecursionError from `str(part)` in
  // parse_report_email, which 11.1.0 wraps in a ParserError (also through
  // parse_report_file).
  for (const kind of ['multipart', 'rfc822'] as const) {
    it(`${kind}: 247 levels parse, 248 raise a ParserError`, async () => {
      await expect(
        parseReportEmail(nested(STR_PART_MAX_NESTING + 1, kind), OFFLINE),
      ).rejects.toThrow('Message with subject "test" is not a valid report');
      for (const parse of [
        (text: string) => parseReportEmail(text, OFFLINE),
        (text: string) =>
          parseReportFile(new TextEncoder().encode(text), OFFLINE),
      ]) {
        const error = await parse(nested(STR_PART_MAX_NESTING + 2, kind)).then(
          () => null,
          (rejection: unknown) => rejection,
        );
        expect(error).toBeInstanceOf(ParserError);
        expect((error as Error).message).toBe(
          'Unable to parse message with subject "test": maximum recursion depth exceeded',
        );
        expect(((error as Error).cause as Error).name).toBe('RecursionError');
      }
    });
  }
});

describe('email limits (not in parsedmarc)', () => {
  const AGGREGATE_EMAIL = readFileSync(
    path.join(SAMPLES_DIR, 'aggregate', 'twilight.eml'),
    'utf-8',
  );
  const offline = (extra: Record<string, unknown> = {}) =>
    createParserConfig({ offline: true, alwaysUseLocalFiles: true, ...extra });

  it('has 50 MiB and 10,000 MIME boundary lines as defaults', () => {
    const config = createParserConfig();
    expect(config.maxEmailSize).toBe(50 * 1024 * 1024);
    expect(config.maxMimeParts).toBe(10_000);
  });

  it('rejects an email over maxEmailSize before parsing it', async () => {
    const size = Buffer.byteLength(AGGREGATE_EMAIL);
    const error = await parseReportEmail(AGGREGATE_EMAIL, {
      config: offline({ maxEmailSize: size - 1 }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailTooLargeError);
    expect(error).toBeInstanceOf(ParserError);
    expect((error as Error).message).toBe(
      `Email of ${size} bytes exceeds the ${size - 1} byte size limit (max_email_size)`,
    );
    const report = await parseReportEmail(AGGREGATE_EMAIL, {
      config: offline({ maxEmailSize: size }),
    });
    expect(report.reportType).toBe('aggregate');
  });

  it('counts the size of text in UTF-8 bytes, and of bytes as given', () => {
    const limits = { maxEmailSize: 3, maxMimeParts: 0 };
    expect(() => checkEmailLimits('abc', limits)).not.toThrow();
    expect(() => checkEmailLimits('abé', limits)).toThrow(EmailTooLargeError);
    expect(() => checkEmailLimits(Uint8Array.of(1, 2, 3, 4), limits)).toThrow(
      'Email of 4 bytes exceeds the 3 byte size limit',
    );
    expect(() =>
      checkEmailLimits('x'.repeat(100), { maxEmailSize: 0, maxMimeParts: 0 }),
    ).not.toThrow();
  });

  it('rejects an email with more MIME boundary lines than maxMimeParts', () => {
    const body = (parts: number): string =>
      `Content-Type: multipart/mixed; boundary=b\r\n\r\n${'--b\r\n\r\nx\r\n'.repeat(parts)}--b--\r\n`;
    const limits = { maxEmailSize: 0, maxMimeParts: 10 };
    // 9 parts and the closing line: 10 boundary lines.
    expect(() => checkEmailLimits(body(9), limits)).not.toThrow();
    expect(() => checkEmailLimits(body(10), limits)).toThrow(
      new EmailTooLargeError(
        'Email has more than 10 MIME boundary lines (max_mime_parts)',
      ),
    );
    expect(() =>
      checkEmailLimits(new TextEncoder().encode(body(10)), limits),
    ).toThrow(EmailTooLargeError);
    // A line starting with "--" at the very start counts too.
    expect(() =>
      checkEmailLimits('--a\n--b\n', { maxEmailSize: 0, maxMimeParts: 1 }),
    ).toThrow(EmailTooLargeError);
  });

  it('counts boundary lines that end in a lone CR, which the parser accepts', () => {
    const limits = { maxEmailSize: 0, maxMimeParts: 10 };
    const body = `a: b\n\n${'--b\r'.repeat(11)}`;
    expect(() => checkEmailLimits(body, limits)).toThrow(EmailTooLargeError);
    expect(() =>
      checkEmailLimits(new TextEncoder().encode(body), limits),
    ).toThrow(EmailTooLargeError);
  });

  it('counts the parts that need no boundary line', async () => {
    const eml = `From: a@b\r\nSubject: x\r\nContent-Type: message/delivery-status\r\n\r\n${'\n'.repeat(11)}`;
    const error = await parseReportEmail(eml, {
      config: offline({ maxMimeParts: 10 }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailTooLargeError);
    expect((error as Error).message).toBe(
      'Email has more than 10 MIME parts (max_mime_parts)',
    );
  });

  it('limits header lines', async () => {
    const eml = `From: a@b\r\nSubject: x\r\n${'a: b\r\n'.repeat(10)}\r\nbody`;
    await expect(
      parseReportEmail(eml, { config: offline({ maxHeaderLines: 10 }) }),
    ).rejects.toThrow(EmailTooLargeError);
    await expect(
      parseReportEmail(eml, { config: offline({ maxHeaderLines: 12 }) }),
    ).rejects.toThrow('is not a valid report');
  });

  it('applies the limits to the sample of a failure report', async () => {
    const sample = `From: a@b\nContent-Type: message/delivery-status\n\n${'\n'.repeat(30)}`;
    const report =
      'Feedback-Type: auth-failure\nVersion: 1\nSource-IP: 192.0.2.1\n' +
      'Arrival-Date: Mon, 1 Jan 2024 00:00:00 +0000\nReported-Domain: b.example\n' +
      'Authentication-Results: x\n';
    const eml =
      'From: a@b\nSubject: x\nDate: Mon, 1 Jan 2024 00:00:00 +0000\n' +
      'Content-Type: multipart/report; boundary=B\n\n' +
      `--B\nContent-Type: message/feedback-report\n\n${report}\n` +
      `--B\nContent-Type: text/rfc822-headers\n\n${sample}\n--B--\n`;
    await expect(
      parseReportEmail(eml, { config: offline({ maxMimeParts: 20 }) }),
    ).rejects.toThrow('more than 20 MIME parts');
  });

  it('counts the parts of a base64 failure sample and of delivery-status blocks', async () => {
    // Shapes the boundary-line count before parsing doesn't see: the
    // sample's parts are only visible once decoded, and each blank line of
    // a delivery-status is a part (500,000 of them took 10.8 s).
    const report =
      'Feedback-Type: auth-failure\nVersion: 1\nSource-IP: 192.0.2.1\n' +
      'Arrival-Date: Mon, 1 Jan 2024 00:00:00 +0000\nReported-Domain: b.example\n';
    const inner = `Content-Type: multipart/mixed; boundary=b\n\n${'--b\nContent-Disposition: attachment; filename=a\n\nx\n'.repeat(10_001)}--b--\n`;
    const sample =
      'From: a@b\nSubject: x\nContent-Type: multipart/report; boundary=B\n\n' +
      `--B\nContent-Type: message/feedback-report\n\n${report}\n` +
      `--B\nContent-Type: text/rfc822-headers\nContent-Transfer-Encoding: base64\n\n${Buffer.from(inner).toString('base64')}\n--B--\n`;
    const blocks = `From: a@b\nSubject: x\nContent-Type: message/delivery-status\n\n${'\n'.repeat(500_000)}`;
    const start = cpuStart();
    for (const eml of [sample, blocks]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await expect(
        parseReportEmail(eml, { config: offline() }),
      ).rejects.toThrow('more than 10000 MIME parts (max_mime_parts)');
    }
    expect(cpuMsSince(start)).toBeLessThan(5000);
  });

  it('bounds the bytes decompressed from all the attachments together', async () => {
    // Each part decompresses within its own cap to nothing recognizable, so
    // the walk went on: 0.6 s per 69 KB part of 50 MiB, minutes per email.
    const gzipPart = (content: Uint8Array): string =>
      `--b\nContent-Type: application/gzip\nContent-Transfer-Encoding: base64\n\n${gzipSync(content).toString('base64')}\n`;
    const multipart = (...parts: string[]): string =>
      `From: a@b.c\nSubject: s\nContent-Type: multipart/mixed; boundary=b\n\n${parts.join('')}--b--\n`;
    const junk = gzipPart(new Uint8Array(30 * 1024 * 1024).fill(0xff));
    const start = cpuStart();
    await expect(
      parseReportEmail(multipart(...Array.from({ length: 20 }, () => junk)), {
        config: offline(),
      }),
    ).rejects.toThrow(
      new EmailTooLargeError(
        'Email attachments decompress to more than 104857600 bytes',
      ),
    );
    expect(cpuMsSince(start)).toBeLessThan(5000);
    // A report after the junk is still found, even past the budget.
    const report = readFileSync(
      path.join(
        SAMPLES_DIR,
        'aggregate',
        '!example.com!1538204542!1538463818.xml',
      ),
    );
    await expect(
      parseReportEmail(multipart(junk, junk, junk, gzipPart(report)), {
        config: offline(),
      }),
    ).resolves.toMatchObject({ reportType: 'aggregate' });
  });

  it('refuses 400,000 tiny MIME parts in linear time', async () => {
    // 12.8 MB, under the size limit: parsing it took 47 s and 928 MB.
    const eml = `From: a@b\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${'--b\r\n\r\nx\r\n'.repeat(400_000)}--b--\r\n`;
    const start = cpuStart();
    const error = await parseReportEmail(eml, { config: offline() }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(EmailTooLargeError);
    expect(cpuMsSince(start)).toBeLessThan(5000);
  });
});

describe('log lines with untrusted values (not in parsedmarc)', () => {
  it('escapes CR/LF in the report ID of a skipped duplicate', async () => {
    const parsed = await parseCase('attachment-gzip-aggregate');
    if (parsed.reportType !== 'aggregate') {
      throw new Error('expected an aggregate report');
    }
    parsed.report.reportMetadata.reportId = 'id\r\nWARNING:tsdmarc:forged';
    const seen = newSeenAggregateReportIds();
    const capture = captureLogs(undefined, DEBUG);
    try {
      for (let index = 0; index < 2; index += 1) {
        classifyParsedEmail(parsed, [], [], [], {
          seenAggregateReportIds: seen,
        });
      }
      expect(capture.output).toEqual([
        'DEBUG:tsdmarc:Skipping duplicate aggregate report from example.com with ID: id\\r\\nWARNING:tsdmarc:forged',
      ]);
    } finally {
      capture.restore();
    }
  });
});
