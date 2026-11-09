// Port of the parts of Python's `email.utils` and `email._parseaddr` that
// mail-parser and parsedmarc use: quoting, RFC 2231 parameters and the
// strict `getaddresses()`.

import { LookupError, pyDecode, pyEncode } from '../py-codecs';
import { pyStrip } from '../py-str';
import { RecursionError } from './errors';

/** A parameter value as `Message.get_param()` returns it for RFC 2231. */
export type Rfc2231Value = readonly [
  charset: string | null,
  language: string | null,
  value: string,
];

/** A parameter value: plain text, or an RFC 2231 triple. */
export type ParamValue = string | Rfc2231Value;

/** A `(realname, address)` pair. */
export type AddressPair = readonly [name: string, address: string];

/** Python's `str.split(sep, maxsplit)`. */
export function pySplit(
  text: string,
  separator: string,
  maxsplit = -1,
): string[] {
  const parts: string[] = [];
  const limit = maxsplit < 0 ? Number.POSITIVE_INFINITY : maxsplit;
  let start = 0;
  while (parts.length < limit) {
    const index = text.indexOf(separator, start);
    if (index === -1) {
      break;
    }
    parts.push(text.slice(start, index));
    start = index + separator.length;
  }
  parts.push(text.slice(start));
  return parts;
}

