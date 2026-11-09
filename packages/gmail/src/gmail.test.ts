// Port of mailsuite's tests/test_mailbox_gmail.py. Instead of mocking the
// SDK's fluent API, a real Gmail client runs against a fake `fetch`, so the
// tests assert on the HTTP requests actually sent.

import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { gaxios, OAuth2Client } from 'google-auth-library';
import {
  EmailTooLargeError,
  FolderExistsError,
  FolderNotFoundError,
  MailboxConnection,
} from 'tsdmarc';
import { describe, expect, it } from 'vitest';

import { GmailConnection } from './gmail';
import { createFakeFetch, type FakeFetch } from './test/fake-fetch';

const API = '/gmail/v1/users/me';
const LABELS = `${API}/labels`;
const MESSAGES = `${API}/messages`;

function buildService(fake: FakeFetch): gmail_v1.Gmail {
  const auth = new OAuth2Client();
  auth.setCredentials({
    access_token: 'access-token',
    expiry_date: Date.now() + 3_600_000,
  });
  return gmail({
    version: 'v1',
    auth,
    retry: false,
    fetchImplementation: fake.fetch,
  });
}

function bareConnection(labelId = 'L1'): {
  conn: GmailConnection;
  fake: FakeFetch;
} {
  const fake = createFakeFetch();
  const conn = new GmailConnection(buildService(fake), {
    includeSpamTrash: false,
    reportsLabelId: labelId,
    paginateMessages: true,
  });
  return { conn, fake };
}

function labels(...entries: [string, string][]): { json: unknown } {
  return { json: { labels: entries.map(([id, name]) => ({ id, name })) } };
}

function jsonBody(body: string): unknown {
  return JSON.parse(body);
}

describe('TestSubclass', () => {
  it('is a MailboxConnection', () => {
    const { conn } = bareConnection();
    expect(conn).toBeInstanceOf(MailboxConnection);
    expect(conn.kind).toBe('gmail');
  });
});

describe('TestCreateFolder', () => {
  it('skips Archive', async () => {
    const { conn, fake } = bareConnection();
    await conn.createFolder('Archive');
    expect(fake.requests).toHaveLength(0);
  });

  it('creates the label', async () => {
    const { conn, fake } = bareConnection();
    fake.on('POST', LABELS, { json: { id: 'L9', name: 'Reports' } });
    await conn.createFolder('Reports');
    const [request] = fake.find('POST', LABELS);
    expect(request?.headers.get('authorization')).toBe('Bearer access-token');
    expect(jsonBody(request?.body ?? '')).toEqual({
      name: 'Reports',
      messageListVisibility: 'show',
    });
  });

  it('swallows a 409 for an existing label', async () => {
    const { conn, fake } = bareConnection();
    fake.on('POST', LABELS, { status: 409, json: { error: 'exists' } });
    await expect(conn.createFolder('Reports')).resolves.toBeUndefined();
  });

  it('propagates other HTTP errors', async () => {
    const { conn, fake } = bareConnection();
    fake.on('POST', LABELS, { status: 500, json: { error: 'boom' } });
    const result = conn.createFolder('Reports');
    // mailsuite: pytest.raises(HttpError); the SDK's error here is gaxios's.
    await expect(result).rejects.toBeInstanceOf(gaxios.GaxiosError);
    await expect(result).rejects.toMatchObject({ status: 500 });
    // No retries: googleapiclient's num_retries defaults to 0.
    expect(fake.find('POST', LABELS)).toHaveLength(1);
  });

  it('clears the label cache', async () => {
    // Regression: a cached miss must not survive createFolder, or later
    // lookups (e.g. during mergeFolders) resolve to "" and orphan messages.
    const { conn, fake } = bareConnection();
    fake.on(
      'GET',
      LABELS,
      labels(['INBOX', 'INBOX']),
      labels(['INBOX', 'INBOX'], ['R1', 'Reports']),
    );
    fake.on('POST', LABELS, { json: {} });
    expect(await conn.findLabelIdForLabel('Reports')).toBe('');
    await conn.createFolder('Reports');
    expect(await conn.findLabelIdForLabel('Reports')).toBe('R1');
  });
});

