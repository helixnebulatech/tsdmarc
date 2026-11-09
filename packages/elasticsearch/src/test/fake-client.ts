// A stand-in for `@elastic/elasticsearch`'s Client, installed with vi.mock.
// It records every API call (name and parameters) and answers like a small
// cluster, with the same canned responses the Python recorder
// (scripts/generate-expected.py) gives parsedmarc.

export interface ApiCall {
  api: string;
  params: Record<string, unknown>;
}

interface Hit {
  _index: string;
  _id: string;
  _source: Record<string, unknown>;
}

export class FakeCluster {
  calls: ApiCall[] = [];
  clientOptions: Record<string, unknown>[] = [];
  existing: Set<string> = new Set<string>();
  searchHits = 0;
  /** `_source` of the documents searches find, replacing `searchHits`. */
  searchSources: Record<string, unknown>[] | null = null;
  count = 0;
  /** Document counts by index, overriding `count`. */
  counts: Map<string, number> = new Map<string, number>();
  /** Shards failed in `count` responses. */
  countFailedShards = 0;
  fieldMapping: unknown = null;
  scrollPages: Hit[][] = [];
  /** `_shards` of a scroll page without hits (a partial failure). */
  emptyPageShards: Record<string, number> | null = null;
  bulkItems: unknown[] = [];
  /** Errors to throw from an API, by name (`'search'`, `'indices.exists'`). */
  failures: Map<string, unknown> = new Map<string, unknown>();
  /** Data streams `GET _data_stream/<name>` lists; `null` answers 404. */
  dataStreams: string[] | null = null;
  /**
   * Builds the client's 404 `ResponseError` (set by the test's `vi.mock`
   * factory, which holds the real module); kept across resets.
   */
  notFound: (() => unknown) | null = null;

  reset(): void {
    this.calls = [];
    this.clientOptions = [];
    this.existing = new Set();
    this.searchHits = 0;
    this.searchSources = null;
    this.count = 0;
    this.counts = new Map();
    this.countFailedShards = 0;
    this.fieldMapping = null;
    this.scrollPages = [];
    this.emptyPageShards = null;
    this.bulkItems = [];
    this.failures = new Map();
    this.dataStreams = null;
  }

  call(api: string, params: Record<string, unknown>): void {
    this.calls.push({ api, params: structuredClone(params) });
    if (this.failures.has(api)) {
      throw this.failures.get(api);
    }
  }

  scrollPage(): Record<string, unknown> {
    const hits = this.scrollPages.shift() ?? [];
    return {
      _scroll_id: 'scroll-1',
      _shards: (hits.length === 0 ? this.emptyPageShards : null) ?? {
        total: 1,
        successful: 1,
        skipped: 0,
        failed: 0,
      },
      hits: { hits },
    };
  }
}

export const cluster: FakeCluster = new FakeCluster();

type Params = Record<string, unknown>;

export class FakeClient {
  readonly options: Params;

  readonly indices = {
    exists: async (params: Params): Promise<boolean> => {
      cluster.call('indices.exists', params);
      return cluster.existing.has(String(params.index));
    },
    create: async (params: Params): Promise<unknown> => {
      cluster.call('indices.create', params);
      return { acknowledged: true };
    },
    delete: async (params: Params): Promise<unknown> => {
      cluster.call('indices.delete', params);
      return { acknowledged: true };
    },
    refresh: async (params: Params): Promise<unknown> => {
      cluster.call('indices.refresh', params);
      return { _shards: { total: 1, successful: 1, failed: 0 } };
    },
    putMapping: async (params: Params): Promise<unknown> => {
      cluster.call('indices.putMapping', params);
      return { acknowledged: true };
    },
    getFieldMapping: async (params: Params): Promise<unknown> => {
      cluster.call('indices.getFieldMapping', params);
      return (
        cluster.fieldMapping ?? { [String(params.index)]: { mappings: {} } }
      );
    },
    getDataStream: async (params: Params): Promise<unknown> => {
      cluster.call('indices.getDataStream', params);
      if (cluster.dataStreams === null) {
        throw cluster.notFound?.() ?? new Error('index_not_found_exception');
      }
      return { data_streams: cluster.dataStreams.map(name => ({ name })) };
    },
    createDataStream: async (params: Params): Promise<unknown> => {
      cluster.call('indices.createDataStream', params);
      return { acknowledged: true };
    },
    putIndexTemplate: async (params: Params): Promise<unknown> => {
      cluster.call('indices.putIndexTemplate', params);
      return { acknowledged: true };
    },
  };

  constructor(options: Params) {
    this.options = options;
    cluster.clientOptions.push(options);
  }

  async search(params: Params): Promise<unknown> {
    cluster.call('search', params);
    if ('scroll' in params) {
      return cluster.scrollPage();
    }
    const sources =
      cluster.searchSources?.slice(0, Number(params.size ?? 10)) ??
      Array.from({ length: cluster.searchHits }, () => ({}));
    const hits = sources.map((source, index) => ({
      _index: 'x',
      _id: String(index),
      _source: source,
    }));
    return {
      took: 1,
      timed_out: false,
      hits: { total: { value: hits.length, relation: 'eq' }, hits },
    };
  }

  async scroll(params: Params): Promise<unknown> {
    cluster.call('scroll', params);
    return cluster.scrollPage();
  }

  async clearScroll(params: Params): Promise<unknown> {
    cluster.call('clearScroll', params);
    return { succeeded: true, num_freed: 1 };
  }

  async bulk(params: Params): Promise<unknown> {
    cluster.call('bulk', params);
    return { took: 1, errors: false, items: cluster.bulkItems };
  }

  async index(params: Params): Promise<unknown> {
    cluster.call('index', params);
    return { _index: params.index, _id: '1', result: 'created' };
  }

  async count(params: Params): Promise<unknown> {
    cluster.call('count', params);
    return {
      count: cluster.counts.get(String(params.index)) ?? cluster.count,
      _shards: { total: 1, successful: 1, failed: cluster.countFailedShards },
    };
  }

  async updateByQuery(params: Params): Promise<unknown> {
    cluster.call('updateByQuery', params);
    return { task: 'node:1' };
  }
}
