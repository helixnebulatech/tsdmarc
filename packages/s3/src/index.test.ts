// Port of tests/test_s3.py. The AWS SDK's S3Client is the SDK boundary;
// PutObjectCommand is the real one, so its `input` is what would be sent.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  GetObjectCommand,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  type AggregateReport,
  captureLogs,
  type FailureReport,
  parseAggregateReportXml,
  parseReportFile,
  type SMTPTLSReport,
  toCamelCaseKeys,
} from 'tsdmarc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { S3Client } from './index';

const aws = vi.hoisted(() => {
  const instances: FakeS3[] = [];
  class FakeS3 {
    readonly config: Record<string, unknown>;
    readonly send = vi.fn((_command: unknown) => Promise.resolve({}));
    readonly destroy = vi.fn();
    constructor(config: Record<string, unknown>) {
      this.config = config;
      instances.push(this);
    }
  }
  return { FakeS3, instances };
});

type FakeS3 = InstanceType<typeof aws.FakeS3>;

vi.mock('@aws-sdk/client-s3', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  S3Client: aws.FakeS3,
}));

const ORG_EMAIL = aggregateReport().reportMetadata.orgEmail;

function aggregateReport(): AggregateReport {
  return {
    reportMetadata: {
      orgName: 'example.com',
      orgEmail: 'dmarc@example.com',
      reportId: 'agg-123',
      beginDate: '2024-01-15 00:00:00',
      endDate: '2024-01-16 00:00:00',
      // Not in metadataKeys: must NOT appear on the S3 object.
      errors: [],
    },
    policyPublished: { domain: 'example.com', p: 'none' },
    records: [],
  } as unknown as AggregateReport;
}

function failureReport(): FailureReport {
  return {
    feedbackType: 'auth-failure',
    arrivalDate: 'Mon, 15 Jan 2024 10:30:00 +0000',
    arrivalDateUtc: '2024-01-15 10:30:00',
    reportedDomain: 'example.com',
    sample: 'From: a@example.com\r\n\r\nbody',
    parsedSample: { subject: 'x' },
  } as unknown as FailureReport;
}

function smtpTlsReport(): SMTPTLSReport {
  return {
    organizationName: 'example.com',
    beginDate: '2024-02-03T00:00:00Z',
    endDate: '2024-02-04T00:00:00Z',
    reportId: 'tls-456',
    contactInfo: 'tls-admin@example.com',
    policies: [],
  };
}

function client(): S3Client {
  return new S3Client('b', 'dmarc', {
    regionName: 'us-east-1',
    endpointUrl: 'https://s3.example.com',
    accessKeyId: 'k',
    secretAccessKey: 's',
  });
}

function sdkOf(s3Client: S3Client): FakeS3 {
  return s3Client.s3 as unknown as FakeS3;
}

function putInput(s3Client: S3Client): {
  Bucket: string;
  Key: string;
  Body: string;
  Metadata: Record<string, string>;
} {
  const sdk = sdkOf(s3Client);
  expect(sdk.send).toHaveBeenCalledTimes(1);
  const command = sdk.send.mock.calls[0]?.[0] as PutObjectCommand;
  return command.input as ReturnType<typeof putInput>;
}

beforeEach(() => {
  aws.instances.length = 0;
});

