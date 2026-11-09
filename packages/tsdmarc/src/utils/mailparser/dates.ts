// Port of mail-parser 4.8.0 `mailparser/dates.py`: RFC 5322 date
// interpretation with diagnostics.

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const ZONES: Readonly<Record<string, number>> = {
  UT: 0,
  GMT: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
};

// `re.I | re.ASCII`: JavaScript's `i` without `u` folds ASCII only.
// oxlint-disable-next-line require-unicode-regexp -- `u` would fold ſ/K into s/k.
const DATE = new RegExp(
  `^(?:(mon|tue|wed|thu|fri|sat|sun) *, *)?([0-9]{1,2}) *(${MONTHS.join('|')}) *([0-9]{2,}) *([0-9]{2}) *: *([0-9]{2})(?: *: *([0-9]{2}))?( *)([+-][0-9]+|[a-z]+)$`,
  'i',
);

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const MAX_YEAR = 9999;
const MIN_YEAR = 1900;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;

/** A UTC instant, as mail-parser's `datetime` with `tzinfo=utc`. */
export interface UtcDateTime {
  /** Milliseconds since the epoch. */
  readonly epochMs: number;
}

/** mail-parser's `DateResult`. */
export interface DateResult {
  readonly value: UtcDateTime | null;
  /** Legacy offset string (`"+1.0"`), or `0` when there is no value. */
  readonly timezone: string | 0;
  readonly reasons: readonly string[];
}

/** A diagnostic entry of `date_diagnostics()`. */
export interface DateDiagnostic {
  reason: string;
  raw: string;
  recovered: boolean;
  value: string | null;
  header: string;
  occurrence: number;
}

const EMPTY_RESULT: DateResult = { value: null, timezone: 0, reasons: [] };

function failure(reason: string): DateResult {
  return { value: null, timezone: 0, reasons: [reason] };
}

/** `datetime.isoformat()` of a UTC datetime (`2019-04-30T02:09:09+00:00`). */
export function utcIsoformat(value: UtcDateTime): string {
  const date = new Date(value.epochMs);
  const pad = (number: number, width = 2): string =>
    String(number).padStart(width, '0');
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+00:00`
  );
}

// Replace nested comments and FWS with single spaces (`_date_tokens`).
function dateTokens(raw: string): string | null {
  const output: string[] = [];
  let depth = 0;
  let escaped = false;
  let gap = false;
  for (const char of raw) {
    if (depth) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
      continue;
    }
    if (char === '(') {
      depth = 1;
      gap = true;
    } else if (char === ')') {
      return null;
    } else if (' \t\r\n'.includes(char)) {
      gap = true;
    } else {
      if (gap && output.length > 0) {
        output.push(' ');
      }
      gap = false;
      output.push(char);
    }
  }
  return depth ? null : output.join('');
}

// `f"{offset / 60:+.1f}"`, with Python's round-half-even on exact halves.
function formatOffset(offset: number): string {
  const sign = offset < 0 ? '-' : '+';
  const minutes = Math.abs(offset);
  // tenths of an hour = minutes / 6; exact halves happen at minutes % 6 == 3.
  let tenths = Math.floor(minutes / 6);
  const remainder = minutes % 6;
  if (remainder > 3 || (remainder === 3 && tenths % 2 === 1)) {
    tenths += 1;
  }
  return `${sign}${Math.floor(tenths / 10)}.${tenths % 10}`;
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > MAX_YEAR || day < 1) {
    return false;
  }
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const limit = month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  return day <= limit;
}

/** `parse_mail_date()`. */
export function parseMailDate(raw: string | null | undefined): DateResult {
  if (raw === null || raw === undefined) {
    return EMPTY_RESULT;
  }
  const tokens = dateTokens(raw);
  const match = tokens === null ? null : DATE.exec(tokens);
  if (match === null) {
    return failure('invalid-date-syntax');
  }
  const [
    ,
    weekday,
    dayText,
    monthText,
    yearText = '',
    hourText,
    minuteText,
    secondText,
    zoneSpace,
    zoneText = '',
  ] = match;
  const yearDigits = yearText.replace(/^0+/u, '');
  if (yearDigits.length > 4) {
    return failure('date-out-of-range');
  }
  let year = Number(yearDigits || '0');
  if (yearText.length === 2) {
    year += year < 50 ? 2000 : 1900;
  } else if (yearText.length === 3) {
    year += 1900;
  }
  const month =
    MONTHS.indexOf((monthText ?? '').toLowerCase() as (typeof MONTHS)[number]) +
    1;
  const day = Number(dayText ?? '');
  if (!isValidDate(year, month, day)) {
    return failure('invalid-calendar-date');
  }
  if (year < MIN_YEAR) {
    return failure('invalid-calendar-date');
  }
  const hour = Number(hourText ?? '');
  const minute = Number(minuteText ?? '');
  const second = Number(secondText ?? '0');
  if (hour > 23 || minute > 59 || second > 60) {
    return failure('invalid-time');
  }
  const zone = zoneText.toUpperCase();
  let offset: number;
  if (zone.startsWith('+') || zone.startsWith('-')) {
    if (zone.length !== 5 || Number(zone.slice(-2)) > 59) {
      return failure('invalid-zone');
    }
    if (!zoneSpace) {
      return failure('invalid-date-syntax');
    }
    offset = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3));
    if (zone.startsWith('-')) {
      offset = -offset;
    }
  } else {
    if (zone === 'J') {
      return failure('invalid-zone');
    }
    offset = ZONES[zone] ?? 0;
  }
  const base = Date.UTC(
    2000,
    month - 1,
    day,
    hour,
    minute,
    Math.min(second, 59),
  );
  // Date.UTC maps years 0-99 to 1900-1999; set the year explicitly.
  const date = new Date(base);
  date.setUTCFullYear(year, month - 1, day);
  let epochMs = date.getTime() - offset * MS_PER_MINUTE;
  if (second === 60) {
    epochMs += MS_PER_SECOND;
  }
  const resultYear = new Date(epochMs).getUTCFullYear();
  if (resultYear > MAX_YEAR || resultYear < 1) {
    return failure('date-out-of-range');
  }
  const reasons: string[] = [];
  if (weekday) {
    // Python's weekday(): Monday is 0.
    const calendarWeekday = (date.getUTCDay() + 6) % 7;
    if (
      WEEKDAYS.indexOf(weekday.toLowerCase() as (typeof WEEKDAYS)[number]) !==
      calendarWeekday
    ) {
      reasons.push('weekday-mismatch');
    }
  }
  return { value: { epochMs }, timezone: formatOffset(offset), reasons };
}

/** `date_diagnostics()`. */
export function dateDiagnostics(
  result: DateResult,
  raw: string,
  header: string,
  occurrence: number,
): DateDiagnostic[] {
  return result.reasons.map(reason => ({
    reason,
    raw,
    recovered: result.value !== null,
    value: result.value === null ? null : utcIsoformat(result.value),
    header,
    occurrence,
  }));
}
