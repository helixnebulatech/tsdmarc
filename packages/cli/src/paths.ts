// File path helpers of the CLI: `_expand_path`, `_expand_file_path_args`
// and `_exclude_archived_paths`.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

import { logger } from 'tsdmarc';

import { glob, globEscape, sortByCodePoint } from './glob';

const ENV_VAR = /\$(\w+|\{[^}]*\})/gu;

/** Python's `os.path.expandvars()`: unknown variables are left as they are. */
export function expandVars(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!value.includes('$')) {
    return value;
  }
  return value.replace(ENV_VAR, (match: string, name: string) => {
    const key = name.startsWith('{') ? name.slice(1, -1) : name;
    const replacement = env[key];
    return replacement === undefined ? match : replacement;
  });
}

/** Python's `os.path.expanduser()` on POSIX. */
export function expandUser(value: string): string {
  if (!value.startsWith('~')) {
    return value;
  }
  let end = value.indexOf(path.sep, 1);
  if (end < 0) {
    end = value.length;
  }
  const user = value.slice(1, end);
  let home: string;
  if (user) {
    // Only the current user's home directory can be looked up in Node.
    let current: string | null = null;
    try {
      current = userInfo().username;
    } catch {
      current = null;
    }
    if (user !== current) {
      return value;
    }
    home = homedir();
  } else {
    home = process.env.HOME ?? homedir();
  }
  const trimmed = home.endsWith(path.sep) ? home.replace(/\/+$/u, '') : home;
  return trimmed + value.slice(end) || path.sep;
}

/** Expand `~` and `$VAR` references in a file path. */
export function expandPath(value: string): string {
  return expandUser(expandVars(value));
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** Python's `os.path.join()` (no normalization). */
function pyJoin(dirname: string, basename: string): string {
  if (!dirname || dirname.endsWith(path.sep)) {
    return dirname + basename;
  }
  return `${dirname}${path.sep}${basename}`;
}

/**
 * Expand CLI file-path arguments into a flat list of file paths.
 *
 * An existing file is taken literally, an existing directory expands to the
 * files inside it (`<dir>/*`, or `<dir>/**` when `recursive`), and only a
 * path that does not exist is treated as a glob pattern, so literal names
 * with glob metacharacters (`[Provider DMARC Failure Report] x.eml`) are
 * never dropped. An argument that matches nothing is logged as a warning.
 */
export function expandFilePathArgs(
  paths: readonly string[],
  recursive = false,
): string[] {
  const expanded: string[] = [];
  for (const filePath of paths) {
    const before = expanded.length;
    if (isDirectory(filePath)) {
      const pattern = pyJoin(globEscape(filePath), recursive ? '**' : '*');
      for (const match of sortByCodePoint(glob(pattern, recursive))) {
        if (isFile(match)) {
          expanded.push(match);
        } else if (!recursive && isDirectory(match)) {
          logger.debug(
            `Skipping subdirectory ${match} (pass --recursive to descend)`,
          );
        }
      }
    } else if (existsSync(filePath)) {
      expanded.push(filePath);
    } else {
      expanded.push(...glob(filePath, recursive));
    }
    if (expanded.length === before) {
      logger.warning(`No files matched ${filePath}`);
    }
  }
  return expanded;
}

/**
 * Python's `os.path.realpath()` (non-strict): symlinks in the existing part
 * of the path are resolved, a missing remainder is appended as-is.
 */
export function realpath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) {
      return absolute;
    }
    return path.join(realpath(parent), path.basename(absolute));
  }
}

/**
 * Python's `os.path.commonpath([a, b]) == a` for absolute paths: whether
 * `target` is `root` or inside it. Paths on different roots (Windows
 * drives) are not comparable and give `false`.
 */
function isInside(root: string, target: string): boolean {
  if (path.parse(root).root !== path.parse(target).root) {
    return false;
  }
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

/**
 * Filter `filePaths` down to paths that are not already inside
 * `archiveDirectory`, so files archived by a previous run inside an input
 * directory are not parsed and archived again. Both sides are resolved with
 * `realpath`, so a symlinked spelling of either still matches.
 */
export function excludeArchivedPaths(
  filePaths: readonly string[],
  archiveDirectory: string,
): string[] {
  const archiveRoot = realpath(archiveDirectory);
  const kept: string[] = [];
  for (const filePath of filePaths) {
    const absPath = realpath(filePath);
    if (isInside(archiveRoot, absPath)) {
      logger.debug(`Excluding already-archived file ${filePath}`);
      continue;
    }
    kept.push(filePath);
  }
  return kept;
}