describe('S3Client init', () => {
  // A regression in argument wiring would send reports to the wrong bucket
  // or authenticate as the wrong principal.
  it('forwards region, endpoint and credentials to the SDK', () => {
    new S3Client('my-bucket', 'dmarc', {
      regionName: 'us-east-1',
      endpointUrl: 'https://s3.example.com',
      accessKeyId: 'AKIA-test',
      secretAccessKey: 'secret-test',
    });
    expect(aws.instances).toHaveLength(1);
    expect(aws.instances[0]?.config).toEqual({
      region: 'us-east-1',
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' },
      requestHandler: { connectionTimeout: 60_000, socketTimeout: 60_000 },
    });
  });

  // boto3 defaults to 60 s connect / 60 s read timeouts; the SDK has none,
  // so a stalled endpoint would hang the save forever.
  it("uses boto3's default connect and read timeouts", () => {
    new S3Client('my-bucket', 'dmarc');
    expect(aws.instances[0]?.config.requestHandler).toEqual({
      connectionTimeout: 60_000,
      socketTimeout: 60_000,
    });
  });

  it('leaves credentials to the default chain and falls back to us-east-1', async () => {
    new S3Client('my-bucket', 'dmarc', {
      regionName: null,
      endpointUrl: null,
      accessKeyId: null,
      secretAccessKey: null,
    });
    const config = aws.instances[0]?.config ?? {};
    expect(Object.keys(config)).toEqual(['region', 'requestHandler']);
    // The fake SDK client has no region chain, so the boto3 default applies.
    const region = config.region as () => Promise<string>;
    await expect(region()).resolves.toBe('us-east-1');
  });

  // The SDK calls the region provider for every request; the default chain
  // lookup must not build a new SDK client (and leak its sockets) each time.
  it('looks the default region up once and releases the probe client', async () => {
    new S3Client('my-bucket', 'dmarc');
    const region = aws.instances[0]?.config.region as () => Promise<string>;
    await region();
    await region();
    await region();
    expect(aws.instances).toHaveLength(2);
    expect(aws.instances[1]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('sends saves to the configured bucket', async () => {
    const s3Client = new S3Client('my-bucket', 'dmarc');
    await s3Client.saveAggregateReportToS3(aggregateReport());
    expect(putInput(s3Client).Bucket).toBe('my-bucket');
  });

  it('overwrites without conditions by default, like parsedmarc', async () => {
    const s3Client = client();
    expect(s3Client.preventOverwrite).toBe(false);
    await s3Client.saveAggregateReportToS3(aggregateReport());
    expect(putInput(s3Client)).not.toHaveProperty('IfNoneMatch');
  });
});

const HASH_SUFFIX = String.raw`_[0-9a-f]{16}\.json`;

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\/]/gu, String.raw`\$&`);
}

async function aggregateKey(
  report: AggregateReport,
  bucketPath = 'dmarc',
): Promise<string> {
  const s3Client = new S3Client('b', bucketPath, { regionName: 'us-east-1' });
  await s3Client.saveAggregateReportToS3(report);
  return putInput(s3Client).Key;
}

/** The last key segment for an aggregate report with `reportId`. */
async function aggregateKeySegment(reportId: string): Promise<string> {
  const report = aggregateReport();
  report.reportMetadata.reportId = reportId;
  return (await aggregateKey(report)).split('/').at(-1) ?? '';
}