describe('TestRenameFolder', () => {
  it('patches the label name', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['L42', 'Reports']));
    fake.on('PATCH', `${LABELS}/L42`, { json: {} });
    await conn.renameFolder('Reports', 'Archived Reports');
    const [request] = fake.find('PATCH', `${LABELS}/L42`);
    expect(jsonBody(request?.body ?? '')).toEqual({ name: 'Archived Reports' });
  });

  it('raises on a conflict', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['LX', 'Archive'], ['L1', 'Reports']));
    await expect(conn.renameFolder('Reports', 'Archive')).rejects.toThrow(
      FolderExistsError,
    );
    expect(fake.find('PATCH', /.*/u)).toHaveLength(0);
  });

  it('raises not found for a missing label', async () => {
    // A missing source label must raise a clear error rather than PATCHing
    // id="" and surfacing a confusing API error.
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels());
    const result = conn.renameFolder('Nope', 'Whatever');
    // mailsuite: pytest.raises(RuntimeError, match="not found"), raised as
    // FolderNotFoundError (a RuntimeError subclass there).
    await expect(result).rejects.toBeInstanceOf(FolderNotFoundError);
    await expect(result).rejects.toThrow(/not found/u);
    expect(fake.find('PATCH', /.*/u)).toHaveLength(0);
  });
});

describe('TestFolderExists', () => {
  it('is true when the label resolves', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['L42', 'Reports']));
    expect(await conn.folderExists('Reports')).toBe(true);
  });

  it('is false when the label is missing', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels());
    expect(await conn.folderExists('Nope')).toBe(false);
  });
});

describe('TestDeleteFolder', () => {
  it('deletes the label', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['L9', 'Junk']));
    fake.on('DELETE', `${LABELS}/L9`, { status: 204 });
    await conn.deleteFolder('Junk');
    expect(fake.find('DELETE', `${LABELS}/L9`)).toHaveLength(1);
  });

  it('raises for a missing label', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels());
    await expect(conn.deleteFolder('Nope')).rejects.toThrow(
      FolderNotFoundError,
    );
    expect(fake.find('DELETE', /.*/u)).toHaveLength(0);
  });
});

describe('TestDoMoveFolder', () => {
  it('renames the label path', async () => {
    // Gmail "move" is a label-path rename.
    const { conn, fake } = bareConnection();
    fake.on(
      'GET',
      LABELS,
      labels(['L1', 'Archive/Forensic'], ['L2', 'Reports']),
    );
    fake.on('PATCH', `${LABELS}/L1`, { json: {} });
    await conn.moveFolder('Archive/Forensic', { newParent: 'Reports' });
    const [request] = fake.find('PATCH', `${LABELS}/L1`);
    expect(jsonBody(request?.body ?? '')).toEqual({ name: 'Reports/Forensic' });
  });
});

describe('TestMoveMessageFrom', () => {
  it('drops the source label and adds the destination', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['LS', 'Forensic'], ['LD', 'Failure']));
    fake.on('GET', MESSAGES, { json: { messages: [{ id: 'm1' }] } });
    fake.on('POST', `${MESSAGES}/m1/modify`, { json: {} });
    fake.on('DELETE', `${LABELS}/LS`, { status: 204 });
    await conn.mergeFolders('Forensic', 'Failure');
    const [request] = fake.find('POST', `${MESSAGES}/m1/modify`);
    expect(jsonBody(request?.body ?? '')).toEqual({
      addLabelIds: ['LD'],
      removeLabelIds: ['LS'],
    });
  });
});

