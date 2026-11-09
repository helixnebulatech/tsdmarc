// Port of mail-parser 4.8.0 Received-header parsing (`received.py` and the
// `parse_received` / `receiveds_parsing` / `receiveds_format` helpers of
// `utils.py`).

import { PY_WS_CLASS, pySplitWhitespace, pyStrip } from '../py-str';
import {
  type DateDiagnostic,
  dateDiagnostics,
  parseMailDate,
  type UtcDateTime,
  utcIsoformat,
} from './dates';
import { MailParserError } from './exceptions';

/** mail-parser's `MailParserReceivedParsingError`. */
export class MailParserReceivedParsingError extends MailParserError {
  override name = 'MailParserReceivedParsingError';
}

const FWS = ' \t\r\n';
const KEYWORD =
  /(from|by|via|with|id|for|envelope-from|envelope-sender)(?=[ \t\r\n])/iuy;
const SENDGRID_DATE = new RegExp(
  `(\\p{Nd}{4}-\\p{Nd}{2}-\\p{Nd}{2}[${PY_WS_CLASS}]+\\p{Nd}{2}:\\p{Nd}{2}:\\p{Nd}{2}\\.\\p{Nd}{9}[${PY_WS_CLASS}]+\\+0000[${PY_WS_CLASS}]+UTC)[${PY_WS_CLASS}]+m=\\+\\p{Nd}+\\.\\p{Nd}+`,
  'iuy',
);
const DIGIT = /^\p{Nd}$/u;
const ENVELOPE_FROM = /<([^>]+)>/u;

/** A recovery diagnostic of the Received parser. */
export interface ReceivedDiagnostic {
  reason: string;
  recovered: boolean;
  raw?: string;
  header?: string;
  occurrence?: number;
}

/** One parsed Received hop, as mail-parser builds it. */
export type ReceivedHop = Record<string, string | number | null>;

// Collapse formatting whitespace outside quoted strings (`_clause_value`).
function clauseValue(value: string): string {
  let output = '';
  let quoted = false;
  let escaped = false;
  let whitespace = false;
  for (const char of pyStrip(value, FWS)) {
    if (FWS.includes(char) && !quoted) {
      whitespace = true;
      continue;
    }
    if (whitespace) {
      output += ' ';
      whitespace = false;
    }
    output += char;
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    }
  }
  return output;
}

type Boundary = [index: number, start: number, keyword: string];

/** `split_received()`: top-level clauses and the date. */
export function splitReceived(
  value: string,
  defects?: ReceivedDiagnostic[],
): [clauses: [string, string][], date: string | null] {
  let boundaries: Boundary[] = [];
  let comment = 0;
  let quote = false;
  let literal = false;
  let angle = false;
  let escaped = false;
  const separators: number[] = [];
  let sendgrid: RegExpExecArray | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (comment) {
      if (char === '\\') {
        escaped = true;
      } else if (char === '(') {
        comment += 1;
      } else if (char === ')') {
        comment -= 1;
      }
      continue;
    }
    if (quote || literal) {
      if (char === '\\') {
        escaped = true;
      } else if (quote && char === '"') {
        quote = false;
      } else if (literal && char === ']') {
        literal = false;
      }
      continue;
    }
    if (char === '(') {
      comment = 1;
    } else if (char === ')') {
      throw new MailParserReceivedParsingError('unexpected-comment-close');
    } else if (char === '"') {
      quote = true;
    } else if (char === '[') {
      literal = true;
    } else if (char === '<') {
      if (angle) {
        throw new MailParserReceivedParsingError('nested-angle-address');
      }
      angle = true;
    } else if (char === '>') {
      angle = false;
    } else if (!angle) {
      if (char === ';') {
        separators.push(index);
      } else if (
        separators.length === 0 &&
        (index === 0 || `${FWS})`.includes(value.charAt(index - 1)))
      ) {
        KEYWORD.lastIndex = index;
        const match = KEYWORD.exec(value);
        if (match) {
          const keyword = (match[1] ?? '').toLowerCase();
          const matchEnd = index + match[0].length;
          let end = matchEnd;
          while (end < value.length && FWS.includes(value.charAt(end))) {
            end += 1;
          }
          // Keep the MTA TLS annotation "with cipher" inside the clause.
          if (
            keyword !== 'with' ||
            !value
              .slice(end, end + 6)
              .toLowerCase()
              .startsWith('cipher')
          ) {
            boundaries.push([index, matchEnd, keyword]);
          }
        } else if (DIGIT.test(char) && sendgrid === null) {
          SENDGRID_DATE.lastIndex = index;
          sendgrid = SENDGRID_DATE.exec(value);
        }
      }
    }
  }
  const unclosed: [boolean, string][] = [
    [comment > 0, 'unclosed-comment'],
    [quote, 'unclosed-quoted-string'],
    [literal, 'unclosed-domain-literal'],
    [angle, 'unclosed-angle-address'],
  ];
  for (const [isUnclosed, reason] of unclosed) {
    if (isUnclosed) {
      throw new MailParserReceivedParsingError(reason);
    }
  }
  let end = value.length;
  let date: string | null = null;
  let extraClause: [string, string] | null = null;
  const [firstSeparator, secondSeparator] = separators;
  if (firstSeparator !== undefined) {
    end = firstSeparator;
    date = pyStrip(value.slice(end + 1), FWS);
    if (secondSeparator !== undefined) {
      // Recover only "id token; for <recipient>; date".
      const middle = pyStrip(value.slice(end + 1, secondSeparator), FWS);
      const parts = pySplitWhitespace(middle, 1);
      if (separators.length !== 2 || parts.length !== 2) {
        throw new MailParserReceivedParsingError('ambiguous-date-separators');
      }
      const [first = '', second = ''] = parts;
      if (
        boundaries.length === 0 ||
        boundaries.at(-1)?.[2] !== 'id' ||
        first.toLowerCase() !== 'for' ||
        !second.startsWith('<') ||
        !second.endsWith('>')
      ) {
        throw new MailParserReceivedParsingError('ambiguous-date-separators');
      }
      extraClause = ['for', clauseValue(second)];
      date = pyStrip(value.slice(secondSeparator + 1), FWS);
      defects?.push({ reason: 'misplaced-date-separator', recovered: true });
    }
  } else if (sendgrid !== null) {
    end = sendgrid.index;
    date = sendgrid[1] ?? '';
    const sendgridStart = sendgrid.index;
    boundaries = boundaries.filter(([index]) => index < sendgridStart);
  }
  const clauses: [string, string][] = [];
  for (const [position, [, start, keyword]] of boundaries.entries()) {
    const stop = boundaries[position + 1]?.[0] ?? end;
    clauses.push([keyword, clauseValue(value.slice(start, stop))]);
  }
  if (extraClause !== null) {
    clauses.push(extraClause);
  }
  return [clauses, date];
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

