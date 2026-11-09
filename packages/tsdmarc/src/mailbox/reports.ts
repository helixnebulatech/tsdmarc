// Mailbox report processing, ported from parsedmarc/__init__.py:
// get_dmarc_reports_from_mailbox(), watch_inbox() and their private helpers.
//
// Backends are told apart by `connection.kind` instead of parsedmarc's
// `isinstance` checks, so this module never imports the IMAP, Gmail or
// Microsoft Graph packages.

import {
  newSeenAggregateReportIds,
  type ParserConfig,
  type ParserConfigInput,
  replaceParserConfig,
  resolveParserConfig,
  type SeenAggregateReportIds,
} from '../config';
import {
  EmailTooLargeError,
  emailTooLargeError,
  findEnrichmentError,
  ParserError,
} from '../errors';
import { errorText, pyInt } from '../internal/py';
import { logger } from '../log';
import {
  JobTimeoutError,
  parallelMap,
  parseReportEmailTask,
  WorkerCrashedError,
} from '../parallel';
import {
  classifyParsedEmail,
  emailByteLength,
  parseReportEmail,
} from '../report-email';
import type {
  AggregateReport,
  FailureReport,
  ParsedReport,
  ParsingResults,
  SMTPTLSReport,
} from '../types';
import { PyDateTime } from '../utils/datetime';
import { ValueError } from '../utils/email';
import { MessageError, RecursionError } from '../utils/py-email/errors';
import { sanitizeForLog } from '../utils/sanitize';
import type { MailboxConnection, MessageId } from './base';

/**
 * Per-message count of consecutive failed saves, keyed on
 * `failedSaveKey(connection, reportsFolder, messageUid)` (parsedmarc's
 * `_FAILED_SAVE_ATTEMPTS`). Populated when a `saveCallback` reports a batch
 * unsaved, or a message runs past `jobTimeout` or loses its worker; a message
 * whose count exceeds `maxUnsavedRetries` is moved to `{archiveFolder}/Unsaved` and its
 * entry dropped. A successful save clears the entries of its batch.
 *
 * Process-local and deliberately not persisted: a restart re-attempts every
 * message still in the reports folder (retry rather than shelve). Unlike
 * parsedmarc's, the key carries `mailboxIdentity`: IMAP UIDs are small
 * integers, so two mailboxes would share counters. Reconnecting to the same
 * mailbox keeps them.
 */
export const FAILED_SAVE_ATTEMPTS: Map<string, number> = new Map();

/** The `FAILED_SAVE_ATTEMPTS` key: Python's `(reports_folder, str(uid))` plus the mailbox. */
export function failedSaveKey(
  connection: MailboxConnection,
  reportsFolder: string,
  messageUid: MessageId,
): string {
  return JSON.stringify([
    connection.mailboxIdentity,
    reportsFolder,
    String(messageUid),
  ]);
}

/** Each connection's seen aggregate report IDs, for calls without `config`. */
const CONNECTION_SEEN_REPORT_IDS = new WeakMap<
  MailboxConnection,
  SeenAggregateReportIds
>();

/**
 * `resolveParserConfig()` for a mailbox: without an explicit `config`, dedup
 * is per connection instead of per process (parsedmarc's module-wide
 * cache), so a report seen in one mailbox isn't dropped, and its message
 * archived unsaved, in another. Share an explicit `config` to dedup across
 * connections.
 */
function resolveMailboxConfig(
  connection: MailboxConnection,
  input: ParserConfigInput,
): ParserConfig {
  const config = resolveParserConfig(input);
  if (input.config) {
    return config;
  }
  let seenAggregateReportIds = CONNECTION_SEEN_REPORT_IDS.get(connection);
  if (seenAggregateReportIds === undefined) {
    seenAggregateReportIds = newSeenAggregateReportIds();
    CONNECTION_SEEN_REPORT_IDS.set(connection, seenAggregateReportIds);
  }
  return replaceParserConfig(config, { seenAggregateReportIds });
}

/** What a save callback returns: `false` means "not saved". */
export type SaveCallbackResult = boolean | null | undefined | void;

/**
 * Called once per fetched batch with only that batch's reports, before any
 * of its messages is moved or deleted. Returning `false` (or throwing)
 * marks the batch unsaved; anything else commits it.
 */
export type SaveCallback = (
  results: ParsingResults,
) => SaveCallbackResult | Promise<SaveCallbackResult>;

