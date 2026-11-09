// @ts-check

// Prints the published packages' package.json files that a PR changes in a
// way that reaches npm users (dependencies, exports, engines, ...), so they
// need a changeset. devDependencies and scripts are left out: they don't
// affect what is installed, and Dependabot's development group only changes
// those.
//
//   node .github/scripts/changed-manifests.mjs <base commit>

import { execFileSync } from 'node:child_process';

const MANIFEST = /^packages\/[^/]+\/package\.json$/;

const base = process.argv[2];
if (!base) {
  throw new Error('Usage: changed-manifests.mjs <base commit>');
}

const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' });

/** The manifest at a commit, or null if the file doesn't exist there. */
const readManifest = (commit, file) => {
  try {
    return JSON.parse(git(['show', `${commit}:${file}`]));
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    return null;
  }
};

/** What npm users get from a manifest. */
const publishedFields = manifest => {
  if (manifest === null) return 'null';
  const { devDependencies: _devDependencies, scripts: _scripts, ...fields } = manifest;
  return JSON.stringify(fields);
};

const changed = git(['diff', '--name-only', base, 'HEAD', '--', 'packages/*/package.json'])
  .split('\n')
  .filter(file => MANIFEST.test(file));

for (const file of changed) {
  const before = readManifest(base, file);
  const after = readManifest('HEAD', file);
  const isPrivate = (after ?? before)?.private === true;
  if (!isPrivate && publishedFields(before) !== publishedFields(after)) {
    console.log(file);
  }
}
