// Port of the env var / config loading tests of parsedmarc's
// tests/test_cli.py (class `Test`).

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureLogs } from 'tsdmarc';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, parseConfig } from './config';
import { ConfigParser } from './configparser';
import {
  applyEnvOverrides,
  configFileFromEnv,
  DIRECT_FILE_KEYS,
  hasEnvConfig,
  resolveSectionKey,
} from './env';
import { ConfigurationError } from './errors';
import { createOptions } from './options';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsdmarc-env-'));
  tempDirs.push(dir);
  return dir;
}

function tempFile(content: string, name = 'file'): string {
  const filePath = path.join(tempDir(), name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveSectionKey', () => {
  it('test_resolve_section_key_simple', () => {
    expect(resolveSectionKey('IMAP_PASSWORD')).toEqual(['imap', 'password']);
    expect(resolveSectionKey('GENERAL_DEBUG')).toEqual(['general', 'debug']);
    expect(resolveSectionKey('S3_BUCKET')).toEqual(['s3', 'bucket']);
    expect(resolveSectionKey('GELF_HOST')).toEqual(['gelf', 'host']);
  });

  it('test_resolve_section_key_underscore_sections', () => {
    expect(resolveSectionKey('SPLUNK_HEC_TOKEN')).toEqual([
      'splunk_hec',
      'token',
    ]);
    expect(resolveSectionKey('GMAIL_API_CREDENTIALS_FILE')).toEqual([
      'gmail_api',
      'credentials_file',
    ]);
    expect(resolveSectionKey('LOG_ANALYTICS_CLIENT_ID')).toEqual([
      'log_analytics',
      'client_id',
    ]);
  });

  it('test_resolve_section_key_unknown', () => {
    expect(resolveSectionKey('UNKNOWN_FOO')).toEqual([null, null]);
    // Just a section name with no key should not match
    expect(resolveSectionKey('IMAP')).toEqual([null, null]);
  });
});

