// Ported from parsedmarc tests/test_cli.py: TestConfigureLogging (the CLI's
// `_configure_logging` wrapper around the core's configureLogging()), plus
// the part of TestOptionalIntegrationExtras that still applies: the
// non-Graph branch of the Graph failure log line.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  captureLogs,
  DEBUG,
  ERROR,
  FileHandler,
  type Handler,
  INFO,
  logger,
  StreamHandler,
  WARNING,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureLogging } from './logging';
import { logMsgraphFailure } from './msgraph-errors';

function isPlainStreamHandler(handler: Handler): boolean {
  return handler instanceof StreamHandler && !(handler instanceof FileHandler);
}

describe('TestConfigureLogging', () => {
  let savedHandlers: Handler[] = [];
  let savedLevel = 0;

  beforeEach(() => {
    savedHandlers = [...logger.handlers];
    savedLevel = logger.level;
  });

  afterEach(() => {
    for (const handler of [...logger.handlers]) {
      if (!savedHandlers.includes(handler)) {
        logger.removeHandler(handler);
        handler.close();
      }
    }
    for (const handler of savedHandlers) {
      logger.addHandler(handler);
    }
    logger.setLevel(savedLevel);
  });

  it('test_sets_log_level', () => {
    configureLogging(DEBUG);
    expect(logger.level).toBe(DEBUG);
  });

  it('test_adds_stream_handler_when_none_present', () => {
    // Remove any existing stream handler so we know one gets added.
    for (const handler of [...logger.handlers]) {
      if (isPlainStreamHandler(handler)) {
        logger.removeHandler(handler);
      }
    }
    configureLogging(INFO);
    expect(logger.handlers.some(isPlainStreamHandler)).toBe(true);
  });

  it('test_does_not_duplicate_stream_handler', () => {
    for (const handler of [...logger.handlers]) {
      logger.removeHandler(handler);
    }
    logger.addHandler(new StreamHandler());
    const before = logger.handlers.length;
    configureLogging(INFO);
    expect(logger.handlers.length).toBe(before);
  });

  it('test_adds_file_handler_when_log_file_given', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-cli-log-'));
    try {
      configureLogging(INFO, path.join(directory, 'test.log'));
      expect(
        logger.handlers.some(handler => handler instanceof FileHandler),
      ).toBe(true);
    } finally {
      for (const handler of [...logger.handlers]) {
        if (handler instanceof FileHandler) {
          logger.removeHandler(handler);
          handler.close();
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // An unopenable log file is a warning, never an error that would crash
  // the parse pipeline.
  it('test_unwritable_log_file_logs_warning_does_not_raise', () => {
    const logs = captureLogs(logger, WARNING);
    try {
      configureLogging(INFO, '/proc/nonexistent/x.log');
    } finally {
      logs.restore();
    }
    expect(
      logs.output.some(line => line.includes('Unable to write to log file')),
    ).toBe(true);
  });
});

describe('TestOptionalIntegrationExtras', () => {
  // From test_graph_error_types_fall_back_to_sentinel_classes: an error
  // that is not a Graph API error keeps the `<name>: <message>` summary,
  // with whitespace collapsed.
  it('logs a non-Graph error with its class name and collapsed message', () => {
    const logs = captureLogs(logger, ERROR);
    try {
      logMsgraphFailure(new TypeError('no  token'), {
        stage: 'connection',
        mailbox: 'reports@example.com',
        tenantId: 'tenant',
        authMethod: 'ClientSecret',
      });
    } finally {
      logs.restore();
    }
    expect(logs.output[0]).toBe(
      'ERROR:tsdmarc:Microsoft Graph connection failed (mailbox=reports@example.com, ' +
        'tenant_id=tenant, auth_method=ClientSecret): TypeError: no token',
    );
  });
});
