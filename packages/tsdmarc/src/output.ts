// Port of parsedmarc's file output: `append_json`, `append_csv`,
// `save_output` and `get_report_zip` (parsedmarc/__init__.py).

import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  type FileHandle,
  opendir,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { zipSync, type Zippable, type ZipOptions } from 'fflate';

import { parsedAggregateReportsToCsv } from './aggregate';
import { parsedFailureReportsToCsv } from './failure';
import { errorText, PyValueError } from './internal/py';
import { pyJsonDumps } from './internal/py-json';
import { JSONDecodeError, pyJsonLoads } from './internal/py-json-loads';
import { logger } from './log';
import { toSnakeCaseKeys } from './serialize';
import { parsedSmtpTlsReportsToCsv } from './smtp-tls';
import type {
  AggregateReport,
  FailureReport,
  ParsingResults,
  SMTPTLSReport,
} from './types';
import { getFilenameSafeString, ValueError } from './utils/email';
import { pyDecode } from './utils/py-codecs';
import { sanitizeForLog } from './utils/sanitize';

export interface SaveOutputOptions {
  /** The path to the directory to save in (default `output`; `~` expands). */
  outputDirectory?: string;
  /** Filename for the aggregate JSON file (default `aggregate.json`). */
  aggregateJsonFilename?: string;
  /** Filename for the failure JSON file (default `failure.json`). */
  failureJsonFilename?: string;
  /** Filename for the SMTP TLS JSON file (default `smtp_tls.json`). */
  smtpTlsJsonFilename?: string;
  /** Filename for the aggregate CSV file (default `aggregate.csv`). */
  aggregateCsvFilename?: string;
  /** Filename for the failure CSV file (default `failure.csv`). */
  failureCsvFilename?: string;
  /** Filename for the SMTP TLS CSV file (default `smtp_tls.csv`). */
  smtpTlsCsvFilename?: string;
  /**
   * Prefix CSV text cells that a spreadsheet would run as a formula with
   * `'` (see `CsvOptions.formulaEscape`). Default true, like parsedmarc.
   */
  csvFormulaEscape?: boolean;
}

export interface GetReportZipOptions {
  /** See {@link SaveOutputOptions.csvFormulaEscape}. Default true. */
  csvFormulaEscape?: boolean;
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}

/** `os.stat()` that returns `null` where `os.path.exists()` is false. */
async function statOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath);
  } catch (error) {
    // os.path.exists() is False for any OSError (missing, broken link, ...).
    if (errorCode(error) !== undefined) {
      return null;
    }
    throw error;
  }
}

