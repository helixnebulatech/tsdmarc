// Packs every published package (after `pnpm build:packages`) and checks the
// tarball: LICENSE and NOTICE present with the right license, every file the
// manifest points at (main, types, exports, bin) included, and no
// `workspace:` ranges left in the packed package.json.
//
//   node tools/pack-check.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apacheLicense = readFileSync(path.join(root, 'LICENSE'), 'utf8');
const rootNotice = readFileSync(path.join(root, 'NOTICE'), 'utf8');

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}:\n${result.stderr}${result.stdout}`);
  }
  return result.stdout;
};

/** Every relative file path a manifest field points at. */
const manifestTargets = manifest => {
  const targets = new Set();
  const walk = value => {
    if (typeof value === 'string') {
      if (value.startsWith('./') && !value.includes('*')) {
        targets.add(path.posix.normalize(value));
      }
    } else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) {
        walk(nested);
      }
    }
  };
  walk(manifest.main && `./${path.posix.normalize(manifest.main)}`);
  walk(manifest.types && `./${path.posix.normalize(manifest.types)}`);
  walk(manifest.exports);
  walk(manifest.bin);
  return [...targets];
};

const checkPackage = (dir, scratch) => {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const problems = [];
  const output = run('pnpm', ['pack', '--json', '--pack-destination', scratch], dir);
  const { filename } = JSON.parse(output.slice(output.indexOf('{')));
  const extractDir = path.join(scratch, manifest.name.replace('/', '__'));
  mkdirSync(extractDir, { recursive: true });
  run('tar', ['-xzf', path.resolve(scratch, path.basename(filename)), '-C', extractDir], scratch);
  const packed = path.join(extractDir, 'package');
  const read = name => {
    try {
      return readFileSync(path.join(packed, name), 'utf8');
    } catch {
      problems.push(`missing ${name}`);
      return '';
    }
  };

  const license = read('LICENSE');
  const notice = read('NOTICE');
  if (manifest.license === 'Apache-2.0') {
    if (license !== apacheLicense) {
      problems.push('LICENSE is not the repo Apache-2.0 LICENSE');
    }
    if (notice !== rootNotice) {
      problems.push('NOTICE is not the repo NOTICE');
    }
  } else if (manifest.license === 'CC-BY-SA-4.0') {
    if (!license.startsWith('Attribution-ShareAlike 4.0 International')) {
      problems.push('LICENSE is not the CC BY-SA 4.0 legal code');
    }
    if (!notice.includes('IPinfo')) {
      problems.push('NOTICE does not credit IPinfo');
    }
  } else {
    problems.push(`unexpected license ${manifest.license}`);
  }

  for (const target of manifestTargets(manifest)) {
    if (target !== 'package.json') {
      read(target);
    }
  }
  if (read('package.json').includes('workspace:')) {
    problems.push('packed package.json still has workspace: ranges');
  }
  return { name: manifest.name, problems };
};

const scratch = mkdtempSync(path.join(tmpdir(), 'tsdmarc-pack-'));
let failed = false;
try {
  for (const entry of readdirSync(path.join(root, 'packages')).sort()) {
    const dir = path.join(root, 'packages', entry);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (manifest.private) {
      continue;
    }
    const { name, problems } = checkPackage(dir, scratch);
    if (problems.length > 0) {
      failed = true;
      console.error(`✗ ${name}\n  ${problems.join('\n  ')}`);
    } else {
      console.log(`✓ ${name}`);
    }
  }
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
process.exit(failed ? 1 : 0);
