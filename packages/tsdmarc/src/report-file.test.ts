// Tests for report-file.ts, ported from parsedmarc's tests/test_init.py:
// Test (parse_report_file methods), TestParseReportFile,
// TestGetDmarcReportsFromMbox, TestGetDmarcReportsFromMboxParallel and
// TestCentralizedConfig.

import {
  createReadStream,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseAggregateReportFile,
  parsedAggregateReportsToCsv,
} from './aggregate';
import {
  createParserConfig,
  DEFAULT_PARSER_OPTIONS,
  IP_ADDRESS_CACHE,
  SEEN_AGGREGATE_REPORT_IDS,
} from './config';
import { DEFAULT_DNS_MAX_RETRIES, DEFAULT_DNS_TIMEOUT } from './constants';
import { EmailTooLargeError, InvalidIPinfoAPIKey, ParserError } from './errors';
import { extractReport, MAX_DECOMPRESSED_REPORT_SIZE } from './extract';
import { parsedFailureReportsToCsv } from './failure';
import { excOrigin } from './internal/py';
import { captureLogs, DEBUG, type LogCapture, logger, WARNING } from './log';
import { aggregateReportKey } from './report-email';
import {
  getDmarcReportsFromMbox,
  looksLikeEmail,
  parseReportFile,
} from './report-file';
import { toSnakeCaseKeys } from './serialize';
import { cpuMsSince, cpuStart } from './test/cpu-time';
import { asJson, SAMPLES_DIR, samplePath } from './test/fixtures';
import type { AggregateReport, FailureReport, ParsedReport } from './types';
import { configureIpinfoApi } from './utils/ip-info';
import { MboxReader } from './utils/mbox';

interface MboxCase {
  data: string;
  messages: { string?: string; error?: { type: string; message: string } }[];
}