describe('S3Client save paths and metadata', () => {
  // The key is built from begin_date, report_id and a hash of the fields
  // that identify the report. Wrong format means unfindable reports; wrong
  // metadata filtering leaks data onto the object.
  it('puts aggregate reports under the aggregate path', async () => {
    const s3Client = client();
    const logs = captureLogs();
    try {
      await s3Client.saveAggregateReportToS3(aggregateReport());
      expect(logs.output).toContain(
        'DEBUG:tsdmarc:Saving aggregate report to s3://b/dmarc/aggregate/year=2024/month=01/day=15/agg-123_f80ea35e1b3f6ad4.json',
      );
    } finally {
      logs.restore();
    }
    expect(putInput(s3Client).Key).toMatch(
      new RegExp(
        String.raw`^dmarc/aggregate/year=2024/month=01/day=15/agg-123${HASH_SUFFIX}$`,
        'u',
      ),
    );
  });

  it('keeps the backward-compatible forensic alias', async () => {
    const s3Client = client();
    await s3Client.saveForensicReportToS3(failureReport());
    expect(putInput(s3Client).Key).toMatch(/^dmarc\/failure\//u);
  });

  it('uses the SMTP TLS report begin_date', async () => {
    // SMTP TLS reports are flat (no report_metadata) and begin_date is the
    // ISO string from the report JSON (RFC 8460 §4.3).
    const s3Client = client();
    await s3Client.saveSmtpTlsReportToS3(smtpTlsReport());
    expect(putInput(s3Client).Key).toMatch(
      new RegExp(
        String.raw`^dmarc/smtp_tls/year=2024/month=02/day=03/tls-456${HASH_SUFFIX}$`,
        'u',
      ),
    );
  });

  it('builds SMTP TLS metadata from the flat report fields', async () => {
    // organization_name is renamed to org_name for consistency with DMARC.
    const s3Client = client();
    await s3Client.saveSmtpTlsReportToS3(smtpTlsReport());
    expect(putInput(s3Client).Metadata).toEqual({
      org_name: 'example.com',
      report_id: 'tls-456',
      begin_date: '2024-02-03T00:00:00Z',
      end_date: '2024-02-04T00:00:00Z',
    });
  });

  it('serializes the snake_case report as the body', async () => {
    const s3Client = client();
    await s3Client.saveAggregateReportToS3(aggregateReport());
    expect(JSON.parse(putInput(s3Client).Body)).toEqual({
      report_metadata: {
        org_name: 'example.com',
        org_email: ORG_EMAIL,
        report_id: 'agg-123',
        begin_date: '2024-01-15 00:00:00',
        end_date: '2024-01-16 00:00:00',
        errors: [],
      },
      policy_published: { domain: 'example.com', p: 'none' },
      records: [],
    });
  });

  it('round-trips a real fixture report', async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../../fixtures/smtp_tls/rfc8460.json.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { result: { report: Record<string, unknown> } };
    const s3Client = client();
    await s3Client.saveSmtpTlsReportToS3(
      toCamelCaseKeys(fixture.result.report) as SMTPTLSReport,
    );
    expect(JSON.parse(putInput(s3Client).Body)).toEqual(fixture.result.report);
  });

  it('filters metadata to the documented keys only', async () => {
    // Other report_metadata fields could leak large or sensitive payloads.
    const s3Client = client();
    const report = aggregateReport() as unknown as {
      reportMetadata: Record<string, unknown>;
    };
    report.reportMetadata.errors = ['a', 'b'];
    report.reportMetadata.internalDiag = 'secret';
    report.reportMetadata.orgExtraContactInfo = null;
    await s3Client.saveAggregateReportToS3(
      report as unknown as AggregateReport,
    );
    expect(putInput(s3Client).Metadata).toEqual({
      org_name: 'example.com',
      org_email: ORG_EMAIL,
      report_id: 'agg-123',
      begin_date: '2024-01-15 00:00:00',
      end_date: '2024-01-16 00:00:00',
    });
  });

  it('drops null metadata values', async () => {
    const s3Client = client();
    const report = aggregateReport() as unknown as {
      reportMetadata: Record<string, unknown>;
    };
    report.reportMetadata.orgEmail = null;
    await s3Client.saveAggregateReportToS3(
      report as unknown as AggregateReport,
    );
    expect(putInput(s3Client).Metadata).not.toHaveProperty('org_email');
  });
});

