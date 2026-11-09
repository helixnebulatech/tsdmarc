// INI configuration loading and parsing: `_load_config`, `_parse_config`
// and their helpers.

import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { AuthMethod } from '@tsdmarc/msgraph';
import {
  DNSSyntaxError,
  LOKI_TIMESTAMP_MODES,
  logger,
  maskNameserverSecrets,
  NoAnswer,
  NXDOMAIN,
  queryDns,
  redactUrlCredentials,
  reverseNameFromAddress,
} from 'tsdmarc';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

import { ConfigParser, type SectionProxy } from './configparser';
import { applyEnvOverrides } from './env';
import { ConfigurationError } from './errors';
import type { CliOptions } from './options';
import { expandPath } from './paths';

/** `index_prefix_domain_map`: tenant name → domain names, in file order. */
export type IndexPrefixDomainMap = Map<string, string[]>;

/** Converts a comma-separated string to a list. */
export function strToList(value: string): string[] {
  return value.split(',').map(item => item.trimStart());
}

/**
 * The canonical {@link AuthMethod} name for `value`, matched
 * case-insensitively so `certificate` is accepted alongside `Certificate`.
 */
export function normalizeGraphAuthMethod(value: string): string {
  const valueLower = value.toLowerCase();
  const names = Object.keys(AuthMethod);
  for (const name of names) {
    if (name.toLowerCase() === valueLower) {
      return name;
    }
  }
  throw new ConfigurationError(
    `Invalid msgraph auth_method: ${pyStrRepr(value)}. Valid values are: ${names.join(', ')}`,
  );
}

