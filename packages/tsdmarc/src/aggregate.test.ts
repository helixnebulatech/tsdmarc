import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  appendParsedRecord,
  bucketIntervalByDay,
  parseAggregateReportFile,
  parseAggregateReportFromFilePath,
  parseAggregateReportXml,
  parsedAggregateReportsToCsv,
  parsedAggregateReportsToCsvRows,
  parseReportRecord,
} from './aggregate';
import { createParserConfig } from './config';
import {
  InvalidAggregateReport,
  InvalidDMARCReport,
  InvalidFailureReport,
  InvalidForensicReport,
  InvalidSMTPTLSReport,
  ParserError,
} from './errors';
import { KeyError, PyAttributeError, PyValueError } from './internal/py';
import { captureLogs, DEBUG, logger, WARNING } from './log';
import { toSnakeCaseKeys } from './serialize';
import { cpuMsSince, cpuStart } from './test/cpu-time';
import { asJson, loadFixture, samplePath } from './test/fixtures';
import { withTzAsync } from './test/tz';
import type { AggregateRecord, AggregateReport } from './types';
import { readCsvDicts } from './utils/csv-reader';
import { PyDateTime } from './utils/datetime';

const FILE_SAMPLES = [
  'aggregate/!example.com!1538204542!1538463818.xml',
  'aggregate/!large-example.com!1711897200!1711983600.xml',
  'aggregate/addisonfoods.com!example.com!1536105600!1536191999.xml',
  'aggregate/empty_reason.xml',
  'aggregate/estadocuenta1.infonacot.gob.mx!example.com!1536853302!1536939702!2940.xml.zip',
  'aggregate/example.net!example.com!1529366400!1529452799.xml',
  'aggregate/fastmail.com!example.com!1516060800!1516147199!102675056.xml.gz',
  'aggregate/ikea.com!example.de!1538690400!1538776800.xml',
  'aggregate/invalid_utf_8.xml',
  'aggregate/invalid_xml.xml',
  'aggregate/old_draft_from_wiki.xml',
  'aggregate/protection.outlook.com!example.com!1711756800!1711843200.xml',
  'aggregate/rfc9990-example.net!example.com!1700000000!1700086399.xml',
  'aggregate/rfc9990-sample.xml',
  'aggregate/usssa.com!example.com!1538784000!1538870399.xml',
  'aggregate/veeam.com!example.com!1530133200!1530219600.xml',
  'aggregate_invalid/report_with_upper_cased_pass.xml',
  'extract_report/changed-input.xml',
  'extract_report/nice-input.xml',
  'extract_report/nice-input.xml.gz',
  'extract_report/nice-input.xml.zip',
];

describe('aggregate samples match parsedmarc', () => {
  for (const sample of FILE_SAMPLES) {
    it(sample, async () => {
      const fixture = loadFixture(sample);
      const report = await parseAggregateReportFromFilePath(
        samplePath(sample),
        {
          alwaysUseLocalFiles: true,
          offline: true,
        },
      );
      expect(fixture.result?.report_type).toBe('aggregate');
      expect(asJson(toSnakeCaseKeys(report))).toEqual(fixture.result?.report);
      expect(parsedAggregateReportsToCsv(report)).toBe(fixture.csv);
    });
  }
});

// --- helpers ---------------------------------------------------------------

const OFFLINE = { offline: true } as const;
const offlineConfig = () => createParserConfig({ offline: true });

const utc = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): PyDateTime =>
  new PyDateTime({
    year,
    month,
    day,
    hour,
    minute,
    second,
    utcOffsetMinutes: 0,
  });

/** Run `fn` while capturing log records (Python's `assertLogs`). */
async function withLogs<T>(
  level: number,
  fn: () => Promise<T>,
): Promise<{ result: T; output: string[]; messages: string[] }> {
  const capture = captureLogs(logger, level);
  try {
    const result = await fn();
    return {
      result,
      output: capture.output,
      messages: capture.records.map(record => record.message),
    };
  } finally {
    capture.restore();
  }
}

/** Run `fn` expecting it to reject; return the error. */
async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

const sum = (items: { count: number | bigint }[]): number =>
  items.reduce((total, item) => total + Number(item.count), 0);

const parseSample = (relative: string): Promise<AggregateReport> =>
  parseAggregateReportFromFilePath(samplePath(relative), {
    alwaysUseLocalFiles: true,
    offline: true,
  });

const RFC9990_SAMPLE = 'aggregate/rfc9990-sample.xml';
const RFC7489_SAMPLE =
  'aggregate/example.net!example.com!1529366400!1529452799.xml';

// A record dict as xmltodict would produce it, for parseReportRecord().
function rawRecord(overrides: {
  row?: Record<string, unknown>;
  policyEvaluated?: Record<string, unknown>;
  identifiers?: Record<string, unknown>;
  identities?: Record<string, unknown>;
  authResults?: unknown;
}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    row: {
      source_ip: '192.0.2.1',
      count: '1',
      policy_evaluated: overrides.policyEvaluated ?? {
        disposition: 'none',
        dkim: 'pass',
        spf: 'pass',
      },
      ...overrides.row,
    },
  };
  if (overrides.identities) {
    record.identities = overrides.identities;
  } else {
    record.identifiers = overrides.identifiers ?? {
      header_from: 'example.com',
    };
  }
  record.auth_results = overrides.authResults ?? { dkim: [], spf: [] };
  return record;
}

// --- Test (kitchen-sink class in tests/test_init.py) -----------------------

