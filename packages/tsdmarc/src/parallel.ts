// Bounded-window parallel report parsing with worker threads, ported from
// parsedmarc/parallel.py (which uses a ProcessPoolExecutor).
//
// A function can't be sent to a worker, so a task names it: one of the
// built-in jobs below, or an export of a module the worker imports (the
// counterpart of pickling a module-level function by name). A config is
// sent as `parserConfigToState()` and rebuilt with `parserConfigFromState()`
// in the worker, so its caches never cross threads (Python's
// `__getstate__`/`__setstate__`); each worker uses its own module-default
// caches. A loaded reverse DNS map, the selected IP database, the IPinfo
// token and the PSL overrides are copied to each worker (see
// `WorkerSharedState`).
//
// Values crossing threads are structured-cloned. Errors and `PyDateTime`
// values lose their class in a structured clone, and objects lose the
// raw-data brands of `serialize.ts` (non-enumerable symbols), so all three
// are encoded and rebuilt on the other side.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ResourceLimits, Worker } from 'node:worker_threads';

import {
  type ParserConfig,
  type ParserOptions,
  parserConfigFromState,
  parserConfigToState,
} from './config';
import {
  DownloadError,
  EmailParserError,
  EmailTooLargeError,
  EnrichmentError,
  InvalidAggregateReport,
  InvalidDMARCReport,
  InvalidFailureReport,
  InvalidIPinfoAPIKey,
  InvalidSMTPTLSReport,
  IPDatabaseError,
  ParserError,
} from './errors';
import { configureLogging, FileHandler, logger } from './log';
import { getRawMarks, type RawMarks, restoreRawMarks } from './serialize';
import type { ReverseDNSService } from './types';
import { PyDateTime } from './utils/datetime';
import { pslOverrides } from './utils/domains';
import { ValueError } from './utils/email';
import { ipInfoState } from './utils/ip-info';

/**
 * Pool initializer (parsedmarc's `_init_worker`): restore the parent's
 * lookup context in a worker, which starts with fresh modules. The IP
 * database path, IPinfo API token and PSL overrides (and, unlike
 * parsedmarc, a loaded reverse DNS map) come from `shared`, so enrichment
 * matches what the main thread configured; then the parent's logging is
 * rebuilt, so records logged while parsing in a worker are not dropped.
 */
export function initWorker(
  logLevel: number,
  logFiles: readonly string[],
  shared: WorkerSharedState,
  reverseDnsMap: Map<string, ReverseDNSService>,
): void {
  applyWorkerSharedState(shared, reverseDnsMap);
  if (logFiles.length === 0) {
    configureLogging(logLevel, null);
    return;
  }
  for (const logFile of logFiles) {
    configureLogging(logLevel, logFile);
  }
}

/** Options passed to a job function when its task carries a config. */
export interface ParallelJobOptions {
  config: ParserConfig;
}

/** What a worker runs for each job: `fn(job)` or `fn(job, { config })`. */
export interface ParallelTask {
  /**
   * URL or absolute path of an ES module exporting the function. Omit to
   * use a built-in job: `parseReportEmailJob` or `parseReportFileJob`.
   */
  module?: string | URL | null;
  /** Name of the exported function. */
  name: string;
  /** Parser config; rebuilt in the worker and passed as `{ config }`. */
  config?: ParserConfig | null;
}

/** Task running `parseReportEmailJob` (report-email.ts) with `config`. */
export function parseReportEmailTask(config: ParserConfig): ParallelTask {
  return { name: 'parseReportEmailJob', config };
}

/** Task running `parseReportFileJob` (report-file.ts) with `config`. */
export function parseReportFileTask(config: ParserConfig): ParallelTask {
  return { name: 'parseReportFileJob', config };
}

/** A task as sent to a worker. */
export interface WireTask {
  module: string | null;
  name: string;
  configState: ParserOptions | null;
}

function toWireTask(task: ParallelTask): WireTask {
  return {
    module: task.module ? String(task.module) : null,
    name: task.name,
    configState: task.config ? parserConfigToState(task.config) : null,
  };
}

/** Job functions by name. */
export type JobRegistry = Readonly<Record<string, unknown>>;

