// The CLI's options namespace (parsedmarc's `opts`): every setting from the
// command line, the configuration file and environment variables, with
// parsedmarc's defaults. Names are parsedmarc's, in camelCase.

import {
  DEFAULT_JOB_TIMEOUT,
  DEFAULT_MAX_EMAIL_SIZE,
  DEFAULT_MAX_EXPANDED_EMAIL_SIZE,
  DEFAULT_MAX_FAILED_LOOKUPS_PER_REPORT,
  DEFAULT_MAX_LOOKUP_TIME_PER_REPORT,
  DEFAULT_MAX_HEADER_LINES,
  DEFAULT_MAX_LOOKUPS_PER_REPORT,
  DEFAULT_MAX_MIME_PARTS,
  DEFAULT_MAX_NORMALIZED_RECORDS,
  DEFAULT_MAX_SMTP_TLS_REPORT_SIZE,
  DEFAULT_MAX_WORKER_HEAP_MB,
  DEFAULT_MAX_XML_DEPTH,
  DEFAULT_MAX_XML_NODES,
} from 'tsdmarc';

/** Values from the command line. */
export interface CliArgs {
  filePath: string[];
  configFile: string | null;
  recursive: boolean;
  stripAttachmentPayloads: boolean;
  output: string | null;
  aggregateJsonFilename: string;
  failureJsonFilename: string;
  smtpTlsJsonFilename: string;
  aggregateCsvFilename: string;
  failureCsvFilename: string;
  smtpTlsCsvFilename: string;
  nameservers: string[] | null;
  dnsTimeout: number;
  dnsRetries: number;
  offline: boolean;
  silent: boolean;
  warnings: boolean;
  verbose: boolean;
  debug: boolean;
  logFile: string | null;
  prettifyJson: boolean;
}

