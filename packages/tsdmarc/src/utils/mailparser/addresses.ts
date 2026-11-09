// Port of mail-parser 4.8.0 `mailparser/addresses.py`: structural address
// recovery for RFC 5322 / RFC 6532 header values, plus `get_addresses()`.
//
// Inputs here are always well-formed strings (the message was decoded from
// UTF-8 with replacement), so the surrogate checks of the original never
// fire; they are kept where they are cheap.

import { LookupError, pyDecode, UnicodeError } from '../py-codecs';
import { decodeHeader } from '../py-email/header';
import { type AddressPair, getaddresses } from '../py-email/utils';
import { PY_WS_CLASS, pyLen, pyStrip } from '../py-str';

const FOLD = /\r?\n[ \t]+/gu;
const ENCODED_WORD = new RegExp(
  `=\\?([^?${PY_WS_CLASS}]+)\\?([bBqQ])\\?([^?${PY_WS_CLASS}]*)\\?=`,
  'uy',
);
const UTF8_NON_ASCII = '\\u0080-\\ud7ff\\ue000-\\u{10ffff}';
const SURROGATE = /[\ud800-\udfff]/u;
const ATOM = `[a-zA-Z0-9!#$%&'*+/=?^_\`{|}~${UTF8_NON_ASCII}-]+`;
const QUOTED = '"(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*"';
const WORD = `(?:${ATOM}|${QUOTED})`;
const LOCAL = `${WORD}(?:[ \\t]*\\.[ \\t]*${WORD})*`;
const DOMAIN = `${ATOM}(?:[ \\t]*\\.[ \\t]*${ATOM})*`;
const LITERAL = '\\[(?:[^\\[\\]\\\\\\r\\n]|\\\\[^\\r\\n])*\\]';
const ADDR_SPEC = new RegExp(
  `^(?:${LOCAL}[ \\t]*@[ \\t]*(?:${DOMAIN}|${LITERAL}))$`,
  'u',
);
const FWS_CHARS = ' \t\r\n';

/** A diagnostic of the address scanner. */
export interface AddressDiagnostic {
  reason: string;
  raw: string;
  recovered: boolean;
  candidates: { display_name: string; address: string }[];
  header?: string;
  occurrence?: number;
}

interface Item {
  raw: string;
  text: string;
  angles: [number, number][];
  problems: string[];
  commentDepth: number;
}

function stripFws(text: string): string {
  return pyStrip(text, FWS_CHARS);
}

