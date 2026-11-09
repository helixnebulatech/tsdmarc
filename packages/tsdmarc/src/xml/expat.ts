// A port of the parts of Expat 2.9.0 (lib/xmltok_impl.c, xmltok.c, xmlrole.c,
// xmlparse.c) that pyexpat runs when xmltodict parses a complete document:
// tokenizer, prolog/DTD role machine, content and epilog processors. Only the
// observable behavior matters here: the same events, the same attribute
// values and the same error code, line and column for every input, so
// `Invalid XML: ...` messages match parsedmarc's.
//
// What is left out because pyexpat never reaches it with xmltodict's setup
// (no namespace processing, parameter entity parsing off, no external entity
// handler): namespaces, external entities, conditional sections, encodings
// other than UTF-8 and UTF-16, and internal entity expansion. The last one is
// a consequence of xmltodict's `disable_entities=True`: every entity
// declaration Expat would store raises "entities are disabled" first, so the
// only entities that can ever be referenced are the five predefined ones.
//
// Expat is Copyright (c) 1997-2000 Thai Open Source Software Center Ltd and
// Copyright (c) 2000-2026 Expat development team, under the MIT license:
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { isNameCode, isNmstrtCode } from './expat-names';

// ---------------------------------------------------------------------------
// Errors

/** Expat's `XML_ErrorString()` table, indexed by `enum XML_Error`. */
const ERROR_STRINGS: readonly string[] = [
  '',
  'out of memory',
  'syntax error',
  'no element found',
  'not well-formed (invalid token)',
  'unclosed token',
  'partial character',
  'mismatched tag',
  'duplicate attribute',
  'junk after document element',
  'illegal parameter entity reference',
  'undefined entity',
  'recursive entity reference',
  'asynchronous entity',
  'reference to invalid character number',
  'reference to binary entity',
  'reference to external entity in attribute',
  'XML or text declaration not at start of entity',
  'unknown encoding',
  'encoding specified in XML declaration is incorrect',
  'unclosed CDATA section',
  'error in processing external entity reference',
  'document is not standalone',
  'unexpected parser state - please send a bug report',
  'entity declared in parameter entity',
  'requested feature requires XML_DTD support in Expat',
  'cannot change setting once parsing has begun',
  'unbound prefix',
  'must not undeclare prefix',
  'incomplete markup in parameter entity',
  'XML declaration not well-formed',
  'text declaration not well-formed',
  'illegal character(s) in public id',
  'parser suspended',
  'parser not suspended',
  'parsing aborted',
  'parsing finished',
  'cannot suspend in external parameter entity',
  'reserved prefix (xml) must not be undeclared or bound to another namespace name',
  'reserved prefix (xmlns) must not be declared or undeclared',
  'prefix must not be bound to one of the reserved namespace names',
  'invalid argument',
  'a successful prior call to function XML_GetBuffer is required',
  'limit on input amplification factor (from DTD and entities) breached',
];

const XML_ERROR_SYNTAX = 2;
const XML_ERROR_NO_ELEMENTS = 3;
const XML_ERROR_INVALID_TOKEN = 4;
const XML_ERROR_UNCLOSED_TOKEN = 5;
const XML_ERROR_PARTIAL_CHAR = 6;
const XML_ERROR_TAG_MISMATCH = 7;
const XML_ERROR_DUPLICATE_ATTRIBUTE = 8;
const XML_ERROR_JUNK_AFTER_DOC_ELEMENT = 9;
const XML_ERROR_PARAM_ENTITY_REF = 10;
const XML_ERROR_UNDEFINED_ENTITY = 11;
const XML_ERROR_BAD_CHAR_REF = 14;
const XML_ERROR_MISPLACED_XML_PI = 17;
const XML_ERROR_UNCLOSED_CDATA_SECTION = 20;
const XML_ERROR_XML_DECL = 30;
const XML_ERROR_PUBLICID = 32;

/**
 * Python's `xml.parsers.expat.ExpatError`: the message is Expat's error
 * string followed by `: line N, column M` (line 1-based, column 0-based and
 * counted in characters), exactly as pyexpat formats it.
 */
export class ExpatError extends Error {
  override name = 'ExpatError';
  /** Expat's numeric error code (`enum XML_Error`). */
  readonly code: number;
  /** 1-based line of the error. */
  readonly lineno: number;
  /** 0-based column of the error, in characters. */
  readonly offset: number;

  constructor(code: number, lineno: number, offset: number) {
    super(
      `${ERROR_STRINGS[code] ?? 'unknown error'}: line ${lineno}, column ${offset}`,
    );
    this.code = code;
    this.lineno = lineno;
    this.offset = offset;
  }
}

// Thrown inside the parser; converted to ExpatError with a position at the top.
class ParseFailure {
  readonly code: number;

  constructor(code: number) {
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Character classes (xmltok_impl.h byte types)

const BT_NONXML = 0;
const BT_MALFORM = 1;
const BT_LT = 2;
const BT_AMP = 3;
const BT_RSQB = 4;
const BT_LEAD4 = 7;
const BT_TRAIL = 8;
const BT_CR = 9;
const BT_LF = 10;
const BT_GT = 11;
const BT_QUOT = 12;
const BT_APOS = 13;
const BT_EQUALS = 14;
const BT_QUEST = 15;
const BT_EXCL = 16;
const BT_SOL = 17;
const BT_SEMI = 18;
const BT_NUM = 19;
const BT_LSQB = 20;
const BT_S = 21;
const BT_NMSTRT = 22;
const BT_HEX = 24;
const BT_DIGIT = 25;
const BT_NAME = 26;
const BT_MINUS = 27;
const BT_OTHER = 28;
const BT_NONASCII = 29;
const BT_PERCNT = 30;
const BT_LPAR = 31;
const BT_RPAR = 32;
const BT_AST = 33;
const BT_PLUS = 34;
const BT_COMMA = 35;
const BT_VERBAR = 36;

// asciitab.h for the non-namespace encoding (":" is an ordinary name start).
const ASCII_TYPES: Uint8Array = (() => {
  const table = new Uint8Array(128).fill(BT_OTHER);
  for (let c = 0; c < 0x20; c += 1) {
    table[c] = BT_NONXML;
  }
  table[0x09] = BT_S;
  table[0x0a] = BT_LF;
  table[0x0d] = BT_CR;
  table[0x20] = BT_S;
  const singles: [string, number][] = [
    ['!', BT_EXCL],
    ['"', BT_QUOT],
    ['#', BT_NUM],
    ['%', BT_PERCNT],
    ['&', BT_AMP],
    ["'", BT_APOS],
    ['(', BT_LPAR],
    [')', BT_RPAR],
    ['*', BT_AST],
    ['+', BT_PLUS],
    [',', BT_COMMA],
    ['-', BT_MINUS],
    ['.', BT_NAME],
    ['/', BT_SOL],
    [':', BT_NMSTRT],
    [';', BT_SEMI],
    ['<', BT_LT],
    ['=', BT_EQUALS],
    ['>', BT_GT],
    ['?', BT_QUEST],
    ['[', BT_LSQB],
    [']', BT_RSQB],
    ['_', BT_NMSTRT],
    ['|', BT_VERBAR],
  ];
  for (const [char, type] of singles) {
    table[char.charCodeAt(0)] = type;
  }
  for (let c = 0x30; c <= 0x39; c += 1) {
    table[c] = BT_DIGIT;
  }
  for (let c = 0x41; c <= 0x5a; c += 1) {
    table[c] = BT_NMSTRT;
    table[c + 0x20] = BT_NMSTRT;
  }
  for (let c = 0x41; c <= 0x46; c += 1) {
    table[c] = BT_HEX;
    table[c + 0x20] = BT_HEX;
  }
  return table;
})();

// ---------------------------------------------------------------------------
// Tokens (xmltok.h)

const TOK_TRAILING_RSQB = -5;
const TOK_NONE = -4;
const TOK_TRAILING_CR = -3;
const TOK_PARTIAL_CHAR = -2;
const TOK_PARTIAL = -1;
const TOK_INVALID = 0;
const TOK_START_TAG_WITH_ATTS = 1;
const TOK_START_TAG_NO_ATTS = 2;
const TOK_EMPTY_ELEMENT_WITH_ATTS = 3;
const TOK_EMPTY_ELEMENT_NO_ATTS = 4;
const TOK_END_TAG = 5;
const TOK_DATA_CHARS = 6;
const TOK_DATA_NEWLINE = 7;
const TOK_CDATA_SECT_OPEN = 8;
const TOK_ENTITY_REF = 9;
const TOK_CHAR_REF = 10;
const TOK_PI = 11;
const TOK_XML_DECL = 12;
const TOK_COMMENT = 13;
const TOK_BOM = 14;
const TOK_PROLOG_S = 15;
const TOK_DECL_OPEN = 16;
const TOK_DECL_CLOSE = 17;
const TOK_NAME = 18;
const TOK_NMTOKEN = 19;
const TOK_POUND_NAME = 20;
const TOK_OR = 21;
const TOK_PERCENT = 22;
const TOK_OPEN_PAREN = 23;
const TOK_CLOSE_PAREN = 24;
const TOK_OPEN_BRACKET = 25;
const TOK_CLOSE_BRACKET = 26;
const TOK_LITERAL = 27;
const TOK_PARAM_ENTITY_REF = 28;
const TOK_INSTANCE_START = 29;
const TOK_NAME_QUESTION = 30;
const TOK_NAME_ASTERISK = 31;
const TOK_NAME_PLUS = 32;
const TOK_COND_SECT_OPEN = 33;
const TOK_COND_SECT_CLOSE = 34;
const TOK_CLOSE_PAREN_QUESTION = 35;
const TOK_CLOSE_PAREN_ASTERISK = 36;
const TOK_CLOSE_PAREN_PLUS = 37;
const TOK_COMMA = 38;
const TOK_ATTRIBUTE_VALUE_S = 39;
const TOK_CDATA_SECT_CLOSE = 40;

// Results of the CHECK_NAME_CASES / CHECK_NMSTRT_CASES / INVALID_CASES helpers
// when the character is not simply consumed.
const STEP_NOT_HANDLED = 0;
const STEP_INVALID = -1;
const STEP_PARTIAL_CHAR = -2;

const MAX_CODE_POINT = 0x11_00_00;
const HIGH_SURROGATE_MIN = 0xd8_00;
const HIGH_SURROGATE_MAX = 0xdb_ff;
const LOW_SURROGATE_MIN = 0xdc_00;
const LOW_SURROGATE_MAX = 0xdf_ff;
const NONCHAR_FFFE = 0xff_fe;
const NONCHAR_FFFF = 0xff_ff;
const ASCII_LIMIT = 0x80;
const BOM = 0xfe_ff;

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}

/**
 * Expat's tokenizer over a string of UTF-16 code units. A non-ASCII BMP
 * character plays the role of a 2- or 3-byte UTF-8 sequence (one unit wide),
 * a surrogate pair the role of a 4-byte sequence (two units wide).
 */
class Tokenizer {
  readonly text: string;
  readonly end: number;
  // UTF-16 input with an odd number of bytes: a dangling byte after `end`.
  readonly oddTail: boolean;
  // Input auto-detected as UTF-16 rather than the declared UTF-8.
  readonly utf16: boolean;
  /** The `nextTokPtr` out-parameter of Expat's scanners. */
  next = 0;

  constructor(text: string, utf16: boolean, oddTail: boolean) {
    this.text = text;
    this.end = text.length;
    this.utf16 = utf16;
    this.oddTail = oddTail;
  }

  type(ptr: number): number {
    const code = this.text.charCodeAt(ptr);
    if (code < ASCII_LIMIT) {
      return ASCII_TYPES[code] ?? BT_OTHER;
    }
    if (code >= HIGH_SURROGATE_MIN && code <= LOW_SURROGATE_MAX) {
      return code <= HIGH_SURROGATE_MAX ? BT_LEAD4 : BT_TRAIL;
    }
    return code === NONCHAR_FFFE || code === NONCHAR_FFFF
      ? BT_NONXML
      : BT_NONASCII;
  }

  code(ptr: number): number {
    return this.text.charCodeAt(ptr);
  }

  is(ptr: number, char: string): boolean {
    return this.text.charCodeAt(ptr) === char.charCodeAt(0);
  }

  private leadInvalid(ptr: number): boolean {
    return !isLowSurrogate(this.text.charCodeAt(ptr + 1));
  }

  // INVALID_CASES: width consumed, or a STEP_* result.
  invalidStep(ptr: number, end: number, type: number): number {
    switch (type) {
      case BT_NONASCII:
        return 1;
      case BT_LEAD4:
        if (end - ptr < 2) {
          return STEP_PARTIAL_CHAR;
        }
        return this.leadInvalid(ptr) ? STEP_INVALID : 2;
      case BT_NONXML:
      case BT_MALFORM:
      case BT_TRAIL:
        return STEP_INVALID;
      default:
        return STEP_NOT_HANDLED;
    }
  }

