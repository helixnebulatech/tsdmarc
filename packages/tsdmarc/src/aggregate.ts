// DMARC aggregate report parsing and CSV output, ported from
// parsedmarc/__init__.py (RFC 7489 and RFC 9990 in one code path).
//
// The parser walks xmltodict-shaped data from the reporter's XML, so every
// access goes through the Python-semantics helpers in ./internal/py: a
// missing element raises KeyError, a wrong type raises TypeError or
// AttributeError, and the final error mapping turns those into the same
// InvalidAggregateReport messages parsedmarc produces.

import {
  type ParserConfig,
  type ParserConfigInput,
  resolveParserConfig,
} from './config';
import { csvSafe, rowsToCsv, type CsvOptions, type CsvRow } from './csv';
import { EnrichmentError, InvalidAggregateReport } from './errors';
import {
  extractReport,
  extractReportFromFilePath,
  type ExtractOptions,
} from './extract';
import {
  dictCopy,
  errorText,
  excOrigin,
  getItem,
  getOptional,
  intValue,
  isDict,
  KeyError,
  noAttribute,
  PyAttributeError,
  pyContains,
  type PyDict,
  pyFrozensetContains,
  PyIndexError,
  pyIntExact,
  pyIter,
  pyLower,
  PyOverflowError,
  pySplit,
  pyStrJoin,
  pyTruthy,
  PyTypeError,
  PyValueError,
} from './internal/py';
import { setOwn } from './internal/set-own';
import { DEBUG, logger } from './log';
import {
  estimatedSize,
  MAX_REPORT_DEPTH,
  markRaw,
  mixedObject,
  nestsDeeperThan,
} from './serialize';
import type {
  AggregateAuthResultDKIM,
  AggregateAuthResultSPF,
  AggregatePolicyOverrideReason,
  AggregatePolicyPublished,
  AggregateRecord,
  AggregateReport,
  AggregateReportMetadata,
} from './types';
import type { PyDateTime } from './utils/datetime';
import { getBaseDomain } from './utils/domains';
import { getIpAddressInfo, ReportLookupBudget } from './utils/ip-info';
import { PY_WS_CLASS } from './utils/py-str';
import { pyRepr, pyStr } from './utils/python';
import { sanitizeForLog } from './utils/sanitize';
import { decodeUtf8 } from './utils/text';
import { humanTimestampToDatetime, timestampToHuman } from './utils/timestamps';
import { ExpatError } from './xml/expat';
import { recoverXml } from './xml/recover';
import {
  DOCTYPE_ERROR,
  parseXmlToDict,
  type ParseXmlOptions,
  XmlDoctypeFound,
  XmlLimitError,
} from './xml/xmltodict';

/** The XML namespace RFC 9990 assigns to DMARC aggregate reports. */
export const RFC_9990_NAMESPACE = 'urn:ietf:params:xml:ns:dmarc-2.0';

/**
 * RFC 9990's PolicyOverrideType enumeration: `policy_test_mode` was added
 * and `forwarded` / `sampled_out` were removed.
 */
export const RFC_9990_POLICY_OVERRIDE_TYPES: ReadonlySet<string> = new Set([
  'local_policy',
  'mailing_list',
  'other',
  'policy_test_mode',
  'trusted_forwarder',
]);
export const RFC_7489_REMOVED_POLICY_OVERRIDE_TYPES: ReadonlySet<string> =
  new Set(['forwarded', 'sampled_out']);

const RFC_9990_ONLY_POLICY_FIELDS = ['np', 'testing', 'discovery_method'];
const SORTED_RFC_9990_OVERRIDE_TYPES = pyRepr(
  [...RFC_9990_POLICY_OVERRIDE_TYPES].sort(),
);

// Each pattern runs on untrusted input and matches in linear time. They are
// Python `re` patterns translated literally: Python's `^` under MULTILINE
// matches only after `\n` (JS `m` also matches after `\r`, U+2028, U+2029),
// its `.` excludes only `\n`, `\w` is `[\p{L}\p{N}_]` and `\s` is
// `PY_WS_CLASS`.
const XML_HEADER = /(?<![^\n])<\?xml [^\n]*?>/gu;
const XML_SCHEMA = /<\/?xs:schema[^<>]*>/gu;
/** The value of any xmlns (default or prefixed) declaration. */
const XML_NAMESPACE = new RegExp(
  `xmlns(?::[a-zA-Z_][\\p{L}\\p{N}_.-]*)?[${PY_WS_CLASS}]*=[${PY_WS_CLASS}]*["']([^"']+)["']`,
  'u',
);

const SECONDS_PER_DAY = 86_400;

/**
 * Python's `str()` for xmltodict values. Elements with attributes are
 * prototype-less dicts, which `pyStr()` can't print, and `str(dict)` is
 * `repr(dict)` in Python.
 */
function str(value: unknown): string {
  return isDict(value) ? pyRepr(value) : pyStr(value);
}

/**
 * Unwrap a possibly-langAttrString value (`{"#text": ..., "@lang": ...}`)
 * to its text. `null` stays `null`; other shapes pass through unchanged.
 */
export function unwrapText(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (isDict(value)) {
    const text = value['#text'];
    return text === null || text === undefined ? null : str(text);
  }
  return value;
}

