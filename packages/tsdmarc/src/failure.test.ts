import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createParserConfig } from './config';
import { InvalidFailureReport, InvalidForensicReport } from './errors';
import {
  parsedFailureReportsToCsv,
  parsedFailureReportsToCsvRows,
  parsedForensicReportsToCsv,
  parsedForensicReportsToCsvRows,
  parseFailureReport,
  parseForensicReport,
} from './failure';
import { getLevelName, WARNING, captureLogs, type LogCapture } from './log';
import { parseReportFile } from './report-file';
import { toSnakeCaseKeys } from './serialize';
import { cpuMsSince, cpuStart } from './test/cpu-time';
import { asJson, loadFixture, samplePath } from './test/fixtures';
import type { FailureReport } from './types';
import { readCsvDicts } from './utils/csv-reader';
import { PyDateTime } from './utils/datetime';
import { parseDate } from './utils/timestamps';

const FIXTURES = path.join(import.meta.dirname, '__fixtures__', 'failure');

interface FailureFixture {
  input: string;
  feedback_report: string;
  sample: string;
  msg_date: string | null;
  options: { strip_attachment_payloads?: boolean };
  result?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
  csv?: string;
  error?: { type: string; message: string };
  logs: string[];
}

const RANDOM_FILENAME = /^[a-z]{10}\.(txt|rtf)$/u;

// Python iterates sets in hash order (the generator sorts them) and
// mail-parser names some attachments randomly.
function normalize(report: unknown): Record<string, unknown> {
  const json = asJson(report) as Record<string, unknown>;
  const sample = json.parsed_sample as Record<string, unknown> | undefined;
  if (sample) {
    if (Array.isArray(sample.defects_categories)) {
      sample.defects_categories = sample.defects_categories.toSorted();
    }
    for (const attachment of (sample.attachments ?? []) as Record<
      string,
      unknown
    >[]) {
      for (const key of ['filename', 'safe_filename']) {
        const name = attachment[key];
        if (typeof name === 'string' && RANDOM_FILENAME.test(name)) {
          attachment[key] = name.replace(/^[a-z]{10}/u, '<random>');
        }
      }
    }
  }
  return json;
}

function msgDateOf(fixture: FailureFixture): PyDateTime | null {
  if (fixture.msg_date === null) {
    return null;
  }
  const msgDate = parseDate(fixture.msg_date);
  expect(msgDate.isoformat()).toBe(fixture.msg_date);
  return msgDate;
}

function parseFixture(fixture: FailureFixture): Promise<FailureReport> {
  return parseFailureReport(
    fixture.feedback_report,
    fixture.sample,
    msgDateOf(fixture),
    {
      config: createParserConfig({
        offline: true,
        alwaysUseLocalFiles: true,
        stripAttachmentPayloads:
          fixture.options.strip_attachment_payloads ?? false,
      }),
    },
  );
}

let capture: LogCapture | undefined;
afterEach(() => {
  capture?.restore();
  capture = undefined;
});

function warnings(): string[] {
  capture ??= captureLogs(undefined, WARNING);
  return capture.records.map(
    record => `${getLevelName(record.level)}:${record.message}`,
  );
}

const fixtureFiles = readdirSync(FIXTURES)
  .filter(name => name.endsWith('.json'))
  .toSorted();