  // CHECK_NAME_CASES.
  nameStep(ptr: number, end: number, type: number): number {
    switch (type) {
      case BT_NONASCII:
        return isNameCode(this.code(ptr)) ? 1 : STEP_INVALID;
      case BT_NMSTRT:
      case BT_HEX:
      case BT_DIGIT:
      case BT_NAME:
      case BT_MINUS:
        return 1;
      case BT_LEAD4:
        // Expat's isName4/isNmstrt4 are "never": no name has an astral char.
        return end - ptr < 2 ? STEP_PARTIAL_CHAR : STEP_INVALID;
      default:
        return STEP_NOT_HANDLED;
    }
  }

  // CHECK_NMSTRT_CASES.
  nmstrtStep(ptr: number, end: number, type: number): number {
    switch (type) {
      case BT_NONASCII:
        return isNmstrtCode(this.code(ptr)) ? 1 : STEP_INVALID;
      case BT_NMSTRT:
      case BT_HEX:
        return 1;
      case BT_LEAD4:
        return end - ptr < 2 ? STEP_PARTIAL_CHAR : STEP_INVALID;
      default:
        return STEP_NOT_HANDLED;
    }
  }

  // Shared ending of a scanner that hit a STEP_INVALID/STEP_PARTIAL_CHAR.
  private fail(step: number, ptr: number): number {
    if (step === STEP_PARTIAL_CHAR) {
      return TOK_PARTIAL_CHAR;
    }
    this.next = ptr;
    return TOK_INVALID;
  }

  private emptyResult(): number {
    return this.oddTail ? TOK_PARTIAL : TOK_NONE;
  }

  // ptr points to the character following "<!-".
  scanComment(start: number, end: number): number {
    let ptr = start;
    if (ptr < end) {
      if (!this.is(ptr, '-')) {
        this.next = ptr;
        return TOK_INVALID;
      }
      ptr += 1;
      while (ptr < end) {
        const type = this.type(ptr);
        const step = this.invalidStep(ptr, end, type);
        if (step > 0) {
          ptr += step;
          continue;
        }
        if (step < 0) {
          return this.fail(step, ptr);
        }
        if (type === BT_MINUS) {
          ptr += 1;
          if (ptr >= end) {
            return TOK_PARTIAL;
          }
          if (this.is(ptr, '-')) {
            ptr += 1;
            if (ptr >= end) {
              return TOK_PARTIAL;
            }
            if (!this.is(ptr, '>')) {
              this.next = ptr;
              return TOK_INVALID;
            }
            this.next = ptr + 1;
            return TOK_COMMENT;
          }
          continue;
        }
        ptr += 1;
      }
    }
    return TOK_PARTIAL;
  }

  // ptr points to the character following "<!".
  scanDecl(start: number, end: number): number {
    let ptr = start;
    if (ptr >= end) {
      return TOK_PARTIAL;
    }
    switch (this.type(ptr)) {
      case BT_MINUS:
        return this.scanComment(ptr + 1, end);
      case BT_LSQB:
        this.next = ptr + 1;
        return TOK_COND_SECT_OPEN;
      case BT_NMSTRT:
      case BT_HEX:
        ptr += 1;
        break;
      default:
        this.next = ptr;
        return TOK_INVALID;
    }
    while (ptr < end) {
      switch (this.type(ptr)) {
        case BT_PERCNT: {
          if (end - ptr < 2) {
            return TOK_PARTIAL;
          }
          // Don't allow <!ENTITY% foo "whatever">.
          const following = this.type(ptr + 1);
          if (
            following === BT_S ||
            following === BT_CR ||
            following === BT_LF ||
            following === BT_PERCNT
          ) {
            this.next = ptr;
            return TOK_INVALID;
          }
          this.next = ptr;
          return TOK_DECL_OPEN;
        }
        case BT_S:
        case BT_CR:
        case BT_LF:
          this.next = ptr;
          return TOK_DECL_OPEN;
        case BT_NMSTRT:
        case BT_HEX:
          ptr += 1;
          break;
        default:
          this.next = ptr;
          return TOK_INVALID;
      }
    }
    return TOK_PARTIAL;
  }

  // Returns the PI token kind, or TOK_INVALID for a mixed-case "xml" target.
  private piTargetKind(start: number, end: number): number {
    if (end - start !== 3) {
      return TOK_PI;
    }
    const target = this.text.slice(start, end);
    if (target === 'xml') {
      return TOK_XML_DECL;
    }
    return target.toLowerCase() === 'xml' ? TOK_INVALID : TOK_PI;
  }

  // ptr points to the character following "<?".
  scanPi(start: number, end: number): number {
    let ptr = start;
    const target = ptr;
    if (ptr >= end) {
      return TOK_PARTIAL;
    }
    const first = this.nmstrtStep(ptr, end, this.type(ptr));
    if (first <= 0) {
      return this.fail(first === STEP_PARTIAL_CHAR ? first : STEP_INVALID, ptr);
    }
    ptr += first;
    while (ptr < end) {
      const type = this.type(ptr);
      const step = this.nameStep(ptr, end, type);
      if (step > 0) {
        ptr += step;
        continue;
      }
      if (step < 0) {
        return this.fail(step, ptr);
      }
      if (type === BT_S || type === BT_CR || type === BT_LF) {
        const tok = this.piTargetKind(target, ptr);
        if (tok === TOK_INVALID) {
          this.next = ptr;
          return TOK_INVALID;
        }
        ptr += 1;
        while (ptr < end) {
          const inner = this.type(ptr);
          const innerStep = this.invalidStep(ptr, end, inner);
          if (innerStep > 0) {
            ptr += innerStep;
            continue;
          }
          if (innerStep < 0) {
            return this.fail(innerStep, ptr);
          }
          if (inner === BT_QUEST) {
            ptr += 1;
            if (ptr >= end) {
              return TOK_PARTIAL;
            }
            if (this.is(ptr, '>')) {
              this.next = ptr + 1;
              return tok;
            }
            continue;
          }
          ptr += 1;
        }
        return TOK_PARTIAL;
      }
      if (type === BT_QUEST) {
        const tok = this.piTargetKind(target, ptr);
        if (tok === TOK_INVALID) {
          this.next = ptr;
          return TOK_INVALID;
        }
        ptr += 1;
        if (ptr >= end) {
          return TOK_PARTIAL;
        }
        if (this.is(ptr, '>')) {
          this.next = ptr + 1;
          return tok;
        }
      }
      this.next = ptr;
      return TOK_INVALID;
    }
    return TOK_PARTIAL;
  }

  // ptr points to the character following "<![".
  scanCdataSection(start: number, end: number): number {
    let ptr = start;
    const expected = 'CDATA[';
    if (end - ptr < expected.length) {
      return TOK_PARTIAL;
    }
    for (const char of expected) {
      if (!this.is(ptr, char)) {
        this.next = ptr;
        return TOK_INVALID;
      }
      ptr += 1;
    }
    this.next = ptr;
    return TOK_CDATA_SECT_OPEN;
  }

  cdataSectionTok(start: number): number {
    const { end } = this;
    let ptr = start;
    if (ptr >= end) {
      return this.emptyResult();
    }
    const type = this.type(ptr);
    switch (type) {
      case BT_RSQB:
        ptr += 1;
        if (ptr >= end) {
          return TOK_PARTIAL;
        }
        if (!this.is(ptr, ']')) {
          break;
        }
        ptr += 1;
        if (ptr >= end) {
          return TOK_PARTIAL;
        }
        if (!this.is(ptr, '>')) {
          ptr -= 1;
          break;
        }
        this.next = ptr + 1;
        return TOK_CDATA_SECT_CLOSE;
      case BT_CR:
        ptr += 1;
        if (ptr >= end) {
          return TOK_PARTIAL;
        }
        if (this.type(ptr) === BT_LF) {
          ptr += 1;
        }
        this.next = ptr;
        return TOK_DATA_NEWLINE;
      case BT_LF:
        this.next = ptr + 1;
        return TOK_DATA_NEWLINE;
      default: {
        const step = this.invalidStep(ptr, end, type);
        if (step < 0) {
          return this.fail(step, ptr);
        }
        ptr += step > 0 ? step : 1;
      }
    }
    return this.dataRun(ptr, end, false);
  }

  // The data-character loop shared by contentTok and cdataSectionTok.
  private dataRun(start: number, end: number, inContent: boolean): number {
    let ptr = start;
    while (ptr < end) {
      const type = this.type(ptr);
      switch (type) {
        case BT_LEAD4:
          if (end - ptr < 2 || this.leadInvalid(ptr)) {
            this.next = ptr;
            return TOK_DATA_CHARS;
          }
          ptr += 2;
          continue;
        case BT_RSQB:
          if (inContent && end - ptr >= 2) {
            if (!this.is(ptr + 1, ']')) {
              ptr += 1;
              continue;
            }
            if (end - ptr >= 3) {
              if (!this.is(ptr + 2, '>')) {
                ptr += 1;
                continue;
              }
              this.next = ptr + 2;
              return TOK_INVALID;
            }
          }
          this.next = ptr;
          return TOK_DATA_CHARS;
        case BT_AMP:
        case BT_LT:
          if (!inContent) {
            ptr += 1;
            continue;
          }
          this.next = ptr;
          return TOK_DATA_CHARS;
        case BT_NONXML:
        case BT_MALFORM:
        case BT_TRAIL:
        case BT_CR:
        case BT_LF:
          this.next = ptr;
          return TOK_DATA_CHARS;
        default:
          ptr += 1;
      }
    }
    this.next = ptr;
    return TOK_DATA_CHARS;
  }

  // ptr points to the character following "</".
  scanEndTag(start: number, end: number): number {
    let ptr = start;
    if (ptr >= end) {
      return TOK_PARTIAL;
    }
    const first = this.nmstrtStep(ptr, end, this.type(ptr));
    if (first <= 0) {
      return this.fail(first === STEP_PARTIAL_CHAR ? first : STEP_INVALID, ptr);
    }
    ptr += first;
    while (ptr < end) {
      const type = this.type(ptr);
      const step = this.nameStep(ptr, end, type);
      if (step > 0) {
        ptr += step;
        continue;
      }
      if (step < 0) {
        return this.fail(step, ptr);
      }
      switch (type) {
        case BT_S:
        case BT_CR:
        case BT_LF:
          for (ptr += 1; ptr < end; ptr += 1) {
            const inner = this.type(ptr);
            if (inner === BT_S || inner === BT_CR || inner === BT_LF) {
              continue;
            }
            if (inner === BT_GT) {
              this.next = ptr + 1;
              return TOK_END_TAG;
            }
            this.next = ptr;
            return TOK_INVALID;
          }
          return TOK_PARTIAL;
        case BT_GT:
          this.next = ptr + 1;
          return TOK_END_TAG;
        default:
          this.next = ptr;
          return TOK_INVALID;
      }
    }
    return TOK_PARTIAL;
  }

  // ptr points to the character following "&#X".
  private scanHexCharRef(start: number, end: number): number {
    let ptr = start;
    if (ptr < end) {
      const first = this.type(ptr);
      if (first !== BT_DIGIT && first !== BT_HEX) {
        this.next = ptr;
        return TOK_INVALID;
      }
      for (ptr += 1; ptr < end; ptr += 1) {
        const type = this.type(ptr);
        if (type === BT_DIGIT || type === BT_HEX) {
          continue;
        }
        if (type === BT_SEMI) {
          this.next = ptr + 1;
          return TOK_CHAR_REF;
        }
        this.next = ptr;
        return TOK_INVALID;
      }
    }
    return TOK_PARTIAL;
  }

  // ptr points to the character following "&#".
  private scanCharRef(start: number, end: number): number {
    let ptr = start;
    if (ptr < end) {
      if (this.is(ptr, 'x')) {
        return this.scanHexCharRef(ptr + 1, end);
      }
      if (this.type(ptr) !== BT_DIGIT) {
        this.next = ptr;
        return TOK_INVALID;
      }
      for (ptr += 1; ptr < end; ptr += 1) {
        const type = this.type(ptr);
        if (type === BT_DIGIT) {
          continue;
        }
        if (type === BT_SEMI) {
          this.next = ptr + 1;
          return TOK_CHAR_REF;
        }
        this.next = ptr;
        return TOK_INVALID;
      }
    }
    return TOK_PARTIAL;
  }

  // ptr points to the character following "&".
  scanRef(start: number, end: number): number {
    let ptr = start;
    if (ptr >= end) {
      return TOK_PARTIAL;
    }
    const firstType = this.type(ptr);
    const first = this.nmstrtStep(ptr, end, firstType);
    if (first < 0) {
      return this.fail(first, ptr);
    }
    if (first === STEP_NOT_HANDLED) {
      if (firstType === BT_NUM) {
        return this.scanCharRef(ptr + 1, end);
      }
      this.next = ptr;
      return TOK_INVALID;
    }
    ptr += first;
    while (ptr < end) {
      const type = this.type(ptr);
      const step = this.nameStep(ptr, end, type);
      if (step > 0) {
        ptr += step;
        continue;
      }
      if (step < 0) {
        return this.fail(step, ptr);
      }
      if (type === BT_SEMI) {
        this.next = ptr + 1;
        return TOK_ENTITY_REF;
      }
      this.next = ptr;
      return TOK_INVALID;
    }
    return TOK_PARTIAL;
  }

