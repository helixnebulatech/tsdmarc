// prepack script of every published Apache-2.0 package: copies the repo's
// LICENSE and NOTICE into the package directory so the tarball carries the
// Apache-2.0 §4(d) attributions (the copies are gitignored).
// @tsdmarc/ipinfo-lite ships its own CC BY-SA 4.0 LICENSE/NOTICE instead.
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.cwd();
if (path.resolve(target) === root) {
  throw new Error('license-files.mjs must run from a package directory');
}
for (const name of ['LICENSE', 'NOTICE']) {
  copyFileSync(path.join(root, name), path.join(target, name));
}
