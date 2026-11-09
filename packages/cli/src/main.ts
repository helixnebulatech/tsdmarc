// The `tsdmarc` command (parsedmarc's `cli._main`).

import { performance } from 'node:perf_hooks';

import { GmailConnection } from '@tsdmarc/gmail';
import { IMAPConnection } from '@tsdmarc/imap';
import { emailResultsViaMsgraph, MSGraphConnection } from '@tsdmarc/msgraph';
import { emailResults } from '@tsdmarc/smtp';
import {
  aggregateReportKey,
  type AggregateReport,
  configureIpinfoApi,
  type FailureReport,
  FileHandler,
  FolderExistsError,
  getDmarcReportsFromMbox,
  findEnrichmentError,
  getReportZip,
  InvalidIPinfoAPIKey,
  isMbox,
  loadIpDb,
  loadPslOverrides,
  loadReverseDnsMap,
  logger,
  type MailboxConnection,
  MaildirConnection,
  type ParsedReport,
  ParserError,
  type ParsingResults,
  pyStr,
  REVERSE_DNS_MAP,
  type ReverseDNSMap,
  sanitizeForLog,
  SEEN_AGGREGATE_REPORT_IDS,
  type SMTPTLSReport,
} from 'tsdmarc';

import { archiveProcessedFile } from './archive';
import { parseArgs } from './args';
import { loadConfig, parseConfig, strToList } from './config';
import {
  getDmarcReportsFromMailbox,
  parseReportFiles,
  watchInbox,
} from './core';
import { configFileFromEnv, hasEnvConfig } from './env';
import { ConfigurationError, SystemExit } from './errors';
import {
  addConsoleHandler,
  applyLogLevel,
  configureDependencyLogging,
  createLogFileHandler,
} from './logging';
import { isGraphError, logMsgraphFailure } from './msgraph-errors';
import { copyOptions, createOptions } from './options';
import {
  buildParserConfig,
  closeOutputClients,
  initOutputClients,
  type OutputClients,
  restoreSearchAliases,
  restoreUtilsGlobals,
  searchAliasSnapshot,
  utilsGlobalsSnapshot,
} from './outputs';
import { expandFilePathArgs, excludeArchivedPaths } from './paths';
import {
  filterSmtpTlsReportsForIndexPrefix,
  processReports,
  type RunState,
} from './process-reports';
import { ProgressBar } from './progress';

const OUTPUT_CLIENT_MAX_RETRIES = 4;
const OUTPUT_CLIENT_RETRY_DELAY = 5;
const MS_PER_SECOND = 1000;

/** Hooks for tests: the delay between output client attempts. */
export const cliTimers: { sleep: (seconds: number) => Promise<void> } = {
  async sleep(seconds: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, seconds * MS_PER_SECOND));
  },
};

/** Hooks for tests: whether stderr is a terminal (for the progress bar). */
export const cliTerminal: { isStderrTty: () => boolean } = {
  isStderrTty: (): boolean => Boolean(process.stderr.isTTY),
};

