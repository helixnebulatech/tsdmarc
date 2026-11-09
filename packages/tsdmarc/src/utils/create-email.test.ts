// createEmail() against the output of Python's mailsuite.utils.create_email
// (tools/fixtures/generate_create_email.py; boundary and Date normalized).

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createEmail, formatDate } from './create-email';

interface CreateEmailCase {
  from: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  headers?: Record<string, string>;
  /** `[filename, latin-1 content]` pairs. */
  att?: [string, string][];
  plain?: string;
  html?: string;
}

const fixture = JSON.parse(
  readFileSync(
    new URL('__fixtures__/create-email.json', import.meta.url),
    'utf8',
  ),
) as { cases: CreateEmailCase[]; expected: string[] };

const BOUNDARY = /={15}\d{19}==/gu;
const DATE_HEADER = /^Date: .*$/mu;

function normalize(message: string): string {
  return message
    .replaceAll(BOUNDARY, 'BOUNDARY')
    .replace(DATE_HEADER, 'Date: DATE');
}

function run(testCase: CreateEmailCase): string {
  try {
    return normalize(
      createEmail({
        messageFrom: testCase.from,
        messageTo: testCase.to,
        messageCc: testCase.cc,
        subject: testCase.subject,
        messageHeaders: testCase.headers,
        attachments: (testCase.att ?? []).map(([name, content]) => [
          name,
          Uint8Array.from(content, char => char.charCodeAt(0)),
        ]),
        plainMessage: testCase.plain,
        htmlMessage: testCase.html,
      }),
    );
  } catch (error) {
    return `ERR ${(error as Error).name}: ${(error as Error).message}`;
  }
}

describe('createEmail', () => {
  it.each(
    fixture.cases.map((testCase, index) => ({
      testCase,
      expected: fixture.expected[index],
      label: testCase.subject ?? `case ${index}`,
    })),
  )('matches mailsuite for $label', ({ testCase, expected }) => {
    expect(run(testCase)).toBe(expected);
  });

  it('rejects header injection like Python (HeaderParseError)', () => {
    expect(() =>
      createEmail({
        messageFrom: 'a@example.com',
        subject: 'hi\nBcc: evil@x.org',
      }),
    ).toThrow(
      "header value appears to contain an embedded header: 'hi\\nBcc: evil@x.org'",
    );
  });

  it('test_cc_recipients: joins two Cc addresses', () => {
    const message = createEmail({
      messageFrom: 'a@example.com',
      messageTo: ['b@example.org'],
      messageCc: ['c@example.org', 'd@example.org'],
    });
    expect(message).toContain('Cc: c@example.org, d@example.org');
  });

  it('draws a fresh 19-digit boundary for every message', () => {
    const first = createEmail({ messageFrom: 'a@example.com' });
    const second = createEmail({ messageFrom: 'a@example.com' });
    const boundary = (text: string): string | undefined =>
      /boundary="(?<value>[^"]+)"/u.exec(text)?.groups?.value;
    expect(boundary(first)).toMatch(/^={15}\d{19}==$/u);
    expect(boundary(first)).not.toBe(boundary(second));
  });
});

describe('formatDate', () => {
  it('formats like email.utils.formatdate(localtime=True)', () => {
    // Tests run with TZ=UTC.
    expect(formatDate(new Date(Date.UTC(2026, 9, 24, 3, 4, 5)))).toBe(
      'Sat, 24 Oct 2026 03:04:05 +0000',
    );
  });
});
