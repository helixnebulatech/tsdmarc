// Port of parsedmarc's TestArchiveSubdirForResult, TestExcludeArchivedPaths,
// TestMoveFileToArchive and TestArchiveProcessedFile (tests/test_cli.py).

import type * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { captureLogs, type ParsedReport, ParserError } from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  archiveProcessedFile,
  archiveSubdirForResult,
  moveFileToArchive,
} from './archive';
import { excludeArchivedPaths } from './paths';

// shutil.move / os.remove are patched in the Python tests; here the fs
// calls archive.ts makes are wrapped so a test can make them fail.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cli-archive-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function write(filePath: string, content: string): void {
  writeFileSync(filePath, content);
}

function asResult(value: unknown): ParsedReport {
  return value as ParsedReport;
}

describe('TestArchiveSubdirForResult', () => {
  it('test_aggregate_report_january_zero_pads_month', () => {
    expect(
      archiveSubdirForResult(
        asResult({
          reportType: 'aggregate',
          report: { reportMetadata: { beginDate: '2023-01-05 00:00:00' } },
        }),
      ),
    ).toBe(path.join('2023', '01', 'Aggregate'));
  });

  it('test_failure_report_january_zero_pads_month', () => {
    expect(
      archiveSubdirForResult(
        asResult({
          reportType: 'failure',
          report: { arrivalDateUtc: '2023-01-05 12:00:00' },
        }),
      ),
    ).toBe(path.join('2023', '01', 'Failure'));
  });

  it('test_smtp_tls_report_uses_hyphenated_folder_name', () => {
    expect(
      archiveSubdirForResult(
        asResult({
          reportType: 'smtp_tls',
          report: { beginDate: '2016-04-01T00:00:00Z' },
        }),
      ),
    ).toBe(path.join('2016', '04', 'SMTP-TLS'));
  });

  it('test_missing_date_key_returns_none', () => {
    const logs = captureLogs();
    try {
      expect(
        archiveSubdirForResult(
          asResult({ reportType: 'aggregate', report: { reportMetadata: {} } }),
        ),
      ).toBeNull();
    } finally {
      logs.restore();
    }
    expect(logs.output).toEqual([
      "WARNING:tsdmarc:Cannot determine archive date for aggregate report: 'begin_date'",
    ]);
  });

  it('test_unparseable_date_returns_none', () => {
    expect(
      archiveSubdirForResult(
        asResult({
          reportType: 'failure',
          report: { arrivalDateUtc: 'not-a-real-date' },
        }),
      ),
    ).toBeNull();
  });

  it('escapes line breaks of an unparseable date in the warning', () => {
    const logs = captureLogs();
    try {
      expect(
        archiveSubdirForResult(
          asResult({
            reportType: 'smtp_tls',
            report: { beginDate: 'x\n2026-01-01 - CRITICAL - forged' },
          }),
        ),
      ).toBeNull();
    } finally {
      logs.restore();
    }
    expect(logs.output).toEqual([
      'WARNING:tsdmarc:Cannot determine archive date for smtp_tls report: Unknown string format: x\\n2026-01-01 - CRITICAL - forged',
    ]);
  });

  it('test_unknown_report_type_returns_none', () => {
    const logs = captureLogs();
    try {
      expect(
        archiveSubdirForResult(asResult({ reportType: 'unknown', report: {} })),
      ).toBeNull();
    } finally {
      logs.restore();
    }
    expect(logs.output).toEqual([
      'WARNING:tsdmarc:Cannot archive unknown report type: unknown',
    ]);
  });
});