export interface CliOptions {
  filePath: string[];
  configFile: string | null;
  offline: boolean;
  stripAttachmentPayloads: boolean;
  output: string | null;
  aggregateCsvFilename: string;
  aggregateJsonFilename: string;
  failureCsvFilename: string;
  failureJsonFilename: string;
  smtpTlsJsonFilename: string;
  smtpTlsCsvFilename: string;
  /** `[general] csv_formula_escape` (tsdmarc only): see `SaveOutputOptions.csvFormulaEscape`. */
  csvFormulaEscape: boolean;
  nameservers: string[] | null;
  dnsTestAddress: string;
  silent: boolean;
  warnings: boolean;
  dnsTimeout: number | null;
  dnsRetries: number | null;
  debug: boolean;
  verbose: boolean;
  prettifyJson: boolean;
  saveAggregate: boolean;
  saveFailure: boolean;
  saveSmtpTls: boolean;
  mailboxReportsFolder: string;
  mailboxArchiveFolder: string;
  mailboxWatch: boolean;
  mailboxDelete: boolean;
  /**
   * `null` means "unset": each per-report-type flag then inherits
   * `mailboxDelete`, so an explicit `false` (opting one type out of a global
   * `delete = true`) stays distinct from being unset.
   */
  mailboxDeleteAggregate: boolean | null;
  mailboxDeleteFailure: boolean | null;
  mailboxDeleteSmtpTls: boolean | null;
  mailboxDeleteInvalid: boolean | null;
  mailboxTest: boolean;
  mailboxBatchSize: number | null;
  mailboxCheckTimeout: number | null;
  mailboxMaxUnsavedRetries: number | null;
  mailboxSince: string | null;
  imapHost: string | null;
  imapSkipCertificateVerification: boolean;
  imapSsl: boolean;
  /** `[imap] starttls`: `null` (unset) requires STARTTLS before logging in. */
  imapStarttls: boolean | null;
  imapPort: number | null;
  imapTimeout: number | null;
  imapMaxRetries: number | null;
  imapUser: string | null;
  imapPassword: string | null;
  graphAuthMethod: string | null;
  graphUser: string | null;
  graphPassword: string | null;
  graphClientId: string | null;
  graphClientSecret: string | null;
  graphCertificatePath: string | null;
  graphCertificatePassword: string | null;
  graphClientAssertion: string | null;
  graphTenantId: string | null;
  graphMailbox: string | null;
  graphAllowUnencryptedStorage: boolean;
  graphUrl: string;
  graphTokenFile: string | null;
  hec: string | null;
  hecToken: string | null;
  hecIndex: string | null;
  hecSkipCertificateVerification: boolean;
  elasticsearchHosts: string[] | null;
  elasticsearchTimeout: number | null;
  elasticsearchNumberOfShards: number | null;
  elasticsearchNumberOfReplicas: number | null;
  elasticsearchIndexSuffix: string | null;
  elasticsearchIndexPrefix: string | null;
  elasticsearchSsl: boolean;
  elasticsearchSslCertPath: string | null;
  elasticsearchSkipCertificateVerification: boolean;
  elasticsearchMonthlyIndexes: boolean;
  elasticsearchUsername: string | null;
  elasticsearchPassword: string | null;
  elasticsearchApiKey: string | null;
  elasticsearchServerless: boolean | null;
  elasticsearchUseDataStreams: boolean;
  opensearchHosts: string[] | null;
  opensearchTimeout: number | null;
  opensearchNumberOfShards: number | null;
  opensearchNumberOfReplicas: number | null;
  opensearchIndexSuffix: string | null;
  opensearchIndexPrefix: string | null;
  opensearchSsl: boolean;
  opensearchSslCertPath: string | null;
  opensearchSkipCertificateVerification: boolean;
  opensearchMonthlyIndexes: boolean;
  opensearchUsername: string | null;
  opensearchPassword: string | null;
  opensearchApiKey: string | null;
  opensearchAuthType: string;
  opensearchAwsRegion: string | null;
  opensearchAwsService: string;
  opensearchUseDataStreams: boolean;
  kafkaHosts: string[] | null;
  kafkaUsername: string | null;
  kafkaPassword: string | null;
  kafkaAggregateTopic: string | null;
  kafkaFailureTopic: string | null;
  kafkaSmtpTlsTopic: string | null;
  kafkaSsl: boolean;
  kafkaSkipCertificateVerification: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSsl: boolean;
  /** `[smtp] starttls`: `null` (unset) requires STARTTLS before logging in. */
  smtpStarttls: boolean | null;
  smtpSkipCertificateVerification: boolean;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFrom: string | null;
  smtpTo: string[] | string;
  smtpSubject: string;
  smtpAttachment: string | null;
  smtpMessage: string;
  s3Bucket: string | null;
  s3Path: string | null;
  s3RegionName: string | null;
  s3EndpointUrl: string | null;
  s3AccessKeyId: string | null;
  s3SecretAccessKey: string | null;
  /** `[s3] prevent_overwrite` (not in parsedmarc). */
  s3PreventOverwrite: boolean;
  syslogServer: string | null;
  /** A string from the configuration file, or the default `514`. */
  syslogPort: string | number | null;
  syslogProtocol: string | null;
  syslogCafilePath: string | null;
  syslogCertfilePath: string | null;
  syslogKeyfilePath: string | null;
  syslogTimeout: number | null;
  syslogRetryAttempts: number | null;
  syslogRetryDelay: number | null;
  gmailApiCredentialsFile: string | null;
  gmailApiTokenFile: string | null;
  gmailApiIncludeSpamTrash: boolean;
  gmailApiPaginateMessages: boolean;
  gmailApiScopes: string[];
  gmailApiOauth2Port: number;
  gmailApiAuthMode: string;
  gmailApiServiceAccountUser: string | null;
  maildirPath: string | null;
  maildirCreate: boolean;
  logFile: string | null;
  /**
   * The log file currently being written: what a SIGHUP reload compares the
   * new configuration's `logFile` against. `null` when no file is attached,
   * including when the configured one could not be opened.
   */
  activeLogFile: string | null;
  nProcs: number | null;
  archiveDirectory: string | null;
  ipDbPath: string | null;
  ipinfoUrl: string | null;
  ipinfoApiToken: string | null;
  alwaysUseLocalFiles: boolean;
  reverseDnsMapPath: string | null;
  reverseDnsMapUrl: string | null;
  pslOverridesPath: string | null;
  pslOverridesUrl: string | null;
  laClientId: string | null;
  laClientSecret: string | null;
  laTenantId: string | null;
  laDce: string | null;
  laDcrImmutableId: string | null;
  laDcrAggregateStream: string | null;
  laDcrFailureStream: string | null;
  laDcrSmtpTlsStream: string | null;
  gelfHost: string | null;
  /** A string from the configuration file. */
  gelfPort: string | number | null;
  gelfMode: string | null;
  /** CA bundle verifying the Graylog certificate (`mode = tls`). */
  gelfCafile: string | null;
  /** Don't verify the Graylog certificate (`mode = tls`), like pygelf. */
  gelfSkipCertificateVerification: boolean;
  webhookAggregateUrl: string | null;
  webhookFailureUrl: string | null;
  webhookSmtpTlsUrl: string | null;
  webhookTimeout: number | null;
  lokiUrl: string | null;
  lokiLabels: Record<string, string> | null;
  lokiLabelFields: string[] | null;
  lokiTimestamp: string;
  lokiUsername: string | null;
  lokiPassword: string | null;
  lokiToken: string | null;
  lokiTenantId: string | null;
  lokiSkipCertificateVerification: boolean;
  lokiTimeout: number | null;
  lokiBatchSize: number | null;
  normalizeTimespanThresholdHours: number | null;
  /** `[general] max_email_size` in bytes (0: no limit; not in parsedmarc). */
  maxEmailSize: number;
  /** `[general] max_mime_parts` (0: no limit; not in parsedmarc). */
  maxMimeParts: number;
  /** `[general] max_header_lines` (0: no limit; not in parsedmarc). */
  maxHeaderLines: number;
  /** `[general] max_expanded_email_size` (0: no limit; not in parsedmarc). */
  maxExpandedEmailSize: number;
  /** `[general] max_normalized_records` (0: no limit; not in parsedmarc). */
  maxNormalizedRecords: number;
  /** `[general] max_xml_depth` (0: no limit; not in parsedmarc). */
  maxXmlDepth: number;
  /** `[general] max_xml_nodes` (0: no limit; not in parsedmarc). */
  maxXmlNodes: number;
  /** `[general] max_smtp_tls_report_size` (0: no limit; not in parsedmarc). */
  maxSmtpTlsReportSize: number;
  /** `[general] max_lookups_per_report` (0: no limit; not in parsedmarc). */
  maxLookupsPerReport: number;
  /** `[general] max_failed_lookups_per_report` (0: no limit; not in parsedmarc). */
  maxFailedLookupsPerReport: number;
  /** `[general] max_lookup_time_per_report` in seconds (0: no limit; not in parsedmarc). */
  maxLookupTimePerReport: number;
  /** `[general] job_timeout` in seconds (0: no limit; not in parsedmarc). */
  jobTimeout: number;
  /** `[general] max_worker_heap_mb` (0: the runtime's; not in parsedmarc). */
  maxWorkerHeapMb: number;
  /** `[elasticsearch] max_indexes_per_report` (not in parsedmarc). */
  elasticsearchMaxIndexesPerReport: number | null;
  /** `[opensearch] max_indexes_per_report` (not in parsedmarc). */
  opensearchMaxIndexesPerReport: number | null;
  postgresqlHost: string | null;
  postgresqlPort: number | null;
  postgresqlUser: string | null;
  postgresqlPassword: string | null;
  postgresqlDatabase: string | null;
  postgresqlConnectionString: string | null;
  /** `[postgresql] sslmode` (not in parsedmarc). */
  postgresqlSslmode: string | null;
  /** `[postgresql] sslrootcert`: a CA file or `system` (not in parsedmarc). */
  postgresqlSslrootcert: string | null;
  /** `[postgresql] sslcert` (not in parsedmarc). */
  postgresqlSslcert: string | null;
  /** `[postgresql] sslkey` (not in parsedmarc). */
  postgresqlSslkey: string | null;
  /** `[postgresql] query_timeout` in seconds (not in parsedmarc). */
  postgresqlQueryTimeout: number | null;
  failOnOutputError: boolean;
}

