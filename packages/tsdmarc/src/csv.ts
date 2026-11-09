// CSV writing compatible with Python's `csv.DictWriter` (excel dialect):
// `,` delimiter, `"` quoting only when needed (QUOTE_MINIMAL), doubled
// quotes, `\r\n` line endings, `None` as an empty cell, other values via
// Python's `str()`.

import { pyStr } from './utils/python';

export type CsvRow = Record<string, unknown>;

const DELIMITER = ',';
const QUOTE = '"';
const LINE_TERMINATOR = '\r\n';

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return pyStr(value);
}

function needsQuotes(cell: string): boolean {
  return (
    cell.includes(DELIMITER) ||
    cell.includes(QUOTE) ||
    cell.includes('\r') ||
    cell.includes('\n')
  );
}

function formatLine(cells: string[]): string {
  if (cells.length === 1 && cells[0] === '') {
    // Python writes a lone empty field as "" so the row isn't blank.
    return `""${LINE_TERMINATOR}`;
  }
  const quoted = cells.map(cell =>
    needsQuotes(cell)
      ? `${QUOTE}${cell.replaceAll(QUOTE, '""')}${QUOTE}`
      : cell,
  );
  return `${quoted.join(DELIMITER)}${LINE_TERMINATOR}`;
}

export interface CsvOptions {
  /**
   * Neutralize spreadsheet formulas (CSV injection): a text cell starting
   * with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`,
   * so Excel, LibreOffice or Google Sheets show it as text instead of
   * evaluating it. Report data comes from untrusted senders. On by
   * default, like parsedmarc 11.1.0 (`_csv_safe`); `false`
   * writes cells unchanged. Numbers (a negative count) are never changed.
   */
  formulaEscape?: boolean;
}

const FORMULA_START = /^[=+\-@\t\r]/u;

/**
 * A text cell with a leading `'` when a spreadsheet would read it as a
 * formula (see {@link CsvOptions.formulaEscape}); other values unchanged.
 */
export function csvFormulaEscape(value: unknown): unknown {
  return typeof value === 'string' && FORMULA_START.test(value)
    ? `'${value}`
    : value;
}

/** Incremental writer, like `csv.DictWriter` over a `StringIO`. */
export class CsvDictWriter {
  readonly fieldnames: readonly string[];
  readonly formulaEscape: boolean;
  private text = '';

  constructor(fieldnames: readonly string[], options: CsvOptions = {}) {
    this.fieldnames = fieldnames;
    this.formulaEscape = options.formulaEscape !== false;
  }

  writeHeader(): void {
    this.text += formatLine([...this.fieldnames]);
  }

  /**
   * Write one row. Missing fields are empty; a field not in `fieldnames`
   * throws, like `DictWriter`'s default `extrasaction="raise"`.
   */
  writeRow(row: CsvRow): void {
    const extras = Object.keys(row).filter(
      key => !this.fieldnames.includes(key),
    );
    if (extras.length > 0) {
      throw new RangeError(
        `dict contains fields not in fieldnames: ${extras.map(key => `'${key}'`).join(', ')}`,
      );
    }
    this.text += formatLine(
      this.fieldnames.map(field =>
        formatCell(
          this.formulaEscape ? csvFormulaEscape(row[field]) : row[field],
        ),
      ),
    );
  }

  getValue(): string {
    return this.text;
  }
}

/** Header plus rows, as one CSV string. */
export function rowsToCsv(
  fieldnames: readonly string[],
  rows: Iterable<CsvRow>,
  options: CsvOptions = {},
): string {
  const writer = new CsvDictWriter(fieldnames, options);
  writer.writeHeader();
  for (const row of rows) {
    writer.writeRow(row);
  }
  return writer.getValue();
}

/**
 * Strip NUL characters from a string cell (parsedmarc's `_csv_safe`).
 * Non-string values are returned unchanged.
 */
export function csvSafe(value: unknown): unknown {
  return typeof value === 'string' ? value.replaceAll('\0', '') : value;
}