describe('TestExcludeArchivedPaths', () => {
  it('test_files_inside_archive_dir_are_excluded', () => {
    const archiveDir = path.join(tmpDir, 'archive');
    const nestedDir = path.join(archiveDir, '2024', '01', 'Aggregate');
    mkdirSync(nestedDir, { recursive: true });
    const insidePath = path.join(nestedDir, 'report.xml');
    write(insidePath, 'x');
    const outsidePath = path.join(tmpDir, 'report.xml');
    write(outsidePath, 'x');

    expect(excludeArchivedPaths([insidePath, outsidePath], archiveDir)).toEqual(
      [outsidePath],
    );
  });

  it('test_relative_paths_are_resolved_before_comparison', () => {
    const archiveDir = path.join(tmpDir, 'archive');
    mkdirSync(archiveDir);
    write(path.join(archiveDir, 'report.xml'), 'x');

    const cwd = process.cwd();
    let result: string[];
    try {
      process.chdir(tmpDir);
      result = excludeArchivedPaths(
        [path.join('archive', 'report.xml')],
        'archive',
      );
    } finally {
      process.chdir(cwd);
    }
    expect(result).toEqual([]);
  });

  it('test_files_outside_archive_dir_are_kept', () => {
    const archiveDir = path.join(tmpDir, 'archive');
    mkdirSync(archiveDir);
    const otherPath = path.join(tmpDir, 'elsewhere', 'report.xml');
    mkdirSync(path.dirname(otherPath));
    write(otherPath, 'x');

    expect(excludeArchivedPaths([otherPath], archiveDir)).toEqual([otherPath]);
  });

  it('test_symlinked_archive_dir_still_excludes_real_path', () => {
    const realArchiveDir = path.join(tmpDir, 'real_archive');
    mkdirSync(realArchiveDir);
    const symlinkedArchiveDir = path.join(tmpDir, 'archive_link');
    symlinkSync(realArchiveDir, symlinkedArchiveDir);
    const realFilePath = path.join(realArchiveDir, 'report.xml');
    write(realFilePath, 'x');

    expect(excludeArchivedPaths([realFilePath], symlinkedArchiveDir)).toEqual(
      [],
    );
  });

  it('keeps a sibling directory that only shares the name prefix', () => {
    // `archive2/` is not inside `archive/` (a plain string prefix test
    // would wrongly exclude it).
    const archiveDir = path.join(tmpDir, 'archive');
    mkdirSync(archiveDir);
    mkdirSync(path.join(tmpDir, 'archive2'));
    const siblingPath = path.join(tmpDir, 'archive2', 'report.xml');
    write(siblingPath, 'x');

    expect(excludeArchivedPaths([siblingPath], archiveDir)).toEqual([
      siblingPath,
    ]);
  });

  it('excludes the archive directory path itself and missing files inside it', () => {
    const archiveDir = path.join(tmpDir, 'archive');
    mkdirSync(archiveDir);
    expect(
      excludeArchivedPaths(
        [archiveDir, path.join(archiveDir, 'not-yet-there.xml')],
        archiveDir,
      ),
    ).toEqual([]);
  });

  it('test_non_comparable_paths_are_kept', () => {
    // Python simulates os.path.commonpath raising ValueError (different
    // Windows drives); here path.parse() reports a different root for the
    // report path, which isInside() treats as "not comparable". The report
    // sits under the archive directory so the test fails if that check is
    // dropped (a plain relative-path comparison would exclude it).
    const archiveDir = path.join(tmpDir, 'archive');
    mkdirSync(archiveDir);
    const reportPath = path.join(archiveDir, 'report.xml');
    write(reportPath, 'x');
    const realParse = path.parse;
    const parse = vi.spyOn(path, 'parse').mockImplementation(target => {
      const parsed = realParse(target);
      return target.endsWith('report.xml')
        ? { ...parsed, root: 'D:\\' }
        : parsed;
    });
    try {
      expect(excludeArchivedPaths([reportPath], archiveDir)).toEqual([
        reportPath,
      ]);
      expect(parse).toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});

describe('TestMoveFileToArchive', () => {
  it('test_no_collision_keeps_original_basename', () => {
    const srcDir = path.join(tmpDir, 'src');
    mkdirSync(srcDir);
    const srcPath = path.join(srcDir, 'report.xml');
    write(srcPath, 'content');
    const destDir = path.join(tmpDir, 'dest');

    const destPath = moveFileToArchive(srcPath, destDir);

    expect(destPath).toBe(path.join(destDir, 'report.xml'));
    expect(readFileSync(destPath, 'utf8')).toBe('content');
    expect(existsSync(srcPath)).toBe(false);
  });

  it('test_collision_appends_dash_one', () => {
    const srcDir = path.join(tmpDir, 'src');
    mkdirSync(srcDir);
    const srcPath = path.join(srcDir, 'report.xml');
    write(srcPath, 'new content');
    const destDir = path.join(tmpDir, 'dest');
    mkdirSync(destDir);
    const existingPath = path.join(destDir, 'report.xml');
    write(existingPath, 'original content');

    const destPath = moveFileToArchive(srcPath, destDir);

    expect(destPath).toBe(path.join(destDir, 'report-1.xml'));
    expect(readFileSync(existingPath, 'utf8')).toBe('original content');
    expect(readFileSync(destPath, 'utf8')).toBe('new content');
  });

  it('test_two_collisions_append_dash_two', () => {
    const srcDir = path.join(tmpDir, 'src');
    mkdirSync(srcDir);
    const srcPath = path.join(srcDir, 'report.xml');
    write(srcPath, 'newest content');
    const destDir = path.join(tmpDir, 'dest');
    mkdirSync(destDir);
    for (const name of ['report.xml', 'report-1.xml']) {
      write(path.join(destDir, name), `original ${name}`);
    }

    const destPath = moveFileToArchive(srcPath, destDir);

    expect(destPath).toBe(path.join(destDir, 'report-2.xml'));
    expect(readFileSync(path.join(destDir, 'report.xml'), 'utf8')).toBe(
      'original report.xml',
    );
    expect(readFileSync(path.join(destDir, 'report-1.xml'), 'utf8')).toBe(
      'original report-1.xml',
    );
  });

  it('puts the numeric suffix before the last extension only', () => {
    const srcPath = path.join(tmpDir, 'report.xml.gz');
    write(srcPath, 'gz');
    const destDir = path.join(tmpDir, 'dest');
    mkdirSync(destDir);
    write(path.join(destDir, 'report.xml.gz'), 'old');

    expect(moveFileToArchive(srcPath, destDir)).toBe(
      path.join(destDir, 'report.xml-1.gz'),
    );
  });

  it('test_failed_move_reraises_even_when_placeholder_cleanup_fails', () => {
    const srcPath = path.join(tmpDir, 'report.xml');
    write(srcPath, 'content');
    const destDir = path.join(tmpDir, 'dest');

    // A non-filesystem error from the move, so the assertion proves which
    // of the two errors escaped.
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new RangeError('move failed');
    });
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('remove failed'), { code: 'EACCES' });
    });

    expect(() => moveFileToArchive(srcPath, destDir)).toThrow(RangeError);

    // The source is untouched and the zero-byte placeholder survives its
    // failed cleanup, never executable or group/other-accessible.
    expect(statSync(srcPath).isFile()).toBe(true);
    const placeholder = path.join(destDir, 'report.xml');
    expect(statSync(placeholder).isFile()).toBe(true);
    expect(statSync(placeholder).size).toBe(0);
    expect(statSync(placeholder).mode & 0o177).toBe(0);
  });

  it('removes the placeholder when the move fails', () => {
    const srcPath = path.join(tmpDir, 'report.xml');
    write(srcPath, 'content');
    const destDir = path.join(tmpDir, 'dest');
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    });

    expect(() => moveFileToArchive(srcPath, destDir)).toThrow('EIO');
    expect(existsSync(path.join(destDir, 'report.xml'))).toBe(false);
    expect(existsSync(srcPath)).toBe(true);
  });

  it('copies and unlinks across devices (EXDEV)', () => {
    const srcPath = path.join(tmpDir, 'report.xml');
    write(srcPath, 'cross-device');
    const destDir = path.join(tmpDir, 'dest');
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EXDEV: cross-device link'), {
        code: 'EXDEV',
      });
    });

    const destPath = moveFileToArchive(srcPath, destDir);

    expect(readFileSync(destPath, 'utf8')).toBe('cross-device');
    expect(existsSync(srcPath)).toBe(false);
  });
});

