// Local socket servers and throwaway certificates for tests: the
// tests assert on the bytes a real server receives.

import { execFileSync } from 'node:child_process';
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { mkdtempSync, readFileSync } from 'node:fs';
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createServer as createTlsServer,
  type TLSSocket,
  type TlsOptions,
} from 'node:tls';

export interface CertificateFiles {
  certPath: string;
  keyPath: string;
  cert: Buffer;
  key: Buffer;
}

/** A self-signed certificate for `localhost` / 127.0.0.1, made with openssl. */
export function makeSelfSignedCertificate(
  commonName = 'localhost',
): CertificateFiles {
  const directory = mkdtempSync(path.join(tmpdir(), 'tsdmarc-cert-'));
  const certPath = path.join(directory, 'cert.pem');
  const keyPath = path.join(directory, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      `/CN=${commonName}`,
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return {
    certPath,
    keyPath,
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}

let localhostCertificateFiles: CertificateFiles | undefined;

/**
 * A self-signed `localhost` certificate made on first use and reused for
 * the rest of the test file (the fake IMAP and SMTP servers' TLS), so no
 * private key is kept in the repo.
 */
export function localhostCertificate(): CertificateFiles {
  localhostCertificateFiles ??= makeSelfSignedCertificate('localhost');
  return localhostCertificateFiles;
}

export interface UdpServer {
  port: number;
  socket: DatagramSocket;
  /** Resolves with the next `count` datagrams. */
  receive: (count?: number) => Promise<Buffer[]>;
  close: () => Promise<void>;
}

export async function startUdpServer(): Promise<UdpServer> {
  const socket = createSocket('udp4');
  const queue: Buffer[] = [];
  let waiter: (() => void) | null = null;
  socket.on('message', message => {
    queue.push(message);
    waiter?.();
  });
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: socket.address().port,
    socket,
    async receive(count = 1): Promise<Buffer[]> {
      while (queue.length < count) {
        await new Promise<void>(resolve => {
          waiter = resolve;
        });
        waiter = null;
      }
      return queue.splice(0, count);
    },
    close: async (): Promise<void> => {
      await new Promise<void>(resolve => socket.close(() => resolve()));
    },
  };
}

export interface StreamServer {
  port: number;
  server: Server;
  /** Every accepted connection, in order. */
  connections: (Socket | TLSSocket)[];
  /** Bytes received on all connections so far. */
  received: () => Buffer;
  /** Resolves once at least `length` bytes arrived. */
  waitForBytes: (length: number) => Promise<Buffer>;
  /** Resolves once there was a connection and the client closed every one. */
  waitForClose: () => Promise<void>;
  close: () => Promise<void>;
}

function streamServer(
  server: Server,
  secureEvent: boolean,
): Promise<StreamServer> {
  const connections: (Socket | TLSSocket)[] = [];
  const chunks: Buffer[] = [];
  const closed: Promise<void>[] = [];
  let notify: (() => void) | null = null;
  server.on(
    secureEvent ? 'secureConnection' : 'connection',
    (socket: Socket) => {
      connections.push(socket);
      closed.push(new Promise(resolve => socket.on('close', () => resolve())));
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        notify?.();
      });
    },
  );
  if (secureEvent) {
    server.on('tlsClientError', () => undefined);
  }
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        server,
        connections,
        received: () => Buffer.concat(chunks),
        async waitForBytes(length: number): Promise<Buffer> {
          while (Buffer.concat(chunks).length < length) {
            await new Promise<void>(done => {
              notify = done;
            });
            notify = null;
          }
          return Buffer.concat(chunks);
        },
        async waitForClose(): Promise<void> {
          // Connections are registered asynchronously: wait for the first.
          while (closed.length === 0) {
            await new Promise(done => setTimeout(done, 5));
          }
          await Promise.all(closed);
        },
        close: async (): Promise<void> => {
          for (const socket of connections) {
            socket.destroy();
          }
          await new Promise<void>(done => server.close(() => done()));
        },
      });
    });
  });
}

export async function startTcpServer(): Promise<StreamServer> {
  return await streamServer(createServer(), false);
}

export async function startTlsServer(
  options: TlsOptions,
): Promise<StreamServer> {
  return await streamServer(createTlsServer(options), true);
}

/** A port with nothing listening on it (bound once, then released). */
export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** Split NUL-terminated frames. */
export function nulFrames(data: Buffer): string[] {
  const text = data.toString('utf-8');
  const frames = text.split('\0');
  // The last element is what follows the final NUL (empty when complete).
  frames.pop();
  return frames;
}
