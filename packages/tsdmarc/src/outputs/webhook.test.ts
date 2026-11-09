// Port of tests/test_webhook.py. `fetch` is the SDK boundary.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureLogs, type LogCapture } from '../log';
import { WebhookClient } from './webhook';

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function client(): WebhookClient {
  return new WebhookClient(
    'http://agg.example.com',
    'http://fail.example.com',
    'http://tls.example.com',
  );
}

let fetchMock: FetchMock;
let logs: LogCapture;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response('ok', { status: 200 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
  vi.unstubAllGlobals();
});

function sent(index = 0): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`fetch call ${index} not made`);
  }
  return { url: String(call[0]), init: call[1] ?? {} };
}

function sentHeaders(index = 0): Headers {
  return new Headers(sent(index).init.headers);
}

describe('WebhookClient init', () => {
  // The constructor stores URLs per report type. A mix-up here would route
  // reports to the wrong endpoint silently.
  it('stores urls and the default timeout', () => {
    const webhook = client();
    expect(webhook.aggregateUrl).toBe('http://agg.example.com');
    expect(webhook.failureUrl).toBe('http://fail.example.com');
    expect(webhook.smtpTlsUrl).toBe('http://tls.example.com');
    expect(webhook.timeout).toBe(60);
  });

  it('respects a custom timeout', () => {
    const webhook = new WebhookClient('a', 'f', 't', { timeout: 120 });
    expect(webhook.timeout).toBe(120);
  });

  it('accepts timeout null (no timeout)', async () => {
    const webhook = new WebhookClient('a', 'f', 't', { timeout: null });
    expect(webhook.timeout).toBeNull();
    await webhook.sendToWebhook('http://agg.example.com', 'x');
    expect(sent().init.signal?.aborted).toBe(false);
  });

  it('sends the JSON content type and user agent', async () => {
    // The Content-Type is required by virtually every webhook receiver to
    // know how to deserialize the body.
    await client().saveAggregateReportToWebhook('{"agg": 1}');
    expect(sentHeaders().get('Content-Type')).toBe('application/json');
    expect(sentHeaders().get('User-Agent')).toContain('tsdmarc');
  });
});

describe('WebhookClient save methods', () => {
  // Each save* sends the payload to the URL configured for that report type.
  it('posts aggregate reports to the aggregate url', async () => {
    await client().saveAggregateReportToWebhook('{"agg": 1}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent().url).toBe('http://agg.example.com');
    expect(sent().init.method).toBe('POST');
    expect(sent().init.body).toBe('{"agg": 1}');
    expect(sent().init.redirect).toBe('follow');
  });

  it('posts failure reports to the failure url', async () => {
    await client().saveFailureReportToWebhook('{"fail": 1}');
    expect(sent().url).toBe('http://fail.example.com');
    expect(sent().init.body).toBe('{"fail": 1}');
  });

  it('posts SMTP TLS reports to the SMTP TLS url', async () => {
    await client().saveSmtpTlsReportToWebhook('{"tls": 1}');
    expect(sent().url).toBe('http://tls.example.com');
    expect(sent().init.body).toBe('{"tls": 1}');
  });

  it('applies the timeout to each request', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const started = Date.now();
    await new WebhookClient('http://a.example.com', '', '', {
      timeout: 0.05,
    }).saveAggregateReportToWebhook('{}');
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(logs.output.some(line => line.includes('Webhook Error'))).toBe(true);
  });
});

describe('WebhookClient object payload', () => {
  // An object payload is form-encoded (httpx `data=`); string/bytes payloads
  // are sent as the raw body (httpx `content=`).
  it('form-encodes an object payload', async () => {
    await client().sendToWebhook('http://agg.example.com', { agg: '1' });
    const { body } = sent().init;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(String(body)).toBe('agg=1');
    // The client-level JSON content type wins, as in httpx.
    expect(sentHeaders().get('Content-Type')).toBe('application/json');
  });

  it('sends a bytes payload as is', async () => {
    const payload = new TextEncoder().encode('{"b": 1}');
    await client().sendToWebhook('http://agg.example.com', payload);
    expect(sent().init.body).toBe(payload);
  });
});