/** The command-line defaults (argparse's). */
export const DEFAULT_ARGS: Readonly<CliArgs> = Object.freeze({
  filePath: [],
  configFile: null,
  recursive: false,
  stripAttachmentPayloads: false,
  output: null,
  aggregateJsonFilename: 'aggregate.json',
  failureJsonFilename: 'failure.json',
  smtpTlsJsonFilename: 'smtp_tls.json',
  aggregateCsvFilename: 'aggregate.csv',
  failureCsvFilename: 'failure.csv',
  smtpTlsCsvFilename: 'smtp_tls.csv',
  nameservers: null,
  dnsTimeout: 2.0,
  dnsRetries: 0,
  offline: false,
  silent: false,
  warnings: false,
  verbose: false,
  debug: false,
  logFile: null,
  prettifyJson: true,
});

/** The options namespace built from the command line and hardcoded defaults. */
export function createOptions(args: Partial<CliArgs> = {}): CliOptions {
  const a: CliArgs = { ...DEFAULT_ARGS, ...args };
  return {
    filePath: [...a.filePath],
    configFile: a.configFile,
    offline: a.offline,
    stripAttachmentPayloads: a.stripAttachmentPayloads,
    output: a.output,
    aggregateCsvFilename: a.aggregateCsvFilename,
    aggregateJsonFilename: a.aggregateJsonFilename,
    failureCsvFilename: a.failureCsvFilename,
    failureJsonFilename: a.failureJsonFilename,
    smtpTlsJsonFilename: a.smtpTlsJsonFilename,
    smtpTlsCsvFilename: a.smtpTlsCsvFilename,
    csvFormulaEscape: true,
    nameservers: a.nameservers === null ? null : [...a.nameservers],
    dnsTestAddress: '1.1.1.1',
    silent: a.silent,
    warnings: a.warnings,
    dnsTimeout: a.dnsTimeout,
    dnsRetries: a.dnsRetries,
    debug: a.debug,
    verbose: a.verbose,
    prettifyJson: a.prettifyJson,
    saveAggregate: false,
    saveFailure: false,
    saveSmtpTls: false,
    mailboxReportsFolder: 'INBOX',
    mailboxArchiveFolder: 'Archive',
    mailboxWatch: false,
    mailboxDelete: false,
    mailboxDeleteAggregate: null,
    mailboxDeleteFailure: null,
    mailboxDeleteSmtpTls: null,
    mailboxDeleteInvalid: null,
    mailboxTest: false,
    mailboxBatchSize: 10,
    mailboxCheckTimeout: 30,
    mailboxMaxUnsavedRetries: 2,
    mailboxSince: null,
    imapHost: null,
    imapSkipCertificateVerification: false,
    imapSsl: true,
    imapStarttls: null,
    imapPort: 993,
    imapTimeout: 30,
    imapMaxRetries: 4,
    imapUser: null,
    imapPassword: null,
    graphAuthMethod: null,
    graphUser: null,
    graphPassword: null,
    graphClientId: null,
    graphClientSecret: null,
    graphCertificatePath: null,
    graphCertificatePassword: null,
    graphClientAssertion: null,
    graphTenantId: null,
    graphMailbox: null,
    graphAllowUnencryptedStorage: false,
    graphUrl: 'https://graph.microsoft.com',
    graphTokenFile: null,
    hec: null,
    hecToken: null,
    hecIndex: null,
    hecSkipCertificateVerification: false,
    elasticsearchHosts: null,
    elasticsearchTimeout: 60,
    elasticsearchNumberOfShards: 1,
    elasticsearchNumberOfReplicas: 0,
    elasticsearchIndexSuffix: null,
    elasticsearchIndexPrefix: null,
    elasticsearchSsl: true,
    elasticsearchSslCertPath: null,
    elasticsearchSkipCertificateVerification: false,
    elasticsearchMonthlyIndexes: false,
    elasticsearchUsername: null,
    elasticsearchPassword: null,
    elasticsearchApiKey: null,
    elasticsearchServerless: false,
    elasticsearchUseDataStreams: false,
    opensearchHosts: null,
    opensearchTimeout: 60,
    opensearchNumberOfShards: 1,
    opensearchNumberOfReplicas: 0,
    opensearchIndexSuffix: null,
    opensearchIndexPrefix: null,
    opensearchSsl: true,
    opensearchSslCertPath: null,
    opensearchSkipCertificateVerification: false,
    opensearchMonthlyIndexes: false,
    opensearchUsername: null,
    opensearchPassword: null,
    opensearchApiKey: null,
    opensearchAuthType: 'basic',
    opensearchAwsRegion: null,
    opensearchAwsService: 'es',
    opensearchUseDataStreams: false,
    kafkaHosts: null,
    kafkaUsername: null,
    kafkaPassword: null,
    kafkaAggregateTopic: null,
    kafkaFailureTopic: null,
    kafkaSmtpTlsTopic: null,
    kafkaSsl: false,
    kafkaSkipCertificateVerification: false,
    smtpHost: null,
    smtpPort: 25,
    smtpSsl: false,
    smtpStarttls: null,
    smtpSkipCertificateVerification: false,
    smtpUser: null,
    smtpPassword: null,
    smtpFrom: null,
    smtpTo: [],
    smtpSubject: 'tsdmarc report',
    smtpAttachment: null,
    smtpMessage: 'Please see the attached DMARC results.',
    s3Bucket: null,
    s3Path: null,
    s3RegionName: null,
    s3EndpointUrl: null,
    s3AccessKeyId: null,
    s3SecretAccessKey: null,
    s3PreventOverwrite: false,
    syslogServer: null,
    syslogPort: null,
    syslogProtocol: null,
    syslogCafilePath: null,
    syslogCertfilePath: null,
    syslogKeyfilePath: null,
    syslogTimeout: null,
    syslogRetryAttempts: null,
    syslogRetryDelay: null,
    gmailApiCredentialsFile: null,
    gmailApiTokenFile: null,
    gmailApiIncludeSpamTrash: false,
    gmailApiPaginateMessages: true,
    gmailApiScopes: [],
    gmailApiOauth2Port: 8080,
    gmailApiAuthMode: 'installed_app',
    gmailApiServiceAccountUser: null,
    maildirPath: null,
    maildirCreate: false,
    logFile: a.logFile,
    activeLogFile: null,
    nProcs: 1,
    archiveDirectory: null,
    ipDbPath: null,
    ipinfoUrl: null,
    ipinfoApiToken: null,
    alwaysUseLocalFiles: false,
    reverseDnsMapPath: null,
    reverseDnsMapUrl: null,
    pslOverridesPath: null,
    pslOverridesUrl: null,
    laClientId: null,
    laClientSecret: null,
    laTenantId: null,
    laDce: null,
    laDcrImmutableId: null,
    laDcrAggregateStream: null,
    laDcrFailureStream: null,
    laDcrSmtpTlsStream: null,
    gelfHost: null,
    gelfPort: null,
    gelfMode: null,
    gelfCafile: null,
    gelfSkipCertificateVerification: false,
    webhookAggregateUrl: null,
    webhookFailureUrl: null,
    webhookSmtpTlsUrl: null,
    webhookTimeout: 60,
    lokiUrl: null,
    lokiLabels: null,
    lokiLabelFields: null,
    lokiTimestamp: 'ingest',
    lokiUsername: null,
    lokiPassword: null,
    lokiToken: null,
    lokiTenantId: null,
    lokiSkipCertificateVerification: false,
    lokiTimeout: 60,
    lokiBatchSize: 1000,
    normalizeTimespanThresholdHours: 24.0,
    maxEmailSize: DEFAULT_MAX_EMAIL_SIZE,
    maxMimeParts: DEFAULT_MAX_MIME_PARTS,
    maxHeaderLines: DEFAULT_MAX_HEADER_LINES,
    maxExpandedEmailSize: DEFAULT_MAX_EXPANDED_EMAIL_SIZE,
    maxNormalizedRecords: DEFAULT_MAX_NORMALIZED_RECORDS,
    maxXmlDepth: DEFAULT_MAX_XML_DEPTH,
    maxXmlNodes: DEFAULT_MAX_XML_NODES,
    maxSmtpTlsReportSize: DEFAULT_MAX_SMTP_TLS_REPORT_SIZE,
    maxLookupsPerReport: DEFAULT_MAX_LOOKUPS_PER_REPORT,
    maxFailedLookupsPerReport: DEFAULT_MAX_FAILED_LOOKUPS_PER_REPORT,
    maxLookupTimePerReport: DEFAULT_MAX_LOOKUP_TIME_PER_REPORT,
    jobTimeout: DEFAULT_JOB_TIMEOUT,
    maxWorkerHeapMb: DEFAULT_MAX_WORKER_HEAP_MB,
    elasticsearchMaxIndexesPerReport: null,
    opensearchMaxIndexesPerReport: null,
    postgresqlHost: null,
    postgresqlPort: 5432,
    postgresqlUser: null,
    postgresqlPassword: null,
    postgresqlDatabase: null,
    postgresqlConnectionString: null,
    postgresqlSslmode: null,
    postgresqlSslrootcert: null,
    postgresqlSslcert: null,
    postgresqlSslkey: null,
    postgresqlQueryTimeout: null,
    failOnOutputError: false,
  };
}

/** A shallow copy (Python's `Namespace(**vars(opts))`). */
export function copyOptions(opts: CliOptions): CliOptions {
  return {
    ...opts,
    filePath: [...opts.filePath],
    nameservers: opts.nameservers === null ? null : [...opts.nameservers],
  };
}
