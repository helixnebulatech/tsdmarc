import { fileURLToPath } from 'node:url';

/** Absolute path to the bundled IPinfo Lite MMDB file. */
export const ipinfoLiteDbPath = fileURLToPath(
  new URL('./data/ipinfo_lite.mmdb', import.meta.url),
);
