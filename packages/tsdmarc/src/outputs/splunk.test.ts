// Port of tests/test_splunk.py. `fetch` (and `node:https` for verify=false)
// is the SDK boundary.

import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureLogs, type LogCapture } from '../log';
import { parseSmtpTlsReportJson } from '../smtp-tls';
import type { AggregateReport, FailureReport, SMTPTLSReport } from '../types';
import { HECClient, SplunkError } from './splunk';

const httpsRequest = vi.hoisted(() => vi.fn());
vi.mock('node:https', () => ({ request: httpsRequest }));

function aggregateReport(): AggregateReport {
  return {
    xmlSchema: '1.0',
    xmlNamespace: null,
    reportMetadata: {
      orgName: 'TestOrg',
      orgEmail: 'dmarc@example.com',
      orgExtraContactInfo: null,
      reportId: 'agg-1',
      beginDate: '2024-01-01 00:00:00',
      endDate: '2024-01-02 00:00:00',
      timespanRequiresNormalization: false,
      originalTimespanSeconds: 86_400,
      errors: [],
      generator: null,
    },
    policyPublished: { domain: 'example.com', p: 'none' },
    records: [
      {
        intervalBegin: '2024-01-01 00:00:00',
        intervalEnd: '2024-01-02 00:00:00',
        normalizedTimespan: false,
        source: {
          ipAddress: '192.0.2.1',
          country: 'US',
          reverseDns: null,
          baseDomain: null,
          name: null,
          type: null,
          asn: 64_496,
          asName: 'Example AS',
          asDomain: 'example.net',
        },
        count: 4,
        alignment: { spf: true, dkim: true, dmarc: true },
        policyEvaluated: {
          disposition: 'none',
          dkim: 'pass',
          spf: 'pass',
          policyOverrideReasons: [],
        },
        identifiers: {
          headerFrom: 'example.com',
          envelopeFrom: 'example.com',
          envelopeTo: null,
        },
        authResults: {
          dkim: [
            {
              domain: 'example.com',
              selector: 's',
              result: 'pass',
              humanResult: null,
            },
          ],
          spf: [
            {
              domain: 'example.com',
              scope: 'mfrom',
              result: 'pass',
              humanResult: null,
            },
          ],
        },
      },
    ],
  } as unknown as AggregateReport;
}

function failureReport(): FailureReport {
  return {
    feedbackType: 'auth-failure',
    userAgent: 'test/1.0',
    version: '1',
    originalEnvelopeId: null,
    originalMailFrom: 'x@example.com',
    originalRcptTo: null,
    arrivalDate: 'Thu, 1 Jan 2024 00:00:00 +0000',
    arrivalDateUtc: '2024-01-01 00:00:00',
    authenticationResults: null,
    deliveryResult: 'other',
    authFailure: ['dmarc'],
    authenticationMechanisms: [],
    dkimDomain: null,
    reportedDomain: 'example.com',
    sampleHeadersOnly: true,
    source: {
      ipAddress: '192.0.2.5',
      country: 'US',
      reverseDns: null,
      baseDomain: null,
      name: null,
      type: null,
      asn: 64_496,
      asName: 'Example AS',
      asDomain: 'example.net',
    },
    sample: '...',
    parsedSample: { subject: 'Test' },
  } as unknown as FailureReport;
}

function smtpTlsReport(): SMTPTLSReport {
  return {
    organizationName: 'example.com',
    beginDate: '2024-02-03T00:00:00Z',
    endDate: '2024-02-04T00:00:00Z',
    contactInfo: 'tls@example.com',
    reportId: 'tls-1',
    policies: [
      {
        policyDomain: 'example.com',
        policyType: 'sts',
        successfulSessionCount: 100,
        failedSessionCount: 0,
      },
    ],
  };
}

function client(): HECClient {
  return new HECClient(
    'https://splunk.example.com:8088',
    'abc-token-uuid',
    'dmarc',
  );
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
let fetchMock: FetchMock;
let logs: LogCapture;

function hecResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(hecResponse({ code: 0, text: 'Success' })),
  );
  vi.stubGlobal('fetch', fetchMock);
  logs = captureLogs();
  httpsRequest.mockReset();
});

afterEach(() => {
  logs.restore();
  vi.unstubAllGlobals();
});

function sentInit(index = 0): RequestInit {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`fetch call ${index} not made`);
  }
  return call[1] ?? {};
}

