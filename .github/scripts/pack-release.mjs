// @ts-check

// Packs every package whose version isn't on npm yet into `release-tarballs/`,
// after the build, with a `manifest.json` (name, version, file, SHA-256) in
// publish order. `pnpm pack` does what `pnpm publish` would do to the
// manifest (`workspace:` ranges) and runs `prepack`.
//
// Outputs `packages`, the JSON list of `{ name, version }`, and shows the
// hashes in the job summary, for whoever approves the Release environment.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isOnNpm, publishablePackages } from './release-lib.mjs';

const destination = path.resolve('release-tarballs');
mkdirSync(destination, { recursive: true });

const manifest = [];
for (const release of publishablePackages()) {
  const { name, version, directory } = release;
  if (await isOnNpm(release)) {
    console.log(`${name}@${version}: already on npm`);
    continue;
  }
  const output = execFileSync('pnpm', ['pack', '--json', '--pack-destination', destination], {
    cwd: directory,
    encoding: 'utf8',
  });
  const file = path.basename(JSON.parse(output.slice(output.indexOf('{'))).filename);
  const sha256 = createHash('sha256')
    .update(readFileSync(path.join(destination, file)))
    .digest('hex');
  manifest.push({ name, version, file, sha256 });
  console.log(`${name}@${version}: packed ${file} (sha256 ${sha256})`);
}

writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const packages = manifest.map(({ name, version }) => ({ name, version }));
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `packages=${JSON.stringify(packages)}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = manifest.map(({ name, version, sha256 }) => `| ${name} | ${version} | \`${sha256}\` |`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Tarballs to publish\n\n| Package | Version | SHA-256 |\n| --- | --- | --- |\n${rows.join('\n')}\n`,
  );
}
