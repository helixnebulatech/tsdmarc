// Port of tests/test_loki.py. `fetch` is the SDK boundary; the row
// conversion is replaced in most tests, like parsedmarc's `patch()`.

import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CsvRow } from '../csv';
import { captureLogs, type LogCapture } from '../log';
import { parseReportFile } from '../report-file';
import type { AggregateReport, FailureReport, SMTPTLSReport } from '../types';
import { humanTimestampToUnixTimestamp } from '../utils/timestamps';
import { LokiClient, type LokiClientOptions, LokiError } from './loki';

const rows = vi.hoisted(() => ({
  aggregate: undefined as CsvRow[] | undefined,
  failure: undefined as CsvRow[] | undefined,
  smtpTls: undefined as CsvRow[] | undefined,
}));

vi.mock('../aggregate', async importOriginal => {
  const original =
    await importOriginal<
      Record<'parsedAggregateReportsToCsvRows', (reports: unknown) => CsvRow[]>
    >();
  return {
    ...original,
    parsedAggregateReportsToCsvRows: (reports: unknown) =>
      rows.aggregate ?? original.parsedAggregateReportsToCsvRows(reports),
  };
});
vi.mock('../failure', async importOriginal => {
  const original =
    await importOriginal<
      Record<'parsedFailureReportsToCsvRows', (reports: unknown) => CsvRow[]>
    >();
  return {
    ...original,
    parsedFailureReportsToCsvRows: (reports: unknown) =>
      rows.failure ?? original.parsedFailureReportsToCsvRows(reports),
  };
});
vi.mock('../smtp-tls', async importOriginal => {
  const original =
    await importOriginal<
      Record<'parsedSmtpTlsReportsToCsvRows', (reports: unknown) => CsvRow[]>
    >();
  return {
    ...original,
    parsedSmtpTlsReportsToCsvRows: (reports: unknown) =>
      rows.smtpTls ?? original.parsedSmtpTlsReportsToCsvRows(reports),
  };
});

// Placeholders: the row conversion is replaced in most tests.
const AGGREGATE = {} as AggregateReport;
const FAILURE = {} as FailureReport;
const SMTP_TLS = {} as SMTPTLSReport;

const AGGREGATE_ROWS: CsvRow[] = [
  {
    org_name: 'google.com',
    report_id: 'r1',
    begin_date: '2026-10-20 00:00:00',
    end_date: '2026-10-20 23:59:59',
    domain: 'example.org',
    source_ip_address: '192.0.2.1',
    count: 3,
    dmarc_aligned: true,
  },
  {
    org_name: 'google.com',
    report_id: 'r1',
    begin_date: '2026-10-20 00:00:00',
    end_date: '2026-10-20 23:59:59',
    domain: 'lists.example.org',
    source_ip_address: '192.0.2.1',
    count: 1,
    dmarc_aligned: false,
  },
];
const FAILURE_ROWS: CsvRow[] = [
  {
    reported_domain: 'example.org',
    arrival_date_utc: '2026-10-20 09:20:27',
    source_ip_address: '192.0.2.1',
  },
];
const SMTP_TLS_ROWS: CsvRow[] = [
  {
    organization_name: 'Reporter',
    begin_date: '2026-10-20T00:00:00Z',
    policy_domain: 'example.org',
    failed_session_count: 1,
  },
];

const SAMPLE_AGGREGATE = fileURLToPath(
  new URL(
    '../../../../samples/aggregate/!example.com!1538204542!1538463818.xml',
    import.meta.url,
  ),
);

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

interface PushBody {
  streams: { stream: Record<string, string>; values: [string, string][] }[];
}

let fetchMock: FetchMock;
let logs: LogCapture;

