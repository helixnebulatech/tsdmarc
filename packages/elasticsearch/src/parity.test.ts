// Parity with parsedmarc: every case in test/expected.json was run through
// parsedmarc.elastic (elasticsearch-py 8 + elasticsearch.dsl) against a
// recording fake server. tsdmarc must make the same requests, with the same
// bodies (documents, queries, settings, mappings), and fail the same way.

import type * as Elasticsearch from '@elastic/elasticsearch';
import { DOCUMENT_MAPPINGS } from '@tsdmarc/search-common/documents';
import type { AggregateReport, FailureReport, SMTPTLSReport } from 'tsdmarc';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createDataStreams,
  createIndexes,
  migrateIndexes,
  saveAggregateReportToElasticsearch,
  saveFailureReportToElasticsearch,
  saveSmtpTlsReportToElasticsearch,
  setHosts,
  type MigrateIndexesOptions,
  type SaveOptions,
} from './elastic';
import {
  applyCluster,
  caseOptions,
  caseReport,
  expected,
  toApiCall,
  withDeviations,
  type ExpectedError,
  type SaveCase,
} from './test/expected';
import { cluster } from './test/fake-client';

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

beforeAll(async () => {
  await setHosts('http://localhost:9200');
});

afterAll(() => {
  cluster.reset();
});

async function outcome(
  run: () => Promise<void>,
): Promise<ExpectedError | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const { name, message } = error as Error;
    return { type: name, message };
  }
}

function save(item: SaveCase): Promise<void> {
  const options = caseOptions<SaveOptions>(item.options);
  switch (item.kind) {
    case 'aggregate':
      return saveAggregateReportToElasticsearch(
        caseReport<AggregateReport>(item),
        options,
      );
    case 'failure':
      return saveFailureReportToElasticsearch(
        caseReport<FailureReport>(item),
        options,
      );
    case 'smtp_tls':
      return saveSmtpTlsReportToElasticsearch(
        caseReport<SMTPTLSReport>(item),
        options,
      );
  }
}

describe('saved reports match parsedmarc', () => {
  it.each(expected.saves.map(item => [item.name, item] as const))(
    '%s',
    async (_name, item) => {
      // A new client: data streams set up by an earlier case are forgotten.
      await setHosts('http://localhost:9200');
      applyCluster(cluster, item.cluster);
      const error = await outcome(() => save(item));
      expect(error).toEqual(item.error);
      if (item.request_count === undefined) {
        expect(cluster.calls).toEqual(
          withDeviations(item, item.requests).map(toApiCall),
        );
        return;
      }
      // Large reports: the head and tail of the requests, and their count.
      const keep = item.requests.length;
      expect(cluster.calls).toHaveLength(item.request_count);
      expect(cluster.calls.slice(0, keep)).toEqual(
        withDeviations(item, item.requests).map(toApiCall),
      );
      expect(cluster.calls.slice(-keep)).toEqual(
        withDeviations(item, item.last_requests ?? []).map(toApiCall),
      );
    },
  );
});

describe('index management matches parsedmarc', () => {
  it.each(expected.others.map(item => [item.name, item] as const))(
    '%s',
    async (name, item) => {
      await setHosts('http://localhost:9200');
      applyCluster(cluster, item.cluster);
      const error = await outcome(async () => {
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
      expect(error).toEqual(item.error);
      expect(cluster.calls).toEqual(
        withDeviations(item, item.requests).map(toApiCall),
      );
    },
  );
});

describe('document mappings match the DSL classes', () => {
  it('declares the same aggregate, failure and SMTP TLS mappings', () => {
    expect(DOCUMENT_MAPPINGS.aggregate).toEqual(expected.mappings.aggregate);
    expect(DOCUMENT_MAPPINGS.failure).toEqual(expected.mappings.failure);
    expect(DOCUMENT_MAPPINGS.smtpTls).toEqual(expected.mappings.smtp_tls);
  });
});
