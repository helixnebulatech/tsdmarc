// envelope-from extraction in Received headers stays linear on runs of `<`.

import { describe, expect, it } from 'vitest';

import { parseReceived } from './received';

/** CPU milliseconds since `start`: a loaded machine doesn't make bounds flaky. */
function cpuMsSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}

const DATE = 'Mon, 1 Jan 2024 00:00:00 +0000';

describe('parseReceived envelope-from', () => {
  it.each([
    [`from a envelope-from <x@y> (z); ${DATE}`, 'x@y'],
    [`from a envelope-from <> <x>; ${DATE}`, 'x'],
    [`from a envelope-from <>; ${DATE}`, undefined],
    [`by b (envelope-from <x@y>); ${DATE}`, 'x@y'],
    [`by b (envelope-from\t <x@y> <z>); ${DATE}`, 'x@y'],
    [`by b (envelope-from <> envelope-from <x>); ${DATE}`, 'x'],
    [`by b (envelope-from <x); ${DATE}`, undefined],
  ])('reads %j', (header, expected) => {
    expect(parseReceived(header).get('envelope_from')).toBe(expected);
  });

  it('is linear on many `<` without a `>`', () => {
    // 40 KB took 6.5 s: every `<` scanned to the end of the clause.
    const size = 200_000;
    const start = process.cpuUsage();
    for (const header of [
      `from a envelope-from x (${'<'.repeat(size)}); ${DATE}`,
      `from a envelope-from x (${'<'.repeat(size)}>); ${DATE}`,
      `by x (${'envelope-from <e'.repeat(size / 16)}); ${DATE}`,
      `by x (${'envelope-from <e'.repeat(size / 16)}>); ${DATE}`,
    ]) {
      parseReceived(header);
    }
    expect(cpuMsSince(start)).toBeLessThan(3000);
  });
});
