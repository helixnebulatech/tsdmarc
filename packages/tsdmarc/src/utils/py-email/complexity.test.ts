// Linear-time ports of `email.message._parseparam()` (CPython's fix for
// gh-136063), `getaddresses()` groups and `as_string()` on deeply nested
// messages. Expected values come from Python 3.14.

import { describe, expect, it, vi } from 'vitest';

import { EmailTooLargeError } from '../../errors';
import { parseReportEmail } from '../../report-email';
import { MailParser } from '../mailparser/core';
import { MailParserRecursionError } from '../mailparser/exceptions';
import { asString, FlattenCache } from './generator';
import { type Message, parseParam } from './message';
import { messageFromString } from './parser';
import { getaddresses } from './utils';

/** CPU milliseconds since `start`: a loaded machine doesn't make bounds flaky. */
function cpuMsSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}

describe('parseParam', () => {
  // [value, Python's email.message._parseparam(value)]
  const cases: [string, string[]][] = [
    ['a;b', ['a', 'b']],
    ['a; b="x;y"; c=1', ['a', 'b="x;y"', 'c=1']],
    ['s=";;;;;', ['s=";;;;;']],
    ['A = 1 ; B="\\";"; c', ['a=1', 'b="\\";"', 'c']],
    [';;', ['', '', '']],
    ['x=";";y', ['x=";"', 'y']],
    ['f="a\\"b;c";g=2', ['f="a\\"b;c"', 'g=2']],
    ['"a;b;"c";d', ['"a;b;"c";d']],
    ['', ['']],
  ];

  it.each(cases)('splits %j like Python', (value, expected) => {
    expect(parseParam(value)).toEqual(expected);
  });

  it('is linear in the number of parameters', () => {
    // CPython's test_get_param_linear_complexity; 400,000 characters of
    // `a;` took 13.4 s (`str.find('=', start, end)` scanned to the end).
    const count = 200_000;
    const start = process.cpuUsage();
    for (const [item, expected] of [
      ['', ''],
      ['foo=bar', 'foo=bar'],
      [' FOO = bar    ', 'foo=bar'],
    ]) {
      const result = parseParam(`${item};`.repeat(count - 1) + item);
      expect(result).toHaveLength(count);
      expect(new Set(result)).toEqual(new Set([expected]));
    }
    const malformed = `s="${';'.repeat(count - 1)}`;
    expect(parseParam(malformed)).toEqual([malformed]);
    expect(cpuMsSince(start)).toBeLessThan(5000);
  });
});

describe('getaddresses', () => {
  // [field, Python's email.utils.getaddresses([field])]
  const cases: [string, [string, string][]][] = [
    [
      'g:a@b,c@d;',
      [
        ['', 'a@b'],
        ['', 'c@d'],
      ],
    ],
    ['x, g: a@b, "q,r" <c@d> ; e@f', [['', '']]],
    ['g:h:a@b;;', [['', 'a@b']]],
    ['a@b', [['', 'a@b']]],
    ['g:;', [['', '']]],
  ];

  it.each(cases)('parses %j like Python', (field, expected) => {
    expect(getaddresses([field])).toEqual(expected);
  });

  it('is linear in the size of a group', () => {
    // 400,000 characters took 95 s: the group's list was rebuilt per member.
    const members = 100_000;
    const start = process.cpuUsage();
    const result = getaddresses([`g:${'a@b,'.repeat(members)};`]);
    expect(cpuMsSince(start)).toBeLessThan(5000);
    // Python counts one address per comma plus one: the group's trailing
    // comma makes the count differ, and strict mode gives up.
    expect(result).toEqual([['', '']]);
    const exact = getaddresses([
      `g:${Array.from({ length: members }, () => 'a@b').join(',')};`,
    ]);
    expect(exact).toHaveLength(members);
    expect(exact[members - 1]).toEqual(['', 'a@b']);
  });
});

/** `depth` nested multiparts around a text part of `size` characters. */
function nested(
  depth: number,
  size: number,
  boundary = (level: number) => `b${level}`,
): string {
  let text = 'From: a@b.c\nSubject: s\n';
  for (let level = 0; level < depth; level += 1) {
    text += `Content-Type: multipart/mixed; boundary="${boundary(level)}"\n\n--${boundary(level)}\n`;
  }
  text += `Content-Type: text/plain\n\n${'x'.repeat(size)}\n`;
  for (let level = depth - 1; level >= 0; level -= 1) {
    text += `--${boundary(level)}--\n`;
  }
  return text;
}