describe('S3Client key hash', () => {
  // Two different reports sharing a report ID go to different objects,
  // while a retry of the same report overwrites its own object.
  it('keeps the punctuation of real report IDs', async () => {
    for (const reportId of [
      'agg-123',
      'example.com:1538463741',
      `dmarc${'@'}example.com`,
      '2024-01-09T00:00:00Z_example.com',
    ]) {
      const report = aggregateReport();
      report.reportMetadata.reportId = reportId;
      // oxlint-disable-next-line no-await-in-loop -- one save per case
      const key = await aggregateKey(report);
      expect(key.startsWith('dmarc/aggregate/year=2024/month=01/day=15/')).toBe(
        true,
      );
      expect(key.split('/').at(-1)).toMatch(
        new RegExp(`^${escapeRegExp(reportId)}${HASH_SUFFIX}$`, 'u'),
      );
    }
  });

  it('pins the hash recipe', async () => {
    // sha256('["aggregate","example.com","agg-123","example.com",
    // "2024-01-15 00:00:00","2024-01-16 00:00:00"]')[:16]. Changing it
    // moves every object.
    const canonical = JSON.stringify([
      'aggregate',
      'example.com',
      'agg-123',
      'example.com',
      '2024-01-15 00:00:00',
      '2024-01-16 00:00:00',
    ]);
    expect(
      createHash('sha256').update(canonical).digest('hex').slice(0, 16),
    ).toBe('f80ea35e1b3f6ad4');
    expect(await aggregateKey(aggregateReport())).toBe(
      'dmarc/aggregate/year=2024/month=01/day=15/agg-123_f80ea35e1b3f6ad4.json',
    );
  });

  it('ignores enrichment', async () => {
    const first = aggregateReport() as unknown as Record<string, unknown>;
    first.records = [{ source: { ipAddress: '192.0.2.1', reverseDns: null } }];
    const second = structuredClone(first);
    second.records = [
      {
        source: {
          ipAddress: '192.0.2.1',
          reverseDns: 'mail.example.net',
          country: 'US',
        },
      },
    ];
    expect(await aggregateKey(first as unknown as AggregateReport)).toBe(
      await aggregateKey(second as unknown as AggregateReport),
    );
  });

  it('separates reports sharing a report ID', async () => {
    const baseKey = await aggregateKey(aggregateReport());
    const variants: [string, (report: AggregateReport) => void][] = [
      [
        'domain',
        r => Object.assign(r.policyPublished, { domain: 'other.example' }),
      ],
      [
        'begin_date',
        r =>
          Object.assign(r.reportMetadata, { beginDate: '2024-01-15 06:00:00' }),
      ],
      [
        'end_date',
        r =>
          Object.assign(r.reportMetadata, { endDate: '2024-01-17 00:00:00' }),
      ],
      [
        'org_name',
        r => Object.assign(r.reportMetadata, { orgName: 'attacker.example' }),
      ],
    ];
    for (const [, change] of variants) {
      const report = aggregateReport();
      change(report);
      // oxlint-disable-next-line no-await-in-loop -- one save per case
      const key = await aggregateKey(report);
      expect(key.slice(0, key.lastIndexOf('_'))).toBe(
        baseKey.slice(0, baseKey.lastIndexOf('_')),
      );
      expect(key).not.toBe(baseKey);
    }
  });

  it('hashes the SMTP TLS policy domains, in any order', async () => {
    const keyFor = async (...domains: string[]): Promise<string> => {
      const s3Client = client();
      const report = smtpTlsReport();
      report.policies = domains.map(
        policyDomain => ({ policyDomain }) as SMTPTLSReport['policies'][number],
      );
      await s3Client.saveSmtpTlsReportToS3(report);
      return putInput(s3Client).Key;
    };
    expect(await keyFor('a.example')).not.toBe(await keyFor('b.example'));
    expect(await keyFor('a.example', 'b.example')).toBe(
      await keyFor('b.example', 'a.example'),
    );
  });
});