interface Cases {
  mbox: Record<string, MboxCase>;
  mbox_reports: { mbox: string; result: unknown };
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

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-report-file-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function files(relative: string): string[] {
  const base = path.join(SAMPLES_DIR, relative);
  return readdirSync(base)
    .map(name => path.join(base, name))
    .filter(file => statSync(file).isFile());
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe('Test (parse_report_file)', () => {
  it('testParseReportFileAcceptsPathForXML', async () => {
    const result = await parseReportFile(
      pathToFileURL(
        samplePath(
          'aggregate/protection.outlook.com!example.com!1711756800!1711843200.xml',
        ),
      ),
      { offline: true },
    );
    expect(result.reportType).toBe('aggregate');
    expect((result.report as AggregateReport).reportMetadata.orgName).toBe(
      'outlook.com',
    );
  });

  it('testParseReportFileAcceptsPathForEmail', async () => {
    const result = await parseReportFile(
      pathToFileURL(
        samplePath(
          'aggregate/Report domain- borschow.com Submitter- google.com Report-ID- 949348866075514174.eml',
        ),
      ),
      { offline: true },
    );
    expect(result.reportType).toBe('aggregate');
    expect((result.report as AggregateReport).reportMetadata.orgName).toBe(
      'google.com',
    );
  });

  it('testAggregateSamples', async () => {
    for (const sample of files('aggregate')) {
      const result = await parseReportFile(sample, OFFLINE);
      expect(result.reportType, sample).toBe('aggregate');
      parsedAggregateReportsToCsv(result.report as AggregateReport);
    }
  });

  it('testEmptySample', async () => {
    expect(
      await errorOf(
        parseReportFile(samplePath('empty.xml'), { offline: true }),
      ),
    ).toBeInstanceOf(ParserError);
  });

  it('testFailureSampleWithoutFeedbackReportPart', async () => {
    const result = await parseReportFile(
      samplePath('failure/exim_plain_text_only_no_arf_part.eml'),
      {
        offline: true,
      },
    );
    expect(result.reportType).toBe('failure');
    const report = result.report as FailureReport;
    expect(report.feedbackType).toBe('auth-failure');
    expect(Object.hasOwn(report, 'authenticationResults')).toBe(true);
    expect(report.source.ipAddress).toBe('203.0.113.68');
  });

  it('testFailureReportFieldsHaveNoTrailingCarriageReturn', async () => {
    const result = await parseReportFile(
      samplePath('failure/[Netease DMARC Failure Report] Rent Reminder.eml'),
      {
        offline: true,
      },
    );
    expect(result.reportType).toBe('failure');
    const report = result.report as FailureReport;
    expect(report.feedbackType).toBe('auth-failure');
    expect(report.userAgent).toBe('NtesDmarcReporter/1.0');
    expect(report.version).toBe('1');
    expect(report.arrivalDate).toBe('Fri, 28 Sep 2018 16:48:42 +0800');
    expect(report.reportedDomain).toBe('cardinal.com');
    for (const [key, value] of Object.entries(report)) {
      if (key !== 'sample' && typeof value === 'string') {
        expect(value, `carriage return in ${key}`).not.toContain('\r');
      }
    }
    parsedFailureReportsToCsv(report);
  });

  it('testParseInvalidAggregateSample', async () => {
    for (const sample of files('aggregate_invalid')) {
      const result = await parseReportFile(sample, OFFLINE);
      parsedAggregateReportsToCsv(result.report as AggregateReport);
    }
  });

  it('testParseReportFileWithBytes', async () => {
    const data = readFileSync(samplePath('aggregate/rfc9990-sample.xml'));
    const result = await parseReportFile(data, OFFLINE);
    expect(result.reportType).toBe('aggregate');
  });

  it('testMagicXmlTagDetection', () => {
    const xml = new TextEncoder().encode(
      '<feedback><report_metadata><org_name>T</org_name><email>a@b.com</email><report_id>r1</report_id><date_range><begin>1704067200</begin><end>1704153599</end></date_range></report_metadata><policy_published><domain>example.com</domain><p>none</p></policy_published></feedback>',
    );
    expect(xml[0]).toBe(0x3c);
    expect(extractReport(xml)).toContain('<feedback>');
  });
});

describe('TestParseReportFile', () => {
  const XML_SAMPLE = samplePath(
    'aggregate/!example.com!1538204542!1538463818.xml',
  );

  it('testParseReportFileFromBytes', async () => {
    const result = await parseReportFile(readFileSync(XML_SAMPLE), {
      offline: true,
    });
    expect(result.reportType).toBe('aggregate');
  });

  it('testParseReportFileFromArrayBuffer', async () => {
    const data = readFileSync(XML_SAMPLE);
    const buffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    );
    expect((await parseReportFile(buffer, { offline: true })).reportType).toBe(
      'aggregate',
    );
  });

  it('testParseReportFileFromBinaryIO', async () => {
    const result = await parseReportFile(createReadStream(XML_SAMPLE), {
      offline: true,
    });
    expect(result.reportType).toBe('aggregate');
  });

  it('testParseReportFileFromWebStream', async () => {
    const data = readFileSync(XML_SAMPLE);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(data));
        controller.close();
      },
    });
    expect((await parseReportFile(stream, { offline: true })).reportType).toBe(
      'aggregate',
    );
  });

  it('testParseReportFileFromPathlib', async () => {
    const result = await parseReportFile(pathToFileURL(XML_SAMPLE), {
      offline: true,
    });
    expect(result.reportType).toBe('aggregate');
  });

  it('testParseReportFileSmtpTls', async () => {
    const result = await parseReportFile(samplePath('smtp_tls/smtp_tls.json'), {
      offline: true,
    });
    expect(result.reportType).toBe('smtp_tls');
  });

  it('testParseReportFileEmail', async () => {
    const result = await parseReportFile(
      samplePath('failure/dmarc_ruf_report_linkedin.eml'),
      { offline: true },
    );
    expect(result.reportType).toBe('failure');
  });

  it('testParseReportFileInvalid', async () => {
    const error = await errorOf(
      parseReportFile(new TextEncoder().encode('this is not a report'), {
        offline: true,
      }),
    );
    expect(error).toBeInstanceOf(ParserError);
  });

  it('testParseReportFileInvalidAggregateReason', async () => {
    const xml =
      '<?xml version="1.0"?>\n<feedback>\n' +
      '<report_metadata><email>dmarc@example.com</email>' +
      '<report_id>no-org</report_id></report_metadata>\n' +
      '<policy_published><domain>example.com</domain><p>none</p>' +
      '</policy_published>\n</feedback>';
    const error = await errorOf(
      parseReportFile(new TextEncoder().encode(xml), { offline: true }),
    );
    expect(error).toBeInstanceOf(ParserError);
    expect(error.message.toLowerCase()).toContain('aggregate');
    expect(error.message).toContain('org_name');
    expect(error.message).not.toContain('Not a valid report');
  });

  it('testParseReportFileInvalidSmtpTlsReason', async () => {
    const error = await errorOf(
      parseReportFile(new TextEncoder().encode('{"organization-name": "x"}'), {
        offline: true,
      }),
    );
    expect(error.message).toContain('SMTP TLS');
    expect(error.message).toContain('date-range');
  });

  it('testParseReportFileInvalidFailureReason', async () => {
    const eml =
      'From: dmarc-noreply@example.com\nSubject: DMARC Failure Report\nMIME-Version: 1.0\n' +
      'Content-Type: multipart/report; report-type=feedback-report; boundary="b"\n\n' +
      '--b\nContent-Type: text/plain\n\nThis is a DMARC failure report.\n' +
      '--b\nContent-Type: message/feedback-report\n\nFeedback-Type: auth-failure\nVersion: 1\n' +
      '--b\nContent-Type: message/rfc822\n\nFrom: spoof@victim.example\nSubject: hi\n--b--\n';
    const error = await errorOf(
      parseReportFile(new TextEncoder().encode(eml), { offline: true }),
    );
    expect(error).toBeInstanceOf(ParserError);
    expect(error.message.toLowerCase()).toContain('failure');
    expect(error.message).toContain('source_ip');
    expect(error.message).not.toContain('Not a valid report');
  });

  it('testParseReportFileUnrecognizedGzip', async () => {
    const blob = gzipSync(Buffer.from('plain junk not a report'));
    const error = await errorOf(parseReportFile(blob, { offline: true }));
    expect(error).toBeInstanceOf(ParserError);
    expect(error.message).toContain('recognized report format');
  });

  it('testParseReportFileUnrecognizedFormat', async () => {
    const error = await errorOf(
      parseReportFile(new TextEncoder().encode('this is not a report'), {
        offline: true,
      }),
    );
    expect(error.message).toContain('recognized report format');
  });

  it('testParseReportFilePreservesCause', async () => {
    const error = await errorOf(
      parseReportFile(new TextEncoder().encode('<feedback></feedback>'), {
        offline: true,
      }),
    );
    expect(error).toBeInstanceOf(ParserError);
    expect(error.cause).toBeInstanceOf(Error);
  });

  describe('unexpected error origin', () => {
    let savedLevel: number;
    beforeEach(() => {
      savedLevel = logger.level;
    });
    afterEach(() => {
      logger.setLevel(savedLevel);
    });

    const parseUnexpectedError = async (): Promise<string> =>
      (
        await errorOf(
          parseReportFile(new TextEncoder().encode('<feedback></feedback>'), {
            offline: true,
          }),
        )
      ).message;

    it('testUnexpectedErrorOmitsOriginWhenNotDebug', async () => {
      logger.setLevel(WARNING);
      const message = await parseUnexpectedError();
      expect(message).toContain('Unexpected error');
      expect(message).not.toContain('raised at');
    });

    it('testUnexpectedErrorCitesOriginInDebug', async () => {
      logger.setLevel(DEBUG);
      const message = await parseUnexpectedError();
      expect(message).toContain('raised at');
      expect(message).toMatch(/\.ts:\d+/u);
    });

    it('testExcOriginEmptyWhenNoTraceback', () => {
      // A never-raised Python exception has no __traceback__; the JS
      // equivalent is an error without a stack (or a non-Error value).
      logger.setLevel(DEBUG);
      const error = new Error('x');
      error.stack = undefined;
      expect(excOrigin(error)).toBe('');
      expect(excOrigin('x')).toBe('');
    });
  });

  it('testParseReportFileClosesHandleOnReadError', async () => {
    // A path is read with readFile(), which closes its own handle; a read
    // error (here, a directory) propagates as the OS error.
    const error = await errorOf(parseReportFile(directory, { offline: true }));
    expect((error as NodeJS.ErrnoException).code).toBe('EISDIR');
  });

  it('testParseReportFileLeavesCallerHandleOpenOnReadError', async () => {
    let closeCalled = false;
    const stream: AsyncIterable<Uint8Array> & { close: () => void } = {
      close: () => {
        closeCalled = true;
      },
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<Uint8Array>> =>
          Promise.reject(new Error('boom')),
      }),
    };
    expect(
      (await errorOf(parseReportFile(stream, { offline: true }))).message,
    ).toBe('boom');
    expect(closeCalled).toBe(false);
  });

  it('testParseReportFileLeavesCallerHandleOpenOnSuccess', async () => {
    const data = new Uint8Array(readFileSync(XML_SAMPLE));
    let closeCalled = false;
    const stream: AsyncIterable<Uint8Array> & { close: () => void } = {
      close: () => {
        closeCalled = true;
      },
      async *[Symbol.asyncIterator]() {
        yield data.subarray(0, 100);
        yield data.subarray(100);
      },
    };
    const result = await parseReportFile(stream, { offline: true });
    expect(result.reportType).toBe('aggregate');
    expect(closeCalled).toBe(false);
  });

  it('rejects a stream yielding text, like a text-mode file', async () => {
    async function* text(): AsyncGenerator<string> {
      yield '<feedback/>';
    }
    const error = await errorOf(
      parseReportFile(text() as unknown as AsyncIterable<Uint8Array>, {
        offline: true,
      }),
    );
    expect(error).toBeInstanceOf(TypeError);
  });

  it('logs the path it parses at DEBUG', async () => {
    const capture = captureLogs(undefined, DEBUG);
    try {
      await parseReportFile(XML_SAMPLE, { offline: true });
      expect(capture.output).toContain(`DEBUG:tsdmarc:Parsing ${XML_SAMPLE}`);
    } finally {
      capture.restore();
    }
  });
});

