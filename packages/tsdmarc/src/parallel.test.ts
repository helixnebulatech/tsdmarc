// Tests for parallel.ts, ported from parsedmarc's tests/test_parallel.py,
// plus the thread-boundary details a process pool doesn't have.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as WorkerThreads from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createParserConfig, IP_ADDRESS_CACHE } from './config';
import {
  EnrichmentError,
  findEnrichmentError,
  InvalidAggregateReport,
  InvalidIPinfoAPIKey,
  IPDatabaseError,
  ParserError,
} from './errors';
import {
  configureLogging,
  DEBUG,
  FileHandler,
  type Handler,
  logger,
  WARNING,
} from './log';
import {
  BrokenProcessPool,
  decodeValue,
  encodeValue,
  captureWorkerSharedState,
  initWorker,
  JobTimeoutError,
  type ParallelTask,
  parallelMap,
  parseReportFileTask,
  WorkerCrashedError,
} from './parallel';
import { parseReportEmailJob } from './report-email';
import { parseReportFile } from './report-file';
import { markRaw, mixedObject, toSnakeCaseKeys } from './serialize';
import { samplePath } from './test/fixtures';
import type { ParsedReport } from './types';
import { PyDateTime } from './utils/datetime';
import { pslOverrides } from './utils/domains';
import { ValueError } from './utils/email';
import { ipInfoState } from './utils/ip-info';

const workerThreads = vi.hoisted(() => ({ created: 0, failStart: false }));

vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof WorkerThreads>();
  // Count the threads started, to observe "no pool for no jobs".
  class CountingWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workerThreads.created += 1;
      if (workerThreads.failStart) {
        // Stopped before it can start (post `ready`).
        void this.terminate();
      }
    }
  }
  return { ...actual, Worker: CountingWorker };
});

const SAMPLE_PATHS = [
  samplePath('aggregate/!example.com!1538204542!1538463818.xml'),
  samplePath('aggregate/!large-example.com!1711897200!1711983600.xml'),
  samplePath('aggregate/example.net!example.com!1529366400!1529452799.xml'),
];

const JOBS_MODULE = new URL('./__fixtures__/parallel/jobs.ts', import.meta.url);

function jobTask(name: string): ParallelTask {
  return { module: JOBS_MODULE, name };
}

/** Wraps a range and counts how many items were pulled. */
class CountingIterable implements Iterable<number> {
  pulled = 0;
  private readonly n: number;

  constructor(n: number) {
    this.n = n;
  }

  *[Symbol.iterator](): Iterator<number> {
    for (let index = 0; index < this.n; index += 1) {
      this.pulled += 1;
      yield index;
    }
  }
}

async function collect<R>(iterable: AsyncIterable<R>): Promise<R[]> {
  const results: R[] = [];
  for await (const item of iterable) {
    results.push(item);
  }
  return results;
}

const offlineConfig = () => createParserConfig({ offline: true });

describe('TestParallelMapParseReportFile', () => {
  beforeEach(() => {
    // A warm cache would make in-thread and worker results differ.
    IP_ADDRESS_CACHE.clear();
  });

  it('test_results_match_sequential_parsing_in_order', async () => {
    const expected: [string, ParsedReport][] = [];
    for (const filePath of SAMPLE_PATHS) {
      expected.push([
        filePath,
        await parseReportFile(filePath, { offline: true }),
      ]);
    }

    const results = await collect(
      parallelMap<string, [string, ParsedReport | Error]>(
        parseReportFileTask(offlineConfig()),
        SAMPLE_PATHS,
        2,
      ),
    );

    expect(results.map(([filePath]) => filePath)).toEqual(SAMPLE_PATHS);
    for (const [index, [, report]] of results.entries()) {
      expect(report).not.toBeInstanceOf(Error);
      expect(report).toEqual(expected[index]?.[1]);
    }
  });
});

describe('TestParallelMapJunkFile', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-parallel-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('test_junk_file_yields_exception_value_and_completes', async () => {
    const junkPath = path.join(directory, 'junk.xml');
    writeFileSync(junkPath, 'not a report');
    const results = await collect(
      parallelMap<string, [string, ParsedReport | Error]>(
        parseReportFileTask(offlineConfig()),
        [junkPath, junkPath],
        2,
      ),
    );
    expect(results).toHaveLength(2);
    for (const [filePath, result] of results) {
      expect(filePath).toBe(junkPath);
      // The class survives the thread boundary.
      expect(result).toBeInstanceOf(ParserError);
      expect((result as Error).message).toContain(
        'Not a recognized report format',
      );
    }
  });
});

