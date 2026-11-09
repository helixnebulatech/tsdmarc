// Port of Python's `email.generator.Generator` as `Message.as_string()`
// runs it: compat32, `mangle_from_=False`, `maxheaderlen=0`, `\n` line
// separators.

import { randomBytes } from 'node:crypto';

import { EmailTooLargeError } from '../../errors';
import { pyRepr } from '../py-str';
import { charsetName, hasSurrogates } from './charset';
import { HeaderWriteError } from './errors';
import { encodeHeaderValue } from './header';
import type { Message } from './message';

/**
 * `Generator._munge_cte`: the Content-Transfer-Encoding and Content-Type a
 * text part's headers get after its 8-bit payload was re-encoded.
 */
type Munge = readonly [cte: string, contentType: string];

const NL = '\n';
const CR_LINE_END = /\r\n?/gu;
const NEWLINE_WITHOUT_FWSP = /\r\n[^ \t]|\r[^ \n\t]|\n[^ \t]/u;
// oxlint-disable-next-line no-control-regex -- the whole Latin-1 range
const BEYOND_LATIN_1 = /[^\u0000-\u00ff]/u;

/**
 * Flattened text of messages already written, shared by the `asString()`
 * calls of one walk over a message tree. Without it, flattening the first
 * part of every multipart on the way down a deeply nested message rewrites
 * the same subtree again at every level.
 *
 * Python holds one flattened level at a time; this cache holds them all, and
 * reading a rope makes the engine keep a flat copy of it. So `maxTotal`
 * (`maxExpandedEmailSize`, 0 for no limit) bounds the text of all levels
 * together, size × depth, which the size of the email does not. Text with a
 * character outside Latin-1 takes two bytes per character in the engine,
 * so its characters count twice: the limit is on memory, not on a count
 * the sender can double by choosing the characters.
 */
export class FlattenCache {
  private readonly texts = new Map<Message, string>();
  private readonly maxTotal: number;
  private total = 0;

  constructor(maxTotal = 0) {
    this.maxTotal = maxTotal;
  }

  get(message: Message): string | undefined {
    return this.texts.get(message);
  }

  add(message: Message, text: string): void {
    this.total += BEYOND_LATIN_1.test(text) ? 2 * text.length : text.length;
    if (this.maxTotal > 0 && this.total > this.maxTotal) {
      throw new EmailTooLargeError(
        `Flattening the email's nested parts exceeds the ${this.maxTotal} character limit (max_expanded_email_size)`,
      );
    }
    this.texts.set(message, text);
  }

  /** Let go of a text no later `asString()` will ask for. */
  delete(message: Message): void {
    this.texts.delete(message);
  }
}

// Python joins `text.splitlines()` with NL, the last line only followed by
// NL if not empty: the same as rewriting the other line endings.
function writeLines(output: string[], text: string): void {
  if (!text) {
    return;
  }
  output.push(text.includes('\r') ? text.replace(CR_LINE_END, NL) : text);
}

function writeHeaders(output: string[], message: Message): void {
  for (const [name, value] of message.rawItems()) {
    const folded = `${name}: ${encodeHeaderValue(name, value)}${NL}`;
    // compat32 sets verify_generated_headers.
    if (NEWLINE_WITHOUT_FWSP.test(folded.slice(0, -NL.length))) {
      throw new HeaderWriteError(
        `folded header contains newline: ${pyRepr(folded)}`,
      );
    }
    output.push(folded);
  }
  output.push(NL);
}

function handleText(output: string[], message: Message): Munge | null {
  let payload = message.getPayload();
  if (payload === null) {
    return null;
  }
  if (typeof payload !== 'string') {
    throw new TypeError('string payload expected: list');
  }
  let munge: Munge | null = null;
  // 8-bit text parsed from bytes is re-encoded with its declared charset.
  const raw = message.payload as string;
  const charset = hasSurrogates(raw) ? message.getParam('charset') : undefined;
  if (charset !== undefined) {
    const reencoded = message.copy();
    reencoded.delete('content-transfer-encoding');
    reencoded.setPayload(raw, charsetName(charset));
    payload = reencoded.getPayload() as string;
    munge = [
      reencoded.get('content-transfer-encoding') ?? '',
      reencoded.get('content-type') ?? '',
    ];
  }
  writeLines(output, payload);
  return munge;
}