/** Hooks for tests: the hard exit of a second SIGINT (`os._exit(130)`). */
export const cliProcess: { hardExit: (code: number) => never } = {
  hardExit: (code: number): never => process.exit(code),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileExistsError(error: unknown): boolean {
  return (
    error instanceof FolderExistsError ||
    (error instanceof Error && 'code' in error && error.code === 'EEXIST') ||
    (error instanceof Error && error.name === 'FileExistsError')
  );
}

function exit(code: number): never {
  throw new SystemExit(code);
}

interface SignalState {
  reloadRequested: boolean;
  shutdownRequested: boolean;
  sigintCount: number;
  /** Aborts the running watch so it returns promptly on a signal. */
  watchAbort: AbortController | null;
}

/**
 * Signal handlers only set flags polled at safe checkpoints. SIGINT is a
 * double tap: the first press is graceful, the second exits with 130.
 */
function installSignalHandlers(signals: SignalState): () => void {
  const onSighup = (): void => {
    signals.reloadRequested = true;
    signals.watchAbort?.abort();
  };
  const onSigterm = (): void => {
    signals.shutdownRequested = true;
    signals.watchAbort?.abort();
  };
  const onSigint = (): void => {
    signals.sigintCount += 1;
    if (signals.sigintCount >= 2) {
      cliProcess.hardExit(130);
    }
    signals.shutdownRequested = true;
    signals.watchAbort?.abort();
  };
  const hasSighup = process.platform !== 'win32';
  if (hasSighup) {
    process.on('SIGHUP', onSighup);
  }
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  return () => {
    if (hasSighup) {
      process.off('SIGHUP', onSighup);
    }
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
  };
}

async function closeConnections(
  connections: MailboxConnection[],
): Promise<void> {
  for (const connection of connections) {
    try {
      await connection.close();
    } catch (error) {
      logger.debug(
        `Error closing the mailbox connection: ${errorMessage(error)}`,
      );
    }
  }
}

/**
 * Run the `tsdmarc` command with `argv` (without the executable and script).
 * Where parsedmarc calls `sys.exit()`, throws {@link SystemExit}; other
 * errors propagate like Python's uncaught exceptions.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  addConsoleHandler();
  const args = parseArgs(argv);

  const aggregateReports: AggregateReport[] = [];
  const failureReports: FailureReport[] = [];
  const smtpTlsReports: SMTPTLSReport[] = [];

  const opts = createOptions(args);
  // Options from the command line and defaults, before any configuration
  // file: each SIGHUP reload starts again from here, so sections removed
  // from the file take effect.
  const optsFromCli = copyOptions(opts);

  const state: RunState = {
    opts,
    clients: new Map(),
    indexPrefixDomainMap: null,
  };

  const configFile = args.configFile ?? configFileFromEnv();
  if (configFile || hasEnvConfig()) {
    try {
      const config = loadConfig(configFile);
      state.indexPrefixDomainMap = await parseConfig(config, opts);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) {
        throw error;
      }
      logger.critical(error.message);
      exit(-1);
    }
  }

  applyLogLevel(opts);
  opts.activeLogFile = null;
  if (opts.logFile) {
    try {
      logger.addHandler(createLogFileHandler(opts.logFile));
      opts.activeLogFile = opts.logFile;
    } catch (error) {
      logger.warning(`Unable to write to log file: ${errorMessage(error)}`);
    }
  }
  configureDependencyLogging(logger.level);

  if (
    opts.imapHost === null &&
    opts.graphClientId === null &&
    opts.gmailApiCredentialsFile === null &&
    opts.maildirPath === null &&
    opts.filePath.length === 0
  ) {
    logger.error('You must supply input files or a mailbox connection');
    exit(1);
  }

  logger.info('Starting tsdmarc');

  await loadIpDb({
    alwaysUseLocalFile: opts.alwaysUseLocalFiles,
    localFilePath: opts.ipDbPath,
    url: opts.ipinfoUrl,
    offline: opts.offline,
  });

  if (opts.ipinfoApiToken && !opts.offline) {
    try {
      await configureIpinfoApi(opts.ipinfoApiToken);
    } catch (error) {
      if (!(error instanceof InvalidIPinfoAPIKey)) {
        throw error;
      }
      logger.critical(error.message);
      exit(1);
    }
  }

  await loadPslOverrides({
    alwaysUseLocalFile: opts.alwaysUseLocalFiles,
    localFilePath: opts.pslOverridesPath,
    url: opts.pslOverridesUrl,
    offline: opts.offline,
  });

  // Output clients, with retries for transient connection errors.
  let retryDelay = OUTPUT_CLIENT_RETRY_DELAY;
  for (let attempt = 0; attempt <= OUTPUT_CLIENT_MAX_RETRIES; attempt += 1) {
    try {
      state.clients = await initOutputClients(opts, state.indexPrefixDomainMap);
      break;
    } catch (error) {
      if (error instanceof ConfigurationError) {
        logger.critical(error.message);
        exit(1);
      }
      if (attempt < OUTPUT_CLIENT_MAX_RETRIES) {
        logger.warning(
          `Output client error (attempt ${attempt + 1}/${OUTPUT_CLIENT_MAX_RETRIES + 1}, ` +
            `retrying in ${retryDelay}s): ${errorMessage(error)}`,
        );
        await cliTimers.sleep(retryDelay);
        retryDelay *= 2;
      } else {
        logger.error(`Output client error: ${errorMessage(error)}`);
        exit(1);
      }
    }
  }

  const signals: SignalState = {
    reloadRequested: false,
    shutdownRequested: false,
    sigintCount: 0,
    watchAbort: null,
  };
  const removeSignalHandlers = installSignalHandlers(signals);
  const connections: MailboxConnection[] = [];
  try {
    await runWithClients({
      args,
      opts,
      optsFromCli,
      state,
      signals,
      configFile,
      connections,
      aggregateReports,
      failureReports,
      smtpTlsReports,
      filesToArchive: [],
      gmailScopes: null,
    });
  } finally {
    // Python closes these at exit (atexit) on every path but a hard exit.
    await closeOutputClients(state.clients);
    await closeConnections(connections);
    removeSignalHandlers();
  }
}

interface RunContext {
  args: ReturnType<typeof parseArgs>;
  opts: ReturnType<typeof createOptions>;
  optsFromCli: ReturnType<typeof createOptions>;
  state: RunState;
  signals: SignalState;
  configFile: string | null;
  connections: MailboxConnection[];
  aggregateReports: AggregateReport[];
  failureReports: FailureReport[];
  smtpTlsReports: SMTPTLSReport[];
  /** Parsed input files waiting for their reports to be saved. */
  filesToArchive: [string, ParsedReport][];
  /**
   * The scopes of the running Gmail connection: a reload keeps it, and so
   * its token, whatever the reloaded file says.
   */
  gmailScopes: readonly string[] | null;
}

