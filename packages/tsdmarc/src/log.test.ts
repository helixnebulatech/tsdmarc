import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  captureLogs,
  configureLogging,
  consoleFormat,
  DEBUG,
  fileFormat,
  FileHandler,
  getLevelName,
  getLogger,
  INFO,
  logger,
  WARNING,
  type Handler,
  type LogRecord,
} from './log';

describe('error text of a log record', () => {
  const FORGED = '2026-10-31 12:00:00,000 - ERROR - [tsdmarc] - FORGED';
  const record = (error: unknown): LogRecord => ({
    name: 'tsdmarc',
    level: 40,
    levelName: 'ERROR',
    message: 'Mailbox Error',
    created: 0,
    error,
    extra: {},
  });

  it.each([
    ['fileFormat', fileFormat],
    ['consoleFormat', consoleFormat],
  ])('%s escapes the message and keeps the stack frames', (_name, format) => {
    const lines = format(record(new Error(`bad date: x\n${FORGED}`))).split(
      '\n',
    );
    expect(lines).not.toContain(FORGED);
    expect(lines[1]).toContain(String.raw`bad date: x\n${FORGED}`);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[2]).toMatch(/^\s+at /u);
  });

  it('keeps a replacement pattern in the message as is', () => {
    expect(fileFormat(record(new Error('a$&b\nc')))).toContain(
      String.raw`Error: a$&b\nc`,
    );
  });

  it('escapes a whole stack that no longer holds the message', () => {
    const error = new Error('original');
    error.message = `changed\n${FORGED}`;
    error.stack = `Error: other\n${FORGED}`;
    expect(fileFormat(record(error)).split('\n')).not.toContain(FORGED);
  });

  it('escapes a value that is not an Error', () => {
    expect(fileFormat(record(`x\n${FORGED}`)).split('\n')).not.toContain(
      FORGED,
    );
  });
});

describe('configureLogging file handler dedup', () => {
  // Repeated configureLogging calls with the same logFile (e.g. a SIGHUP
  // config reload) must not stack duplicate FileHandlers: a duplicate would
  // write every record twice and leak a file descriptor per call.
  let savedHandlers: Handler[];
  let savedLevel: number;
  let directory: string;

  beforeEach(() => {
    savedHandlers = [...logger.handlers];
    savedLevel = logger.level;
    directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-log-'));
  });

  afterEach(() => {
    for (const handler of [...logger.handlers]) {
      if (!savedHandlers.includes(handler)) {
        logger.removeHandler(handler);
        handler.close();
      }
    }
    logger.setLevel(savedLevel);
    rmSync(directory, { recursive: true, force: true });
  });

  it('attaches one handler and logs once for the same file twice', () => {
    const logPath = path.join(directory, 'a.log');
    configureLogging(INFO, logPath);
    configureLogging(INFO, logPath);

    const fileHandlers = logger.handlers.filter(
      handler =>
        handler instanceof FileHandler &&
        handler.baseFilename === path.resolve(logPath),
    );
    expect(fileHandlers).toHaveLength(1);

    logger.info('dedup-check line');
    const contents = readFileSync(logPath, 'utf-8');
    expect(contents.split('dedup-check line')).toHaveLength(2);
  });

  it('attaches one handler per different file', () => {
    const firstPath = path.join(directory, 'first.log');
    const secondPath = path.join(directory, 'second.log');
    configureLogging(INFO, firstPath);
    configureLogging(INFO, secondPath);

    const filePaths = logger.handlers
      .filter(
        (handler): handler is FileHandler => handler instanceof FileHandler,
      )
      .map(handler => handler.baseFilename);
    expect(filePaths).toContain(path.resolve(firstPath));
    expect(filePaths).toContain(path.resolve(secondPath));
  });
});

describe('loggers', () => {
  it('returns the same logger for the same name', () => {
    expect(getLogger('tsdmarc')).toBe(logger);
    expect(getLogger('other')).not.toBe(logger);
  });

  it('is silent below the effective level and captures like assertLogs', () => {
    const log = getLogger('capture-test');
    const capture = captureLogs(log, WARNING);
    log.info('not captured');
    log.warning('captured');
    log.exception('failed', new Error('boom'));
    capture.restore();
    log.warning('after restore');
    expect(capture.output).toEqual([
      'WARNING:capture-test:captured',
      'ERROR:capture-test:failed',
    ]);
    expect(capture.records[1]?.error).toBeInstanceOf(Error);
  });

  it('lowers the logger level while capturing and restores it', () => {
    const log = getLogger('level-test');
    log.setLevel(WARNING);
    const capture = captureLogs(log, DEBUG);
    log.debug('debug line');
    capture.restore();
    expect(capture.output).toEqual(['DEBUG:level-test:debug line']);
    expect(log.level).toBe(WARNING);
  });

  it('applies filters that can add extra fields', () => {
    const log = getLogger('filter-test');
    log.addFilter(record => {
      record.extra.context = 'ctx';
      return true;
    });
    const capture = captureLogs(log, INFO);
    log.info('hello');
    capture.restore();
    expect(capture.records[0]?.extra).toEqual({ context: 'ctx' });
  });

  it('names levels like Python', () => {
    expect(getLevelName(WARNING)).toBe('WARNING');
    expect(getLevelName(25)).toBe('Level 25');
  });
});