function sentBody(index = 0): string {
  const { body } = sentInit(index);
  if (!(body instanceof Uint8Array)) {
    throw new TypeError('expected a bytes body');
  }
  return new TextDecoder().decode(body);
}

interface HecEvent {
  time: number;
  host: string;
  source: string;
  index: string;
  sourcetype: string;
  event: Record<string, unknown>;
}

function sentEvents(index = 0): HecEvent[] {
  return sentBody(index)
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as HecEvent);
}

function firstEvent(): HecEvent {
  const [event] = sentEvents();
  if (!event) {
    throw new Error('no event sent');
  }
  return event;
}

describe('HECClient init', () => {
  // The HEC URL is rebuilt into the /services/collector/event/1.0 endpoint,
  // and the Authorization header is `Splunk <token>`.
  it('rewrites the url to the collector endpoint', () => {
    const hec = new HECClient(
      'https://splunk.example.com:8088/some/random/path',
      't',
      'dmarc',
    );
    expect(hec.url).toBe(
      'https://splunk.example.com:8088/services/collector/event/1.0',
    );
  });

  it('keeps the scheme and netloc literally, like urlparse', () => {
    const hec = new HECClient('HTTPS://User@Host:443/x?y#z', 't', 'dmarc');
    expect(hec.url).toBe('https://User@Host:443/services/collector/event/1.0');
  });

  it('uses the Splunk prefix in the authorization header', async () => {
    const hec = new HECClient('https://h:8088', 'my-token', 'dmarc');
    expect(hec.headers.Authorization).toBe('Splunk my-token');
    await hec.saveSmtpTlsReportsToSplunk(smtpTlsReport());
    expect(new Headers(sentInit().headers).get('Authorization')).toBe(
      'Splunk my-token',
    );
  });

  it('sets the user agent header', async () => {
    const hec = new HECClient('https://h:8088', 'my-token', 'dmarc');
    await hec.saveSmtpTlsReportsToSplunk(smtpTlsReport());
    expect(new Headers(sentInit().headers).get('User-Agent')).toContain(
      'tsdmarc',
    );
  });

  it('normalizes a token with the Splunk prefix', () => {
    // A token pasted as `Splunk <token>` must not become `Splunk Splunk ...`.
    const hec = new HECClient(
      'https://h:8088',
      'Splunk abc-token-uuid',
      'dmarc',
    );
    expect(hec.accessToken).toBe('abc-token-uuid');
  });

  it('leaves a token without the prefix unchanged', () => {
    // lstrip("Splunk ") has character-set semantics: it works for HEC's
    // UUID-shaped tokens, whose hex digits are not in that set.
    expect(client().accessToken).toBe('abc-token-uuid');
  });

  it('strips leading prefix characters like Python lstrip', () => {
    const hec = new HECClient('https://h:8088', 'nuk-token', 'dmarc');
    expect(hec.accessToken).toBe('-token');
  });

  it('carries host, source and index on every event', async () => {
    // A regression here would mis-route events to the wrong index.
    const hec = new HECClient('https://h:8088', 't', 'dmarc', {
      source: 'my-source',
    });
    expect(hec.commonData.index).toBe('dmarc');
    expect(hec.commonData.source).toBe('my-source');
    expect(hec.commonData.host).toBeTruthy();
    await hec.saveSmtpTlsReportsToSplunk(smtpTlsReport());
    const event = firstEvent();
    expect(event.index).toBe('dmarc');
    expect(event.source).toBe('my-source');
    expect(event.host).toBe(hostname());
  });

  it('defaults the source to tsdmarc', () => {
    expect(client().source).toBe('tsdmarc');
  });
});