/**
 * Run one job in this thread, as a worker does. `builtins` holds the jobs a
 * task can name without a module.
 */
export async function runWireTask(
  task: WireTask,
  job: unknown,
  builtins: JobRegistry,
): Promise<unknown> {
  let fn: unknown;
  if (task.module === null) {
    fn = Object.hasOwn(builtins, task.name) ? builtins[task.name] : undefined;
  } else {
    const specifier = path.isAbsolute(task.module)
      ? pathToFileURL(task.module).href
      : task.module;
    const imported = (await import(specifier)) as Record<string, unknown>;
    fn = imported[task.name];
  }
  if (typeof fn !== 'function') {
    throw new TypeError(
      `${task.module ?? 'tsdmarc'} has no job function named ${task.name}`,
    );
  }
  const run = fn as (job: unknown, options?: ParallelJobOptions) => unknown;
  if (task.configState === null) {
    return run(job);
  }
  return run(job, { config: parserConfigFromState(task.configState) });
}

// --- Module state across threads --------------------------------------------

/**
 * Module-level enrichment state the main thread may have set up before
 * parsing in parallel (the IP database `loadIpDb()` chose, the IPinfo API
 * token, PSL overrides loaded from a URL or file, a loaded reverse DNS
 * map). A worker starts with fresh modules, so it gets a copy: otherwise it
 * would use the bundled IP database, no IPinfo API, the bundled overrides
 * and download the map again. parsedmarc's forkserver workers start fresh
 * too and have the same gap.
 */
export interface WorkerSharedState {
  ipDbPath: string | null;
  ipinfoApiToken: string | null;
  pslOverrides: string[];
  /** Entries of the task config's reverse DNS map, when it is loaded. */
  reverseDnsMap: [string, ReverseDNSService][] | null;
}

/** Snapshot the state to hand to workers running a task with `config`. */
export function captureWorkerSharedState(
  config: ParserConfig | null | undefined,
): WorkerSharedState {
  const map = config?.reverseDnsMap;
  return {
    ipDbPath: ipInfoState.ipDbPath,
    ipinfoApiToken: ipInfoState.ipinfoApiToken,
    pslOverrides: [...pslOverrides],
    reverseDnsMap: map && map.size > 0 ? [...map] : null,
  };
}

/**
 * Install a snapshot from {@link captureWorkerSharedState} in this thread;
 * the reverse DNS map entries go into `reverseDnsMap` (the module default
 * that `parserConfigFromState()` binds).
 */
export function applyWorkerSharedState(
  state: WorkerSharedState,
  reverseDnsMap: Map<string, ReverseDNSService>,
): void {
  if (state.ipDbPath !== null) {
    ipInfoState.ipDbPath = state.ipDbPath;
  }
  ipInfoState.ipinfoApiToken = state.ipinfoApiToken;
  pslOverrides.splice(0, pslOverrides.length, ...state.pslOverrides);
  if (state.reverseDnsMap !== null) {
    reverseDnsMap.clear();
    for (const [key, value] of state.reverseDnsMap) {
      reverseDnsMap.set(key, value);
    }
  }
}

// --- Values across threads -------------------------------------------------

const ERROR_CLASSES: Readonly<Record<string, new (message: string) => Error>> =
  {
    DownloadError,
    EmailParserError,
    EmailTooLargeError,
    EnrichmentError,
    InvalidAggregateReport,
    InvalidDMARCReport,
    InvalidFailureReport,
    InvalidIPinfoAPIKey,
    InvalidSMTPTLSReport,
    IPDatabaseError,
    ParserError,
    RangeError,
    TypeError,
    ValueError,
  };

const MAX_CAUSE_DEPTH = 5;

/** An error flattened for a structured clone. */
export interface EncodedError {
  name: string;
  message: string;
  stack: string | null;
  cause: EncodedError | null;
  code: string | null;
}

/**
 * An `Error` or `PyDateTime` found inside a value, or the raw-data brands
 * of an object in it, by path.
 */
interface SpecialValue {
  path: (string | number)[];
  error?: EncodedError;
  datetime?: ReturnType<PyDateTime['fields']>;
  rawMarks?: RawMarks;
}