async function parseInputFiles(context: RunContext): Promise<void> {
  const { args, opts, signals } = context;
  let filePaths = expandFilePathArgs(args.filePath, args.recursive);
  if (opts.archiveDirectory) {
    filePaths = excludeArchivedPaths(filePaths, opts.archiveDirectory);
  }
  const mboxPaths: string[] = [];
  for (const filePath of filePaths) {
    if (await isMbox(filePath)) {
      mboxPaths.push(filePath);
    }
  }
  filePaths = [...new Set(filePaths)];
  const uniqueMboxPaths = [...new Set(mboxPaths)];
  filePaths = filePaths.filter(filePath => !uniqueMboxPaths.includes(filePath));

  let progressBar: ProgressBar | null = null;
  if (cliTerminal.isStderrTty() && filePaths.length > 0) {
    progressBar = new ProgressBar(filePaths.length);
  }

  const nProcs = Math.max(Math.trunc(opts.nProcs || 1), 1);
  const parserConfig = buildParserConfig(opts);

  for await (const [filePath, result] of parseReportFiles(filePaths, {
    config: parserConfig,
    nProcs,
    shouldStop: () => signals.shutdownRequested,
  })) {
    progressBar?.update(1);
    const enrichmentError = findEnrichmentError(result);
    if (enrichmentError !== null) {
      // Not the file's fault (an unusable IP database, a revoked IPinfo
      // token): every file would fail the same way. Stop before any file
      // is archived as invalid or its reports saved without enrichment.
      progressBar?.close();
      logger.critical(
        `Failed to parse ${sanitizeForLog(filePath)} - ${sanitizeForLog(enrichmentError.message)}`,
      );
      exit(1);
    }
    if (result instanceof Error) {
      logger.error(
        `Failed to parse ${sanitizeForLog(filePath)} - ${sanitizeForLog(result.message)}`,
      );
    } else if (result.reportType === 'aggregate') {
      const reportOrg = result.report.reportMetadata.orgName;
      const reportId = result.report.reportMetadata.reportId;
      const reportKey = aggregateReportKey(result.report);
      if (SEEN_AGGREGATE_REPORT_IDS.has(reportKey)) {
        logger.debug(
          `Skipping duplicate aggregate report from ${sanitizeForLog(pyStr(reportOrg))} with ID: ${sanitizeForLog(pyStr(reportId))}`,
        );
      } else {
        SEEN_AGGREGATE_REPORT_IDS.set(reportKey, true);
        context.aggregateReports.push(result.report);
      }
    } else if (result.reportType === 'failure') {
      context.failureReports.push(result.report);
    } else if (result.reportType === 'smtp_tls') {
      context.smtpTlsReports.push(result.report);
    }
    if (opts.archiveDirectory) {
      if (result instanceof Error) {
        archiveProcessedFile(filePath, opts.archiveDirectory, result);
      } else {
        // Moved once its reports are saved: an archived file is not read again.
        context.filesToArchive.push([filePath, result]);
      }
    }
  }

  progressBar?.close();

  if (signals.shutdownRequested) {
    // Reports parsed so far still go through processReports() below.
    logger.info('Shutdown requested, stopping file processing early');
  }

  for (const mboxPath of uniqueMboxPaths) {
    if (signals.shutdownRequested) {
      logger.info('Shutdown requested, skipping remaining mbox files');
      break;
    }
    const reports = await getDmarcReportsFromMbox(mboxPath, {
      config: parserConfig,
      nProcs,
    });
    appendReports(context, reports);
  }
}

/** One by one: a spread can't take a mbox's worth of reports as arguments. */
function appendReports(context: RunContext, reports: ParsingResults): void {
  for (const report of reports.aggregateReports) {
    context.aggregateReports.push(report);
  }
  for (const report of reports.failureReports) {
    context.failureReports.push(report);
  }
  for (const report of reports.smtpTlsReports) {
    context.smtpTlsReports.push(report);
  }
}