describe('asString with a shared cache', () => {
  it('flattens every part as without it', () => {
    for (const source of [
      nested(5, 10),
      // An empty boundary gets a random one the first time it is written.
      nested(4, 10, level => (level === 2 ? '' : `b${level}`)),
    ]) {
      const message = messageFromString(source);
      const cache = new FlattenCache();
      const cached = new Map<Message, string>();
      for (const part of message.walk()) {
        cached.set(part, asString(part, cache));
      }
      for (const part of message.walk()) {
        expect(cached.get(part)).toBe(asString(part));
      }
    }
  });

  it('keeps deep nesting near-linear in parseReportEmail', async () => {
    // A 5 MB part 60 levels deep took 19 s (120 levels: 78 s): every level
    // flattened the whole subtree again.
    const text = nested(200, 2_000_000);
    const start = process.cpuUsage();
    await expect(parseReportEmail(text, { offline: true })).rejects.toThrow(
      'is not a valid report',
    );
    expect(cpuMsSince(start)).toBeLessThan(5000);
  });
});

const MIB = 1024 * 1024;

/** A chain of message/rfc822 parts around a body of `size` characters. */
function rfc822Chain(depth: number, size: number): string {
  return `From: a@b.c\nSubject: s\n${'Content-Type: message/rfc822\n\n'.repeat(depth)}Subject: leaf\n\n${'y'.repeat(size)}\n`;
}

/** Nested multipart attachments, each with a text part, around a body. */
function attachmentChain(depth: number, size: number): string {
  let open = 'From: a@b.c\nSubject: s\n';
  let close = '';
  for (let level = 0; level < depth; level += 1) {
    open += `Content-Type: multipart/mixed; boundary="b${level}"\nContent-Disposition: attachment\n\n--b${level}\nContent-Type: text/plain\n\nx\n--b${level}\n`;
    close = `\n--b${level}--\n${close}`;
  }
  return `${open}Content-Type: text/plain\n\n${'y'.repeat(size)}${close}`;
}

describe('text kept per nesting level (not in Python)', () => {
  it('refuses a message/rfc822 chain that expands past the limit', async () => {
    // 246 levels of 20 MiB retained 4.9 GB: a flat copy per level.
    await expect(
      parseReportEmail(rfc822Chain(246, 3 * MIB), { offline: true }),
    ).rejects.toThrow(EmailTooLargeError);
  });

  it('refuses nested attachments that expand past the limit', async () => {
    // 900 levels of 5 MiB took 4.5 GiB and killed the process.
    await expect(
      parseReportEmail(attachmentChain(900, MIB), { offline: true }),
    ).rejects.toThrow(
      'exceeds the 536870912 character limit (max_expanded_email_size)',
    );
  });

  it('counts text outside Latin-1 twice, as it takes twice the memory', async () => {
    // A 3 MB failure sample of U+4E2D nested 490 levels deep held 2 GB:
    // the limit counted characters, half the memory they took.
    const feedback =
      'Feedback-Type: auth-failure\nVersion: 1\nUser-Agent: x\nAuth-Failure: dmarc\nSource-IP: 192.0.2.1\nReported-Domain: example.com\nArrival-Date: Mon, 1 Jan 2024 00:00:00 +0000\n';
    const failureEmail = (text: string): string =>
      `From: a@b.c\nSubject: r\nContent-Type: multipart/report; report-type=feedback-report; boundary=o\n\n--o\nContent-Type: message/feedback-report\n\n${feedback}\n--o\nContent-Type: text/rfc822-headers\n\n${'Content-Type: message/rfc822\nContent-Disposition: attachment\n\n'.repeat(10)}From: a@b.c\nSubject: s\nContent-Type: text/plain; charset=utf-8\n\n${text.repeat(10_000)}\n--o--\n`;
    const options = { offline: true, maxExpandedEmailSize: 150_000 };
    await expect(
      parseReportEmail(failureEmail('x'), options),
    ).resolves.toMatchObject({ reportType: 'failure' });
    await expect(
      parseReportEmail(failureEmail('\u4E2D'), options),
    ).rejects.toThrow('(max_expanded_email_size)');
  });

  it('lets go of each level of a chain once it is read', async () => {
    const remove = vi.spyOn(FlattenCache.prototype, 'delete');
    await expect(
      parseReportEmail(rfc822Chain(40, 1000), { offline: true }),
    ).rejects.toThrow('is not a valid report');
    expect(remove).toHaveBeenCalledTimes(40);
    remove.mockRestore();
  });

  it('accepts a large part nested a few levels deep, or any with no limit', async () => {
    for (const text of [rfc822Chain(4, 49 * MIB), nested(4, 49 * MIB)]) {
      await expect(parseReportEmail(text, { offline: true })).rejects.toThrow(
        'is not a valid report',
      );
    }
    await expect(
      parseReportEmail(rfc822Chain(20, 30 * MIB), {
        offline: true,
        maxExpandedEmailSize: 0,
      }),
    ).rejects.toThrow('is not a valid report');
  });

  it('gives nested attachments the text of their parts, shared', () => {
    const { attachments } = MailParser.fromString(attachmentChain(3, 10));
    const leaf = `Content-Type: text/plain\n\n${'y'.repeat(10)}`;
    const text = 'Content-Type: text/plain\n\nx';
    const inner = (level: number): string =>
      `Content-Type: multipart/mixed; boundary="b${level}"\nContent-Disposition: attachment\n\n--b${level}\n${text}\n--b${level}\n${level === 2 ? leaf : inner(level + 1)}\n--b${level}--\n`;
    expect(attachments.map(attachment => attachment.payload)).toEqual([
      `${text}${inner(1)}`,
      `${text}${inner(2)}`,
      `${text}${leaf}`,
    ]);
  });
});

