// A Python-style datetime: wall-clock fields plus an optional UTC offset.
//
// parsedmarc's output depends on Python's distinction between naive
// datetimes (no offset; interpreted as local time) and aware ones (fixed
// offset). A JS `Date` is always an instant, so it cannot represent a naive
// value. `PyDateTime` keeps both forms, with the same conversions Python
// does: `timestamp()` and `astimezone()` read a naive value as local time
// (honoring `process.env.TZ`).

const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;
const MICROSECONDS_PER_MS = 1000;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export interface PyDateTimeFields {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  microsecond?: number;
  /** Minutes east of UTC; `null` (default) for a naive datetime. */
  utcOffsetMinutes?: number | null;
}

function pad(value: number, width = 2): string {
  return String(Math.trunc(Math.abs(value))).padStart(width, '0');
}

/**
 * `Date.UTC()` for any year: `Date.UTC` itself maps years 0-99 to 1900-1999,
 * `setUTCFullYear` doesn't.
 */
function utcEpochMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime();
}

function daysInMonth(year: number, month: number): number {
  return new Date(utcEpochMs(year, month + 1, 0)).getUTCDate();
}

/** Python's `round()` on a float: halves go to the even neighbor. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference > 0.5) {
    return floor + 1;
  }
  if (difference < 0.5) {
    return floor;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

function formatOffset(minutes: number, separator: string): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}${separator}${pad(absolute % 60)}`;
}

export class PyDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly microsecond: number;
  readonly utcOffsetMinutes: number | null;

  constructor(fields: PyDateTimeFields) {
    const {
      year,
      month,
      day,
      hour = 0,
      minute = 0,
      second = 0,
      microsecond = 0,
      utcOffsetMinutes = null,
    } = fields;
    const valid =
      Number.isInteger(year) &&
      year >= 1 &&
      year <= 9999 &&
      Number.isInteger(month) &&
      month >= 1 &&
      month <= 12 &&
      Number.isInteger(day) &&
      day >= 1 &&
      day <= daysInMonth(year, month) &&
      Number.isInteger(hour) &&
      hour >= 0 &&
      hour <= 23 &&
      Number.isInteger(minute) &&
      minute >= 0 &&
      minute <= 59 &&
      Number.isInteger(second) &&
      second >= 0 &&
      second <= 59 &&
      Number.isInteger(microsecond) &&
      microsecond >= 0 &&
      microsecond <= 999_999 &&
      (utcOffsetMinutes === null ||
        (Number.isInteger(utcOffsetMinutes) &&
          Math.abs(utcOffsetMinutes) < 24 * 60));
    if (!valid) {
      throw new RangeError(
        `invalid datetime: ${JSON.stringify({ day, hour, microsecond, minute, month, second, utcOffsetMinutes, year })}`,
      );
    }
    this.year = year;
    this.month = month;
    this.day = day;
    this.hour = hour;
    this.minute = minute;
    this.second = second;
    this.microsecond = microsecond;
    this.utcOffsetMinutes = utcOffsetMinutes;
  }

  /** Naive datetime in local time from an epoch instant (ms precision). */
  static fromDateLocal(date: Date, microsecond?: number): PyDateTime {
    return new PyDateTime({
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      microsecond: microsecond ?? date.getMilliseconds() * MICROSECONDS_PER_MS,
    });
  }

  /** Aware datetime with the given offset, from an epoch instant. */
  static fromDateWithOffset(
    date: Date,
    utcOffsetMinutes: number,
    microsecond?: number,
  ): PyDateTime {
    const shifted = new Date(date.getTime() + utcOffsetMinutes * MS_PER_MINUTE);
    return new PyDateTime({
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
      microsecond:
        microsecond ?? shifted.getUTCMilliseconds() * MICROSECONDS_PER_MS,
      utcOffsetMinutes,
    });
  }

  /**
   * Python's `datetime.fromtimestamp(seconds)` (naive, local time), or
   * `datetime.fromtimestamp(seconds, timezone.utc)` with `utc: true`.
   */
  static fromTimestamp(seconds: number, utc = false): PyDateTime {
    // CPython: modf() into whole seconds and a fraction, the fraction rounded
    // half-even to microseconds, carrying into the seconds at 1e6 or below 0.
    let whole = Math.trunc(seconds);
    let microsecond = roundHalfEven((seconds - whole) * 1_000_000);
    if (microsecond >= 1_000_000) {
      whole += 1;
      microsecond -= 1_000_000;
    } else if (microsecond < 0) {
      whole -= 1;
      microsecond += 1_000_000;
    }
    const date = new Date(whole * MS_PER_SECOND);
    return utc
      ? PyDateTime.fromDateWithOffset(date, 0, microsecond)
      : PyDateTime.fromDateLocal(date, microsecond);
  }

  /** Python's `datetime.now()` (naive local) or `datetime.now(timezone.utc)`. */
  static now(utc = false): PyDateTime {
    return PyDateTime.fromTimestamp(Date.now() / MS_PER_SECOND, utc);
  }

  get isNaive(): boolean {
    return this.utcOffsetMinutes === null;
  }

  /** The instant this datetime denotes (naive values are read as local time). */
  toDate(): Date {
    const ms = Math.floor(this.microsecond / MICROSECONDS_PER_MS);
    if (this.utcOffsetMinutes === null) {
      // setFullYear, not the constructor: it maps years 0-99 to 1900-1999.
      const date = new Date(0);
      date.setFullYear(this.year, this.month - 1, this.day);
      date.setHours(this.hour, this.minute, this.second, ms);
      return date;
    }
    const utcMs = utcEpochMs(
      this.year,
      this.month,
      this.day,
      this.hour,
      this.minute,
      this.second,
      ms,
    );
    return new Date(utcMs - this.utcOffsetMinutes * MS_PER_MINUTE);
  }

  /** POSIX timestamp in seconds (Python's `datetime.timestamp()`). */
  timestamp(): number {
    // Python divides the exact microsecond count by 1e6 (one rounding).
    const wholeSeconds =
      (this.toDate().getTime() -
        Math.floor(this.microsecond / MICROSECONDS_PER_MS)) /
      MS_PER_SECOND;
    const totalMicro = wholeSeconds * 1_000_000 + this.microsecond;
    return Number.isSafeInteger(totalMicro)
      ? totalMicro / 1_000_000
      : wholeSeconds + this.microsecond / 1_000_000;
  }

  /** Python's `astimezone(timezone.utc)`. */
  toUtc(): PyDateTime {
    return PyDateTime.fromDateWithOffset(this.toDate(), 0, this.microsecond);
  }

  /** Python's `astimezone()` with no argument: aware, in local time. */
  toLocal(): PyDateTime {
    const date = this.toDate();
    return PyDateTime.fromDateWithOffset(
      date,
      -date.getTimezoneOffset(),
      this.microsecond,
    );
  }

  /** Python's `replace(tzinfo=...)`: same wall clock, new (or no) offset. */
  withOffset(utcOffsetMinutes: number | null): PyDateTime {
    return new PyDateTime({ ...this.fields(), utcOffsetMinutes });
  }

  /** Python's `replace(...)` for wall-clock fields. */
  replace(changes: Partial<PyDateTimeFields>): PyDateTime {
    return new PyDateTime({ ...this.fields(), ...changes });
  }

  /** Add a duration in seconds (Python's `+ timedelta(seconds=...)`). */
  addSeconds(seconds: number): PyDateTime {
    const totalMicro = roundHalfEven(seconds * 1_000_000) + this.microsecond;
    const wallMs = utcEpochMs(
      this.year,
      this.month,
      this.day,
      this.hour,
      this.minute,
      this.second,
    );
    const microRemainder = ((totalMicro % 1_000_000) + 1_000_000) % 1_000_000;
    const shiftedMs =
      wallMs + ((totalMicro - microRemainder) / 1_000_000) * MS_PER_SECOND;
    const shifted = new Date(shiftedMs);
    return new PyDateTime({
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
      microsecond: microRemainder,
      utcOffsetMinutes: this.utcOffsetMinutes,
    });
  }

  /** Midnight of the same day (Python's `datetime.combine(dt.date(), time())`). */
  startOfDay(): PyDateTime {
    return this.replace({ hour: 0, minute: 0, second: 0, microsecond: 0 });
  }

  /**
   * Seconds from `other` to this datetime (Python's `(self - other)
   * .total_seconds()`). Both must be naive or both aware, as in Python.
   */
  secondsSince(other: PyDateTime): number {
    if (this.isNaive !== other.isNaive) {
      throw new TypeError(
        "can't subtract offset-naive and offset-aware datetimes",
      );
    }
    if (this.isNaive) {
      return (this.wallClockMicros() - other.wallClockMicros()) / 1_000_000;
    }
    return this.timestamp() - other.timestamp();
  }

  /** Negative, zero or positive, like comparing Python datetimes. */
  compare(other: PyDateTime): number {
    return Math.sign(this.secondsSince(other));
  }

  equals(other: PyDateTime): boolean {
    if (this.isNaive !== other.isNaive) {
      return false;
    }
    return this.compare(other) === 0;
  }

  private wallClockMicros(): number {
    const wallMs = utcEpochMs(
      this.year,
      this.month,
      this.day,
      this.hour,
      this.minute,
      this.second,
    );
    return wallMs * MICROSECONDS_PER_MS + this.microsecond;
  }

  fields(): PyDateTimeFields {
    return {
      year: this.year,
      month: this.month,
      day: this.day,
      hour: this.hour,
      minute: this.minute,
      second: this.second,
      microsecond: this.microsecond,
      utcOffsetMinutes: this.utcOffsetMinutes,
    };
  }

  /** Day of the week, Monday = 0 (Python's `weekday()`). */
  weekday(): number {
    const sundayFirst = new Date(
      utcEpochMs(this.year, this.month, this.day),
    ).getUTCDay();
    return (sundayFirst + 6) % 7;
  }

  /**
   * Python's `strftime` for the directives parsedmarc uses: `%Y %y %m %d %H
   * %I %M %S %f %p %z %Z %a %A %b %B %j %%`.
   */
  strftime(format: string): string {
    let result = '';
    for (let index = 0; index < format.length; index += 1) {
      const char = format.charAt(index);
      if (char !== '%' || index === format.length - 1) {
        result += char;
        continue;
      }
      index += 1;
      result += this.directive(format.charAt(index));
    }
    return result;
  }

  private directive(code: string): string {
    const weekdayName = WEEKDAYS[(this.weekday() + 1) % 7] ?? '';
    const monthName = MONTHS[this.month - 1] ?? '';
    switch (code) {
      case 'Y':
        return pad(this.year, 4);
      case 'y':
        return pad(this.year % 100);
      case 'm':
        return pad(this.month);
      case 'd':
        return pad(this.day);
      case 'H':
        return pad(this.hour);
      case 'I':
        return pad(this.hour % 12 === 0 ? 12 : this.hour % 12);
      case 'M':
        return pad(this.minute);
      case 'S':
        return pad(this.second);
      case 'f':
        return pad(this.microsecond, 6);
      case 'p':
        return this.hour < 12 ? 'AM' : 'PM';
      case 'z':
        return this.utcOffsetMinutes === null
          ? ''
          : formatOffset(this.utcOffsetMinutes, '');
      case 'Z':
        return this.utcOffsetMinutes === null
          ? ''
          : this.utcOffsetMinutes === 0
            ? 'UTC'
            : `UTC${formatOffset(this.utcOffsetMinutes, ':')}`;
      case 'a':
        return weekdayName.slice(0, 3);
      case 'A':
        return weekdayName;
      case 'b':
        return monthName.slice(0, 3);
      case 'B':
        return monthName;
      case 'j': {
        const start = utcEpochMs(this.year, 1, 1);
        const current = utcEpochMs(this.year, this.month, this.day);
        return pad((current - start) / 86_400_000 + 1, 3);
      }
      case '%':
        return '%';
      default:
        return `%${code}`;
    }
  }

  /** Python's `isoformat(sep)`: `2024-01-01T00:00:00[.ffffff][+00:00]`. */
  isoformat(separator = 'T'): string {
    let text = `${pad(this.year, 4)}-${pad(this.month)}-${pad(this.day)}${separator}${pad(this.hour)}:${pad(this.minute)}:${pad(this.second)}`;
    if (this.microsecond !== 0) {
      text += `.${pad(this.microsecond, 6)}`;
    }
    if (this.utcOffsetMinutes !== null) {
      text += formatOffset(this.utcOffsetMinutes, ':');
    }
    return text;
  }

  /** Python's `str(datetime)`: ISO format with a space separator. */
  toString(): string {
    return this.isoformat(' ');
  }

  /** JSON form, matching Python's `json.dumps(..., default=str)`. */
  toJSON(): string {
    return this.toString();
  }
}
