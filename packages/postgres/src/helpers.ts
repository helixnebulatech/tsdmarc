// Value helpers of parsedmarc/postgres.py (`_ensure_utc_suffix`, ...).
//
// Two timestamp conventions coexist in parsed reports, so two helpers are
// needed; do not collapse them into one. Aggregate *report* begin/end dates
// come from `timestampToHuman()`, which is **local** naive time, so they go
// through `naiveLocalToTimestamptz()`. Aggregate *record* interval_begin/end
// and SMTP TLS begin/end are already **UTC** naive strings, so they only need
// a `+00` suffix via `ensureUtcSuffix()`. Using the wrong helper silently
// shifts timestamps.

import { isIP } from 'node:net';

import {
  humanTimestampToDatetime,
  logger,
  PyDateTime,
  pyStr,
  sanitizeForLog,
} from 'tsdmarc';

// `datetime.strptime(value, "%Y-%m-%d %H:%M:%S")`: %Y takes 4 digits, the
// other fields 1 or 2.
const NAIVE_TIMESTAMP =
  /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/u;
const DATE_PART_LENGTH = 10;
/** ISO 8601 as PostgreSQL reads it; its offsets stop at 15:59. */
const POSTGRES_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-](?:0\d|1[0-5])(?::?\d{2})?)?$/u;
const INT4_MAX = 2_147_483_647;
const INT4_MIN = -2_147_483_648;
const INET_NETMASK = /^(?<address>[^/]+)\/(?<bits>\d{1,3})$/u;
const IPV4_BITS = 32;
const IPV6_BITS = 128;

/** What stands for a NUL, which PostgreSQL rejects in `text` and `jsonb`. */
const NUL_REPLACEMENT = '\uFFFD';
const JSON_ESCAPE = /\\(?:u0000|[\s\S])/gu;

/** `value`, as PostgreSQL's text types can hold it. */
export function withoutNul<T>(value: T): T | string {
  return typeof value === 'string'
    ? value.replaceAll('\u0000', NUL_REPLACEMENT)
    : value;
}

/**
 * JSON text with its `\u0000` escapes replaced, which `jsonb` rejects. Every
 * escape is read whole, so `\\u0000` (a backslash and `u0000`) stays.
 */
export function jsonWithoutNul(text: string): string {
  return text.replace(JSON_ESCAPE, escape =>
    escape === String.raw`\u0000` ? NUL_REPLACEMENT : escape,
  );
}

/**
 * Append `+00` to a timestamp string if it lacks timezone info.
 *
 * Several parsers produce `YYYY-MM-DD HH:MM:SS` strings that are known to
 * be UTC but lack an explicit offset. PostgreSQL `TIMESTAMPTZ` columns need
 * the offset to avoid interpreting the value in the session timezone.
 */
export function ensureUtcSuffix<T extends string | null | undefined>(
  value: T,
): T | string {
  if (
    value &&
    typeof value === 'string' &&
    !value.includes('+') &&
    !value.slice(DATE_PART_LENGTH).includes('-') &&
    !value.includes('Z')
  ) {
    return `${value}+00`;
  }
  return value;
}

/**
 * A report's date-time for a `TIMESTAMPTZ` column. dateutil, which validates
 * these at parsing time, reads forms PostgreSQL refuses (`12`, offsets past
 * 15:59), which would fail the whole batch: those are sent in UTC. Forms
 * PostgreSQL reads go through {@link ensureUtcSuffix} unchanged; like there,
 * a value with no offset is UTC. Unparseable ones are left to PostgreSQL.
 */
export function normalizeTimestamp<T extends string | null | undefined>(
  value: T,
): T | string {
  if (!value || typeof value !== 'string' || POSTGRES_TIMESTAMP.test(value)) {
    return ensureUtcSuffix(value);
  }
  try {
    const datetime = humanTimestampToDatetime(value, {
      assumeUtc: true,
      toUtc: true,
    });
    return `${datetime.strftime('%Y-%m-%d %H:%M:%S')}+00`;
  } catch {
    return ensureUtcSuffix(value);
  }
}

/** Whether PostgreSQL's `INET` reads `value`: an address, maybe with a netmask. */
function isInet(value: string): boolean {
  const netmask = INET_NETMASK.exec(value)?.groups;
  const address = netmask?.address ?? value;
  // Node accepts an IPv6 zone (`fe80::1%eth0`); INET doesn't.
  const family = address.includes('%') ? 0 : isIP(address);
  if (family === 0) {
    return false;
  }
  const maxBits = family === 4 ? IPV4_BITS : IPV6_BITS;
  return netmask === undefined || Number(netmask.bits) <= maxBits;
}

/**
 * A reporter's IP for an `INET` column, or `null` with a warning when
 * PostgreSQL would refuse it: SMTP TLS reports carry these unvalidated, and
 * one bad value would fail the whole batch.
 */
export function inetOrNull(value: unknown, column: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && isInet(value)) {
    return value;
  }
  logger.warning(
    `PostgreSQL: storing NULL in ${column}: ${sanitizeForLog(pyStr(value))} is not an IP address`,
  );
  return null;
}

/**
 * A reporter's count for an `INTEGER` column, clamped with a warning: a value
 * past its range would fail the whole batch (reports keep exact big integers,
 * and the other outputs still get them).
 */
export function int4<T>(value: T, column: string): T | number {
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    return value;
  }
  if (value >= INT4_MIN && value <= INT4_MAX) {
    return value;
  }
  const clamped = value > INT4_MAX ? INT4_MAX : INT4_MIN;
  logger.warning(
    `PostgreSQL: storing ${clamped} in ${column}: ${value} is out of range`,
  );
  return clamped;
}

/**
 * Convert a naive local-time `YYYY-MM-DD HH:MM:SS` string to ISO 8601 with
 * the local UTC offset, so PostgreSQL does not read it in the session
 * timezone.
 *
 * @throws {RangeError} If `value` doesn't match the format (Python's
 *   `ValueError` from `strptime`).
 */
export function naiveLocalToTimestamptz<T extends string | null | undefined>(
  value: T,
): T | string {
  if (!value) {
    return value;
  }
  const match = NAIVE_TIMESTAMP.exec(value);
  if (!match) {
    throw new RangeError(
      `time data '${value}' does not match format '%Y-%m-%d %H:%M:%S'`,
    );
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number) as [number, number, number, number, number, number];
  const naive = new PyDateTime({ year, month, day, hour, minute, second });
  return naive.toLocal().isoformat();
}

/**
 * Normalize a failure report `arrival_date` (RFC 2822 or ISO 8601) to a UTC
 * `YYYY-MM-DD HH:MM:SS+00` string. Unparseable values are returned as is,
 * for PostgreSQL to try.
 */
export function normalizeArrivalDate<T extends string | null | undefined>(
  value: T,
): T | string {
  if (!value) {
    return value;
  }
  try {
    const datetime = humanTimestampToDatetime(value, { toUtc: true });
    return `${datetime.strftime('%Y-%m-%d %H:%M:%S')}+00`;
  } catch {
    // If parsing fails, return as-is and let PostgreSQL try.
    return value;
  }
}

/**
 * Make `contact_info` a plain string: the TLS-RPT field is normally one
 * string, but a list is joined so it fits a `TEXT` column.
 */
export function contactInfoToText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(pyStr).join(', ');
  }
  return pyStr(value);
}
