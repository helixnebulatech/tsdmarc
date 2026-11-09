// Archiving of processed input files (`archive_directory`):
// `_archive_subdir_for_result`, `_move_file_to_archive` and
// `_archive_processed_file`.

import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
} from 'node:fs';
import path from 'node:path';

import {
  humanTimestampToDatetime,
  logger,
  type ParsedReport,
  ParserError,
  sanitizeForLog,
} from 'tsdmarc';

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}

/** Python's `str(exception)`: the message, or the repr of a `KeyError` key. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class MissingKey extends Error {
  override name = 'KeyError';

  constructor(key: string) {
    super(`'${key}'`);
  }
}

/** Python's `dict[key]`: a missing key or a non-dict raises. */
function item(value: unknown, key: string, pyKey: string): unknown {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(
      `${value === null || value === undefined ? "'NoneType'" : `'${typeof value}'`} object is not subscriptable`,
    );
  }
  if (!(key in value)) {
    throw new MissingKey(pyKey);
  }
  return (value as Record<string, unknown>)[key];
}

/**
 * The `<year>/<month>/<type folder>` subdirectory a parsed report's source
 * file is archived under, or `null` when the report type is unknown or its
 * date can't be determined. The date comes from the report itself:
 * aggregate `report_metadata.begin_date`, failure `arrival_date_utc` and
 * SMTP TLS `begin_date`.
 */
export function archiveSubdirForResult(result: ParsedReport): string | null {
  const reportType: string = result.reportType;
  // Aggregate begin_date is local time and must stay naive;
  // arrival_date_utc is UTC wall-clock.
  let assumeUtc = false;
  let typeFolder: string;
  let dateString: unknown;
  try {
    if (reportType === 'aggregate') {
      typeFolder = 'Aggregate';
      const metadata = item(
        item(result, 'report', 'report'),
        'reportMetadata',
        'report_metadata',
      );
      dateString = item(metadata, 'beginDate', 'begin_date');
    } else if (reportType === 'failure') {
      typeFolder = 'Failure';
      dateString = item(
        item(result, 'report', 'report'),
        'arrivalDateUtc',
        'arrival_date_utc',
      );
      assumeUtc = true;
    } else if (reportType === 'smtp_tls') {
      typeFolder = 'SMTP-TLS';
      dateString = item(
        item(result, 'report', 'report'),
        'beginDate',
        'begin_date',
      );
    } else {
      logger.warning(
        `Cannot archive unknown report type: ${sanitizeForLog(reportType)}`,
      );
      return null;
    }
    if (typeof dateString !== 'string') {
      throw new TypeError(
        `expected string, got ${dateString === null || dateString === undefined ? 'NoneType' : typeof dateString}`,
      );
    }
    const datetime = humanTimestampToDatetime(dateString, { assumeUtc });
    return path.join(
      String(datetime.year).padStart(4, '0'),
      String(datetime.month).padStart(2, '0'),
      typeFolder,
    );
  } catch (error) {
    // The date (and so the parser's error message) comes from the report.
    logger.warning(
      `Cannot determine archive date for ${reportType} report: ${sanitizeForLog(errorMessage(error))}`,
    );
    return null;
  }
}

/** `shutil.move()` onto an existing placeholder: rename, else copy2 + unlink. */
function move(source: string, destination: string): void {
  try {
    renameSync(source, destination);
    return;
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') {
      throw error;
    }
  }
  // Cross-device: copy the data and metadata, then remove the source.
  copyFileSync(source, destination);
  const stats = statSync(source);
  chmodSync(destination, stats.mode);
  utimesSync(destination, stats.atime, stats.mtime);
  unlinkSync(source);
}

/**
 * Move `filePath` into `destDir` (created if needed) and return the final
 * path. An existing file is never overwritten: `name-1.xml`, `name-2.xml`,
 * ... are tried instead. Each candidate is claimed atomically with an
 * exclusive-create placeholder (mode 0600) before the move, so concurrent
 * runs sharing an archive directory cannot collide.
 */
export function moveFileToArchive(filePath: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const basename = path.basename(filePath);
  const ext = path.extname(basename);
  const base = basename.slice(0, basename.length - ext.length);
  let candidate = basename;
  let n = 1;
  let destPath: string;
  for (;;) {
    destPath = path.join(destDir, candidate);
    try {
      closeSync(openSync(destPath, 'wx', 0o600));
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      candidate = `${base}-${n}${ext}`;
      n += 1;
    }
  }

  try {
    move(filePath, destPath);
  } catch (error) {
    try {
      unlinkSync(destPath);
    } catch {
      // Best-effort cleanup of the placeholder; the move error matters.
    }
    throw error;
  }
  return destPath;
}

/**
 * Move `filePath` into `archiveDirectory` after processing.
 *
 * Parse failures (`ParserError`) go to `Invalid/`; other errors (a
 * transient read error, a bug) leave the file in place so a later run can
 * retry it. Parsed reports go to the dated subdirectory from
 * {@link archiveSubdirForResult}, or stay in place when it is `null`. A
 * move failure is logged and never aborts the run.
 */
export function archiveProcessedFile(
  filePath: string,
  archiveDirectory: string,
  result: ParsedReport | Error,
): void {
  let subdir: string | null;
  if (result instanceof ParserError) {
    subdir = 'Invalid';
  } else if (result instanceof Error) {
    logger.debug(
      `Leaving ${sanitizeForLog(filePath)} in place: ${result.name} is not ` +
        'a report-parsing failure, so it may be retryable',
    );
    return;
  } else {
    subdir = archiveSubdirForResult(result);
    if (subdir === null) {
      return;
    }
  }

  const destDir = path.join(archiveDirectory, subdir);
  let destPath: string;
  try {
    destPath = moveFileToArchive(filePath, destDir);
  } catch (error) {
    logger.error(
      `Error moving ${sanitizeForLog(filePath)} to the archive: ${sanitizeForLog(errorMessage(error))}`,
    );
    return;
  }
  logger.debug(
    `Archived ${sanitizeForLog(filePath)} to ${sanitizeForLog(destPath)}`,
  );
}
