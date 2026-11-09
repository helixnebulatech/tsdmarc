import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { InvalidSMTPTLSReport } from './errors';
import { KeyError, PyTypeError } from './internal/py';
import { JSONDecodeError } from './internal/py-json-loads';
import { toSnakeCaseKeys } from './serialize';
import {
  parsedSmtpTlsReportsToCsv,
  parsedSmtpTlsReportsToCsvRows,
  parseSmtpTlsFailureDetails,
  parseSmtpTlsReportJson,
  parseSmtpTlsReportPolicy,
} from './smtp-tls';
import { asJson, loadFixture, samplePath } from './test/fixtures';

const JSON_SAMPLES = [
  'smtp_tls/empty_failure_detail_fields.json',
  'smtp_tls/mail.ru.json',
  'smtp_tls/rfc8460.json',
  'smtp_tls/smtp_tls.json',
];

const parseSample = (relative: string) =>
  parseSmtpTlsReportJson(readFileSync(samplePath(relative)));

describe('SMTP TLS samples match parsedmarc', () => {
  for (const sample of JSON_SAMPLES) {
    it(sample, () => {
      const fixture = loadFixture(sample);
      const report = parseSample(sample);
      expect(asJson(toSnakeCaseKeys(report))).toEqual(fixture.result?.report);
      expect(parsedSmtpTlsReportsToCsv(report)).toBe(fixture.csv);
    });
  }

  it('reads RFC 8460 "additional-information" (rfc8460.json)', () => {
    const report = parseSample('smtp_tls/rfc8460.json');
    const detail = report.policies[0]?.failureDetails?.find(
      d => d.resultType === 'starttls-not-supported',
    );
    expect(detail?.additionalInfoUri).toBe(
      'https://reports.company-x.example/report_info?id=5065427c-23d3#StarttlsNotSupported',
    );
  });

  it('strips NUL from CSV fields', () => {
    const report = parseSample('smtp_tls/smtp_tls.json');
    report.organizationName = 'Example\0Inc.';
    const csv = parsedSmtpTlsReportsToCsv(report);
    expect(csv).not.toContain('\0');
    expect(csv.split('\r\n')[1]?.startsWith('ExampleInc.,')).toBe(true);
  });
});

describe('failure details', () => {
  it('parses the minimal form', () => {
    const result = parseSmtpTlsFailureDetails({
      'failed-session-count': 5,
      'result-type': 'certificate-expired',
    });
    expect(result).toEqual({
      failedSessionCount: 5,
      resultType: 'certificate-expired',
    });
  });

  it('parses every optional field', () => {
    const result = parseSmtpTlsFailureDetails({
      'additional-info-uri': 'https://example.com/info',
      'failed-session-count': 3,
      'failure-reason-code': 'TLS_ERROR',
      'receiving-ip': '10.0.0.2',
      'receiving-mx-helo': 'mx.example.com',
      'receiving-mx-hostname': 'mx.example.com',
      'result-type': 'starttls-not-supported',
      'sending-mta-ip': '10.0.0.1',
    });
    expect(result).toMatchObject({
      additionalInfoUri: 'https://example.com/info',
      failureReasonCode: 'TLS_ERROR',
      receivingIp: '10.0.0.2',
      receivingMxHelo: 'mx.example.com',
      receivingMxHostname: 'mx.example.com',
      sendingMtaIp: '10.0.0.1',
    });
  });

  it('omits blank optional fields (parsedmarc issue #915)', () => {
    const result = parseSmtpTlsFailureDetails({
      'additional-info-uri': '',
      'additional-information': '',
      'failed-session-count': 1,
      'failure-reason-code': '',
      'receiving-ip': '   ',
      'receiving-mx-helo': '\t',
      'receiving-mx-hostname': '',
      'result-type': 'sts-policy-fetch-error',
      'sending-mta-ip': '',
    });
    expect(result).toEqual({
      failedSessionCount: 1,
      resultType: 'sts-policy-fetch-error',
    });
  });

  it('prefers the RFC key and falls back to the legacy one', () => {
    const base = { 'failed-session-count': 1, 'result-type': 'x' };
    expect(
      parseSmtpTlsFailureDetails({
        ...base,
        'additional-information': 'https://example.com/rfc-key-info',
      }).additionalInfoUri,
    ).toBe('https://example.com/rfc-key-info');
    expect(
      parseSmtpTlsFailureDetails({
        ...base,
        'additional-info-uri': 'https://example.com/legacy-key-info',
        'additional-information': 'https://example.com/rfc-key-info',
      }).additionalInfoUri,
    ).toBe('https://example.com/rfc-key-info');
    expect(
      parseSmtpTlsFailureDetails({
        ...base,
        'additional-info-uri': 'https://example.com/legacy-key-info',
        'additional-information': '',
      }).additionalInfoUri,
    ).toBe('https://example.com/legacy-key-info');
  });

  it('rejects a missing required field, naming it', () => {
    expect(() => parseSmtpTlsFailureDetails({ 'result-type': 'err' })).toThrow(
      "Missing required failure details field: 'failed-session-count'",
    );
  });

  it('wraps a non-dict value with a TypeError cause', () => {
    try {
      parseSmtpTlsFailureDetails('not a dict');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidSMTPTLSReport);
      expect((error as Error).cause).toBeInstanceOf(PyTypeError);
    }
  });
});

