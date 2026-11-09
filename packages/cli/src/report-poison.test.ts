// Reports that pass parsing but used to make an output step throw (a
// KeyError in the CSV flattener, an unparsable IP in a search document, an
// address header with no address). With one such report a mailbox batch was
// held on every run, and the next mail was never read. Real `main()` on a
// real Maildir, plus a fake search client for Elasticsearch and OpenSearch.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as elastic from '@tsdmarc/elasticsearch';
import * as opensearch from '@tsdmarc/opensearch';
import {
  captureLogs,
  type FailureReport,
  FileHandler,
  fileFormat,
  logger,
  parseReportFile,
  parseSmtpTlsReportJson,
  ParserError,
  type ParsingResults,
  SEEN_AGGREGATE_REPORT_IDS,
  type SMTPTLSReport,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { archiveSubdirForResult } from './archive';
import { getDmarcReportsFromMailbox } from './core';
import { main } from './main';
import { createOptions } from './options';
import type { OutputClients } from './outputs';
import {
  filterSmtpTlsReportsForIndexPrefix,
  processReports,
  type RunState,
} from './process-reports';

const FORGED = '2026-10-31 12:00:00,000 - ERROR - [tsdmarc] - FORGED';

const AGGREGATE_XML = readFileSync(
  fileURLToPath(
    new URL(
      '../../../samples/aggregate/example.net!example.com!1529366400!1529452799.xml',
      import.meta.url,
    ),
  ),
  'utf8',
);

function emailWith(
  contentType: string,
  filename: string,
  body: string,
): string {
  return [
    'From: [EMAIL]',
    'To: [EMAIL]',
    `Subject: ${filename}`,
    'Date: Mon, 01 Jan 2024 00:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain',
    '',
    'report',
    '--B',
    `Content-Type: ${contentType}`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body).toString('base64'),
    '--B--',
    '',
  ].join('\n');
}

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-poison-'));
  SEEN_AGGREGATE_REPORT_IDS.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

function smtpTlsReport(startDatetime: string): SMTPTLSReport {
  return {
    organizationName: 'x',
    beginDate: startDatetime,
    endDate: startDatetime,
    contactInfo: 'c',
    reportId: 'p',
    policies: [],
  } as unknown as SMTPTLSReport;
}

/** The folder of each message file under `box`, keyed by its name. */
function messageFolders(box: string): Record<string, string> {
  const folders: Record<string, string> = {};
  for (const entry of readdirSync(box, { recursive: true, encoding: 'utf8' })) {
    const parts = entry.split(path.sep);
    const name = parts.at(-1) ?? '';
    if (parts.length >= 2 && ['cur', 'new'].includes(parts.at(-2) ?? '')) {
      if (!name.startsWith('.')) {
        folders[name.split(':')[0] ?? name] = parts.slice(0, -2).join('/');
      }
    }
  }
  return folders;
}

describe('a mailbox report the file output used to fail on', () => {
  const reasonWithoutType = AGGREGATE_XML.replace(
    '</policy_evaluated>',
    '<reason><comment>x</comment></reason></policy_evaluated>',
  ).replace('<report_id>', '<report_id>poison');
  const policyStringNumber = JSON.stringify({
    'organization-name': 'x',
    'date-range': {
      'start-datetime': '2024-01-01T00:00:00Z',
      'end-datetime': '2024-01-02T00:00:00Z',
    },
    'contact-info': 'c',
    'report-id': 'p',
    policies: [
      {
        policy: {
          'policy-type': 'sts',
          'policy-string': [1],
          'policy-domain': 'example.com',
          'mx-host': ['mx.example.com'],
        },
        summary: {
          'total-successful-session-count': 1,
          'total-failure-session-count': 0,
        },
      },
    ],
  });

  it.each([
    [
      'an override reason without type',
      emailWith('text/xml', 'poison.xml', reasonWithoutType),
      '.Archive/Aggregate',
    ],
    [
      'a number in policy-string',
      emailWith('application/tlsrpt+json', 'poison.json', policyStringNumber),
      '.Archive/Invalid',
    ],
  ])('does not hold its neighbour: %s', async (_name, poison, poisonFolder) => {
    const box = path.join(tempDir, 'box');
    for (const folder of ['cur', 'new', 'tmp']) {
      mkdirSync(path.join(box, folder), { recursive: true });
    }
    writeFileSync(
      path.join(box, 'cur', 'good:2,S'),
      emailWith('text/xml', 'good.xml', AGGREGATE_XML),
    );
    writeFileSync(path.join(box, 'cur', 'poison:2,S'), poison);
    const output = path.join(tempDir, 'out');
    const configPath = path.join(tempDir, 'c.ini');
    writeFileSync(
      configPath,
      `[general]\noffline = True\nsilent = True\noutput = ${output}\n` +
        `[maildir]\nmaildir_path = ${box}\n`,
    );
    const logs = captureLogs();
    try {
      await expect(main(['-c', configPath])).resolves.toBeUndefined();
    } finally {
      logs.restore();
    }
    expect(logs.output.filter(line => line.includes('output'))).toEqual([]);
    expect(messageFolders(box)).toEqual({
      good: '.Archive/Aggregate',
      poison: poisonFolder,
    });
  });
});

