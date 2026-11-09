// Port of parsedmarc's tests/test_cli.py `TestArchiveDirectory`: end-to-end
// coverage of `[general] archive_directory`, running the real `main()`
// against on-disk sample reports (there is no SDK boundary to mock here).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IMAPConnection } from '@tsdmarc/imap';
import { logger, parseReportFile, SEEN_AGGREGATE_REPORT_IDS } from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { archiveSubdirForResult } from './archive';
import { SystemExit } from './errors';
import { main } from './main';

const SAMPLES = fileURLToPath(new URL('../../../samples/', import.meta.url));
const AGGREGATE_SAMPLE_1 = path.join(
  SAMPLES,
  'aggregate/!example.com!1538204542!1538463818.xml',
);
const AGGREGATE_SAMPLE_2 = path.join(
  SAMPLES,
  'aggregate/!large-example.com!1711897200!1711983600.xml',
);
// Not dmarc_ruf_report_linkedin.eml: it starts with an mbox "From " line,
// so it is classified as an mbox (never archived).
const FAILURE_SAMPLE = path.join(
  SAMPLES,
  'failure/DMARC Failure Report for domain.de (mail-from=sharepoint@domain.de, ip=10.10.10.10).eml',
);
const SMTP_TLS_SAMPLE = path.join(SAMPLES, 'smtp_tls/rfc8460.json');

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function copySample(
  src: string,
  destDir: string,
  destBasename?: string,
): string {
  const dest = path.join(destDir, destBasename ?? path.basename(src));
  copyFileSync(src, dest);
  return dest;
}

/** The subdirectory the CLI computes for a sample, parsed the same way. */
async function expectedSubdir(samplePath: string): Promise<string> {
  const result = await parseReportFile(samplePath, { offline: true });
  const subdir = archiveSubdirForResult(result);
  expect(subdir).not.toBeNull();
  return subdir as string;
}

function writeConfig(
  tmpDir: string,
  outputDirname: string,
  archiveDirname: string | null = null,
  nProcs: number | null = null,
): { cfgPath: string; outputDir: string; archiveDir: string | null } {
  const cfgPath = path.join(tmpDir, 'parsedmarc.ini');
  const outputDir = path.join(tmpDir, outputDirname);
  let configText = `[general]\noffline = True\nsilent = True\noutput = ${outputDir}\n`;
  let archiveDir: string | null = null;
  if (archiveDirname !== null) {
    archiveDir = path.join(tmpDir, archiveDirname);
    configText += `archive_directory = ${archiveDir}\n`;
  }
  if (nProcs !== null) {
    configText += `n_procs = ${nProcs}\n`;
  }
  writeFileSync(cfgPath, configText);
  return { cfgPath, outputDir, archiveDir };
}

function archiveTree(archiveDir: string): Map<string, string> {
  const tree = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        tree.set(path.relative(archiveDir, full), readFileSync(full, 'latin1'));
      }
    }
  };
  walk(archiveDir);
  return tree;
}