describe('WebhookClient error handling', () => {
  // HTTP / network failures must NOT abort the surrounding batch: they are
  // logged and swallowed.
  it('logs and swallows network errors', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    await expect(
      client().saveAggregateReportToWebhook('{"a": 1}'),
    ).resolves.toBeUndefined();
    const errors = logs.output.filter(line => line.startsWith('ERROR:'));
    expect(errors.some(line => line.includes('Webhook Error'))).toBe(true);
    expect(errors.some(line => line.includes('connection refused'))).toBe(true);
  });

  it('includes the low-level cause of a fetch failure', async () => {
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }),
    );
    await client().saveAggregateReportToWebhook('{}');
    expect(logs.output).toContain(
      'ERROR:tsdmarc:Webhook Error: fetch failed: ECONNREFUSED',
    );
  });

  it('swallows errors in the failure save', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    await client().saveFailureReportToWebhook('{"f": 1}');
    expect(logs.output).toContain('ERROR:tsdmarc:Webhook Error: timeout');
  });

  it('swallows errors in the SMTP TLS save', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    await client().saveSmtpTlsReportToWebhook('{"t": 1}');
    expect(logs.output).toContain('ERROR:tsdmarc:Webhook Error: boom');
  });

  it('does not log HTTP error statuses (no raise_for_status upstream)', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await client().saveAggregateReportToWebhook('{}');
    expect(logs.output.filter(line => line.startsWith('ERROR:'))).toEqual([]);
  });

  it('releases the response body instead of leaving it to GC', async () => {
    let cancelled = false;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    await client().saveAggregateReportToWebhook('{}');
    expect(cancelled).toBe(true);
    // Not read: an endless body would never finish.
    expect(pulled).toBeLessThan(5);
    expect(logs.output.filter(line => line.startsWith('ERROR:'))).toEqual([]);
  });
});