describe('policies', () => {
  const summary = {
    'total-failure-session-count': 2,
    'total-successful-session-count': 100,
  };

  it('parses a valid STS policy', () => {
    const result = parseSmtpTlsReportPolicy({
      policy: {
        'mx-host-pattern': ['*.example.com'],
        'policy-domain': 'example.com',
        'policy-string': ['version: STSv1', 'mode: enforce'],
        'policy-type': 'sts',
      },
      summary,
    });
    expect(result).toEqual({
      failedSessionCount: 2,
      mxHostPatterns: ['*.example.com'],
      policyDomain: 'example.com',
      policyStrings: ['version: STSv1', 'mode: enforce'],
      policyType: 'sts',
      successfulSessionCount: 100,
    });
  });

  it('rejects an invalid policy type', () => {
    expect(() =>
      parseSmtpTlsReportPolicy({
        policy: { 'policy-domain': 'example.com', 'policy-type': 'invalid' },
        summary,
      }),
    ).toThrow('Invalid policy type invalid');
  });

  // parsedmarc 11.1.0 (sanitize_for_log): the value can't forge log lines.
  it('escapes control characters in an invalid policy type', () => {
    expect(() =>
      parseSmtpTlsReportPolicy({
        policy: {
          'policy-domain': 'example.com',
          'policy-type': 'a\r\nFORGED',
        },
        summary,
      }),
    ).toThrow('Invalid policy type a\\r\\nFORGED');
  });

  it('drops empty policy-string and mx-host-pattern lists', () => {
    const result = parseSmtpTlsReportPolicy({
      policy: {
        'mx-host-pattern': [],
        'policy-domain': 'example.com',
        'policy-string': [],
        'policy-type': 'sts',
      },
      summary,
    });
    expect(result).not.toHaveProperty('policyStrings');
    expect(result).not.toHaveProperty('mxHostPatterns');
  });

  it('parses nested failure details', () => {
    const result = parseSmtpTlsReportPolicy({
      'failure-details': [
        { 'failed-session-count': 1, 'result-type': 'certificate-expired' },
      ],
      policy: { 'policy-domain': 'example.com', 'policy-type': 'sts' },
      summary,
    });
    expect(result.failureDetails).toHaveLength(1);
    expect(result.failureDetails?.[0]?.resultType).toBe('certificate-expired');
  });

  it('rejects a missing required policy field', () => {
    expect(() =>
      parseSmtpTlsReportPolicy({
        policy: { 'policy-type': 'sts' },
        summary: {},
      }),
    ).toThrow("Missing required policy field: 'policy-domain'");
  });
});