describe('Test', () => {
  it('testAggregateResultWordsAreLowercase', async () => {
    // parsedmarc goes through parse_report_file; for an XML file that is
    // parse_aggregate_report_file.
    const report = await parseAggregateReportFromFilePath(
      samplePath('aggregate_invalid/report_with_upper_cased_pass.xml'),
      OFFLINE,
    );
    const [record] = report.records;
    expect(record?.policyEvaluated.dkim).toBe('pass');
    expect(record?.policyEvaluated.spf).toBe('pass');
    expect(record?.authResults.dkim[0]?.result).toBe('pass');
    expect(record?.authResults.spf[0]?.result).toBe('pass');
    expect(record?.policyEvaluated.disposition).toBe('none');
  });

  it('testRFC9990SampleReport', async () => {
    const report = await parseSample(RFC9990_SAMPLE);
    expect(report.xmlSchema).toBe('1.0');

    const metadata = report.reportMetadata;
    expect(metadata.orgName).toBe('Sample Reporter');
    expect(metadata.orgEmail).toBe('report_sender@example-reporter.com');
    expect(metadata.orgExtraContactInfo).toBe('...');
    expect(metadata.reportId).toBe('3v98abbp8ya9n3va8yr8oa3ya');
    expect(metadata.generator).toBe('Example DMARC Aggregate Reporter v1.2');

    const pp = report.policyPublished;
    expect(pp.domain).toBe('example.com');
    expect(pp.p).toBe('quarantine');
    expect(pp.sp).toBe('none');
    expect(pp.np).toBe('none');
    expect(pp.testing).toBe('n');
    expect(pp.discoveryMethod).toBe('treewalk');
    expect(pp.adkim).toBe('r');
    expect(pp.aspf).toBe('r');
    expect(pp.pct).toBeNull();
    expect(pp.fo).toBeNull();

    expect(report.records).toHaveLength(1);
    const rec = report.records[0] as AggregateRecord;
    expect(rec.source.ipAddress).toBe('192.0.2.123');
    expect(rec.count).toBe(123);
    expect(rec.policyEvaluated.disposition).toBe('pass');
    expect(rec.policyEvaluated.dkim).toBe('pass');
    expect(rec.policyEvaluated.spf).toBe('fail');

    expect(rec.authResults.dkim).toHaveLength(1);
    const dkim = rec.authResults.dkim[0];
    expect(dkim?.domain).toBe('example.com');
    expect(dkim?.selector).toBe('abc123');
    expect(dkim?.result).toBe('pass');
    expect(dkim?.humanResult).toBeNull();

    expect(rec.authResults.spf).toHaveLength(1);
    const spf = rec.authResults.spf[0];
    expect(spf?.domain).toBe('example.com');
    expect(spf?.result).toBe('fail');
    expect(spf?.humanResult).toBeNull();

    const header = (
      parsedAggregateReportsToCsv(report).split('\n')[0] ?? ''
    ).split(',');
    expect(header).toContain('np');
    expect(header).toContain('testing');
    expect(header).toContain('discovery_method');
  });

  it('testRFC9990FieldsAbsentFromRFC7489Report', async () => {
    const report = await parseSample(RFC7489_SAMPLE);
    const pp = report.policyPublished;
    expect(pp.pct).toBe('100');
    expect(pp.fo).toBe('0');
    expect(pp.np).toBeNull();
    expect(pp.testing).toBeNull();
    expect(pp.discoveryMethod).toBeNull();
    expect(report.reportMetadata.generator).toBeNull();
  });

  it('testRFC9990WithExplicitFields', async () => {
    const report = await parseSample(
      'aggregate/rfc9990-example.net!example.com!1700000000!1700086399.xml',
    );
    expect(report.policyPublished.np).toBe('reject');
    expect(report.policyPublished.testing).toBe('y');
    expect(report.policyPublished.discoveryMethod).toBe('treewalk');
  });

  it('testRFC9990NamespaceCaptured', async () => {
    const report = await parseSample(RFC9990_SAMPLE);
    expect(report.xmlNamespace).toBe('urn:ietf:params:xml:ns:dmarc-2.0');
  });

  it('testRFC9990NamespaceAbsentOnRFC7489Report', async () => {
    const report = await parseSample(RFC7489_SAMPLE);
    expect(report.xmlNamespace).toBeNull();
  });

  it('testRFC9990DetectionAcceptsNamespacelessReports', async () => {
    const { result: report, output } = await withLogs(WARNING, () =>
      parseAggregateReportXml(
        `<?xml version="1.0"?>
        <feedback>
            <report_metadata>
                <org_name>Test</org_name>
                <email>t@example.com</email>
                <report_id>r1</report_id>
                <date_range><begin>1700000000</begin><end>1700086399</end></date_range>
            </report_metadata>
            <policy_published>
                <domain>example.com</domain>
                <p>none</p>
                <np>reject</np>
            </policy_published>
            <record>
                <row>
                    <source_ip>192.0.2.1</source_ip>
                    <count>1</count>
                    <policy_evaluated>
                        <disposition>none</disposition>
                        <dkim>pass</dkim>
                        <spf>pass</spf>
                    </policy_evaluated>
                </row>
                <identifiers><header_from>example.com</header_from></identifiers>
                <auth_results>
                    <dkim>
                        <domain>example.com</domain>
                        <result>pass</result>
                    </dkim>
                </auth_results>
            </record>
        </feedback>`,
        OFFLINE,
      ),
    );
    expect(report.xmlNamespace).toBeNull();
    expect(output.some(message => message.includes('selector'))).toBe(true);
  });

  it('testRFC9990DKIMMissingSelectorWarning', async () => {
    const xml = `<?xml version="1.0"?>
        <feedback xmlns="urn:ietf:params:xml:ns:dmarc-2.0">
            <version>1.0</version>
            <report_metadata>
                <org_name>Test</org_name>
                <email>t@example.com</email>
                <report_id>r1</report_id>
                <date_range><begin>1700000000</begin><end>1700086399</end></date_range>
            </report_metadata>
            <policy_published>
                <domain>example.com</domain>
                <p>none</p>
            </policy_published>
            <record>
                <row>
                    <source_ip>192.0.2.1</source_ip>
                    <count>1</count>
                    <policy_evaluated>
                        <disposition>none</disposition>
                        <dkim>pass</dkim>
                        <spf>pass</spf>
                    </policy_evaluated>
                </row>
                <identifiers><header_from>example.com</header_from></identifiers>
                <auth_results>
                    <dkim>
                        <domain>example.com</domain>
                        <result>pass</result>
                    </dkim>
                </auth_results>
            </record>
        </feedback>`;
    const { output } = await withLogs(WARNING, () =>
      parseAggregateReportXml(xml, OFFLINE),
    );
    expect(
      output.some(
        message => message.includes('selector') && message.includes('REQUIRED'),
      ),
    ).toBe(true);
    // The exact parsedmarc message.
    expect(output).toContain(
      "WARNING:tsdmarc:DKIM auth result for 'example.com' is missing the 'selector' element, which is REQUIRED by RFC 9990",
    );
  });

  it('testRFC9990LegacyOverrideTypeWarning', async () => {
    const xml = `<?xml version="1.0"?>
        <feedback xmlns="urn:ietf:params:xml:ns:dmarc-2.0">
            <report_metadata>
                <org_name>Test</org_name>
                <email>t@example.com</email>
                <report_id>r1</report_id>
                <date_range><begin>1700000000</begin><end>1700086399</end></date_range>
            </report_metadata>
            <policy_published>
                <domain>example.com</domain>
                <p>none</p>
            </policy_published>
            <record>
                <row>
                    <source_ip>192.0.2.1</source_ip>
                    <count>1</count>
                    <policy_evaluated>
                        <disposition>none</disposition>
                        <dkim>pass</dkim>
                        <spf>pass</spf>
                        <reason><type>forwarded</type></reason>
                    </policy_evaluated>
                </row>
                <identifiers><header_from>example.com</header_from></identifiers>
                <auth_results>
                    <dkim>
                        <domain>example.com</domain>
                        <selector>s</selector>
                        <result>pass</result>
                    </dkim>
                </auth_results>
            </record>
        </feedback>`;
    const { messages } = await withLogs(WARNING, () =>
      parseAggregateReportXml(xml, OFFLINE),
    );
    expect(
      messages.some(
        message =>
          message.includes('forwarded') &&
          message.includes('removed in RFC 9990'),
      ),
    ).toBe(true);
    expect(messages).toContain(
      "Policy override reason type 'forwarded' was removed in RFC 9990; expected one of ['local_policy', 'mailing_list', 'other', 'policy_test_mode', 'trusted_forwarder']",
    );
  });

  it('testRFC9990LangAttrStringUnwrapped', async () => {
    const xml = `<?xml version="1.0"?>
        <feedback xmlns="urn:ietf:params:xml:ns:dmarc-2.0">
            <report_metadata>
                <org_name>Test</org_name>
                <email>t@example.com</email>
                <extra_contact_info xml:lang="en">contact-here</extra_contact_info>
                <report_id>r1</report_id>
                <date_range><begin>1700000000</begin><end>1700086399</end></date_range>
                <error xml:lang="en">a problem</error>
            </report_metadata>
            <policy_published>
                <domain>example.com</domain>
                <p>none</p>
            </policy_published>
            <record>
                <row>
                    <source_ip>192.0.2.1</source_ip>
                    <count>1</count>
                    <policy_evaluated>
                        <disposition>none</disposition>
                        <dkim>pass</dkim>
                        <spf>pass</spf>
                        <reason>
                            <type>local_policy</type>
                            <comment xml:lang="en">a comment</comment>
                        </reason>
                    </policy_evaluated>
                </row>
                <identifiers><header_from>example.com</header_from></identifiers>
                <auth_results>
                    <dkim>
                        <domain>example.com</domain>
                        <selector>s</selector>
                        <result>pass</result>
                        <human_result xml:lang="en">looks fine</human_result>
                    </dkim>
                    <spf>
                        <domain>example.com</domain>
                        <result>pass</result>
                        <human_result xml:lang="en">spf-detail</human_result>
                    </spf>
                </auth_results>
            </record>
        </feedback>`;
    const report = await parseAggregateReportXml(xml, OFFLINE);
    expect(report.reportMetadata.orgExtraContactInfo).toBe('contact-here');
    expect(report.reportMetadata.errors).toEqual(['a problem']);
    const rec = report.records[0] as AggregateRecord;
    expect(rec.policyEvaluated.policyOverrideReasons[0]?.comment).toBe(
      'a comment',
    );
    expect(rec.authResults.dkim[0]?.humanResult).toBe('looks fine');
    expect(rec.authResults.spf[0]?.humanResult).toBe('spf-detail');
  });

  it('testAggregateCsvExposesASNColumns', async () => {
    const report = await parseSample(
      'aggregate/!example.com!1538204542!1538463818.xml',
    );
    const header = (
      parsedAggregateReportsToCsv(report).split(/\r?\n/u)[0] ?? ''
    ).split(',');
    expect(header).toContain('source_asn');
    expect(header).toContain('source_as_name');
    expect(header).toContain('source_as_domain');
  });

  it('testBucketIntervalBeginAfterEnd', () => {
    expect(() =>
      bucketIntervalByDay(utc(2024, 1, 2), utc(2024, 1, 1), 100),
    ).toThrow(new PyValueError('begin must be earlier than end'));
  });

  it('testBucketIntervalNaiveDatetime', () => {
    const naive = (day: number) =>
      new PyDateTime({ year: 2024, month: 1, day });
    expect(() => bucketIntervalByDay(naive(1), naive(2), 100)).toThrow(
      new PyValueError('begin and end must be timezone-aware'),
    );
  });

  it('testBucketIntervalDifferentTzinfo', () => {
    const begin = utc(2024, 1, 1);
    const end = new PyDateTime({
      year: 2024,
      month: 1,
      day: 2,
      utcOffsetMinutes: 5 * 60,
    });
    expect(() => bucketIntervalByDay(begin, end, 100)).toThrow(
      new PyValueError('begin and end must have the same tzinfo'),
    );
  });

  it('testBucketIntervalNegativeCount', () => {
    expect(() =>
      bucketIntervalByDay(utc(2024, 1, 1), utc(2024, 1, 2), -1),
    ).toThrow(new PyValueError('total_count must be non-negative'));
  });

  it('testBucketIntervalZeroCount', () => {
    expect(bucketIntervalByDay(utc(2024, 1, 1), utc(2024, 1, 2), 0)).toEqual(
      [],
    );
  });

  it('testBucketIntervalSameBeginEnd', () => {
    const dt = utc(2024, 1, 1, 12);
    expect(bucketIntervalByDay(dt, dt, 100)).toEqual([]);
  });

  it('testBucketIntervalSingleDay', () => {
    const begin = utc(2024, 1, 1);
    const result = bucketIntervalByDay(begin, utc(2024, 1, 1, 23, 59, 59), 100);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(100);
    expect(result[0]?.begin.equals(begin)).toBe(true);
  });

  it('testBucketIntervalMultiDay', () => {
    const result = bucketIntervalByDay(utc(2024, 1, 1), utc(2024, 1, 3), 100);
    expect(result).toHaveLength(2);
    expect(sum(result)).toBe(100);
    expect(result[0]?.count).toBe(50);
    expect(result[1]?.count).toBe(50);
  });

  it('testBucketIntervalRemainderDistribution', () => {
    const result = bucketIntervalByDay(utc(2024, 1, 1), utc(2024, 1, 4), 10);
    expect(sum(result)).toBe(10);
    expect(result).toHaveLength(3);
  });

  it('testBucketIntervalPartialDays', () => {
    const result = bucketIntervalByDay(
      utc(2024, 1, 1, 12),
      utc(2024, 1, 3),
      90,
    );
    expect(sum(result)).toBe(90);
    expect(result[0]?.count).toBe(30);
    expect(result[1]?.count).toBe(60);
  });

  it('testAppendParsedRecordNoNormalize', () => {
    const records: AggregateRecord[] = [];
    const rec = { count: 10, source: { ipAddress: '1.2.3.4' } };
    appendParsedRecord(
      rec as never,
      records,
      utc(2024, 1, 1),
      utc(2024, 1, 2),
      false,
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.normalizedTimespan).toBe(false);
    expect(records[0]?.intervalBegin).toBe('2024-01-01 00:00:00');
    expect(records[0]?.intervalEnd).toBe('2024-01-02 00:00:00');
  });

  it('testAppendParsedRecordNormalize', () => {
    const records: AggregateRecord[] = [];
    const rec = { count: 100, source: { ipAddress: '1.2.3.4' } };
    appendParsedRecord(
      rec as never,
      records,
      utc(2024, 1, 1),
      utc(2024, 1, 3),
      true,
    );
    expect(records).toHaveLength(2);
    expect(sum(records)).toBe(100);
    for (const record of records) {
      expect(record.normalizedTimespan).toBe(true);
    }
  });

  it('testAppendParsedRecordNormalizeZeroCount', () => {
    const records: AggregateRecord[] = [];
    const rec = { count: 0, source: { ipAddress: '1.2.3.4' } };
    appendParsedRecord(
      rec as never,
      records,
      utc(2024, 1, 1),
      utc(2024, 1, 3),
      true,
    );
    expect(records).toHaveLength(0);
  });

  it('testParseReportRecordNoneSourceIP', async () => {
    const record = rawRecord({ row: { source_ip: null } });
    await expect(parseReportRecord(record, offlineConfig())).rejects.toThrow(
      new PyValueError('Source IP address is empty'),
    );
  });

  it('testParseReportRecordMissingDkimSpf', async () => {
    const result = await parseReportRecord(
      rawRecord({
        policyEvaluated: { disposition: 'none', dkim: 'pass', spf: 'fail' },
        authResults: {},
      }),
      offlineConfig(),
    );
    expect(result.authResults.dkim).toEqual([]);
    expect(result.authResults.spf).toEqual([]);
  });

  it('testParseReportRecordReasonHandling', async () => {
    const result = await parseReportRecord(
      rawRecord({
        policyEvaluated: {
          disposition: 'none',
          dkim: 'pass',
          spf: 'pass',
          reason: { type: 'forwarded' },
        },
      }),
      offlineConfig(),
    );
    const reasons = result.policyEvaluated.policyOverrideReasons;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.type).toBe('forwarded');
    expect(reasons[0]?.comment).toBeNull();
  });

  it('testParseReportRecordReasonList', async () => {
    const result = await parseReportRecord(
      rawRecord({
        policyEvaluated: {
          disposition: 'none',
          dkim: 'pass',
          spf: 'pass',
          reason: [
            { type: 'forwarded', comment: 'relay' },
            { type: 'local_policy' },
          ],
        },
      }),
      offlineConfig(),
    );
    const reasons = result.policyEvaluated.policyOverrideReasons;
    expect(reasons).toHaveLength(2);
    expect(reasons[0]?.comment).toBe('relay');
    expect(reasons[1]?.comment).toBeNull();
  });

  it('testParseReportRecordIdentities', async () => {
    const result = await parseReportRecord(
      rawRecord({
        identities: {
          header_from: 'Example.COM',
          envelope_from: 'example.com',
        },
      }),
      offlineConfig(),
    );
    expect(result).toHaveProperty('identifiers');
    expect(result.identifiers.headerFrom).toBe('example.com');
  });

  it('testParseReportRecordDkimDefaults', async () => {
    const result = await parseReportRecord(
      rawRecord({
        policyEvaluated: { disposition: 'none', dkim: 'fail', spf: 'fail' },
        authResults: { dkim: { domain: 'example.com' }, spf: [] },
      }),
      offlineConfig(),
    );
    const dkim = result.authResults.dkim[0];
    expect(dkim?.selector).toBe('none');
    expect(dkim?.result).toBe('none');
    expect(dkim?.humanResult).toBeNull();
  });

  it('testParseReportRecordSpfDefaults', async () => {
    const result = await parseReportRecord(
      rawRecord({
        policyEvaluated: { disposition: 'none', dkim: 'fail', spf: 'fail' },
        authResults: { dkim: [], spf: { domain: 'example.com' } },
      }),
      offlineConfig(),
    );
    const spf = result.authResults.spf[0];
    expect(spf?.scope).toBe('mfrom');
    expect(spf?.result).toBe('none');
    expect(spf?.humanResult).toBeNull();
  });

  it('testParseReportRecordHumanResult', async () => {
    const result = await parseReportRecord(
      rawRecord({
        authResults: {
          dkim: [
            {
              domain: 'example.com',
              selector: 's1',
              result: 'pass',
              human_result: 'good key',
            },
          ],
          spf: [
            {
              domain: 'example.com',
              scope: 'mfrom',
              result: 'pass',
              human_result: 'sender valid',
            },
          ],
        },
      }),
      offlineConfig(),
    );
    expect(result.authResults.dkim[0]?.humanResult).toBe('good key');
    expect(result.authResults.spf[0]?.humanResult).toBe('sender valid');
  });

  it('testParseReportRecordEnvelopeFromFallback', async () => {
    const result = await parseReportRecord(
      rawRecord({
        authResults: {
          dkim: [],
          spf: [
            { domain: 'Bounce.Example.COM', scope: 'mfrom', result: 'pass' },
          ],
        },
      }),
      offlineConfig(),
    );
    expect(result.identifiers.envelopeFrom).toBe('bounce.example.com');
  });

  it('testParseReportRecordEnvelopeFromNullFallback', async () => {
    const result = await parseReportRecord(
      rawRecord({
        identifiers: { header_from: 'example.com', envelope_from: null },
        authResults: {
          dkim: [],
          spf: [{ domain: 'SPF.Example.COM', scope: 'mfrom', result: 'pass' }],
        },
      }),
      offlineConfig(),
    );
    expect(result.identifiers.envelopeFrom).toBe('spf.example.com');
  });

  it('testParseReportRecordEnvelopeFromNullNoSpfDomain', async () => {
    const result = await parseReportRecord(
      rawRecord({
        identifiers: { header_from: 'example.com', envelope_from: null },
        authResults: { dkim: [], spf: [{ scope: 'mfrom', result: 'pass' }] },
      }),
      offlineConfig(),
    );
    expect(result.identifiers.envelopeFrom).toBeNull();
  });

  it('testParseReportRecordEnvelopeTo', async () => {
    const result = await parseReportRecord(
      rawRecord({
        identifiers: {
          header_from: 'example.com',
          envelope_from: 'bounce@example.com',
          envelope_to: 'recipient@example.com',
        },
      }),
      offlineConfig(),
    );
    expect(result.identifiers.envelopeTo).toBe('recipient@example.com');
  });

  it('testParseReportRecordAlignment', async () => {
    const result = await parseReportRecord(
      rawRecord({
        policyEvaluated: { disposition: 'none', dkim: 'pass', spf: 'fail' },
      }),
      offlineConfig(),
    );
    expect(result.alignment.dkim).toBe(true);
    expect(result.alignment.spf).toBe(false);
    expect(result.alignment.dmarc).toBe(true);
  });

  it('testAggregateReportInvalidNpWarning', async () => {
    const xml = `<?xml version="1.0"?>
        <feedback>
            <version>1.0</version>
            <report_metadata>
                <org_name>Test Org</org_name>
                <email>test@example.com</email>
                <report_id>test-np-invalid</report_id>
                <date_range><begin>1704067200</begin><end>1704153599</end></date_range>
            </report_metadata>
            <policy_published>
                <domain>example.com</domain>
                <p>none</p>
                <np>banana</np>
                <testing>maybe</testing>
                <discovery_method>magic</discovery_method>
            </policy_published>
            <record>
                <row>
                    <source_ip>192.0.2.1</source_ip>
                    <count>1</count>
                    <policy_evaluated>
                        <disposition>none</disposition>
                        <dkim>pass</dkim>
                        <spf>pass</spf>
                    </policy_evaluated>
                </row>
                <identifiers><header_from>example.com</header_from></identifiers>
                <auth_results>
                    <spf><domain>example.com</domain><result>pass</result></spf>
                </auth_results>
            </record>
        </feedback>`;
    const { result: report, messages } = await withLogs(WARNING, () =>
      parseAggregateReportXml(xml, OFFLINE),
    );
    expect(report.policyPublished.np).toBe('banana');
    expect(report.policyPublished.testing).toBe('maybe');
    expect(report.policyPublished.discoveryMethod).toBe('magic');
    // The warnings the test's name refers to.
    expect(messages).toEqual([
      'Invalid np value: banana',
      'Invalid testing value: maybe',
      'Invalid discovery_method value: magic',
    ]);
  });

  // parsedmarc 11.1.0 (sanitize_for_log): report text in these warnings
  // can't forge log lines.
  it('escapes control characters in the invalid policy value warnings', async () => {
    const xml = `<feedback>
  <report_metadata><org_name>O</org_name><email>a@example.com</email>
    <report_id>r</report_id>
    <date_range><begin>1529366400</begin><end>1529452799</end></date_range>
  </report_metadata>
  <policy_published><domain>example.com</domain><p>none</p>
    <np>x&#13;&#10;FORGED</np><testing>y&#10;FORGED</testing>
    <discovery_method>z&#13;FORGED</discovery_method>
  </policy_published>
  <record>
    <row><source_ip>192.0.2.1</source_ip><count>1</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>
  </record>
  <record>
    <row><source_ip>bad&#10;ip</source_ip><count>1</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>
  </record>
</feedback>`;
    const { messages } = await withLogs(WARNING, () =>
      parseAggregateReportXml(xml, OFFLINE),
    );
    expect(messages).toEqual([
      'Invalid np value: x\\r\\nFORGED',
      'Invalid testing value: y\\nFORGED',
      'Invalid discovery_method value: z\\rFORGED',
      "Could not parse record: 'bad\\nip' does not appear to be an IPv4 or IPv6 address.",
    ]);
  });

  it('testAggregateReportPassDisposition', async () => {
    const xml = `<?xml version="1.0"?>
        <feedback>
            <report_metadata>
                <org_name>TestOrg</org_name>
                <email>test@example.com</email>
                <report_id>test-pass</report_id>
                <date_range><begin>1704067200</begin><end>1704153599</end></date_range>
            </report_metadata>
            <policy_published>
                <domain>example.com</domain>
                <p>reject</p>
            </policy_published>
            <record>
                <row>
                    <source_ip>192.0.2.1</source_ip>
                    <count>1</count>
                    <policy_evaluated>
                        <disposition>pass</disposition>
                        <dkim>pass</dkim>
                        <spf>pass</spf>
                    </policy_evaluated>
                </row>
                <identifiers><header_from>example.com</header_from></identifiers>
                <auth_results>
                    <spf><domain>example.com</domain><result>pass</result></spf>
                </auth_results>
            </record>
        </feedback>`;
    const report = await parseAggregateReportXml(xml, OFFLINE);
    expect(report.records[0]?.policyEvaluated.disposition).toBe('pass');
  });

  it('testAggregateReportMultipleRecords', async () => {
    const xml = `<?xml version="1.0"?>
        <feedback>
            <report_metadata>
                <org_name>TestOrg</org_name>
                <email>test@example.com</email>
                <report_id>test-multi</report_id>
                <date_range><begin>1704067200</begin><end>1704153599</end></date_range>
            </report_metadata>
            <policy_published>
                <domain>example.com</domain>
                <p>none</p>
            </policy_published>
            <record>
                <row>
                    <source_ip>192.0.2.1</source_ip>
                    <count>10</count>
                    <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
                </row>
                <identifiers><header_from>example.com</header_from></identifiers>
                <auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>
            </record>
            <record>
                <row>
                    <source_ip>192.0.2.2</source_ip>
                    <count>5</count>
                    <policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated>
                </row>
                <identifiers><header_from>example.com</header_from></identifiers>
                <auth_results><spf><domain>example.com</domain><result>fail</result></spf></auth_results>
            </record>
        </feedback>`;
    const report = await parseAggregateReportXml(xml, OFFLINE);
    expect(report.records).toHaveLength(2);
    expect(report.records[0]?.count).toBe(10);
    expect(report.records[1]?.count).toBe(5);
  });

  it('testAggregateReportInvalidXmlRecovery', async () => {
    const xml =
      '<?xml version="1.0"?><feedback><report_metadata><org_name>Test</org_name><email>t@e.com</email><report_id>r1</report_id><date_range><begin>1704067200</begin><end>1704153599</end></date_range></report_metadata><policy_published><domain>example.com</domain><p>none</p></policy_published><record><row><source_ip>192.0.2.1</source_ip><count>1</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers><auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results></record></feedback>';
    const report = await parseAggregateReportXml(xml, OFFLINE);
    expect(report.reportMetadata.reportId).toBe('r1');
  });

  it('testAggregateReportCsvRowsContainRFC9990Fields', async () => {
    const report = await parseSample(RFC9990_SAMPLE);
    const rows = parsedAggregateReportsToCsvRows(report);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0] ?? {};
    for (const key of [
      'np',
      'testing',
      'discovery_method',
      'source_ip_address',
      'dkim_domains',
      'spf_domains',
    ]) {
      expect(row).toHaveProperty(key);
    }
  });

  it('testAggregateReportSchemaVersion', async () => {
    const report = await parseAggregateReportXml(
      minimalAggregateXml().replace(
        '<feedback>',
        '<feedback><version>1.0</version>',
      ),
      OFFLINE,
    );
    expect(report.xmlSchema).toBe('1.0');
  });

  it('testAggregateReportDraftSchema', async () => {
    const report = await parseAggregateReportXml(
      minimalAggregateXml(),
      OFFLINE,
    );
    expect(report.xmlSchema).toBe('draft');
  });

  it('testAggregateReportGeneratorField', async () => {
    const report = await parseAggregateReportXml(
      minimalAggregateXml().replace(
        '<report_id>edge-case</report_id>',
        '<report_id>test-gen</report_id><generator>My Reporter v1.0</generator>',
      ),
      OFFLINE,
    );
    expect(report.reportMetadata.generator).toBe('My Reporter v1.0');
  });

  it('testAggregateReportReportErrors', async () => {
    const report = await parseAggregateReportXml(
      minimalAggregateXml().replace(
        '<report_id>edge-case</report_id>',
        '<report_id>test-err</report_id><error>Some error</error>',
      ),
      OFFLINE,
    );
    expect(report.reportMetadata.errors).toContain('Some error');
  });

  it('testAggregateReportPolicyDefaults', async () => {
    const report = await parseAggregateReportXml(
      minimalAggregateXml({
        policyPublished:
          '<policy_published><domain>example.com</domain><p>reject</p></policy_published>',
      }),
      OFFLINE,
    );
    const pp = report.policyPublished;
    expect(pp.adkim).toBe('r');
    expect(pp.aspf).toBe('r');
    expect(pp.sp).toBe('reject');
    expect(pp.pct).toBeNull();
    expect(pp.fo).toBeNull();
    expect(pp.np).toBeNull();
    expect(pp.testing).toBeNull();
    expect(pp.discoveryMethod).toBeNull();
  });

  it('testParsedAggregateReportsToCsvRowsList', async () => {
    const report = await parseSample(RFC9990_SAMPLE);
    const rows = parsedAggregateReportsToCsvRows([report]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const value of Object.values(row)) {
        // Python: type(v) in [str, int, bool].
        const isPyStrIntBool =
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          Number.isInteger(value);
        expect(isPyStrIntBool).toBe(true);
      }
    }
  });

  it('testExceptionHierarchy', () => {
    // Python: issubclass(ParserError, RuntimeError); JS has no RuntimeError,
    // so ParserError extends Error.
    expect(new ParserError('x')).toBeInstanceOf(Error);
    expect(new InvalidDMARCReport('x')).toBeInstanceOf(ParserError);
    expect(new InvalidAggregateReport('x')).toBeInstanceOf(InvalidDMARCReport);
    expect(new InvalidFailureReport('x')).toBeInstanceOf(InvalidDMARCReport);
    expect(new InvalidSMTPTLSReport('x')).toBeInstanceOf(ParserError);
    expect(InvalidForensicReport).toBe(InvalidFailureReport);
  });

  it('testAggregateReportNormalization', async () => {
    const report = await parseAggregateReportXml(
      minimalAggregateXml({ count: 90 }).replace(
        '<end>1704153599</end>',
        '<end>1704326400</end>',
      ),
      OFFLINE,
    );
    expect(report.reportMetadata.timespanRequiresNormalization).toBe(true);
    expect(report.records.length).toBeGreaterThan(1);
    expect(sum(report.records)).toBe(90);
    for (const record of report.records) {
      expect(record.normalizedTimespan).toBe(true);
    }
  });

  it('testParseAggregateReportFile', async () => {
    const data = new Uint8Array(readFileSync(samplePath(RFC9990_SAMPLE)));
    const report = await parseAggregateReportFile(data, {
      offline: true,
      alwaysUseLocalFiles: true,
    });
    expect(report.reportMetadata.orgName).toBe('Sample Reporter');
    expect(report.policyPublished.domain).toBe('example.com');
  });

  it('testParseAggregateReportFileLeavesCallerStreamOpen', async () => {
    // tsdmarc takes a path or bytes, not file objects, so the contract to
    // keep is that the caller's buffer is left untouched on success and on
    // the error path.
    const data = new Uint8Array(readFileSync(samplePath(RFC9990_SAMPLE)));
    const copy = data.slice();
    const report = await parseAggregateReportFile(data, {
      offline: true,
      alwaysUseLocalFiles: true,
    });
    expect(report.reportMetadata.orgName).toBe('Sample Reporter');
    expect(data).toEqual(copy);

    const garbage = new TextEncoder().encode('this is not a valid report');
    const garbageCopy = garbage.slice();
    const error = await rejection(() =>
      parseAggregateReportFile(garbage, OFFLINE),
    );
    expect(error).toBeInstanceOf(InvalidAggregateReport);
    expect(error.message).toBe(
      'Invalid archive file: Not a valid zip, gzip, json, or xml file',
    );
    expect(garbage).toEqual(garbageCopy);
  });
});