describe('applyEnvOverrides', () => {
  it('test_apply_env_overrides_injects_values', () => {
    const config = new ConfigParser();
    config.addSection('imap');
    config.set('imap', 'host', 'original.example.com');
    applyEnvOverrides(config, {
      PARSEDMARC_IMAP_HOST: 'new.example.com',
      PARSEDMARC_IMAP_PASSWORD: 'secret123',
    });
    expect(config.getRaw('imap', 'host')).toBe('new.example.com');
    expect(config.getRaw('imap', 'password')).toBe('secret123');
  });

  it('sets max_email_size from either prefix, TSDMARC_ winning', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      PARSEDMARC_GENERAL_MAX_EMAIL_SIZE: '1000',
      TSDMARC_GENERAL_MAX_EMAIL_SIZE: '2000',
      PARSEDMARC_GENERAL_MAX_MIME_PARTS: '50',
    });
    expect(config.getRaw('general', 'max_email_size')).toBe('2000');
    expect(config.getRaw('general', 'max_mime_parts')).toBe('50');
  });

  it('test_apply_env_overrides_creates_sections', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      PARSEDMARC_ELASTICSEARCH_HOSTS: 'http://localhost:9200',
    });
    expect(config.hasSection('elasticsearch')).toBe(true);
    expect(config.getRaw('elasticsearch', 'hosts')).toBe(
      'http://localhost:9200',
    );
  });

  it('test_apply_env_overrides_postgresql_section', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      PARSEDMARC_POSTGRESQL_HOST: 'db.example.com',
      PARSEDMARC_POSTGRESQL_PORT: '5432',
      PARSEDMARC_POSTGRESQL_USER: 'parsedmarc',
      PARSEDMARC_POSTGRESQL_DATABASE: 'parsedmarc',
    });
    expect(config.sections()).toContain('postgresql');
    expect(config.getRaw('postgresql', 'host')).toBe('db.example.com');
    expect(config.getRaw('postgresql', 'port')).toBe('5432');
    expect(config.getRaw('postgresql', 'database')).toBe('parsedmarc');
  });

  it('test_apply_env_overrides_ignores_config_file_var', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      PARSEDMARC_CONFIG_FILE: '/some/path.ini',
      TSDMARC_CONFIG_FILE: '/other/path.ini',
    });
    expect(config.sections()).toEqual([]);
  });

  it('test_boolean_values_from_env', () => {
    for (const trueValue of ['true', 'yes', '1', 'on', 'True', 'YES']) {
      const config = new ConfigParser();
      applyEnvOverrides(config, { PARSEDMARC_GENERAL_DEBUG: trueValue });
      expect(config.section('general').getboolean('debug')).toBe(true);
    }
    for (const falseValue of ['false', 'no', '0', 'off', 'False', 'NO']) {
      const config = new ConfigParser();
      applyEnvOverrides(config, { PARSEDMARC_GENERAL_DEBUG: falseValue });
      expect(config.section('general').getboolean('debug')).toBe(false);
    }
  });

  it('test_short_alias_debug', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, { DEBUG: 'true' });
    expect(config.getRaw('general', 'debug')).toBe('true');
  });

  it('ignores a bare DEBUG that is not a boolean (DEBUG=* of the debug package)', () => {
    const config = new ConfigParser();
    const logs = captureLogs();
    try {
      applyEnvOverrides(config, {
        DEBUG: '*',
        TSDMARC_GENERAL_SILENT: 'true',
      });
    } finally {
      logs.restore();
    }
    expect(config.section('general').has('debug')).toBe(false);
    expect(config.section('general').getboolean('silent')).toBe(true);
    expect(logs.output).toContain(
      "WARNING:tsdmarc:Ignoring DEBUG='*': not a boolean (use TSDMARC_DEBUG to set [general] debug)",
    );
    // The prefixed aliases stay strict.
    const strict = new ConfigParser();
    applyEnvOverrides(strict, { TSDMARC_DEBUG: '*' });
    expect(strict.getRaw('general', 'debug')).toBe('*');
  });

  it('test_short_alias_parsedmarc_debug', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, { PARSEDMARC_DEBUG: 'true' });
    expect(config.getRaw('general', 'debug')).toBe('true');
  });

  it('TSDMARC_DEBUG alias maps to [general] debug and wins over PARSEDMARC_DEBUG', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      PARSEDMARC_DEBUG: 'false',
      TSDMARC_DEBUG: 'true',
    });
    expect(config.getRaw('general', 'debug')).toBe('true');
  });

  it('test_file_env_var_reads_secret', () => {
    const secretPath = tempFile('sekret-123\n', 'x.secret');
    const config = new ConfigParser();
    applyEnvOverrides(config, { PARSEDMARC_IMAP_PASSWORD_FILE: secretPath });
    expect(config.getRaw('imap', 'password')).toBe('sekret-123');
  });

  it('test_file_env_var_strips_trailing_crlf', () => {
    const secretPath = tempFile(' pre  inside\r\n', 'x.secret');
    const config = new ConfigParser();
    applyEnvOverrides(config, { PARSEDMARC_IMAP_PASSWORD_FILE: secretPath });
    expect(config.getRaw('imap', 'password')).toBe(' pre  inside');
  });

  it('test_file_env_var_supersedes_direct_env', () => {
    const secretPath = tempFile('from-file', 'x.secret');
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      PARSEDMARC_IMAP_PASSWORD: 'from-env',
      PARSEDMARC_IMAP_PASSWORD_FILE: secretPath,
    });
    expect(config.getRaw('imap', 'password')).toBe('from-file');
  });

  it('test_file_env_var_missing_file_raises', () => {
    const config = new ConfigParser();
    const missing = path.join(tempDir(), 'tsdmarc-nonexistent-secret');
    expect(() =>
      applyEnvOverrides(config, { PARSEDMARC_IMAP_PASSWORD_FILE: missing }),
    ).toThrow(ConfigurationError);
    expect(() =>
      applyEnvOverrides(config, { PARSEDMARC_IMAP_PASSWORD_FILE: missing }),
    ).toThrow(/PARSEDMARC_IMAP_PASSWORD_FILE/u);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'test_file_env_var_unreadable_file_raises',
    () => {
      const secretPath = tempFile('data', 'x.secret');
      chmodSync(secretPath, 0o000);
      try {
        const config = new ConfigParser();
        expect(() =>
          applyEnvOverrides(config, {
            PARSEDMARC_IMAP_PASSWORD_FILE: secretPath,
          }),
        ).toThrow(ConfigurationError);
      } finally {
        chmodSync(secretPath, 0o600);
      }
    },
  );

  it('test_file_env_var_path_expansion', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'secret'), 'expanded-value', 'utf8');
    // `$VAR` expansion reads the process environment, like os.path.expandvars.
    process.env.PARSEDMARC_TEST_SECRET_DIR = dir;
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      PARSEDMARC_TEST_SECRET_DIR: dir,
      PARSEDMARC_IMAP_PASSWORD_FILE: '$PARSEDMARC_TEST_SECRET_DIR/secret',
    });
    expect(config.getRaw('imap', 'password')).toBe('expanded-value');
  });

  it('test_file_env_var_unknown_section_ignored', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      PARSEDMARC_UNKNOWN_FOO_FILE: '/tmp/should-not-be-read',
    });
    expect(config.sections()).toEqual([]);
  });

  it('test_file_env_var_direct_file_keys_keep_direct_semantics', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      PARSEDMARC_GENERAL_LOG_FILE: '/var/log/parsedmarc.log',
      PARSEDMARC_GMAIL_API_CREDENTIALS_FILE: '/etc/parsedmarc/gmail.json',
      PARSEDMARC_GMAIL_API_TOKEN_FILE: '/etc/parsedmarc/gmail.token',
      PARSEDMARC_MSGRAPH_TOKEN_FILE: '/etc/parsedmarc/msgraph.token',
    });
    expect(config.getRaw('general', 'log_file')).toBe(
      '/var/log/parsedmarc.log',
    );
    expect(config.getRaw('gmail_api', 'credentials_file')).toBe(
      '/etc/parsedmarc/gmail.json',
    );
    expect(config.getRaw('gmail_api', 'token_file')).toBe(
      '/etc/parsedmarc/gmail.token',
    );
    expect(config.getRaw('msgraph', 'token_file')).toBe(
      '/etc/parsedmarc/msgraph.token',
    );
  });

  it('test_file_env_var_double_suffix_wraps_direct_file_key', () => {
    const secretPath = tempFile(
      '/run/secrets/real-gmail-credentials.json\n',
      'x.secret',
    );
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      PARSEDMARC_GMAIL_API_CREDENTIALS_FILE_FILE: secretPath,
    });
    expect(config.getRaw('gmail_api', 'credentials_file')).toBe(
      '/run/secrets/real-gmail-credentials.json',
    );
  });

  it('test_direct_file_keys_matches_parse_config_source', () => {
    // Every `*_file` key read in config.ts must be in DIRECT_FILE_KEYS, or
    // its env var would be treated as a Docker-secret reference.
    const source = readFileSync(
      fileURLToPath(new URL('config.ts', import.meta.url)),
      'utf8',
    );
    const sectionOf: Record<string, string> = {
      general: 'general',
      graph: 'msgraph',
      gmail: 'gmail_api',
    };
    const seen = new Set<string>();
    for (const match of source.matchAll(
      /(\w+)\.(?:get|getItem|has)\('(\w+_file)'/gu,
    )) {
      const [, variable = '', key = ''] = match;
      const section = sectionOf[variable] ?? variable;
      seen.add(`${section.toUpperCase()}_${key.toUpperCase()}`);
    }
    expect(seen).toEqual(new Set(DIRECT_FILE_KEYS));
  });
});

