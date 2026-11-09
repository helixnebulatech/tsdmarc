// SIGHUP configuration reload (parsedmarc's TestSighupReload,
// TestSighupReloadAtomicity and TestUtilsGlobalsSnapshot).

import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as elastic from '@tsdmarc/elasticsearch';
import { GmailConnection } from '@tsdmarc/gmail';
import { IMAPConnection } from '@tsdmarc/imap';
import * as tsdmarc from 'tsdmarc';
import {
  captureLogs,
  FileHandler,
  getLogger,
  type Handler,
  INFO,
  ipInfoState,
  logger,
  type LogCapture,
  pslOverrides,
  REVERSE_DNS_MAP,
  type ReverseDNSMap,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as config from './config';
import { ConfigParser } from './configparser';
import * as core from './core';
import { DEPENDENCY_LOGGERS } from './logging';
import { main } from './main';
import type { CliOptions } from './options';
import * as outputs from './outputs';
import { ElasticsearchHandle, type OutputClients } from './outputs';
import { stdout } from './process-reports';

type Signal = 'SIGHUP' | 'SIGTERM' | 'SIGINT';
type ElasticClient = NonNullable<
  ReturnType<typeof elastic.getDefaultConnection>
>;
type WatchOptions = Parameters<typeof core.watchInbox>[0];

const SIGNALS: readonly Signal[] = ['SIGHUP', 'SIGTERM', 'SIGINT'];
let baselineListeners = new Map<Signal, Set<unknown>>();
const tempDirs: string[] = [];

/** Deliver `signal` to the listeners main() installed (not vitest's own). */
function sendSignal(signal: Signal): void {
  const baseline = baselineListeners.get(signal) ?? new Set();
  for (const listener of process.listeners(signal)) {
    if (!baseline.has(listener)) {
      (listener as (name: Signal) => void)(signal);
    }
  }
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-reload-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(contents: string, suffix: string): string {
  const filePath = path.join(tempDir(), `file${suffix}`);
  writeFileSync(filePath, contents);
  return filePath;
}

function fileExistsError(message: string): Error {
  return Object.assign(new Error(message), { code: 'EEXIST' });
}

function emptyReports(): tsdmarc.ParsingResults {
  return { aggregateReports: [], failureReports: [], smtpTlsReports: [] };
}

function mockImap(): void {
  vi.spyOn(IMAPConnection, 'connect').mockResolvedValue({
    close: vi.fn(async () => undefined),
  } as unknown as IMAPConnection);
}

function setImapWatchOptions(opts: CliOptions): void {
  opts.imapHost = 'imap.example.com';
  opts.imapUser = 'user';
  opts.imapPassword = 'pass';
  opts.mailboxWatch = true;
}

let savedMap: ReverseDNSMap = new Map();

beforeEach(() => {
  baselineListeners = new Map(
    SIGNALS.map(signal => [signal, new Set(process.listeners(signal))]),
  );
  savedMap = new Map(REVERSE_DNS_MAP);
  vi.spyOn(stdout, 'write').mockImplementation(() => undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue(emptyReports());
  mockImap();
});

afterEach(() => {
  REVERSE_DNS_MAP.clear();
  for (const [key, value] of savedMap) {
    REVERSE_DNS_MAP.set(key, value);
  }
  for (const name of DEPENDENCY_LOGGERS) {
    const depLogger = getLogger(name);
    for (const handler of [...depLogger.handlers]) {
      depLogger.removeHandler(handler);
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('TestSighupReload', () => {
  const BASE_CONFIG = `[general]
silent = true

[imap]
host = imap.example.com
user = user
password = pass

[mailbox]
watch = true
`;

  beforeEach(() => {
    logger.disabled = true;
    vi.mocked(config.loadConfig).mockReturnValue(new ConfigParser());
  });

  it('testSighupTriggersReloadAndWatchRestarts', async () => {
    vi.mocked(config.parseConfig).mockImplementation(async (_config, opts) => {
      setImapWatchOptions(opts);
      return null;
    });
    vi.mocked(outputs.initOutputClients).mockResolvedValue(new Map());
    let calls = 0;
    vi.mocked(core.watchInbox).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        // SIGHUP arrives while watching; the watch returns normally.
        sendSignal('SIGHUP');
        return;
      }
      throw fileExistsError('stop-watch-loop');
    });
    const cfgPath = writeFile(BASE_CONFIG, '.ini');

    await expect(main(['-c', cfgPath])).rejects.toMatchObject({ code: 1 });

    // watchInbox ran twice: the initial run and after the reload.
    expect(core.watchInbox).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(config.parseConfig).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('testInvalidConfigOnReloadKeepsPreviousState', async () => {
    const initialMap = new Map([['prefix_', ['example.com']]]);
    let parseCalls = 0;
    vi.mocked(config.parseConfig).mockImplementation(async (_config, opts) => {
      parseCalls += 1;
      setImapWatchOptions(opts);
      if (parseCalls === 1) {
        return initialMap;
      }
      throw new Error('bad config');
    });
    const s3Client = { close: vi.fn() };
    vi.mocked(outputs.initOutputClients).mockResolvedValue(
      new Map([['s3_client', s3Client]]),
    );
    let calls = 0;
    let closedDuringRun: number | null = null;
    vi.mocked(core.watchInbox).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        sendSignal('SIGHUP');
        return;
      }
      closedDuringRun = s3Client.close.mock.calls.length;
      throw fileExistsError('stop');
    });
    const cfgPath = writeFile(BASE_CONFIG, '.ini');

    await expect(main(['-c', cfgPath])).rejects.toMatchObject({ code: 1 });

    // The watch loop continued after the failed reload.
    expect(core.watchInbox).toHaveBeenCalledTimes(2);
    // The old clients were not closed by the reload (only at exit).
    expect(closedDuringRun).toBe(0);
    expect(s3Client.close).toHaveBeenCalledTimes(1);
  });

  it('testReloadPassesFreshDomainMapToOutputClients', async () => {
    const firstMap = new Map([['tenant_a', ['example.com']]]);
    const secondMap = new Map([
      ['tenant_a', ['example.com']],
      ['tenant_b', ['example.net']],
    ]);
    const maps = [firstMap, secondMap];
    vi.mocked(config.parseConfig).mockImplementation(async (_config, opts) => {
      setImapWatchOptions(opts);
      return maps.shift() ?? secondMap;
    });
    vi.mocked(outputs.initOutputClients).mockImplementation(
      async () => new Map(),
    );
    let calls = 0;
    vi.mocked(core.watchInbox).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        sendSignal('SIGHUP');
        return;
      }
      throw fileExistsError('stop-watch-loop');
    });
    const cfgPath = writeFile(BASE_CONFIG, '.ini');

    await expect(main(['-c', cfgPath])).rejects.toMatchObject({ code: 1 });

    const initCalls = vi.mocked(outputs.initOutputClients).mock.calls;
    expect(initCalls).toHaveLength(2);
    expect(initCalls[0]?.[1]).toBe(firstMap);
    expect(initCalls[1]?.[1]).toBe(secondMap);
  });

  it('testReloadClosesOldClients', async () => {
    vi.mocked(config.parseConfig).mockImplementation(async (_config, opts) => {
      setImapWatchOptions(opts);
      return null;
    });
    const oldClient = { close: vi.fn() };
    const newClient = { close: vi.fn() };
    let initCalls = 0;
    vi.mocked(outputs.initOutputClients).mockImplementation(async () => {
      initCalls += 1;
      return new Map([
        ['kafka_client', initCalls === 1 ? oldClient : newClient],
      ]);
    });
    let calls = 0;
    let oldClosedBeforeExit = 0;
    vi.mocked(core.watchInbox).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        sendSignal('SIGHUP');
        return;
      }
      oldClosedBeforeExit = oldClient.close.mock.calls.length;
      throw fileExistsError('stop');
    });
    const cfgPath = writeFile(BASE_CONFIG, '.ini');

    await expect(main(['-c', cfgPath])).rejects.toMatchObject({ code: 1 });

    // The old client was closed by the successful reload.
    expect(oldClosedBeforeExit).toBe(1);
    expect(oldClient.close).toHaveBeenCalledTimes(1);
  });

  it('testRemovedConfigSectionTakesEffectOnReload', async () => {
    vi.mocked(config.loadConfig).mockReset();
    const configV1 =
      `${BASE_CONFIG}\n[kafka]\nhosts = kafka.example.com:9092\n` +
      'aggregate_topic = dmarc_agg\n' +
      'forensic_topic = dmarc_forensic\n' +
      'smtp_tls_topic = smtp_tls\n';
    const configV2 = BASE_CONFIG;
    const cfgPath = writeFile(configV1, '.ini');
    let calls = 0;
    vi.mocked(core.watchInbox).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        // The operator removes [kafka] before signalling.
        writeFileSync(cfgPath, configV2);
        sendSignal('SIGHUP');
        return;
      }
      throw fileExistsError('stop');
    });
    const capturedHosts: (string[] | null)[] = [];
    vi.mocked(outputs.initOutputClients).mockImplementation(async opts => {
      capturedHosts.push(opts.kafkaHosts);
      return new Map();
    });

    await expect(main(['-c', cfgPath])).rejects.toMatchObject({ code: 1 });

    expect(capturedHosts[0]).not.toBeNull();
    expect(capturedHosts[1]).toBeNull();
  });

  it('testReloadRefreshesReverseDnsMap', async () => {
    vi.mocked(config.parseConfig).mockImplementation(async (_config, opts) => {
      setImapWatchOptions(opts);
      return null;
    });
    vi.mocked(outputs.initOutputClients).mockResolvedValue(new Map());
    const snapshots: ReverseDNSMap[] = [];
    let calls = 0;
    vi.mocked(core.watchInbox).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        sendSignal('SIGHUP');
        return;
      }
      // The map after the reload, before the loop stops.
      snapshots.push(new Map(REVERSE_DNS_MAP));
      throw fileExistsError('stop');
    });
    const cfgPath = writeFile(BASE_CONFIG, '.ini');
    REVERSE_DNS_MAP.clear();
    REVERSE_DNS_MAP.set('stale.example.com', { name: 'Stale', type: 'stale' });

    await expect(main(['-c', cfgPath])).rejects.toMatchObject({ code: 1 });

    expect(core.watchInbox).toHaveBeenCalledTimes(2);
    expect(snapshots).toHaveLength(1);
    const refreshed = snapshots[0] ?? new Map();
    // Repopulated: not empty, and the stale entry is gone.
    expect(refreshed.size).toBeGreaterThan(0);
    expect(refreshed.has('stale.example.com')).toBe(false);
  });

  it('test_sighup_reload_rebuilds_parser_config', async () => {
    let parseCalls = 0;
    vi.mocked(config.parseConfig).mockImplementation(async (_config, opts) => {
      parseCalls += 1;
      setImapWatchOptions(opts);
      opts.dnsTimeout = parseCalls === 1 ? 5.0 : 42.0;
      return null;
    });
    vi.mocked(outputs.initOutputClients).mockResolvedValue(new Map());
    let calls = 0;
    vi.mocked(core.watchInbox).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        sendSignal('SIGHUP');
        return;
      }
      throw fileExistsError('stop-watch-loop');
    });
    const cfgPath = writeFile(BASE_CONFIG, '.ini');

    await expect(main(['-c', cfgPath])).rejects.toMatchObject({ code: 1 });

    const watchCalls = vi.mocked(core.watchInbox).mock.calls;
    expect(watchCalls).toHaveLength(2);
    expect(watchCalls[0]?.[0].config?.dnsTimeout).toBe(5.0);
    expect(watchCalls[1]?.[0].config?.dnsTimeout).toBe(42.0);
  });
});