function handleMultipart(
  output: string[],
  message: Message,
  cache: FlattenCache | null,
): void {
  const subparts = message.getPayload();
  if (typeof subparts === 'string') {
    output.push(subparts);
    return;
  }
  const texts = (subparts ?? []).map(part => flatten(part, cache));
  let boundary = message.getBoundary();
  if (!boundary) {
    // Only `boundary=""` gets here: Python makes up a random boundary and
    // writes it into the Content-Type header.
    boundary = makeBoundary(texts.join(NL));
    message.setBoundary(boundary);
  }
  if (message.preamble !== null) {
    writeLines(output, message.preamble);
    output.push(NL);
  }
  output.push(`--${boundary}${NL}`);
  const [first, ...rest] = texts;
  if (first !== undefined) {
    output.push(first);
  }
  for (const text of rest) {
    output.push(`${NL}--${boundary}${NL}`, text);
  }
  output.push(`${NL}--${boundary}--${NL}`);
  if (message.epilogue !== null) {
    writeLines(output, message.epilogue);
  }
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;
// `sys.maxsize` on 64-bit CPython: `random.randrange(sys.maxsize)`.
const PY_MAXSIZE = 0x7f_ff_ff_ff_ff_ff_ff_ffn;
const BOUNDARY_TOKEN_DIGITS = 19;

// `Generator._make_boundary()`. The token is a random integer below
// `sys.maxsize` (more than `crypto.randomInt` can draw), zero-padded to 19
// digits; Python's `^` and `$` (MULTILINE) only see `\n` line ends.
function makeBoundary(text: string): string {
  const token = randomBytes(8).readBigUInt64BE() % PY_MAXSIZE;
  const base = `${'='.repeat(15)}${String(token).padStart(BOUNDARY_TOKEN_DIGITS, '0')}==`;
  let candidate = base;
  for (let counter = 0; ; counter += 1) {
    const escaped = candidate.replace(REGEX_SPECIAL, '\\$&');
    const boundaryLine = new RegExp(
      String.raw`(?:^|\n)--${escaped}(?:--)?\r?(?=\n|$)`,
      'u',
    );
    if (!boundaryLine.test(text)) {
      return candidate;
    }
    candidate = `${base}.${counter}`;
  }
}

function handleDeliveryStatus(
  output: string[],
  message: Message,
  cache: FlattenCache | null,
): void {
  const blocks: string[] = [];
  const payload = message.getPayload();
  for (const part of Array.isArray(payload) ? payload : []) {
    const text = flatten(part, cache);
    const lines = text.split(NL);
    blocks.push(lines.at(-1) === '' ? lines.slice(0, -1).join(NL) : text);
  }
  output.push(blocks.join(NL));
}

function handleMessage(
  output: string[],
  message: Message,
  cache: FlattenCache | null,
): void {
  const { payload } = message;
  if (Array.isArray(payload)) {
    const first = payload[0];
    if (first === undefined) {
      throw new RangeError('list index out of range');
    }
    output.push(flatten(first, cache));
  } else if (payload !== null) {
    output.push(payload);
  }
}

function dispatch(
  output: string[],
  message: Message,
  cache: FlattenCache | null,
): Munge | null {
  const main = message.getContentMaintype();
  const sub = message.getContentSubtype();
  if (main === 'multipart') {
    handleMultipart(output, message, cache);
  } else if (main === 'message' && sub === 'delivery-status') {
    handleDeliveryStatus(output, message, cache);
  } else if (main === 'message') {
    handleMessage(output, message, cache);
  } else {
    return handleText(output, message);
  }
  return null;
}

/** Flatten one message: headers, blank line, body. */
function flatten(message: Message, cache: FlattenCache | null): string {
  const cached = cache?.get(message);
  if (cached !== undefined) {
    return cached;
  }
  const body: string[] = [];
  const munge = dispatch(body, message, cache);
  let headers = message;
  if (munge !== null) {
    headers = message.copy();
    if (headers.get('content-transfer-encoding') === undefined) {
      headers.set('Content-Transfer-Encoding', munge[0]);
    } else {
      headers.replaceHeader('content-transfer-encoding', munge[0]);
    }
    headers.replaceHeader('content-type', munge[1]);
  }
  const output: string[] = [];
  writeHeaders(output, headers);
  // The body is appended with `+`, not joined: engines keep the sub-parts'
  // text as shared pieces (ropes) instead of copying it at every level.
  let text = output.join('');
  for (const piece of body) {
    text += piece;
  }
  cache?.add(message, text);
  return text;
}

/**
 * `msg.as_string()` (compat32, no Unix From line). Calls that share a
 * `cache` reuse each other's flattened parts; only share it while the
 * messages are not modified.
 */
export function asString(
  message: Message,
  cache: FlattenCache | null = null,
): string {
  return flatten(message, cache);
}