/** Archive the parsed files, unless an output didn't get their reports. */
function archiveSavedFiles(context: RunContext, outputErrors: string[]): void {
  const { opts, filesToArchive } = context;
  if (!opts.archiveDirectory || filesToArchive.length === 0) {
    return;
  }
  if (outputErrors.length > 0) {
    logger.warning(
      `Leaving ${filesToArchive.length} parsed files in place: their reports were not saved to every output`,
    );
    return;
  }
  for (const [filePath, result] of filesToArchive) {
    archiveProcessedFile(filePath, opts.archiveDirectory, result);
  }
}

interface MailboxSetup {
  mailboxConnection: MailboxConnection | null;
  msgraphConnection: MSGraphConnection | null;
}

function graphContext(
  opts: RunContext['opts'],
  stage: string,
): Parameters<typeof logMsgraphFailure>[1] {
  return {
    stage,
    mailbox: opts.graphMailbox || opts.graphUser,
    tenantId: opts.graphTenantId,
    authMethod: opts.graphAuthMethod,
  };
}

/**
 * Any effective delete flag needs the deletion scope; the per-type flags
 * inherit mailboxDelete when unset. Without the scope every flag is turned
 * off.
 */
function disableDeletionWithoutGmailScope(
  opts: RunContext['opts'],
  scopes: readonly string[],
): void {
  const perTypeDelete = [
    opts.mailboxDeleteAggregate,
    opts.mailboxDeleteFailure,
    opts.mailboxDeleteSmtpTls,
    opts.mailboxDeleteInvalid,
  ];
  if (
    !perTypeDelete.some(value =>
      value === null ? opts.mailboxDelete : value,
    ) ||
    scopes.includes('https://mail.google.com/')
  ) {
    return;
  }
  logger.error(
    "Message deletion requires scope 'https://mail.google.com/'. " +
      'Add the scope and remove token file ' +
      'to acquire proper access.',
  );
  opts.mailboxDelete = false;
  opts.mailboxDeleteAggregate = false;
  opts.mailboxDeleteFailure = false;
  opts.mailboxDeleteSmtpTls = false;
  opts.mailboxDeleteInvalid = false;
}

