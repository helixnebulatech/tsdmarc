import { fileURLToPath } from 'node:url';

import { defineConfig, type ViteUserConfig } from 'vitest/config';

const source = (directory: string): string =>
  fileURLToPath(new URL(`../${directory}/src/index.ts`, import.meta.url));

// Tests run against the sources of every package, so they don't need a
// build first.
const config: ViteUserConfig = defineConfig({
  resolve: {
    alias: [
      { find: /^tsdmarc$/u, replacement: source('tsdmarc') },
      ...[
        'elasticsearch',
        'gmail',
        'imap',
        'kafka',
        'loganalytics',
        'msgraph',
        'opensearch',
        'postgres',
        's3',
        'smtp',
      ].map(name => ({
        find: new RegExp(`^@tsdmarc/${name}$`, 'u'),
        replacement: source(name),
      })),
    ],
  },
  test: {
    env: { TZ: 'UTC' },
    include: ['src/**/*.test.ts'],
    // Generous bounds: on a loaded machine (turbo runs every package at
    // once, other jobs) slow is not hung. A real hang still fails.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    setupFiles: ['src/test/setup.ts'],
  },
});

export default config;