// Worker-thread parsing can be slow when the machine is busy.
describe('TestArchiveDirectory', () => {
  let tmpDir: string;
  let inputDir: string;

  beforeEach(() => {
    SEEN_AGGREGATE_REPORT_IDS.clear();
    logger.disabled = true;
    tmpDir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-archive-'));
    inputDir = path.join(tmpDir, 'input');
    mkdirSync(inputDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function expectAllArchived(
    archiveDir: string,
    files: [string, string][],
  ): Promise<void> {
    for (const [src, samplePath] of files) {
      const subdir = await expectedSubdir(samplePath);
      const dest = path.join(archiveDir, subdir, path.basename(src));
      expect(isFile(dest), `missing ${dest}`).toBe(true);
      expect(isFile(src)).toBe(false);
    }
  }

  it('test_archive_moves_all_three_types', async () => {
    const agg1 = copySample(AGGREGATE_SAMPLE_1, inputDir);
    const agg2 = copySample(AGGREGATE_SAMPLE_2, inputDir);
    const failure = copySample(FAILURE_SAMPLE, inputDir);
    const smtpTls = copySample(SMTP_TLS_SAMPLE, inputDir);
    const { cfgPath, outputDir, archiveDir } = writeConfig(
      tmpDir,
      'output',
      'archive',
    );

    await main(['-c', cfgPath, inputDir]);

    await expectAllArchived(archiveDir as string, [
      [agg1, AGGREGATE_SAMPLE_1],
      [agg2, AGGREGATE_SAMPLE_2],
      [failure, FAILURE_SAMPLE],
      [smtpTls, SMTP_TLS_SAMPLE],
    ]);
    expect(isFile(path.join(outputDir, 'aggregate.json'))).toBe(true);
  });

  it('test_failed_parse_moved_to_invalid', async () => {
    const garbagePath = path.join(inputDir, 'garbage.xml');
    writeFileSync(garbagePath, 'not a report');
    const { cfgPath, archiveDir } = writeConfig(tmpDir, 'output', 'archive');

    await main(['-c', cfgPath, inputDir]);

    expect(
      isFile(path.join(archiveDir as string, 'Invalid', 'garbage.xml')),
    ).toBe(true);
    expect(isFile(garbagePath)).toBe(false);
  });

  it('test_collision_appends_numeric_suffix', async () => {
    const src = copySample(AGGREGATE_SAMPLE_1, inputDir);
    const { cfgPath, archiveDir } = writeConfig(tmpDir, 'output', 'archive');
    const subdir = await expectedSubdir(AGGREGATE_SAMPLE_1);
    const destDir = path.join(archiveDir as string, subdir);
    mkdirSync(destDir, { recursive: true });
    const basename = path.basename(src);
    const preexistingPath = path.join(destDir, basename);
    writeFileSync(preexistingPath, 'PREEXISTING DUMMY CONTENT');

    await main(['-c', cfgPath, inputDir]);

    expect(readFileSync(preexistingPath, 'utf8')).toBe(
      'PREEXISTING DUMMY CONTENT',
    );
    const ext = path.extname(basename);
    const base = basename.slice(0, -ext.length);
    expect(isFile(path.join(destDir, `${base}-1${ext}`))).toBe(true);
    expect(isFile(src)).toBe(false);
  });

  it('test_second_run_skips_archived_files', async () => {
    copySample(AGGREGATE_SAMPLE_1, inputDir);
    copySample(FAILURE_SAMPLE, inputDir);
    copySample(SMTP_TLS_SAMPLE, inputDir);
    const archiveDir = path.join(inputDir, 'archive');
    const outputDir = path.join(tmpDir, 'output');
    const cfgPath = path.join(tmpDir, 'parsedmarc.ini');
    writeFileSync(
      cfgPath,
      '[general]\noffline = True\nsilent = True\n' +
        `output = ${outputDir}\narchive_directory = ${archiveDir}\n`,
    );

    await main(['-c', cfgPath, '-r', inputDir]);
    const firstRunTree = archiveTree(archiveDir);
    expect(firstRunTree.size).toBe(3);

    // Dedup must not be what keeps the archived files from being re-parsed.
    SEEN_AGGREGATE_REPORT_IDS.clear();

    await main(['-c', cfgPath, '-r', inputDir]);
    const secondRunTree = archiveTree(archiveDir);
    expect(secondRunTree).toEqual(firstRunTree);
    for (const rel of secondRunTree.keys()) {
      expect(path.basename(rel)).not.toContain('-1');
    }
  });

  it('test_archive_with_n_procs_2', async () => {
    const agg1 = copySample(AGGREGATE_SAMPLE_1, inputDir);
    const agg2 = copySample(AGGREGATE_SAMPLE_2, inputDir);
    const failure = copySample(FAILURE_SAMPLE, inputDir);
    const smtpTls = copySample(SMTP_TLS_SAMPLE, inputDir);
    const { cfgPath, outputDir, archiveDir } = writeConfig(
      tmpDir,
      'output',
      'archive',
      2,
    );

    await main(['-c', cfgPath, inputDir]);

    await expectAllArchived(archiveDir as string, [
      [agg1, AGGREGATE_SAMPLE_1],
      [agg2, AGGREGATE_SAMPLE_2],
      [failure, FAILURE_SAMPLE],
      [smtpTls, SMTP_TLS_SAMPLE],
    ]);
    expect(isFile(path.join(outputDir, 'aggregate.json'))).toBe(true);
  });

  async function runWithBrokenOutput(
    extra: string,
    inputs: string[],
  ): Promise<string> {
    const archiveDir = path.join(tmpDir, 'archive');
    const brokenOutput = path.join(tmpDir, 'not-a-directory');
    writeFileSync(brokenOutput, '');
    const configPath = path.join(tmpDir, 'config.ini');
    writeFileSync(
      configPath,
      `[general]
silent = true
offline = true
archive_directory = ${archiveDir}
output = ${brokenOutput}
${extra}`,
    );
    await main(['-c', configPath, ...inputs]).catch((error: unknown) => {
      if (!(error instanceof SystemExit)) {
        throw error;
      }
    });
    return archiveDir;
  }

  it('leaves a parsed file in place when its reports were not saved', async () => {
    const source = copySample(SMTP_TLS_SAMPLE, inputDir);

    const archiveDir = await runWithBrokenOutput('', [source]);

    expect(isFile(source)).toBe(true);
    expect(isDirectory(archiveDir)).toBe(false);
  });

  it('leaves a parsed file in place with fail_on_output_error', async () => {
    const source = copySample(SMTP_TLS_SAMPLE, inputDir);

    await runWithBrokenOutput('fail_on_output_error = true\n', [source]);

    expect(isFile(source)).toBe(true);
  });

  it('saves and archives a file left in place once the output works again', async () => {
    const src = copySample(AGGREGATE_SAMPLE_1, inputDir);
    const { cfgPath, outputDir, archiveDir } = writeConfig(
      tmpDir,
      'out',
      'archive',
    );
    writeFileSync(outputDir, 'not a directory');

    await main(['-c', cfgPath, src]);

    expect(isFile(src)).toBe(true);
    expect(existsSync(archiveDir as string)).toBe(false);

    rmSync(outputDir);
    SEEN_AGGREGATE_REPORT_IDS.clear();
    await main(['-c', cfgPath, src]);

    await expectAllArchived(archiveDir as string, [[src, AGGREGATE_SAMPLE_1]]);
    expect(isFile(path.join(outputDir, 'aggregate.json'))).toBe(true);
  });

  it('archives parsed files past an invalid file and a bad mbox message', async () => {
    const src = copySample(AGGREGATE_SAMPLE_1, inputDir);
    const invalid = path.join(inputDir, 'bad.xml');
    writeFileSync(invalid, 'not a report');
    const mbox = path.join(inputDir, 'bad.mbox');
    writeFileSync(
      mbox,
      'From x Thu Jan  1 00:00:00 2024\nFrom: a@b.c\nDate: not-a-date\nSubject: x\n\nbody\n\n',
    );
    const { cfgPath, outputDir, archiveDir } = writeConfig(
      tmpDir,
      'out',
      'archive',
    );

    await main(['-c', cfgPath, src, invalid, mbox]);

    await expectAllArchived(archiveDir as string, [[src, AGGREGATE_SAMPLE_1]]);
    expect(isFile(path.join(archiveDir as string, 'Invalid', 'bad.xml'))).toBe(
      true,
    );
    expect(isFile(mbox)).toBe(true);
    expect(isFile(path.join(outputDir, 'aggregate.json'))).toBe(true);
  });

  it('still moves an invalid file when the reports were not saved', async () => {
    const invalid = path.join(inputDir, 'invalid.xml');
    writeFileSync(invalid, 'not a report');

    const archiveDir = await runWithBrokenOutput('', [invalid]);

    expect(isFile(path.join(archiveDir, 'Invalid', 'invalid.xml'))).toBe(true);
  });

  it('leaves a parsed file in place when the mailbox connection fails', async () => {
    const source = copySample(SMTP_TLS_SAMPLE, inputDir);
    const archiveDir = path.join(tmpDir, 'archive');
    vi.spyOn(IMAPConnection, 'connect').mockRejectedValue(new Error('down'));
    const configPath = path.join(tmpDir, 'config.ini');
    writeFileSync(
      configPath,
      `[general]
silent = true
offline = true
archive_directory = ${archiveDir}

[imap]
host = imap.example.com
user = user
password = password
`,
    );

    await expect(main(['-c', configPath, source])).rejects.toMatchObject({
      code: 1,
    });

    expect(isFile(source)).toBe(true);
  });

  it('test_no_archive_when_option_unset', async () => {
    const agg1 = copySample(AGGREGATE_SAMPLE_1, inputDir);
    const { cfgPath, archiveDir } = writeConfig(tmpDir, 'output');
    expect(archiveDir).toBeNull();

    await main(['-c', cfgPath, inputDir]);

    expect(isFile(agg1)).toBe(true);
    expect(isDirectory(path.join(tmpDir, 'archive'))).toBe(false);
    expect(existsSync(path.join(inputDir, 'archive'))).toBe(false);
  });

  it('test_duplicate_aggregate_reports_both_archived', async () => {
    const copy1 = copySample(AGGREGATE_SAMPLE_1, inputDir, 'copy-a.xml');
    const copy2 = copySample(AGGREGATE_SAMPLE_1, inputDir, 'copy-b.xml');
    const { cfgPath, outputDir, archiveDir } = writeConfig(
      tmpDir,
      'output',
      'archive',
    );

    await main(['-c', cfgPath, inputDir]);

    const reports = JSON.parse(
      readFileSync(path.join(outputDir, 'aggregate.json'), 'utf8'),
    ) as unknown[];
    expect(reports).toHaveLength(1);
    const subdir = await expectedSubdir(AGGREGATE_SAMPLE_1);
    expect(isFile(path.join(archiveDir as string, subdir, 'copy-a.xml'))).toBe(
      true,
    );
    expect(isFile(path.join(archiveDir as string, subdir, 'copy-b.xml'))).toBe(
      true,
    );
    expect(isFile(copy1)).toBe(false);
    expect(isFile(copy2)).toBe(false);
  });
});