async function connectMailboxes(context: RunContext): Promise<MailboxSetup> {
  const { opts, connections } = context;
  let mailboxConnection: MailboxConnection | null = null;
  let msgraphConnection: MSGraphConnection | null = null;

  if (opts.imapHost) {
    try {
      if (opts.imapUser === null || opts.imapPassword === null) {
        logger.error(
          'IMAP user and password must be specified if host is specified',
        );
        exit(1);
      }
      let verify = true;
      if (opts.imapSkipCertificateVerification) {
        logger.debug('Skipping IMAP certificate verification');
        verify = false;
      }
      mailboxConnection = await IMAPConnection.connect(
        opts.imapHost,
        opts.imapUser,
        {
          port: opts.imapPort ?? 993,
          ssl: opts.imapSsl,
          starttls: opts.imapStarttls,
          verify,
          timeout: opts.imapTimeout ?? 30,
          maxRetries: opts.imapMaxRetries ?? 4,
          password: opts.imapPassword,
        },
      );
      connections.push(mailboxConnection);
    } catch (error) {
      if (error instanceof SystemExit) {
        throw error;
      }
      logger.exception('IMAP Error', error);
      exit(1);
    }
  }

  if (opts.graphClientId) {
    try {
      const mailbox = opts.graphMailbox || opts.graphUser;
      // Redacted summary, before any network I/O; secrets are never logged.
      logger.info(
        `Connecting to Microsoft Graph (auth_method=${opts.graphAuthMethod ?? 'None'}, ` +
          `tenant_id=${opts.graphTenantId ?? 'None'}, client_id=${opts.graphClientId}, ` +
          `mailbox=${mailbox ?? 'None'}, graph_url=${opts.graphUrl})`,
      );
      const isSet = (value: string | null): string =>
        value ? 'set' : 'not set';
      logger.debug(
        `Microsoft Graph auth details: username=${opts.graphUser ?? 'None'}, ` +
          `certificate_path=${opts.graphCertificatePath ?? 'None'}, ` +
          `certificate_password ${isSet(opts.graphCertificatePassword)}, ` +
          `client_secret ${isSet(opts.graphClientSecret)}, password ${isSet(opts.graphPassword)}, ` +
          `client_assertion ${isSet(opts.graphClientAssertion)}, ` +
          `token_file=${opts.graphTokenFile ?? 'None'}, ` +
          `allow_unencrypted_storage=${opts.graphAllowUnencryptedStorage ? 'True' : 'False'}`,
      );
      const connectStart = performance.now();
      msgraphConnection = await MSGraphConnection.connect({
        authMethod: opts.graphAuthMethod ?? 'UsernamePassword',
        mailbox: mailbox ?? '',
        tenantId: opts.graphTenantId ?? '',
        clientId: opts.graphClientId,
        clientSecret: opts.graphClientSecret,
        certificatePath: opts.graphCertificatePath,
        certificatePassword: opts.graphCertificatePassword,
        clientAssertion: opts.graphClientAssertion,
        username: opts.graphUser,
        password: opts.graphPassword,
        tokenFile: opts.graphTokenFile ?? '.token',
        allowUnencryptedStorage: opts.graphAllowUnencryptedStorage,
        graphUrl: opts.graphUrl,
        tokenCacheName: 'parsedmarc',
      });
      connections.push(msgraphConnection);
      // App-only methods get their first token on the first mailbox call,
      // so failures can still surface later.
      logger.info(
        `Microsoft Graph connection initialized in ${((performance.now() - connectStart) / MS_PER_SECOND).toFixed(2)} seconds`,
      );
      mailboxConnection = msgraphConnection;
    } catch (error) {
      if (isGraphError(error)) {
        logMsgraphFailure(error, graphContext(opts, 'connection'));
        exit(1);
      }
      logger.exception('MS Graph Error', error);
      exit(1);
    }
  }

  if (opts.gmailApiCredentialsFile) {
    disableDeletionWithoutGmailScope(opts, opts.gmailApiScopes);
    context.gmailScopes = opts.gmailApiScopes;
    try {
      mailboxConnection = await GmailConnection.connect({
        credentialsFile: opts.gmailApiCredentialsFile,
        tokenFile: opts.gmailApiTokenFile ?? '.token',
        scopes: opts.gmailApiScopes,
        includeSpamTrash: opts.gmailApiIncludeSpamTrash,
        paginateMessages: opts.gmailApiPaginateMessages,
        reportsFolder: opts.mailboxReportsFolder,
        oauth2Port: opts.gmailApiOauth2Port,
        authMode: opts.gmailApiAuthMode,
        serviceAccountUser: opts.gmailApiServiceAccountUser,
      });
      connections.push(mailboxConnection);
    } catch (error) {
      logger.exception('Gmail API Error', error);
      exit(1);
    }
  }

  if (opts.maildirPath) {
    try {
      mailboxConnection = new MaildirConnection(opts.maildirPath, {
        maildirCreate: opts.maildirCreate,
      });
      connections.push(mailboxConnection);
    } catch (error) {
      logger.exception('Maildir Error', error);
      exit(1);
    }
  }

  return { mailboxConnection, msgraphConnection };
}

function intOr(value: number | null, fallback: number): number {
  return value === null ? fallback : Math.trunc(value);
}

