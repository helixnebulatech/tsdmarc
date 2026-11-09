// @ts-check

// Publishes the tarballs in `release-tarballs/` with npm, in manifest order.
// This runs next to the OIDC token, so it installs nothing and runs nothing
// from the workspace or the tarballs (`--ignore-scripts`): only this script,
// from a sparse checkout, and npm.
//
// Versions already on npm are skipped, so a re-run finishes a partial publish.
// The first failure stops it: later packages may depend on the failed one.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isOnNpm } from './release-lib.mjs';

const directory = path.resolve('release-tarballs');
const tag = process.env.NPM_DIST_TAG || 'latest';
const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));

// All of them first, so that a bad artifact publishes nothing.
for (const { name, version, file, sha256 } of manifest) {
  const actual = createHash('sha256')
    .update(readFileSync(path.join(directory, path.basename(file))))
    .digest('hex');
  if (actual !== sha256) {
    throw new Error(`${name}@${version}: SHA-256 of ${file} is ${actual}, expected ${sha256}`);
  }
}

for (const release of manifest) {
  const { name, version, file } = release;
  if (await isOnNpm(release)) {
    console.log(`${name}@${version}: already on npm`);
    continue;
  }
  const tarball = path.join(directory, path.basename(file));
  execFileSync('npm', ['publish', tarball, '--ignore-scripts', '--tag', tag], { stdio: 'inherit' });
  console.log(`${name}@${version}: published`);
}