// --- TestMalformedXmlRecovery ------------------------------------------------

const MALFORMED_REPORT_BODY = `
  <report_metadata>
    <org_name>example.com</org_name>
    <email>dmarc@example.com</email>
    <report_id>12345</report_id>
    <date_range><begin>1680000000</begin><end>1680086400</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain><p>none</p>
  </policy_published>
  <record>
    <row><source_ip>203.0.113.1</source_ip><count>1</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>
  </record>`;

describe('TestMalformedXmlRecovery', () => {
  it('testRecoversMalformedXml', async () => {
    const malformed = `<?xml version="1.0"?>
<feedback>${MALFORMED_REPORT_BODY}
  <broken_tag
</feedback>`;
    // parsedmarc accepts either outcome; lxml recovers this one, so pin it.
    const report = await parseAggregateReportXml(malformed, OFFLINE);
    expect(report).toHaveProperty('reportMetadata');
    expect(report.reportMetadata.reportId).toBe('12345');
    expect(report.records).toHaveLength(1);
    expect(report.reportMetadata.errors).toHaveLength(1);
    expect(report.reportMetadata.errors[0]).toMatch(/^Invalid XML: /u);
  });

  it('testBytesXmlInput', async () => {
    const xml = new TextEncoder().encode(
      `<?xml version="1.0"?>
<feedback>${MALFORMED_REPORT_BODY.replace('12345', 'test-bytes-input')}
</feedback>`,
    );
    // Python decodes the bytes before calling; also pass the bytes directly.
    const fromText = await parseAggregateReportXml(
      new TextDecoder().decode(xml),
      OFFLINE,
    );
    expect(fromText.reportMetadata.reportId).toBe('test-bytes-input');
    const fromBytes = await parseAggregateReportXml(xml, OFFLINE);
    expect(fromBytes.reportMetadata.reportId).toBe('test-bytes-input');
  });

  it('testExpatErrorRaises', async () => {
    await expect(
      parseAggregateReportXml('not xml at all {}', OFFLINE),
    ).rejects.toThrow(InvalidAggregateReport);
  });

  it('testMissingOrgName', async () => {
    const xml = `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <email>dmarc@example.com</email>
    <report_id>missing-org</report_id>
    <date_range><begin>1680000000</begin><end>1680086400</end></date_range>
  </report_metadata>
  <policy_published><domain>example.com</domain><p>none</p></policy_published>
  <record>
    <row><source_ip>1.2.3.4</source_ip><count>1</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>
  </record>
</feedback>`;
    const error = await rejection(() => parseAggregateReportXml(xml, OFFLINE));
    expect(error).toBeInstanceOf(InvalidAggregateReport);
    expect(error.cause).toBeInstanceOf(KeyError);
    expect(error.message).toBe("Missing field: 'org_name'");
  });

  it('testReportMetadataNotAStructureRaises', async () => {
    const xml =
      '<feedback><report_metadata>x</report_metadata>' +
      '<policy_published><domain>x.com</domain></policy_published>' +
      '<record></record></feedback>';
    const error = await rejection(() => parseAggregateReportXml(xml, OFFLINE));
    expect(error).toBeInstanceOf(InvalidAggregateReport);
    expect(error.message).toContain('missing required section');
    expect(error.cause).toBeInstanceOf(PyAttributeError);
  });

  it('testXmlSchemaRegexRejectsRepeatedTagsQuickly', async () => {
    // GHSA-4h9r-c435-j834: the schema-tag regex must run in linear time.
    const start = cpuStart();
    await expect(
      parseAggregateReportXml('<xs:schema'.repeat(500_000), OFFLINE),
    ).rejects.toThrow(InvalidAggregateReport);
    expect(cpuMsSince(start)).toBeLessThan(10_000);
  });

  it('testMinifiedAggregateReportWithSchemaTag', async () => {
    const original = readFileSync(
      samplePath('aggregate/ikea.com!example.de!1538690400!1538776800.xml'),
      'utf-8',
    );
    const minified = original
      .split(/\r\n|\r|\n/u)
      .map(line => line.trim())
      .join('');
    expect(minified).toContain('<xs:schema');
    expect(minified).not.toContain('\n');
    const options = { alwaysUseLocalFiles: true, offline: true };
    const expected = await parseAggregateReportXml(original, options);
    const report = await parseAggregateReportXml(minified, options);
    expect(report.reportMetadata.orgName).toBe(expected.reportMetadata.orgName);
    expect(report.reportMetadata.reportId).toBe(
      expected.reportMetadata.reportId,
    );
    expect(report.records).toHaveLength(expected.records.length);
    expect(report.records.length).toBeGreaterThan(0);
  });

  // GHSA-m47j-wp78-fqjg (parsedmarc 11.1.0).
  const DOCTYPE_SAMPLE = 'aggregate/!example.com!1538204542!1538463818.xml';

  /** The sample with `doctype` after its XML declaration (or `declaration`). */
  function sampleWithDoctype(doctype: string, declaration?: string): string {
    const original = readFileSync(samplePath(DOCTYPE_SAMPLE), 'utf-8');
    expect(original.startsWith('<?xml')).toBe(true);
    const split = original.indexOf('?>') + 2;
    return (
      (declaration ?? original.slice(0, split)) +
      doctype +
      original.slice(split)
    );
  }

  it('testDoctypeIsRejected', async () => {
    // The sample parses without the DOCTYPE, so only it is rejected.
    await parseAggregateReportXml(sampleWithDoctype(''), OFFLINE);
    for (const doctype of [
      '<!DOCTYPE feedback [<!ATTLIST record a CDATA "x">]>',
      '<!DOCTYPE feedback>',
    ]) {
      const error = await rejection(() =>
        parseAggregateReportXml(sampleWithDoctype(doctype), OFFLINE),
      );
      expect(error).toBeInstanceOf(InvalidAggregateReport);
      expect(error.message).toBe(
        'Aggregate reports must not contain a DOCTYPE declaration',
      );
    }
  });

  it('testDoctypeIsRejectedOnTheRecoveryPath', async () => {
    // The malformed declaration makes the first parse fail before Expat
    // reaches the DOCTYPE, so the lxml recovery path applies the check.
    const declaration = '<?xml version="1.0" foo?>';
    const report = await parseAggregateReportXml(
      sampleWithDoctype('', declaration),
      OFFLINE,
    );
    expect(
      report.reportMetadata.errors.some(error =>
        error.startsWith('Invalid XML'),
      ),
    ).toBe(true);
    const error = await rejection(() =>
      parseAggregateReportXml(
        sampleWithDoctype(
          '<!DOCTYPE feedback [<!ATTLIST record a CDATA "x">]>',
          declaration,
        ),
        OFFLINE,
      ),
    );
    expect(error).toBeInstanceOf(InvalidAggregateReport);
    expect(error.message).toContain('DOCTYPE');
  });

  it('rejects a deep left-nested content model on the recovery path quickly, like lxml', async () => {
    // A malformed XML declaration sends the report to the recovery path,
    // which reads the internal subset before the DOCTYPE is rejected.
    const depth = 64_000;
    const model = `${'('.repeat(depth)}a${',b)'.repeat(depth)}`;
    const start = cpuStart();
    const error = await rejection(() =>
      parseAggregateReportXml(
        `<?xml version="x"?><!DOCTYPE a [<!ELEMENT a ${model}>]><a/>`,
        OFFLINE,
      ),
    );
    expect(cpuMsSince(start)).toBeLessThan(2000);
    expect(error).toBeInstanceOf(InvalidAggregateReport);
    expect(error.message).toBe(
      'Invalid XML: no element found: line 1, column 0',
    );
  });

  it('testEmptyDocumentIsInvalid', async () => {
    const error = await rejection(() => parseAggregateReportXml('', OFFLINE));
    expect(error).toBeInstanceOf(InvalidAggregateReport);
  });

  it('testAttlistDefaultAttributeAmplificationIsRejectedQuickly', async () => {
    // 1,000 default attributes on 10,000 <z/> elements (64 KB of XML) made
    // xmltodict build 10 million entries; the DOCTYPE is rejected first.
    const attributes = Array.from(
      { length: 1000 },
      (_, index) => `a${index} CDATA "vvvvvvvvvv"`,
    ).join(' ');
    const xml =
      `<!DOCTYPE feedback [<!ATTLIST z ${attributes}>]>` +
      `<feedback><record>${'<z/>'.repeat(10_000)}</record></feedback>`;
    const start = cpuStart();
    const error = await rejection(() => parseAggregateReportXml(xml, OFFLINE));
    expect(cpuMsSince(start)).toBeLessThan(1000);
    expect(error).toBeInstanceOf(InvalidAggregateReport);
    expect(error.message).toContain('DOCTYPE');
  });

  it('rejects a DOCTYPE that only the rewritten text exposes, like parsedmarc', async () => {
    // xml_header_regex rewrites a line starting with "<?xml " inside a
    // prolog PI, which ends that PI early and turns its "<!DOCTYPE" into a
    // real declaration: the second parse rejects it as an unexpected error.
    const xml = sampleWithDoctype('<?pi \n<?xml y> <!DOCTYPE feedback> ?>');
    const error = await rejection(() => parseAggregateReportXml(xml, OFFLINE));
    expect(error).toBeInstanceOf(InvalidAggregateReport);
    expect(error.message).toBe(
      'Unexpected error: Aggregate reports must not contain a DOCTYPE declaration',
    );
  });
});