/** An output client whose close() fails (a broker connection already gone). */
class RaisingCloseClient {
  closeCount = 0;

  close(): void {
    this.closeCount += 1;
    throw new Error('broker connection already gone');
  }
}

/** A log FileHandler whose close() fails, like a flush to a full disk. */
class RaisingCloseFileHandler extends FileHandler {
  closeAttempts = 0;

  override close(): void {
    this.closeAttempts += 1;
    throw new Error('No space left on device');
  }

  /** What actually releases the descriptor. */
  reallyClose(): void {
    FileHandler.prototype.close.call(this);
  }
}

/** A stand-in for a search client in the real `default` connection slot. */
class FakeSearchConnection {
  readonly name: string;
  closeCount = 0;

  constructor(name: string) {
    this.name = name;
  }

  close(): void {
    this.closeCount += 1;
  }
}

/** Whether a FileHandler still holds its file open. */
function isOpen(handler: FileHandler): boolean {
  return (handler as unknown as { fd: number | null }).fd !== null;
}

interface CapturedState {
  reverseDnsMap: ReverseDNSMap;
  pslOverrides: string[];
  ipDbPath: string | null;
  ipinfoApiToken: string | null;
  alias: unknown;
  oldClosed: number;
  newClosed: number;
  logHandlers: Handler[];
}

