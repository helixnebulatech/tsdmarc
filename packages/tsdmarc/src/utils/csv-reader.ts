// Python's `csv.reader` / `csv.DictReader` with the default `excel` dialect
// (comma delimiter, `"` quoting with doubled quotes, no escape character,
// non-strict), used to read the reverse DNS map like parsedmarc does.
//
// A port of the state machine in CPython's Modules/_csv.c, fed the lines
// `io.StringIO(text)` yields (split after each `\n`, nothing translated),
// so blank rows, bare `\r`, unterminated quotes and errors match.

/** Python's `_csv.Error`. */
export class CsvError extends Error {
  override name = 'Error';
}

/** `csv.field_size_limit()` default. */
const FIELD_SIZE_LIMIT = 131_072;

// Parser states (a plain object: worker threads load this file with Node's
// type stripping, which has no enums).
const ParserState = {
  StartRecord: 0,
  StartField: 1,
  InField: 2,
  InQuotedField: 3,
  QuoteInQuotedField: 4,
  EatCrnl: 5,
} as const;
type ParserStateValue = (typeof ParserState)[keyof typeof ParserState];

const EOL = '';
const DELIMITER = ',';
const QUOTE = '"';

function isLineBreak(char: string): boolean {
  return char === '\n' || char === '\r';
}

/**
 * `io.StringIO(text)` lines: each ends after a `\n`, the last may not.
 *
 * @yields {string} each line, with its `\n`.
 */
function* stringIoLines(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline + 1;
    yield text.slice(start, end);
    start = end;
  }
}

class CsvParser {
  state: ParserStateValue = ParserState.StartRecord;
  fields: string[] = [];
  field = '';
  fieldLength = 0;

  reset(): void {
    this.state = ParserState.StartRecord;
    this.fields = [];
    this.field = '';
    this.fieldLength = 0;
  }

  saveField(): void {
    this.fields.push(this.field);
    this.field = '';
    this.fieldLength = 0;
  }

  addChar(char: string): void {
    if (this.fieldLength >= FIELD_SIZE_LIMIT) {
      throw new CsvError(`field larger than field limit (${FIELD_SIZE_LIMIT})`);
    }
    this.field += char;
    this.fieldLength += 1;
  }

  /** `parse_process_char()`; `EOL` marks the end of a line. */
  processChar(char: string): void {
    switch (this.state) {
      case ParserState.StartRecord: {
        if (char === EOL) {
          return; // Empty line: an empty row.
        }
        if (isLineBreak(char)) {
          this.state = ParserState.EatCrnl;
          return;
        }
        this.state = ParserState.StartField;
        this.startField(char);
        return;
      }
      case ParserState.StartField: {
        this.startField(char);
        return;
      }
      case ParserState.InField: {
        if (isLineBreak(char) || char === EOL) {
          this.saveField();
          this.state =
            char === EOL ? ParserState.StartRecord : ParserState.EatCrnl;
        } else if (char === DELIMITER) {
          this.saveField();
          this.state = ParserState.StartField;
        } else {
          this.addChar(char);
        }
        return;
      }
      case ParserState.InQuotedField: {
        if (char === EOL) {
          return;
        }
        if (char === QUOTE) {
          this.state = ParserState.QuoteInQuotedField;
        } else {
          this.addChar(char);
        }
        return;
      }
      case ParserState.QuoteInQuotedField: {
        if (char === QUOTE) {
          this.addChar(char);
          this.state = ParserState.InQuotedField;
        } else if (char === DELIMITER) {
          this.saveField();
          this.state = ParserState.StartField;
        } else if (isLineBreak(char) || char === EOL) {
          this.saveField();
          this.state =
            char === EOL ? ParserState.StartRecord : ParserState.EatCrnl;
        } else {
          // Not strict: text after the closing quote joins the field.
          this.addChar(char);
          this.state = ParserState.InField;
        }
        return;
      }
      case ParserState.EatCrnl: {
        if (char === EOL) {
          this.state = ParserState.StartRecord;
        } else if (!isLineBreak(char)) {
          throw new CsvError(
            "new-line character seen in unquoted field - do you need to open the file with newline=''?",
          );
        }
        return;
      }
      default: {
        throw new CsvError('unknown parser state');
      }
    }
  }

  private startField(char: string): void {
    if (isLineBreak(char) || char === EOL) {
      this.saveField();
      this.state = char === EOL ? ParserState.StartRecord : ParserState.EatCrnl;
    } else if (char === QUOTE) {
      this.state = ParserState.InQuotedField;
    } else if (char === DELIMITER) {
      this.saveField();
    } else {
      this.addChar(char);
      this.state = ParserState.InField;
    }
  }
}

/**
 * Rows of a CSV text, lazily, like `csv.reader(io.StringIO(text))`. Blank
 * lines give `[]`; malformed input throws {@link CsvError} when reached.
 *
 * @yields {string[]} the fields of each record.
 */
export function* iterCsvRows(text: string): Generator<string[]> {
  const parser = new CsvParser();
  const lines = stringIoLines(text);
  for (;;) {
    parser.reset();
    let ended = false;
    do {
      const next = lines.next();
      if (next.done === true) {
        ended = true;
        break;
      }
      for (const char of next.value) {
        parser.processChar(char);
      }
      parser.processChar(EOL);
    } while (parser.state !== ParserState.StartRecord);
    if (ended) {
      // End of data mid-record: non-strict csv keeps what it has.
      if (
        parser.fieldLength !== 0 ||
        parser.state === ParserState.InQuotedField
      ) {
        parser.saveField();
        yield parser.fields;
      }
      return;
    }
    yield parser.fields;
  }
}

/** Rows of a CSV text, like `list(csv.reader(io.StringIO(text)))`. */
export function readCsvRows(text: string): string[][] {
  return [...iterCsvRows(text)];
}

/** A `csv.DictReader` row: missing trailing fields are `null`; extra fields go under `null`. */
export type CsvDictRow = Map<string | null, string | string[] | null>;

/**
 * Rows as dicts keyed by the header row, lazily, like
 * `csv.DictReader(io.StringIO(text))`. The header is the first row even
 * when blank; later blank rows are skipped.
 *
 * @yields {CsvDictRow} each non-blank record after the header.
 */
export function* readCsvDicts(text: string): Generator<CsvDictRow> {
  const rows = iterCsvRows(text);
  const header = rows.next();
  if (header.done === true) {
    return;
  }
  const fieldnames = header.value;
  for (const row of rows) {
    if (row.length === 0) {
      continue;
    }
    const dict: CsvDictRow = new Map();
    for (const [position, value] of row.entries()) {
      if (position >= fieldnames.length) {
        break;
      }
      dict.set(fieldnames[position] as string, value);
    }
    if (row.length > fieldnames.length) {
      dict.set(null, row.slice(fieldnames.length));
    } else {
      for (const name of fieldnames.slice(row.length)) {
        dict.set(name, null);
      }
    }
    yield dict;
  }
}