// --- TestPolicyPublishedEdgeCases -------------------------------------------

function policyTemplate(
  options: { tag?: string; policyExtra?: string; extraMetadata?: string } = {},
): string {
  const { tag = 'default', policyExtra = '', extraMetadata = '' } = options;
  return `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>example.com</org_name>
    <email>dmarc@example.com</email>
    <report_id>test-${tag}</report_id>
    <date_range><begin>1680000000</begin><end>1680086400</end></date_range>
    ${extraMetadata}
  </report_metadata>
  <policy_published>
    <domain>example.com</domain><p>reject</p>
    ${policyExtra}
  </policy_published>
  <record>
    <row><source_ip>203.0.113.1</source_ip><count>1</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>
  </record>
</feedback>`;
}

const parsePolicy = (
  options: Parameters<typeof policyTemplate>[0],
): Promise<AggregateReport> =>
  parseAggregateReportXml(policyTemplate(options), OFFLINE);

describe('TestPolicyPublishedEdgeCases', () => {
  it('testPolicyPublishedListHandled', async () => {
    const report = await parsePolicy({
      tag: 'np',
      policyExtra: '<np>quarantine</np>',
    });
    expect(report.policyPublished.np).toBe('quarantine');
  });

  it('testNpFieldValues', async () => {
    for (const value of ['none', 'quarantine', 'reject']) {
      const report = await parsePolicy({
        tag: `np-${value}`,
        policyExtra: `<np>${value}</np>`,
      });
      expect(report.policyPublished.np).toBe(value);
    }
  });

  it('testTestingField', async () => {
    for (const value of ['y', 'n']) {
      const report = await parsePolicy({
        tag: `testing-${value}`,
        policyExtra: `<testing>${value}</testing>`,
      });
      expect(report.policyPublished.testing).toBe(value);
    }
  });

  it('testDiscoveryMethodField', async () => {
    for (const value of ['psl', 'treewalk']) {
      const report = await parsePolicy({
        tag: `disc-${value}`,
        policyExtra: `<discovery_method>${value}</discovery_method>`,
      });
      expect(report.policyPublished.discoveryMethod).toBe(value);
    }
  });

  it('testGeneratorField', async () => {
    const report = await parsePolicy({
      tag: 'gen',
      extraMetadata: '<generator>TestGen/1.0</generator>',
    });
    expect(report.reportMetadata.generator).toBe('TestGen/1.0');
  });

  it('testPctFieldNone', async () => {
    const report = await parsePolicy({ tag: 'no-pct' });
    expect(report.policyPublished.pct).toBeNull();
  });

  it('testFoFieldNone', async () => {
    const report = await parsePolicy({ tag: 'no-fo' });
    expect(report.policyPublished.fo).toBeNull();
  });

  it('testReportMetadataErrors', async () => {
    const report = await parsePolicy({
      tag: 'errors',
      extraMetadata: '<error>DNS timeout</error>',
    });
    expect(report.reportMetadata.errors).toContain('DNS timeout');
  });

  it('testReportMetadataErrorsList', async () => {
    const report = await parsePolicy({
      tag: 'errors-list',
      extraMetadata: '<error>error1</error><error>error2</error>',
    });
    expect(report.reportMetadata.errors).toContain('error1');
    expect(report.reportMetadata.errors).toContain('error2');
  });

  it('testRecordParseFailureSkipped', async () => {
    const xml = `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>example.com</org_name>
    <email>dmarc@example.com</email>
    <report_id>bad-records</report_id>
    <date_range><begin>1680000000</begin><end>1680086400</end></date_range>
  </report_metadata>
  <policy_published><domain>example.com</domain><p>none</p></policy_published>
  <record>
    <row><source_ip>203.0.113.1</source_ip><count>1</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>
  </record>
  <record>
    <row><source_ip>bad-ip</source_ip><count>not-a-number</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>
  </record>
</feedback>`;
    const { result: report, messages } = await withLogs(WARNING, () =>
      parseAggregateReportXml(xml, OFFLINE),
    );
    expect(report.records.length).toBeGreaterThanOrEqual(1);
    // Exactly what parsedmarc does: the bad record is skipped with a warning.
    expect(report.records).toHaveLength(1);
    expect(messages).toEqual([
      "Could not parse record: 'bad-ip' does not appear to be an IPv4 or IPv6 address.",
    ]);
  });
});

// --- TestBucketIntervalEdgeCases --------------------------------------------

