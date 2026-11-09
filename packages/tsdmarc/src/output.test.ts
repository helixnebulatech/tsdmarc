// Port of TestAppendJson, TestAppendCsv and TestSaveOutput from
// tests/test_init.py, plus tests of getReportZip() and the edge cases of
// the file formats.

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseAggregateReportXml,
  parsedAggregateReportsToCsv,
} from './aggregate';
import { parsedFailureReportsToCsv } from './failure';
import type * as PyJson from './internal/py-json';
import { captureLogs } from './log';
import { appendCsv, appendJson, getReportZip, saveOutput } from './output';
import { toCamelCaseKeys } from './serialize';
import { parsedSmtpTlsReportsToCsv } from './smtp-tls';
import { loadFixture, samplePath } from './test/fixtures';
import type {
  AggregateReport,
  FailureReport,
  ParsingResults,
  SMTPTLSReport,
} from './types';

// Faults a real disk would give, with what a failed write leaves behind.
const faults = vi.hoisted(() => ({
  diskFull: false,
  unreadable: false,
  refusedName: '',
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>();
  const noSpace = (): Error =>
    Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      if (faults.unreadable) {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      }
      return await actual.readFile(...args);
    },
    async writeFile(...args: Parameters<typeof actual.writeFile>) {
      const [target, data] = args;
      if (faults.diskFull) {
        await actual.writeFile(target, String(data).slice(0, 10));
        throw noSpace();
      }
      if (faults.refusedName && String(target).endsWith(faults.refusedName)) {
        throw Object.assign(new Error('ENAMETOOLONG: name too long'), {
          code: 'ENAMETOOLONG',
        });
      }
      await actual.writeFile(...args);
    },
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof write>) => {
        if (faults.diskFull) {
          await write(String(writeArgs[0]).slice(0, 10));
          throw noSpace();
        }
        await write(...writeArgs);
      };
      return handle;
    },
  };
});

// Lets a test fail one serialization: no real report reaches V8's limit
// without several gigabytes of memory.
const jsonFaults = vi.hoisted(() => ({ tooLong: false }));

vi.mock('./internal/py-json', async importOriginal => {
  const actual = await importOriginal<typeof PyJson>();
  return {
    ...actual,
    pyJsonDumps(...args: Parameters<typeof actual.pyJsonDumps>) {
      if (jsonFaults.tooLong) {
        throw new RangeError('Invalid string length');
      }
      return actual.pyJsonDumps(...args);
    },
  };
});

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'tsdmarc-output-'));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  Object.assign(faults, {
    diskFull: false,
    unreadable: false,
    refusedName: '',
  });
  jsonFaults.tooLong = false;
});