describe('processReports() with a report a search output used to refuse', () => {
  function runState(configure: (opts: RunState['opts']) => void): RunState {
    const opts = createOptions();
    opts.silent = true;
    opts.saveFailure = true;
    opts.saveSmtpTls = true;
    configure(opts);
    return {
      opts,
      clients: new Map() as unknown as OutputClients,
      indexPrefixDomainMap: null,
    };
  }

  function tlsReport(detail: Record<string, unknown>): SMTPTLSReport {
    return parseSmtpTlsReportJson(
      JSON.stringify({
        'organization-name': 'x',
        'date-range': {
          'start-datetime': '2024-01-01T00:00:00Z',
          'end-datetime': '2024-01-02T00:00:00Z',
        },
        'contact-info': 'c',
        'report-id': 'p',
        policies: [
          {
            policy: { 'policy-type': 'sts', 'policy-domain': 'example.com' },
            summary: {
              'total-successful-session-count': 1,
              'total-failure-session-count': 1,
            },
            'failure-details': [
              { 'result-type': 'x', 'failed-session-count': 1, ...detail },
            ],
          },
        ],
      }),
    );
  }

  function fakeSearchClient(): { indexed: unknown[]; client: never } {
    const indexed: unknown[] = [];
    const client = {
      indices: {
        exists: async () => true,
        create: async () => ({}),
      },
      search: async () => ({
        hits: { hits: [] },
        body: { hits: { hits: [] } },
      }),
      index: async (document: unknown) => {
        indexed.push(document);
        return {};
      },
    };
    return { indexed, client: client as never };
  }

  const smtpTls = (...smtpTlsReports: SMTPTLSReport[]): ParsingResults => ({
    aggregateReports: [],
    failureReports: [],
    smtpTlsReports,
  });

  describe.each(['sending-mta-ip', 'receiving-ip'])('a bad %s', field => {
    it.each([
      ['Elasticsearch', elastic.setDefaultConnection, 'elasticsearchHosts'],
      ['OpenSearch', opensearch.setDefaultConnection, 'opensearchHosts'],
    ] as const)('is saved by %s with the neighbour', async (_n, set, key) => {
      const { indexed, client } = fakeSearchClient();
      set(client);
      const state = runState(opts => {
        opts[key] = ['http://[IP]:9'];
      });
      const logs = captureLogs();
      let errors: string[] = [];
      try {
        errors = await processReports(
          state,
          smtpTls(
            tlsReport({ [field]: 'not-an-ip' }),
            tlsReport({ [field]: '[IP]' }),
          ),
        );
      } finally {
        logs.restore();
        set(null);
      }
      expect(errors).toEqual([]);
      expect(indexed).toHaveLength(2);
    });
  });

  it('saves a failure sample with no address in To', async () => {
    const { indexed, client } = fakeSearchClient();
    elastic.setDefaultConnection(client);
    const { report } = await parseReportFile(
      fileURLToPath(
        new URL(
          '../../../samples/failure/dmarc_ruf_report_linkedin.eml',
          import.meta.url,
        ),
      ),
      { offline: true },
    );
    const failure = report as FailureReport;
    const headers = { ...failure.parsedSample.headers, to: [] };
    failure.parsedSample = { ...failure.parsedSample, headers };
    const state = runState(opts => {
      opts.elasticsearchHosts = ['http://[IP]:9'];
    });
    const logs = captureLogs();
    let errors: string[] = [];
    try {
      errors = await processReports(state, {
        aggregateReports: [],
        failureReports: [failure],
        smtpTlsReports: [],
      });
    } finally {
      logs.restore();
      elastic.setDefaultConnection(null);
    }
    expect(errors).toEqual([]);
    expect(indexed).toHaveLength(1);
  });
});

