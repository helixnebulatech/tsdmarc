// Bundled data files (parsedmarc's `importlib.resources.files(...)`).
//
// The CSV/TXT maps ship in this package's `resources/` directory. This
// module runs from `src/utils/` (tests) or from the bundled `dist/index.js`,
// so the package root is found by walking up from this file until a
// directory containing `resources/base_reverse_dns_map.csv` appears.
//
// The IPinfo Lite MMDB is large, so it lives in the optional
// `@tsdmarc/ipinfo-lite` package and is found with a dynamic import.

import { existsSync } from 'node:fs';
import path from 'node:path';

const MARKER_FILE = path.join('resources', 'base_reverse_dns_map.csv');

let packageRoot: string | null = null;

/** The tsdmarc package root (the directory holding `resources/`). */
export function getPackageRoot(): string {
  if (packageRoot !== null) {
    return packageRoot;
  }
  let directory = import.meta.dirname;
  for (;;) {
    if (existsSync(path.join(directory, MARKER_FILE))) {
      packageRoot = directory;
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(
        `Could not find the tsdmarc resources directory above ${import.meta.filename}`,
      );
    }
    directory = parent;
  }
}

/** Absolute path of a bundled resource file, e.g. `psl_overrides.txt`. */
export function getResourcePath(name: string): string {
  return path.join(getPackageRoot(), 'resources', name);
}

let ipinfoLitePath: Promise<string | null> | null = null;

/**
 * Path of the MMDB file shipped by `@tsdmarc/ipinfo-lite`, or `null` when
 * that optional package is not installed.
 */
export function getBundledIpDbPath(): Promise<string | null> {
  ipinfoLitePath ??= import('@tsdmarc/ipinfo-lite').then(
    (module: { ipinfoLiteDbPath: string }) => module.ipinfoLiteDbPath,
    () => null,
  );
  return ipinfoLitePath;
}