describe('looksLikeEmail', () => {
  it('accepts a header line or an mbox From line', () => {
    expect(looksLikeEmail('Subject: x\nbody')).toBe(true);
    expect(
      looksLikeEmail('From someone@example.com Thu Jan  1 00:00:00 2024'),
    ).toBe(true);
    expect(looksLikeEmail('X-Header:value')).toBe(true);
    expect(looksLikeEmail('not a header\nSubject: x')).toBe(false);
    expect(looksLikeEmail(': empty name')).toBe(false);
    expect(looksLikeEmail('na me: x')).toBe(false);
  });

  it('runs in linear time on a long header-name run', () => {
    const start = cpuStart();
    expect(looksLikeEmail('a'.repeat(1_000_000))).toBe(false);
    expect(cpuMsSince(start)).toBeLessThan(5000);
  });
});

describe('MboxReader matches Python mailbox.mbox', () => {
  for (const [name, testCase] of Object.entries(CASES.mbox)) {
    it(name, async () => {
      const mboxPath = path.join(directory, `${name}.mbox`);
      writeFileSync(mboxPath, Buffer.from(testCase.data, 'base64'));
      const mbox = await MboxReader.open(mboxPath);
      try {
        expect(mbox.keys()).toHaveLength(testCase.messages.length);
        for (const [key, expected] of testCase.messages.entries()) {
          if (expected.error) {
            const error = await errorOf(mbox.getString(key));
            expect(error.name).toBe(expected.error.type);
            expect(error.message).toBe(expected.error.message);
          } else {
            expect(await mbox.getString(key)).toBe(expected.string);
          }
        }
      } finally {
        await mbox.close();
      }
    });
  }

  it('creates a missing mbox file, like mailbox.mbox(create=True)', async () => {
    const mboxPath = path.join(directory, 'new.mbox');
    const mbox = await MboxReader.open(mboxPath);
    await mbox.close();
    expect(statSync(mboxPath).size).toBe(0);
  });
});

