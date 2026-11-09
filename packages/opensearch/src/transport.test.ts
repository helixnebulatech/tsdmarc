// The real OpenSearch client against a loopback HTTP server: retries must
// follow opensearch-py (max_retries=3 on connection errors and 502/503/504,
// retry_on_timeout=False), so a slow write is never sent twice.

import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { errors } from '@opensearch-project/opensearch';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { setHosts } from './opensearch';

const awsSdk = vi.hoisted(() => ({ loaded: false }));

vi.mock('@aws-sdk/credential-providers', () => {
  awsSdk.loaded = true;
  return { fromNodeProviderChain: vi.fn() };
});

type Mode = 'hang' | 'ok' | 'unavailable' | 'bad-request';

let mode: Mode = 'ok';
let requests = 0;
const hanging: ServerResponse[] = [];
let server: Server;
let port = 0;

const SHORT_TIMEOUT_SECONDS = 0.2;
// Only the timeout test needs a short timeout; the others must not time
// out on a loaded machine.
const GENEROUS_TIMEOUT_SECONDS = 60;
const SETTLE_MS = 300;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests += 1;
      if (mode === 'hang') {
        hanging.push(response);
        return;
      }
      const status = { ok: 201, unavailable: 503, 'bad-request': 400 }[mode];
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: 'created' }));
    });
  });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  ({ port } = server.address() as AddressInfo);
});

afterAll(async () => {
  for (const response of hanging) {
    response.destroy();
  }
  server.closeAllConnections();
  await new Promise<void>(resolve => {
    server.close(() => {
      resolve();
    });
  });
});

beforeEach(() => {
  requests = 0;
});

async function indexOnce(timeout = GENEROUS_TIMEOUT_SECONDS): Promise<unknown> {
  const client = await setHosts(`127.0.0.1:${port}`, { timeout });
  try {
    return await client
      .index({ index: 'dmarc_aggregate-2026-10-24', body: { a: 1 } })
      .catch((error: unknown) => error);
  } finally {
    await client.close();
  }
}

describe('retries', () => {
  it('does not resend a request that timed out', async () => {
    mode = 'hang';
    const error = await indexOnce(SHORT_TIMEOUT_SECONDS);
    expect(error).toBeInstanceOf(errors.TimeoutError);
    // Give a (wrong) retry the time to reach the server.
    await new Promise(resolve => {
      setTimeout(resolve, SETTLE_MS);
    });
    expect(requests).toBe(1);
  });

  it('retries 503 three times like opensearch-py', async () => {
    mode = 'unavailable';
    const error = await indexOnce();
    expect(error).toBeInstanceOf(errors.ResponseError);
    expect(
      (error as InstanceType<typeof errors.ResponseError>).statusCode,
    ).toBe(503);
    expect(requests).toBe(4);
  });

  it('does not retry other errors', async () => {
    mode = 'bad-request';
    const error = await indexOnce();
    expect(error).toBeInstanceOf(errors.ResponseError);
    expect(requests).toBe(1);
  });

  it('retries a connection error three times', async () => {
    // A port nobody listens on: every attempt is refused.
    const closed = createServer();
    await new Promise<void>(resolve => {
      closed.listen(0, '127.0.0.1', resolve);
    });
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>(resolve => {
      closed.close(() => {
        resolve();
      });
    });
    const client = await setHosts(`127.0.0.1:${closedPort}`);
    const attempts: number[] = [];
    client.on('request', (_error, result) => {
      attempts.push(result.meta.attempts);
    });
    const error = await client
      .index({ index: 'x', body: {} })
      .catch((caught: unknown) => caught);
    await client.close();
    expect(error).toBeInstanceOf(errors.ConnectionError);
    expect(attempts).toHaveLength(4);
  });

  it('succeeds without retrying', async () => {
    mode = 'ok';
    const response = (await indexOnce()) as { statusCode: number };
    expect(response.statusCode).toBe(201);
    expect(requests).toBe(1);
  });

  it('supports callbacks', async () => {
    mode = 'unavailable';
    const client = await setHosts(`127.0.0.1:${port}`);
    const outcome = await new Promise<[unknown, unknown]>(resolve => {
      client.transport.request(
        { method: 'GET', path: '/' },
        {},
        (error, result) => {
          resolve([error, result.statusCode]);
        },
      );
    });
    await client.close();
    expect(outcome[0]).toBeInstanceOf(errors.ResponseError);
    expect(outcome[1]).toBe(503);
    expect(requests).toBe(4);
  });
});

describe('lazy AWS SDK', () => {
  it('basic auth does not load @aws-sdk/credential-providers', async () => {
    const client = await setHosts(`127.0.0.1:${port}`);
    await client.close();
    expect(awsSdk.loaded).toBe(false);
  });
});
