// Port of elasticsearch.helpers.reindex() (with scan() and bulk()), which
// parsedmarc's legacy `published_policy.fo` migration uses: scroll through
// the source index in `_doc` order and bulk-index every hit, with the same
// `_id`, into the target index.

import type { Client } from '@elastic/elasticsearch';
import { rawJsonIntegers } from 'tsdmarc';

const DEFAULT_SCROLL = '5m';
const SCAN_SIZE = 1000;
const BULK_CHUNK_SIZE = 500;
const BULK_MAX_CHUNK_BYTES = 100 * 1024 * 1024;
const HTTP_NOT_FOUND = 404;
// Hit metadata that expand_action() moves into the bulk action line.
const ACTION_META_KEYS = ['_id', '_index', '_routing'] as const;

/** Raised when a scroll request fails on some shards (helpers.ScanError). */
export class ScanError extends Error {
  override name = 'ScanError';
  readonly scrollId: string;

  constructor(scrollId: string, message: string) {
    super(message);
    this.scrollId = scrollId;
  }
}

/** Raised when some documents fail to index (helpers.BulkIndexError). */
export class BulkIndexError extends Error {
  override name = 'BulkIndexError';
  readonly errors: unknown[];

  constructor(message: string, errors: unknown[]) {
    super(message);
    this.errors = errors;
  }
}

interface Hit {
  _id?: string;
  _index?: string;
  _routing?: string;
  _source?: unknown;
  [key: string]: unknown;
}

interface ScrollResponse {
  _scroll_id?: string;
  _shards?: { total?: number; successful?: number; skipped?: number };
  hits: { hits: Hit[] };
}

/**
 * Unlike helpers.scan(), also checked on a page without hits: when the last
 * shard with documents fails, the scroll ends in an empty page that reports
 * the failure, and stopping there would lose those documents in silence.
 */
function assertAllShards(response: ScrollResponse, scrollId: string): void {
  const shards = response._shards ?? {};
  const successful = shards.successful ?? 0;
  const skipped = shards.skipped ?? 0;
  const total = shards.total ?? 0;
  if (successful + skipped < total) {
    throw new ScanError(
      scrollId,
      `Scroll request has only succeeded on ${successful} (+${skipped} skipped) shards out of ${total}.`,
    );
  }
}

async function* scan(
  client: Client,
  index: string,
  scroll: string,
): AsyncGenerator<Hit> {
  let response = (await client.search({
    index,
    scroll,
    size: SCAN_SIZE,
    sort: '_doc',
  })) as unknown as ScrollResponse;
  let scrollId = response._scroll_id;
  try {
    while (scrollId) {
      const { hits } = response.hits;
      yield* hits;
      assertAllShards(response, scrollId);
      if (hits.length === 0) {
        break;
      }
      response = (await client.scroll({
        scroll_id: scrollId,
        scroll,
      })) as unknown as ScrollResponse;
      scrollId = response._scroll_id;
    }
  } finally {
    if (scrollId) {
      await client.clearScroll(
        { scroll_id: scrollId },
        { ignore: [HTTP_NOT_FOUND] },
      );
    }
  }
}

/** expand_action(): one hit → the bulk action line and the document. */
function expandHit(hit: Hit): [Record<string, unknown>, unknown] {
  const meta: Record<string, unknown> = {};
  for (const key of ACTION_META_KEYS) {
    if (key in hit) {
      meta[key] = hit[key];
    }
  }
  // The client's serializer keeps integers beyond 2^53 as bigints.
  return [
    { index: meta },
    rawJsonIntegers('_source' in hit ? hit._source : hit),
  ];
}

async function sendChunk(
  client: Client,
  operations: unknown[],
  headers: Record<string, string> | undefined,
): Promise<void> {
  const response = await client.bulk(
    { operations },
    headers ? { headers } : undefined,
  );
  const errors: unknown[] = [];
  for (const item of response.items) {
    for (const [opType, result] of Object.entries(item)) {
      const status = result?.status ?? 500;
      if (status < 200 || status >= 300) {
        errors.push({ [opType]: result });
      }
    }
  }
  if (errors.length > 0) {
    throw new BulkIndexError(
      `${errors.length} document(s) failed to index.`,
      errors,
    );
  }
}

async function isDataStream(client: Client, name: string): Promise<boolean> {
  try {
    const response = await client.indices.getDataStream({
      name,
      expand_wildcards: 'all',
    });
    return response.data_streams.some(stream => stream.name === name);
  } catch {
    // Not a data stream (or not visible): treat it as an index.
    return false;
  }
}

/**
 * Copy every document of `sourceIndex` into `targetIndex`
 * (`elasticsearch.helpers.reindex(client, source_index, target_index)`).
 * `bulkHeaders` are sent with each bulk request.
 */
export async function reindex(
  client: Client,
  sourceIndex: string,
  targetIndex: string,
  bulkHeaders?: Record<string, string>,
): Promise<void> {
  const opType = (await isDataStream(client, targetIndex)) ? 'create' : null;
  let operations: unknown[] = [];
  let count = 0;
  let bytes = 0;
  for await (const hit of scan(client, sourceIndex, DEFAULT_SCROLL)) {
    const [action, document] = expandHit({ ...hit, _index: targetIndex });
    const line =
      opType === null ? action : { [opType]: action.index as unknown };
    const size =
      Buffer.byteLength(JSON.stringify(line)) +
      Buffer.byteLength(JSON.stringify(document)) +
      2;
    if (
      count > 0 &&
      (count === BULK_CHUNK_SIZE || bytes + size > BULK_MAX_CHUNK_BYTES)
    ) {
      await sendChunk(client, operations, bulkHeaders);
      operations = [];
      count = 0;
      bytes = 0;
    }
    operations.push(line, document);
    count += 1;
    bytes += size;
  }
  if (count > 0) {
    await sendChunk(client, operations, bulkHeaders);
  }
}