function writeMbox(name: string, data: string | Uint8Array): string {
  const mboxPath = path.join(directory, name);
  writeFileSync(mboxPath, data);
  return mboxPath;
}

/** The mbox parsedmarc's TestGetDmarcReportsFromMboxParallel builds. */
function reportsMbox(): string {
  return writeMbox(
    'reports.mbox',
    Buffer.from(CASES.mbox_reports.mbox, 'base64'),
  );
}

describe('TestGetDmarcReportsFromMbox', () => {
  it('testEmptyMbox', async () => {
    const results = await getDmarcReportsFromMbox(writeMbox('empty.mbox', ''), {
      offline: true,
    });
    expect(results).toEqual({
      aggregateReports: [],
      failureReports: [],
      smtpTlsReports: [],
    });
  });

  it('testMboxWithAggregateReport', async () => {
    SEEN_AGGREGATE_REPORT_IDS.clear();
    const twilight = readFileSync(
      samplePath('aggregate/twilight.eml'),
      'utf-8',
    );
    const mboxPath = writeMbox(
      'aggregate.mbox',
      `From dmarc@example.com Thu Jan  1 00:00:00 2024\n${twilight.replaceAll(/^From /gmu, '>From ')}\n`,
    );
    const results = await getDmarcReportsFromMbox(mboxPath, { offline: true });
    expect(results.aggregateReports.length).toBeGreaterThanOrEqual(1);
  });
});