/** A value ready for `postMessage`, with errors and datetimes encoded. */
export interface EncodedValue {
  value: unknown;
  specials: SpecialValue[];
}

export function encodeError(error: unknown, depth = 0): EncodedError {
  if (!(error instanceof Error)) {
    return {
      name: 'Error',
      message: String(error),
      stack: null,
      cause: null,
      code: null,
    };
  }
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
    cause:
      error.cause !== undefined && depth < MAX_CAUSE_DEPTH
        ? encodeError(error.cause, depth + 1)
        : null,
    code: typeof code === 'string' ? code : null,
  };
}

export function decodeError(encoded: EncodedError): Error {
  const ErrorClass = Object.hasOwn(ERROR_CLASSES, encoded.name)
    ? ERROR_CLASSES[encoded.name]
    : undefined;
  const error = ErrorClass
    ? new ErrorClass(encoded.message)
    : new Error(encoded.message);
  if (error.name !== encoded.name) {
    error.name = encoded.name;
  }
  if (encoded.stack !== null) {
    error.stack = encoded.stack;
  }
  if (encoded.cause !== null) {
    error.cause = decodeError(encoded.cause);
  }
  if (encoded.code !== null) {
    (error as { code?: string }).code = encoded.code;
  }
  return error;
}

function findSpecials(
  value: unknown,
  path: (string | number)[],
  specials: SpecialValue[],
): void {
  if (value instanceof Error) {
    specials.push({ path: [...path], error: encodeError(value) });
    return;
  }
  if (value instanceof PyDateTime) {
    specials.push({ path: [...path], datetime: value.fields() });
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const rawMarks = getRawMarks(value);
    if (rawMarks !== null) {
      specials.push({ path: [...path], rawMarks });
    }
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      path.push(index);
      findSpecials(item, path, specials);
      path.pop();
    }
    return;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !ArrayBuffer.isView(value)
  ) {
    if (value instanceof Map) {
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      path.push(key);
      findSpecials(item, path, specials);
      path.pop();
    }
  }
}

/** Encode a value for `postMessage`. */
export function encodeValue(value: unknown): EncodedValue {
  const specials: SpecialValue[] = [];
  findSpecials(value, [], specials);
  return { value, specials };
}

