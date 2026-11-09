// Base domains: the Public Suffix List plus parsedmarc's PSL overrides,
// ported from parsedmarc/utils.py (`get_base_domain`, `load_psl_overrides`).
//
// parsedmarc uses `publicsuffixlist.PublicSuffixList()` with its defaults:
// private domains included and unknown TLDs treated as public suffixes. tldts
// supplies the list (with the same options); the label handling around it
// follows publicsuffixlist's `privatesuffix()`, so inputs tldts would reject
// as hostnames (IP addresses, empty labels, `host:port`) give the same
// answer as in parsedmarc.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { getPublicSuffix } from 'tldts';

import { USER_AGENT } from '../constants';
import { logger } from '../log';
import {
  describeHttpError,
  HTTPError,
  httpGet,
  InvalidURL,
  redactUrl,
} from './http';
import { pySplitlines, pyStrip } from './py-str';
import { getResourcePath } from './resources';

const DEFAULT_PSL_OVERRIDES_URL =
  'https://raw.githubusercontent.com/domainaware/parsedmarc/master/parsedmarc/resources/maps/psl_overrides.txt';

const DOWNLOAD_TIMEOUT_SECONDS = 60;
const MAX_OVERRIDES_BYTES = 16 * 1024 * 1024;

/**
 * The module-level PSL overrides list (parsedmarc's `psl_overrides`).
 * `loadPslOverrides()` refills this same array in place, and
 * `getBaseDomain()` reads it on every call.
 */
export const pslOverrides: string[] = [];

export interface LoadPslOverridesOptions {
  /** Always use a local overrides file. */
  alwaysUseLocalFile?: boolean;
  /** Path to a local overrides file (default: the bundled `psl_overrides.txt`). */
  localFilePath?: string | null;
  /** URL to a PSL overrides file. */
  url?: string | null;
  /** Do not make online requests. */
  offline?: boolean;
}

function loadText(target: string[], text: string): void {
  for (const line of pySplitlines(text)) {
    const stripped = pyStrip(line);
    if (stripped) {
      target.push(stripped);
    }
  }
}

// One load at a time per set of options: concurrent callers share it.
const pslLoadsInFlight = new Map<string, Promise<string[]>>();

/**
 * Loads the PSL overrides list from a URL or local file.
 *
 * Repopulates the module-level `pslOverrides` array in place, then returns
 * it. The URL is tried first; on failure (or when `offline` /
 * `alwaysUseLocalFile` is set) the local path is used, defaulting to the
 * bundled `psl_overrides.txt`.
 *
 * parsedmarc clears the list before downloading; here the new list is built
 * aside and swapped in at once, so lookups running during the download keep
 * seeing the previous overrides instead of an empty list.
 */
export function loadPslOverrides(
  options: LoadPslOverridesOptions = {},
): Promise<string[]> {
  const key = JSON.stringify([
    options.url ?? null,
    options.localFilePath ?? null,
    options.offline ?? false,
    options.alwaysUseLocalFile ?? false,
  ]);
  const running = pslLoadsInFlight.get(key);
  if (running !== undefined) {
    return running;
  }
  const load = fetchPslOverrides(options).finally(() => {
    pslLoadsInFlight.delete(key);
  });
  pslLoadsInFlight.set(key, load);
  return load;
}

async function fetchPslOverrides(
  options: LoadPslOverridesOptions,
): Promise<string[]> {
  const url = options.url ?? DEFAULT_PSL_OVERRIDES_URL;
  const offline = options.offline ?? false;
  const alwaysUseLocalFile = options.alwaysUseLocalFile ?? false;

  const loaded: string[] = [];

  if (!(offline || alwaysUseLocalFile)) {
    try {
      logger.debug(`Trying to fetch PSL overrides from ${redactUrl(url)}...`);
      const response = await httpGet(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: DOWNLOAD_TIMEOUT_SECONDS,
        maxBytes: MAX_OVERRIDES_BYTES,
      });
      response.raiseForStatus();
      loadText(loaded, response.text());
    } catch (error) {
      if (!(error instanceof HTTPError || error instanceof InvalidURL)) {
        throw error;
      }
      logger.warning(
        `Failed to fetch PSL overrides: ${describeHttpError(error)}`,
      );
    }
  }

  if (loaded.length === 0) {
    const path = options.localFilePath || getResourcePath('psl_overrides.txt');
    logger.info(`Loading PSL overrides from ${path}`);
    loadText(loaded, await readFile(path, 'utf8'));
  }

  // Swap synchronously: no await between emptying and refilling.
  pslOverrides.length = 0;
  for (const entry of loaded) {
    pslOverrides.push(entry);
  }
  return pslOverrides;
}

// Bootstrap with the bundled file at import time, with no network call.
// parsedmarc does this synchronously on import, so getBaseDomain() works
// before any loader runs.
loadText(
  pslOverrides,
  readFileSync(getResourcePath('psl_overrides.txt'), 'utf8'),
);

// A label no PSL rule names, used to detect wildcard rules.
const WILDCARD_PROBE_LABEL = 'tsdmarc-wildcard-probe--';

const TLDTS_OPTIONS = {
  allowIcannDomains: true,
  allowPrivateDomains: true,
  detectIp: false,
  extractHostname: false,
  mixedInputs: false,
  validateHostname: false,
} as const;

/**
 * publicsuffixlist's `PublicSuffixList().privatesuffix(domain)`: the
 * shortest suffix assigned to an individual, or `null` when the domain is
 * malformed or is itself a public suffix.
 */
export function privateSuffix(domain: string): string | null {
  // Empty labels are not permitted, so a trailing dot is ignored.
  const trimmed = domain.endsWith('.') ? domain.slice(0, -1) : domain;
  const labels = trimmed.toLowerCase().split('.');
  if (labels.includes('')) {
    return null;
  }
  const joined = labels.join('.');
  const suffix = getPublicSuffix(joined, TLDTS_OPTIONS);
  // Unknown TLDs count as public suffixes (accept_unknown=True).
  let publicLength = suffix ? suffix.split('.').length : 1;
  // publicsuffixlist treats the parent of a wildcard rule as public too
  // (`*.example.com` makes `example.com` public, as the PSL test data
  // expects); tldts does not. A rule matching one label below the domain
  // reveals such a wildcard.
  const probe = getPublicSuffix(
    `${WILDCARD_PROBE_LABEL}.${joined}`,
    TLDTS_OPTIONS,
  );
  if (probe && probe.split('.').length === labels.length + 1) {
    publicLength = labels.length;
  }
  if (labels.length < publicLength + 1) {
    return null;
  }
  return labels.slice(-(publicLength + 1)).join('.');
}

/**
 * Gets the base domain name for the given domain.
 *
 * Results are based on the Public Suffix List and the overrides in
 * `psl_overrides.txt`. Returns `null` if a base domain cannot be determined.
 */
export function getBaseDomain(domain: string): string | null {
  const lowered = domain.toLowerCase();
  const publicSuffix = privateSuffix(lowered);
  for (const override of pslOverrides) {
    if (lowered.endsWith(override)) {
      return pyStrip(pyStrip(override, '.'), '-');
    }
  }
  return publicSuffix;
}