describe('parseFailureReport matches parsedmarc parse_failure_report()', () => {
  it('has fixtures', () => {
    expect(fixtureFiles.length).toBeGreaterThan(40);
  });

  for (const name of fixtureFiles) {
    it(name, async () => {
      const fixture = JSON.parse(
        readFileSync(path.join(FIXTURES, name), 'utf-8'),
      ) as FailureFixture;
      warnings();
      if (fixture.error) {
        const error = await parseFixture(fixture).catch(
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(InvalidFailureReport);
        expect((error as Error).message).toBe(fixture.error.message);
      } else {
        const report = await parseFixture(fixture);
        expect(normalize(toSnakeCaseKeys(report))).toEqual(fixture.result);
        expect(asJson(parsedFailureReportsToCsvRows(report))).toEqual(
          fixture.rows,
        );
        expect(parsedFailureReportsToCsv(report)).toBe(fixture.csv);
      }
      expect(warnings()).toEqual(fixture.logs);
    });
  }

  it('matches the full parse_report_file() fixtures of samples/failure', async () => {
    const sampleFixtures = fixtureFiles.filter(name =>
      name.startsWith('sample.'),
    );
    expect(sampleFixtures).toHaveLength(5);
    for (const name of sampleFixtures) {
      const fixture = JSON.parse(
        readFileSync(path.join(FIXTURES, name), 'utf-8'),
      ) as FailureFixture;
      const full = loadFixture(fixture.input.replace(/^samples\//u, ''));
      const report = await parseFixture(fixture);
      expect(normalize(toSnakeCaseKeys(report))).toEqual(
        normalize(full.result?.report),
      );
      expect(parsedFailureReportsToCsv(report)).toBe(full.csv);
    }
  });
});

// Port of parsedmarc's tests/test_init.py TestFailureReportParsing.
describe('TestFailureReportParsing', () => {
  const baseFields: Record<string, string> = {
    'Feedback-Type': 'auth-failure',
    'User-Agent': 'test/1.0',
    Version: '1',
    'Original-Mail-From': 'sender@example.com',
    'Arrival-Date': 'Thu, 1 Jan 2024 00:00:00 +0000',
    'Source-IP': '203.0.113.1',
    'Reported-Domain': 'example.com',
    'Auth-Failure': 'dmarc',
  };

  const makeFeedbackReport = (overrides: Record<string, string> = {}) =>
    Object.entries({ ...baseFields, ...overrides })
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');

  const withoutField = (field: string) =>
    makeFeedbackReport()
      .split('\n')
      .filter(line => !line.startsWith(`${field}:`))
      .join('\n');

  const makeSample = () => `From: sender@example.com
To: recipient@example.com
Subject: Test
Date: Thu, 1 Jan 2024 00:00:00 +0000

Test body`;

  const defaultMsgDate = () =>
    new PyDateTime({
      year: 2024,
      month: 1,
      day: 1,
      utcOffsetMinutes: 0,
    });

  const parse = (
    report: string,
    msgDate: PyDateTime | null = defaultMsgDate(),
  ) => parseFailureReport(report, makeSample(), msgDate, { offline: true });

  it('testMissingVersion', async () => {
    const report = await parse(withoutField('Version'));
    expect(report.version).toBeNull();
  });

  it('testMissingUserAgent', async () => {
    const report = await parse(withoutField('User-Agent'));
    expect(report.userAgent).toBeNull();
  });

  it('testMissingDeliveryResult', async () => {
    const report = await parse(makeFeedbackReport());
    expect(report.deliveryResult).toBe('other');
  });

  it('testDeliveryResultMapped', async () => {
    for (const value of ['delivered', 'spam', 'policy', 'reject']) {
      const report = await parse(
        makeFeedbackReport({ 'Delivery-Result': value }),
      );
      expect(report.deliveryResult).toBe(value);
    }
  });

  it('testDeliveryResultUnknownMapsToOther', async () => {
    const report = await parse(
      makeFeedbackReport({ 'Delivery-Result': 'unknown-value' }),
    );
    expect(report.deliveryResult).toBe('other');
  });

  it('testIdentityAlignmentNone', async () => {
    const report = await parse(
      makeFeedbackReport({ 'Identity-Alignment': 'none' }),
    );
    expect(report.authenticationMechanisms).toEqual([]);
  });

  it('testIdentityAlignmentMultiple', async () => {
    const report = await parse(
      makeFeedbackReport({ 'Identity-Alignment': 'dkim,spf' }),
    );
    expect(report.authenticationMechanisms).toEqual(['dkim', 'spf']);
  });

  it('testIdentityAlignmentCFWSWhitespaceStripped', async () => {
    const report = await parse(
      makeFeedbackReport({ 'Identity-Alignment': 'dkim, spf' }),
    );
    expect(report.authenticationMechanisms).toEqual(['dkim', 'spf']);
  });

  it('testAuthFailureCFWSWhitespaceStripped', async () => {
    const report = await parse(
      makeFeedbackReport({ 'Auth-Failure': 'dmarc, spf' }),
    );
    expect(report.authFailure).toEqual(['dmarc', 'spf']);
  });

  it('testMissingIdentityAlignmentWarns', async () => {
    capture = captureLogs(undefined, WARNING);
    const report = await parse(withoutField('Identity-Alignment'));
    expect(report.authenticationMechanisms).toEqual([]);
    expect(
      capture.output.some(
        line =>
          line.includes('Identity-Alignment') && line.includes('RFC 9991'),
      ),
    ).toBe(true);
  });

  it('testMissingAuthFailureWarns', async () => {
    capture = captureLogs(undefined, WARNING);
    const report = await parse(withoutField('Auth-Failure'));
    expect(report.authFailure).toEqual(['dmarc']);
    expect(
      capture.output.some(
        line => line.includes('Auth-Failure') && line.includes('RFC 9991'),
      ),
    ).toBe(true);
  });

  it('testMissingReportedDomainFallback', async () => {
    const report = await parse(withoutField('Reported-Domain'));
    expect(report.reportedDomain).toBe('example.com');
  });

  it('testMissingArrivalDateWithMsgDate', async () => {
    const msgDate = new PyDateTime({
      year: 2024,
      month: 6,
      day: 15,
      hour: 12,
      utcOffsetMinutes: 0,
    });
    const report = await parse(withoutField('Arrival-Date'), msgDate);
    expect(report.arrivalDate).toContain('2024-06-15');
  });

  it('testMissingArrivalDateNoMsgDateRaises', async () => {
    await expect(parse(withoutField('Arrival-Date'), null)).rejects.toThrow(
      InvalidFailureReport,
    );
  });
});

// Ports of the failure-CSV methods of parsedmarc's tests/test_init.py Test.
describe('failure report CSV', () => {
  const loadSampleReport = (name: string): Promise<FailureReport> => {
    const fixture = JSON.parse(
      readFileSync(path.join(FIXTURES, name), 'utf-8'),
    ) as FailureFixture;
    return parseFixture(fixture);
  };

  it('testFailureReportCsvRoundtrip', async () => {
    for (const name of fixtureFiles.filter(file =>
      file.startsWith('sample.'),
    )) {
      const report = await loadSampleReport(name);
      const csv = parsedFailureReportsToCsv(report);
      expect(csv).toContain(',');
      expect(parsedFailureReportsToCsvRows(report).length).toBeGreaterThan(0);
    }
  });

  it('testFailureReportCsvStripsNulFromFields', async () => {
    const report = await loadSampleReport(
      'sample.dmarc_ruf_report_linkedin.json',
    );
    report.parsedSample.subject = 're\0port';
    report.userAgent = 'Agent\0X';
    const csv = parsedFailureReportsToCsv(report);
    expect(csv).not.toContain('\0');
    const [header = '', row = ''] = csv.split('\r\n');
    const columns = header.split(',');
    // Neither value contains a comma or quote, so splitting on "," up to the
    // subject column is safe here.
    const cells = row.split(',');
    expect(cells[columns.indexOf('user_agent')]).toBe('AgentX');
    expect(csv).toContain(',report,');
  });

  it('accepts a list of reports', async () => {
    const report = await loadSampleReport(
      'sample.dmarc_ruf_report_linkedin.json',
    );
    const csv = parsedFailureReportsToCsv([report, report]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(lines[2]);
    expect(parsedFailureReportsToCsvRows([])).toEqual([]);
  });
});

describe('edge cases', () => {
  const sample = 'From: a@example.com\nSubject: s\n\nbody';
  const msgDate = new PyDateTime({
    year: 2024,
    month: 1,
    day: 1,
    utcOffsetMinutes: 0,
  });

  it('testFailureReportBackwardCompat', () => {
    expect(parseForensicReport).toBe(parseFailureReport);
    expect(parsedForensicReportsToCsv).toBe(parsedFailureReportsToCsv);
    expect(parsedForensicReportsToCsvRows).toBe(parsedFailureReportsToCsvRows);
    expect(InvalidForensicReport).toBe(InvalidFailureReport);
  });

  it('keeps unknown fields as own properties, even __proto__', async () => {
    const report = await parseFailureReport(
      'Source-IP: 192.0.2.1\n__proto__: x\nReported-URI: mailto:a@example.com\nX-Custom-Field: y',
      sample,
      msgDate,
      { offline: true },
    );
    expect(Object.hasOwn(report, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(report)).toBe(Object.prototype);
    expect(report.reportedUri).toBe('mailto:a@example.com');
    expect(report.xCustomField).toBe('y');
  });

  it('does not treat a lone CR as a line break (Python re.MULTILINE)', async () => {
    const report = await parseFailureReport(
      'Version: 1\rUser-Agent: x\nSource-IP: 192.0.2.1',
      sample,
      msgDate,
      { offline: true },
    );
    expect(report.version).toBeNull();
    expect(report.userAgent).toBeNull();
  });

  it('takes the source IP up to the first Python whitespace character', async () => {
    const report = await parseFailureReport(
      'Source-IP: 192.0.2.1\u001fjunk',
      sample,
      msgDate,
      { offline: true },
    );
    expect(report.source.ipAddress).toBe('192.0.2.1');
  });

  it('wraps the cause of unexpected errors', async () => {
    const error = (await parseFailureReport(
      'Source-IP: 192.0.2.1\nArrival-Date: not a date',
      sample,
      msgDate,
      { offline: true },
    ).catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(InvalidFailureReport);
    expect(error.message).toBe(
      'Unexpected error: Unknown string format: not a date',
    );
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('runs the field regex in linear time on long hostile lines', async () => {
    const hostile = `${'a-'.repeat(50_000)}\r\r${': x\r'.repeat(50_000)}`;
    const started = cpuStart();
    await parseFailureReport(
      `Source-IP: 192.0.2.1\n${hostile}`,
      sample,
      msgDate,
      {
        offline: true,
      },
    );
    expect(cpuMsSince(started)).toBeLessThan(2000);
  });
});

describe('CSV formula escaping (parsedmarc 11.1.0)', () => {
  it('testFailureReportCsvNeutralizesFormulaInSubject', async () => {
    const result = await parseReportFile(
      samplePath('failure/dmarc_ruf_report_linkedin.eml'),
      { offline: true },
    );
    const report = result.report as FailureReport;
    report.parsedSample.subject = '@evil';
    const [row] = readCsvDicts(parsedFailureReportsToCsv(report));
    expect(row?.get('subject')).toBe("'@evil");
  });
});