  // After the closing quote of an attribute value: whitespace, ">" or "/>".
  // Returns a token, or -100 - ptr when another attribute name starts at ptr.
  private afterAttributeValue(start: number, end: number): number {
    let ptr = start;
    if (ptr >= end) {
      return TOK_PARTIAL;
    }
    const type = this.type(ptr);
    if (type === BT_SOL) {
      return this.emptyTagEnd(ptr, end, TOK_EMPTY_ELEMENT_WITH_ATTS);
    }
    if (type === BT_GT) {
      this.next = ptr + 1;
      return TOK_START_TAG_WITH_ATTS;
    }
    if (type !== BT_S && type !== BT_CR && type !== BT_LF) {
      this.next = ptr;
      return TOK_INVALID;
    }
    for (;;) {
      ptr += 1;
      if (ptr >= end) {
        return TOK_PARTIAL;
      }
      const inner = this.type(ptr);
      const step = this.nmstrtStep(ptr, end, inner);
      if (step > 0) {
        return NEXT_ATTRIBUTE_BASE - (ptr + step);
      }
      if (step < 0) {
        return this.fail(step, ptr);
      }
      switch (inner) {
        case BT_S:
        case BT_CR:
        case BT_LF:
          continue;
        case BT_GT:
          this.next = ptr + 1;
          return TOK_START_TAG_WITH_ATTS;
        case BT_SOL:
          return this.emptyTagEnd(ptr, end, TOK_EMPTY_ELEMENT_WITH_ATTS);
        default:
          this.next = ptr;
          return TOK_INVALID;
      }
    }
  }

  // ptr points to "/" of "/>".
  private emptyTagEnd(slash: number, end: number, tok: number): number {
    const ptr = slash + 1;
    if (ptr >= end) {
      return TOK_PARTIAL;
    }
    if (!this.is(ptr, '>')) {
      this.next = ptr;
      return TOK_INVALID;
    }
    this.next = ptr + 1;
    return tok;
  }

  // ptr points to the character following the first character of an
  // attribute name.
  scanAtts(start: number, end: number): number {
    let ptr = start;
    while (ptr < end) {
      const type = this.type(ptr);
      const step = this.nameStep(ptr, end, type);
      if (step > 0) {
        ptr += step;
        continue;
      }
      if (step < 0) {
        return this.fail(step, ptr);
      }
      if (type === BT_S || type === BT_CR || type === BT_LF) {
        for (;;) {
          ptr += 1;
          if (ptr >= end) {
            return TOK_PARTIAL;
          }
          const inner = this.type(ptr);
          if (inner === BT_EQUALS) {
            break;
          }
          if (inner !== BT_S && inner !== BT_CR && inner !== BT_LF) {
            this.next = ptr;
            return TOK_INVALID;
          }
        }
      } else if (type !== BT_EQUALS) {
        this.next = ptr;
        return TOK_INVALID;
      }
      // ptr points to "=".
      let open: number;
      for (;;) {
        ptr += 1;
        if (ptr >= end) {
          return TOK_PARTIAL;
        }
        open = this.type(ptr);
        if (open === BT_QUOT || open === BT_APOS) {
          break;
        }
        if (open !== BT_S && open !== BT_CR && open !== BT_LF) {
          this.next = ptr;
          return TOK_INVALID;
        }
      }
      ptr += 1;
      // In the attribute value.
      for (;;) {
        if (ptr >= end) {
          return TOK_PARTIAL;
        }
        const valueType = this.type(ptr);
        if (valueType === open) {
          break;
        }
        const valueStep = this.invalidStep(ptr, end, valueType);
        if (valueStep > 0) {
          ptr += valueStep;
          continue;
        }
        if (valueStep < 0) {
          return this.fail(valueStep, ptr);
        }
        if (valueType === BT_AMP) {
          const tok = this.scanRef(ptr + 1, end);
          if (tok <= 0) {
            return tok;
          }
          ptr = this.next;
          continue;
        }
        if (valueType === BT_LT) {
          this.next = ptr;
          return TOK_INVALID;
        }
        ptr += 1;
      }
      const after = this.afterAttributeValue(ptr + 1, end);
      if (after > NEXT_ATTRIBUTE_BASE) {
        return after;
      }
      ptr = NEXT_ATTRIBUTE_BASE - after;
    }
    return TOK_PARTIAL;
  }

  // ptr points to the character following "<".
  scanLt(start: number, end: number): number {
    let ptr = start;
    if (ptr >= end) {
      return TOK_PARTIAL;
    }
    const firstType = this.type(ptr);
    const first = this.nmstrtStep(ptr, end, firstType);
    if (first < 0) {
      return this.fail(first, ptr);
    }
    if (first === STEP_NOT_HANDLED) {
      switch (firstType) {
        case BT_EXCL:
          ptr += 1;
          if (ptr >= end) {
            return TOK_PARTIAL;
          }
          switch (this.type(ptr)) {
            case BT_MINUS:
              return this.scanComment(ptr + 1, end);
            case BT_LSQB:
              return this.scanCdataSection(ptr + 1, end);
            default:
              this.next = ptr;
              return TOK_INVALID;
          }
        case BT_QUEST:
          return this.scanPi(ptr + 1, end);
        case BT_SOL:
          return this.scanEndTag(ptr + 1, end);
        default:
          this.next = ptr;
          return TOK_INVALID;
      }
    }
    ptr += first;
    // We have a start tag.
    while (ptr < end) {
      const type = this.type(ptr);
      const step = this.nameStep(ptr, end, type);
      if (step > 0) {
        ptr += step;
        continue;
      }
      if (step < 0) {
        return this.fail(step, ptr);
      }
      switch (type) {
        case BT_S:
        case BT_CR:
        case BT_LF:
          ptr += 1;
          while (ptr < end) {
            const inner = this.type(ptr);
            const innerStep = this.nmstrtStep(ptr, end, inner);
            if (innerStep > 0) {
              return this.scanAtts(ptr + innerStep, end);
            }
            if (innerStep < 0) {
              return this.fail(innerStep, ptr);
            }
            switch (inner) {
              case BT_GT:
                this.next = ptr + 1;
                return TOK_START_TAG_NO_ATTS;
              case BT_SOL:
                return this.emptyTagEnd(ptr, end, TOK_EMPTY_ELEMENT_NO_ATTS);
              case BT_S:
              case BT_CR:
              case BT_LF:
                ptr += 1;
                continue;
              default:
                this.next = ptr;
                return TOK_INVALID;
            }
          }
          return TOK_PARTIAL;
        case BT_GT:
          this.next = ptr + 1;
          return TOK_START_TAG_NO_ATTS;
        case BT_SOL:
          return this.emptyTagEnd(ptr, end, TOK_EMPTY_ELEMENT_NO_ATTS);
        default:
          this.next = ptr;
          return TOK_INVALID;
      }
    }
    return TOK_PARTIAL;
  }

  contentTok(start: number): number {
    const { end } = this;
    let ptr = start;
    if (ptr >= end) {
      return this.emptyResult();
    }
    const type = this.type(ptr);
    switch (type) {
      case BT_LT:
        return this.scanLt(ptr + 1, end);
      case BT_AMP:
        return this.scanRef(ptr + 1, end);
      case BT_CR:
        ptr += 1;
        if (ptr >= end) {
          return TOK_TRAILING_CR;
        }
        if (this.type(ptr) === BT_LF) {
          ptr += 1;
        }
        this.next = ptr;
        return TOK_DATA_NEWLINE;
      case BT_LF:
        this.next = ptr + 1;
        return TOK_DATA_NEWLINE;
      case BT_RSQB:
        ptr += 1;
        if (ptr >= end) {
          return TOK_TRAILING_RSQB;
        }
        if (!this.is(ptr, ']')) {
          break;
        }
        ptr += 1;
        if (ptr >= end) {
          return TOK_TRAILING_RSQB;
        }
        if (!this.is(ptr, '>')) {
          ptr -= 1;
          break;
        }
        this.next = ptr;
        return TOK_INVALID;
      default: {
        const step = this.invalidStep(ptr, end, type);
        if (step < 0) {
          return this.fail(step, ptr);
        }
        ptr += step > 0 ? step : 1;
      }
    }
    return this.dataRun(ptr, end, true);
  }

  // ptr points to the character following "%".
  private scanPercent(start: number, end: number): number {
    let ptr = start;
    if (ptr >= end) {
      return TOK_PARTIAL;
    }
    const firstType = this.type(ptr);
    const first = this.nmstrtStep(ptr, end, firstType);
    if (first < 0) {
      return this.fail(first, ptr);
    }
    if (first === STEP_NOT_HANDLED) {
      this.next = ptr;
      return firstType === BT_S ||
        firstType === BT_LF ||
        firstType === BT_CR ||
        firstType === BT_PERCNT
        ? TOK_PERCENT
        : TOK_INVALID;
    }
    ptr += first;
    while (ptr < end) {
      const type = this.type(ptr);
      const step = this.nameStep(ptr, end, type);
      if (step > 0) {
        ptr += step;
        continue;
      }
      if (step < 0) {
        return this.fail(step, ptr);
      }
      if (type === BT_SEMI) {
        this.next = ptr + 1;
        return TOK_PARAM_ENTITY_REF;
      }
      this.next = ptr;
      return TOK_INVALID;
    }
    return TOK_PARTIAL;
  }

  // ptr points to the character following "#".
  private scanPoundName(start: number, end: number): number {
    let ptr = start;
    if (ptr >= end) {
      return TOK_PARTIAL;
    }
    const first = this.nmstrtStep(ptr, end, this.type(ptr));
    if (first <= 0) {
      return this.fail(first === STEP_PARTIAL_CHAR ? first : STEP_INVALID, ptr);
    }
    ptr += first;
    while (ptr < end) {
      const type = this.type(ptr);
      const step = this.nameStep(ptr, end, type);
      if (step > 0) {
        ptr += step;
        continue;
      }
      if (step < 0) {
        return this.fail(step, ptr);
      }
      switch (type) {
        case BT_CR:
        case BT_LF:
        case BT_S:
        case BT_RPAR:
        case BT_GT:
        case BT_PERCNT:
        case BT_VERBAR:
          this.next = ptr;
          return TOK_POUND_NAME;
        default:
          this.next = ptr;
          return TOK_INVALID;
      }
    }
    return -TOK_POUND_NAME;
  }

  private scanLit(open: number, start: number, end: number): number {
    let ptr = start;
    while (ptr < end) {
      const type = this.type(ptr);
      const step = this.invalidStep(ptr, end, type);
      if (step > 0) {
        ptr += step;
        continue;
      }
      if (step < 0) {
        return this.fail(step, ptr);
      }
      ptr += 1;
      if ((type === BT_QUOT || type === BT_APOS) && type === open) {
        if (ptr >= end) {
          return -TOK_LITERAL;
        }
        this.next = ptr;
        switch (this.type(ptr)) {
          case BT_S:
          case BT_CR:
          case BT_LF:
          case BT_GT:
          case BT_PERCNT:
          case BT_LSQB:
            return TOK_LITERAL;
          default:
            return TOK_INVALID;
        }
      }
    }
    return TOK_PARTIAL;
  }