/**
 * The text up to its last `>`. A `<([^>]+)>` match ends at or before it,
 * so searching this prefix finds the same match; it keeps a backtracking
 * engine linear, since a `<` can no longer scan to the end and fail.
 */
function upToLastAngle(text: string): string {
  return text.slice(0, text.lastIndexOf('>') + 1);
}

/** `parse_received()`. */
export function parseReceived(
  received: string,
  defects?: ReceivedDiagnostic[],
): Map<string, string> {
  const values = new Map<string, string>();
  const [clauses, date] = splitReceived(received, defects);
  if (date !== null) {
    values.set('date', date);
  }
  for (const [keyword, value] of clauses) {
    if (keyword === 'envelope-from' || keyword === 'envelope-sender') {
      const match = ENVELOPE_FROM.exec(upToLastAngle(value));
      if (match) {
        values.set(keyword.replace('-', '_'), match[1] ?? '');
      }
    } else if (keyword === 'from') {
      if (!values.has('from')) {
        values.set(keyword, value);
      }
    } else {
      values.set(keyword, value);
    }
  }
  // Some MTAs put envelope-from inside a comment of another clause.
  for (const clauseKey of ['by', 'from', 'with']) {
    const clauseVal = values.get(clauseKey) ?? '';
    for (const [envKey, envName] of [
      ['envelope_from', 'envelope-from'],
      ['envelope_sender', 'envelope-sender'],
    ] as const) {
      if (!values.has(envKey) && clauseVal.toLowerCase().includes(envName)) {
        const pattern = new RegExp(
          `${envName.replace(REGEX_SPECIAL, '\\$&')}[${PY_WS_CLASS}]+<([^>]+)>`,
          'iu',
        );
        const match = pattern.exec(upToLastAngle(clauseVal));
        if (match) {
          values.set(envKey, match[1] ?? '');
        }
      }
    }
  }
  if (values.size === 0) {
    throw new MailParserReceivedParsingError(
      `Unable to match any clauses in ${received}`,
    );
  }
  return values;
}

interface ParsedHop {
  values: Map<string, string>;
}

/** `receiveds_parsing()` followed by `receiveds_format()`. */
export function receivedsParsing(
  receiveds: readonly string[],
  defects?: ReceivedDiagnostic[],
  dateDefects?: DateDiagnostic[],
): ReceivedHop[] {
  const parsed: ParsedHop[] = [];
  for (const [index, received] of receiveds.entries()) {
    const diagnostics: ReceivedDiagnostic[] = [];
    try {
      parsed.push({ values: parseReceived(received, diagnostics) });
    } catch (error) {
      if (!(error instanceof MailParserReceivedParsingError)) {
        throw error;
      }
      parsed.push({ values: new Map([['raw', received]]) });
      if (!error.message.startsWith('Unable to match any clauses')) {
        diagnostics.push({ reason: error.message, recovered: false });
      }
    }
    if (defects !== undefined) {
      for (const defect of diagnostics) {
        defect.raw = received;
        defect.header = 'received';
        defect.occurrence = index;
        defects.push(defect);
      }
    }
  }
  return receivedsFormat(parsed, receiveds, dateDefects);
}

function receivedsFormat(
  receiveds: readonly ParsedHop[],
  rawHeaders: readonly string[],
  dateDefects?: DateDiagnostic[],
): ReceivedHop[] {
  const output: Record<string, string | number | null>[] = [];
  const utcValues: (UtcDateTime | null | undefined)[] = [];
  let hop = 0;
  for (
    let occurrence = receiveds.length - 1;
    occurrence >= 0;
    occurrence -= 1
  ) {
    const { values } = receiveds[occurrence] ?? { values: new Map() };
    const entry: Record<string, string | number | null> = {};
    for (const [key, value] of values) {
      if (value) {
        entry[key] = key === 'raw' ? value : pyStrip(value);
      }
    }
    entry.hop = hop + 1;
    let now: UtcDateTime | null | undefined;
    const date = values.get('date');
    if (date !== undefined) {
      const result = parseMailDate(date);
      now = result.value;
      entry.date_utc = null;
      dateDefects?.push(
        ...dateDiagnostics(
          result,
          rawHeaders[occurrence] ?? date,
          'received',
          occurrence,
        ),
      );
    }
    if (output.length > 0 && now) {
      const before = utcValues[hop - 1];
      entry.delay = before ? (now.epochMs - before.epochMs) / 1000 : 0;
    } else {
      entry.delay = 0;
    }
    if (now) {
      entry.date_utc = utcIsoformat(now);
    }
    output.push(entry);
    utcValues.push(now);
    hop += 1;
  }
  return output;
}
