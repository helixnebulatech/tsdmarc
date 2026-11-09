// The feed parser's nesting limit and boundary matching, against Python's
// email.message_from_string() and mail-parser 4.8.0 (Python 3.14 venv).

import { describe, expect, it } from 'vitest';

import { DEFAULT_EMAIL_LIMITS } from '../../config';
import { EmailTooLargeError } from '../../errors';
import { MAIL_PARSER_MAX_NESTING, MailParser } from '../mailparser/core';
import {
  MailParserError,
  MailParserRecursionError,
} from '../mailparser/exceptions';
import { RecursionError } from './errors';
import type { Message } from './message';
import { MESSAGE_FROM_STRING_MAX_NESTING, messageFromString } from './parser';

/** CPU milliseconds since `start`: a loaded machine doesn't make bounds flaky. */
function cpuMsSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}

/** A message nested `depth` levels deep (multipart, or message/rfc822). */
function nested(
  depth: number,
  kind: 'multipart' | 'rfc822' = 'multipart',
): string {
  const parts = ['From: a@b.c\n'];
  for (let level = 0; level < depth; level += 1) {
    parts.push(
      kind === 'multipart'
        ? `Content-Type: multipart/mixed; boundary=B${level}\n\n--B${level}\n`
        : 'Content-Type: message/rfc822\n\n',
    );
  }
  parts.push('Content-Type: text/plain\n\nx\n');
  return parts.join('');
}

function depthOf(text: string): number {
  let depth = 0;
  let message = messageFromString(text);
  for (;;) {
    const payload = message.getPayload();
    const child = Array.isArray(payload) ? payload[0] : undefined;
    if (child === undefined) {
      return depth;
    }
    depth += 1;
    message = child;
  }
}

describe('nesting limit', () => {
  it.each(['multipart', 'rfc822'] as const)(
    'message_from_string parses 987 %s levels and raises RecursionError at 988',
    kind => {
      // Python 3.14, top-level call: 987 ok, 988 RecursionError.
      expect(MESSAGE_FROM_STRING_MAX_NESTING).toBe(987);
      expect(depthOf(nested(987, kind))).toBe(987);
      expect(() => messageFromString(nested(988, kind))).toThrow(
        RecursionError,
      );
      expect(() => messageFromString(nested(988, kind))).toThrow(
        'maximum recursion depth exceeded',
      );
    },
  );

  it.each(['multipart', 'rfc822'] as const)(
    'mail-parser parses 983 %s levels and raises MailParserRecursionError at 984',
    kind => {
      // mailparser.parse_from_string(), top-level call: 983 ok, 984 fails.
      expect(MAIL_PARSER_MAX_NESTING).toBe(983);
      expect(MailParser.fromString(nested(983, kind)).message).toBeDefined();
      let caught: unknown;
      try {
        MailParser.fromString(nested(984, kind));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MailParserRecursionError);
      expect(caught).toBeInstanceOf(MailParserError);
      expect((caught as Error).message).toBe(
        'Message nesting too deep to parse (possible malicious multipart structure)',
      );
      expect((caught as Error).cause).toBeInstanceOf(RecursionError);
    },
  );

  it('rejects a 20,000-level multipart bomb quickly', () => {
    // Before the limit, 10,000 levels took ~8 s and then overflowed the
    // stack (RangeError); Python rejects 20,000 levels in ~0.3 s.
    const text = nested(20_000);
    const start = process.cpuUsage();
    expect(() => MailParser.fromString(text)).toThrow(MailParserRecursionError);
    expect(() => messageFromString(text)).toThrow(RecursionError);
    expect(cpuMsSince(start)).toBeLessThan(2000);
  });

  it('checks boundaries in constant time per line', () => {
    // 900 open boundaries over a 100,000-line body: every line used to be
    // tried against every boundary (33 s here, 32 s in Python).
    const text = `${nested(900).slice(0, -'x\n'.length)}${'--line\n'.repeat(100_000)}`;
    const start = process.cpuUsage();
    expect(depthOf(text)).toBe(900);
    expect(cpuMsSince(start)).toBeLessThan(3000);
  });
});