  prologTok(start: number): number {
    const { end } = this;
    let ptr = start;
    if (ptr >= end) {
      return this.emptyResult();
    }
    let tok: number;
    const type = this.type(ptr);
    switch (type) {
      case BT_QUOT:
        return this.scanLit(BT_QUOT, ptr + 1, end);
      case BT_APOS:
        return this.scanLit(BT_APOS, ptr + 1, end);
      case BT_LT:
        ptr += 1;
        if (ptr >= end) {
          return TOK_PARTIAL;
        }
        switch (this.type(ptr)) {
          case BT_EXCL:
            return this.scanDecl(ptr + 1, end);
          case BT_QUEST:
            return this.scanPi(ptr + 1, end);
          case BT_NMSTRT:
          case BT_HEX:
          case BT_NONASCII:
          case BT_LEAD4:
            this.next = ptr - 1;
            return TOK_INSTANCE_START;
          default:
            // In UTF-8, U+FFFE/U+FFFF are lead bytes here, checked later.
            if (!this.utf16 && this.code(ptr) >= ASCII_LIMIT) {
              this.next = ptr - 1;
              return TOK_INSTANCE_START;
            }
            this.next = ptr;
            return TOK_INVALID;
        }
      case BT_CR:
        if (ptr + 1 === end) {
          this.next = end;
          // Might be part of a CR/LF pair.
          return -TOK_PROLOG_S;
        }
        return this.prologSpace(ptr, end);
      case BT_S:
      case BT_LF:
        return this.prologSpace(ptr, end);
      case BT_PERCNT:
        return this.scanPercent(ptr + 1, end);
      case BT_COMMA:
        this.next = ptr + 1;
        return TOK_COMMA;
      case BT_LSQB:
        this.next = ptr + 1;
        return TOK_OPEN_BRACKET;
      case BT_RSQB:
        ptr += 1;
        if (ptr >= end) {
          return -TOK_CLOSE_BRACKET;
        }
        if (this.is(ptr, ']')) {
          if (end - ptr < 2) {
            return TOK_PARTIAL;
          }
          if (this.is(ptr + 1, '>')) {
            this.next = ptr + 2;
            return TOK_COND_SECT_CLOSE;
          }
        }
        this.next = ptr;
        return TOK_CLOSE_BRACKET;
      case BT_LPAR:
        this.next = ptr + 1;
        return TOK_OPEN_PAREN;
      case BT_RPAR:
        return this.closeParen(ptr + 1, end);
      case BT_VERBAR:
        this.next = ptr + 1;
        return TOK_OR;
      case BT_GT:
        this.next = ptr + 1;
        return TOK_DECL_CLOSE;
      case BT_NUM:
        return this.scanPoundName(ptr + 1, end);
      case BT_LEAD4:
        if (end - ptr < 2) {
          return TOK_PARTIAL_CHAR;
        }
        this.next = ptr;
        return TOK_INVALID;
      case BT_NMSTRT:
      case BT_HEX:
        tok = TOK_NAME;
        ptr += 1;
        break;
      case BT_DIGIT:
      case BT_NAME:
      case BT_MINUS:
        tok = TOK_NMTOKEN;
        ptr += 1;
        break;
      case BT_NONASCII:
        if (isNmstrtCode(this.code(ptr))) {
          tok = TOK_NAME;
        } else if (isNameCode(this.code(ptr))) {
          tok = TOK_NMTOKEN;
        } else {
          this.next = ptr;
          return TOK_INVALID;
        }
        ptr += 1;
        break;
      default:
        this.next = ptr;
        return TOK_INVALID;
    }
    while (ptr < end) {
      const inner = this.type(ptr);
      const step = this.nameStep(ptr, end, inner);
      if (step > 0) {
        ptr += step;
        continue;
      }
      if (step < 0) {
        return this.fail(step, ptr);
      }
      switch (inner) {
        case BT_GT:
        case BT_RPAR:
        case BT_COMMA:
        case BT_VERBAR:
        case BT_LSQB:
        case BT_PERCNT:
        case BT_S:
        case BT_CR:
        case BT_LF:
          this.next = ptr;
          return tok;
        case BT_PLUS:
          return this.nameSuffix(ptr, tok, TOK_NAME_PLUS);
        case BT_AST:
          return this.nameSuffix(ptr, tok, TOK_NAME_ASTERISK);
        case BT_QUEST:
          return this.nameSuffix(ptr, tok, TOK_NAME_QUESTION);
        default:
          this.next = ptr;
          return TOK_INVALID;
      }
    }
    return -tok;
  }

  private nameSuffix(ptr: number, tok: number, suffixed: number): number {
    if (tok === TOK_NMTOKEN) {
      this.next = ptr;
      return TOK_INVALID;
    }
    this.next = ptr + 1;
    return suffixed;
  }

  private closeParen(start: number, end: number): number {
    const ptr = start;
    if (ptr >= end) {
      return -TOK_CLOSE_PAREN;
    }
    switch (this.type(ptr)) {
      case BT_AST:
        this.next = ptr + 1;
        return TOK_CLOSE_PAREN_ASTERISK;
      case BT_QUEST:
        this.next = ptr + 1;
        return TOK_CLOSE_PAREN_QUESTION;
      case BT_PLUS:
        this.next = ptr + 1;
        return TOK_CLOSE_PAREN_PLUS;
      case BT_CR:
      case BT_LF:
      case BT_S:
      case BT_GT:
      case BT_COMMA:
      case BT_VERBAR:
      case BT_RPAR:
        this.next = ptr;
        return TOK_CLOSE_PAREN;
      default:
        this.next = ptr;
        return TOK_INVALID;
    }
  }

  private prologSpace(start: number, end: number): number {
    let ptr = start;
    for (;;) {
      ptr += 1;
      if (ptr >= end) {
        break;
      }
      const type = this.type(ptr);
      if (type === BT_S || type === BT_LF) {
        continue;
      }
      // Don't split a CR/LF pair.
      if (type === BT_CR && ptr + 1 !== end) {
        continue;
      }
      this.next = ptr;
      return TOK_PROLOG_S;
    }
    this.next = ptr;
    return TOK_PROLOG_S;
  }

  attributeValueTok(start: number, end: number): number {
    let ptr = start;
    if (ptr >= end) {
      return TOK_NONE;
    }
    while (ptr < end) {
      switch (this.type(ptr)) {
        case BT_LEAD4:
          ptr += 2;
          break;
        case BT_AMP:
          if (ptr === start) {
            return this.scanRef(ptr + 1, end);
          }
          this.next = ptr;
          return TOK_DATA_CHARS;
        case BT_LT:
          // For literals in the DTD.
          this.next = ptr;
          return TOK_INVALID;
        case BT_LF:
          if (ptr === start) {
            this.next = ptr + 1;
            return TOK_DATA_NEWLINE;
          }
          this.next = ptr;
          return TOK_DATA_CHARS;
        case BT_CR:
          if (ptr === start) {
            return this.newlineAt(ptr, end);
          }
          this.next = ptr;
          return TOK_DATA_CHARS;
        case BT_S:
          if (ptr === start) {
            this.next = ptr + 1;
            return TOK_ATTRIBUTE_VALUE_S;
          }
          this.next = ptr;
          return TOK_DATA_CHARS;
        default:
          ptr += 1;
      }
    }
    this.next = ptr;
    return TOK_DATA_CHARS;
  }

  entityValueTok(start: number, end: number): number {
    let ptr = start;
    if (ptr >= end) {
      return TOK_NONE;
    }
    while (ptr < end) {
      switch (this.type(ptr)) {
        case BT_LEAD4:
          ptr += 2;
          break;
        case BT_AMP:
          if (ptr === start) {
            return this.scanRef(ptr + 1, end);
          }
          this.next = ptr;
          return TOK_DATA_CHARS;
        case BT_PERCNT:
          if (ptr === start) {
            const tok = this.scanPercent(ptr + 1, end);
            return tok === TOK_PERCENT ? TOK_INVALID : tok;
          }
          this.next = ptr;
          return TOK_DATA_CHARS;
        case BT_LF:
          if (ptr === start) {
            this.next = ptr + 1;
            return TOK_DATA_NEWLINE;
          }
          this.next = ptr;
          return TOK_DATA_CHARS;
        case BT_CR:
          if (ptr === start) {
            return this.newlineAt(ptr, end);
          }
          this.next = ptr;
          return TOK_DATA_CHARS;
        default:
          ptr += 1;
      }
    }
    this.next = ptr;
    return TOK_DATA_CHARS;
  }

  private newlineAt(cr: number, end: number): number {
    let ptr = cr + 1;
    if (ptr >= end) {
      return TOK_TRAILING_CR;
    }
    if (this.type(ptr) === BT_LF) {
      ptr += 1;
    }
    this.next = ptr;
    return TOK_DATA_NEWLINE;
  }

  /** Expat's XmlNameLength. */
  nameLength(start: number): number {
    let ptr = start;
    for (;;) {
      switch (this.type(ptr)) {
        case BT_LEAD4:
          ptr += 2;
          break;
        case BT_NONASCII:
        case BT_NMSTRT:
        case BT_HEX:
        case BT_DIGIT:
        case BT_NAME:
        case BT_MINUS:
          ptr += 1;
          break;
        default:
          return ptr - start;
      }
    }
  }

  /** Expat's XmlCharRefNumber; ptr points to "&#". -1 for a bad reference. */
  charRefNumber(start: number): number {
    let ptr = start + 2;
    let result = 0;
    if (this.is(ptr, 'x')) {
      for (ptr += 1; !this.is(ptr, ';'); ptr += 1) {
        result = result * 16 + Number.parseInt(this.text.charAt(ptr), 16);
        if (result >= MAX_CODE_POINT) {
          return -1;
        }
      }
    } else {
      for (; !this.is(ptr, ';'); ptr += 1) {
        result = result * 10 + (this.code(ptr) - 0x30);
        if (result >= MAX_CODE_POINT) {
          return -1;
        }
      }
    }
    return checkCharRefNumber(result);
  }

  /** Expat's XmlPredefinedEntityName: the character, or "" if not predefined. */
  predefinedEntity(start: number, end: number): string {
    return PREDEFINED_ENTITIES.get(this.text.slice(start, end)) ?? '';
  }

