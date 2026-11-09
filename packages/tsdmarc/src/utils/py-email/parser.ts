// Port of Python's `email.feedparser.FeedParser` (compat32), as used by
// `email.message_from_string()`.
//
// Python feeds the text in chunks and suspends on incomplete lines; with
// the whole text available up front the result is the same, so this port
// reads lines from the text on demand and parses synchronously.

import { DEFAULT_EMAIL_LIMITS, type EmailLimits } from '../../config';
import { EmailTooLargeError } from '../../errors';
import { pyLStrip } from '../py-str';
import {
  CloseBoundaryNotFoundDefect,
  FirstHeaderLineIsContinuationDefect,
  InvalidHeaderDefect,
  InvalidMultipartContentTransferEncodingDefect,
  MisplacedEnvelopeHeaderDefect,
  MissingHeaderBodySeparatorDefect,
  MultipartInvariantViolationDefect,
  NoBoundaryInMultipartDefect,
  RecursionError,
  StartBoundaryNotFoundDefect,
} from './errors';
import { Message } from './message';

const HEADER_LINE = /^(?:From |[!-9;-~]*:|[\t ])/u;
const NL_START = /^(?:\r\n|\r|\n)/u;
const NL_END = /(?:\r\n|\r|\n)$/u;
const BOUNDARY_END = /(--)?[ \t]*(\r\n|\r|\n)?$/uy;

/**
 * Nesting levels `email.message_from_string()` parses when called from a
 * module's top level: CPython's default recursion limit (1000) leaves room
 * for 987 nested `_parsegen` generators before it raises `RecursionError`.
 */
export const MESSAGE_FROM_STRING_MAX_NESTING = 987;

/**
 * An EOF matcher of `BufferedSubFile`: a multipart boundary (Python's
 * `boundaryre.match`) or a blank line (`NLCRE.match`, delivery-status).
 */
type EofMatcher =
  | { readonly kind: 'boundary'; readonly separator: string }
  | { readonly kind: 'blank' };

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;
const SPACE = 0x20;
const TAB = 0x09;

/** `line` without its line ending and the spaces/tabs before it. */
function boundaryCandidate(line: string): string {
  let end = line.length;
  if (end > 0 && line.charCodeAt(end - 1) === LF) {
    end -= 1;
  }
  if (end > 0 && line.charCodeAt(end - 1) === CR) {
    end -= 1;
  }
  while (end > 0) {
    const code = line.charCodeAt(end - 1);
    if (code !== SPACE && code !== TAB) {
      break;
    }
    end -= 1;
  }
  return line.slice(0, end);
}

/** `email.feedparser.BufferedSubFile`, already closed. */
class LineBuffer {
  private readonly text: string;
  private position = 0;
  // Lines given back by `unreadline()`, or stopped at by an EOF matcher. No
  // array of all the lines: the parser's limits have to stop a hostile
  // message before it costs one string per line.
  private readonly unread: string[] = [];
  private readonly eofStack: EofMatcher[] = [];
  // Python tries every matcher on the stack for each line, which is
  // quadratic in the nesting depth; any match means EOF, so counting the
  // active separators answers the same question with one lookup.
  private readonly separators = new Map<string, number>();
  private blankMatchers = 0;

  constructor(text: string) {
    this.text = text;
  }

