// Port of opensearchpy.helpers.reindex() (with scan() and bulk()), which
// parsedmarc's legacy `published_policy.fo` migration uses: scroll through
// the source index in `_doc` order and bulk-index every hit, with the same
// `_id`, into the target index.

import type { Client } from '@opensearch-project/opensearch';
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
  hits?: { hits?: Hit[] };
}

interface BulkResponse {
  items?: Record<string, { status?: number } | undefined>[];
}

/**
 * Unlike helpers.scan(), also checked on a page without hits: when the last
 * shard with documents fails, the scroll ends in an empty page that reports
 * the failure, and stopping there would lose those documents in silence.
 */
function assertAllShards(response: ScrollResponse, scrollId: string): void {
  const shards = response._shards;
  if (shards) {
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
}

async function* scan(
  client: Client,
  index: string,
  scroll: string,
): AsyncGenerator<Hit> {
  let response = (
    await client.search({
      index,
      scroll,
      size: SCAN_SIZE,
      body: { sort: '_doc' },
    })
  ).body as ScrollResponse;
  let scrollId = response._scroll_id;
  try {
    while (scrollId) {
      const hits = response.hits?.hits ?? [];
      yield* hits;
      assertAllShards(response, scrollId);
      if (hits.length === 0) {
        break;
      }
      response = (
        await client.scroll({ body: { scroll_id: scrollId, scroll } })
      ).body as ScrollResponse;
      scrollId = response._scroll_id;
    }
  } finally {
    if (scrollId) {
      await client.clearScroll(
        { body: { scroll_id: [scrollId] } },
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
  // The client's long numeral support keeps integers beyond 2^53 as bigints.
  return [
    { index: meta },
    rawJsonIntegers('_source' in hit ? hit._source : hit),
  ];
}

async function sendChunk(client: Client, body: unknown[]): Promise<void> {
  const response = (await client.bulk({ body: body as never[] }))
    .body as BulkResponse;
  if (!response.items) {
    throw new BulkIndexError('The bulk response has no items.', []);
  }
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

/**
 * Copy every document of `sourceIndex` into `targetIndex`
 * (`opensearchpy.helpers.reindex(client, source_index, target_index)`).
 */
export async function reindex(
  client: Client,
  sourceIndex: string,
  targetIndex: string,
): Promise<void> {
  let body: unknown[] = [];
  let count = 0;
  let bytes = 0;
  for await (const hit of scan(client, sourceIndex, DEFAULT_SCROLL)) {
    const [action, document] = expandHit({ ...hit, _index: targetIndex });
    const size =
      Buffer.byteLength(JSON.stringify(action)) +
      Buffer.byteLength(JSON.stringify(document)) +
      2;
    if (
      count > 0 &&
      (count === BULK_CHUNK_SIZE || bytes + size > BULK_MAX_CHUNK_BYTES)
    ) {
      await sendChunk(client, body);
      body = [];
      count = 0;
      bytes = 0;
    }
    body.push(action, document);
    count += 1;
    bytes += size;
  }
  if (count > 0) {
    await sendChunk(client, body);
  }
}