  /** Expat's XmlIsPublicId; returns the bad position or -1 when valid. */
  publicIdBadPosition(start: number, end: number): number {
    for (let ptr = start + 1; ptr < end - 1; ptr += 1) {
      const type = this.type(ptr);
      switch (type) {
        case BT_DIGIT:
        case BT_HEX:
        case BT_MINUS:
        case BT_APOS:
        case BT_LPAR:
        case BT_RPAR:
        case BT_PLUS:
        case BT_COMMA:
        case BT_SOL:
        case BT_EQUALS:
        case BT_QUEST:
        case BT_CR:
        case BT_LF:
        case BT_SEMI:
        case BT_EXCL:
        case BT_AST:
        case BT_PERCNT:
        case BT_NUM:
          break;
        case BT_S:
          if (this.is(ptr, '\t')) {
            return ptr;
          }
          break;
        default: {
          const code = this.code(ptr);
          const asciiLetter =
            (type === BT_NAME || type === BT_NMSTRT) && code < ASCII_LIMIT;
          if (!asciiLetter && code !== 0x24 && code !== 0x40) {
            return ptr;
          }
        }
      }
    }
    return -1;
  }
}

// Sentinel range for Tokenizer.afterAttributeValue (positions are encoded as
// NEXT_ATTRIBUTE_BASE - ptr, always below every real token value).
const NEXT_ATTRIBUTE_BASE = -100;

const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

const CONTROL_LIMIT = 0x20;

function checkCharRefNumber(result: number): number {
  if (result >= HIGH_SURROGATE_MIN && result <= LOW_SURROGATE_MAX) {
    return -1;
  }
  if (
    result < CONTROL_LIMIT &&
    result !== 0x09 &&
    result !== 0x0a &&
    result !== 0x0d
  ) {
    return -1;
  }
  if (result === NONCHAR_FFFE || result === NONCHAR_FFFF) {
    return -1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Prolog roles (xmlrole.c)

const ROLE_ERROR = -1;
const ROLE_NONE = 0;
const ROLE_XML_DECL = 1;
const ROLE_INSTANCE_START = 2;
const ROLE_DOCTYPE_NONE = 3;
const ROLE_DOCTYPE_NAME = 4;
const ROLE_DOCTYPE_SYSTEM_ID = 5;
const ROLE_DOCTYPE_PUBLIC_ID = 6;
const ROLE_DOCTYPE_INTERNAL_SUBSET = 7;
const ROLE_DOCTYPE_CLOSE = 8;
const ROLE_GENERAL_ENTITY_NAME = 9;
const ROLE_PARAM_ENTITY_NAME = 10;
const ROLE_ENTITY_NONE = 11;
const ROLE_ENTITY_VALUE = 12;
const ROLE_ENTITY_SYSTEM_ID = 13;
const ROLE_ENTITY_PUBLIC_ID = 14;
const ROLE_ENTITY_COMPLETE = 15;
const ROLE_ENTITY_NOTATION_NAME = 16;
const ROLE_NOTATION_NONE = 17;
const ROLE_NOTATION_NAME = 18;
const ROLE_NOTATION_SYSTEM_ID = 19;
const ROLE_NOTATION_NO_SYSTEM_ID = 20;
const ROLE_NOTATION_PUBLIC_ID = 21;
const ROLE_ATTRIBUTE_NAME = 22;
const ROLE_ATTRIBUTE_TYPE_CDATA = 23;
const ROLE_ATTRIBUTE_TYPE_ID = 24;
const ROLE_ATTRIBUTE_ENUM_VALUE = 31;
const ROLE_ATTRIBUTE_NOTATION_VALUE = 32;
const ROLE_ATTLIST_NONE = 33;
const ROLE_ATTLIST_ELEMENT_NAME = 34;
const ROLE_IMPLIED_ATTRIBUTE_VALUE = 35;
const ROLE_REQUIRED_ATTRIBUTE_VALUE = 36;
const ROLE_DEFAULT_ATTRIBUTE_VALUE = 37;
const ROLE_FIXED_ATTRIBUTE_VALUE = 38;
const ROLE_ELEMENT_NONE = 39;
const ROLE_ELEMENT_NAME = 40;
const ROLE_CONTENT_ANY = 41;
const ROLE_CONTENT_EMPTY = 42;
const ROLE_CONTENT_PCDATA = 43;
const ROLE_GROUP_OPEN = 44;
const ROLE_GROUP_CLOSE = 45;
const ROLE_GROUP_CLOSE_REP = 46;
const ROLE_GROUP_CLOSE_OPT = 47;
const ROLE_GROUP_CLOSE_PLUS = 48;
const ROLE_GROUP_CHOICE = 49;
const ROLE_GROUP_SEQUENCE = 50;
const ROLE_CONTENT_ELEMENT = 51;
const ROLE_CONTENT_ELEMENT_REP = 52;
const ROLE_CONTENT_ELEMENT_OPT = 53;
const ROLE_CONTENT_ELEMENT_PLUS = 54;
const ROLE_PI = 55;
const ROLE_COMMENT = 56;
const ROLE_PARAM_ENTITY_REF = 60;

const ATTRIBUTE_TYPE_KEYWORDS: readonly string[] = [
  'CDATA',
  'ID',
  'IDREF',
  'IDREFS',
  'ENTITY',
  'ENTITIES',
  'NMTOKEN',
  'NMTOKENS',
];

// Role handler states.
const S_PROLOG0 = 0;
const S_PROLOG1 = 1;
const S_PROLOG2 = 2;
const S_DOCTYPE0 = 3;
const S_DOCTYPE1 = 4;
const S_DOCTYPE2 = 5;
const S_DOCTYPE3 = 6;
const S_DOCTYPE4 = 7;
const S_DOCTYPE5 = 8;
const S_INTERNAL_SUBSET = 9;
const S_ENTITY0 = 10;
const S_ENTITY1 = 11;
const S_ENTITY2 = 12;
const S_ENTITY3 = 13;
const S_ENTITY4 = 14;
const S_ENTITY5 = 15;
const S_ENTITY6 = 16;
const S_ENTITY7 = 17;
const S_ENTITY8 = 18;
const S_ENTITY9 = 19;
const S_ENTITY10 = 20;
const S_NOTATION0 = 21;
const S_NOTATION1 = 22;
const S_NOTATION2 = 23;
const S_NOTATION3 = 24;
const S_NOTATION4 = 25;
const S_ATTLIST0 = 26;
const S_ATTLIST1 = 27;
const S_ATTLIST2 = 28;
const S_ATTLIST3 = 29;
const S_ATTLIST4 = 30;
const S_ATTLIST5 = 31;
const S_ATTLIST6 = 32;
const S_ATTLIST7 = 33;
const S_ATTLIST8 = 34;
const S_ATTLIST9 = 35;
const S_ELEMENT0 = 36;
const S_ELEMENT1 = 37;
const S_ELEMENT2 = 38;
const S_ELEMENT3 = 39;
const S_ELEMENT4 = 40;
const S_ELEMENT5 = 41;
const S_ELEMENT6 = 42;
const S_ELEMENT7 = 43;
const S_DECL_CLOSE = 44;
const S_ERROR = 45;

/** xmlrole.c's PROLOG_STATE for the document entity. */
class PrologState {
  state = S_PROLOG0;
  level = 0;
  roleNone = ROLE_NONE;
  private readonly tokenizer: Tokenizer;

  constructor(tokenizer: Tokenizer) {
    this.tokenizer = tokenizer;
  }

  private matches(ptr: number, end: number, keyword: string): boolean {
    return (
      end - ptr === keyword.length &&
      this.tokenizer.text.startsWith(keyword, ptr)
    );
  }

  private common(): number {
    this.state = S_ERROR;
    return ROLE_ERROR;
  }

  private goto(state: number, role: number): number {
    this.state = state;
    return role;
  }

  private declClose(state: number, roleNone: number, role: number): number {
    this.roleNone = roleNone;
    return this.goto(state, role);
  }

  role(tok: number, ptr: number, end: number): number {
    switch (this.state) {
      case S_PROLOG0:
      case S_PROLOG1:
        switch (tok) {
          case TOK_PROLOG_S:
            return this.goto(S_PROLOG1, ROLE_NONE);
          case TOK_XML_DECL:
            if (this.state === S_PROLOG0) {
              return this.goto(S_PROLOG1, ROLE_XML_DECL);
            }
            break;
          case TOK_PI:
            return this.goto(S_PROLOG1, ROLE_PI);
          case TOK_COMMENT:
            return this.goto(S_PROLOG1, ROLE_COMMENT);
          case TOK_BOM:
            return ROLE_NONE;
          case TOK_DECL_OPEN:
            if (!this.matches(ptr + 2, end, 'DOCTYPE')) {
              break;
            }
            return this.goto(S_DOCTYPE0, ROLE_DOCTYPE_NONE);
          case TOK_INSTANCE_START:
            return this.goto(S_ERROR, ROLE_INSTANCE_START);
          default:
            break;
        }
        return this.common();
      case S_PROLOG2:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_NONE;
          case TOK_PI:
            return ROLE_PI;
          case TOK_COMMENT:
            return ROLE_COMMENT;
          case TOK_INSTANCE_START:
            return this.goto(S_ERROR, ROLE_INSTANCE_START);
          default:
            return this.common();
        }
      case S_DOCTYPE0:
        if (tok === TOK_PROLOG_S) {
          return ROLE_DOCTYPE_NONE;
        }
        if (tok === TOK_NAME) {
          return this.goto(S_DOCTYPE1, ROLE_DOCTYPE_NAME);
        }
        return this.common();
      case S_DOCTYPE1:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_DOCTYPE_NONE;
          case TOK_OPEN_BRACKET:
            return this.goto(S_INTERNAL_SUBSET, ROLE_DOCTYPE_INTERNAL_SUBSET);
          case TOK_DECL_CLOSE:
            return this.goto(S_PROLOG2, ROLE_DOCTYPE_CLOSE);
          case TOK_NAME:
            if (this.matches(ptr, end, 'SYSTEM')) {
              return this.goto(S_DOCTYPE3, ROLE_DOCTYPE_NONE);
            }
            if (this.matches(ptr, end, 'PUBLIC')) {
              return this.goto(S_DOCTYPE2, ROLE_DOCTYPE_NONE);
            }
            break;
          default:
            break;
        }
        return this.common();
      case S_DOCTYPE2:
        if (tok === TOK_PROLOG_S) {
          return ROLE_DOCTYPE_NONE;
        }
        if (tok === TOK_LITERAL) {
          return this.goto(S_DOCTYPE3, ROLE_DOCTYPE_PUBLIC_ID);
        }
        return this.common();
      case S_DOCTYPE3:
        if (tok === TOK_PROLOG_S) {
          return ROLE_DOCTYPE_NONE;
        }
        if (tok === TOK_LITERAL) {
          return this.goto(S_DOCTYPE4, ROLE_DOCTYPE_SYSTEM_ID);
        }
        return this.common();
      case S_DOCTYPE4:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_DOCTYPE_NONE;
          case TOK_OPEN_BRACKET:
            return this.goto(S_INTERNAL_SUBSET, ROLE_DOCTYPE_INTERNAL_SUBSET);
          case TOK_DECL_CLOSE:
            return this.goto(S_PROLOG2, ROLE_DOCTYPE_CLOSE);
          default:
            return this.common();
        }
      case S_DOCTYPE5:
        if (tok === TOK_PROLOG_S) {
          return ROLE_DOCTYPE_NONE;
        }
        if (tok === TOK_DECL_CLOSE) {
          return this.goto(S_PROLOG2, ROLE_DOCTYPE_CLOSE);
        }
        return this.common();
      case S_INTERNAL_SUBSET:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_NONE;
          case TOK_DECL_OPEN:
            if (this.matches(ptr + 2, end, 'ENTITY')) {
              return this.goto(S_ENTITY0, ROLE_ENTITY_NONE);
            }
            if (this.matches(ptr + 2, end, 'ATTLIST')) {
              return this.goto(S_ATTLIST0, ROLE_ATTLIST_NONE);
            }
            if (this.matches(ptr + 2, end, 'ELEMENT')) {
              return this.goto(S_ELEMENT0, ROLE_ELEMENT_NONE);
            }
            if (this.matches(ptr + 2, end, 'NOTATION')) {
              return this.goto(S_NOTATION0, ROLE_NOTATION_NONE);
            }
            break;
          case TOK_PI:
            return ROLE_PI;
          case TOK_COMMENT:
            return ROLE_COMMENT;
          case TOK_PARAM_ENTITY_REF:
            return ROLE_PARAM_ENTITY_REF;
          case TOK_CLOSE_BRACKET:
            return this.goto(S_DOCTYPE5, ROLE_DOCTYPE_NONE);
          case TOK_NONE:
            return ROLE_NONE;
          default:
            break;
        }
        return this.common();
      case S_ENTITY0:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ENTITY_NONE;
          case TOK_PERCENT:
            return this.goto(S_ENTITY1, ROLE_ENTITY_NONE);
          case TOK_NAME:
            return this.goto(S_ENTITY2, ROLE_GENERAL_ENTITY_NAME);
          default:
            return this.common();
        }
      case S_ENTITY1:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ENTITY_NONE;
        }
        if (tok === TOK_NAME) {
          return this.goto(S_ENTITY7, ROLE_PARAM_ENTITY_NAME);
        }
        return this.common();
      case S_ENTITY2:
      case S_ENTITY7: {
        const general = this.state === S_ENTITY2;
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ENTITY_NONE;
          case TOK_NAME:
            if (this.matches(ptr, end, 'SYSTEM')) {
              return this.goto(
                general ? S_ENTITY4 : S_ENTITY9,
                ROLE_ENTITY_NONE,
              );
            }
            if (this.matches(ptr, end, 'PUBLIC')) {
              return this.goto(
                general ? S_ENTITY3 : S_ENTITY8,
                ROLE_ENTITY_NONE,
              );
            }
            break;
          case TOK_LITERAL:
            return this.declClose(
              S_DECL_CLOSE,
              ROLE_ENTITY_NONE,
              ROLE_ENTITY_VALUE,
            );
          default:
            break;
        }
        return this.common();
      }
      case S_ENTITY3:
      case S_ENTITY8:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ENTITY_NONE;
        }
        if (tok === TOK_LITERAL) {
          return this.goto(
            this.state === S_ENTITY3 ? S_ENTITY4 : S_ENTITY9,
            ROLE_ENTITY_PUBLIC_ID,
          );
        }
        return this.common();
      case S_ENTITY4:
      case S_ENTITY9:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ENTITY_NONE;
        }
        if (tok === TOK_LITERAL) {
          return this.goto(
            this.state === S_ENTITY4 ? S_ENTITY5 : S_ENTITY10,
            ROLE_ENTITY_SYSTEM_ID,
          );
        }
        return this.common();
      case S_ENTITY5:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ENTITY_NONE;
          case TOK_DECL_CLOSE:
            return this.goto(S_INTERNAL_SUBSET, ROLE_ENTITY_COMPLETE);
          case TOK_NAME:
            if (this.matches(ptr, end, 'NDATA')) {
              return this.goto(S_ENTITY6, ROLE_ENTITY_NONE);
            }
            break;
          default:
            break;
        }
        return this.common();
      case S_ENTITY6:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ENTITY_NONE;
        }
        if (tok === TOK_NAME) {
          return this.declClose(
            S_DECL_CLOSE,
            ROLE_ENTITY_NONE,
            ROLE_ENTITY_NOTATION_NAME,
          );
        }
        return this.common();
      case S_ENTITY10:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ENTITY_NONE;
        }
        if (tok === TOK_DECL_CLOSE) {
          return this.goto(S_INTERNAL_SUBSET, ROLE_ENTITY_COMPLETE);
        }
        return this.common();
      case S_NOTATION0:
        if (tok === TOK_PROLOG_S) {
          return ROLE_NOTATION_NONE;
        }
        if (tok === TOK_NAME) {
          return this.goto(S_NOTATION1, ROLE_NOTATION_NAME);
        }
        return this.common();
      case S_NOTATION1:
        if (tok === TOK_PROLOG_S) {
          return ROLE_NOTATION_NONE;
        }
        if (tok === TOK_NAME) {
          if (this.matches(ptr, end, 'SYSTEM')) {
            return this.goto(S_NOTATION3, ROLE_NOTATION_NONE);
          }
          if (this.matches(ptr, end, 'PUBLIC')) {
            return this.goto(S_NOTATION2, ROLE_NOTATION_NONE);
          }
        }
        return this.common();
      case S_NOTATION2:
        if (tok === TOK_PROLOG_S) {
          return ROLE_NOTATION_NONE;
        }
        if (tok === TOK_LITERAL) {
          return this.goto(S_NOTATION4, ROLE_NOTATION_PUBLIC_ID);
        }
        return this.common();
      case S_NOTATION3:
        if (tok === TOK_PROLOG_S) {
          return ROLE_NOTATION_NONE;
        }
        if (tok === TOK_LITERAL) {
          return this.declClose(
            S_DECL_CLOSE,
            ROLE_NOTATION_NONE,
            ROLE_NOTATION_SYSTEM_ID,
          );
        }
        return this.common();
      case S_NOTATION4:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_NOTATION_NONE;
          case TOK_LITERAL:
            return this.declClose(
              S_DECL_CLOSE,
              ROLE_NOTATION_NONE,
              ROLE_NOTATION_SYSTEM_ID,
            );
          case TOK_DECL_CLOSE:
            return this.goto(S_INTERNAL_SUBSET, ROLE_NOTATION_NO_SYSTEM_ID);
          default:
            return this.common();
        }
      case S_ATTLIST0:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ATTLIST_NONE;
        }
        if (tok === TOK_NAME) {
          return this.goto(S_ATTLIST1, ROLE_ATTLIST_ELEMENT_NAME);
        }
        return this.common();
      case S_ATTLIST1:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ATTLIST_NONE;
          case TOK_DECL_CLOSE:
            return this.goto(S_INTERNAL_SUBSET, ROLE_ATTLIST_NONE);
          case TOK_NAME:
            return this.goto(S_ATTLIST2, ROLE_ATTRIBUTE_NAME);
          default:
            return this.common();
        }
      case S_ATTLIST2:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ATTLIST_NONE;
          case TOK_NAME: {
            for (const [index, keyword] of ATTRIBUTE_TYPE_KEYWORDS.entries()) {
              if (this.matches(ptr, end, keyword)) {
                return this.goto(S_ATTLIST8, ROLE_ATTRIBUTE_TYPE_CDATA + index);
              }
            }
            if (this.matches(ptr, end, 'NOTATION')) {
              return this.goto(S_ATTLIST5, ROLE_ATTLIST_NONE);
            }
            break;
          }
          case TOK_OPEN_PAREN:
            return this.goto(S_ATTLIST3, ROLE_ATTLIST_NONE);
          default:
            break;
        }
        return this.common();
      case S_ATTLIST3:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ATTLIST_NONE;
        }
        if (tok === TOK_NMTOKEN || tok === TOK_NAME) {
          return this.goto(S_ATTLIST4, ROLE_ATTRIBUTE_ENUM_VALUE);
        }
        return this.common();
      case S_ATTLIST4:
      case S_ATTLIST7: {
        const enumeration = this.state === S_ATTLIST4;
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ATTLIST_NONE;
          case TOK_CLOSE_PAREN:
            return this.goto(S_ATTLIST8, ROLE_ATTLIST_NONE);
          case TOK_OR:
            return this.goto(
              enumeration ? S_ATTLIST3 : S_ATTLIST6,
              ROLE_ATTLIST_NONE,
            );
          default:
            return this.common();
        }
      }
      case S_ATTLIST5:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ATTLIST_NONE;
        }
        if (tok === TOK_OPEN_PAREN) {
          return this.goto(S_ATTLIST6, ROLE_ATTLIST_NONE);
        }
        return this.common();
      case S_ATTLIST6:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ATTLIST_NONE;
        }
        if (tok === TOK_NAME) {
          return this.goto(S_ATTLIST7, ROLE_ATTRIBUTE_NOTATION_VALUE);
        }
        return this.common();
      case S_ATTLIST8:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ATTLIST_NONE;
          case TOK_POUND_NAME:
            if (this.matches(ptr + 1, end, 'IMPLIED')) {
              return this.goto(S_ATTLIST1, ROLE_IMPLIED_ATTRIBUTE_VALUE);
            }
            if (this.matches(ptr + 1, end, 'REQUIRED')) {
              return this.goto(S_ATTLIST1, ROLE_REQUIRED_ATTRIBUTE_VALUE);
            }
            if (this.matches(ptr + 1, end, 'FIXED')) {
              return this.goto(S_ATTLIST9, ROLE_ATTLIST_NONE);
            }
            break;
          case TOK_LITERAL:
            return this.goto(S_ATTLIST1, ROLE_DEFAULT_ATTRIBUTE_VALUE);
          default:
            break;
        }
        return this.common();
      case S_ATTLIST9:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ATTLIST_NONE;
        }
        if (tok === TOK_LITERAL) {
          return this.goto(S_ATTLIST1, ROLE_FIXED_ATTRIBUTE_VALUE);
        }
        return this.common();
      case S_ELEMENT0:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ELEMENT_NONE;
        }
        if (tok === TOK_NAME) {
          return this.goto(S_ELEMENT1, ROLE_ELEMENT_NAME);
        }
        return this.common();
      case S_ELEMENT1:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ELEMENT_NONE;
          case TOK_NAME:
            if (this.matches(ptr, end, 'EMPTY')) {
              return this.declClose(
                S_DECL_CLOSE,
                ROLE_ELEMENT_NONE,
                ROLE_CONTENT_EMPTY,
              );
            }
            if (this.matches(ptr, end, 'ANY')) {
              return this.declClose(
                S_DECL_CLOSE,
                ROLE_ELEMENT_NONE,
                ROLE_CONTENT_ANY,
              );
            }
            break;
          case TOK_OPEN_PAREN:
            this.level = 1;
            return this.goto(S_ELEMENT2, ROLE_GROUP_OPEN);
          default:
            break;
        }
        return this.common();
      case S_ELEMENT2:
      case S_ELEMENT6:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ELEMENT_NONE;
          case TOK_POUND_NAME:
            if (
              this.state === S_ELEMENT2 &&
              this.matches(ptr + 1, end, 'PCDATA')
            ) {
              return this.goto(S_ELEMENT3, ROLE_CONTENT_PCDATA);
            }
            break;
          case TOK_OPEN_PAREN:
            if (this.state === S_ELEMENT2) {
              this.level = 2;
              return this.goto(S_ELEMENT6, ROLE_GROUP_OPEN);
            }
            this.level += 1;
            return ROLE_GROUP_OPEN;
          case TOK_NAME:
            return this.goto(S_ELEMENT7, ROLE_CONTENT_ELEMENT);
          case TOK_NAME_QUESTION:
            return this.goto(S_ELEMENT7, ROLE_CONTENT_ELEMENT_OPT);
          case TOK_NAME_ASTERISK:
            return this.goto(S_ELEMENT7, ROLE_CONTENT_ELEMENT_REP);
          case TOK_NAME_PLUS:
            return this.goto(S_ELEMENT7, ROLE_CONTENT_ELEMENT_PLUS);
          default:
            break;
        }
        return this.common();
      case S_ELEMENT3:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ELEMENT_NONE;
          case TOK_CLOSE_PAREN:
            return this.declClose(
              S_DECL_CLOSE,
              ROLE_ELEMENT_NONE,
              ROLE_GROUP_CLOSE,
            );
          case TOK_CLOSE_PAREN_ASTERISK:
            return this.declClose(
              S_DECL_CLOSE,
              ROLE_ELEMENT_NONE,
              ROLE_GROUP_CLOSE_REP,
            );
          case TOK_OR:
            return this.goto(S_ELEMENT4, ROLE_ELEMENT_NONE);
          default:
            return this.common();
        }
      case S_ELEMENT4:
        if (tok === TOK_PROLOG_S) {
          return ROLE_ELEMENT_NONE;
        }
        if (tok === TOK_NAME) {
          return this.goto(S_ELEMENT5, ROLE_CONTENT_ELEMENT);
        }
        return this.common();
      case S_ELEMENT5:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ELEMENT_NONE;
          case TOK_CLOSE_PAREN_ASTERISK:
            return this.declClose(
              S_DECL_CLOSE,
              ROLE_ELEMENT_NONE,
              ROLE_GROUP_CLOSE_REP,
            );
          case TOK_OR:
            return this.goto(S_ELEMENT4, ROLE_ELEMENT_NONE);
          default:
            return this.common();
        }
      case S_ELEMENT7:
        switch (tok) {
          case TOK_PROLOG_S:
            return ROLE_ELEMENT_NONE;
          case TOK_CLOSE_PAREN:
            return this.closeGroup(ROLE_GROUP_CLOSE);
          case TOK_CLOSE_PAREN_ASTERISK:
            return this.closeGroup(ROLE_GROUP_CLOSE_REP);
          case TOK_CLOSE_PAREN_QUESTION:
            return this.closeGroup(ROLE_GROUP_CLOSE_OPT);
          case TOK_CLOSE_PAREN_PLUS:
            return this.closeGroup(ROLE_GROUP_CLOSE_PLUS);
          case TOK_COMMA:
            return this.goto(S_ELEMENT6, ROLE_GROUP_SEQUENCE);
          case TOK_OR:
            return this.goto(S_ELEMENT6, ROLE_GROUP_CHOICE);
          default:
            return this.common();
        }
      case S_DECL_CLOSE:
        if (tok === TOK_PROLOG_S) {
          return this.roleNone;
        }
        if (tok === TOK_DECL_CLOSE) {
          return this.goto(S_INTERNAL_SUBSET, this.roleNone);
        }
        return this.common();
      default:
        return ROLE_NONE;
    }
  }

  private closeGroup(role: number): number {
    this.level -= 1;
    if (this.level === 0) {
      this.roleNone = ROLE_ELEMENT_NONE;
      this.state = S_DECL_CLOSE;
    }
    return role;
  }
}

