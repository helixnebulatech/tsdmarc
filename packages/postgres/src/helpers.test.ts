// Port of TestPostgreSQLHelpers (tests/test_postgres.py), plus the libpq
// connection-string parsing.

import { captureLogs } from 'tsdmarc';
import { describe, expect, it } from 'vitest';

import { parseConnectionString, parseKeywordValueString } from './dsn';
import {
  contactInfoToText,
  ensureUtcSuffix,
  inetOrNull,
  int4,
  naiveLocalToTimestamptz,
  normalizeArrivalDate,
  normalizeTimestamp,
} from './helpers';

function withTimezone<T>(timezone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  try {
    return fn();
  } finally {
    process.env.TZ = previous;
  }
}

describe('ensureUtcSuffix', () => {
  it('passes null through', () => {
    expect(ensureUtcSuffix(null)).toBeNull();
  });

  it('passes an empty string through', () => {
    expect(ensureUtcSuffix('')).toBe('');
  });

  it('appends +00 to a naive UTC timestamp', () => {
    expect(ensureUtcSuffix('2024-01-15 10:30:00')).toBe(
      '2024-01-15 10:30:00+00',
    );
  });

  it('leaves a timestamp with + unchanged', () => {
    expect(ensureUtcSuffix('2024-01-15 10:30:00+05:30')).toBe(
      '2024-01-15 10:30:00+05:30',
    );
  });

  it('leaves a timestamp with Z unchanged', () => {
    expect(ensureUtcSuffix('2024-01-15T10:30:00Z')).toBe(
      '2024-01-15T10:30:00Z',
    );
  });

  it('leaves a negative offset after the date unchanged', () => {
    expect(ensureUtcSuffix('2024-01-15 10:30:00-05:00')).toBe(
      '2024-01-15 10:30:00-05:00',
    );
  });

  it('appends +00 to a naive ISO timestamp with T', () => {
    expect(ensureUtcSuffix('2024-01-15T10:30:00')).toBe(
      '2024-01-15T10:30:00+00',
    );
  });
});

describe('naiveLocalToTimestamptz', () => {
  it('passes null through', () => {
    expect(naiveLocalToTimestamptz(null)).toBeNull();
  });

  it('passes an empty string through', () => {
    expect(naiveLocalToTimestamptz('')).toBe('');
  });

  it('attaches the local offset', () => {
    expect(naiveLocalToTimestamptz('2024-01-15 10:30:00')).toBe(
      '2024-01-15T10:30:00+00:00',
    );
    withTimezone('Europe/Warsaw', () => {
      expect(naiveLocalToTimestamptz('2024-01-15 10:30:00')).toBe(
        '2024-01-15T10:30:00+01:00',
      );
      expect(naiveLocalToTimestamptz('2024-07-15 10:30:00')).toBe(
        '2024-07-15T10:30:00+02:00',
      );
    });
    withTimezone('America/New_York', () => {
      expect(naiveLocalToTimestamptz('2024-01-15 10:30:00')).toBe(
        '2024-01-15T10:30:00-05:00',
      );
    });
  });

  it('accepts single-digit fields like strptime', () => {
    expect(naiveLocalToTimestamptz('2024-1-5 1:2:3')).toBe(
      '2024-01-05T01:02:03+00:00',
    );
  });

  it('raises for a bad format (ValueError from strptime)', () => {
    expect(() => naiveLocalToTimestamptz('not-a-date')).toThrow(
      new RangeError(
        "time data 'not-a-date' does not match format '%Y-%m-%d %H:%M:%S'",
      ),
    );
    expect(() => naiveLocalToTimestamptz('2024-02-30 00:00:00')).toThrow(
      RangeError,
    );
  });
});

describe('normalizeArrivalDate', () => {
  it('passes null through', () => {
    expect(normalizeArrivalDate(null)).toBeNull();
  });

  it('passes an empty string through', () => {
    expect(normalizeArrivalDate('')).toBe('');
  });

  it('adds +00 to a naive ISO string', () => {
    expect(normalizeArrivalDate('2024-01-15 10:30:00')).toBe(
      '2024-01-15 10:30:00+00',
    );
  });

  it('converts an RFC 2822 date to UTC', () => {
    // 00:34:24 +0800 is 16:34:24 UTC on 27 Oct 2022.
    expect(normalizeArrivalDate('Fri, 28 Oct 2022 00:34:24 +0800')).toBe(
      '2022-10-27 16:34:24+00',
    );
  });

  it('accepts a string already ending with +00', () => {
    expect(normalizeArrivalDate('2024-01-15 10:30:00+00')).toBe(
      '2024-01-15 10:30:00+00',
    );
  });

  it('returns an unparseable string as is', () => {
    expect(normalizeArrivalDate('not a date at all')).toBe('not a date at all');
  });
});

