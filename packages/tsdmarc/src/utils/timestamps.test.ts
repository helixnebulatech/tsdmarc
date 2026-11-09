import { describe, expect, it } from 'vitest';

import { withTz } from '../test/tz';
import { PyDateTime } from './datetime';
import {
  DateParseError,
  humanTimestampToDatetime,
  humanTimestampToUnixTimestamp,
  parseDate,
  stripComments,
  timestampToDatetime,
  timestampToHuman,
} from './timestamps';

/** CPU milliseconds since `start`: a loaded machine doesn't make bounds flaky. */
function cpuMsSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}

const utc = (year: number, month: number, day: number): PyDateTime =>
  new PyDateTime({ day, month, utcOffsetMinutes: 0, year });

describe('timestamp helpers', () => {
  it('timestampToDatetime matches local fromtimestamp', () => {
    withTz('Europe/Warsaw', () => {
      const dt = timestampToDatetime(1_704_067_200);
      expect(dt.isNaive).toBe(true);
      expect(dt.toString()).toBe('2024-01-01 01:00:00');
    });
  });

  it('timestampToHuman returns YYYY-MM-DD HH:MM:SS', () => {
    expect(timestampToHuman(1_704_067_200)).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u,
    );
    expect(timestampToHuman('1704067200')).toBe('2024-01-01 00:00:00');
  });

  it('parses a plain timestamp string', () => {
    const dt = humanTimestampToDatetime('2024-01-01 00:00:00');
    expect([dt.year, dt.month, dt.day]).toEqual([2024, 1, 1]);
  });

  it('converts to UTC when asked', () => {
    const dt = humanTimestampToDatetime('2024-01-01 12:00:00', { toUtc: true });
    expect(dt.utcOffsetMinutes).toBe(0);
  });

  it('strips parenthesized comments, nested and with quoted-pairs', () => {
    expect(
      humanTimestampToDatetime('Mon, 01 Jan 2024 00:00:00 +0000 (UTC)').year,
    ).toBe(2024);
    const cases = [
      ['Tue, 1 Jan 2019 00:00:00 +0000\t(GMT)', utc(2019, 1, 1)],
      ['Mon, 01 Jan 2024 00:00:00 +0000 (x) (y)', utc(2024, 1, 1)],
      ['Mon, 01 Jan 2024 00:00:00 +0000 (a (b) c)', utc(2024, 1, 1)],
      ['Mon, 01 Jan 2024 00:00:00 +0000 (\\) x)', utc(2024, 1, 1)],
    ] as const;
    for (const [input, expected] of cases) {
      expect(humanTimestampToDatetime(input).equals(expected)).toBe(true);
    }
    expect(stripComments('a (b (c) d) e (unclosed')).toBe('a  e ');
  });

  it('rejects a whitespace-padded unclosed comment in linear time', () => {
    // The old regex comment stripper was quadratic on whitespace runs (200,000
    // spaces took 18.6 s in Python); the depth-counting scan takes ms.
    const start = process.cpuUsage();
    expect(() => humanTimestampToDatetime(`${' '.repeat(200_000)}(x`)).toThrow(
      DateParseError,
    );
    expect(cpuMsSince(start)).toBeLessThan(5000);
  });

  it('handles a -0000 zone', () => {
    expect(humanTimestampToDatetime('2024-01-01 00:00:00 -0000').year).toBe(
      2024,
    );
  });

  it('converts to whole UNIX seconds, with a T separator too', () => {
    expect(
      Number.isInteger(humanTimestampToUnixTimestamp('2024-01-01 00:00:00')),
    ).toBe(true);
    expect(humanTimestampToUnixTimestamp('2024-01-01T00:00:00')).toBe(
      humanTimestampToUnixTimestamp('2024-01-01 00:00:00'),
    );
  });
});

