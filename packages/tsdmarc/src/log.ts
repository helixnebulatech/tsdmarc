// Minimal Python-style logging, ported from how parsedmarc uses `logging`.
//
// parsedmarc logs through named loggers with handlers (stream, file, syslog,
// GELF) and filters, and its tests capture records with `assertLogs`. This
// module provides the same model: `getLogger(name)` returns a shared
// `Logger`, handlers receive `LogRecord`s, and `captureLogs()` replaces
// `assertLogs`. Library loggers are silent until a handler is attached, like
// parsedmarc's `NullHandler` default.

import { closeSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';

import { sanitizeForLog } from './utils/sanitize';

export const NOTSET = 0;
export const DEBUG = 10;
export const INFO = 20;
export const WARNING = 30;
export const ERROR = 40;
export const CRITICAL = 50;

const LEVEL_NAMES: ReadonlyMap<number, string> = new Map([
  [NOTSET, 'NOTSET'],
  [DEBUG, 'DEBUG'],
  [INFO, 'INFO'],
  [WARNING, 'WARNING'],
  [ERROR, 'ERROR'],
  [CRITICAL, 'CRITICAL'],
]);

/** Level used when neither the logger nor `setLevel()` chose one. */
const DEFAULT_EFFECTIVE_LEVEL = WARNING;

/** Name of the level, or `Level <n>` for custom levels (as in Python). */
export function getLevelName(level: number): string {
  return LEVEL_NAMES.get(level) ?? `Level ${level}`;
}

export interface LogRecord {
  name: string;
  level: number;
  levelName: string;
  message: string;
  /** Milliseconds since the epoch. */
  created: number;
  /** Error passed to `exception()` / `log(..., { error })`. */
  error?: unknown;
  /** Extra fields, like Python's `extra=`; filters may add to it. */
  extra: Record<string, unknown>;
}

export interface LogOptions {
  error?: unknown;
  extra?: Record<string, unknown>;
}

export type LogFilter = (record: LogRecord) => boolean;
export type LogFormatter = (record: LogRecord) => string;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Python's default `asctime`: local time, `2026-10-24 03:17:13,123`. */
export function formatAsctime(created: number): string {
  const date = new Date(created);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${time},${pad(date.getMilliseconds(), 3)}`;
}

/**
 * An error for the log, with its message escaped: it can quote report fields
 * and add lines of its own. The stack keeps its line breaks only when the
 * message can be told apart from the frames.
 */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return sanitizeForLog(String(error));
  }
  const message = sanitizeForLog(error.message);
  if (error.stack === undefined) {
    return `${error.name}: ${message}`;
  }
  return error.stack.includes(error.message)
    ? error.stack.replace(error.message, () => message)
    : sanitizeForLog(error.stack);
}

/** `LEVEL:name:message`, the format of Python's `assertLogs` output. */
export function basicFormat(record: LogRecord): string {
  return `${record.levelName}:${record.name}:${record.message}`;
}

/** Console format used by `configureLogging()`. */
export function consoleFormat(record: LogRecord): string {
  const line = `${record.levelName.padStart(8)}:${record.name}:${record.message}`;
  return record.error === undefined
    ? line
    : `${line}\n${errorText(record.error)}`;
}

/** Log file format used by `configureLogging()`. */
export function fileFormat(record: LogRecord): string {
  const line = `${formatAsctime(record.created)} - ${record.levelName} - [${record.name}] - ${record.message}`;
  return record.error === undefined
    ? line
    : `${line}\n${errorText(record.error)}`;
}

export abstract class Handler {
  level: number = NOTSET;
  formatter: LogFormatter = basicFormat;
  readonly filters: LogFilter[] = [];

  setLevel(level: number): void {
    this.level = level;
  }

  setFormatter(formatter: LogFormatter): void {
    this.formatter = formatter;
  }

  addFilter(filter: LogFilter): void {
    this.filters.push(filter);
  }

  removeFilter(filter: LogFilter): void {
    const index = this.filters.indexOf(filter);
    if (index !== -1) {
      this.filters.splice(index, 1);
    }
  }

  format(record: LogRecord): string {
    return this.formatter(record);
  }

  /** Apply level and filters, then emit. Errors in `emit` never propagate. */
  handle(record: LogRecord): void {
    if (record.level < this.level) {
      return;
    }
    for (const filter of this.filters) {
      if (!filter(record)) {
        return;
      }
    }
    try {
      this.emit(record);
    } catch (error) {
      this.handleError(record, error);
    }
  }

  /** Like Python's `Handler.handleError`: report to stderr, keep going. */
  handleError(record: LogRecord, error: unknown): void {
    process.stderr.write(
      `--- Logging error ---\n${errorText(error)}\nMessage: ${record.message}\n`,
    );
  }

  abstract emit(record: LogRecord): void;

  flush(): void {
    // Nothing buffered by default.
  }

  close(): void {
    // Nothing to release by default.
  }
}

/** Discards every record. */
export class NullHandler extends Handler {
  emit(_record: LogRecord): void {
    // Intentionally empty.
  }
}

export interface WritableTextStream {
  write: (text: string) => unknown;
}

/** Writes formatted records to a stream (stderr by default). */
export class StreamHandler extends Handler {
  readonly stream: WritableTextStream;

  constructor(stream: WritableTextStream = process.stderr) {
    super();
    this.stream = stream;
  }

  emit(record: LogRecord): void {
    this.stream.write(`${this.format(record)}\n`);
  }
}

/** Appends formatted records to a file, synchronously and in order. */
export class FileHandler extends StreamHandler {
  /** Absolute path of the log file, like Python's `baseFilename`. */
  readonly baseFilename: string;
  private fd: number | null;

  constructor(filename: string, mode: 'a' | 'w' = 'a') {
    const baseFilename = path.resolve(filename);
    const fd = openSync(baseFilename, mode);
    super({
      write: (text: string): void => {
        if (this.fd !== null) {
          writeSync(this.fd, text);
        }
      },
    });
    this.baseFilename = baseFilename;
    this.fd = fd;
  }

  override close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

export class Logger {
  readonly name: string;
  level: number = NOTSET;
  readonly handlers: Handler[] = [];
  readonly filters: LogFilter[] = [];
  disabled = false;

  constructor(name: string) {
    this.name = name;
  }

  setLevel(level: number): void {
    this.level = level;
  }

  getEffectiveLevel(): number {
    return this.level === NOTSET ? DEFAULT_EFFECTIVE_LEVEL : this.level;
  }

  isEnabledFor(level: number): boolean {
    return !this.disabled && level >= this.getEffectiveLevel();
  }

  addHandler(handler: Handler): void {
    if (!this.handlers.includes(handler)) {
      this.handlers.push(handler);
    }
  }

  removeHandler(handler: Handler): void {
    const index = this.handlers.indexOf(handler);
    if (index !== -1) {
      this.handlers.splice(index, 1);
    }
  }

  hasHandlers(): boolean {
    return this.handlers.length > 0;
  }

  addFilter(filter: LogFilter): void {
    this.filters.push(filter);
  }

  removeFilter(filter: LogFilter): void {
    const index = this.filters.indexOf(filter);
    if (index !== -1) {
      this.filters.splice(index, 1);
    }
  }

  log(level: number, message: string, options: LogOptions = {}): void {
    if (!this.isEnabledFor(level)) {
      return;
    }
    const record: LogRecord = {
      name: this.name,
      level,
      levelName: getLevelName(level),
      message,
      created: Date.now(),
      extra: { ...options.extra },
    };
    if (options.error !== undefined) {
      record.error = options.error;
    }
    for (const filter of this.filters) {
      if (!filter(record)) {
        return;
      }
    }
    for (const handler of [...this.handlers]) {
      handler.handle(record);
    }
  }

  debug(message: string, options?: LogOptions): void {
    this.log(DEBUG, message, options);
  }

  info(message: string, options?: LogOptions): void {
    this.log(INFO, message, options);
  }

  warning(message: string, options?: LogOptions): void {
    this.log(WARNING, message, options);
  }

  error(message: string, options?: LogOptions): void {
    this.log(ERROR, message, options);
  }

  critical(message: string, options?: LogOptions): void {
    this.log(CRITICAL, message, options);
  }

  /** Log at ERROR with the error attached (Python's `logger.exception`). */
  exception(message: string, error: unknown, options: LogOptions = {}): void {
    this.log(ERROR, message, { ...options, error });
  }
}

const loggers = new Map<string, Logger>();

/** Return the shared logger with this name, creating it on first use. */
export function getLogger(name: string): Logger {
  let logger = loggers.get(name);
  if (logger === undefined) {
    logger = new Logger(name);
    loggers.set(name, logger);
  }
  return logger;
}

/** The library logger (parsedmarc's `parsedmarc.log.logger`). */
export const logger: Logger = getLogger('tsdmarc');

/**
 * Configure the library logger's handlers: set the level, add a stderr
 * handler if there is none, and add a file handler for `logFile` unless one
 * for the same absolute path is already attached (so repeated calls, e.g. a
 * SIGHUP reload, never write each record twice).
 */
export function configureLogging(level: number, logFile?: string | null): void {
  logger.setLevel(level);

  const hasStreamHandler = logger.handlers.some(
    handler =>
      handler instanceof StreamHandler && !(handler instanceof FileHandler),
  );
  if (!hasStreamHandler) {
    const handler = new StreamHandler();
    handler.setFormatter(consoleFormat);
    logger.addHandler(handler);
  }

  if (logFile) {
    try {
      const logFilePath = path.resolve(logFile);
      const hasFileHandler = logger.handlers.some(
        handler =>
          handler instanceof FileHandler &&
          handler.baseFilename === logFilePath,
      );
      if (!hasFileHandler) {
        const handler = new FileHandler(logFile, 'a');
        handler.setFormatter(fileFormat);
        logger.addHandler(handler);
      }
    } catch (error) {
      logger.warning(`Unable to write to log file: ${String(error)}`);
    }
  }
}

/** Collects records; used by {@link captureLogs}. */
export class CaptureHandler extends Handler {
  readonly records: LogRecord[] = [];

  emit(record: LogRecord): void {
    this.records.push(record);
  }
}

export interface LogCapture {
  /** Captured records, in order. */
  readonly records: LogRecord[];
  /** Captured records as `LEVEL:name:message` strings (like `assertLogs`). */
  readonly output: string[];
  /** Detach the capture handler and restore the logger's level. */
  restore: () => void;
}

/**
 * Capture records of `level` and above from a logger, like Python's
 * `assertLogs`. Call `restore()` when done (e.g. in `afterEach`).
 */
export function captureLogs(
  target: Logger | string = logger,
  level: number = DEBUG,
): LogCapture {
  const log = typeof target === 'string' ? getLogger(target) : target;
  const handler = new CaptureHandler();
  handler.setLevel(level);
  const savedLevel = log.level;
  if (log.getEffectiveLevel() > level) {
    log.setLevel(level);
  }
  log.addHandler(handler);
  return {
    records: handler.records,
    get output(): string[] {
      return handler.records.map(basicFormat);
    },
    restore(): void {
      log.removeHandler(handler);
      log.setLevel(savedLevel);
    },
  };
}