/** `_scan()`: split only at structural delimiters. */
function scan(raw: string): Item[] {
  const items: Item[] = [];
  let buf: string[] = [];
  let angles: [number, number][] = [];
  let problems: string[] = [];
  let start = 0;
  let angle: number | null = null;
  let comment = 0;
  let maxComment = 0;
  let quote = false;
  let literal = false;
  let escaped = false;
  let group = false;

  const emit = (end: number): void => {
    const text = buf.join('');
    const rawItem = raw.slice(start, end);
    if (stripFws(text) || problems.length > 0 || SURROGATE.test(rawItem)) {
      items.push({
        raw: rawItem,
        text,
        angles,
        problems,
        commentDepth: maxComment,
      });
    }
    buf = [];
    angles = [];
    problems = [];
    start = end + 1;
    maxComment = 0;
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw.charAt(index);
    if (escaped) {
      if (!comment) {
        buf.push(char);
      }
      escaped = false;
      continue;
    }
    if (char === '\\' && (quote || comment || literal)) {
      escaped = true;
      if (!comment) {
        buf.push(char);
      }
      continue;
    }
    if (comment) {
      if (char === '(') {
        comment += 1;
        maxComment = Math.max(maxComment, comment);
      } else if (char === ')') {
        comment -= 1;
      }
      continue;
    }
    if (quote) {
      buf.push(char);
      if (char === '"') {
        quote = false;
      }
      continue;
    }
    if (literal) {
      buf.push(char);
      if (char === ']') {
        literal = false;
      }
      continue;
    }
    if (char === '(') {
      comment = 1;
      maxComment = Math.max(maxComment, 1);
      buf.push(' ');
    } else if (char === '"') {
      quote = true;
      buf.push(char);
    } else if (char === '[') {
      literal = true;
      buf.push(char);
    } else if (char === '<') {
      if (angle === null) {
        angle = buf.length;
      } else {
        problems.push('nested-angle');
      }
      buf.push(char);
    } else if (char === '>') {
      if (angle === null) {
        problems.push('unmatched-angle');
      } else {
        angles.push([angle, buf.length]);
        angle = null;
      }
      buf.push(char);
    } else if (angle === null && char === ',') {
      emit(index);
    } else if (angle === null && char === ':') {
      if (group || angles.length > 0) {
        problems.push('invalid-group-boundary');
        buf.push(char);
      } else {
        group = true;
        if (
          !validPhrase(buf.join('')) ||
          SURROGATE.test(raw.slice(start, index))
        ) {
          problems.push('invalid-group-name');
          emit(index);
        }
        buf = [];
        start = index + 1;
      }
    } else if (angle === null && char === ';') {
      if (!group) {
        problems.push('unmatched-group');
      }
      emit(index);
      group = false;
    } else {
      if (char === ')' || char === ']') {
        problems.push('unmatched-delimiter');
      }
      buf.push(char);
    }
  }
  if (quote || comment || literal || angle !== null || escaped) {
    problems.push('unclosed-delimiter');
  }
  if (group) {
    problems.push('unclosed-group');
  }
  emit(raw.length);
  return items;
}

// Character positions in `buf` (one entry per UTF-16 unit pushed) map
// 1:1 to `text` indices, because every push is a single code unit.

/** `_mailbox()`: validate an addr-spec and strip token-separating FWS. */
function mailbox(input: string): string | null {
  let value = stripFws(input.replace(FOLD, ' '));
  if (SURROGATE.test(value)) {
    return null;
  }
  // RFC 5322 section 4.4: obsolete source routes precede the addr-spec.
  if (value.startsWith('@') || value.startsWith(',')) {
    let literal = false;
    let escaped = false;
    const domains: string[] = [];
    let start = 0;
    let terminated = false;
    for (let index = 0; index < value.length; index += 1) {
      const char = value.charAt(index);
      if (escaped) {
        escaped = false;
      } else if (char === '\\' && literal) {
        escaped = true;
      } else if (char === '[') {
        literal = true;
      } else if (char === ']') {
        literal = false;
      } else if (!literal && (char === ',' || char === ':')) {
        const domain = stripFws(value.slice(start, index));
        if (domain) {
          domains.push(domain);
        }
        start = index + 1;
        if (char === ':') {
          terminated = true;
          break;
        }
      }
    }
    if (!terminated) {
      return null;
    }
    if (
      domains.length === 0 ||
      domains.some(
        domain => !domain.startsWith('@') || !ADDR_SPEC.test(`route${domain}`),
      )
    ) {
      return null;
    }
    value = stripFws(value.slice(start));
  }
  if (!ADDR_SPEC.test(value)) {
    return null;
  }
  let normalized = '';
  let quoted = false;
  let literal = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      escaped = false;
    } else if (char === '\\' && (quoted || literal)) {
      escaped = true;
    } else if (char === '"' && !literal) {
      quoted = !quoted;
    } else if (char === '[' && !quoted) {
      literal = true;
    } else if (char === ']' && literal) {
      literal = false;
    }
    if (!(char === ' ' || char === '\t') || quoted || literal) {
      normalized += char;
    }
  }
  return normalized;
}

/** `_valid_phrase()`: label specials outside quoted strings. */
function validPhrase(value: string): boolean {
  let quoted = false;
  let escaped = false;
  for (const char of stripFws(value.replace(FOLD, ' '))) {
    if (char.charCodeAt(0) < 32 && char !== '\t') {
      return false;
    }
    if (escaped) {
      escaped = false;
    } else if (char === '\\' && quoted) {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && '@<>[]:;,\\'.includes(char)) {
      return false;
    }
  }
  return Boolean(stripFws(value)) && !(quoted || escaped);
}

