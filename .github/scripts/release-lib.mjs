// @ts-check

// What the release scripts share: the packages this commit releases and
// whether a version is already on npm.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REGISTRY = (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
const REGISTRY_TIMEOUT_MS = 30_000;

/**
 * Packages in `packages/` that aren't private, dependencies first, so that a
 * failed publish never leaves a package on npm without its dependencies.
 *
 * @returns {{ name: string, version: string, directory: string }[]}
 */
export const publishablePackages = () => {
  const manifests = new Map();
  for (const entry of readdirSync('packages', { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join('packages', entry.name);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) throw error;
      continue; // not a package
    }
    if (!manifest.private) manifests.set(manifest.name, { ...manifest, directory });
  }

  const sorted = [];
  const visited = new Set();
  const visit = name => {
    const manifest = manifests.get(name);
    if (!manifest || visited.has(name)) return;
    visited.add(name);
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      visit(dependency);
    }
    sorted.push({ name, version: manifest.version, directory: manifest.directory });
  };
  for (const name of [...manifests.keys()].sort()) visit(name);
  return sorted;
};

/** Throws unless npm gives a clear answer: a registry outage isn't "not published". */
export const isOnNpm = async ({ name, version }) => {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}/${version}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw new Error(`${url}: unexpected status ${response.status}`);
};