/** Python's `os.path.expanduser()` for `~` and `~/...`. */
function expandUser(filePath: string): string {
  if (filePath === '~' || filePath.startsWith('~/')) {
    return path.join(homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Files up to this size are parsed and rewritten, like parsedmarc. A larger
 * file that ends the way {@link appendJson} writes it only gets the new
 * entries spliced in: parsing it would take seconds per batch.
 */
const MAX_REWRITTEN_JSON_BYTES = 8 * 1024 * 1024;
/** The largest file ever parsed; V8 strings stop at 512 MiB of characters. */
const MAX_PARSED_JSON_BYTES = 256 * 1024 * 1024;
/** How `json.dump(reports, indent=2)` starts and ends a list of objects. */
const JSON_ARRAY_HEAD = '[\n  {';
const JSON_ARRAY_TAIL = '\n  }\n]';
/** The closing `\n]`, replaced when entries are spliced in. */
const JSON_ARRAY_CLOSE_BYTES = 2;
const COPY_CHUNK_BYTES = 1024 * 1024;
const TEMP_SUFFIX_BYTES = 6;
const PERMISSION_BITS = 0o7777;

/** One array element, laid out as `json.dump(list, indent=2)` writes it. */
function encodeJsonEntry(entry: unknown): string {
  try {
    return pyJsonDumps([entry], { ensureAscii: false, indent: 2 }).slice(2, -2);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ValueError(
        `Report too large for JSON output: ${error.message}`,
      );
    }
    throw error;
  }
}

/** Whether a file looks like what `json.dump(reports, indent=2)` writes. */
async function isJsonArrayOfObjects(
  filename: string,
  size: number,
): Promise<boolean> {
  const handle = await open(filename, 'r');
  try {
    const head = Buffer.alloc(JSON_ARRAY_HEAD.length);
    const tail = Buffer.alloc(JSON_ARRAY_TAIL.length);
    await handle.read(head, 0, head.length, 0);
    await handle.read(tail, 0, tail.length, size - tail.length);
    return (
      head.toString('latin1') === JSON_ARRAY_HEAD &&
      tail.toString('latin1') === JSON_ARRAY_TAIL
    );
  } finally {
    await handle.close();
  }
}

/** Copy the first `length` bytes of `filename`, without holding them all. */
async function copyFileStart(
  filename: string,
  length: number,
  output: FileHandle,
): Promise<void> {
  const input = await open(filename, 'r');
  try {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let remaining = length;
    while (remaining > 0) {
      // oxlint-disable-next-line no-await-in-loop -- bytes stay in order
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(remaining, buffer.length),
      );
      if (bytesRead === 0) {
        throw new ValueError(`${filename} shrank while being copied`);
      }
      // oxlint-disable-next-line no-await-in-loop -- bytes stay in order
      await output.writeFile(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
  } finally {
    await input.close();
  }
}

/**
 * Replace `filename` with what `write` produces: a temporary file in the same
 * directory, flushed, then renamed over it, so a crash or a full disk leaves
 * the old content whole. Symbolic links, the mode and (when allowed) the
 * owner are kept. Anything but a regular file (a FIFO, `/dev/stdout`) can't
 * be replaced and is written directly, like Python.
 */
async function replaceFile(
  filename: string,
  info: Stats | null,
  write: (output: FileHandle) => Promise<void>,
): Promise<void> {
  if (info !== null && !info.isFile()) {
    const output = await open(filename, 'w');
    try {
      await write(output);
    } finally {
      await output.close();
    }
    return;
  }
  const target = info === null ? filename : await realpath(filename);
  const suffix = randomBytes(TEMP_SUFFIX_BYTES).toString('hex');
  const tempPath = `${target}.${suffix}.tmp`;
  const output = await open(tempPath, 'wx');
  try {
    await write(output);
    if (info !== null) {
      await output.chmod(info.mode & PERMISSION_BITS);
      await output.chown(info.uid, info.gid).catch(() => undefined);
    }
    await output.sync();
    await output.close();
    await rename(tempPath, target);
  } catch (error) {
    await output.close().catch(() => undefined);
    await rm(tempPath, { force: true });
    throw error;
  }
}

/** Keep a file {@link appendJson} can't use next to it, and say so. */
async function setAsideJsonFile(
  filename: string,
  reason: string,
): Promise<void> {
  const aside = `${filename}.corrupt-${Date.now()}`;
  await rename(filename, aside);
  logger.warning(
    `${sanitizeForLog(filename)} ${reason}: moved to ${sanitizeForLog(aside)}, starting a new file`,
  );
}

/**
 * The entries of an existing JSON array to carry over, or `null` when the
 * file was moved aside (it holds no array that can be read).
 */
async function readJsonArray(
  filename: string,
  size: number,
): Promise<unknown[] | null> {
  if (size > MAX_PARSED_JSON_BYTES) {
    await setAsideJsonFile(filename, 'is too large to parse');
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(filename);
  } catch (error) {
    if (errorCode(error) === undefined) {
      throw error;
    }
    await setAsideJsonFile(filename, `is unreadable (${errorText(error)})`);
    return null;
  }
  // Strict UTF-8 like open(encoding="utf-8"): UnicodeDecodeError is not
  // caught by parsedmarc and propagates.
  const text = pyDecode(bytes, 'utf-8');
  try {
    // Exact numbers: json.dump() writes back what json.loads() read (big
    // ints, `1.0`, `NaN`), which JS numbers would change.
    const loaded: unknown = pyJsonLoads(text, { exactNumbers: true });
    if (Array.isArray(loaded)) {
      return loaded;
    }
    await setAsideJsonFile(filename, 'does not hold a JSON array');
    return null;
  } catch (error) {
    if (!(error instanceof JSONDecodeError)) {
      throw error;
    }
    await setAsideJsonFile(filename, 'is not valid JSON');
    return null;
  }
}

async function appendJsonEntries(
  filename: string,
  reports: readonly unknown[],
): Promise<void> {
  const entries = reports.map(report => toSnakeCaseKeys(report));
  const info = await statOrNull(filename);
  let existing: unknown[] = [];
  let keptBytes = 0;
  if (info?.isFile() && info.size > 0) {
    if (
      info.size > MAX_REWRITTEN_JSON_BYTES &&
      (await isJsonArrayOfObjects(filename, info.size))
    ) {
      keptBytes = info.size - JSON_ARRAY_CLOSE_BYTES;
    } else {
      existing = (await readJsonArray(filename, info.size)) ?? [];
    }
  }

  // Stat again: a file that couldn't be used has been moved aside.
  await replaceFile(filename, await statOrNull(filename), async output => {
    // json.dump(merged, output, ensure_ascii=False, indent=2), one entry at
    // a time: the whole array may not fit in a string.
    let separator = '[\n';
    if (keptBytes > 0) {
      await copyFileStart(filename, keptBytes, output);
      separator = ',\n';
    }
    for (const entry of [...existing, ...entries]) {
      // oxlint-disable-next-line no-await-in-loop -- bytes stay in order
      await output.writeFile(`${separator}${encodeJsonEntry(entry)}`, 'utf-8');
      separator = ',\n';
    }
    await output.writeFile('\n]', 'utf-8');
  });
}

/** Tails of the {@link appendJson} calls running, by absolute path. */
const jsonAppends = new Map<string, Promise<void>>();

/**
 * Append `reports` to a JSON array on disk, creating the file if needed.
 *
 * Reads the existing array (if the file exists and parses cleanly), merges
 * the new reports onto the end, and replaces the file with a single valid
 * JSON array (indented by 2, keys in snake_case like parsedmarc's output).
 * A file above {@link MAX_REWRITTEN_JSON_BYTES} that already has that layout
 * keeps its bytes and only gets the new entries, which gives the same result.
 * A file that can't be used (corrupt, unreadable, a root that is not an
 * array) is moved to `<filename>.corrupt-<timestamp>` with a warning, never
 * discarded. An empty `reports` leaves the file alone (and creates nothing).
 * Calls for one file run in turn; other processes are not coordinated with.
 *
 * Throws `ValueError` when a single report is too large to serialize.
 */
export async function appendJson(
  filename: string,
  reports:
    | readonly AggregateReport[]
    | readonly FailureReport[]
    | readonly SMTPTLSReport[],
): Promise<void> {
  if (reports.length === 0) {
    // Don't create an empty-array file for an empty input; if a file
    // already exists, leave it alone.
    return;
  }

  const key = path.resolve(filename);
  const previous = jsonAppends.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => appendJsonEntries(filename, reports));
  jsonAppends.set(key, current);
  try {
    await current;
  } finally {
    if (jsonAppends.get(key) === current) {
      jsonAppends.delete(key);
    }
  }
}

/**
 * Append CSV text to a file. When the file already has content, the header
 * line of `csv` is dropped; a header-only `csv` then writes nothing.
 */
export async function appendCsv(filename: string, csv: string): Promise<void> {
  // "a+" like Python: creates the file, and every write goes to the end.
  const handle = await open(filename, 'a+');
  try {
    let text = csv;
    const { size } = await handle.stat();
    if (size !== 0) {
      // strip the headers from the CSV
      const newline = text.indexOf('\n');
      if (newline === -1) {
        // Python's `_headers, csv = csv.split("\n", 1)`
        throw new PyValueError(
          'not enough values to unpack (expected 2, got 1)',
        );
      }
      text = text.slice(newline + 1);
      if (text.length === 0) {
        // not appending anything, don't do any dance to append it correctly
        return;
      }
    }
    await handle.writeFile(text, 'utf-8');
  } finally {
    await handle.close();
  }
}

/** Numbered names tried for a sample before a random one is used. */
const MAX_SAMPLE_NAME_PROBES = 1000;

/**
 * Write `sample` to a file that doesn't exist yet, named `<subject>.eml`,
 * then `<subject> (1).eml`, … A sender repeats a subject at will, so an
 * existing sample is never reused, and a long run of one subject stops
 * probing. Returns the name used, without the extension.
 */
async function writeNewSample(
  directory: string,
  subject: string,
  sample: string,
): Promise<string> {
  for (let count = 0; ; count += 1) {
    let filename = subject;
    if (count > MAX_SAMPLE_NAME_PROBES) {
      filename = `${subject} (${randomBytes(TEMP_SUFFIX_BYTES).toString('hex')})`;
    } else if (count > 0) {
      filename = `${subject} (${count})`;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- each name depends on the last
      await writeFile(path.join(directory, `${filename}.eml`), sample, {
        encoding: 'utf-8',
        flag: 'wx',
      });
      return filename;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
    }
  }
}

/**
 * Save report data in the given directory.
 *
 * Writes the JSON and CSV files of each report type, then the message
 * sample of each failure report to a `samples` subdirectory, named after the
 * sample's own `subject` header run through {@link getFilenameSafeString},
 * falling back to `sample` when sanitizing leaves nothing. A subject comes
 * from an untrusted sender, so it is sanitized here, at write time; a
 * caller-supplied `filenameSafeSubject` is not trusted and not used. Names
 * that collide, in this call or with a file already there, get a ` (1)`,
 * ` (2)`, … suffix.
 *
 * Throws `ValueError` if `outputDirectory` exists and is not a directory.
 */
export async function saveOutput(
  results: ParsingResults,
  options: SaveOutputOptions = {},
): Promise<void> {
  const {
    aggregateJsonFilename = 'aggregate.json',
    failureJsonFilename = 'failure.json',
    smtpTlsJsonFilename = 'smtp_tls.json',
    aggregateCsvFilename = 'aggregate.csv',
    failureCsvFilename = 'failure.csv',
    smtpTlsCsvFilename = 'smtp_tls.csv',
  } = options;
  const { aggregateReports, failureReports, smtpTlsReports } = results;
  const outputDirectory = expandUser(options.outputDirectory ?? 'output');
  const csvOptions = { formulaEscape: options.csvFormulaEscape !== false };

  const outputInfo = await statOrNull(outputDirectory);
  if (outputInfo === null) {
    await mkdir(outputDirectory, { recursive: true });
  } else if (!outputInfo.isDirectory()) {
    throw new ValueError(`${outputDirectory} is not a directory`);
  }

  // Flattened before the first write: a report that can't be flattened
  // would otherwise leave its JSON appended, and a copy more on each retry.
  const aggregateCsv = parsedAggregateReportsToCsv(
    aggregateReports,
    csvOptions,
  );
  const failureCsv = parsedFailureReportsToCsv(failureReports, csvOptions);
  const smtpTlsCsv = parsedSmtpTlsReportsToCsv(smtpTlsReports, csvOptions);

  await appendJson(
    path.join(outputDirectory, aggregateJsonFilename),
    aggregateReports,
  );
  await appendCsv(
    path.join(outputDirectory, aggregateCsvFilename),
    aggregateCsv,
  );
  await appendJson(
    path.join(outputDirectory, failureJsonFilename),
    failureReports,
  );
  await appendCsv(path.join(outputDirectory, failureCsvFilename), failureCsv);
  await appendJson(
    path.join(outputDirectory, smtpTlsJsonFilename),
    smtpTlsReports,
  );
  await appendCsv(path.join(outputDirectory, smtpTlsCsvFilename), smtpTlsCsv);

  const samplesDirectory = path.join(outputDirectory, 'samples');
  if ((await statOrNull(samplesDirectory)) === null) {
    await mkdir(samplesDirectory, { recursive: true });
  }

  for (const failureReport of failureReports) {
    const { sample, parsedSample } = failureReport;
    const subject =
      getFilenameSafeString(parsedSample.subject ?? null) || 'sample';
    try {
      await writeNewSample(samplesDirectory, subject, sample);
    } catch (error) {
      if (subject === 'sample') {
        throw error;
      }
      // A name the filesystem refuses (too long, invalid encoding) must not
      // lose the batch's other output: fall back to the generic name.
      const fallback = await writeNewSample(samplesDirectory, 'sample', sample);
      logger.warning(
        `Could not write sample ${sanitizeForLog(JSON.stringify(subject))}.eml ` +
          `(${errorText(error)}); writing it as ${fallback}.eml instead`,
      );
    }
  }
}

interface WalkEntry {
  root: string;
  dirs: string[];
  files: string[];
}

/** Entries of a directory in on-disk order, like `os.scandir()`. */
async function scanDirectory(directory: string): Promise<WalkEntry> {
  const dirs: string[] = [];
  const files: string[] = [];
  // opendir() keeps the directory's own order (readdir() sorts names).
  for await (const entry of await opendir(directory)) {
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    } else {
      files.push(entry.name);
    }
  }
  return { root: directory, dirs, files };
}

/**
 * Python's `os.walk(top)`: top-down, a directory before its children.
 *
 * @yields {WalkEntry} Each directory with its subdirectory and file names.
 */
async function* walk(top: string): AsyncGenerator<WalkEntry> {
  let entry: WalkEntry;
  try {
    entry = await scanDirectory(top);
  } catch {
    // os.walk() ignores errors by default.
    return;
  }
  yield entry;
  for (const directory of entry.dirs) {
    yield* walk(path.join(top, directory));
  }
}

/** The arcname `zipfile.ZipInfo.from_file()` stores (normalized, relative). */
function zipArcname(arcname: string, isDirectory: boolean): string {
  let name = path.normalize(arcname);
  while (name.startsWith('/')) {
    name = name.slice(1);
  }
  return isDirectory ? `${name}/` : name;
}

const ZIP_UNIX = 3;
const MS_DOS_DIRECTORY = 0x10;
const MODE_MASK = 0xff_ff;
const ATTRS_SHIFT = 0x1_00_00;

/** Python's `ZipFile.write(filename, arcname)` with `ZIP_DEFLATED`. */
async function addToZip(
  entries: [string, Zippable[string]][],
  filePath: string,
  arcname: string,
): Promise<void> {
  const info = await stat(filePath);
  const isDirectory = info.isDirectory();
  // (st_mode & 0xFFFF) << 16, plus the MS-DOS directory flag for folders.
  let attrs = (info.mode & MODE_MASK) * ATTRS_SHIFT;
  if (isDirectory) {
    attrs += MS_DOS_DIRECTORY;
  }
  const options: ZipOptions = {
    os: ZIP_UNIX,
    attrs,
    mtime: info.mtime,
    // Directories are stored, files deflated at zlib's default level.
    level: isDirectory ? 0 : 6,
  };
  const data = isDirectory ? new Uint8Array(0) : await readFile(filePath);
  entries.push([zipArcname(arcname, isDirectory), [data, options]]);
}

async function isFile(filePath: string): Promise<boolean> {
  return (await statOrNull(filePath))?.isFile() ?? false;
}

async function isDirectory(filePath: string): Promise<boolean> {
  return (await statOrNull(filePath))?.isDirectory() ?? false;
}

/**
 * Creates a zip file of parsed report output: {@link saveOutput} into a
 * temporary directory, then every file in it.
 *
 * The layout is parsedmarc's, except that parsedmarc also stores each file
 * of `samples/` a second time as `../<name>` (its `add_subdir()` swaps the
 * `relpath` arguments). Those entries point outside the extraction
 * directory, a path-traversal risk for whoever unzips the attachment, so
 * they are left out; every file is still in the zip once.
 */
export async function getReportZip(
  results: ParsingResults,
  options: GetReportZipOptions = {},
): Promise<Uint8Array> {
  const entries: [string, Zippable[string]][] = [];

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'tmp'));
  try {
    await saveOutput(results, {
      outputDirectory: tmpDir,
      csvFormulaEscape: options.csvFormulaEscape !== false,
    });
    for await (const { root, dirs, files } of walk(tmpDir)) {
      for (const file of files) {
        const filePath = path.join(root, file);
        if (await isFile(filePath)) {
          const arcname = path.join(path.relative(tmpDir, root) || '.', file);
          await addToZip(entries, filePath, arcname);
        }
      }
      for (const directory of dirs) {
        const dirPath = path.join(root, directory);
        if (await isDirectory(dirPath)) {
          await addToZip(entries, dirPath, directory);
        }
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  // zipSync keeps insertion order. parsedmarc's layout never repeats a name
  // (zipfile would store a duplicate twice; an object can hold it once).
  return zipSync(Object.fromEntries(entries));
}