describe('saveAggregateReportsToSplunk', () => {
  // Each record is a separate event, timestamped by interval_begin, with the
  // report metadata flattened onto it and sourcetype dmarc:aggregate.
  it('sends one event per record', async () => {
    const report = aggregateReport();
    const [record] = report.records;
    if (!record) {
      throw new Error('fixture has no record');
    }
    report.records.push(structuredClone(record));
    await client().saveAggregateReportsToSplunk(report);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://splunk.example.com:8088/services/collector/event/1.0',
    );
    const events = sentEvents();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.sourcetype).toBe('dmarc:aggregate');
      expect(event.index).toBe('dmarc');
    }
  });

  it('carries source metadata on the event', async () => {
    await client().saveAggregateReportsToSplunk(aggregateReport());
    const { event } = firstEvent();
    expect(event.source_ip_address).toBe('192.0.2.1');
    expect(event.header_from).toBe('example.com');
    expect(event.message_count).toBe(4);
    expect(event.passed_dmarc).toBe(true);
    expect(event.org_name).toBe('TestOrg');
  });

  it('builds the same event fields as parsedmarc', async () => {
    await client().saveAggregateReportsToSplunk(aggregateReport());
    expect(firstEvent().event).toEqual({
      org_name: 'TestOrg',
      org_email: 'dmarc@example.com',
      org_extra_contact_info: null,
      report_id: 'agg-1',
      begin_date: '2024-01-01 00:00:00',
      end_date: '2024-01-02 00:00:00',
      timespan_requires_normalization: false,
      original_timespan_seconds: 86_400,
      errors: [],
      generator: null,
      interval_begin: '2024-01-01 00:00:00',
      interval_end: '2024-01-02 00:00:00',
      normalized_timespan: false,
      published_policy: { domain: 'example.com', p: 'none' },
      source_ip_address: '192.0.2.1',
      source_country: 'US',
      source_reverse_dns: null,
      source_base_domain: null,
      source_type: null,
      source_name: null,
      source_asn: 64_496,
      source_as_name: 'Example AS',
      source_as_domain: 'example.net',
      message_count: 4,
      disposition: 'none',
      spf_aligned: true,
      dkim_aligned: true,
      passed_dmarc: true,
      header_from: 'example.com',
      envelope_from: 'example.com',
      dkim_results: [
        {
          domain: 'example.com',
          selector: 's',
          result: 'pass',
          human_result: null,
        },
      ],
      spf_results: [
        {
          domain: 'example.com',
          scope: 'mfrom',
          result: 'pass',
          human_result: null,
        },
      ],
    });
  });

  it('includes the published policy', async () => {
    await client().saveAggregateReportsToSplunk(aggregateReport());
    expect(firstEvent().event.published_policy).toEqual({
      domain: 'example.com',
      p: 'none',
    });
  });

  it('normalizes a single report to a list', async () => {
    await client().saveAggregateReportsToSplunk(aggregateReport());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an empty list', async () => {
    await client().saveAggregateReportsToSplunk([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies the client timeout to the request', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(signal?.reason));
        }),
    );
    const hec = new HECClient('https://h:8088', 't', 'dmarc', {
      timeout: 0.05,
    });
    await expect(
      hec.saveAggregateReportsToSplunk(aggregateReport()),
    ).rejects.toThrow(SplunkError);
    expect(signal?.aborted).toBe(true);
  });

  it('refuses an oversized HEC response instead of parsing it', async () => {
    fetchMock.mockResolvedValue(
      new Response(`{"code":0,"text":"${'x'.repeat(2 * 1024 * 1024)}"}`, {
        status: 200,
      }),
    );
    await expect(
      client().saveAggregateReportsToSplunk(aggregateReport()),
    ).rejects.toThrow(new SplunkError('Response body exceeds 1048576 bytes'));
  });

  it('turns off certificate verification with verify false', async () => {
    // fetch cannot skip verification portably, so verify=false goes through
    // node:https with rejectUnauthorized=false (mocked here).
    let written = '';
    httpsRequest.mockImplementation(
      (
        _url: URL,
        _options: unknown,
        callback: (response: PassThrough) => void,
      ) => {
        const outgoing = new EventEmitter() as EventEmitter & {
          end: (body?: Uint8Array) => void;
        };
        outgoing.end = body => {
          written = new TextDecoder().decode(body);
          const response = Object.assign(new PassThrough(), {
            statusCode: 200,
            headers: {},
          });
          response.end(JSON.stringify({ code: 0, text: 'Success' }));
          return callback(response);
        };
        return outgoing;
      },
    );
    const hec = new HECClient('https://h:8088', 't', 'dmarc', {
      verify: false,
      timeout: 15,
    });
    await hec.saveAggregateReportsToSplunk(aggregateReport());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    const [url, options] = httpsRequest.mock.calls[0] as [
      URL,
      { method: string; rejectUnauthorized: boolean; headers: object },
    ];
    expect(String(url)).toBe('https://h:8088/services/collector/event/1.0');
    expect(options.method).toBe('POST');
    expect(options.rejectUnauthorized).toBe(false);
    expect(options.headers).toMatchObject({ Authorization: 'Splunk t' });
    expect(JSON.parse(written.trim())).toMatchObject({
      sourcetype: 'dmarc:aggregate',
    });
  });

  it('raises SplunkError for a non-zero response code', async () => {
    // HEC returns code=0 on success; its error text carries the diagnosis.
    fetchMock.mockResolvedValue(
      hecResponse({ code: 4, text: 'Invalid token' }),
    );
    await expect(
      client().saveAggregateReportsToSplunk(aggregateReport()),
    ).rejects.toThrow(new SplunkError('Invalid token'));
  });

  it('translates a post exception to SplunkError', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(
      client().saveAggregateReportsToSplunk(aggregateReport()),
    ).rejects.toThrow(/network/u);
    await expect(
      client().saveAggregateReportsToSplunk(aggregateReport()),
    ).rejects.toBeInstanceOf(SplunkError);
  });

  it('translates a non-JSON response to SplunkError', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 502 }));
    await expect(
      client().saveAggregateReportsToSplunk(aggregateReport()),
    ).rejects.toBeInstanceOf(SplunkError);
  });

  it('treats interval_begin as UTC for the event time', async () => {
    // interval_begin is a UTC wall-clock string; the event time must be its
    // true UTC epoch regardless of the host timezone (parsedmarc #819).
    const previous = process.env.TZ;
    process.env.TZ = 'Europe/Warsaw';
    try {
      await client().saveAggregateReportsToSplunk(aggregateReport());
    } finally {
      process.env.TZ = previous;
    }
    expect(firstEvent().time).toBe(1_704_067_200);
  });
});

