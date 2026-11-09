// Port of mailsuite's tests/test_mailbox_graph.py (the parts that exercise
// MSGraphConnection's Graph calls). Python fakes the SDK's fluent client;
// here a fake `fetch` answers the REST calls and the tests assert on the
// requests sent: method, URL, query and JSON body.

import type { AccessToken, TokenCredential } from '@azure/identity';
import {
  EmailTooLargeError,
  FolderExistsError,
  MailboxConnection,
} from 'tsdmarc';
import { describe, expect, it } from 'vitest';

import { APIError, ODataError } from './errors';
import { MSGraphConnection } from './graph';
import {
  createFakeFetch,
  type FakeFetch,
  type FakeResponse,
  type RecordedRequest,
} from './test/fake-fetch';

const USER = '/v1.0/users/user%40example.com';
const FOLDERS = `${USER}/mailFolders`;
const MESSAGES = `${USER}/messages`;

interface FakeCredential extends TokenCredential {
  scopes: string[][];
}

function fakeCredential(): FakeCredential {
  const scopes: string[][] = [];
  return {
    scopes,
    getToken: (requested: string | string[]): Promise<AccessToken> => {
      scopes.push(Array.isArray(requested) ? requested : [requested]);
      return Promise.resolve({
        token: 'graph-token',
        expiresOnTimestamp: Date.now() + 3_600_000,
      });
    },
  };
}

function makeConn(graphUrl: string | null = null): {
  conn: MSGraphConnection;
  fake: FakeFetch;
  credential: FakeCredential;
  sleeps: number[];
} {
  const fake = createFakeFetch();
  const credential = fakeCredential();
  const sleeps: number[] = [];
  const conn = new MSGraphConnection({
    credential,
    mailbox: 'user@example.com',
    graphUrl,
    fetch: fake.fetch,
    sleep: ms => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { conn, fake, credential, sleeps };
}

function folders(...entries: [string, string][]): { json: unknown } {
  return {
    json: { value: entries.map(([id, displayName]) => ({ id, displayName })) },
  };
}

/** Answer folder listings by their `$filter` display name. */
function directory(
  byName: Record<string, string>,
): (request: RecordedRequest) => FakeResponse {
  return request => {
    const filter = request.url.searchParams.get('$filter') ?? '';
    const name = /^displayName eq '(.*)'$/su
      .exec(filter)?.[1]
      ?.replaceAll("''", "'");
    const id = name === undefined ? undefined : byName[name];
    return folders(
      ...(id === undefined ? [] : [[id, name ?? ''] as [string, string]]),
    );
  };
}

function body(fake: FakeFetch, method: string, path: string): unknown {
  const [request] = fake.find(method, path);
  return JSON.parse(request?.body ?? 'null');
}

describe('TestSubclass', () => {
  it('is a MailboxConnection', () => {
    const { conn } = makeConn();
    expect(conn).toBeInstanceOf(MailboxConnection);
    expect(conn.kind).toBe('msgraph');
  });
});

describe('TestKeepalive', () => {
  it('is a no-op', async () => {
    const { conn, fake } = makeConn();
    await conn.keepalive();
    expect(fake.requests).toHaveLength(0);
  });
});

describe('TestSendMessage', () => {
  it('sends plain text', async () => {
    const { conn, fake } = makeConn();
    fake.on('POST', `${USER}/sendMail`, { status: 202 });
    const result = await conn.sendMessage({
      messageFrom: 'ignored@example.com',
      messageTo: ['b@example.org'],
      subject: 'hi',
      plainMessage: 'hello',
    });
    expect(result).toBeNull();
    const [request] = fake.find('POST', `${USER}/sendMail`);
    expect(request?.headers.get('authorization')).toBe('Bearer graph-token');
    expect(request?.headers.get('content-type')).toBe('application/json');
    // Same payload as the Python SDK serializes.
    expect(request?.body).toBe(
      '{"Message":{"@odata.type":"#microsoft.graph.message","body":{"content":"hello","contentType":"text"},"subject":"hi","toRecipients":[{"emailAddress":{"address":"b@example.org"}}]},"SaveToSentItems":true}',
    );
  });

  it('passes saveToSentItems=false through', async () => {
    const { conn, fake } = makeConn();
    fake.on('POST', `${USER}/sendMail`, { status: 202 });
    await conn.sendMessage({
      messageFrom: 'ignored@example.com',
      messageTo: ['b@example.org'],
      plainMessage: 'hello',
      saveToSentItems: false,
    });
    expect(body(fake, 'POST', `${USER}/sendMail`)).toMatchObject({
      SaveToSentItems: false,
    });
  });

  it('sends HTML', async () => {
    const { conn, fake } = makeConn();
    fake.on('POST', `${USER}/sendMail`, { status: 202 });
    await conn.sendMessage({
      messageFrom: 'x@example.com',
      messageTo: ['b@example.org'],
      subject: 'hi',
      htmlMessage: '<p>hi</p>',
    });
    expect(body(fake, 'POST', `${USER}/sendMail`)).toMatchObject({
      Message: { body: { content: '<p>hi</p>', contentType: 'html' } },
    });
  });

  it('sends every recipient list', async () => {
    const { conn, fake } = makeConn();
    fake.on('POST', `${USER}/sendMail`, { status: 202 });
    await conn.sendMessage({
      messageFrom: 'x@example.com',
      messageTo: ['a@e.com', 'b@e.com'],
      messageCc: ['c@e.com'],
      messageBcc: ['d@e.com'],
      plainMessage: 'hi',
    });
    const { Message } = body(fake, 'POST', `${USER}/sendMail`) as {
      Message: Record<string, { emailAddress: { address: string } }[]>;
    };
    expect(Message.toRecipients).toHaveLength(2);
    expect(Message.ccRecipients).toEqual([
      { emailAddress: { address: 'c@e.com' } },
    ]);
    expect(Message.bccRecipients).toEqual([
      { emailAddress: { address: 'd@e.com' } },
    ]);
    expect(Message.toRecipients?.[0]?.emailAddress.address).toBe('a@e.com');
  });

  it('sends attachments as base64 file attachments', async () => {
    const { conn, fake } = makeConn();
    fake.on('POST', `${USER}/sendMail`, { status: 202 });
    await conn.sendMessage({
      messageFrom: 'x@example.com',
      messageTo: ['b@example.org'],
      plainMessage: 'hi',
      attachments: [['readme.txt', new TextEncoder().encode('contents')]],
    });
    expect(body(fake, 'POST', `${USER}/sendMail`)).toMatchObject({
      Message: {
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'readme.txt',
            contentBytes: Buffer.from('contents').toString('base64'),
          },
        ],
      },
    });
  });
});

