import { packageConfig } from '@tsdmarc/tsdown-config';
import type { UserConfig } from 'tsdown';

// parallel-worker.ts is the worker thread entry of parallelMap(); it is
// loaded by URL next to index.js, so it is built as its own entry.
const config: UserConfig = packageConfig({
  entry: ['src/index.ts', 'src/parallel-worker.ts'],
});

export default config;