describe('assumeUtc (parsedmarc issue #811)', () => {
  // 2024-01-15 12:00:00 UTC, evaluated under Europe/Warsaw (UTC+1).
  const UTC_STRING = '2024-01-15 12:00:00';
  const TRUE_EPOCH = 1_705_320_000;

  it('yields an aware UTC datetime', () => {
    withTz('Europe/Warsaw', () => {
      const dt = humanTimestampToDatetime(UTC_STRING, { assumeUtc: true });
      expect(dt.utcOffsetMinutes).toBe(0);
      expect(Math.trunc(dt.timestamp())).toBe(TRUE_EPOCH);
    });
  });

  it('reads a naive parse as local time by default', () => {
    withTz('Europe/Warsaw', () => {
      const dt = humanTimestampToDatetime(UTC_STRING);
      expect(dt.isNaive).toBe(true);
      expect(Math.trunc(dt.timestamp())).toBe(TRUE_EPOCH - 3600);
    });
  });

  it('applies to the UNIX timestamp helper', () => {
    withTz('Europe/Warsaw', () => {
      expect(
        humanTimestampToUnixTimestamp(UTC_STRING, { assumeUtc: true }),
      ).toBe(TRUE_EPOCH);
    });
  });

  it('does not override an explicit offset', () => {
    withTz('Europe/Warsaw', () => {
      const dt = humanTimestampToDatetime('2024-01-15 13:00:00 +0100', {
        assumeUtc: true,
      });
      expect(Math.trunc(dt.timestamp())).toBe(TRUE_EPOCH);
    });
  });
});

describe('parseDate (dateutil-compatible)', () => {
  // Expected values were produced by dateutil.parser.parse 2.9.
  const cases: [string, string][] = [
    ['2024-01-01T00:00:00Z', '2024-01-01T00:00:00+00:00'],
    ['2024-01-01T00:00:00.123456+02:00', '2024-01-01T00:00:00.123456+02:00'],
    ['Tue, 30 Apr 2019 02:09:00 +0000', '2019-04-30T02:09:00+00:00'],
    ['Mon, 1 Apr 2024 10:00:00 GMT', '2024-04-01T10:00:00+00:00'],
    ['Thu, 13 Sep 2018 13:50:16 -0400', '2018-09-13T13:50:16-04:00'],
    ['Wed, 5 Sep 2018 16:12:41 +0200 (CEST)', '2018-09-05T16:12:41+02:00'],
    ['Sep 5, 2018 4:12 PM', '2018-09-05T16:12:00'],
    ['01/02/24 10:00', '2024-01-02T10:00:00'],
    ['20240102', '2024-01-02T00:00:00'],
    ['2-Jan-2024', '2024-01-02T00:00:00'],
    ['2024-01-01 00:00:00 EST', '2024-01-01T00:00:00'],
    ['2018-09-29 06:02:22.5', '2018-09-29T06:02:22.500000'],
    ['January 1, 2024 at 10:00', '2024-01-01T10:00:00'],
    ['2019-04-30T02:09:00+0000', '2019-04-30T02:09:00+00:00'],
  ];
  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      expect(parseDate(input).isoformat()).toBe(expected);
    });
  }

  for (const input of [
    '',
    'foo',
    '2024-02-30 00:00:00',
    '2024-13-01',
    '2024-01-01 25:00:00',
  ]) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => parseDate(input)).toThrow(DateParseError);
    });
  }
});

describe('PyDateTime', () => {
  it('formats like Python', () => {
    const dt = new PyDateTime({
      day: 5,
      hour: 7,
      microsecond: 120,
      minute: 2,
      month: 3,
      second: 9,
      utcOffsetMinutes: -330,
      year: 2024,
    });
    expect(dt.isoformat()).toBe('2024-03-05T07:02:09.000120-05:30');
    expect(dt.toString()).toBe('2024-03-05 07:02:09.000120-05:30');
    expect(dt.strftime('%a %b %d %Y %H:%M:%S %z %j %%')).toBe(
      'Tue Mar 05 2024 07:02:09 -0530 065 %',
    );
  });

  it('converts between local, UTC and timestamps', () => {
    withTz('America/New_York', () => {
      const naive = new PyDateTime({ day: 1, hour: 12, month: 7, year: 2024 });
      expect(naive.timestamp()).toBe(1_719_849_600);
      expect(naive.toUtc().toString()).toBe('2024-07-01 16:00:00+00:00');
      expect(naive.toLocal().utcOffsetMinutes).toBe(-240);
      expect(PyDateTime.fromTimestamp(1_719_849_600).equals(naive)).toBe(true);
    });
  });

  it('adds seconds across day boundaries and compares', () => {
    const dt = new PyDateTime({ day: 31, hour: 23, month: 12, year: 2023 });
    const later = dt.addSeconds(3600.5);
    expect(later.toString()).toBe('2024-01-01 00:00:00.500000');
    expect(later.secondsSince(dt)).toBe(3600.5);
    expect(later.compare(dt)).toBe(1);
    expect(() => later.secondsSince(dt.withOffset(0))).toThrow(TypeError);
  });

  it('rejects invalid fields', () => {
    expect(() => new PyDateTime({ day: 29, month: 2, year: 2023 })).toThrow(
      RangeError,
    );
  });
});