describe('WebhookClient throwOnError', () => {
  // The CLI turns it on: a report the webhook didn't take must count as
  // not saved, or its email is deleted (or archived) all the same.
  function throwing(): WebhookClient {
    return new WebhookClient(
      'http://agg.example.com',
      'http://fail.example.com',
      'http://tls.example.com',
      { throwOnError: true },
    );
  }

  it('is off by default', () => {
    expect(client().throwOnError).toBe(false);
  });

  it('throws a network error with its cause, without logging it', async () => {
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }),
    );
    await expect(throwing().saveAggregateReportToWebhook('{}')).rejects.toThrow(
      'fetch failed: ECONNREFUSED',
    );
    expect(logs.output).toEqual([]);
  });

  it.each([
    'saveFailureReportToWebhook',
    'saveSmtpTlsReportToWebhook',
  ] as const)('throws from %s', async method => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    await expect(throwing()[method]('{}')).rejects.toThrow('timeout');
  });

  it.each([301, 404, 500, 503])(
    'throws on HTTP %i, without the URL in the message',
    async status => {
      fetchMock.mockResolvedValue(new Response(null, { status }));
      const webhook = new WebhookClient(
        'http://hook.example.com/secret-token',
        '',
        '',
        { throwOnError: true },
      );
      const error: unknown = await webhook
        .saveAggregateReportToWebhook('{}')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `Webhook responded with HTTP ${status}`,
      );
    },
  );

  it.each([200, 202, 204])('accepts HTTP %i', async status => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(
      throwing().saveAggregateReportToWebhook('{}'),
    ).resolves.toBeUndefined();
    expect(logs.output).toEqual([]);
  });

  it('throws after close', async () => {
    const webhook = throwing();
    webhook.close();
    await expect(webhook.saveAggregateReportToWebhook('{}')).rejects.toThrow(
      'Cannot send a request, as the client has been closed.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when a real server answers 500', async () => {
    vi.unstubAllGlobals();
    const server = createServer((_request, response) => {
      response.writeHead(500).end('down');
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    try {
      const webhook = new WebhookClient(`http://127.0.0.1:${port}/`, '', '', {
        throwOnError: true,
        timeout: 5,
      });
      await expect(webhook.saveAggregateReportToWebhook('{}')).rejects.toThrow(
        'Webhook responded with HTTP 500',
      );
    } finally {
      await new Promise(resolve => {
        server.close(resolve);
      });
    }
  });
});

describe('WebhookClient URLs', () => {
  it('delivers to a URL with credentials through the real fetch', async () => {
    vi.unstubAllGlobals();
    const requests: { url?: string; authorization?: string }[] = [];
    const server = createServer((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      request.resume();
      request.on('end', () => response.end('ok'));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await new WebhookClient(
        `http://user:p%40ss@127.0.0.1:${port}/hook`,
        '',
        '',
      ).saveAggregateReportToWebhook('{}');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    expect(requests).toEqual([
      { url: '/hook', authorization: 'Basic dXNlcjpwQHNz' },
    ]);
    expect(logs.output.filter(line => line.startsWith('ERROR:'))).toEqual([]);
  });

  it.each([
    ['no scheme', 'hooks.slack.example/services/T/B/SECRET'],
    ['credentials', 'http://user:SECRET@127.0.0.1:9/hook'],
    ['a token path', 'http://127.0.0.1:9/services/T/B/SECRET'],
  ])('keeps a URL with %s out of the log', async (_name, url) => {
    vi.unstubAllGlobals();
    await new WebhookClient(url, '', '').saveAggregateReportToWebhook('{}');
    expect(logs.output.some(line => line.includes('Webhook Error'))).toBe(true);
    expect(logs.output.join('\n')).not.toContain('SECRET');
  });
});

// parsedmarc's TestWebhookClientUrlCredentials (GHSA-hjr3-rx4c-24cv).
describe('WebhookClient malformed URL credentials', () => {
  const malformed: [string, string][] = [
    ['https://admin:p4ssw0rd/x@hooks.example/x', 'p4ssw0rd'],
    ['https://admin:p4ss?w0rd@hooks.example/x', 'p4ss'],
    ['https://admin:p4ss#w0rd@hooks.example/x', 'p4ss'],
  ];
  const saves = [
    'saveAggregateReportToWebhook',
    'saveFailureReportToWebhook',
    'saveSmtpTlsReportToWebhook',
  ] as const;
  const message =
    'invalid webhook URL (details withheld because they may include credentials)';

  it.each(malformed)(
    'test_invalid_url_is_logged_without_password: %s',
    async (url, secret) => {
      const webhook = new WebhookClient(url, url, url);
      for (const method of saves) {
        // oxlint-disable-next-line no-await-in-loop -- one save at a time
        await webhook[method]('{"a": 1}');
      }
      expect(logs.output).toEqual(
        saves.map(() => `ERROR:tsdmarc:Webhook Error: ${message}`),
      );
      expect(logs.output.join('\n')).not.toContain(secret);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(malformed)(
    'throws the fixed message with throwOnError: %s',
    async (url, secret) => {
      const webhook = new WebhookClient(url, url, url, { throwOnError: true });
      const error: unknown = await webhook
        .saveAggregateReportToWebhook('{}')
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(message);
      expect((error as Error).cause).toBeUndefined();
      expect(String((error as Error).stack)).not.toContain(secret);
      expect(logs.output).toEqual([]);
    },
  );

  it('test_valid_url_is_the_one_posted', async () => {
    const url = 'https://admin:p4ssw0rd@hooks.example/x';
    await new WebhookClient(url, url, url).saveAggregateReportToWebhook(
      '{"a": 1}',
    );
    expect(sent().url).toBe('https://hooks.example/x');
    expect(sentHeaders().get('Authorization')).toBe(
      `Basic ${Buffer.from('admin:p4ssw0rd').toString('base64')}`,
    );
  });
});

describe('WebhookClient close', () => {
  it('refuses requests after close and logs the error', async () => {
    const webhook = client();
    webhook.close();
    await webhook.saveAggregateReportToWebhook('{}');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs.output).toContain(
      'ERROR:tsdmarc:Webhook Error: Cannot send a request, as the client has been closed.',
    );
  });

  it('aborts in-flight requests', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(signal?.reason));
        }),
    );
    const webhook = client();
    const pending = webhook.saveAggregateReportToWebhook('{}');
    await Promise.resolve();
    webhook.close();
    await pending;
    expect(signal?.aborted).toBe(true);
  });
});

describe('WebhookClient backward-compatible alias', () => {
  it('saveForensicReportToWebhook posts to the failure url', async () => {
    await client().saveForensicReportToWebhook('{"fail": 1}');
    expect(sent().url).toBe('http://fail.example.com');
    expect(sent().init.body).toBe('{"fail": 1}');
  });
});