describe('TestSighupReloadAtomicity', () => {
  const CONFIG_TEMPLATE = (
    dnsTimeout: string,
    generalExtra: string,
    batchSize: number,
  ): string => `[general]
debug = true
offline = true
dns_timeout = ${dnsTimeout}
${generalExtra}
[imap]
host = imap.example.com
user = user
password = pass

[mailbox]
watch = true
batch_size = ${batchSize}
`;

  /** The configuration the run starts with: batch size 3, DNS timeout 5. */
  const initialConfig = (generalExtra = ''): string =>
    CONFIG_TEMPLATE('5.0', generalExtra, 3);
  /** What the operator edits the file to: every value differs. */
  const reloadConfig = (generalExtra = ''): string =>
    CONFIG_TEMPLATE('42.0', generalExtra, 9);

  let searchConns: [FakeSearchConnection, FakeSearchConnection];

  beforeEach(() => {
    REVERSE_DNS_MAP.clear();
    REVERSE_DNS_MAP.set('before.example.com', {
      name: 'Before Reload',
      type: 'test',
    });
  });

  /**
   * Stands in for initOutputClients() against the real `default`
   * connection slot: the first call registers the old connection, the
   * second the new one, each wrapped in a real ElasticsearchHandle.
   */
  function fakeSearchClients(
    extraOldClients: [string, outputs.Closable][] = [],
  ): [FakeSearchConnection, FakeSearchConnection] {
    const oldConn = new FakeSearchConnection('old');
    const newConn = new FakeSearchConnection('new');
    searchConns = [oldConn, newConn];
    let calls = 0;
    vi.mocked(outputs.initOutputClients).mockImplementation(async () => {
      const conn = calls === 0 ? oldConn : newConn;
      calls += 1;
      elastic.setDefaultConnection(conn as unknown as ElasticClient);
      const clients: OutputClients = new Map([
        [
          'elasticsearch',
          new ElasticsearchHandle(conn as unknown as ElasticClient),
        ],
      ]);
      if (conn === oldConn) {
        for (const [name, client] of extraOldClients) {
          clients.set(name, client);
        }
      }
      return clients;
    });
    return searchConns;
  }

  function captureState(): CapturedState {
    const [oldConn, newConn] = searchConns;
    return {
      reverseDnsMap: new Map(REVERSE_DNS_MAP),
      pslOverrides: [...pslOverrides],
      ipDbPath: ipInfoState.ipDbPath,
      ipinfoApiToken: ipInfoState.ipinfoApiToken,
      alias: elastic.getDefaultConnection(),
      oldClosed: oldConn.closeCount,
      newClosed: newConn.closeCount,
      logHandlers: [...logger.handlers],
    };
  }

  /**
   * Run main() through exactly one SIGHUP reload. The first watchInbox()
   * call rewrites the config file, runs `beforeSignal` and signals SIGHUP;
   * the second records the state the reload left and signals SIGTERM, so
   * main() returns normally (closing the clients the run ended with).
   */
  async function driveReload(
    initial: string,
    reload: string,
    beforeSignal?: () => void,
  ): Promise<{
    state: CapturedState;
    watchCalls: WatchOptions[];
    logs: string[];
  }> {
    const cfgPath = writeFile(initial, '.ini');
    let state: CapturedState | null = null;
    const watchCalls: WatchOptions[] = [];
    vi.mocked(core.watchInbox).mockImplementation(async options => {
      watchCalls.push(options);
      if (watchCalls.length === 1) {
        writeFileSync(cfgPath, reload);
        beforeSignal?.();
        sendSignal('SIGHUP');
        return;
      }
      state = captureState();
      sendSignal('SIGTERM');
    });
    const capture: LogCapture = captureLogs(logger, INFO);
    try {
      await main(['-c', cfgPath]);
    } finally {
      capture.restore();
    }
    expect(watchCalls).toHaveLength(2);
    expect(state).not.toBeNull();
    return {
      state: state as unknown as CapturedState,
      watchCalls,
      logs: capture.output,
    };
  }

  function assertPreviousConfigStillRunning(
    state: CapturedState,
    watchCalls: WatchOptions[],
    logs: string[],
  ): void {
    expect(
      logs.some(line => line.includes('continuing with previous config')),
    ).toBe(true);
    expect(state.reverseDnsMap).toEqual(
      new Map([
        ['before.example.com', { name: 'Before Reload', type: 'test' }],
      ]),
    );
    expect(watchCalls[1]?.batchSize).toBe(3);
    expect(watchCalls[1]?.config?.dnsTimeout).toBe(5.0);
  }

  const AFTER_MAP =
    'base_reverse_dns,name,type\nafter.example.com,After Reload,test\n';

  it('testFailedReloadKeepsOldClientsWhenMapFileIsMissing', async () => {
    const [oldConn, newConn] = fakeSearchClients();

    const { state, watchCalls, logs } = await driveReload(
      initialConfig(),
      reloadConfig('local_reverse_dns_map_path = /nonexistent/map.csv\n'),
    );

    // The new clients were built, then closed and stripped of the slot.
    expect(state.newClosed).toBe(1);
    // The old ones are untouched and still registered.
    expect(state.oldClosed).toBe(0);
    expect(state.alias).toBe(oldConn);
    assertPreviousConfigStillRunning(state, watchCalls, logs);
    // main()'s trailing close ran against the old clients, and did not
    // close the discarded ones a second time.
    expect(oldConn.closeCount).toBe(1);
    expect(newConn.closeCount).toBe(1);
  });

  it('testFailedReloadRestoresPslOverrides', async () => {
    const [oldConn] = fakeSearchClients();
    const overridesBefore = [...pslOverrides];
    expect(overridesBefore.length).toBeGreaterThan(0);

    const { state, watchCalls, logs } = await driveReload(
      initialConfig(),
      reloadConfig(
        'local_psl_overrides_path = /nonexistent/psl_overrides.txt\n',
      ),
    );

    expect(state.pslOverrides).toEqual(overridesBefore);
    expect(state.newClosed).toBe(1);
    expect(state.oldClosed).toBe(0);
    expect(state.alias).toBe(oldConn);
    assertPreviousConfigStillRunning(state, watchCalls, logs);
  });

  it('testFailedReloadKeepsOldClientsWhenIpDatabaseIsUnavailable', async () => {
    const [oldConn] = fakeSearchClients();
    const overridesBefore = [...pslOverrides];
    expect(overridesBefore).not.toContain('reload-only.example');
    const reloadMapPath = writeFile(AFTER_MAP, '.csv');
    const reloadOverridesPath = writeFile('reload-only.example\n', '.txt');
    const ipDbPath = writeFile('not really an mmdb', '.mmdb');
    // tsdmarc's loadIpDb() only warns when the bundled database is
    // missing, so the failure is injected at the loader itself, on the
    // reload's call (startup resolves the local file).
    const realLoadIpDb = vi.mocked(tsdmarc.loadIpDb).getMockImplementation();
    let loadCalls = 0;
    vi.mocked(tsdmarc.loadIpDb).mockImplementation(async options => {
      loadCalls += 1;
      if (loadCalls > 1) {
        throw new Error('No bundled IP database');
      }
      await realLoadIpDb?.(options);
    });

    const { state, watchCalls, logs } = await driveReload(
      initialConfig(`ip_db_path = ${ipDbPath}\n`),
      reloadConfig(
        `local_reverse_dns_map_path = ${reloadMapPath}\n` +
          `local_psl_overrides_path = ${reloadOverridesPath}\n`,
      ),
    );

    expect(state.pslOverrides).toEqual(overridesBefore);
    expect(state.reverseDnsMap.has('after.example.com')).toBe(false);
    expect(state.ipDbPath).toBe(ipDbPath);
    expect(state.newClosed).toBe(1);
    expect(state.oldClosed).toBe(0);
    expect(state.alias).toBe(oldConn);
    assertPreviousConfigStillRunning(state, watchCalls, logs);
  });

  it('testSuccessfulReloadCommitsEveryStagedValue', async () => {
    const [, newConn] = fakeSearchClients();
    const mapPath = writeFile(AFTER_MAP, '.csv');

    const { state, watchCalls, logs } = await driveReload(
      initialConfig(),
      reloadConfig(`local_reverse_dns_map_path = ${mapPath}\n`),
    );

    expect(
      logs.some(line => line.includes('Configuration reloaded successfully')),
    ).toBe(true);
    expect(state.reverseDnsMap).toEqual(
      new Map([['after.example.com', { name: 'After Reload', type: 'test' }]]),
    );
    expect(state.alias).toBe(newConn);
    expect(state.oldClosed).toBe(1);
    expect(state.newClosed).toBe(0);
    expect(watchCalls[1]?.batchSize).toBe(9);
    expect(watchCalls[1]?.config?.dnsTimeout).toBe(42.0);
    // The parser config keeps the live map object.
    expect(watchCalls[1]?.config?.reverseDnsMap).toBe(REVERSE_DNS_MAP);
    // main()'s trailing close ran against the new clients.
    expect(newConn.closeCount).toBe(1);
  });

  it('testOldClientCloseFailureDoesNotUndoTheReload', async () => {
    const raisingClient = new RaisingCloseClient();
    const [, newConn] = fakeSearchClients([['kafka', raisingClient]]);
    const mapPath = writeFile(AFTER_MAP, '.csv');

    const { state, watchCalls, logs } = await driveReload(
      initialConfig(),
      reloadConfig(`local_reverse_dns_map_path = ${mapPath}\n`),
    );

    expect(raisingClient.closeCount).toBe(1);
    expect(logs.some(line => line.includes('Error closing kafka'))).toBe(true);
    expect(
      logs.some(line => line.includes('Configuration reloaded successfully')),
    ).toBe(true);
    expect(state.alias).toBe(newConn);
    expect(state.newClosed).toBe(0);
    expect(state.oldClosed).toBe(1);
    expect(state.reverseDnsMap).toEqual(
      new Map([['after.example.com', { name: 'After Reload', type: 'test' }]]),
    );
    expect(watchCalls[1]?.batchSize).toBe(9);
  });

  it('testLogFileCloseFailureDoesNotUndoTheReload', async () => {
    const [, newConn] = fakeSearchClients();
    const mapPath = writeFile(AFTER_MAP, '.csv');
    const logPath = writeFile('', '.log');
    const staleHandler = new RaisingCloseFileHandler(writeFile('', '.log'));

    try {
      const { state, watchCalls, logs } = await driveReload(
        initialConfig(),
        reloadConfig(
          `local_reverse_dns_map_path = ${mapPath}\nlog_file = ${logPath}\n`,
        ),
        () => logger.addHandler(staleHandler),
      );

      expect(staleHandler.closeAttempts).toBe(1);
      expect(
        logs.some(line => line.includes('Unable to close the log file')),
      ).toBe(true);
      expect(state.logHandlers).not.toContain(staleHandler);
      // The commit stands.
      expect(
        logs.some(line => line.includes('Configuration reloaded successfully')),
      ).toBe(true);
      expect(state.alias).toBe(newConn);
      expect(state.newClosed).toBe(0);
      expect(state.oldClosed).toBe(1);
      expect(state.reverseDnsMap).toEqual(
        new Map([
          ['after.example.com', { name: 'After Reload', type: 'test' }],
        ]),
      );
      expect(watchCalls[1]?.batchSize).toBe(9);
    } finally {
      logger.removeHandler(staleHandler);
      staleHandler.reallyClose();
    }
  });

  it('testUnwritableLogFileAbortsTheReload', async () => {
    const [oldConn] = fakeSearchClients();
    const mapPath = writeFile(AFTER_MAP, '.csv');
    // A file under a directory that does not exist cannot be opened.
    const unwritableLog = path.join(tempDir(), 'missing', 'tsdmarc-reload.log');
    const liveHandler = new FileHandler(writeFile('', '.log'), 'a');

    try {
      const { state, watchCalls, logs } = await driveReload(
        initialConfig(),
        reloadConfig(
          `local_reverse_dns_map_path = ${mapPath}\nlog_file = ${unwritableLog}\n`,
        ),
        () => logger.addHandler(liveHandler),
      );

      expect(
        logs.some(line =>
          line.includes(
            'Config reload failed, continuing with previous config',
          ),
        ),
      ).toBe(true);
      expect(
        logs.some(line => line.includes('Configuration reloaded successfully')),
      ).toBe(false);
      // The previous log file is still attached and open, and is the only
      // FileHandler: nothing leaked from the failed open.
      expect(
        state.logHandlers.filter(handler => handler instanceof FileHandler),
      ).toEqual([liveHandler]);
      expect(isOpen(liveHandler)).toBe(true);
      expect(state.newClosed).toBe(1);
      expect(state.oldClosed).toBe(0);
      expect(state.alias).toBe(oldConn);
      expect(state.reverseDnsMap.has('after.example.com')).toBe(false);
      assertPreviousConfigStillRunning(state, watchCalls, logs);
    } finally {
      logger.removeHandler(liveHandler);
      liveHandler.close();
    }
  });

  it('testFailedReloadClosesTheStagedLogFileHandler', async () => {
    const [oldConn] = fakeSearchClients();
    const logPath = writeFile('', '.log');
    const closeSpy = vi.spyOn(FileHandler.prototype, 'close');

    const { state, watchCalls, logs } = await driveReload(
      initialConfig(),
      reloadConfig(
        'local_reverse_dns_map_path = /nonexistent/map.csv\n' +
          `log_file = ${logPath}\n`,
      ),
    );

    // The initial config names no log file, so the only FileHandler closed
    // during the run is the one the reload staged.
    const closed = closeSpy.mock.contexts as FileHandler[];
    expect(closed).toHaveLength(1);
    const staged = closed[0] as FileHandler;
    expect(staged.baseFilename).toBe(path.resolve(logPath));
    expect(isOpen(staged)).toBe(false);
    // It was never attached.
    expect(state.logHandlers).not.toContain(staged);
    expect(state.newClosed).toBe(1);
    expect(state.oldClosed).toBe(0);
    expect(state.alias).toBe(oldConn);
    assertPreviousConfigStillRunning(state, watchCalls, logs);
  });

  it('testFailedReloadSurvivesAStagedLogFileHandlerThatCannotClose', async () => {
    const [oldConn] = fakeSearchClients();
    const logPath = writeFile('', '.log');
    const realClose = FileHandler.prototype.close;
    const attempts: FileHandler[] = [];
    vi.spyOn(FileHandler.prototype, 'close').mockImplementation(function (
      this: FileHandler,
    ) {
      attempts.push(this);
      throw new Error('No space left on device');
    });

    let result: Awaited<ReturnType<typeof driveReload>>;
    try {
      result = await driveReload(
        initialConfig(),
        reloadConfig(
          'local_reverse_dns_map_path = /nonexistent/map.csv\n' +
            `log_file = ${logPath}\n`,
        ),
      );
    } finally {
      vi.mocked(FileHandler.prototype.close).mockRestore();
      for (const handler of attempts) {
        realClose.call(handler);
      }
    }
    const { state, watchCalls, logs } = result;

    expect(attempts).toHaveLength(1);
    expect(
      logs.some(line =>
        line.includes('Unable to close the log file opened for the reload'),
      ),
    ).toBe(true);
    // The close error was swallowed: the rollback finished normally.
    assertPreviousConfigStillRunning(state, watchCalls, logs);
    expect(state.newClosed).toBe(1);
    expect(state.oldClosed).toBe(0);
    expect(state.alias).toBe(oldConn);
    expect(state.logHandlers).not.toContain(attempts[0]);
  });

  it('testLogFileUnopenableAtStartupIsRetriedOnReload', async () => {
    const dir = tempDir();
    const logPath = path.join(dir, 'later', 'tsdmarc.log');
    const [, newConn] = fakeSearchClients();

    const { state, logs } = await driveReload(
      initialConfig(`log_file = ${logPath}\n`),
      reloadConfig(`log_file = ${logPath}\n`),
      // The operator creates the missing directory before the SIGHUP.
      () => mkdirSync(path.dirname(logPath)),
    );

    expect(
      logs.some(line => line.includes('Unable to write to log file')),
    ).toBe(true);
    expect(
      logs.some(line => line.includes('Configuration reloaded successfully')),
    ).toBe(true);
    const fileHandlers = state.logHandlers.filter(
      handler => handler instanceof FileHandler,
    );
    expect(fileHandlers).toHaveLength(1);
    expect(fileHandlers[0]?.baseFilename).toBe(path.resolve(logPath));
    expect(state.oldClosed).toBe(1);
    expect(state.newClosed).toBe(0);
    expect(state.alias).toBe(newConn);
    closeSync(openSync(logPath, 'r'));
  });

  it('testLogFileOpenedAtStartupIsNotReopenedByAnUnchangedReload', async () => {
    const logPath = writeFile('', '.log');
    const [, newConn] = fakeSearchClients();
    let startupHandlers: FileHandler[] = [];

    const { state, logs } = await driveReload(
      initialConfig(`log_file = ${logPath}\n`),
      reloadConfig(`log_file = ${logPath}\n`),
      () => {
        startupHandlers = logger.handlers.filter(
          (handler): handler is FileHandler => handler instanceof FileHandler,
        );
      },
    );

    expect(
      logs.some(line => line.includes('Unable to write to log file')),
    ).toBe(false);
    expect(
      logs.some(line => line.includes('Configuration reloaded successfully')),
    ).toBe(true);
    // Startup opened the file once; the reload saw the same active log
    // file and kept that handler rather than opening a second one.
    expect(startupHandlers).toHaveLength(1);
    const fileHandlers = state.logHandlers.filter(
      handler => handler instanceof FileHandler,
    );
    expect(fileHandlers).toHaveLength(1);
    expect(fileHandlers[0]).toBe(startupHandlers[0]);
    expect(startupHandlers[0]?.baseFilename).toBe(path.resolve(logPath));
    expect(state.oldClosed).toBe(1);
    expect(state.newClosed).toBe(0);
    expect(state.alias).toBe(newConn);
  });
});