/** `_name()`: recover a display phrase, unquoting quoted pairs. */
function displayName(value: string): string {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (const char of stripFws(value.replace(FOLD, ' '))) {
    if (escaped) {
      result += char;
      escaped = false;
    } else if (char === '\\' && quoted) {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else {
      result += char;
    }
  }
  return stripFws(result);
}

/** `_decoded_word()`: decode one RFC 2047 word at `start`. */
function decodedWord(
  value: string,
  start: number,
  comment: boolean,
  problems: Set<string>,
): [string, number] | null {
  ENCODED_WORD.lastIndex = start;
  const match = ENCODED_WORD.exec(value);
  if (!match) {
    return null;
  }
  const end = start + match[0].length;
  if (
    end < value.length &&
    !(comment ? ' \t)' : ' \t').includes(value.charAt(end))
  ) {
    return null;
  }
  if (pyLen(value.slice(start, end)) > 75) {
    problems.add('overlong-encoded-word');
  }
  try {
    const pieces: string[] = [];
    for (const [data, charset] of decodeHeader(match[0])) {
      let text: string;
      if (typeof data === 'string') {
        text = data;
      } else {
        let encoding = (charset ?? 'ascii').split('*')[0] ?? '';
        if (encoding === 'unknown-8bit') {
          encoding = 'utf-8';
        }
        text = pyDecode(data, encoding);
      }
      if (SURROGATE.test(text)) {
        problems.add('invalid-encoded-word');
        return null;
      }
      for (const char of text) {
        if (char.charCodeAt(0) < 32 && char !== '\t') {
          return null;
        }
      }
      pieces.push(text);
    }
    return [pieces.join(''), end];
  } catch (error) {
    // Python catches LookupError, UnicodeError and ValueError here; the
    // HeaderParseError of a bad base64 word is none of them and propagates.
    if (error instanceof LookupError || error instanceof UnicodeError) {
      return null;
    }
    throw error;
  }
}

/** `_display_source()`: decode display words into quoted parser input. */
function displaySource(
  input: string,
  phraseStart: boolean,
  problems: Set<string>,
): string {
  const value = input.replace(FOLD, ' ');
  let phrase = phraseStart;
  let output = '';
  let comment = 0;
  let quoted = false;
  let escaped = false;
  let index = 0;
  while (index < value.length) {
    const char = value.charAt(index);
    if (escaped) {
      escaped = false;
    } else if (char === '\\' && (quoted || comment)) {
      escaped = true;
    } else if (comment && char === ')') {
      comment -= 1;
    } else if (!quoted && char === '(') {
      comment += 1;
    } else if (!comment && char === '"') {
      quoted = !quoted;
    } else if (!quoted && !comment && char === '<') {
      phrase = false;
    } else if (
      !quoted &&
      (comment || phrase) &&
      char === '=' &&
      (index === 0 ||
        (comment ? ' \t(' : ' \t').includes(value.charAt(index - 1)))
    ) {
      let word = decodedWord(value, index, comment > 0, problems);
      if (word) {
        const pieces = [word[0]];
        let end = word[1];
        while (end < value.length) {
          let nextStart = end;
          while (
            nextStart < value.length &&
            ' \t'.includes(value.charAt(nextStart))
          ) {
            nextStart += 1;
          }
          if (nextStart === end) {
            break;
          }
          word = decodedWord(value, nextStart, comment > 0, problems);
          if (!word) {
            break;
          }
          pieces.push(word[0]);
          end = word[1];
        }
        let text = pieces.join('').replaceAll('\\', '\\\\');
        if (comment) {
          text = text.replaceAll('(', '\\(').replaceAll(')', '\\)');
        } else {
          text = `"${text.replaceAll('"', '\\"')}"`;
        }
        output += text;
        index = end;
        continue;
      }
    }
    output += char;
    index += 1;
  }
  return output;
}

/** `parse_address_header()`: mailbox pairs and recovery evidence. */
export function parseAddressHeader(
  raw: string,
  decodeNames: boolean,
): [AddressPair[], AddressDiagnostic[]] {
  const results: AddressPair[] = [];
  const diagnostics: AddressDiagnostic[] = [];
  for (const item of scan(raw)) {
    let candidates: AddressPair[] = [];
    const displayProblems = new Set<string>();
    const prefix = item.angles[0] ? item.text.slice(0, item.angles[0][0]) : '';
    const name = displayName(
      decodeNames ? displaySource(prefix, true, displayProblems) : prefix,
    );
    for (const [index, [left, right]] of item.angles.entries()) {
      const address = mailbox(item.text.slice(left + 1, right));
      if (address) {
        candidates.push([index === 0 ? name : '', address]);
      }
    }
    let reason: string | null = null;
    let selected: AddressPair[] = [];
    if (item.problems.length > 0) {
      reason = [...new Set(item.problems)].toSorted().join(',');
    } else if (item.angles.length > 0) {
      const [left, right] = item.angles[0] ?? [0, 0];
      if (item.angles.length !== 1 || stripFws(item.text.slice(right + 1))) {
        reason = 'ambiguous-angle-address';
      } else if (candidates.length === 0) {
        reason = 'invalid-angle-address';
      } else {
        selected = candidates;
        if (
          stripFws(item.text.slice(0, left)) &&
          !validPhrase(item.text.slice(0, left))
        ) {
          reason = 'invalid-display-name';
        }
      }
    } else {
      const address = mailbox(item.text);
      if (address) {
        selected = [['', address]];
        candidates = selected;
      } else {
        reason = 'invalid-or-ambiguous-address';
      }
    }
    const invalidUtf8 = SURROGATE.test(item.raw);
    if (invalidUtf8) {
      reason = 'invalid-utf8';
    }
    if (selected.length > 0 && !invalidUtf8) {
      // Deep comments are stripped before the stdlib's recursive parser.
      let source = item.commentDepth < 16 ? item.raw : item.text;
      if (decodeNames) {
        source = displaySource(source, item.angles.length > 0, displayProblems);
      }
      const parsed = getaddresses([source]);
      const parsedAddresses = parsed
        .filter(([, address]) => address)
        .map(([, address]) => address);
      const selectedAddresses = selected.map(([, address]) => address);
      if (
        parsedAddresses.length === selectedAddresses.length &&
        parsedAddresses.every(
          (address, index) => address === selectedAddresses[index],
        )
      ) {
        selected = parsed.filter(([, address]) => address);
      } else {
        reason ??= 'structural-recovery';
      }
    }
    if (displayProblems.size > 0) {
      reason = [reason, ...[...displayProblems].toSorted()]
        .filter(Boolean)
        .join(',');
    }
    results.push(...selected);
    if (reason) {
      diagnostics.push({
        reason,
        raw: item.raw,
        recovered: selected.length > 0,
        candidates: candidates.map(([displayName_, address]) => ({
          display_name: displayName_,
          address,
        })),
      });
    }
  }
  return [results, diagnostics];
}

/** mail-parser `get_addresses()` for a header string. */
export function getAddresses(
  rawHeader: string | null | undefined,
  defects?: AddressDiagnostic[],
  decodeNames = false,
): AddressPair[] {
  if (rawHeader === null || rawHeader === undefined) {
    return [];
  }
  if (!stripFws(rawHeader)) {
    return getaddresses([rawHeader]);
  }
  const [parsed, diagnostics] = parseAddressHeader(rawHeader, decodeNames);
  // Not `push(...diagnostics)`: one per address overflows the call stack.
  for (const diagnostic of diagnostics) {
    defects?.push(diagnostic);
  }
  return parsed.length > 0 ? parsed : [['', '']];
}