function valueAt(root: unknown, valuePath: (string | number)[]): unknown {
  let current = root;
  for (const key of valuePath) {
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** Rebuild a value received from `postMessage`. */
export function decodeValue(encoded: EncodedValue): unknown {
  let { value } = encoded;
  for (const special of encoded.specials) {
    if (special.rawMarks) {
      const target = valueAt(value, special.path);
      if (typeof target === 'object' && target !== null) {
        restoreRawMarks(target, special.rawMarks);
      }
      continue;
    }
    let rebuilt: unknown;
    if (special.error) {
      rebuilt = decodeError(special.error);
    } else if (special.datetime) {
      rebuilt = new PyDateTime(special.datetime);
    } else {
      continue;
    }
    if (special.path.length === 0) {
      value = rebuilt;
      continue;
    }
    let parent = value as Record<string | number, unknown>;
    for (const key of special.path.slice(0, -1)) {
      parent = parent[key] as Record<string | number, unknown>;
    }
    const last = special.path.at(-1) as string | number;
    parent[last] = rebuilt;
  }
  return value;
}

// --- Worker pool -------------------------------------------------------------

/** Data each worker starts with. */
export interface WorkerInit {
  logLevel: number;
  logFiles: string[];
  task: WireTask;
  shared: WorkerSharedState;
}

/** Messages from the parent to a worker. */
export type ToWorkerMessage =
  | { type: 'run'; id: number; job: unknown }
  | { type: 'close' };

/** Messages from a worker to the parent. */
export type FromWorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; ok: true; value: EncodedValue }
  | { type: 'result'; id: number; ok: false; error: EncodedError };

/**
 * Python's `concurrent.futures.process.BrokenProcessPool`: the pool can't
 * run jobs at all (a worker failed while starting).
 */
export class BrokenProcessPool extends Error {
  override name = 'BrokenProcessPool';
}

/**
 * A worker thread died while running a job (over its heap limit,
 * `process.exit()` or an uncaught error outside the job's promise). Only
 * that job fails; the worker is replaced. parsedmarc's process pool breaks
 * for good instead (`BrokenProcessPool`). It says nothing about the job's
 * content: the heap also holds what the worker kept from earlier jobs.
 */
export class WorkerCrashedError extends Error {
  override name = 'WorkerCrashedError';
}

/** A job ran longer than `jobTimeout`; its worker was stopped and replaced. */
export class JobTimeoutError extends Error {
  override name = 'JobTimeoutError';
}

const BROKEN_POOL_MESSAGE =
  'A process in the process pool was terminated abruptly while the future was running or pending.';

const isSourceModule = import.meta.url.endsWith('.ts');

/** Node can't resolve the extensionless imports of `src/` on its own. */
const SOURCE_BOOTSTRAP = `
const { registerHooks } = require('node:module');
const { workerData } = require('node:worker_threads');
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && context.parentURL && context.parentURL.endsWith('.ts')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});
import(workerData.entry);
`;

/**
 * The worker entry next to the `src/` module. Held in a variable so
 * bundlers don't pick it up as an asset: only `dist/` ships, without it.
 */
const SOURCE_WORKER_ENTRY = './parallel-worker.ts';

function createWorker(init: WorkerInit, limits: ResourceLimits | null): Worker {
  const resourceLimits = limits === null ? {} : { resourceLimits: limits };
  if (isSourceModule) {
    const entry = new URL(SOURCE_WORKER_ENTRY, import.meta.url);
    const runsTypeScriptNatively = 'Bun' in globalThis || 'Deno' in globalThis;
    if (runsTypeScriptNatively) {
      return new Worker(entry, { workerData: init, ...resourceLimits });
    }
    return new Worker(SOURCE_BOOTSTRAP, {
      eval: true,
      workerData: { ...init, entry: entry.href },
      ...resourceLimits,
    });
  }
  // Inline `new Worker(new URL('./x.js', import.meta.url))`: the only form
  // bundlers (Vite, webpack, Rollup plugins, esbuild) rewrite to the
  // emitted worker file.
  return new Worker(new URL('./parallel-worker.js', import.meta.url), {
    workerData: init,
    ...resourceLimits,
  });
}

interface PoolTask {
  id: number;
  job: unknown;
  state: 'queued' | 'running' | 'done' | 'cancelled';
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface PoolWorker {
  worker: Worker;
  current: PoolTask | null;
  /** The worker finished starting (posted `ready`). */
  ready: boolean;
  /** The worker exited, failed or was stopped; its later events are ignored. */
  gone: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const MS_PER_SECOND = 1000;

/** Upper bound of a worker's young generation, in MiB. */
const MAX_YOUNG_GENERATION_MB = 32;
/** The young generation is at most this fraction of the old generation. */
const YOUNG_GENERATION_DIVISOR = 4;

/**
 * The young generation size for a worker whose old generation is limited to
 * `maxWorkerHeapMb`. Without it, Node picks its own default (192 MiB on Node
 * 24, 96 MiB on Node 26), larger than a small old generation: when V8 then
 * promotes a full young generation it runs out of room before Node can stop
 * the worker, and the whole process dies with "Reached heap limit" instead of
 * the worker failing with ERR_WORKER_OUT_OF_MEMORY. Seen on Node 24 under
 * load; a bounded young generation keeps the failure inside the worker.
 */
export function youngGenerationMb(maxWorkerHeapMb: number): number {
  return Math.max(
    1,
    Math.min(
      MAX_YOUNG_GENERATION_MB,
      Math.floor(maxWorkerHeapMb / YOUNG_GENERATION_DIVISOR),
    ),
  );
}

class WorkerPool {
  private readonly size: number;
  private readonly init: WorkerInit;
  private readonly jobTimeoutMs: number | null;
  private readonly resourceLimits: ResourceLimits | null;
  private readonly workers: PoolWorker[] = [];
  private readonly queue: PoolTask[] = [];
  private nextId = 0;
  private broken: Error | null = null;
  private closing = false;

  constructor(
    size: number,
    init: WorkerInit,
    jobTimeout: number | null,
    maxWorkerHeapMb: number | null,
  ) {
    this.size = size;
    this.init = init;
    this.jobTimeoutMs =
      jobTimeout !== null && jobTimeout > 0 ? jobTimeout * MS_PER_SECOND : null;
    this.resourceLimits =
      maxWorkerHeapMb !== null && maxWorkerHeapMb > 0
        ? {
            maxOldGenerationSizeMb: maxWorkerHeapMb,
            maxYoungGenerationSizeMb: youngGenerationMb(maxWorkerHeapMb),
          }
        : null;
  }

  submit(job: unknown): PoolTask {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Rejections are observed when the task is harvested.
    promise.catch(() => undefined);
    const task: PoolTask = {
      id: this.nextId,
      job,
      state: 'queued',
      promise,
      resolve,
      reject,
    };
    this.nextId += 1;
    if (this.broken) {
      task.state = 'done';
      reject(this.broken);
      return task;
    }
    this.queue.push(task);
    this.dispatch();
    return task;
  }

  private dispatch(): void {
    while (this.queue.length > 0 && !this.broken && !this.closing) {
      let idle = this.workers.find(entry => entry.current === null);
      if (!idle && this.workers.length < this.size) {
        idle = this.spawn();
      }
      if (!idle) {
        return;
      }
      const task = this.queue.shift() as PoolTask;
      task.state = 'running';
      idle.current = task;
      if (idle.ready) {
        this.startTimer(idle);
      }
      const message: ToWorkerMessage = {
        type: 'run',
        id: task.id,
        job: task.job,
      };
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker thread, not a window.
      idle.worker.postMessage(message);
    }
  }

  private spawn(): PoolWorker {
    const entry: PoolWorker = {
      worker: createWorker(this.init, this.resourceLimits),
      current: null,
      ready: false,
      gone: false,
      timer: null,
    };
    entry.worker.on('message', (message: FromWorkerMessage) => {
      if (message.type === 'ready') {
        entry.ready = true;
        // A job sent while the worker was starting is timed from now.
        this.startTimer(entry);
        return;
      }
      const task = entry.current;
      if (entry.gone || task === null || task.id !== message.id) {
        return;
      }
      this.release(entry);
      task.state = 'done';
      if (message.ok) {
        task.resolve(decodeValue(message.value));
      } else {
        task.reject(decodeError(message.error));
      }
      this.dispatch();
    });
    entry.worker.on('error', error => {
      this.workerFailed(entry, error);
    });
    entry.worker.on('exit', code => {
      if (this.closing && entry.current === null) {
        this.remove(entry);
        return;
      }
      this.workerFailed(
        entry,
        new Error(`Worker thread exited with code ${String(code)}`),
      );
    });
    this.workers.push(entry);
    return entry;
  }

  /** Start the `jobTimeout` timer of a worker's current task. */
  private startTimer(entry: PoolWorker): void {
    const task = entry.current;
    if (this.jobTimeoutMs === null || task === null || entry.timer !== null) {
      return;
    }
    entry.timer = setTimeout(() => {
      this.timeOut(entry, task);
    }, this.jobTimeoutMs);
  }

  /** Clear a worker's current task and its timer. */
  private release(entry: PoolWorker): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.current = null;
  }

  private remove(entry: PoolWorker): void {
    entry.gone = true;
    const index = this.workers.indexOf(entry);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }
  }

  /**
   * A worker died. Before it finished starting, the pool is unusable
   * (Python's `BrokenProcessPool`); after, only its running job fails and a
   * new worker takes over the queue.
   */
  private workerFailed(entry: PoolWorker, cause: unknown): void {
    if (entry.gone) {
      return;
    }
    const task = entry.current;
    this.release(entry);
    this.remove(entry);
    if (!entry.ready) {
      this.breakPool(cause, task);
      return;
    }
    if (task !== null) {
      task.state = 'done';
      task.reject(
        new WorkerCrashedError(
          'A worker thread terminated abruptly while running this job',
          { cause },
        ),
      );
    }
    this.dispatch();
  }

  private timeOut(entry: PoolWorker, task: PoolTask): void {
    if (entry.gone || entry.current !== task) {
      return;
    }
    this.release(entry);
    this.remove(entry);
    void entry.worker.terminate();
    task.state = 'done';
    task.reject(
      new JobTimeoutError(
        `Job did not finish within ${String((this.jobTimeoutMs ?? 0) / MS_PER_SECOND)} seconds`,
      ),
    );
    this.dispatch();
  }

  private breakPool(cause: unknown, failedTask: PoolTask | null): void {
    if (this.broken) {
      return;
    }
    this.broken = new BrokenProcessPool(BROKEN_POOL_MESSAGE, { cause });
    if (failedTask !== null) {
      failedTask.state = 'done';
      failedTask.reject(this.broken);
    }
    for (const entry of this.workers) {
      if (entry.current) {
        entry.current.state = 'done';
        entry.current.reject(this.broken);
        this.release(entry);
      }
    }
    for (const task of this.queue.splice(0)) {
      task.state = 'done';
      task.reject(this.broken);
    }
    void this.terminate();
  }

  /** Cancel tasks that have not started (`cancel_futures=True`). */
  cancelQueued(): void {
    for (const task of this.queue.splice(0)) {
      task.state = 'cancelled';
      task.resolve(undefined);
    }
  }

  /** Let idle workers exit; wait for them. */
  async close(): Promise<void> {
    this.closing = true;
    this.cancelQueued();
    await Promise.all(
      this.workers.map(
        entry =>
          new Promise<void>(resolve => {
            entry.worker.once('exit', () => resolve());
            const message: ToWorkerMessage = { type: 'close' };
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker thread, not a window.
            entry.worker.postMessage(message);
          }),
      ),
    );
  }

  /** Stop every worker now, abandoning running tasks. */
  async terminate(): Promise<void> {
    this.closing = true;
    this.cancelQueued();
    const workers = [...this.workers];
    for (const entry of workers) {
      this.release(entry);
    }
    await Promise.all(workers.map(entry => entry.worker.terminate()));
  }
}

/** Options of {@link parallelMap}. */
export interface ParallelMapOptions<J = unknown, R = unknown> {
  /** Jobs submitted ahead of the oldest unfinished one, per worker. */
  windowFactor?: number;
  /**
   * Called every `heartbeatInterval` seconds spent waiting for a result. If
   * it throws, the iteration ends with that error: the jobs did not fail,
   * so `onJobError` doesn't see it.
   */
  heartbeat?: (() => unknown) | null;
  /** Seconds between heartbeats (default 30). */
  heartbeatInterval?: number;
  /**
   * Checked after each result; when it returns true, queued jobs are
   * cancelled, running ones are awaited and yielded, and iteration ends.
   */
  shouldStop?: (() => boolean | Promise<boolean>) | null;
  /**
   * Turns a failed job into a result instead of ending the iteration: an
   * error the job threw, a {@link WorkerCrashedError} or a
   * {@link JobTimeoutError}. Not called for {@link BrokenProcessPool}
   * (workers that can't start), which still ends the iteration.
   */
  onJobError?: ((error: unknown, job: J) => R) | null;
  /**
   * Seconds a job may run before its worker is stopped and the job fails
   * with {@link JobTimeoutError}, counted once the worker has started.
   * `null` or `0`: no limit. Default: `jobTimeout` of the task's config,
   * else no limit.
   */
  jobTimeout?: number | null;
  /**
   * Heap limit of each worker, in MiB. A worker over it dies, which fails
   * its job with a {@link WorkerCrashedError}. `null` or `0`: the runtime's
   * limit. Default: `maxWorkerHeapMb` of the task's config, else no limit.
   */
  maxWorkerHeapMb?: number | null;
}

function iterate<J>(
  jobs: Iterable<J> | AsyncIterable<J>,
): AsyncIterator<J> | Iterator<J> {
  if (Symbol.asyncIterator in jobs) {
    return (jobs as AsyncIterable<J>)[Symbol.asyncIterator]();
  }
  return (jobs as Iterable<J>)[Symbol.iterator]();
}

function sleep(seconds: number): {
  promise: Promise<'timeout'>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), seconds * 1000);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Wait until `task` settles, sending heartbeats. Only a heartbeat can throw. */