describe('TestArchiveProcessedFile', () => {
  it('test_exception_result_routes_to_invalid', () => {
    const srcPath = path.join(tmpDir, 'garbage.xml');
    write(srcPath, 'not a report');
    const archiveDir = path.join(tmpDir, 'archive');

    archiveProcessedFile(srcPath, archiveDir, new ParserError('boom'));

    expect(
      statSync(path.join(archiveDir, 'Invalid', 'garbage.xml')).isFile(),
    ).toBe(true);
  });

  it('archives a parsed report under its dated subdirectory', () => {
    const srcPath = path.join(tmpDir, 'report.xml');
    write(srcPath, '<feedback/>');
    const archiveDir = path.join(tmpDir, 'archive');

    archiveProcessedFile(
      srcPath,
      archiveDir,
      asResult({
        reportType: 'aggregate',
        report: { reportMetadata: { beginDate: '2024-03-01 00:00:00' } },
      }),
    );

    expect(
      statSync(
        path.join(archiveDir, '2024', '03', 'Aggregate', 'report.xml'),
      ).isFile(),
    ).toBe(true);
    expect(existsSync(srcPath)).toBe(false);
  });

  it('test_move_failure_is_logged_and_does_not_raise', () => {
    const srcPath = path.join(tmpDir, 'garbage.xml');
    write(srcPath, 'not a report');
    const archiveDir = path.join(tmpDir, 'archive');
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC: disk full'), { code: 'ENOSPC' });
    });

    const logs = captureLogs();
    try {
      archiveProcessedFile(srcPath, archiveDir, new ParserError('boom'));
    } finally {
      logs.restore();
    }

    expect(
      logs.records.some(
        record =>
          record.levelName === 'ERROR' &&
          record.message.includes('Error moving'),
      ),
    ).toBe(true);
    // The move never completed, so the source file is untouched.
    expect(statSync(srcPath).isFile()).toBe(true);
  });

  it('test_unresolvable_subdir_leaves_file_in_place', () => {
    const srcPath = path.join(tmpDir, 'report.json');
    write(srcPath, '{}');
    const archiveDir = path.join(tmpDir, 'archive');

    archiveProcessedFile(
      srcPath,
      archiveDir,
      asResult({ reportType: 'unknown', report: {} }),
    );

    expect(statSync(srcPath).isFile()).toBe(true);
  });

  it('test_non_parser_error_leaves_file_in_place', () => {
    const srcPath = path.join(tmpDir, 'report.xml');
    write(srcPath, '<xml></xml>');
    const archiveDir = path.join(tmpDir, 'archive');

    archiveProcessedFile(
      srcPath,
      archiveDir,
      Object.assign(new Error('transient'), { code: 'EACCES' }),
    );

    expect(statSync(srcPath).isFile()).toBe(true);
    expect(existsSync(archiveDir)).toBe(false);
  });
});

describe('log lines built from reports and file names', () => {
  it('escapes a line break in the path of a file that stays or fails to move', () => {
    const logs = captureLogs();
    const source = path.join(tmpDir, 'a\nFAKE.xml');
    try {
      archiveProcessedFile(
        source,
        path.join(tmpDir, 'archive'),
        new Error('x'),
      );
      // The source doesn't exist: the move fails.
      archiveProcessedFile(
        source,
        path.join(tmpDir, 'archive'),
        new ParserError('x'),
      );
    } finally {
      logs.restore();
    }
    expect(logs.records.length).toBeGreaterThan(0);
    for (const record of logs.records) {
      expect(record.message).not.toContain('\n');
    }
  });
});