describe('TestMessageOps', () => {
  it('fetches the raw message', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', `${MESSAGES}/msg42/$value`, { text: 'raw rfc822 bytes' });
    expect(await conn.fetchMessage('msg42')).toBe('raw rfc822 bytes');
    const [request] = fake.find('GET', `${MESSAGES}/msg42/$value`);
    expect(request?.headers.get('accept')).toBe(
      'application/octet-stream, application/json',
    );
    expect(fake.find('PATCH', /.*/u)).toHaveLength(0);
  });

  it('returns "" for an empty body', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', `${MESSAGES}/m2/$value`, { text: '' });
    expect(await conn.fetchMessage('m2')).toBe('');
  });

  it('marks the message read when asked', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', `${MESSAGES}/m3/$value`, { text: 'x' });
    fake.on('PATCH', `${MESSAGES}/m3`, { json: {} });
    await conn.fetchMessage('m3', { markRead: true });
    expect(body(fake, 'PATCH', `${MESSAGES}/m3`)).toEqual({
      '@odata.type': '#microsoft.graph.message',
      isRead: true,
    });
  });

  it('marks a message read', async () => {
    const { conn, fake } = makeConn();
    fake.on('PATCH', `${MESSAGES}/m4`, { json: {} });
    await conn.markMessageRead('m4');
    expect(body(fake, 'PATCH', `${MESSAGES}/m4`)).toMatchObject({
      isRead: true,
    });
  });

  it('deletes a message', async () => {
    const { conn, fake } = makeConn();
    fake.on('DELETE', `${MESSAGES}/m5`, { status: 204 });
    await conn.deleteMessage('m5');
    expect(fake.find('DELETE', `${MESSAGES}/m5`)).toHaveLength(1);
  });

  it('moves a message', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['folder-abc', 'Archive']));
    fake.on('POST', `${MESSAGES}/m6/move`, { json: { id: 'm6-new' } });
    await conn.moveMessage('m6', 'Archive');
    expect(body(fake, 'POST', `${MESSAGES}/m6/move`)).toEqual({
      DestinationId: 'folder-abc',
    });
  });

  it('decodes invalid UTF-8 with replacement characters', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', `${MESSAGES}/m7/$value`, {
      text: Buffer.from([0x61, 0xff, 0x62]).toString('latin1'),
    });
    expect(await conn.fetchMessage('m7')).toBe('aÿb');
  });

  // maxSize is not in mailsuite.
  it('refuses a message whose Content-Length is over maxSize', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', `${MESSAGES}/m8/$value`, {
      text: 'x'.repeat(2000),
      headers: { 'content-length': '2000' },
    });
    await expect(
      conn.fetchMessage('m8', { maxSize: 1000, markRead: true }),
    ).rejects.toThrow(
      new EmailTooLargeError(
        'Email of 2000 bytes exceeds the 1000 byte size limit (max_email_size)',
      ),
    );
    expect(fake.find('PATCH', /.*/u)).toHaveLength(0);
  });

  it('stops reading a body that grows past maxSize', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', `${MESSAGES}/m9/$value`, { text: 'x'.repeat(2000) });
    await expect(conn.fetchMessage('m9', { maxSize: 1000 })).rejects.toThrow(
      new EmailTooLargeError(
        'Email exceeds the 1000 byte size limit (max_email_size)',
      ),
    );
  });

  it('reads a message within maxSize', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', `${MESSAGES}/m10/$value`, { text: 'small' });
    expect(await conn.fetchMessage('m10', { maxSize: 1000 })).toBe('small');
  });

  it('percent-encodes message ids', async () => {
    const { conn, fake } = makeConn();
    fake.on('DELETE', /.*/u, { status: 204 });
    await conn.deleteMessage('AAMk/AD=');
    expect(fake.requests[0]?.url.pathname).toBe(`${MESSAGES}/AAMk%2FAD%3D`);
  });
});