describe('TestBucketIntervalEdgeCases', () => {
  it('testDayCursorAdjustment', () => {
    // 2024-01-01 23:30Z and 2024-01-03 00:00Z, both in UTC-10.
    const minus10 = -600;
    const begin = new PyDateTime({
      year: 2024,
      month: 1,
      day: 1,
      hour: 13,
      minute: 30,
      utcOffsetMinutes: minus10,
    });
    const end = new PyDateTime({
      year: 2024,
      month: 1,
      day: 2,
      hour: 14,
      utcOffsetMinutes: minus10,
    });
    const buckets = bucketIntervalByDay(begin, end, 100);
    expect(sum(buckets)).toBe(100);
  });
});

// --- TestAggregateReportEdgeCases -------------------------------------------

function minimalAggregateXml(
  options: {
    policyPublished?: string;
    orgName?: string;
    email?: string;
    reason?: string;
    count?: number;
  } = {},
): string {
  const {
    policyPublished = '<policy_published><domain>example.com</domain><p>none</p></policy_published>',
    orgName = 'TestOrg',
    email = 'test@example.com',
    reason = '',
    count = 1,
  } = options;
  return `<?xml version="1.0"?>
    <feedback>
        <report_metadata>
            <org_name>${orgName}</org_name>
            <email>${email}</email>
            <report_id>edge-case</report_id>
            <date_range><begin>1704067200</begin><end>1704153599</end></date_range>
        </report_metadata>
        ${policyPublished}
        <record>
            <row>
                <source_ip>192.0.2.1</source_ip>
                <count>${count}</count>
                <policy_evaluated>
                    <disposition>none</disposition>
                    <dkim>pass</dkim>
                    <spf>pass</spf>
                    ${reason}
                </policy_evaluated>
            </row>
            <identifiers><header_from>example.com</header_from></identifiers>
            <auth_results>
                <spf><domain>example.com</domain><result>pass</result></spf>
            </auth_results>
        </record>
    </feedback>`;
}

describe('TestAggregateReportEdgeCases', () => {
  it('testBytesInputIsDecoded', async () => {
    const xml = new TextEncoder().encode(minimalAggregateXml());
    const report = await parseAggregateReportXml(xml, OFFLINE);
    expect(report.reportMetadata.reportId).toBe('edge-case');
  });

  it('testPolicyPublishedListUsesFirstEntry', async () => {
    const policies =
      '<policy_published><domain>example.com</domain><p>reject</p></policy_published>' +
      '<policy_published><domain>other.example</domain><p>none</p></policy_published>';
    const report = await parseAggregateReportXml(
      minimalAggregateXml({ policyPublished: policies }),
      OFFLINE,
    );
    expect(report.policyPublished.domain).toBe('example.com');
    expect(report.policyPublished.p).toBe('reject');
  });

  it('testUnknownPolicyOverrideTypeWarnsUnderRFC9990', async () => {
    const policies =
      '<policy_published><domain>example.com</domain><p>none</p><np>none</np></policy_published>';
    const reason = '<reason><type>banana</type></reason>';
    const { result: report, output } = await withLogs(WARNING, () =>
      parseAggregateReportXml(
        minimalAggregateXml({ policyPublished: policies, reason }),
        OFFLINE,
      ),
    );
    expect(
      output.some(message =>
        message.includes('Unknown policy override reason type'),
      ),
    ).toBe(true);
    expect(output).toContain(
      "WARNING:tsdmarc:Unknown policy override reason type 'banana' per RFC 9990; expected one of ['local_policy', 'mailing_list', 'other', 'policy_test_mode', 'trusted_forwarder']",
    );
    const reasons = report.records[0]?.policyEvaluated.policyOverrideReasons;
    expect(reasons?.[0]?.type).toBe('banana');
  });

  it('testMissingOrgNameAndEmailIsInvalid', async () => {
    const error = await rejection(() =>
      parseAggregateReportXml(
        minimalAggregateXml({ orgName: '', email: '' }),
        OFFLINE,
      ),
    );
    expect(error).toBeInstanceOf(InvalidAggregateReport);
    expect(error.message).toContain('Organization name is missing');
  });

  it('testMalformedEmailAttributeOnlyIsDiscarded', async () => {
    const xml = minimalAggregateXml().replace(
      '<email>test@example.com</email>',
      '<email xml:lang="en"></email>',
    );
    const report = await parseAggregateReportXml(xml, OFFLINE);
    expect(report.reportMetadata.orgEmail).toBeNull();
  });
});

// --- Port-specific edge cases (expected values from parsedmarc 11.0.5) ------

const GOOD_RECORD =
  '<row><source_ip>192.0.2.1</source_ip><count>1</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers><auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>';

function edgeXml(
  options: {
    record?: string;
    records?: string;
    policyPublished?: string;
    metadataExtra?: string;
    begin?: string;
    end?: string;
    orgName?: string;
    reportId?: string;
  } = {},
): string {
  const {
    record = GOOD_RECORD,
    policyPublished = '<policy_published><domain>example.com</domain><p>none</p></policy_published>',
    metadataExtra = '',
    begin = '1704067200',
    end = '1704153599',
    orgName = '<org_name>TestOrg</org_name>',
    reportId = '<report_id>edge-case</report_id>',
  } = options;
  const records = options.records ?? `<record>${record}</record>`;
  return `<?xml version="1.0"?><feedback><report_metadata>${orgName}<email>test@example.com</email>${reportId}<date_range><begin>${begin}</begin><end>${end}</end></date_range>${metadataExtra}</report_metadata>${policyPublished}${records}</feedback>`;
}

const withRecord = (from: string, to: string): string =>
  GOOD_RECORD.replace(from, to);

async function expectInvalid(
  xml: string,
  message: string | RegExp,
  cause: new (...args: never[]) => Error,
): Promise<void> {
  const error = await rejection(() => parseAggregateReportXml(xml, OFFLINE));
  expect(error).toBeInstanceOf(InvalidAggregateReport);
  if (typeof message === 'string') {
    expect(error.message).toBe(message);
  } else {
    expect(error.message).toMatch(message);
  }
  expect(error.cause).toBeInstanceOf(cause);
}

describe('non-string fields from malformed XML', () => {
  const MISSING_SECTION = 'Report missing required section';

  it('rejects dict-shaped report fields like Python (AttributeError)', async () => {
    await expectInvalid(
      edgeXml({ reportId: '<report_id x="1">abc</report_id>' }),
      MISSING_SECTION,
      PyAttributeError,
    );
    await expectInvalid(
      edgeXml({ orgName: '<org_name x="1">Foo</org_name>' }),
      MISSING_SECTION,
      PyAttributeError,
    );
    await expectInvalid(
      edgeXml({ begin: '<a>1</a>' }),
      MISSING_SECTION,
      PyAttributeError,
    );
    await expectInvalid(
      edgeXml({
        record: withRecord('<dkim>pass</dkim>', '<dkim x="1">PASS</dkim>'),
      }),
      MISSING_SECTION,
      PyAttributeError,
    );
    await expectInvalid(
      edgeXml({
        record: withRecord(
          '<spf>pass</spf></policy_evaluated>',
          '<spf>pass</spf><reason>forwarded</reason></policy_evaluated>',
        ),
      }),
      MISSING_SECTION,
      PyAttributeError,
    );
    await expectInvalid(
      edgeXml({
        record: withRecord(
          '<policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>',
          '<policy_evaluated>x</policy_evaluated>',
        ),
      }),
      MISSING_SECTION,
      PyAttributeError,
    );
  });

  it('maps a single bad record to InvalidAggregateReport', async () => {
    await expectInvalid(
      edgeXml({
        record: withRecord(
          '<source_ip>192.0.2.1</source_ip>',
          '<source_ip><a>1</a></source_ip>',
        ),
      }),
      MISSING_SECTION,
      PyAttributeError,
    );
    await expectInvalid(
      edgeXml({ records: '<record>junk</record>' }),
      MISSING_SECTION,
      PyAttributeError,
    );
    await expectInvalid(
      edgeXml({ records: '<record></record>' }),
      MISSING_SECTION,
      PyAttributeError,
    );
    await expectInvalid(
      edgeXml({ records: '<record><row>x</row></record>' }),
      /^Unexpected error: string indices must be integers, not 'str'/u,
      TypeError,
    );
    await expectInvalid(
      edgeXml({ record: withRecord('<count>1</count>', '<count>abc</count>') }),
      /^Unexpected error: invalid literal for int\(\) with base 10: 'abc'/u,
      PyValueError,
    );
    await expectInvalid(
      edgeXml({ record: withRecord('<count>1</count>', '<count>1.0</count>') }),
      /^Unexpected error: invalid literal for int\(\) with base 10: '1\.0'/u,
      PyValueError,
    );
    await expectInvalid(
      edgeXml({
        record: withRecord(
          '<auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>',
          '<auth_results><spf>domainx</spf><dkim>foo</dkim></auth_results>',
        ),
      }),
      /^Unexpected error: string indices must be integers, not 'str'/u,
      TypeError,
    );
  });

  it('reports missing required elements as missing fields', async () => {
    await expectInvalid(
      edgeXml({ records: '' }),
      "Missing field: 'record'",
      KeyError,
    );
    await expectInvalid(
      edgeXml({ record: withRecord('<dkim>pass</dkim>', '') }),
      "Missing field: 'dkim'",
      KeyError,
    );
    await expectInvalid(
      edgeXml({
        record: withRecord(
          '<identifiers><header_from>example.com</header_from></identifiers>',
          '',
        ),
      }),
      "Missing field: 'identifiers'",
      KeyError,
    );
    await expectInvalid(
      edgeXml({
        record: withRecord(
          '<auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results>',
          '',
        ),
      }),
      "Missing field: 'auth_results'",
      KeyError,
    );
  });

  it('skips bad records of a record list with a warning', async () => {
    const badIp = withRecord(
      '<source_ip>192.0.2.1</source_ip>',
      '<source_ip><a>1</a></source_ip>',
    );
    const badCount = withRecord('<count>1</count>', '<count>abc</count>');
    const { result: report, messages } = await withLogs(WARNING, () =>
      parseAggregateReportXml(
        edgeXml({
          records: [GOOD_RECORD, badIp, badCount, 'junk', '']
            .map(record => `<record>${record}</record>`)
            .join(''),
        }),
        OFFLINE,
      ),
    );
    expect(report.records).toHaveLength(1);
    expect(messages).toEqual([
      "Could not parse record: 'dict' object has no attribute 'lower'",
      "Could not parse record: invalid literal for int() with base 10: 'abc'",
      "Could not parse record: 'str' object has no attribute 'copy'",
      "Could not parse record: 'NoneType' object has no attribute 'copy'",
    ]);
  });

  it('keeps or replaces non-string values like parsedmarc', async () => {
    const headerFromDict = await parseAggregateReportXml(
      edgeXml({
        record: withRecord(
          '<header_from>example.com</header_from>',
          '<header_from lang="x">Example.COM</header_from>',
        ),
      }),
      OFFLINE,
    );
    expect(headerFromDict.records[0]?.identifiers.headerFrom).toBe('');

    const dkimDicts = await parseAggregateReportXml(
      edgeXml({
        record: withRecord(
          '<auth_results>',
          '<auth_results><dkim><domain>Ex.COM</domain><selector x="1">S</selector><result x="2">PASS</result></dkim>',
        ),
      }),
      OFFLINE,
    );
    expect(asJson(dkimDicts.records[0]?.authResults.dkim)).toEqual([
      {
        domain: 'Ex.COM',
        selector: { '@x': '1', '#text': 'S' },
        result: { '@x': '2', '#text': 'PASS' },
        humanResult: null,
      },
    ]);
    const dkimRow = parsedAggregateReportsToCsvRows(dkimDicts)[0];
    expect(dkimRow?.dkim_domains).toBe('ex.com');
    expect(dkimRow?.dkim_selectors).toBe("{'@x': '1', '#text': 's'}");
    expect(dkimRow?.dkim_results).toBe("{'@x': '2', '#text': 'pass'}");

    // envelope_from is backfilled with str(domain).lower().
    const spfDomainDict = await parseAggregateReportXml(
      edgeXml({
        record: withRecord(
          '<spf><domain>example.com</domain>',
          '<spf><domain x="1">EX.com</domain>',
        ),
      }),
      OFFLINE,
    );
    expect(spfDomainDict.records[0]?.identifiers.envelopeFrom).toBe(
      "{'@x': '1', '#text': 'ex.com'}",
    );

    const { result: npDict, messages } = await withLogs(WARNING, () =>
      parseAggregateReportXml(
        edgeXml({
          policyPublished:
            '<policy_published><domain>example.com</domain><p>none</p><np x="1">none</np></policy_published>',
        }),
        OFFLINE,
      ),
    );
    expect(npDict.policyPublished.np).toEqual({ '@x': '1', '#text': 'none' });
    expect(messages).toEqual([
      "Invalid np value: {'@x': '1', '#text': 'none'}",
    ]);
    // Non-str/int/bool CSV values become "".
    expect(parsedAggregateReportsToCsvRows(npDict)[0]?.np).toBe('');

    const generatorDict = await parseAggregateReportXml(
      edgeXml({ metadataExtra: '<generator x="1">Gen</generator>' }),
      OFFLINE,
    );
    expect(generatorDict.reportMetadata.generator).toBe('Gen');

    const emptyExtraContact = await parseAggregateReportXml(
      edgeXml({ metadataExtra: '<extra_contact_info x="1"/>' }),
      OFFLINE,
    );
    expect(emptyExtraContact.reportMetadata.orgExtraContactInfo).toBeNull();

    const emptyVersion = await parseAggregateReportXml(
      edgeXml().replace('<feedback>', '<feedback><version></version>'),
      OFFLINE,
    );
    expect(emptyVersion.xmlSchema).toBeNull();
  });

  it('unwraps an <email> with attributes and derives org_name from it', async () => {
    const report = await parseAggregateReportXml(
      edgeXml({ orgName: '<org_name></org_name>' }).replace(
        '<email>test@example.com</email>',
        '<email x="1">a@Example.org</email>',
      ),
      OFFLINE,
    );
    expect(report.reportMetadata.orgEmail).toBe('a@Example.org');
    expect(report.reportMetadata.orgName).toBe('example.org');
  });

  it('handles org names, report IDs, timestamps and counts like Python', async () => {
    const withSpace = await parseAggregateReportXml(
      edgeXml({ orgName: '<org_name>Foo Bar.com</org_name>' }),
      OFFLINE,
    );
    expect(withSpace.reportMetadata.orgName).toBe('Foo Bar.com');
    const subdomain = await parseAggregateReportXml(
      edgeXml({ orgName: '<org_name>mail.google.com</org_name>' }),
      OFFLINE,
    );
    expect(subdomain.reportMetadata.orgName).toBe('google.com');
    const brackets = await parseAggregateReportXml(
      edgeXml({ reportId: '<report_id>&lt;abc@host&gt;</report_id>' }),
      OFFLINE,
    );
    expect(brackets.reportMetadata.reportId).toBe('abc');
    const fractional = await parseAggregateReportXml(
      edgeXml({ begin: '1704067200.5', end: '1704153599.9' }),
      OFFLINE,
    );
    expect(fractional.reportMetadata.originalTimespanSeconds).toBe(86_399);
    const spaces = await parseAggregateReportXml(
      edgeXml({ record: withRecord('<count>1</count>', '<count> 7 </count>') }),
      OFFLINE,
    );
    expect(spaces.records[0]?.count).toBe(7);
  });

  it('keeps an override reason without a type', async () => {
    const report = await parseAggregateReportXml(
      edgeXml({
        record: withRecord(
          '<spf>pass</spf></policy_evaluated>',
          '<spf>pass</spf><reason><comment>c</comment></reason></policy_evaluated>',
        ),
      }),
      OFFLINE,
    );
    expect(report.records[0]?.policyEvaluated.policyOverrideReasons).toEqual([
      { comment: 'c' },
    ]);
    // parsedmarc's CSV rows read r_["type"], which raises KeyError here and
    // loses the batch (deviation).
    const [row] = parsedAggregateReportsToCsvRows(report);
    expect(row?.policy_override_reasons).toBe('none');
    expect(row?.policy_override_comments).toBe('c');
  });

  it('rejects an empty <reason/> like Python (None has no .get)', async () => {
    await expectInvalid(
      edgeXml({
        record: withRecord(
          '<spf>pass</spf></policy_evaluated>',
          '<spf>pass</spf><reason><type>other</type></reason><reason/></policy_evaluated>',
        ),
      }),
      'Report missing required section',
      PyAttributeError,
    );
  });

  it('skips empty <error> elements', async () => {
    const report = await parseAggregateReportXml(
      edgeXml({ metadataExtra: '<error></error><error>e2</error>' }),
      OFFLINE,
    );
    expect(report.reportMetadata.errors).toEqual(['e2']);
  });
});