/** The steps after the output clients exist (inside their teardown). */
async function runWithClients(context: RunContext): Promise<void> {
  const { opts, optsFromCli, state, signals, configFile } = context;

  await parseInputFiles(context);

  // The file/mbox reports, before any mailbox batch is added: mailbox
  // batches are saved by the save callback as they are fetched, so the
  // final processReports() call must only see these.
  const fileParsingResults: ParsingResults = {
    aggregateReports: [...context.aggregateReports],
    failureReports: [...context.failureReports],
    smtpTlsReports: [...context.smtpTlsReports],
  };

  const { mailboxConnection, msgraphConnection } =
    await connectMailboxes(context);
  let parserConfig = buildParserConfig(opts);
  const nProcs = Math.max(Math.trunc(opts.nProcs || 1), 1);
  let mailboxBatchSize = 10;
  let mailboxCheckTimeout = 30;
  let mailboxMaxUnsavedRetries = 2;
  if (mailboxConnection) {
    mailboxBatchSize = intOr(opts.mailboxBatchSize, 10);
    mailboxCheckTimeout = intOr(opts.mailboxCheckTimeout, 30);
    mailboxMaxUnsavedRetries = intOr(opts.mailboxMaxUnsavedRetries, 2);
  }

  /**
   * Save one mailbox batch and report whether it landed: `false` when an
   * output destination failed keeps the batch's messages in the mailbox to
   * be retried. With `fail_on_output_error` it throws instead.
   */
  const mailboxSaveCallback = async (batch: ParsingResults): Promise<boolean> =>
    (await processReports(state, batch)).length === 0;

  if (mailboxConnection && !signals.shutdownRequested) {
    try {
      const reports = await getDmarcReportsFromMailbox(mailboxConnection, {
        delete: opts.mailboxDelete,
        deleteAggregate: opts.mailboxDeleteAggregate,
        deleteFailure: opts.mailboxDeleteFailure,
        deleteSmtpTls: opts.mailboxDeleteSmtpTls,
        deleteInvalid: opts.mailboxDeleteInvalid,
        batchSize: mailboxBatchSize,
        reportsFolder: opts.mailboxReportsFolder,
        archiveFolder: opts.mailboxArchiveFolder,
        test: opts.mailboxTest,
        since: opts.mailboxSince,
        config: parserConfig,
        nProcs,
        saveCallback: mailboxSaveCallback,
        maxUnsavedRetries: mailboxMaxUnsavedRetries,
      });
      appendReports(context, reports);
    } catch (error) {
      if (error instanceof SystemExit) {
        throw error;
      }
      if (error instanceof ParserError) {
        // fail_on_output_error: the batch's messages stay in the mailbox.
        logger.error(sanitizeForLog(error.message));
        exit(1);
      }
      if (isGraphError(error) && msgraphConnection !== null) {
        logMsgraphFailure(error, graphContext(opts, 'mailbox fetch'));
        exit(1);
      }
      logger.exception('Mailbox Error', error);
      exit(1);
    }
  }

  // Filtered here: processReports() filtered the file snapshot and the
  // mailbox batches, not this combined list that feeds the summary email.
  const parsingResults: ParsingResults = {
    aggregateReports: context.aggregateReports,
    failureReports: context.failureReports,
    smtpTlsReports: filterSmtpTlsReportsForIndexPrefix(
      context.smtpTlsReports,
      state.indexPrefixDomainMap,
    ),
  };

  const fileResultsNonempty =
    fileParsingResults.aggregateReports.length > 0 ||
    fileParsingResults.failureReports.length > 0 ||
    fileParsingResults.smtpTlsReports.length > 0;
  // Mailbox reports were already saved by the callback; with a mailbox and
  // nothing from files, skip the call so no second, empty JSON is printed.
  let outputErrors: string[] = [];
  if (fileResultsNonempty || !mailboxConnection) {
    try {
      outputErrors = await processReports(state, fileParsingResults);
    } catch (error) {
      if (!(error instanceof ParserError)) {
        throw error;
      }
      logger.error(sanitizeForLog(error.message));
      exit(1);
    }
  }
  archiveSavedFiles(context, outputErrors);

  await emailParsingResults(opts, parsingResults, msgraphConnection);

  if (mailboxConnection && opts.mailboxWatch) {
    logger.info('Watching for email - Ctrl-C once to quit, twice to force');

    for (;;) {
      // A reload may have disabled watch mode.
      if (!opts.mailboxWatch) {
        logger.info(
          'Mailbox watch disabled in reloaded configuration, stopping watcher',
        );
        break;
      }
      // Aborted by SIGHUP/SIGTERM/SIGINT so a waiting watch (IMAP IDLE, the
      // sleep between checks) returns without waiting out checkTimeout.
      const watchAbort = new AbortController();
      signals.watchAbort = watchAbort;
      try {
        // configReloading is true on SIGHUP (reload) or SIGTERM/SIGINT
        // (shutdown); the backend returns at a safe boundary.
        await watchInbox({
          mailboxConnection,
          callback: mailboxSaveCallback,
          reportsFolder: opts.mailboxReportsFolder,
          archiveFolder: opts.mailboxArchiveFolder,
          delete: opts.mailboxDelete,
          deleteAggregate: opts.mailboxDeleteAggregate,
          deleteFailure: opts.mailboxDeleteFailure,
          deleteSmtpTls: opts.mailboxDeleteSmtpTls,
          deleteInvalid: opts.mailboxDeleteInvalid,
          test: opts.mailboxTest,
          checkTimeout: mailboxCheckTimeout,
          batchSize: mailboxBatchSize,
          since: opts.mailboxSince,
          config: parserConfig,
          configReloading: () =>
            signals.reloadRequested || signals.shutdownRequested,
          nProcs,
          maxUnsavedRetries: mailboxMaxUnsavedRetries,
          signal: watchAbort.signal,
        });
      } catch (error) {
        if (isFileExistsError(error) || error instanceof ParserError) {
          logger.error(sanitizeForLog(errorMessage(error)));
          exit(1);
        }
        if (isGraphError(error)) {
          if (msgraphConnection === null) {
            logger.exception('Mailbox Error', error);
          } else {
            logMsgraphFailure(error, graphContext(opts, 'mailbox watch'));
          }
          exit(1);
        }
        throw error;
      } finally {
        signals.watchAbort = null;
      }

      // Shutdown wins over a reload when both were requested.
      if (signals.shutdownRequested) {
        logger.info('Shutdown requested, exiting watch loop');
        break;
      }
      if (!signals.reloadRequested) {
        break;
      }

      logger.info('SIGHUP received, config will reload after current batch');
      // Cleared before reloading, so a SIGHUP arriving meanwhile is kept
      // for the next iteration.
      signals.reloadRequested = false;
      logger.info('Reloading configuration...');
      const reloaded = await reloadConfiguration({
        opts,
        optsFromCli,
        state,
        configFile,
        gmailScopes: context.gmailScopes,
      });
      if (reloaded !== null) {
        parserConfig = reloaded.parserConfig;
        mailboxBatchSize = reloaded.batchSize;
        mailboxCheckTimeout = reloaded.checkTimeout;
        mailboxMaxUnsavedRetries = reloaded.maxUnsavedRetries;
      }
    }
  }
}

