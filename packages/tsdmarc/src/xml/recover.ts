// Emulation of what parsedmarc (11.1.0) does when xmltodict rejects a report:
//
//   tree = etree.parse(BytesIO(xml.encode("utf-8")),
//                      etree.XMLParser(recover=True, resolve_entities=False))
//   root = tree.getroot()                 # None -> xml = ""
//   has_doctype = bool(tree.docinfo.doctype) or (
//       tree.docinfo.internalDTD is not None)
//   if not has_doctype:
//       xml = str(etree.tostring(root, encoding="unicode"))
//   ... except Exception: xml = "<a/>"
//   if has_doctype: raise InvalidAggregateReport(...)
//
// i.e. libxml2 2.14's recovering parser followed by lxml's serializer. The
// behavior below was established by experiment against lxml 6.1 / libxml2
// 2.14 (see tools/fixtures/generate_xml.py and the differential fixtures),
// not from libxml2's sources: the goal is that the recovered text parses to
// the same xmltodict result as Python's.
//
// Like libxml2 without XML_PARSE_HUGE, nesting is capped at 256 elements, a
// content model in the DTD at 256 groups and a text node at 10,000,000
// characters; there is no recursion and no entity expansion, so adversarial
// input stays linear. The internal subset is only scanned: a document with a
// DOCTYPE is rejected, so nothing it declares can reach the output.
//
// No tree is built: lxml serializes the root element in document order, so
// each node is written to the output as soon as it is parsed. Only the stack
// of open element names is kept (to write the closing tags, also for the
// elements still open when parsing stops), plus two facts about the innermost
// element: whether its start tag still lacks its ">" (no children yet, so it
// may still become "<a/>"), and the length of its trailing text node (text
// pieces merge into one node, which is capped at MAX_TEXT_LENGTH). Reports can
// be large, so memory stays close to the size of the input and the output.
// The DOCTYPE, and the comments and PIs outside the root element, are parsed
// but not written: `tostring(root)` leaves them out.

import { TextBuffer } from './text-buffer';
import { assertEncodableUtf8 } from './unicode';

interface RComment {
  kind: 'comment';
  value: string;
}

interface RProcessingInstruction {
  kind: 'pi';
  target: string;
  value: string;
}

/** A malformed markup declaration in the internal subset. */
class DeclarationError extends Error {
  override name = 'DeclarationError';
}

/** Stops the parser (libxml2's xmlHaltParser). */
class Halt extends Error {
  override name = 'Halt';
}

const MAX_DEPTH = 256;
const MAX_CONTENT_MODEL_DEPTH = 256;
const MAX_TEXT_LENGTH = 10_000_000;
const PREDEFINED: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);
const MAX_UNICODE = 0x10_ff_ff;
const REPLACEMENT_CHARACTER = 0xff_fd;
const CHAR_TAB = 0x09;
const CHAR_LF = 0x0a;
const CHAR_CR = 0x0d;
const CHAR_SPACE = 0x20;
const ASCII_DEL = 0x7f;

function isBlank(code: number): boolean {
  return (
    code === CHAR_SPACE ||
    code === CHAR_TAB ||
    code === CHAR_LF ||
    code === CHAR_CR
  );
}

/** XML 1.0 Char production (what libxml2's IS_CHAR accepts). */
function isXmlChar(code: number): boolean {
  if (code < CHAR_SPACE) {
    return code === CHAR_TAB || code === CHAR_LF || code === CHAR_CR;
  }
  if (code <= 0xd7_ff) {
    return true;
  }
  if (code >= 0xe0_00 && code <= 0xff_fd) {
    return true;
  }
  return code >= 0x1_00_00 && code <= MAX_UNICODE;
}

// XML 1.0 fifth edition NameStartChar / NameChar.
function isNameStartChar(code: number): boolean {
  if (code < 0x80) {
    return (
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x41 && code <= 0x5a) ||
      code === 0x5f ||
      code === 0x3a
    );
  }
  return (
    (code >= 0xc0 && code <= 0xd6) ||
    (code >= 0xd8 && code <= 0xf6) ||
    (code >= 0xf8 && code <= 0x2_ff) ||
    (code >= 0x3_70 && code <= 0x3_7d) ||
    (code >= 0x3_7f && code <= 0x1f_ff) ||
    (code >= 0x20_0c && code <= 0x20_0d) ||
    (code >= 0x20_70 && code <= 0x21_8f) ||
    (code >= 0x2c_00 && code <= 0x2f_ef) ||
    (code >= 0x30_01 && code <= 0xd7_ff) ||
    (code >= 0xf9_00 && code <= 0xfd_cf) ||
    (code >= 0xfd_f0 && code <= 0xff_fd) ||
    (code >= 0x1_00_00 && code <= 0xe_ff_ff)
  );
}

function isNameChar(code: number): boolean {
  if (isNameStartChar(code)) {
    return true;
  }
  return (
    code === 0x2d ||
    code === 0x2e ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0xb7 ||
    (code >= 0x3_00 && code <= 0x3_6f) ||
    (code >= 0x20_3f && code <= 0x20_40)
  );
}

