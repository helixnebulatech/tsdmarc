// Port of the `_expand_file_path_args` tests of parsedmarc's
// tests/test_cli.py (class `Test`).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { captureLogs, WARNING } from 'tsdmarc';
import { afterEach, describe, expect, it } from 'vitest';

import { glob } from './glob';
import { expandFilePathArgs } from './paths';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-paths-'));
  tempDirs.push(dir);
  return dir;
}

function touch(...paths: string[]): void {
  for (const filePath of paths) {
    writeFileSync(filePath, 'x');
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sorted = (values: string[]): string[] => [...values].sort();

function warnings(action: () => string[]): {
  result: string[];
  output: string[];
} {
  const logs = captureLogs('tsdmarc', WARNING);
  try {
    const result = action();
    return { result, output: logs.output };
  } finally {
    logs.restore();
  }
}

describe('expandFilePathArgs', () => {
  it('test_expand_file_path_args_keeps_bracketed_filenames', () => {
    const d = tempDir();
    const bracket = path.join(d, '[Netease DMARC Failure Report] Rent.eml');
    const plain = path.join(d, 'report.eml');
    touch(bracket, plain);

    // Sanity: raw glob drops the bracketed path (documents the bug).
    expect(glob(bracket)).toEqual([]);
    // The literal bracketed path is preserved as-is.
    expect(expandFilePathArgs([bracket])).toEqual([bracket]);
    // Wildcards (non-existent as literal paths) still expand.
    expect(sorted(expandFilePathArgs([path.join(d, '*.eml')]))).toEqual(
      sorted([bracket, plain]),
    );
  });

  it('test_expand_file_path_args_directory', () => {
    const d = tempDir();
    mkdirSync(path.join(d, 'sub'));
    const aXml = path.join(d, 'a.xml');
    const bEml = path.join(d, 'b.eml');
    const cXml = path.join(d, 'sub', 'c.xml');
    const hidden = path.join(d, '.hidden');
    touch(aXml, bEml, cXml, hidden);

    const result = expandFilePathArgs([d]);
    expect(sorted(result)).toEqual(sorted([aXml, bEml]));
    expect(result).not.toContain(path.join(d, 'sub'));
    expect(result).not.toContain(cXml);
    expect(result).not.toContain(hidden);

    // A trailing separator on the directory argument behaves the same.
    const trailing = expandFilePathArgs([d + path.sep]);
    expect(sorted(trailing.map(p => path.basename(p)))).toEqual(
      sorted(result.map(p => path.basename(p))),
    );
  });

  it('test_expand_file_path_args_directory_recursive', () => {
    const d = tempDir();
    mkdirSync(path.join(d, 'sub'));
    mkdirSync(path.join(d, '.hiddendir'));
    const aXml = path.join(d, 'a.xml');
    const bEml = path.join(d, 'b.eml');
    const cXml = path.join(d, 'sub', 'c.xml');
    const hidden = path.join(d, '.hidden');
    const hiddenDirFile = path.join(d, '.hiddendir', 'd.xml');
    touch(aXml, bEml, cXml, hidden, hiddenDirFile);

    const result = expandFilePathArgs([d], true);
    expect(sorted(result)).toEqual(sorted([aXml, bEml, cXml]));
    expect(result).not.toContain(d);
    expect(result).not.toContain(path.join(d, 'sub'));
    expect(result).not.toContain(hidden);
    expect(result).not.toContain(hiddenDirFile);
  });

  it('test_expand_file_path_args_directory_with_glob_metacharacters', () => {
    const d = tempDir();
    const bracketDir = path.join(d, 'reports [2024]');
    mkdirSync(bracketDir);
    const report = path.join(bracketDir, 'report.xml');
    touch(report);

    expect(expandFilePathArgs([bracketDir])).toEqual([report]);
    expect(expandFilePathArgs([bracketDir], true)).toEqual([report]);
  });

  it('test_expand_file_path_args_recursive_glob_pattern', () => {
    const d = tempDir();
    mkdirSync(path.join(d, 'sub'));
    const topXml = path.join(d, 'x.xml');
    const nestedXml = path.join(d, 'sub', 'y.xml');
    touch(topXml, nestedXml);

    const pattern = path.join(d, '**', '*.xml');
    expect(sorted(expandFilePathArgs([pattern], true))).toEqual(
      sorted([topXml, nestedXml]),
    );
    // Without recursive, '**' matches a single path component.
    expect(expandFilePathArgs([pattern])).toEqual([nestedXml]);
  });

  it('test_expand_file_path_args_warns_on_nonexistent_path', () => {
    const missing = path.join(tempDir(), 'nonexistent.xml');
    const { result, output } = warnings(() => expandFilePathArgs([missing]));
    expect(result).toEqual([]);
    expect(output.some(line => line.includes(missing))).toBe(true);
  });

  it('test_expand_file_path_args_no_warning_for_matching_path', () => {
    const d = tempDir();
    const report = path.join(d, 'report.xml');
    touch(report);

    let logged = warnings(() => expandFilePathArgs([report]));
    expect(logged.output).toEqual([]);
    expect(logged.result).toEqual([report]);

    logged = warnings(() => expandFilePathArgs([path.join(d, '*.xml')]));
    expect(logged.output).toEqual([]);
    expect(logged.result).toEqual([report]);
  });

  it('test_expand_file_path_args_empty_list_is_silent', () => {
    const { result, output } = warnings(() => expandFilePathArgs([]));
    expect(output).toEqual([]);
    expect(result).toEqual([]);
  });

  it('test_expand_file_path_args_mixed_warns_only_for_unmatched', () => {
    const d = tempDir();
    const report = path.join(d, 'report.xml');
    touch(report);
    const missing = path.join(d, 'nonexistent.xml');

    const { result, output } = warnings(() =>
      expandFilePathArgs([report, missing]),
    );
    expect(result).toEqual([report]);
    const warningLines = output.filter(line => line.includes('WARNING'));
    expect(warningLines).toHaveLength(1);
    expect(warningLines[0]).toContain(missing);
    expect(warningLines[0]).not.toContain(report);
  });
});
