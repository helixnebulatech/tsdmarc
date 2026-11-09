// Reading mbox files like Python's `mailbox.mbox`: the same message
// boundaries (`_generate_toc`), `get_bytes()` and `get_string()`.
//
// Python's mbox does not undo `>From ` quoting when reading, so neither does
// this. `get_string()` re-parses the message from bytes and serializes it
// again (`email.message_from_bytes(...).as_string()`), which is what
// parsedmarc parses.

import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';

import { pyDecode } from './py-codecs';
import { messageFromString } from './py-email/parser';

const LF = 0x0a;
const FROM_LINE = Uint8Array.from([0x46, 0x72, 0x6f, 0x6d, 0x20]); // "From "
const READ_CHUNK_SIZE = 64 * 1024;
const EMPTY = new Uint8Array(0);

interface TocEntry {
  start: number;
  stop: number;
}

function startsWithFrom(head: Uint8Array): boolean {
  return FROM_LINE.every((byte, index) => head[index] === byte);
}

/** `line` with `bytes` added. A copy of them: the read buffer is reused. */
function extendLine(line: LineStart, bytes: Uint8Array): LineStart {
  const missing = FROM_LINE.length - line.head.length;
  return {
    offset: line.offset,
    length: line.length + bytes.length,
    head:
      missing > 0
        ? Uint8Array.from([...line.head, ...bytes.subarray(0, missing)])
        : line.head,
  };
}

/** Open like `_singlefileMailbox.__init__` with `create=True`. */
async function openMailboxFile(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDWR);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Python creates a missing mbox file (and fails if its directory is
      // missing).
      return open(path, 'w+');
    }
    if (code === 'EACCES' || code === 'EROFS') {
      return open(path, 'r');
    }
    throw error;
  }
}

/** What the table of contents needs of a line; the rest is never kept. */
interface LineStart {
  offset: number;
  /** The line's length, with its `\n`. */
  length: number;
  /** The line's first bytes (as many as `From `). */
  head: Uint8Array;
}

/**
 * Read the file line by line. `generateToc()` only looks at the start of each
 * line, so a long one costs no memory, however large the file.
 *
 * @yields {LineStart} Every line.
 */
async function* readLines(file: FileHandle): AsyncGenerator<LineStart> {
  let offset = 0;
  // The start of an unfinished line.
  let pending: LineStart | null = null;
  const buffer = new Uint8Array(READ_CHUNK_SIZE);
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) {
      break;
    }
    const chunk = buffer.subarray(0, bytesRead);
    const chunkOffset = offset;
    offset += bytesRead;
    let lineStart = 0;
    for (
      let index = chunk.indexOf(LF);
      index !== -1;
      index = chunk.indexOf(LF, lineStart)
    ) {
      const tail = chunk.subarray(lineStart, index + 1);
      if (pending === null) {
        yield {
          offset: chunkOffset + lineStart,
          length: tail.length,
          head: tail.subarray(0, FROM_LINE.length),
        };
      } else {
        yield extendLine(pending, tail);
        pending = null;
      }
      lineStart = index + 1;
    }
    if (lineStart < chunk.length) {
      pending = extendLine(
        pending ?? { offset: chunkOffset + lineStart, length: 0, head: EMPTY },
        chunk.subarray(lineStart),
      );
    }
  }
  if (pending !== null) {
    yield pending;
  }
}

/** A read-only view of an mbox file (Python's `mailbox.mbox`). */
export class MboxReader {
  private readonly file: FileHandle;
  private readonly toc: TocEntry[];

  private constructor(file: FileHandle, toc: TocEntry[]) {
    this.file = file;
    this.toc = toc;
  }

  /**
   * Open an mbox file and index its messages. Like Python, a missing file
   * is created empty.
   */
  static async open(path: string): Promise<MboxReader> {
    const file = await openMailboxFile(path);
    try {
      return new MboxReader(file, await MboxReader.generateToc(file));
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  /** Python's `_mboxMMDF._generate_toc()`, with `\n` line separators. */
  private static async generateToc(file: FileHandle): Promise<TocEntry[]> {
    const starts: number[] = [];
    const stops: number[] = [];
    let lastWasEmpty = false;
    let end = 0;
    for await (const { offset: linePos, length, head } of readLines(file)) {
      end = linePos + length;
      if (startsWithFrom(head)) {
        if (stops.length < starts.length) {
          stops.push(lastWasEmpty ? linePos - 1 : linePos);
        }
        starts.push(linePos);
        lastWasEmpty = false;
      } else if (length === 1 && head[0] === LF) {
        lastWasEmpty = true;
      } else {
        lastWasEmpty = false;
      }
    }
    // End of file.
    stops.push(lastWasEmpty ? end - 1 : end);
    const count = Math.min(starts.length, stops.length);
    const toc: TocEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      toc.push({ start: starts[index] ?? 0, stop: stops[index] ?? 0 });
    }
    return toc;
  }

  /** Message keys, in file order. */
  keys(): number[] {
    return this.toc.map((_entry, index) => index);
  }

  get length(): number {
    return this.toc.length;
  }

  /** The size of a message in the file, in bytes (its `From ` line included). */
  size(key: number): number {
    const { start, stop } = this.entry(key);
    return Math.max(stop - start, 0);
  }

  private entry(key: number): TocEntry {
    const entry = this.toc[key];
    if (entry === undefined) {
      throw new RangeError(`No message with key: ${key}`);
    }
    return entry;
  }

  /** `get_bytes(key)`: the message without its `From ` line. */
  async getBytes(key: number): Promise<Uint8Array> {
    const { start, stop } = this.entry(key);
    const raw = new Uint8Array(Math.max(stop - start, 0));
    let filled = 0;
    while (filled < raw.length) {
      const { bytesRead } = await this.file.read(
        raw,
        filled,
        raw.length - filled,
        start + filled,
      );
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    const data = raw.subarray(0, filled);
    const firstLineEnd = data.indexOf(LF);
    return firstLineEnd === -1
      ? new Uint8Array(0)
      : data.slice(firstLineEnd + 1);
  }

  /**
   * `get_string(key)`: the message parsed from bytes and serialized again,
   * like `email.message_from_bytes(...).as_string()`.
   */
  async getString(key: number): Promise<string> {
    const text = pyDecode(await this.getBytes(key), 'ascii', 'surrogateescape');
    return messageFromString(text).asString();
  }

  async close(): Promise<void> {
    await this.file.close();
  }
}