// PubidChar*: anything else (a tab, non-ASCII) ends the literal early.
const PUBID_LITERAL = /^[ \r\na-zA-Z0-9\-'()+,./:=?;!*#@$_%]*$/u;

const ELEMENT_TYPE_KEYWORDS: readonly string[] = [
  'CDATA',
  'IDREFS',
  'IDREF',
  'ID',
  'ENTITIES',
  'ENTITY',
  'NMTOKENS',
  'NMTOKEN',
];

const LATIN1_LABELS = new Set([
  'iso-8859-1',
  'iso_8859-1',
  'iso8859-1',
  'latin1',
  'latin-1',
  'iso-latin-1',
  'l1',
  'cp819',
  'ibm819',
  'csisolatin1',
]);
const ASCII_LABELS = new Set([
  'us-ascii',
  'ascii',
  'ansi_x3.4-1968',
  'iso646-us',
  'us',
]);
const UTF8_LABELS = new Set(['utf-8', 'utf8']);
const UTF16_LABELS = new Set([
  'utf-16',
  'utf16',
  'utf-16le',
  'utf-16be',
  'ucs-2',
  'ucs2',
]);
// Bytes iconv's CP1252 leaves undefined (WHATWG maps them to C1 controls).
const CP1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
// Bytes per String.fromCharCode call when decoding Latin-1 (kept well under
// the engines' argument count limits).
const TRANSCODE_BLOCK_SIZE = 8192;

/**
 * Decode the UTF-8 bytes of `text` as `encoding` the way libxml2 (iconv)
 * would after an `encoding="..."` declaration. Returns the decoded text and
 * whether decoding stopped at an invalid byte (libxml2 then halts), or null
 * when the encoding is unknown (libxml2 reports it and keeps UTF-8).
 */
function transcode(text: string, encoding: string): [string, boolean] | null {
  const label = encoding.toLowerCase();
  if (UTF8_LABELS.has(label)) {
    return [text, false];
  }
  const bytes = new TextEncoder().encode(text);
  if (LATIN1_LABELS.has(label) || ASCII_LABELS.has(label)) {
    const limit = ASCII_LABELS.has(label) ? 0x80 : 0x1_00;
    let end = 0;
    while (end < bytes.length && (bytes[end] as number) < limit) {
      end += 1;
    }
    // Bytes map to the code points of the same value; converted in blocks
    // (one string per byte would cost far more memory on large reports).
    const blocks: string[] = [];
    for (let index = 0; index < end; index += TRANSCODE_BLOCK_SIZE) {
      blocks.push(
        String.fromCharCode(
          ...bytes.subarray(index, Math.min(end, index + TRANSCODE_BLOCK_SIZE)),
        ),
      );
    }
    return [blocks.join(''), end < bytes.length];
  }
  let decoderLabel = label;
  let usable = bytes;
  let stopped = false;
  if (label === 'windows-1252' || label === 'cp1252') {
    const bad = bytes.findIndex(byte => CP1252_UNDEFINED.has(byte));
    if (bad >= 0) {
      usable = bytes.subarray(0, bad);
      stopped = true;
    }
  } else if (UTF16_LABELS.has(label)) {
    decoderLabel = label.endsWith('be') ? 'utf-16be' : 'utf-16le';
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(decoderLabel, { fatal: true });
  } catch {
    return null;
  }
  try {
    return [decoder.decode(usable), stopped];
  } catch {
    // Find the longest decodable prefix (libxml2 halts at the bad byte).
    let low = 0;
    let high = usable.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      try {
        new TextDecoder(decoderLabel, { fatal: true }).decode(
          usable.subarray(0, middle),
        );
        low = middle;
      } catch {
        high = middle - 1;
      }
    }
    return [
      new TextDecoder(decoderLabel).decode(usable.subarray(0, low)),
      true,
    ];
  }
}

function normalizeNewlines(text: string): string {
  return text.includes('\r')
    ? text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    : text;
}

// How lxml writes a character of text or of an attribute value: the
// replacement, or null when the character is written as is.
function escapedTextChar(code: number, inAttribute: boolean): string | null {
  switch (code) {
    case 0x26:
      return '&amp;';
    case 0x3c:
      return '&lt;';
    case 0x3e:
      return '&gt;';
    case 0x22:
      return inAttribute ? '&quot;' : null;
    case CHAR_CR:
      return '&#13;';
    case CHAR_LF:
      return inAttribute ? '&#10;' : null;
    case CHAR_TAB:
      return inAttribute ? '&#9;' : null;
    default:
      // Other control characters (only reachable through character
      // references) are written as U+FFFD; everything else, non-ASCII
      // included, as is (`encoding="unicode"`).
      return code < CHAR_SPACE ? '&#xFFFD;' : null;
  }
}

// The code point at `index`, combining a surrogate pair only when both
// halves are before `end` (a lone surrogate is returned as is).
function codePointBefore(value: string, index: number, end: number): number {
  const code = value.charCodeAt(index);
  if (code >= 0xd8_00 && code <= 0xdb_ff && index + 1 < end) {
    const low = value.charCodeAt(index + 1);
    if (low >= 0xdc_00 && low <= 0xdf_ff) {
      return (code - 0xd8_00) * 0x4_00 + (low - 0xdc_00) + 0x1_00_00;
    }
  }
  return code;
}

// Size of the byte blocks the output is assembled in.
const OUTPUT_BLOCK_SIZE = 1 << 20;
const UTF8_TWO_BYTES = 0x8_00;
const UTF8_THREE_BYTES = 0x1_00_00;

/**
 * The serialized root element, assembled as UTF-8 bytes in blocks that are
 * decoded when full. That avoids keeping millions of small strings alive
 * until the final join.
 */
class Output {
  private readonly pieces: string[] = [];
  private readonly block = new Uint8Array(OUTPUT_BLOCK_SIZE);
  private readonly decoder = new TextDecoder();
  private length = 0;

  private flush(): void {
    if (this.length > 0) {
      // A block may end inside a character: `stream` keeps its first bytes.
      this.pieces.push(
        this.decoder.decode(this.block.subarray(0, this.length), {
          stream: true,
        }),
      );
      this.length = 0;
    }
  }

  /** One ASCII character. */
  byte(code: number): void {
    if (this.length === OUTPUT_BLOCK_SIZE) {
      this.flush();
    }
    this.block[this.length] = code;
    this.length += 1;
  }

  /** One code point, as UTF-8 (a lone surrogate becomes U+FFFD). */
  codePoint(code: number): void {
    if (code < 0x80) {
      this.byte(code);
      return;
    }
    const value = code >= 0xd8_00 && code <= 0xdf_ff ? 0xff_fd : code;
    if (value < UTF8_TWO_BYTES) {
      this.byte(0xc0 | (value >> 6));
    } else if (value < UTF8_THREE_BYTES) {
      this.byte(0xe0 | (value >> 12));
      this.byte(0x80 | ((value >> 6) & 0x3f));
    } else {
      this.byte(0xf0 | (value >> 18));
      this.byte(0x80 | ((value >> 12) & 0x3f));
      this.byte(0x80 | ((value >> 6) & 0x3f));
    }
    this.byte(0x80 | (value & 0x3f));
  }

  /** A string written as is (names, comments, PIs, markup). */
  write(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      const code = codePointBefore(value, index, value.length);
      if (code > 0xff_ff) {
        index += 1;
      }
      this.codePoint(code);
    }
  }

  /** `value.slice(start, end)` with lxml's escaping of text/attributes. */
  text(value: string, start: number, end: number, inAttribute: boolean): void {
    for (let index = start; index < end; index += 1) {
      const code = codePointBefore(value, index, end);
      if (code > 0xff_ff) {
        index += 1;
      }
      const escaped = escapedTextChar(code, inAttribute);
      if (escaped === null) {
        this.codePoint(code);
      } else {
        this.write(escaped);
      }
    }
  }

  toString(): string {
    this.flush();
    this.pieces.push(this.decoder.decode());
    return this.pieces.join('');
  }
}

function serializePI(pi: RProcessingInstruction): string {
  return pi.value === '' ? `<?${pi.target}?>` : `<?${pi.target} ${pi.value}?>`;
}

interface EntityDeclaration {
  internal: boolean;
}

interface StartTag {
  name: string;
  namespaces: [string, string][];
  attributes: [string, string][];
  // Attribute names seen so far (created with the first attribute).
  seen: Set<string> | null;
}