describe('record as a single element vs a list', () => {
  it('parses a single <record> (a dict) and a repeated one (a list)', async () => {
    const single = await parseAggregateReportXml(edgeXml(), OFFLINE);
    expect(single.records).toHaveLength(1);
    const list = await parseAggregateReportXml(
      edgeXml({
        records: `<record>${GOOD_RECORD}</record><record>${withRecord('<count>1</count>', '<count>2</count>')}</record>`,
      }),
      OFFLINE,
    );
    expect(list.records.map(record => record.count)).toEqual([1, 2]);
  });
});

describe('keepAlive', () => {
  const manyRecords = (count: number): string =>
    Array.from(
      { length: count },
      (_, index) =>
        `<record>${withRecord('192.0.2.1', `192.0.2.${index + 1}`)}</record>`,
    ).join('');

  it('is called every 20 records, with debug progress logs', async () => {
    let calls = 0;
    const { result: report, output } = await withLogs(DEBUG, () =>
      parseAggregateReportXml(edgeXml({ records: manyRecords(45) }), {
        offline: true,
        keepAlive: () => {
          calls += 1;
        },
      }),
    );
    expect(report.records).toHaveLength(45);
    expect(calls).toBe(2);
    expect(
      output.filter(
        line => line.includes('keepalive') || line.includes('Processed'),
      ),
    ).toEqual([
      'DEBUG:tsdmarc:Sending keepalive cmd',
      'DEBUG:tsdmarc:Processed 20/45',
      'DEBUG:tsdmarc:Sending keepalive cmd',
      'DEBUG:tsdmarc:Processed 40/45',
    ]);
  });

  it('is not called for 20 records or fewer, nor for a single record', async () => {
    let calls = 0;
    const keepAlive = () => {
      calls += 1;
    };
    await parseAggregateReportXml(edgeXml({ records: manyRecords(20) }), {
      offline: true,
      keepAlive,
    });
    await parseAggregateReportXml(edgeXml(), { offline: true, keepAlive });
    expect(calls).toBe(0);
  });

  it('is awaited when it returns a promise', async () => {
    const order: string[] = [];
    await parseAggregateReportXml(edgeXml({ records: manyRecords(21) }), {
      offline: true,
      keepAlive: async () => {
        await Promise.resolve();
        order.push('keepalive');
      },
    });
    order.push('done');
    expect(order).toEqual(['keepalive', 'done']);
  });

  it('rethrows what it throws as is, not as an invalid report', async () => {
    const failure = new Error('NOOP failed');
    const keepAlive = (): never => {
      throw failure;
    };
    const xml = edgeXml({ records: manyRecords(45) });
    await expect(
      parseAggregateReportXml(xml, { offline: true, keepAlive }),
    ).rejects.toBe(failure);
    await expect(
      parseAggregateReportFile(new TextEncoder().encode(xml), {
        offline: true,
        keepAlive,
      }),
    ).rejects.toBe(failure);
  });

  it('is passed through by parseAggregateReportFile', async () => {
    let calls = 0;
    await parseAggregateReportFile(
      new TextEncoder().encode(edgeXml({ records: manyRecords(41) })),
      {
        offline: true,
        keepAlive: () => {
          calls += 1;
        },
      },
    );
    expect(calls).toBe(2);
  });
});

/** Begin/end metadata and record intervals, for timespan tests. */
async function intervals(
  begin: number,
  end: number,
  options: { count?: number; normalizeTimespanThresholdHours?: number } = {},
): Promise<{
  metadata: [string, string, boolean, number | bigint];
  records: [string, string, number | bigint, boolean][];
}> {
  const { count = 100, normalizeTimespanThresholdHours } = options;
  const report = await parseAggregateReportXml(
    edgeXml({
      record: withRecord('<count>1</count>', `<count>${count}</count>`),
      begin: String(begin),
      end: String(end),
    }),
    {
      offline: true,
      ...(normalizeTimespanThresholdHours === undefined
        ? {}
        : { normalizeTimespanThresholdHours }),
    },
  );
  const metadata = report.reportMetadata;
  return {
    metadata: [
      metadata.beginDate,
      metadata.endDate,
      metadata.timespanRequiresNormalization,
      metadata.originalTimespanSeconds,
    ],
    records: report.records.map(record => [
      record.intervalBegin,
      record.intervalEnd,
      record.count,
      record.normalizedTimespan,
    ]),
  };
}

const JAN_1_2024 = 1_704_067_200;

describe('normalizeTimespanThresholdHours boundaries', () => {
  it('normalizes only spans strictly longer than the threshold', async () => {
    await withTzAsync('UTC', async () => {
      const exact = await intervals(JAN_1_2024, JAN_1_2024 + 86_400);
      expect(exact.metadata).toEqual([
        '2024-01-01 00:00:00',
        '2024-01-02 00:00:00',
        false,
        86_400,
      ]);
      expect(exact.records).toEqual([
        ['2024-01-01 00:00:00', '2024-01-02 00:00:00', 100, false],
      ]);

      const over = await intervals(JAN_1_2024, JAN_1_2024 + 86_401);
      expect(over.metadata[2]).toBe(true);
      expect(over.records).toEqual([
        ['2024-01-01 00:00:00', '2024-01-02 00:00:00', 100, true],
      ]);
    });
  });

  it('honors custom and fractional thresholds', async () => {
    await withTzAsync('UTC', async () => {
      const oneHour = { normalizeTimespanThresholdHours: 1 };
      expect(
        (await intervals(JAN_1_2024, JAN_1_2024 + 3600, oneHour)).metadata[2],
      ).toBe(false);
      expect(
        (await intervals(JAN_1_2024, JAN_1_2024 + 3601, oneHour)).records,
      ).toEqual([['2024-01-01 00:00:00', '2024-01-01 01:00:01', 100, true]]);
      const halfHour = { normalizeTimespanThresholdHours: 0.5 };
      expect(
        (await intervals(JAN_1_2024, JAN_1_2024 + 1800, halfHour)).metadata[2],
      ).toBe(false);
      expect(
        (await intervals(JAN_1_2024, JAN_1_2024 + 1801, halfHour)).metadata[2],
      ).toBe(true);
    });
  });

  it('never normalizes zero or negative spans', async () => {
    await withTzAsync('UTC', async () => {
      const zero = await intervals(JAN_1_2024, JAN_1_2024, {
        normalizeTimespanThresholdHours: 0,
      });
      expect(zero.metadata[2]).toBe(false);
      expect(zero.records).toHaveLength(1);
      const negative = await intervals(JAN_1_2024 + 86_400, JAN_1_2024);
      expect(negative.metadata).toEqual([
        '2024-01-02 00:00:00',
        '2024-01-01 00:00:00',
        false,
        -86_400,
      ]);
      expect(negative.records).toEqual([
        ['2024-01-02 00:00:00', '2024-01-01 00:00:00', 100, false],
      ]);
    });
  });

  it('distributes counts over the days a long report covers', async () => {
    await withTzAsync('UTC', async () => {
      // 2024-01-01 12:00Z to 2024-01-04 00:00Z: 12h + 24h + 24h.
      const result = await intervals(JAN_1_2024 + 43_200, JAN_1_2024 + 259_200);
      expect(result.records).toEqual([
        ['2024-01-01 12:00:00', '2024-01-02 00:00:00', 20, true],
        ['2024-01-02 00:00:00', '2024-01-03 00:00:00', 40, true],
        ['2024-01-03 00:00:00', '2024-01-04 00:00:00', 40, true],
      ]);
    });
  });
});