describe('an enrichment failure in an mbox (not in parsedmarc)', () => {
  it('ends the run instead of skipping every message', async () => {
    // A token revoked mid-run fails every message the same way: skipping
    // them would end the run with no reports and no error.
    const twilight = readFileSync(
      samplePath('aggregate/twilight.eml'),
      'utf-8',
    ).replaceAll(/^From /gmu, '>From ');
    const mboxPath = writeMbox(
      'revoked.mbox',
      `From x Thu Jan  1 00:00:00 2024\n${twilight}\n`,
    );
    await configureIpinfoApi('revoked', { probe: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    );
    try {
      await expect(
        // Fresh caches: an IP cached by an earlier test needs no lookup.
        getDmarcReportsFromMbox(mboxPath, {
          config: createParserConfig({ offline: true }),
        }),
      ).rejects.toBeInstanceOf(InvalidIPinfoAPIKey);
    } finally {
      vi.unstubAllGlobals();
      await configureIpinfoApi(null);
    }
  });
});

describe('TestGetDmarcReportsFromMboxParallel', () => {
  let capture: LogCapture | null = null;
  beforeEach(() => {
    SEEN_AGGREGATE_REPORT_IDS.clear();
    IP_ADDRESS_CACHE.clear();
  });
  afterEach(() => {
    capture?.restore();
    capture = null;
    SEEN_AGGREGATE_REPORT_IDS.clear();
  });

  const aggregateReportIds = (results: {
    aggregateReports: AggregateReport[];
  }): Set<string> =>
    new Set(
      results.aggregateReports.map(report => report.reportMetadata.reportId),
    );

  it('test_parallel_matches_sequential', async () => {
    const mboxPath = reportsMbox();

    capture = captureLogs(undefined, WARNING);
    const sequential = await getDmarcReportsFromMbox(mboxPath, {
      offline: true,
      nProcs: 1,
    });
    const sequentialLogs = capture.output;
    capture.restore();

    SEEN_AGGREGATE_REPORT_IDS.clear();
    capture = captureLogs(undefined, WARNING);
    const parallel = await getDmarcReportsFromMbox(mboxPath, {
      offline: true,
      nProcs: 2,
    });
    const parallelLogs = capture.output;

    expect(sequential.aggregateReports).toHaveLength(1);
    expect(parallel.aggregateReports).toHaveLength(1);
    expect(aggregateReportIds(sequential)).toEqual(
      aggregateReportIds(parallel),
    );
    expect(sequential.failureReports).toHaveLength(1);
    expect(parallel.failureReports).toHaveLength(1);
    expect(sequential.smtpTlsReports).toHaveLength(1);
    expect(parallel.smtpTlsReports).toHaveLength(1);
    expect(
      sequentialLogs.some(line => line.includes('not a valid report')),
    ).toBe(true);
    expect(parallelLogs.some(line => line.includes('not a valid report'))).toBe(
      true,
    );
    expect(parallel).toEqual(sequential);
  });

  it('matches parsedmarc on the same mbox', async () => {
    const results = await getDmarcReportsFromMbox(reportsMbox(), {
      config: createParserConfig(OFFLINE),
    });
    expect(asJson(toSnakeCaseKeys(results))).toEqual(CASES.mbox_reports.result);
  });

  it('logs progress per message', async () => {
    capture = captureLogs(undefined, DEBUG);
    await getDmarcReportsFromMbox(reportsMbox(), {
      config: createParserConfig(OFFLINE),
    });
    expect(capture.output).toContain('INFO:tsdmarc:Processing message 1 of 5');
    expect(capture.output).toContain('INFO:tsdmarc:Processing message 5 of 5');
    expect(
      capture.output.some(line =>
        line.startsWith('DEBUG:tsdmarc:Found 5 messages in '),
      ),
    ).toBe(true);
  });

  it('skips a message with a bare ParserError, unlike parsedmarc', async () => {
    // A message whose Date header can't be parsed is a bare ParserError,
    // which parsedmarc lets abort the whole mbox, losing the other reports.
    const twilight = readFileSync(
      samplePath('aggregate/twilight.eml'),
      'utf-8',
    ).replaceAll(/^From /gmu, '>From ');
    const mboxPath = writeMbox(
      'bad-date.mbox',
      'From x Thu Jan  1 00:00:00 2024\nFrom: a@b.c\nDate: not-a-real-date\nSubject: x\n\nbody\n\n' +
        `From y Thu Jan  1 00:00:00 2024\n${twilight}\n`,
    );
    for (const nProcs of [1, 2]) {
      capture = captureLogs();
      const results = await getDmarcReportsFromMbox(mboxPath, {
        config: createParserConfig(OFFLINE),
        nProcs,
      });
      expect(results.aggregateReports).toHaveLength(1);
      expect(capture.output).toContainEqual(
        expect.stringMatching(
          /^WARNING:tsdmarc:Skipping message 1: ParserError: .*not-a-real-date/u,
        ),
      );
    }
  });

  it('skips a message whose attachment is invalid, unlike parsedmarc', async () => {
    const twilight = readFileSync(
      samplePath('aggregate/twilight.eml'),
      'utf-8',
    ).replaceAll(/^From /gmu, '>From ');
    const invalidXml = Buffer.from('<foo/>').toString('base64');
    const invalidJson = Buffer.from('{"a": 1}').toString('base64');
    const attachment = (type: string, body: string): string =>
      `From: a@b.c\nDate: Mon, 1 Jan 2024 00:00:00 +0000\nSubject: x\nContent-Type: ${type}\nContent-Transfer-Encoding: base64\n\n${body}\n\n`;
    const mboxPath = writeMbox(
      'bad-attachment.mbox',
      `From x Thu Jan  1 00:00:00 2024\n${attachment('application/xml', invalidXml)}` +
        `From y Thu Jan  1 00:00:00 2024\n${attachment('application/tlsrpt+json', invalidJson)}` +
        `From z Thu Jan  1 00:00:00 2024\n${twilight}\n`,
    );
    for (const nProcs of [1, 2]) {
      const results = await getDmarcReportsFromMbox(mboxPath, {
        config: createParserConfig(OFFLINE),
        nProcs,
      });
      expect(results.aggregateReports).toHaveLength(1);
    }
  });

  it('testPoisonMessageRaisesParserError', async () => {
    // GHSA-qxwv-2vwj-v828: each message's stored bytes reach the parser (no
    // re-serialization while reading the mbox), whose ParserError names the
    // message; the mbox loop logs it and goes on, unlike parsedmarc.
    const twilight = readFileSync(
      samplePath('aggregate/twilight.eml'),
      'utf-8',
    ).replaceAll(/^From /gmu, '>From ');
    let nested = 'Subject: s\n';
    for (let index = 0; index < 400; index += 1) {
      nested += `Content-Type: multipart/mixed; boundary=b${index}\n\n--b${index}\n`;
    }
    nested += 'Content-Type: text/plain\n\nx\n';
    for (let index = 399; index >= 0; index -= 1) {
      nested += `--b${index}--\n`;
    }
    const header =
      'From: a@example.com\nSubject: x\nDate: Mon, 1 Jan 2024 00:00:00 +0000\n' +
      'MIME-Version: 1.0\n' +
      'Content-Type: multipart/report; report-type=feedback-report; boundary=B\n\n' +
      '--B\nContent-Type: text/plain\n\nhi\n' +
      '--B\nContent-Type: message/feedback-report\n\n' +
      'Feedback-Type: auth-failure\nVersion: 1\nSource-IP: 192.0.2.1\n' +
      'Arrival-Date: Mon, 1 Jan 2024 00:00:00 +0000\nReported-Domain: example.com\n' +
      'Authentication-Results: x\n\n' +
      '--B\nContent-Type: message/rfc822\n\nFrom: a@b\nX-A: a\u001Cb\n\nbody\n--B--\n';
    for (const [name, poison, cause] of [
      ['header', header, 'folded header contains newline'],
      ['nested', nested, 'maximum recursion depth'],
    ] as const) {
      const mboxPath = writeMbox(
        `poison-${name}.mbox`,
        `From x Thu Jan  1 00:00:00 2024\n${poison}\n` +
          `From y Thu Jan  1 00:00:00 2024\n${twilight}\n`,
      );
      for (const nProcs of [1, 2]) {
        capture = captureLogs();
        const results = await getDmarcReportsFromMbox(mboxPath, {
          config: createParserConfig(OFFLINE),
          nProcs,
        });
        expect(results.aggregateReports).toHaveLength(1);
        const warning = capture.output.find(line =>
          line.startsWith('WARNING:tsdmarc:Skipping message 1: ParserError: '),
        );
        expect(warning).toContain('Unable to parse message');
        expect(warning).toContain(cause);
      }
    }
  });

  it('skips messages over maxEmailSize without parsing them', async () => {
    const mboxPath = writeMbox(
      'big.mbox',
      `From x Thu Jan  1 00:00:00 2024\nSubject: big\n\n${'a'.repeat(5000)}\n`,
    );
    capture = captureLogs();
    const results = await getDmarcReportsFromMbox(mboxPath, {
      config: createParserConfig({ ...OFFLINE, maxEmailSize: 1000 }),
    });
    expect(results.aggregateReports).toHaveLength(0);
    expect(capture.output).toContainEqual(
      expect.stringMatching(
        /^WARNING:tsdmarc:Skipping message 1: EmailTooLargeError: Email of \d+ bytes exceeds the 1000 byte size limit/u,
      ),
    );
  });
});

describe('TestCentralizedConfig', () => {
  const AGGREGATE = samplePath('aggregate/twilight.eml');

  function singleAggregateMbox(): string {
    const content = readFileSync(AGGREGATE, 'utf-8').replaceAll(
      /^From /gmu,
      '>From ',
    );
    return writeMbox(
      'single.mbox',
      `From MAILER-DAEMON Thu Jan  1 00:00:00 2024\n${content}\n`,
    );
  }

  afterEach(() => {
    SEEN_AGGREGATE_REPORT_IDS.clear();
  });

  it('test_kwargs_path_uses_module_default_caches_not_fresh_ones', async () => {
    SEEN_AGGREGATE_REPORT_IDS.clear();
    const mboxPath = singleAggregateMbox();
    const first = await getDmarcReportsFromMbox(mboxPath, { offline: true });
    const second = await getDmarcReportsFromMbox(mboxPath, { offline: true });
    expect(first.aggregateReports).toHaveLength(1);
    expect(second.aggregateReports).toHaveLength(0);
    const report = first.aggregateReports[0] as AggregateReport;
    expect(SEEN_AGGREGATE_REPORT_IDS.has(aggregateReportKey(report))).toBe(
      true,
    );
  });

  it('test_kwargs_and_config_equivalence', async () => {
    for (const sample of [
      'aggregate/rfc9990-sample.xml',
      'failure/dmarc_ruf_report_linkedin.eml',
      'smtp_tls/google.com_smtp_tls_report.eml',
    ]) {
      const kwargsResult = await parseReportFile(samplePath(sample), OFFLINE);
      const configResult = await parseReportFile(samplePath(sample), {
        config: createParserConfig(OFFLINE),
      });
      expect(configResult, sample).toEqual(kwargsResult);
    }
  });

  it('test_config_wins_over_kwargs_normalize_threshold', async () => {
    const data = readFileSync(
      samplePath('aggregate/ikea.com!example.de!1538690400!1538776800.xml'),
    );
    let report = await parseAggregateReportFile(data, {
      offline: true,
      config: createParserConfig({
        offline: true,
        normalizeTimespanThresholdHours: 1000,
      }),
      normalizeTimespanThresholdHours: 1,
    });
    for (const record of report.records) {
      expect(record.normalizedTimespan).toBe(false);
    }
    report = await parseAggregateReportFile(data, {
      offline: true,
      config: createParserConfig({
        offline: true,
        normalizeTimespanThresholdHours: 1,
      }),
      normalizeTimespanThresholdHours: 1000,
    });
    for (const record of report.records) {
      expect(record.normalizedTimespan).toBe(true);
    }
  });

  it('config wins over options in parseReportFile and getDmarcReportsFromMbox', async () => {
    const sample = samplePath(
      'aggregate/ikea.com!example.de!1538690400!1538776800.xml',
    );
    const result = (await parseReportFile(sample, {
      config: createParserConfig({
        offline: true,
        normalizeTimespanThresholdHours: 1,
      }),
      normalizeTimespanThresholdHours: 1000,
    })) as ParsedReport & { report: AggregateReport };
    expect(
      result.report.records.every(record => record.normalizedTimespan),
    ).toBe(true);

    const config = createParserConfig({ offline: true });
    const mboxPath = singleAggregateMbox();
    await getDmarcReportsFromMbox(mboxPath, { config, offline: false });
    expect(config.seenAggregateReportIds.size).toBe(1);
    expect(SEEN_AGGREGATE_REPORT_IDS.size).toBe(0);
  });

  it('test_separate_configs_isolate_dedup_state', async () => {
    const mboxPath = singleAggregateMbox();
    const configA = createParserConfig({ offline: true });
    const configB = createParserConfig({ offline: true });
    expect(
      (await getDmarcReportsFromMbox(mboxPath, { config: configA }))
        .aggregateReports,
    ).toHaveLength(1);
    expect(
      (await getDmarcReportsFromMbox(mboxPath, { config: configB }))
        .aggregateReports,
    ).toHaveLength(1);

    const configC = createParserConfig({ offline: true });
    expect(
      (await getDmarcReportsFromMbox(mboxPath, { config: configC }))
        .aggregateReports,
    ).toHaveLength(1);
    expect(
      (await getDmarcReportsFromMbox(mboxPath, { config: configC }))
        .aggregateReports,
    ).toHaveLength(0);
  });

  it('test_dns_and_normalize_defaults_match_constants_and_parser_config', () => {
    // TypeScript has no runtime signature defaults to inspect: every public
    // function resolves omitted options through resolveParserConfig(), whose
    // defaults are DEFAULT_PARSER_OPTIONS.
    expect(DEFAULT_PARSER_OPTIONS.dnsTimeout).toBe(DEFAULT_DNS_TIMEOUT);
    expect(DEFAULT_PARSER_OPTIONS.dnsRetries).toBe(DEFAULT_DNS_MAX_RETRIES);
    expect(DEFAULT_PARSER_OPTIONS.normalizeTimespanThresholdHours).toBe(24);
    const config = createParserConfig();
    expect(config.dnsTimeout).toBe(DEFAULT_DNS_TIMEOUT);
    expect(config.dnsRetries).toBe(DEFAULT_DNS_MAX_RETRIES);
    expect(config.normalizeTimespanThresholdHours).toBe(24);
  });
});

describe('report file size limit (not in parsedmarc)', () => {
  it('refuses a file over the limit without reading it', async () => {
    // A sparse file: its size is all that's checked.
    const filePath = path.join(directory, 'huge.eml');
    writeFileSync(filePath, '');
    truncateSync(filePath, MAX_DECOMPRESSED_REPORT_SIZE + 1);
    const error = await errorOf(
      parseReportFile(filePath, { config: createParserConfig(OFFLINE) }),
    );
    expect(error).toBeInstanceOf(EmailTooLargeError);
    expect(error.message).toBe(
      `File of ${MAX_DECOMPRESSED_REPORT_SIZE + 1} bytes exceeds the ${MAX_DECOMPRESSED_REPORT_SIZE} byte size limit (max_email_size)`,
    );
  });

  it('refuses a stream over the limit once it has read that much', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let read = 0;
    const stream = new Readable({
      read() {
        read += 1;
        this.push(read > 200 ? null : chunk);
      },
    });
    const error = await errorOf(
      parseReportFile(stream, { config: createParserConfig(OFFLINE) }),
    );
    expect(error).toBeInstanceOf(EmailTooLargeError);
    expect(error.message).toBe(
      `Stream of more than ${MAX_DECOMPRESSED_REPORT_SIZE} bytes exceeds the byte size limit (max_email_size)`,
    );
    expect(read).toBeLessThan(150);
    // The caller's stream is left for the caller to close.
    expect(stream.destroyed).toBe(false);
    stream.destroy();
  });

  it('reads a stream up to the limit, and any without a limit', async () => {
    const xml = readFileSync(
      samplePath('aggregate/!example.com!1538204542!1538463818.xml'),
    );
    const padded = async function* (): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(xml);
      yield new Uint8Array(MAX_DECOMPRESSED_REPORT_SIZE - xml.length).fill(
        0x0a,
      );
    };
    expect(
      await parseReportFile(padded(), { config: createParserConfig(OFFLINE) }),
    ).toMatchObject({ reportType: 'aggregate' });
    const beyond = async function* (): AsyncGenerator<Uint8Array> {
      yield* padded();
      yield new Uint8Array(1).fill(0x0a);
    };
    expect(
      await parseReportFile(beyond(), {
        config: createParserConfig({ ...OFFLINE, maxEmailSize: 0 }),
      }),
    ).toMatchObject({ reportType: 'aggregate' });
  });

  it('still parses report emails as files, where the email limit applies', async () => {
    const eml = readFileSync(samplePath('aggregate/twilight.eml'));
    const filePath = path.join(directory, 'twilight.eml');
    writeFileSync(filePath, eml);
    const error = await errorOf(
      parseReportFile(filePath, {
        config: createParserConfig({ ...OFFLINE, maxEmailSize: 100 }),
      }),
    );
    expect(error).toBeInstanceOf(EmailTooLargeError);
    expect(error.message).toMatch(/^Email of \d+ bytes exceeds the 100 byte/u);
  });
});

