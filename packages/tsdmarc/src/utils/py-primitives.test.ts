// Replays CPython / mail-parser outputs (tools/fixtures/generate_py_primitives.py)
// against the ports in py-binascii, py-codecs, py-email and mailparser.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseAddressHeader } from './mailparser/addresses';
import { parseMailDate, utcIsoformat } from './mailparser/dates';
import { a2bBase64, a2bQp, a2bUu, b64decode } from './py-binascii';
import { pyDecode } from './py-codecs';
import { decodeHeader } from './py-email/header';
import { getaddresses } from './py-email/utils';

interface Outcome {
  hex?: string;
  value?: string;
  error?: string;
  message?: string;
}

interface Primitives {
  base64: { input: string; lenient: Outcome; strict: Outcome }[];
  qp: { input: string; body: Outcome; header: Outcome }[];
  uu: { input: string; output: Outcome }[];
  codecs: ({ codec: string; input: string } & Record<
    'strict' | 'replace' | 'ignore',
    Outcome
  >)[];
  decode_header: {
    input: string;
    chunks?: [string | { hex: string }, string | null][];
    error?: string;
  }[];
  addresses: {
    input: string;
    decode_names?: boolean;
    parsed?: [string, string][];
    diagnostics?: unknown[];
    getaddresses?: [string, string][];
  }[];
  dates: {
    input: string;
    value: string | null;
    timezone: string | number;
    reasons: string[];
  }[];
}

const FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '__fixtures__', 'py-primitives.json'),
    'utf8',
  ),
) as Primitives;

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function run(expected: Outcome, action: () => Uint8Array | string): void {
  if (expected.error !== undefined) {
    expect(action).toThrow();
    return;
  }
  const result = action();
  if (typeof result === 'string') {
    expect(result).toBe(expected.value);
  } else {
    expect(toHex(result)).toBe(expected.hex);
  }
}

function runBinascii(expected: Outcome, action: () => Uint8Array): void {
  if (expected.error !== undefined) {
    expect(action).toThrow(expected.message);
    return;
  }
  expect(toHex(action())).toBe(expected.hex);
}

describe('binascii', () => {
  it('names its error like type(binascii.Error()).__name__', () => {
    // parsedmarc callers that print `type(e).__name__` show "Error".
    expect(() => b64decode('ab')).toThrow(
      expect.objectContaining({ name: 'Error', message: 'Incorrect padding' }),
    );
  });

  it.each(FIXTURE.base64.map(c => [c.input, c] as const))(
    'a2b_base64(%s)',
    (_, item) => {
      runBinascii(item.lenient, () => a2bBase64(fromHex(item.input)));
      runBinascii(item.strict, () => a2bBase64(fromHex(item.input), true));
    },
  );

  it.each(FIXTURE.qp.map(c => [c.input, c] as const))(
    'a2b_qp(%s)',
    (_, item) => {
      runBinascii(item.body, () => a2bQp(fromHex(item.input)));
      runBinascii(item.header, () => a2bQp(fromHex(item.input), true));
    },
  );

  it.each(FIXTURE.uu.map(c => [c.input, c] as const))(
    'a2b_uu(%s)',
    (_, item) => {
      runBinascii(item.output, () => a2bUu(fromHex(item.input)));
    },
  );
});

describe('codecs', () => {
  it.each(FIXTURE.codecs.map(c => [`${c.codec}:${c.input}`, c] as const))(
    'decode %s',
    (_, item) => {
      for (const errors of ['strict', 'replace', 'ignore'] as const) {
        run(item[errors], () =>
          pyDecode(fromHex(item.input), item.codec, errors),
        );
      }
    },
  );
});

describe('email.header.decode_header', () => {
  it.each(FIXTURE.decode_header.map(c => [c.input, c] as const))(
    '%s',
    (_, item) => {
      if (item.error !== undefined) {
        expect(() => decodeHeader(item.input)).toThrow();
        return;
      }
      const chunks = decodeHeader(item.input).map(([data, charset]) => [
        typeof data === 'string' ? data : { hex: toHex(data) },
        charset,
      ]);
      expect(chunks).toEqual(item.chunks);
    },
  );
});

describe('addresses', () => {
  it.each(
    FIXTURE.addresses.map((c, index) => [`${index}: ${c.input}`, c] as const),
  )('%s', (_, item) => {
    if (item.getaddresses !== undefined) {
      expect(getaddresses([item.input])).toEqual(item.getaddresses);
      return;
    }
    const [parsed, diagnostics] = parseAddressHeader(
      item.input,
      item.decode_names ?? false,
    );
    expect(parsed).toEqual(item.parsed);
    expect(diagnostics).toEqual(item.diagnostics);
  });
});

describe('mail-parser dates', () => {
  it.each(FIXTURE.dates.map(c => [c.input, c] as const))('%s', (_, item) => {
    const result = parseMailDate(item.input);
    expect(result.value === null ? null : utcIsoformat(result.value)).toBe(
      item.value,
    );
    expect(result.timezone).toBe(item.timezone);
    expect(result.reasons).toEqual(item.reasons);
  });
});