// ---------------------------------------------------------------------------
// The parser (xmlparse.c)

/** Callbacks pyexpat would invoke; any exception aborts parsing. */
export interface ExpatHandlers {
  /**
   * Called for every attribute as a start tag is read, before the attributes
   * are stored (not in pyexpat): a handler that throws limits their cost.
   */
  attribute?: () => void;
  /** Start of an element; `attributes` is `[name, value, name, value, ...]`. */
  startElement: (name: string, attributes: string[]) => void;
  endElement: (name: string) => void;
  characterData: (data: string) => void;
  /** An entity declaration Expat would store (xmltodict raises here). */
  entityDecl: () => void;
  /**
   * `StartDoctypeDeclHandler`: called where Expat calls it, at the `[` of
   * the internal subset or at the closing `>` of a DOCTYPE without one.
   */
  startDoctypeDecl?: () => void;
}

interface DefaultAttribute {
  readonly name: string;
  readonly value: string | null;
  readonly isCdata: boolean;
}

interface ElementType {
  readonly defaults: DefaultAttribute[];
  // First declaration of each attribute name (index into `defaults`).
  readonly firstIndex: Map<string, number>;
}

interface RawAttribute {
  name: number;
  valueStart: number;
  valueEnd: number;
  normalized: boolean;
}

const GROUP_PIPE = 1;
const GROUP_COMMA = 2;

class DocumentParser {
  private readonly tok: Tokenizer;
  private readonly prolog: PrologState;
  private readonly handlers: ExpatHandlers;
  eventPtr = 0;
  // DTD state.
  private standalone = false;
  private hasParamEntityRefs = false;
  private keepProcessing = true;
  private declEntity = false;
  private doctypeSysid = false;
  private readonly groupConnector: number[] = [];
  private readonly elementTypes = new Map<string, ElementType>();
  private readonly maybeTokenized = new Set<string>();
  private declElementType = '';
  private declAttributeId = '';
  private declAttributeIsCdata = false;
  private declAttributeIsId = false;
  // A DOCTYPE name was read and startDoctypeDecl has not been called yet.
  private doctypePending = false;

  constructor(tokenizer: Tokenizer, handlers: ExpatHandlers) {
    this.tok = tokenizer;
    this.prolog = new PrologState(tokenizer);
    this.handlers = handlers;
  }

  private fail(code: number, at?: number): never {
    if (at !== undefined) {
      this.eventPtr = at;
    }
    throw new ParseFailure(code);
  }

  /** initScan (xmltok.c) for UTF-8 input, then the prolog processor. */
  run(firstTok: number, firstNext: number): void {
    this.doProlog(0, firstTok, firstNext);
  }

