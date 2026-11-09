// @ts-check

// Creates a GitHub Release (and its `name@version` tag, at the released
// commit) for each package of this commit that is on npm, with the package's
// CHANGELOG.md section as the notes. Changesets' own action does this when it
// publishes; here publishing runs in a separate, read-only job, so this job
// does it afterwards. Releases that already exist are left as is.
//
// The list comes from npm, not from what the publish job did, so that a
// partial publish gets its releases and a re-run catches up. The exception is
// PUBLISHED_PACKAGES: what a successful publish job reports may take a moment
// to show up in the registry.
//
// Outputs `packages`, the JSON list of `{ name, version }` on npm.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isOnNpm, publishablePackages } from './release-lib.mjs';

const justPublished = new Set(
  JSON.parse(process.env.PUBLISHED_PACKAGES || '[]').map(({ name, version }) => `${name}@${version}`),
);
const commit = process.env.GITHUB_SHA;

/** The `## version` section of a changesets CHANGELOG.md. */
const changelogSection = (directory, version) => {
  let text;
  try {
    text = readFileSync(path.join(directory, 'CHANGELOG.md'), 'utf8');
  } catch {
    return '';
  }
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.trim() === `## ${version}`);
  if (start === -1) return '';
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith('## '),
  );
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
};

const gh = args => execFileSync('gh', args, { stdio: 'pipe' }).toString();

const packages = [];
for (const release of publishablePackages()) {
  if (justPublished.has(`${release.name}@${release.version}`) || (await isOnNpm(release))) {
    packages.push(release);
  } else {
    console.log(`${release.name}@${release.version}: not on npm`);
  }
}

let failures = 0;
for (const { name, version, directory } of packages) {
  const tag = `${name}@${version}`;
  try {
    try {
      gh(['release', 'view', tag]);
      console.log(`${tag}: release already exists`);
      continue;
    } catch {
      // not found: create it
    }
    const notes = changelogSection(directory, version) || `Published ${tag} to npm.`;
    gh([
      'release',
      'create',
      tag,
      '--title',
      tag,
      '--notes',
      notes,
      '--target',
      String(commit),
      // the core package is the one GitHub shows as "Latest"
      `--latest=${name === 'tsdmarc'}`,
    ]);
    console.log(`${tag}: release created`);
  } catch (error) {
    failures++;
    console.log(`::error::Could not create the release for ${tag}: ${error}`);
  }
}

if (process.env.GITHUB_OUTPUT) {
  const list = packages.map(({ name, version }) => ({ name, version }));
  appendFileSync(process.env.GITHUB_OUTPUT, `packages=${JSON.stringify(list)}\n`);
}

if (failures > 0) process.exit(1);