interface ExternalId {
  publicId: string | null;
  systemId: string | null;
}

class RecoveringParser {
  private text: string;
  private pos = 0;
  private wellFormed = true;
  private standalone = false;
  private hasExternalSubset = false;
  private hasParameterEntityReferences = false;
  private readonly entities = new Map<string, EntityDeclaration>();
  private readonly out = new Output();
  // Whether libxml2 created an internal subset (any DOCTYPE it could read
  // up to its external ID), i.e. `tree.docinfo.doctype` is set.
  private hasDoctype = false;
  // A character reference to a surrogate was stored: lxml's serializer then
  // produces invalid UTF-8 and decoding it raises (parsedmarc uses "<a/>").
  private unserializable = false;
  private rootName: string | null = null;
  // Names of the open elements, innermost last.
  private readonly openElements: string[] = [];
  // The innermost open element has no children yet: its start tag was
  // written without the ">" (it becomes "<a/>" if it stays empty).
  private startTagPending = false;
  // Length of the innermost open element's last child when it is a text
  // node (later text merges into it), -1 when its last child is not text.
  private textRun = -1;

  constructor(text: string) {
    this.text = text;
  }

  private error(): void {
    this.wellFormed = false;
  }

  private code(offset = 0): number {
    return this.text.codePointAt(this.pos + offset) ?? -1;
  }

  private at(literal: string): boolean {
    return this.text.startsWith(literal, this.pos);
  }

  private get eof(): boolean {
    return this.pos >= this.text.length;
  }

  private skipBlanks(): number {
    const start = this.pos;
    while (!this.eof && isBlank(this.text.charCodeAt(this.pos))) {
      this.pos += 1;
    }
    return this.pos - start;
  }

  private parseName(): string | null {
    const start = this.pos;
    const first = this.code();
    if (first < 0 || !isNameStartChar(first)) {
      return null;
    }
    this.pos += first > 0xff_ff ? 2 : 1;
    for (;;) {
      const code = this.code();
      if (code < 0 || !isNameChar(code)) {
        break;
      }
      this.pos += code > 0xff_ff ? 2 : 1;
    }
    return this.text.slice(start, this.pos);
  }

  private parseNmtoken(): string | null {
    const start = this.pos;
    for (;;) {
      const code = this.code();
      if (code < 0 || !isNameChar(code)) {
        break;
      }
      this.pos += code > 0xff_ff ? 2 : 1;
    }
    return this.pos > start ? this.text.slice(start, this.pos) : null;
  }

  // ---- document ---------------------------------------------------------

  /** Parses the document and returns parsedmarc's recovery result. */
  run(): RecoveredXml {
    try {
      this.parseDocument();
    } catch (error) {
      if (!(error instanceof Halt)) {
        throw error;
      }
    }
    if (this.rootName === null) {
      return { hasDoctype: false, xml: '' };
    }
    if (this.hasDoctype) {
      return { hasDoctype: true, xml: '' };
    }
    if (this.unserializable) {
      return { hasDoctype: false, xml: '<a/>' };
    }
    // Elements still open when parsing stopped are closed like the others.
    while (this.openElements.length > 0) {
      this.closeElement();
    }
    return { hasDoctype: false, xml: this.out.toString() };
  }

  private parseDocument(): void {
    if (this.text.charCodeAt(0) === 0xfe_ff) {
      this.pos = 1;
    }
    if (this.at('<?xml') && isBlank(this.text.charCodeAt(this.pos + 5))) {
      this.parseXmlDeclaration();
    }
    this.parseMisc();
    if (this.at('<!DOCTYPE')) {
      this.parseDoctype();
      this.parseMisc();
    }
    if (this.code() !== 0x3c) {
      this.error();
      return;
    }
    this.parseRootElement();
    if (this.rootName !== null) {
      this.parseMisc();
    }
  }

  // Comments and PIs outside the root element (not serialized).
  private parseMisc(): void {
    for (;;) {
      this.skipBlanks();
      if (this.at('<?')) {
        this.parsePI();
      } else if (this.at('<!--')) {
        this.parseComment();
      } else {
        return;
      }
    }
  }

  // ---- XML declaration --------------------------------------------------

  // A quoted pseudo-attribute value: [value, closed], or null without a quote.
  private parseQuotedDeclValue(
    valid: (code: number, index: number) => boolean,
  ): [string, boolean] | null {
    const quote = this.code();
    if (quote !== 0x22 && quote !== 0x27) {
      this.error();
      return null;
    }
    this.pos += 1;
    const start = this.pos;
    while (
      !this.eof &&
      valid(this.text.charCodeAt(this.pos), this.pos - start)
    ) {
      this.pos += 1;
    }
    const value = this.text.slice(start, this.pos);
    if (this.code() === quote) {
      this.pos += 1;
      return [value, true];
    }
    // "String not closed"
    this.error();
    return [value, false];
  }

  private parsePseudoAttribute(name: string): string | null {
    if (!this.at(name)) {
      return null;
    }
    this.pos += name.length;
    this.skipBlanks();
    if (this.code() !== 0x3d) {
      this.error();
      return null;
    }
    this.pos += 1;
    this.skipBlanks();
    return '';
  }