/** Mailbox-handling options shared by both entry points (not part of `config`). */
interface MailboxProcessingOptions extends ParserConfigInput {
  /** The folder where reports can be found. Default: `"INBOX"`. */
  reportsFolder?: string;
  /** The folder to move processed mail to. Default: `"Archive"`. */
  archiveFolder?: string;
  /** Delete messages after processing them. Default: false. */
  delete?: boolean;
  /**
   * Delete aggregate report messages instead of moving them to the
   * `Aggregate` archive subfolder. `null`/unset inherits `delete`.
   */
  deleteAggregate?: boolean | null;
  /**
   * Delete failure report messages instead of moving them to the `Failure`
   * archive subfolder. `null`/unset inherits `delete`.
   */
  deleteFailure?: boolean | null;
  /**
   * Delete SMTP TLS report messages instead of moving them to the
   * `SMTP-TLS` archive subfolder. `null`/unset inherits `delete`.
   */
  deleteSmtpTls?: boolean | null;
  /**
   * Delete unparseable messages instead of moving them to the `Invalid`
   * archive subfolder. `null`/unset inherits `delete`.
   */
  deleteInvalid?: boolean | null;
  /** Do not move or delete messages after processing them. Default: false. */
  test?: boolean;
  /** Messages to read and process before saving (0: no limit). Default: 10. */
  batchSize?: number;
  /**
   * Only messages since this relative time (`5m`, `3h`, `2d`, `1w`). Any
   * other string falls back to one day, with a warning.
   */
  since?: string | null;
  /**
   * Worker threads used to parse messages. Fetching, archiving and dedup
   * stay sequential; with `nProcs > 1`, invalid messages are disposed of
   * after the parsing phase. Default: 1.
   */
  nProcs?: number;
  /**
   * Retries a message gets after its batch was first reported unsaved,
   * before it moves to the `Unsaved` archive subfolder (never deleted).
   * `0` moves it on the first failed save; negative values throw
   * `ValueError`. Default: 2.
   */
  maxUnsavedRetries?: number;
}

/** Options of {@link getDmarcReportsFromMailbox}. */
export interface GetDmarcReportsFromMailboxOptions extends MailboxProcessingOptions {
  /** Results from the previous run, to accumulate into. */
  results?: ParsingResults | null;
  /** Create the destination folders (not used in watch). Default: true. */
  createFolders?: boolean;
  /**
   * Called once per batch before its messages are archived or deleted.
   * Returning `false` leaves them in `reportsFolder` for retry (or moves
   * them to `Unsaved` once retries run out) and keeps their aggregate
   * report keys out of the dedup cache. Throwing counts as unsaved too, and
   * the error is rethrown after that bookkeeping. Still invoked in `test`
   * mode, where the mailbox and retry counters are never touched.
   */
  saveCallback?: SaveCallback | null;
}

/** Options of {@link watchInbox}. */
export interface WatchInboxOptions extends MailboxProcessingOptions {
  /** Seconds to wait for an IMAP IDLE response or between checks. Default: 30. */
  checkTimeout?: number;
  /** Returns true when a config reload or shutdown was requested. */
  configReloading?: (() => boolean) | null;
  /** Aborts the watch loop. */
  signal?: AbortSignal;
}

/**
 * Fetch one message by UID, casting the UID to what each backend expects
 * (parsedmarc's `_fetch_mailbox_message`). Returns `[messageId, content]`;
 * `messageId` is what later move/delete calls use.
 *
 * A content error raised while fetching (Python's `email.errors.MessageError`
 * or `RecursionError`, from a backend that re-serializes the message) is
 * returned, not thrown, as `content`: a `ParserError` the caller treats like
 * a parse failure, so the message is disposed of as invalid instead of
 * aborting the batch on every run (GHSA-qxwv-2vwj-v828). Transport and
 * service errors still throw: a transient network failure must not move a
 * legitimate report to the invalid folder.
 *
 * With `maxSize` (bytes, not in parsedmarc), a message over the limit is
 * returned as an `EmailTooLargeError` the same way: backends that know a
 * message's size refuse it before downloading it.
 */
export async function fetchMailboxMessage(
  connection: MailboxConnection,
  msgUid: MessageId,
  test: boolean,
  maxSize: number | null = null,
): Promise<[MessageId, string | ParserError]> {
  const limit = maxSize !== null && maxSize > 0 ? { maxSize } : {};
  const messageId: MessageId =
    connection.kind === 'imap' ? pyInt(msgUid) : String(msgUid);
  let content: string;
  try {
    content =
      connection.kind === 'msgraph' || connection.kind === 'maildir'
        ? await connection.fetchMessage(messageId, {
            markRead: !test,
            ...limit,
          })
        : await connection.fetchMessage(messageId, limit);
  } catch (error) {
    if (error instanceof MessageError || error instanceof RecursionError) {
      return [
        messageId,
        new ParserError(
          `Unable to fetch message UID ${messageId}: ${error.name}: ${error.message}`,
          { cause: error },
        ),
      ];
    }
    if (error instanceof EmailTooLargeError) {
      return [
        messageId,
        new EmailTooLargeError(`Message UID ${msgUid}: ${error.message}`, {
          cause: error,
        }),
      ];
    }
    throw error;
  }
  if (limit.maxSize !== undefined) {
    const size = emailByteLength(content);
    if (size > limit.maxSize) {
      const tooLarge = emailTooLargeError(size, limit.maxSize);
      return [
        messageId,
        new EmailTooLargeError(`Message UID ${msgUid}: ${tooLarge.message}`, {
          cause: tooLarge,
        }),
      ];
    }
  }
  return [messageId, content];
}

