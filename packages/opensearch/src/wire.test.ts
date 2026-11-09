// The real OpenSearch client against a loopback HTTP server: tsdmarc must
// put the same HTTP requests on the wire (method, path, query string and
// JSON body) as parsedmarc with opensearch-py, for every recorded case.

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  type AggregateReport,
  type FailureReport,
  parseAggregateReportXml,
  parseSmtpTlsReportJson,
  type SMTPTLSReport,
} from 'tsdmarc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AlreadySaved,
  createDataStreams,
  createIndexes,
  migrateIndexes,
  saveAggregateReportToOpenSearch,
  saveFailureReportToOpenSearch,
  saveSmtpTlsReportToOpenSearch,
  setHosts,
  type MigrateIndexesOptions,
  type SaveOptions,
} from './opensearch';
import {
  caseOptions,
  caseReport,
  expected,
  type ClusterState,
  type RecordedRequest,
  type SaveCase,
  withDeviations,
} from './test/expected';

interface WireRequest extends RecordedRequest {
  body?: unknown;
}

let state: ClusterState = {};
let scrollPages: unknown[][] = [];
let seen: WireRequest[] = [];
/** Request bodies as sent (JSON.parse would round big integers). */
let rawBodies: string[] = [];
/** Applied to response bodies, for what `JSON.stringify` cannot write. */
let rewriteResponse = (text: string): string => text;
let server: Server;
let port = 0;

function respond(method: string, path: string): [number, unknown] {
  const parts = path.split('/').filter(Boolean);
  const last = parts.at(-1) ?? '';
  if (method === 'HEAD') {
    return [state.exists?.[parts[0] ?? ''] ? 200 : 404, null];
  }
  if (method === 'GET' && parts[0] === '_data_stream') {
    if (state.data_streams === null || state.data_streams === undefined) {
      return [
        404,
        { error: { type: 'index_not_found_exception' }, status: 404 },
      ];
    }
    return [200, { data_streams: state.data_streams.map(name => ({ name })) }];
  }
  if (path === '/_search/scroll') {
    if (method === 'DELETE') {
      return [200, { succeeded: true }];
    }
    return [
      200,
      {
        _scroll_id: 'scroll-1',
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { hits: scrollPages.shift() ?? [] },
      },
    ];
  }
  if (last === '_search') {
    const scrolling = seen.at(-1)?.params?.scroll !== undefined;
    if (scrolling) {
      return respond('POST', '/_search/scroll');
    }
    const hits = Array.from({ length: state.search_hits ?? 0 }, (_, id) => ({
      _index: 'x',
      _id: String(id),
      _source: {},
    }));
    return [200, { hits: { total: { value: hits.length }, hits } }];
  }
  if (last === '_count') {
    return [200, { count: state.count ?? 0 }];
  }
  if (last === '_update_by_query') {
    return [200, { task: 'node:1' }];
  }
  if (parts[1] === '_mapping' && parts[2] === 'field') {
    return [200, state.field_mapping ?? { [parts[0] ?? '']: { mappings: {} } }];
  }
  if (last === '_bulk') {
    return [200, { errors: false, items: [] }];
  }
  if (last === '_doc') {
    return [201, { result: 'created' }];
  }
  return [200, { acknowledged: true }];
}

function parseBody(path: string, text: string): unknown {
  if (text === '') {
    return undefined;
  }
  if (path.endsWith('/_bulk')) {
    return text
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as unknown);
  }
  return JSON.parse(text) as unknown;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      text += chunk;
    });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      const method = request.method ?? '';
      const entry: WireRequest = { method, path };
      if (url.searchParams.size > 0) {
        entry.params = Object.fromEntries(url.searchParams);
      }
      rawBodies.push(text);
      const body = parseBody(path, text);
      if (body !== undefined) {
        entry.body = body;
      }
      seen.push(entry);
      const [status, payload] = respond(method, path);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        payload === null ? '' : rewriteResponse(JSON.stringify(payload)),
      );
    });
  });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  ({ port } = server.address() as AddressInfo);
});

afterAll(async () => {
  await new Promise<void>(resolve => {
    server.close(() => {
      resolve();
    });
  });
});

async function run(
  cluster: ClusterState,
  action: () => Promise<void>,
): Promise<WireRequest[]> {
  state = cluster;
  scrollPages = structuredClone(cluster.scroll_pages ?? []);
  seen = [];
  rawBodies = [];
  const client = await setHosts(`127.0.0.1:${port}`);
  try {
    await action().catch(() => undefined);
  } finally {
    await client.close();
  }
  return seen;
}

/**
 * opensearch-py sends PUT for the put-mapping and put-index-template APIs
 * and the JS client sends POST; OpenSearch serves both methods on
 * `/{index}/_mapping` and `/_index_template/{name}`.
 */