describe('NFC normalization', () => {
  const body = (text: string): string =>
    MailParser.fromString(
      `Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${Buffer.from(text).toString('base64')}\n`,
    ).body;

  it('leaves alone a run of marks long enough to be quadratic', () => {
    // ICU's insertion sort: 80,000 marks took 26 s, 1 MiB of base64 hours.
    const marks = `${'\u0300'.repeat(200_000)}${'\u0316'.repeat(200_000)}`;
    const start = process.cpuUsage();
    expect(body(`a${marks}`)).toBe(`a${marks}`);
    expect(cpuMsSince(start)).toBeLessThan(2000);
  });

  it('normalizes like Python up to 128 marks in a row', () => {
    // unicodedata.normalize("NFC", ...): U+0316 sorts before U+0300, and
    // U+0300 composes with the base.
    const run = `${'\u0300'.repeat(64)}${'\u0316'.repeat(64)}`;
    expect(body(`a${run}`)).toBe(
      `\u00e0${'\u0316'.repeat(64)}${'\u0300'.repeat(63)}`,
    );
    expect(body('e\u0301 caf\u0065\u0301')).toBe('\u00e9 caf\u00e9');
    expect(body(`a${run}b${run}`)).not.toContain('a\u0300');
  });
});

describe('FeedParser', () => {
  it('reads a parent header list once, not once per child', () => {
    // Within the default limits, 90,000 junk headers before Content-Type
    // and 9,000 children took 20 s: every child asked for the parent's
    // content type.
    const count = 9000;
    const junk = 'x:\n'.repeat(90_000);
    const blocks = `${junk}Content-Type: message/delivery-status\n\n${'x: y\n\n'.repeat(count)}`;
    const parts = `${junk}Content-Type: multipart/mixed; boundary=b\n\n${'--b\n\nx\n'.repeat(count)}--b--\n`;
    const start = process.cpuUsage();
    const delivery = messageFromString(blocks);
    const multipart = messageFromString(parts);
    expect(cpuMsSince(start)).toBeLessThan(1500);
    expect(delivery.getPayload()).toHaveLength(count);
    expect(multipart.getPayload()).toHaveLength(count);
  });

  it('still gives the children of a multipart/digest message/rfc822', () => {
    const message = messageFromString(
      'Content-Type: multipart/digest; boundary=b\n\n--b\n\nx\n--b\nContent-Type: text/plain\n\ny\n--b--\n',
    );
    const [first, second] = message.getPayload() as Message[];
    expect(first?.getContentType()).toBe('message/rfc822');
    expect(second?.getContentType()).toBe('text/plain');
  });
});