describe('contactInfoToText', () => {
  it('passes null through', () => {
    expect(contactInfoToText(null)).toBeNull();
  });

  it('keeps a string', () => {
    expect(contactInfoToText('admin@example.com')).toBe('admin@example.com');
  });

  it('joins a list', () => {
    expect(contactInfoToText(['admin@example.com', 'abuse@example.com'])).toBe(
      'admin@example.com, abuse@example.com',
    );
  });

  it('joins an empty list to an empty string', () => {
    expect(contactInfoToText([])).toBe('');
  });

  it('stringifies other scalars', () => {
    expect(contactInfoToText(123)).toBe('123');
  });
});

describe('libpq connection strings', () => {
  // Expected values are psycopg's conninfo_to_dict() (PQconninfoParse).
  it('parses URIs like libpq', () => {
    const parse = (uri: string): Record<string, string> =>
      Object.fromEntries(parseConnectionString(uri));
    expect(
      parse(
        'postgresql://u:p%40x@h:5433/d%2Fb?sslmode=require&application_name=a+b',
      ),
    ).toEqual({
      user: 'u',
      password: 'p@x',
      host: 'h',
      port: '5433',
      dbname: 'd/b',
      sslmode: 'require',
      application_name: 'a+b',
    });
    expect(parse('postgresql://%2Fvar%2Frun@/db')).toEqual({
      user: '/var/run',
      dbname: 'db',
    });
    expect(parse('postgresql://[::1]:5/db')).toEqual({
      host: '::1',
      port: '5',
      dbname: 'db',
    });
    expect(parse('postgresql://u@h?ssl=true')).toEqual({
      user: 'u',
      host: 'h',
      sslmode: 'require',
    });
    expect(parse('postgresql:///?host=/tmp')).toEqual({ host: '/tmp' });
    expect(parse('postgresql://a@b@h/db')).toEqual({
      user: 'a',
      host: 'b@h',
      dbname: 'db',
    });
    expect(parse('postgresql://h/db?dbname=x')).toEqual({
      host: 'h',
      dbname: 'x',
    });
    expect(parse('postgres://')).toEqual({});
  });

  it('rejects unknown keywords like libpq', () => {
    expect(() => parseConnectionString('postgresql://h/db?foo=1')).toThrow(
      'invalid URI query parameter: not a libpq keyword',
    );
    expect(() => parseConnectionString('host=h foo=bar')).toThrow(
      'invalid connection option: not a libpq keyword',
    );
  });

  it('parses key=value pairs with quoting and escapes', () => {
    expect(
      parseKeywordValueString(
        "host = db  password='a b\\'c\\\\' user=x\\ y application_name=''",
      ),
    ).toEqual([
      { keyword: 'host', value: 'db' },
      { keyword: 'password', value: "a b'c\\" },
      { keyword: 'user', value: 'x y' },
      { keyword: 'application_name', value: '' },
    ]);
  });

  it('parses key=value strings', () => {
    expect(
      Object.fromEntries(
        parseConnectionString('host=/var/run/postgresql dbname=my/db'),
      ),
    ).toEqual({ host: '/var/run/postgresql', dbname: 'my/db' });
    expect(parseConnectionString('').size).toBe(0);
  });

  it('reports malformed strings like libpq', () => {
    expect(() => parseKeywordValueString('host')).toThrow(
      'missing "=" after "host" in connection info string',
    );
    expect(() => parseKeywordValueString("password='open")).toThrow(
      'unterminated quoted string in connection info string',
    );
  });
});