describe('TestFetchMessages', () => {
  it('reads a single page', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['L42', 'Reports']));
    fake.on('GET', MESSAGES, {
      json: { messages: [{ id: 'm1' }, { id: 'm2' }] },
    });
    expect(await conn.fetchMessages('Reports')).toEqual(['m1', 'm2']);
    const [request] = fake.find('GET', MESSAGES);
    expect(request?.url.searchParams.get('labelIds')).toBe('L42');
    expect(request?.url.searchParams.get('includeSpamTrash')).toBe('false');
    expect(request?.url.searchParams.has('q')).toBe(false);
    expect(request?.url.searchParams.has('pageToken')).toBe(false);
  });

  it('paginates', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['L42', 'Reports']));
    fake.on(
      'GET',
      MESSAGES,
      { json: { messages: [{ id: 'm1' }], nextPageToken: 'tok' } },
      { json: { messages: [{ id: 'm2' }] } },
    );
    expect(await conn.fetchMessages('Reports')).toEqual(['m1', 'm2']);
    const pageTokens = fake
      .find('GET', MESSAGES)
      .map(request => request.url.searchParams.get('pageToken'));
    expect(pageTokens).toEqual([null, 'tok']);
  });

  it('stops after one page when pagination is disabled', async () => {
    const { conn, fake } = bareConnection();
    conn.paginateMessages = false;
    fake.on('GET', LABELS, labels(['L42', 'Reports']));
    fake.on('GET', MESSAGES, {
      json: { messages: [{ id: 'm1' }], nextPageToken: 'tok' },
    });
    expect(await conn.fetchMessages('Reports')).toEqual(['m1']);
    expect(fake.find('GET', MESSAGES)).toHaveLength(1);
  });

  it('applies the since filter', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['L42', 'Reports']));
    fake.on('GET', MESSAGES, { json: { messages: [{ id: 'm1' }] } });
    await conn.fetchMessages('Reports', { since: '2026/04/01' });
    const [request] = fake.find('GET', MESSAGES);
    expect(request?.url.searchParams.get('q')).toBe('after:2026/04/01');
  });

  it('applies the since filter to every page', async () => {
    // Regression: the since filter was dropped on every page after the
    // first, so paginated fetches returned messages older than `since`.
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['L42', 'Reports']));
    fake.on(
      'GET',
      MESSAGES,
      { json: { messages: [{ id: 'm1' }], nextPageToken: 'tok' } },
      { json: { messages: [{ id: 'm2' }] } },
    );
    const ids = await conn.fetchMessages('Reports', { since: '2026/04/01' });
    expect(ids).toEqual(['m1', 'm2']);
    const queries = fake
      .find('GET', MESSAGES)
      .map(request => request.url.searchParams.get('q'));
    expect(queries).toEqual(['after:2026/04/01', 'after:2026/04/01']);
  });

  it('sends includeSpamTrash when enabled', async () => {
    const { conn, fake } = bareConnection();
    conn.includeSpamTrash = true;
    fake.on('GET', LABELS, labels(['L42', 'Reports']));
    fake.on('GET', MESSAGES, { json: {} });
    expect(await conn.fetchMessages('Reports')).toEqual([]);
    const [request] = fake.find('GET', MESSAGES);
    expect(request?.url.searchParams.get('includeSpamTrash')).toBe('true');
  });
});

describe('TestFetchMessage', () => {
  it('decodes the raw message', async () => {
    const { conn, fake } = bareConnection();
    const body = 'From: a\r\nSubject: test\r\n\r\nbody\r\n';
    fake.on('GET', `${MESSAGES}/m1`, {
      json: { raw: Buffer.from(body).toString('base64url') },
    });
    const result = await conn.fetchMessage('m1');
    expect(result).toBe(body);
    const [request] = fake.find('GET', `${MESSAGES}/m1`);
    expect(request?.url.searchParams.get('format')).toBe('raw');
  });

  it('replaces invalid UTF-8 like errors="replace"', async () => {
    const { conn, fake } = bareConnection();
    const raw = Buffer.from([0x53, 0x75, 0x62, 0xff, 0x6a]).toString('base64');
    fake.on('GET', `${MESSAGES}/m2`, { json: { raw } });
    expect(await conn.fetchMessage('m2')).toBe('Sub�j');
  });

  // maxSize is not in mailsuite.
  it('refuses a message whose sizeEstimate is over maxSize', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', `${MESSAGES}/m3`, {
      json: {
        raw: Buffer.from('small').toString('base64url'),
        sizeEstimate: 2000,
      },
    });
    await expect(conn.fetchMessage('m3', { maxSize: 1000 })).rejects.toThrow(
      new EmailTooLargeError(
        'Email of 2000 bytes exceeds the 1000 byte size limit (max_email_size)',
      ),
    );
  });

  it('refuses raw content over maxSize without a sizeEstimate', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', `${MESSAGES}/m4`, {
      json: { raw: Buffer.from('x'.repeat(2000)).toString('base64url') },
    });
    await expect(conn.fetchMessage('m4', { maxSize: 1000 })).rejects.toThrow(
      EmailTooLargeError,
    );
    expect(await conn.fetchMessage('m4', { maxSize: 2000 })).toHaveLength(2000);
  });
});

describe('TestDeleteMessage', () => {
  it('calls delete', async () => {
    const { conn, fake } = bareConnection();
    fake.on('DELETE', `${MESSAGES}/m1`, { status: 204 });
    await conn.deleteMessage('m1');
    expect(fake.find('DELETE', `${MESSAGES}/m1`)).toHaveLength(1);
  });
});

describe('TestMoveMessage', () => {
  it('modifies the labels', async () => {
    const { conn, fake } = bareConnection('REPORTS');
    fake.on('GET', LABELS, labels(['ARCHIVE', 'Archive']));
    fake.on('POST', `${MESSAGES}/m1/modify`, { json: {} });
    await conn.moveMessage('m1', 'Archive');
    const [request] = fake.find('POST', `${MESSAGES}/m1/modify`);
    expect(jsonBody(request?.body ?? '')).toEqual({
      addLabelIds: ['ARCHIVE'],
      removeLabelIds: ['REPORTS'],
    });
  });
});