async function waitFor(
  task: PoolTask,
  heartbeat: () => unknown,
  heartbeatInterval: number,
): Promise<void> {
  for (;;) {
    const timer = sleep(heartbeatInterval);
    const outcome = await Promise.race([
      task.promise.then(
        () => 'done' as const,
        () => 'done' as const,
      ),
      timer.promise,
    ]);
    timer.cancel();
    if (outcome === 'done') {
      return;
    }
    await heartbeat();
  }
}

/**
 * Map a task over `jobs` with a bounded pool of `nProcs` worker threads
 * (parsedmarc's `parallel_map`).
 *
 * `jobs` is consumed lazily: at most `windowFactor * nProcs` jobs are
 * submitted ahead of the oldest unfinished one. Results come back in
 * submission order. No worker is started when `jobs` is empty. A job that
 * throws, or whose worker dies ({@link WorkerCrashedError}) or runs past
 * `jobTimeout` ({@link JobTimeoutError}), makes the iteration throw at its
 * position, unless `onJobError` turns it into a result. A dead worker is
 * replaced; only a worker that fails while starting breaks the pool
 * ({@link BrokenProcessPool}). parsedmarc's process pool breaks on any
 * dead worker.
 *
 * Throws {@link ValueError} right away when `nProcs` is less than 1.
 */