beforeEach(() => {
  rows.aggregate = AGGREGATE_ROWS;
  rows.failure = FAILURE_ROWS;
  rows.smtpTls = SMTP_TLS_ROWS;
  fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function client(options: LokiClientOptions = {}): LokiClient {
  return new LokiClient('http://loki.example.org:3100', {
    labels: { host: 'mail.example.org' },
    ...options,
  });
}

function respond(status: number, body = ''): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(status === 204 ? null : body, {
        status,
        headers: status >= 300 && status < 400 ? { Location: '/x' } : {},
      }),
    ),
  );
}

/** The JSON bodies of every push request, in order. */
function pushes(): PushBody[] {
  return fetchMock.mock.calls.map(
    call => JSON.parse(String(call[1]?.body)) as PushBody,
  );
}

/** [labels, timestamp in ns, line] of every pushed entry. */
function entries(): [Record<string, string>, bigint, CsvRow][] {
  return pushes().flatMap(body =>
    body.streams.flatMap(stream =>
      stream.values.map(
        ([ts, line]) =>
          [stream.stream, BigInt(ts), JSON.parse(line) as CsvRow] as [
            Record<string, string>,
            bigint,
            CsvRow,
          ],
      ),
    ),
  );
}

function sentHeaders(index = 0): Headers {
  return new Headers(fetchMock.mock.calls[index]?.[1]?.headers);
}

describe('LokiClient init', () => {
  it('appends the push path to a base URL', () => {
    for (const url of ['http://loki:3100', 'http://loki:3100/']) {
      expect(new LokiClient(url).url).toBe('http://loki:3100/loki/api/v1/push');
    }
  });

  it('appends the push path before the query string', () => {
    for (const url of [
      'https://gw.example.org?route=logs',
      'https://gw.example.org/?route=logs',
    ]) {
      expect(new LokiClient(url).url).toBe(
        'https://gw.example.org/loki/api/v1/push?route=logs',
      );
    }
  });

  it('keeps an explicit push path', () => {
    expect(new LokiClient('https://gw.example.org/custom/push').url).toBe(
      'https://gw.example.org/custom/push',
    );
  });

  it('labels streams with job and host by default', () => {
    const labels = new LokiClient('http://loki:3100').labels;
    expect(Object.keys(labels)).toEqual(['job', 'host']);
    expect(labels.job).toBe('parsedmarc');
    expect(labels.host).toBeTruthy();
  });

  it('merges configured labels over the defaults', () => {
    const { labels } = new LokiClient('http://loki:3100', {
      labels: { host: 'mail2', env: 'prod' },
    });
    expect(labels).toEqual({ job: 'parsedmarc', host: 'mail2', env: 'prod' });
  });

  it('uses report_type and domain as label fields by default', () => {
    expect(new LokiClient('http://loki:3100').labelFields).toEqual([
      'report_type',
      'domain',
    ]);
  });

  it('rejects invalid label names', () => {
    expect(
      () => new LokiClient('http://loki:3100', { labels: { 'bad-name': 'x' } }),
    ).toThrow("Invalid Loki label name 'bad-name'");
    expect(
      () => new LokiClient('http://loki:3100', { labelFields: ['1field'] }),
    ).toThrow("Invalid Loki label name '1field'");
  });

  it('rejects an invalid timestamp mode', () => {
    expect(
      () =>
        new LokiClient('http://loki:3100', {
          timestamp: 'report_end' as 'ingest',
        }),
    ).toThrow(
      "Invalid Loki timestamp 'report_end'. Must be one of: ingest, report_begin",
    );
  });

  it('refuses a token together with basic auth', () => {
    expect(
      () =>
        new LokiClient('http://loki:3100', {
          username: 'u',
          password: 'p',
          token: 't',
        }),
    ).toThrow('Loki token and username/password are exclusive');
  });

  it('sends the content type, user agent, bearer token and tenant', async () => {
    const loki = client({ token: 'secret', tenantId: 'fosdem' });
    await loki.saveAggregateReportToLoki(AGGREGATE);
    const headers = sentHeaders();
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('User-Agent')).toContain('tsdmarc');
    expect(headers.get('Authorization')).toBe('Bearer secret');
    expect(headers.get('X-Scope-OrgID')).toBe('fosdem');
  });

  it('sends no auth headers by default', async () => {
    await client().saveAggregateReportToLoki(AGGREGATE);
    expect(sentHeaders().has('Authorization')).toBe(false);
    expect(sentHeaders().has('X-Scope-OrgID')).toBe(false);
  });

  it('sends basic auth', async () => {
    await client({ username: 'u', password: 'p' }).saveAggregateReportToLoki(
      AGGREGATE,
    );
    expect(sentHeaders().get('Authorization')).toBe(`Basic ${btoa('u:p')}`);
  });

  it('prefers username/password over URL credentials, like httpx', async () => {
    const loki = new LokiClient('http://a:b@loki.example.org:3100', {
      username: 'u',
      password: 'p',
    });
    await loki.saveAggregateReportToLoki(AGGREGATE);
    expect(sentHeaders().get('Authorization')).toBe(`Basic ${btoa('u:p')}`);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://loki.example.org:3100/loki/api/v1/push',
    );
  });

  it('turns URL credentials into basic auth', async () => {
    const loki = new LokiClient('http://a:b@loki.example.org:3100');
    await loki.saveAggregateReportToLoki(AGGREGATE);
    expect(sentHeaders().get('Authorization')).toBe(`Basic ${btoa('a:b')}`);
  });
});

