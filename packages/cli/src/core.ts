// The core functions the CLI drives, behind one module: the mailbox fetch
// and watch loops, and the parallel parsing of report files. Tests replace
// these at this seam (parsedmarc's tests patch the same names on its CLI
// module).

import {
  getDmarcReportsFromMailbox as coreGetDmarcReportsFromMailbox,
  type MailboxConnection,
  parallelMap,
  type ParsedReport,
  type ParserConfig,
  type ParsingResults,
  parseReportFileTask,
  watchInbox as coreWatchInbox,
  type WatchInboxOptions as CoreWatchInboxOptions,
  type GetDmarcReportsFromMailboxOptions,
  type SaveCallback,
} from 'tsdmarc';

export type { GetDmarcReportsFromMailboxOptions, SaveCallback } from 'tsdmarc';

/** `watch_inbox()` keyword arguments, connection and callback included. */
export interface WatchInboxOptions extends CoreWatchInboxOptions {
  mailboxConnection: MailboxConnection;
  callback: SaveCallback;
}

export interface ParseReportFilesOptions {
  config: ParserConfig;
  nProcs: number;
  shouldStop?: () => boolean;
}

/** Fetch and parse the reports in a mailbox (`get_dmarc_reports_from_mailbox`). */
export async function getDmarcReportsFromMailbox(
  connection: MailboxConnection,
  options: GetDmarcReportsFromMailboxOptions,
): Promise<ParsingResults> {
  return await coreGetDmarcReportsFromMailbox(connection, options);
}

/** Watch a mailbox for new reports (`watch_inbox`, keyword arguments only). */
export async function watchInbox(options: WatchInboxOptions): Promise<void> {
  const { mailboxConnection, callback, ...watchOptions } = options;
  await coreWatchInbox(mailboxConnection, callback, watchOptions);
}

/**
 * Parse report files with `nProcs` worker threads, yielding
 * `[path, result]` in input order; a failure is yielded as the error.
 * `shouldStop` is checked after each result (parsedmarc's
 * `parallel_map(_parse_report_file_job, ...)`).
 */
export function parseReportFiles(
  filePaths: readonly string[],
  options: ParseReportFilesOptions,
): AsyncGenerator<[string, ParsedReport | Error]> {
  return parallelMap<string, [string, ParsedReport | Error]>(
    parseReportFileTask(options.config),
    filePaths,
    options.nProcs,
    {
      shouldStop: options.shouldStop ?? null,
      // A worker that dies on one file (parsedmarc: BrokenProcessPool for
      // every file left) fails only that file.
      onJobError: (error, filePath) => [
        filePath,
        error instanceof Error ? error : new Error(String(error)),
      ],
    },
  );
}