describe('S3Client key sanitization', () => {
  // The report ID is sender-controlled: it is percent-encoded into one key
  // segment so it can't add path segments, carry characters AWS says to
  // avoid, or push the key past S3's 1,024-byte limit.
  it('keeps a traversal report ID in one segment', async () => {
    const report = aggregateReport();
    report.reportMetadata.reportId = '../../etc/passwd';
    const key = await aggregateKey(report);
    const normalKey = await aggregateKey(aggregateReport());
    expect(key.split('/')).toHaveLength(normalKey.split('/').length);
    expect(key).toMatch(
      new RegExp(
        String.raw`^dmarc/aggregate/year=2024/month=01/day=15/\.\.%2F\.\.%2Fetc%2Fpasswd${HASH_SUFFIX}$`,
        'u',
      ),
    );
  });

  it('encodes "/", the AWS characters to avoid, controls and non-ASCII', async () => {
    const cases: Record<string, string> = {
      'a/b': 'a%2Fb',
      'a{b}': 'a%7Bb%7D',
      'a^b': 'a%5Eb',
      'a[b]': 'a%5Bb%5D',
      'a"b': 'a%22b',
      'a<b>': 'a%3Cb%3E',
      'a~b': 'a%7Eb',
      'a#b': 'a%23b',
      'a|b': 'a%7Cb',
      'a`b': 'a%60b',
      'a\\b': 'a%5Cb',
      'a%b': 'a%25b',
      'a\r\nb': 'a%0D%0Ab',
      'a\u0000b': 'a%00b',
      'a\u007Fb': 'a%7Fb',
      café: 'caf%C3%A9',
    };
    for (const [reportId, encoded] of Object.entries(cases)) {
      // oxlint-disable-next-line no-await-in-loop -- one save per case
      const segment = await aggregateKeySegment(reportId);
      expect(segment).toMatch(
        new RegExp(`^${escapeRegExp(encoded)}${HASH_SUFFIX}$`, 'u'),
      );
      // The encoding is reversible.
      expect(
        decodeURIComponent(segment.slice(0, segment.lastIndexOf('_'))),
      ).toBe(reportId);
    }
  });

  it('never leaves an empty or period-only last segment', async () => {
    for (const reportId of ['', '.', '..']) {
      // oxlint-disable-next-line no-await-in-loop -- one save per case
      expect(await aggregateKeySegment(reportId)).toMatch(
        new RegExp(`^${escapeRegExp(reportId)}${HASH_SUFFIX}$`, 'u'),
      );
    }
  });

  it('shortens an oversized multibyte report ID to 1024 bytes', async () => {
    const report = aggregateReport();
    const reportId = '€'.repeat(5000); // 3 UTF-8 bytes -> 9 characters
    report.reportMetadata.reportId = reportId;
    const key = await aggregateKey(report, 'p'.repeat(300));
    expect(Buffer.byteLength(key)).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(key)).toBeGreaterThan(1024 - 9);
    const segment = key.split('/').at(-1) ?? '';
    expect(segment).toMatch(new RegExp(`^(%E2%82%AC)+${HASH_SUFFIX}$`, 'u'));
    const decoded = decodeURIComponent(
      segment.slice(0, segment.lastIndexOf('_')),
    );
    expect(reportId.startsWith(decoded)).toBe(true);
  });

  it('counts the encoded length of "~"', async () => {
    const report = aggregateReport();
    report.reportMetadata.reportId = '~'.repeat(2000);
    const key = await aggregateKey(report);
    expect(Buffer.byteLength(key)).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(key)).toBeGreaterThan(1024 - 3);
    expect(key.split('/').at(-1)).toMatch(
      new RegExp(`^(%7E)+${HASH_SUFFIX}$`, 'u'),
    );
  });

  it('drops the ID when bucketPath alone uses up the key limit', async () => {
    const key = await aggregateKey(aggregateReport(), 'p'.repeat(1100));
    expect(key).toMatch(
      new RegExp(`/year=2024/month=01/day=15/${HASH_SUFFIX}$`, 'u'),
    );
  });

  it('survives report IDs String() would throw on', async () => {
    const report = aggregateReport();
    report.reportMetadata.reportId = { toString: 1 } as unknown as string;
    // Python's str() of a dict, encoded.
    expect(await aggregateKey(report)).toMatch(
      new RegExp(`/%7B'to_string': 1%7D${HASH_SUFFIX}$`, 'u'),
    );
  });
});

