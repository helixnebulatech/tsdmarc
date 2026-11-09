// Run smoke.mjs against the built packages under one or more runtimes.
//
//   node tools/smoke/run.mjs                 # every runtime found locally
//   node tools/smoke/run.mjs --runtime deno  # one runtime (CI matrix)
//
// Local extra Node versions can be given with SMOKE_NODE_BINARIES
// (colon-separated paths), e.g. a Node 24 binary next to the system Node 26.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'smoke.mjs');

const args = process.argv.slice(2);
const runtimeIndex = args.indexOf('--runtime');
const only = runtimeIndex === -1 ? null : args[runtimeIndex + 1];

const has = command =>
  spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;

const runtimes = [];
if (!only || only === 'node') {
  runtimes.push({ command: process.execPath, args: [script], name: `node ${process.version}` });
  for (const binary of (process.env.SMOKE_NODE_BINARIES ?? '').split(':').filter(Boolean)) {
    if (existsSync(binary)) {
      runtimes.push({ command: binary, args: [script], name: `node (${binary})` });
    }
  }
}
if ((!only || only === 'bun') && has('bun')) {
  runtimes.push({ command: 'bun', args: [script], name: 'bun' });
}
if ((!only || only === 'deno') && has('deno')) {
  runtimes.push({ command: 'deno', args: ['run', '--allow-all', '--node-modules-dir=manual', script], name: 'deno' });
}
if (runtimes.length === 0) {
  console.error(`No runtime available for ${only}`);
  process.exit(1);
}

let failed = false;
for (const runtime of runtimes) {
  console.log(`\n=== ${runtime.name} ===`);
  const result = spawnSync(runtime.command, runtime.args, {
    cwd: here,
    env: { ...process.env, TZ: 'UTC' },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failed = true;
    console.error(`FAILED under ${runtime.name}`);
  }
}
process.exit(failed ? 1 : 0);