async function emailParsingResults(
  opts: RunContext['opts'],
  parsingResults: ParsingResults,
  msgraphConnection: MSGraphConnection | null,
): Promise<void> {
  const smtpTo = Array.isArray(opts.smtpTo)
    ? [...opts.smtpTo]
    : strToList(String(opts.smtpTo));
  const hasReports =
    parsingResults.aggregateReports.length > 0 ||
    parsingResults.failureReports.length > 0 ||
    parsingResults.smtpTlsReports.length > 0;
  const graphRecipients = msgraphConnection !== null && smtpTo.length > 0;
  if (!hasReports && (opts.smtpHost || graphRecipients)) {
    logger.info('No reports were parsed; skipping the results email');
  } else if (opts.smtpHost) {
    try {
      await emailResults(
        parsingResults,
        opts.smtpHost,
        opts.smtpFrom ?? '',
        smtpTo,
        {
          port: opts.smtpPort ?? 25,
          verify: !opts.smtpSkipCertificateVerification,
          username: opts.smtpUser,
          password: opts.smtpPassword,
          subject: opts.smtpSubject,
          requireEncryption: opts.smtpSsl,
          starttls: opts.smtpStarttls,
          attachmentFilename: opts.smtpAttachment,
          message: opts.smtpMessage,
          reportZip: results =>
            getReportZip(results, {
              csvFormulaEscape: opts.csvFormulaEscape,
            }),
        },
      );
    } catch (error) {
      logger.exception('Failed to email results', error);
      exit(1);
    }
  } else if (msgraphConnection !== null && smtpTo.length > 0) {
    try {
      await emailResultsViaMsgraph(parsingResults, msgraphConnection, smtpTo, {
        subject: opts.smtpSubject,
        attachmentFilename: opts.smtpAttachment,
        message: opts.smtpMessage,
        reportZip: results =>
          getReportZip(results, { csvFormulaEscape: opts.csvFormulaEscape }),
      });
    } catch (error) {
      if (isGraphError(error)) {
        logMsgraphFailure(error, graphContext(opts, 'message send'));
        exit(1);
      }
      logger.exception('Failed to email results via Microsoft Graph', error);
      exit(1);
    }
  }
}

interface ReloadInput {
  opts: RunContext['opts'];
  optsFromCli: RunContext['opts'];
  state: RunState;
  configFile: string | null;
  gmailScopes: readonly string[] | null;
}

interface Reloaded {
  parserConfig: ReturnType<typeof buildParserConfig>;
  batchSize: number;
  checkTimeout: number;
  maxUnsavedRetries: number;
}

/**
 * Reload the configuration in three phases: stage every fallible step off
 * to the side (rolled back on failure, keeping the running configuration),
 * commit with assignments only, then close the replaced clients. Returns
 * the new watch parameters, or `null` when the reload failed.
 */
