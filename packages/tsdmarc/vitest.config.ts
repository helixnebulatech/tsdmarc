import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Generous bounds: on a loaded machine (turbo runs every package at
    // once, other jobs) slow is not hung. A real hang still fails.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: { TZ: 'UTC' },
  },
});

export default config;
