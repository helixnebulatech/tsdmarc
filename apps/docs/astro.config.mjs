// Astro Starlight configuration for the tsdmarc documentation website.
//
// The final URL is not fixed yet (GitHub Pages project page or a custom
// domain), so `site` and `base` come from the environment:
//
//   DOCS_SITE  origin, e.g. https://helixnebulatech.github.io or https://docs.example.com
//   DOCS_BASE  path prefix, e.g. /tsdmarc ("" or "/" for a domain root)
//
// The GitHub Pages workflow passes the values reported by
// actions/configure-pages.
import { readFileSync } from 'node:fs';

import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';

const site = process.env.DOCS_SITE || 'https://helixnebulatech.github.io';
const base = process.env.DOCS_BASE ?? '/tsdmarc';

// The GitHub repository, from the core package's manifest.
const corePackage = JSON.parse(
  readFileSync(new URL('../../packages/tsdmarc/package.json', import.meta.url), 'utf8'),
);
const repositoryUrl = corePackage.repository.url
  .replace(/^git\+/u, '')
  .replace(/\.git$/u, '');

// Published packages documented in the API reference, in sidebar order.
const apiPackages = [
  'tsdmarc',
  'imap',
  'gmail',
  'msgraph',
  'smtp',
  'elasticsearch',
  'opensearch',
  'postgres',
  'kafka',
  's3',
  'loganalytics',
  'cli',
];

const [apiTypeDoc, apiSidebarGroup] = createStarlightTypeDocPlugin();

export default defineConfig({
  site,
  base: base === '' ? '/' : base,
  output: 'static',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'tsdmarc',
      description:
        'Parse DMARC aggregate, failure and SMTP TLS reports in TypeScript. A 1:1 port of parsedmarc for Node.js, Bun and Deno.',
      logo: {
        src: './src/assets/logo.svg',
        alt: 'tsdmarc',
        replacesTitle: false,
      },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: repositoryUrl }],
      editLink: {
        baseUrl: `${repositoryUrl}/edit/main/apps/docs/`,
      },
      lastUpdated: false,
      customCss: ['./src/styles/custom.css'],
      components: {
        Footer: './src/components/Footer.astro',
      },
      plugins: [
        apiTypeDoc({
          entryPoints: apiPackages.map(name => `../../packages/${name}`),
          output: 'api',
          sidebar: { label: 'Packages', collapsed: true },
          typeDoc: {
            entryPointStrategy: 'packages',
            // Each package is documented from its source entry point; the
            // package READMEs are not merged in (the guides cover usage).
            packageOptions: {
              entryPoints: ['src/index.ts'],
              excludeInternal: true,
              readme: 'none',
              validation: { notExported: false, invalidLink: false },
            },
            // A root readme makes starlight-typedoc keep each package's
            // index page (the list of its exports).
            readme: './typedoc-readme.md',
            excludePrivate: true,
            excludeProtected: true,
            excludeExternals: true,
            gitRevision: 'main',
            sourceLinkTemplate: `${repositoryUrl}/blob/{gitRevision}/{path}#L{line}`,
            skipErrorChecking: true,
            validation: { notExported: false, invalidLink: false },
          },
        }),
      ],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { slug: 'getting-started/introduction' },
            { slug: 'getting-started/installation' },
            { slug: 'getting-started/quick-start' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { slug: 'guides/library' },
            { slug: 'guides/cli' },
            { slug: 'guides/configuration' },
            { slug: 'guides/environment-variables' },
            { slug: 'guides/output-formats' },
            { slug: 'guides/mailboxes' },
            { slug: 'guides/outputs' },
            { slug: 'guides/dashboards' },
            { slug: 'guides/running-as-a-service' },
            { slug: 'guides/migrating-from-parsedmarc' },
            { slug: 'guides/security' },
          ],
        },
        {
          label: 'Background',
          items: [
            { slug: 'background/dmarc' },
            { slug: 'background/mailing-lists' },
            { slug: 'background/davmail' },
          ],
        },
        {
          label: 'API reference',
          items: [{ slug: 'reference/overview' }, apiSidebarGroup],
        },
        {
          label: 'Project',
          items: [{ slug: 'project/credits' }],
        },
      ],
    }),
  ],
});
