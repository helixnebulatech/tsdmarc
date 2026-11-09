// Port of parsedmarc's tests/test_elastic.py.
//
// parsedmarc mocks the elasticsearch.dsl boundary (create_connection, Index,
// Search, Document.save). There is no DSL here, so the client itself is
// mocked (test/fake-client.ts) and each test asserts on the calls it
// receives: the documents, queries, settings and index names sent.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type * as Elasticsearch from '@elastic/elasticsearch';
import { errors } from '@elastic/elasticsearch';
import { ValueError } from '@tsdmarc/search-common/python';
import {
  captureLogs,
  InvalidFailureReport,
  WARNING,
  type AggregateReport,
  type FailureReport,
  type LogCapture,
  type SMTPTLSReport,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AlreadySaved,
  BACKFILL,
  createClient,
  createDataStreams,
  createIndexes,
  ElasticsearchError,
  getDefaultConnection,
  migrateIndexes,
  saveAggregateReportToElasticsearch,
  saveFailureReportToElasticsearch,
  saveForensicReportToElasticsearch,
  saveSmtpTlsReportToElasticsearch,
  setHosts,
  type SaveOptions,
} from './elastic';
import { caseReport, expected, findCase } from './test/expected';
import { cluster, type ApiCall } from './test/fake-client';

vi.mock('@elastic/elasticsearch', async importOriginal => {
  const { cluster: fake, FakeClient } = await import('./test/fake-client');
  const actual = await importOriginal<typeof Elasticsearch>();
  fake.notFound = () =>
    new actual.errors.ResponseError({
      body: { error: { type: 'index_not_found_exception' }, status: 404 },
      statusCode: 404,
      headers: {},
      warnings: null,
    } as unknown as ConstructorParameters<
      typeof actual.errors.ResponseError
    >[0]);
  return { ...actual, Client: FakeClient };
});

/** Run an async test body with the process timezone set to `tz`. */
async function withTz(tz: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    await run();
  } finally {
    process.env.TZ = previous;
  }
}

function aggregateReport(): AggregateReport {
  return caseReport(findCase(expected.saves, 'aggregate/helper'));
}

function failureReport(): FailureReport {
  return caseReport(findCase(expected.saves, 'failure/helper'));
}

function smtpTlsReport(): SMTPTLSReport {
  return caseReport(findCase(expected.saves, 'smtp_tls/helper'));
}

function callsTo(api: string): ApiCall[] {
  return cluster.calls.filter(call => call.api === api);
}

function indexCalls(): string[] {
  return callsTo('indices.exists').map(call => String(call.params.index));
}

function savedDocuments(): Record<string, unknown>[] {
  return callsTo('index').map(
    call => call.params.document as Record<string, unknown>,
  );
}

function savedDocument(): Record<string, unknown> {
  const documents = savedDocuments();
  expect(documents).toHaveLength(1);
  return documents[0] ?? {};
}

function lastClientOptions(): Record<string, unknown> {
  return cluster.clientOptions.at(-1) ?? {};
}

const DATE = { type: 'date' };

function createdMappings(call: ApiCall | undefined): unknown {
  return call?.params.mappings;
}

let logs: LogCapture | null = null;

function captureWarnings(): LogCapture {
  logs = captureLogs('tsdmarc', WARNING);
  return logs;
}

beforeEach(async () => {
  cluster.reset();
  await setHosts('http://localhost:9200');
  cluster.reset();
});

afterEach(() => {
  logs?.restore();
  logs = null;
});

// ---------------------------------------------------------------------------
// setHosts: connection-parameter assembly
// ---------------------------------------------------------------------------