describe('TestFolderResolution', () => {
  it('finds a folder by display name', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['abc123', 'Reports']));
    expect(await conn.findFolderIdFromFolderPath('Reports')).toBe('abc123');
  });

  it('raises for an unknown folder', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders());
    await expect(
      conn.findFolderIdFromFolderPath('DoesNotExist'),
    ).rejects.toThrow(/not found/u);
  });

  it('escapes single quotes in the OData filter', async () => {
    // Apostrophes must be doubled or Graph rejects the filter expression.
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['id1', "John's mail"]));
    expect(await conn.findFolderIdFromFolderPath("John's mail")).toBe('id1');
    const [request] = fake.find('GET', FOLDERS);
    expect(request?.url.searchParams.get('$filter')).toBe(
      "displayName eq 'John''s mail'",
    );
    expect(request?.url.search).toBe(
      '?%24filter=displayName%20eq%20%27John%27%27s%20mail%27',
    );
  });

  it('falls back to a well-known folder', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders());
    fake.on('GET', `${FOLDERS}/inbox`, { json: { id: 'inbox-id' } });
    expect(await conn.findFolderIdFromFolderPath('Inbox')).toBe('inbox-id');
  });

  it('normalizes well-known names', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders());
    fake.on('GET', `${FOLDERS}/sentitems`, { json: { id: 'sent-id' } });
    expect(await conn.findFolderIdFromFolderPath('Sent Items')).toBe('sent-id');
  });

  it('uses the well-known folder when listing fails', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, { status: 500, json: { error: { code: 'x' } } });
    fake.on('GET', `${FOLDERS}/junkemail`, { json: { id: 'junk-id' } });
    expect(await conn.findFolderIdFromFolderPath('Junk-Email')).toBe('junk-id');
  });

  it('resolves nested paths through child folders', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['p1', 'Parent']));
    fake.on('GET', `${FOLDERS}/p1/childFolders`, folders(['c1', 'Child']));
    expect(await conn.findFolderIdFromFolderPath('Parent/Child')).toBe('c1');
    const [child] = fake.find('GET', `${FOLDERS}/p1/childFolders`);
    expect(child?.url.searchParams.get('$filter')).toBe(
      "displayName eq 'Child'",
    );
  });

  it('caches resolved paths', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['abc123', 'Reports']));
    await conn.findFolderIdFromFolderPath('Reports');
    await conn.findFolderIdFromFolderPath('Reports');
    expect(fake.find('GET', FOLDERS)).toHaveLength(1);
  });
});