describe('parseSmtpTlsReportJson', () => {
  const policies = [
    {
      policy: { 'policy-domain': 'example.com', 'policy-type': 'sts' },
      summary: {
        'total-failure-session-count': 0,
        'total-successful-session-count': 50,
      },
    },
  ];
  const valid = {
    'contact-info': 'admin@example.com',
    'date-range': {
      'end-datetime': '2024-01-02T00:00:00Z',
      'start-datetime': '2024-01-01T00:00:00Z',
    },
    'organization-name': 'Example Corp',
    policies,
    'report-id': 'report-123',
  };

  it('rejects data nested deeper than the outputs can serialize (deviation)', () => {
    const deep = (depth: number): string =>
      `${'['.repeat(depth)}"x"${']'.repeat(depth)}`;
    const report = (depth: number): string =>
      JSON.stringify(valid).replace(
        '"contact-info":"admin@example.com"',
        `"contact-info":"admin@example.com","extra":${deep(depth)}`,
      );
    expect(() => parseSmtpTlsReportJson(report(100_000))).toThrow(
      InvalidSMTPTLSReport,
    );
    expect(() => parseSmtpTlsReportJson(report(100_000))).toThrow(
      'report data nested more than 512 levels deep',
    );
    expect(() => parseSmtpTlsReportJson(report(400))).not.toThrow();
  });

  it('rejects deep text while scanning, before it can fill the heap', () => {
    // Unclosed, so only the scan can reject it; 20 million levels of `[` need
    // 1.6 GB of heap, which a bare heap check below would not survive.
    const text = '['.repeat(20_000_000);
    const before = process.memoryUsage().heapUsed;
    expect(() =>
      parseSmtpTlsReportJson(text, { maxSmtpTlsReportSize: 0 }),
    ).toThrow('report data nested more than 512 levels deep');
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(
      100 * 1024 * 1024,
    );
  });

  it('rejects a report over maxSmtpTlsReportSize before parsing it', () => {
    const text = JSON.stringify(valid);
    const parse = (input: string | Uint8Array, limit: number) =>
      parseSmtpTlsReportJson(input, { maxSmtpTlsReportSize: limit });
    expect(() => parse(text, text.length - 1)).toThrow(InvalidSMTPTLSReport);
    expect(() => parse(text, text.length - 1)).toThrow(
      `SMTP TLS report of ${text.length} bytes exceeds the ${text.length - 1} byte limit`,
    );
    expect(() => parse(Buffer.from(text), text.length - 1)).toThrow(
      InvalidSMTPTLSReport,
    );
    expect(parse(text, text.length).reportId).toBe('report-123');
    expect(parse(text, 0).reportId).toBe('report-123');
    expect(() =>
      parseSmtpTlsReportJson(`[${'{},'.repeat(4_000_000)}{}]`),
    ).toThrow('exceeds the 10485760 byte limit');
  });

  it('accepts a report at the depth limit and rejects one past it', () => {
    const nested = (depth: number): string =>
      JSON.stringify(valid).replace(
        '"contact-info":"admin@example.com"',
        `"contact-info":"admin@example.com","extra":${'['.repeat(depth)}1${']'.repeat(depth)}`,
      );
    expect(() => parseSmtpTlsReportJson(nested(511))).not.toThrow();
    expect(() => parseSmtpTlsReportJson(nested(512))).toThrow(
      InvalidSMTPTLSReport,
    );
  });

  it("rejects integers over Python's 4300 digits and keeps smaller ones", () => {
    const report = JSON.stringify({
      ...valid,
      policies: [
        {
          policy: { 'policy-domain': 'd', 'policy-type': 'sts' },
          summary: {
            'total-failure-session-count': 0,
            'total-successful-session-count': 0,
          },
        },
      ],
    });
    const withCount = (digits: number): string =>
      report.replace(
        '"total-successful-session-count":0',
        `"total-successful-session-count":${'1'.repeat(digits)}`,
      );
    expect(() => parseSmtpTlsReportJson(withCount(4301))).toThrow(
      'Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits',
    );
    expect(() => parseSmtpTlsReportJson(withCount(4301))).toThrow(
      InvalidSMTPTLSReport,
    );
    expect(
      parseSmtpTlsReportJson(withCount(4300)).policies[0]
        ?.successfulSessionCount,
    ).toBe(BigInt('1'.repeat(4300)));
  });

  it('parses a valid report, from text or bytes', () => {
    const fromText = parseSmtpTlsReportJson(JSON.stringify(valid));
    expect(fromText.organizationName).toBe('Example Corp');
    expect(fromText.reportId).toBe('report-123');
    expect(fromText.policies).toHaveLength(1);
    const fromBytes = parseSmtpTlsReportJson(
      new TextEncoder().encode(JSON.stringify(valid)),
    );
    expect(fromBytes).toEqual(fromText);
  });

  it('testParseSmtpTlsReportJsonBytes: a tlsa policy, from bytes', () => {
    const report = {
      'organization-name': 'Org',
      'date-range': {
        'start-datetime': '2024-01-01',
        'end-datetime': '2024-01-02',
      },
      'contact-info': 'a@b.com',
      'report-id': 'r1',
      policies: [
        {
          policy: { 'policy-type': 'tlsa', 'policy-domain': 'a.com' },
          summary: {
            'total-successful-session-count': 1,
            'total-failure-session-count': 0,
          },
        },
      ],
    };
    const result = parseSmtpTlsReportJson(
      new TextEncoder().encode(JSON.stringify(report)),
    );
    expect(result.organizationName).toBe('Org');
    expect(result.policies[0]?.policyType).toBe('tlsa');
  });

  it('rejects missing top-level fields', () => {
    expect(() =>
      parseSmtpTlsReportJson(JSON.stringify({ policies: [] })),
    ).toThrow('Missing required field: organization-name]');
    expect(() =>
      parseSmtpTlsReportJson(JSON.stringify({ 'organization-name': 'Org' })),
    ).toThrow(InvalidSMTPTLSReport);
  });

  it('rejects invalid JSON, keeping the cause', () => {
    try {
      parseSmtpTlsReportJson('not json {{{');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidSMTPTLSReport);
      expect((error as Error).cause).toBeInstanceOf(JSONDecodeError);
      expect((error as Error).message).toBe(
        'Expecting value: line 1 column 1 (char 0)',
      );
    }
  });

  it('names a missing nested field', () => {
    try {
      parseSmtpTlsReportJson(
        JSON.stringify({ ...valid, 'date-range': {}, policies: [] }),
      );
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('start-datetime');
      expect((error as Error).cause).toBeInstanceOf(KeyError);
    }
  });

  it('rejects non-list policies like Python', () => {
    expect(() =>
      parseSmtpTlsReportJson(
        JSON.stringify({ ...valid, policies: 'not-a-list' }),
      ),
    ).toThrow("policies must be a list, not <class 'str'>");
  });
});