/** Lowercase a reporter-supplied enum word; non-strings pass through. */
function normalizeResultWord(value: unknown): unknown {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

export interface DayBucket {
  begin: PyDateTime;
  end: PyDateTime;
  count: number | bigint;
}

/** Consecutive days of an interval that overlap it by the same seconds. */
interface DayGroup {
  /** Index of the group's first day within the interval. */
  firstDay: number;
  days: number;
  seconds: number;
}

/** The calendar days an interval touches, grouped by overlap length. */
interface DayLayout {
  intervalSeconds: number;
  /** Midnight of the first day. */
  firstMidnight: PyDateTime;
  dayCount: number;
  groups: DayGroup[];
}

/** Python's `datetime.max.date()`: adding a day to it overflows. */
const LAST_DATE = { year: 9999, month: 12, day: 31 } as const;

function layoutDays(begin: PyDateTime, end: PyDateTime): DayLayout {
  const intervalSeconds = end.secondsSince(begin);
  let firstMidnight = begin.startOfDay();
  if (firstMidnight.compare(begin) > 0) {
    firstMidnight = firstMidnight.addSeconds(-SECONDS_PER_DAY);
  }
  const dayCount = Math.ceil(end.secondsSince(firstMidnight) / SECONDS_PER_DAY);
  const lastMidnight = firstMidnight.addSeconds(
    (dayCount - 1) * SECONDS_PER_DAY,
  );
  // Python's loop computes `day_cursor + timedelta(days=1)` for every day,
  // which overflows on 9999-12-31.
  if (
    lastMidnight.year === LAST_DATE.year &&
    lastMidnight.month === LAST_DATE.month &&
    lastMidnight.day === LAST_DATE.day
  ) {
    throw new PyOverflowError('date value out of range');
  }
  if (dayCount === 1) {
    return {
      intervalSeconds,
      firstMidnight,
      dayCount,
      groups: [{ firstDay: 0, days: 1, seconds: intervalSeconds }],
    };
  }
  const groups: DayGroup[] = [
    {
      firstDay: 0,
      days: 1,
      seconds: firstMidnight.addSeconds(SECONDS_PER_DAY).secondsSince(begin),
    },
  ];
  if (dayCount > 2) {
    groups.push({ firstDay: 1, days: dayCount - 2, seconds: SECONDS_PER_DAY });
  }
  groups.push({
    firstDay: dayCount - 1,
    days: 1,
    seconds: end.secondsSince(lastMidnight),
  });
  return { intervalSeconds, firstMidnight, dayCount, groups };
}

/**
 * Splits a report interval into calendar-day buckets
 * (`_bucket_interval_by_day`), computing the day layout once for all of a
 * report's records.
 *
 * Python walks every day of the interval; a reporter-supplied `date_range`
 * can span thousands of years, so this works per group of days with the
 * same overlap (first day, full days, last day). Every day in a group gets
 * the same exact share, so floors, fractions and the largest-remainder
 * order (Python's stable `sorted(..., reverse=True)`: among equal
 * fractions, earlier days first) are computed per group, and only buckets
 * with a non-zero count are built. The result equals Python's.
 */
export class IntervalDays {
  readonly begin: PyDateTime;
  readonly end: PyDateTime;
  #layout: DayLayout | null = null;

  constructor(begin: PyDateTime, end: PyDateTime) {
    this.begin = begin;
    this.end = end;
  }

  /**
   * Distribute `totalCount` over the days, like Python, raising like it.
   * More than `maxBuckets` buckets raise `InvalidAggregateReport` before any
   * is built (not in parsedmarc).
   */
  buckets(
    totalCount: number | bigint,
    maxBuckets: number = Number.POSITIVE_INFINITY,
  ): DayBucket[] {
    const { begin, end } = this;
    if (begin.isNaive !== end.isNaive) {
      throw new PyTypeError(
        "can't compare offset-naive and offset-aware datetimes",
      );
    }
    if (begin.compare(end) > 0) {
      throw new PyValueError('begin must be earlier than end');
    }
    if (begin.isNaive) {
      throw new PyValueError('begin and end must be timezone-aware');
    }
    if (begin.utcOffsetMinutes !== end.utcOffsetMinutes) {
      throw new PyValueError('begin and end must have the same tzinfo');
    }
    if (totalCount < 0) {
      throw new PyValueError('total_count must be non-negative');
    }
    if (end.secondsSince(begin) <= 0 || totalCount === 0 || totalCount === 0n) {
      return [];
    }
    this.#layout ??= layoutDays(begin, end);
    return this.#distribute(this.#layout, totalCount, maxBuckets);
  }

  #distribute(
    layout: DayLayout,
    totalCount: number | bigint,
    maxBuckets: number,
  ): DayBucket[] {
    // `(seconds / interval) * total_count` converts the int to a float.
    const totalFloat = Number(totalCount);
    if (!Number.isFinite(totalFloat)) {
      throw new PyOverflowError('int too large to convert to float');
    }
    const shares = layout.groups.map(group => {
      const exact = (group.seconds / layout.intervalSeconds) * totalFloat;
      const floor = Math.trunc(exact);
      return { group, floor: BigInt(floor), fraction: exact - floor, plus: 0 };
    });
    let remainder = BigInt(totalCount);
    for (const share of shares) {
      remainder -= share.floor * BigInt(share.group.days);
    }
    // `indices_by_fraction[:remainder]`, including a negative slice end.
    const dayCount = BigInt(layout.dayCount);
    let extra =
      remainder >= 0n
        ? remainder < dayCount
          ? remainder
          : dayCount
        : dayCount + remainder > 0n
          ? dayCount + remainder
          : 0n;
    const byFraction = [...shares].sort(
      (a, b) => b.fraction - a.fraction || a.group.firstDay - b.group.firstDay,
    );
    for (const share of byFraction) {
      const days = BigInt(share.group.days);
      const given = extra < days ? extra : days;
      share.plus = Number(given);
      extra -= given;
    }

    // Each bucket holds a record: millions of days per <record> would fill
    // the heap, which ends the process instead of raising.
    let bucketCount = 0;
    for (const { group, floor, plus } of shares) {
      bucketCount += floor > 0n ? group.days : plus;
    }
    if (bucketCount > maxBuckets) {
      throw new InvalidAggregateReport(
        'Report needs too many records to normalize its timespan (max_normalized_records)',
      );
    }

    const buckets: DayBucket[] = [];
    for (const { group, floor, plus } of shares) {
      // Days that only get their floor share come after the `plus` ones.
      const lastDay =
        floor > 0n ? group.firstDay + group.days : group.firstDay + plus;
      for (let day = group.firstDay; day < lastDay; day += 1) {
        const count = floor + (day - group.firstDay < plus ? 1n : 0n);
        buckets.push({
          begin:
            day === 0
              ? this.begin
              : layout.firstMidnight.addSeconds(day * SECONDS_PER_DAY),
          end:
            day === layout.dayCount - 1
              ? this.end
              : layout.firstMidnight.addSeconds((day + 1) * SECONDS_PER_DAY),
          count: intValue(count),
        });
      }
    }
    return buckets;
  }
}