/**
 * The warning for a message that couldn't be parsed: a {@link ParserError}'s
 * own message (as parsedmarc logs it), or the error type and message of any
 * other error. Untrusted text is escaped.
 */
export function invalidMessageWarning(
  error: unknown,
  messageId: MessageId,
): string {
  if (error instanceof ParserError) {
    return sanitizeForLog(error.message);
  }
  const name = error instanceof Error ? error.name : 'Error';
  return sanitizeForLog(
    `Unexpected error parsing message UID ${messageId}, treating it as invalid: ${name}: ${errorText(error)}`,
  );
}

/** The warning for a message that ran past `jobTimeout`. */
function timedOutMessageWarning(
  error: JobTimeoutError,
  messageId: MessageId,
): string {
  return `Timed out parsing message UID ${messageId}: ${error.message}`;
}

/** The warning for a message whose worker died (usually out of memory). */
function crashedMessageWarning(
  error: WorkerCrashedError,
  messageId: MessageId,
): string {
  return `Worker failed parsing message UID ${messageId}: ${error.message}: ${errorText(error.cause)}`;
}

/**
 * Delete or move an unparseable message (parsedmarc's
 * `_dispose_invalid_message`). Callers pass their effective
 * `deleteInvalid` as `del`.
 */
export async function disposeInvalidMessage(
  connection: MailboxConnection,
  messageId: MessageId,
  del: boolean,
  invalidReportsFolder: string,
): Promise<void> {
  try {
    const id =
      connection.kind === 'imap' ? pyInt(messageId) : String(messageId);
    if (del) {
      logger.debug(`Deleting message UID ${messageId}`);
      await connection.deleteMessage(id);
    } else {
      logger.debug(
        `Moving message UID ${messageId} to ${invalidReportsFolder}`,
      );
      await connection.moveMessage(id, invalidReportsFolder);
    }
  } catch (error) {
    // Logged and left in place, as the archival of parsed reports does,
    // rather than aborting the rest of the batch (GHSA-qxwv-2vwj-v828).
    const action = del ? 'deleting' : 'moving';
    const name = error instanceof Error ? error.name : 'Error';
    logger.error(
      `Mailbox error: Error ${action} invalid message UID ${messageId}: ${name}: ${errorText(error)}`,
    );
  }
}

/**
 * Consolidate a pre-rename `<archive>/Forensic` subfolder into
 * `<archive>/Failure` (parsedmarc's `_migrate_forensic_archive_folder`).
 * A no-op without a legacy folder; never throws (warn, don't crash).
 */
export async function migrateForensicArchiveFolder(
  connection: MailboxConnection,
  archiveFolder: string,
): Promise<void> {
  const oldFolder = `${archiveFolder}/Forensic`;
  const newFolder = `${archiveFolder}/Failure`;
  try {
    if (!(await connection.folderExists(oldFolder))) {
      return;
    }
    if (await connection.folderExists(newFolder)) {
      // Both exist (a partial earlier migration, or a manually created
      // Failure folder): merge and drop the emptied legacy folder.
      await connection.mergeFolders(oldFolder, newFolder);
      logger.info(
        `Merged legacy archive folder ${oldFolder} into ${newFolder}`,
      );
    } else {
      await connection.renameFolder(oldFolder, newFolder);
      logger.info(`Renamed legacy archive folder ${oldFolder} to ${newFolder}`);
    }
  } catch (error) {
    logger.warning(
      `Could not migrate legacy archive folder ${oldFolder} to ${newFolder}: ${errorText(error)}`,
    );
  }
}

/**
 * Best-effort create `folder` if the backend says it is missing
 * (parsedmarc's `_ensure_folder`). Never throws.
 */
export async function ensureFolder(
  connection: MailboxConnection,
  folder: string,
): Promise<void> {
  try {
    if (!(await connection.folderExists(folder))) {
      await connection.createFolder(folder);
    }
  } catch (error) {
    logger.warning(`Could not create folder ${folder}: ${errorText(error)}`);
  }
}

const SINCE_PATTERN = /^(?<amount>\p{Nd}+)(?<unit>[mhdw]\n?)$/u;
const MINUTES_PER_UNIT: Readonly<Record<string, number>> = {
  m: 1,
  h: 60,
  d: 60 * 24,
  w: 60 * 24 * 7,
};
const DEFAULT_SINCE_MINUTES = 1440;
const SECONDS_PER_MINUTE = 60;
const DECIMAL_BASE = 10;
const MS_PER_SECOND = 1000;

/** Python's `int()` of a run of Unicode decimal digits (`\d` matches them all). */
function decimalDigitsValue(digits: string): number {
  let value = 0;
  for (const char of digits) {
    let codePoint = char.codePointAt(0) ?? 0;
    // Unicode decimal digits come in contiguous 0-9 runs: find the run's
    // start, then the digit is the offset into its block of ten.
    let start = codePoint;
    while (/^\p{Nd}$/u.test(String.fromCodePoint(start - 1))) {
      start -= 1;
    }
    codePoint = (codePoint - start) % DECIMAL_BASE;
    value = value * DECIMAL_BASE + codePoint;
  }
  return value;
}

