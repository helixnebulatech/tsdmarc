// The real v9 client against a loopback HTTP server: checks the headers
// that make it work with Elasticsearch 8 and 9 servers.
//
// The v9 client sends `compatible-with=9` vendored media types, which an
// Elasticsearch 8 server rejects. setHosts() replaces them with
// `compatible-with=8` (what parsedmarc's v8 client sends; Elasticsearch 9
// accepts it through REST API compatibility), and bulk requests keep their
// NDJSON media type.

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateIndexes, setHosts } from './elastic';

interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const seen: SeenRequest[] = [];
let server: Server;
let baseUrl = '';

function respond(request: SeenRequest): [number, unknown] {
  const path = request.url.split('?')[0] ?? '';
  if (request.method === 'HEAD') {
    return [path === '/dmarc_aggregate' ? 200 : 404, null];
  }
  if (path.endsWith('/_mapping/field/published_policy.fo')) {
    return [
      200,
      {
        dmarc_aggregate: {
          mappings: {
            'published_policy.fo': {
              full_name: 'published_policy.fo',
              mapping: { fo: { type: 'long' } },
            },
          },
        },
      },
    ];
  }
  if (path.startsWith('/_data_stream/')) {
    return [404, { error: { type: 'index_not_found_exception' } }];
  }
  if (path === '/dmarc_aggregate/_search') {
    return [
      200,
      {
        _scroll_id: 's1',
        _shards: { total: 1, successful: 1, skipped: 0 },
        hits: {
          hits: [{ _index: 'dmarc_aggregate', _id: 'a', _source: { x: 1 } }],
        },
      },
    ];
  }
  if (path === '/_search/scroll' && request.method === 'POST') {
    return [200, { _scroll_id: 's1', _shards: {}, hits: { hits: [] } }];
  }
  if (path === '/_bulk') {
    return [200, { errors: false, items: [{ index: { status: 201 } }] }];
  }
  return [200, { acknowledged: true }];
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const entry: SeenRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      };
      seen.push(entry);
      const [status, payload] = respond(entry);
      response.writeHead(status, {
        'content-type': 'application/json',
        'x-elastic-product': 'Elasticsearch',
      });
      response.end(payload === null ? '' : JSON.stringify(payload));
    });
  });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => {
    server.close(() => {
      resolve();
    });
  });
});

describe('REST API compatibility headers', () => {
  it('asks for compatible-with=8 on JSON and bulk requests', async () => {
    const client = await setHosts(baseUrl);
    try {
      await migrateIndexes({ legacyFoIndexes: ['dmarc_aggregate'] });
    } finally {
      await client.close();
    }
    const paths = seen.map(request => `${request.method} ${request.url}`);
    expect(paths).toContain('POST /_bulk');
    for (const request of seen) {
      expect(request.headers.accept).toBe(
        'application/vnd.elasticsearch+json; compatible-with=8',
      );
      const contentType = request.headers['content-type'];
      if (request.url.startsWith('/_bulk')) {
        expect(contentType).toBe(
          'application/vnd.elasticsearch+x-ndjson; compatible-with=8',
        );
        expect(request.body.trim().split('\n')).toEqual([
          '{"index":{"_id":"a","_index":"dmarc_aggregate-v2"}}',
          '{"x":1}',
        ]);
      } else if (request.body !== '') {
        expect(contentType).toBe(
          'application/vnd.elasticsearch+json; compatible-with=8',
        );
      }
    }
    // The migration ran to the end: the original index was dropped.
    expect(paths.at(-1)).toBe('DELETE /dmarc_aggregate');
  });
});