// [input, msg.as_string() (random boundary normalized), defects, content types]
const BOUNDARY_CASES: [string, string, string[], string[]][] = [
  [
    'Content-Type: multipart/mixed; boundary="B--"\n\npre\n--B--\nContent-Type: text/plain\n\na\n--B----\nepi\n',
    'Content-Type: multipart/mixed; boundary="B--"\n\npre\n--B--\nContent-Type: text/plain\n\na\n--B----\nepi\n',
    [],
    ['multipart/mixed', 'text/plain'],
  ],
  [
    'Content-Type: multipart/mixed; boundary="B"\n\n--B \t\nContent-Type: text/plain\n\na\n--B-- \t\r\nepi\n',
    'Content-Type: multipart/mixed; boundary="B"\n\n--B\nContent-Type: text/plain\n\na\n--B--\nepi\n',
    [],
    ['multipart/mixed', 'text/plain'],
  ],
  [
    'Content-Type: multipart/mixed; boundary="O"\n\n--O\nContent-Type: multipart/mixed; boundary="I"\n\n--I\n\nin\n--O\n\nnext\n--I--\n--O--\n',
    'Content-Type: multipart/mixed; boundary="O"\n\n--O\nContent-Type: multipart/mixed; boundary="I"\n\n--I\n\nin\n--I--\n\n--O\n\nnext\n--I--\n--O--\n',
    ['CloseBoundaryNotFoundDefect'],
    ['multipart/mixed', 'multipart/mixed', 'text/plain', 'text/plain'],
  ],
  [
    'Content-Type: multipart/mixed; boundary=""\n\n--\n\na\n----\n',
    'Content-Type: multipart/mixed; boundary="BOUNDARY"\n\n--BOUNDARY\n\na\n--BOUNDARY--\n',
    [],
    ['multipart/mixed', 'text/plain'],
  ],
  [
    'Content-Type: multipart/mixed; boundary="X"\n\n--X\n\na\n--Xy\nb\n--X--x\n--X--\n',
    'Content-Type: multipart/mixed; boundary="X"\n\n--X\n\na\n--Xy\nb\n--X--x\n--X--\n',
    [],
    ['multipart/mixed', 'text/plain'],
  ],
  [
    'Content-Type: multipart/report; boundary="R"\n\n--R\nContent-Type: message/delivery-status\n\nA: 1\n\nB: 2\n--R\n\nz\n--R--\n',
    'Content-Type: multipart/report; boundary="R"\n\n--R\nContent-Type: message/delivery-status\n\nA: 1\n\nB: 2\n\n--R\n\nz\n--R--\n',
    [],
    [
      'multipart/report',
      'message/delivery-status',
      'text/plain',
      'text/plain',
      'text/plain',
    ],
  ],
];

describe('boundary matching', () => {
  it.each(BOUNDARY_CASES)(
    'matches Python for %j',
    (input, expected, defects, types) => {
      const message = messageFromString(input);
      const parts = [...message.walk()];
      expect(parts.map(part => part.getContentType())).toEqual(types);
      expect(
        parts.flatMap(part => part.defects.map(defect => defect.name)),
      ).toEqual(defects);
      expect(message.asString().replaceAll(/={15}\d{19}==/gu, 'BOUNDARY')).toBe(
        expected,
      );
    },
  );
});

describe('generator errors', () => {
  it('quotes the folded header with repr() like Python', () => {
    const message = messageFromString('From: a@b.c\n\nbody\n');
    message.set('X', 'a\nb\u001B');
    expect(() => message.asString()).toThrow(
      String.raw`folded header contains newline: 'X: a\nb\x1b\n'`,
    );
  });
});

describe('encoded-word charsets', () => {
  it.each(['ut\0f-8', 'utf-8\0', '\0'])(
    'raises ValueError for a NUL in the charset name (%j), like Python',
    charset => {
      // Python: bytes.decode() rejects the codec name with
      // ValueError('embedded null character') before mail-parser's
      // LookupError fallback, so parse_from_string() fails.
      const text = `From: a@b.c\nSubject: =?${charset}?q?abc?= tail\n\nbody\n`;
      expect(() => MailParser.fromString(text)).toThrow(
        'embedded null character',
      );
    },
  );
});