describe('saveFailureReportsToSplunk', () => {
  it('sends one event per report', async () => {
    await client().saveFailureReportsToSplunk([
      failureReport(),
      failureReport(),
    ]);
    const events = sentEvents();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.sourcetype).toBe('dmarc:failure');
    }
  });

  it('sends the snake_case report as the event', async () => {
    await client().saveFailureReportsToSplunk(failureReport());
    const { event } = firstEvent();
    expect(event.reported_domain).toBe('example.com');
    expect(event.arrival_date_utc).toBe('2024-01-01 00:00:00');
    expect(event.source).toMatchObject({ ip_address: '192.0.2.5' });
    expect(event.parsed_sample).toEqual({ subject: 'Test' });
  });

  it('is a no-op for an empty list', async () => {
    await client().saveFailureReportsToSplunk([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats arrival_date_utc as UTC for the event time', async () => {
    // parsedmarc #811 (bug 1): the naive parse used to shift the epoch by
    // the host's UTC offset (-3600 s under Europe/Warsaw in January).
    const previous = process.env.TZ;
    process.env.TZ = 'Europe/Warsaw';
    try {
      await client().saveFailureReportsToSplunk(failureReport());
    } finally {
      process.env.TZ = previous;
    }
    expect(firstEvent().time).toBe(1_704_067_200);
  });

  it('raises SplunkError for a non-zero response code', async () => {
    fetchMock.mockResolvedValue(
      hecResponse({ code: 6, text: 'Invalid data format' }),
    );
    await expect(
      client().saveFailureReportsToSplunk(failureReport()),
    ).rejects.toThrow(new SplunkError('Invalid data format'));
  });

  it('translates a post exception to SplunkError', async () => {
    fetchMock.mockRejectedValue(new Error('conn refused'));
    await expect(
      client().saveFailureReportsToSplunk(failureReport()),
    ).rejects.toBeInstanceOf(SplunkError);
  });

  it('logs a debug breadcrumb with verify false', async () => {
    // Operators can spot misconfigured TLS in their logs.
    const hec = new HECClient('http://h:8088', 't', 'dmarc', {
      verify: false,
    });
    await hec.saveFailureReportsToSplunk(failureReport());
    expect(
      logs.output.some(line =>
        line.includes('Skipping certificate verification'),
      ),
    ).toBe(true);
  });

  it('keeps the backward-compatible forensic alias', async () => {
    await client().saveForensicReportsToSplunk(failureReport());
    expect(firstEvent().sourcetype).toBe('dmarc:failure');
  });
});