describe('TSDMARC_* and PARSEDMARC_* variables', () => {
  it('TSDMARC_* wins over PARSEDMARC_* for the same key', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      TSDMARC_IMAP_HOST: 'tsdmarc.example.com',
      PARSEDMARC_IMAP_HOST: 'parsedmarc.example.com',
      PARSEDMARC_IMAP_USER: 'from-parsedmarc',
    });
    expect(config.getRaw('imap', 'host')).toBe('tsdmarc.example.com');
    // A key only set with the parsedmarc prefix still applies.
    expect(config.getRaw('imap', 'user')).toBe('from-parsedmarc');
  });

  it('a direct TSDMARC_* value wins over a PARSEDMARC_*_FILE secret', () => {
    const secretPath = tempFile('from-parsedmarc-file', 'x.secret');
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      PARSEDMARC_IMAP_PASSWORD_FILE: secretPath,
      TSDMARC_IMAP_PASSWORD: 'from-tsdmarc',
    });
    expect(config.getRaw('imap', 'password')).toBe('from-tsdmarc');
  });

  it('TSDMARC_*_FILE wins over a direct TSDMARC_* value', () => {
    const secretPath = tempFile('from-file', 'x.secret');
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      TSDMARC_IMAP_PASSWORD: 'from-env',
      TSDMARC_IMAP_PASSWORD_FILE: secretPath,
    });
    expect(config.getRaw('imap', 'password')).toBe('from-file');
  });

  it('TSDMARC_CONFIG_FILE wins over PARSEDMARC_CONFIG_FILE', () => {
    expect(
      configFileFromEnv({
        TSDMARC_CONFIG_FILE: '/a.ini',
        PARSEDMARC_CONFIG_FILE: '/b.ini',
      }),
    ).toBe('/a.ini');
    expect(configFileFromEnv({ PARSEDMARC_CONFIG_FILE: '/b.ini' })).toBe(
      '/b.ini',
    );
    expect(configFileFromEnv({})).toBeNull();
  });

  it('hasEnvConfig ignores the config file variables and bare DEBUG', () => {
    expect(hasEnvConfig({ TSDMARC_CONFIG_FILE: '/a.ini' })).toBe(false);
    expect(hasEnvConfig({ PARSEDMARC_CONFIG_FILE: '/a.ini' })).toBe(false);
    expect(hasEnvConfig({ DEBUG: 'true' })).toBe(false);
    expect(hasEnvConfig({ TSDMARC_GENERAL_DEBUG: 'true' })).toBe(true);
    expect(hasEnvConfig({ PARSEDMARC_GENERAL_DEBUG: 'true' })).toBe(true);
  });
});

