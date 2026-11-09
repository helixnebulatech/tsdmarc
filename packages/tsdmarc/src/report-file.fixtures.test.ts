// Every file in samples/ through parseReportFile(), compared with
// parsedmarc's own parse_report_file() output (fixtures/).

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsedAggregateReportsToCsv } from './aggregate';
import { parsedFailureReportsToCsv } from './failure';
import { parseReportFile } from './report-file';
import { toSnakeCaseKeys } from './serialize';
import { parsedSmtpTlsReportsToCsv } from './smtp-tls';
import { asJson, loadFixture, SAMPLES_DIR, samplePath } from './test/fixtures';
import type { ParsedReport } from './types';

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const SAMPLES = walk(SAMPLES_DIR)
  .map(file => path.relative(SAMPLES_DIR, file))
  .sort();

function toCsv(result: ParsedReport): string {
  switch (result.reportType) {
    case 'aggregate':
      return parsedAggregateReportsToCsv(result.report);
    case 'failure':
      return parsedFailureReportsToCsv(result.report);
    default:
      return parsedSmtpTlsReportsToCsv(result.report);
  }
}

describe('parseReportFile matches parsedmarc on every sample', () => {
  it('covers all 35 samples', () => {
    expect(SAMPLES).toHaveLength(35);
  });

  for (const sample of SAMPLES) {
    it(sample, async () => {
      const fixture = loadFixture(sample);
      let result: ParsedReport;
      try {
        result = await parseReportFile(samplePath(sample), {
          alwaysUseLocalFiles: true,
          offline: true,
        });
      } catch (error) {
        expect(fixture.error).toBeDefined();
        expect((error as Error).name).toBe(fixture.error?.type);
        expect((error as Error).message).toBe(fixture.error?.message);
        return;
      }
      expect(fixture.error).toBeUndefined();
      expect(asJson(toSnakeCaseKeys(result))).toEqual(fixture.result);
      expect(toCsv(result)).toBe(fixture.csv);
      // Results survive a structured clone (they cross worker threads).
      expect(asJson(toSnakeCaseKeys(structuredClone(result)))).toEqual(
        fixture.result,
      );
    });
  }
});