describe('S3Client metadata sanitization', () => {
  // S3 metadata must be ASCII (botocore rejects anything else) and is
  // limited to 2 KB; values are percent-encoded so they round-trip.
  it('percent-encodes a non-ASCII org name', async () => {
    const s3Client = client();
    const report = aggregateReport();
    report.reportMetadata.orgName = 'Ünïcode Org';
    await s3Client.saveAggregateReportToS3(report);
    expect(putInput(s3Client).Metadata).toEqual({
      org_name: '%C3%9Cn%C3%AFcode Org',
      org_email: ORG_EMAIL,
      report_id: 'agg-123',
      begin_date: '2024-01-15 00:00:00',
      end_date: '2024-01-16 00:00:00',
    });

    const tlsClient = client();
    const tlsReport = smtpTlsReport();
    tlsReport.organizationName = 'Ünïcode Org';
    await tlsClient.saveSmtpTlsReportToS3(tlsReport);
    expect(putInput(tlsClient).Metadata.org_name).toBe('%C3%9Cn%C3%AFcode Org');
  });

  it('round-trips CR, LF and "%"', async () => {
    const s3Client = client();
    const report = aggregateReport();
    const orgName = 'Org\r\nX-Injected: 1 100%';
    report.reportMetadata.orgName = orgName;
    await s3Client.saveAggregateReportToS3(report);
    const value = putInput(s3Client).Metadata.org_name ?? '';
    expect(value).toBe('Org%0D%0AX-Injected: 1 100%25');
    expect(decodeURIComponent(value)).toBe(orgName);
  });

  it('caps each value at 256 characters, under 2 KB in total', async () => {
    const s3Client = client();
    const report = aggregateReport();
    report.reportMetadata.orgName = 'x'.repeat(10_000);
    report.reportMetadata.orgEmail = 'x'.repeat(10_000);
    report.reportMetadata.reportId = 'x'.repeat(10_000);
    // 255 ASCII characters, then one that encodes to 6: dropped whole.
    report.reportMetadata.endDate = `${'a'.repeat(255)}Ü`;
    await s3Client.saveAggregateReportToS3(report);
    const metadata = putInput(s3Client).Metadata;
    expect(metadata.end_date).toBe('a'.repeat(255));
    let total = 0;
    for (const [key, value] of Object.entries(metadata)) {
      expect(value.length).toBeLessThanOrEqual(256);
      total +=
        Buffer.byteLength(`x-amz-meta-${key}`) + Buffer.byteLength(value);
    }
    expect(total).toBeLessThan(2048);
  });

  it('turns a lone surrogate into "?"', async () => {
    const s3Client = client();
    const report = smtpTlsReport();
    report.organizationName = 'Org\uD800';
    report.reportId = 'id\uDFFF';
    await s3Client.saveSmtpTlsReportToS3(report);
    const { Key, Metadata } = putInput(s3Client);
    expect(Metadata.org_name).toBe('Org?');
    expect(Metadata.report_id).toBe('id?');
    expect(Key).toMatch(new RegExp(String.raw`/id\?${HASH_SUFFIX}$`, 'u'));
    expect(() => encodeURIComponent(Key)).not.toThrow();
  });
});

describe('S3Client failure reports', () => {
  // Failure reports have no report_metadata and no report ID; parsedmarc
  // before 11.2.0 raised KeyError on every one.
  const sample = async (): Promise<FailureReport> => {
    const parsed = await parseReportFile(
      fileURLToPath(
        new URL(
          '../../../samples/failure/dmarc_ruf_report_linkedin.eml',
          import.meta.url,
        ),
      ),
      { offline: true },
    );
    expect(parsed.reportType).toBe('failure');
    return parsed.report as FailureReport;
  };
  const save = async (report: FailureReport): Promise<S3Client> => {
    const s3Client = client();
    await s3Client.saveFailureReportToS3(report);
    return s3Client;
  };

  it('keys them by arrival date and reported domain', async () => {
    const report = await sample();
    const s3Client = await save(structuredClone(report));
    const { Key, Body, Metadata } = putInput(s3Client);
    expect(Key).toMatch(
      new RegExp(
        String.raw`^dmarc/failure/year=2019/month=04/day=30/example\.com${HASH_SUFFIX}$`,
        'u',
      ),
    );
    expect(Metadata).toEqual({
      reported_domain: 'example.com',
      arrival_date: '2019-04-30 02:09:00',
    });
    expect(JSON.parse(Body)).toMatchObject({ reported_domain: 'example.com' });

    // A different sample is a different report.
    const other = structuredClone(report);
    other.sample = `${other.sample}\n`;
    expect(putInput(await save(other)).Key).not.toBe(Key);

    // Different enrichment of the same report is the same report.
    const enriched = structuredClone(report);
    enriched.source.reverseDns = 'mail.example.net';
    enriched.source.country = 'US';
    expect(putInput(await save(enriched)).Key).toBe(Key);
  });
});