describe('saveSmtpTlsReportsToSplunk', () => {
  // HEC answers for the whole request, so a bare NaN from one reporter would
  // fail the other events of the POST. Numbers stay allowed in the optional
  // failure-details fields, which outputs store as text.
  it.each(['NaN', 'Infinity', '-Infinity', '1e999'])(
    'sends strict JSON for a reporter-supplied %s',
    async literal => {
      const report = parseSmtpTlsReportJson(
        JSON.stringify({
          'organization-name': 'o',
          'date-range': {
            'start-datetime': '2024-02-03T00:00:00Z',
            'end-datetime': '2024-02-04T00:00:00Z',
          },
          'contact-info': 'c',
          'report-id': 'r',
          policies: [
            {
              policy: { 'policy-type': 'sts', 'policy-domain': 'example.org' },
              summary: {
                'total-successful-session-count': 1,
                'total-failure-session-count': 1,
              },
              'failure-details': [
                {
                  'result-type': 'starttls-not-supported',
                  'failed-session-count': 1,
                  'failure-reason-code': 'PLACEHOLDER',
                },
              ],
            },
          ],
        }).replace('"PLACEHOLDER"', literal),
      );
      await client().saveSmtpTlsReportsToSplunk([report, smtpTlsReport()]);
      const events = sentEvents();
      expect(events).toHaveLength(2);
      const policies = events[0]?.event.policies as {
        failure_details: Record<string, unknown>[];
      }[];
      expect(policies[0]?.failure_details[0]).toHaveProperty(
        'failure_reason_code',
        null,
      );
    },
  );

  it('sends one event per report', async () => {
    await client().saveSmtpTlsReportsToSplunk([smtpTlsReport()]);
    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.sourcetype).toBe('smtp:tls');
    expect(events[0]?.time).toBe(1_706_918_400);
    expect(events[0]?.event).toMatchObject({
      organization_name: 'example.com',
      report_id: 'tls-1',
      policies: [
        { policy_domain: 'example.com', successful_session_count: 100 },
      ],
    });
  });

  it.each([
    ['text', 'garbage\nforged line'],
    ['a number', 1_706_918_400],
    ['null', null],
    ['an object', { start: 1 }],
  ])(
    'sends a report whose begin date is %s without a time',
    async (_name, beginDate) => {
      const bad = { ...smtpTlsReport(), beginDate } as unknown as SMTPTLSReport;
      await client().saveSmtpTlsReportsToSplunk([bad, smtpTlsReport()]);
      const events = sentEvents();
      expect(events).toHaveLength(2);
      expect(events[0]).not.toHaveProperty('time');
      expect(events[0]?.event).toMatchObject({ report_id: 'tls-1' });
      expect(events[1]?.time).toBe(1_706_918_400);
      const warnings = logs.output.filter(line => line.startsWith('WARNING:'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('without an event time');
      expect(warnings[0]).not.toContain('\n');
    },
  );

  it('normalizes a single report to a list', async () => {
    await client().saveSmtpTlsReportsToSplunk(smtpTlsReport());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an empty list', async () => {
    await client().saveSmtpTlsReportsToSplunk([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('raises SplunkError for a non-zero response code', async () => {
    fetchMock.mockResolvedValue(
      hecResponse({ code: 7, text: 'Incorrect index' }),
    );
    await expect(
      client().saveSmtpTlsReportsToSplunk(smtpTlsReport()),
    ).rejects.toThrow(new SplunkError('Incorrect index'));
  });

  it('translates a post exception to SplunkError', async () => {
    fetchMock.mockRejectedValue(new Error('conn refused'));
    await expect(
      client().saveSmtpTlsReportsToSplunk(smtpTlsReport()),
    ).rejects.toBeInstanceOf(SplunkError);
  });

  it('logs a debug breadcrumb with verify false', async () => {
    const hec = new HECClient('http://h:8088', 't', 'dmarc', {
      verify: false,
    });
    await hec.saveSmtpTlsReportsToSplunk(smtpTlsReport());
    expect(
      logs.output.some(line =>
        line.includes('Skipping certificate verification'),
      ),
    ).toBe(true);
  });
});

describe('HECClient URLs', () => {
  it('keeps the credentials of the URL out of the error', async () => {
    vi.unstubAllGlobals();
    const hec = new HECClient('http://user:SECRET@127.0.0.1:9', 'tok', 'idx');
    const error: unknown = await hec
      .saveSmtpTlsReportsToSplunk([smtpTlsReport()])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SplunkError);
    expect(String((error as SplunkError).message)).not.toContain('SECRET');
    expect(String((error as SplunkError).cause)).not.toContain('SECRET');
  });
});

// fetch and undici quote a header value they refuse; the HEC token is one.
describe('HECClient invalid token', () => {
  it.each([
    ['a control character', 'SECRET\nTOKEN'],
    ['a character over U+00FF', 'SECRET\u{20ac}TOKEN'],
  ])('keeps a token with %s out of the error', async (_name, token) => {
    for (const verify of [true, false]) {
      const hec = new HECClient('https://splunk.example:8088', token, 'idx', {
        verify,
      });
      // oxlint-disable-next-line no-await-in-loop -- one save at a time
      const error: unknown = await hec
        .saveSmtpTlsReportsToSplunk([smtpTlsReport()])
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SplunkError);
      expect((error as SplunkError).message).toBe(
        'Invalid value for the Authorization header',
      );
      expect(String((error as SplunkError).stack)).not.toContain('SECRET');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
  });
});

// parsedmarc's TestHECClientUrlCredentials (GHSA-hjr3-rx4c-24cv): a
// password with an unencoded "/", "?" or "#" ends the URL's authority early,
// so the URL can't be parsed; the error has a fixed message and no cause.
describe('HECClient malformed URL credentials', () => {
  const malformed: [string, string][] = [
    ['https://admin:p4ssw0rd/x@splunk.example:8088', 'p4ssw0rd'],
    ['https://admin:p4ss?w0rd@splunk.example:8088', 'p4ss'],
    ['https://admin:p4ss#w0rd@splunk.example:8088', 'p4ss'],
  ];
  const saves = [
    ['saveAggregateReportsToSplunk', aggregateReport],
    ['saveFailureReportsToSplunk', failureReport],
    ['saveSmtpTlsReportsToSplunk', smtpTlsReport],
  ] as const;

  it.each(malformed)(
    'test_invalid_url_raises_fixed_message_without_password: %s',
    async (url, secret) => {
      for (const verify of [true, false]) {
        const hec = new HECClient(url, 'tok', 'dmarc', { verify });
        for (const [method, makeReport] of saves) {
          // oxlint-disable-next-line no-await-in-loop -- one save at a time
          const error: unknown = await (
            hec[method] as (report: unknown) => Promise<void>
          )(makeReport()).catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(SplunkError);
          expect((error as SplunkError).message).toBe(
            'Invalid Splunk HEC URL (details withheld because they may include credentials)',
          );
          expect((error as SplunkError).cause).toBeUndefined();
          expect(String((error as SplunkError).stack)).not.toContain(secret);
        }
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(httpsRequest).not.toHaveBeenCalled();
    },
  );

  it('test_valid_url_is_the_one_posted', async () => {
    const hec = new HECClient(
      'https://admin:p4ssw0rd@splunk.example:8088',
      'tok',
      'dmarc',
    );
    await hec.saveAggregateReportsToSplunk(aggregateReport());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://splunk.example:8088/services/collector/event/1.0',
    );
    expect(new Headers(sentInit().headers).get('Authorization')).not.toBeNull();
  });
});

describe('HECClient close', () => {
  it('refuses requests after close', async () => {
    const hec = client();
    hec.close();
    await expect(
      hec.saveSmtpTlsReportsToSplunk(smtpTlsReport()),
    ).rejects.toThrow(
      new SplunkError('Cannot send a request, as the client has been closed.'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('integers beyond 2^53', () => {
  // Python ints are unbounded and json.dumps() writes them exactly.
  const HUGE = 99_999_999_999_999_999_999n;

  it('sends an aggregate message_count exactly', async () => {
    const report = aggregateReport();
    const [record] = report.records;
    if (!record) {
      throw new Error('fixture has no record');
    }
    record.count = HUGE;
    await client().saveAggregateReportsToSplunk(report);
    expect(sentBody()).toContain('"message_count": 99999999999999999999,');
  });

  it('sends SMTP TLS session counts exactly', async () => {
    const report = smtpTlsReport();
    const [policy] = report.policies;
    if (!policy) {
      throw new Error('fixture has no policy');
    }
    policy.successfulSessionCount = HUGE;
    await client().saveSmtpTlsReportsToSplunk(report);
    expect(sentBody()).toContain(
      '"successful_session_count": 99999999999999999999,',
    );
  });
});