describe('setHosts', () => {
  // The client takes the scheme in each node URL, `auth` for credentials and
  // `requestTimeout` in milliseconds.

  it('single host url passed through unchanged', async () => {
    await setHosts('https://es:9200');
    expect(lastClientOptions().nodes).toEqual(['https://es:9200']);
  });

  it('host list preserved', async () => {
    await setHosts(['http://es1:9200', 'http://es2:9200']);
    expect(lastClientOptions().nodes).toEqual([
      'http://es1:9200',
      'http://es2:9200',
    ]);
  });

  it('bare host use_ssl false gets http prefix', async () => {
    await setHosts('localhost:9200', { useSsl: false });
    expect(lastClientOptions().nodes).toEqual(['http://localhost:9200']);
    expect(lastClientOptions()).not.toHaveProperty('tls');
  });

  it('bare host use_ssl true gets https prefix', async () => {
    await setHosts('localhost', { useSsl: true });
    const options = lastClientOptions();
    expect(options.nodes).toEqual(['https://localhost']);
    expect(options.tls).toEqual({ rejectUnauthorized: true });
  });

  it('explicit url passes through even with use_ssl true', async () => {
    // A host that already carries a scheme is never re-prefixed.
    await setHosts('http://example.com:9200', { useSsl: true });
    expect(lastClientOptions().nodes).toEqual(['http://example.com:9200']);
  });

  it('timeout default 60s becomes request timeout', async () => {
    await setHosts('es:9200');
    expect(lastClientOptions().requestTimeout).toBe(60_000);
  });

  it('timeout custom', async () => {
    await setHosts('es:9200', { timeout: 30 });
    expect(lastClientOptions().requestTimeout).toBe(30_000);
  });

  it('use ssl with custom ca', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-es-'));
    try {
      const caPath = path.join(directory, 'ca.pem');
      writeFileSync(caPath, 'CA CERTIFICATE');
      await setHosts('es:9200', { useSsl: true, sslCertPath: caPath });
      const tls = lastClientOptions().tls as { ca: Buffer };
      expect(tls.ca.toString()).toBe('CA CERTIFICATE');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // tsdmarc-specific: elastic_transport rejects TLS options on http nodes.
  it('custom ca with an http host raises like elastic_transport', async () => {
    const error = await setHosts(['es1:9200', 'http://es2:9200'], {
      useSsl: true,
      sslCertPath: '/nonexistent/ca.pem',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValueError);
    expect((error as Error).message).toBe(
      "TLS options require scheme to be 'https'",
    );
    expect(cluster.clientOptions).toEqual([]);
  });

  it('verify certs alone with an http host is accepted', async () => {
    await setHosts('http://es:9200', { useSsl: true });
    expect(lastClientOptions().nodes).toEqual(['http://es:9200']);
  });

  it('skip certificate verification sets verify false', async () => {
    await setHosts('es:9200', {
      useSsl: true,
      skipCertificateVerification: true,
    });
    expect(lastClientOptions().tls).toEqual({ rejectUnauthorized: false });
  });

  it('username password sets basic auth', async () => {
    await setHosts('es:9200', { username: 'u', password: 'p' });
    expect(lastClientOptions().auth).toEqual({ username: 'u', password: 'p' });
  });

  it('username without password not set', async () => {
    // Half-configured auth is suspicious enough not to send.
    await setHosts('es:9200', { username: 'u' });
    expect(lastClientOptions()).not.toHaveProperty('auth');
  });

  it('api key set', async () => {
    await setHosts('es:9200', { apiKey: 'base64key==' });
    expect(lastClientOptions().auth).toEqual({ apiKey: 'base64key==' });
  });

  // tsdmarc-specific: behavior parsedmarc gets from elasticsearch-py.

  it('api key and basic auth together are rejected', async () => {
    await expect(
      setHosts('es:9200', { username: 'u', password: 'p', apiKey: 'k' }),
    ).rejects.toThrow(
      "Can only set one of 'api_key', 'basic_auth', and 'bearer_auth'",
    );
  });

  it('http url without a port is rejected like elasticsearch-py', async () => {
    await expect(setHosts('http://localhost')).rejects.toThrow(
      "URL must include a 'scheme', 'host', and 'port' component",
    );
    await expect(setHosts('localhost')).rejects.toThrow(
      "URL must include a 'scheme', 'host', and 'port' component",
    );
    // https defaults to port 443, as in elastic_transport.
    await expect(setHosts('https://es')).resolves.toBeDefined();
  });

  it('asks for REST API compatibility with Elasticsearch 8 by default', async () => {
    await setHosts('es:9200');
    expect(lastClientOptions().headers).toEqual({
      accept: 'application/vnd.elasticsearch+json; compatible-with=8',
      'content-type': 'application/vnd.elasticsearch+json; compatible-with=8',
    });
    await setHosts('es:9200', { compatibleWith: 9 });
    expect(lastClientOptions().headers).toEqual({
      accept: 'application/vnd.elasticsearch+json; compatible-with=9',
      'content-type': 'application/vnd.elasticsearch+json; compatible-with=9',
    });
    await setHosts('es:9200', { compatibleWith: null });
    expect(lastClientOptions()).not.toHaveProperty('headers');
  });
});

// ---------------------------------------------------------------------------
// createIndexes
// ---------------------------------------------------------------------------

describe('createIndexes', () => {
  it('creates missing index with default settings', async () => {
    await createIndexes(['dmarc_aggregate-2024-01-15']);
    expect(callsTo('indices.create')).toEqual([
      {
        api: 'indices.create',
        params: {
          index: 'dmarc_aggregate-2024-01-15',
          settings: { number_of_shards: 1, number_of_replicas: 0 },
        },
      },
    ]);
  });

  it('creates with custom settings', async () => {
    await createIndexes(['idx'], {
      number_of_shards: 3,
      refresh_interval: '5s',
    });
    expect(callsTo('indices.create')[0]?.params.settings).toEqual({
      number_of_shards: 3,
      refresh_interval: '5s',
    });
  });

  it('skips existing index', async () => {
    cluster.existing.add('idx');
    await createIndexes(['idx']);
    expect(callsTo('indices.create')).toEqual([]);
  });

  it('wraps sdk error', async () => {
    cluster.failures.set('indices.exists', new Error('cluster down'));
    await expect(createIndexes(['idx'])).rejects.toThrow(ElasticsearchError);
    await expect(createIndexes(['idx'])).rejects.toThrow('cluster down');
  });

  function createError(type: string): errors.ResponseError {
    return new errors.ResponseError({
      body: { error: { type, root_cause: [] }, status: 400 },
      statusCode: 400,
      headers: {},
      warnings: null,
    } as unknown as ConstructorParameters<typeof errors.ResponseError>[0]);
  }

  it('accepts an index another writer created after the exists check', async () => {
    // Concurrent saves to a new daily index: the cluster answers the losing
    // create with resource_already_exists_exception.
    cluster.failures.set(
      'indices.create',
      createError('resource_already_exists_exception'),
    );
    await expect(createIndexes(['idx'])).resolves.toBeUndefined();
  });

  it('still wraps other create errors', async () => {
    cluster.failures.set(
      'indices.create',
      createError('illegal_argument_exception'),
    );
    await expect(createIndexes(['idx'])).rejects.toThrow(ElasticsearchError);
  });
});

describe('createIndexes in serverless mode', () => {
  // Elastic Cloud Serverless rejects number_of_shards and
  // number_of_replicas with HTTP 400; other settings pass through.

  beforeEach(async () => {
    await setHosts('http://localhost:9200', { serverless: true });
    cluster.reset();
  });

  afterEach(async () => {
    await setHosts('http://localhost:9200');
  });

  it('serverless default skips settings entirely', async () => {
    await createIndexes(['idx']);
    expect(callsTo('indices.create')).toEqual([
      { api: 'indices.create', params: { index: 'idx' } },
    ]);
  });

  it('serverless filters rejected keys and passes others through', async () => {
    await createIndexes(['idx'], {
      number_of_shards: 3,
      number_of_replicas: 2,
      refresh_interval: '5s',
    });
    expect(callsTo('indices.create')[0]?.params.settings).toEqual({
      refresh_interval: '5s',
    });
  });

  it('serverless skips settings when only rejected keys', async () => {
    await createIndexes(['idx'], {
      number_of_shards: 3,
      number_of_replicas: 2,
    });
    expect(callsTo('indices.create')).toEqual([
      { api: 'indices.create', params: { index: 'idx' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// migrateIndexes
// ---------------------------------------------------------------------------

describe('migrateIndexes', () => {
  // Backfills dkim_results_combined/spf_results_combined (issue #169) on
  // pre-existing aggregate documents as a non-blocking task, guarded by a
  // cheap count; SDK errors are logged, never thrown.

  it('backfill submitted when old docs exist', async () => {
    cluster.count = 42;
    await migrateIndexes({ aggregateIndexes: ['dmarc_aggregate'] });
    const updates = callsTo('updateByQuery');
    expect(updates).toHaveLength(1);
    const params = updates[0]?.params ?? {};
    expect(params.index).toBe('dmarc_aggregate*');
    expect(params.conflicts).toBe('proceed');
    expect(params.wait_for_completion).toBe(false);
    expect(params.query).toEqual(BACKFILL.aggregateQuery);
    const script = params.script as { source: string; lang: string };
    expect(script.source).toContain('ctx._source.dkim_results_combined');
    expect(script.source).toContain('ctx._source.spf_results_combined');
    expect(script.lang).toBe('painless');

    // The count guard also targets the date-suffixed pattern.
    const count = callsTo('count')[0]?.params ?? {};
    expect(count.index).toBe('dmarc_aggregate*');
    expect(count.query).toEqual(BACKFILL.aggregateQuery);
  });

  it('backfill skipped when no old docs', async () => {
    cluster.count = 0;
    await migrateIndexes({ aggregateIndexes: ['dmarc_aggregate'] });
    expect(callsTo('updateByQuery')).toEqual([]);
  });

  it('backfill skipped when no aggregate indexes', async () => {
    await migrateIndexes();
    await migrateIndexes({ aggregateIndexes: null });
    expect(cluster.calls).toEqual([]);
  });

  it('backfill failure does not raise', async () => {
    cluster.failures.set('count', new Error('cluster unreachable'));
    const capture = captureWarnings();
    await migrateIndexes({ aggregateIndexes: ['dmarc_aggregate'] });
    expect(
      capture.output.some(message => message.includes('cluster unreachable')),
    ).toBe(true);
    expect(callsTo('updateByQuery')).toEqual([]);
  });

  it('get connection failure does not raise', async () => {
    // With no connection registered, migrateIndexes still only logs.
    vi.resetModules();
    const core = await import('tsdmarc');
    const fresh = await import('./elastic');
    const capture = core.captureLogs('tsdmarc', WARNING);
    logs = capture;
    await fresh.migrateIndexes({ aggregateIndexes: ['dmarc_aggregate'] });
    expect(
      capture.output.some(message =>
        message.includes('Skipping the dkim_results_combined'),
      ),
    ).toBe(true);
    expect(
      capture.output.some(message =>
        message.includes("There is no connection with alias 'default'."),
      ),
    ).toBe(true);
  });

  it('smtp tls backfill submitted when old docs exist', async () => {
    cluster.count = 7;
    await migrateIndexes({ smtpTlsIndexes: ['smtp_tls'] });
    const updates = callsTo('updateByQuery');
    expect(updates).toHaveLength(1);
    const params = updates[0]?.params ?? {};
    expect(params.index).toBe('smtp_tls*');
    expect(params.conflicts).toBe('proceed');
    expect(params.wait_for_completion).toBe(false);
    expect(params.query).toEqual(BACKFILL.smtpTlsQuery);
    const script = params.script as { source: string };
    expect(script.source).toContain('ctx._source.policies_combined');
    expect(script.source).toContain('ctx._source.failure_details_combined');

    const count = callsTo('count')[0]?.params ?? {};
    expect(count.index).toBe('smtp_tls*');
    expect(count.query).toEqual(BACKFILL.smtpTlsQuery);
  });

  it('smtp tls backfill skipped when no old docs', async () => {
    cluster.count = 0;
    await migrateIndexes({ smtpTlsIndexes: ['smtp_tls'] });
    expect(callsTo('updateByQuery')).toEqual([]);
  });

  it('smtp tls backfill skipped when no smtp tls indexes or aggregate', async () => {
    await migrateIndexes();
    await migrateIndexes({ smtpTlsIndexes: null });
    expect(cluster.calls).toEqual([]);
  });

  it('smtp tls backfill failure does not raise', async () => {
    cluster.failures.set('count', new Error('cluster unreachable'));
    const capture = captureWarnings();
    await migrateIndexes({ smtpTlsIndexes: ['smtp_tls'] });
    expect(
      capture.output.some(message => message.includes('cluster unreachable')),
    ).toBe(true);
    expect(callsTo('updateByQuery')).toEqual([]);
  });

  it('logs the submitted backfill task', async () => {
    cluster.count = 42;
    logs = captureLogs('tsdmarc');
    await migrateIndexes({ aggregateIndexes: ['dmarc_aggregate'] });
    expect(logs.output).toContain(
      'INFO:tsdmarc:Backfilling dkim_results_combined/spf_results_combined on 42 existing documents in dmarc_aggregate* (task node:1)',
    );
  });
});

/** A get-field-mapping response in the modern, typeless shape. */
function typelessFoMapping(indexName: string, foType: string): unknown {
  return {
    [indexName]: {
      mappings: {
        'published_policy.fo': {
          full_name: 'published_policy.fo',
          mapping: { fo: { type: foType } },
        },
      },
    },
  };
}

describe('migrateIndexes: legacy published_policy.fo migration', () => {
  // parsedmarc before 5.0.0 mapped published_policy.fo as `long`, which
  // cannot hold values like `0:1`; such an index is rebuilt with the
  // text/keyword shape. The combined-field backfill is a no-op here.

  function legacyIndex(v2Exists: boolean): void {
    cluster.existing.add('dmarc_aggregate');
    if (v2Exists) {
      cluster.existing.add('dmarc_aggregate-v2');
    }
    cluster.fieldMapping = typelessFoMapping('dmarc_aggregate', 'long');
    cluster.scrollPages = [
      [
        { _index: 'dmarc_aggregate', _id: 'a', _source: { org_name: 'A' } },
        { _index: 'dmarc_aggregate', _id: 'b', _source: { org_name: 'B' } },
      ],
    ];
  }

  it('skips non existent index', async () => {
    await migrateIndexes({ legacyFoIndexes: ['missing'] });
    expect(callsTo('indices.getFieldMapping')).toEqual([]);
  });

  it('skips when field is unmapped', async () => {
    cluster.existing.add('dmarc_aggregate');
    cluster.fieldMapping = { dmarc_aggregate: { mappings: {} } };
    await migrateIndexes({ legacyFoIndexes: ['dmarc_aggregate'] });
    expect(callsTo('search')).toEqual([]);
    expect(callsTo('indices.create')).toEqual([]);
    expect(callsTo('indices.delete')).toEqual([]);
  });

  it('migrates when fo is long', async () => {
    legacyIndex(false);
    await migrateIndexes({ legacyFoIndexes: ['dmarc_aggregate'] });

    expect(callsTo('indices.create')).toEqual([
      { api: 'indices.create', params: { index: 'dmarc_aggregate-v2' } },
    ]);
    const mapping = callsTo('indices.putMapping')[0]?.params ?? {};
    expect(mapping.index).toBe('dmarc_aggregate-v2');
    expect(mapping).not.toHaveProperty('body');
    expect(mapping.properties).toEqual({
      published_policy: {
        properties: {
          fo: {
            type: 'text',
            fields: { keyword: { type: 'keyword', ignore_above: 256 } },
          },
        },
      },
    });
    // Reindexed old -> v2, keeping each _id; only then is the original
    // dropped. The v2 index is never deleted: nothing was left over.
    expect(callsTo('search')[0]?.params.index).toBe('dmarc_aggregate');
    expect(callsTo('bulk')[0]?.params.operations).toEqual([
      { index: { _id: 'a', _index: 'dmarc_aggregate-v2' } },
      { org_name: 'A' },
      { index: { _id: 'b', _index: 'dmarc_aggregate-v2' } },
      { org_name: 'B' },
    ]);
    expect(callsTo('indices.delete')).toEqual([
      { api: 'indices.delete', params: { index: 'dmarc_aggregate' } },
    ]);
    const order = cluster.calls.map(call => call.api);
    expect(order.indexOf('bulk')).toBeLessThan(
      order.lastIndexOf('indices.delete'),
    );
  });

  it('retries after an interrupted earlier attempt', async () => {
    // A leftover -v2 index is debris of an attempt that died between
    // create and delete: it is discarded and the migration completes.
    legacyIndex(true);
    const capture = captureWarnings();
    await migrateIndexes({ legacyFoIndexes: ['dmarc_aggregate'] });
    expect(
      capture.output.some(message =>
        message.includes('Discarding dmarc_aggregate-v2'),
      ),
    ).toBe(true);
    expect(callsTo('indices.delete')).toEqual([
      { api: 'indices.delete', params: { index: 'dmarc_aggregate-v2' } },
      { api: 'indices.delete', params: { index: 'dmarc_aggregate' } },
    ]);
    expect(callsTo('indices.create')).toHaveLength(1);
    expect(callsTo('bulk')).toHaveLength(1);
  });

  it('retries after an interrupted earlier attempt: copies dmarc_aggregate into the recreated -v2', async () => {
    // Python: v2.delete(), v2.create(), then
    // reindex(client, "dmarc_aggregate", "dmarc_aggregate-v2"), then
    // original.delete().
    legacyIndex(true);
    await migrateIndexes({ legacyFoIndexes: ['dmarc_aggregate'] });
    expect(callsTo('indices.create')).toEqual([
      {
        api: 'indices.create',
        params: { index: 'dmarc_aggregate-v2' },
      },
    ]);
    expect(callsTo('search')[0]?.params.index).toBe('dmarc_aggregate');
    expect(callsTo('bulk')[0]?.params.operations).toEqual([
      { index: { _id: 'a', _index: 'dmarc_aggregate-v2' } },
      { org_name: 'A' },
      { index: { _id: 'b', _index: 'dmarc_aggregate-v2' } },
      { org_name: 'B' },
    ]);
    const order = cluster.calls.map(call =>
      call.api === 'indices.delete' || call.api === 'indices.create'
        ? `${call.api} ${String(call.params.index)}`
        : call.api,
    );
    const at = (step: string): number => order.indexOf(step);
    expect(at('indices.delete dmarc_aggregate-v2')).toBeLessThan(
      at('indices.create dmarc_aggregate-v2'),
    );
    expect(at('indices.create dmarc_aggregate-v2')).toBeLessThan(at('bulk'));
    expect(at('bulk')).toBeLessThan(at('indices.delete dmarc_aggregate'));
  });

  it('migrates when fo is long under a mapping type', async () => {
    // The Elasticsearch 6-era response nests the field under the type name.
    cluster.existing.add('dmarc_aggregate');
    cluster.fieldMapping = {
      dmarc_aggregate: {
        mappings: {
          doc: { 'published_policy.fo': { mapping: { fo: { type: 'long' } } } },
        },
      },
    };
    await migrateIndexes({ legacyFoIndexes: ['dmarc_aggregate'] });
    expect(callsTo('indices.create')).toHaveLength(1);
    expect(callsTo('indices.delete')).toHaveLength(1);
  });

  it('skips when fo already text', async () => {
    cluster.existing.add('dmarc_aggregate');
    cluster.fieldMapping = typelessFoMapping('dmarc_aggregate', 'text');
    await migrateIndexes({ legacyFoIndexes: ['dmarc_aggregate'] });
    expect(callsTo('search')).toEqual([]);
    expect(callsTo('indices.create')).toEqual([]);
    expect(callsTo('indices.delete')).toEqual([]);
  });

  it('index exists failure does not raise', async () => {
    cluster.failures.set('indices.exists', new Error('cluster unreachable'));
    cluster.failures.set('count', new Error('no connection'));
    const capture = captureWarnings();
    await migrateIndexes({
      aggregateIndexes: ['dmarc_aggregate'],
      legacyFoIndexes: ['dmarc_aggregate'],
    });
    expect(
      capture.output.some(
        message =>
          message.includes('legacy published_policy.fo migration') &&
          message.includes('cluster unreachable'),
      ),
    ).toBe(true);
    expect(
      capture.output.some(message =>
        message.includes('dkim_results_combined/spf_results_combined backfill'),
      ),
    ).toBe(true);
    expect(
      capture.output.some(message => message.includes('no connection')),
    ).toBe(true);
  });

  it('no legacy indexes means no lookup', async () => {
    await migrateIndexes({ aggregateIndexes: ['dmarc_aggregate'] });
    expect(callsTo('indices.exists')).toEqual([]);
  });

  it('bulk errors fail the migration and keep the original', async () => {
    legacyIndex(false);
    cluster.bulkItems = [
      { index: { _id: 'a', status: 400, error: { type: 'mapper_parsing' } } },
    ];
    const capture = captureWarnings();
    await migrateIndexes({ legacyFoIndexes: ['dmarc_aggregate'] });
    expect(capture.output).toEqual([
      'WARNING:tsdmarc:Failed the legacy published_policy.fo migration for dmarc_aggregate: 1 document(s) failed to index.. This will be retried at the next startup.',
    ]);
    expect(callsTo('indices.delete')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// saveAggregateReportToElasticsearch
// ---------------------------------------------------------------------------

describe('saveAggregateReportToElasticsearch', () => {
  // The save fans out across several calls: search (dedup), indices.exists
  // / indices.create (daily or monthly index) and index (the document).

  it('save emits one document per record', async () => {
    const report = aggregateReport();
    const [record] = report.records;
    if (record) {
      report.records.push(structuredClone(record));
    }
    cluster.existing.add('dmarc_aggregate-2024-01-15');
    await saveAggregateReportToElasticsearch(report);
    expect(savedDocuments()).toHaveLength(2);
  });

  it('already saved raises when search returns hit', async () => {
    // The dedup query is all that prevents double-indexing on re-runs.
    cluster.searchHits = 1;
    await expect(
      saveAggregateReportToElasticsearch(aggregateReport()),
    ).rejects.toThrow(AlreadySaved);
    expect(savedDocuments()).toEqual([]);
  });

  it('search exception wraps to elasticsearch error', async () => {
    cluster.failures.set('search', new Error('network'));
    const error = await saveAggregateReportToElasticsearch(
      aggregateReport(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ElasticsearchError);
    expect((error as Error).message).toBe(
      "Elasticsearch's search for existing report error: network",
    );
  });

  it('save exception wraps to elasticsearch error', async () => {
    cluster.failures.set('index', new Error('disk'));
    const error = await saveAggregateReportToElasticsearch(
      aggregateReport(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ElasticsearchError);
    expect((error as Error).message).toBe('Elasticsearch error: disk');
  });

  it('index name uses daily format by default', async () => {
    await saveAggregateReportToElasticsearch(aggregateReport());
    expect(indexCalls()).toContain('dmarc_aggregate-2024-01-15');
    expect(callsTo('index')[0]?.params.index).toBe(
      'dmarc_aggregate-2024-01-15',
    );
  });

  it('index name uses monthly format when flag set', async () => {
    await saveAggregateReportToElasticsearch(aggregateReport(), {
      monthlyIndexes: true,
    });
    expect(indexCalls()).toContain('dmarc_aggregate-2024-01');
  });

  it('index name honours suffix and prefix', async () => {
    // Multi-tenant setups where one cluster serves several DMARC owners.
    await saveAggregateReportToElasticsearch(aggregateReport(), {
      indexSuffix: 'tenant_a',
      indexPrefix: 'customer1_',
    });
    expect(indexCalls()).toContain(
      'customer1_dmarc_aggregate_tenant_a-2024-01-15',
    );
  });

  it('dedup search pattern uses suffix wildcard', async () => {
    // '*' matches both daily and monthly index buckets.
    await saveAggregateReportToElasticsearch(aggregateReport(), {
      indexSuffix: 'tenant_a',
      indexPrefix: 'cust_',
    });
    expect(callsTo('search')[0]?.params.index).toBe(
      'cust_dmarc_aggregate_tenant_a-*,cust_dmarc_aggregate_tenant_a',
    );
  });

  it('interval dates are utc regardless of host timezone', async () => {
    // interval_begin/interval_end are UTC wall-clock strings: the index
    // date and stored date_begin must not shift with the host's offset
    // (parsedmarc issue #819).
    await withTz('Europe/Warsaw', async () => {
      await saveAggregateReportToElasticsearch(aggregateReport());
    });
    expect(indexCalls()).toContain('dmarc_aggregate-2024-01-15');
    expect(savedDocument().date_begin).toBe('2024-01-15T00:00:00+00:00');
  });

  it('save populates combined dkim and spf fields', async () => {
    // Issue #169: two DKIM signatures yield exactly two combined entries,
    // not a cross-product.
    const report = aggregateReport();
    const [record] = report.records;
    if (record) {
      record.authResults = {
        dkim: [
          {
            domain: 'example.net',
            selector: 'net1',
            result: 'fail',
            humanResult: null,
          },
          {
            domain: 'example.org',
            selector: 'org1',
            result: 'pass',
            humanResult: null,
          },
        ],
        spf: [
          {
            domain: 'example.org',
            scope: 'mfrom',
            result: 'pass',
            humanResult: null,
          },
        ],
      };
    }
    await saveAggregateReportToElasticsearch(report);
    const document = savedDocument();
    expect(document.dkim_results_combined).toEqual([
      'net1 / example.net / fail',
      'org1 / example.org / pass',
    ]);
    expect(document.spf_results_combined).toEqual([
      'mfrom / example.org / pass',
    ]);
  });
});

describe('aggregate document passed_dmarc', () => {
  // _AggregateReportDoc.save() derives passed_dmarc, the field dashboards
  // filter on, from SPF/DKIM alignment.

  it.each([
    ['pass', 'fail', true],
    ['fail', 'pass', true],
    ['pass', 'pass', true],
    ['fail', 'fail', false],
  ])(
    'passed dmarc derived from alignment (spf %s, dkim %s)',
    async (spf, dkim, passed) => {
      const report = aggregateReport();
      const [record] = report.records;
      if (record) {
        record.policyEvaluated.spf = spf;
        record.policyEvaluated.dkim = dkim;
      }
      await saveAggregateReportToElasticsearch(report);
      const document = savedDocument();
      expect(document.spf_aligned).toBe(spf === 'pass');
      expect(document.dkim_aligned).toBe(dkim === 'pass');
      expect(document.passed_dmarc).toBe(passed);
    },
  );
});

describe('aggregate document combined results', () => {
  it('add dkim result appends combined string', async () => {
    // Issue #169: the composed "selector / domain / result" string keeps
    // the per-signature pairing that the flattened object array loses.
    const report = aggregateReport();
    const [record] = report.records;
    if (record) {
      record.authResults.dkim = [
        {
          domain: 'example.net',
          selector: 'net1',
          result: 'fail',
          humanResult: null,
        },
        {
          domain: 'example.org',
          selector: 'org1',
          result: 'pass',
          humanResult: null,
        },
      ];
    }
    await saveAggregateReportToElasticsearch(report);
    expect(savedDocument().dkim_results_combined).toEqual([
      'net1 / example.net / fail',
      'org1 / example.org / pass',
    ]);
  });

  it('add spf result appends combined string', async () => {
    const report = aggregateReport();
    const [record] = report.records;
    if (record) {
      record.authResults.spf = [
        {
          domain: 'example.org',
          scope: 'mfrom',
          result: 'pass',
          humanResult: null,
        },
      ];
    }
    await saveAggregateReportToElasticsearch(report);
    expect(savedDocument().spf_results_combined).toEqual([
      'mfrom / example.org / pass',
    ]);
  });

  it('spf result serializes under singular result key', async () => {
    await saveAggregateReportToElasticsearch(aggregateReport());
    const [spf] = savedDocument().spf_results as Record<string, unknown>[];
    expect(spf?.result).toBe('pass');
    expect(spf).not.toHaveProperty('results');
  });
});

// ---------------------------------------------------------------------------
// saveFailureReportToElasticsearch
// ---------------------------------------------------------------------------

describe('saveFailureReportToElasticsearch', () => {
  function sampleHeaders(): Record<string, unknown> {
    const sample = savedDocument().sample as Record<string, unknown>;
    return sample.headers as Record<string, unknown>;
  }

  it('save emits one document', async () => {
    await saveFailureReportToElasticsearch(failureReport());
    expect(savedDocuments()).toHaveLength(1);
  });

  it('already saved raises on dedup hit', async () => {
    // Dedup uses arrival_date + From/To/Subject of the parsed sample.
    cluster.searchHits = 1;
    await expect(
      saveFailureReportToElasticsearch(failureReport()),
    ).rejects.toThrow(AlreadySaved);
    expect(savedDocuments()).toEqual([]);
  });

  it('save exception wraps to elasticsearch error', async () => {
    cluster.failures.set('index', new Error('disk'));
    const error = await saveFailureReportToElasticsearch(failureReport()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ElasticsearchError);
    expect((error as Error).message).toBe('Elasticsearch error: disk');
  });

  it('keyerror wraps to invalid failure report', async () => {
    // A malformed report surfaces as InvalidFailureReport, so callers can
    // tell it from infrastructure errors.
    const report = failureReport() as Partial<FailureReport>;
    delete report.feedbackType;
    const error = await saveFailureReportToElasticsearch(
      report as FailureReport,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidFailureReport);
    expect((error as Error).message).toBe(
      "Failure report missing required field: 'feedback_type'",
    );
  });

  it('index dedup pattern searches both old and new names', async () => {
    // Data from before the forensic → failure rename is in dmarc_forensic*.
    await saveFailureReportToElasticsearch(failureReport());
    const index = String(callsTo('search')[0]?.params.index);
    expect(index).toContain('dmarc_failure-*');
    expect(index).toContain('dmarc_forensic-*');
  });

  it('index name uses arrival date for monthly partition', async () => {
    await saveFailureReportToElasticsearch(failureReport(), {
      monthlyIndexes: true,
    });
    expect(indexCalls()).toContain('dmarc_failure-2024-01');
  });

  it('arrival date epoch is utc regardless of host timezone', async () => {
    // arrival_date_utc is a UTC wall-clock string (parsedmarc issue #811).
    await withTz('Europe/Warsaw', async () => {
      await saveFailureReportToElasticsearch(failureReport());
    });
    const query = callsTo('search')[0]?.params.query as {
      bool: { must: Record<string, unknown>[] };
    };
    expect(query.bool.must[0]).toEqual({
      match: { arrival_date: 1_704_067_200_000 },
    });
    expect(savedDocument().arrival_date).toBe('2024-01-01T00:00:00');
  });

  it('failure search index with suffix and prefix', async () => {
    await saveFailureReportToElasticsearch(failureReport(), {
      indexSuffix: 'tenant_a',
      indexPrefix: 'cust_',
    });
    expect(callsTo('search')[0]?.params.index).toBe(
      'cust_dmarc_failure_tenant_a-*,cust_dmarc_failure_tenant_a,' +
        'cust_dmarc_forensic_tenant_a-*,cust_dmarc_forensic_tenant_a',
    );
  });

  it('failure index honours suffix and prefix', async () => {
    await saveFailureReportToElasticsearch(failureReport(), {
      indexSuffix: 'tenant_a',
      indexPrefix: 'cust_',
    });
    expect(indexCalls()).toContain('cust_dmarc_failure_tenant_a-2024-01-01');
  });

  it('from header with empty display name', async () => {
    const report = failureReport();
    report.parsedSample.headers.From = [['', 'sender@example.com']];
    report.parsedSample.headers.To = [['', 'rcpt@example.com']];
    await saveFailureReportToElasticsearch(report);
    expect(sampleHeaders().from).toBe('sender@example.com');
    expect(sampleHeaders().to).toBe('rcpt@example.com');
  });

  it('to header with non empty display joins with brackets', async () => {
    const report = failureReport();
    report.parsedSample.headers.To = [['RT', 'rcpt@example.com']];
    await saveFailureReportToElasticsearch(report);
    expect(sampleHeaders().to).toBe('RT <rcpt@example.com>');
  });

  it('sample address lists indexed for reply to cc bcc attachments', async () => {
    const report = failureReport();
    const address = (displayName: string, email: string) => ({
      displayName,
      address: email,
      local: null,
      domain: null,
    });
    report.parsedSample.replyTo = [address('RT', 'rt@example.com')];
    report.parsedSample.cc = [address('CC', 'cc@example.com')];
    report.parsedSample.bcc = [address('', 'bcc@example.com')];
    report.parsedSample.attachments = [
      {
        filename: 'a.pdf',
        mailContentType: 'application/pdf',
        sha256: 'deadbeef',
      },
    ];
    await saveFailureReportToElasticsearch(report);
    const sample = savedDocument().sample as Record<string, unknown>;
    expect(sample.reply_to).toEqual([
      { display_name: 'RT', address: 'rt@example.com' },
    ]);
    expect(sample.cc).toEqual([
      { display_name: 'CC', address: 'cc@example.com' },
    ]);
    expect(sample.bcc).toEqual([
      { display_name: '', address: 'bcc@example.com' },
    ]);
    expect(sample.attachments).toEqual([
      {
        filename: 'a.pdf',
        content_type: 'application/pdf',
        sha256: 'deadbeef',
      },
    ]);
  });

  it('reply to header flattened and indexed', async () => {
    // Flattened so the dashboard's sample.headers.reply-to.keyword column
    // resolves; each address also fills the nested sample.reply_to docs.
    const report = failureReport();
    report.parsedSample.headers['Reply-To'] = [
      ['Real One', 'real@phish.example'],
    ];
    report.parsedSample.replyTo = [
      {
        displayName: 'Real One',
        address: 'real@phish.example',
        local: null,
        domain: null,
      },
    ];
    await saveFailureReportToElasticsearch(report);
    expect(sampleHeaders()['reply-to']).toBe('Real One <real@phish.example>');
    const sample = savedDocument().sample as Record<string, unknown>;
    expect(
      (sample.reply_to as { address: string }[]).map(item => item.address),
    ).toEqual(['real@phish.example']);
  });

  it('reply to header without display name flattens to address', async () => {
    const report = failureReport();
    report.parsedSample.headers['Reply-To'] = [['', 'noname@phish.example']];
    await saveFailureReportToElasticsearch(report);
    expect(sampleHeaders()['reply-to']).toBe('noname@phish.example');
  });

  it('keeps a __proto__ header like a Python dict', async () => {
    const report = failureReport();
    // An own `__proto__` key, as the email parser produces it.
    for (const [name, value] of [
      ['__proto__', 'x'],
      ['Constructor', 'y'],
    ] as const) {
      Object.defineProperty(report.parsedSample.headers, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
    await saveFailureReportToElasticsearch(report);
    const headers = sampleHeaders();
    expect(Object.hasOwn(headers, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(headers, '__proto__')?.value).toBe(
      'x',
    );
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
    expect(headers.constructor).toBe('y');
  });
});

// ---------------------------------------------------------------------------
// saveSmtpTlsReportToElasticsearch
// ---------------------------------------------------------------------------

describe('saveSmtpTlsReportToElasticsearch', () => {
  it('save emits one document', async () => {
    await saveSmtpTlsReportToElasticsearch(smtpTlsReport());
    expect(savedDocuments()).toHaveLength(1);
  });

  it('already saved raises on dedup hit', async () => {
    cluster.searchHits = 1;
    await expect(
      saveSmtpTlsReportToElasticsearch(smtpTlsReport()),
    ).rejects.toThrow(AlreadySaved);
    expect(savedDocuments()).toEqual([]);
  });

  it('search exception wraps to elasticsearch error', async () => {
    cluster.failures.set('search', new Error('network'));
    await expect(
      saveSmtpTlsReportToElasticsearch(smtpTlsReport()),
    ).rejects.toThrow(ElasticsearchError);
  });

  it('save exception wraps to elasticsearch error', async () => {
    cluster.failures.set('index', new Error('disk'));
    await expect(
      saveSmtpTlsReportToElasticsearch(smtpTlsReport()),
    ).rejects.toThrow(ElasticsearchError);
  });

  it('index name uses begin date for monthly partition', async () => {
    await saveSmtpTlsReportToElasticsearch(smtpTlsReport(), {
      monthlyIndexes: true,
    });
    expect(indexCalls()).toContain('smtp_tls-2024-02');
  });

  it('index name honours suffix and prefix', async () => {
    await saveSmtpTlsReportToElasticsearch(smtpTlsReport(), {
      indexSuffix: 't1',
      indexPrefix: 'cust_',
    });
    expect(indexCalls()).toContain('cust_smtp_tls_t1-2024-02-03');
  });

  it('policy without strings or mx patterns', async () => {
    const report = smtpTlsReport();
    for (const policy of report.policies) {
      delete policy.policyStrings;
      delete policy.mxHostPatterns;
      delete policy.failureDetails;
    }
    await saveSmtpTlsReportToElasticsearch(report);
    const [policy] = savedDocument().policies as Record<string, unknown>[];
    expect(policy).toEqual({
      policy_domain: 'example.com',
      policy_type: 'sts',
      successful_session_count: 100,
      failed_session_count: 1,
    });
  });

  it('failure details all optional fields populated', async () => {
    const report = smtpTlsReport();
    const [policy] = report.policies;
    if (policy) {
      policy.failureDetails = [
        {
          resultType: 'certificate-expired',
          failedSessionCount: 1,
          receivingMxHostname: 'mx.example.com',
          additionalInformationUri: 'https://example.com/why',
          failureReasonCode: 'ERR_CERT',
          ipAddress: '10.0.0.5',
          receivingIp: '10.0.0.2',
          receivingMxHelo: 'mx.helo.example.com',
          sendingMtaIp: '10.0.0.1',
        } as never,
      ];
    }
    await saveSmtpTlsReportToElasticsearch(report);
    const [saved] = savedDocument().policies as {
      failure_details: unknown[];
    }[];
    expect(saved?.failure_details).toEqual([
      {
        result_type: 'certificate-expired',
        ip_address: '10.0.0.5',
        sending_mta_ip: '10.0.0.1',
        receiving_mx_hostname: 'mx.example.com',
        receiving_mx_helo: 'mx.helo.example.com',
        receiving_ip: '10.0.0.2',
        failed_session_count: 1,
        additional_information_uri: 'https://example.com/why',
        failure_reason_code: 'ERR_CERT',
      },
    ]);
  });

  it('save populates combined policy and failure detail fields', async () => {
    // The SMTP TLS analogue of issue #169: two policies (one with two
    // failure details) yield two entries each, not a cross-product.
    const report = smtpTlsReport();
    report.policies = [
      {
        policyDomain: 'example.com',
        policyType: 'sts',
        successfulSessionCount: 100,
        failedSessionCount: 2,
        failureDetails: [
          {
            resultType: 'certificate-expired',
            failedSessionCount: 1,
            sendingMtaIp: '192.0.2.1',
            receivingIp: '203.0.113.1',
            receivingMxHostname: 'mx1.example.com',
            additionalInfoUri: 'https://reports.example.com/tls-help',
          },
          {
            resultType: 'starttls-not-supported',
            failedSessionCount: 1,
            sendingMtaIp: '192.0.2.2',
            receivingIp: '203.0.113.2',
            receivingMxHostname: 'mx2.example.com',
          },
        ],
      },
      {
        policyDomain: 'example.net',
        policyType: 'tlsa',
        successfulSessionCount: 50,
        failedSessionCount: 0,
      },
    ];
    await saveSmtpTlsReportToElasticsearch(report);
    const document = savedDocument();
    expect(document.policies_combined).toEqual([
      'example.com / sts',
      'example.net / tlsa',
    ]);
    expect(document.failure_details_combined).toEqual([
      'example.com / sts / certificate-expired / 192.0.2.1 / 203.0.113.1 / mx1.example.com',
      'example.com / sts / starttls-not-supported / 192.0.2.2 / 203.0.113.2 / mx2.example.com',
    ]);
    // The parser emits additional_info_uri; it is stored on the declared
    // additional_information_uri field rather than dropped.
    const [policy] = document.policies as {
      failure_details: { additional_information_uri?: string }[];
    }[];
    expect(policy?.failure_details[0]?.additional_information_uri).toBe(
      'https://reports.example.com/tls-help',
    );
  });

  it('save blank failure detail fields omitted from ip fields', async () => {
    // Issue #915: a reporter sent sending-mta-ip/receiving-ip as "". The
    // parser drops them, so the Ip fields never see an empty string (which
    // would fail validation and discard the whole report).
    const report = caseReport<SMTPTLSReport>(
      findCase(
        expected.saves,
        'smtp_tls/empty_failure_detail_fields.json.json',
      ),
    );
    await saveSmtpTlsReportToElasticsearch(report);
    const [policy] = savedDocument().policies as {
      failure_details: Record<string, unknown>[];
    }[];
    const [detail] = policy?.failure_details ?? [];
    expect(detail).not.toHaveProperty('sending_mta_ip');
    expect(detail).not.toHaveProperty('receiving_ip');
    expect(detail?.failure_reason_code).toBe('no-policy-served');
  });
});

describe('setHosts: secrets in error messages', () => {
  it.each(['https://user:pa/ss@es:9200', 'https://user:pa#ss@es:9200'])(
    'hides the password of an unparseable URL: %s',
    async url => {
      const error = await setHosts(url).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ValueError);
      expect((error as Error).message).toBe(
        "Could not parse URL 'https://***@es:9200'",
      );
    },
  );
});

describe('report data the cluster must not choke on', () => {
  function dedupClauses(): unknown[] {
    const query = callsTo('search')[0]?.params as {
      query: { bool: { must: unknown[] } };
    };
    return query.query.bool.must;
  }

  it.each(['From', 'To', 'Reply-To'])(
    'a %s header without addresses does not abort the save',
    async name => {
      const report = failureReport();
      const headers = report.parsedSample.headers as Record<string, unknown>;
      headers[name] = [];
      await saveFailureReportToElasticsearch(report);
      const sample = savedDocument().sample as Record<string, unknown>;
      expect(sample.headers).not.toHaveProperty(name.toLowerCase());
      expect(JSON.stringify(dedupClauses())).not.toContain(
        `sample.headers.${name.toLowerCase()}`,
      );
    },
  );

  it('keeps header names free of dots, which would become objects', async () => {
    const report = failureReport();
    const headers = report.parsedSample.headers as Record<string, unknown>;
    headers['Subject.x'] = 'y';
    await saveFailureReportToElasticsearch(report);
    const sample = savedDocument().sample as Record<string, unknown>;
    expect(sample.headers).toHaveProperty(['subject_x'], 'y');
    expect(Object.keys(sample.headers as object)).not.toContain('subject.x');
  });

  it('writes an override reason with child elements as text', async () => {
    const report = aggregateReport();
    const [record] = report.records;
    if (record) {
      record.policyEvaluated.policyOverrideReasons = [
        { type: { a: 'b' }, comment: ['c', 'd'] },
      ] as unknown as typeof record.policyEvaluated.policyOverrideReasons;
    }
    await saveAggregateReportToElasticsearch(report);
    expect(savedDocument().policy_overrides).toEqual([
      { type: "{'a': 'b'}", comment: ['c', 'd'] },
    ]);
  });

  it('never turns a domain with child elements into query parameters', async () => {
    const report = aggregateReport();
    report.policyPublished.domain = {
      query: 'x',
      zero_terms_query: 'all',
    } as unknown as string;
    await saveAggregateReportToElasticsearch(report);
    const text = "{'query': 'x', 'zero_terms_query': 'all'}";
    expect(dedupClauses()).toContainEqual({
      match_phrase: { 'published_policy.domain': text },
    });
    const policy = savedDocument().published_policy as Record<string, unknown>;
    expect(policy.domain).toBe(text);
  });

  it('drops a pct that is not a number instead of failing the save', async () => {
    const report = aggregateReport();
    report.policyPublished.pct = 'abc';
    const capture = captureWarnings();
    await saveAggregateReportToElasticsearch(report);
    const policy = savedDocument().published_policy as Record<string, unknown>;
    expect(policy).not.toHaveProperty('pct');
    expect(capture.output.join('\n')).toContain('pct');
  });

  it('drops an SMTP TLS address that is not an IP instead of failing the save', async () => {
    const report = smtpTlsReport();
    const [detail] = report.policies[0]?.failureDetails ?? [];
    if (detail) {
      detail.sendingMtaIp = 'not-an-ip';
      detail.receivingIp = '';
    }
    await saveSmtpTlsReportToElasticsearch(report);
    const [policy] = savedDocument().policies as {
      failure_details: Record<string, unknown>[];
    }[];
    const [saved] = policy?.failure_details ?? [];
    expect(saved).not.toHaveProperty('sending_mta_ip');
    expect(saved).not.toHaveProperty('receiving_ip');
    expect(saved?.result_type).toBe(detail?.resultType);
    expect(savedDocument().failure_details_combined).toEqual([
      expect.stringContaining('not-an-ip'),
    ]);
  });

  it('reports a failing duplicate search of a failure report as ElasticsearchError', async () => {
    cluster.failures.set('search', new Error('shard failure'));
    await expect(
      saveFailureReportToElasticsearch(failureReport()),
    ).rejects.toThrow(ElasticsearchError);
  });
});

describe('aggregate report retried after a partial save', () => {
  // parsedmarc took any document found as the whole report, so a retry after
  // a write failed halfway raised AlreadySaved and lost the other records.
  function reportWithRecords(count: number): AggregateReport {
    const report = aggregateReport();
    const [record] = report.records;
    report.records = Array.from({ length: count }, (_, position) => {
      const copy = structuredClone(
        record,
      ) as AggregateReport['records'][number];
      copy.source.ipAddress = `192.0.2.${position + 1}`;
      return copy;
    });
    return report;
  }

  async function documentsOf(
    report: AggregateReport,
  ): Promise<Record<string, unknown>[]> {
    await saveAggregateReportToElasticsearch(structuredClone(report));
    const documents = savedDocuments();
    cluster.reset();
    return documents;
  }

  it('writes only the records that are missing', async () => {
    const report = reportWithRecords(3);
    const documents = await documentsOf(report);
    cluster.searchSources = [documents[1] ?? {}];
    const capture = captureWarnings();
    await saveAggregateReportToElasticsearch(report);
    expect(savedDocuments()).toEqual([documents[0], documents[2]]);
    expect(capture.output).toEqual([
      `WARNING:tsdmarc:Resuming aggregate report ID agg-1 from TestOrg: 1 of 3 records are already in Elasticsearch`,
    ]);
    expect(callsTo('search')).toHaveLength(1);
  });

  it('reads the stored documents again past one page of hits', async () => {
    const report = reportWithRecords(12);
    const documents = await documentsOf(report);
    cluster.searchSources = documents.slice(0, 11);
    await saveAggregateReportToElasticsearch(report);
    expect(savedDocuments()).toEqual([documents[11]]);
    expect(callsTo('search')).toHaveLength(2);
  });

  it('raises AlreadySaved when every record is stored', async () => {
    const report = reportWithRecords(3);
    cluster.searchSources = await documentsOf(report);
    await expect(saveAggregateReportToElasticsearch(report)).rejects.toThrow(
      AlreadySaved,
    );
    expect(savedDocuments()).toEqual([]);
  });

  it('raises AlreadySaved when a stored document is not one of its records', async () => {
    const report = reportWithRecords(3);
    const [first] = await documentsOf(report);
    cluster.searchSources = [{ ...first, source_ip_address: '198.51.100.1' }];
    await expect(saveAggregateReportToElasticsearch(report)).rejects.toThrow(
      AlreadySaved,
    );
    expect(savedDocuments()).toEqual([]);
  });

  it('ignores enrichment that changed since the first attempt', async () => {
    const report = reportWithRecords(2);
    const [first] = await documentsOf(report);
    cluster.searchSources = [
      { ...first, source_reverse_dns: 'other.example', source_country: 'XX' },
    ];
    await saveAggregateReportToElasticsearch(report);
    expect(savedDocuments()).toHaveLength(1);
  });
});

describe('index creation driven by report dates', () => {
  function createdIndexes(): unknown[] {
    return [...new Set(callsTo('indices.create').map(c => c.params.index))];
  }

  function reportSpanningDays(days: number): AggregateReport {
    const report = aggregateReport();
    const [record] = report.records;
    report.records = Array.from({ length: days }, (_, day) => {
      const date = new Date(Date.UTC(2024, 0, 1 + day))
        .toISOString()
        .slice(0, 10);
      return {
        ...structuredClone(record),
        intervalBegin: `${date} 00:00:00`,
        intervalEnd: `${date} 23:59:59`,
      };
    }) as AggregateReport['records'];
    return report;
  }

  it('bounds the indexes one report creates and keeps every record', async () => {
    const capture = captureWarnings();
    await saveAggregateReportToElasticsearch(reportSpanningDays(1100));
    expect(createdIndexes()).toHaveLength(31);
    expect(callsTo('index')).toHaveLength(1100);
    const days = savedDocuments().map(document => document.date_begin);
    expect(new Set(days).size).toBe(1100);
    expect(
      capture.output.filter(line => line.includes('indexes')),
    ).toHaveLength(1);
  });

  it('leaves a report within the limit in its daily indexes', async () => {
    const capture = captureWarnings();
    await saveAggregateReportToElasticsearch(reportSpanningDays(31));
    expect(createdIndexes()).toHaveLength(31);
    expect(capture.output).toEqual([]);
  });

  it('counts indexes, not days, with monthly indexes', async () => {
    await saveAggregateReportToElasticsearch(reportSpanningDays(120), {
      monthlyIndexes: true,
    });
    expect(createdIndexes()).toHaveLength(4);
  });

  it('maxIndexesPerReport changes the limit and 0 removes it', async () => {
    await saveAggregateReportToElasticsearch(reportSpanningDays(5), {
      maxIndexesPerReport: 2,
    });
    expect(createdIndexes()).toHaveLength(2);
    cluster.reset();
    await saveAggregateReportToElasticsearch(reportSpanningDays(40), {
      maxIndexesPerReport: 0,
    });
    expect(createdIndexes()).toHaveLength(40);
  });

  it('turns date detection off and declares the date fields', async () => {
    await saveAggregateReportToElasticsearch(aggregateReport());
    await saveFailureReportToElasticsearch(failureReport());
    await saveSmtpTlsReportToElasticsearch(smtpTlsReport());
    const dates = {
      '@timestamp': DATE,
      date_begin: DATE,
      date_end: DATE,
      date_range: DATE,
    };
    expect(callsTo('indices.create').map(createdMappings)).toEqual([
      { date_detection: false, properties: dates },
      {
        date_detection: false,
        properties: {
          '@timestamp': DATE,
          arrival_date: DATE,
          sample: {
            properties: {
              date: DATE,
              headers: expect.objectContaining({ dynamic: false }),
            },
          },
        },
      },
      { date_detection: false, properties: dates },
    ]);
  });

  it('maps a fixed list of sample headers and saves every header', async () => {
    // Header names come from the sender: mapped dynamically, a sample with
    // enough distinct names would use up index.mapping.total_fields.limit and
    // every later sample of that index would be rejected.
    const report = failureReport();
    const headers = report.parsedSample.headers as Record<string, unknown>;
    for (let index = 0; index < 1500; index += 1) {
      headers[`X-Spam-${index}`] = 'y';
    }
    await saveFailureReportToElasticsearch(report);
    const mapping = createdMappings(callsTo('indices.create')[0]) as {
      properties: { sample: { properties: { headers: unknown } } };
    };
    const headersMapping = mapping.properties.sample.properties.headers as {
      dynamic: boolean;
      properties: Record<string, unknown>;
    };
    expect(headersMapping.dynamic).toBe(false);
    const dynamicString = {
      type: 'text',
      fields: { keyword: { type: 'keyword', ignore_above: 256 } },
    };
    for (const name of ['from', 'to', 'reply-to', 'received', 'subject']) {
      expect(headersMapping.properties[name]).toEqual(dynamicString);
    }
    expect(headersMapping.properties).not.toHaveProperty('x-spam-0');
    const sample = savedDocument().sample as { headers: object };
    expect(Object.keys(sample.headers)).toHaveLength(
      Object.keys(headers).length,
    );
    expect(sample.headers).toHaveProperty(['x-spam-1499'], 'y');
  });

  it('createIndexes() alone still creates bare indexes', async () => {
    await createIndexes(['bare']);
    expect(createdMappings(callsTo('indices.create')[0])).toBeUndefined();
  });
});

describe('duplicate search scope', () => {
  async function searchedIndex(options: SaveOptions): Promise<unknown> {
    await saveAggregateReportToElasticsearch(aggregateReport(), options);
    return callsTo('search')[0]?.params.index;
  }

  it('stops at the suffix, so `prod` does not reach `production`', async () => {
    await expect(searchedIndex({ indexSuffix: 'prod' })).resolves.toBe(
      'dmarc_aggregate_prod-*,dmarc_aggregate_prod',
    );
  });

  it('leaves suffixed indexes out without a suffix', async () => {
    await expect(searchedIndex({})).resolves.toBe(
      'dmarc_aggregate-*,dmarc_aggregate',
    );
  });

  it('keeps the prefix', async () => {
    await expect(
      searchedIndex({ indexPrefix: 'tenant_', indexSuffix: 'a' }),
    ).resolves.toBe('tenant_dmarc_aggregate_a-*,tenant_dmarc_aggregate_a');
  });

  it('applies to failure and SMTP TLS reports', async () => {
    await saveFailureReportToElasticsearch(failureReport(), {
      indexSuffix: 'prod',
    });
    await saveSmtpTlsReportToElasticsearch(smtpTlsReport(), {
      indexSuffix: 'prod',
    });
    expect(callsTo('search').map(call => call.params.index)).toEqual([
      'dmarc_failure_prod-*,dmarc_failure_prod,' +
        'dmarc_forensic_prod-*,dmarc_forensic_prod',
      'smtp_tls_prod-*,smtp_tls_prod',
    ]);
  });
});

describe('legacy migration never deletes an incomplete copy', () => {
  function legacyIndex(): void {
    cluster.existing.add('dmarc_aggregate');
    cluster.fieldMapping = typelessFoMapping('dmarc_aggregate', 'long');
    cluster.scrollPages = [
      [{ _index: 'dmarc_aggregate', _id: 'a', _source: { org_name: 'A' } }],
    ];
  }

  async function migrate(): Promise<LogCapture> {
    const capture = captureWarnings();
    await migrateIndexes({ legacyFoIndexes: ['dmarc_aggregate'] });
    return capture;
  }

  function deletedIndexes(): unknown[] {
    return callsTo('indices.delete').map(call => call.params.index);
  }

  it('deletes the original once the counts match', async () => {
    legacyIndex();
    cluster.count = 1;
    await migrate();
    expect(callsTo('indices.refresh')).toEqual([
      { api: 'indices.refresh', params: { index: 'dmarc_aggregate-v2' } },
    ]);
    expect(deletedIndexes()).toEqual(['dmarc_aggregate']);
  });

  it('fails on shards lost in a page without hits', async () => {
    legacyIndex();
    cluster.emptyPageShards = {
      total: 2,
      successful: 1,
      skipped: 0,
      failed: 1,
    };
    const capture = await migrate();
    expect(deletedIndexes()).toEqual([]);
    expect(capture.output.join('\n')).toContain(
      'Scroll request has only succeeded on 1 (+0 skipped) shards out of 2.',
    );
  });

  it('keeps the original when the copy holds fewer documents', async () => {
    legacyIndex();
    cluster.counts.set('dmarc_aggregate', 2);
    cluster.counts.set('dmarc_aggregate-v2', 1);
    const capture = await migrate();
    expect(deletedIndexes()).toEqual([]);
    expect(capture.output.join('\n')).toContain(
      'dmarc_aggregate-v2 holds 1 documents, dmarc_aggregate holds 2',
    );
  });

  it('keeps the original when a count missed shards', async () => {
    legacyIndex();
    cluster.countFailedShards = 1;
    await migrate();
    expect(deletedIndexes()).toEqual([]);
  });
});

describe('an explicit client instead of the default connection', () => {
  // The default connection is module state: an application writing to one
  // cluster per tenant passes each tenant's client instead.

  type Spied = ReturnType<typeof vi.spyOn>;

  function spyOnRequests(client: Elasticsearch.Client): Spied[] {
    return [
      vi.spyOn(client, 'search'),
      vi.spyOn(client, 'index'),
      vi.spyOn(client, 'count'),
      vi.spyOn(client, 'updateByQuery'),
      vi.spyOn(client.indices, 'exists'),
      vi.spyOn(client.indices, 'create'),
    ];
  }

  function requestCount(spies: readonly Spied[]): number {
    return spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
  }

  it('sends every request of a save to the client passed in', async () => {
    const fallback = getDefaultConnection();
    expect(fallback).not.toBeNull();
    const tenant = await createClient('http://tenant-b:9200');
    const fallbackSpies = fallback ? spyOnRequests(fallback) : [];
    const tenantSpies = spyOnRequests(tenant);
    const options = { client: tenant };
    await saveAggregateReportToElasticsearch(aggregateReport(), options);
    await saveFailureReportToElasticsearch(failureReport(), options);
    await saveSmtpTlsReportToElasticsearch(smtpTlsReport(), options);
    await migrateIndexes({ ...options, aggregateIndexes: ['dmarc_aggregate'] });
    expect(requestCount(fallbackSpies)).toBe(0);
    expect(tenantSpies[1]?.mock.calls).toHaveLength(3);
    expect(tenantSpies[2]?.mock.calls).toHaveLength(1);
  });

  it('a concurrent setHosts() does not redirect a save in progress', async () => {
    const tenant = await createClient('http://tenant-b:9200');
    const tenantSpies = spyOnRequests(tenant);
    const saving = saveAggregateReportToElasticsearch(aggregateReport(), {
      client: tenant,
    });
    const other = await setHosts('http://tenant-c:9200');
    const otherSpies = spyOnRequests(other);
    await saving;
    expect(requestCount(otherSpies)).toBe(0);
    expect(tenantSpies[1]?.mock.calls).toHaveLength(1);
  });

  it('createClient() does not replace the default connection', async () => {
    const fallback = getDefaultConnection();
    await createClient('http://tenant-b:9200');
    expect(getDefaultConnection()).toBe(fallback);
  });

  it('takes the serverless flag of the client, not of setHosts()', async () => {
    const tenant = await createClient('http://tenant-b:9200', {
      serverless: true,
    });
    cluster.reset();
    await createIndexes(['idx'], null, null, { client: tenant });
    await createIndexes(['other']);
    expect(callsTo('indices.create').map(call => call.params)).toEqual([
      { index: 'idx' },
      {
        index: 'other',
        settings: { number_of_shards: 1, number_of_replicas: 0 },
      },
    ]);
  });
});

describe('backward-compatible aliases', () => {
  it('save forensic alias points to save failure', () => {
    expect(saveForensicReportToElasticsearch).toBe(
      saveFailureReportToElasticsearch,
    );
  });
});

// ---------------------------------------------------------------------------
// Data streams (parsedmarc issue #842)
// ---------------------------------------------------------------------------

function streamError(type: string, statusCode: number): errors.ResponseError {
  return new errors.ResponseError({
    body: { error: { type, root_cause: [] }, status: statusCode },
    statusCode,
    headers: {},
    warnings: null,
  } as unknown as ConstructorParameters<typeof errors.ResponseError>[0]);
}

/** The body of the index template a put sent. */
function templateBody(call: ApiCall | undefined): Record<string, unknown> {
  return (call?.params ?? {}) as Record<string, unknown>;
}

function putTemplates(): Record<string, unknown>[] {
  return callsTo('indices.putIndexTemplate').map(templateBody);
}

/** The `template` (settings and mappings) of the `index`th template put. */
function putTemplate(index = 0): { settings?: unknown; mappings?: unknown } {
  return (putTemplates()[index]?.template ?? {}) as {
    settings?: unknown;
    mappings?: unknown;
  };
}

describe('createDataStreams', () => {
  it('creates template and stream when missing', async () => {
    await createDataStreams(['dmarc_aggregate'], {
      number_of_shards: 2,
      number_of_replicas: 1,
    });
    const [put] = callsTo('indices.putIndexTemplate');
    expect(put?.params.name).toBe('dmarc_aggregate');
    const template = templateBody(put);
    // Exact name, no wildcard: the template must never claim the
    // date-suffixed indexes written without data streams.
    expect(template.index_patterns).toEqual(['dmarc_aggregate']);
    expect(template.data_stream).toEqual({});
    expect(template.priority).toBe(501);
    expect(template.composed_of).toEqual(['dmarc_aggregate@custom']);
    expect(template.ignore_missing_component_templates).toEqual([
      'dmarc_aggregate@custom',
    ]);
    expect(template.template).toEqual({
      settings: { number_of_shards: 2, number_of_replicas: 1 },
      mappings: { properties: { '@timestamp': { type: 'date' } } },
    });
    expect((template._meta as { description: string }).description).toContain(
      'dmarc_aggregate@custom',
    );
    expect(callsTo('indices.createDataStream')).toEqual([
      { api: 'indices.createDataStream', params: { name: 'dmarc_aggregate' } },
    ]);
    // No concrete index is created for a stream.
    expect(callsTo('indices.create')).toEqual([]);
  });

  it('default settings are one shard no replicas', async () => {
    await createDataStreams(['smtp_tls']);
    expect(putTemplate().settings).toEqual({
      number_of_shards: 1,
      number_of_replicas: 0,
    });
  });

  it('existing stream gets template but is not recreated', async () => {
    // The template is put again so that settings changes reach the next
    // backing index; the stream itself already exists.
    cluster.dataStreams = ['dmarc_failure'];
    await createDataStreams(['dmarc_failure']);
    expect(callsTo('indices.putIndexTemplate')).toHaveLength(1);
    expect(callsTo('indices.createDataStream')).toEqual([]);
    expect(callsTo('indices.exists')).toEqual([]);
  });

  it('concrete index holding the name raises without writing', async () => {
    // Elasticsearch answers GET _data_stream/<name> for a name held by a
    // concrete index with 200 and an empty list, not a 404. Taking that as
    // "the stream exists" would send every document into the old undated
    // index, such as one left by a pre-5.0.0 release.
    cluster.dataStreams = [];
    cluster.existing.add('dmarc_aggregate');
    const error = await createDataStreams(['dmarc_aggregate']).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ElasticsearchError);
    expect((error as Error).message).toBe(
      'Elasticsearch error: cannot create the data stream dmarc_aggregate: ' +
        'an index or alias with that name already exists',
    );
    expect(indexCalls()).toEqual(['dmarc_aggregate']);
    expect(callsTo('indices.putIndexTemplate')).toEqual([]);
    expect(callsTo('indices.createDataStream')).toEqual([]);
    // Not remembered: the next save checks again.
    cluster.reset();
    await expect(
      createDataStreams(['dmarc_aggregate']),
    ).resolves.toBeUndefined();
    expect(callsTo('indices.createDataStream')).toHaveLength(1);
  });

  it('alias holding the name raises', async () => {
    // A missing stream is a 404; an alias with the name still exists as far
    // as the index exists check is concerned.
    cluster.existing.add('smtp_tls');
    await expect(createDataStreams(['smtp_tls'])).rejects.toThrow(
      ElasticsearchError,
    );
    expect(callsTo('indices.putIndexTemplate')).toEqual([]);
    expect(callsTo('indices.createDataStream')).toEqual([]);
  });

  it('reports an alias the stream lookup refuses as a name collision', async () => {
    // Elasticsearch 8 and 9 answer GET _data_stream/<alias> with 400
    // illegal_argument_exception ("matches an alias").
    cluster.failures.set(
      'indices.getDataStream',
      streamError('illegal_argument_exception', 400),
    );
    cluster.existing.add('smtp_tls');
    await expect(createDataStreams(['smtp_tls'])).rejects.toThrow(
      'cannot create the data stream smtp_tls: an index or alias with that name already exists',
    );
    expect(callsTo('indices.putIndexTemplate')).toEqual([]);
  });

  it('ready stream is not set up again', async () => {
    await createDataStreams(['dmarc_aggregate']);
    await createDataStreams(['dmarc_aggregate']);
    expect(callsTo('indices.getDataStream')).toHaveLength(1);
    expect(callsTo('indices.putIndexTemplate')).toHaveLength(1);
    expect(callsTo('indices.createDataStream')).toHaveLength(1);
  });

  it('setHosts forgets ready streams', async () => {
    // A new connection may be a different cluster or carry new index
    // settings, so the template has to be put again.
    await createDataStreams(['dmarc_aggregate']);
    await setHosts('http://localhost:9200');
    await createDataStreams(['dmarc_aggregate']);
    expect(callsTo('indices.putIndexTemplate')).toHaveLength(2);
  });

  it('puts the template again when the settings change', async () => {
    await createDataStreams(['dmarc_aggregate']);
    cluster.dataStreams = ['dmarc_aggregate'];
    await createDataStreams(['dmarc_aggregate'], {
      number_of_shards: 3,
      number_of_replicas: 0,
    });
    expect(
      putTemplates().map(
        template => (template.template as { settings: unknown }).settings,
      ),
    ).toEqual([
      { number_of_shards: 1, number_of_replicas: 0 },
      { number_of_shards: 3, number_of_replicas: 0 },
    ]);
    expect(callsTo('indices.createDataStream')).toHaveLength(1);
  });

  it('sdk error is wrapped and retried next time', async () => {
    cluster.failures.set('indices.putIndexTemplate', new Error('cluster down'));
    const error = await createDataStreams(['dmarc_aggregate']).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ElasticsearchError);
    expect((error as Error).message).toContain('cluster down');
    expect(callsTo('indices.createDataStream')).toEqual([]);

    cluster.failures.delete('indices.putIndexTemplate');
    await createDataStreams(['dmarc_aggregate']);
    expect(callsTo('indices.createDataStream')).toEqual([
      { api: 'indices.createDataStream', params: { name: 'dmarc_aggregate' } },
    ]);
  });

  it('wraps a failing stream lookup other than a 404', async () => {
    cluster.failures.set(
      'indices.getDataStream',
      streamError('security_exception', 403),
    );
    await expect(createDataStreams(['dmarc_aggregate'])).rejects.toThrow(
      ElasticsearchError,
    );
    expect(callsTo('indices.putIndexTemplate')).toEqual([]);
  });

  it('accepts a stream another writer created after the check', async () => {
    cluster.failures.set(
      'indices.createDataStream',
      streamError('resource_already_exists_exception', 400),
    );
    await expect(
      createDataStreams(['dmarc_aggregate']),
    ).resolves.toBeUndefined();
  });

  it('is no collision when another writer creates the stream between the checks', async () => {
    // The stream lookup says "missing", then the exists check finds the
    // stream another writer just created.
    const record = cluster.call.bind(cluster);
    cluster.call = (api, params) => {
      record(api, params);
      if (api === 'indices.exists') {
        cluster.dataStreams = ['dmarc_aggregate'];
      }
    };
    cluster.existing.add('dmarc_aggregate');
    try {
      await expect(
        createDataStreams(['dmarc_aggregate']),
      ).resolves.toBeUndefined();
    } finally {
      cluster.call = record;
    }
    expect(callsTo('indices.getDataStream')).toHaveLength(2);
    expect(callsTo('indices.putIndexTemplate')).toHaveLength(1);
    expect(callsTo('indices.createDataStream')).toEqual([]);
  });

  it('concurrent saves share one set-up', async () => {
    await Promise.all([
      createDataStreams(['dmarc_aggregate']),
      createDataStreams(['dmarc_aggregate']),
    ]);
    expect(callsTo('indices.getDataStream')).toHaveLength(1);
    expect(callsTo('indices.createDataStream')).toHaveLength(1);
  });

  it('keeps the streams of each client apart', async () => {
    const tenant = await createClient('http://tenant:9200');
    await createDataStreams(['dmarc_aggregate']);
    await createDataStreams(['dmarc_aggregate'], null, null, {
      client: tenant,
    });
    expect(callsTo('indices.createDataStream')).toHaveLength(2);
  });

  it('serverless strips rejected settings from template', async () => {
    await setHosts('http://localhost:9200', { serverless: true });
    await createDataStreams(['dmarc_aggregate'], {
      number_of_shards: 1,
      number_of_replicas: 0,
      refresh_interval: '5s',
    });
    expect(putTemplate().settings).toEqual({ refresh_interval: '5s' });
    await setHosts('http://localhost:9200');
  });
});

describe('saving to data streams', () => {
  const STREAM_MAPPINGS = {
    aggregate: {
      date_detection: false,
      properties: {
        '@timestamp': DATE,
        date_begin: DATE,
        date_end: DATE,
        date_range: DATE,
      },
    },
  };

  it('aggregate report goes to the stream', async () => {
    await saveAggregateReportToElasticsearch(aggregateReport(), {
      indexPrefix: 'cust_',
      indexSuffix: 'tenant_a',
      // Ignored in stream mode.
      monthlyIndexes: true,
      useDataStreams: true,
    });
    const [indexCall] = callsTo('index');
    expect(indexCall?.params.index).toBe('cust_dmarc_aggregate_tenant_a');
    expect(indexCall?.params.op_type).toBe('create');
    expect(savedDocument()['@timestamp']).toBe('2024-01-15T00:00:00+00:00');
    expect(savedDocument().report_id).toBe('agg-1');
    const [template] = putTemplates();
    expect(template?.index_patterns).toEqual(['cust_dmarc_aggregate_tenant_a']);
    // The backing indices get the date mappings of a dated index.
    expect(putTemplate().mappings).toEqual(STREAM_MAPPINGS.aggregate);
    expect(callsTo('indices.createDataStream')).toEqual([
      {
        api: 'indices.createDataStream',
        params: { name: 'cust_dmarc_aggregate_tenant_a' },
      },
    ]);
    expect(callsTo('indices.create')).toEqual([]);
    // The duplicate search covers the stream as well as the dated indexes
    // written before the switch.
    expect(callsTo('search')[0]?.params.index).toBe(
      'cust_dmarc_aggregate_tenant_a-*,cust_dmarc_aggregate_tenant_a',
    );
    expect(callsTo('search')[0]?.params.ignore_unavailable).toBe(true);
  });

  it('aggregate report dated mode unchanged apart from timestamp and op type', async () => {
    await saveAggregateReportToElasticsearch(aggregateReport());
    const [indexCall] = callsTo('index');
    expect(indexCall?.params.index).toBe('dmarc_aggregate-2024-01-15');
    expect(indexCall?.params.op_type).toBe('create');
    expect(savedDocument()['@timestamp']).toBe('2024-01-15T00:00:00+00:00');
    expect(callsTo('indices.create')).toHaveLength(1);
    expect(callsTo('indices.putIndexTemplate')).toEqual([]);
    expect(callsTo('indices.createDataStream')).toEqual([]);
  });

  it('failure report goes to the stream', async () => {
    await saveFailureReportToElasticsearch(failureReport(), {
      monthlyIndexes: true,
      useDataStreams: true,
    });
    const [indexCall] = callsTo('index');
    expect(indexCall?.params.index).toBe('dmarc_failure');
    expect(indexCall?.params.op_type).toBe('create');
    expect(savedDocument()['@timestamp']).toBe('2024-01-01T00:00:00+00:00');
    const mappings = putTemplate().mappings as {
      properties: Record<string, unknown>;
    };
    // sample.headers keeps its fixed list of fields in the stream too.
    expect(mappings.properties.sample).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          headers: expect.objectContaining({ dynamic: false }),
        }),
      }),
    );
    expect(callsTo('indices.createDataStream')).toEqual([
      { api: 'indices.createDataStream', params: { name: 'dmarc_failure' } },
    ]);
    expect(callsTo('indices.create')).toEqual([]);
    expect(callsTo('search')[0]?.params.index).toBe(
      'dmarc_failure-*,dmarc_failure,dmarc_forensic-*,dmarc_forensic',
    );
  });

  it('failure report dated mode unchanged apart from timestamp and op type', async () => {
    await saveFailureReportToElasticsearch(failureReport());
    const [indexCall] = callsTo('index');
    expect(indexCall?.params.index).toBe('dmarc_failure-2024-01-01');
    expect(indexCall?.params.op_type).toBe('create');
    expect(savedDocument()['@timestamp']).toBe('2024-01-01T00:00:00+00:00');
    expect(callsTo('indices.createDataStream')).toEqual([]);
  });

  it('smtp tls report goes to the stream', async () => {
    await saveSmtpTlsReportToElasticsearch(smtpTlsReport(), {
      indexPrefix: 'cust_',
      useDataStreams: true,
    });
    const [indexCall] = callsTo('index');
    expect(indexCall?.params.index).toBe('cust_smtp_tls');
    expect(indexCall?.params.op_type).toBe('create');
    expect(savedDocument()['@timestamp']).toBe('2024-02-03T00:00:00+00:00');
    expect(callsTo('indices.createDataStream')).toEqual([
      { api: 'indices.createDataStream', params: { name: 'cust_smtp_tls' } },
    ]);
    expect(callsTo('indices.create')).toEqual([]);
    expect(callsTo('search')[0]?.params.index).toBe(
      'cust_smtp_tls-*,cust_smtp_tls',
    );
  });

  it('smtp tls report dated mode unchanged apart from timestamp and op type', async () => {
    await saveSmtpTlsReportToElasticsearch(smtpTlsReport());
    const [indexCall] = callsTo('index');
    expect(indexCall?.params.index).toBe('smtp_tls-2024-02-03');
    expect(indexCall?.params.op_type).toBe('create');
    expect(savedDocument()['@timestamp']).toBe('2024-02-03T00:00:00+00:00');
    expect(callsTo('indices.createDataStream')).toEqual([]);
  });

  it('stream set up once for a multi record report', async () => {
    const report = aggregateReport();
    report.records.push(...structuredClone(report.records));
    await saveAggregateReportToElasticsearch(report, { useDataStreams: true });
    expect(callsTo('index')).toHaveLength(2);
    expect(callsTo('indices.putIndexTemplate')).toHaveLength(1);
  });

  it('a report over many days stays in its one stream, without a warning', async () => {
    // maxIndexesPerReport bounds dated indexes; a stream is one name.
    const capture = captureWarnings();
    const report = aggregateReport();
    const [record] = report.records;
    report.records = Array.from({ length: 40 }, (_, day) => {
      const date = new Date(Date.UTC(2024, 0, 1 + day))
        .toISOString()
        .slice(0, 10);
      return {
        ...structuredClone(record),
        intervalBegin: `${date} 00:00:00`,
        intervalEnd: `${date} 23:59:59`,
      };
    }) as AggregateReport['records'];
    await saveAggregateReportToElasticsearch(report, { useDataStreams: true });
    expect(new Set(callsTo('index').map(call => call.params.index))).toEqual(
      new Set(['dmarc_aggregate']),
    );
    expect(callsTo('index')).toHaveLength(40);
    expect(capture.output).toEqual([]);
  });

  it('name collision saves nothing', async () => {
    cluster.existing.add('smtp_tls');
    await expect(
      saveSmtpTlsReportToElasticsearch(smtpTlsReport(), {
        useDataStreams: true,
      }),
    ).rejects.toThrow(ElasticsearchError);
    expect(callsTo('index')).toEqual([]);
  });
});

describe('migrateIndexes with a data stream', () => {
  it('legacy fo migration skips a stream with the name', async () => {
    // With useDataStreams the undated legacy name is the stream itself. The
    // exists check is true for it, and the field mapping comes back keyed by
    // a backing index; its fo is text, so nothing is migrated or deleted.
    cluster.existing.add('dmarc_aggregate');
    cluster.fieldMapping = typelessFoMapping(
      '.ds-dmarc_aggregate-2026.10.31-000001',
      'text',
    );
    await migrateIndexes({ legacyFoIndexes: ['dmarc_aggregate'] });
    expect(callsTo('bulk')).toEqual([]);
    expect(callsTo('indices.create')).toEqual([]);
    expect(callsTo('indices.delete')).toEqual([]);
  });
});
