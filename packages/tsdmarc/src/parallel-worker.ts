// Worker thread entry of `parallelMap()` (see parallel.ts): restore the
// parent's lookup state and logging, then run one job per message and post
// back its result.

import { parentPort, workerData } from 'node:worker_threads';

import { REVERSE_DNS_MAP } from './config';
import {
  encodeError,
  encodeValue,
  type FromWorkerMessage,
  initWorker,
  type JobRegistry,
  runWireTask,
  type ToWorkerMessage,
  type WorkerInit,
} from './parallel';
import { parseReportEmailJob } from './report-email';
import { parseReportFileJob } from './report-file';

/** The jobs a task can name without a module. */
const BUILTIN_JOBS: JobRegistry = Object.freeze({
  parseReportEmailJob,
  parseReportFileJob,
});

const init = workerData as WorkerInit;
const port = parentPort;

if (port !== null) {
  initWorker(init.logLevel, init.logFiles, init.shared, REVERSE_DNS_MAP);
  port.on('message', async (message: ToWorkerMessage) => {
    if (message.type === 'close') {
      // Closing the port lets the thread end once its output is flushed.
      // Deno's port has no close(), so the thread exits instead.
      if (typeof port.close === 'function') {
        port.close();
      } else {
        process.exit(0);
      }
      return;
    }
    let reply: FromWorkerMessage;
    try {
      const value = await runWireTask(init.task, message.job, BUILTIN_JOBS);
      reply = {
        type: 'result',
        id: message.id,
        ok: true,
        value: encodeValue(value),
      };
    } catch (error) {
      reply = {
        type: 'result',
        id: message.id,
        ok: false,
        error: encodeError(error),
      };
    }
    port.postMessage(reply);
  });
  const ready: FromWorkerMessage = { type: 'ready' };
  port.postMessage(ready);
}
