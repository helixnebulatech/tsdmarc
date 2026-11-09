// Shared timezone-forcing helper for timestamp tests (port of tests/tzutil.py).
// Node and Bun re-read process.env.TZ on every Date operation.

import { afterEach } from 'vitest';

/**
 * Set the process timezone for each test in the current file. The default
 * zone is fixed and non-UTC (UTC+1 in January), so code that reads a UTC
 * wall-clock string as local time produces a shifted epoch under it.
 */
export function forceTz(tz = 'Europe/Warsaw'): void {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  afterEach(() => {
    process.env.TZ = previous;
  });
}

/** Run `fn` with the process timezone set to `tz`, restoring it afterwards. */
export function withTz<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = previous;
  }
}

/** Async version of {@link withTz}: restores the timezone after `fn` settles. */
export async function withTzAsync<T>(
  tz: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    process.env.TZ = previous;
  }
}
