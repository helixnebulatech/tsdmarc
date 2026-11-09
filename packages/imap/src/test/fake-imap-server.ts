// A minimal IMAP server on 127.0.0.1, for tests that run the real imapflow
// over a socket (socket timeouts, IDLE). It logs in anyone, has an empty
// INBOX, answers IDLE with a continuation and DONE with OK, and can be told
// to leave some commands unanswered. With `starttls`, it advertises
// STARTTLS and upgrades the connection when asked.

import { createServer, type Server, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';

import { localhostCertificate } from '../../../tsdmarc/src/test/sockets';

export interface FakeImapServer {
  /** The loopback address it listens on. */
  host: string;
  port: number;
  /** Connections accepted so far. */
  connections: number;
  /** Command lines received (tag stripped), e.g. `SELECT INBOX`, `DONE`. */
  commands: string[];
  /** Each command line (tag stripped) with whether it arrived over TLS. */
  log: { command: string; tls: boolean }[];
  /** Every byte received before TLS, as latin1 text. */
  plainText: string;
  /** Advertise STARTTLS on plain-text connections. Default: false. */
  starttls: boolean;
  /** Commands (upper-case verbs) to leave unanswered. */
  silent: Set<string>;
  /**
   * Called after each IDLE continuation, with the connection's socket and
   * the number of IDLE commands received so far (on any connection): lets
   * a test push untagged responses (`* 1 EXISTS`) or drop the connection.
   */
  onIdle: ((socket: Socket, count: number) => void) | null;
  /**
   * Answers `UID FETCH`, given the connection's socket, the tag and the
   * command after `UID FETCH <uid>`. Unset, it gets the default `OK`.
   */
  onUidFetch:
    | ((socket: Socket, tag: string, fetchItems: string) => void)
    | null;
  close: () => Promise<void>;
}

const CAPABILITIES = 'IMAP4rev1 IDLE MOVE UIDPLUS AUTH=PLAIN';

function answer(
  socket: Socket,
  tag: string,
  verb: string,
  advertiseStartTls: boolean,
): void {
  switch (verb) {
    case 'CAPABILITY': {
      const extra = advertiseStartTls ? ' STARTTLS' : '';
      socket.write(
        `* CAPABILITY ${CAPABILITIES}${extra}\r\n${tag} OK done\r\n`,
      );
      break;
    }
    case 'LOGIN':
    case 'AUTHENTICATE':
      socket.write(`${tag} OK [CAPABILITY ${CAPABILITIES}] logged in\r\n`);
      break;
    case 'LIST':
      socket.write(`* LIST () "/" INBOX\r\n${tag} OK done\r\n`);
      break;
    case 'SELECT':
    case 'EXAMINE':
      socket.write(
        `* 0 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 1] ok\r\n${tag} OK [READ-WRITE] selected\r\n`,
      );
      break;
    case 'LOGOUT':
      socket.write(`* BYE bye\r\n${tag} OK bye\r\n`);
      socket.end();
      break;
    default:
      socket.write(`${tag} OK done\r\n`);
  }
}

export async function startFakeImapServer(): Promise<FakeImapServer> {
  const sockets = new Set<Socket>();
  const state: Omit<FakeImapServer, 'host' | 'port' | 'close'> = {
    connections: 0,
    commands: [],
    log: [],
    plainText: '',
    starttls: false,
    silent: new Set(),
    onIdle: null,
    onUidFetch: null,
  };
  let idleCount = 0;
  const serve = (socket: Socket, tls: boolean): void => {
    socket.on('error', () => undefined);
    let buffer = '';
    let idleTag = '';
    let authTag = '';
    socket.on('data', (data: Buffer) => {
      const text = data.toString('latin1');
      if (!tls) {
        state.plainText += text;
      }
      buffer += text;
      let end = buffer.indexOf('\r\n');
      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\r\n');
        if (authTag !== '') {
          // The SASL response to an AUTHENTICATE continuation.
          state.log.push({ command: line, tls });
          answer(socket, authTag, 'AUTHENTICATE', false);
          authTag = '';
          continue;
        }
        if (line === 'DONE') {
          state.commands.push('DONE');
          state.log.push({ command: 'DONE', tls });
          socket.write(`${idleTag} OK IDLE done\r\n`);
          continue;
        }
        const [tag = '', verb = '', ...rest] = line.split(' ');
        const command = verb.toUpperCase();
        state.commands.push([command, ...rest].join(' '));
        state.log.push({ command: [command, ...rest].join(' '), tls });
        if (state.silent.has(command)) {
          continue;
        }
        if (command === 'IDLE') {
          idleTag = tag;
          socket.write('+ idling\r\n');
          idleCount += 1;
          state.onIdle?.(socket, idleCount);
        } else if (
          command === 'UID' &&
          rest[0]?.toUpperCase() === 'FETCH' &&
          state.onUidFetch !== null
        ) {
          state.onUidFetch(socket, tag, rest.slice(2).join(' '));
        } else if (command === 'AUTHENTICATE' && rest.length === 1) {
          // No initial response: ask for it, as a real server does.
          authTag = tag;
          socket.write('+ \r\n');
        } else if (command === 'STARTTLS' && state.starttls && !tls) {
          socket.write(`${tag} OK begin TLS\r\n`);
          socket.removeAllListeners('data');
          serve(
            new TLSSocket(socket, {
              isServer: true,
              key: localhostCertificate().key,
              cert: localhostCertificate().cert,
            }),
            true,
          );
          return;
        } else {
          answer(socket, tag, command, state.starttls && !tls);
        }
      }
    });
  };
  const server: Server = createServer(socket => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK fake IMAP ready\r\n');
    serve(socket, false);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const isObject = typeof address === 'object' && address !== null;
  return Object.assign(state, {
    host: isObject ? address.address : '',
    port: isObject ? address.port : 0,
    close: async (): Promise<void> => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  });
}