  private doProlog(start: number, firstTok: number, firstNext: number): void {
    const { tok: tokenizer } = this;
    let s = start;
    let tok = firstTok;
    let next = firstNext;
    for (;;) {
      this.eventPtr = s;
      if (tok <= 0) {
        switch (tok) {
          case TOK_INVALID:
            this.fail(XML_ERROR_INVALID_TOKEN, next);
            break;
          case TOK_PARTIAL:
            this.fail(XML_ERROR_UNCLOSED_TOKEN);
            break;
          case TOK_PARTIAL_CHAR:
            this.fail(XML_ERROR_PARTIAL_CHAR);
            break;
          case -TOK_PROLOG_S:
            tok = TOK_PROLOG_S;
            break;
          case TOK_NONE:
            this.fail(XML_ERROR_NO_ELEMENTS);
            break;
          default:
            tok = -tok;
            next = tokenizer.end;
        }
      }
      const role = this.prolog.role(tok, s, next);
      switch (role) {
        case ROLE_XML_DECL:
          this.processXmlDecl(s, next);
          break;
        case ROLE_DOCTYPE_NAME:
          this.doctypeSysid = false;
          this.doctypePending = this.handlers.startDoctypeDecl !== undefined;
          break;
        case ROLE_DOCTYPE_INTERNAL_SUBSET:
          if (this.doctypePending) {
            this.doctypePending = false;
            this.handlers.startDoctypeDecl?.();
          }
          break;
        case ROLE_DOCTYPE_PUBLIC_ID:
        case ROLE_ENTITY_PUBLIC_ID:
        case ROLE_NOTATION_PUBLIC_ID: {
          if (role === ROLE_DOCTYPE_PUBLIC_ID) {
            this.declEntity = true;
            this.hasParamEntityRefs = true;
          }
          const bad = tokenizer.publicIdBadPosition(s, next);
          if (bad >= 0) {
            this.fail(XML_ERROR_PUBLICID, bad);
          }
          break;
        }
        case ROLE_DOCTYPE_CLOSE:
          if (this.doctypePending) {
            this.doctypePending = false;
            this.handlers.startDoctypeDecl?.();
          }
          if (this.doctypeSysid) {
            this.hasParamEntityRefs = true;
          }
          break;
        case ROLE_INSTANCE_START:
          this.doContent(s);
          return;
        case ROLE_ATTLIST_ELEMENT_NAME:
          this.declElementType = tokenizer.text.slice(s, next);
          break;
        case ROLE_ATTRIBUTE_NAME:
          this.declAttributeId = tokenizer.text.slice(s, next);
          this.declAttributeIsCdata = false;
          this.declAttributeIsId = false;
          break;
        case ROLE_ATTRIBUTE_TYPE_CDATA:
          this.declAttributeIsCdata = true;
          break;
        case ROLE_ATTRIBUTE_TYPE_ID:
          this.declAttributeIsId = true;
          break;
        case ROLE_IMPLIED_ATTRIBUTE_VALUE:
        case ROLE_REQUIRED_ATTRIBUTE_VALUE:
          if (this.keepProcessing) {
            this.defineAttribute(null, this.declAttributeIsId);
          }
          break;
        case ROLE_DEFAULT_ATTRIBUTE_VALUE:
        case ROLE_FIXED_ATTRIBUTE_VALUE:
          if (this.keepProcessing) {
            const value = this.storeAttributeValue(
              this.declAttributeIsCdata,
              s + 1,
              next - 1,
            );
            this.defineAttribute(value, false);
          }
          break;
        case ROLE_ENTITY_VALUE:
          if (this.keepProcessing) {
            const error = this.storeEntityValue(s + 1, next - 1);
            if (this.declEntity) {
              this.handlers.entityDecl();
            }
            if (error !== 0) {
              throw new ParseFailure(error);
            }
          }
          break;
        case ROLE_DOCTYPE_SYSTEM_ID:
          this.hasParamEntityRefs = true;
          this.doctypeSysid = true;
          this.declEntity = true;
          break;
        case ROLE_ENTITY_COMPLETE:
        case ROLE_ENTITY_NOTATION_NAME:
          if (this.keepProcessing && this.declEntity) {
            this.handlers.entityDecl();
          }
          break;
        case ROLE_GENERAL_ENTITY_NAME:
          this.declEntity =
            tokenizer.predefinedEntity(s, next) === '' && this.keepProcessing;
          break;
        case ROLE_PARAM_ENTITY_NAME:
          this.declEntity = this.keepProcessing;
          break;
        case ROLE_ERROR:
          if (tok === TOK_PARAM_ENTITY_REF) {
            this.fail(XML_ERROR_PARAM_ENTITY_REF);
          }
          if (tok === TOK_XML_DECL) {
            this.fail(XML_ERROR_MISPLACED_XML_PI);
          }
          this.fail(XML_ERROR_SYNTAX);
          break;
        case ROLE_GROUP_OPEN:
          this.groupConnector[this.prolog.level] = 0;
          break;
        case ROLE_GROUP_SEQUENCE:
          if (this.groupConnector[this.prolog.level] === GROUP_PIPE) {
            this.fail(XML_ERROR_SYNTAX);
          }
          this.groupConnector[this.prolog.level] = GROUP_COMMA;
          break;
        case ROLE_GROUP_CHOICE:
          if (this.groupConnector[this.prolog.level] === GROUP_COMMA) {
            this.fail(XML_ERROR_SYNTAX);
          }
          this.groupConnector[this.prolog.level] = GROUP_PIPE;
          break;
        case ROLE_PARAM_ENTITY_REF:
          // Parameter entity parsing is off in pyexpat: the reference is
          // skipped and, unless standalone, later declarations are ignored.
          this.hasParamEntityRefs = true;
          this.keepProcessing = this.standalone;
          break;
        default:
          break;
      }
      s = next;
      tok = tokenizer.prologTok(s);
      ({ next } = tokenizer);
    }
  }

  private elementType(name: string): ElementType {
    let type = this.elementTypes.get(name);
    if (!type) {
      type = { defaults: [], firstIndex: new Map() };
      this.elementTypes.set(name, type);
    }
    return type;
  }

  private defineAttribute(value: string | null, isId: boolean): void {
    const type = this.elementType(this.declElementType);
    const name = this.declAttributeId;
    // The first declaration of an attribute is binding.
    if ((value !== null || isId) && type.firstIndex.has(name)) {
      return;
    }
    type.defaults.push({ isCdata: this.declAttributeIsCdata, name, value });
    if (!this.declAttributeIsCdata) {
      this.maybeTokenized.add(name);
    }
    if (!type.firstIndex.has(name)) {
      type.firstIndex.set(name, type.defaults.length - 1);
    }
  }

  // storeEntityValue for an entity Expat won't keep (a predefined name): only
  // its errors matter. Returns an XML_Error code (0 for none).
  private storeEntityValue(start: number, end: number): number {
    const { tok: tokenizer } = this;
    let ptr = start;
    for (;;) {
      const tok = tokenizer.entityValueTok(ptr, end);
      switch (tok) {
        case TOK_PARAM_ENTITY_REF:
          this.eventPtr = ptr;
          return XML_ERROR_PARAM_ENTITY_REF;
        case TOK_NONE:
          return 0;
        case TOK_CHAR_REF:
          if (tokenizer.charRefNumber(ptr) < 0) {
            this.eventPtr = ptr;
            return XML_ERROR_BAD_CHAR_REF;
          }
          break;
        case TOK_PARTIAL:
          this.eventPtr = ptr;
          return XML_ERROR_INVALID_TOKEN;
        case TOK_INVALID:
          this.eventPtr = tokenizer.next;
          return XML_ERROR_INVALID_TOKEN;
        case TOK_TRAILING_CR:
          tokenizer.next = ptr + 1;
          break;
        default:
          break;
      }
      ptr = tokenizer.next;
    }
  }

  // storeAttributeValue + appendAttributeValue.
  private storeAttributeValue(
    isCdata: boolean,
    start: number,
    end: number,
  ): string {
    const { tok: tokenizer } = this;
    let value = '';
    let ptr = start;
    const lastIsSpace = (): boolean =>
      value.length === 0 || value.endsWith(' ');
    for (;;) {
      const tok = tokenizer.attributeValueTok(ptr, end);
      let { next } = tokenizer;
      switch (tok) {
        case TOK_NONE:
          if (!isCdata && value.endsWith(' ')) {
            value = value.slice(0, -1);
          }
          return value;
        case TOK_INVALID:
          this.fail(XML_ERROR_INVALID_TOKEN, next);
          break;
        case TOK_PARTIAL:
          this.fail(XML_ERROR_INVALID_TOKEN, ptr);
          break;
        case TOK_CHAR_REF: {
          const code = tokenizer.charRefNumber(ptr);
          if (code < 0) {
            this.fail(XML_ERROR_BAD_CHAR_REF, ptr);
          }
          if (!isCdata && code === 0x20 && lastIsSpace()) {
            break;
          }
          value += String.fromCodePoint(code);
          break;
        }
        case TOK_DATA_CHARS:
          value += tokenizer.text.slice(ptr, next);
          break;
        case TOK_TRAILING_CR:
        case TOK_ATTRIBUTE_VALUE_S:
        case TOK_DATA_NEWLINE:
          if (tok === TOK_TRAILING_CR) {
            next = ptr + 1;
          }
          if (!isCdata && lastIsSpace()) {
            break;
          }
          value += ' ';
          break;
        case TOK_ENTITY_REF: {
          const char = tokenizer.predefinedEntity(ptr + 1, next - 1);
          if (char !== '') {
            value += char;
            break;
          }
          if (!this.hasParamEntityRefs || this.standalone) {
            this.fail(XML_ERROR_UNDEFINED_ENTITY);
          }
          break;
        }
        default:
          // TOK_PARTIAL_CHAR: unreachable after the tokenizer validated it.
          this.fail(XML_ERROR_INVALID_TOKEN, ptr);
      }
      ptr = next;
    }
  }

  private processXmlDecl(s: number, next: number): void {
    const result = parseXmlDecl(this.tok, s, next);
    if (result.bad >= 0) {
      this.fail(XML_ERROR_XML_DECL, result.bad);
    }
    if (result.standalone) {
      this.standalone = true;
    }
  }

  // XmlGetAttributes (xmltok_impl.c getAtts); ptr points to "<".
  private getAttributes(start: number): RawAttribute[] {
    const { tok: tokenizer } = this;
    const IN_NAME = 0;
    const IN_VALUE = 1;
    const OTHER = 2;
    let state = IN_NAME;
    let open = 0;
    const atts: RawAttribute[] = [];
    let current: RawAttribute = {
      name: 0,
      normalized: true,
      valueEnd: 0,
      valueStart: 0,
    };
    for (let ptr = start + 1; ; ptr += 1) {
      const type = tokenizer.type(ptr);
      switch (type) {
        case BT_LEAD4:
        case BT_NONASCII:
        case BT_NMSTRT:
        case BT_HEX:
          if (state === OTHER) {
            current = {
              name: ptr,
              normalized: true,
              valueEnd: 0,
              valueStart: 0,
            };
            state = IN_NAME;
          }
          if (type === BT_LEAD4) {
            ptr += 1;
          }
          break;
        case BT_QUOT:
        case BT_APOS:
          if (state !== IN_VALUE) {
            current.valueStart = ptr + 1;
            state = IN_VALUE;
            open = type;
          } else if (open === type) {
            state = OTHER;
            current.valueEnd = ptr;
            atts.push(current);
            this.handlers.attribute?.();
          }
          break;
        case BT_AMP:
          current.normalized = false;
          break;
        case BT_S:
          if (state === IN_NAME) {
            state = OTHER;
          } else if (
            state === IN_VALUE &&
            current.normalized &&
            (ptr === current.valueStart ||
              !tokenizer.is(ptr, ' ') ||
              tokenizer.is(ptr + 1, ' ') ||
              tokenizer.type(ptr + 1) === open)
          ) {
            current.normalized = false;
          }
          break;
        case BT_CR:
        case BT_LF:
          if (state === IN_NAME) {
            state = OTHER;
          } else if (state === IN_VALUE) {
            current.normalized = false;
          }
          break;
        case BT_GT:
        case BT_SOL:
          if (state !== IN_VALUE) {
            return atts;
          }
          break;
        default:
          break;
      }
    }
  }

  // storeAtts: the [name, value, ...] list pyexpat passes with
  // ordered_attributes, including defaults from the internal DTD subset.
  private storeAtts(tagStart: number, elementName: string): string[] {
    const { tok: tokenizer } = this;
    const elementType = this.elementTypes.get(elementName);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const att of this.getAttributes(tagStart)) {
      const name = tokenizer.text.slice(
        att.name,
        att.name + tokenizer.nameLength(att.name),
      );
      if (seen.has(name)) {
        this.fail(XML_ERROR_DUPLICATE_ATTRIBUTE, att.name);
      }
      seen.add(name);
      let value: string;
      if (att.normalized) {
        value = tokenizer.text.slice(att.valueStart, att.valueEnd);
      } else {
        let isCdata = true;
        if (elementType && this.maybeTokenized.has(name)) {
          const index = elementType.firstIndex.get(name);
          if (index !== undefined) {
            isCdata = elementType.defaults[index]?.isCdata ?? true;
          }
        }
        value = this.storeAttributeValue(isCdata, att.valueStart, att.valueEnd);
      }
      result.push(name, value);
    }
    for (const defaultAttribute of elementType?.defaults ?? []) {
      if (!seen.has(defaultAttribute.name) && defaultAttribute.value !== null) {
        seen.add(defaultAttribute.name);
        result.push(defaultAttribute.name, defaultAttribute.value);
      }
    }
    return result;
  }

  private doContent(start: number): void {
    const { tok: tokenizer, handlers } = this;
    // Open elements, as [raw name start, raw name length] pairs: an explicit
    // stack, so deep nesting can't overflow the call stack.
    const tagStack: number[] = [];
    const nameStack: string[] = [];
    let s = start;
    for (;;) {
      this.eventPtr = s;
      const tok = tokenizer.contentTok(s);
      const { next } = tokenizer;
      switch (tok) {
        case TOK_TRAILING_CR:
          handlers.characterData('\n');
          this.fail(XML_ERROR_NO_ELEMENTS);
          break;
        case TOK_NONE:
          this.fail(XML_ERROR_NO_ELEMENTS);
          break;
        case TOK_INVALID:
          this.fail(XML_ERROR_INVALID_TOKEN, next);
          break;
        case TOK_PARTIAL:
          this.fail(XML_ERROR_UNCLOSED_TOKEN);
          break;
        case TOK_PARTIAL_CHAR:
          this.fail(XML_ERROR_PARTIAL_CHAR);
          break;
        case TOK_ENTITY_REF: {
          const char = tokenizer.predefinedEntity(s + 1, next - 1);
          if (char !== '') {
            handlers.characterData(char);
          } else if (!this.hasParamEntityRefs || this.standalone) {
            this.fail(XML_ERROR_UNDEFINED_ENTITY);
          }
          break;
        }
        case TOK_START_TAG_NO_ATTS:
        case TOK_START_TAG_WITH_ATTS: {
          const nameLength = tokenizer.nameLength(s + 1);
          const name = tokenizer.text.slice(s + 1, s + 1 + nameLength);
          tagStack.push(s + 1, nameLength);
          nameStack.push(name);
          const attributes = this.storeAtts(s, name);
          handlers.startElement(name, attributes);
          break;
        }
        case TOK_EMPTY_ELEMENT_NO_ATTS:
        case TOK_EMPTY_ELEMENT_WITH_ATTS: {
          const name = tokenizer.text.slice(
            s + 1,
            s + 1 + tokenizer.nameLength(s + 1),
          );
          const attributes = this.storeAtts(s, name);
          handlers.startElement(name, attributes);
          this.eventPtr = next;
          handlers.endElement(name);
          if (nameStack.length === 0) {
            this.epilog(next);
            return;
          }
          break;
        }
        case TOK_END_TAG: {
          const rawName = s + 2;
          const length = tokenizer.nameLength(rawName);
          const openLength = tagStack.pop() ?? 0;
          const openStart = tagStack.pop() ?? 0;
          if (
            length !== openLength ||
            tokenizer.text.slice(rawName, rawName + length) !==
              tokenizer.text.slice(openStart, openStart + openLength)
          ) {
            this.fail(XML_ERROR_TAG_MISMATCH, rawName);
          }
          handlers.endElement(nameStack.pop() ?? '');
          if (nameStack.length === 0) {
            this.epilog(next);
            return;
          }
          break;
        }
        case TOK_CHAR_REF: {
          const code = tokenizer.charRefNumber(s);
          if (code < 0) {
            this.fail(XML_ERROR_BAD_CHAR_REF);
          }
          handlers.characterData(String.fromCodePoint(code));
          break;
        }
        case TOK_XML_DECL:
          this.fail(XML_ERROR_MISPLACED_XML_PI);
          break;
        case TOK_DATA_NEWLINE:
          handlers.characterData('\n');
          break;
        case TOK_CDATA_SECT_OPEN: {
          const after = this.doCdataSection(next);
          this.eventPtr = after;
          s = after;
          continue;
        }
        case TOK_TRAILING_RSQB:
          handlers.characterData(tokenizer.text.slice(s, tokenizer.end));
          this.fail(XML_ERROR_NO_ELEMENTS, tokenizer.end);
          break;
        case TOK_DATA_CHARS:
          handlers.characterData(tokenizer.text.slice(s, next));
          break;
        default:
          // PI, comment: no handler.
          break;
      }
      s = next;
    }
  }

  private doCdataSection(start: number): number {
    const { tok: tokenizer, handlers } = this;
    let s = start;
    this.eventPtr = s;
    for (;;) {
      const tok = tokenizer.cdataSectionTok(s);
      const { next } = tokenizer;
      switch (tok) {
        case TOK_CDATA_SECT_CLOSE:
          return next;
        case TOK_DATA_NEWLINE:
          handlers.characterData('\n');
          break;
        case TOK_DATA_CHARS:
          handlers.characterData(tokenizer.text.slice(s, next));
          break;
        case TOK_INVALID:
          this.fail(XML_ERROR_INVALID_TOKEN, next);
          break;
        case TOK_PARTIAL_CHAR:
          this.fail(XML_ERROR_PARTIAL_CHAR);
          break;
        default:
          // TOK_PARTIAL, TOK_NONE.
          this.fail(XML_ERROR_UNCLOSED_CDATA_SECTION);
      }
      s = next;
      this.eventPtr = s;
    }
  }

  private epilog(start: number): void {
    const { tok: tokenizer } = this;
    let s = start;
    this.eventPtr = s;
    for (;;) {
      const tok = tokenizer.prologTok(s);
      const { next } = tokenizer;
      switch (tok) {
        case -TOK_PROLOG_S:
        case TOK_NONE:
          return;
        case TOK_PROLOG_S:
        case TOK_PI:
        case TOK_COMMENT:
          break;
        case TOK_INVALID:
          this.fail(XML_ERROR_INVALID_TOKEN, next);
          break;
        case TOK_PARTIAL:
          this.fail(XML_ERROR_UNCLOSED_TOKEN);
          break;
        case TOK_PARTIAL_CHAR:
          this.fail(XML_ERROR_PARTIAL_CHAR);
          break;
        default:
          this.fail(XML_ERROR_JUNK_AFTER_DOC_ELEMENT);
      }
      s = next;
      this.eventPtr = s;
    }
  }
}