describe('TestCreateFolder', () => {
  it('creates a top-level folder', async () => {
    const { conn, fake } = makeConn();
    fake.on('POST', FOLDERS, { status: 201, json: { id: 'new' } });
    await conn.createFolder('Reports');
    expect(fake.find('POST', FOLDERS)).toHaveLength(1);
    expect(body(fake, 'POST', FOLDERS)).toEqual({ displayName: 'Reports' });
  });

  it('creates a nested folder under its parent', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['p1', 'Parent']));
    fake.on('POST', `${FOLDERS}/p1/childFolders`, { status: 201, json: {} });
    await conn.createFolder('Parent/Child');
    expect(body(fake, 'POST', `${FOLDERS}/p1/childFolders`)).toEqual({
      displayName: 'Child',
    });
  });

  it('swallows 409 Conflict for an existing folder', async () => {
    const { conn, fake } = makeConn();
    fake.on('POST', FOLDERS, {
      status: 409,
      json: { error: { code: 'ErrorFolderExists', message: 'exists' } },
    });
    await expect(conn.createFolder('Reports')).resolves.toBeUndefined();
  });

  it('propagates other errors', async () => {
    const { conn, fake } = makeConn();
    fake.on('POST', FOLDERS, {
      status: 400,
      json: { error: { code: 'BadRequest', message: 'server explosion' } },
    });
    await expect(conn.createFolder('Reports')).rejects.toThrow(/explosion/u);
  });
});

describe('TestRenameFolder', () => {
  it('patches the display name', async () => {
    const { conn, fake } = makeConn();
    // The first listing (empty) answers the conflict check for the new
    // name; the second resolves the folder being renamed.
    fake.on('GET', FOLDERS, folders(), folders(['fid1', 'Old']));
    fake.on('PATCH', `${FOLDERS}/fid1`, { json: {} });
    await conn.renameFolder('Old', 'New');
    expect(body(fake, 'PATCH', `${FOLDERS}/fid1`)).toEqual({
      displayName: 'New',
    });
  });

  it('uses the leaf of the new name', async () => {
    // Graph renames in place; only the leaf becomes the display name.
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, directory({ Old: 'fid2' }));
    fake.on('PATCH', `${FOLDERS}/fid2`, { json: {} });
    await conn.renameFolder('Old', 'Parent/Renamed');
    expect(body(fake, 'PATCH', `${FOLDERS}/fid2`)).toEqual({
      displayName: 'Renamed',
    });
  });

  it('raises on a conflict', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['dup', 'New']));
    await expect(conn.renameFolder('Old', 'New')).rejects.toThrow(
      FolderExistsError,
    );
    expect(fake.find('PATCH', /.*/u)).toHaveLength(0);
  });
});

describe('TestFolderExists', () => {
  it('is true when the folder resolves', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['fid1', 'Reports']));
    expect(await conn.folderExists('Reports')).toBe(true);
  });

  it('is false when not found', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders());
    expect(await conn.folderExists('Missing')).toBe(false);
  });

  it('propagates listing failures', async () => {
    // A failed listing (auth/network) must not read as a missing folder.
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, {
      status: 401,
      json: { error: { code: 'InvalidAuthenticationToken', message: 'no' } },
    });
    await expect(conn.folderExists('Whatever')).rejects.toThrow(
      /Failed to list folders/u,
    );
  });
});