describe('parseDate: dateutil details (expected values from dateutil 2.9)', () => {
  const at = (year: number, month: number, day: number): PyDateTime =>
    new PyDateTime({ day, month, year });
  const parse = (input: string, today = at(2026, 1, 31)): string =>
    parseDate(input, { currentYear: 2026, default: today }).isoformat();

  it('caps a missing day to the month length like dateutil', () => {
    // dateutil fills the day from `default` (today) and falls back to the
    // month's last day; this used to throw on the 29th-31st.
    expect(parse('Feb 2024')).toBe('2024-02-29T00:00:00');
    expect(parse('Feb 2023')).toBe('2023-02-28T00:00:00');
    expect(parse('Apr 2025')).toBe('2025-04-30T00:00:00');
    expect(parse('2024-02')).toBe('2024-02-29T00:00:00');
    expect(parse('Feb')).toBe('2026-02-28T00:00:00');
  });

  it('moves to the named weekday when no day is given', () => {
    // Saturday 2026-10-24: "Tue" is the next Tuesday, "Sat" is today.
    const saturday = at(2026, 10, 24);
    expect(parse('Tue', saturday)).toBe('2026-10-27T00:00:00');
    expect(parse('Fri 10:00', saturday)).toBe('2026-10-30T10:00:00');
    expect(parse('Saturday', saturday)).toBe('2026-10-24T00:00:00');
    // An explicit date wins over the weekday.
    expect(parse('Thu 2024-01-01', saturday)).toBe('2024-01-01T00:00:00');
  });

  it('resolves year/month/day like _ymd', () => {
    expect(parse('1 2 3')).toBe('2003-01-02T00:00:00');
    expect(parse('13 2 3')).toBe('2003-02-13T00:00:00');
    expect(parse('01-01-2024')).toBe('2024-01-01T00:00:00');
    expect(parse('2024-1-1 1:2:3')).toBe('2024-01-01T01:02:03');
    expect(parse('January 1st 2024')).toBe('2024-01-01T00:00:00');
    expect(parse('99-Jan-01')).toBe('1999-01-01T00:00:00');
    expect(parse('Jan of 05')).toBe('2005-01-31T00:00:00');
  });

  it('reverses the sign after a zone name ("GMT+1" is UTC-1)', () => {
    expect(parse('2024-01-01 10:00 GMT+1')).toBe('2024-01-01T10:00:00-01:00');
    expect(parse('2024-01-01 10:00 UTC-3')).toBe('2024-01-01T10:00:00+03:00');
    expect(parse('2024-01-01 10:00 GMT-0300')).toBe(
      '2024-01-01T10:00:00+03:00',
    );
    expect(parse('Jan 01 2024 10:00:00 GMT+0000 (UTC)')).toBe(
      '2024-01-01T10:00:00+00:00',
    );
    expect(parse('2024-01-01T10Z')).toBe('2024-01-01T10:00:00+00:00');
    expect(parse('10:00:00,5')).toBe('2026-01-31T10:00:00.500000');
  });

  it('treats zone names like dateutil', () => {
    withTz('UTC', () => {
      // "UT" and unknown names are ignored (naive); "z" is UTC; lowercase
      // "gmt" is not a zone name at all.
      expect(parse('2024-01-01 10:00 UT')).toBe('2024-01-01T10:00:00');
      expect(parse('2024-01-01 10:00 z')).toBe('2024-01-01T10:00:00+00:00');
      expect(() => parse('2024-01-01 10:00 gmt')).toThrow(
        'Unknown string format: 2024-01-01 10:00 gmt',
      );
    });
    // A name in time.tzname means the local zone.
    withTz('America/New_York', () => {
      expect(parse('2024-07-01 10:00 EDT')).toBe('2024-07-01T10:00:00-04:00');
      expect(parse('2024-11-03 01:30 EST')).toBe('2024-11-03T01:30:00-05:00');
      expect(parse('2024-11-03 01:30 EDT')).toBe('2024-11-03T01:30:00-04:00');
    });
  });

  it("raises with Python's messages", () => {
    expect(() => parse('2024-02-30')).toThrow(
      'day 30 must be in range 1..29 for month 2 in year 2024: 2024-02-30',
    );
    expect(() => parse('2024-01-01 25:00')).toThrow(
      'hour must be in 0..23, not 25: 2024-01-01 25:00',
    );
    expect(() => parse('at')).toThrow('String does not contain a date: at');
    expect(() => parse('99999999999')).toThrow(
      'Python int too large to convert to C int',
    );
    expect(() => parse('2024-01-01 10:00 +2500')).toThrow(
      'offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not datetime.timedelta(days=1, seconds=3600)',
    );
  });

  it('stays linear on 200 KB adversarial strings', () => {
    // dateutil itself needs ~50 s for "1." * 200,000 (its token stack pops
    // from the front); the port is linear (~0.1 s per input).
    const start = process.cpuUsage();
    for (const input of [
      '1.'.repeat(100_000),
      'a.'.repeat(100_000),
      `${' '.repeat(200_000)}x`,
      '1-'.repeat(100_000),
      '1'.repeat(200_000),
    ]) {
      expect(() => parse(input)).toThrow();
    }
    // Every "12 h" sets the hour again; dateutil accepts it.
    expect(parse('12 h '.repeat(40_000))).toBe('2026-01-31T12:00:00');
    expect(cpuMsSince(start)).toBeLessThan(10_000);
  });
});