describe('review findings: Python semantics', () => {
  const report = (
    overrides: Record<string, unknown> = {},
    policyType: unknown = 'sts',
  ) =>
    JSON.stringify({
      'contact-info': 'x',
      'date-range': {
        'end-datetime': '2024-01-01T23:59:59Z',
        'start-datetime': '2024-01-01T00:00:00Z',
      },
      'organization-name': 'O',
      policies: [
        {
          policy: {
            'policy-domain': 'd',
            'policy-string': ['a', 'b'],
            'policy-type': policyType,
          },
          summary: {
            'total-failure-session-count': 0,
            'total-successful-session-count': 1,
          },
        },
      ],
      'report-id': 'r',
      ...overrides,
    }).replace(
      '"total-successful-session-count":1',
      '"total-successful-session-count":18446744073709551616',
    );

  it('keeps big integers as Python does', () => {
    const parsed = parseSmtpTlsReportJson(report());
    expect(parsed.policies[0]?.successfulSessionCount).toBe(
      18_446_744_073_709_551_616n,
    );
  });

  // parsedmarc accepts these, and they then fail in the outputs (deviation).
  it.each([
    ['organization-name', { 'organization-name': 5 }, 'must be a string'],
    ['report-id', { 'report-id': { a: 1 } }, 'must be a string'],
    ['contact-info', { 'contact-info': { a: 1 } }, 'must be a string'],
    ['contact-info item', { 'contact-info': [1] }, 'must be a string'],
    [
      'start-datetime',
      { 'date-range': { 'end-datetime': 'x', 'start-datetime': 5 } },
      'must be a string',
    ],
    [
      'end-datetime',
      {
        'date-range': {
          'end-datetime': 'not a date',
          'start-datetime': '2024-01-01T00:00:00Z',
        },
      },
      'is not a valid date-time',
    ],
    [
      'long start-datetime',
      {
        'date-range': {
          'end-datetime': '2024-01-01T00:00:00Z',
          'start-datetime': `12:34.${'1'.repeat(1000)}`,
        },
      },
      'is not a valid date-time',
    ],
  ])('rejects a bad %s', (_field, overrides, message) => {
    expect(() => parseSmtpTlsReportJson(report(overrides))).toThrow(
      InvalidSMTPTLSReport,
    );
    expect(() => parseSmtpTlsReportJson(report(overrides))).toThrow(message);
  });

  it.each([
    ['policy-string', { 'policy-string': [1] }, {}],
    ['mx-host-pattern', { 'mx-host-pattern': [{ a: 1 }] }, {}],
    ['policy-domain', { 'policy-domain': 1 }, {}],
    ['count', {}, { 'total-failure-session-count': 1.5 }],
    ['count', {}, { 'total-successful-session-count': '3' }],
    ['count', {}, { 'total-successful-session-count': true }],
  ])('rejects a bad policy %s', (_field, info, summary) => {
    const policy = {
      policy: { 'policy-domain': 'd', 'policy-type': 'sts', ...info },
      summary: {
        'total-failure-session-count': 0,
        'total-successful-session-count': 1,
        ...summary,
      },
    };
    expect(() => parseSmtpTlsReportPolicy(policy)).toThrow(
      InvalidSMTPTLSReport,
    );
    expect(() =>
      parseSmtpTlsReportJson(report({ policies: [policy] })),
    ).toThrow(InvalidSMTPTLSReport);
  });

  it('rejects bad failure details and keeps scalar optional fields', () => {
    const details = { 'failed-session-count': 1, 'result-type': 'x' };
    expect(() =>
      parseSmtpTlsFailureDetails({ ...details, 'result-type': 1 }),
    ).toThrow(InvalidSMTPTLSReport);
    expect(() =>
      parseSmtpTlsFailureDetails({ ...details, 'failed-session-count': 'x' }),
    ).toThrow(InvalidSMTPTLSReport);
    expect(() =>
      parseSmtpTlsFailureDetails({ ...details, 'receiving-ip': { a: 1 } }),
    ).toThrow(InvalidSMTPTLSReport);
    expect(() =>
      parseSmtpTlsFailureDetails({ ...details, 'additional-information': [1] }),
    ).toThrow(InvalidSMTPTLSReport);
    expect(
      parseSmtpTlsFailureDetails({ ...details, 'failure-reason-code': 451 })
        .failureReasonCode,
    ).toBe(451);
  });

  it('prints an invalid policy type with str()', () => {
    for (const [value, text] of [
      [{ summary: 'tlsa' }, "{'summary': 'tlsa'}"],
      [null, 'None'],
      [[1], '[1]'],
      [true, 'True'],
    ] as const) {
      expect(() => parseSmtpTlsReportJson(report({}, value))).toThrow(
        `Invalid policy type ${text}`,
      );
    }
  });

  it('keeps a UTF-8 BOM and rejects it like json.loads', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(report()),
    ]);
    expect(() => parseSmtpTlsReportJson(new Uint8Array(bytes))).toThrow(
      'Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)',
    );
  });
});

