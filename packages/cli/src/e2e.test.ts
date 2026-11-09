// End-to-end: the built `dist/bin.js` run with Node on `samples/`, offline,
// compared with parsedmarc's own output in `fixtures/`.

import { spawnSync } from 'node:child_process';
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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = path.resolve(packageDir, '..', '..');
const binPath = path.join(packageDir, 'dist', 'bin.js');
/** One CLI run may take this long on a loaded machine. */
const CLI_TIMEOUT_MS = 120_000;
/** A test (or the build) may run the CLI more than once. */
const E2E_TIMEOUT_MS = 300_000;

interface Fixture {
  csv: string;
  result: { report: Record<string, unknown>; report_type: string };
}

/** Python's `sorted()` on file names: by code point. */
function byCodePoint(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference =
      (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function isMbox(category: string, name: string): boolean {
  return readFileSync(
    path.join(repoDir, 'samples', category, name),
    'latin1',
  ).startsWith('From ');
}

/**
 * The fixtures of every sample in `samples/<category>`, in CLI order:
 * sorted, with mbox files last (they are read after the report files).
 */
function fixturesFor(category: string): Fixture[] {
  const sorted = readdirSync(path.join(repoDir, 'samples', category))
    .filter(name => !name.startsWith('.'))
    .sort(byCodePoint);
  const samples = [
    ...sorted.filter(name => !isMbox(category, name)),
    ...sorted.filter(name => isMbox(category, name)),
  ];
  return samples.map(
    name =>
      JSON.parse(
        readFileSync(
          path.join(repoDir, 'fixtures', category, `${name}.json`),
          'utf8',
        ),
      ) as Fixture,
  );
}

/** One CSV file from per-report CSVs: the header once, then every row. */
function joinCsv(csvs: string[]): string {
  const [first] = csvs;
  if (first === undefined) {
    return '';
  }
  const header = first.slice(0, first.indexOf('\r\n') + 2);
  return header + csvs.map(csv => csv.slice(header.length)).join('');
}

function runCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd: repoDir,
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

let outputRoot: string;

beforeAll(() => {
  // Build this package so the test runs what gets published.
  const build = spawnSync(
    path.join(packageDir, 'node_modules', '.bin', 'tsdown'),
    [],
    { cwd: packageDir, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  expect(build.status, build.stderr).toBe(0);
  outputRoot = mkdtempSync(path.join(tmpdir(), 'tsdmarc-e2e-'));
}, E2E_TIMEOUT_MS);

afterAll(() => {
  rmSync(outputRoot, { recursive: true, force: true });
});

describe('tsdmarc on samples/', { timeout: E2E_TIMEOUT_MS }, () => {
  it('writes the aggregate JSON and CSV parsedmarc writes', () => {
    const output = path.join(outputRoot, 'aggregate');
    const { status, stderr } = runCli([
      '--offline',
      '--silent',
      '--output',
      output,
      'samples/aggregate',
    ]);
    expect(status, stderr).toBe(0);

    // The CLI skips repeated aggregate report IDs, keeping the first.
    const seen = new Set<string>();
    const fixtures = fixturesFor('aggregate').filter(fixture => {
      const metadata = fixture.result.report.report_metadata as {
        org_name: string;
        report_id: string;
      };
      const key = `${metadata.org_name}_${metadata.report_id}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    const json = JSON.parse(
      readFileSync(path.join(output, 'aggregate.json'), 'utf8'),
    ) as unknown[];
    expect(json).toEqual(fixtures.map(fixture => fixture.result.report));
    expect(readFileSync(path.join(output, 'aggregate.csv'), 'utf8')).toBe(
      joinCsv(fixtures.map(fixture => fixture.csv)),
    );
  });

  it('writes the failure JSON and CSV parsedmarc writes', () => {
    const output = path.join(outputRoot, 'failure');
    const { status, stderr } = runCli([
      '--offline',
      '-s',
      '-o',
      output,
      'samples/failure',
    ]);
    expect(status, stderr).toBe(0);
    const fixtures = fixturesFor('failure');
    const json = JSON.parse(
      readFileSync(path.join(output, 'failure.json'), 'utf8'),
    ) as unknown[];
    expect(json).toEqual(fixtures.map(fixture => fixture.result.report));
    expect(readFileSync(path.join(output, 'failure.csv'), 'utf8')).toBe(
      joinCsv(fixtures.map(fixture => fixture.csv)),
    );
  });

  it('prints and writes the SMTP TLS reports parsedmarc writes', () => {
    const output = path.join(outputRoot, 'smtp_tls');
    const { status, stdout, stderr } = runCli([
      '--offline',
      '-o',
      output,
      'samples/smtp_tls',
    ]);
    expect(status, stderr).toBe(0);
    const fixtures = fixturesFor('smtp_tls');
    const reports = fixtures.map(fixture => fixture.result.report);
    expect(JSON.parse(stdout)).toEqual({
      aggregate_reports: [],
      failure_reports: [],
      smtp_tls_reports: reports,
    });
    expect(stdout.endsWith('\n\n')).toBe(true);
    const json = JSON.parse(
      readFileSync(path.join(output, 'smtp_tls.json'), 'utf8'),
    ) as unknown[];
    expect(json).toEqual(reports);
    expect(readFileSync(path.join(output, 'smtp_tls.csv'), 'utf8')).toBe(
      joinCsv(fixtures.map(fixture => fixture.csv)),
    );
  });

  it('prints single-line JSON with --no-prettify-json', () => {
    const { status, stdout } = runCli([
      '--offline',
      '--no-prettify-json',
      'samples/smtp_tls/rfc8460.json',
    ]);
    expect(status).toBe(0);
    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(stdout.startsWith('{"aggregate_reports": [], ')).toBe(true);
  });

  it('goes on past a file that fails to parse, and past a failing mbox message', () => {
    const input = path.join(outputRoot, 'poison-input');
    mkdirSync(input);
    let nested = 'a';
    for (let index = 0; index < 260; index += 1) {
      nested = `Content-Type: multipart/mixed; boundary=b${index}\n\n--b${index}\n${nested}\n--b${index}--\n`;
    }
    const poison = `From: a@b\nSubject: poison\nMIME-Version: 1.0\n${nested}`;
    writeFileSync(path.join(input, 'poison.eml'), poison);
    const twilight = readFileSync(
      path.join(repoDir, 'samples', 'aggregate', 'twilight.eml'),
      'utf8',
    ).replaceAll(/^From /gmu, '>From ');
    writeFileSync(
      path.join(input, 'reports.mbox'),
      `From x Thu Jan  1 00:00:00 2024\n${poison}\n\nFrom y Thu Jan  1 00:00:00 2024\n${twilight}\n`,
    );
    const files = runCli([
      '--offline',
      '--no-prettify-json',
      path.join(input, 'poison.eml'),
      'samples/smtp_tls/rfc8460.json',
    ]);
    expect(files.status, files.stderr).toBe(0);
    expect(files.stderr).toMatch(
      /Failed to parse .*poison\.eml - Unable to parse message with subject "poison": maximum recursion depth exceeded/u,
    );
    const printed = JSON.parse(files.stdout) as {
      smtp_tls_reports: unknown[];
    };
    expect(printed.smtp_tls_reports).toHaveLength(1);

    // Unlike parsedmarc 11.1.0, which ends an mbox run at a ParserError
    // other than InvalidDMARCReport: the message is logged and skipped.
    const mbox = runCli([
      '--offline',
      '--no-prettify-json',
      '--warnings',
      path.join(input, 'reports.mbox'),
    ]);
    expect(mbox.status, mbox.stderr).toBe(0);
    expect(mbox.stderr).toMatch(
      /Skipping message \d+: .*Unable to parse message with subject "poison": maximum recursion depth exceeded/u,
    );
  });

  it('exits 2 on a usage error and 0 on --version', () => {
    expect(runCli(['--dns-timeout', 'soon']).status).toBe(2);
    const version = runCli(['--version']);
    expect(version.status).toBe(0);
    // The core's package.json version, as released, not a hard-coded one.
    const core = JSON.parse(
      readFileSync(
        path.join(repoDir, 'packages', 'tsdmarc', 'package.json'),
        'utf8',
      ),
    ) as { version: string };
    expect(version.stdout.trim()).toBe(core.version);
  });
});

describe('integers beyond 2^53', { timeout: E2E_TIMEOUT_MS }, () => {
  it('prints and writes them exactly, like parsedmarc', () => {
    const input = path.join(outputRoot, 'huge-input');
    const output = path.join(outputRoot, 'huge-output');
    mkdirSync(input);
    writeFileSync(
      path.join(input, 'aggregate.xml'),
      readFileSync(
        path.join(
          repoDir,
          'samples/aggregate/!example.com!1538204542!1538463818.xml',
        ),
        'utf8',
      ).replace('<count>1</count>', '<count>99999999999999999999</count>'),
    );
    writeFileSync(
      path.join(input, 'smtp_tls.json'),
      readFileSync(
        path.join(repoDir, 'samples/smtp_tls/smtp_tls.json'),
        'utf8',
      ).replace(
        '"total-failure-session-count":3',
        '"total-failure-session-count":99999999999999999999',
      ),
    );
    const { status, stdout, stderr } = runCli([
      '--offline',
      '-o',
      output,
      path.join(input, 'aggregate.xml'),
      path.join(input, 'smtp_tls.json'),
    ]);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain('"count": 99999999999999999999,');
    expect(stdout).toContain('"failed_session_count": 99999999999999999999');
    expect(readFileSync(path.join(output, 'aggregate.json'), 'utf8')).toContain(
      '"count": 99999999999999999999,',
    );
    expect(readFileSync(path.join(output, 'smtp_tls.csv'), 'utf8')).toContain(
      ',99999999999999999999',
    );
  });
});