describe('timespans crossing DST (Europe/Warsaw)', () => {
  // begin_date/end_date are local time; interval_* are UTC (parsedmarc
  // converts the local strings back with to_utc=True).
  it('spring forward', async () => {
    await withTzAsync('Europe/Warsaw', async () => {
      const result = await intervals(1_711_753_200, 1_711_922_400);
      expect(result.metadata).toEqual([
        '2024-03-30 00:00:00',
        '2024-04-01 00:00:00',
        true,
        169_200,
      ]);
      expect(result.records).toEqual([
        ['2024-03-29 23:00:00', '2024-03-30 00:00:00', 2, true],
        ['2024-03-30 00:00:00', '2024-03-31 00:00:00', 51, true],
        ['2024-03-31 00:00:00', '2024-03-31 22:00:00', 47, true],
      ]);
    });
  });

  it('spring forward, starting right after the gap', async () => {
    await withTzAsync('Europe/Warsaw', async () => {
      const result = await intervals(1_711_846_800, 1_711_936_800);
      expect(result.metadata).toEqual([
        '2024-03-31 03:00:00',
        '2024-04-01 04:00:00',
        true,
        90_000,
      ]);
      expect(result.records).toEqual([
        ['2024-03-31 01:00:00', '2024-04-01 00:00:00', 92, true],
        ['2024-04-01 00:00:00', '2024-04-01 02:00:00', 8, true],
      ]);
    });
  });

  it('fall back', async () => {
    await withTzAsync('Europe/Warsaw', async () => {
      const result = await intervals(1_729_893_600, 1_730_070_000);
      expect(result.metadata).toEqual([
        '2024-10-26 00:00:00',
        '2024-10-28 00:00:00',
        true,
        176_400,
      ]);
      expect(result.records).toEqual([
        ['2024-10-25 22:00:00', '2024-10-26 00:00:00', 4, true],
        ['2024-10-26 00:00:00', '2024-10-27 00:00:00', 49, true],
        ['2024-10-27 00:00:00', '2024-10-27 23:00:00', 47, true],
      ]);
    });
  });

  it('fall back: ambiguous local times resolve to the first occurrence', async () => {
    await withTzAsync('Europe/Warsaw', async () => {
      // 00:30Z and 01:30Z are both 02:30 local; Python's fold=0 maps the
      // local string back to 00:30Z.
      const short = await intervals(1_729_989_000, 1_729_992_600);
      expect(short.metadata).toEqual([
        '2024-10-27 02:30:00',
        '2024-10-27 02:30:00',
        false,
        3600,
      ]);
      expect(short.records).toEqual([
        ['2024-10-27 00:30:00', '2024-10-27 00:30:00', 100, false],
      ]);
      const long = await intervals(1_729_992_600, 1_730_100_000);
      expect(long.metadata).toEqual([
        '2024-10-27 02:30:00',
        '2024-10-28 08:20:00',
        true,
        107_400,
      ]);
      expect(long.records).toEqual([
        ['2024-10-27 00:30:00', '2024-10-28 00:00:00', 76, true],
        ['2024-10-28 00:00:00', '2024-10-28 07:20:00', 24, true],
      ]);
    });
  });
});

// --- Review findings (fresh-context differential review) --------------------

/**
 * A literal port of Python's `_bucket_interval_by_day` loop (one entry per
 * day), the reference for the grouped implementation.
 */
function bruteForceBuckets(
  begin: PyDateTime,
  end: PyDateTime,
  totalCount: number,
): [string, string, number][] {
  const intervalSeconds = end.secondsSince(begin);
  if (intervalSeconds <= 0 || totalCount === 0) {
    return [];
  }
  let cursor = begin.startOfDay();
  const days: [PyDateTime, PyDateTime, number][] = [];
  while (cursor.compare(end) < 0) {
    const dayEnd = cursor.addSeconds(86_400);
    const start = begin.compare(cursor) > 0 ? begin : cursor;
    const stop = end.compare(dayEnd) < 0 ? end : dayEnd;
    const seconds = stop.secondsSince(start);
    if (seconds > 0) {
      days.push([start, stop, seconds]);
    }
    cursor = dayEnd;
  }
  const exact = days.map(day => (day[2] / intervalSeconds) * totalCount);
  const floors = exact.map(value => Math.trunc(value));
  const remainder = totalCount - floors.reduce((a, b) => a + b, 0);
  // Array.prototype.sort is stable, like Python's sorted(reverse=True).
  const order = days
    .map((_day, index) => index)
    .sort(
      (a, b) =>
        (exact[b] as number) -
        (floors[b] as number) -
        ((exact[a] as number) - (floors[a] as number)),
    );
  const sliceEnd =
    remainder >= 0 ? remainder : Math.max(days.length + remainder, 0);
  const counts = [...floors];
  for (const index of order.slice(0, sliceEnd)) {
    counts[index] = (counts[index] as number) + 1;
  }
  return days.flatMap(([start, stop], index) =>
    (counts[index] as number) > 0
      ? [
          [
            start.strftime('%Y-%m-%d %H:%M:%S'),
            stop.strftime('%Y-%m-%d %H:%M:%S'),
            counts[index] as number,
          ] as [string, string, number],
        ]
      : [],
  );
}

