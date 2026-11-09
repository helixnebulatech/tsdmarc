// Shared test setup: module mocks at the package boundaries (every function
// export wrapped in a `vi.fn` that runs the real implementation until a
// test changes it), no network, and process-wide state reset after each
// test.

import { AzureLogger, setLogLevel as setAzureLogLevel } from '@azure/logger';
import * as elastic from '@tsdmarc/elasticsearch';
import * as opensearch from '@tsdmarc/opensearch';
import {
  getLogger,
  type Handler,
  ipInfoState,
  logger,
  pslOverrides,
  SEEN_AGGREGATE_REPORT_IDS,
} from 'tsdmarc';
import { afterEach, beforeEach, vi } from 'vitest';

import { DEPENDENCY_LOGGERS } from '../logging';

const originalAzureLog = AzureLogger.log;

type Module = Record<string, unknown>;

/**
 * Wrap every function export whose name starts with a lower-case letter in
 * a `vi.fn` running the original (classes are left as they are: spy on
 * their static or prototype methods instead).
 */
async function wrapFunctions(
  importOriginal: () => Promise<unknown>,
): Promise<Module> {
  const actual = (await importOriginal()) as Module;
  const wrapped: Module = {};
  for (const [name, value] of Object.entries(actual)) {
    wrapped[name] =
      typeof value === 'function' && /^[a-z]/u.test(name)
        ? vi.fn(value as (...args: unknown[]) => unknown)
        : value;
  }
  return wrapped;
}

vi.mock('tsdmarc', wrapFunctions);
vi.mock('@tsdmarc/elasticsearch', wrapFunctions);
vi.mock('@tsdmarc/opensearch', wrapFunctions);
vi.mock('@tsdmarc/smtp', wrapFunctions);
vi.mock('@tsdmarc/msgraph', wrapFunctions);
vi.mock('../config', wrapFunctions);
vi.mock('../core', wrapFunctions);
vi.mock('../outputs', wrapFunctions);

const savedEnv = { ...process.env };
let savedHandlers: Handler[] = [];
let savedLevel = 0;
let savedPslOverrides: string[] = [];
let savedIpInfoState = { ...ipInfoState };

beforeEach(() => {
  savedHandlers = [...logger.handlers];
  savedLevel = logger.level;
  savedPslOverrides = [...pslOverrides];
  savedIpInfoState = { ...ipInfoState };
  // No test may reach the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed (network is disabled in tests)');
    }),
  );
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const handler of [...logger.handlers]) {
    if (!savedHandlers.includes(handler)) {
      logger.removeHandler(handler);
      handler.close();
    }
  }
  logger.setLevel(savedLevel);
  logger.disabled = false;
  pslOverrides.splice(0, pslOverrides.length, ...savedPslOverrides);
  Object.assign(ipInfoState, savedIpInfoState);
  SEEN_AGGREGATE_REPORT_IDS.clear();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  elastic.setDefaultConnection(null);
  elastic.setServerless(false);
  opensearch.setDefaultConnection(null);
  // configureDependencyLogging() shares the tsdmarc handlers with these.
  for (const name of DEPENDENCY_LOGGERS) {
    const depLogger = getLogger(name);
    for (const handler of [...depLogger.handlers]) {
      depLogger.removeHandler(handler);
    }
    depLogger.setLevel(0);
  }
  AzureLogger.log = originalAzureLog;
  setAzureLogLevel(undefined);
});
