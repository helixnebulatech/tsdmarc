// A stand-in for imapflow's `ImapFlow`, used with `vi.mock('imapflow')`.
//
// It records every call (method name and arguments) in `server.calls`, so
// tests assert on the IMAP operations the client sends, and serves a small
// in-memory mailbox. `server.failures` queues per-method outcomes (an Error
// to throw, or `false` for imapflow's "command failed" result).

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import type { ImapFlowOptions, NamespacesObject } from 'imapflow';

export type Call = [method: string, ...args: unknown[]];

/** What a fetchOne() call returns instead of the stored message. */
export type FetchOverride = Record<string, unknown> | false;

export interface FakeServer {
  capabilities: string[];
  folders: { path: string; delimiter: string }[];
  namespaces: NamespacesObject | undefined;
  /** UID → raw message. */
  messages: Map<number, Buffer>;
  calls: Call[];
  instances: FakeImapFlow[];
  failures: Map<string, (Error | false)[]>;
  fetchOverrides: FetchOverride[];
  /** UID → RFC822.SIZE to report instead of the message's length. */
  sizeOverrides: Map<number, number>;
  /** The server advertises STARTTLS (before login) and the upgrade works. */
  starttls: boolean;
  /** Called after each idle() starts, with the connection and the 1-based IDLE count. */
  onIdle: ((flow: FakeImapFlow, count: number) => void) | null;
  idleCount: number;
  /** Methods whose next call never gets an answer (until close()). */
  hangs: string[];
}

export function newServer(): FakeServer {
  return {
    capabilities: ['IMAP4rev1', 'IDLE', 'MOVE', 'UIDPLUS'],
    folders: [{ path: 'INBOX', delimiter: '/' }],
    namespaces: undefined,
    messages: new Map(),
    calls: [],
    instances: [],
    failures: new Map(),
    fetchOverrides: [],
    sizeOverrides: new Map(),
    starttls: false,
    onIdle: null,
    idleCount: 0,
    hangs: [],
  };
}

/** The shared fake server state; `resetServer()` clears it in place. */
export const server: FakeServer = newServer();

export function resetServer(): FakeServer {
  Object.assign(server, newServer());
  return server;
}

/** Queue outcomes for the next calls of `method`. */
export function failNext(method: string, ...outcomes: (Error | false)[]): void {
  server.failures.set(method, [
    ...(server.failures.get(method) ?? []),
    ...outcomes,
  ]);
}

/** An error as imapflow raises it, with a `code`. */
export function imapflowError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The calls of one method, without the method name. */
export function callsOf(method: string): unknown[][] {
  return server.calls
    .filter(([name]) => name === method)
    .map(([, ...args]) => args);
}

export class FakeImapFlow extends EventEmitter {
  readonly options: ImapFlowOptions;
  capabilities: Map<string, boolean> = new Map();
  namespaces: NamespacesObject | undefined;
  secureConnection = false;
  /** How the credentials were sent: null before login. */
  loggedIn: { secure: boolean } | null = null;
  mailbox: { path: string } | false = false;
  /** The real imapflow's response parser limits (see `responseLimits()`). */
  streamer = { maxLineLength: 0, maxLiteralSize: 0, maxResponseSize: 0 };
  private endIdle: (() => void) | null = null;
  private received = 0;
  private hung: (() => void)[] = [];

  constructor(options: ImapFlowOptions) {
    super();
    this.options = options;
    server.instances.push(this);
  }

  /** Bytes "received": every answered call counts as some. */
  stats(): { sent: number; received: number } {
    return { sent: 0, received: this.received };
  }

  /** If `method` is queued in `server.hangs`, wait until close(), then fail. */
  private async hang(method: string): Promise<void> {
    const index = server.hangs.indexOf(method);
    if (index === -1) {
      return;
    }
    server.hangs.splice(index, 1);
    await new Promise<void>(resolve => this.hung.push(resolve));
    throw imapflowError('Connection not available', 'NoConnection');
  }

  /** Record a call and apply a queued failure. Returns false for "command failed". */
  private record(method: string, ...args: unknown[]): boolean {
    if (method !== 'idle') {
      this.breakIdle();
    }
    server.calls.push([method, ...args]);
    this.received += 1;
    const outcome = server.failures.get(method)?.shift();
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome !== false;
  }

  /** Like imapflow: a command sent while idling ends IDLE first. */
  private breakIdle(): void {
    const end = this.endIdle;
    this.endIdle = null;
    end?.();
  }

  async connect(): Promise<void> {
    this.record('connect');
    await Promise.resolve();
    // Pre-login capabilities, then imapflow's STARTTLS decision.
    this.capabilities = new Map(
      [...server.capabilities, ...(server.starttls ? ['STARTTLS'] : [])].map(
        name => [name, true],
      ),
    );
    this.secureConnection = Boolean(this.options.secure);
    await this.upgradeToSTARTTLS();
    this.loggedIn = { secure: this.secureConnection };
    this.capabilities = new Map(server.capabilities.map(name => [name, true]));
    this.namespaces = server.namespaces;
  }

