// Environment variable overrides of the INI configuration
// (`TSDMARC_{SECTION}_{KEY}`, and parsedmarc's `PARSEDMARC_{SECTION}_{KEY}`).

import { readFileSync } from 'node:fs';

import { logger, sanitizeForLog } from 'tsdmarc';

import { type ConfigParser, isPyBoolean, pyRepr } from './configparser';
import { ConfigurationError } from './errors';
import { expandPath } from './paths';

/** All known INI config section names, used for env var resolution. */
export const KNOWN_SECTIONS: ReadonlySet<string> = new Set([
  'general',
  'mailbox',
  'imap',
  'msgraph',
  'elasticsearch',
  'opensearch',
  'splunk_hec',
  'kafka',
  'smtp',
  's3',
  'postgresql',
  'syslog',
  'gmail_api',
  'maildir',
  'log_analytics',
  'gelf',
  'webhook',
  'loki',
]);

/**
 * Environment variable prefixes, lowest priority first: parsedmarc's names
 * are accepted, and tsdmarc's win when both are set.
 */
export const ENV_PREFIXES: readonly string[] = ['PARSEDMARC_', 'TSDMARC_'];

/** Variables naming the configuration file (not config values). */
export const CONFIG_FILE_ENV_VARS: readonly string[] = [
  'PARSEDMARC_CONFIG_FILE',
  'TSDMARC_CONFIG_FILE',
];

/**
 * Short aliases that don't follow the `{PREFIX}{SECTION}_{KEY}` pattern, with
 * the priority tier they belong to (index into {@link ENV_PREFIXES}).
 */
export const ENV_ALIASES: ReadonlyMap<string, [string, string, number]> =
  new Map([
    ['DEBUG', ['general', 'debug', 0]],
    ['PARSEDMARC_DEBUG', ['general', 'debug', 0]],
    ['TSDMARC_DEBUG', ['general', 'debug', 1]],
  ]);

/**
 * The bare alias other Node.js tools also read (`DEBUG=*`, `DEBUG=express:*`
 * for the `debug` package): only boolean values are taken as `[general]
 * debug`, so such a value can't stop the CLI from starting. Not in
 * parsedmarc, which fails on any non-boolean `DEBUG`.
 */
const SHARED_DEBUG_ALIAS = 'DEBUG';

/**
 * Real config keys whose own names end in `_file`. For these the
 * `..._FILE` env var is the direct value (a path), not a Docker-secret file
 * reference. Keep in sync with `parseConfig()`.
 */
export const DIRECT_FILE_KEYS: ReadonlySet<string> = new Set([
  'GENERAL_LOG_FILE',
  'MSGRAPH_TOKEN_FILE',
  'GMAIL_API_CREDENTIALS_FILE',
  'GMAIL_API_TOKEN_FILE',
]);

/**
 * Resolve an env var suffix like `IMAP_PASSWORD` to `['imap', 'password']`,
 * using longest-prefix matching against the known sections so that
 * multi-word sections like `splunk_hec` work. `[null, null]` when no
 * section matches.
 */
export function resolveSectionKey(
  suffix: string,
): [string, string] | [null, null] {
  const suffixLower = suffix.toLowerCase();
  let bestSection: string | null = null;
  let bestKey: string | null = null;
  for (const section of KNOWN_SECTIONS) {
    const sectionPrefix = `${section}_`;
    if (suffixLower.startsWith(sectionPrefix)) {
      const key = suffixLower.slice(sectionPrefix.length);
      if (
        key &&
        (bestSection === null || section.length > bestSection.length)
      ) {
        bestSection = section;
        bestKey = key;
      }
    }
  }
  return bestSection === null || bestKey === null
    ? [null, null]
    : [bestSection, bestKey];
}

function errorClassName(error: unknown): string {
  if (error instanceof Error && 'code' in error) {
    switch (error.code) {
      case 'ENOENT':
        return 'FileNotFoundError';
      case 'EACCES':
      case 'EPERM':
        return 'PermissionError';
      case 'EISDIR':
        return 'IsADirectoryError';
      default:
        return 'OSError';
    }
  }
  return error instanceof Error ? error.name : 'OSError';
}