/** The minutes a relative `since` (`5m`, `3h`, `2d`, `1w`) stands for. */
function sinceMinutes(since: string): number {
  const match = SINCE_PATTERN.exec(since);
  if (!match?.groups) {
    logger.warning(
      `Incorrect format for 'since' option. Provided value: ${since}, ` +
        'expected values: (5m|3h|2d|1w). Ignoring option, fetching ' +
        'messages for last 24hrs. SMTP does not support a time or ' +
        'timezone in since. See ' +
        'https://www.rfc-editor.org/rfc/rfc3501#page-52',
    );
    return DEFAULT_SINCE_MINUTES;
  }
  // Python compares re.split()'s unit token exactly, so "2d\n" (accepted by
  // `$`) keeps the one-day default.
  const perUnit = MINUTES_PER_UNIT[match.groups.unit ?? ''];
  if (perUnit === undefined) {
    return DEFAULT_SINCE_MINUTES;
  }
  return decimalDigitsValue(match.groups.amount ?? '') * perUnit;
}

/**
 * `strftime("%s")` of an aware UTC datetime, as CPython computes it on
 * glibc: the tm fields go through mktime(), which reads them as local
 * time, so the result is off by the local UTC offset (exact under TZ=UTC).
 */
function pyStrftimeEpoch(datetime: PyDateTime): string {
  return String(Math.floor(datetime.withOffset(null).timestamp()));
}

/** Backend-specific `since` and `currentTime` strings. */
function resolveSince(
  connection: MailboxConnection,
  since: string,
): { since: string; currentTime: string | null } {
  const minutes = sinceMinutes(since);
  const sinceTime = (): PyDateTime =>
    PyDateTime.now(true).addSeconds(-minutes * SECONDS_PER_MINUTE);
  switch (connection.kind) {
    case 'imap':
      logger.debug(
        "Only days and weeks values in 'since' option are considered " +
          'for IMAP connections. Examples: 2d or 1w',
      );
      return {
        since: sinceTime().strftime('%d-%b-%Y'),
        currentTime: PyDateTime.now(true).strftime('%d-%b-%Y'),
      };
    case 'msgraph':
      return {
        since: sinceTime().isoformat(),
        currentTime: PyDateTime.now(true).isoformat(),
      };
    case 'gmail':
      return {
        since: pyStrftimeEpoch(sinceTime()),
        currentTime: pyStrftimeEpoch(PyDateTime.now(true)),
      };
    default:
      return { since, currentTime: null };
  }
}

interface ArchiveFolders {
  aggregate: string;
  failure: string;
  smtpTls: string;
  invalid: string;
  unsaved: string;
}

/** The per-type delete flags, each inheriting `delete` when unset. */
interface DeleteFlags {
  aggregate: boolean;
  failure: boolean;
  smtpTls: boolean;
  invalid: boolean;
}

/** One batch's parsed reports and the message IDs behind them. */
class Batch {
  readonly aggregateReports: AggregateReport[] = [];
  readonly failureReports: FailureReport[] = [];
  readonly smtpTlsReports: SMTPTLSReport[] = [];
  /** Aggregate dedup keys, staged until the batch is saved. */
  readonly pendingAggregateKeys = new Set<string>();
  readonly aggregateMsgUids: MessageId[] = [];
  readonly failureMsgUids: MessageId[] = [];
  readonly smtpTlsMsgUids: MessageId[] = [];

  constructor(private readonly config: ParserConfig) {}

  add(parsedEmail: ParsedReport, messageId: MessageId): void {
    const reportType = classifyParsedEmail(
      parsedEmail,
      this.aggregateReports,
      this.failureReports,
      this.smtpTlsReports,
      {
        seenAggregateReportIds: this.config.seenAggregateReportIds,
        pendingAggregateKeys: this.pendingAggregateKeys,
      },
    );
    // The UID is kept even for a dropped duplicate, so its message is
    // archived too.
    if (reportType === 'aggregate') {
      this.aggregateMsgUids.push(messageId);
    } else if (reportType === 'failure') {
      this.failureMsgUids.push(messageId);
    } else if (reportType === 'smtp_tls') {
      this.smtpTlsMsgUids.push(messageId);
    }
  }

  results(): ParsingResults {
    return {
      aggregateReports: this.aggregateReports,
      failureReports: this.failureReports,
      smtpTlsReports: this.smtpTlsReports,
    };
  }

  msgUids(): MessageId[] {
    return [
      ...this.aggregateMsgUids,
      ...this.failureMsgUids,
      ...this.smtpTlsMsgUids,
    ];
  }
}

interface ParseContext {
  connection: MailboxConnection;
  /** `config.maxEmailSize`, or null when unlimited. */
  maxSize: number | null;
  messages: MessageId[];
  messageLimit: number;
  test: boolean;
  config: ParserConfig;
  batch: Batch;
  deleteInvalid: boolean;
  invalidReportsFolder: string;
  reportsFolder: string;
  unsavedReportsFolder: string;
  maxUnsavedRetries: number;
}