describe('S3Client close', () => {
  // close() must release the SDK client's sockets in watch mode.
  it('destroys the underlying client', () => {
    const s3Client = client();
    s3Client.close();
    expect(sdkOf(s3Client).destroy).toHaveBeenCalledTimes(1);
  });

  it('swallows exceptions from the underlying client', () => {
    const s3Client = client();
    sdkOf(s3Client).destroy.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => s3Client.close()).not.toThrow();
  });
});

describe('integers beyond 2^53', () => {
  it('writes a record count exactly, like json.dumps(report, default=str)', async () => {
    const xml = readFileSync(
      new URL(
        '../../../samples/aggregate/!example.com!1538204542!1538463818.xml',
        import.meta.url,
      ),
      'utf8',
    ).replace('<count>1</count>', '<count>99999999999999999999</count>');
    const report = await parseAggregateReportXml(xml, { offline: true });
    const s3Client = client();
    await s3Client.saveAggregateReportToS3(report);
    expect(putInput(s3Client).Body).toContain('"count": 99999999999999999999,');
  });
});

/** An S3 error as the SDK throws it for an HTTP status. */
function s3Error(name: string, httpStatusCode: number): S3ServiceException {
  return new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode },
    message: name,
  });
}

/**
 * A bucket behind the SDK boundary: PutObject honors `If-None-Match: *`
 * (unless `ignoresConditions`, like older MinIO/Ceph), GetObject reads back.
 */
function fakeBucket(
  sdk: FakeS3,
  { ignoresConditions = false, conflicts = 0 } = {},
): { objects: Map<string, string>; commands: unknown[] } {
  const objects = new Map<string, string>();
  const commands: unknown[] = [];
  let pendingConflicts = conflicts;
  sdk.send.mockImplementation((command: unknown) => {
    commands.push(command);
    if (command instanceof PutObjectCommand) {
      const { Key, Body, IfNoneMatch } = command.input;
      const key = String(Key);
      if (IfNoneMatch === '*' && pendingConflicts > 0) {
        pendingConflicts -= 1;
        return Promise.reject(s3Error('ConditionalRequestConflict', 409));
      }
      if (IfNoneMatch === '*' && !ignoresConditions && objects.has(key)) {
        return Promise.reject(s3Error('PreconditionFailed', 412));
      }
      objects.set(key, String(Body));
      return Promise.resolve({});
    }
    if (command instanceof GetObjectCommand) {
      const data = objects.get(String(command.input.Key));
      if (data === undefined) {
        return Promise.reject(s3Error('NoSuchKey', 404));
      }
      return Promise.resolve({
        Body: { transformToString: () => Promise.resolve(data) },
      });
    }
    return Promise.reject(new Error('unexpected command'));
  });
  return { objects, commands };
}

