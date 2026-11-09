// Graceful SIGTERM/SIGINT shutdown (parsedmarc's TestSigtermShutdown).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { IMAPConnection } from '@tsdmarc/imap';
import * as tsdmarc from 'tsdmarc';
import { logger } from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as config from './config';
import { ConfigParser } from './configparser';
import * as core from './core';
import { cliProcess, main } from './main';
import type { CliOptions } from './options';
import * as outputs from './outputs';
import type { Closable } from './outputs';
import { stdout } from './process-reports';

type Signal = 'SIGHUP' | 'SIGTERM' | 'SIGINT';

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
  const dir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-signals-'));
  tempDirs.push(dir);
  return dir;
}

const BASE_CONFIG = `[general]
silent = true

[imap]
host = imap.example.com
user = user
password = pass

[mailbox]
watch = true
`;

function writeConfig(body: string = BASE_CONFIG): string {
  const filePath = path.join(tempDir(), 'config.ini');
  writeFileSync(filePath, body);
  return filePath;
}

function emptyReports(): tsdmarc.ParsingResults {
  return { aggregateReports: [], failureReports: [], smtpTlsReports: [] };
}

async function parseConfigSideEffect(
  _config: ConfigParser,
  opts: CliOptions,
): Promise<null> {
  opts.imapHost = 'imap.example.com';
  opts.imapUser = 'user';
  opts.imapPassword = 'pass';
  opts.mailboxWatch = true;
  return null;
}

beforeEach(() => {
  baselineListeners = new Map(
    SIGNALS.map(signal => [signal, new Set(process.listeners(signal))]),
  );
  logger.disabled = true;
  vi.spyOn(stdout, 'write').mockImplementation(() => undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('TestSigtermShutdown', () => {
  function mockWatchSetup(clients: Map<string, Closable>): void {
    vi.spyOn(IMAPConnection, 'connect').mockResolvedValue({
      close: vi.fn(async () => undefined),
    } as unknown as IMAPConnection);
    vi.mocked(config.loadConfig).mockReturnValue(new ConfigParser());
    vi.mocked(config.parseConfig).mockImplementation(parseConfigSideEffect);
    vi.mocked(core.getDmarcReportsFromMailbox).mockResolvedValue(
      emptyReports(),
    );
    vi.mocked(outputs.initOutputClients).mockResolvedValue(clients);
  }

  it('testSigtermDuringWatchExitsCleanlyAndClosesClients', async () => {
    const kafkaClient = { close: vi.fn() };
    const elasticsearchClient = { close: vi.fn() };
    // No `close`: skipped.
    const noCloseClient = {} as Closable;
    mockWatchSetup(
      new Map<string, Closable>([
        ['kafka', kafkaClient],
        ['elasticsearch', elasticsearchClient],
        ['syslog', noCloseClient],
      ]),
    );
    const observed: boolean[] = [];
    vi.mocked(core.watchInbox).mockImplementation(async options => {
      // SIGTERM lands while watching; the backend then polls
      // configReloading at its next safe boundary and returns.
      sendSignal('SIGTERM');
      observed.push(options.configReloading?.() ?? false);
    });

    await main(['-c', writeConfig()]);

    expect(core.watchInbox).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([true]);
    expect(kafkaClient.close).toHaveBeenCalled();
    expect(elasticsearchClient.close).toHaveBeenCalled();
  });

  it('testFirstSigintGracefulSecondSigintHardExits', async () => {
    mockWatchSetup(new Map());
    const sentinel = new Error('process.exit was reached');
    const hardExit = vi.spyOn(cliProcess, 'hardExit').mockImplementation(() => {
      throw sentinel;
    });
    let flagAfterFirst = false;
    vi.mocked(core.watchInbox).mockImplementation(async options => {
      sendSignal('SIGINT'); // first press: graceful flag
      flagAfterFirst = options.configReloading?.() ?? false;
      sendSignal('SIGINT'); // second press: hard exit
    });

    await expect(main(['-c', writeConfig()])).rejects.toBe(sentinel);

    expect(flagAfterFirst).toBe(true);
    expect(hardExit).toHaveBeenCalledTimes(1);
    expect(hardExit).toHaveBeenCalledWith(130);
  });

  it('testSigtermDuringOneShotStopsEarlyAndSkipsMbox', async () => {
    // Real files, parsed by real worker threads. SIGTERM arrives during the
    // mbox scan that precedes parsing (parsedmarc raises it on the first
    // pool submission): the parallel window (2 * nProcs) is primed with two
    // jobs before shouldStop is first checked, so the third and fourth file
    // are never parsed, and the mbox loop breaks at once.
    const dir = tempDir();
    const names = ['a.xml', 'b.xml', 'c.xml', 'd.xml', 'e.mbox'];
    for (const name of names) {
      writeFileSync(path.join(dir, name), 'not a report\n');
    }
    const kafkaClient = { close: vi.fn() };
    vi.mocked(outputs.initOutputClients).mockResolvedValue(
      new Map([['kafka', kafkaClient]]),
    );
    let signalled = false;
    vi.mocked(tsdmarc.isMbox).mockImplementation(async filePath => {
      if (!signalled) {
        signalled = true;
        sendSignal('SIGTERM');
      }
      return filePath.endsWith('.mbox');
    });
    logger.disabled = false;
    const logs = tsdmarc.captureLogs(logger, tsdmarc.ERROR);

    try {
      await main(['--offline', ...names.map(name => path.join(dir, name))]);
    } finally {
      logs.restore();
    }

    const parsed = logs.output
      .filter(line => line.includes('Failed to parse'))
      .map(line =>
        path.basename(line.split('Failed to parse ')[1]?.split(' - ')[0] ?? ''),
      );
    expect(parsed).toEqual(['a.xml', 'b.xml']);
    expect(tsdmarc.getDmarcReportsFromMbox).not.toHaveBeenCalled();
    expect(kafkaClient.close).toHaveBeenCalled();
  });

  it('testNormalOneShotExitClosesOutputClients', async () => {
    const kafkaClient = { close: vi.fn() };
    const esClient = { close: vi.fn() };
    vi.mocked(outputs.initOutputClients).mockResolvedValue(
      new Map([
        ['kafka', kafkaClient],
        ['elasticsearch', esClient],
      ]),
    );

    // No watch, no mailbox, no matching files: the run returns normally.
    await main([path.join(tempDir(), 'nothing-here.xml')]);

    expect(kafkaClient.close).toHaveBeenCalledTimes(1);
    expect(esClient.close).toHaveBeenCalledTimes(1);
  });
});