/**
 * Put back messages that ran past `jobTimeout` or lost their worker. Neither
 * says anything about the content (the same report can fit in on a healthy
 * resolver, or in a worker with free memory), so unlike an invalid message
 * one is never deleted: it is retried like an unsaved batch, up to
 * `maxUnsavedRetries` times so it can't hold up every pass, then moved to
 * `Unsaved`.
 */
async function holdBackUnfinishedMessages(
  context: ParseContext,
  messageIds: MessageId[],
): Promise<void> {
  if (context.test || messageIds.length === 0) {
    return;
  }
  await holdBackUnsavedBatch(
    context.connection,
    messageIds,
    context.reportsFolder,
    context.unsavedReportsFolder,
    context.maxUnsavedRetries,
  );
}

async function parseInParallel(
  context: ParseContext,
  nProcs: number,
): Promise<void> {
  const { connection, messages, messageLimit, test, batch } = context;
  // Results come back in submission order, so the oldest queued ID always
  // belongs to the next result.
  const fetchedIds: MessageId[] = [];
  const invalidMsgIds: MessageId[] = [];
  const unfinishedMsgIds: MessageId[] = [];

  async function* jobs(): AsyncGenerator<string> {
    for (let index = 0; index < messageLimit; index += 1) {
      const msgUid = messages[index] as MessageId;
      logger.debug(
        `Processing message ${index + 1} of ${messageLimit}: UID ${msgUid}`,
      );
      const [messageId, msgContent] = await fetchMailboxMessage(
        connection,
        msgUid,
        test,
        context.maxSize,
      );
      if (msgContent instanceof ParserError) {
        // Never submitted, so never yielded and never queued in fetchedIds;
        // the post-loop disposal handles it.
        logger.warning(sanitizeForLog(msgContent.message));
        invalidMsgIds.push(messageId);
        continue;
      }
      fetchedIds.push(messageId);
      yield msgContent;
    }
  }

  // A failure of one message (a ParserError, an unexpected error) makes only
  // that message invalid. A failed heartbeat or an enrichment failure is no
  // such thing: it ends this loop before anything is disposed of, and the
  // batch stays in the mailbox for the next run.
  for await (const result of parallelMap<
    string,
    ParsedReport | ParserError | Error
  >(parseReportEmailTask(context.config), jobs(), nProcs, {
    heartbeat: () => connection.keepalive(),
    onJobError: error =>
      error instanceof Error ? error : new Error(String(error)),
  })) {
    const messageId = fetchedIds.shift() as MessageId;
    if (result instanceof JobTimeoutError) {
      logger.warning(timedOutMessageWarning(result, messageId));
      unfinishedMsgIds.push(messageId);
    } else if (result instanceof WorkerCrashedError) {
      logger.warning(crashedMessageWarning(result, messageId));
      unfinishedMsgIds.push(messageId);
    } else if (result instanceof Error) {
      const enrichmentError = findEnrichmentError(result);
      if (enrichmentError !== null) {
        throw enrichmentError;
      }
      logger.warning(invalidMessageWarning(result, messageId));
      invalidMsgIds.push(messageId);
    } else {
      batch.add(result, messageId);
    }
  }

  if (!test) {
    for (const invalidMessageId of invalidMsgIds) {
      await disposeInvalidMessage(
        connection,
        invalidMessageId,
        context.deleteInvalid,
        context.invalidReportsFolder,
      );
    }
  }
  await holdBackUnfinishedMessages(context, unfinishedMsgIds);
}

/**
 * `parseReportEmail()` on the calling thread, with the connection kept alive
 * and `config.jobTimeout` checked at each keepalive. A failure of either
 * reaches the caller as thrown (see `parseReportEmail()`): the message isn't
 * at fault, and a `ParserError` here would dispose of a legitimate report.
 */
async function parseWithKeepalive(
  context: ParseContext,
  content: string,
): Promise<ParsedReport> {
  const { connection, config } = context;
  const deadline =
    config.jobTimeout > 0
      ? Date.now() + config.jobTimeout * MS_PER_SECOND
      : Number.POSITIVE_INFINITY;
  const keepAlive = async (): Promise<void> => {
    if (Date.now() >= deadline) {
      throw new JobTimeoutError(
        `Job did not finish within ${config.jobTimeout} seconds`,
      );
    }
    await connection.keepalive();
  };
  return parseReportEmail(content, { config, keepAlive });
}