  /** Where the line starting at `start` ends, past its line ending. */
  private lineEnd(start: number): number {
    const { text } = this;
    for (let index = start; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === LF) {
        return index + 1;
      }
      if (code === CR) {
        return text.charCodeAt(index + 1) === LF ? index + 2 : index + 1;
      }
    }
    return text.length;
  }

  pushEofMatcher(matcher: EofMatcher): void {
    this.eofStack.push(matcher);
    if (matcher.kind === 'blank') {
      this.blankMatchers += 1;
    } else {
      const { separator } = matcher;
      this.separators.set(separator, (this.separators.get(separator) ?? 0) + 1);
    }
  }

  popEofMatcher(): void {
    const matcher = this.eofStack.pop();
    if (matcher === undefined) {
      return;
    }
    if (matcher.kind === 'blank') {
      this.blankMatchers -= 1;
      return;
    }
    const count = (this.separators.get(matcher.separator) ?? 0) - 1;
    if (count > 0) {
      this.separators.set(matcher.separator, count);
    } else {
      this.separators.delete(matcher.separator);
    }
  }

  /**
   * Whether any EOF matcher on the stack matches `line`. A boundary line is
   * the separator, an optional `--`, then optional spaces/tabs and a line
   * ending, so stripping those leaves either the separator or the separator
   * plus `--`.
   */
  private atEof(line: string): boolean {
    const first = line.charCodeAt(0);
    if (first === CR || first === LF) {
      return this.blankMatchers > 0;
    }
    if (this.separators.size === 0 || !line.startsWith('--')) {
      return false;
    }
    const candidate = boundaryCandidate(line);
    return (
      this.separators.has(candidate) ||
      (candidate.endsWith('--') && this.separators.has(candidate.slice(0, -2)))
    );
  }

  /** The next line, or `''` at (real or matcher-induced) EOF. */
  readline(): string {
    const pending = this.unread.at(-1);
    if (pending !== undefined) {
      if (this.atEof(pending)) {
        return '';
      }
      this.unread.pop();
      return pending;
    }
    if (this.position >= this.text.length) {
      return '';
    }
    const end = this.lineEnd(this.position);
    const line = this.text.slice(this.position, end);
    this.position = end;
    if (this.atEof(line)) {
      this.unread.push(line);
      return '';
    }
    return line;
  }

  unreadline(line: string): void {
    this.unread.push(line);
  }

  /**
   * `''.join(self._input)`: the text up to EOF. Lines that can't be at an
   * EOF matcher are stepped over without making a string of each.
   */
  readToEof(): string {
    let head = '';
    while (this.unread.length > 0) {
      const line = this.readline();
      if (line === '') {
        return head;
      }
      head += line;
    }
    const { text } = this;
    const start = this.position;
    const blankEnds = this.blankMatchers > 0;
    const boundaryEnds = this.separators.size > 0;
    if (!blankEnds && !boundaryEnds) {
      this.position = text.length;
      return head + text.slice(start);
    }
    while (this.position < text.length) {
      const first = text.charCodeAt(this.position);
      if (blankEnds && (first === CR || first === LF)) {
        break;
      }
      const end = this.lineEnd(this.position);
      if (
        boundaryEnds &&
        first === DASH &&
        this.atEof(text.slice(this.position, end))
      ) {
        break;
      }
      this.position = end;
    }
    return head + text.slice(start, this.position);
  }

  /**
   * `for line in self._input`: lines until EOF.
   * @yields {string} Each line, with its line ending.
   */
  *[Symbol.iterator](): Generator<string> {
    for (;;) {
      const line = this.readline();
      if (line === '') {
        return;
      }
      yield line;
    }
  }
}

// compat32 `header_source_parse()`.
function headerSourceParse(lines: readonly string[]): [string, string] {
  const first = lines[0] ?? '';
  const colon = first.indexOf(':');
  const name = first.slice(0, colon);
  const value = pyLStrip(
    [first.slice(colon + 1), ...lines.slice(1)].join(''),
    ' \t\r\n',
  );
  // `value.rstrip('\r\n')`, without the quadratic `/[\r\n]+$/` search.
  let end = value.length;
  while (end > 0 && '\r\n'.includes(value.charAt(end - 1))) {
    end -= 1;
  }
  return [name, value.slice(0, end)];
}

class FeedParser {
  private readonly input: LineBuffer;
  private readonly msgstack: Message[] = [];
  private cur: Message | null = null;
  private last: Message | null = null;
  // Python asks each parent for its content type once per child, which scans
  // the parent's headers every time: K headers and N children cost K*N.
  // Headers are complete before the first child exists, so the answer is
  // kept instead.
  private readonly digests = new Set<Message>();
  private readonly maxNesting: number;
  private readonly limits: EmailLimits;
  private parts = 0;
  private headerLines = 0;

  constructor(text: string, maxNesting: number, limits: EmailLimits) {
    this.input = new LineBuffer(text);
    this.maxNesting = maxNesting;
    this.limits = limits;
  }