/**
 * parsedmarc's `_domain_scope_aggregate_xml()` and `_domain_scope_email()`:
 * a gzipped aggregate report email whose only record's count tells which
 * document a batch kept. `null` emits an empty policy domain.
 */
function domainScopeEmail(
  policyDomain: string | null,
  recordCount: number,
  { reporter = 'reporter.example', reportId = 'shared-report-id' } = {},
): string {
  const recordDomain = policyDomain ?? 'a.example';
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<feedback><report_metadata>' +
    `<org_name>${reporter}</org_name><email>dmarc@reporter.example</email>` +
    `<report_id>${reportId}</report_id>` +
    '<date_range><begin>1680000000</begin><end>1680086400</end></date_range>' +
    '</report_metadata><policy_published>' +
    `<domain>${policyDomain ?? ''}</domain><p>none</p></policy_published>` +
    `<record><row><source_ip>192.0.2.1</source_ip><count>${recordCount}</count>` +
    '<policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>' +
    `<identifiers><header_from>${recordDomain}</header_from></identifiers>` +
    `<auth_results><spf><domain>${recordDomain}</domain><result>pass</result></spf></auth_results>` +
    '</record></feedback>';
  return [
    'From: dmarc@reporter.example',
    'To: dmarc@receiver.example',
    `Subject: Report domain: ${String(policyDomain)}`,
    'Date: Mon, 1 Jan 2024 00:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: application/gzip',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="report.xml.gz"',
    '',
    gzipSync(xml).toString('base64'),
    '--b--',
    '',
  ].join('\n');
}