describe('preventOverwrite (deviation)', () => {
  const key =
    'dmarc/aggregate/year=2024/month=01/day=15/agg-123_f80ea35e1b3f6ad4.json';
  const probe = 'dmarc/.tsdmarc-conditional-write-check';
  const guarded = (): S3Client =>
    new S3Client('b', 'dmarc', {
      regionName: 'us-east-1',
      preventOverwrite: true,
    });
  // The hashed fields aren't secret: a forged report can copy them all and
  // differ only in its records.
  const forged = (): AggregateReport => {
    const report = aggregateReport() as unknown as Record<string, unknown>;
    report.records = [{ source: { ipAddress: '192.0.2.1' } }];
    return report as unknown as AggregateReport;
  };

  it('keeps the first report when another sender reuses its ID', async () => {
    const s3Client = guarded();
    const { objects, commands } = fakeBucket(sdkOf(s3Client));
    await s3Client.saveAggregateReportToS3(aggregateReport());
    const legitimate = objects.get(key);
    const logs = captureLogs();
    try {
      await s3Client.saveAggregateReportToS3(forged());
    } finally {
      logs.restore();
    }
    expect(objects.get(key)).toBe(legitimate);
    const others = [...objects.keys()].filter(k => k !== key && k !== probe);
    expect(others).toHaveLength(1);
    const [alternate] = others;
    expect(alternate).toMatch(
      /^dmarc\/aggregate\/year=2024\/month=01\/day=15\/agg-123_f80ea35e1b3f6ad4-[0-9a-f]{64}\.json$/u,
    );
    expect(JSON.parse(objects.get(alternate ?? '') ?? '')).toMatchObject({
      records: [{ source: { ip_address: '192.0.2.1' } }],
    });
    expect(logs.output).toContain(
      `WARNING:tsdmarc:s3://b/${key} holds a different aggregate report with the same identifying fields; saving this one as ${alternate}`,
    );
    // Every write was conditional.
    for (const command of commands) {
      if (command instanceof PutObjectCommand) {
        expect(command.input.IfNoneMatch).toBe('*');
      }
    }
  });

  it('keeps the separate copy of a long report ID within 1024 bytes', async () => {
    const s3Client = guarded();
    const { objects } = fakeBucket(sdkOf(s3Client));
    const longId = (report: AggregateReport): AggregateReport => {
      report.reportMetadata.reportId = '€'.repeat(500);
      return report;
    };
    await s3Client.saveAggregateReportToS3(longId(aggregateReport()));
    await s3Client.saveAggregateReportToS3(longId(forged()));
    const saved = [...objects.keys()].filter(k => k !== probe);
    expect(saved).toHaveLength(2);
    for (const savedKey of saved) {
      expect(Buffer.byteLength(savedKey)).toBeLessThanOrEqual(1024);
    }
  });

  it('skips a report that is already saved, and its retries', async () => {
    const s3Client = guarded();
    const { objects } = fakeBucket(sdkOf(s3Client));
    await s3Client.saveAggregateReportToS3(aggregateReport());
    await s3Client.saveAggregateReportToS3(aggregateReport());
    await s3Client.saveAggregateReportToS3(forged());
    await s3Client.saveAggregateReportToS3(forged());
    expect(objects.size).toBe(3); // probe, first report, second report
  });

  it('refuses to save when the service ignores If-None-Match', async () => {
    const s3Client = guarded();
    const { objects } = fakeBucket(sdkOf(s3Client), {
      ignoresConditions: true,
    });
    await expect(
      s3Client.saveAggregateReportToS3(aggregateReport()),
    ).rejects.toThrow(
      `S3 service ignored If-None-Match (s3://b/${probe} was overwritten): it does not support conditional writes, which preventOverwrite needs`,
    );
    expect(objects.has(key)).toBe(false);
  });

  it('checks the service once per client', async () => {
    const s3Client = guarded();
    const { commands } = fakeBucket(sdkOf(s3Client));
    await s3Client.saveAggregateReportToS3(aggregateReport());
    await s3Client.saveSmtpTlsReportToS3(smtpTlsReport());
    const probes = commands.filter(
      c => c instanceof PutObjectCommand && c.input.Key === probe,
    );
    expect(probes).toHaveLength(2);
  });

  it('retries a 409 ConditionalRequestConflict, as AWS documents', async () => {
    const s3Client = guarded();
    const { objects } = fakeBucket(sdkOf(s3Client), { conflicts: 2 });
    await s3Client.saveAggregateReportToS3(aggregateReport());
    expect(objects.has(key)).toBe(true);
  });
});