async function parseSequentially(context: ParseContext): Promise<void> {
  const { connection, messages, messageLimit, test, batch } = context;
  for (let index = 0; index < messageLimit; index += 1) {
    const msgUid = messages[index] as MessageId;
    logger.debug(
      `Processing message ${index + 1} of ${messageLimit}: UID ${msgUid}`,
    );
    const [messageId, msgContent] = await fetchMailboxMessage(
      connection,
      msgUid,
      test,
      context.maxSize,
    );
    try {
      if (msgContent instanceof ParserError) {
        throw msgContent;
      }
      batch.add(await parseWithKeepalive(context, msgContent), messageId);
    } catch (error) {
      if (error instanceof JobTimeoutError) {
        logger.warning(timedOutMessageWarning(error, messageId));
        await holdBackUnfinishedMessages(context, [messageId]);
        continue;
      }
      if (!(error instanceof ParserError)) {
        throw error;
      }
      // Every report would fail alike, whatever it holds: the pass stops
      // and the batch stays in the mailbox, as after a failed keepalive.
      const enrichmentError = findEnrichmentError(error);
      if (enrichmentError !== null) {
        throw enrichmentError;
      }
      logger.warning(invalidMessageWarning(error, messageId));
      if (!test) {
        await disposeInvalidMessage(
          connection,
          messageId,
          context.deleteInvalid,
          context.invalidReportsFolder,
        );
      }
    }
  }
}

/**
 * Failure bookkeeping for an unsaved batch: count the attempt for each
 * message, keep those under the cap in place and move the rest to
 * `Unsaved` (never deleted).
 */
async function holdBackUnsavedBatch(
  connection: MailboxConnection,
  batchMsgUids: MessageId[],
  reportsFolder: string,
  unsavedReportsFolder: string,
  maxUnsavedRetries: number,
): Promise<void> {
  const retainedUids: MessageId[] = [];
  const overCapUids: MessageId[] = [];
  let highestAttempt = 0;
  for (const msgUid of batchMsgUids) {
    const attemptsKey = failedSaveKey(connection, reportsFolder, msgUid);
    const attempts = (FAILED_SAVE_ATTEMPTS.get(attemptsKey) ?? 0) + 1;
    FAILED_SAVE_ATTEMPTS.set(attemptsKey, attempts);
    if (attempts > maxUnsavedRetries) {
      overCapUids.push(msgUid);
    } else {
      retainedUids.push(msgUid);
      highestAttempt = Math.max(highestAttempt, attempts);
    }
  }
  if (retainedUids.length > 0) {
    logger.error(
      `Reports were not saved: leaving ${retainedUids.length} ` +
        `message(s) in ${reportsFolder} to retry on the next run ` +
        `or check (failed attempt ${highestAttempt} of ` +
        `${maxUnsavedRetries + 1})`,
    );
  }
  if (overCapUids.length > 0) {
    logger.error(
      `Reports were not saved after ${maxUnsavedRetries + 1} ` +
        `attempt(s): moving ${overCapUids.length} message(s) from ` +
        `${reportsFolder} to ${unsavedReportsFolder} instead of ` +
        'retrying them further. They are never deleted -- fix the ' +
        `output destination, then move them back to ${reportsFolder}`,
    );
    await ensureFolder(connection, unsavedReportsFolder);
    for (const msgUid of overCapUids) {
      try {
        await connection.moveMessage(msgUid, unsavedReportsFolder);
      } catch (error) {
        logger.error(
          `Mailbox error: Error moving message UID ${msgUid}: ${errorText(error)}`,
        );
        continue;
      }
      // Drop the counter only once the message is out of the retry loop:
      // after a failed move it stays over the cap, so the move is retried.
      FAILED_SAVE_ATTEMPTS.delete(
        failedSaveKey(connection, reportsFolder, msgUid),
      );
    }
  }
}

/** Delete or archive each report type's messages per its delete flag. */
async function disposeSavedBatch(
  connection: MailboxConnection,
  batch: Batch,
  reportsFolder: string,
  folders: ArchiveFolders,
  deleteFlags: DeleteFlags,
): Promise<void> {
  const groups: [MessageId[], boolean, string, string][] = [
    [
      batch.aggregateMsgUids,
      deleteFlags.aggregate,
      folders.aggregate,
      'aggregate report',
    ],
    [
      batch.failureMsgUids,
      deleteFlags.failure,
      folders.failure,
      'failure report',
    ],
    [
      batch.smtpTlsMsgUids,
      deleteFlags.smtpTls,
      folders.smtpTls,
      'SMTP TLS report',
    ],
  ];
  for (const [msgUids, deleteType, destinationFolder, label] of groups) {
    const numberOfMsgs = msgUids.length;
    if (numberOfMsgs === 0) {
      continue;
    }
    if (!deleteType) {
      logger.debug(
        `Moving ${label} messages from ${reportsFolder} to ${destinationFolder}`,
      );
    }
    for (const [index, msgUid] of msgUids.entries()) {
      if (deleteType) {
        logger.debug(
          `Deleting message ${index + 1} of ${numberOfMsgs}: UID ${msgUid}`,
        );
        try {
          await connection.deleteMessage(msgUid);
        } catch (error) {
          logger.error(
            `Mailbox error: Error deleting message UID ${msgUid}: ${errorText(error)}`,
          );
        }
      } else {
        logger.debug(
          `Moving message ${index + 1} of ${numberOfMsgs}: UID ${msgUid}`,
        );
        try {
          await connection.moveMessage(msgUid, destinationFolder);
        } catch (error) {
          logger.error(
            `Mailbox error: Error moving message UID ${msgUid}: ${errorText(error)}`,
          );
        }
      }
    }
  }
}