describe('raw report keys across the thread boundary', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-parallel-raw-'));
    IP_ADDRESS_CACHE.clear();
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps reporter keys unrenamed and huge counts exact', async () => {
    const xml = readFileSync(SAMPLE_PATHS[0] as string, 'utf8')
      .replace('<count>1</count>', '<count>99999999999999999999</count>')
      .replace(
        '<header_from>example.com</header_from>',
        '<header_from>example.com</header_from><envelopeFrom>camel.example</envelopeFrom><envelope_from>snake.example</envelope_from><toString>x</toString>',
      )
      .replace(
        '</policy_evaluated>',
        '<reason><type>other</type><comment>c</comment><toString>y</toString></reason></policy_evaluated>',
      );
    const reportPath = path.join(directory, 'raw-keys.xml');
    writeFileSync(reportPath, xml);
    const sequential = toSnakeCaseKeys(
      await parseReportFile(reportPath, { offline: true }),
    );
    const [[, parallel] = []] = await collect(
      parallelMap<string, [string, ParsedReport | Error]>(
        parseReportFileTask(offlineConfig()),
        [reportPath],
        1,
      ),
    );
    expect(parallel).not.toBeInstanceOf(Error);
    const snake = toSnakeCaseKeys(parallel);
    expect(snake).toEqual(sequential);
    const record = (
      snake as {
        report: { records: Record<string, Record<string, unknown>>[] };
      }
    ).report.records[0];
    expect(record?.identifiers).toMatchObject({
      envelopeFrom: 'camel.example',
      envelope_from: 'snake.example',
      toString: 'x',
    });
    expect(record?.policy_evaluated?.policy_override_reasons).toEqual([
      { type: 'other', comment: 'c', toString: 'y' },
    ]);
    expect(record?.count).toBe(99_999_999_999_999_999_999n);
  });

  it('encodes and decodes raw marks in place', () => {
    const value = {
      raw: markRaw({ fooBar: 1 }),
      mixed: mixedObject([
        { key: 'knownField', value: 1, raw: false },
        { key: 'rawKey', value: { innerKey: 2 }, raw: true },
        { key: 'knownField', value: 3, raw: true },
      ]),
    };
    const decoded = decodeValue(structuredClone(encodeValue(value)));
    expect(toSnakeCaseKeys(decoded)).toEqual(toSnakeCaseKeys(value));
    expect(toSnakeCaseKeys(decoded)).toEqual({
      raw: { fooBar: 1 },
      mixed: { known_field: 1, rawKey: { innerKey: 2 }, knownField: 3 },
    });
  });
});