/**
 * Split [begin, end) into calendar-day buckets and distribute `totalCount`
 * across them in proportion to each day's overlap, using largest-remainder
 * rounding so the counts sum to `totalCount` (`_bucket_interval_by_day`).
 */
export function bucketIntervalByDay(
  begin: PyDateTime,
  end: PyDateTime,
  totalCount: number | bigint,
): DayBucket[] {
  return new IntervalDays(begin, end).buckets(totalCount);
}

const INTERVAL_FORMAT = '%Y-%m-%d %H:%M:%S';

/** A parsed record before its interval fields are added. */
type RecordWithoutInterval = Omit<
  AggregateRecord,
  'intervalBegin' | 'intervalEnd' | 'normalizedTimespan'
>;

/**
 * Characters of output that weigh as one record of `maxNormalizedRecords`.
 * An ordinary row stays within it: a record of the samples and the report
 * data its row repeats come to 1,550-1,910.
 */
const RECORD_WEIGHT_UNIT = 2048;

/**
 * What a report's normalized timespan may still expand to, in records of
 * ordinary size (`maxNormalizedRecords`; not in parsedmarc). Every day
 * bucket is a row of the CSV and a document of the search outputs, and
 * repeats its record's results and the report's data (reporter, errors,
 * published policy), so a record with thousands of `<dkim>` entries, or a
 * long `extra_contact_info`, weighs as many records as its rows take in the
 * output: the number of records alone doesn't bound the report.
 */
export class NormalizedRecordBudget {
  #left: number;
  readonly #reportSize: number;

  /**
   * @param reportSize Estimated characters of the report data each row
   *   repeats ({@link estimatedSize}).
   */
  constructor(maxRecords: number, reportSize = 0) {
    this.#left = maxRecords;
    this.#reportSize = reportSize;
  }