  parse(): Message {
    this.parsegen();
    const root = this.popMessage();
    if (root.getContentMaintype() === 'multipart' && !root.isMultipart()) {
      root.defects.push(new MultipartInvariantViolationDefect());
    }
    return root;
  }

  private current(): Message {
    if (this.cur === null) {
      throw new Error('no current message');
    }
    return this.cur;
  }

  private lastMessage(): Message {
    if (this.last === null) {
      throw new Error('no last message');
    }
    return this.last;
  }

  private newMessage(): void {
    const { maxMimeParts } = this.limits;
    this.parts += 1;
    if (maxMimeParts > 0 && this.parts > maxMimeParts) {
      throw new EmailTooLargeError(
        `Email has more than ${maxMimeParts} MIME parts (max_mime_parts)`,
      );
    }
    const message = new Message();
    if (this.cur !== null && this.digests.has(this.cur)) {
      message.setDefaultType('message/rfc822');
    }
    this.msgstack.at(-1)?.attach(message);
    this.msgstack.push(message);
    this.cur = message;
    this.last = message;
  }

  private popMessage(): Message {
    const message = this.msgstack.pop();
    if (message === undefined) {
      throw new Error('message stack is empty');
    }
    this.cur = this.msgstack.at(-1) ?? null;
    return message;
  }

  private parsegen(): void {
    // Each nesting level is one more `_parsegen` generator in Python, which
    // raises RecursionError past the interpreter's recursion limit. The
    // ancestors on the stack are this message's nesting level.
    if (this.msgstack.length > this.maxNesting) {
      throw new RecursionError();
    }
    this.newMessage();
    const headers: string[] = [];
    for (const line of this.input) {
      if (!HEADER_LINE.test(line)) {
        if (!NL_START.test(line)) {
          this.current().defects.push(new MissingHeaderBodySeparatorDefect());
          this.input.unreadline(line);
        }
        break;
      }
      this.countHeaderLine();
      headers.push(line);
    }
    this.parseHeaders(headers);
    const cur = this.current();
    const contentType = cur.getContentType();
    if (contentType === 'multipart/digest') {
      this.digests.add(cur);
    }
    if (contentType === 'message/delivery-status') {
      this.parseDeliveryStatus();
      return;
    }
    if (cur.getContentMaintype() === 'message') {
      this.parsegen();
      this.popMessage();
      return;
    }
    if (cur.getContentMaintype() === 'multipart') {
      this.parseMultipart(cur);
      return;
    }
    cur.setPayload(this.input.readToEof());
  }

  private countHeaderLine(): void {
    const { maxHeaderLines } = this.limits;
    this.headerLines += 1;
    if (maxHeaderLines > 0 && this.headerLines > maxHeaderLines) {
      throw new EmailTooLargeError(
        `Email has more than ${maxHeaderLines} header lines (max_header_lines)`,
      );
    }
  }

  private parseDeliveryStatus(): void {
    for (;;) {
      this.input.pushEofMatcher({ kind: 'blank' });
      this.parsegen();
      this.popMessage();
      this.input.popEofMatcher();
      // The blank line that ended the block, then the next one.
      this.input.readline();
      const line = this.input.readline();
      if (line === '') {
        break;
      }
      this.input.unreadline(line);
    }
  }

