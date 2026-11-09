// Socket plumbing shared by the syslog and GELF handlers. Python's logging
// handlers send with blocking calls; here `emit()` stays synchronous and
// queues the send, keeping Python's one-at-a-time order.

import type { Socket as DatagramSocket } from 'node:dgram';
import { connect as netConnect, type Socket } from 'node:net';
import {
  connect as tlsConnect,
  type ConnectionOptions,
  type TLSSocket,
} from 'node:tls';

const KEEP_ALIVE_INTERVAL_MS = 2 ** 30;

/** Python's `SocketHandler` reconnect back-off, in seconds. */
export const RETRY_START = 1;
export const RETRY_MAX = 30;
export const RETRY_FACTOR = 2;

/** Python's `TimeoutError: timed out` for socket operations. */
export class SocketTimeoutError extends Error {
  override name = 'TimeoutError';

  constructor() {
    super('timed out');
  }
}

/**
 * Runs send tasks one after another. Sockets are unref'd, like Python's,
 * which never hold the interpreter open; while sends are queued a timer
 * keeps the event loop alive so they are not cut short.
 */
export class SendQueue {
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;
  #keepAlive: ReturnType<typeof setInterval> | null = null;

  /** Queue `task`; its error goes to `onError` (never rejects the queue). */
  push(task: () => Promise<void>, onError: (error: unknown) => void): void {
    this.#queued += 1;
    this.#keepAlive ??= setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
    this.#tail = this.#tail.then(() => this.#run(task, onError));
  }

  async #run(
    task: () => Promise<void>,
    onError: (error: unknown) => void,
  ): Promise<void> {
    try {
      await task();
    } catch (error) {
      onError(error);
    } finally {
      this.#queued -= 1;
      if (this.#queued === 0 && this.#keepAlive !== null) {
        clearInterval(this.#keepAlive);
        this.#keepAlive = null;
      }
    }
  }

  /** Resolves once every queued send has finished. */
  async drain(): Promise<void> {
    await this.#tail;
  }
}

/**
 * Messages a stream handler could not deliver. `emit()` can't report them
 * and `SendQueue` runs on, so the client's save method asks here after
 * draining and fails, which keeps the batch from counting as saved.
 */
export class SendFailures {
  #count = 0;
  #first: unknown = null;

  record(error: unknown): void {
    if (this.#count === 0) {
      this.#first = error;
    }
    this.#count += 1;
  }

  /** The failures since the last call, or `null` when there were none. */
  take(): { count: number; error: unknown } | null {
    if (this.#count === 0) {
      return null;
    }
    const failures = { count: this.#count, error: this.#first };
    this.#count = 0;
    this.#first = null;
    return failures;
  }
}

/** Run `start` and settle with it, or reject after `timeoutMs`. */
async function withTimeout<T>(
  timeoutMs: number | null,
  start: (
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ) => void,
  onTimeout: () => void = () => undefined,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            onTimeout();
            reject(new SocketTimeoutError());
          }, timeoutMs);
    const done = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
    start(
      value => {
        done();
        resolve(value);
      },
      error => {
        done();
        reject(error);
      },
    );
  });
}

/** Connect a TCP socket, failing after `timeoutMs`. */
export async function connectTcp(
  options: { host: string; port: number; family?: number },
  timeoutMs: number | null,
): Promise<Socket> {
  const socket = netConnect(options);
  try {
    await withTimeout<void>(
      timeoutMs,
      (resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      },
      () => socket.destroy(),
    );
  } catch (error) {
    socket.destroy();
    throw error;
  }
  socket.removeAllListeners('error');
  socket.on('error', () => undefined);
  return socket;
}

/** Start TLS (over `options.socket` or a new connection), with a timeout. */
export async function connectTls(
  options: ConnectionOptions,
  timeoutMs: number | null,
): Promise<TLSSocket> {
  const socket = tlsConnect(options);
  try {
    await withTimeout<void>(
      timeoutMs,
      (resolve, reject) => {
        socket.once('secureConnect', () => resolve());
        socket.once('error', reject);
      },
      () => socket.destroy(),
    );
  } catch (error) {
    socket.destroy();
    throw error;
  }
  socket.removeAllListeners('error');
  socket.on('error', () => undefined);
  return socket;
}

/** Python's `sock.sendall(data)`, with the socket's timeout. */
export async function sendAll(
  socket: Socket,
  data: Uint8Array,
  timeoutMs: number | null,
): Promise<void> {
  await withTimeout<void>(timeoutMs, (resolve, reject) => {
    if (socket.destroyed || !socket.writable) {
      reject(Object.assign(new Error('Broken pipe'), { code: 'EPIPE' }));
      return;
    }
    socket.write(data, error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/** Python's `sock.sendto(data, (host, port))`. */
export async function sendTo(
  socket: DatagramSocket,
  data: Uint8Array,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(data, port, host, error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/** Close a stream socket after its pending writes, without waiting forever. */
export async function closeStream(
  socket: Socket,
  timeoutMs: number,
): Promise<void> {
  if (socket.destroyed) {
    return;
  }
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      socket.destroy();
    }, timeoutMs);
    timer.unref();
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    // Like Python's close(): flush what was written, then drop the socket
    // without waiting for the peer to close its side.
    socket.end(() => socket.destroy());
  });
}

/** Close a datagram socket. */
export async function closeDatagram(socket: DatagramSocket): Promise<void> {
  await new Promise<void>(resolve => {
    try {
      socket.close(() => resolve());
    } catch {
      // Already closed.
      resolve();
    }
  });
}
