// Formatting as in vercel/ai.
import { defineConfig } from 'oxfmt';
import ultracite from 'ultracite/oxfmt';

export default defineConfig({
  ...ultracite,
  arrowParens: 'avoid',
  bracketSameLine: false,
  bracketSpacing: true,
  endOfLine: 'lf',
  ignorePatterns: [
    '.changeset/**',
    '**/CHANGELOG.md',
    '**/*.mjs',
    '**/tsconfig*.json',
    '**/turbo.json',
    'tools/tsconfig/**',
    'fixtures/**',
    'samples/**',
    'dashboards/**',
    'upstream/**',
    '.claude/**',
    '.venv/**',
  ],
  printWidth: 80,
  quoteProps: 'as-needed',
  semi: true,
  singleQuote: true,
  sortPackageJson: false,
  tabWidth: 2,
  trailingComma: 'all',
  useTabs: false,
});