describe('PyDateTime: Python semantics at the edges', () => {
  it('handles years 0001-0099 (Date.UTC maps them to the 1900s)', () => {
    const leap = new PyDateTime({
      day: 29,
      hour: 12,
      month: 2,
      utcOffsetMinutes: 0,
      year: 4,
    });
    expect(leap.timestamp()).toBe(-62_035_848_000);
    expect(leap.weekday()).toBe(6);
    expect(leap.strftime('%j %a')).toBe('060 Sun');
    expect(
      new PyDateTime({
        day: 1,
        month: 1,
        utcOffsetMinutes: 0,
        year: 1,
      }).timestamp(),
    ).toBe(-62_135_596_800);
    const late = new PyDateTime({
      day: 31,
      hour: 23,
      microsecond: 999_999,
      minute: 59,
      month: 12,
      second: 59,
      year: 99,
    });
    expect(late.addSeconds(0.000_000_5).toString()).toBe(
      '0099-12-31 23:59:59.999999',
    );
    expect(late.addSeconds(0.000_001_5).toString()).toBe(
      '0100-01-01 00:00:00.000001',
    );
  });

  it('fromTimestamp rounds microseconds half-even with carry', () => {
    const cases: [number, string][] = [
      [1.999_999_5, '1970-01-01T00:00:01.999999+00:00'],
      [1.999_999_6, '1970-01-01T00:00:02+00:00'],
      [0.000_000_5, '1970-01-01T00:00:00+00:00'],
      [0.000_001_5, '1970-01-01T00:00:00.000002+00:00'],
      [-1.5, '1969-12-31T23:59:58.500000+00:00'],
      [-0.000_000_4, '1970-01-01T00:00:00+00:00'],
      [1_704_067_200.123_456_789, '2024-01-01T00:00:00.123457+00:00'],
      [1.000_000_5, '1970-01-01T00:00:01.000001+00:00'],
    ];
    for (const [seconds, expected] of cases) {
      expect(PyDateTime.fromTimestamp(seconds, true).isoformat()).toBe(
        expected,
      );
    }
    expect(
      new PyDateTime({
        day: 1,
        microsecond: 1,
        month: 1,
        utcOffsetMinutes: 0,
        year: 2024,
      }).timestamp(),
    ).toBe(1_704_067_200.000_001);
  });
});

describe('parseDate: length limit (not in dateutil)', () => {
  const start = new PyDateTime({ day: 1, month: 1, year: 2024 });

  it('rejects text too long to be a date before tokenizing it', () => {
    const before = process.cpuUsage();
    expect(() =>
      parseDate(`12:34.${'1'.repeat(20_000_000)}`, { default: start }),
    ).toThrow(
      new DateParseError(
        'String of 20000006 characters is too long to be a date',
      ),
    );
    expect(cpuMsSince(before)).toBeLessThan(1000);
  });

  it('still parses long fractions up to the limit', () => {
    const fits = 1024 * 1024 - 6;
    const date = parseDate(`12:34.${'1'.repeat(fits)}`, { default: start });
    expect(date.second).toBe(6);
    expect(() =>
      parseDate(`12:34.${'1'.repeat(fits + 1)}`, { default: start }),
    ).toThrow(DateParseError);
  });
});