describe('loadConfig / parseConfig', () => {
  it('test_load_config_with_file_and_env_override', () => {
    const configPath = tempFile(
      '[imap]\nhost = file.example.com\nuser = alice\npassword = fromfile\n',
      'c.ini',
    );
    const config = loadConfig(configPath, {
      PARSEDMARC_IMAP_PASSWORD: 'fromenv',
    });
    expect(config.getRaw('imap', 'host')).toBe('file.example.com');
    expect(config.getRaw('imap', 'user')).toBe('alice');
    expect(config.getRaw('imap', 'password')).toBe('fromenv');
  });

  it('test_load_config_env_only', () => {
    const config = loadConfig(null, {
      PARSEDMARC_GENERAL_DEBUG: 'true',
      PARSEDMARC_ELASTICSEARCH_HOSTS: 'http://localhost:9200',
    });
    expect(config.getRaw('general', 'debug')).toBe('true');
    expect(config.getRaw('elasticsearch', 'hosts')).toBe(
      'http://localhost:9200',
    );
  });

  it('test_parse_config_from_env', async () => {
    const config = loadConfig(null, {
      PARSEDMARC_GENERAL_DEBUG: 'true',
      PARSEDMARC_GENERAL_SAVE_AGGREGATE: 'true',
      PARSEDMARC_GENERAL_OFFLINE: 'true',
    });
    const opts = createOptions();
    await parseConfig(config, opts);
    expect(opts.debug).toBe(true);
    expect(opts.saveAggregate).toBe(true);
    expect(opts.offline).toBe(true);
  });

  it('test_config_file_env_var', async () => {
    const configPath = tempFile(
      '[general]\ndebug = true\noffline = true\n',
      'c.ini',
    );
    const env = { PARSEDMARC_CONFIG_FILE: configPath };
    const config = loadConfig(configFileFromEnv(env), env);
    const opts = createOptions();
    await parseConfig(config, opts);
    expect(opts.debug).toBe(true);
    expect(opts.offline).toBe(true);
  });
});