describe('transfer decoding', () => {
  const decoded = (cte: string, body: string): Uint8Array | null =>
    messageFromString(
      `Content-Transfer-Encoding: ${cte}\n\n${body}`,
    ).getDecodedPayload();

  it('decodes base64 made of line endings without a view per line', () => {
    // 20 MiB of them exhausted a 2 GiB heap.
    const body = '\n'.repeat(12 * MIB);
    const start = process.cpuUsage();
    expect(decoded('base64', body)).toEqual(new Uint8Array(0));
    expect(cpuMsSince(start)).toBeLessThan(700);
  });

  it('skips every kind of line ending in base64, like Python', () => {
    expect(
      Buffer.from(decoded('base64', 'aGk\r\n\r\rh\n') ?? []).toString(),
    ).toBe('hi!');
  });

  it('decodes real uuencode like Python', () => {
    const body = 'begin 644 f\n#86)C\n`\nend\n';
    expect(Buffer.from(decoded('x-uuencode', body) ?? []).toString()).toBe(
      'abc',
    );
    expect(
      Buffer.from(
        decoded('uue', 'text first\nbegin 644 f\n#86)C\nend\nafter') ?? [],
      ).toString(),
    ).toBe('abc');
  });

  it('does not let short uuencode lines decode to more than the input', () => {
    // Each `M\n` promises 45 bytes: 20 MiB exhausted a 2 GiB heap.
    const body = `begin 644 f\n${'M\n'.repeat(1000)}end\n`;
    expect(Buffer.from(decoded('uuencode', body) ?? []).toString()).toBe(body);
  });

  it('keeps uuencode and base64 of short lines within the input size', () => {
    // A line of `_` promised 63 bytes for 2, and every line of base64 or
    // uuencode was an object: a message under 50 MiB aborted the process.
    for (const line of ['_\n', '_\r', '`\n']) {
      const body = `begin 644 a\n${line.repeat(100_000)}end\n`;
      expect(
        (decoded('x-uuencode', body) ?? new Uint8Array(0)).length,
      ).toBeLessThanOrEqual(body.length);
    }
    const start = process.cpuUsage();
    const base64 = decoded('base64', `QUJD\r\nREVG\r${'\n'.repeat(8 * MIB)}`);
    expect(Buffer.from(base64 ?? []).toString()).toBe('ABCDEF');
    expect(cpuMsSince(start)).toBeLessThan(1000);
  });
});

describe('address headers', () => {
  const parse = (field: string): MailParser =>
    MailParser.fromString(`From: a@b\nTo: ${field}\nSubject: s\n\nb\n`);
  const groups = (depth: number): string => `[${':a'.repeat(depth)}] <b@c>`;
  const comments = (depth: number): string =>
    `[${'('.repeat(depth)}${')'.repeat(depth)}] <b@c>`;

  it('fails on nesting where mail-parser does, not with a stack overflow', () => {
    // Measured with mail-parser 4.8.0 on Python 3.14: groups fail at 979.
    expect(() => parse(groups(978))).not.toThrow();
    expect(() => parse(groups(982))).toThrow(MailParserRecursionError);
    expect(() => parse(comments(490))).not.toThrow();
    expect(() => parse(comments(491))).toThrow(MailParserRecursionError);
    for (const field of [groups(40_000), comments(40_000)]) {
      expect(() => parse(field)).toThrow(MailParserRecursionError);
    }
  });

  it('takes linear time on many addresses inside nested groups', () => {
    const field = `[${':a'.repeat(900)}:${'x,'.repeat(MIB / 2)}x] <b@c>`;
    const start = process.cpuUsage();
    parse(field);
    expect(cpuMsSince(start)).toBeLessThan(3000);
  });

  it('takes linear time on text inside nested comments', () => {
    const field = `[${'(x'.repeat(480)}${'y'.repeat(4 * MIB)}${')'.repeat(480)}] <b@c>`;
    const start = process.cpuUsage();
    parse(field);
    expect(cpuMsSince(start)).toBeLessThan(5000);
  });

  it('reports a defect per invalid address, however many', () => {
    const count = 300_000;
    expect(
      parse('@,'.repeat(count)).addressHeaderDefects.length,
    ).toBeGreaterThanOrEqual(count);
  });
});