describe('LokiClient URL credentials', () => {
  // GHSA-hjr3-rx4c-24cv: a password with an unencoded "/", "?" or "#" ends
  // the URL's authority early, so URL parsers read it as the port and quote
  // it in their errors.
  const malformed: [string, string][] = [
    ['https://admin:p4ssw0rd/w0rd@loki.example.org:3100', 'p4ssw0rd'],
    ['https://admin:p4ss?w0rd@loki.example.org:3100', 'p4ss'],
    ['https://admin:p4ss#w0rd@loki.example.org:3100', 'p4ss'],
  ];

  it('rejects an invalid URL with a fixed message', () => {
    for (const [url, secret] of malformed) {
      let thrown: unknown;
      try {
        new LokiClient(url);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error;
      expect(error.name).toBe('ValueError');
      expect(error.message).toBe(
        'Invalid Loki URL (details withheld because they may include credentials)',
      );
      expect(error.cause).toBeUndefined();
      expect(String(error.stack)).not.toContain(secret);
    }
  });

  it('keeps the userinfo of a valid URL for requests', () => {
    expect(
      new LokiClient('https://admin:p4ssw0rd@loki.example.org:3100').url,
    ).toBe('https://admin:p4ssw0rd@loki.example.org:3100/loki/api/v1/push');
  });
});

describe('LokiClient aggregate reports', () => {
  it('writes one line per record, with report_type', async () => {
    await client().saveAggregateReportToLoki(AGGREGATE);
    const lines = entries().map(entry => entry[2]);
    expect(lines).toEqual(
      AGGREGATE_ROWS.map(row => ({ ...row, report_type: 'aggregate' })),
    );
  });

  it('splits streams by the label fields', async () => {
    await client().saveAggregateReportToLoki(AGGREGATE);
    const streams = (pushes()[0]?.streams ?? [])
      .map(stream => stream.stream)
      .toSorted((a, b) => (a.domain ?? '').localeCompare(b.domain ?? ''));
    expect(streams).toEqual([
      {
        job: 'parsedmarc',
        host: 'mail.example.org',
        report_type: 'aggregate',
        domain: 'example.org',
      },
      {
        job: 'parsedmarc',
        host: 'mail.example.org',
        report_type: 'aggregate',
        domain: 'lists.example.org',
      },
    ]);
  });

  it('uses custom label fields', async () => {
    await client({ labelFields: ['org_name'] }).saveAggregateReportToLoki(
      AGGREGATE,
    );
    const streams = pushes()[0]?.streams ?? [];
    expect(streams).toHaveLength(1);
    expect(streams[0]?.stream.org_name).toBe('google.com');
    expect(streams[0]?.stream).not.toHaveProperty('domain');
  });

  it('leaves out empty or missing label values', async () => {
    rows.aggregate = [{ domain: '', org_name: null }];
    await client({
      labelFields: ['domain', 'org_name', 'nope'],
    }).saveAggregateReportToLoki(AGGREGATE);
    expect(Object.keys(pushes()[0]?.streams[0]?.stream ?? {})).toEqual([
      'job',
      'host',
    ]);
  });

  it('timestamps entries at ingest, unique per line', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    await client().saveAggregateReportToLoki(AGGREGATE);
    const stamps = entries()
      .map(([, ts]) => ts)
      .toSorted((a, b) => Number(a - b));
    expect(stamps).toEqual([1_000_000_000_000n, 1_000_000_000_001n]);
  });

  it('timestamps entries at the report begin', async () => {
    await client({ timestamp: 'report_begin' }).saveAggregateReportToLoki(
      AGGREGATE,
    );
    const begin =
      BigInt(
        humanTimestampToUnixTimestamp('2026-10-20 00:00:00', {
          assumeUtc: true,
        }),
      ) * 1_000_000_000n;
    const stamps = entries()
      .map(([, ts]) => ts)
      .toSorted((a, b) => Number(a - b));
    expect(stamps).toEqual([begin, begin + 1n]);
  });

  it('falls back to the ingest time for an unparsable begin', async () => {
    rows.aggregate = [{ domain: 'example.org', begin_date: 'garbage' }];
    vi.useFakeTimers({ toFake: ['Date'], now: 42 });
    await client({ timestamp: 'report_begin' }).saveAggregateReportToLoki(
      AGGREGATE,
    );
    expect(entries().map(([, ts]) => ts)).toEqual([42_000_000n]);
    expect(logs.output).toContain(
      'DEBUG:tsdmarc:Unparsable begin_date, using ingest time',
    );
  });

  it('sends timestamps and lines as strings', async () => {
    await client().saveAggregateReportToLoki(AGGREGATE);
    for (const stream of pushes()[0]?.streams ?? []) {
      for (const [ts, line] of stream.values) {
        expect(typeof ts).toBe('string');
        expect(typeof line).toBe('string');
      }
    }
  });

  it('splits large reports into batches', async () => {
    rows.aggregate = Array.from({ length: 5 }, (_, index) => ({
      ...AGGREGATE_ROWS[0],
      report_id: String(index),
    }));
    await client({ batchSize: 2 }).saveAggregateReportToLoki(AGGREGATE);
    const sizes = pushes().map(body =>
      body.streams.reduce((sum, stream) => sum + stream.values.length, 0),
    );
    expect(sizes).toEqual([2, 2, 1]);
    expect(new Set(entries().map(([, ts]) => ts)).size).toBe(5);
  });

  it('sends nothing without rows', async () => {
    rows.aggregate = [];
    await client().saveAggregateReportToLoki([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to the push URL with the timeout, without following redirects', async () => {
    vi.spyOn(AbortSignal, 'timeout');
    await client({ timeout: 12 }).saveAggregateReportToLoki(AGGREGATE);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://loki.example.org:3100/loki/api/v1/push');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(AbortSignal.timeout).toHaveBeenCalledWith(12_000);
  });

  it('logs the number of records', async () => {
    await client().saveAggregateReportToLoki(AGGREGATE);
    expect(logs.output).toContain(
      'DEBUG:tsdmarc:Saving 2 aggregate records to Loki',
    );
  });
});

describe('LokiClient ordering', () => {
  // Loki rejects entries more than max_chunk_age/2 behind the newest line
  // of a stream (too_far_behind), so entries are pushed oldest first even
  // though multi-day aggregate rows arrive source-major.
  it('sends report_begin entries in timestamp order', async () => {
    rows.aggregate = ['192.0.2.1', '192.0.2.2'].flatMap(ip =>
      [1, 2, 3].map(day => ({
        source_ip_address: ip,
        begin_date: `2024-01-0${day} 00:00:00`,
      })),
    );
    await client({
      timestamp: 'report_begin',
      batchSize: 2,
    }).saveAggregateReportToLoki(AGGREGATE);
    const stamps = entries().map(([, ts]) => ts);
    expect(stamps).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stamps).toEqual(stamps.toSorted((a, b) => Number(a - b)));
  });
});

describe('LokiClient other report types', () => {
  it('labels failure reports by reported domain, with a UTC begin', async () => {
    await client({ timestamp: 'report_begin' }).saveFailureReportToLoki(
      FAILURE,
    );
    const [[labels, ts, line] = [{}, 0n, {}]] = entries();
    expect(labels.report_type).toBe('failure');
    expect(labels.domain).toBe('example.org');
    expect(line.domain).toBe('example.org');
    expect(ts).toBe(
      BigInt(
        humanTimestampToUnixTimestamp('2026-10-20 09:20:27', {
          assumeUtc: true,
        }),
      ) * 1_000_000_000n,
    );
  });

  it('keeps the forensic alias', async () => {
    await client().saveForensicReportToLoki(FAILURE);
    expect(entries()[0]?.[0].report_type).toBe('failure');
  });

  it('labels SMTP TLS reports by policy domain', async () => {
    await client({ timestamp: 'report_begin' }).saveSmtpTlsReportToLoki(
      SMTP_TLS,
    );
    const [[labels, ts, line] = [{}, 0n, {}]] = entries();
    expect(labels.report_type).toBe('smtp_tls');
    expect(labels.domain).toBe('example.org');
    expect(line.policy_domain).toBe('example.org');
    expect(ts).toBe(
      BigInt(humanTimestampToUnixTimestamp('2026-10-20T00:00:00Z')) *
        1_000_000_000n,
    );
  });

  it('overwrites only report_type among existing fields', async () => {
    rows.aggregate = [{ domain: 'a.example', report_type: 'x' }];
    await client().saveAggregateReportToLoki(AGGREGATE);
    const line = entries()[0]?.[2];
    expect(line?.domain).toBe('a.example');
    expect(line?.report_type).toBe('aggregate');
    // The key keeps its place, like a Python dict update.
    expect(Object.keys(line ?? {})).toEqual(['domain', 'report_type']);
  });
});

describe('LokiClient errors', () => {
  // A failed push must throw: the CLI then keeps the mailbox messages for a
  // retry instead of archiving reports that were never stored.
  it('throws with the status and body on an error status', async () => {
    respond(400, 'entry too far behind');
    const error = await client()
      .saveAggregateReportToLoki(AGGREGATE)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LokiError);
    expect(String(error)).toContain('400');
    expect(String(error)).toContain('entry too far behind');
  });

  it('throws on a server error', async () => {
    respond(503);
    await expect(client().saveAggregateReportToLoki(AGGREGATE)).rejects.toThrow(
      LokiError,
    );
  });

  it('throws on a network error', async () => {
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('refused') }),
    );
    const error = await client()
      .saveAggregateReportToLoki(AGGREGATE)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LokiError);
    expect(String(error)).toContain('refused');
  });

  it('masks the URL password in errors', async () => {
    const secret = 's3cr3t-loki-pw';
    const loki = new LokiClient(`http://u:${secret}@loki.example.org:3100`);
    respond(500);
    const statusError = await loki
      .saveAggregateReportToLoki(AGGREGATE)
      .catch((thrown: unknown) => thrown);
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('refused') }),
    );
    const networkError = await loki
      .saveAggregateReportToLoki(AGGREGATE)
      .catch((thrown: unknown) => thrown);
    for (const error of [statusError, networkError]) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain('http://u:***@loki.example.org:3100');
    }
    // The credentials still go to the server, as basic auth.
    expect(sentHeaders(1).get('Authorization')).toBe(
      `Basic ${btoa(`u:${secret}`)}`,
    );
  });

  it('treats the blocked-ingestion 260 as a failure', async () => {
    respond(260, 'ingestion blocked');
    await expect(client().saveAggregateReportToLoki(AGGREGATE)).rejects.toThrow(
      'failed with HTTP 260: ingestion blocked',
    );
  });

  it('quotes at most 500 characters of the body', async () => {
    respond(400, 'é'.repeat(600));
    await expect(client().saveAggregateReportToLoki(AGGREGATE)).rejects.toThrow(
      /HTTP 400: é{500}$/u,
    );
  });

  it('accepts 200 and 204', async () => {
    for (const status of [200, 204]) {
      respond(status);
      // oxlint-disable-next-line no-await-in-loop -- one push per status
      await client().saveAggregateReportToLoki(AGGREGATE);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses to push after close', async () => {
    const loki = client();
    loki.close();
    await expect(loki.saveAggregateReportToLoki(AGGREGATE)).rejects.toThrow(
      'Cannot send a request, as the client has been closed.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('LokiClient redirects', () => {
  // httpx turns a redirected POST into a GET, which the target would answer
  // 200 without storing anything; a 3xx must throw instead.
  const withServer = async (
    run: (port: number, requested: string[]) => Promise<void>,
  ): Promise<void> => {
    vi.unstubAllGlobals();
    const requested: string[] = [];
    const server = createServer((request: IncomingMessage, response) => {
      requested.push(`${request.method} ${request.url}`);
      if (request.url === '/loki/api/v1/push') {
        response.writeHead(301, { Location: '/ok' }).end();
      } else {
        response.writeHead(200).end();
      }
    });
    await new Promise<void>(resolve => {
      server.listen(0, 'localhost', resolve);
    });
    try {
      await run((server.address() as AddressInfo).port, requested);
    } finally {
      await new Promise(resolve => {
        server.close(resolve);
      });
    }
  };

  it('does not follow a redirect', async () => {
    await withServer(async (port, requested) => {
      const loki = new LokiClient(`http://localhost:${port}`, { timeout: 5 });
      await expect(loki.saveAggregateReportToLoki(AGGREGATE)).rejects.toThrow(
        'failed with HTTP 301',
      );
      expect(requested).toEqual(['POST /loki/api/v1/push']);
    });
  });
});

describe('LokiClient real reports', () => {
  beforeEach(() => {
    rows.aggregate = undefined;
    rows.failure = undefined;
    rows.smtpTls = undefined;
  });

  it('pushes the aggregate sample', async () => {
    const parsed = await parseReportFile(SAMPLE_AGGREGATE, { offline: true });
    await client().saveAggregateReportToLoki(parsed.report as AggregateReport);
    const all = entries();
    expect(all).toHaveLength(1);
    const [labels, , line] = all[0] ?? [{}, 0n, {}];
    expect(labels.domain).toBe('example.com');
    expect(line.source_ip_address).toBe(
      (parsed.report as AggregateReport).records[0]?.source.ipAddress,
    );
    expect(line.report_type).toBe('aggregate');
  });

  it('timestamps the aggregate sample at its UTC <begin>', async () => {
    // The row's interval_begin is naive UTC, so the timestamp is the XML
    // <begin> epoch whatever the local zone.
    const parsed = await parseReportFile(SAMPLE_AGGREGATE, { offline: true });
    await client({ timestamp: 'report_begin' }).saveAggregateReportToLoki(
      parsed.report as AggregateReport,
    );
    expect(new Set(entries().map(([, ts]) => ts))).toEqual(
      new Set([1_538_413_632n * 1_000_000_000n]),
    );
  });
});