  /** The records of ordinary size a row of `record` weighs, at least one. */
  weigh(record: RecordWithoutInterval): number {
    return Math.max(
      1,
      (estimatedSize(record) + this.#reportSize) / RECORD_WEIGHT_UNIT,
    );
  }

  /** The buckets of a record of `weight` that still fit. */
  room(weight: number): number {
    return Math.max(Math.floor(this.#left / weight), 0);
  }

  spend(weight: number): void {
    this.#left -= weight;
  }
}

/**
 * Append a parsed record unchanged, or split into daily buckets when the
 * report's timespan needs normalizing (`_append_parsed_record`).
 */
export function appendParsedRecord(
  parsedRecord: RecordWithoutInterval,
  records: AggregateRecord[],
  beginDt: PyDateTime,
  endDt: PyDateTime,
  normalize: boolean,
  /** The report's day layout, shared by its records (built if omitted). */
  interval: IntervalDays = new IntervalDays(beginDt, endDt),
  /**
   * `maxNormalizedRecords`, for all the report's `records` (`0`: no limit),
   * or the report's {@link NormalizedRecordBudget}, which weighs records by
   * size.
   */
  maxRecords: number | NormalizedRecordBudget = 0,
): void {
  if (!normalize) {
    records.push({
      ...parsedRecord,
      normalizedTimespan: false,
      intervalBegin: beginDt.strftime(INTERVAL_FORMAT),
      intervalEnd: endDt.strftime(INTERVAL_FORMAT),
    });
    return;
  }
  const totalCount = pyIntExact(parsedRecord.count ?? 0);
  if (maxRecords instanceof NormalizedRecordBudget) {
    // Measured once per record: its buckets share the same objects.
    const weight = maxRecords.weigh(parsedRecord);
    const buckets = interval.buckets(totalCount, maxRecords.room(weight));
    maxRecords.spend(weight * buckets.length);
    pushBuckets(parsedRecord, records, buckets);
    return;
  }
  const room =
    maxRecords > 0
      ? Math.max(maxRecords - records.length, 0)
      : Number.POSITIVE_INFINITY;
  pushBuckets(parsedRecord, records, interval.buckets(totalCount, room));
}

function pushBuckets(
  parsedRecord: RecordWithoutInterval,
  records: AggregateRecord[],
  buckets: DayBucket[],
): void {
  for (const bucket of buckets) {
    records.push({
      ...parsedRecord,
      count: bucket.count,
      normalizedTimespan: true,
      intervalBegin: bucket.begin.strftime(INTERVAL_FORMAT),
      intervalEnd: bucket.end.strftime(INTERVAL_FORMAT),
    });
  }
}

/**
 * The RFC 9990 override-type warnings. Membership in Python's frozensets
 * hashes the value, so a dict or list `type` (`<type lang="en">`) raises
 * TypeError and the record is dropped, as in parsedmarc.
 */
function warnOverrideType(reasonType: unknown, isRfc9990: boolean): void {
  if (!isRfc9990) {
    return;
  }
  if (pyFrozensetContains(RFC_7489_REMOVED_POLICY_OVERRIDE_TYPES, reasonType)) {
    logger.warning(
      `Policy override reason type ${pyRepr(reasonType)} was removed in RFC 9990; expected one of ${SORTED_RFC_9990_OVERRIDE_TYPES}`,
    );
  } else if (
    reasonType !== null &&
    reasonType !== undefined &&
    !pyFrozensetContains(RFC_9990_POLICY_OVERRIDE_TYPES, reasonType)
  ) {
    logger.warning(
      `Unknown policy override reason type ${pyRepr(reasonType)} per RFC 9990; expected one of ${SORTED_RFC_9990_OVERRIDE_TYPES}`,
    );
  }
}

function parseDkimResults(
  results: unknown,
  isRfc9990: boolean,
): AggregateAuthResultDKIM[] {
  const parsed: AggregateAuthResultDKIM[] = [];
  for (const result of pyIter(results)) {
    if (!(pyContains(result, 'domain') && getItem(result, 'domain') !== null)) {
      continue;
    }
    const domain = getItem(result, 'domain');
    let selector: unknown = 'none';
    if (
      pyContains(result, 'selector') &&
      getItem(result, 'selector') !== null
    ) {
      selector = getItem(result, 'selector');
    } else if (isRfc9990) {
      logger.warning(
        `DKIM auth result for ${pyRepr(domain)} is missing the 'selector' element, which is REQUIRED by RFC 9990`,
      );
    }
    let outcome: unknown = 'none';
    if (pyContains(result, 'result') && getItem(result, 'result') !== null) {
      outcome = normalizeResultWord(getItem(result, 'result'));
    }
    parsed.push({
      domain: markRaw(domain),
      selector: markRaw(selector),
      result: markRaw(outcome),
      humanResult: markRaw(unwrapText(getOptional(result, 'human_result'))),
    } as AggregateAuthResultDKIM);
  }
  return parsed;
}

function parseSpfResults(results: unknown): AggregateAuthResultSPF[] {
  const parsed: AggregateAuthResultSPF[] = [];
  for (const result of pyIter(results)) {
    if (!(pyContains(result, 'domain') && getItem(result, 'domain') !== null)) {
      continue;
    }
    let scope: unknown = 'mfrom';
    if (pyContains(result, 'scope') && getItem(result, 'scope') !== null) {
      scope = getItem(result, 'scope');
    }
    let outcome: unknown = 'none';
    if (pyContains(result, 'result') && getItem(result, 'result') !== null) {
      outcome = normalizeResultWord(getItem(result, 'result'));
    }
    parsed.push({
      domain: markRaw(getItem(result, 'domain')),
      scope: markRaw(scope),
      result: markRaw(outcome),
      humanResult: markRaw(unwrapText(getOptional(result, 'human_result'))),
    } as AggregateAuthResultSPF);
  }
  return parsed;
}

/** parsedmarc's identifier keys and their camelCase names. */
const IDENTIFIER_FIELDS: ReadonlyMap<string, string> = new Map([
  ['header_from', 'headerFrom'],
  ['envelope_from', 'envelopeFrom'],
  ['envelope_to', 'envelopeTo'],
]);

/**
 * The record's identifiers: parsedmarc keeps every child of the reporter's
 * `<identifiers>`, so keys it doesn't know stay as the reporter wrote them.
 */
function identifiersObject(
  identifiers: PyDict,
): AggregateRecord['identifiers'] {
  return mixedObject(
    Object.entries(identifiers).map(([key, value]) => {
      const camelKey = IDENTIFIER_FIELDS.get(key);
      return camelKey === undefined
        ? { key, value, raw: true }
        : { key: camelKey, value: markRaw(value), raw: false };
    }),
  ) as unknown as AggregateRecord['identifiers'];
}

/**
 * Convert one `<record>` into parsedmarc's consistent shape, enriching the
 * source IP (`_parse_report_record`).
 */
export async function parseReportRecord(
  record: unknown,
  config: ParserConfig,
  isRfc9990 = false,
  lookupBudget: ReportLookupBudget | null = null,
): Promise<RecordWithoutInterval> {
  // Python starts with `record = record.copy()`, so a record that is not a
  // dict (`<record>text</record>`, `<record/>`) fails with AttributeError.
  const row = getItem(dictCopy(record), 'row');
  const sourceIp = getItem(row, 'source_ip');
  if (sourceIp === null) {
    throw new PyValueError('Source IP address is empty');
  }
  if (typeof sourceIp !== 'string') {
    throw noAttribute(sourceIp, 'lower');
  }
  const source = await getIpAddressInfo(sourceIp, { config, lookupBudget });
  const count = pyIntExact(getItem(row, 'count'));

  const policyEvaluated = dictCopy(getItem(row, 'policy_evaluated'));
  let disposition: unknown = 'none';
  let dkim: unknown = 'fail';
  let spf: unknown = 'fail';
  if (pyContains(policyEvaluated, 'disposition')) {
    disposition = normalizeResultWord(getItem(policyEvaluated, 'disposition'));
  }
  if (pyContains(policyEvaluated, 'dkim')) {
    dkim = normalizeResultWord(getItem(policyEvaluated, 'dkim'));
  }
  if (pyContains(policyEvaluated, 'spf')) {
    spf = normalizeResultWord(getItem(policyEvaluated, 'spf'));
  }
  const rawSpf = getItem(policyEvaluated, 'spf');
  const spfAligned = rawSpf !== null && pyLower(rawSpf) === 'pass';
  const rawDkim = getItem(policyEvaluated, 'dkim');
  const dkimAligned = rawDkim !== null && pyLower(rawDkim) === 'pass';

  let reasons: unknown[] = [];
  if (pyContains(policyEvaluated, 'reason')) {
    const reason = getItem(policyEvaluated, 'reason');
    reasons = Array.isArray(reason) ? reason : [reason];
  }
  for (const reason of reasons) {
    // Python updates the reporter's dict in place and keeps it, so the
    // reason stays raw data (other children included).
    const comment = unwrapText(getOptional(reason, 'comment'));
    setOwn(reason as PyDict, 'comment', comment);
    warnOverrideType(getOptional(reason, 'type'), isRfc9990);
  }

  const identifiers = dictCopy(
    pyContains(record, 'identities')
      ? getItem(record, 'identities')
      : getItem(record, 'identifiers'),
  );
  const headerFrom = getItem(identifiers, 'header_from');
  identifiers.header_from =
    typeof headerFrom === 'string' ? headerFrom.toLowerCase() : '';

  const rawAuthResults = getItem(record, 'auth_results');
  let authResults: PyDict;
  if (isDict(rawAuthResults)) {
    authResults = { ...rawAuthResults };
    if (!pyContains(authResults, 'spf')) {
      authResults.spf = [];
    }
    if (!pyContains(authResults, 'dkim')) {
      authResults.dkim = [];
    }
  } else {
    authResults = { dkim: [], spf: [] };
  }
  if (!Array.isArray(authResults.dkim)) {
    authResults.dkim = [authResults.dkim];
  }
  const dkimResults = parseDkimResults(authResults.dkim, isRfc9990);
  if (!Array.isArray(authResults.spf)) {
    authResults.spf = [authResults.spf];
  }
  const spfResults = parseSpfResults(authResults.spf);

  // Backfill envelope_from from the last SPF result's domain when the
  // reporter omitted it or sent it empty.
  if (
    getOptional(identifiers, 'envelope_from') === null ||
    getOptional(identifiers, 'envelope_from') === undefined
  ) {
    let envelopeFrom: unknown = null;
    const spfList = authResults.spf as unknown[];
    if (spfList.length > 0) {
      const spfResult = spfList.at(-1);
      if (pyContains(spfResult, 'domain')) {
        envelopeFrom = getItem(spfResult, 'domain');
      }
    }
    if (envelopeFrom !== null) {
      envelopeFrom = str(envelopeFrom).toLowerCase();
    }
    identifiers.envelope_from = envelopeFrom;
  }
  let envelopeTo: unknown = null;
  if (pyContains(identifiers, 'envelope_to')) {
    envelopeTo = identifiers.envelope_to;
    delete identifiers.envelope_to;
  }
  identifiers.envelope_to = envelopeTo;

  return {
    source,
    count,
    alignment: {
      spf: spfAligned,
      dkim: dkimAligned,
      dmarc: spfAligned || dkimAligned,
    },
    policyEvaluated: {
      disposition: markRaw(disposition),
      dkim: markRaw(dkim),
      spf: markRaw(spf),
      policyOverrideReasons: reasons.map(reason =>
        markRaw(reason),
      ) as AggregatePolicyOverrideReason[],
    } as AggregateRecord['policyEvaluated'],
    identifiers: identifiersObject(identifiers),
    authResults: { dkim: dkimResults, spf: spfResults },
  } as RecordWithoutInterval;
}

export interface ParseAggregateReportOptions extends ParserConfigInput {
  /** DNS timeout in seconds (parsedmarc's `timeout`); same as `dnsTimeout`. */
  timeout?: number;
  /** DNS retries (parsedmarc's `retries`); same as `dnsRetries`. */
  retries?: number;
  /** Called every 20 records of large reports (not part of `config`). */
  keepAlive?: (() => unknown) | null;
}

function configFrom(options: ParseAggregateReportOptions): ParserConfig {
  const { timeout, retries, keepAlive: _keepAlive, ...rest } = options;
  return resolveParserConfig({
    ...rest,
    ...(timeout === undefined ? {} : { dnsTimeout: timeout }),
    ...(retries === undefined ? {} : { dnsRetries: retries }),
  });
}

function optionalPolicyField(policy: unknown, key: string): unknown {
  return pyContains(policy, key) && getItem(policy, key) !== null
    ? getItem(policy, key)
    : null;
}

/** The range of C `time_t` (int64) and of glibc's `int tm_year`. */
const TIME_T_MIN = -(2n ** 63n);
const TIME_T_MAX = 2n ** 63n - 1n;
const TM_YEAR_MAX = 2n ** 31n - 1n + 1900n;
const TM_YEAR_MIN = -(2n ** 31n) + 1900n;
const MAX_JS_DATE_SECONDS = 8_640_000_000_000;
const SECONDS_PER_400_YEARS = 12_622_780_800n;
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

/** The proleptic Gregorian year of a UTC timestamp, for any integer. */
function utcYear(timestamp: bigint): bigint {
  // Shift into JS Date's range by whole 400-year cycles (146097 days each).
  const cycles = timestamp / SECONDS_PER_400_YEARS;
  const rest = Number(timestamp - cycles * SECONDS_PER_400_YEARS);
  return BigInt(new Date(rest * 1000).getUTCFullYear()) + cycles * 400n;
}

/**
 * `timestamp_to_human()` with the errors Python's
 * `datetime.fromtimestamp()` raises for timestamps out of range: beyond
 * `time_t` or a year glibc's `localtime()` can't hold → OverflowError,
 * otherwise outside years 1-9999 → ValueError.
 */
function checkedTimestampToHuman(timestamp: number | bigint): string {
  const exact = BigInt(timestamp);
  if (exact < TIME_T_MIN || exact > TIME_T_MAX) {
    throw new PyOverflowError('timestamp out of range for platform time_t');
  }
  if (Math.abs(Number(exact)) < MAX_JS_DATE_SECONDS) {
    const year = new Date(Number(exact) * 1000).getFullYear();
    if (year < MIN_YEAR || year > MAX_YEAR) {
      throw new PyValueError(`year must be in 1..9999, not ${year}`);
    }
    return timestampToHuman(Number(exact));
  }
  // Far outside JS Date's range the year is taken in UTC; Python's local
  // year differs only within the UTC offset of New Year.
  const year = utcYear(exact);
  if (year > TM_YEAR_MAX || year < TM_YEAR_MIN) {
    throw new PyOverflowError('timestamp out of range for platform time_t');
  }
  throw new PyValueError(`year must be in 1..9999, not ${year}`);
}

function xmlLimits(config: ParserConfig): ParseXmlOptions {
  return { maxDepth: config.maxXmlDepth, maxNodes: config.maxXmlNodes };
}

async function buildReport(
  xmlText: string,
  xmlNamespace: string | null,
  initialErrors: string[],
  config: ParserConfig,
  keepAlive: (() => unknown) | null,
): Promise<AggregateReport> {
  let errors = initialErrors;
  let xml = xmlText.replace(XML_HEADER, '<?xml version="1.0"?>');
  xml = xml.replace(XML_SCHEMA, '');

  // The statements below follow parse_aggregate_report_xml's order, so the
  // first missing or malformed field raises the same error as in Python.
  const report = getItem(parseXmlToDict(xml, xmlLimits(config)), 'feedback');
  const reportMetadata = getItem(report, 'report_metadata') as PyDict;
  // <email> may carry attributes (xml:lang), which make it a dict.
  if (isDict(getOptional(reportMetadata, 'email'))) {
    const unwrapped = unwrapText(reportMetadata.email);
    // Python's logger.debug("%r", ...) formats only when DEBUG is enabled.
    if (unwrapped === null && logger.isEnabledFor(DEBUG)) {
      logger.debug(
        `Discarding malformed <email> in report_metadata: ${pyRepr(reportMetadata.email)}`,
      );
    }
    setOwn(reportMetadata, 'email', unwrapped);
  }
  const schema = pyContains(report, 'version')
    ? getItem(report, 'version')
    : 'draft';

  if (getItem(reportMetadata, 'org_name') === null) {
    const email = getItem(reportMetadata, 'email');
    if (email !== null) {
      setOwn(reportMetadata, 'org_name', pySplit(email, '@').at(-1));
    }
  }
  let orgName = getItem(reportMetadata, 'org_name');
  if (orgName !== null && !pyContains(orgName, ' ')) {
    if (typeof orgName !== 'string') {
      throw noAttribute(orgName, 'lower');
    }
    const baseDomain = getBaseDomain(orgName);
    if (baseDomain !== null) {
      orgName = baseDomain;
    }
  }
  if (!pyTruthy(orgName)) {
    logger.debug(`Could not parse org_name from XML.\r\n${pyRepr(report)}`);
    throw new KeyError(
      'Organization name is missing. This field is a requirement for saving the report',
    );
  }
  const orgEmail = getItem(reportMetadata, 'email');
  const orgExtraContactInfo = unwrapText(
    getOptional(reportMetadata, 'extra_contact_info'),
  );
  const rawReportId = getItem(reportMetadata, 'report_id');
  if (typeof rawReportId !== 'string') {
    throw noAttribute(rawReportId, 'replace');
  }
  const reportId = rawReportId
    .replaceAll('<', '')
    .replaceAll('>', '')
    .split('@')[0] as string;

  const dateRange = getItem(reportMetadata, 'date_range');
  const beginTs = pyIntExact(pySplit(getItem(dateRange, 'begin'), '.')[0]);
  const endTs = pyIntExact(pySplit(getItem(dateRange, 'end'), '.')[0]);
  const spanSeconds = intValue(BigInt(endTs) - BigInt(beginTs));
  const normalizeTimespan =
    Number(spanSeconds) > config.normalizeTimespanThresholdHours * 3600;
  const beginDate = checkedTimestampToHuman(beginTs);
  const endDate = checkedTimestampToHuman(endTs);
  const beginDt = humanTimestampToDatetime(beginDate, { toUtc: true });
  const endDt = humanTimestampToDatetime(endDate, { toUtc: true });

  // <error> is a single langAttrString in RFC 9990 but may repeat in
  // RFC 7489 reports. When present it replaces the parse errors so far.
  if (pyContains(reportMetadata, 'error')) {
    const rawErrors = reportMetadata.error;
    const list = Array.isArray(rawErrors) ? rawErrors : [rawErrors];
    errors = list
      .map(error => markRaw(unwrapText(error)))
      .filter(text => pyTruthy(text)) as string[];
  }
  const generator = unwrapText(getOptional(reportMetadata, 'generator'));

  const newReportMetadata = {
    orgName: markRaw(orgName),
    orgEmail: markRaw(orgEmail),
    orgExtraContactInfo: markRaw(orgExtraContactInfo),
    reportId,
    beginDate,
    endDate,
    timespanRequiresNormalization: normalizeTimespan,
    originalTimespanSeconds: spanSeconds,
    errors,
    generator: markRaw(generator),
  } as AggregateReportMetadata;

  let policyPublished = getItem(report, 'policy_published');
  if (Array.isArray(policyPublished)) {
    if (policyPublished.length === 0) {
      throw new PyIndexError('list index out of range');
    }
    policyPublished = policyPublished[0];
  }
  const isRfc9990 =
    xmlNamespace === RFC_9990_NAMESPACE ||
    pyContains(reportMetadata, 'generator') ||
    RFC_9990_ONLY_POLICY_FIELDS.some(field =>
      pyContains(policyPublished, field),
    );

  const domain = getItem(policyPublished, 'domain');
  const adkim = optionalPolicyField(policyPublished, 'adkim') ?? 'r';
  const aspf = optionalPolicyField(policyPublished, 'aspf') ?? 'r';
  const p = getItem(policyPublished, 'p');
  const sp = optionalPolicyField(policyPublished, 'sp') ?? p;
  const pct = optionalPolicyField(policyPublished, 'pct');
  const fo = optionalPolicyField(policyPublished, 'fo');
  const np = optionalPolicyField(policyPublished, 'np');
  if (np !== null && !['none', 'quarantine', 'reject'].includes(np as string)) {
    logger.warning(`Invalid np value: ${sanitizeForLog(str(np))}`);
  }
  const testing = optionalPolicyField(policyPublished, 'testing');
  if (testing !== null && !['n', 'y'].includes(testing as string)) {
    logger.warning(`Invalid testing value: ${sanitizeForLog(str(testing))}`);
  }
  const discoveryMethod = optionalPolicyField(
    policyPublished,
    'discovery_method',
  );
  if (
    discoveryMethod !== null &&
    !['psl', 'treewalk'].includes(discoveryMethod as string)
  ) {
    logger.warning(
      `Invalid discovery_method value: ${sanitizeForLog(str(discoveryMethod))}`,
    );
  }
  const newPolicyPublished = {
    domain: markRaw(domain),
    adkim: markRaw(adkim),
    aspf: markRaw(aspf),
    p: markRaw(p),
    sp: markRaw(sp),
    pct: markRaw(pct),
    fo: markRaw(fo),
    np: markRaw(np),
    testing: markRaw(testing),
    discoveryMethod: markRaw(discoveryMethod),
  } as AggregatePolicyPublished;
  const interval = new IntervalDays(beginDt, endDt);
  // Measured once: every row of the report repeats the same objects.
  const recordBudget =
    normalizeTimespan && config.maxNormalizedRecords > 0
      ? new NormalizedRecordBudget(
          config.maxNormalizedRecords,
          estimatedSize([
            schema,
            xmlNamespace,
            newReportMetadata,
            newPolicyPublished,
          ]),
        )
      : 0;

  const records: AggregateRecord[] = [];
  const reportRecords = getItem(report, 'record');
  if (Array.isArray(reportRecords)) {
    const lookupBudget = new ReportLookupBudget(config);
    for (let index = 0; index < reportRecords.length; index += 1) {
      if (keepAlive !== null && index > 0 && index % 20 === 0) {
        logger.debug('Sending keepalive cmd');
        await keepAlive();
        logger.debug(`Processed ${index}/${reportRecords.length}`);
      }
      try {
        const parsed = await parseReportRecord(
          reportRecords[index],
          config,
          isRfc9990,
          lookupBudget,
        );
        appendParsedRecord(
          parsed,
          records,
          beginDt,
          endDt,
          normalizeTimespan,
          interval,
          recordBudget,
        );
      } catch (error) {
        // Not this record's fault: every other one would fail too, leaving
        // an empty report that looks parsed. Nor is a report over the limit
        // of normalized records valid without the record that crossed it.
        if (
          error instanceof EnrichmentError ||
          error instanceof InvalidAggregateReport
        ) {
          throw error;
        }
        logger.warning(
          `Could not parse record: ${sanitizeForLog(errorText(error))}`,
        );
      }
    }
  } else {
    const parsed = await parseReportRecord(reportRecords, config, isRfc9990);
    appendParsedRecord(
      parsed,
      records,
      beginDt,
      endDt,
      normalizeTimespan,
      interval,
      recordBudget,
    );
  }

  return {
    xmlSchema: markRaw(schema),
    xmlNamespace,
    reportMetadata: newReportMetadata,
    policyPublished: newPolicyPublished,
    records,
  } as AggregateReport;
}

/**
 * Run `parse` with a keepalive hook whose failures reach the caller as
 * thrown. They say nothing about the report, but the error handling around
 * a parse makes a report error of whatever it catches (as in parsedmarc,
 * where a dropped connection invalidates the report), so `parse`'s outcome
 * is overridden by the failure. Nests: an outer call sees it too.
 */
export async function withKeepAlive<T>(
  keepAlive: (() => unknown) | null,
  parse: (keepAlive: (() => unknown) | null) => Promise<T>,
): Promise<T> {
  if (keepAlive === null) {
    return parse(null);
  }
  const interrupted: { by: { error: unknown } | null } = { by: null };
  const tracked = async (): Promise<void> => {
    try {
      await keepAlive();
    } catch (error) {
      interrupted.by = { error };
      throw error;
    }
  };
  let result: T;
  try {
    result = await parse(tracked);
  } catch (error) {
    throw interrupted.by === null ? error : interrupted.by.error;
  }
  if (interrupted.by !== null) {
    throw interrupted.by.error;
  }
  return result;
}

/**
 * Parse a DMARC aggregate report's XML. Malformed XML is recovered the way
 * parsedmarc does (with the parse error kept in `reportMetadata.errors`).
 * An error thrown by `keepAlive` is rethrown as is.
 */
export async function parseAggregateReportXml(
  xml: string | Uint8Array,
  options: ParseAggregateReportOptions = {},
): Promise<AggregateReport> {
  const config = configFrom(options);
  return withKeepAlive(options.keepAlive ?? null, async keepAlive =>
    parseAggregateXml(xml, config, keepAlive),
  );
}

async function parseAggregateXml(
  xml: string | Uint8Array,
  config: ParserConfig,
  keepAlive: (() => unknown) | null,
): Promise<AggregateReport> {
  let text = typeof xml === 'string' ? xml : decodeUtf8(xml, 'ignore');

  // Detect the namespace before any rewriting strips it.
  const xmlNamespace = XML_NAMESPACE.exec(text)?.[1] ?? null;

  const errors: string[] = [];
  try {
    getItem(parseXmlToDict(text, xmlLimits(config)), 'feedback');
  } catch (error) {
    if (error instanceof XmlDoctypeFound) {
      throw new InvalidAggregateReport(DOCTYPE_ERROR, { cause: error });
    }
    if (error instanceof XmlLimitError) {
      throw new InvalidAggregateReport(`Invalid XML: ${error.message}`, {
        cause: error,
      });
    }
    errors.push(`Invalid XML: ${errorText(error)}`);
    let hasDoctype = false;
    try {
      // The first parse can fail before Expat reaches a DOCTYPE (e.g. on a
      // malformed XML declaration), so the recovered tree gets the same
      // check; only its root element is parsed again.
      ({ hasDoctype, xml: text } = recoverXml(text));
    } catch {
      // parsedmarc: `except Exception: xml = "<a/>"`.
      text = '<a/>';
    }
    if (hasDoctype) {
      throw new InvalidAggregateReport(DOCTYPE_ERROR, { cause: error });
    }
  }

  let report: AggregateReport;
  try {
    report = await buildReport(text, xmlNamespace, errors, config, keepAlive);
  } catch (error) {
    if (error instanceof InvalidAggregateReport) {
      throw error;
    }
    if (error instanceof ExpatError || error instanceof XmlLimitError) {
      throw new InvalidAggregateReport(`Invalid XML: ${errorText(error)}`, {
        cause: error,
      });
    }
    if (error instanceof KeyError) {
      throw new InvalidAggregateReport(`Missing field: ${error.message}`, {
        cause: error,
      });
    }
    if (error instanceof PyAttributeError) {
      throw new InvalidAggregateReport('Report missing required section', {
        cause: error,
      });
    }
    throw new InvalidAggregateReport(
      `Unexpected error: ${errorText(error)}${excOrigin(error)}`,
      { cause: error },
    );
  }
  if (nestsDeeperThan(report, MAX_REPORT_DEPTH)) {
    throw new InvalidAggregateReport(
      `Invalid XML: report data nested more than ${MAX_REPORT_DEPTH} levels deep`,
    );
  }
  return report;
}

export interface ParseAggregateReportFileOptions
  extends ParserConfigInput, ExtractOptions {
  keepAlive?: (() => unknown) | null;
}

/**
 * Parse an aggregate report from bytes (zip, gzip or XML) or base64 text
 * (`parse_aggregate_report_file`). Like Python, a string goes to
 * `extractReport()` as base64, or as the XML itself when it is not valid
 * base64; it is never opened as a path (see
 * {@link parseAggregateReportFromFilePath}).
 */
export async function parseAggregateReportFile(
  input: string | Uint8Array,
  options: ParseAggregateReportFileOptions = {},
): Promise<AggregateReport> {
  return parseExtracted(
    async extractOptions => extractReport(input, extractOptions),
    options,
  );
}

/**
 * Parse an aggregate report file from disk (`extract_report_from_file_path`
 * followed by `parse_aggregate_report_xml`). parsedmarc's
 * `parse_aggregate_report_file()` documents a path argument but treats a
 * string as report content; this is the path form.
 */
export async function parseAggregateReportFromFilePath(
  filePath: string,
  options: ParseAggregateReportFileOptions = {},
): Promise<AggregateReport> {
  return parseExtracted(
    extractOptions => extractReportFromFilePath(filePath, extractOptions),
    options,
  );
}

async function parseExtracted(
  extract: (options: ExtractOptions) => Promise<string>,
  options: ParseAggregateReportFileOptions,
): Promise<AggregateReport> {
  const { keepAlive, maxDecompressedSize, ...configOptions } = options;
  const config = resolveParserConfig(configOptions);
  let xml: string;
  try {
    xml = await extract({ maxDecompressedSize });
  } catch (error) {
    throw new InvalidAggregateReport(errorText(error) + excOrigin(error), {
      cause: error,
    });
  }
  return parseAggregateReportXml(xml, { config, keepAlive: keepAlive ?? null });
}

/** Fields of `parsedAggregateReportsToCsv()`, in column order. */
export const AGGREGATE_CSV_FIELDS: readonly string[] = [
  'xml_schema',
  'org_name',
  'org_email',
  'org_extra_contact_info',
  'report_id',
  'begin_date',
  'end_date',
  'normalized_timespan',
  'errors',
  'domain',
  'adkim',
  'aspf',
  'p',
  'sp',
  'np',
  'pct',
  'fo',
  'testing',
  'discovery_method',
  'source_ip_address',
  'source_country',
  'source_reverse_dns',
  'source_base_domain',
  'source_name',
  'source_type',
  'source_asn',
  'source_as_name',
  'source_as_domain',
  'count',
  'spf_aligned',
  'dkim_aligned',
  'dmarc_aligned',
  'disposition',
  'policy_override_reasons',
  'policy_override_comments',
  'envelope_from',
  'header_from',
  'envelope_to',
  'dkim_domains',
  'dkim_selectors',
  'dkim_results',
  'spf_domains',
  'spf_scopes',
  'spf_results',
];

const lowerStr = (value: unknown): string => str(value).toLowerCase();
/**
 * A `<reason>` field for a CSV row: `value or "none"`, as text. `<reason>`
 * stays the reporter's raw data, so `<type>` can be missing or carry
 * attributes and `<comment>` can repeat. parsedmarc raises KeyError or
 * TypeError there, after the report was accepted, and loses the batch.
 */
function reasonText(reason: unknown, field: string): string {
  const value = unwrapText(getOptional(reason, field));
  if (!pyTruthy(value)) {
    return 'none';
  }
  return Array.isArray(value) ? pyRepr(value) : str(value);
}

/** Keep only values Python's CSV rows keep (str, int, bool); others become "". */
function csvValue(value: unknown): unknown {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isInteger(value))
  ) {
    return value;
  }
  return '';
}

/**
 * Flatten aggregate reports into CSV rows (snake_case keys), one per
 * record (`parsed_aggregate_reports_to_csv_rows`).
 */
export function parsedAggregateReportsToCsvRows(
  reports: AggregateReport | AggregateReport[],
): CsvRow[] {
  const reportList = Array.isArray(reports) ? reports : [reports];
  const rows: CsvRow[] = [];
  for (const report of reportList) {
    const metadata = report.reportMetadata;
    const policy = report.policyPublished;
    const reportFields: CsvRow = {
      xml_schema: report.xmlSchema,
      org_name: metadata.orgName,
      org_email: metadata.orgEmail,
      org_extra_contact_info: metadata.orgExtraContactInfo,
      report_id: metadata.reportId,
      begin_date: metadata.beginDate,
      end_date: metadata.endDate,
      normalized_timespan: metadata.timespanRequiresNormalization,
      errors: pyStrJoin('|', metadata.errors),
      domain: policy.domain,
      adkim: policy.adkim,
      aspf: policy.aspf,
      p: policy.p,
      sp: policy.sp,
      np: policy.np ?? null,
      pct: policy.pct,
      fo: policy.fo,
      testing: policy.testing ?? null,
      discovery_method: policy.discoveryMethod ?? null,
    };
    for (const record of report.records) {
      const reasons = record.policyEvaluated.policyOverrideReasons;
      rows.push({
        ...reportFields,
        begin_date: record.intervalBegin,
        end_date: record.intervalEnd,
        source_ip_address: record.source.ipAddress,
        source_country: record.source.country,
        source_reverse_dns: record.source.reverseDns,
        source_base_domain: record.source.baseDomain,
        source_name: record.source.name,
        source_type: record.source.type,
        source_asn: record.source.asn,
        source_as_name: record.source.asName,
        source_as_domain: record.source.asDomain,
        count: record.count,
        spf_aligned: record.alignment.spf,
        dkim_aligned: record.alignment.dkim,
        dmarc_aligned: record.alignment.dmarc,
        disposition: record.policyEvaluated.disposition,
        policy_override_reasons: reasons
          .map(r => reasonText(r, 'type'))
          .join(','),
        policy_override_comments: reasons
          .map(r => reasonText(r, 'comment'))
          .join('|'),
        envelope_from: record.identifiers.envelopeFrom,
        header_from: record.identifiers.headerFrom,
        envelope_to: record.identifiers.envelopeTo,
        dkim_domains: record.authResults.dkim
          .map(r => lowerStr(r.domain))
          .join(','),
        dkim_selectors: record.authResults.dkim
          .filter(r => 'selector' in r)
          .map(r => lowerStr(r.selector))
          .join(','),
        dkim_results: record.authResults.dkim
          .map(r => lowerStr(r.result))
          .join(','),
        spf_domains: record.authResults.spf
          .map(r => lowerStr(r.domain))
          .join(','),
        spf_scopes: record.authResults.spf
          .map(r => lowerStr(r.scope))
          .join(','),
        spf_results: record.authResults.spf
          .map(r => lowerStr(r.result))
          .join(','),
      });
    }
  }
  return rows.map(row =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, csvValue(value)]),
    ),
  );
}

/** Aggregate reports as flat CSV, with headers. */
export function parsedAggregateReportsToCsv(
  reports: AggregateReport | AggregateReport[],
  options: CsvOptions = {},
): string {
  const rows = parsedAggregateReportsToCsvRows(reports).map(row =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, csvSafe(value)]),
    ),
  );
  return rowsToCsv(AGGREGATE_CSV_FIELDS, rows, options);
}
