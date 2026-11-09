// A stand-in for nodemailer's SMTPConnection, used with
// `vi.mock('nodemailer/lib/smtp-connection')`. It records what the client
// sends: connection options, login credentials, the envelope and the raw
// message. `fakeSmtp.failures` makes a step fail with a given error.

import { EventEmitter } from 'node:events';

import type { SMTPConnectionOptions } from 'nodemailer/lib/smtp-connection';

type Step = 'connect' | 'login' | 'send';

export interface FakeSmtpState {
  instances: FakeSMTPConnection[];
  /** STARTTLS is advertised (and used, unless `ignoreTLS`) on plain connections. */
  starttls: boolean;
  /** Fail a step: via its callback, or as an 'error' event. */
  failures: Partial<Record<Step, { error: Error; asEvent?: boolean }>>;
}

export const fakeSmtp: FakeSmtpState = {
  instances: [],
  starttls: true,
  failures: {},
};

export function resetFakeSmtp(): void {
  fakeSmtp.instances = [];
  fakeSmtp.starttls = true;
  fakeSmtp.failures = {};
}

/** An error as nodemailer reports it: its own code, plus the system code. */
export function nodemailerError(
  message: string,
  code: string,
  originalCode?: string,
): Error {
  return Object.assign(new Error(message), {
    code,
    ...(originalCode === undefined ? {} : { originalCode }),
  });
}

export class FakeSMTPConnection extends EventEmitter {
  readonly options: SMTPConnectionOptions;
  secure = false;
  connected = false;
  /** `connect()` calls: one per send. */
  connectCalls = 0;
  quitCalled = false;
  auth: unknown = null;
  envelope: { from: string; to: string[] } | null = null;
  message: string | null = null;
  /** The plain-text EHLO reply's lines, which nodemailer keeps with `ignoreTLS`. */
  _ehloLines: string[] = [];

  constructor(options: SMTPConnectionOptions) {
    super();
    this.options = options;
    fakeSmtp.instances.push(this);
  }

  /** Apply a configured failure; returns true when the step failed. */
  private fail(step: Step, callback: (error: Error) => void): boolean {
    const failure = fakeSmtp.failures[step];
    if (failure === undefined) {
      return false;
    }
    setImmediate(() => {
      if (failure.asEvent) {
        this.emit('error', failure.error);
        return;
      }
      callback(failure.error);
    });
    return true;
  }

  connect(callback: (error?: Error) => void): void {
    this.connectCalls += 1;
    if (this.fail('connect', callback)) {
      return;
    }
    this.connected = true;
    const upgrade =
      !this.options.secure && fakeSmtp.starttls && !this.options.ignoreTLS;
    this.secure = Boolean(this.options.secure) || upgrade;
    if (!this.secure) {
      this._ehloLines = [
        'smtp.example.com',
        ...(fakeSmtp.starttls ? ['STARTTLS'] : []),
        'AUTH PLAIN LOGIN',
      ];
    }
    setImmediate(() => callback());
  }

  login(
    auth: unknown,
    callback: (error: Error | null, ok?: boolean) => void,
  ): void {
    this.auth = auth;
    if (this.fail('login', callback)) {
      return;
    }
    setImmediate(() => callback(null, true));
  }

  send(
    envelope: { from: string; to: string[] },
    message: Buffer | string,
    callback: (error: Error | null, info?: object) => void,
  ): void {
    this.envelope = envelope;
    this.message = message.toString();
    if (this.fail('send', callback)) {
      return;
    }
    setImmediate(() => callback(null, { accepted: envelope.to, rejected: [] }));
  }

  quit(): void {
    this.quitCalled = true;
  }

  close(): void {
    this.quitCalled = true;
  }
}
