// Tests for mailbox/reports.ts, ported from parsedmarc's tests/test_init.py:
// TestGetDmarcReportsFromMailboxValidation,
// TestMigrateForensicArchiveFolderErrorHandling,
// TestMigrateForensicArchiveFolderMaildir,
// TestGetDmarcReportsFromMailboxMaildir,
// TestGetDmarcReportsFromMailboxMaildirSaveCallback,
// TestGetDmarcReportsFromMailboxMaildirBatchSizeZeroRecursion and
// TestWatchInboxMaildir, on real Maildirs in temp directories with the real
// samples. Extra tests cover the `kind`-dependent branches (parsedmarc's
// isinstance checks) with small in-memory connections.
//
// tests/test_mail.py is not ported: it guards parsedmarc.mail's lazy
// optional imports (placeholder Gmail/Graph classes when an extra is not
// installed). Here those backends are separate packages the core never
// imports, so there is nothing to guard.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createParserConfig,
  type ParserConfig,
  SEEN_AGGREGATE_REPORT_IDS,
} from '../config';
import { emailTooLargeError, InvalidIPinfoAPIKey } from '../errors';
import { captureLogs, DEBUG, ERROR, type LogCapture, WARNING } from '../log';
import type * as ParallelModule from '../parallel';
import type { ParallelTask } from '../parallel';
import type * as ReportEmailModule from '../report-email';
import { samplePath } from '../test/fixtures';
import type { ParsedReport, ParsingResults } from '../types';
import { ValueError } from '../utils/email';
import { configureIpinfoApi } from '../utils/ip-info';
import { HeaderWriteError, RecursionError } from '../utils/py-email/errors';
import {
  type FetchMessageOptions,
  type FetchMessagesOptions,
  type MailboxKind,
  MailboxConnection,
  type MessageId,
  type WatchOptions,
} from './base';
import { MaildirConnection } from './maildir';
import {
  disposeInvalidMessage,
  FAILED_SAVE_ATTEMPTS,
  fetchMailboxMessage,
  getDmarcReportsFromMailbox,
  type GetDmarcReportsFromMailboxOptions,
  migrateForensicArchiveFolder,
  watchInbox,
} from './reports';

const AGGREGATE = samplePath('aggregate/twilight.eml');
const FAILURE = samplePath('failure/dmarc_ruf_report_linkedin.eml');
const SMTP_TLS = samplePath('smtp_tls/google.com_smtp_tls_report.eml');
const emailJob = vi.hoisted(() => ({ name: null as string | null }));

const parsedEmail = vi.hoisted(() => ({
  fixed: null as ParsedReport | null,
}));

// Stands in for parsing where a test needs a lot of reports quickly.
vi.mock('../report-email', async importOriginal => {
  const actual = await importOriginal<typeof ReportEmailModule>();
  return {
    ...actual,
    parseReportEmail: async (
      ...args: Parameters<typeof actual.parseReportEmail>
    ): Promise<ParsedReport> =>
      parsedEmail.fixed ?? (await actual.parseReportEmail(...args)),
  };
});

// Runs a fixture job in the real workers in place of `parseReportEmailJob`.
vi.mock('../parallel', async importOriginal => {
  const actual = await importOriginal<typeof ParallelModule>();
  return {
    ...actual,
    parseReportEmailTask: (config: ParserConfig): ParallelTask =>
      emailJob.name === null
        ? actual.parseReportEmailTask(config)
        : {
            module: new URL(
              '../__fixtures__/parallel/jobs.ts',
              import.meta.url,
            ),
            name: emailJob.name,
            config,
          },
  };
});

const JUNK = Buffer.from(
  'From: noise@example.com\nSubject: not a report\n\nplain text\n',
);

let tmp: string;
let maildirPath: string;
let capture: LogCapture | null = null;
let deliveries = 0;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'tsdmarc-reports-'));
  maildirPath = path.join(tmp, 'Maildir');
  makeMaildir(maildirPath);
  // Module-global process state: a report "seen" by an earlier test would
  // be dropped, and a stale retry count would move messages early.
  SEEN_AGGREGATE_REPORT_IDS.clear();
  FAILED_SAVE_ATTEMPTS.clear();
});