describe('TestDeleteFolder', () => {
  it('deletes the resolved folder', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['fid1', 'Junk']));
    fake.on('DELETE', `${FOLDERS}/fid1`, { status: 204 });
    await conn.deleteFolder('Junk');
    expect(fake.find('DELETE', `${FOLDERS}/fid1`)).toHaveLength(1);
  });
});

describe('TestDoMoveFolder', () => {
  it('moves natively to the parent', async () => {
    const { conn, fake } = makeConn();
    fake.on(
      'GET',
      FOLDERS,
      directory({ Forensic: 'fid_src', Reports: 'fid_parent' }),
    );
    fake.on('GET', `${FOLDERS}/fid_parent/childFolders`, directory({}));
    fake.on('POST', `${FOLDERS}/fid_src/move`, { json: { id: 'fid_src' } });
    await conn.moveFolder('Forensic', { newParent: 'Reports' });
    expect(body(fake, 'POST', `${FOLDERS}/fid_src/move`)).toEqual({
      DestinationId: 'fid_parent',
    });
    // Same leaf name: no follow-up rename.
    expect(fake.find('PATCH', /.*/u)).toHaveLength(0);
  });

  it('uses msgfolderroot for the top level', async () => {
    // Move P/Forensic to the top level ("" parent = the mailbox root).
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, directory({ P: 'p' }));
    fake.on(
      'GET',
      `${FOLDERS}/p/childFolders`,
      directory({ Forensic: 'fid_src' }),
    );
    fake.on('POST', `${FOLDERS}/fid_src/move`, { json: { id: 'fid_src' } });
    await conn.moveFolder('P/Forensic', { newParent: '' });
    expect(body(fake, 'POST', `${FOLDERS}/fid_src/move`)).toEqual({
      DestinationId: 'msgfolderroot',
    });
  });

  it('renames the leaf using the id returned by the move', async () => {
    // A move can change the folder id; the rename must target the new one.
    const { conn, fake } = makeConn();
    fake.on(
      'GET',
      FOLDERS,
      directory({ Forensic: 'fid_src', Reports: 'fid_parent' }),
    );
    fake.on('GET', `${FOLDERS}/fid_parent/childFolders`, directory({}));
    fake.on('POST', `${FOLDERS}/fid_src/move`, { json: { id: 'fid_new' } });
    fake.on('PATCH', `${FOLDERS}/fid_new`, { json: {} });
    await conn.moveFolder('Forensic', { newPath: 'Reports/Failure' });
    expect(body(fake, 'PATCH', `${FOLDERS}/fid_new`)).toEqual({
      displayName: 'Failure',
    });
    expect(fake.find('PATCH', `${FOLDERS}/fid_src`)).toHaveLength(0);
  });
});

function messagePage(
  ids: string[],
  nextLink: string | null = null,
): { json: unknown } {
  return {
    json: {
      value: ids.map(id => ({ id })),
      ...(nextLink === null ? {} : { '@odata.nextLink': nextLink }),
    },
  };
}

const NEXT_LINK = `https://graph.microsoft.com${FOLDERS}/f1/messages?%24skiptoken=L2`;