describe('TestUtilsGlobalsSnapshot', () => {
  it('testRestoresEveryLoaderGlobalAfterTheLoadersRanAgain', () => {
    pslOverrides.splice(0, pslOverrides.length, 'example.co.uk');
    ipInfoState.ipDbPath = '/before/ipinfo_lite.mmdb';
    ipInfoState.ipinfoApiToken = 'before-token';
    const overridesObject = pslOverrides;

    const snapshot = outputs.utilsGlobalsSnapshot();

    // What the loaders do: refill the list in place, rebind the others.
    pslOverrides.length = 0;
    pslOverrides.push('example.com.au');
    ipInfoState.ipDbPath = '/after/ipinfo_lite.mmdb';
    ipInfoState.ipinfoApiToken = 'after-token';

    outputs.restoreUtilsGlobals(snapshot);

    expect([...pslOverrides]).toEqual(['example.co.uk']);
    expect(ipInfoState.ipDbPath).toBe('/before/ipinfo_lite.mmdb');
    expect(ipInfoState.ipinfoApiToken).toBe('before-token');
    // Restored in place, not rebound.
    expect(tsdmarc.pslOverrides).toBe(overridesObject);
  });

  it('testSnapshotIsNotAliasedToTheLiveOverridesList', () => {
    pslOverrides.splice(0, pslOverrides.length, 'example.co.uk');

    const snapshot = outputs.utilsGlobalsSnapshot();
    pslOverrides.length = 0;

    expect(snapshot.pslOverrides).toEqual(['example.co.uk']);
  });
});