function normalize(requests: readonly WireRequest[]): WireRequest[] {
  return requests.map(request =>
    (request.path.endsWith('/_mapping') ||
      request.path.startsWith('/_index_template/')) &&
    request.method === 'POST'
      ? { ...request, method: 'PUT' }
      : request,
  );
}

function save(item: SaveCase): Promise<void> {
  const options = caseOptions<SaveOptions>(item.options);
  switch (item.kind) {
    case 'aggregate':
      return saveAggregateReportToOpenSearch(
        caseReport<AggregateReport>(item),
        options,
      );
    case 'failure':
      return saveFailureReportToOpenSearch(
        caseReport<FailureReport>(item),
        options,
      );
    case 'smtp_tls':
      return saveSmtpTlsReportToOpenSearch(
        caseReport<SMTPTLSReport>(item),
        options,
      );
  }
}

describe('HTTP requests match parsedmarc on the wire', () => {
  const saves = expected.saves.filter(item => item.request_count === undefined);

  it.each(saves.map(item => [item.name, item] as const))(
    '%s',
    async (_name, item) => {
      const requests = await run(item.cluster, () => save(item));
      expect(normalize(requests)).toEqual(withDeviations(item, item.requests));
    },
  );

  it.each(expected.others.map(item => [item.name, item] as const))(
    '%s',
    async (name, item) => {
      const requests = await run(item.cluster, async () => {
        const settings = (item.options.settings ?? null) as Record<
          string,
          unknown
        > | null;
        if (name.startsWith('create_indexes')) {
          await createIndexes(item.args[0] as string[], settings);
        } else if (name.startsWith('create_data_streams')) {
          await createDataStreams(item.args[0] as string[], settings);
        } else {
          await migrateIndexes(
            caseOptions<MigrateIndexesOptions>(item.options),
          );
        }
      });
      expect(normalize(requests)).toEqual(withDeviations(item, item.requests));
    },
  );
});

describe('integers beyond 2^53', () => {
  const SAMPLES = new URL('../../../samples/', import.meta.url);

  it('sends an aggregate message_count exactly, like Python', async () => {
    const xml = readFileSync(
      new URL('aggregate/!example.com!1538204542!1538463818.xml', SAMPLES),
      'utf8',
    ).replace('<count>1</count>', '<count>99999999999999999999</count>');
    const report = await parseAggregateReportXml(xml, { offline: true });
    await run({}, () => saveAggregateReportToOpenSearch(report));
    expect(rawBodies.join('\n')).toContain(
      '"message_count":99999999999999999999',
    );
  });

  it('sends SMTP TLS session counts exactly, like Python', async () => {
    const json = readFileSync(
      new URL('smtp_tls/smtp_tls.json', SAMPLES),
      'utf8',
    ).replace(
      '"total-failure-session-count":3',
      '"total-failure-session-count":99999999999999999999',
    );
    const report = parseSmtpTlsReportJson(json);
    await run({}, () => saveSmtpTlsReportToOpenSearch(report));
    expect(rawBodies.join('\n')).toContain(
      '"failed_session_count":99999999999999999999',
    );
  });
});

describe('integers beyond 2^53 in the legacy migration', () => {
  it('writes back the exact integers it read', async () => {
    const big = '9007199254740993';
    rewriteResponse = text =>
      text.replace(
        '"org_name":"A"',
        `"message_count":${big},"text":"${big}","ratio":1.2345678901234567`,
      );
    try {
      await run(
        {
          exists: { dmarc_aggregate: true },
          field_mapping: {
            dmarc_aggregate: {
              mappings: {
                'published_policy.fo': { mapping: { fo: { type: 'long' } } },
              },
            },
          },
          scroll_pages: [
            [
              {
                _index: 'dmarc_aggregate',
                _id: 'a',
                _source: { org_name: 'A' },
              },
            ],
          ],
        },
        () => migrateIndexes({ legacyFoIndexes: ['dmarc_aggregate'] }),
      );
    } finally {
      rewriteResponse = text => text;
    }
    expect(rawBodies.join('\n')).toContain(`"message_count":${big}`);
    expect(rawBodies.join('\n')).toContain(`"text":"${big}"`);
    expect(rawBodies.join('\n')).toContain('"ratio":1.2345678901234567');
  });
});

describe('a stored failure sample with a __proto__ header', () => {
  it('reads as a duplicate instead of failing the search', async () => {
    rewriteResponse = text =>
      text.replace('"_source":{}', '"_source":{"__proto__":"x"}');
    let error: unknown;
    try {
      await run({ search_hits: 1 }, async () => {
        error = await saveFailureReportToOpenSearch(
          caseReport<FailureReport>(
            expected.saves.find(
              item => item.name === 'failure/helper',
            ) as SaveCase,
          ),
        ).catch((caught: unknown) => caught);
      });
    } finally {
      rewriteResponse = text => text;
    }
    expect(error).toBeInstanceOf(AlreadySaved);
  });
});