describe('TestParallelMapBoundedLaziness', () => {
  it('test_consumption_stays_bounded_and_results_are_complete_and_ordered', async () => {
    const n = 20;
    const windowFactor = 2;
    const nProcs = 2;
    const windowSize = windowFactor * nProcs;
    const jobs = new CountingIterable(n);
    const results: number[] = [];
    for await (const result of parallelMap<number, number>(
      jobTask('echoJob'),
      jobs,
      nProcs,
      { windowFactor },
    )) {
      results.push(result);
      expect(jobs.pulled).toBeLessThanOrEqual(windowSize + results.length + 1);
    }
    expect(results).toEqual([...Array.from({ length: n }).keys()]);
  });

  it('accepts an async iterable of jobs', async () => {
    async function* jobs(): AsyncGenerator<number> {
      for (let index = 0; index < 5; index += 1) {
        yield index;
      }
    }
    expect(await collect(parallelMap(jobTask('echoJob'), jobs(), 3))).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('yields in submission order, not completion order', async () => {
    const results = await collect(
      parallelMap<number, number>(jobTask('sleepJob'), [120, 10, 60, 0], 4),
    );
    expect(results).toEqual([120, 10, 60, 0]);
  });
});

describe('TestParallelMapShouldStop', () => {
  it('test_should_stop_ends_iteration_early', async () => {
    const n = 20;
    const jobs = new CountingIterable(n);
    const results = await collect(
      parallelMap<number, number>(jobTask('echoJob'), jobs, 2, {
        shouldStop: () => true,
      }),
    );
    expect(results.length).toBeLessThan(n);
    expect(jobs.pulled).toBeLessThan(n);
    expect(results).toEqual([...Array.from({ length: results.length }).keys()]);
  });
});

describe('TestParallelMapValidation', () => {
  it('test_n_procs_below_one_raises_value_error_eagerly', () => {
    expect(() => parallelMap(jobTask('echoJob'), [1, 2], 0)).toThrow(
      ValueError,
    );
    expect(() => parallelMap(jobTask('echoJob'), [1, 2], 0)).toThrow(
      'n_procs must be at least 1, got 0',
    );
  });
});

describe('TestParallelMapEmptyJobs', () => {
  it('test_empty_jobs_yields_nothing_and_spawns_no_pool', async () => {
    const before = workerThreads.created;
    expect(await collect(parallelMap(jobTask('echoJob'), [], 2))).toEqual([]);
    expect(workerThreads.created).toBe(before);
  });

  it('starts no more threads than nProcs', async () => {
    const before = workerThreads.created;
    await collect(parallelMap(jobTask('echoJob'), [1, 2, 3, 4, 5, 6], 2));
    expect(workerThreads.created - before).toBe(2);
  });
});

describe('parallelMap across the thread boundary', () => {
  it('throws a job error at its position, with its class', async () => {
    const iterator = parallelMap<string, unknown>(
      jobTask('failingJob'),
      ['boom'],
      1,
    );
    const error = await iterator.next().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidAggregateReport);
    expect((error as Error).message).toBe('boom');
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it('rebuilds errors and PyDateTime values inside results', async () => {
    const [result] = (await collect(
      parallelMap(jobTask('classyJob'), [null], 1),
    )) as [{ when: PyDateTime; errors: Error[] }];
    expect(result.when).toBeInstanceOf(PyDateTime);
    expect(result.when.isoformat()).toBe('2024-01-02T03:00:00+01:00');
    expect(result.errors[0]).toBeInstanceOf(InvalidAggregateReport);
  });

  it('fails only the job whose worker died', async () => {
    // parsedmarc's pool breaks (BrokenProcessPool) and every later job
    // fails; here the worker is replaced and the other jobs run.
    const results: unknown[] = [];
    const error = await (async () => {
      for await (const result of parallelMap(
        jobTask('crashOrEchoJob'),
        [1, 'crash', 3],
        1,
      )) {
        results.push(result);
      }
    })().catch((caught: unknown) => caught);
    expect(results).toEqual([1]);
    expect(error).toBeInstanceOf(WorkerCrashedError);
    expect(error).not.toBeInstanceOf(BrokenProcessPool);
  });

  it('turns failed jobs into results with onJobError and goes on', async () => {
    const results = await collect(
      parallelMap<unknown, unknown>(
        jobTask('crashOrEchoJob'),
        [1, 'crash', 3, 'crash', 5],
        2,
        { onJobError: (error, job) => ({ job, name: (error as Error).name }) },
      ),
    );
    expect(results).toEqual([
      1,
      { job: 'crash', name: 'WorkerCrashedError' },
      3,
      { job: 'crash', name: 'WorkerCrashedError' },
      5,
    ]);
  });

  it('passes errors thrown by a job to onJobError', async () => {
    const results = await collect(
      parallelMap<string, unknown>(jobTask('failingJob'), ['bad'], 1, {
        onJobError: error => error,
      }),
    );
    expect(results[0]).toBeInstanceOf(InvalidAggregateReport);
  });

  it('contains a worker over its heap limit: only its job fails', async () => {
    const results: unknown[] = [];
    for await (const item of parallelMap<unknown, unknown>(
      jobTask('exhaustOrEchoJob'),
      [1, 'exhaust', 3],
      2,
      { maxWorkerHeapMb: 64, onJobError: error => error },
    )) {
      results.push(item);
    }
    expect(results[0]).toBe(1);
    expect(results[2]).toBe(3);
    expect(results[1]).toBeInstanceOf(WorkerCrashedError);
    expect(((results[1] as Error).cause as NodeJS.ErrnoException).code).toBe(
      'ERR_WORKER_OUT_OF_MEMORY',
    );
  }, 60_000);

  it('takes maxWorkerHeapMb from the task config unless given', async () => {
    const task = (maxWorkerHeapMb: number): ParallelTask => ({
      ...jobTask('heapLimitJob'),
      config: createParserConfig({ maxWorkerHeapMb }),
    });
    const limits = async (
      limitedTask: ParallelTask,
      options: { maxWorkerHeapMb?: number } = {},
    ): Promise<unknown[]> => {
      const results: unknown[] = [];
      for await (const item of parallelMap(limitedTask, [1], 1, options)) {
        results.push(item);
      }
      return results;
    };
    expect(await limits(task(300))).toEqual([300]);
    expect(await limits(task(300), { maxWorkerHeapMb: 200 })).toEqual([200]);
    const [runtimeLimit] = await limits(jobTask('heapLimitJob'));
    expect(runtimeLimit).toBeGreaterThan(300);
    expect(await limits(task(0))).toEqual([runtimeLimit]);
  });

  it('keeps enrichment errors behind a report error across threads', async () => {
    const results: unknown[] = [];
    for (const name of ['revokedTokenEmailJob', 'ipDatabaseErrorJob']) {
      for await (const item of parallelMap(jobTask(name), [1], 1)) {
        results.push(item);
      }
    }
    expect(findEnrichmentError(results[0])).toBeInstanceOf(InvalidIPinfoAPIKey);
    const databaseError = findEnrichmentError(results[1]);
    expect(databaseError).toBeInstanceOf(IPDatabaseError);
    expect(databaseError).toBeInstanceOf(EnrichmentError);
    expect((databaseError as IPDatabaseError).code).toBe('ENOENT');
  });

  it('stops a job after jobTimeout and replaces its worker', async () => {
    const results = await collect(
      parallelMap<unknown, unknown>(
        jobTask('hangOrEchoJob'),
        ['hang', 3],
        1,
        // Generous: the next job runs in a new worker, module import
        // included, on a possibly loaded machine.
        { jobTimeout: 5, onJobError: error => error },
      ),
    );
    expect(results[0]).toBeInstanceOf(JobTimeoutError);
    expect(results[1]).toBe(3);
  });

  it('breaks the pool when a worker cannot start, even with onJobError', async () => {
    workerThreads.failStart = true;
    const onJobError = vi.fn((error: unknown) => error);
    try {
      const error = await collect(
        parallelMap(jobTask('echoJob'), [1, 2], 1, { onJobError }),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BrokenProcessPool);
      expect(onJobError).not.toHaveBeenCalled();
    } finally {
      workerThreads.failStart = false;
    }
  });

  it("test_workers_see_parent_ip_state: workers get the main thread's IP database, IPinfo token, PSL overrides and reverse DNS map", async () => {
    const saved = {
      ipDbPath: ipInfoState.ipDbPath,
      ipinfoApiToken: ipInfoState.ipinfoApiToken,
      pslOverrides: [...pslOverrides],
    };
    ipInfoState.ipDbPath = '/main/chosen.mmdb';
    ipInfoState.ipinfoApiToken = 'token-from-main';
    pslOverrides.push('override-from-main.example');
    const reverseDnsMap = new Map([
      ['example.net', { name: 'Example', type: 'Test' }],
    ]);
    try {
      const [state] = await collect(
        parallelMap(
          {
            module: JOBS_MODULE,
            name: 'sharedStateJob',
            config: createParserConfig({ offline: true, reverseDnsMap }),
          },
          [null],
          1,
        ),
      );
      expect(state).toEqual({
        ipDbPath: '/main/chosen.mmdb',
        ipinfoApiToken: 'token-from-main',
        pslOverrides: [...pslOverrides],
        reverseDnsMap: [['example.net', { name: 'Example', type: 'Test' }]],
      });
    } finally {
      ipInfoState.ipDbPath = saved.ipDbPath;
      ipInfoState.ipinfoApiToken = saved.ipinfoApiToken;
      pslOverrides.splice(0, pslOverrides.length, ...saved.pslOverrides);
    }
  });

  it('rejects a task naming a missing function', async () => {
    const error = await collect(parallelMap(jobTask('nope'), [1], 1)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TypeError);
  });

  it('calls heartbeat while waiting for a slow job', async () => {
    let beats = 0;
    const results = await collect(
      parallelMap<number, number>(jobTask('sleepJob'), [300], 1, {
        heartbeat: () => {
          beats += 1;
        },
        heartbeatInterval: 0.05,
      }),
    );
    expect(results).toEqual([300]);
    expect(beats).toBeGreaterThanOrEqual(2);
  });

  it('a failing heartbeat ends the iteration without failing the job', async () => {
    const onJobError = vi.fn((error: unknown) => error);
    const error = await collect(
      parallelMap<number, unknown>(jobTask('sleepJob'), [60_000], 1, {
        heartbeat: () => Promise.reject(new Error('NOOP failed')),
        heartbeatInterval: 0.05,
        onJobError,
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toEqual(new Error('NOOP failed'));
    expect(onJobError).not.toHaveBeenCalled();
  });

  it('takes jobTimeout from the task config unless given', async () => {
    const task = (jobTimeout: number): ParallelTask => ({
      ...jobTask('hangOrEchoJob'),
      config: createParserConfig({ offline: true, jobTimeout }),
    });
    const fromConfig = await collect(
      parallelMap<unknown, unknown>(task(0.2), ['hang'], 1, {
        onJobError: error => error,
      }),
    );
    expect(fromConfig[0]).toBeInstanceOf(JobTimeoutError);
    const overridden = await collect(
      parallelMap<unknown, unknown>(task(0.2), [3], 1, { jobTimeout: 60 }),
    );
    expect(overridden).toEqual([3]);
  });

  // Bundlers only emit the worker file for this exact inline form; a URL
  // built in a separate statement leaves dist/ bundles without the worker.
  it('creates the built worker with the inline form bundlers rewrite', () => {
    const source = readFileSync(
      new URL('parallel.ts', import.meta.url),
      'utf-8',
    );
    expect(source).toMatch(
      /new Worker\(new URL\('\.\/parallel-worker\.js', import\.meta\.url\), \{/u,
    );
  });

  it('encodes and decodes values in place', () => {
    const value = {
      list: [new ParserError('x'), 1],
      when: new PyDateTime({ year: 2020, month: 5, day: 6 }),
    };
    const decoded = decodeValue(
      structuredClone(encodeValue(value)),
    ) as typeof value;
    expect(decoded.list[0]).toBeInstanceOf(ParserError);
    expect(decoded.when).toBeInstanceOf(PyDateTime);
    expect(decoded.when.equals(value.when)).toBe(true);
    const error = decodeValue(
      structuredClone(encodeValue(new ParserError('top'))),
    );
    expect(error).toBeInstanceOf(ParserError);
  });
});

describe('worker logging', () => {
  let savedHandlers: Handler[];
  let savedLevel: number;
  let directory: string;

  beforeEach(() => {
    savedHandlers = [...logger.handlers];
    savedLevel = logger.level;
    directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-parallel-log-'));
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

  it('test_worker_debug_log_reaches_parent_file_handler', async () => {
    const logPath = path.join(directory, 'parallel.log');
    configureLogging(DEBUG, logPath);
    const [sample] = SAMPLE_PATHS as [string];
    const results = await collect(
      parallelMap<string, [string, ParsedReport | Error]>(
        parseReportFileTask(offlineConfig()),
        [sample],
        2,
      ),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.[0]).toBe(sample);
    expect(results[0]?.[1]).not.toBeInstanceOf(Error);
    expect(readFileSync(logPath, 'utf-8')).toContain(`Parsing ${sample}`);
  });

  it('test_no_log_files_sets_level_only', () => {
    initWorker(WARNING, [], captureWorkerSharedState(null), new Map());
    expect(logger.level).toBe(WARNING);
  });

  it('test_log_files_attach_file_handlers', () => {
    const logPath = path.join(directory, 'worker.log');
    initWorker(DEBUG, [logPath], captureWorkerSharedState(null), new Map());
    expect(logger.level).toBe(DEBUG);
    const fileHandlers = logger.handlers.filter(
      handler => handler instanceof FileHandler,
    );
    expect(fileHandlers.some(handler => handler.baseFilename === logPath)).toBe(
      true,
    );
  });
});

describe('TestParseReportEmailJob', () => {
  it('test_invalid_email_returns_parser_error_value', async () => {
    const result = await parseReportEmailJob(
      new TextEncoder().encode('not a valid email'),
      { config: offlineConfig() },
    );
    expect(result).toBeInstanceOf(ParserError);
  });
});