describe('TestFetchMessagesPagination', () => {
  it('reads a single page', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['f1', 'Reports']));
    fake.on('GET', `${FOLDERS}/f1/messages`, messagePage(['m1', 'm2']));
    expect(await conn.fetchMessages('Reports')).toEqual(['m1', 'm2']);
    const [request] = fake.find('GET', `${FOLDERS}/f1/messages`);
    expect(request?.url.search).toBe('?%24select=id&%24top=100');
  });

  it('caps at batchSize even with since', async () => {
    // Regression: `since` used to disable the batchSize cap.
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['f1', 'Reports']));
    fake.on(
      'GET',
      `${FOLDERS}/f1/messages`,
      messagePage(['m1', 'm2'], NEXT_LINK),
      messagePage(['m3', 'm4']),
    );
    const ids = await conn.fetchMessages('Reports', {
      batchSize: 2,
      since: '2024-01-01T00:00:00Z',
    });
    expect(ids).toEqual(['m1', 'm2']);
    const requests = fake.find('GET', `${FOLDERS}/f1/messages`);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.searchParams.get('$filter')).toBe(
      'receivedDateTime ge 2024-01-01T00:00:00Z',
    );
    expect(requests[0]?.url.searchParams.get('$top')).toBe('2');
  });

  it('fetches every page with batchSize 0 and since', async () => {
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['f1', 'Reports']));
    fake.on(
      'GET',
      `${FOLDERS}/f1/messages`,
      messagePage(['m1', 'm2'], NEXT_LINK),
      messagePage(['m3', 'm4']),
    );
    const ids = await conn.fetchMessages('Reports', {
      batchSize: 0,
      since: '2024-01-01T00:00:00Z',
    });
    expect(ids).toEqual(['m1', 'm2', 'm3', 'm4']);
    const requests = fake.find('GET', `${FOLDERS}/f1/messages`);
    // The second request is the nextLink, as given.
    expect(requests[1]?.url.href).toBe(NEXT_LINK);
  });

  it('refuses a nextLink on another host', async () => {
    // The bearer token must never leave the Graph host.
    const { conn, fake } = makeConn();
    fake.on('GET', FOLDERS, folders(['f1', 'Reports']));
    fake.on(
      'GET',
      `${FOLDERS}/f1/messages`,
      messagePage(['m1'], 'https://evil.example/steal'),
    );
    await expect(conn.fetchMessages('Reports')).rejects.toThrow(
      /Refusing to send/u,
    );
    expect(
      fake.requests.every(
        request => request.url.host === 'graph.microsoft.com',
      ),
    ).toBe(true);
  });
});

