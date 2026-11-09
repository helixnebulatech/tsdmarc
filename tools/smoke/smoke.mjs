// Smoke test of the built packages: import everything, parse every sample
// offline and compare with parsedmarc's output (fixtures/), as a consumer
// would, under whichever runtime executes this file.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const packages = [
  'tsdmarc',
  '@tsdmarc/cli',
  '@tsdmarc/elasticsearch',
  '@tsdmarc/gmail',
  '@tsdmarc/imap',
  '@tsdmarc/ipinfo-lite',
  '@tsdmarc/kafka',
  '@tsdmarc/loganalytics',
  '@tsdmarc/msgraph',
  '@tsdmarc/opensearch',
  '@tsdmarc/postgres',
  '@tsdmarc/s3',
  '@tsdmarc/smtp',
];
for (const name of packages) {
  const module = await import(name);
  assert.ok(Object.keys(module).length > 0, `${name} exports nothing`);
}

const tsdmarc = await import('tsdmarc');

function walk(directory) {
  return readdirSync(directory).flatMap(entry => {
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const csvWriters = {
  aggregate: tsdmarc.parsedAggregateReportsToCsv,
  failure: tsdmarc.parsedFailureReportsToCsv,
  smtp_tls: tsdmarc.parsedSmtpTlsReportsToCsv,
};

let checked = 0;
for (const sample of walk(path.join(root, 'samples')).sort()) {
  const relative = path.relative(path.join(root, 'samples'), sample);
  const fixture = JSON.parse(
    readFileSync(path.join(root, 'fixtures', `${relative}.json`), 'utf-8'),
  );
  let result;
  try {
    result = await tsdmarc.parseReportFile(sample, {
      alwaysUseLocalFiles: true,
      offline: true,
    });
  } catch (error) {
    assert.ok(fixture.error, `${relative}: unexpected ${error}`);
    assert.equal(error.name, fixture.error.type, `${relative}: error type`);
    checked += 1;
    continue;
  }
  assert.ok(!fixture.error, `${relative}: expected ${fixture.error?.type}`);
  assert.deepEqual(
    JSON.parse(JSON.stringify(tsdmarc.toSnakeCaseKeys(result))),
    fixture.result,
    `${relative}: parsed report differs from parsedmarc`,
  );
  assert.equal(
    csvWriters[result.reportType](result.report),
    fixture.csv,
    `${relative}: CSV differs from parsedmarc`,
  );
  checked += 1;
}
assert.ok(checked > 30, `only ${checked} samples checked`);
console.log(`ok: ${packages.length} packages imported, ${checked} samples match parsedmarc`);