describe('values PostgreSQL would refuse (one would fail the whole batch)', () => {
  it('passes non-strings through ensureUtcSuffix', () => {
    const value = 5 as unknown as string;
    expect(ensureUtcSuffix(value)).toBe(5);
    expect(normalizeTimestamp(value)).toBe(5);
  });

  it('never throws converting contact_info', () => {
    expect(contactInfoToText({ toString: 1 })).toBe("{'toString': 1}");
    expect(contactInfoToText([{ toString: 1 }, 'a'])).toBe(
      "{'toString': 1}, a",
    );
  });

  it('leaves timestamps PostgreSQL reads as they were', () => {
    expect(normalizeTimestamp('2024-09-03T00:00:00Z')).toBe(
      '2024-09-03T00:00:00Z',
    );
    expect(normalizeTimestamp('2024-09-03T23:59:59-07:00')).toBe(
      '2024-09-03T23:59:59-07:00',
    );
    expect(normalizeTimestamp('2024-09-03 00:00:00')).toBe(
      '2024-09-03 00:00:00+00',
    );
    expect(normalizeTimestamp(null)).toBeNull();
  });

  it('rewrites in UTC what only dateutil reads, reading naive as UTC', () => {
    withTimezone('America/New_York', () => {
      expect(normalizeTimestamp('2024-09-03T00:00:00+16:00')).toBe(
        '2024-09-02 08:00:00+00',
      );
      expect(normalizeTimestamp('Jan 5 2024 10:00')).toBe(
        '2024-01-05 10:00:00+00',
      );
    });
  });

  it('leaves what nothing can parse to PostgreSQL', () => {
    expect(normalizeTimestamp('not a date')).toBe('not a date+00');
  });

  it.each([
    ['192.0.2.1'],
    ['2001:db8::1'],
    ['::ffff:192.0.2.1'],
    ['192.0.2.0/24'],
    ['2001:db8::/32'],
  ])('keeps the address %s', value => {
    expect(inetOrNull(value, 'sending_mta_ip')).toBe(value);
  });

  it.each([
    ['mx.example.com'],
    ['192.0.2.1/33'],
    ['2001:db8::/129'],
    ['fe80::1%eth0'],
    ['1.2.3.4 '],
    [''],
    [5],
  ])('stores NULL for %j, with a warning', value => {
    const logs = captureLogs();
    try {
      expect(inetOrNull(value, 'sending_mta_ip')).toBeNull();
    } finally {
      logs.restore();
    }
    expect(logs.output[0]).toContain('storing NULL in sending_mta_ip');
  });

  it('sanitizes the value in the warning', () => {
    const logs = captureLogs();
    try {
      inetOrNull('x\nFORGED', 'receiving_ip');
    } finally {
      logs.restore();
    }
    expect(logs.output.join('')).toContain('x\\nFORGED');
  });

  it('clamps counts to INTEGER, only past its range', () => {
    const logs = captureLogs();
    try {
      expect(int4(2_147_483_647, 'c')).toBe(2_147_483_647);
      expect(int4(-2_147_483_648, 'c')).toBe(-2_147_483_648);
      expect(int4(null, 'c')).toBeNull();
      expect(logs.output).toEqual([]);
      expect(int4(2_147_483_648, 'c')).toBe(2_147_483_647);
      expect(int4(-2_147_483_649, 'c')).toBe(-2_147_483_648);
      expect(int4(2n ** 70n, 'message_count')).toBe(2_147_483_647);
    } finally {
      logs.restore();
    }
    expect(logs.output.at(-1)).toContain(
      'storing 2147483647 in message_count: 1180591620717411303424 is out of range',
    );
  });
});

describe('connection string errors never quote password text', () => {
  it.each([
    ['postgresql+psycopg://user:S3cret@db/dmarc'],
    ['POSTGRESQL://u:S3cret=x@h'],
    ['pgsql://user:S3cret@db'],
    ['password=mi S3cret'],
    ['password=mi S3cret=x'],
    ['postgresql://u:pa/S3cret%word@h/db'],
    ['postgresql://u:pa/s?S3cret@h/db'],
    ['postgresql://u:pa/s?S3cret=1@h/db'],
    ['postgresql://u:pa/s?S3cret%zz=1@h/db'],
    ['postgresql://u:pa/s?x=S3cret%zz@h/db'],
  ])('%s', dsn => {
    expect(() => parseConnectionString(dsn)).toThrow(Error);
    expect(() => parseConnectionString(dsn)).not.toThrow(/S3cret/u);
  });

  it('points at the scheme of an unsupported URI', () => {
    expect(() => parseConnectionString('pgsql://u:p@h')).toThrow(
      'unsupported URI scheme in connection string (use postgresql:// or postgres://)',
    );
  });

  it('reads a ? in the password like libpq', () => {
    expect(
      Object.fromEntries(parseConnectionString('postgresql://u:pa?ss@h/db')),
    ).toEqual({ user: 'u', password: 'pa?ss', host: 'h', dbname: 'db' });
  });
});
