// Ported from parsedmarc 11.2.1 tests/test_cli.py: TestMixedInputAggregateDedup.
// The direct-file and mbox paths of one run share the seen report ID cache,
// so they must key it identically (reporter, Report-ID and policy domain).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { logger } from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main } from './main';

const REPORT_ID = 'shared-id@reporter.example';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-dedup-'));
  logger.disabled = true;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function xml(policyDomain: string, recordCount: number): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<feedback><report_metadata>' +
    '<org_name>reporter.example</org_name>' +
    '<email>dmarc@reporter.example</email>' +
    `<report_id>${REPORT_ID}</report_id>` +
    '<date_range><begin>1680000000</begin><end>1680086400</end>' +
    '</date_range></report_metadata>' +
    `<policy_published><domain>${policyDomain}</domain><p>none</p>` +
    '</policy_published>' +
    '<record><row><source_ip>192.0.2.1</source_ip>' +
    `<count>${recordCount}</count>` +
    '<policy_evaluated><disposition>none</disposition><dkim>pass</dkim>' +
    '<spf>pass</spf></policy_evaluated></row>' +
    `<identifiers><header_from>${policyDomain}</header_from></identifiers>` +
    `<auth_results><spf><domain>${policyDomain}</domain>` +
    '<result>pass</result></spf></auth_results></record></feedback>'
  );
}

function xmlFile(name: string, policyDomain: string, count: number): string {
  const filePath = path.join(tempDir, name);
  writeFileSync(filePath, xml(policyDomain, count));
  return filePath;
}

function mboxFile(name: string, policyDomain: string, count: number): string {
  const attachment = gzipSync(Buffer.from(xml(policyDomain, count)))
    .toString('base64')
    .replaceAll(/(.{76})/gu, '$1\n');
  const message = [
    'From MAILER-DAEMON Mon Jan  1 00:00:00 2024',
    'Content-Type: multipart/mixed; boundary="BOUNDARY"',
    'MIME-Version: 1.0',
    'From: dmarc@reporter.example',
    'To: dmarc@example.com',
    `Subject: Report domain: ${policyDomain}`,
    'Date: Mon, 1 Jan 2024 00:00:00 +0000',
    '',
    '--BOUNDARY',
    'Content-Type: application/gzip',
    'MIME-Version: 1.0',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="report.xml.gz"',
    '',
    attachment,
    '--BOUNDARY--',
    '',
    '',
  ].join('\n');
  const filePath = path.join(tempDir, name);
  writeFileSync(filePath, message);
  return filePath;
}

async function run(...paths: string[]): Promise<[string, number][]> {
  const outputDir = path.join(tempDir, 'output');
  const configPath = path.join(tempDir, 'tsdmarc.ini');
  writeFileSync(
    configPath,
    `[general]\noffline = True\nsilent = True\noutput = ${outputDir}\n`,
  );
  await main(['-c', configPath, ...paths]);
  const reports = JSON.parse(
    readFileSync(path.join(outputDir, 'aggregate.json'), 'utf8'),
  ) as {
    policy_published: { domain: string };
    records: { count: number }[];
  }[];
  return reports
    .map((report): [string, number] => [
      report.policy_published.domain,
      report.records[0]?.count ?? 0,
    ])
    .toSorted(([a], [b]) => a.localeCompare(b));
}

describe('TestMixedInputAggregateDedup', () => {
  it('test_same_report_in_file_and_mbox_is_saved_once', async () => {
    const xmlPath = xmlFile('report.xml', 'a.example', 5);
    const mboxPath = mboxFile('reports.mbox', 'a.example', 7);
    // Direct files are parsed before mbox files, so the file's copy wins.
    expect(await run(xmlPath, mboxPath)).toEqual([['a.example', 5]]);
  });

  it('test_same_id_for_other_domain_in_file_and_mbox_is_kept', async () => {
    const xmlPath = xmlFile('report.xml', 'a.example', 5);
    const mboxPath = mboxFile('reports.mbox', 'b.example', 7);
    expect(await run(xmlPath, mboxPath)).toEqual([
      ['a.example', 5],
      ['b.example', 7],
    ]);
  });

  it('test_direct_files_with_same_id_for_different_domains_are_kept', async () => {
    const aPath = xmlFile('a.xml', 'a.example', 5);
    const bPath = xmlFile('b.xml', 'b.example', 7);
    const aUpperPath = xmlFile('a-upper.xml', 'A.EXAMPLE', 9);
    const kept = await run(aPath, bPath, aUpperPath);
    expect(kept.map(([domain]) => domain.toLowerCase()).toSorted()).toEqual([
      'a.example',
      'b.example',
    ]);
    expect(kept).toContainEqual(['b.example', 7]);
  });
});