/** A small deterministic PRNG (mulberry32), so failures are reproducible. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('bucketIntervalByDay without a per-day loop', () => {
  const asRows = (begin: PyDateTime, end: PyDateTime, count: number) =>
    bucketIntervalByDay(begin, end, count).map(bucket => [
      bucket.begin.strftime('%Y-%m-%d %H:%M:%S'),
      bucket.end.strftime('%Y-%m-%d %H:%M:%S'),
      bucket.count,
    ]);

  it('equals the per-day algorithm on random intervals and counts', () => {
    const random = prng(20_261_024);
    const counts = [0, 1, 2, 3, 7, 10, 99, 1000, 123_456, 9_007_199_254_740];
    for (let run = 0; run < 1500; run += 1) {
      let begin = Math.floor(random() * 4_000_000_000);
      if (random() < 0.3) {
        // Midnight and one second either side of it.
        begin = begin - (begin % 86_400) + [0, 1, 86_399][run % 3]!;
      }
      const spans = [
        Math.floor(random() * 3 * 86_400),
        Math.floor(random() * 400 * 86_400),
        [0, 1, 86_399, 86_400, 86_401, 172_800][run % 6]!,
      ];
      const span = spans[run % 3]!;
      const count =
        run % 4 === 0
          ? Math.floor(random() * 1_000_000)
          : counts[run % counts.length]!;
      const beginDt = PyDateTime.fromTimestamp(begin, true);
      const endDt = PyDateTime.fromTimestamp(begin + span, true);
      expect(asRows(beginDt, endDt, count)).toEqual(
        bruteForceBuckets(beginDt, endDt, count),
      );
    }
  });

  it('gives earlier days the remainder among equal fractions', () => {
    // 10 full days, 3 messages: Python's stable sort favors days 1-3.
    expect(asRows(utc(2024, 1, 1), utc(2024, 1, 11), 3)).toEqual([
      ['2024-01-01 00:00:00', '2024-01-02 00:00:00', 1],
      ['2024-01-02 00:00:00', '2024-01-03 00:00:00', 1],
      ['2024-01-03 00:00:00', '2024-01-04 00:00:00', 1],
    ]);
  });

  it('handles counts beyond 2^53 with Python int/float arithmetic', () => {
    // Python's float shares round, its int floors are exact, and the
    // negative remainder slices `indices[:remainder]` to nothing.
    const buckets = bucketIntervalByDay(
      utc(2024, 1, 1),
      utc(2024, 1, 3, 12),
      10n ** 25n + 7n,
    );
    expect(buckets.map(bucket => bucket.count)).toEqual([
      4_000_000_000_000_000_469_762_048n,
      4_000_000_000_000_000_469_762_048n,
      2_000_000_000_000_000_234_881_024n,
    ]);
  });

  it('raises OverflowError on 9999-12-31 like Python', () => {
    expect(() =>
      bucketIntervalByDay(utc(9999, 12, 30), utc(9999, 12, 31, 12), 5),
    ).toThrow('date value out of range');
  });

  it('handles a date_range of thousands of years quickly', async () => {
    const records = Array.from(
      { length: 200 },
      () =>
        `<record>${withRecord('<count>1</count>', '<count>5</count>')}</record>`,
    ).join('');
    const started = cpuStart();
    const report = await parseAggregateReportXml(
      edgeXml({ records, begin: '0', end: '253370764800' }),
      OFFLINE,
    );
    expect(cpuMsSince(started)).toBeLessThan(5000);
    expect(report.records).toHaveLength(1000);
    expect(report.records[0]).toMatchObject({
      count: 1,
      intervalBegin: '1970-01-01 00:00:00',
      intervalEnd: '1970-01-02 00:00:00',
    });
  });
});

describe('raw report data keeps its keys', () => {
  it('does not rename camelCase elements or let them overwrite known fields', async () => {
    const record = withRecord(
      '<identifiers><header_from>example.com</header_from></identifiers>',
      '<identifiers><header_from>example.com</header_from><envelopeFrom>camel.example</envelopeFrom><envelope_from>snake.example</envelope_from><toString>x</toString></identifiers>',
    ).replace(
      '</policy_evaluated>',
      '<reason><type>other</type><comment>c</comment><toString>y</toString></reason></policy_evaluated>',
    );
    const report = await parseAggregateReportXml(
      edgeXml({
        record,
        policyPublished:
          '<policy_published><domain>example.com</domain><p><someValue>1</someValue></p></policy_published>',
      }),
      OFFLINE,
    );
    const snake = toSnakeCaseKeys(report) as {
      policy_published: Record<string, unknown>;
      records: Record<string, Record<string, unknown>>[];
    };
    const [first] = snake.records;
    expect(first?.identifiers).toEqual({
      header_from: 'example.com',
      envelopeFrom: 'camel.example',
      envelope_from: 'snake.example',
      toString: 'x',
      envelope_to: null,
    });
    expect(first?.policy_evaluated?.policy_override_reasons).toEqual([
      { type: 'other', comment: 'c', toString: 'y' },
    ]);
    expect(snake.policy_published.p).toEqual({ someValue: '1' });
    expect(report.records[0]?.identifiers.envelopeFrom).toBe('snake.example');
  });
});

describe('Python evaluation order and errors', () => {
  it('drops a record whose RFC 9990 reason type is a dict (unhashable)', async () => {
    const reason =
      '<reason><type lang="en">other</type><comment>c</comment></reason>';
    const records = [
      `<record>${GOOD_RECORD.replace('</policy_evaluated>', `${reason}</policy_evaluated>`)}</record>`,
      `<record>${GOOD_RECORD}</record>`,
    ].join('');
    const { result, messages } = await withLogs(WARNING, () =>
      parseAggregateReportXml(
        edgeXml({ records, metadataExtra: '<generator>x</generator>' }),
        OFFLINE,
      ),
    );
    expect(result.records).toHaveLength(1);
    expect(messages).toContain(
      "Could not parse record: cannot use 'dict' as a set element (unhashable type: 'dict')",
    );
    await expectInvalid(
      edgeXml({
        record: GOOD_RECORD.replace(
          '</policy_evaluated>',
          `${reason}</policy_evaluated>`,
        ),
        metadataExtra: '<generator>x</generator>',
      }),
      "Unexpected error: cannot use 'dict' as a set element (unhashable type: 'dict')",
      TypeError,
    );
  });

  it('reports a missing <email> before later fields, like Python', async () => {
    const xml = edgeXml({ reportId: '' }).replace(
      '<email>test@example.com</email>',
      '',
    );
    await expectInvalid(xml, "Missing field: 'email'", KeyError);
  });

  it('uses Python 3.14 TypeError wording', async () => {
    await expectInvalid(
      edgeXml({
        record: GOOD_RECORD.replace(
          '<identifiers><header_from>example.com</header_from></identifiers>',
          '<identifiers><header_from>a</header_from></identifiers><identifiers><header_from>b</header_from></identifiers>',
        ),
      }),
      'Unexpected error: list indices must be integers or slices, not str',
      TypeError,
    );
    await expectInvalid(
      edgeXml({ policyPublished: '<policy_published/>' }),
      "Unexpected error: argument of type 'NoneType' is not a container or iterable",
      TypeError,
    );
  });

  it('accepts Unicode digits and exact big integers like int()', async () => {
    const arabic = await parseAggregateReportXml(
      edgeXml({
        record: withRecord('<count>1</count>', '<count>١٢</count>'),
      }),
      OFFLINE,
    );
    expect(arabic.records[0]?.count).toBe(12);
    const big = await parseAggregateReportXml(
      edgeXml({
        record: withRecord(
          '<count>1</count>',
          '<count> 999999999999999999999　</count>',
        ),
      }),
      OFFLINE,
    );
    expect(big.records[0]?.count).toBe(999_999_999_999_999_999_999n);
    await expectInvalid(
      edgeXml({ record: withRecord('<count>1</count>', '<count>1﻿</count>') }),
      /^Unexpected error: invalid literal for int\(\) with base 10: '1/u,
      PyValueError,
    );
  });

  it('raises Python errors for out-of-range timestamps', async () => {
    await expectInvalid(
      edgeXml({ begin: '99999999999999999999' }),
      'Unexpected error: timestamp out of range for platform time_t',
      RangeError,
    );
    await expectInvalid(
      edgeXml({ end: '9007199254740993' }),
      'Unexpected error: year must be in 1..9999, not 285428751',
      PyValueError,
    );
  });

  it('writes malformed <reason> fields as text in CSV (deviation)', async () => {
    const parseReason = async (reason: string) =>
      parsedAggregateReportsToCsvRows(
        await parseAggregateReportXml(
          edgeXml({
            record: GOOD_RECORD.replace(
              '</policy_evaluated>',
              `${reason}</policy_evaluated>`,
            ),
          }),
          OFFLINE,
        ),
      )[0];
    expect(
      await parseReason('<reason><type lang="en">other</type></reason>'),
    ).toMatchObject({
      policy_override_comments: 'none',
      policy_override_reasons: 'other',
    });
    expect(
      await parseReason(
        '<reason><type>other</type><comment>a</comment><comment>b</comment></reason>',
      ),
    ).toMatchObject({
      policy_override_comments: "['a', 'b']",
      policy_override_reasons: 'other',
    });
    expect(
      await parseReason(
        '<reason><type>a</type></reason><reason><type>b</type><comment>c</comment></reason>',
      ),
    ).toMatchObject({
      policy_override_comments: 'none|c',
      policy_override_reasons: 'a,b',
    });
    expect(
      await parseReason(
        '<reason><type><x>1</x></type><comment><y>2</y></comment></reason>',
      ),
    ).toMatchObject({
      policy_override_comments: 'none',
      policy_override_reasons: 'none',
    });
  });

  it('matches xmlns prefixes like Python (first character [a-zA-Z_])', async () => {
    const xml = edgeXml().replace(
      '<feedback>',
      '<feedback xmlns:\u00e9a="urn:wrong" xmlns:b="urn:right">',
    );
    const report = await parseAggregateReportXml(xml, OFFLINE);
    expect(report.xmlNamespace).toBe('urn:right');
  });

  it('treats a string as report content, not a path (parse_aggregate_report_file)', async () => {
    const xml = edgeXml();
    const fromText = await parseAggregateReportFile(xml, OFFLINE);
    expect(fromText.reportMetadata.reportId).toBe('edge-case');
    const fromBase64 = await parseAggregateReportFile(
      Buffer.from(xml).toString('base64'),
      OFFLINE,
    );
    expect(fromBase64.reportMetadata.reportId).toBe('edge-case');
  });
});

describe('adversarial XML', () => {
  const nest = (depth: number): string =>
    `${'<x>'.repeat(depth)}v${'</x>'.repeat(depth)}`;
  const withIdentifier = (extra: string): string =>
    edgeXml({
      record: GOOD_RECORD.replace(
        '<header_from>example.com</header_from>',
        `<header_from>example.com</header_from>${extra}`,
      ),
    });

  it('keeps deeply nested raw data that every output can serialize', async () => {
    const report = await parseAggregateReportXml(
      withIdentifier(`<zz>${nest(400)}</zz>`),
      OFFLINE,
    );
    const snake = toSnakeCaseKeys(report);
    expect(JSON.stringify(snake)).toContain('"v"');
    expect(structuredClone(report).records).toHaveLength(1);
    expect(parsedAggregateReportsToCsv(report)).toContain('example.com');
  });

  it('rejects raw data nested deeper than 512 levels', async () => {
    const error = await rejection(() =>
      parseAggregateReportXml(
        withIdentifier(`<zz>${nest(5000)}</zz>`),
        OFFLINE,
      ),
    );
    expect(error).toBeInstanceOf(InvalidAggregateReport);
    expect(error.message).toBe(
      'Invalid XML: report data nested more than 512 levels deep',
    );
  });

  it('accepts a deeply nested <email> with attributes, like parsedmarc', async () => {
    const xml = edgeXml().replace(
      '<email>test@example.com</email>',
      `<email lang="en">${nest(5000)}</email>`,
    );
    const { result, messages } = await withLogs(DEBUG, () =>
      parseAggregateReportXml(xml, OFFLINE),
    );
    expect(result.reportMetadata.orgEmail).toBeNull();
    const discarded = messages.find(message =>
      message.startsWith('Discarding malformed <email> in report_metadata: '),
    );
    expect(discarded).toContain(
      `{'@lang': 'en', 'x': ${"{'x': ".repeat(4999)}'v'`,
    );
  });
});

describe('CSV formula escaping (parsedmarc 11.1.0)', () => {
  it('testAggregateCsvNeutralizesFormulaInOrgName', async () => {
    const payload = '=HYPERLINK("http://evil","x")';
    const escaped = payload.replaceAll('"', '&quot;');
    const xml =
      '<feedback><report_metadata>' +
      `<org_name>${escaped}</org_name>` +
      '<email>a@example.com</email><report_id>r-1</report_id>' +
      '<date_range><begin>1529366400</begin><end>1529452799</end>' +
      '</date_range></report_metadata><policy_published>' +
      '<domain>example.com</domain><p>none</p></policy_published>' +
      '<record><row><source_ip>192.0.2.1</source_ip><count>3</count>' +
      '<policy_evaluated><disposition>none</disposition>' +
      '<dkim>fail</dkim><spf>fail</spf></policy_evaluated></row>' +
      '<identifiers><header_from>example.com</header_from>' +
      '</identifiers><auth_results></auth_results></record></feedback>';
    const report = await parseAggregateReportXml(xml, OFFLINE);
    expect(report.reportMetadata.orgName).toBe(payload);

    let [row] = readCsvDicts(parsedAggregateReportsToCsv(report));
    expect(row?.get('org_name')).toBe(`'${payload}`);
    expect(row?.get('domain')).toBe('example.com');
    expect(row?.get('count')).toBe('3');

    report.reportMetadata.orgName = 'Example-Org Inc.';
    [row] = readCsvDicts(parsedAggregateReportsToCsv(report));
    expect(row?.get('org_name')).toBe('Example-Org Inc.');
  });
});

describe('report size limits (not in parsedmarc)', () => {
  const YEAR_9998 = 253_370_764_800;
  const record = (count: number): string =>
    `<record>${GOOD_RECORD.replace(/<count>\d+<\/count>/u, `<count>${count}</count>`)}</record>`;
  const spanning = (seconds: number, records: string): string =>
    edgeXml({
      begin: '1700000000',
      end: String(1_700_000_000 + seconds),
      records,
    });

  it('rejects a timespan that would expand past maxNormalizedRecords, before building it', async () => {
    const before = process.memoryUsage().heapUsed;
    const xml = edgeXml({
      begin: '0',
      end: String(YEAR_9998),
      records: record(3_000_000).repeat(3),
    });
    await expect(parseAggregateReportXml(xml, OFFLINE)).rejects.toThrow(
      new InvalidAggregateReport(
        'Report needs too many records to normalize its timespan (max_normalized_records)',
      ),
    );
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(
      200 * 1024 * 1024,
    );
  });

  it('counts the buckets of every record against the limit', async () => {
    const days = 10;
    const xml = spanning(days * 86_400, record(1000).repeat(3));
    const report = await parseAggregateReportXml(xml, {
      ...OFFLINE,
      maxNormalizedRecords: 33,
    });
    expect(report.records.length).toBeGreaterThanOrEqual(30);
    await expect(
      parseAggregateReportXml(xml, { ...OFFLINE, maxNormalizedRecords: 29 }),
    ).rejects.toThrow(InvalidAggregateReport);
  });

  it('keeps a legitimate long report and disables the limit with 0', async () => {
    const days = 3000;
    const xml = spanning(days * 86_400, record(1_000_000));
    for (const maxNormalizedRecords of [0, 250_000]) {
      const report = await parseAggregateReportXml(xml, {
        ...OFFLINE,
        maxNormalizedRecords,
      });
      expect(report.records.length).toBeGreaterThanOrEqual(days);
      expect(
        report.records.reduce((sum, item) => sum + Number(item.count), 0),
      ).toBe(1_000_000);
    }
  });

  it('weighs a record by its size: each day copies its results', async () => {
    // 82 KB of XML: 10,000 days of a record with 1,000 DKIM results, which
    // the outputs would repeat in each of 10,000 rows.
    const dkim =
      '<dkim><domain>d.example</domain><selector>s</selector><result>pass</result></dkim>';
    const heavy = (days: number, results: number): string =>
      record(days).replace(
        '<auth_results>',
        `<auth_results>${dkim.repeat(results)}`,
      );
    const start = cpuStart();
    await expect(
      parseAggregateReportXml(spanning(10_000 * 86_400, heavy(10_000, 1000)), {
        ...OFFLINE,
        maxNormalizedRecords: 50_000,
      }),
    ).rejects.toThrow(
      new InvalidAggregateReport(
        'Report needs too many records to normalize its timespan (max_normalized_records)',
      ),
    );
    expect(cpuMsSince(start)).toBeLessThan(2000);
    // A few results weigh like any record.
    const days = 5;
    const report = await parseAggregateReportXml(
      spanning(days * 86_400, heavy(days, 2)),
      { ...OFFLINE, maxNormalizedRecords: days },
    );
    expect(report.records).toHaveLength(days);
  });

  it('weighs the report data that every row copies', async () => {
    // Each row of the CSV and each search document repeats the report's
    // 200 KB of extra_contact_info.
    const days = 20_000;
    const contact = (text: string): string =>
      edgeXml({
        begin: '1700000000',
        end: String(1_700_000_000 + days * 86_400),
        records: record(days),
        metadataExtra: `<extra_contact_info>${text}</extra_contact_info>`,
      });
    const start = cpuStart();
    await expect(
      parseAggregateReportXml(contact('x'.repeat(200_000)), {
        ...OFFLINE,
        maxNormalizedRecords: 50_000,
      }),
    ).rejects.toThrow(InvalidAggregateReport);
    expect(cpuMsSince(start)).toBeLessThan(2000);
    const report = await parseAggregateReportXml(
      contact('mailto:dmarc@example.org'),
      { ...OFFLINE, maxNormalizedRecords: days },
    );
    expect(report.records).toHaveLength(days);
  });

  it('checks the nesting of shared day buckets once', async () => {
    // Every bucket shares the record's 1,000 results: walking them once per
    // bucket took seconds before the report could be returned.
    const results =
      '<dkim><domain>d.example</domain><selector>s</selector><result>pass</result></dkim>'.repeat(
        1000,
      );
    const days = 20_000;
    const xml = spanning(
      days * 86_400,
      record(days).replace('<auth_results>', `<auth_results>${results}`),
    );
    const start = cpuStart();
    const report = await parseAggregateReportXml(xml, {
      ...OFFLINE,
      maxNormalizedRecords: 0,
    });
    expect(cpuMsSince(start)).toBeLessThan(3000);
    expect(report.records).toHaveLength(days);
  });

  it('rejects deep XML at maxXmlDepth without recovering it', async () => {
    const xml = `<feedback>${'<a>'.repeat(2000)}`;
    await expect(
      parseAggregateReportXml(xml, { ...OFFLINE, maxXmlDepth: 1000 }),
    ).rejects.toThrow(
      new InvalidAggregateReport(
        'Invalid XML: XML nests more than 1000 elements',
      ),
    );
  });

  it('accepts unknown deep XML under the default maxXmlDepth', async () => {
    const deep = `${'<a>'.repeat(50_000)}${'</a>'.repeat(50_000)}`;
    const xml = edgeXml().replace('</feedback>', `${deep}</feedback>`);
    await expect(parseAggregateReportXml(xml, OFFLINE)).resolves.toBeDefined();
    await expect(
      parseAggregateReportXml(xml, { ...OFFLINE, maxXmlDepth: 10 }),
    ).rejects.toThrow('XML nests more than 10 elements');
  });

  it('rejects XML over maxXmlNodes, counting attributes', async () => {
    const options = { ...OFFLINE, maxXmlNodes: 1000 };
    await expect(
      parseAggregateReportXml(
        `<feedback>${'<a b=""/>'.repeat(600)}</feedback>`,
        options,
      ),
    ).rejects.toThrow(
      'Invalid XML: XML has more than 1000 elements and attributes',
    );
    const attributes = Array.from({ length: 2000 }, (_, i) => `a${i}=""`);
    await expect(
      parseAggregateReportXml(`<feedback ${attributes.join(' ')}/>`, options),
    ).rejects.toThrow('XML has more than 1000 elements and attributes');
    await expect(
      parseAggregateReportXml(edgeXml(), { ...OFFLINE, maxXmlNodes: 100 }),
    ).resolves.toBeDefined();
  });

  it('also limits the recovered text', async () => {
    // Expat stops at the bad end tag, so only the second pass sees the nodes.
    const xml = `<feedback><x></y>${'<a/>'.repeat(2000)}</feedback>`;
    await expect(
      parseAggregateReportXml(xml, { ...OFFLINE, maxXmlNodes: 1000 }),
    ).rejects.toThrow('XML has more than 1000 elements and attributes');
  });

  it('keeps a large legitimate report under the default limits', async () => {
    const records = record(1).repeat(200_000);
    const report = await parseAggregateReportXml(edgeXml({ records }), OFFLINE);
    expect(report.records).toHaveLength(200_000);
  });
});

describe('source_ip reaches logs sanitized', () => {
  it('rejects an address with a newline before any lookup', async () => {
    const { messages, result } = await withLogs(DEBUG, () =>
      parseAggregateReportXml(
        edgeXml({
          record: GOOD_RECORD.replace(
            /<source_ip>[^<]*<\/source_ip>/u,
            '<source_ip>1.2.3.4&#10;forged line</source_ip>',
          ),
        }),
        { ...OFFLINE, nameservers: ['127.0.0.1'], offline: false },
      ).catch((error: unknown) => error),
    );
    expect(result).toBeInstanceOf(InvalidAggregateReport);
    expect(messages.join(' ')).not.toContain('\nforged line');
  });
});