/**
 * Fetches and parses DMARC and SMTP TLS reports from a mailbox, then
 * archives (or deletes) each message by report type: `<archive>/Aggregate`,
 * `Failure`, `SMTP-TLS`, `Invalid`, and `Unsaved` for batches the
 * `saveCallback` kept failing to save.
 *
 * Parsing options (or `config`) work as in every parsing function; the
 * mailbox options always apply. With `batchSize: 0` the reports folder is
 * re-checked after the run and new messages are processed recursively.
 *
 * Throws an `EnrichmentError` when enrichment fails for every report
 * (a revoked IPinfo token, no readable IP database): the batch stays in
 * `reportsFolder`, unsaved, for the next run. Unlike parsedmarc, which
 * files those reports as invalid or empty, and deletes them with `delete`.
 *
 * Throws `ValueError` when a delete option is combined with `test`, when
 * `maxUnsavedRetries` is negative, or without a connection.
 */
export async function getDmarcReportsFromMailbox(
  connection: MailboxConnection,
  options: GetDmarcReportsFromMailboxOptions = {},
): Promise<ParsingResults> {
  const {
    reportsFolder = 'INBOX',
    archiveFolder = 'Archive',
    delete: del = false,
    deleteAggregate = null,
    deleteFailure = null,
    deleteSmtpTls = null,
    deleteInvalid = null,
    test = false,
    results = null,
    batchSize = 10,
    since: sinceOption = null,
    createFolders = true,
    nProcs = 1,
    saveCallback = null,
    maxUnsavedRetries = 2,
    ...configOptions
  } = options;

  // Each per-type flag inherits `delete` when unset; every decision below
  // reads only these resolved flags.
  const deleteFlags: DeleteFlags = {
    aggregate: deleteAggregate ?? del,
    failure: deleteFailure ?? del,
    smtpTls: deleteSmtpTls ?? del,
    invalid: deleteInvalid ?? del,
  };

  if (
    test &&
    (deleteFlags.aggregate ||
      deleteFlags.failure ||
      deleteFlags.smtpTls ||
      deleteFlags.invalid)
  ) {
    throw new ValueError('delete options and test are mutually exclusive');
  }
  if (maxUnsavedRetries < 0) {
    throw new ValueError('max_unsaved_retries must be >= 0');
  }
  // Runtime guard for JavaScript callers and casts.
  if ((connection as MailboxConnection | null | undefined) == null) {
    throw new ValueError('Must supply a connection');
  }

  const config = resolveMailboxConfig(connection, configOptions);

  // Used by the batchSize 0 re-check below.
  let currentTime: string | null = null;

  let aggregateReports: AggregateReport[] = [];
  let failureReports: FailureReport[] = [];
  let smtpTlsReports: SMTPTLSReport[] = [];
  // This call's own reports, kept apart from the accumulated lists so the
  // save callback gets only what this batch parsed.
  const batch = new Batch(config);
  const folders: ArchiveFolders = {
    aggregate: `${archiveFolder}/Aggregate`,
    failure: `${archiveFolder}/Failure`,
    smtpTls: `${archiveFolder}/SMTP-TLS`,
    invalid: `${archiveFolder}/Invalid`,
    unsaved: `${archiveFolder}/Unsaved`,
  };

  if (results) {
    aggregateReports = [...results.aggregateReports];
    failureReports = [...results.failureReports];
    smtpTlsReports = [...results.smtpTlsReports];
  }

  if (!test && createFolders) {
    await migrateForensicArchiveFolder(connection, archiveFolder);
    await connection.createFolder(archiveFolder);
    await connection.createFolder(folders.aggregate);
    await connection.createFolder(folders.failure);
    await connection.createFolder(folders.smtpTls);
    await connection.createFolder(folders.invalid);
    if (saveCallback !== null) {
      // Only a callback can hold a batch back; without one the folder
      // would sit empty in every mailbox.
      await connection.createFolder(folders.unsaved);
    }
  }

  let since = sinceOption;
  if (since) {
    ({ since, currentTime } = resolveSince(connection, since));
  }

  const messages = await connection.fetchMessages(reportsFolder, {
    batchSize,
    since,
  });
  let totalMessages = messages.length;
  logger.debug(`Found ${messages.length} messages in ${reportsFolder}`);

  const messageLimit =
    batchSize && !since ? Math.min(totalMessages, batchSize) : totalMessages;

  logger.debug(`Processing ${messageLimit} messages`);

  const context: ParseContext = {
    connection,
    maxSize: config.maxEmailSize > 0 ? config.maxEmailSize : null,
    messages,
    messageLimit,
    test,
    config,
    batch,
    deleteInvalid: deleteFlags.invalid,
    invalidReportsFolder: folders.invalid,
    reportsFolder,
    unsavedReportsFolder: folders.unsaved,
    maxUnsavedRetries,
  };
  if (nProcs > 1 && messageLimit > 1) {
    await parseInParallel(context, nProcs);
  } else {
    await parseSequentially(context);
  }

  // Ask the caller whether the batch reached its outputs before touching a
  // single message: an unsaved batch exists nowhere else yet.
  let persisted = true;
  let callbackError: { error: unknown } | null = null;
  if (saveCallback !== null) {
    try {
      persisted = (await saveCallback(batch.results())) !== false;
    } catch (error) {
      // A throwing callback is a failed save too: the bookkeeping below
      // still runs (so the retry cap applies even when a watch loop
      // swallows the error), then the error is rethrown.
      persisted = false;
      callbackError = { error };
    }
  }

  const batchMsgUids = batch.msgUids();

  if (persisted) {
    for (const reportKey of batch.pendingAggregateKeys) {
      config.seenAggregateReportIds.set(reportKey, true);
    }
    if (!test) {
      for (const msgUid of batchMsgUids) {
        FAILED_SAVE_ATTEMPTS.delete(
          failedSaveKey(connection, reportsFolder, msgUid),
        );
      }
    }
  } else if (!test) {
    await holdBackUnsavedBatch(
      connection,
      batchMsgUids,
      reportsFolder,
      folders.unsaved,
      maxUnsavedRetries,
    );
  }

  if (callbackError !== null) {
    throw callbackError.error;
  }

  // One by one: with batchSize 0, a spread can run out of call stack.
  for (const report of batch.aggregateReports) {
    aggregateReports.push(report);
  }
  for (const report of batch.failureReports) {
    failureReports.push(report);
  }
  for (const report of batch.smtpTlsReports) {
    smtpTlsReports.push(report);
  }

  if (persisted && !test) {
    await disposeSavedBatch(
      connection,
      batch,
      reportsFolder,
      folders,
      deleteFlags,
    );
  }
  let accumulated: ParsingResults = {
    aggregateReports,
    failureReports,
    smtpTlsReports,
  };

  // An unsaved batch left its messages in place; re-checking now would
  // reprocess them at once and burn the retry cap in one call.
  if (persisted && !test && !batchSize) {
    totalMessages = currentTime
      ? (await connection.fetchMessages(reportsFolder, { since: currentTime }))
          .length
      : (await connection.fetchMessages(reportsFolder)).length;
  } else {
    totalMessages = 0;
  }

  if (totalMessages > 0) {
    // Process emails that came in during the last run. Like parsedmarc,
    // batchSize and createFolders are left at their defaults here.
    accumulated = await getDmarcReportsFromMailbox(connection, {
      reportsFolder,
      archiveFolder,
      delete: del,
      deleteAggregate: deleteFlags.aggregate,
      deleteFailure: deleteFlags.failure,
      deleteSmtpTls: deleteFlags.smtpTls,
      deleteInvalid: deleteFlags.invalid,
      test,
      results: accumulated,
      since: currentTime,
      nProcs,
      saveCallback,
      maxUnsavedRetries,
      config,
    });
  }

  return accumulated;
}