afterEach(() => {
  capture?.restore();
  capture = null;
  FAILED_SAVE_ATTEMPTS.clear();
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

function makeMaildir(dir: string): void {
  for (const subdir of ['cur', 'new', 'tmp']) {
    mkdirSync(path.join(dir, subdir), { recursive: true });
  }
}

/** Deliver like Python's `mailbox.Maildir.add()`: a file in `new/`. */
function deliverTo(dir: string, source: string | Buffer): void {
  const raw = typeof source === 'string' ? readFileSync(source) : source;
  deliveries += 1;
  writeFileSync(
    path.join(dir, 'new', `1761300000.M${deliveries}P1Q${deliveries}.testhost`),
    raw,
  );
}

function deliver(source: string | Buffer): void {
  deliverTo(maildirPath, source);
}

function connect(): MaildirConnection {
  return new MaildirConnection(maildirPath, { maildirCreate: true });
}

async function run(
  options: GetDmarcReportsFromMailboxOptions = {},
  connection: MaildirConnection = connect(),
): Promise<[MaildirConnection, ParsingResults]> {
  const result = await getDmarcReportsFromMailbox(connection, {
    offline: true,
    ...options,
  });
  return [connection, result];
}

async function count(
  connection: MailboxConnection,
  folder: string,
): Promise<number> {
  return (await connection.fetchMessages(folder)).length;
}

const fail = (): boolean => false;

/** A Maildir connection whose first delete and/or move throws. */
class FailingDisposalMaildirConnection extends MaildirConnection {
  private failDelete: boolean;
  private failMove: boolean;

  constructor(dir: string, { failDelete = false, failMove = false } = {}) {
    super(dir, { maildirCreate: true });
    this.failDelete = failDelete;
    this.failMove = failMove;
  }

  override async deleteMessage(messageId: MessageId): Promise<void> {
    if (this.failDelete) {
      this.failDelete = false;
      throw new Error('server said no');
    }
    await super.deleteMessage(messageId);
  }

  override async moveMessage(
    messageId: MessageId,
    folderName: string,
  ): Promise<void> {
    if (this.failMove) {
      this.failMove = false;
      throw new Error('server said no');
    }
    await super.moveMessage(messageId, folderName);
  }
}

/** A Maildir connection whose folderExists() always throws. */
class UncreatableFolderMaildirConnection extends MaildirConnection {
  override folderExists(_folderName: string): Promise<boolean> {
    return Promise.reject(new Error('server said no'));
  }
}

/** Delivers one extra message right after the first fetchMessages() call. */
class MidRunArrivalMaildirConnection extends MaildirConnection {
  private deliveredExtra = false;

  constructor(
    private readonly dir: string,
    private readonly extraSource: string,
  ) {
    super(dir, { maildirCreate: true });
  }

  override async fetchMessages(
    reportsFolder: string,
    options?: FetchMessagesOptions,
  ): Promise<MessageId[]> {
    const result = await super.fetchMessages(reportsFolder, options);
    if (!this.deliveredExtra) {
      this.deliveredExtra = true;
      deliverTo(this.dir, this.extraSource);
    }
    return result;
  }
}

/** A Maildir connection whose watch() runs exactly one check, letting errors through. */
class SingleCheckMaildirConnection extends MaildirConnection {
  override async watch(options: WatchOptions): Promise<void> {
    await options.checkCallback(this);
  }
}

/** In-memory backend of any kind, recording what it is asked to do. */
class FakeConnection extends MailboxConnection {
  readonly kind: MailboxKind;
  readonly folders = new Map<string, MessageId[]>();
  readonly contents = new Map<string, string>();
  readonly fetchMessagesCalls: [string, FetchMessagesOptions | undefined][] =
    [];
  readonly fetchMessageCalls: [MessageId, FetchMessageOptions | undefined][] =
    [];
  readonly deleted: MessageId[] = [];
  readonly moved: [MessageId, string][] = [];
  readonly watchCalls: WatchOptions[] = [];
  keepalives = 0;

  constructor(kind: MailboxKind, inbox: Record<string, string> = {}) {
    super();
    this.kind = kind;
    this.folders.set('INBOX', Object.keys(inbox));
    for (const [id, content] of Object.entries(inbox)) {
      this.contents.set(id, content);
    }
  }

  override folderExists(name: string): Promise<boolean> {
    return Promise.resolve(this.folders.has(name));
  }

  override createFolder(name: string): Promise<void> {
    if (!this.folders.has(name)) {
      this.folders.set(name, []);
    }
    return Promise.resolve();
  }

  override fetchMessages(
    folder: string,
    options?: FetchMessagesOptions,
  ): Promise<MessageId[]> {
    this.fetchMessagesCalls.push([folder, options]);
    return Promise.resolve([...(this.folders.get(folder) ?? [])]);
  }

  override fetchMessage(
    messageId: MessageId,
    options?: FetchMessageOptions,
  ): Promise<string> {
    this.fetchMessageCalls.push([messageId, options]);
    return Promise.resolve(this.contents.get(String(messageId)) ?? '');
  }

  private remove(messageId: MessageId): void {
    for (const messages of this.folders.values()) {
      const index = messages.findIndex(id => String(id) === String(messageId));
      if (index !== -1) {
        messages.splice(index, 1);
      }
    }
  }

  override deleteMessage(messageId: MessageId): Promise<void> {
    this.deleted.push(messageId);
    this.remove(messageId);
    return Promise.resolve();
  }

  override moveMessage(messageId: MessageId, folder: string): Promise<void> {
    this.moved.push([messageId, folder]);
    this.remove(messageId);
    this.folders.get(folder)?.push(messageId);
    return Promise.resolve();
  }

  override keepalive(): Promise<void> {
    this.keepalives += 1;
    return Promise.resolve();
  }

  override watch(options: WatchOptions): Promise<void> {
    this.watchCalls.push(options);
    return Promise.resolve();
  }
}

/** An IMAP backend whose NOOP fails until `failKeepalive` is cleared. */
class FailingKeepaliveConnection extends FakeConnection {
  failKeepalive = true;

  constructor(inbox: Record<string, string>) {
    super('imap', inbox);
  }

  override keepalive(): Promise<void> {
    this.keepalives += 1;
    return this.failKeepalive
      ? Promise.reject(new Error('NOOP failed'))
      : Promise.resolve();
  }
}

/** A gzipped aggregate report email, long enough to reach keepalive with `records` > 20. */
function aggregateEmail({
  reportId = 'id-1',
  domain = 'a.example',
  begin = 1_700_000_000,
  records = 1,
} = {}): string {
  const record = (index: number): string =>
    `<record><row><source_ip>192.0.2.${(index % 250) + 1}</source_ip><count>1</count>` +
    '<policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>' +
    `<identifiers><header_from>${domain}</header_from></identifiers>` +
    `<auth_results><spf><domain>${domain}</domain><result>pass</result></spf></auth_results></record>`;
  const xml =
    '<?xml version="1.0"?><feedback><report_metadata><org_name>rep.example</org_name>' +
    `<email>r@rep.example</email><report_id>${reportId}</report_id>` +
    `<date_range><begin>${begin}</begin><end>${begin + 86_399}</end></date_range></report_metadata>` +
    `<policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><sp>none</sp><pct>100</pct></policy_published>` +
    `${Array.from({ length: records }, (_, index) => record(index)).join('')}</feedback>`;
  return [
    'From: r@rep.example',
    'To: d@a.example',
    'Subject: Report',
    'Message-ID: <1@rep.example>',
    'Date: Mon, 1 Jan 2024 00:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: application/gzip',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="r.xml.gz"',
    '',
    gzipSync(xml).toString('base64'),
    '',
  ].join('\n');
}

const sample = (file: string): string => readFileSync(file, 'utf-8');

describe('TestGetDmarcReportsFromMailboxValidation', () => {
  const conn = (): FakeConnection => new FakeConnection('imap');

  it('test_delete_and_test_combination_raises', async () => {
    const promise = getDmarcReportsFromMailbox(conn(), {
      delete: true,
      test: true,
    });
    await expect(promise).rejects.toBeInstanceOf(ValueError);
    await expect(promise).rejects.toThrow('mutually exclusive');
  });

  it('test_inherited_delete_with_test_raises', async () => {
    await expect(
      getDmarcReportsFromMailbox(conn(), {
        delete: true,
        deleteAggregate: false,
        test: true,
      }),
    ).rejects.toThrow('mutually exclusive');
  });

  for (const flag of [
    'deleteAggregate',
    'deleteFailure',
    'deleteSmtpTls',
    'deleteInvalid',
  ] as const) {
    it(`test_explicit_per_type_delete_with_test_raises (${flag})`, async () => {
      await expect(
        getDmarcReportsFromMailbox(conn(), {
          test: true,
          deleteAggregate: flag === 'deleteAggregate',
          deleteFailure: flag === 'deleteFailure',
          deleteSmtpTls: flag === 'deleteSmtpTls',
          deleteInvalid: flag === 'deleteInvalid',
        }),
      ).rejects.toThrow('mutually exclusive');
    });
  }

  it('test_none_connection_raises', async () => {
    const promise = getDmarcReportsFromMailbox(
      null as unknown as MailboxConnection,
    );
    await expect(promise).rejects.toBeInstanceOf(ValueError);
    await expect(promise).rejects.toThrow(/connection/iu);
  });

  it('test_negative_max_unsaved_retries_raises', async () => {
    await expect(
      getDmarcReportsFromMailbox(conn(), { maxUnsavedRetries: -1 }),
    ).rejects.toThrow('max_unsaved_retries');
  });

  it('test_watch_inbox_negative_max_unsaved_retries_raises', async () => {
    const connection = conn();
    await expect(
      watchInbox(connection, () => undefined, { maxUnsavedRetries: -1 }),
    ).rejects.toThrow('max_unsaved_retries');
    expect(connection.watchCalls).toEqual([]);
  });
});

describe('TestMigrateForensicArchiveFolderErrorHandling', () => {
  it('test_backend_error_is_warned_not_raised', async () => {
    class RenameFails extends FakeConnection {
      override folderExists(name: string): Promise<boolean> {
        return Promise.resolve(name.endsWith('/Forensic'));
      }

      override renameFolder(): Promise<void> {
        return Promise.reject(new Error('server said no'));
      }
    }
    capture = captureLogs(undefined, WARNING);
    await migrateForensicArchiveFolder(new RenameFails('imap'), 'Archive');
    expect(capture.output).toContain(
      'WARNING:tsdmarc:Could not migrate legacy archive folder Archive/Forensic to Archive/Failure: server said no',
    );
  });
});

describe('TestMigrateForensicArchiveFolderMaildir', () => {
  let conn: MaildirConnection;

  beforeEach(async () => {
    conn = connect();
    await conn.createFolder('Archive');
  });

  async function seed(folder: string, subject: string): Promise<void> {
    await conn.createFolder(folder);
    deliverTo(
      path.join(maildirPath, `.${folder}`),
      Buffer.from(
        `From: reporter@example.com\nTo: dmarc@example.org\nSubject: ${subject}\n\nbody\n`,
      ),
    );
  }

  it('test_rename_moves_legacy_folder_and_its_messages', async () => {
    await seed('Archive/Forensic', 'legacy failure report');
    expect(await conn.folderExists('Archive/Forensic')).toBe(true);
    expect(await conn.folderExists('Archive/Failure')).toBe(false);

    await migrateForensicArchiveFolder(conn, 'Archive');

    expect(await conn.folderExists('Archive/Forensic')).toBe(false);
    expect(await conn.folderExists('Archive/Failure')).toBe(true);
    expect(await count(conn, 'Archive/Failure')).toBe(1);
  });

  it('test_merge_consolidates_messages_when_both_exist', async () => {
    await seed('Archive/Failure', 'post-rename failure report');
    await seed('Archive/Forensic', 'legacy failure report');

    await migrateForensicArchiveFolder(conn, 'Archive');

    expect(await conn.folderExists('Archive/Forensic')).toBe(false);
    expect(await conn.folderExists('Archive/Failure')).toBe(true);
    expect(await count(conn, 'Archive/Failure')).toBe(2);
  });

  it('test_no_legacy_folder_is_noop', async () => {
    await migrateForensicArchiveFolder(conn, 'Archive');
    expect(await conn.folderExists('Archive/Forensic')).toBe(false);
    expect(await conn.folderExists('Archive/Failure')).toBe(false);
  });

  it('test_orchestration_migrates_before_creating_folders', async () => {
    await seed('Archive/Forensic', 'legacy failure report');

    const result = await getDmarcReportsFromMailbox(conn);

    expect(await conn.folderExists('Archive/Forensic')).toBe(false);
    expect(await conn.folderExists('Archive/Failure')).toBe(true);
    expect(await count(conn, 'Archive/Failure')).toBe(1);
    expect(result.failureReports).toEqual([]);
  });
});

describe('TestGetDmarcReportsFromMailboxMaildir', () => {
  async function assertEachReportTypeRouted(
    conn: MaildirConnection,
    result: ParsingResults,
  ): Promise<void> {
    expect(result.aggregateReports).toHaveLength(1);
    expect(result.failureReports).toHaveLength(1);
    expect(result.smtpTlsReports).toHaveLength(1);

    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Aggregate')).toBe(1);
    expect(await count(conn, 'Archive/Failure')).toBe(1);
    expect(await count(conn, 'Archive/SMTP-TLS')).toBe(1);
    expect(await count(conn, 'Archive/Invalid')).toBe(1);
  }

  it('test_each_report_type_routed_to_its_archive_subfolder', async () => {
    for (const source of [AGGREGATE, FAILURE, SMTP_TLS, JUNK]) {
      deliver(source);
    }
    const [conn, result] = await run();
    await assertEachReportTypeRouted(conn, result);
  });

  it('test_each_report_type_routed_to_its_archive_subfolder_parallel', async () => {
    for (const source of [AGGREGATE, FAILURE, SMTP_TLS, JUNK]) {
      deliver(source);
    }
    const [conn, result] = await run({ nProcs: 2 });
    await assertEachReportTypeRouted(conn, result);
  });

  it('test_delete_mode_removes_processed_messages', async () => {
    deliver(FAILURE);
    const [conn, result] = await run({ delete: true });
    expect(result.failureReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await conn.fetchMessages('Archive/Failure')).toEqual([]);
  });

  it('test_delete_mode_removes_processed_messages_parallel', async () => {
    deliver(FAILURE);
    deliver(AGGREGATE);
    const [conn, result] = await run({ delete: true, nProcs: 2 });
    expect(result.failureReports).toHaveLength(1);
    expect(result.aggregateReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await conn.fetchMessages('Archive/Failure')).toEqual([]);
    expect(await conn.fetchMessages('Archive/Aggregate')).toEqual([]);
  });

  it('test_delete_aggregate_overrides_delete_false', async () => {
    for (const source of [AGGREGATE, FAILURE, SMTP_TLS, JUNK]) {
      deliver(source);
    }
    const [conn, result] = await run({ deleteAggregate: true });
    expect(result.aggregateReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await conn.fetchMessages('Archive/Aggregate')).toEqual([]);
    expect(await count(conn, 'Archive/Failure')).toBe(1);
    expect(await count(conn, 'Archive/SMTP-TLS')).toBe(1);
    expect(await count(conn, 'Archive/Invalid')).toBe(1);
  });

  it('test_delete_failure_false_overrides_delete_true', async () => {
    for (const source of [AGGREGATE, FAILURE, SMTP_TLS, JUNK]) {
      deliver(source);
    }
    const [conn, result] = await run({ delete: true, deleteFailure: false });
    expect(result.aggregateReports).toHaveLength(1);
    expect(result.failureReports).toHaveLength(1);
    expect(result.smtpTlsReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Failure')).toBe(1);
    expect(await conn.fetchMessages('Archive/Aggregate')).toEqual([]);
    expect(await conn.fetchMessages('Archive/SMTP-TLS')).toEqual([]);
    expect(await conn.fetchMessages('Archive/Invalid')).toEqual([]);
  });

  it('test_delete_invalid_true_deletes_unparseable_messages', async () => {
    deliver(FAILURE);
    deliver(JUNK);
    const [conn, result] = await run({ deleteInvalid: true });
    expect(result.failureReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await conn.fetchMessages('Archive/Invalid')).toEqual([]);
    expect(await count(conn, 'Archive/Failure')).toBe(1);
  });

  it('test_delete_invalid_false_keeps_unparseable_when_delete_true', async () => {
    deliver(FAILURE);
    deliver(JUNK);
    const [conn, result] = await run({ delete: true, deleteInvalid: false });
    expect(result.failureReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Invalid')).toBe(1);
    expect(await conn.fetchMessages('Archive/Failure')).toEqual([]);
  });

  it('test_per_type_delete_flags_parallel', async () => {
    deliver(AGGREGATE);
    deliver(FAILURE);
    deliver(JUNK);
    const [conn, result] = await run({
      nProcs: 2,
      delete: true,
      deleteFailure: false,
      deleteInvalid: false,
    });
    expect(result.aggregateReports).toHaveLength(1);
    expect(result.failureReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Failure')).toBe(1);
    expect(await count(conn, 'Archive/Invalid')).toBe(1);
    expect(await conn.fetchMessages('Archive/Aggregate')).toEqual([]);
  });

  it('test_test_mode_allowed_when_all_delete_flags_explicitly_false', async () => {
    deliver(FAILURE);
    const [conn, result] = await run({
      delete: true,
      deleteAggregate: false,
      deleteFailure: false,
      deleteSmtpTls: false,
      deleteInvalid: false,
      test: true,
    });
    expect(result.failureReports).toHaveLength(1);
    expect(await count(conn, 'INBOX')).toBe(1);
    expect(await conn.folderExists('Archive/Failure')).toBe(false);
  });

  it('test_test_mode_parses_without_moving_or_creating_folders', async () => {
    deliver(FAILURE);
    const [conn, result] = await run({ test: true });
    expect(result.failureReports).toHaveLength(1);
    expect(await count(conn, 'INBOX')).toBe(1);
    expect(await conn.folderExists('Archive/Failure')).toBe(false);
  });

  it('test_test_mode_parses_without_moving_or_creating_folders_parallel', async () => {
    deliver(FAILURE);
    deliver(AGGREGATE);
    const [conn, result] = await run({ test: true, nProcs: 2 });
    expect(result.failureReports).toHaveLength(1);
    expect(result.aggregateReports).toHaveLength(1);
    expect(await count(conn, 'INBOX')).toBe(2);
    expect(await conn.folderExists('Archive/Failure')).toBe(false);
    expect(await conn.folderExists('Archive/Aggregate')).toBe(false);
  });

  it('test_duplicate_aggregate_parallel_archives_both_messages', async () => {
    deliver(AGGREGATE);
    deliver(AGGREGATE);
    const [conn, result] = await run({ nProcs: 2 });
    expect(result.aggregateReports).toHaveLength(1);
    expect(await count(conn, 'Archive/Aggregate')).toBe(2);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
  });

  it('test_delete_error_is_logged_and_disposal_continues', async () => {
    deliver(AGGREGATE);
    deliver(SMTP_TLS);
    const conn = new FailingDisposalMaildirConnection(maildirPath, {
      failDelete: true,
    });

    capture = captureLogs(undefined, ERROR);
    const [, result] = await run({ delete: true }, conn);

    expect(result.aggregateReports).toHaveLength(1);
    expect(result.smtpTlsReports).toHaveLength(1);
    expect(
      capture.output.some(line =>
        line.includes('Mailbox error: Error deleting message UID'),
      ),
    ).toBe(true);
    expect(await count(conn, 'INBOX')).toBe(1);
    expect(await conn.fetchMessages('Archive/Aggregate')).toEqual([]);
    expect(await conn.fetchMessages('Archive/SMTP-TLS')).toEqual([]);
  });

  it('test_move_error_is_logged_and_disposal_continues', async () => {
    deliver(AGGREGATE);
    deliver(SMTP_TLS);
    const conn = new FailingDisposalMaildirConnection(maildirPath, {
      failMove: true,
    });

    capture = captureLogs(undefined, ERROR);
    const [, result] = await run({}, conn);

    expect(result.aggregateReports).toHaveLength(1);
    expect(result.smtpTlsReports).toHaveLength(1);
    expect(
      capture.output.some(line =>
        line.includes('Mailbox error: Error moving message UID'),
      ),
    ).toBe(true);
    expect(await count(conn, 'INBOX')).toBe(1);
    expect(await conn.fetchMessages('Archive/Aggregate')).toEqual([]);
    expect(await count(conn, 'Archive/SMTP-TLS')).toBe(1);
  });
});

describe('TestGetDmarcReportsFromMailboxMaildirSaveCallback', () => {
  it('test_failed_save_callback_leaves_messages_in_inbox', async () => {
    deliver(AGGREGATE);
    deliver(FAILURE);
    const [conn, result] = await run({ saveCallback: fail });
    expect(result.aggregateReports).toHaveLength(1);
    expect(result.failureReports).toHaveLength(1);
    expect(await count(conn, 'INBOX')).toBe(2);
    expect(await conn.fetchMessages('Archive/Aggregate')).toEqual([]);
    expect(await conn.fetchMessages('Archive/Failure')).toEqual([]);
  });

  it('test_failed_save_logs_an_error_naming_the_reports_folder', async () => {
    deliver(AGGREGATE);
    capture = captureLogs(undefined, ERROR);
    await run({ saveCallback: fail });
    expect(capture.output).toContain(
      'ERROR:tsdmarc:Reports were not saved: leaving 1 message(s) in INBOX to retry on the next run or check (failed attempt 1 of 3)',
    );
  });

  it('test_failed_save_then_retry_is_not_deduplicated', async () => {
    deliver(AGGREGATE);
    let [conn, result] = await run({ saveCallback: fail });
    expect(result.aggregateReports).toHaveLength(1);
    expect(await count(conn, 'INBOX')).toBe(1);

    const received: ParsingResults[] = [];
    [conn, result] = await run({
      saveCallback: batch => {
        received.push(batch);
      },
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.aggregateReports).toHaveLength(1);
    expect(result.aggregateReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Aggregate')).toBe(1);
  });

  const boom = (): never => {
    throw new Error('sink is down');
  };

  it('test_save_callback_exception_leaves_messages', async () => {
    deliver(AGGREGATE);
    await expect(run({ saveCallback: boom })).rejects.toThrow('sink is down');

    expect(await count(connect(), 'INBOX')).toBe(1);
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(1);
    const [, result] = await run({ saveCallback: null });
    expect(result.aggregateReports).toHaveLength(1);
  });

  it('test_save_callback_exception_still_bounded_by_the_retry_cap', async () => {
    deliver(AGGREGATE);
    await expect(
      run({ saveCallback: boom, maxUnsavedRetries: 0 }),
    ).rejects.toThrow('sink is down');

    const conn = connect();
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Unsaved')).toBe(1);
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(0);
  });

  it('async save callbacks are awaited (rejection = unsaved, rethrown)', async () => {
    deliver(AGGREGATE);
    await expect(
      run({
        saveCallback: () => Promise.reject(new Error('async sink is down')),
      }),
    ).rejects.toThrow('async sink is down');
    expect(await count(connect(), 'INBOX')).toBe(1);

    const [conn] = await run({ saveCallback: () => Promise.resolve(false) });
    expect(await count(conn, 'INBOX')).toBe(1);
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(1);
  });

  it('test_successful_save_callback_archives_messages', async () => {
    deliver(AGGREGATE);
    deliver(FAILURE);
    deliver(SMTP_TLS);
    const conn = connect();
    const received: [ParsingResults, number][] = [];

    const [, result] = await run(
      {
        saveCallback: async batch => {
          // Nothing is archived yet: the caller can still veto it.
          received.push([batch, await count(conn, 'INBOX')]);
        },
      },
      conn,
    );

    expect(received).toHaveLength(1);
    const [batch, inboxCountAtCallbackTime] = received[0] as [
      ParsingResults,
      number,
    ];
    expect(batch.aggregateReports).toHaveLength(1);
    expect(batch.failureReports).toHaveLength(1);
    expect(batch.smtpTlsReports).toHaveLength(1);
    expect(inboxCountAtCallbackTime).toBe(3);

    expect(result.aggregateReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Aggregate')).toBe(1);
    expect(await count(conn, 'Archive/Failure')).toBe(1);
    expect(await count(conn, 'Archive/SMTP-TLS')).toBe(1);
  });

  it('test_failed_save_callback_with_delete_does_not_delete', async () => {
    deliver(FAILURE);
    const [conn, result] = await run({ delete: true, saveCallback: fail });
    expect(result.failureReports).toHaveLength(1);
    expect(await count(conn, 'INBOX')).toBe(1);
  });

  it('test_invalid_message_still_filed_when_save_fails', async () => {
    deliver(JUNK);
    deliver(AGGREGATE);
    const [conn, result] = await run({ saveCallback: fail });
    expect(result.aggregateReports).toHaveLength(1);
    expect(await count(conn, 'Archive/Invalid')).toBe(1);
    expect(await count(conn, 'INBOX')).toBe(1);
  });

  it('test_unsaved_folder_created_only_with_a_save_callback', async () => {
    deliver(AGGREGATE);
    const [conn] = await run({ saveCallback: () => undefined });
    expect(await conn.folderExists('Archive/Unsaved')).toBe(true);

    const otherMaildir = path.join(tmp, 'MaildirNoCallback');
    makeMaildir(otherMaildir);
    deliverTo(otherMaildir, FAILURE);
    const otherConn = new MaildirConnection(otherMaildir, {
      maildirCreate: true,
    });
    await getDmarcReportsFromMailbox(otherConn, { offline: true });
    expect(await otherConn.folderExists('Archive/Failure')).toBe(true);
    expect(await otherConn.folderExists('Archive/Unsaved')).toBe(false);
  });

  it('test_repeated_failures_move_the_message_to_unsaved', async () => {
    deliver(AGGREGATE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [conn] = await run({ saveCallback: fail });
      expect(await count(conn, 'INBOX')).toBe(1);
      expect(await conn.fetchMessages('Archive/Unsaved')).toEqual([]);
    }

    capture = captureLogs(undefined, ERROR);
    const [conn] = await run({ saveCallback: fail });

    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Unsaved')).toBe(1);
    expect(capture.output).toContain(
      'ERROR:tsdmarc:Reports were not saved after 3 attempt(s): moving 1 message(s) from INBOX to Archive/Unsaved instead of retrying them further. They are never deleted -- fix the output destination, then move them back to INBOX',
    );
  });

  it('test_max_unsaved_retries_zero_moves_on_the_first_failure', async () => {
    deliver(AGGREGATE);
    const [conn] = await run({ saveCallback: fail, maxUnsavedRetries: 0 });
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Unsaved')).toBe(1);
  });

  it('test_unsaved_messages_are_moved_not_deleted', async () => {
    deliver(AGGREGATE);
    const [conn] = await run({
      saveCallback: fail,
      maxUnsavedRetries: 0,
      delete: true,
    });
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Unsaved')).toBe(1);
  });

  it('test_successful_save_clears_the_retry_counters', async () => {
    deliver(AGGREGATE);
    await run({ saveCallback: fail });
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(1);

    const [conn] = await run({ saveCallback: () => true });
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(0);
    expect(await count(conn, 'Archive/Aggregate')).toBe(1);
  });

  it('test_test_mode_invokes_the_callback_without_touching_anything', async () => {
    deliver(AGGREGATE);
    const received: ParsingResults[] = [];
    const recordAndFail = (batch: ParsingResults): boolean => {
      received.push(batch);
      return false;
    };
    let conn = connect();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      [conn] = await run({
        saveCallback: recordAndFail,
        maxUnsavedRetries: 0,
        test: true,
      });
    }
    expect(received).toHaveLength(2);
    expect(received[0]?.aggregateReports).toHaveLength(1);
    expect(await count(conn, 'INBOX')).toBe(1);
    expect(await conn.folderExists('Archive/Unsaved')).toBe(false);
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(0);
  });

  it('test_unsaved_folder_is_created_when_folder_creation_was_skipped', async () => {
    deliver(AGGREGATE);
    const conn = connect();
    await conn.createFolder('Archive');
    await run(
      { saveCallback: fail, maxUnsavedRetries: 0, createFolders: false },
      conn,
    );
    expect(await count(conn, 'Archive/Unsaved')).toBe(1);
  });

  it('test_unsaved_folder_check_failure_is_logged_not_raised', async () => {
    deliver(AGGREGATE);
    const conn = new UncreatableFolderMaildirConnection(maildirPath, {
      maildirCreate: true,
    });
    await conn.createFolder('Archive');

    capture = captureLogs(undefined, WARNING);
    await run(
      { saveCallback: fail, maxUnsavedRetries: 0, createFolders: false },
      conn,
    );

    expect(capture.output).toContain(
      'WARNING:tsdmarc:Could not create folder Archive/Unsaved: server said no',
    );
    expect(await count(conn, 'Archive/Unsaved')).toBe(1);
  });

  it('test_failed_move_to_unsaved_is_logged_and_leaves_the_message', async () => {
    deliver(AGGREGATE);
    const conn = new FailingDisposalMaildirConnection(maildirPath, {
      failMove: true,
    });
    capture = captureLogs(undefined, ERROR);
    await run({ saveCallback: fail, maxUnsavedRetries: 0 }, conn);
    expect(
      capture.output.some(line =>
        line.includes('Mailbox error: Error moving message UID'),
      ),
    ).toBe(true);
    expect(await count(conn, 'INBOX')).toBe(1);
    expect(await conn.fetchMessages('Archive/Unsaved')).toEqual([]);
  });

  it('test_failed_move_keeps_the_counter_so_the_move_is_retried', async () => {
    deliver(AGGREGATE);
    let [conn] = await run({ saveCallback: fail, maxUnsavedRetries: 1 });
    expect(await count(conn, 'INBOX')).toBe(1);

    const failingConn = new FailingDisposalMaildirConnection(maildirPath, {
      failMove: true,
    });
    capture = captureLogs(undefined, ERROR);
    await run({ saveCallback: fail, maxUnsavedRetries: 1 }, failingConn);
    expect(capture.output.length).toBeGreaterThan(0);
    expect(await count(failingConn, 'INBOX')).toBe(1);
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(1);

    [conn] = await run({ saveCallback: fail, maxUnsavedRetries: 1 });
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Unsaved')).toBe(1);
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(0);
  });

  it('test_failed_save_skips_the_batch_size_zero_re_check', async () => {
    deliver(AGGREGATE);
    const [conn, result] = await run({
      saveCallback: fail,
      batchSize: 0,
      maxUnsavedRetries: 1,
    });
    expect(result.aggregateReports).toHaveLength(1);
    expect(await count(conn, 'INBOX')).toBe(1);
    expect(await conn.fetchMessages('Archive/Unsaved')).toEqual([]);
  });

  it('test_save_callback_receives_each_batch_separately', async () => {
    deliver(AGGREGATE);
    const conn = new MidRunArrivalMaildirConnection(maildirPath, SMTP_TLS);
    const received: ParsingResults[] = [];

    const [, result] = await run(
      {
        saveCallback: batch => {
          received.push(batch);
        },
        batchSize: 0,
      },
      conn,
    );

    expect(received).toHaveLength(2);
    expect(received[0]?.aggregateReports).toHaveLength(1);
    expect(received[0]?.smtpTlsReports).toEqual([]);
    expect(received[1]?.aggregateReports).toEqual([]);
    expect(received[1]?.smtpTlsReports).toHaveLength(1);
    expect(result.aggregateReports).toHaveLength(1);
    expect(result.smtpTlsReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
  });

  it('test_failed_save_callback_parallel', async () => {
    deliver(AGGREGATE);
    deliver(FAILURE);

    let [conn, result] = await run({ saveCallback: fail, nProcs: 2 });
    expect(result.aggregateReports).toHaveLength(1);
    expect(result.failureReports).toHaveLength(1);
    expect(await count(conn, 'INBOX')).toBe(2);

    [conn, result] = await run({ saveCallback: null, nProcs: 2 });
    expect(result.aggregateReports).toHaveLength(1);
    expect(await count(conn, 'Archive/Aggregate')).toBe(1);
  });
});

describe('TestGetDmarcReportsFromMailboxMaildirBatchSizeZeroRecursion', () => {
  beforeEach(() => {
    deliver(AGGREGATE);
    deliver(FAILURE);
  });

  it('test_batch_size_zero_recursion_threads_n_procs', async () => {
    const conn = new MidRunArrivalMaildirConnection(maildirPath, SMTP_TLS);
    const [, result] = await run({ nProcs: 2, batchSize: 0 }, conn);
    expect(result.aggregateReports).toHaveLength(1);
    expect(result.failureReports).toHaveLength(1);
    expect(result.smtpTlsReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
  });

  it('test_batch_size_zero_recursion_threads_per_type_delete', async () => {
    const conn = new MidRunArrivalMaildirConnection(maildirPath, SMTP_TLS);
    const [, result] = await run({ batchSize: 0, deleteSmtpTls: true }, conn);
    expect(result.smtpTlsReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await conn.fetchMessages('Archive/SMTP-TLS')).toEqual([]);
    expect(await count(conn, 'Archive/Aggregate')).toBe(1);
    expect(await count(conn, 'Archive/Failure')).toBe(1);
  });
});

describe('TestWatchInboxMaildir', () => {
  beforeEach(() => {
    deliver(FAILURE);
    deliver(JUNK);
  });

  it('test_watch_inbox_forwards_per_type_delete_flags', async () => {
    const conn = new SingleCheckMaildirConnection(maildirPath, {
      maildirCreate: true,
    });
    await conn.createFolder('Archive');
    await conn.createFolder('Archive/Failure');
    const received: ParsingResults[] = [];

    await watchInbox(
      conn,
      batch => {
        received.push(batch);
      },
      { offline: true, delete: true, deleteFailure: false },
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.failureReports).toHaveLength(1);
    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Failure')).toBe(1);
    expect(await conn.folderExists('Archive/Invalid')).toBe(false);
  });

  it('test_watch_inbox_callback_returning_false_defers_the_batch', async () => {
    const conn = new SingleCheckMaildirConnection(maildirPath, {
      maildirCreate: true,
    });
    await conn.createFolder('Archive');
    await conn.createFolder('Archive/Invalid');
    const received: ParsingResults[] = [];

    await watchInbox(
      conn,
      batch => {
        received.push(batch);
        return false;
      },
      { offline: true },
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.failureReports).toHaveLength(1);
    expect(await count(conn, 'INBOX')).toBe(1);
    expect(await conn.fetchMessages('Archive/Failure')).toEqual([]);
    expect(await count(conn, 'Archive/Invalid')).toBe(1);
  });

  it('test_watch_inbox_forwards_max_unsaved_retries', async () => {
    const conn = new SingleCheckMaildirConnection(maildirPath, {
      maildirCreate: true,
    });
    await conn.createFolder('Archive');
    await conn.createFolder('Archive/Invalid');

    await watchInbox(conn, () => false, {
      offline: true,
      maxUnsavedRetries: 0,
    });

    expect(await conn.fetchMessages('INBOX')).toEqual([]);
    expect(await count(conn, 'Archive/Unsaved')).toBe(1);
  });

  it('the real Maildir watch loop logs a throwing callback and stops on abort', async () => {
    const conn = connect();
    await conn.createFolder('Archive');
    await conn.createFolder('Archive/Invalid');
    const controller = new AbortController();
    let calls = 0;
    capture = captureLogs(undefined, WARNING);

    await watchInbox(
      conn,
      () => {
        calls += 1;
        controller.abort();
        throw new Error('sink is down');
      },
      { offline: true, maxUnsavedRetries: 0, signal: controller.signal },
    );

    expect(calls).toBe(1);
    expect(capture.output).toContain(
      'WARNING:tsdmarc:Maildir init error. sink is down',
    );
    // The retry bookkeeping ran before the error reached the watch loop.
    expect(await count(conn, 'Archive/Unsaved')).toBe(1);
  });
});

describe('watchInbox options', () => {
  it('passes checkTimeout, configReloading and signal to watch()', async () => {
    const conn = new FakeConnection('gmail');
    const configReloading = (): boolean => false;
    const { signal } = new AbortController();
    await watchInbox(conn, () => undefined, {
      checkTimeout: 5,
      configReloading,
      signal,
    });
    const [options] = conn.watchCalls;
    expect(options?.checkTimeout).toBe(5);
    expect(options?.configReloading).toBe(configReloading);
    expect(options?.signal).toBe(signal);
  });

  it('omits configReloading when not given, and defaults checkTimeout to 30', async () => {
    const conn = new FakeConnection('gmail');
    await watchInbox(conn, () => undefined);
    const [options] = conn.watchCalls;
    expect(options?.checkTimeout).toBe(30);
    expect(options !== undefined && 'configReloading' in options).toBe(false);
  });
});

describe('kind-dependent branches', () => {
  it('fetchMailboxMessage casts IMAP UIDs to integers and never marks read', async () => {
    const conn = new FakeConnection('imap', { 12: 'x' });
    expect(await fetchMailboxMessage(conn, '12', false)).toEqual([12, 'x']);
    expect(conn.fetchMessageCalls).toEqual([[12, {}]]);
    await expect(fetchMailboxMessage(conn, 'abc', false)).rejects.toThrow(
      'invalid literal for int()',
    );
  });

  for (const kind of ['msgraph', 'maildir'] as const) {
    it(`fetchMailboxMessage marks ${kind} messages read unless testing`, async () => {
      const conn = new FakeConnection(kind, { 7: 'x' });
      expect(await fetchMailboxMessage(conn, 7, false)).toEqual(['7', 'x']);
      await fetchMailboxMessage(conn, '7', true);
      expect(conn.fetchMessageCalls).toEqual([
        ['7', { markRead: true }],
        ['7', { markRead: false }],
      ]);
    });
  }

  it('fetchMailboxMessage passes Gmail IDs as strings with no options but a size limit', async () => {
    const conn = new FakeConnection('gmail', { abc: 'x' });
    expect(await fetchMailboxMessage(conn, 'abc', false)).toEqual(['abc', 'x']);
    expect(conn.fetchMessageCalls).toEqual([['abc', {}]]);
  });

  it('disposeInvalidMessage casts per backend and logs the action', async () => {
    const imap = new FakeConnection('imap', { 5: 'x' });
    const gmail = new FakeConnection('gmail', { 6: 'x' });
    capture = captureLogs(undefined, DEBUG);
    await disposeInvalidMessage(imap, '5', true, 'Archive/Invalid');
    await disposeInvalidMessage(gmail, 6, false, 'Archive/Invalid');
    expect(imap.deleted).toEqual([5]);
    expect(gmail.moved).toEqual([['6', 'Archive/Invalid']]);
    expect(capture.output).toEqual([
      'DEBUG:tsdmarc:Deleting message UID 5',
      'DEBUG:tsdmarc:Moving message UID 6 to Archive/Invalid',
    ]);
  });

  it('processes an IMAP mailbox end to end with integer UIDs', async () => {
    const conn = new FakeConnection('imap', {
      1: sample(AGGREGATE),
      2: JUNK.toString(),
    });
    const result = await getDmarcReportsFromMailbox(conn, { offline: true });
    expect(result.aggregateReports).toHaveLength(1);
    expect(conn.moved).toEqual([
      [2, 'Archive/Invalid'],
      [1, 'Archive/Aggregate'],
    ]);
    expect(conn.fetchMessagesCalls[0]).toEqual([
      'INBOX',
      { batchSize: 10, since: null },
    ]);
  });

  it('batchSize limits how many messages are processed', async () => {
    const conn = new FakeConnection('gmail', {
      a: JUNK.toString(),
      b: JUNK.toString(),
      c: JUNK.toString(),
    });
    capture = captureLogs(undefined, DEBUG);
    await getDmarcReportsFromMailbox(conn, { offline: true, batchSize: 2 });
    expect(conn.moved.map(([id]) => id)).toEqual(['a', 'b']);
    expect(capture.output).toContain('DEBUG:tsdmarc:Processing 2 messages');
  });

  describe('since', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
    });

    const sinceSent = async (
      kind: MailboxKind,
      since: string,
      batchSize = 10,
    ): Promise<FakeConnection> => {
      const conn = new FakeConnection(kind);
      await getDmarcReportsFromMailbox(conn, {
        offline: true,
        since,
        batchSize,
      });
      return conn;
    };

    it('IMAP gets a %d-%b-%Y date and a debug note', async () => {
      capture = captureLogs(undefined, DEBUG);
      const conn = await sinceSent('imap', '2d');
      expect(conn.fetchMessagesCalls[0]?.[1]).toEqual({
        batchSize: 10,
        since: '22-Oct-2026',
      });
      expect(capture.output).toContain(
        "DEBUG:tsdmarc:Only days and weeks values in 'since' option are considered for IMAP connections. Examples: 2d or 1w",
      );
    });

    it('Microsoft Graph gets an ISO timestamp', async () => {
      const conn = await sinceSent('msgraph', '3h');
      expect(conn.fetchMessagesCalls[0]?.[1]?.since).toBe(
        '2026-10-24T09:00:00+00:00',
      );
    });

    it('Gmail gets epoch seconds', async () => {
      const conn = await sinceSent('gmail', '1w');
      expect(conn.fetchMessagesCalls[0]?.[1]?.since).toBe(
        String(Date.parse('2026-10-17T12:00:00Z') / 1000),
      );
    });

    it('minutes and Unicode digits are understood', async () => {
      expect(
        (await sinceSent('msgraph', '30m')).fetchMessagesCalls[0]?.[1]?.since,
      ).toBe('2026-10-24T11:30:00+00:00');
      // Python's \d and int() accept any decimal digit: "١٢h" is 12 hours.
      expect(
        (await sinceSent('msgraph', '١٢h')).fetchMessagesCalls[0]?.[1]?.since,
      ).toBe('2026-10-24T00:00:00+00:00');
    });

    it('an invalid value warns and falls back to one day', async () => {
      capture = captureLogs(undefined, WARNING);
      const conn = await sinceSent('msgraph', 'yesterday');
      expect(conn.fetchMessagesCalls[0]?.[1]?.since).toBe(
        '2026-10-23T12:00:00+00:00',
      );
      expect(capture.output).toEqual([
        "WARNING:tsdmarc:Incorrect format for 'since' option. Provided value: yesterday, expected values: (5m|3h|2d|1w). Ignoring option, fetching messages for last 24hrs. SMTP does not support a time or timezone in since. See https://www.rfc-editor.org/rfc/rfc3501#page-52",
      ]);
    });

    it('Maildir gets the value unchanged', async () => {
      const conn = await sinceSent('maildir', '2d');
      expect(conn.fetchMessagesCalls[0]?.[1]?.since).toBe('2d');
    });

    it('since disables the batchSize limit', async () => {
      const conn = new FakeConnection('maildir', {
        a: JUNK.toString(),
        b: JUNK.toString(),
      });
      await getDmarcReportsFromMailbox(conn, {
        offline: true,
        since: '1d',
        batchSize: 1,
      });
      expect(conn.moved.map(([id]) => id)).toEqual(['a', 'b']);
    });

    it('the batchSize 0 re-check fetches since the current time', async () => {
      const conn = await sinceSent('msgraph', '2d', 0);
      expect(conn.fetchMessagesCalls[1]).toEqual([
        'INBOX',
        { since: '2026-10-24T12:00:00+00:00' },
      ]);
    });
  });
});

// --- Poison messages and size limits (not in parsedmarc) -------------------

/** A message nested deeper than Python's recursion limit lets str(part) go. */
function deeplyNestedMessage(levels: number): string {
  let body = 'a';
  for (let index = 0; index < levels; index += 1) {
    body = `Content-Type: multipart/mixed; boundary=b${index}\r\n\r\n--b${index}\r\n${body}\r\n--b${index}--\r\n`;
  }
  return `From: a@b\r\nSubject: x\r\nMIME-Version: 1.0\r\n${body}`;
}

/** A failure report whose sample has a header Python can't write back. */
const HEADER_WRITE_POISON = [
  'From: a@example.com',
  'Subject: x',
  'Date: Mon, 1 Jan 2024 00:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/report; report-type=feedback-report; boundary=B',
  '',
  '--B',
  'Content-Type: text/plain',
  '',
  'hi',
  '--B',
  'Content-Type: message/feedback-report',
  '',
  'Feedback-Type: auth-failure',
  'Version: 1',
  'Source-IP: 192.0.2.1',
  'Arrival-Date: Mon, 1 Jan 2024 00:00:00 +0000',
  'Reported-Domain: example.com',
  'Authentication-Results: x',
  '',
  '--B',
  'Content-Type: message/rfc822',
  '',
  'From: a@b',
  'X-A: a\u001Cb',
  '',
  'body',
  '--B--',
  '',
].join('\r\n');

describe('poison messages', () => {
  let capture: LogCapture | null = null;
  beforeEach(() => {
    SEEN_AGGREGATE_REPORT_IDS.clear();
  });
  afterEach(() => {
    capture?.restore();
    capture = null;
    SEEN_AGGREGATE_REPORT_IDS.clear();
  });

  for (const nProcs of [1, 2]) {
    it(`moves messages the parser rejects to Invalid and goes on (nProcs ${nProcs})`, async () => {
      // GHSA-qxwv-2vwj-v828: parseReportEmail() turns the RecursionError and
      // HeaderWriteError of re-serializing a part into a ParserError.
      const conn = new FakeConnection('gmail', {
        a: deeplyNestedMessage(260),
        b: HEADER_WRITE_POISON,
        c: sample(AGGREGATE),
      });
      capture = captureLogs(undefined, WARNING);
      // Twice: the poison messages are gone after the first run, so a
      // restart (or the next watch check) doesn't fail on them again.
      for (let run = 0; run < 2; run += 1) {
        await getDmarcReportsFromMailbox(conn, { offline: true, nProcs });
      }
      expect(conn.moved).toEqual([
        ['a', 'Archive/Invalid'],
        ['b', 'Archive/Invalid'],
        ['c', 'Archive/Aggregate'],
      ]);
      expect(capture.output).toContain(
        'WARNING:tsdmarc:Unable to parse message with subject "x": maximum recursion depth exceeded',
      );
      expect(
        capture.output.some(line =>
          line.startsWith(
            'WARNING:tsdmarc:Unable to parse message with subject "x": folded header contains newline: ',
          ),
        ),
      ).toBe(true);
    });
  }

  it('moves a Maildir message the parser rejects to Invalid', async () => {
    // TestGetDmarcReportsFromMailboxMaildir.test_poison_message_does_not_abort_the_batch,
    // with mailsuite 2.3.3's Maildir backend: the fetch returns the stored
    // bytes and the move renames the file, so neither re-serializes the
    // message; the ParserError of parsing it moves it to Invalid.
    for (const nProcs of [1, 2]) {
      const root = mkdtempSync(path.join(tmpdir(), 'tsdmarc-maildir-'));
      try {
        for (const subdir of ['new', 'cur', 'tmp']) {
          mkdirSync(path.join(root, subdir));
        }
        writeFileSync(path.join(root, 'new', '1.poison'), HEADER_WRITE_POISON);
        writeFileSync(
          path.join(root, 'new', '2.nested'),
          deeplyNestedMessage(400),
        );
        writeFileSync(path.join(root, 'new', '3.report'), sample(AGGREGATE));
        SEEN_AGGREGATE_REPORT_IDS.clear();
        const conn = new MaildirConnection(root);
        capture = captureLogs(undefined, WARNING);
        const result = await getDmarcReportsFromMailbox(conn, {
          offline: true,
          nProcs,
        });
        capture.restore();
        expect(result.aggregateReports).toHaveLength(1);
        expect(await count(conn, 'INBOX')).toBe(0);
        expect(await count(conn, 'Archive/Invalid')).toBe(2);
        expect(await count(conn, 'Archive/Aggregate')).toBe(1);
        expect(
          capture.output.filter(line =>
            line.startsWith(
              'WARNING:tsdmarc:Unable to parse message with subject',
            ),
          ),
        ).toHaveLength(2);
        expect(
          capture.output.some(line => line.includes('Mailbox error')),
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('lets watch mode go on past a poison message', async () => {
    const conn = new FakeConnection('maildir', {
      a: deeplyNestedMessage(260),
      b: sample(AGGREGATE),
    });
    const saved: ParsingResults[] = [];
    await watchInbox(
      conn,
      results => {
        saved.push(results);
      },
      { offline: true },
    );
    await conn.watchCalls[0]?.checkCallback(conn);
    expect(conn.moved).toEqual([
      ['a', 'Archive/Invalid'],
      ['b', 'Archive/Aggregate'],
    ]);
    expect(saved[0]?.aggregateReports).toHaveLength(1);
  });

  it('escapes CR/LF of an invalid message in the log', async () => {
    const conn = new FakeConnection('gmail', {
      a: 'Subject: =?utf-8?q?x=0D=0AWARNING:tsdmarc:forged?=\r\n\r\nbody\r\n',
    });
    capture = captureLogs(undefined, WARNING);
    await getDmarcReportsFromMailbox(conn, { offline: true });
    expect(capture.output).toEqual([
      'WARNING:tsdmarc:Message with subject "x\\r\\nWARNING:tsdmarc:forged" is not a valid report',
    ]);
  });
});

// tests/test_init.py TestGetDmarcReportsFromMailboxContentErrors: a content
// error raised by the backend's fetch (Python's email.errors.MessageError
// or RecursionError) makes the message invalid; transport errors still end
// the run (GHSA-qxwv-2vwj-v828).
describe('TestGetDmarcReportsFromMailboxContentErrors', () => {
  afterEach(() => {
    SEEN_AGGREGATE_REPORT_IDS.clear();
  });

  function failingFetch(
    conn: FakeConnection,
    poisonId: string,
    error: Error,
  ): void {
    const fetchMessage = conn.fetchMessage.bind(conn);
    vi.spyOn(conn, 'fetchMessage').mockImplementation(
      async (messageId, options) => {
        if (String(messageId) === poisonId) {
          throw error;
        }
        return fetchMessage(messageId, options);
      },
    );
  }

  const errors = (): Error[] => [
    new HeaderWriteError('folded header contains newline'),
    new RecursionError('maximum recursion depth exceeded'),
  ];

  for (const [kind, poisonId, reportId] of [
    ['gmail', 'poison', 'report'],
    ['imap', '1', '2'],
  ] as const) {
    for (const nProcs of [1, 2]) {
      it(`test_fetch_content_error_moves_message_to_invalid (${kind}, nProcs ${nProcs})`, async () => {
        // IMAP UIDs stay integers throughout.
        const expectedPoison = kind === 'imap' ? Number(poisonId) : poisonId;
        const expectedReport = kind === 'imap' ? Number(reportId) : reportId;
        for (const error of errors()) {
          SEEN_AGGREGATE_REPORT_IDS.clear();
          let conn = new FakeConnection(kind, {
            [poisonId]: 'unused',
            [reportId]: sample(AGGREGATE),
          });
          failingFetch(conn, poisonId, error);
          capture = captureLogs(undefined, WARNING);
          let result = await getDmarcReportsFromMailbox(conn, {
            offline: true,
            nProcs,
          });
          capture.restore();
          expect(result.aggregateReports).toHaveLength(1);
          expect(result.failureReports).toEqual([]);
          expect(conn.moved).toEqual([
            [expectedPoison, 'Archive/Invalid'],
            [expectedReport, 'Archive/Aggregate'],
          ]);
          expect(capture.output).toContain(
            `WARNING:tsdmarc:Unable to fetch message UID ${poisonId}: ${error.name}: ${error.message}`,
          );

          SEEN_AGGREGATE_REPORT_IDS.clear();
          conn = new FakeConnection(kind, {
            [poisonId]: 'unused',
            [reportId]: sample(AGGREGATE),
          });
          failingFetch(conn, poisonId, error);
          capture = captureLogs(undefined, WARNING);
          result = await getDmarcReportsFromMailbox(conn, {
            offline: true,
            nProcs,
            deleteInvalid: true,
          });
          capture.restore();
          expect(result.aggregateReports).toHaveLength(1);
          expect(conn.deleted).toEqual([expectedPoison]);
          expect(conn.moved).toEqual([[expectedReport, 'Archive/Aggregate']]);
        }
      });
    }
  }

  for (const nProcs of [1, 2]) {
    it(`test_unparseable_content_moves_message_to_invalid (nProcs ${nProcs})`, async () => {
      for (const poison of [HEADER_WRITE_POISON, deeplyNestedMessage(400)]) {
        SEEN_AGGREGATE_REPORT_IDS.clear();
        const conn = new FakeConnection('imap', {
          '1': poison,
          '2': sample(AGGREGATE),
        });
        capture = captureLogs(undefined, WARNING);
        const result = await getDmarcReportsFromMailbox(conn, {
          offline: true,
          nProcs,
        });
        capture.restore();
        expect(result.aggregateReports).toHaveLength(1);
        expect(conn.moved).toEqual([
          [1, 'Archive/Invalid'],
          [2, 'Archive/Aggregate'],
        ]);
        expect(
          capture.output.some(line => line.includes('Unable to parse message')),
        ).toBe(true);
      }
    });

    it(`test_transport_error_on_fetch_still_propagates (nProcs ${nProcs})`, async () => {
      const conn = new FakeConnection('maildir', {
        a: sample(AGGREGATE),
        b: 'junk',
      });
      vi.spyOn(conn, 'fetchMessage').mockRejectedValue(
        Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
      );
      await expect(
        getDmarcReportsFromMailbox(conn, {
          offline: true,
          nProcs,
          deleteInvalid: true,
        }),
      ).rejects.toThrow('connection reset');
      expect(conn.moved).toEqual([]);
      expect(conn.deleted).toEqual([]);
    });
  }

  it('logs and skips an invalid message the backend refuses to move', async () => {
    const conn = new FakeConnection('gmail', {
      bad: 'Subject: s\n\nnot a report\n',
      ok: sample(AGGREGATE),
    });
    const moveMessage = conn.moveMessage.bind(conn);
    vi.spyOn(conn, 'moveMessage').mockImplementation(
      async (messageId, folder) => {
        if (messageId === 'bad') {
          throw new RecursionError('maximum recursion depth exceeded');
        }
        return moveMessage(messageId, folder);
      },
    );
    capture = captureLogs(undefined, WARNING);
    const result = await getDmarcReportsFromMailbox(conn, { offline: true });
    capture.restore();
    expect(result.aggregateReports).toHaveLength(1);
    expect(conn.moved).toEqual([['ok', 'Archive/Aggregate']]);
    expect(capture.output).toContain(
      'ERROR:tsdmarc:Mailbox error: Error moving invalid message UID bad: RecursionError: maximum recursion depth exceeded',
    );
  });
});

describe('maxEmailSize', () => {
  let capture: LogCapture | null = null;
  afterEach(() => {
    capture?.restore();
    capture = null;
    SEEN_AGGREGATE_REPORT_IDS.clear();
  });

  for (const nProcs of [1, 2]) {
    it(`moves messages the backend refuses as too large to Invalid (nProcs ${nProcs})`, async () => {
      const conn = new FakeConnection('gmail', {
        big: 'x',
        ok: sample(AGGREGATE),
      });
      const fetchMessage = conn.fetchMessage.bind(conn);
      vi.spyOn(conn, 'fetchMessage').mockImplementation(
        async (messageId, options) => {
          if (messageId === 'big') {
            throw emailTooLargeError(999_999_999, options?.maxSize ?? 0);
          }
          return fetchMessage(messageId, options);
        },
      );
      capture = captureLogs(undefined, WARNING);
      const result = await getDmarcReportsFromMailbox(conn, {
        offline: true,
        nProcs,
      });
      expect(result.aggregateReports).toHaveLength(1);
      expect(conn.moved).toEqual([
        ['big', 'Archive/Invalid'],
        ['ok', 'Archive/Aggregate'],
      ]);
      expect(capture.output).toContain(
        `WARNING:tsdmarc:Message UID big: Email of 999999999 bytes exceeds the ${50 * 1024 * 1024} byte size limit (max_email_size)`,
      );
    });
  }

  it('passes the limit to the backend and checks what comes back', async () => {
    const conn = new FakeConnection('gmail', { a: sample(AGGREGATE) });
    capture = captureLogs(undefined, WARNING);
    const config = createParserConfig({ offline: true, maxEmailSize: 100 });
    await getDmarcReportsFromMailbox(conn, { config });
    expect(conn.fetchMessageCalls).toEqual([['a', { maxSize: 100 }]]);
    expect(conn.moved).toEqual([['a', 'Archive/Invalid']]);
    expect(capture.output[0]).toMatch(
      /^WARNING:tsdmarc:Message UID a: Email of \d+ bytes exceeds the 100 byte size limit/u,
    );
  });

  it('sends no limit when maxEmailSize is 0', async () => {
    const conn = new FakeConnection('gmail', { a: sample(AGGREGATE) });
    const config = createParserConfig({ offline: true, maxEmailSize: 0 });
    const result = await getDmarcReportsFromMailbox(conn, { config });
    expect(result.aggregateReports).toHaveLength(1);
    expect(conn.fetchMessageCalls).toEqual([['a', {}]]);
  });

  it('Maildir refuses a large file before reading it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tsdmarc-maildir-'));
    try {
      for (const subdir of ['new', 'cur', 'tmp']) {
        mkdirSync(path.join(root, subdir));
      }
      writeFileSync(path.join(root, 'new', '1.big'), 'x'.repeat(2000));
      const conn = new MaildirConnection(root);
      const [key] = await conn.fetchMessages('INBOX');
      await expect(
        conn.fetchMessage(key as string, { maxSize: 1000, markRead: true }),
      ).rejects.toThrow(
        'Email of 2000 bytes exceeds the 1000 byte size limit (max_email_size)',
      );
      // Not marked read: still in new/.
      expect(
        readFileSync(path.join(root, 'new', '1.big'), 'utf-8'),
      ).toHaveLength(2000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A keepalive tells nothing about the message being parsed. Python treats
// its failure as a parse error when sequential (deleting the report with
// `delete`), which is the behavior these tests rule out.
describe('keepalive failures', () => {
  const HEARTBEAT_MS = 30_000;

  /** Make parallelMap's 30 s heartbeat wait fire right away. */
  function fastHeartbeat(): () => void {
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((handler: () => void, ms?: number) =>
        realSetTimeout(
          handler,
          ms === HEARTBEAT_MS ? 1 : ms,
        )) as typeof setTimeout);
    return () => spy.mockRestore();
  }

  for (const del of [false, true]) {
    it(`sequential: aborts untouched and the retry saves the report (delete: ${del})`, async () => {
      const conn = new FailingKeepaliveConnection({
        1: aggregateEmail({ records: 45 }),
      });
      const options = { offline: true, delete: del };
      await expect(getDmarcReportsFromMailbox(conn, options)).rejects.toThrow(
        'NOOP failed',
      );
      expect(conn.keepalives).toBe(1);
      expect(conn.moved).toEqual([]);
      expect(conn.deleted).toEqual([]);
      expect(conn.folders.get('INBOX')).toEqual(['1']);

      conn.failKeepalive = false;
      const result = await getDmarcReportsFromMailbox(conn, options);
      expect(result.aggregateReports).toHaveLength(1);
      expect(result.aggregateReports[0]?.records).toHaveLength(45);
      expect(conn.folders.get('INBOX')).toEqual([]);
      expect(conn.moved.map(([, folder]) => folder)).toEqual(
        del ? [] : ['Archive/Aggregate'],
      );
      expect(conn.deleted).toEqual(del ? [1] : []);
    });

    it(`parallel: aborts untouched and the retry saves the reports (delete: ${del})`, async () => {
      const conn = new FailingKeepaliveConnection({
        1: aggregateEmail({ reportId: 'id-1' }),
        2: aggregateEmail({ reportId: 'id-2' }),
      });
      const options = { offline: true, delete: del, nProcs: 2 };
      const restore = fastHeartbeat();
      try {
        await expect(getDmarcReportsFromMailbox(conn, options)).rejects.toThrow(
          'NOOP failed',
        );
      } finally {
        restore();
      }
      expect(conn.moved).toEqual([]);
      expect(conn.deleted).toEqual([]);
      expect(conn.folders.get('INBOX')).toEqual(['1', '2']);

      conn.failKeepalive = false;
      const result = await getDmarcReportsFromMailbox(conn, options);
      expect(result.aggregateReports).toHaveLength(2);
      expect(conn.folders.get('INBOX')).toEqual([]);
      expect(conn.folders.get('Archive/Invalid')).toEqual([]);
    });
  }

  it('sequential: keeps parsing when keepalive succeeds', async () => {
    const conn = new FailingKeepaliveConnection({
      1: aggregateEmail({ records: 45 }),
    });
    conn.failKeepalive = false;
    const result = await getDmarcReportsFromMailbox(conn, { offline: true });
    expect(result.aggregateReports[0]?.records).toHaveLength(45);
    expect(conn.keepalives).toBe(2);
  });

  it('sequential: a failed message stays invalid when no keepalive failed', async () => {
    const conn = new FailingKeepaliveConnection({
      1: sample(AGGREGATE).replace('MIME-Version', 'X-Ignored').slice(0, 200),
    });
    const result = await getDmarcReportsFromMailbox(conn, { offline: true });
    expect(result.aggregateReports).toEqual([]);
    expect(conn.moved).toEqual([[1, 'Archive/Invalid']]);
  });
});

// With a revoked token or no IP database, every report fails alike. Python
// files them as invalid (one record) or empty (several), and deletes them
// with `delete`, which is what these tests rule out.
describe('enrichment failures', () => {
  const DELETE_OPTIONS = [
    {},
    { delete: true },
    { deleteInvalid: true },
  ] as const;

  async function withRevokedToken(run: () => Promise<void>): Promise<void> {
    await configureIpinfoApi('revoked', { probe: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    try {
      await run();
    } finally {
      vi.unstubAllGlobals();
      await configureIpinfoApi(null);
    }
  }

  for (const records of [1, 2]) {
    for (const deleteOptions of DELETE_OPTIONS) {
      it(`sequential: stops untouched and the retry saves it (${records} records, ${JSON.stringify(deleteOptions)})`, async () => {
        const conn = new FakeConnection('imap', {
          1: aggregateEmail({ records }),
          2: aggregateEmail({ records, reportId: 'id-2' }),
        });
        const saved: ParsingResults[] = [];
        const options = {
          ...deleteOptions,
          config: createParserConfig({ offline: true }),
          saveCallback: (results: ParsingResults): void => {
            saved.push(results);
          },
        };
        await withRevokedToken(async () => {
          await expect(
            getDmarcReportsFromMailbox(conn, options),
          ).rejects.toBeInstanceOf(InvalidIPinfoAPIKey);
        });
        expect(saved).toEqual([]);
        expect(conn.moved).toEqual([]);
        expect(conn.deleted).toEqual([]);
        expect(conn.folders.get('INBOX')).toEqual(['1', '2']);

        const result = await getDmarcReportsFromMailbox(conn, options);
        expect(result.aggregateReports).toHaveLength(2);
        expect(result.aggregateReports[0]?.records).toHaveLength(records);
        expect(conn.folders.get('INBOX')).toEqual([]);
        expect(conn.folders.get('Archive/Invalid')).toEqual([]);
      });

      it(`parallel: stops untouched and the retry saves it (${records} records, ${JSON.stringify(deleteOptions)})`, async () => {
        const conn = new FakeConnection('imap', {
          1: aggregateEmail({ records }),
          2: aggregateEmail({ records, reportId: 'id-2' }),
        });
        const options = {
          ...deleteOptions,
          offline: true,
          nProcs: 2,
        };
        emailJob.name = 'revokedTokenEmailJob';
        try {
          await expect(
            getDmarcReportsFromMailbox(conn, options),
          ).rejects.toBeInstanceOf(InvalidIPinfoAPIKey);
        } finally {
          emailJob.name = null;
        }
        expect(conn.moved).toEqual([]);
        expect(conn.deleted).toEqual([]);
        expect(conn.folders.get('INBOX')).toEqual(['1', '2']);

        const result = await getDmarcReportsFromMailbox(conn, options);
        expect(result.aggregateReports).toHaveLength(2);
        expect(conn.folders.get('Archive/Invalid')).toEqual([]);
      });
    }
  }

  it('sequential: a failure report stops the pass too', async () => {
    const email = readFileSync(
      samplePath('failure/dmarc_ruf_report_linkedin.eml'),
      'utf8',
    );
    const conn = new FakeConnection('imap', { 1: email });
    await withRevokedToken(async () => {
      await expect(
        getDmarcReportsFromMailbox(conn, {
          delete: true,
          config: createParserConfig({ offline: true }),
        }),
      ).rejects.toBeInstanceOf(InvalidIPinfoAPIKey);
    });
    expect(conn.deleted).toEqual([]);
    expect(conn.moved).toEqual([]);
  });

  it('a bad message next to the failure is still disposed of as invalid', async () => {
    const conn = new FakeConnection('imap', {
      1: 'not a report',
      2: aggregateEmail(),
    });
    await withRevokedToken(async () => {
      await expect(
        getDmarcReportsFromMailbox(conn, {
          config: createParserConfig({ offline: true }),
        }),
      ).rejects.toBeInstanceOf(InvalidIPinfoAPIKey);
    });
    expect(conn.moved).toEqual([[1, 'Archive/Invalid']]);
    expect(conn.folders.get('INBOX')).toEqual(['2']);
  });
});

// A worker out of memory says nothing about its message: the heap may hold
// other jobs' leftovers. Python's pool breaks and leaves the mailbox alone.
describe('workers out of memory', () => {
  const HEAP_LIMIT_MB = 64;
  const POISON = 'X-Poison: 1\n';

  for (const del of [false, true]) {
    it(`holds the message back, then moves it to Unsaved (delete: ${del})`, async () => {
      const conn = new FakeConnection('imap', {
        1: POISON + aggregateEmail({ reportId: 'poison' }),
        2: aggregateEmail({ reportId: 'fine' }),
      });
      const options = {
        delete: del,
        nProcs: 2,
        maxUnsavedRetries: 1,
        config: createParserConfig({
          offline: true,
          maxWorkerHeapMb: HEAP_LIMIT_MB,
        }),
      };
      emailJob.name = 'exhaustOrParseEmailJob';
      try {
        const first = await getDmarcReportsFromMailbox(conn, options);
        expect(first.aggregateReports).toHaveLength(1);
        expect(conn.folders.get('INBOX')).toEqual(['1']);
        expect(conn.folders.get('Archive/Invalid')).toEqual([]);

        conn.folders.get('INBOX')?.push('3');
        conn.contents.set('3', aggregateEmail({ reportId: 'other' }));
        await getDmarcReportsFromMailbox(conn, options);
      } finally {
        emailJob.name = null;
      }
      expect(conn.folders.get('INBOX')).toEqual([]);
      expect(conn.folders.get('Archive/Unsaved')).toEqual([1]);
      expect(conn.folders.get('Archive/Invalid')).toEqual([]);
      expect(conn.deleted.map(String)).not.toContain('1');
    }, 60_000);
  }
});

// A message over `jobTimeout` may well be a legitimate report on a slow
// resolver, so it is never treated as invalid (`deleteInvalid` would destroy
// it): it stays for retry, then moves to Unsaved.
describe('jobTimeout', () => {
  const NEARLY_ZERO = 0.000_001;

  it('sequential: stops at the next checkpoint and leaves the message for retry', async () => {
    capture = captureLogs(undefined, WARNING);
    const conn = new FakeConnection('imap', {
      1: aggregateEmail({ records: 45 }),
    });
    const result = await getDmarcReportsFromMailbox(conn, {
      config: createParserConfig({ offline: true, jobTimeout: NEARLY_ZERO }),
      delete: true,
    });
    expect(result.aggregateReports).toEqual([]);
    expect(conn.keepalives).toBe(0);
    expect(conn.deleted).toEqual([]);
    expect(conn.moved).toEqual([]);
    expect(conn.folders.get('INBOX')).toEqual(['1']);
    expect(capture.output.join('\n')).toContain('Timed out parsing message');
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(1);
  });

  it('sequential: moves it to Unsaved once retries run out, never deleting it', async () => {
    const conn = new FakeConnection('imap', {
      1: aggregateEmail({ records: 45 }),
    });
    await getDmarcReportsFromMailbox(conn, {
      config: createParserConfig({ offline: true, jobTimeout: NEARLY_ZERO }),
      delete: true,
      maxUnsavedRetries: 0,
    });
    expect(conn.deleted).toEqual([]);
    expect(conn.moved).toEqual([[1, 'Archive/Unsaved']]);
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(0);
  });

  it('parallel: holds back a timed-out message instead of invalidating it', async () => {
    const conn = new FakeConnection('imap', {
      1: aggregateEmail({ reportId: 'id-1', records: 500 }),
      2: aggregateEmail({ reportId: 'id-2', records: 500 }),
    });
    const result = await getDmarcReportsFromMailbox(conn, {
      config: createParserConfig({ offline: true, jobTimeout: NEARLY_ZERO }),
      delete: true,
      maxUnsavedRetries: 0,
      nProcs: 2,
    });
    expect(result.aggregateReports).toEqual([]);
    expect(conn.deleted).toEqual([]);
    expect(conn.moved).toEqual([
      [1, 'Archive/Unsaved'],
      [2, 'Archive/Unsaved'],
    ]);
  });

  it('leaves mailbox state alone in test mode', async () => {
    const conn = new FakeConnection('imap', {
      1: aggregateEmail({ records: 45 }),
    });
    await getDmarcReportsFromMailbox(conn, {
      config: createParserConfig({ offline: true, jobTimeout: NEARLY_ZERO }),
      test: true,
    });
    expect(conn.moved).toEqual([]);
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(0);
  });

  it('jobTimeout 0 disables the limit', async () => {
    const conn = new FakeConnection('imap', {
      1: aggregateEmail({ records: 45 }),
    });
    const result = await getDmarcReportsFromMailbox(conn, {
      config: createParserConfig({ offline: true, jobTimeout: 0 }),
    });
    expect(result.aggregateReports[0]?.records).toHaveLength(45);
    expect(conn.keepalives).toBe(2);
  });
});

describe('dedup scope', () => {
  it('does not drop a report seen on another connection by default', async () => {
    const report = aggregateEmail();
    const first = new FakeConnection('imap', { 1: report });
    const second = new FakeConnection('imap', { 1: report });
    const a = await getDmarcReportsFromMailbox(first, { offline: true });
    const b = await getDmarcReportsFromMailbox(second, { offline: true });
    expect(a.aggregateReports).toHaveLength(1);
    expect(b.aggregateReports).toHaveLength(1);
    expect(SEEN_AGGREGATE_REPORT_IDS.size).toBe(0);
  });

  it('still drops a duplicate on the same connection across calls', async () => {
    const conn = new FakeConnection('imap', { 1: aggregateEmail() });
    await getDmarcReportsFromMailbox(conn, { offline: true });
    conn.folders.get('INBOX')?.push('1');
    const again = await getDmarcReportsFromMailbox(conn, { offline: true });
    expect(again.aggregateReports).toEqual([]);
  });

  it('shares dedup across connections given one explicit config', async () => {
    const report = aggregateEmail();
    const config = createParserConfig({ offline: true });
    const first = new FakeConnection('imap', { 1: report });
    const second = new FakeConnection('imap', { 1: report });
    await getDmarcReportsFromMailbox(first, { config });
    const b = await getDmarcReportsFromMailbox(second, { config });
    expect(b.aggregateReports).toEqual([]);
  });

  it('keeps reports reusing org and ID for another domain, not another period', async () => {
    // As parsedmarc 11.2 (RFC 9990 section 3.5.1): the identity is the
    // reporter, the Report-ID and the policy domain.
    const conn = new FakeConnection('imap', {
      1: aggregateEmail({ domain: 'a.example' }),
      2: aggregateEmail({ domain: 'b.example' }),
      3: aggregateEmail({ domain: 'a.example', begin: 1_700_100_000 }),
      4: aggregateEmail({ domain: 'a.example' }),
    });
    const result = await getDmarcReportsFromMailbox(conn, { offline: true });
    expect(
      result.aggregateReports.map(report => report.policyPublished.domain),
    ).toEqual(['a.example', 'b.example']);
    expect(conn.folders.get('Archive/Aggregate')).toHaveLength(4);
  });
});

describe('failed save counters', () => {
  class NamedMailbox extends FakeConnection {
    constructor(private readonly identity: string) {
      super('imap', { 1: aggregateEmail() });
    }

    override get mailboxIdentity(): string {
      return this.identity;
    }
  }

  it('counts each mailbox apart for the same folder and UID', async () => {
    const options = {
      offline: true,
      saveCallback: fail,
      maxUnsavedRetries: 1,
    };
    const first = new NamedMailbox('a@imap.example:993');
    const second = new NamedMailbox('b@imap.example:993');
    await getDmarcReportsFromMailbox(first, options);
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(1);
    await getDmarcReportsFromMailbox(second, options);
    // Its first failure: within maxUnsavedRetries, so it stays for retry.
    expect(second.moved).toEqual([]);
    expect(FAILED_SAVE_ATTEMPTS.size).toBe(2);
  });

  it('keeps counting across connection objects to one mailbox', async () => {
    const options = {
      offline: true,
      saveCallback: fail,
      maxUnsavedRetries: 1,
    };
    await getDmarcReportsFromMailbox(new NamedMailbox('a@imap'), options);
    const reconnected = new NamedMailbox('a@imap');
    await getDmarcReportsFromMailbox(reconnected, options);
    expect(reconnected.moved).toEqual([[1, 'Archive/Unsaved']]);
  });

  it("a save on one mailbox leaves another's counter alone", async () => {
    const options = { offline: true, maxUnsavedRetries: 1 };
    const failing = new NamedMailbox('a@imap.example:993');
    const saving = new NamedMailbox('b@imap.example:993');
    await getDmarcReportsFromMailbox(failing, {
      ...options,
      saveCallback: fail,
    });
    await getDmarcReportsFromMailbox(saving, options);
    await getDmarcReportsFromMailbox(failing, {
      ...options,
      saveCallback: fail,
    });
    expect(failing.moved).toEqual([[1, 'Archive/Unsaved']]);
  });
});

describe('a batch with more reports than a call can take as arguments', () => {
  it('returns them all', async () => {
    const messages = 200_000;
    const inbox: Record<string, string> = {};
    for (let index = 0; index < messages; index += 1) {
      inbox[`m${index}`] = 'x';
    }
    parsedEmail.fixed = {
      reportType: 'smtp_tls',
      report: { policies: [] },
    } as unknown as ParsedReport;
    try {
      const results = await getDmarcReportsFromMailbox(
        new FakeConnection('other' as MailboxKind, inbox),
        { batchSize: 0, test: true, offline: true },
      );
      expect(results.smtpTlsReports).toHaveLength(messages);
    } finally {
      parsedEmail.fixed = null;
    }
  });
});

// parsedmarc's TestAggregateReportIdentityDomainScopePendingSave: the
// mailbox path stages new dedup keys until the batch is saved, and must make
// the same domain-scoped decision as the immediate-write path.
describe('TestAggregateReportIdentityDomainScopePendingSave', () => {
  let config: ParserConfig;
  beforeEach(() => {
    config = createParserConfig({ offline: true, alwaysUseLocalFiles: true });
  });

  const deliverDomain = (domain: string, records: number): void => {
    deliver(
      Buffer.from(aggregateEmail({ reportId: 'shared-id', domain, records })),
    );
  };
  // Dry run: messages stay for the next call, while reports are still
  // classified, the callback called and pending keys committed on success.
  const runOnce = async (
    saveCallback: GetDmarcReportsFromMailboxOptions['saveCallback'],
  ): Promise<ParsingResults> =>
    (await run({ config, saveCallback, test: true }))[1];
  const countByDomain = (result: ParsingResults): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const report of result.aggregateReports) {
      counts[report.policyPublished.domain] = report.records.reduce(
        (sum, record) => sum + Number(record.count),
        0,
      );
    }
    expect(Object.keys(counts)).toHaveLength(result.aggregateReports.length);
    return counts;
  };
  const saved = (): boolean => true;
  const notSaved = (): boolean => false;

  it('test_committed_batch_keeps_reports_for_both_domains', async () => {
    deliverDomain('a.example', 3);
    deliverDomain('b.example', 5);
    expect(countByDomain(await runOnce(saved))).toEqual({
      'a.example': 3,
      'b.example': 5,
    });
  });

  it('test_committed_batch_still_suppresses_same_domain_duplicate', async () => {
    deliverDomain('a.example', 3);
    deliverDomain('a.example', 3);
    const result = await runOnce(saved);
    expect(result.aggregateReports).toHaveLength(1);
    expect(countByDomain(result)).toEqual({ 'a.example': 3 });
  });

  it('test_failed_save_drops_pending_keys_so_the_retry_reparses', async () => {
    deliverDomain('a.example', 3);
    const first = await runOnce(notSaved);
    const retry = await runOnce(saved);
    expect(countByDomain(first)).toEqual({ 'a.example': 3 });
    expect(countByDomain(retry)).toEqual({ 'a.example': 3 });
  });

  it('test_successful_save_then_rerun_returns_nothing', async () => {
    deliverDomain('a.example', 3);
    deliverDomain('b.example', 5);
    const committed = await runOnce(saved);
    const rerun = await runOnce(saved);
    expect(countByDomain(committed)).toEqual({
      'a.example': 3,
      'b.example': 5,
    });
    expect(rerun.aggregateReports).toEqual([]);
  });

  it('test_false_callback_retry_still_returns_both_domains', async () => {
    deliverDomain('a.example', 3);
    deliverDomain('b.example', 5);
    const expected = { 'a.example': 3, 'b.example': 5 };
    expect(countByDomain(await runOnce(notSaved))).toEqual(expected);
    expect(countByDomain(await runOnce(saved))).toEqual(expected);
  });

  it('test_raising_callback_retry_still_returns_both_domains', async () => {
    deliverDomain('a.example', 3);
    deliverDomain('b.example', 5);
    await expect(
      runOnce(() => {
        throw new Error('output destination down');
      }),
    ).rejects.toThrow('output destination down');
    expect(countByDomain(await runOnce(saved))).toEqual({
      'a.example': 3,
      'b.example': 5,
    });
  });
});
