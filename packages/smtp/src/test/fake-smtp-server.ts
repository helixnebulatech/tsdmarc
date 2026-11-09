// A minimal SMTP server on the loopback interface, for tests that run the
// real nodemailer over a socket. It records every command line with
// whether it arrived over TLS, so a test can check that credentials never
// cross a plain-text connection. `starttls` decides whether the plain-text
// EHLO reply advertises STARTTLS (false plays a server, or an on-path
// attacker, that strips it); `implicitTls` makes it an SMTPS server.

import { createServer, type Server, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';

import { localhostCertificate } from '../../../tsdmarc/src/test/sockets';

export interface SmtpCommand {
  /** The command line, e.g. `EHLO host`, `AUTH PLAIN dXNlcg==`. */
  line: string;
  /** Received over TLS (implicit, or after STARTTLS). */
  tls: boolean;
}

export interface FakeSmtpServer {
  host: string;
  port: number;
  /** Advertise STARTTLS on plain-text connections. Default: false. */
  starttls: boolean;
  commands: SmtpCommand[];
  /** Every byte received before TLS, as latin1 text. */
  plainText: string;
  /** Messages received with DATA. */
  messages: string[];
  close: () => Promise<void>;
}

function tlsOptions(): { isServer: true; key: Buffer; cert: Buffer } {
  const { key, cert } = localhostCertificate();
  return { isServer: true, key, cert };
}

function serve(
  state: FakeSmtpServer,
  socket: Socket | TLSSocket,
  tls: boolean,
  greet: boolean,
): void {
  let buffer = '';
  let inData = false;
  let active = true;
  const write = (text: string): void => {
    socket.write(text);
  };
  const ehlo = (): void => {
    const lines = ['fake.example.com'];
    if (state.starttls && !tls) {
      lines.push('STARTTLS');
    }
    lines.push('AUTH PLAIN');
    write(
      lines
        .map((line, index) =>
          index === lines.length - 1 ? `250 ${line}\r\n` : `250-${line}\r\n`,
        )
        .join(''),
    );
  };
  const handle = (line: string): void => {
    state.commands.push({ line, tls });
    const verb = (line.split(' ', 1)[0] ?? '').toUpperCase();
    switch (verb) {
      case 'EHLO':
        ehlo();
        break;
      case 'STARTTLS':
        if (tls || !state.starttls) {
          write('502 5.5.1 not available\r\n');
          break;
        }
        write('220 2.0.0 ready\r\n');
        active = false;
        socket.removeAllListeners('data');
        serve(state, new TLSSocket(socket, tlsOptions()), true, false);
        break;
      case 'AUTH':
        write('235 2.7.0 authenticated\r\n');
        break;
      case 'DATA':
        inData = true;
        write('354 go ahead\r\n');
        break;
      case 'QUIT':
        write('221 bye\r\n');
        socket.end();
        break;
      default:
        write('250 ok\r\n');
    }
  };
  socket.on('error', () => undefined);
  socket.on('data', (data: Buffer) => {
    const text = data.toString('latin1');
    if (!tls) {
      state.plainText += text;
    }
    buffer += text;
    // After STARTTLS, the TLS socket's handler takes over.
    for (;;) {
      if (!active) {
        return;
      }
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end === -1) {
          return;
        }
        state.messages.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 5);
        inData = false;
        write('250 2.0.0 queued\r\n');
        continue;
      }
      const end = buffer.indexOf('\r\n');
      if (end === -1) {
        return;
      }
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      handle(line);
    }
  });
  if (greet) {
    write('220 fake.example.com ESMTP\r\n');
  }
}

export async function startFakeSmtpServer(
  options: { implicitTls?: boolean } = {},
): Promise<FakeSmtpServer> {
  const sockets = new Set<Socket>();
  const state: FakeSmtpServer = {
    host: '',
    port: 0,
    starttls: false,
    commands: [],
    plainText: '',
    messages: [],
    close: () => Promise.resolve(),
  };
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (options.implicitTls) {
      serve(state, new TLSSocket(socket, tlsOptions()), true, true);
    } else {
      serve(state, socket, false, true);
    }
  });
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  const address = server.address();
  if (typeof address === 'object' && address !== null) {
    state.host = address.address;
    state.port = address.port;
  }
  state.close = async (): Promise<void> => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return state;
}
