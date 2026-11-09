// Job functions for parallel.test.ts, loaded by worker threads by module URL
// (like parsedmarc's test_parallel.py module-level `_echo_job`).

import { resourceLimits } from 'node:worker_threads';

import { type ParserConfig, REVERSE_DNS_MAP } from '../../config';
import {
  InvalidAggregateReport,
  InvalidIPinfoAPIKey,
  IPDatabaseError,
  ParserError,
} from '../../errors';
import { parseReportEmailJob } from '../../report-email';
import { PyDateTime } from '../../utils/datetime';
import { pslOverrides } from '../../utils/domains';
import { ipInfoState } from '../../utils/ip-info';

/** Returns its job unchanged. */
export function echoJob(value: unknown): unknown {
  return value;
}

/** Waits `milliseconds`, then returns it. */
export async function sleepJob(milliseconds: number): Promise<number> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
  return milliseconds;
}

/** Throws a tsdmarc error class. */
export function failingJob(message: string): never {
  throw new InvalidAggregateReport(message, { cause: new TypeError('inner') });
}

/** Returns values whose classes a structured clone would lose. */
export function classyJob(): unknown {
  return {
    when: new PyDateTime({
      year: 2024,
      month: 1,
      day: 2,
      hour: 3,
      utcOffsetMinutes: 60,
    }),
    errors: [new InvalidAggregateReport('as a value')],
  };
}

/** Fills the heap until the worker dies. */
function exhaustHeap(): never {
  const kept: string[] = [];
  for (let index = 0; ; index += 1) {
    kept.push(`${'x'.repeat(1024)}${index}`);
  }
}

/** Dies out of memory for `"exhaust"`, returns any other job. */
export function exhaustOrEchoJob(value: unknown): unknown {
  if (value === 'exhaust') {
    exhaustHeap();
  }
  return value;
}

/** This worker's heap limit, in MiB. */
export function heapLimitJob(): number | undefined {
  return resourceLimits.maxOldGenerationSizeMb;
}

/** This worker's young generation limit, in MiB. */
export function youngGenerationLimitJob(): number | undefined {
  return resourceLimits.maxYoungGenerationSizeMb;
}

/** `parseReportEmailJob` that dies out of memory on an `X-Poison` email. */
export function exhaustOrParseEmailJob(
  content: string,
  options: { config: ParserConfig },
): unknown {
  if (content.includes('X-Poison')) {
    exhaustHeap();
  }
  return parseReportEmailJob(content, options);
}

/** What `parseReportEmailJob` returns once the IPinfo token is revoked. */
export function revokedTokenEmailJob(): ParserError {
  return new ParserError('Message is not a valid DMARC report', {
    cause: new InvalidAggregateReport('Unexpected error', {
      cause: new InvalidIPinfoAPIKey('IPinfo API rejected the token'),
    }),
  });
}

/** Returns an `IPDatabaseError` with its cause and code. */
export function ipDatabaseErrorJob(): ParserError {
  return new ParserError('wrapped', {
    cause: new IPDatabaseError('No usable IP database', { code: 'ENOENT' }),
  });
}

/** Exits the worker thread abruptly. */
export function crashJob(): never {
  process.exit(3);
}

/** Exits the worker thread for `"crash"`, returns any other job. */
export function crashOrEchoJob(value: unknown): unknown {
  if (value === 'crash') {
    process.exit(3);
  }
  return value;
}

/** Never finishes for `"hang"`, returns any other job. */
export function hangOrEchoJob(value: unknown): unknown {
  if (value === 'hang') {
    return new Promise(() => {
      // Keep the event loop busy so the thread can't idle out.
      setInterval(() => undefined, 1000);
    });
  }
  return value;
}

/** The module-level enrichment state the worker sees. */
export function sharedStateJob(): unknown {
  return {
    ipDbPath: ipInfoState.ipDbPath,
    ipinfoApiToken: ipInfoState.ipinfoApiToken,
    pslOverrides: [...pslOverrides],
    reverseDnsMap: [...REVERSE_DNS_MAP],
  };
}
