import { describe, expect, it } from 'vitest';

import { CsvDictWriter, csvFormulaEscape, csvSafe, rowsToCsv } from './csv';

// Expected strings were produced by Python's csv.DictWriter (excel dialect).
describe('CSV writing like csv.DictWriter', () => {
  it('quotes only when needed and prints Python values', () => {
    const csv = rowsToCsv(
      ['a', 'b', 'c'],
      [
        { a: 'x', b: null, c: true },
        { a: 'he said "hi"', b: '1,2', c: 'line\nbreak' },
        { a: 'cr\rhere', b: 0, c: -3 },
        { a: ' lead', b: 'trail ', c: '' },
        { a: 1.5, b: 0.1, c: 1e-5 },
      ],
    );
    expect(csv).toBe(
      'a,b,c\r\nx,,True\r\n"he said ""hi""","1,2","line\nbreak"\r\n"cr\rhere",0,-3\r\n lead,trail ,\r\n1.5,0.1,1e-05\r\n',
    );
  });

  it('writes a lone empty field as ""', () => {
    const writer = new CsvDictWriter(['only']);
    writer.writeHeader();
    writer.writeRow({ only: '' });
    writer.writeRow({});
    expect(writer.getValue()).toBe('only\r\n""\r\n""\r\n');
  });

  it('rejects fields not in fieldnames', () => {
    const writer = new CsvDictWriter(['a']);
    expect(() => writer.writeRow({ a: 1, zz: 2 })).toThrow(
      "dict contains fields not in fieldnames: 'zz'",
    );
  });

  it('strips NUL characters from strings only', () => {
    expect(csvSafe('a\0b')).toBe('ab');
    expect(csvSafe(5)).toBe(5);
  });
});

describe('CSV formula escaping', () => {
  const rows = [
    {
      a: '=HYPERLINK("http://x")',
      b: '+1',
      c: '-2+3',
      d: '@SUM(A1)',
      e: '\tx',
      f: '\rx',
    },
    { a: 'plain', b: -3, c: 'a=b', d: "'quoted", e: '', f: null },
  ];
  const fields = ['a', 'b', 'c', 'd', 'e', 'f'];

  it('can be turned off', () => {
    expect(rowsToCsv(fields, rows, { formulaEscape: false })).toBe(
      'a,b,c,d,e,f\r\n"=HYPERLINK(""http://x"")",+1,-2+3,@SUM(A1),\tx,"\rx"\r\nplain,-3,a=b,\'quoted,,\r\n',
    );
  });

  it('prefixes formula-like text cells with a quote by default, never numbers', () => {
    expect(rowsToCsv(fields, rows)).toBe(
      'a,b,c,d,e,f\r\n"\'=HYPERLINK(""http://x"")",\'+1,\'-2+3,\'@SUM(A1),\'\tx,"\'\rx"\r\nplain,-3,a=b,\'quoted,,\r\n',
    );
    expect(csvFormulaEscape('=1')).toBe("'=1");
    expect(csvFormulaEscape(-1)).toBe(-1);
    expect(csvFormulaEscape('ok')).toBe('ok');
  });
});

// tests/test_init.py::testCsvSafeNeutralizesFormulaPrefixes: parsedmarc's
// `_csv_safe` strips NUL, then escapes; here csvSafe() builds the row and
// the writer escapes.
describe('_csv_safe', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', "'\rcmd"],
    ['\u0000=1+1', "'=1+1"],
    ['Example Inc.', 'Example Inc.'],
    ['a-b=c+d@e', 'a-b=c+d@e'],
    ['', ''],
    [15_169, 15_169],
    [null, null],
  ])('testCsvSafeNeutralizesFormulaPrefixes(%j)', (value, expected) => {
    expect(csvFormulaEscape(csvSafe(value))).toBe(expected);
  });
});
