// Access to fixtures/ (parsedmarc's output for every sample) and samples/.

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const REPO_ROOT: string = path.resolve(
  import.meta.dirname,
  '../../../..',
);
export const SAMPLES_DIR: string = path.join(REPO_ROOT, 'samples');
export const FIXTURES_DIR: string = path.join(REPO_ROOT, 'fixtures');

export interface Fixture {
  sample: string;
  parsedmarc: string;
  result?: { report_type: string; report: unknown };
  csv?: string;
  error?: { type: string; message: string };
}

/** Absolute path of a sample, from its path relative to samples/. */
export function samplePath(relative: string): string {
  return path.join(SAMPLES_DIR, relative);
}

/** The parsedmarc fixture for a sample path relative to samples/. */
export function loadFixture(relative: string): Fixture {
  return JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, `${relative}.json`), 'utf-8'),
  ) as Fixture;
}

/** Round-trip through JSON, as parsedmarc's JSON output would. */
export function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