async function reloadConfiguration(
  input: ReloadInput,
): Promise<Reloaded | null> {
  const { opts, optsFromCli, state, configFile, gmailScopes } = input;
  // Taken before the try: the rollback needs them, and neither can fail.
  const previousSearchState = searchAliasSnapshot();
  const previousUtilsState = utilsGlobalsSnapshot();
  let newClients: OutputClients = new Map();
  let stagedLogHandler: FileHandler | null = null;

  let newOpts: RunContext['opts'];
  let newIndexPrefixDomainMap: RunState['indexPrefixDomainMap'];
  let reloaded: Reloaded;
  let stagedReverseDnsMap: ReverseDNSMap;
  const oldLogFile = opts.activeLogFile;
  let newLogFile: string | null;
  try {
    // Phase 1: nothing the running configuration reads is written here.
    newOpts = copyOptions(optsFromCli);
    const newConfig = loadConfig(configFile);
    newIndexPrefixDomainMap = await parseConfig(newConfig, newOpts);
    if (gmailScopes !== null) {
      disableDeletionWithoutGmailScope(newOpts, gmailScopes);
    }
    newClients = await initOutputClients(newOpts, newIndexPrefixDomainMap);

    reloaded = {
      parserConfig: buildParserConfig(newOpts),
      batchSize: intOr(newOpts.mailboxBatchSize, 10),
      checkTimeout: intOr(newOpts.mailboxCheckTimeout, 30),
      maxUnsavedRetries: intOr(newOpts.mailboxMaxUnsavedRetries, 2),
    };

    // Open the replacement log file now, so the commit has nothing
    // fallible left to do. An unwritable log file fails the reload (at
    // startup it is only a warning: there is no previous configuration).
    newLogFile = newOpts.logFile;
    if (oldLogFile !== newLogFile && newLogFile) {
      stagedLogHandler = createLogFileHandler(newLogFile);
    }

    // Into a fresh map: loadReverseDnsMap() clears the map it is given
    // before reading, so loading into the live one could leave it empty.
    stagedReverseDnsMap = new Map();
    await loadReverseDnsMap(stagedReverseDnsMap, {
      alwaysUseLocalFile: newOpts.alwaysUseLocalFiles,
      localFilePath: newOpts.reverseDnsMapPath,
      url: newOpts.reverseDnsMapUrl,
      offline: newOpts.offline,
      pslOverridesPath: newOpts.pslOverridesPath,
      pslOverridesUrl: newOpts.pslOverridesUrl,
    });

    // Rewrites the shared cache file on a successful download, which no
    // snapshot can undo; last but one for that reason.
    await loadIpDb({
      alwaysUseLocalFile: newOpts.alwaysUseLocalFiles,
      localFilePath: newOpts.ipDbPath,
      url: newOpts.ipinfoUrl,
      offline: newOpts.offline,
    });

    // Last: an invalid token is fatal even on reload.
    try {
      await configureIpinfoApi(newOpts.offline ? null : newOpts.ipinfoApiToken);
    } catch (error) {
      if (error instanceof InvalidIPinfoAPIKey) {
        logger.critical(error.message);
        exit(1);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof SystemExit) {
      // The process is leaving; nothing is rolled back.
      throw error;
    }
    // Rollback: close what was built before restoring the `default`
    // connections (a built handle releases its connection as it closes).
    await closeOutputClients(newClients);
    if (stagedLogHandler !== null) {
      try {
        stagedLogHandler.close();
      } catch (closeError) {
        logger.warning(
          `Unable to close the log file opened for the reload: ${errorMessage(closeError)}`,
        );
      }
    }
    await restoreSearchAliases(previousSearchState);
    restoreUtilsGlobals(previousUtilsState);
    logger.exception(
      'Config reload failed, continuing with previous config',
      error,
    );
    return null;
  }

  // Phase 2: commit. Nothing below may throw.
  REVERSE_DNS_MAP.clear();
  for (const [key, value] of stagedReverseDnsMap) {
    REVERSE_DNS_MAP.set(key, value);
  }
  const { activeLogFile } = opts;
  Object.assign(opts, newOpts);
  opts.activeLogFile = activeLogFile;
  const oldClients = state.clients;
  state.clients = newClients;
  state.indexPrefixDomainMap = newIndexPrefixDomainMap;

  applyLogLevel(opts);
  if (oldLogFile !== newLogFile) {
    for (const handler of [...logger.handlers]) {
      if (handler instanceof FileHandler) {
        let closeError: unknown = null;
        try {
          handler.close();
        } catch (error) {
          // The new configuration is live: a failing close must not undo it.
          closeError = error;
        }
        // Detach first: the failing handler can't log its own failure.
        logger.removeHandler(handler);
        if (closeError !== null) {
          logger.warning(
            `Unable to close the log file: ${errorMessage(closeError)}`,
          );
        }
      }
    }
    if (stagedLogHandler !== null) {
      logger.addHandler(stagedLogHandler);
    }
    opts.activeLogFile = newLogFile;
  }
  configureDependencyLogging(logger.level);

  // Phase 3: the replaced clients can go (errors are logged, not thrown).
  await closeOutputClients(oldClients);
  logger.info('Configuration reloaded successfully');
  return reloaded;
}

/**
 * Run the command and return its exit status, printing uncaught errors like
 * Python's traceback handler (status 1).
 */
export async function run(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  try {
    await main(argv);
    return 0;
  } catch (error) {
    if (error instanceof SystemExit) {
      return error.code;
    }
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? String(error)) : String(error)}\n`,
    );
    return 1;
  }
}