describe('CSV rows of several policies (deviation)', () => {
  it('does not carry policy strings or MX patterns into the next policy', () => {
    const base = {
      failureDetails: [],
      failedSessionCount: 0,
      successfulSessionCount: 1,
    };
    const rows = parsedSmtpTlsReportsToCsvRows({
      beginDate: '2024-01-01T00:00:00Z',
      contactInfo: 'x',
      endDate: '2024-01-01T23:59:59Z',
      organizationName: 'O',
      policies: [
        {
          ...base,
          mxHostPatterns: ['mx.a.example'],
          policyDomain: 'a.example',
          policyStrings: ['version: STSv1'],
          policyType: 'sts',
        },
        {
          ...base,
          failureDetails: [{ failedSessionCount: 1, resultType: 'x' }],
          policyDomain: 'b.example',
          policyType: 'no-policy-found',
        },
      ],
      reportId: 'r',
    });
    expect(rows.map(row => row.policy_strings)).toEqual([
      'version: STSv1',
      undefined,
      undefined,
    ]);
    expect(rows.map(row => row.mx_host_patterns)).toEqual([
      'mx.a.example',
      undefined,
      undefined,
    ]);
  });
});

describe('CSV formula escaping (parsedmarc 11.1.0)', () => {
  it('testSmtpTlsCsvNeutralizesFormulaInOrganizationName', () => {
    const report = parseSample('smtp_tls/smtp_tls.json');
    report.organizationName = '+1-555-0100';
    const csv = parsedSmtpTlsReportsToCsv(report);
    const header = csv.split('\r\n')[0]?.split(',') ?? [];
    const row = csv.split('\r\n')[1]?.split(',') ?? [];
    expect(row[header.indexOf('organization_name')]).toBe("'+1-555-0100");
  });

  it('testSmtpTlsPolicyTypeControlCharactersEscapedInError', () => {
    const report = JSON.stringify({
      'organization-name': 'Example',
      'date-range': {
        'start-datetime': '2016-04-01T00:00:00Z',
        'end-datetime': '2016-04-01T23:59:59Z',
      },
      'contact-info': 'tls@example.com',
      'report-id': 'r-1',
      policies: [
        {
          policy: {
            'policy-type': 'sts\r\nWARNING:cli.py:1:INJECTED',
            'policy-domain': 'example.com',
          },
          summary: {
            'total-successful-session-count': 1,
            'total-failure-session-count': 0,
          },
        },
      ],
    });
    let message = '';
    try {
      parseSmtpTlsReportJson(report);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidSMTPTLSReport);
      message = (error as Error).message;
    }
    expect(message).toContain('sts\\r\\nWARNING:cli.py:1:INJECTED');
    expect(message).not.toContain('\r');
    expect(message).not.toContain('\n');
  });
});