describe('TestWatch', () => {
  it('exits on config reload', async () => {
    const { conn } = makeConn();
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
    // Both reload checks of iteration 1 are false (the callback runs); the
    // first check of iteration 2 is true (the loop exits).
    const { conn } = makeConn();
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
});

describe('TestGraphUrl', () => {
  it.each([
    'https://graph.microsoft.us',
    'https://dod-graph.microsoft.us',
    'https://microsoftgraph.chinacloudapi.cn',
    'https://graph.microsoft.de',
    'https://graph.example.test',
    'https://graph.microsoft.us/', // trailing slash stripped
  ])('overrides the base URL: %s', async url => {
    const { conn, fake, credential } = makeConn(url);
    expect(conn.client.baseUrl).toBe(`${url.replace(/\/$/u, '')}/v1.0`);
    fake.on('DELETE', /.*/u, { status: 204 });
    await conn.deleteMessage('m1');
    const { origin } = new URL(url);
    expect(fake.requests[0]?.url.href).toBe(
      `${origin}/v1.0/users/user%40example.com/messages/m1`,
    );
    // App-only token for the sovereign cloud's resource.
    expect(credential.scopes[0]).toEqual([`${origin}/.default`]);
  });

  it('defaults to the worldwide cloud', () => {
    const { conn } = makeConn();
    expect(conn.client.baseUrl).toBe('https://graph.microsoft.com/v1.0');
  });

  it('rejects plain http', () => {
    expect(() => makeConn('http://graph.example.test')).toThrow(
      'Only https is supported',
    );
  });
});

describe('Graph errors and retries', () => {
  it('raises ODataError with the Graph details', async () => {
    const { conn, fake } = makeConn();
    fake.on('DELETE', `${MESSAGES}/m1`, {
      status: 404,
      headers: { 'request-id': 'req-1' },
      json: {
        error: {
          code: 'ErrorItemNotFound',
          message: 'The specified object was not found in the store.',
          innerError: {
            'request-id': 'req-1',
            'client-request-id': 'client-1',
            date: '2026-10-24T00:00:00',
          },
        },
      },
    });
    const error: unknown = await conn
      .deleteMessage('m1')
      .catch(error_ => error_);
    expect(error).toBeInstanceOf(ODataError);
    const odata = error as ODataError;
    expect(odata.responseStatusCode).toBe(404);
    expect(odata.primaryMessage).toBe(
      'The specified object was not found in the store.',
    );
    expect(odata.message).toBe(odata.primaryMessage);
    expect(odata.mainError).toEqual({
      code: 'ErrorItemNotFound',
      message: 'The specified object was not found in the store.',
      innerError: {
        requestId: 'req-1',
        clientRequestId: 'client-1',
        date: '2026-10-24T00:00:00',
      },
    });
    expect(odata.responseHeaders['request-id']).toBe('req-1');
  });

  it('raises APIError for a non-OData error body', async () => {
    const { conn, fake } = makeConn();
    fake.on('DELETE', `${MESSAGES}/m1`, { status: 400, text: 'nope' });
    const error: unknown = await conn
      .deleteMessage('m1')
      .catch(error_ => error_);
    expect(error).toBeInstanceOf(APIError);
    expect(error).not.toBeInstanceOf(ODataError);
    expect((error as APIError).responseStatusCode).toBe(400);
  });

  it('retries 429 honoring Retry-After', async () => {
    const { conn, fake, sleeps } = makeConn();
    fake.on(
      'DELETE',
      `${MESSAGES}/m1`,
      { status: 429, headers: { 'Retry-After': '7' } },
      { status: 204 },
    );
    await conn.deleteMessage('m1');
    expect(sleeps).toEqual([7000]);
    const requests = fake.find('DELETE', `${MESSAGES}/m1`);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.has('retry-attempt')).toBe(false);
    expect(requests[1]?.headers.get('retry-attempt')).toBe('1');
  });

  it('gives up after three retries with backoff', async () => {
    const { conn, fake, sleeps } = makeConn();
    fake.on('POST', `${USER}/sendMail`, {
      status: 503,
      json: { error: { code: 'ServiceUnavailable', message: 'busy' } },
    });
    await expect(
      conn.sendMessage({ messageFrom: 'x', plainMessage: 'hi' }),
    ).rejects.toThrow('busy');
    expect(fake.find('POST', `${USER}/sendMail`)).toHaveLength(4);
    // 0.5 * 2^(n-1) + up to 1 s of jitter + the 3 s base delay.
    const bounds: [number, number][] = [
      [3.25, 4.25],
      [3.5, 4.5],
      [4, 5],
    ];
    expect(sleeps).toHaveLength(3);
    for (const [index, ms] of sleeps.entries()) {
      const [low, high] = bounds[index] ?? [0, 0];
      expect(ms).toBeGreaterThanOrEqual(low * 1000);
      expect(ms).toBeLessThanOrEqual(high * 1000);
    }
  });

  it('does not retry a Retry-After of 180 seconds or more', async () => {
    const { conn, fake, sleeps } = makeConn();
    fake.on('DELETE', `${MESSAGES}/m1`, {
      status: 429,
      headers: { 'Retry-After': '600' },
      json: { error: { code: 'TooManyRequests', message: 'slow down' } },
    });
    await expect(conn.deleteMessage('m1')).rejects.toThrow('slow down');
    expect(sleeps).toEqual([]);
  });

  it('does not retry other errors', async () => {
    const { conn, fake } = makeConn();
    fake.on('DELETE', `${MESSAGES}/m1`, { status: 500, json: { error: {} } });
    await expect(conn.deleteMessage('m1')).rejects.toBeInstanceOf(ODataError);
    expect(fake.requests).toHaveLength(1);
  });

  it('sends a timeout signal with every request', async () => {
    const fake = createFakeFetch();
    const signals: (AbortSignal | null | undefined)[] = [];
    const conn = new MSGraphConnection({
      credential: fakeCredential(),
      mailbox: 'user@example.com',
      fetch: (input, init) => {
        signals.push(init?.signal);
        return fake.fetch(input, init);
      },
    });
    fake.on('DELETE', /.*/u, { status: 204 });
    await conn.deleteMessage('m1');
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});
