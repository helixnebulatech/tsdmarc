import { fileURLToPath } from 'node:url';

import { defineConfig, type ViteUserConfig } from 'vitest/config';

// Tests run against the core's sources, so they don't need a build first.
const config: ViteUserConfig = defineConfig({
  resolve: {
    alias: {
      tsdmarc: fileURLToPath(
        new URL('../tsdmarc/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    env: { TZ: 'UTC' },
    include: ['src/**/*.test.ts'],
    // Generous bounds: on a loaded machine (turbo runs every package at
    // once, other jobs) slow is not hung. A real hang still fails.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

export default config;