  private parseXmlDeclaration(): void {
    this.pos += 5;
    this.skipBlanks();
    let version: string | null = null;
    if (this.parsePseudoAttribute('version') !== null) {
      const parsed = this.parseQuotedDeclValue((code, index) =>
        index === 1 ? code === 0x2e : code >= 0x30 && code <= 0x39,
      );
      // xmlParseVersionNum needs a digit and a dot; it keeps what it read
      // even when the closing quote is missing.
      if (parsed && /^[0-9]\.[0-9]*$/u.test(parsed[0])) {
        [version] = parsed;
      }
    }
    if (version === null) {
      this.error();
    } else if (version !== '1.0' && !/^1\.[0-9]/u.test(version)) {
      // "Unsupported version": an error unless it is 1.x (then a warning).
      this.error();
    }
    if (!isBlank(this.text.charCodeAt(this.pos))) {
      if (this.at('?>')) {
        this.pos += 2;
        return;
      }
      this.error();
    }
    this.skipBlanks();
    let hasEncoding = false;
    if (this.parsePseudoAttribute('encoding') !== null) {
      const name = this.parseQuotedDeclValue((code, index) => {
        const letter =
          (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
        if (index === 0) {
          return letter;
        }
        return (
          letter ||
          (code >= 0x30 && code <= 0x39) ||
          code === 0x2e ||
          code === 0x5f ||
          code === 0x2d
        );
      });
      if (name === null || !name[1] || name[0] === '') {
        this.error();
      } else {
        hasEncoding = true;
        this.switchEncoding(name[0]);
      }
    }
    if (hasEncoding && !isBlank(this.text.charCodeAt(this.pos))) {
      if (this.at('?>')) {
        this.pos += 2;
        return;
      }
      this.error();
    }
    this.skipBlanks();
    if (this.parsePseudoAttribute('standalone') !== null) {
      const value = this.parseQuotedDeclValue(
        code =>
          code !== 0x22 && code !== 0x27 && code !== 0x3f && code !== 0x3e,
      );
      if (value?.[0] === 'yes') {
        this.standalone = true;
      } else if (value?.[0] !== 'no') {
        this.error();
      }
    }
    this.skipBlanks();
    if (this.at('?>')) {
      this.pos += 2;
    } else if (this.code() === 0x3e) {
      this.error();
      this.pos += 1;
    } else {
      this.error();
      // MOVETO_ENDTAG stops at ">" or at a NUL; NEXT then skips one char.
      let index = this.pos;
      while (
        index < this.text.length &&
        this.text.charCodeAt(index) !== 0x3e &&
        this.text.charCodeAt(index) !== 0
      ) {
        index += 1;
      }
      this.pos = Math.min(index + 1, this.text.length);
    }
  }

  private switchEncoding(name: string): void {
    const rest = this.text.slice(this.pos);
    const decoded = transcode(rest, name);
    if (decoded === null) {
      // Unsupported encoding: reported, parsing goes on as UTF-8.
      this.error();
      return;
    }
    const [text, stopped] = decoded;
    this.text = this.text.slice(0, this.pos) + text;
    if (stopped) {
      this.error();
      this.haltAt = this.text.length;
    }
  }

  // Set when decoding stopped at an invalid byte: parsing halts there
  // instead of seeing a clean end of input.
  private haltAt = -1;

  // ---- comments and processing instructions ----------------------------

  private parseComment(): RComment | null {
    const { text } = this;
    const start = this.pos + 4;
    let index = start;
    // Fast path over ASCII: "--" not followed by ">" is an error and both
    // hyphens are skipped, so "--->" does not close the comment.
    for (;;) {
      if (index >= text.length) {
        this.error();
        this.pos = text.length;
        return null;
      }
      const code = text.charCodeAt(index);
      if (code === 0x2d && text.charCodeAt(index + 1) === 0x2d) {
        if (text.charCodeAt(index + 2) === 0x3e) {
          this.pos = index + 3;
          return { kind: 'comment', value: text.slice(start, index) };
        }
        this.error();
        index += 2;
        continue;
      }
      if (
        (code >= CHAR_SPACE && code <= ASCII_DEL) ||
        code === CHAR_TAB ||
        code === CHAR_LF
      ) {
        index += 1;
        continue;
      }
      break;
    }
    // Complex path: a sliding window of the last two characters (q, r) and
    // the current one. The comment is the text before q once "-->" is seen,
    // with CRLF and CR read as LF.
    let width = 0;
    // The next character, with CRLF and CR read as LF like xmlCurrentChar.
    const take = (): number => {
      const code = text.codePointAt(index) ?? -1;
      if (code === CHAR_CR) {
        width = text.charCodeAt(index + 1) === CHAR_LF ? 2 : 1;
        return CHAR_LF;
      }
      width = code > 0xff_ff ? 2 : 1;
      return code;
    };
    let qPosition = index;
    let q = take();
    if (q < 0) {
      this.error();
      this.pos = text.length;
      return null;
    }
    if (!isXmlChar(q)) {
      this.error();
      this.pos = index;
      return null;
    }
    index += width;
    let rPosition = index;
    let r = take();
    if (r < 0) {
      this.error();
      this.pos = text.length;
      return null;
    }
    if (!isXmlChar(r)) {
      this.error();
      this.pos = index;
      return null;
    }
    index += width;
    let cur = take();
    while (
      cur >= 0 &&
      isXmlChar(cur) &&
      (cur !== 0x3e || r !== 0x2d || q !== 0x2d)
    ) {
      if (r === 0x2d && q === 0x2d) {
        this.error();
      }
      q = r;
      qPosition = rPosition;
      r = cur;
      rPosition = index;
      index += width;
      cur = take();
    }
    if (cur < 0) {
      this.error();
      this.pos = text.length;
      return null;
    }
    if (!isXmlChar(cur)) {
      this.error();
      this.pos = index;
      return null;
    }
    this.pos = index + 1;
    return {
      kind: 'comment',
      value: normalizeNewlines(text.slice(start, qPosition)),
    };
  }

  private parsePI(): RProcessingInstruction | null {
    const { text } = this;
    this.pos += 2;
    const target = this.parseName();
    if (target === null) {
      this.error();
      return null;
    }
    if (target.toLowerCase() === 'xml') {
      this.error();
    }
    if (this.at('?>')) {
      this.pos += 2;
      return { kind: 'pi', target, value: '' };
    }
    if (this.skipBlanks() === 0) {
      this.error();
    }
    const start = this.pos;
    let index = start;
    while (index < text.length) {
      const code = text.codePointAt(index) ?? 0;
      if (code === 0x3f && text.charCodeAt(index + 1) === 0x3e) {
        this.pos = index + 2;
        return {
          kind: 'pi',
          target,
          value: normalizeNewlines(text.slice(start, index)),
        };
      }
      if (!isXmlChar(code)) {
        break;
      }
      index += code > 0xff_ff ? 2 : 1;
    }
    this.error();
    this.pos = index;
    return null;
  }

  // ---- DOCTYPE ----------------------------------------------------------

  private parseQuoted(): string | null {
    const quote = this.code();
    if (quote !== 0x22 && quote !== 0x27) {
      return null;
    }
    const close = this.text.indexOf(String.fromCharCode(quote), this.pos + 1);
    if (close < 0) {
      return null;
    }
    const value = this.text.slice(this.pos + 1, close);
    this.pos = close + 1;
    return value;
  }

  // ExternalID; `strict` requires the system literal after PUBLIC.
  private parseExternalId(strict: boolean): ExternalId | null {
    if (this.at('SYSTEM')) {
      this.pos += 6;
      if (this.skipBlanks() === 0) {
        this.error();
      }
      const systemId = this.parseQuoted();
      if (systemId === null) {
        this.error();
        return { publicId: null, systemId: null };
      }
      return { publicId: null, systemId };
    }
    if (this.at('PUBLIC')) {
      this.pos += 6;
      if (this.skipBlanks() === 0) {
        this.error();
      }
      const publicId = this.parseQuoted();
      if (publicId === null || !PUBID_LITERAL.test(publicId)) {
        // "Unfinished PubidLiteral"
        this.error();
        throw new Halt();
      }
      const blanks = this.skipBlanks();
      const quote = this.code();
      if (quote !== 0x22 && quote !== 0x27) {
        if (strict) {
          this.error();
        }
        return { publicId, systemId: null };
      }
      if (blanks === 0) {
        this.error();
      }
      const systemId = this.parseQuoted();
      if (systemId === null) {
        this.error();
      }
      return { publicId, systemId };
    }
    return null;
  }

  private parseDoctype(): void {
    this.pos += 9;
    if (this.skipBlanks() === 0) {
      this.error();
    }
    const name = this.parseName();
    if (name === null) {
      this.error();
    }
    this.skipBlanks();
    const external = this.parseExternalId(true);
    if (
      external &&
      (external.publicId !== null || external.systemId !== null)
    ) {
      this.hasExternalSubset = true;
    }
    // libxml2 creates the internal subset here, even without a name.
    this.hasDoctype = true;
    this.skipBlanks();
    if (this.code() === 0x5b) {
      this.pos += 1;
      if (!this.parseInternalSubset()) {
        return;
      }
      if (this.code() === 0x5d) {
        this.pos += 1;
        this.skipBlanks();
      }
    }
    if (this.code() === 0x3e) {
      this.pos += 1;
    } else {
      // "DOCTYPE improperly terminated"
      this.error();
    }
  }

  // xmlParseInternalSubset: stops at "]", at the end of input, at a
  // character that cannot start a declaration, or at a declaration that
  // could not be parsed at all.
  // Returns false when it stopped on an error: the offending character has
  // been skipped and the DOCTYPE is over (no "]" or ">" is expected).
  private parseInternalSubset(): boolean {
    this.skipBlanks();
    while (!this.eof && this.code() !== 0x5d) {
      const before = this.pos;
      try {
        if (this.at('<!--')) {
          this.parseComment();
        } else if (this.at('<?')) {
          this.parsePI();
        } else if (this.at('<!ENTITY')) {
          this.parseEntityDeclaration();
        } else if (this.at('<!ATTLIST')) {
          this.parseAttlistDeclaration();
        } else if (this.at('<!ELEMENT')) {
          this.parseElementDeclaration();
        } else if (this.at('<!NOTATION')) {
          this.parseNotationDeclaration();
        } else if (this.code() === 0x25) {
          this.parseParameterEntityReference();
        } else {
          // "Content error in the internal subset": the character is
          // skipped and the DOCTYPE ends there.
          this.error();
          this.pos += this.code() > 0xff_ff ? 2 : 1;
          return false;
        }
      } catch (error) {
        if (!(error instanceof DeclarationError)) {
          throw error;
        }
        this.error();
      }
      if (this.pos === before) {
        this.error();
        this.pos += this.code() > 0xff_ff ? 2 : 1;
        return false;
      }
      this.skipBlanks();
    }
    return true;
  }

  private requireBlanks(): void {
    if (this.skipBlanks() === 0) {
      this.error();
      throw new DeclarationError();
    }
  }

  private requireName(): string {
    const name = this.parseName();
    if (name === null) {
      this.error();
      throw new DeclarationError();
    }
    return name;
  }

  private requireDeclarationEnd(): void {
    this.skipBlanks();
    if (this.code() !== 0x3e) {
      this.error();
      throw new DeclarationError();
    }
    this.pos += 1;
  }

  private parseParameterEntityReference(): void {
    this.pos += 1;
    const name = this.requireName();
    if (this.code() !== 0x3b) {
      this.error();
      throw new DeclarationError();
    }
    this.pos += 1;
    // An undefined parameter entity is only a warning (the reference itself
    // marks the DTD as having PE references); the reference is dropped.
    this.hasParameterEntityReferences = true;
    if (this.standalone && !this.entities.has(`%${name}`)) {
      this.error();
    }
  }

  private parseEntityDeclaration(): void {
    this.pos += 8;
    this.requireBlanks();
    let parameter = false;
    if (this.code() === 0x25) {
      this.pos += 1;
      this.requireBlanks();
      parameter = true;
    }
    const name = this.requireName();
    this.requireBlanks();
    const key = parameter ? `%${name}` : name;
    let internal = false;
    const value = this.parseQuoted();
    if (value === null) {
      const external = this.parseExternalId(false);
      if (
        !external ||
        (external.publicId === null && external.systemId === null)
      ) {
        this.error();
        throw new DeclarationError();
      }
      const blanks = this.skipBlanks();
      if (!parameter && blanks > 0 && this.at('NDATA')) {
        this.pos += 5;
        this.requireBlanks();
        this.requireName();
      }
    } else {
      internal = true;
    }
    this.requireDeclarationEnd();
    if (!parameter && PREDEFINED.has(name)) {
      return;
    }
    if (this.entities.has(key)) {
      return;
    }
    this.entities.set(key, { internal });
  }

  private parseNotationDeclaration(): void {
    this.pos += 10;
    this.requireBlanks();
    this.requireName();
    this.requireBlanks();
    const external = this.parseExternalId(false);
    if (
      !external ||
      (external.publicId === null && external.systemId === null)
    ) {
      this.error();
      throw new DeclarationError();
    }
    this.requireDeclarationEnd();
  }

  private parseEnumeration(names: boolean): void {
    // ptr at "("
    this.pos += 1;
    for (;;) {
      this.skipBlanks();
      const value = names ? this.parseName() : this.parseNmtoken();
      if (value === null) {
        this.error();
        throw new DeclarationError();
      }
      this.skipBlanks();
      if (this.code() === 0x7c) {
        this.pos += 1;
        continue;
      }
      if (this.code() === 0x29) {
        this.pos += 1;
        return;
      }
      this.error();
      throw new DeclarationError();
    }
  }

  private parseAttlistDeclaration(): void {
    this.pos += 9;
    this.requireBlanks();
    this.requireName();
    for (;;) {
      const blanks = this.skipBlanks();
      if (this.code() === 0x3e) {
        this.pos += 1;
        return;
      }
      if (blanks === 0) {
        this.error();
        throw new DeclarationError();
      }
      this.requireName();
      this.requireBlanks();
      if (this.at('NOTATION')) {
        this.pos += 8;
        this.requireBlanks();
        if (this.code() !== 0x28) {
          this.error();
          throw new DeclarationError();
        }
        this.parseEnumeration(true);
      } else if (this.code() === 0x28) {
        this.parseEnumeration(false);
      } else {
        const keyword = ELEMENT_TYPE_KEYWORDS.find(candidate =>
          this.at(candidate),
        );
        if (!keyword) {
          this.error();
          throw new DeclarationError();
        }
        this.pos += keyword.length;
      }
      this.requireBlanks();
      if (this.at('#REQUIRED')) {
        this.pos += 9;
      } else if (this.at('#IMPLIED')) {
        this.pos += 8;
      } else {
        if (this.at('#FIXED')) {
          this.pos += 6;
          this.requireBlanks();
        }
        this.skipDtdAttributeValue();
      }
    }
  }

  // An attribute default, which only matters for where it ends.
  private skipDtdAttributeValue(): void {
    const quote = this.code();
    if (quote !== 0x22 && quote !== 0x27) {
      this.error();
      throw new DeclarationError();
    }
    this.pos += 1;
    for (;;) {
      if (this.eof) {
        this.error();
        throw new DeclarationError();
      }
      const code = this.code();
      if (code === quote) {
        this.pos += 1;
        return;
      }
      if (code === 0x26) {
        if (this.parseAttributeReference(true) === null) {
          this.error();
          throw new DeclarationError();
        }
        continue;
      }
      if (code === 0x3c) {
        this.error();
      }
      this.pos += code > 0xff_ff ? 2 : 1;
    }
  }

  private parseElementDeclaration(): void {
    this.pos += 9;
    this.requireBlanks();
    this.requireName();
    this.requireBlanks();
    if (this.at('EMPTY')) {
      this.pos += 5;
    } else if (this.at('ANY')) {
      this.pos += 3;
    } else if (this.code() === 0x28) {
      this.parseContentModel();
    } else {
      this.error();
      throw new DeclarationError();
    }
    this.requireDeclarationEnd();
  }

  // A content model ("(a | b)*", "(a , b?)"): only the separator of each open
  // group is kept, and groups nest like xmlParseElementChildrenContentDeclPriv.
  private parseContentModel(): void {
    const separators = [0];
    this.pos += 1;
    for (;;) {
      this.skipBlanks();
      if (this.code() === 0x28) {
        this.pos += 1;
        if (separators.length >= MAX_CONTENT_MODEL_DEPTH) {
          // "depth 257 too deep": the declaration ends here.
          this.error();
          throw new DeclarationError();
        }
        separators.push(0);
        continue;
      }
      if (this.at('#PCDATA')) {
        this.pos += 7;
      } else if (this.parseName() === null) {
        this.error();
        throw new DeclarationError();
      } else {
        this.skipOccurrence();
      }
      // Separators and closing parentheses after an item.
      for (;;) {
        this.skipBlanks();
        const code = this.code();
        if (code === 0x7c || code === 0x2c) {
          const current = separators.at(-1) as number;
          if (current !== 0 && current !== code) {
            this.error();
            throw new DeclarationError();
          }
          separators[separators.length - 1] = code;
          this.pos += 1;
          break;
        }
        if (code !== 0x29) {
          this.error();
          throw new DeclarationError();
        }
        this.pos += 1;
        separators.pop();
        this.skipOccurrence();
        if (separators.length === 0) {
          return;
        }
      }
    }
  }

  private skipOccurrence(): void {
    const code = this.code();
    if (code === 0x3f || code === 0x2a || code === 0x2b) {
      this.pos += 1;
    }
  }

  // ---- references ----------------------------------------------------------

  // xmlParseCharRef after "&#": the code point (0 for an invalid reference).
  private parseCharRef(): number {
    let value = 0;
    let digits = 0;
    if (this.code() === 0x78) {
      this.pos += 1;
      for (;;) {
        const code = this.code();
        if (code === 0x3b) {
          this.pos += 1;
          break;
        }
        const digit = Number.parseInt(String.fromCharCode(code), 16);
        if (code < 0 || Number.isNaN(digit)) {
          value = 0;
          digits = 0;
          break;
        }
        value = Math.min(value * 16 + digit, 0x11_00_00);
        digits += 1;
        this.pos += 1;
      }
    } else {
      for (;;) {
        const code = this.code();
        if (code === 0x3b) {
          this.pos += 1;
          break;
        }
        if (code < 0x30 || code > 0x39) {
          value = 0;
          digits = 0;
          break;
        }
        value = Math.min(value * 10 + (code - 0x30), 0x11_00_00);
        digits += 1;
        this.pos += 1;
      }
    }
    if (digits === 0 || value === 0) {
      this.error();
      return 0;
    }
    if (value > MAX_UNICODE) {
      this.error();
      return REPLACEMENT_CHARACTER;
    }
    if (!isXmlChar(value)) {
      this.error();
      if (value >= 0xd8_00 && value <= 0xdf_ff) {
        // Stored as is; lxml then fails to serialize the document.
        this.unserializable = true;
      }
    }
    return value;
  }

  // xmlParseEntityRef after "&": the name, or null (an error was reported).
  private parseEntityName(): string | null {
    const name = this.parseName();
    if (name === null) {
      this.error();
      return null;
    }
    if (this.code() !== 0x3b) {
      this.error();
      return null;
    }
    this.pos += 1;
    return name;
  }

  private entityIsUndeclaredError(): boolean {
    return (
      this.standalone ||
      !(this.hasExternalSubset || this.hasParameterEntityReferences)
    );
  }

  // A reference inside an attribute value; null when the value must be
  // discarded (a character reference to 0).
  private parseAttributeReference(inDtd: boolean): string | null {
    this.pos += 1;
    if (this.code() === 0x23) {
      this.pos += 1;
      const code = this.parseCharRef();
      if (code === 0) {
        return null;
      }
      if (inDtd && code === 0x26) {
        return '&#38;';
      }
      return String.fromCodePoint(code);
    }
    const name = this.parseEntityName();
    if (name === null) {
      return '';
    }
    const predefined = PREDEFINED.get(name);
    if (predefined !== undefined) {
      return inDtd && predefined === '&' ? '&#38;' : predefined;
    }
    if (this.entities.has(name)) {
      return `&${name};`;
    }
    if (this.entityIsUndeclaredError()) {
      this.error();
    }
    return '';
  }

  // xmlParseReference in content.
  private parseContentReference(): void {
    this.pos += 1;
    if (this.code() === 0x23) {
      this.pos += 1;
      const code = this.parseCharRef();
      if (code !== 0) {
        this.appendText(String.fromCodePoint(code));
      }
      return;
    }
    const name = this.parseEntityName();
    if (name === null) {
      return;
    }
    const predefined = PREDEFINED.get(name);
    if (predefined === undefined && !this.entities.has(name)) {
      if (this.entityIsUndeclaredError()) {
        this.error();
      }
      this.writeEntityReference(name);
      return;
    }
    if (!this.wellFormed) {
      return;
    }
    if (predefined === undefined) {
      this.writeEntityReference(name);
    } else {
      this.appendText(predefined);
    }
  }

  // ---- output -------------------------------------------------------------

  // Before a child of the innermost open element: ends its start tag.
  private beginChild(): void {
    if (this.startTagPending) {
      this.out.byte(0x3e);
      this.startTagPending = false;
    }
  }

  private writeEntityReference(name: string): void {
    this.beginChild();
    this.textRun = -1;
    this.out.byte(0x26);
    this.out.write(name);
    this.out.byte(0x3b);
  }

  private writeChildComment(comment: RComment): void {
    this.beginChild();
    this.textRun = -1;
    this.out.write('<!--');
    this.out.write(comment.value);
    this.out.write('-->');
  }

  private writeChildPI(pi: RProcessingInstruction): void {
    this.beginChild();
    this.textRun = -1;
    this.out.write(serializePI(pi));
  }

  // Closes the innermost open element ("<a/>" when it has no children).
  private closeElement(): void {
    const name = this.openElements.pop() as string;
    if (this.startTagPending) {
      this.out.write('/>');
      this.startTagPending = false;
    } else {
      this.out.write('</');
      this.out.write(name);
      this.out.byte(0x3e);
    }
    // The parent's last child is now this element.
    this.textRun = -1;
  }

  // ---- elements -----------------------------------------------------------

  // Text for the innermost open element: `value.slice(start, end)`, merged
  // into its last child when that is a text node.
  private appendText(value: string, start = 0, end = value.length): void {
    if (end === start) {
      return;
    }
    this.beginChild();
    const run = Math.max(this.textRun, 0);
    if (run + (end - start) > MAX_TEXT_LENGTH) {
      // "Resource limit exceeded: Text node too long": the node keeps what
      // fits and parsing stops.
      this.out.text(value, start, start + (MAX_TEXT_LENGTH - run), false);
      this.textRun = MAX_TEXT_LENGTH;
      this.error();
      throw new Halt();
    }
    this.out.text(value, start, end, false);
    this.textRun = run + (end - start);
  }

  // xmlParseAttValueInternal for a start tag; null when the value is invalid.
  // The value is copied in runs: one concatenation per character would hold
  // a rope node (32 bytes) per input byte until the value ends.
  private parseAttributeValue(): string | null {
    const quote = this.code();
    if (quote !== 0x22 && quote !== 0x27) {
      this.error();
      return null;
    }
    this.pos += 1;
    const value = new TextBuffer();
    let runStart = this.pos;
    const endRun = (): void => {
      if (this.pos > runStart) {
        value.push(this.text.slice(runStart, this.pos));
      }
    };
    for (;;) {
      if (this.eof) {
        this.error();
        return null;
      }
      const code = this.code();
      if (code === quote) {
        endRun();
        this.pos += 1;
        return value.text() ?? '';
      }
      if (code === 0x26) {
        endRun();
        const piece = this.parseAttributeReference(false);
        if (piece === null) {
          return null;
        }
        value.push(piece);
        runStart = this.pos;
        continue;
      }
      if (code === 0x3c) {
        this.error();
      }
      const width = code > 0xff_ff ? 2 : 1;
      if (code === CHAR_CR && this.code(1) === CHAR_LF) {
        // CRLF reads as one LF, so it becomes one space.
        endRun();
        this.pos += 1;
        runStart = this.pos;
      } else if (code !== CHAR_SPACE && isBlank(code)) {
        endRun();
        value.push(' ');
        this.pos += 1;
        runStart = this.pos;
      } else if (isXmlChar(code)) {
        this.pos += width;
      } else {
        // "invalid character in attribute value": control characters become
        // U+FFFD, the noncharacters U+FFFE/U+FFFF are kept.
        this.error();
        endRun();
        value.push(code < CHAR_SPACE ? '\uFFFD' : String.fromCodePoint(code));
        this.pos += width;
        runStart = this.pos;
      }
    }
  }

  // xmlParseStartTag2 + xmlParseElementStart. Writes the start tag (without
  // its ending) and returns the element name and whether it stays open, or
  // null when no element was created.
  private parseStartTag(): [string, boolean] | null {
    this.pos += 1;
    const name = this.parseName();
    if (name === null) {
      // "StartTag: invalid element name": "<" is dropped, the rest is text.
      this.error();
      return null;
    }
    const tag: StartTag = { attributes: [], name, namespaces: [], seen: null };
    this.skipBlanks();
    for (;;) {
      const code = this.code();
      const atEnd =
        code === 0x3e ||
        (code === 0x2f && this.text.charCodeAt(this.pos + 1) === 0x3e);
      const byteChar =
        code >= CHAR_SPACE ||
        code === CHAR_TAB ||
        code === CHAR_LF ||
        code === CHAR_CR;
      if (atEnd || !byteChar || this.eof) {
        break;
      }
      const attributeName = this.parseName();
      if (attributeName === null) {
        // "error parsing attribute name"
        this.error();
        break;
      }
      this.skipBlanks();
      let value: string | null = null;
      if (this.code() === 0x3d) {
        this.pos += 1;
        this.skipBlanks();
        value = this.parseAttributeValue();
      } else {
        // "Specification mandates value for attribute"
        this.error();
      }
      if (value !== null) {
        this.addAttribute(tag, attributeName, value);
      }
      const next = this.code();
      if (
        next === 0x3e ||
        (next === 0x2f && this.text.charCodeAt(this.pos + 1) === 0x3e)
      ) {
        break;
      }
      if (this.skipBlanks() === 0) {
        // "attributes construct error"
        this.error();
        break;
      }
    }
    let open: boolean;
    if (this.at('/>')) {
      this.pos += 2;
      open = false;
    } else if (this.code() === 0x3e) {
      this.pos += 1;
      open = true;
    } else {
      // "Couldn't find end of Start Tag": the element ends here, empty.
      this.error();
      open = false;
    }
    this.writeStartTag(tag);
    return [name, open];
  }

  // "<name" with its namespace declarations, then its attributes.
  private writeStartTag(tag: StartTag): void {
    const { out } = this;
    this.beginChild();
    out.byte(0x3c);
    out.write(tag.name);
    for (const [prefix, uri] of tag.namespaces) {
      out.write(prefix === '' ? ' xmlns="' : ' xmlns:');
      if (prefix !== '') {
        out.write(prefix);
        out.write('="');
      }
      out.text(uri, 0, uri.length, true);
      out.byte(0x22);
    }
    for (const [name, value] of tag.attributes) {
      out.byte(CHAR_SPACE);
      out.write(name);
      out.write('="');
      out.text(value, 0, value.length, true);
      out.byte(0x22);
    }
  }

  private addAttribute(tag: StartTag, name: string, value: string): void {
    tag.seen ??= new Set<string>();
    const { seen } = tag;
    if (name === 'xmlns' || name.startsWith('xmlns:')) {
      const prefix = name === 'xmlns' ? '' : name.slice(6);
      if (seen.has(name)) {
        this.error();
        return;
      }
      seen.add(name);
      if (
        prefix === 'xml' ||
        prefix === 'xmlns' ||
        (prefix !== '' && value === '')
      ) {
        return;
      }
      tag.namespaces.push([prefix, value]);
      return;
    }
    if (seen.has(name)) {
      // "Attribute x redefined": an error, but both are kept.
      this.error();
    }
    seen.add(name);
    tag.attributes.push([name, value]);
  }

  // A child element of the innermost open element, or the root: its name,
  // or null when there was no element.
  private startElement(): string | null {
    const started = this.parseStartTag();
    if (started === null) {
      return null;
    }
    const [name, open] = started;
    if (open) {
      this.openElements.push(name);
      this.startTagPending = true;
    } else {
      this.out.write('/>');
    }
    this.textRun = -1;
    return name;
  }

  private parseRootElement(): void {
    this.rootName = this.startElement();
    if (this.openElements.length > 0) {
      this.parseContent();
    }
  }

  // xmlParseEndTag2 after "</": the element is closed whatever the name.
  private parseEndTag(expected: string): void {
    this.pos += 2;
    const name = this.parseName();
    this.skipBlanks();
    if (this.code() === 0x3e) {
      this.pos += 1;
    } else {
      this.error();
    }
    if (name !== expected) {
      // "Opening and ending tag mismatch"
      this.error();
    }
  }

  // xmlParseContentInternal with an explicit stack of open elements.
  private parseContent(): void {
    const stack = this.openElements;
    const end = (): number =>
      this.haltAt >= 0 ? this.haltAt : this.text.length;
    while (this.pos < end()) {
      const code = this.text.charCodeAt(this.pos);
      if (code === 0x3c) {
        const next = this.text.charCodeAt(this.pos + 1);
        if (next === 0x2f) {
          // An end tag always closes the innermost element, whatever its
          // name; a mismatch is only an error.
          this.parseEndTag(stack.at(-1) as string);
          this.closeElement();
          if (stack.length === 0) {
            return;
          }
        } else if (next === 0x3f) {
          const pi = this.parsePI();
          if (pi) {
            this.writeChildPI(pi);
          }
        } else if (this.at('<!--')) {
          const comment = this.parseComment();
          if (comment) {
            this.writeChildComment(comment);
          }
        } else if (this.at('<![CDATA[')) {
          this.parseCdata();
        } else {
          if (stack.length >= MAX_DEPTH) {
            // "Excessive depth in document: 256"
            this.error();
            throw new Halt();
          }
          this.startElement();
        }
      } else if (code === 0x26) {
        this.parseContentReference();
      } else {
        this.parseCharData();
      }
    }
    if (this.haltAt >= 0) {
      throw new Halt();
    }
  }

  private parseCdata(): void {
    const start = this.pos + 9;
    let index = start;
    const { text } = this;
    while (index < text.length) {
      const code = text.codePointAt(index) ?? 0;
      if (code === 0x5d && text.startsWith(']]>', index)) {
        const value = normalizeNewlines(text.slice(start, index));
        if (value === '' && this.textRun < 0) {
          // libxml2 still adds an empty text node: "<a></a>", not "<a/>".
          this.beginChild();
          this.textRun = 0;
        }
        this.appendText(value);
        this.pos = index + 3;
        return;
      }
      if (!isXmlChar(code)) {
        this.error();
        this.pos = index;
        return;
      }
      index += code > 0xff_ff ? 2 : 1;
    }
    // "CData section not finished": everything up to the end is lost.
    this.error();
    this.pos = text.length;
  }

  // xmlParseCharData: an ASCII fast path, then a "complex" path.
  private parseCharData(): void {
    const { text } = this;
    const limit = this.haltAt >= 0 ? this.haltAt : text.length;
    let start = this.pos;
    let index = start;
    for (;;) {
      if (index >= limit) {
        this.appendText(text, start, index);
        this.pos = index;
        return;
      }
      const code = text.charCodeAt(index);
      if (code === 0x3c || code === 0x26) {
        this.appendText(text, start, index);
        this.pos = index;
        return;
      }
      if (code === 0x5d) {
        if (text.startsWith(']]>', index)) {
          // "Sequence ']]>' not allowed in content": the fast path drops the
          // text it has read and skips one "]".
          this.error();
          this.pos = index + 1;
          return;
        }
        index += 1;
        continue;
      }
      if (
        (code >= CHAR_SPACE && code <= ASCII_DEL) ||
        code === CHAR_TAB ||
        code === CHAR_LF
      ) {
        index += 1;
        continue;
      }
      if (code === CHAR_CR && text.charCodeAt(index + 1) === CHAR_LF) {
        // CRLF: the text before it is flushed and the run restarts at LF.
        this.appendText(text, start, index);
        start = index + 1;
        index += 2;
        continue;
      }
      break;
    }
    this.appendText(text, start, index);
    const complexStart = index;
    while (index < limit) {
      const code = text.codePointAt(index) ?? 0;
      if (code === 0x3c || code === 0x26 || !isXmlChar(code)) {
        break;
      }
      if (code === 0x5d && text.startsWith(']]>', index)) {
        this.error();
      }
      index += code > 0xff_ff ? 2 : 1;
    }
    this.appendText(
      normalizeNewlines(text.slice(complexStart, Math.min(index, limit))),
    );
    if (index < limit) {
      const code = text.codePointAt(index) ?? 0;
      if (code !== 0x3c && code !== 0x26) {
        // "PCDATA invalid Char value": the character is skipped.
        this.error();
        index += code > 0xff_ff ? 2 : 1;
      }
    }
    this.pos = index;
  }
}

/** The outcome of {@link recoverXml}. */
export interface RecoveredXml {
  /**
   * The recovered document has a DOCTYPE (parsedmarc rejects the report);
   * `xml` is then empty.
   */
  hasDoctype: boolean;
  /** The text parsedmarc parses again. */
  xml: string;
}

/**
 * Emulate parsedmarc's lxml recovery of malformed XML: libxml2's recovering
 * parser (`recover=True, resolve_entities=False`) followed by
 * `etree.tostring(root, encoding="unicode")`. `xml` is the recovered root
 * element, `""` when libxml2 found no root element, and `"<a/>"` where lxml
 * raises (empty input, a leading NUL, lone surrogates); `hasDoctype` is set
 * instead when the recovered tree has a DOCTYPE.
 */
export function recoverXml(text: string): RecoveredXml {
  try {
    assertEncodableUtf8(text);
  } catch {
    return { hasDoctype: false, xml: '<a/>' };
  }
  const first = text.charCodeAt(0) === 0xfe_ff ? 1 : 0;
  if (text === '' || (text.length > first && text.charCodeAt(first) === 0)) {
    // "Document is empty"
    return { hasDoctype: false, xml: '<a/>' };
  }
  // libxml2 sniffs "<\0?\0" as UTF-16LE without a byte order mark (what a
  // UTF-16 report becomes after decode(errors="ignore") drops its BOM).
  const source = text.startsWith('<\u0000?\u0000')
    ? new TextDecoder('utf-16le').decode(new TextEncoder().encode(text))
    : text;
  return new RecoveringParser(source).run();
}