/** `email.utils.quote()`: escape backslashes and double quotes. */
export function quote(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/** `email.utils.unquote()`: remove surrounding quotes or angle brackets. */
export function unquote(text: string): string {
  if (text.length > 1) {
    if (text.startsWith('"') && text.endsWith('"')) {
      return text.slice(1, -1).replaceAll('\\\\', '\\').replaceAll('\\"', '"');
    }
    if (text.startsWith('<') && text.endsWith('>')) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** `email.utils.decode_rfc2231()`. */
export function decodeRfc2231(text: string): Rfc2231Value {
  const parts = pySplit(text, "'", 2);
  if (parts.length <= 2) {
    return [null, null, text];
  }
  return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? ''];
}

const RFC2231_CONTINUATION =
  /^(?<name>[A-Za-z0-9_]+)\*(?:(?<num>[0-9]+)\*?)?$/u;
const PERCENT_ESCAPE = /%([0-9a-fA-F]{2})/gu;
const LATIN1_MAX = 0xff;

// `urllib.parse.unquote(s, encoding="latin-1")`: %XX → the char U+00XX.
function percentUnquoteLatin1(text: string): string {
  if (!text.includes('%')) {
    return text;
  }
  return text.replace(PERCENT_ESCAPE, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

interface Continuation {
  num: number | null;
  value: string;
  encoded: boolean;
}

/** `email.utils.decode_params()`. */
export function decodeParams(
  params: readonly (readonly [string, string])[],
): [string, ParamValue][] {
  const first = params[0];
  const decoded: [string, ParamValue][] =
    first === undefined ? [] : [[first[0], first[1]]];
  const rfc2231 = new Map<string, Continuation[]>();
  for (const [rawName, rawValue] of params.slice(1)) {
    const encoded = rawName.endsWith('*');
    const value = unquote(rawValue);
    const match = RFC2231_CONTINUATION.exec(rawName);
    if (match?.groups === undefined) {
      decoded.push([rawName, `"${quote(value)}"`]);
      continue;
    }
    const name = match.groups.name ?? '';
    const num =
      match.groups.num === undefined ? null : Number(match.groups.num);
    const list = rfc2231.get(name) ?? [];
    list.push({ num, value, encoded });
    rfc2231.set(name, list);
  }
  for (const [name, list] of rfc2231) {
    const hasZero = list.some(item => item.num === 0);
    let continuations = hasZero
      ? list.filter(item => item.num !== null)
      : list.map(item => ({ ...item, num: item.num ?? 0 }));
    // Python's sort is stable, like Array.prototype.sort.
    continuations = continuations.toSorted(
      (a, b) => (a.num ?? 0) - (b.num ?? 0),
    );
    let extended = false;
    const pieces: string[] = [];
    for (const item of continuations) {
      if (item.encoded) {
        pieces.push(percentUnquoteLatin1(item.value));
        extended = true;
      } else {
        pieces.push(item.value);
      }
    }
    const value = quote(pieces.join(''));
    if (extended) {
      const [charset, language, text] = decodeRfc2231(value);
      decoded.push([name, [charset, language, `"${text}"`]]);
    } else {
      decoded.push([name, `"${value}"`]);
    }
  }
  return decoded;
}

/** `bytes(text, 'raw-unicode-escape')`. */
export function rawUnicodeEscape(text: string): Uint8Array {
  // Latin-1 text maps one character to one byte; `decode_header()` calls
  // this once per encoded word, so skip the codec lookup.
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > LATIN1_MAX) {
      return pyEncode(text, 'raw-unicode-escape');
    }
    bytes[index] = code;
  }
  return bytes;
}

/** `email.utils.collapse_rfc2231_value()`. */
export function collapseRfc2231Value(
  value: ParamValue,
  errors: 'replace' | 'strict' = 'replace',
  fallbackCharset = 'us-ascii',
): string {
  if (typeof value === 'string') {
    return unquote(value);
  }
  const [charset, , text] = value;
  try {
    return pyDecode(rawUnicodeEscape(text), charset ?? fallbackCharset, errors);
  } catch (error) {
    if (error instanceof LookupError) {
      return unquote(text);
    }
    throw error;
  }
}

function* iterEscapedChars(addr: string): Generator<[number, string]> {
  let escape = false;
  let position = 0;
  for (let index = 0; index < addr.length; index += 1) {
    position = index;
    const char = addr.charAt(index);
    if (escape) {
      yield [index, `\\${char}`];
      escape = false;
    } else if (char === '\\') {
      escape = true;
    } else {
      yield [index, char];
    }
  }
  if (escape) {
    yield [position, '\\'];
  }
}

function stripQuotedRealnames(addr: string): string {
  if (!addr.includes('"')) {
    return addr;
  }
  let start = 0;
  let openPos: number | null = null;
  const result: string[] = [];
  for (const [position, char] of iterEscapedChars(addr)) {
    if (char !== '"') {
      continue;
    }
    if (openPos === null) {
      openPos = position;
    } else {
      if (start !== openPos) {
        result.push(addr.slice(start, openPos));
      }
      start = position + 1;
      openPos = null;
    }
  }
  if (start < addr.length) {
    result.push(addr.slice(start));
  }
  return result.join('');
}

function checkParenthesis(addr: string): boolean {
  let opens = 0;
  for (const [, char] of iterEscapedChars(stripQuotedRealnames(addr))) {
    if (char === '(') {
      opens += 1;
    } else if (char === ')') {
      opens -= 1;
      if (opens < 0) {
        return false;
      }
    }
  }
  return opens === 0;
}

const SPECIALS = '()<>@,:;."[]';
const LWS = ' \t';
const CR = '\r\n';
const FWS = LWS + CR;
const ATOM_ENDS = SPECIALS + LWS + CR;
const PHRASE_ENDS = ATOM_ENDS.replace('.', '');

/**
 * Python frames of `AddrlistClass` that fit in CPython's default recursion
 * limit under `mailparser.parse_from_string()`: a group nests one
 * (`getaddress`), a comment two (`getcomment`, `getdelimited`). Measured
 * with Python 3.14: 491 nested comments fail, as here, and 979 nested groups
 * (982 here; Python's limit shifts with the frames below the deepest level).
 */
const ADDRLIST_MAX_FRAMES = 982;

/** Port of `email._parseaddr.AddrlistClass`. */
class AddrlistParser {
  private pos = 0;
  private frames = 0;
  private commentlist: string[] = [];
  private readonly field: string;

  constructor(field: string) {
    this.field = field;
  }

  private char(): string {
    return this.field.charAt(this.pos);
  }

  private gotonext(): string {
    const wslist: string[] = [];
    while (this.pos < this.field.length) {
      const char = this.char();
      if (`${LWS}\n\r`.includes(char)) {
        if (!'\n\r'.includes(char)) {
          wslist.push(char);
        }
        this.pos += 1;
      } else if (char === '(') {
        this.commentlist.push(this.getcomment());
      } else {
        break;
      }
    }
    return wslist.join('');
  }

  private enter(frames: number): void {
    this.frames += frames;
    if (this.frames > ADDRLIST_MAX_FRAMES) {
      throw new RecursionError();
    }
  }

  getaddrlist(): AddressPair[] {
    const result: AddressPair[] = [];
    while (this.pos < this.field.length) {
      const before = result.length;
      this.getaddress(result);
      if (result.length === before) {
        result.push(['', '']);
      }
    }
    return result;
  }

  /**
   * Python returns a list that each enclosing group copies; appending to
   * `result` costs one push per address however deep the groups nest.
   */
  private getaddress(result: AddressPair[]): void {
    this.enter(1);
    this.commentlist = [];
    this.gotonext();
    const oldpos = this.pos;
    const oldcl = this.commentlist;
    const plist = this.getphraselist();
    this.gotonext();
    if (this.pos >= this.field.length) {
      if (plist.length > 0) {
        result.push([this.commentlist.join(' '), plist[0] ?? '']);
      }
    } else if ('.@'.includes(this.char())) {
      this.pos = oldpos;
      this.commentlist = oldcl;
      const addrspec = this.getaddrspec();
      result.push([this.commentlist.join(' '), addrspec]);
    } else if (this.char() === ':') {
      const fieldlen = this.field.length;
      this.pos += 1;
      while (this.pos < this.field.length) {
        this.gotonext();
        if (this.pos < fieldlen && this.char() === ';') {
          this.pos += 1;
          break;
        }
        this.getaddress(result);
      }
    } else if (this.char() === '<') {
      const routeaddr = this.getrouteaddr();
      if (this.commentlist.length > 0) {
        result.push([
          `${plist.join(' ')} (${this.commentlist.join(' ')})`,
          routeaddr,
        ]);
      } else {
        result.push([plist.join(' '), routeaddr]);
      }
    } else if (plist.length > 0) {
      result.push([this.commentlist.join(' '), plist[0] ?? '']);
    } else if (SPECIALS.includes(this.char())) {
      this.pos += 1;
    }
    this.gotonext();
    if (this.pos < this.field.length && this.char() === ',') {
      this.pos += 1;
    }
    this.frames -= 1;
  }

  private getrouteaddr(): string {
    if (this.char() !== '<') {
      return '';
    }
    let expectroute = false;
    this.pos += 1;
    this.gotonext();
    let adlist = '';
    while (this.pos < this.field.length) {
      if (expectroute) {
        this.getdomain();
        expectroute = false;
      } else if (this.char() === '>') {
        this.pos += 1;
        break;
      } else if (this.char() === '@') {
        this.pos += 1;
        expectroute = true;
      } else if (this.char() === ':') {
        this.pos += 1;
      } else {
        adlist = this.getaddrspec();
        this.pos += 1;
        break;
      }
      this.gotonext();
    }
    return adlist;
  }

  private getaddrspec(): string {
    const aslist: string[] = [];
    this.gotonext();
    while (this.pos < this.field.length) {
      let preserveWs = true;
      const char = this.char();
      if (char === '.') {
        if (aslist.length > 0 && pyStrip(aslist.at(-1) ?? '') === '') {
          aslist.pop();
        }
        aslist.push('.');
        this.pos += 1;
        preserveWs = false;
      } else if (char === '"') {
        aslist.push(`"${quote(this.getquote())}"`);
      } else if (ATOM_ENDS.includes(char)) {
        if (aslist.length > 0 && pyStrip(aslist.at(-1) ?? '') === '') {
          aslist.pop();
        }
        break;
      } else {
        aslist.push(this.getatom());
      }
      const ws = this.gotonext();
      if (preserveWs && ws) {
        aslist.push(ws);
      }
    }
    if (this.pos >= this.field.length || this.char() !== '@') {
      return aslist.join('');
    }
    aslist.push('@');
    this.pos += 1;
    this.gotonext();
    const domain = this.getdomain();
    if (!domain) {
      return '';
    }
    return aslist.join('') + domain;
  }

  private getdomain(): string {
    const sdlist: string[] = [];
    while (this.pos < this.field.length) {
      const char = this.char();
      if (LWS.includes(char)) {
        this.pos += 1;
      } else if (char === '(') {
        this.commentlist.push(this.getcomment());
      } else if (char === '[') {
        sdlist.push(this.getdomainliteral());
      } else if (char === '.') {
        this.pos += 1;
        sdlist.push('.');
      } else if (char === '@') {
        return '';
      } else if (ATOM_ENDS.includes(char)) {
        break;
      } else {
        sdlist.push(this.getatom());
      }
    }
    return sdlist.join('');
  }

  private getdelimited(
    beginchar: string,
    endchars: string,
    allowcomments: boolean,
  ): string {
    if (this.char() !== beginchar) {
      return '';
    }
    // Appended, not joined: a rope, so that a comment does not copy the text
    // of the comments nested in it.
    let text = '';
    let quoted = false;
    this.pos += 1;
    while (this.pos < this.field.length) {
      const char = this.char();
      if (quoted) {
        text += char;
        quoted = false;
      } else if (endchars.includes(char)) {
        this.pos += 1;
        break;
      } else if (allowcomments && char === '(') {
        text += this.getcomment();
        continue;
      } else if (char === '\\') {
        quoted = true;
      } else {
        text += char;
      }
      this.pos += 1;
    }
    return text;
  }

  private getquote(): string {
    return this.getdelimited('"', '"\r', false);
  }

  private getcomment(): string {
    this.enter(2);
    const comment = this.getdelimited('(', ')\r', true);
    this.frames -= 2;
    return comment;
  }

  private getdomainliteral(): string {
    return `[${this.getdelimited('[', ']\r', false)}]`;
  }

  private getatom(atomends: string = ATOM_ENDS): string {
    let atom = '';
    while (this.pos < this.field.length) {
      const char = this.char();
      if (atomends.includes(char)) {
        break;
      }
      atom += char;
      this.pos += 1;
    }
    return atom;
  }

  private getphraselist(): string[] {
    const plist: string[] = [];
    while (this.pos < this.field.length) {
      const char = this.char();
      if (FWS.includes(char)) {
        this.pos += 1;
      } else if (char === '"') {
        plist.push(this.getquote());
      } else if (char === '(') {
        this.commentlist.push(this.getcomment());
      } else if (PHRASE_ENDS.includes(char)) {
        break;
      } else {
        plist.push(this.getatom(PHRASE_ENDS));
      }
    }
    return plist;
  }
}

/** `email._parseaddr.AddressList(field).addresslist`. */
export function addressList(field: string): AddressPair[] {
  if (!field) {
    return [];
  }
  return new AddrlistParser(field).getaddrlist();
}

/** `email.utils.getaddresses(fieldvalues, strict=True)`. */
export function getaddresses(fieldvalues: readonly string[]): AddressPair[] {
  const accepted = fieldvalues.map(value =>
    checkParenthesis(value) ? value : "('', '')",
  );
  const parsed = addressList(accepted.join(', ')).map((pair): AddressPair =>
    pair[1].includes('[') ? ['', ''] : pair,
  );
  let expected = 0;
  for (const value of accepted) {
    const stripped = stripQuotedRealnames(value);
    expected += 1 + (stripped.split(',').length - 1);
  }
  if (parsed.length !== expected) {
    return [['', '']];
  }
  return parsed;
}