/**
 * Watches the mailbox for new messages and processes them with
 * {@link getDmarcReportsFromMailbox} on every check, with `callback` as its
 * `saveCallback`: it runs once per batch, before the batch's messages are
 * archived or deleted, and returning `false` (or throwing) leaves them for
 * the next check. What happens to a thrown error is backend-specific: the
 * IMAP and Maildir watch loops log it and keep checking; Gmail and
 * Microsoft Graph end the watch.
 *
 * Throws `ValueError` for a negative `maxUnsavedRetries` before watching.
 */
export async function watchInbox(
  mailboxConnection: MailboxConnection,
  callback: SaveCallback,
  options: WatchInboxOptions = {},
): Promise<void> {
  const {
    reportsFolder = 'INBOX',
    archiveFolder = 'Archive',
    delete: del = false,
    deleteAggregate = null,
    deleteFailure = null,
    deleteSmtpTls = null,
    deleteInvalid = null,
    test = false,
    checkTimeout = 30,
    batchSize = 10,
    since = null,
    configReloading = null,
    nProcs = 1,
    maxUnsavedRetries = 2,
    signal,
    ...configOptions
  } = options;

  // Validated up front: thrown inside a check, the IMAP and Maildir watch
  // loops would swallow it and retry forever.
  if (maxUnsavedRetries < 0) {
    throw new ValueError('max_unsaved_retries must be >= 0');
  }

  const config = resolveMailboxConfig(mailboxConnection, configOptions);

  const checkCallback = async (
    connection: MailboxConnection,
  ): Promise<void> => {
    await getDmarcReportsFromMailbox(connection, {
      reportsFolder,
      archiveFolder,
      delete: del,
      deleteAggregate,
      deleteFailure,
      deleteSmtpTls,
      deleteInvalid,
      test,
      batchSize,
      since,
      createFolders: false,
      nProcs,
      saveCallback: callback,
      maxUnsavedRetries,
      config,
    });
  };

  await mailboxConnection.watch({
    checkCallback,
    checkTimeout,
    ...(configReloading === null ? {} : { configReloading }),
    ...(signal === undefined ? {} : { signal }),
  });
}