function tempPath(name: string): string {
  return path.join(tempRoot, name);
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

// appendJson converts camelCase keys to snake_case; these test objects
// have no keys to convert, like the Python test dicts.
function reports(...items: Record<string, unknown>[]): AggregateReport[] {
  return items as unknown as AggregateReport[];
}

function fixtureReport<T>(relative: string): T {
  const report = loadFixture(relative).result?.report;
  expect(report).toBeDefined();
  return toCamelCaseKeys(report) as T;
}

describe('appendJson', () => {
  // appendJson writes new files cleanly and merges into existing JSON
  // arrays without breaking valid JSON.
  it('test_writes_new_file', async () => {
    const filePath = tempPath('new.json');
    await appendJson(filePath, reports({ a: 1 }));
    expect(readJson(filePath)).toEqual([{ a: 1 }]);
  });

  it('test_appends_to_existing_file', async () => {
    const filePath = tempPath('existing.json');
    writeFileSync(filePath, '');
    await appendJson(filePath, reports({ a: 1 }));
    await appendJson(filePath, reports({ b: 2 }));
    expect(readJson(filePath)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('test_empty_list_on_existing_file_is_noop', async () => {
    const filePath = tempPath('existing.json');
    await appendJson(filePath, reports({ a: 1 }));
    const before = readFileSync(filePath, 'utf-8');
    await appendJson(filePath, []);
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
    expect(readJson(filePath)).toEqual([{ a: 1 }]);
  });

  it('does not create a file for an empty list', async () => {
    const filePath = tempPath('none.json');
    await appendJson(filePath, []);
    expect(existsSync(filePath)).toBe(false);
  });

  it('test_corrupt_existing_file_is_overwritten_cleanly', async () => {
    // A corrupt file (e.g. truncated by a crash) makes way for the new
    // content rather than failing to record (its bytes are kept aside).
    const filePath = tempPath('corrupt.json');
    writeFileSync(filePath, '{ this is not valid json at all');
    await appendJson(filePath, reports({ new: 'data' }));
    expect(readJson(filePath)).toEqual([{ new: 'data' }]);
  });

  it('test_existing_file_with_non_list_root_is_overwritten', async () => {
    const filePath = tempPath('dict.json');
    writeFileSync(filePath, '{"not": "a list"}');
    await appendJson(filePath, reports({ new: 'data' }));
    expect(readJson(filePath)).toEqual([{ new: 'data' }]);
  });

  it('keeps a corrupt file aside with a warning instead of losing it', async () => {
    const filePath = tempPath('history.json');
    await appendJson(filePath, reports({ id: 1 }, { id: 2 }));
    const history = readFileSync(filePath, 'utf-8').slice(0, -3);
    writeFileSync(filePath, history);
    const capture = captureLogs();
    try {
      await appendJson(filePath, reports({ id: 3 }));
      expect(capture.output).toEqual([
        expect.stringMatching(
          /^WARNING:tsdmarc:.*history\.json is not valid JSON: moved to .*history\.json\.corrupt-\d+, starting a new file$/u,
        ),
      ]);
    } finally {
      capture.restore();
    }
    expect(readJson(filePath)).toEqual([{ id: 3 }]);
    const aside = readdirSync(tempRoot).find(name =>
      name.includes('.corrupt-'),
    );
    expect(readFileSync(tempPath(aside ?? ''), 'utf-8')).toBe(history);
  });

  it('keeps aside an array-less file and one that cannot be read', async () => {
    const filePath = tempPath('dict.json');
    writeFileSync(filePath, '{"a": 1}');
    await appendJson(filePath, reports({ id: 1 }));
    faults.unreadable = true;
    await appendJson(filePath, reports({ id: 2 }));
    expect(readJson(filePath)).toEqual([{ id: 2 }]);
    const aside = readdirSync(tempRoot)
      .filter(name => name.includes('.corrupt-'))
      .map(name => readFileSync(tempPath(name), 'utf-8'));
    expect(aside.toSorted()).toEqual([
      '[\n  {\n    "id": 1\n  }\n]',
      '{"a": 1}',
    ]);
  });

  it('leaves the file whole when the disk fills up during a write', async () => {
    const filePath = tempPath('full.json');
    await appendJson(filePath, reports({ id: 1 }, { id: 2 }));
    faults.diskFull = true;
    await expect(appendJson(filePath, reports({ id: 3 }))).rejects.toThrow(
      'ENOSPC',
    );
    faults.diskFull = false;
    expect(readJson(filePath)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(readdirSync(tempRoot)).toEqual(['full.json']);
    await appendJson(filePath, reports({ id: 3 }));
    expect(readJson(filePath)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('keeps every report of concurrent calls for one file', async () => {
    const filePath = tempPath('concurrent.json');
    const ids = Array.from({ length: 20 }, (_, id) => id);
    await Promise.all(
      ids.map(async id => {
        await appendJson(filePath, reports({ id }));
      }),
    );
    expect(readJson(filePath)).toEqual(ids.map(id => ({ id })));
  });

  it('keeps the mode of the file and writes through a symbolic link', async () => {
    const realPath = tempPath('real.json');
    const linkPath = tempPath('link.json');
    await appendJson(realPath, reports({ id: 1 }));
    chmodSync(realPath, 0o640);
    symlinkSync(realPath, linkPath);
    await appendJson(linkPath, reports({ id: 2 }));
    expect(readJson(realPath)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(statSync(realPath).mode & 0o777).toBe(0o640);
  });

  it('splices into a large file what rewriting it would give', async () => {
    const filePath = tempPath('large.json');
    const padding = 'é'.repeat(5 * 1024 * 1024);
    await appendJson(filePath, reports({ id: 1, padding }));
    const existing = readFileSync(filePath);
    expect(existing.length).toBeGreaterThan(8 * 1024 * 1024);
    await appendJson(filePath, reports({ id: 2 }, { id: 3 }));
    const expected = `${existing.toString('utf-8').slice(0, -2)},\n  {\n    "id": 2\n  },\n  {\n    "id": 3\n  }\n]`;
    expect(readFileSync(filePath, 'utf-8') === expected).toBe(true);
  });

  it('appends to a file too long for a string, without reading it all', async () => {
    // Sparse, so it costs almost nothing here, but 600 MiB once copied:
    // V8 strings stop at 512 MiB of characters.
    const filePath = tempPath('huge.json');
    const size = 600 * 1024 * 1024;
    const tail = '\n  }\n]';
    writeFileSync(filePath, '[\n  {\n    "a": "');
    truncateSync(filePath, size - tail.length);
    const fd = openSync(filePath, 'r+');
    writeSync(fd, tail, size - tail.length);
    closeSync(fd);
    await appendJson(filePath, reports({ id: 2 }));
    expect(statSync(filePath).size).toBe(
      size + ',\n  {\n    "id": 2\n  }'.length,
    );
    const end = Buffer.alloc(24);
    const reader = openSync(filePath, 'r');
    readSync(reader, end, 0, end.length, statSync(filePath).size - end.length);
    closeSync(reader);
    expect(end.toString('latin1')).toBe(
      '\n  },\n  {\n    "id": 2\n  }\n]'.slice(-24),
    );
  });

  it('sets aside a huge file it cannot parse, keeping it whole', async () => {
    const filePath = tempPath('compact.json');
    const size = 300 * 1024 * 1024;
    writeFileSync(filePath, '[');
    truncateSync(filePath, size);
    await appendJson(filePath, reports({ id: 1 }));
    expect(readJson(filePath)).toEqual([{ id: 1 }]);
    const aside = readdirSync(tempRoot).find(name =>
      name.includes('.corrupt-'),
    );
    expect(statSync(tempPath(aside ?? '')).size).toBe(size);
  });

  it('turns a report too long for a string into a ValueError', async () => {
    const filePath = tempPath('toolong.json');
    jsonFaults.tooLong = true;
    await expect(
      appendJson(filePath, reports({ id: 1 })),
    ).rejects.toMatchObject({
      name: 'ValueError',
      message: expect.stringContaining('too large'),
    });
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('writes json.dump(indent=2) layout, without a trailing newline', async () => {
    const filePath = tempPath('layout.json');
    await appendJson(filePath, reports({ a: 1, b: [], c: {}, d: ['x'] }));
    expect(readFileSync(filePath, 'utf-8')).toBe(
      '[\n  {\n    "a": 1,\n    "b": [],\n    "c": {},\n    "d": [\n      "x"\n    ]\n  }\n]',
    );
  });

  it('writes non-ASCII as is (ensure_ascii=False)', async () => {
    const filePath = tempPath('utf8.json');
    await appendJson(filePath, reports({ org: 'exämple' }));
    expect(readFileSync(filePath, 'utf-8')).toContain('"org": "exämple"');
  });

  it('merges onto an array file with a trailing newline', async () => {
    const filePath = tempPath('newline.json');
    writeFileSync(filePath, '[\n  {"a": 1}\n]\n');
    await appendJson(filePath, reports({ b: 2 }));
    expect(readJson(filePath)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  // Expected text is parsedmarc's append_json() output for the same file.
  it('keeps existing numbers as json.loads/json.dump round-trips them', async () => {
    const filePath = tempPath('numbers.json');
    writeFileSync(
      filePath,
      '[{"a": 12345678901234567890, "b": 1.0, "c": NaN, "d": 1e400, "e": -0, "f": 1E5, "g": -0.0, "h": 2.50, "i": 1e-7, "j": "\\u00e9"}]',
    );
    await appendJson(filePath, reports({ k: 1 }));
    expect(readFileSync(filePath, 'utf-8')).toBe(
      '[\n  {\n    "a": 12345678901234567890,\n    "b": 1.0,\n    "c": NaN,\n    "d": Infinity,\n    "e": 0,\n    "f": 100000.0,\n    "g": -0.0,\n    "h": 2.5,\n    "i": 1e-07,\n    "j": "é"\n  },\n  {\n    "k": 1\n  }\n]',
    );
  });

  it('overwrites a file with a UTF-8 BOM (json.loads rejects it)', async () => {
    const filePath = tempPath('bom.json');
    writeFileSync(filePath, '﻿[{"a": 1}]');
    await appendJson(filePath, reports({ b: 2 }));
    expect(readJson(filePath)).toEqual([{ b: 2 }]);
  });

  it('raises UnicodeDecodeError for a file that is not UTF-8', async () => {
    const filePath = tempPath('latin1.json');
    writeFileSync(filePath, Buffer.from([0x5b, 0xff, 0x5d]));
    await expect(appendJson(filePath, reports({ b: 2 }))).rejects.toMatchObject(
      {
        name: 'UnicodeDecodeError',
      },
    );
    expect(readFileSync(filePath)).toEqual(Buffer.from([0x5b, 0xff, 0x5d]));
  });

  it("writes reports with snake_case keys, equal to parsedmarc's JSON", async () => {
    const relative =
      'aggregate/example.net!example.com!1529366400!1529452799.xml';
    const report = fixtureReport<AggregateReport>(relative);
    const filePath = tempPath('aggregate.json');
    await appendJson(filePath, [report]);
    await appendJson(filePath, [report]);
    const expected = loadFixture(relative).result?.report;
    expect(readJson(filePath)).toEqual([expected, expected]);
  });
});

describe('appendCsv', () => {
  it('test_writes_new_file_with_header', async () => {
    const filePath = tempPath('new.csv');
    await appendCsv(filePath, 'h1,h2\nv1,v2\n');
    expect(readFileSync(filePath, 'utf-8')).toBe('h1,h2\nv1,v2\n');
  });

  it('test_appends_strips_header_on_existing_file', async () => {
    // A second append must not repeat the header line.
    const filePath = tempPath('existing.csv');
    writeFileSync(filePath, '');
    await appendCsv(filePath, 'h1,h2\nv1,v2\n');
    await appendCsv(filePath, 'h1,h2\nv3,v4\n');
    const content = readFileSync(filePath, 'utf-8');
    expect(content.split('h1,h2')).toHaveLength(2);
    expect(content).toContain('v3,v4');
    expect(content).toBe('h1,h2\nv1,v2\nv3,v4\n');
  });

  it('test_append_empty_csv_on_existing_file_is_noop', async () => {
    // A header-only CSV leaves an existing file untouched.
    const filePath = tempPath('existing.csv');
    await appendCsv(filePath, 'h1,h2\nv1,v2\n');
    await appendCsv(filePath, 'h1,h2\n');
    expect(readFileSync(filePath, 'utf-8')).toBe('h1,h2\nv1,v2\n');
  });

  it('writes the header of a header-only CSV to a new file', async () => {
    const filePath = tempPath('header.csv');
    await appendCsv(filePath, 'h1,h2\r\n');
    expect(readFileSync(filePath, 'utf-8')).toBe('h1,h2\r\n');
  });

  it('keeps CRLF rows (Python opens with newline="\\n")', async () => {
    const filePath = tempPath('crlf.csv');
    await appendCsv(filePath, 'h1,h2\r\nv1,v2\r\n');
    await appendCsv(filePath, 'h1,h2\r\nv3,v4\r\n');
    expect(readFileSync(filePath, 'utf-8')).toBe('h1,h2\r\nv1,v2\r\nv3,v4\r\n');
  });

  it('raises ValueError for a CSV without a newline on an existing file', async () => {
    const filePath = tempPath('existing.csv');
    writeFileSync(filePath, 'h1\n');
    await expect(appendCsv(filePath, 'h1')).rejects.toMatchObject({
      name: 'ValueError',
      message: 'not enough values to unpack (expected 2, got 1)',
    });
    expect(readFileSync(filePath, 'utf-8')).toBe('h1\n');
  });
});

describe('saveOutput', () => {
  it('writes nothing when a report cannot be flattened to CSV', async () => {
    // JSON appended before the CSV step throws would gain a copy per retry.
    const results = {
      aggregateReports: [],
      failureReports: [],
      smtpTlsReports: [
        {
          organizationName: 'x',
          beginDate: 'b',
          endDate: 'e',
          reportId: 'r',
          contactInfo: 'c',
          policies: [
            {
              policyDomain: 'example.com',
              policyType: 'sts',
              policyStrings: [1],
              successfulSessionCount: 1,
              failedSessionCount: 0,
            },
          ],
        },
      ],
    } as unknown as ParsingResults;
    const output = tempPath('poison');

    await expect(
      saveOutput(results, { outputDirectory: output }),
    ).rejects.toThrow(TypeError);

    expect(readdirSync(output)).toEqual([]);
  });

  // saveOutput() writes each failure report's message sample to a file
  // named after the sample's Subject header. That header comes from an
  // untrusted sender, so these tests check the layout of the whole
  // temporary root, not just the samples directory (GHSA-c284-w5m6-jhjm
  // wrote files above it).
  let outputDirectory: string;

  beforeEach(() => {
    // Nested, so a traversal out of samples/ has somewhere to land
    // inside the tree the assertions walk.
    outputDirectory = path.join(tempRoot, 'parsedmarc', 'output');
  });

  function failureReport(
    subject: string,
    parsedSampleExtra: Record<string, unknown> = {},
  ): FailureReport {
    // A failure report carrying only the keys saveOutput() reads.
    return {
      sample: `Subject: ${subject}\r\n\r\nThe message body.\r\n`,
      parsedSample: { subject, ...parsedSampleExtra },
      // Read only by the CSV renderer saveOutput() also calls.
      authFailure: ['dmarc'],
      authenticationMechanisms: [],
      source: {
        ipAddress: '192.0.2.1',
        reverseDns: null,
        baseDomain: null,
        name: null,
        type: null,
        asn: null,
        asName: null,
        asDomain: null,
        country: null,
      },
    } as unknown as FailureReport;
  }

  async function save(...failureReports: FailureReport[]): Promise<void> {
    await saveOutput(
      { aggregateReports: [], failureReports, smtpTlsReports: [] },
      { outputDirectory },
    );
  }

  /** Every file under the temp root, relative to it, sorted. */
  function writtenFiles(): string[] {
    return (
      readdirSync(tempRoot, { recursive: true, withFileTypes: true }) ?? []
    )
      .filter(entry => entry.isFile())
      .map(entry =>
        path.relative(tempRoot, path.join(entry.parentPath, entry.name)),
      )
      .toSorted();
  }

  const samples = path.join('parsedmarc', 'output', 'samples');

  it('escapes CSV formulas unless csvFormulaEscape is false', async () => {
    const report = failureReport('=HYPERLINK("http://evil.example")');
    const csvPath = path.join(outputDirectory, 'failure.csv');
    await save(report);
    expect(readFileSync(csvPath, 'utf8')).toContain(
      ',"\'=HYPERLINK(""http://evil.example"")",',
    );
    rmSync(outputDirectory, { recursive: true });
    await saveOutput(
      { aggregateReports: [], failureReports: [report], smtpTlsReports: [] },
      { outputDirectory, csvFormulaEscape: false },
    );
    expect(readFileSync(csvPath, 'utf8')).toContain(
      ',"=HYPERLINK(""http://evil.example"")",',
    );
  });

  it('testTraversalSubjectsAreConfinedToTheSamplesDirectory', async () => {
    // Subjects made only of path separators and dots collapse to the
    // "sample" fallback inside samples/ instead of escaping it.
    await save(
      failureReport('../../../'),
      failureReport('/'),
      failureReport('..'),
    );
    expect(writtenFiles().filter(file => file.endsWith('.eml'))).toEqual([
      path.join(samples, 'sample (1).eml'),
      path.join(samples, 'sample (2).eml'),
      path.join(samples, 'sample.eml'),
    ]);
    // Nothing at all was written above the output directory.
    for (const file of writtenFiles()) {
      expect(
        file.startsWith(path.join('parsedmarc', 'output') + path.sep),
      ).toBe(true);
    }
  });

  it('testCraftedFilenameSafeSubjectIsIgnored', async () => {
    // The filename comes from the subject at write time; a caller-supplied
    // filenameSafeSubject cannot name the file.
    await save(
      failureReport('monthly digest', { filenameSafeSubject: '../evil' }),
    );
    const written = writtenFiles();
    expect(written).toContain(path.join(samples, 'monthly digest.eml'));
    expect(written.filter(file => file.includes('evil'))).toEqual([]);
  });

  it('testNullByteSubjectIsStrippedAndWritten', async () => {
    // A NUL in the subject is stripped rather than reaching open().
    await save(failureReport('re\0port'));
    expect(writtenFiles().filter(file => file.endsWith('.eml'))).toEqual([
      path.join(samples, 'report.eml'),
    ]);
  });

  it('testOrdinarySubjectNamesTheFileAndSampleIsWrittenVerbatim', async () => {
    const report = failureReport('DMARC failure report');
    await save(report);
    const filePath = path.join(
      outputDirectory,
      'samples',
      'DMARC failure report.eml',
    );
    // CRLFs are not translated.
    expect(readFileSync(filePath, 'utf-8')).toBe(report.sample);
  });

  it('testParsedSampleReportIsNamedFromItsSubject', async () => {
    // End to end with a real failure report from the sample corpus
    // (parsedmarc's own parse of it, from fixtures/).
    await save(
      fixtureReport<FailureReport>('failure/dmarc_ruf_report_linkedin.eml'),
    );
    expect(writtenFiles().filter(file => file.endsWith('.eml'))).toEqual([
      path.join(samples, 'Subject line, could be UTF8 encoded.eml'),
    ]);
  });

  it('testMultiByteSubjectWithinFilesystemNameLimit', async () => {
    // GHSA-j53g-34vj-g25q: 84 three-byte characters plus ".eml" were a
    // 256-byte name, and saveOutput() failed with ENAMETOOLONG.
    await save(failureReport('\u4E2D'.repeat(84)));
    expect(writtenFiles().filter(file => file.endsWith('.eml'))).toEqual([
      path.join(samples, `${'\u4E2D'.repeat(33)}.eml`),
    ]);
  });

  it('keeps sample names under the file name length limit', async () => {
    // 100 emoji are 400 bytes; the name keeps 25 (100 bytes), with room for
    // the " (1)" suffix.
    await save(
      failureReport('😀'.repeat(100)),
      failureReport('😀'.repeat(100)),
    );
    expect(writtenFiles().filter(file => file.endsWith('.eml'))).toEqual(
      [
        path.join(samples, `${'😀'.repeat(25)} (1).eml`),
        path.join(samples, `${'😀'.repeat(25)}.eml`),
      ].toSorted(),
    );
  });

  it('never replaces a sample saved by an earlier call', async () => {
    const directory = path.join(outputDirectory, 'samples');
    for (const sample of ['first', 'second', 'third']) {
      await save({ ...failureReport('same'), sample });
    }
    const read = (name: string): string =>
      readFileSync(path.join(directory, name), 'utf-8');
    expect(read('same.eml')).toBe('first');
    expect(read('same (1).eml')).toBe('second');
    expect(read('same (2).eml')).toBe('third');
  });

  it('stops probing numbers after a long run of one subject', async () => {
    const directory = path.join(outputDirectory, 'samples');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'same.eml'), 'old');
    for (let count = 1; count <= 1000; count += 1) {
      writeFileSync(path.join(directory, `same (${count}).eml`), 'old');
    }
    await save({ ...failureReport('same'), sample: 'new' });
    const added = readdirSync(directory).filter(name =>
      /^same \([0-9a-f]{12}\)\.eml$/u.test(name),
    );
    expect(added).toHaveLength(1);
    expect(readFileSync(path.join(directory, added[0] ?? ''), 'utf-8')).toBe(
      'new',
    );
  });

  it('falls back to "sample" when a sample file cannot be written', async () => {
    faults.refusedName = 'blocked.eml';
    const capture = captureLogs();
    try {
      await save(failureReport('blocked'), failureReport('fine'));
      expect(capture.output).toEqual([
        expect.stringMatching(
          /^WARNING:tsdmarc:Could not write sample "blocked"\.eml \(.*\); writing it as sample\.eml instead$/u,
        ),
      ]);
    } finally {
      capture.restore();
    }
    expect(writtenFiles().filter(file => file.endsWith('.eml'))).toEqual([
      path.join(samples, 'fine.eml'),
      path.join(samples, 'sample.eml'),
    ]);
  });

  it('names a sample without a subject "None", like Python', async () => {
    await save(failureReport('x', { subject: null }));
    expect(writtenFiles().filter(file => file.endsWith('.eml'))).toEqual([
      path.join(samples, 'None.eml'),
    ]);
  });

  it('writes every file, with CSV headers even when there are no reports', async () => {
    const aggregate = fixtureReport<AggregateReport>(
      'aggregate/example.net!example.com!1529366400!1529452799.xml',
    );
    const smtpTls = fixtureReport<SMTPTLSReport>(
      'smtp_tls/google.com_smtp_tls_report.eml',
    );
    const results: ParsingResults = {
      aggregateReports: [aggregate],
      failureReports: [],
      smtpTlsReports: [smtpTls],
    };
    await saveOutput(results, { outputDirectory });
    expect(readdirSync(outputDirectory).toSorted()).toEqual([
      'aggregate.csv',
      'aggregate.json',
      'failure.csv',
      'samples',
      'smtp_tls.csv',
      'smtp_tls.json',
    ]);
    expect(
      readFileSync(path.join(outputDirectory, 'aggregate.csv'), 'utf-8'),
    ).toBe(parsedAggregateReportsToCsv([aggregate]));
    expect(
      readFileSync(path.join(outputDirectory, 'failure.csv'), 'utf-8'),
    ).toBe(parsedFailureReportsToCsv([]));
    expect(
      readFileSync(path.join(outputDirectory, 'smtp_tls.csv'), 'utf-8'),
    ).toBe(parsedSmtpTlsReportsToCsv([smtpTls]));

    // A second save appends rows (without headers) and array items.
    await saveOutput(results, { outputDirectory });
    const csv = parsedAggregateReportsToCsv([aggregate]);
    const rows = csv.slice(csv.indexOf('\n') + 1);
    expect(
      readFileSync(path.join(outputDirectory, 'aggregate.csv'), 'utf-8'),
    ).toBe(csv + rows);
    expect(readJson(path.join(outputDirectory, 'smtp_tls.json'))).toHaveLength(
      2,
    );
  });

  it('uses the given file names', async () => {
    await saveOutput(
      {
        aggregateReports: [],
        failureReports: [failureReport('s')],
        smtpTlsReports: [],
      },
      {
        outputDirectory,
        aggregateCsvFilename: 'a.csv',
        failureJsonFilename: 'f.json',
        failureCsvFilename: 'f.csv',
        smtpTlsCsvFilename: 's.csv',
      },
    );
    expect(readdirSync(outputDirectory).toSorted()).toEqual([
      'a.csv',
      'f.csv',
      'f.json',
      's.csv',
      'samples',
    ]);
  });

  it('raises ValueError when the output path is a file', async () => {
    const filePath = tempPath('a-file');
    writeFileSync(filePath, '');
    await expect(
      saveOutput(
        { aggregateReports: [], failureReports: [], smtpTlsReports: [] },
        { outputDirectory: filePath },
      ),
    ).rejects.toMatchObject({
      name: 'ValueError',
      message: `${filePath} is not a directory`,
    });
  });

  it('expands ~ in the output directory', async () => {
    vi.stubEnv('HOME', tempRoot);
    await saveOutput(
      { aggregateReports: [], failureReports: [], smtpTlsReports: [] },
      { outputDirectory: '~/reports' },
    );
    expect(
      statSync(path.join(tempRoot, 'reports', 'samples')).isDirectory(),
    ).toBe(true);
  });
});

interface ZipEntryInfo {
  name: string;
  method: number;
  madeBy: number;
  externalAttr: number;
}

/** The central directory of a zip file. */
function zipEntries(zip: Uint8Array): ZipEntryInfo[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (view.getUint32(end, true) !== 0x06_05_4b_50) {
    end -= 1;
  }
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries: ZipEntryInfo[] = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      madeBy: view.getUint16(offset + 4, true),
      method: view.getUint16(offset + 10, true),
      externalAttr: view.getUint32(offset + 38, true),
      name: Buffer.from(
        zip.subarray(offset + 46, offset + 46 + nameLength),
      ).toString('utf-8'),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('getReportZip', () => {
  const linkedin = 'failure/dmarc_ruf_report_linkedin.eml';
  const subject = 'Subject line, could be UTF8 encoded';

  it("has parsedmarc's layout without the ../ copies of the samples", async () => {
    const report = fixtureReport<FailureReport>(linkedin);
    const zip = await getReportZip({
      aggregateReports: [],
      failureReports: [report, report],
      smtpTlsReports: [],
    });
    const entries = zipEntries(zip);
    // Recorded from parsedmarc 11.0.5's get_report_zip() (the order of
    // files within a directory follows the file system, as os.walk does),
    // minus its `../<name>` copies of the samples, which are left out on
    // purpose (path traversal on extraction).
    expect(entries.map(entry => entry.name).toSorted()).toEqual(
      [
        'aggregate.csv',
        'failure.csv',
        'failure.json',
        'smtp_tls.csv',
        'samples/',
        `samples/${subject} (1).eml`,
        `samples/${subject}.eml`,
      ].toSorted(),
    );
    // Top-level files first, then the directory and its files, as os.walk
    // visits them. No entry points outside the extraction directory.
    const names = entries.map(entry => entry.name);
    expect(names.slice(0, 4).toSorted()).toEqual([
      'aggregate.csv',
      'failure.csv',
      'failure.json',
      'smtp_tls.csv',
    ]);
    expect(names[4]).toBe('samples/');
    expect(names.slice(5).every(name => name.startsWith('samples/'))).toBe(
      true,
    );
    expect(names.some(name => name.startsWith('..'))).toBe(false);

    for (const entry of entries) {
      // Made by Unix, zip 2.0; Unix mode in the high 16 bits.
      expect(entry.madeBy).toBe(0x03_14);
      if (entry.name === 'samples/') {
        expect(entry.method).toBe(0);
        expect(entry.externalAttr & 0x10).toBe(0x10);
        expect((entry.externalAttr >>> 16) & 0o170_000).toBe(0o040_000);
      } else {
        expect(entry.method).toBe(8);
        expect((entry.externalAttr >>> 16) & 0o170_000).toBe(0o100_000);
      }
    }

    const files = unzipSync(zip);
    const fixture = loadFixture(linkedin);
    expect(
      JSON.parse(Buffer.from(files['failure.json'] ?? []).toString()),
    ).toEqual([fixture.result?.report, fixture.result?.report]);
    expect(Buffer.from(files['failure.csv'] ?? []).toString()).toBe(
      parsedFailureReportsToCsv([report, report]),
    );
    expect(Buffer.from(files[`samples/${subject}.eml`] ?? []).toString()).toBe(
      report.sample,
    );
    expect(
      Buffer.from(files[`samples/${subject} (1).eml`] ?? []).toString(),
    ).toBe(report.sample);
    expect(files['aggregate.json']).toBeUndefined();
  });

  it('removes its temporary directory', async () => {
    const before = new Set(readdirSync(tmpdir()));
    await getReportZip({
      aggregateReports: [],
      failureReports: [],
      smtpTlsReports: [],
    });
    const created = readdirSync(tmpdir()).filter(
      name => !before.has(name) && name.startsWith('tmp'),
    );
    expect(created).toEqual([]);
  });

  it('works for empty results: headers only', async () => {
    const files = unzipSync(
      await getReportZip({
        aggregateReports: [],
        failureReports: [],
        smtpTlsReports: [],
      }),
    );
    expect(Object.keys(files).toSorted()).toEqual([
      'aggregate.csv',
      'failure.csv',
      'samples/',
      'smtp_tls.csv',
    ]);
  });
});

describe('integers beyond 2^53', () => {
  // Python ints are unbounded: parsedmarc writes a huge count exactly in
  // its JSON and CSV output, and keeps it exact when appending.
  const xml = readFileSync(
    samplePath('aggregate/!example.com!1538204542!1538463818.xml'),
    'utf8',
  ).replace('<count>1</count>', '<count>99999999999999999999</count>');

  it('writes and appends the JSON and CSV output exactly', async () => {
    const report = await parseAggregateReportXml(xml, { offline: true });
    expect(report.records[0]?.count).toBe(99_999_999_999_999_999_999n);
    await saveOutput(
      { aggregateReports: [report], failureReports: [], smtpTlsReports: [] },
      { outputDirectory: tempRoot },
    );
    await appendJson(tempPath('aggregate.json'), [report]);
    const json = readFileSync(tempPath('aggregate.json'), 'utf-8');
    expect(json.match(/"count": 99999999999999999999,/gu)).toHaveLength(2);
    expect(readFileSync(tempPath('aggregate.csv'), 'utf-8')).toContain(
      ',99999999999999999999,',
    );
  });
});