  private parseMultipart(cur: Message): void {
    const boundary = cur.getBoundary();
    if (boundary === undefined) {
      cur.defects.push(new NoBoundaryInMultipartDefect());
      cur.setPayload(this.input.readToEof());
      return;
    }
    const cte = (cur.get('content-transfer-encoding') ?? '8bit').toLowerCase();
    if (!['7bit', '8bit', 'binary'].includes(cte)) {
      cur.defects.push(new InvalidMultipartContentTransferEncodingDefect());
    }
    const separator = `--${boundary}`;
    const boundaryMatch = (line: string): RegExpExecArray | null => {
      if (!line.startsWith(separator)) {
        return null;
      }
      BOUNDARY_END.lastIndex = separator.length;
      return BOUNDARY_END.exec(line);
    };
    let capturingPreamble = true;
    const preamble: string[] = [];
    let linesep: string | undefined;
    let closeBoundarySeen = false;
    for (;;) {
      let line = this.input.readline();
      if (line === '') {
        break;
      }
      const match = boundaryMatch(line);
      if (match === null) {
        preamble.push(line);
        continue;
      }
      if (match[1] !== undefined) {
        closeBoundarySeen = true;
        linesep = match[2];
        break;
      }
      if (capturingPreamble) {
        if (preamble.length > 0) {
          const lastLine = preamble.at(-1) ?? '';
          preamble[preamble.length - 1] = lastLine.replace(NL_END, '');
          cur.preamble = preamble.join('');
        }
        capturingPreamble = false;
        this.input.unreadline(line);
        continue;
      }
      // Consume consecutive boundary lines (empty parts).
      for (;;) {
        line = this.input.readline();
        if (boundaryMatch(line) === null) {
          this.input.unreadline(line);
          break;
        }
      }
      this.input.pushEofMatcher({ kind: 'boundary', separator });
      this.parsegen();
      const last = this.lastMessage();
      if (last.getContentMaintype() === 'multipart') {
        const { epilogue } = last;
        if (epilogue === '') {
          last.epilogue = null;
        } else if (epilogue !== null) {
          last.epilogue = epilogue.replace(NL_END, '');
        }
      } else if (typeof last.payload === 'string') {
        last.payload = last.payload.replace(NL_END, '');
      }
      this.input.popEofMatcher();
      this.popMessage();
      this.last = this.cur;
    }
    if (capturingPreamble) {
      cur.defects.push(new StartBoundaryNotFoundDefect());
      cur.setPayload(preamble.join(''));
      // Python drains the rest of the input without keeping it.
      this.input.readToEof();
      cur.epilogue = '';
      return;
    }
    if (!closeBoundarySeen) {
      cur.defects.push(new CloseBoundaryNotFoundDefect());
      return;
    }
    const epilogue = this.input.readToEof();
    // Without a line ending after the close boundary, the rest starts on its
    // own first line, and a leading line ending of that one is dropped.
    cur.epilogue = linesep ? epilogue : epilogue.replace(NL_START, '');
  }

  private parseHeaders(lines: readonly string[]): void {
    let lastHeader = '';
    let lastValue: string[] = [];
    const cur = this.current();
    for (const [lineno, line] of lines.entries()) {
      if (line.startsWith(' ') || line.startsWith('\t')) {
        if (!lastHeader) {
          cur.defects.push(new FirstHeaderLineIsContinuationDefect(line));
          continue;
        }
        lastValue.push(line);
        continue;
      }
      if (lastHeader) {
        cur.setRaw(...headerSourceParse(lastValue));
        lastHeader = '';
        lastValue = [];
      }
      if (line.startsWith('From ')) {
        if (lineno === 0) {
          cur.unixfrom = line.replace(NL_END, '');
          continue;
        }
        if (lineno === lines.length - 1) {
          this.input.unreadline(line);
          return;
        }
        cur.defects.push(new MisplacedEnvelopeHeaderDefect(line));
        continue;
      }
      const colon = line.indexOf(':');
      if (colon === 0) {
        cur.defects.push(new InvalidHeaderDefect('Missing header name.'));
        continue;
      }
      lastHeader = line.slice(0, colon);
      lastValue = [line];
    }
    if (lastHeader) {
      cur.setRaw(...headerSourceParse(lastValue));
    }
  }
}

/**
 * `email.message_from_string(text)` with the compat32 policy.
 *
 * Throws {@link RecursionError} for a message nested deeper than
 * `maxNesting` levels (multipart or message/* parts), where CPython runs
 * out of recursion depth; the default is what a top-level call allows.
 * Throws {@link EmailTooLargeError} past `limits` (not in Python).
 */
export function messageFromString(
  text: string,
  maxNesting: number = MESSAGE_FROM_STRING_MAX_NESTING,
  limits: EmailLimits = DEFAULT_EMAIL_LIMITS,
): Message {
  return new FeedParser(text, maxNesting, limits).parse();
}