// parsedmarc's TestAggregateReportIdentityIsDomainScoped: RFC 9990
// section 3.5.1 makes a Report-ID unique only among reports to the same
// domain, so the dedup key includes the policy domain.
describe('TestAggregateReportIdentityIsDomainScoped', () => {
  let mboxes = 0;
  function mbox(messages: string[]): string {
    mboxes += 1;
    return writeMbox(
      `domain-scope-${mboxes}.mbox`,
      messages
        .map(
          message =>
            `From MAILER-DAEMON Thu Jan  1 00:00:00 2024\n${message}\n`,
        )
        .join(''),
    );
  }
  const parse = (
    mboxPath: string,
    nProcs = 1,
    config = createParserConfig(OFFLINE),
  ): ReturnType<typeof getDmarcReportsFromMbox> =>
    getDmarcReportsFromMbox(mboxPath, { config, nProcs });
  const domains = (result: {
    aggregateReports: AggregateReport[];
  }): unknown[] =>
    result.aggregateReports.map(report => report.policyPublished.domain);
  const counts = (result: { aggregateReports: AggregateReport[] }): number[] =>
    result.aggregateReports.map(report =>
      report.records.reduce((sum, record) => sum + Number(record.count), 0),
    );

  it('test_same_report_id_for_different_domains_keeps_both_reports', async () => {
    const result = await parse(
      mbox([
        domainScopeEmail('a.example', 3),
        domainScopeEmail('b.example', 5),
      ]),
    );
    expect(domains(result)).toEqual(['a.example', 'b.example']);
    expect(counts(result)).toEqual([3, 5]);
  });

  it('test_different_domains_are_kept_in_either_delivery_order', async () => {
    const result = await parse(
      mbox([
        domainScopeEmail('b.example', 5),
        domainScopeEmail('a.example', 3),
      ]),
    );
    expect(domains(result)).toEqual(['b.example', 'a.example']);
    expect(counts(result)).toEqual([5, 3]);
  });

  it('test_same_domain_duplicate_report_is_still_suppressed', async () => {
    const result = await parse(
      mbox([
        domainScopeEmail('a.example', 3),
        domainScopeEmail('a.example', 3),
      ]),
    );
    expect(domains(result)).toEqual(['a.example']);
    expect(counts(result)).toEqual([3]);
  });

  it('test_dedup_is_per_domain_within_one_batch', async () => {
    const result = await parse(
      mbox([
        domainScopeEmail('a.example', 1),
        domainScopeEmail('a.example', 2),
        domainScopeEmail('b.example', 3),
      ]),
    );
    expect(domains(result)).toEqual(['a.example', 'b.example']);
    expect(counts(result)).toEqual([1, 3]);
  });

  it('test_domain_ascii_case_does_not_disable_duplicate_suppression', async () => {
    const result = await parse(
      mbox([
        domainScopeEmail('A.Example', 3),
        domainScopeEmail('a.example', 5),
        domainScopeEmail('b.example', 7),
      ]),
    );
    expect(domains(result)).toEqual(['A.Example', 'b.example']);
    expect(counts(result)).toEqual([3, 7]);
  });

  it('test_empty_policy_domain_keeps_existing_parser_behavior', async () => {
    const result = await parse(
      mbox([
        domainScopeEmail(null, 3),
        domainScopeEmail(null, 5),
        domainScopeEmail('b.example', 7),
      ]),
    );
    expect(domains(result)).toEqual([null, 'b.example']);
    expect(counts(result)).toEqual([3, 7]);
  });

  it('test_parallel_mbox_keeps_both_domains_and_suppresses_duplicates', async () => {
    const result = await parse(
      mbox([
        domainScopeEmail('a.example', 3),
        domainScopeEmail('a.example', 5),
        domainScopeEmail('b.example', 7),
      ]),
      2,
    );
    expect(domains(result)).toEqual(['a.example', 'b.example']);
    expect(counts(result)).toEqual([3, 7]);
  });

  it('test_one_config_keeps_each_domain_and_still_suppresses_repeats', async () => {
    const config = createParserConfig(OFFLINE);
    const first = await parse(
      mbox([domainScopeEmail('a.example', 3)]),
      1,
      config,
    );
    const second = await parse(
      mbox([domainScopeEmail('b.example', 5)]),
      1,
      config,
    );
    const third = await parse(
      mbox([domainScopeEmail('b.example', 5)]),
      1,
      config,
    );
    expect(domains(first)).toEqual(['a.example']);
    expect(domains(second)).toEqual(['b.example']);
    expect(counts(second)).toEqual([5]);
    expect(domains(third)).toEqual([]);
  });

  it('test_key_encoding_does_not_collide_on_field_boundaries', async () => {
    const result = await parse(
      mbox([
        domainScopeEmail('a.example', 1, { reporter: 'a_b', reportId: 'c' }),
        domainScopeEmail('a.example', 2, { reporter: 'a', reportId: 'b_c' }),
      ]),
    );
    expect(counts(result)).toEqual([1, 2]);
    expect(
      result.aggregateReports.map(report => report.reportMetadata.orgName),
    ).toEqual(['a_b', 'a']);
  });
});