function pyStrRepr(value: string): string {
  return value.includes("'") && !value.includes('"')
    ? `"${value}"`
    : `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/**
 * Load configuration from an INI file and/or environment variables.
 *
 * @throws {ConfigurationError} If `configFile` is given but does not exist
 * or is not readable, or if a `..._FILE` secret file cannot be read.
 */
export function loadConfig(
  configFile: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): ConfigParser {
  const config = new ConfigParser();
  if (configFile !== null) {
    const absPath = path.resolve(configFile);
    if (!existsSync(absPath)) {
      throw new ConfigurationError(`A file does not exist at ${absPath}`);
    }
    try {
      accessSync(absPath, constants.R_OK);
    } catch {
      throw new ConfigurationError(
        `Unable to read ${absPath} — check file permissions`,
      );
    }
    config.read(configFile);
  }
  applyEnvOverrides(config, env);
  return config;
}

/**
 * Read an `index_prefix_domain_map` YAML file. An empty file means "unset"
 * (`null`). Anything else must be a mapping of tenant name to a list of
 * domain names, all strings: every other shape would match the wrong
 * domains (a scalar value) or none (a non-string item) without an error.
 */
export function loadIndexPrefixDomainMap(
  filePath: string,
): IndexPrefixDomainMap | null {
  const text = readFileSync(filePath, 'utf8');
  // PyYAML is YAML 1.1 (`yes` is a boolean) and keeps the last duplicate key.
  const document = parseDocument(text, { version: '1.1', uniqueKeys: false });
  const firstError = document.errors[0];
  if (firstError !== undefined) {
    throw firstError;
  }
  const { contents } = document;
  if (contents === null || (isScalar(contents) && contents.value === null)) {
    return null;
  }
  const invalid = new ConfigurationError(
    'index_prefix_domain_map must be a YAML mapping of tenant ' +
      'name to a list of domain names, all strings',
  );
  if (!isMap(contents)) {
    throw invalid;
  }
  const result: IndexPrefixDomainMap = new Map();
  for (const pair of contents.items) {
    const { key, value } = pair;
    if (!(isScalar(key) && typeof key.value === 'string' && isSeq(value))) {
      throw invalid;
    }
    const domains: string[] = [];
    for (const domain of value.items) {
      if (!(isScalar(domain) && typeof domain.value === 'string')) {
        throw invalid;
      }
      domains.push(domain.value);
    }
    result.set(key.value, domains);
  }
  return result;
}

function bool(section: SectionProxy, key: string): boolean {
  return Boolean(section.getboolean(key));
}

function deprecatedImapOption(option: string): void {
  logger.warning(
    `Use of the ${option} option in the imap ` +
      'configuration section has been deprecated. ' +
      'Use this option in the mailbox configuration ' +
      'section instead.',
  );
}

/** An integer setting that must be 0 or more. */
function nonNegativeInt(section: SectionProxy, key: string): number {
  const value = section.getint(key) ?? 0;
  if (value < 0) {
    throw new ConfigurationError(`${key} must be 0 or a positive integer`);
  }
  return value;
}

function missing(setting: string, section: string): ConfigurationError {
  return new ConfigurationError(
    `${setting} setting missing from the ${section} config section`,
  );
}

async function parseGeneral(
  general: SectionProxy,
  opts: CliOptions,
): Promise<IndexPrefixDomainMap | null> {
  let indexPrefixDomainMap: IndexPrefixDomainMap | null = null;
  if (general.has('silent')) {
    opts.silent = bool(general, 'silent');
  }
  if (general.has('normalize_timespan_threshold_hours')) {
    opts.normalizeTimespanThresholdHours =
      general.getfloat('normalize_timespan_threshold_hours') ?? null;
  }
  if (general.has('index_prefix_domain_map')) {
    indexPrefixDomainMap = loadIndexPrefixDomainMap(
      expandPath(general.getItem('index_prefix_domain_map')),
    );
  }
  if (general.has('offline')) {
    opts.offline = bool(general, 'offline');
  }
  if (general.has('strip_attachment_payloads')) {
    opts.stripAttachmentPayloads = bool(general, 'strip_attachment_payloads');
  }
  if (general.has('output')) {
    opts.output = expandPath(general.getItem('output'));
  }
  if (general.has('archive_directory')) {
    opts.archiveDirectory = expandPath(general.getItem('archive_directory'));
  }
  if (general.has('aggregate_json_filename')) {
    opts.aggregateJsonFilename = general.getItem('aggregate_json_filename');
  }
  if (general.has('failure_json_filename')) {
    opts.failureJsonFilename = general.getItem('failure_json_filename');
  } else if (general.has('forensic_json_filename')) {
    opts.failureJsonFilename = general.getItem('forensic_json_filename');
  }
  if (general.has('smtp_tls_json_filename')) {
    opts.smtpTlsJsonFilename = general.getItem('smtp_tls_json_filename');
  }
  if (general.has('aggregate_csv_filename')) {
    opts.aggregateCsvFilename = general.getItem('aggregate_csv_filename');
  }
  if (general.has('failure_csv_filename')) {
    opts.failureCsvFilename = general.getItem('failure_csv_filename');
  } else if (general.has('forensic_csv_filename')) {
    opts.failureCsvFilename = general.getItem('forensic_csv_filename');
  }
  if (general.has('smtp_tls_csv_filename')) {
    opts.smtpTlsCsvFilename = general.getItem('smtp_tls_csv_filename');
  }
  if (general.has('csv_formula_escape')) {
    opts.csvFormulaEscape = bool(general, 'csv_formula_escape');
  }
  if (general.has('dns_timeout')) {
    opts.dnsTimeout = general.getfloat('dns_timeout') ?? 2;
  }
  if (general.has('dns_retries')) {
    opts.dnsRetries = general.getint('dns_retries') ?? 0;
  }
  // Not in parsedmarc: limits on the emails parsed (0 disables each).
  if (general.has('max_email_size')) {
    opts.maxEmailSize = nonNegativeInt(general, 'max_email_size');
  }
  if (general.has('max_mime_parts')) {
    opts.maxMimeParts = nonNegativeInt(general, 'max_mime_parts');
  }
  if (general.has('max_header_lines')) {
    opts.maxHeaderLines = nonNegativeInt(general, 'max_header_lines');
  }
  if (general.has('max_expanded_email_size')) {
    opts.maxExpandedEmailSize = nonNegativeInt(
      general,
      'max_expanded_email_size',
    );
  }
  if (general.has('max_normalized_records')) {
    opts.maxNormalizedRecords = nonNegativeInt(
      general,
      'max_normalized_records',
    );
  }
  if (general.has('max_xml_depth')) {
    opts.maxXmlDepth = nonNegativeInt(general, 'max_xml_depth');
  }
  if (general.has('max_xml_nodes')) {
    opts.maxXmlNodes = nonNegativeInt(general, 'max_xml_nodes');
  }
  if (general.has('max_smtp_tls_report_size')) {
    opts.maxSmtpTlsReportSize = nonNegativeInt(
      general,
      'max_smtp_tls_report_size',
    );
  }
  if (general.has('max_lookups_per_report')) {
    opts.maxLookupsPerReport = nonNegativeInt(
      general,
      'max_lookups_per_report',
    );
  }
  if (general.has('max_failed_lookups_per_report')) {
    opts.maxFailedLookupsPerReport = nonNegativeInt(
      general,
      'max_failed_lookups_per_report',
    );
  }
  if (general.has('max_lookup_time_per_report')) {
    opts.maxLookupTimePerReport = nonNegativeInt(
      general,
      'max_lookup_time_per_report',
    );
  }
  if (general.has('job_timeout')) {
    opts.jobTimeout = nonNegativeInt(general, 'job_timeout');
  }
  if (general.has('max_worker_heap_mb')) {
    opts.maxWorkerHeapMb = nonNegativeInt(general, 'max_worker_heap_mb');
  }
  if (general.has('dns_test_address')) {
    opts.dnsTestAddress = general.getItem('dns_test_address');
  }
  if (general.has('nameservers')) {
    opts.nameservers = strToList(general.getItem('nameservers'));
    await dnsPreFlightCheck(opts.dnsTestAddress, opts.nameservers, opts);
  }
  if (general.has('save_aggregate')) {
    opts.saveAggregate = bool(general, 'save_aggregate');
  }
  if (general.has('save_failure')) {
    opts.saveFailure = bool(general, 'save_failure');
  } else if (general.has('save_forensic')) {
    opts.saveFailure = bool(general, 'save_forensic');
  }
  if (general.has('save_smtp_tls')) {
    opts.saveSmtpTls = bool(general, 'save_smtp_tls');
  }
  if (general.has('debug')) {
    opts.debug = bool(general, 'debug');
  }
  if (general.has('verbose')) {
    opts.verbose = bool(general, 'verbose');
  }
  if (general.has('warnings')) {
    opts.warnings = bool(general, 'warnings');
  }
  if (general.has('fail_on_output_error')) {
    opts.failOnOutputError = bool(general, 'fail_on_output_error');
  }
  if (general.has('log_file')) {
    opts.logFile = expandPath(general.getItem('log_file'));
  }
  if (general.has('n_procs')) {
    opts.nProcs = general.getint('n_procs') ?? null;
  }
  opts.ipDbPath = general.has('ip_db_path')
    ? expandPath(general.getItem('ip_db_path'))
    : null;
  if (general.has('ipinfo_url')) {
    opts.ipinfoUrl = general.getItem('ipinfo_url');
  } else if (general.has('ip_db_url')) {
    // `ip_db_url` is the pre-9.10 name of the same option.
    opts.ipinfoUrl = general.getItem('ip_db_url');
    logger.warning(
      '[general] ip_db_url is deprecated; rename it to ipinfo_url',
    );
  }
  if (general.has('ipinfo_api_token')) {
    opts.ipinfoApiToken = general.getItem('ipinfo_api_token');
  }
  if (general.has('always_use_local_files')) {
    opts.alwaysUseLocalFiles = bool(general, 'always_use_local_files');
  }
  if (general.has('local_reverse_dns_map_path')) {
    opts.reverseDnsMapPath = expandPath(
      general.getItem('local_reverse_dns_map_path'),
    );
  }
  if (general.has('reverse_dns_map_url')) {
    opts.reverseDnsMapUrl = general.getItem('reverse_dns_map_url');
  }
  if (general.has('local_psl_overrides_path')) {
    opts.pslOverridesPath = expandPath(
      general.getItem('local_psl_overrides_path'),
    );
  }
  if (general.has('psl_overrides_url')) {
    opts.pslOverridesUrl = general.getItem('psl_overrides_url');
  }
  if (general.has('prettify_json')) {
    opts.prettifyJson = bool(general, 'prettify_json');
  }
  return indexPrefixDomainMap;
}

/**
 * The nameservers pre-flight check: a PTR query for `dnsTestAddress`.
 * queryDns() is called directly rather than getReverseDns(), which turns
 * every DNS error into `null`, so a broken transport (every DoH query
 * failing) would be reported as a missing PTR record.
 */
async function dnsPreFlightCheck(
  dnsTestAddress: string,
  nameservers: string[],
  opts: CliOptions,
): Promise<void> {
  let reverseName: string;
  try {
    reverseName = reverseNameFromAddress(dnsTestAddress);
  } catch (error) {
    if (!(error instanceof DNSSyntaxError)) {
      throw error;
    }
    throw new ConfigurationError(
      `DNS pre-flight check failed: dns_test_address ${pyStrRepr(dnsTestAddress)} is not a valid IP address`,
      { cause: error },
    );
  }
  try {
    await queryDns(reverseName, 'PTR', {
      nameservers,
      ...(opts.dnsTimeout === null ? {} : { timeout: opts.dnsTimeout }),
    });
  } catch (error) {
    if (error instanceof NXDOMAIN || error instanceof NoAnswer) {
      throw new ConfigurationError(
        `DNS pre-flight check failed: no PTR record for ${dnsTestAddress} from ${pyList(redactUrlCredentials(nameservers))}: ${error.message}`,
        { cause: error },
      );
    }
    // A DNS over HTTPS error can quote the request URL, which carries the
    // configured nameserver's credentials: no cause is kept.
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(
      `DNS pre-flight check failed: ${name}: ${maskNameserverSecrets(message, nameservers)}`,
    );
  }
}

/** Python's `str(list_of_str)`. */
export function pyList(values: readonly string[]): string {
  return `[${values.map(pyStrRepr).join(', ')}]`;
}

function parseMailbox(config: ConfigParser, opts: CliOptions): void {
  const mailbox = config.section('mailbox');
  if (config.sections().includes('msgraph')) {
    opts.mailboxReportsFolder = 'Inbox';
  }
  if (mailbox.has('reports_folder')) {
    opts.mailboxReportsFolder = mailbox.getItem('reports_folder');
  }
  if (mailbox.has('archive_folder')) {
    opts.mailboxArchiveFolder = mailbox.getItem('archive_folder');
  }
  if (mailbox.has('watch')) {
    opts.mailboxWatch = bool(mailbox, 'watch');
  }
  if (mailbox.has('delete')) {
    opts.mailboxDelete = bool(mailbox, 'delete');
  }
  if (mailbox.has('delete_aggregate')) {
    opts.mailboxDeleteAggregate = bool(mailbox, 'delete_aggregate');
  }
  if (mailbox.has('delete_failure')) {
    opts.mailboxDeleteFailure = bool(mailbox, 'delete_failure');
  }
  if (mailbox.has('delete_smtp_tls')) {
    opts.mailboxDeleteSmtpTls = bool(mailbox, 'delete_smtp_tls');
  }
  if (mailbox.has('delete_invalid')) {
    opts.mailboxDeleteInvalid = bool(mailbox, 'delete_invalid');
  }
  if (mailbox.has('test')) {
    opts.mailboxTest = bool(mailbox, 'test');
  }
  if (mailbox.has('batch_size')) {
    opts.mailboxBatchSize = mailbox.getint('batch_size') ?? null;
  }
  if (mailbox.has('check_timeout')) {
    opts.mailboxCheckTimeout = mailbox.getint('check_timeout') ?? null;
  }
  if (mailbox.has('max_unsaved_retries')) {
    opts.mailboxMaxUnsavedRetries =
      mailbox.getint('max_unsaved_retries') ?? null;
  }
  if (mailbox.has('since')) {
    opts.mailboxSince = mailbox.getItem('since');
  }
}

function parseImap(imap: SectionProxy, opts: CliOptions): void {
  if (imap.has('watch')) {
    logger.warning(
      'Starting in 8.0.0, the watch option has been ' +
        'moved from the imap configuration section to ' +
        'the mailbox configuration section.',
    );
  }
  if (!imap.has('host')) {
    throw missing('host', 'imap');
  }
  opts.imapHost = imap.getItem('host');
  if (imap.has('port')) {
    opts.imapPort = imap.getint('port') ?? null;
  }
  if (imap.has('timeout')) {
    opts.imapTimeout = imap.getint('timeout') ?? null;
  }
  if (imap.has('max_retries')) {
    opts.imapMaxRetries = imap.getint('max_retries') ?? null;
  }
  if (imap.has('ssl')) {
    opts.imapSsl = bool(imap, 'ssl');
  }
  if (imap.has('skip_certificate_verification')) {
    opts.imapSkipCertificateVerification = bool(
      imap,
      'skip_certificate_verification',
    );
  }
  if (imap.has('starttls')) {
    opts.imapStarttls = bool(imap, 'starttls');
  }
  if (opts.imapStarttls === false && !opts.imapSsl) {
    logger.warning(
      '[imap] starttls = False and ssl = False: the IMAP connection ' +
        'will not be encrypted, and the IMAP credentials will be sent ' +
        'in plain text',
    );
  }
  if (!imap.has('user')) {
    throw missing('user', 'imap');
  }
  opts.imapUser = imap.getItem('user');
  if (!imap.has('password')) {
    throw missing('password', 'imap');
  }
  opts.imapPassword = imap.getItem('password');
  if (imap.has('reports_folder')) {
    opts.mailboxReportsFolder = imap.getItem('reports_folder');
    deprecatedImapOption('reports_folder');
  }
  if (imap.has('archive_folder')) {
    opts.mailboxArchiveFolder = imap.getItem('archive_folder');
    deprecatedImapOption('archive_folder');
  }
  if (imap.has('watch')) {
    opts.mailboxWatch = bool(imap, 'watch');
    deprecatedImapOption('watch');
  }
  if (imap.has('delete')) {
    deprecatedImapOption('delete');
  }
  if (imap.has('test')) {
    opts.mailboxTest = bool(imap, 'test');
    deprecatedImapOption('test');
  }
  if (imap.has('batch_size')) {
    opts.mailboxBatchSize = imap.getint('batch_size') ?? null;
    deprecatedImapOption('batch_size');
  }
}

function parseMsgraph(graph: SectionProxy, opts: CliOptions): void {
  opts.graphTokenFile = expandPath(graph.get('token_file', '.token'));

  if (graph.has('auth_method')) {
    opts.graphAuthMethod = normalizeGraphAuthMethod(
      graph.getItem('auth_method'),
    );
  } else {
    logger.info(
      'auth_method setting missing from the ' +
        'msgraph config section ' +
        'defaulting to UsernamePassword',
    );
    opts.graphAuthMethod = 'UsernamePassword';
  }
  const method = opts.graphAuthMethod;

  if (method === 'UsernamePassword') {
    if (!graph.has('user')) {
      throw missing('user', 'msgraph');
    }
    opts.graphUser = graph.getItem('user');
    if (!graph.has('password')) {
      throw missing('password', 'msgraph');
    }
    opts.graphPassword = graph.getItem('password');
    if (!graph.has('client_secret')) {
      throw missing('client_secret', 'msgraph');
    }
    opts.graphClientSecret = graph.getItem('client_secret');
  }

  if (method === 'DeviceCode' && graph.has('user')) {
    opts.graphUser = graph.getItem('user');
  }

  if (method !== 'UsernamePassword') {
    if (!graph.has('tenant_id')) {
      throw missing('tenant_id', 'msgraph');
    }
    opts.graphTenantId = graph.getItem('tenant_id');
  }

  if (method === 'ClientSecret') {
    if (!graph.has('client_secret')) {
      throw missing('client_secret', 'msgraph');
    }
    opts.graphClientSecret = graph.getItem('client_secret');
  }

  if (method === 'Certificate') {
    if (!graph.has('certificate_path')) {
      throw missing('certificate_path', 'msgraph');
    }
    opts.graphCertificatePath = expandPath(graph.getItem('certificate_path'));
    if (graph.has('certificate_password')) {
      opts.graphCertificatePassword = graph.getItem('certificate_password');
    }
  }

  if (method === 'ClientAssertion') {
    if (!graph.has('client_assertion')) {
      throw missing('client_assertion', 'msgraph');
    }
    opts.graphClientAssertion = graph.getItem('client_assertion');
  }

  if (!graph.has('client_id')) {
    throw missing('client_id', 'msgraph');
  }
  opts.graphClientId = graph.getItem('client_id');

  if (graph.has('mailbox')) {
    opts.graphMailbox = graph.getItem('mailbox');
  } else if (method !== 'UsernamePassword') {
    throw missing('mailbox', 'msgraph');
  }

  if (graph.has('graph_url')) {
    opts.graphUrl = graph.getItem('graph_url');
  } else if (graph.has('url')) {
    opts.graphUrl = graph.getItem('url');
  }

  if (graph.has('allow_unencrypted_storage')) {
    opts.graphAllowUnencryptedStorage = bool(
      graph,
      'allow_unencrypted_storage',
    );
  }
}

type SearchBackend = 'elasticsearch' | 'opensearch';

function parseSearch(
  search: SectionProxy,
  opts: CliOptions,
  backend: SearchBackend,
): void {
  if (!search.has('hosts')) {
    throw missing('hosts', backend);
  }
  const hosts = strToList(search.getItem('hosts'));
  const timeout = search.has('timeout')
    ? search.getfloat('timeout')
    : undefined;
  const shards = search.has('number_of_shards')
    ? search.getint('number_of_shards')
    : undefined;
  const replicas = search.has('number_of_replicas')
    ? search.getint('number_of_replicas')
    : undefined;
  const indexSuffix = search.has('index_suffix')
    ? search.getItem('index_suffix')
    : undefined;
  const indexPrefix = search.has('index_prefix')
    ? search.getItem('index_prefix')
    : undefined;
  const monthly = search.has('monthly_indexes')
    ? bool(search, 'monthly_indexes')
    : undefined;
  const ssl = search.has('ssl') ? bool(search, 'ssl') : undefined;
  const certPath = search.has('cert_path')
    ? expandPath(search.getItem('cert_path'))
    : undefined;
  const skipVerification = search.has('skip_certificate_verification')
    ? bool(search, 'skip_certificate_verification')
    : undefined;
  const user = search.has('user') ? search.getItem('user') : undefined;
  const password = search.has('password')
    ? search.getItem('password')
    : undefined;
  const useDataStreams = search.has('use_data_streams')
    ? bool(search, 'use_data_streams')
    : undefined;
  // Not in parsedmarc: 0 disables the limit.
  const maxIndexes = search.has('max_indexes_per_report')
    ? nonNegativeInt(search, 'max_indexes_per_report')
    : undefined;
  let apiKey: string | undefined;
  // Until 8.20
  if (search.has('apiKey')) {
    apiKey = search.getItem('apiKey');
  }
  // Since 8.20
  if (search.has('api_key')) {
    apiKey = search.getItem('api_key');
  }

  if (backend === 'elasticsearch') {
    opts.elasticsearchHosts = hosts;
    if (timeout !== undefined) opts.elasticsearchTimeout = timeout;
    if (shards !== undefined) opts.elasticsearchNumberOfShards = shards;
    if (replicas !== undefined) opts.elasticsearchNumberOfReplicas = replicas;
    if (indexSuffix !== undefined) opts.elasticsearchIndexSuffix = indexSuffix;
    if (indexPrefix !== undefined) opts.elasticsearchIndexPrefix = indexPrefix;
    if (monthly !== undefined) opts.elasticsearchMonthlyIndexes = monthly;
    if (ssl !== undefined) opts.elasticsearchSsl = ssl;
    if (certPath !== undefined) opts.elasticsearchSslCertPath = certPath;
    if (skipVerification !== undefined) {
      opts.elasticsearchSkipCertificateVerification = skipVerification;
    }
    if (user !== undefined) opts.elasticsearchUsername = user;
    if (password !== undefined) opts.elasticsearchPassword = password;
    if (apiKey !== undefined) opts.elasticsearchApiKey = apiKey;
    if (maxIndexes !== undefined) {
      opts.elasticsearchMaxIndexesPerReport = maxIndexes;
    }
    if (search.has('serverless')) {
      opts.elasticsearchServerless = search.getboolean('serverless') ?? null;
    }
    if (useDataStreams !== undefined) {
      opts.elasticsearchUseDataStreams = useDataStreams;
    }
    if (opts.elasticsearchUseDataStreams && opts.elasticsearchMonthlyIndexes) {
      warnMonthlyIndexesIgnored(backend);
    }
    return;
  }

  opts.opensearchHosts = hosts;
  if (timeout !== undefined) opts.opensearchTimeout = timeout;
  if (shards !== undefined) opts.opensearchNumberOfShards = shards;
  if (replicas !== undefined) opts.opensearchNumberOfReplicas = replicas;
  if (indexSuffix !== undefined) opts.opensearchIndexSuffix = indexSuffix;
  if (indexPrefix !== undefined) opts.opensearchIndexPrefix = indexPrefix;
  if (monthly !== undefined) opts.opensearchMonthlyIndexes = monthly;
  if (ssl !== undefined) opts.opensearchSsl = ssl;
  if (certPath !== undefined) opts.opensearchSslCertPath = certPath;
  if (skipVerification !== undefined) {
    opts.opensearchSkipCertificateVerification = skipVerification;
  }
  if (user !== undefined) opts.opensearchUsername = user;
  if (password !== undefined) opts.opensearchPassword = password;
  if (apiKey !== undefined) opts.opensearchApiKey = apiKey;
  if (maxIndexes !== undefined) opts.opensearchMaxIndexesPerReport = maxIndexes;
  if (search.has('auth_type')) {
    opts.opensearchAuthType = search.getItem('auth_type').trim().toLowerCase();
  } else if (search.has('authentication_type')) {
    opts.opensearchAuthType = search
      .getItem('authentication_type')
      .trim()
      .toLowerCase();
  }
  if (search.has('aws_region')) {
    opts.opensearchAwsRegion = search.getItem('aws_region').trim();
  }
  if (search.has('aws_service')) {
    opts.opensearchAwsService = search.getItem('aws_service').trim();
  }
  if (useDataStreams !== undefined) {
    opts.opensearchUseDataStreams = useDataStreams;
  }
  if (opts.opensearchUseDataStreams && opts.opensearchMonthlyIndexes) {
    warnMonthlyIndexesIgnored(backend);
  }
}

function warnMonthlyIndexesIgnored(backend: SearchBackend): void {
  logger.warning(
    `[${backend}] monthly_indexes is ignored because use_data_streams is enabled`,
  );
}

function parseSplunkHec(hec: SectionProxy, opts: CliOptions): void {
  if (!hec.has('url')) {
    throw missing('url', 'splunk_hec');
  }
  opts.hec = hec.getItem('url');
  if (!hec.has('token')) {
    throw missing('token', 'splunk_hec');
  }
  opts.hecToken = hec.getItem('token');
  if (!hec.has('index')) {
    throw missing('index', 'splunk_hec');
  }
  opts.hecIndex = hec.getItem('index');
  if (hec.has('skip_certificate_verification')) {
    opts.hecSkipCertificateVerification = Boolean(
      hec.getboolean('skip_certificate_verification', false),
    );
  }
}

function parseKafka(kafka: SectionProxy, opts: CliOptions): void {
  if (!kafka.has('hosts')) {
    throw missing('hosts', 'kafka');
  }
  opts.kafkaHosts = strToList(kafka.getItem('hosts'));
  if (kafka.has('user')) {
    opts.kafkaUsername = kafka.getItem('user');
  }
  if (kafka.has('password')) {
    opts.kafkaPassword = kafka.getItem('password');
  }
  if (kafka.has('ssl')) {
    opts.kafkaSsl = bool(kafka, 'ssl');
  }
  if (kafka.has('skip_certificate_verification')) {
    opts.kafkaSkipCertificateVerification = bool(
      kafka,
      'skip_certificate_verification',
    );
  }
  if (!kafka.has('aggregate_topic')) {
    throw missing('aggregate_topic', 'kafka');
  }
  opts.kafkaAggregateTopic = kafka.getItem('aggregate_topic');
  if (kafka.has('failure_topic')) {
    opts.kafkaFailureTopic = kafka.getItem('failure_topic');
  } else if (kafka.has('forensic_topic')) {
    opts.kafkaFailureTopic = kafka.getItem('forensic_topic');
  } else {
    throw missing('failure_topic', 'kafka');
  }
  if (!kafka.has('smtp_tls_topic')) {
    throw missing('smtp_tls_topic', 'kafka');
  }
  opts.kafkaSmtpTlsTopic = kafka.getItem('smtp_tls_topic');
}

function parseSmtp(smtp: SectionProxy, opts: CliOptions): void {
  if (smtp.has('host')) {
    opts.smtpHost = smtp.getItem('host');
    if (!smtp.has('user')) {
      throw missing('user', 'smtp');
    }
    opts.smtpUser = smtp.getItem('user');
    if (!smtp.has('password')) {
      throw missing('password', 'smtp');
    }
    opts.smtpPassword = smtp.getItem('password');
    if (smtp.has('from')) {
      opts.smtpFrom = smtp.getItem('from');
    } else {
      logger.critical('from setting missing from the smtp config section');
    }
  } else if (!opts.graphClientId) {
    // host is SMTP-only; with [msgraph] the summary email goes through the
    // Graph mailbox instead, so host/user/password/from are not required.
    throw missing('host', 'smtp');
  }
  if (smtp.has('port')) {
    opts.smtpPort = smtp.getint('port') ?? null;
  }
  if (smtp.has('ssl')) {
    opts.smtpSsl = bool(smtp, 'ssl');
  }
  if (smtp.has('skip_certificate_verification')) {
    opts.smtpSkipCertificateVerification = bool(
      smtp,
      'skip_certificate_verification',
    );
  }
  if (smtp.has('starttls')) {
    opts.smtpStarttls = bool(smtp, 'starttls');
  }
  if (opts.smtpHost && opts.smtpStarttls === false && !opts.smtpSsl) {
    logger.warning(
      '[smtp] starttls = False and ssl = False: the SMTP connection ' +
        'will not be encrypted, and the SMTP credentials and the ' +
        'results email will be sent in plain text',
    );
  }
  if (smtp.has('to')) {
    opts.smtpTo = strToList(smtp.getItem('to'));
  } else {
    logger.critical('to setting missing from the smtp config section');
  }
  if (smtp.has('subject')) {
    opts.smtpSubject = smtp.getItem('subject');
  }
  if (smtp.has('attachment')) {
    opts.smtpAttachment = expandPath(smtp.getItem('attachment'));
  }
  if (smtp.has('message')) {
    opts.smtpMessage = smtp.getItem('message');
  }
}

function parseS3(s3: SectionProxy, opts: CliOptions): void {
  if (!s3.has('bucket')) {
    throw missing('bucket', 's3');
  }
  opts.s3Bucket = s3.getItem('bucket');
  if (s3.has('path')) {
    let s3Path = s3.getItem('path');
    if (s3Path.startsWith('/')) {
      s3Path = s3Path.slice(1);
    }
    if (s3Path.endsWith('/')) {
      s3Path = s3Path.slice(0, -1);
    }
    opts.s3Path = s3Path;
  } else {
    opts.s3Path = '';
  }
  if (s3.has('region_name')) {
    opts.s3RegionName = s3.getItem('region_name');
  }
  if (s3.has('endpoint_url')) {
    opts.s3EndpointUrl = s3.getItem('endpoint_url');
  }
  if (s3.has('access_key_id')) {
    opts.s3AccessKeyId = s3.getItem('access_key_id');
  }
  if (s3.has('secret_access_key')) {
    opts.s3SecretAccessKey = s3.getItem('secret_access_key');
  }
  // Not in parsedmarc, which always overwrites.
  if (s3.has('prevent_overwrite')) {
    opts.s3PreventOverwrite = Boolean(s3.getboolean('prevent_overwrite'));
  }
}

const POSTGRESQL_TLS_KEYS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey'];

function parsePostgresql(pg: SectionProxy, opts: CliOptions): void {
  // Not in parsedmarc. 0 waits forever.
  if (pg.has('query_timeout')) {
    opts.postgresqlQueryTimeout = nonNegativeInt(pg, 'query_timeout');
  }
  if (pg.has('connection_string')) {
    opts.postgresqlConnectionString = pg.getItem('connection_string');
    // The client ignores these with a connection string, and a TLS setting
    // ignored in silence is a weaker connection than the file asks for.
    for (const key of POSTGRESQL_TLS_KEYS) {
      if (pg.has(key)) {
        logger.error(
          `[postgresql] ${key} is ignored with connection_string: put it in the connection string`,
        );
      }
    }
  } else if (pg.has('host')) {
    opts.postgresqlHost = pg.getItem('host');
    if (pg.has('port')) {
      opts.postgresqlPort = pg.getint('port') ?? null;
    }
    if (pg.has('user')) {
      opts.postgresqlUser = pg.getItem('user');
    }
    if (pg.has('password')) {
      opts.postgresqlPassword = pg.getItem('password');
    }
    if (pg.has('database')) {
      opts.postgresqlDatabase = pg.getItem('database');
    }
    // Not in parsedmarc. sslrootcert may also be libpq's word `system`.
    if (pg.has('sslmode')) {
      opts.postgresqlSslmode = pg.getItem('sslmode');
    }
    if (pg.has('sslrootcert')) {
      opts.postgresqlSslrootcert = expandPath(pg.getItem('sslrootcert'));
    }
    if (pg.has('sslcert')) {
      opts.postgresqlSslcert = expandPath(pg.getItem('sslcert'));
    }
    if (pg.has('sslkey')) {
      opts.postgresqlSslkey = expandPath(pg.getItem('sslkey'));
    }
  } else {
    throw new ConfigurationError(
      'host (or connection_string) setting missing from the ' +
        'postgresql config section',
    );
  }
}

function parseSyslog(syslog: SectionProxy, opts: CliOptions): void {
  if (!syslog.has('server')) {
    throw missing('server', 'syslog');
  }
  opts.syslogServer = syslog.getItem('server');
  opts.syslogPort = syslog.has('port') ? syslog.getItem('port') : 514;
  opts.syslogProtocol = syslog.has('protocol')
    ? syslog.getItem('protocol')
    : 'udp';
  if (syslog.has('cafile_path')) {
    opts.syslogCafilePath = expandPath(syslog.getItem('cafile_path'));
  }
  if (syslog.has('certfile_path')) {
    opts.syslogCertfilePath = expandPath(syslog.getItem('certfile_path'));
  }
  if (syslog.has('keyfile_path')) {
    opts.syslogKeyfilePath = expandPath(syslog.getItem('keyfile_path'));
  }
  opts.syslogTimeout = syslog.has('timeout')
    ? (syslog.getfloat('timeout') ?? null)
    : 5.0;
  opts.syslogRetryAttempts = syslog.has('retry_attempts')
    ? (syslog.getint('retry_attempts') ?? null)
    : 3;
  opts.syslogRetryDelay = syslog.has('retry_delay')
    ? (syslog.getint('retry_delay') ?? null)
    : 5;
}

function parseGmailApi(gmail: SectionProxy, opts: CliOptions): void {
  const credentials = gmail.get('credentials_file');
  opts.gmailApiCredentialsFile = credentials
    ? expandPath(credentials)
    : (credentials ?? null);
  opts.gmailApiTokenFile = expandPath(gmail.get('token_file', '.token'));
  opts.gmailApiIncludeSpamTrash = Boolean(
    gmail.getboolean('include_spam_trash', false),
  );
  opts.gmailApiPaginateMessages = Boolean(
    gmail.getboolean('paginate_messages', true),
  );
  const defaultScope = 'https://www.googleapis.com/auth/gmail.modify';
  opts.gmailApiScopes = strToList(gmail.get('scopes', defaultScope));
  if (gmail.has('oauth2_port')) {
    opts.gmailApiOauth2Port = gmail.getint('oauth2_port', 8080);
  }
  if (gmail.has('auth_mode')) {
    opts.gmailApiAuthMode = gmail.getItem('auth_mode').trim();
  }
  if (gmail.has('service_account_user')) {
    opts.gmailApiServiceAccountUser = gmail
      .getItem('service_account_user')
      .trim();
  } else if (gmail.has('delegated_user')) {
    opts.gmailApiServiceAccountUser = gmail.getItem('delegated_user').trim();
  }
}

function parseMaildir(maildir: SectionProxy, opts: CliOptions): void {
  const maildirPath = maildir.get('maildir_path', maildir.get('path'));
  opts.maildirPath = maildirPath
    ? expandPath(maildirPath)
    : (maildirPath ?? null);
  opts.maildirCreate = Boolean(
    maildir.getboolean('maildir_create', maildir.getboolean('create', false)),
  );
}

function parseLogAnalytics(la: SectionProxy, opts: CliOptions): void {
  opts.laClientId = la.get('client_id') ?? null;
  opts.laClientSecret = la.get('client_secret') ?? null;
  opts.laTenantId = la.get('tenant_id') ?? null;
  opts.laDce = la.get('dce') ?? null;
  opts.laDcrImmutableId = la.get('dcr_immutable_id') ?? null;
  opts.laDcrAggregateStream = la.get('dcr_aggregate_stream') ?? null;
  opts.laDcrFailureStream =
    la.get('dcr_failure_stream') || la.get('dcr_forensic_stream') || null;
  opts.laDcrSmtpTlsStream = la.get('dcr_smtp_tls_stream') ?? null;
}

function parseGelf(gelf: SectionProxy, opts: CliOptions): void {
  if (!gelf.has('host')) {
    throw missing('host', 'gelf');
  }
  opts.gelfHost = gelf.getItem('host');
  if (!gelf.has('port')) {
    throw missing('port', 'gelf');
  }
  opts.gelfPort = gelf.getItem('port');
  if (!gelf.has('mode')) {
    throw missing('mode', 'gelf');
  }
  opts.gelfMode = gelf.getItem('mode');
  // tsdmarc additions (only used with mode = tls): GELF over TLS verifies
  // the server certificate, which pygelf doesn't.
  if (gelf.has('cafile')) {
    opts.gelfCafile = expandPath(gelf.getItem('cafile'));
  }
  if (gelf.has('skip_certificate_verification')) {
    opts.gelfSkipCertificateVerification = bool(
      gelf,
      'skip_certificate_verification',
    );
  }
}

function parseWebhook(webhook: SectionProxy, opts: CliOptions): void {
  if (webhook.has('aggregate_url')) {
    opts.webhookAggregateUrl = webhook.getItem('aggregate_url');
  }
  if (webhook.has('failure_url')) {
    opts.webhookFailureUrl = webhook.getItem('failure_url');
  } else if (webhook.has('forensic_url')) {
    opts.webhookFailureUrl = webhook.getItem('forensic_url');
  }
  if (webhook.has('smtp_tls_url')) {
    opts.webhookSmtpTlsUrl = webhook.getItem('smtp_tls_url');
  }
  if (webhook.has('timeout')) {
    opts.webhookTimeout = webhook.getint('timeout') ?? null;
  }
}

function parseLoki(loki: SectionProxy, opts: CliOptions): void {
  if (!loki.has('url')) {
    throw missing('url', 'loki');
  }
  opts.lokiUrl = loki.getItem('url');
  if (loki.has('labels')) {
    const labels: Record<string, string> = {};
    for (const pair of strToList(loki.getItem('labels'))) {
      const separator = pair.indexOf('=');
      const name = separator === -1 ? '' : pair.slice(0, separator).trim();
      if (name === '') {
        throw new ConfigurationError(
          `Invalid loki label '${pair}', expected name=value`,
        );
      }
      labels[name] = pair.slice(separator + 1).trim();
    }
    opts.lokiLabels = labels;
  }
  if (loki.has('label_fields')) {
    opts.lokiLabelFields = strToList(loki.getItem('label_fields'))
      .map(field => field.trim())
      .filter(field => field !== '');
  }
  if (loki.has('timestamp')) {
    const timestamp = loki.getItem('timestamp');
    opts.lokiTimestamp = timestamp;
    if (!(LOKI_TIMESTAMP_MODES as readonly string[]).includes(timestamp)) {
      throw new ConfigurationError(
        `Invalid loki timestamp '${timestamp}', must be one of: ${LOKI_TIMESTAMP_MODES.join(', ')}`,
      );
    }
  }
  if (loki.has('username')) {
    opts.lokiUsername = loki.getItem('username');
  }
  if (loki.has('password')) {
    opts.lokiPassword = loki.getItem('password');
  }
  if (loki.has('token')) {
    opts.lokiToken = loki.getItem('token');
  }
  if (loki.has('tenant_id')) {
    opts.lokiTenantId = loki.getItem('tenant_id');
  }
  if (loki.has('skip_certificate_verification')) {
    opts.lokiSkipCertificateVerification = bool(
      loki,
      'skip_certificate_verification',
    );
  }
  if (loki.has('timeout')) {
    opts.lokiTimeout = loki.getfloat('timeout') ?? null;
  }
  if (loki.has('batch_size')) {
    opts.lokiBatchSize = loki.getint('batch_size') ?? null;
  }
}

/**
 * Apply a loaded configuration to `opts` in place.
 *
 * @returns The `index_prefix_domain_map`, or `null`.
 * @throws {ConfigurationError} If required settings are missing or invalid.
 */
export async function parseConfig(
  config: ConfigParser,
  opts: CliOptions,
): Promise<IndexPrefixDomainMap | null> {
  opts.silent = true;
  let indexPrefixDomainMap: IndexPrefixDomainMap | null = null;
  const sections = config.sections();
  if (sections.includes('general')) {
    indexPrefixDomainMap = await parseGeneral(config.section('general'), opts);
  }
  if (sections.includes('mailbox')) {
    parseMailbox(config, opts);
  }
  if (sections.includes('imap')) {
    parseImap(config.section('imap'), opts);
  }
  if (sections.includes('msgraph')) {
    parseMsgraph(config.section('msgraph'), opts);
  }
  if (config.has('elasticsearch')) {
    parseSearch(config.section('elasticsearch'), opts, 'elasticsearch');
  }
  if (config.has('opensearch')) {
    parseSearch(config.section('opensearch'), opts, 'opensearch');
  }
  if (sections.includes('splunk_hec')) {
    parseSplunkHec(config.section('splunk_hec'), opts);
  }
  if (sections.includes('kafka')) {
    parseKafka(config.section('kafka'), opts);
  }
  if (sections.includes('smtp')) {
    parseSmtp(config.section('smtp'), opts);
  }
  if (sections.includes('s3')) {
    parseS3(config.section('s3'), opts);
  }
  if (sections.includes('postgresql')) {
    parsePostgresql(config.section('postgresql'), opts);
  }
  if (sections.includes('syslog')) {
    parseSyslog(config.section('syslog'), opts);
  }
  if (sections.includes('gmail_api')) {
    parseGmailApi(config.section('gmail_api'), opts);
  }
  if (sections.includes('maildir')) {
    parseMaildir(config.section('maildir'), opts);
  }
  if (sections.includes('log_analytics')) {
    parseLogAnalytics(config.section('log_analytics'), opts);
  }
  if (sections.includes('gelf')) {
    parseGelf(config.section('gelf'), opts);
  }
  if (sections.includes('webhook')) {
    parseWebhook(config.section('webhook'), opts);
  }
  if (sections.includes('loki')) {
    parseLoki(config.section('loki'), opts);
  }
  return indexPrefixDomainMap;
}