  /** imapflow's policy (`doSTARTTLS`: true requires, false never). */
  async upgradeToSTARTTLS(): Promise<boolean> {
    await Promise.resolve();
    if (this.secureConnection) {
      return true;
    }
    if (this.options.doSTARTTLS === false) {
      return false;
    }
    if (!this.capabilities.has('STARTTLS')) {
      if (this.options.doSTARTTLS === true) {
        throw Object.assign(new Error('Server does not support STARTTLS'), {
          tlsFailed: true,
        });
      }
      return false;
    }
    server.calls.push(['starttls']);
    this.secureConnection = true;
    return true;
  }

  async logout(): Promise<void> {
    this.record('logout');
    await Promise.resolve();
  }

  close(): void {
    this.breakIdle();
    server.calls.push(['close']);
    for (const resolve of this.hung.splice(0)) {
      resolve();
    }
  }

  async list(
    options?: unknown,
  ): Promise<{ path: string; delimiter: string }[]> {
    this.record('list', options);
    await Promise.resolve();
    return server.folders.map(folder => ({ ...folder }));
  }

  async mailboxOpen(path: string): Promise<{ path: string } | false> {
    if (!this.record('mailboxOpen', path)) {
      return false;
    }
    await Promise.resolve();
    this.mailbox = { path };
    return this.mailbox;
  }

  async search(query: unknown, options: unknown): Promise<number[] | false> {
    if (!this.record('search', query, options)) {
      return false;
    }
    await Promise.resolve();
    return [...server.messages.keys()];
  }

  async fetchOne(
    seq: string,
    query: unknown,
    options: unknown,
  ): Promise<Record<string, unknown> | false> {
    this.record('fetchOne', seq, query, options);
    await Promise.resolve();
    if (server.fetchOverrides.length > 0) {
      return server.fetchOverrides.shift() as FetchOverride;
    }
    const uid = Number(seq);
    const source = server.messages.get(uid);
    if (source === undefined) {
      return false;
    }
    if (!(query as { source?: unknown }).source) {
      // An RFC822.SIZE fetch.
      return {
        seq: 1,
        uid,
        size: server.sizeOverrides.get(uid) ?? source.length,
      };
    }
    return { seq: 1, uid, source };
  }

  async download(
    range: string,
    part: unknown,
    options: unknown,
  ): Promise<{ meta?: object; content?: Readable }> {
    this.record('download', range, part, options);
    await Promise.resolve();
    const source = server.messages.get(Number(range));
    if (source === undefined) {
      return {};
    }
    return {
      meta: {},
      content: Readable.from([source.subarray(0, 3), source.subarray(3)]),
    };
  }

  async messageCopy(
    range: unknown,
    destination: string,
    options: unknown,
  ): Promise<object | false> {
    if (!this.record('messageCopy', range, destination, options)) {
      return false;
    }
    await Promise.resolve();
    return { path: 'INBOX', destination };
  }

  async messageMove(
    range: unknown,
    destination: string,
    options: unknown,
  ): Promise<object | false> {
    if (!this.record('messageMove', range, destination, options)) {
      return false;
    }
    await this.hang('messageMove');
    return { path: 'INBOX', destination };
  }

  async messageFlagsAdd(
    range: unknown,
    flags: string[],
    options: unknown,
  ): Promise<boolean> {
    const ok = this.record('messageFlagsAdd', range, flags, options);
    await Promise.resolve();
    return ok;
  }

  async messageDelete(range: unknown, options?: unknown): Promise<boolean> {
    const ok =
      options === undefined
        ? this.record('messageDelete', range)
        : this.record('messageDelete', range, options);
    await Promise.resolve();
    return ok;
  }

  async mailboxCreate(path: string): Promise<object | false> {
    if (!this.record('mailboxCreate', path)) {
      return false;
    }
    await Promise.resolve();
    server.folders.push({ path, delimiter: '/' });
    return { path, created: true };
  }

  async mailboxRename(path: string, newPath: string): Promise<object | false> {
    if (!this.record('mailboxRename', path, newPath)) {
      return false;
    }
    await Promise.resolve();
    return { path, newPath };
  }

  async mailboxDelete(path: string): Promise<object | false> {
    if (!this.record('mailboxDelete', path)) {
      return false;
    }
    await Promise.resolve();
    return { path };
  }

  async noop(): Promise<void> {
    this.record('noop');
    await this.hang('noop');
  }

  /** Resolves when IDLE is broken by the next command. */
  idle(): Promise<boolean> {
    this.record('idle');
    server.idleCount += 1;
    const count = server.idleCount;
    const ended = new Promise<boolean>(resolve => {
      this.endIdle = () => resolve(true);
    });
    server.onIdle?.(this, count);
    return ended;
  }

  /** Simulate the server ending IDLE on its own (a tagged OK). */
  serverEndsIdle(): void {
    this.breakIdle();
  }

  /** Simulate the connection dropping. */
  drop(): void {
    this.breakIdle();
    this.emit('close');
  }
}