describe('the bare DEBUG variable', () => {
  it.each(['*', 'express:*', ''])(
    'ignores %j, which is not a boolean, keeping the file value',
    async value => {
      const config = new ConfigParser();
      config.addSection('general');
      config.set('general', 'debug', 'true');
      applyEnvOverrides(config, { DEBUG: value });
      const opts = createOptions();
      await parseConfig(config, opts);
      expect(opts.debug).toBe(true);
    },
  );

  it('still reads a boolean', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, { DEBUG: 'yes' });
    expect(config.getRaw('general', 'debug')).toBe('yes');
  });

  it('keeps the prefixed variables strict', () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, { TSDMARC_DEBUG: '*' });
    expect(config.getRaw('general', 'debug')).toBe('*');
  });
});

describe('the limits added by tsdmarc', () => {
  it.each([
    ['GENERAL_MAX_NORMALIZED_RECORDS', 'general', 'max_normalized_records'],
    ['GENERAL_MAX_XML_DEPTH', 'general', 'max_xml_depth'],
    ['GENERAL_MAX_XML_NODES', 'general', 'max_xml_nodes'],
    ['GENERAL_MAX_SMTP_TLS_REPORT_SIZE', 'general', 'max_smtp_tls_report_size'],
    ['GENERAL_MAX_HEADER_LINES', 'general', 'max_header_lines'],
    ['GENERAL_MAX_EXPANDED_EMAIL_SIZE', 'general', 'max_expanded_email_size'],
    ['GENERAL_JOB_TIMEOUT', 'general', 'job_timeout'],
    ['GENERAL_MAX_LOOKUPS_PER_REPORT', 'general', 'max_lookups_per_report'],
    [
      'GENERAL_MAX_FAILED_LOOKUPS_PER_REPORT',
      'general',
      'max_failed_lookups_per_report',
    ],
    [
      'GENERAL_MAX_LOOKUP_TIME_PER_REPORT',
      'general',
      'max_lookup_time_per_report',
    ],
    ['GENERAL_MAX_WORKER_HEAP_MB', 'general', 'max_worker_heap_mb'],
    [
      'ELASTICSEARCH_MAX_INDEXES_PER_REPORT',
      'elasticsearch',
      'max_indexes_per_report',
    ],
    [
      'OPENSEARCH_MAX_INDEXES_PER_REPORT',
      'opensearch',
      'max_indexes_per_report',
    ],
    ['POSTGRESQL_SSLMODE', 'postgresql', 'sslmode'],
    ['POSTGRESQL_SSLROOTCERT', 'postgresql', 'sslrootcert'],
    ['POSTGRESQL_SSLCERT', 'postgresql', 'sslcert'],
    ['POSTGRESQL_SSLKEY', 'postgresql', 'sslkey'],
    ['POSTGRESQL_QUERY_TIMEOUT', 'postgresql', 'query_timeout'],
  ])('%s comes from either prefix, TSDMARC_ winning', (name, section, key) => {
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      [`PARSEDMARC_${name}`]: 'parsedmarc',
      [`TSDMARC_${name}`]: 'tsdmarc',
    });
    expect(config.getRaw(section, key)).toBe('tsdmarc');
    const parsedmarcOnly = new ConfigParser();
    applyEnvOverrides(parsedmarcOnly, { [`PARSEDMARC_${name}`]: 'parsedmarc' });
    expect(parsedmarcOnly.getRaw(section, key)).toBe('parsedmarc');
  });
});
