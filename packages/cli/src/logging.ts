// CLI logging setup: the console handler, log levels from the options,
// `_configure_logging` and `_configure_dependency_logging`.

import { format } from 'node:util';

import { AzureLogger, setLogLevel as setAzureLogLevel } from '@azure/logger';
import {
  configureLogging as configureLibraryLogging,
  consoleFormat,
  DEBUG,
  ERROR,
  FileHandler,
  fileFormat,
  getLogger,
  INFO,
  logger,
  StreamHandler,
  WARNING,
} from 'tsdmarc';

import type { CliOptions } from './options';

/**
 * Configure logging for the current process (parsedmarc's
 * `_configure_logging`, also used by parallel workers).
 */
export function configureLogging(
  logLevel: number,
  logFile: string | null = null,
): void {
  configureLibraryLogging(logLevel, logFile);
}

/**
 * Attach the console handler parsedmarc's CLI adds at import time, once.
 */
export function addConsoleHandler(): void {
  const hasStreamHandler = logger.handlers.some(
    handler =>
      handler instanceof StreamHandler && !(handler instanceof FileHandler),
  );
  if (!hasStreamHandler) {
    const handler = new StreamHandler();
    handler.setFormatter(consoleFormat);
    logger.addHandler(handler);
  }
}

/** ERROR, raised to WARNING/INFO/DEBUG by `warnings`/`verbose`/`debug`. */
export function applyLogLevel(opts: CliOptions): void {
  logger.setLevel(ERROR);
  if (opts.warnings) {
    logger.setLevel(WARNING);
  }
  if (opts.verbose) {
    logger.setLevel(INFO);
  }
  if (opts.debug) {
    logger.setLevel(DEBUG);
  }
}

/** A log file handler with the CLI's file format. */
export function createLogFileHandler(logFile: string): FileHandler {
  const handler = new FileHandler(logFile, 'a');
  handler.setFormatter(fileFormat);
  return handler;
}

/**
 * Loggers of the libraries behind the mailbox and Microsoft Graph layers.
 * tsdmarc's own mailbox backends log to the `tsdmarc` logger; the Azure
 * SDK's `@azure/logger` output is bridged into the `azure` logger.
 */
export const DEPENDENCY_LOGGERS: readonly string[] = [
  'mailsuite',
  'azure',
  'msgraph',
  'httpx',
  'httpcore',
];

const AZURE_LEVELS: ReadonlyMap<string, number> = new Map([
  ['verbose', DEBUG],
  ['info', INFO],
  ['warning', WARNING],
  ['error', ERROR],
]);
const AZURE_NAMESPACE = /^azure:\S*?:(verbose|info|warning|error) /u;

function azureLogLevelName(level: number): 'verbose' | 'info' | 'warning' {
  if (level <= DEBUG) {
    return 'verbose';
  }
  return level <= INFO ? 'info' : 'warning';
}

/** Send `@azure/logger` output (e.g. AADSTS token errors) to the `azure` logger. */
function bridgeAzureLogger(level: number): void {
  const azureLogger = getLogger('azure');
  AzureLogger.log = (...args: unknown[]): void => {
    const text = format(...args);
    const match = AZURE_NAMESPACE.exec(text);
    const recordLevel = AZURE_LEVELS.get(match?.[1] ?? '') ?? INFO;
    azureLogger.log(recordLevel, match ? text.slice(match[0].length) : text);
  };
  setAzureLogLevel(azureLogLevelName(level));
}

/**
 * Apply the CLI's verbosity to dependency loggers: the tsdmarc level when
 * `--verbose`/`--debug` makes it more verbose than WARNING, WARNING
 * otherwise. Their handlers are synced to exactly the tsdmarc logger's
 * (console and optional file), so a SIGHUP reload that swaps the log file
 * neither duplicates output nor writes to a closed handler.
 */
export function configureDependencyLogging(level: number): void {
  const depLevel = Math.min(level, WARNING);
  for (const name of DEPENDENCY_LOGGERS) {
    const depLogger = getLogger(name);
    depLogger.setLevel(depLevel);
    for (const existing of [...depLogger.handlers]) {
      if (!logger.handlers.includes(existing)) {
        depLogger.removeHandler(existing);
      }
    }
    for (const wanted of logger.handlers) {
      if (!depLogger.handlers.includes(wanted)) {
        depLogger.addHandler(wanted);
      }
    }
  }
  bridgeAzureLogger(depLevel);
}
