// Time bounds that guard against pathological complexity (catastrophic
// regex backtracking, quadratic loops) measure CPU time, not wall-clock
// time: on a loaded machine (parallel test workers, other jobs) a test
// waits for the CPU and wall-clock bounds fail. Vitest runs each test file
// in its own process, so process.cpuUsage() counts the code under test.

/** The CPU time used by this process so far (pass it to `cpuMsSince`). */
export function cpuStart(): NodeJS.CpuUsage {
  return process.cpuUsage();
}

/** Milliseconds of CPU time this process has used since `start`. */
export function cpuMsSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}
