// Port of parsedmarc's tests/test_cli.py: the `_main()` tests of class
// `Test` and class `TestDirectoryFilePaths`.

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as elastic from '@tsdmarc/elasticsearch';
import { IMAPConnection } from '@tsdmarc/imap';
import * as opensearch from '@tsdmarc/opensearch';
import {
  captureLogs,
  getDmarcReportsFromMbox,
  InvalidIPinfoAPIKey,
  logger,
  type MailboxConnection,
  parseReportFile,
  ParserError,
  type ParsingResults,
  SEEN_AGGREGATE_REPORT_IDS,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from './core';
import { main } from './main';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TOP_LEVEL_SAMPLE = path.join(
  REPO_ROOT,
  'samples/aggregate/!example.com!1538204542!1538463818.xml',
);
const NESTED_SAMPLE = path.join(
  REPO_ROOT,
  'samples/aggregate/!large-example.com!1711897200!1711983600.xml',
);

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-main-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(content: string): string {
  const configPath = path.join(tempDir(), 'tsdmarc.ini');
  writeFileSync(configPath, content);
  return configPath;
}

/**
 * A `getDmarcReportsFromMailbox` implementation that honors the real
 * contract: the fetched batch goes to `saveCallback` before the function
 * returns the accumulated results.
 */
function fetchInvokingSaveCallback(
  reports: ParsingResults,
): typeof core.getDmarcReportsFromMailbox {
  return async (_connection, options) => {
    await options.saveCallback?.(reports);
    return reports;
  };
}

function fakeImapConnection(): IMAPConnection {
  return { close: vi.fn(async () => undefined) } as unknown as IMAPConnection;
}

function fakeSearchClient(): never {
  return { close: vi.fn(async () => undefined) } as never;
}

beforeEach(() => {
  // The CLI's console handler would write every record to stderr.
  logger.disabled = true;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const IMAP_CONFIG = `[imap]
host = imap.example.com
user = test-user
password = test-password
`;

describe('main() (class Test)', () => {
  it('runs a one-shot IMAP fetch and closes the connection', async () => {
    const connection = fakeImapConnection();
    const connect = vi
      .spyOn(IMAPConnection, 'connect')
      .mockResolvedValue(connection);
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: [],
      failureReports: [],
      smtpTlsReports: [],
    });
    const configPath = writeConfig(
      `[general]\nsilent = true\noffline = true\n${IMAP_CONFIG}`,
    );

    await main(['-c', configPath]);

    expect(connect).toHaveBeenCalledWith(
      'imap.example.com',
      'test-user',
      expect.objectContaining({
        password: 'test-password',
        port: 993,
        ssl: true,
        verify: true,
      }),
    );
    expect(vi.mocked(core.getDmarcReportsFromMailbox).mock.calls[0]?.[0]).toBe(
      connection as unknown as MailboxConnection,
    );
    expect(connection.close).toHaveBeenCalled();
  });

  it('exits 1 without input files or a mailbox', async () => {
    await expect(main([])).rejects.toMatchObject({ code: 1 });
  });

  it('testCliPassesOpenSearchSigV4Settings', async () => {
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue(fakeImapConnection());
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue({
      aggregateReports: [],
      failureReports: [],
      smtpTlsReports: [],
    });
    vi.mocked(opensearch.setHosts).mockResolvedValue(fakeSearchClient());
    vi.mocked(opensearch.migrateIndexes).mockResolvedValue();
    const configPath = writeConfig(`[general]
save_aggregate = true
silent = true
offline = true

${IMAP_CONFIG}
[opensearch]
hosts = localhost
authentication_type = awssigv4
aws_region = eu-west-1
aws_service = aoss
`);

    await main(['-c', configPath]);

    const options = vi.mocked(opensearch.setHosts).mock.calls[0]?.[1];
    expect(options?.authType).toBe('awssigv4');
    expect(options?.awsRegion).toBe('eu-west-1');
    expect(options?.awsService).toBe('aoss');
  });

  it('testFailOnOutputErrorExits', async () => {
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue(fakeImapConnection());
    vi.mocked(core.getDmarcReportsFromMailbox).mockImplementation(
      fetchInvokingSaveCallback({
        aggregateReports: [{ policyPublished: { domain: 'example.com' } }],
        failureReports: [],
        smtpTlsReports: [],
      } as unknown as ParsingResults),
    );
    vi.mocked(elastic.setHosts).mockResolvedValue(fakeSearchClient());
    vi.mocked(elastic.migrateIndexes).mockResolvedValue();
    vi.mocked(elastic.saveAggregateReportToElasticsearch).mockRejectedValue(
      new elastic.ElasticsearchError('simulated output failure'),
    );
    const configPath = writeConfig(`[general]
save_aggregate = true
fail_on_output_error = true
silent = true
offline = true

${IMAP_CONFIG}
[elasticsearch]
hosts = localhost
`);

    await expect(main(['-c', configPath])).rejects.toMatchObject({ code: 1 });
    expect(elastic.saveAggregateReportToElasticsearch).toHaveBeenCalledOnce();
  });

  it('testOutputErrorDoesNotExitWhenDisabled', async () => {
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue(fakeImapConnection());
    vi.mocked(core.getDmarcReportsFromMailbox).mockImplementation(
      fetchInvokingSaveCallback({
        aggregateReports: [{ policyPublished: { domain: 'example.com' } }],
        failureReports: [],
        smtpTlsReports: [],
      } as unknown as ParsingResults),
    );
    vi.mocked(elastic.setHosts).mockResolvedValue(fakeSearchClient());
    vi.mocked(elastic.migrateIndexes).mockResolvedValue();
    vi.mocked(elastic.saveAggregateReportToElasticsearch).mockRejectedValue(
      new elastic.ElasticsearchError('simulated output failure'),
    );
    const configPath = writeConfig(`[general]
save_aggregate = true
fail_on_output_error = false
silent = true
offline = true

${IMAP_CONFIG}
[elasticsearch]
hosts = localhost
`);

    await main(['-c', configPath]);
    expect(elastic.saveAggregateReportToElasticsearch).toHaveBeenCalledOnce();
  });

  it('testFailOnOutputErrorExitsWithMultipleSinkErrors', async () => {
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue(fakeImapConnection());
    vi.mocked(core.getDmarcReportsFromMailbox).mockImplementation(
      fetchInvokingSaveCallback({
        aggregateReports: [{ policyPublished: { domain: 'example.com' } }],
        failureReports: [{ reportedDomain: 'example.com' }],
        smtpTlsReports: [],
      } as unknown as ParsingResults),
    );
    vi.mocked(elastic.setHosts).mockResolvedValue(fakeSearchClient());
    vi.mocked(elastic.migrateIndexes).mockResolvedValue();
    vi.mocked(elastic.saveAggregateReportToElasticsearch).mockRejectedValue(
      new elastic.ElasticsearchError('aggregate sink failed'),
    );
    vi.mocked(elastic.saveFailureReportToElasticsearch).mockResolvedValue();
    vi.mocked(opensearch.setHosts).mockResolvedValue(fakeSearchClient());
    vi.mocked(opensearch.migrateIndexes).mockResolvedValue();
    vi.mocked(opensearch.saveAggregateReportToOpenSearch).mockResolvedValue();
    vi.mocked(opensearch.saveFailureReportToOpenSearch).mockRejectedValue(
      new opensearch.OpenSearchError('failure sink failed'),
    );
    const errors: string[] = [];
    // Capture records, and keep the CLI's console handler off stderr.
    logger.disabled = false;
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logs = captureLogs();
    const configPath = writeConfig(`[general]
save_aggregate = true
save_failure = true
fail_on_output_error = true
silent = true
offline = true

${IMAP_CONFIG}
[elasticsearch]
hosts = localhost

[opensearch]
hosts = localhost
`);

    try {
      await expect(main(['-c', configPath])).rejects.toMatchObject({
        code: 1,
      });
    } finally {
      logs.restore();
    }
    for (const record of logs.records) {
      if (record.levelName === 'ERROR') {
        errors.push(record.message);
      }
    }
    expect(elastic.saveAggregateReportToElasticsearch).toHaveBeenCalledOnce();
    expect(opensearch.saveFailureReportToOpenSearch).toHaveBeenCalledOnce();
    // Both destinations' failures reach the fatal message.
    expect(errors.at(-1)).toBe(
      'Output destination failures detected: ' +
        'Elasticsearch Error: aggregate sink failed | ' +
        'OpenSearch Error: failure sink failed',
    );
  });
});

// Parsing the large sample in worker threads takes a few seconds.
describe('TestDirectoryFilePaths', () => {
  // Runs the real main(): real worker threads, real parsing, real output.
  beforeEach(() => {
    SEEN_AGGREGATE_REPORT_IDS.clear();
  });

  function buildReportsDir(dir: string): string {
    const reportsDir = path.join(dir, 'reports');
    const nestedDir = path.join(reportsDir, 'nested');
    mkdirSync(nestedDir, { recursive: true });
    copyFileSync(
      TOP_LEVEL_SAMPLE,
      path.join(reportsDir, path.basename(TOP_LEVEL_SAMPLE)),
    );
    copyFileSync(
      NESTED_SAMPLE,
      path.join(nestedDir, path.basename(NESTED_SAMPLE)),
    );
    return reportsDir;
  }

  function writeOutputConfig(
    dir: string,
    outputName: string,
    nProcs?: number,
  ): [string, string] {
    const configPath = path.join(dir, 'tsdmarc.ini');
    const outputDir = path.join(dir, outputName);
    let text = `[general]\noffline = True\nsilent = True\noutput = ${outputDir}\n`;
    if (nProcs !== undefined) {
      text += `n_procs = ${nProcs}\n`;
    }
    writeFileSync(configPath, text);
    return [configPath, outputDir];
  }

  function reportIds(outputDir: string): Set<string> {
    const reports = JSON.parse(
      readFileSync(path.join(outputDir, 'aggregate.json'), 'utf8'),
    ) as { report_metadata: { report_id: string } }[];
    return new Set(reports.map(report => report.report_metadata.report_id));
  }

  async function sampleReportId(samplePath: string): Promise<string> {
    const result = await parseReportFile(samplePath, { offline: true });
    if (result.reportType !== 'aggregate') {
      throw new Error('expected an aggregate report');
    }
    return result.report.reportMetadata.reportId;
  }

  it('test_directory_file_path_non_recursive_skips_nested', async () => {
    const dir = tempDir();
    const reportsDir = buildReportsDir(dir);
    const [configPath, outputDir] = writeOutputConfig(
      dir,
      'output_non_recursive',
    );

    await main(['-c', configPath, reportsDir]);

    const ids = reportIds(outputDir);
    expect(ids.has(await sampleReportId(TOP_LEVEL_SAMPLE))).toBe(true);
    expect(ids.has(await sampleReportId(NESTED_SAMPLE))).toBe(false);
  });

  it('test_directory_file_path_recursive_includes_nested', async () => {
    const dir = tempDir();
    const reportsDir = buildReportsDir(dir);
    const [configPath, outputDir] = writeOutputConfig(dir, 'output_recursive');

    await main(['-c', configPath, '-r', reportsDir]);

    const ids = reportIds(outputDir);
    expect(ids.has(await sampleReportId(TOP_LEVEL_SAMPLE))).toBe(true);
    expect(ids.has(await sampleReportId(NESTED_SAMPLE))).toBe(true);
  });

  it('test_directory_file_path_recursive_includes_nested_n_procs_2', async () => {
    const dir = tempDir();
    const reportsDir = buildReportsDir(dir);
    const [configPath, outputDir] = writeOutputConfig(
      dir,
      'output_recursive_n_procs_2',
      2,
    );

    await main(['-c', configPath, '-r', reportsDir]);

    const ids = reportIds(outputDir);
    const topLevelId = await sampleReportId(TOP_LEVEL_SAMPLE);
    const nestedId = await sampleReportId(NESTED_SAMPLE);
    expect(ids).toEqual(new Set([topLevelId, nestedId]));
  });
});

describe('a run with more reports than a call can take as arguments', () => {
  const MANY_REPORTS = 200_000;
  const reports = (): ParsingResults => ({
    aggregateReports: [],
    failureReports: [],
    smtpTlsReports: Array.from({ length: MANY_REPORTS }, () => ({
      policies: [],
    })) as unknown as ParsingResults['smtpTlsReports'],
  });

  it('collects them from an mbox file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-mbox-'));
    const mboxPath = path.join(dir, 'reports.mbox');
    writeFileSync(
      mboxPath,
      'From x Thu Jan  1 00:00:00 2024\nSubject: a\n\nb\n',
    );
    const configPath = path.join(dir, 'config.ini');
    writeFileSync(
      configPath,
      '[general]\nsilent = true\noffline = true\nsave_smtp_tls = false\n',
    );
    const mbox = vi.mocked(getDmarcReportsFromMbox);
    mbox.mockResolvedValue(reports());
    try {
      await expect(main(['-c', configPath, mboxPath])).resolves.toBeUndefined();
      expect(mbox).toHaveBeenCalledOnce();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an enrichment failure while parsing files', () => {
  it('stops before archiving any file or saving any report', async () => {
    const dir = tempDir();
    const reportsDir = path.join(dir, 'reports');
    const archiveDir = path.join(dir, 'archive');
    const outputDir = path.join(dir, 'output');
    mkdirSync(reportsDir);
    const good = path.join(reportsDir, 'good.xml');
    const bad = path.join(reportsDir, 'bad.xml');
    copyFileSync(TOP_LEVEL_SAMPLE, good);
    copyFileSync(TOP_LEVEL_SAMPLE, bad);
    const parsed = await parseReportFile(TOP_LEVEL_SAMPLE, { offline: true });
    // How parseReportFile() reports a token revoked mid-run.
    const revoked = new ParserError('Unexpected error', {
      cause: new InvalidIPinfoAPIKey(
        'IPinfo API rejected the configured token (HTTP 403)',
      ),
    });
    vi.mocked(core.parseReportFiles).mockImplementation(async function* () {
      yield [good, parsed];
      yield [bad, revoked];
    });
    const configPath = writeConfig(
      `[general]\nsilent = true\noffline = true\noutput = ${outputDir}\narchive_directory = ${archiveDir}\n`,
    );

    await expect(main(['-c', configPath, reportsDir])).rejects.toMatchObject({
      code: 1,
    });

    // Both stay for the next run, none in Invalid/ or saved.
    expect(readFileSync(good, 'utf8')).not.toBe('');
    expect(readFileSync(bad, 'utf8')).not.toBe('');
    expect(() =>
      readFileSync(path.join(outputDir, 'aggregate.json')),
    ).toThrow();
  });
});