describe('structure limits (not in Python)', () => {
  const parse = (text: string, limits = {}) =>
    messageFromString(text, MESSAGE_FROM_STRING_MAX_NESTING, {
      ...DEFAULT_EMAIL_LIMITS,
      ...limits,
    });
  const DSN = 'Content-Type: message/delivery-status\n\n';

  it('counts the blank lines of a message/delivery-status as parts', () => {
    // Each one makes a Message: 20 MiB of them exhausted a 2 GiB heap.
    expect(() => parse(`${DSN}${'\n'.repeat(1_000_000)}`)).toThrow(
      new EmailTooLargeError(
        'Email has more than 10000 MIME parts (max_mime_parts)',
      ),
    );
  });

  it('counts multipart parts delimited by lone CRs', () => {
    const text = `Content-Type: multipart/mixed; boundary=x\n\n${'--x\ra: b\r\rc\r'.repeat(20_000)}--x--\r`;
    expect(() => parse(text)).toThrow(EmailTooLargeError);
  });

  it('counts header lines, whatever they turn into', () => {
    for (const line of ['a:\n', ':\n', ' \n', 'a: b\n c\n']) {
      expect(() => parse(`${line.repeat(100_001)}\nbody\n`)).toThrow(
        new EmailTooLargeError(
          'Email has more than 100000 header lines (max_header_lines)',
        ),
      );
    }
  });

  it('parses up to the limits, and without them when they are 0', () => {
    const blanks = 5000;
    expect(parse(`${DSN}${'\n'.repeat(blanks)}`).getPayload()).toHaveLength(
      blanks,
    );
    const noLimits = { maxMimeParts: 0, maxHeaderLines: 0 };
    expect(
      parse(`${DSN}${'\n'.repeat(20_000)}`, noLimits).getPayload(),
    ).toHaveLength(20_000);
    expect(
      parse(`${'a: b\n'.repeat(200_000)}\nbody\n`, noLimits).getPayload(),
    ).toBe('body\n');
  });
});

describe('large inputs', () => {
  it('reads an epilogue of any number of lines', () => {
    // `push(...lines)` overflowed the call stack, on a valid message.
    const lines = 500_000;
    const message = messageFromString(
      `Content-Type: multipart/mixed; boundary=x\n\n--x\n\nb\n--x--\n${'\n'.repeat(lines)}`,
    );
    expect(message.epilogue).toBe('\n'.repeat(lines));
  });

  it('keeps every line ending of a body read without its lines', () => {
    const body = 'a\r\nb\rc\n\r\n--y\n--\n-\nend';
    const multipart = `Content-Type: multipart/mixed; boundary=x\n\n--x\n\n${body}\n--x\n\nz\n--x--\n--tail`;
    const parts = messageFromString(multipart).getPayload() as Message[];
    expect(parts.map(part => part.getPayload())).toEqual([body, 'z']);
    expect(messageFromString(multipart).epilogue).toBe('--tail');
    expect(messageFromString(`a: b\n\n${body}`).getPayload()).toBe(body);
    // No line ending after the close boundary, so no epilogue.
    expect(
      messageFromString(
        'Content-Type: multipart/mixed; boundary=x\n\n--x\n\nb\n--x--',
      ).epilogue,
    ).toBe('');
  });

  it('walks a wide part at the bottom of a deep chain in linear time', () => {
    // Every message used to pass through a generator per ancestor.
    const depth = 900;
    const blanks = 300_000;
    const text = `${'Content-Type: message/rfc822\n\n'.repeat(depth)}Content-Type: message/delivery-status\n\n${'\n'.repeat(blanks)}`;
    const message = messageFromString(text, depth + 1, {
      ...DEFAULT_EMAIL_LIMITS,
      maxMimeParts: 0,
    });
    const start = process.cpuUsage();
    let count = 0;
    for (const _part of message.walk()) {
      count += 1;
    }
    expect(cpuMsSince(start)).toBeLessThan(1500);
    expect(count).toBe(depth + 1 + blanks);
  });
});