describe('sender-controlled text in the log file', () => {
  function logFile(): { lines: () => string[]; close: () => void } {
    const file = path.join(tempDir, 'log.txt');
    const handler = new FileHandler(file);
    handler.setFormatter(fileFormat);
    logger.addHandler(handler);
    return {
      lines: () => readFileSync(file, 'utf8').split('\n'),
      close: () => {
        logger.removeHandler(handler);
        handler.close();
      },
    };
  }

  it('escapes the fail_on_output_error message', async () => {
    const state: RunState = {
      opts: {
        ...createOptions(),
        silent: true,
        saveSmtpTls: true,
        failOnOutputError: true,
      },
      clients: new Map([
        [
          'hec_client',
          {
            saveSmtpTlsReportsToSplunk: vi.fn(async () => {
              throw new Error(`Unknown string format: x\n${FORGED}`);
            }),
          },
        ],
      ]) as unknown as OutputClients,
      indexPrefixDomainMap: null,
    };
    const logs = captureLogs();
    const error = await processReports(state, {
      aggregateReports: [],
      failureReports: [],
      smtpTlsReports: [smtpTlsReport('x')],
    }).catch((caught: unknown) => caught);
    logs.restore();
    expect(error).toBeInstanceOf(ParserError);
    expect((error as Error).message).not.toContain('\n');
    expect((error as Error).message).toContain(String.raw`\n${FORGED}`);
  });

  it('escapes a ParserError that ends the mailbox pass', async () => {
    const box = path.join(tempDir, 'box');
    for (const folder of ['cur', 'new', 'tmp']) {
      mkdirSync(path.join(box, folder), { recursive: true });
    }
    const configPath = path.join(tempDir, 'c.ini');
    writeFileSync(
      configPath,
      `[general]\noffline = True\nsilent = True\n[maildir]\nmaildir_path = ${box}\n`,
    );
    vi.mocked(getDmarcReportsFromMailbox).mockRejectedValueOnce(
      new ParserError(`x\n${FORGED}`),
    );
    const logs = captureLogs();
    try {
      await expect(main(['-c', configPath])).rejects.toMatchObject({ code: 1 });
    } finally {
      logs.restore();
    }
    const messages = logs.records.map(record => record.message);
    expect(messages.some(message => message.includes(FORGED))).toBe(true);
    expect(messages.filter(message => message.includes('\n'))).toEqual([]);
  });

  it('escapes the date in the archive warning', () => {
    const logs = captureLogs();
    try {
      expect(
        archiveSubdirForResult({
          reportType: 'smtp_tls',
          report: smtpTlsReport(`x\n${FORGED}`),
        }),
      ).toBeNull();
    } finally {
      logs.restore();
    }
    const [message] = logs.records.map(record => record.message);
    expect(message).toContain('Cannot determine archive date');
    expect(message).not.toContain('\n');
  });

  it('escapes the domain in the index_prefix_domain_map debug line', () => {
    const log = logFile();
    const { level } = logger;
    logger.setLevel(10);
    try {
      filterSmtpTlsReportsForIndexPrefix(
        [
          {
            ...smtpTlsReport('x'),
            policies: [{ policyDomain: `d.example\n${FORGED}` }],
          } as unknown as SMTPTLSReport,
        ],
        new Map([['prefix', ['example.org']]]),
      );
    } finally {
      logger.setLevel(level);
      log.close();
    }
    expect(log.lines()).not.toContain(FORGED);
  });
});
