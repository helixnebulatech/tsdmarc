// Resuming an aggregate report whose save stopped halfway. Elasticsearch and
// OpenSearch store one document per record, written one after the other, and
// parsedmarc takes any document found by the duplicate search as the whole
// report: after a write failed on record k, the retry raised AlreadySaved and
// the records from k on were never stored. Here the documents found are
// compared with the report's own, and a retry writes only the missing ones.

import { PyDateTime } from 'tsdmarc';

/**
 * The fields that tell the documents of one report apart. Enrichment
 * (reverse DNS, GeoIP, source name and type) is left out: its answers
 * change between attempts.
 */
export const AGGREGATE_RECORD_FIELDS: readonly string[] = [
  'date_begin',
  'date_end',
  'source_ip_address',
  'message_count',
  'disposition',
  'dkim_aligned',
  'spf_aligned',
  'header_from',
  'envelope_from',
  'envelope_to',
  'dkim_results_combined',
  'spf_results_combined',
];

/**
 * Most records a report can have to be resumed: the stored documents are
 * read in one search page, which the default `index.max_result_window`
 * limits to 10,000 hits (one more than the report is asked for).
 */
const MAX_RESUMABLE_RECORDS = 9999;

function normalized(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof PyDateTime) {
    return value.isoformat();
  }
  if (Array.isArray(value)) {
    return value.map(normalized);
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'object') {
    // Nothing a resumed document holds in these fields: never equal.
    return { object: String(value) };
  }
  return value;
}

/** A serialized record document as the duplicate search returns it. */
function fingerprint(document: unknown): string {
  const source =
    typeof document === 'object' && document !== null
      ? (document as Record<string, unknown>)
      : {};
  return JSON.stringify(
    AGGREGATE_RECORD_FIELDS.map(field =>
      normalized(Object.hasOwn(source, field) ? source[field] : null),
    ),
  );
}

/** Hits in a search response without `size`: Elasticsearch's default. */
const DEFAULT_SEARCH_SIZE = 10;

/**
 * The positions of the report's records that are already stored, when the
 * documents the duplicate search found are part of this report and some are
 * missing. `null` means the report counts as saved (parsedmarc's
 * `AlreadySaved`): every record is there, the documents found are not all
 * this report's (another report with the same identity), or there are too
 * many to compare.
 *
 * @param documents The report's documents, serialized as they are sent, in
 * record order; `null` when they can't be serialized.
 * @param found The `_source` of the hits of the duplicate search (one page
 * of the default size).
 * @param fetchStored Reads the `_source` (at least
 * {@link AGGREGATE_RECORD_FIELDS}) of up to `size` documents the duplicate
 * search matches, when `found` is a full page.
 */
export async function findStoredRecords(
  documents: readonly Record<string, unknown>[] | null,
  found: readonly unknown[],
  fetchStored: (size: number) => Promise<readonly unknown[]>,
): Promise<ReadonlySet<number> | null> {
  if (
    documents === null ||
    found.length === 0 ||
    found.length >= documents.length ||
    documents.length > MAX_RESUMABLE_RECORDS
  ) {
    return null;
  }
  const stored =
    found.length < DEFAULT_SEARCH_SIZE
      ? found
      : await fetchStored(documents.length + 1);
  if (stored.length === 0 || stored.length >= documents.length) {
    return null;
  }
  const positions = new Map<string, number[]>();
  for (const [position, document] of documents.entries()) {
    const key = fingerprint(document);
    const list = positions.get(key);
    if (list === undefined) {
      positions.set(key, [position]);
    } else {
      list.push(position);
    }
  }
  const taken = new Set<number>();
  for (const source of stored) {
    const position = positions.get(fingerprint(source))?.shift();
    if (position === undefined) {
      return null;
    }
    taken.add(position);
  }
  return taken;
}