/**
 * Read a Docker-secret file referenced by a `..._FILE` env var, without
 * trailing CR/LF. Throws `ConfigurationError` when the file is missing,
 * unreadable or not valid UTF-8.
 */
export function readSecretFile(envKey: string, rawPath: string): string {
  const filePath = expandPath(rawPath);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(
      readFileSync(filePath),
    );
  } catch (error) {
    const name =
      error instanceof TypeError ? 'UnicodeDecodeError' : errorClassName(error);
    throw new ConfigurationError(
      `Cannot read secret file for ${envKey}: ${filePath} (${name})`,
      { cause: error },
    );
  }
  return content.replace(/[\r\n]+$/u, '');
}

/** Whether any env var configures tsdmarc (the config file variables aside). */
export function hasEnvConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(env).some(
    key =>
      ENV_PREFIXES.some(prefix => key.startsWith(prefix)) &&
      !CONFIG_FILE_ENV_VARS.includes(key),
  );
}

/** `TSDMARC_CONFIG_FILE`, else `PARSEDMARC_CONFIG_FILE`. */
export function configFileFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return env.TSDMARC_CONFIG_FILE || env.PARSEDMARC_CONFIG_FILE || null;
}

/**
 * Inject `TSDMARC_*` / `PARSEDMARC_*` environment variables into `config`.
 *
 * `{PREFIX}{SECTION}_{KEY}` overrides (or creates) the corresponding value;
 * sections are created as needed. A `{PREFIX}{SECTION}_{KEY}_FILE` variant
 * reads the value from the referenced file (Docker / Kubernetes secrets)
 * and wins over the direct variable. `TSDMARC_*` variables win over
 * `PARSEDMARC_*` ones. The real `*_file` keys in {@link DIRECT_FILE_KEYS}
 * keep their direct-value meaning.
 */
export function applyEnvOverrides(
  config: ConfigParser,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const fileSuffix = '_FILE';
  const tiers = ENV_PREFIXES.map(() => ({
    direct: new Map<string, [string, string, string]>(),
    secrets: new Map<string, [string, string, string]>(),
  }));

  for (const [envKey, value] of Object.entries(env)) {
    if (value === undefined || CONFIG_FILE_ENV_VARS.includes(envKey)) {
      continue;
    }
    const alias = ENV_ALIASES.get(envKey);
    if (alias !== undefined) {
      if (envKey === SHARED_DEBUG_ALIAS && !isPyBoolean(value)) {
        logger.warning(
          `Ignoring ${envKey}=${sanitizeForLog(pyRepr(value))}: not a boolean (use TSDMARC_DEBUG to set [general] debug)`,
        );
        continue;
      }
      const [section, key, tier] = alias;
      tiers[tier]?.direct.set(`${section}\u0000${key}`, [section, key, value]);
      continue;
    }
    const tier = ENV_PREFIXES.findIndex(prefix => envKey.startsWith(prefix));
    const prefix = ENV_PREFIXES[tier];
    if (prefix === undefined) {
      continue;
    }

    const keyBody = envKey.slice(prefix.length);
    const isSecret =
      keyBody.endsWith(fileSuffix) && !DIRECT_FILE_KEYS.has(keyBody);
    const [section, key] = resolveSectionKey(
      isSecret ? keyBody.slice(0, -fileSuffix.length) : keyBody,
    );
    if (section === null) {
      logger.debug(`Ignoring unrecognized env var: ${envKey}`);
      continue;
    }
    const target = tiers[tier];
    if (isSecret) {
      target?.secrets.set(`${section}\u0000${key}`, [
        section,
        key,
        readSecretFile(envKey, value),
      ]);
    } else {
      target?.direct.set(`${section}\u0000${key}`, [section, key, value]);
    }
  }

  // Later tiers overwrite earlier ones; within a tier, _FILE wins.
  const merged = new Map<string, [string, string, string]>();
  for (const { direct, secrets } of tiers) {
    for (const [id, entry] of [...direct, ...secrets]) {
      merged.set(id, entry);
    }
  }
  for (const [section, key, value] of merged.values()) {
    if (!config.hasSection(section)) {
      config.addSection(section);
    }
    config.set(section, key, value);
    logger.debug(`Config override from env: [${section}] ${key}`);
  }
}