export function parallelMap<J, R>(
  task: ParallelTask,
  jobs: Iterable<J> | AsyncIterable<J>,
  nProcs: number,
  options: ParallelMapOptions<J, R> = {},
): AsyncGenerator<R> {
  if (nProcs < 1) {
    throw new ValueError(`n_procs must be at least 1, got ${nProcs}`);
  }
  return generate<J, R>(task, jobs, nProcs, options);
}

async function* generate<J, R>(
  task: ParallelTask,
  jobs: Iterable<J> | AsyncIterable<J>,
  nProcs: number,
  options: ParallelMapOptions<J, R>,
): AsyncGenerator<R> {
  const {
    windowFactor = 2,
    heartbeat = null,
    heartbeatInterval = 30,
    shouldStop = null,
    onJobError = null,
    jobTimeout = task.config?.jobTimeout ?? null,
    maxWorkerHeapMb = task.config?.maxWorkerHeapMb ?? null,
  } = options;
  const iterator = iterate(jobs);
  const pull = async (): Promise<IteratorResult<J>> => iterator.next();

  const first = await pull();
  if (first.done) {
    return;
  }

  const logFiles = logger.handlers
    .filter(handler => handler instanceof FileHandler)
    .map(handler => (handler as FileHandler).baseFilename);
  const pool = new WorkerPool(
    nProcs,
    {
      logLevel: logger.getEffectiveLevel(),
      logFiles,
      task: toWireTask(task),
      shared: captureWorkerSharedState(task.config),
    },
    jobTimeout,
    maxWorkerHeapMb,
  );
  const settle = async (poolTask: PoolTask, wait: boolean): Promise<R> => {
    if (wait && heartbeat !== null) {
      await waitFor(poolTask, heartbeat, heartbeatInterval);
    }
    try {
      return (await poolTask.promise) as R;
    } catch (error) {
      if (onJobError === null || error instanceof BrokenProcessPool) {
        throw error;
      }
      return onJobError(error, poolTask.job as J);
    }
  };
  const windowSize = Math.max(windowFactor * nProcs, 1);
  let finished = false;
  try {
    const window: PoolTask[] = [pool.submit(first.value)];
    while (window.length < windowSize) {
      const next = await pull();
      if (next.done) {
        break;
      }
      window.push(pool.submit(next.value));
    }

    while (window.length > 0) {
      const oldest = window.shift() as PoolTask;
      yield await settle(oldest, true);

      if (shouldStop !== null && (await shouldStop())) {
        pool.cancelQueued();
        for (const remaining of window) {
          if (remaining.state !== 'cancelled') {
            yield await settle(remaining, false);
          }
        }
        break;
      }

      const next = await pull();
      if (!next.done) {
        window.push(pool.submit(next.value));
      }
    }
    finished = true;
  } finally {
    if (finished) {
      await pool.close();
    } else {
      await pool.terminate();
    }
  }
}