describe('the Gmail deletion scope after a reload', () => {
  const GMAIL_CONFIG = `[gmail_api]
credentials_file = /tmp/gmail-credentials.json
scopes = https://www.googleapis.com/auth/gmail.modify

[mailbox]
watch = true
delete = true
delete_failure = true
`;

  async function watchedDeleteOptions(reloadedConfig: string): Promise<{
    delete: boolean | undefined;
    deleteFailure: boolean | null | undefined;
  }> {
    vi.spyOn(GmailConnection, 'connect').mockResolvedValue({
      close: vi.fn(async () => undefined),
    } as unknown as GmailConnection);
    const cfgPath = writeFile(GMAIL_CONFIG, '.ini');
    const watched: WatchOptions[] = [];
    vi.mocked(core.watchInbox).mockImplementation(async options => {
      watched.push({ ...options });
      if (watched.length === 1) {
        writeFileSync(cfgPath, reloadedConfig);
        sendSignal('SIGHUP');
        return;
      }
      throw fileExistsError('stop-watch-loop');
    });

    await expect(main(['-c', cfgPath])).rejects.toMatchObject({ code: 1 });

    const reloaded = watched[1];
    return {
      delete: reloaded?.delete,
      deleteFailure: reloaded?.deleteFailure,
    };
  }

  it('keeps deletion off without the scope', async () => {
    expect(await watchedDeleteOptions(GMAIL_CONFIG)).toEqual({
      delete: false,
      deleteFailure: false,
    });
  });

  it('keeps deletion off when only the reloaded file gains the scope', async () => {
    // The connection keeps the token and scopes it started with.
    const withScope = GMAIL_CONFIG.replace(
      'https://www.googleapis.com/auth/gmail.modify',
      'https://mail.google.com/',
    );
    expect(await watchedDeleteOptions(withScope)).toEqual({
      delete: false,
      deleteFailure: false,
    });
  });
});