function sentRaw(fake: FakeFetch): string {
  const [request] = fake.find('POST', `${MESSAGES}/send`);
  const { raw } = jsonBody(request?.body ?? '') as { raw: string };
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('TestSendMessage', () => {
  it('sends the encoded message', async () => {
    const { conn, fake } = bareConnection();
    fake.on('POST', `${MESSAGES}/send`, { json: { id: 'sent-123' } });
    const result = await conn.sendMessage({
      messageFrom: 'a@example.com',
      messageTo: ['b@example.org'],
      subject: 'hi',
      plainMessage: 'hello',
    });
    expect(result).toBe('sent-123');
    const raw = sentRaw(fake);
    expect(raw).toContain('Subject: hi');
    expect(raw).toContain('To: b@example.org');
    expect(raw).toContain('hello');
  });

  it('uses the padded URL-safe alphabet like Python', async () => {
    const { conn, fake } = bareConnection();
    fake.on('POST', `${MESSAGES}/send`, { json: { id: 's1' } });
    await conn.sendMessage({ messageFrom: 'a@example.com', subject: '??>>' });
    const [request] = fake.find('POST', `${MESSAGES}/send`);
    const { raw } = jsonBody(request?.body ?? '') as { raw: string };
    expect(raw).not.toMatch(/[+/]/u);
    expect(raw.length % 4).toBe(0);
  });

  it('sends attachments', async () => {
    const { conn, fake } = bareConnection();
    fake.on('POST', `${MESSAGES}/send`, { json: { id: 's2' } });
    await conn.sendMessage({
      messageFrom: 'a@example.com',
      messageTo: ['b@example.org'],
      attachments: [['file.txt', new TextEncoder().encode('data')]],
    });
    expect(sentRaw(fake)).toContain('file.txt');
  });

  it('accepts saveToSentItems', async () => {
    // saveToSentItems is accepted for API parity and the send still works.
    const { conn, fake } = bareConnection();
    fake.on('POST', `${MESSAGES}/send`, { json: { id: 's3' } });
    const result = await conn.sendMessage({
      messageFrom: 'a@example.com',
      messageTo: ['b@example.org'],
      plainMessage: 'hello',
      saveToSentItems: false,
    });
    expect(result).toBe('s3');
    expect(sentRaw(fake)).toContain('hello');
  });
});

describe('TestKeepalive', () => {
  it('is a no-op', async () => {
    const { conn, fake } = bareConnection();
    await conn.keepalive();
    expect(fake.requests).toHaveLength(0);
  });
});

describe('TestLabelLookup', () => {
  it('finds by name', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['L1', 'INBOX'], ['L42', 'Reports']));
    expect(await conn.findLabelIdForLabel('Reports')).toBe('L42');
  });

  it('finds by id', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['L42', 'Reports']));
    expect(await conn.findLabelIdForLabel('L42')).toBe('L42');
  });

  it('returns "" when missing', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels());
    expect(await conn.findLabelIdForLabel('Nope')).toBe('');
  });

  it('caches lookups', async () => {
    const { conn, fake } = bareConnection();
    fake.on('GET', LABELS, labels(['L42', 'Reports']));
    await conn.findLabelIdForLabel('Reports');
    await conn.findLabelIdForLabel('Reports');
    expect(fake.find('GET', LABELS)).toHaveLength(1);
  });
});

describe('TestWatch', () => {
  it('exits on config reload', async () => {
    const { conn } = bareConnection();
    let calls = 0;
    await conn.watch({
      checkCallback: () => {
        calls += 1;
      },
      checkTimeout: 0,
      configReloading: () => true,
    });
    expect(calls).toBe(0);
  });

  it('calls the callback then exits', async () => {
    const { conn } = bareConnection();
    let calls = 0;
    await conn.watch({
      checkCallback: () => {
        calls += 1;
      },
      checkTimeout: 0,
      configReloading: () => calls > 0,
    });
    expect(calls).toBe(1);
  });

  it('stops when the signal aborts', async () => {
    const { conn } = bareConnection();
    const controller = new AbortController();
    let calls = 0;
    const watching = conn.watch({
      checkCallback: () => {
        calls += 1;
      },
      checkTimeout: 3600,
      signal: controller.signal,
    });
    controller.abort();
    await watching;
    expect(calls).toBe(0);
  });
});

describe('fromService', () => {
  it('resolves the reports label id', async () => {
    const fake = createFakeFetch();
    fake.on('GET', LABELS, labels(['INBOX', 'INBOX'], ['L7', 'DMARC']));
    const conn = await GmailConnection.fromService(buildService(fake), {
      includeSpamTrash: false,
      reportsFolder: 'DMARC',
      paginateMessages: true,
    });
    expect(conn.reportsLabelId).toBe('L7');
  });
});