// ---------------------------------------------------------------------------
// XML declaration (xmltok.c doParseXmlDecl)

interface XmlDeclResult {
  bad: number;
  standalone: boolean;
}

const ASCII_LOWER_A = 0x61;
const ASCII_LOWER_Z = 0x7a;
const ASCII_UPPER_A = 0x41;
const ASCII_UPPER_Z = 0x5a;
const ASCII_DIGIT_0 = 0x30;
const ASCII_DIGIT_9 = 0x39;

function isAsciiLetter(code: number): boolean {
  return (
    (code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z) ||
    (code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z)
  );
}

function isDeclSpace(code: number): boolean {
  return code === 0x20 || code === 0x0d || code === 0x0a || code === 0x09;
}

interface PseudoAttribute {
  ok: boolean;
  // null when only white space remained.
  name: [number, number] | null;
  value: number;
  next: number;
}

function parsePseudoAttribute(
  tokenizer: Tokenizer,
  start: number,
  end: number,
): PseudoAttribute {
  const toAscii = (ptr: number): number => {
    if (ptr >= end) {
      return -1;
    }
    const code = tokenizer.code(ptr);
    return code < ASCII_LIMIT ? code : -1;
  };
  let ptr = start;
  if (ptr === end) {
    return { name: null, next: start, ok: true, value: 0 };
  }
  if (!isDeclSpace(toAscii(ptr))) {
    return { name: null, next: ptr, ok: false, value: 0 };
  }
  do {
    ptr += 1;
  } while (isDeclSpace(toAscii(ptr)));
  if (ptr === end) {
    return { name: null, next: start, ok: true, value: 0 };
  }
  const nameStart = ptr;
  let nameEnd: number;
  for (;;) {
    let c = toAscii(ptr);
    if (c === -1) {
      return { name: null, next: ptr, ok: false, value: 0 };
    }
    if (c === 0x3d) {
      nameEnd = ptr;
      break;
    }
    if (isDeclSpace(c)) {
      nameEnd = ptr;
      do {
        ptr += 1;
        c = toAscii(ptr);
      } while (isDeclSpace(c));
      if (c !== 0x3d) {
        return { name: null, next: ptr, ok: false, value: 0 };
      }
      break;
    }
    ptr += 1;
  }
  if (ptr === nameStart) {
    return { name: null, next: ptr, ok: false, value: 0 };
  }
  ptr += 1;
  let c = toAscii(ptr);
  while (isDeclSpace(c)) {
    ptr += 1;
    c = toAscii(ptr);
  }
  if (c !== 0x22 && c !== 0x27) {
    return { name: null, next: ptr, ok: false, value: 0 };
  }
  const open = c;
  ptr += 1;
  const value = ptr;
  for (; ; ptr += 1) {
    c = toAscii(ptr);
    if (c === open) {
      break;
    }
    const allowed =
      isAsciiLetter(c) ||
      (c >= ASCII_DIGIT_0 && c <= ASCII_DIGIT_9) ||
      c === 0x2e ||
      c === 0x2d ||
      c === 0x5f;
    if (!allowed) {
      return { name: null, next: ptr, ok: false, value: 0 };
    }
  }
  return { name: [nameStart, nameEnd], next: ptr + 1, ok: true, value };
}

function parseXmlDecl(
  tokenizer: Tokenizer,
  s: number,
  next: number,
): XmlDeclResult {
  const { text } = tokenizer;
  const end = next - 2;
  const isName = (range: [number, number], keyword: string): boolean =>
    text.slice(range[0], range[1]) === keyword;
  let attribute = parsePseudoAttribute(tokenizer, s + 5, end);
  if (!(attribute.ok && attribute.name)) {
    return { bad: attribute.next, standalone: false };
  }
  if (isName(attribute.name, 'version')) {
    const valueEnd = attribute.next - 1;
    const version = text.slice(attribute.value, valueEnd);
    // Expat 2.9 accepts the XML 1.0 fifth edition's "1." followed by digits.
    if (!/^1\.[0-9]+$/u.test(version)) {
      return { bad: attribute.value, standalone: false };
    }
    attribute = parsePseudoAttribute(tokenizer, attribute.next, end);
    if (!attribute.ok) {
      return { bad: attribute.next, standalone: false };
    }
    if (!attribute.name) {
      return { bad: -1, standalone: false };
    }
  } else {
    return { bad: attribute.name[0], standalone: false };
  }
  if (isName(attribute.name, 'encoding')) {
    const first = attribute.value < end ? tokenizer.code(attribute.value) : -1;
    if (!isAsciiLetter(first)) {
      return { bad: attribute.value, standalone: false };
    }
    attribute = parsePseudoAttribute(tokenizer, attribute.next, end);
    if (!attribute.ok) {
      return { bad: attribute.next, standalone: false };
    }
    if (!attribute.name) {
      return { bad: -1, standalone: false };
    }
  }
  if (!isName(attribute.name, 'standalone')) {
    return { bad: attribute.name[0], standalone: false };
  }
  const value = text.slice(attribute.value, attribute.next - 1);
  if (value !== 'yes' && value !== 'no') {
    return { bad: attribute.value, standalone: false };
  }
  let ptr = attribute.next;
  while (ptr < end && isDeclSpace(tokenizer.code(ptr))) {
    ptr += 1;
  }
  if (ptr !== end) {
    return { bad: ptr, standalone: false };
  }
  return { bad: -1, standalone: value === 'yes' };
}

// ---------------------------------------------------------------------------
// Entry point

/** Expat's updatePosition from the start of the input up to `upto`. */
function positionOf(text: string, upto: number): [number, number] {
  let line = 1;
  let column = 0;
  let ptr = 0;
  while (ptr < upto) {
    const code = text.charCodeAt(ptr);
    if (code === 0x0a) {
      line += 1;
      column = 0;
      ptr += 1;
    } else if (code === 0x0d) {
      line += 1;
      column = 0;
      ptr += 1;
      if (ptr < upto && text.charCodeAt(ptr) === 0x0a) {
        ptr += 1;
      }
    } else {
      column += 1;
      ptr +=
        code >= HIGH_SURROGATE_MIN &&
        code <= HIGH_SURROGATE_MAX &&
        ptr + 1 < upto
          ? 2
          : 1;
    }
  }
  return [line, column];
}

const UTF16_LITTLE_ENDIAN = 1;
const UTF16_BIG_ENDIAN = 2;

// initScan's auto-detection: pyexpat passes "utf-8", but a document whose
// first or second byte is NUL is still read as UTF-16 (big or little endian).
function detectUtf16(text: string): number {
  if (text.length < 1) {
    return 0;
  }
  if (text.charCodeAt(0) === 0) {
    return text.length === 1 ? 0 : UTF16_BIG_ENDIAN;
  }
  if (
    text.charCodeAt(0) < ASCII_LIMIT &&
    text.length > 1 &&
    text.charCodeAt(1) === 0
  ) {
    return UTF16_LITTLE_ENDIAN;
  }
  return 0;
}

// Code units per String.fromCharCode() call: well below engines' argument
// limits, large enough that building the view stays linear and fast.
const UTF16_BLOCK = 8192;

const PLATFORM_LITTLE_ENDIAN =
  new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function utf16View(text: string, order: number): [string, boolean] {
  const bytes = new TextEncoder().encode(text);
  const count = Math.floor(bytes.length / 2);
  // A copy of the whole units, read in the platform's byte order, swapped
  // where that differs from the document's.
  const units = new Uint16Array(bytes.slice(0, count * 2).buffer, 0, count);
  if ((order === UTF16_BIG_ENDIAN) === PLATFORM_LITTLE_ENDIAN) {
    for (let index = 0; index < count; index += 1) {
      const unit = units[index] as number;
      units[index] = ((unit & 0xff) << 8) | (unit >> 8);
    }
  }
  // Lone surrogates stay as they are (TextDecoder would replace them). The
  // typed array is passed as the argument list: spreading it goes through
  // its iterator, several times slower.
  const blocks: string[] = [];
  for (let start = 0; start < units.length; start += UTF16_BLOCK) {
    blocks.push(
      Reflect.apply(
        String.fromCharCode,
        null,
        units.subarray(start, start + UTF16_BLOCK),
      ) as string,
    );
  }
  return [blocks.join(''), bytes.length % 2 === 1];
}

/**
 * Parse a complete document the way `pyexpat.ParserCreate("utf-8")` +
 * `Parse(text.encode("utf-8"), True)` does, calling `handlers` for each event.
 * Throws {@link ExpatError} on malformed input; exceptions from handlers
 * propagate unchanged (pyexpat re-raises them).
 *
 * `text` must not contain lone surrogates (Python cannot encode them).
 */
export function expatParse(text: string, handlers: ExpatHandlers): void {
  const order = detectUtf16(text);
  const [view, oddTail] = order === 0 ? [text, false] : utf16View(text, order);
  const tokenizer = new Tokenizer(view, order !== 0, oddTail);
  const parser = new DocumentParser(tokenizer, handlers);
  try {
    let firstTok: number;
    if (order === 0 && view.length === 1 && (view === '<' || view === '\0')) {
      // A single byte that could start a longer encoding signature.
      firstTok = TOK_PARTIAL;
    } else if (order === 0 && view.charCodeAt(0) === BOM) {
      firstTok = TOK_BOM;
      tokenizer.next = 1;
    } else {
      firstTok = tokenizer.prologTok(0);
    }
    parser.run(firstTok, tokenizer.next);
  } catch (error) {
    if (error instanceof ParseFailure) {
      const [line, column] = positionOf(view, parser.eventPtr);
      throw new ExpatError(error.code, line, column);
    }
    throw error;
  }
}
