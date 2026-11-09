// Port of tests/test_syslog.py. Where Python patches SysLogHandler and the
// ssl module, these tests talk to real UDP/TCP/TLS servers on 127.0.0.1
// and assert on the bytes they receive.

import { Socket as DatagramSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import tls, { type TLSSocket } from 'node:tls';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { captureLogs, getLogger, type LogCapture, WARNING } from '../log';
import {
  sampleAggregateReport,
  sampleFailureReport,
  sampleSmtpTlsReport,
} from '../test/output-samples';
import {
  type CertificateFiles,
  makeSelfSignedCertificate,
  nulFrames,
  type StreamServer,
  startTcpServer,
  startTlsServer,
  startUdpServer,
  type UdpServer,
} from '../test/sockets';
import {
  SyslogClient,
  SyslogError,
  SysLogHandler,
  syslogTimers,
} from './syslog';

// What parsedmarc 11.0.5 sends (recorded with Python 3.14's SysLogHandler)
// for sampleAggregateReport({ orgName: 'exämple.com' }): `<14>` (facility
// user, priority info), json.dumps() of the CSV row, and a NUL.
const PYTHON_AGGREGATE_MESSAGE =
  '<14>{"xml_schema": "draft", "org_name": "ex\\u00e4mple.com", "org_email": "dmarc@example.com", "org_extra_contact_info": "", "report_id": "agg-1", "begin_date": "2024-01-01 00:00:00", "end_date": "2024-01-02 00:00:00", "normalized_timespan": false, "errors": "", "domain": "example.com", "adkim": "r", "aspf": "r", "p": "none", "sp": "none", "np": "", "pct": "", "fo": "", "testing": "", "discovery_method": "", "source_ip_address": "192.0.2.1", "source_country": "US", "source_reverse_dns": "", "source_base_domain": "", "source_name": "", "source_type": "", "source_asn": 64496, "source_as_name": "Example AS", "source_as_domain": "example.net", "count": 9, "spf_aligned": true, "dkim_aligned": true, "dmarc_aligned": true, "disposition": "none", "policy_override_reasons": "", "policy_override_comments": "", "envelope_from": "example.com", "header_from": "example.com", "envelope_to": "", "dkim_domains": "", "dkim_selectors": "", "dkim_results": "", "spf_domains": "", "spf_scopes": "", "spf_results": ""}\0';

const syslogLogger = getLogger('tsdmarc_syslog');
const cleanups: (() => Promise<void> | void)[] = [];

function track<T extends { close: () => Promise<void> | void }>(
  resource: T,
): T {
  cleanups.push(() => resource.close());
  return resource;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
  // Reset the module-level logger, like Python's _fresh_logger().
  syslogLogger.handlers.length = 0;
});

function handlerOf(client: SyslogClient): SysLogHandler {
  expect(client.logHandler).toBeInstanceOf(SysLogHandler);
  return client.logHandler as SysLogHandler;
}

function parseMessage(data: Buffer): unknown {
  const text = data.toString('utf-8');
  expect(text.startsWith('<14>')).toBe(true);
  expect(text.endsWith('\0')).toBe(true);
  return JSON.parse(text.slice('<14>'.length, -1));
}

describe('SyslogClient init: UDP', () => {
  // UDP is the default protocol — back-compat for every existing
  // deployment. The socket must be a datagram socket, not a stream.
  it('test_udp_uses_dgram_socket', async () => {
    const server = track(await startUdpServer());
    const client = track(await SyslogClient.create('127.0.0.1', server.port));
    const handler = handlerOf(client);
    expect(handler.address).toEqual(['127.0.0.1', server.port]);
    expect(handler.socktype).toBe('dgram');
    expect(handler.socket).toBeInstanceOf(DatagramSocket);
  });

  it('test_udp_is_default', async () => {
    const server = track(await startUdpServer());
    const client = track(
      await SyslogClient.create('127.0.0.1', server.port, { protocol: 'udp' }),
    );
    expect(handlerOf(client).socktype).toBe('dgram');
  });

  it('sends the same bytes as Python: <PRI>json\\0 per datagram', async () => {
    const server = track(await startUdpServer());
    const client = track(await SyslogClient.create('127.0.0.1', server.port));
    await client.saveAggregateReportToSyslog([
      sampleAggregateReport({ orgName: 'exämple.com' }),
    ]);
    const [datagram] = await server.receive();
    expect(datagram?.toString('latin1')).toBe(PYTHON_AGGREGATE_MESSAGE);
  });

  it('accepts the protocol in any case', async () => {
    const server = track(await startUdpServer());
    const client = track(
      await SyslogClient.create('127.0.0.1', server.port, { protocol: 'UDP' }),
    );
    expect(client.protocol).toBe('udp');
  });
});

describe('SyslogClient init: TCP', () => {
  // TCP uses a stream socket and applies the configured timeout. The wrong
  // socket type would silently fail to deliver messages.
  it('test_tcp_uses_stream_socket', async () => {
    const server = track(await startTcpServer());
    const client = track(
      await SyslogClient.create('127.0.0.1', server.port, { protocol: 'tcp' }),
    );
    expect(handlerOf(client).socktype).toBe('stream');
    await vi.waitFor(() => expect(server.connections).toHaveLength(1));
  });

  it('test_tcp_applies_timeout_to_socket', async () => {
    const server = track(await startTcpServer());
    const client = track(
      await SyslogClient.create('127.0.0.1', server.port, {
        protocol: 'tcp',
        timeout: 12.5,
      }),
    );
    expect(handlerOf(client).timeout).toBe(12.5);
  });

  it('frames TCP messages like Python: NUL-terminated, no octet count', async () => {
    const server = track(await startTcpServer());
    const client = track(
      await SyslogClient.create('127.0.0.1', server.port, { protocol: 'tcp' }),
    );
    const report = sampleAggregateReport({ orgName: 'exämple.com' });
    await client.saveAggregateReportToSyslog([report]);
    await client.saveAggregateReportToSyslog(report);
    const data = await server.waitForBytes(2 * PYTHON_AGGREGATE_MESSAGE.length);
    expect(data.toString('latin1')).toBe(PYTHON_AGGREGATE_MESSAGE.repeat(2));
  });
});

describe('SyslogClient init: TLS', () => {
  // TLS ≥ 1.2, optional CA and client certificate, retry on connection
  // failure. Each has user-facing security consequences.
  let serverCert: CertificateFiles;
  let clientCert: CertificateFiles;

  beforeAll(() => {
    serverCert = makeSelfSignedCertificate('localhost');
    clientCert = makeSelfSignedCertificate('tsdmarc-client');
  });

  async function tlsServer(
    extra: Record<string, unknown> = {},
  ): Promise<StreamServer> {
    return track(
      await startTlsServer({
        cert: serverCert.cert,
        key: serverCert.key,
        ...extra,
      }),
    );
  }

  it('test_tls_enforces_tls_1_2_minimum', async () => {
    // The lowest version security teams accept is TLS 1.2: a server that
    // only speaks TLS 1.1 is refused.
    const server = await tlsServer({
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1.1',
      ciphers: 'DEFAULT:@SECLEVEL=0',
    });
    // Node's own defaults (TLS 1.2 minimum, OpenSSL security level 1)
    // would refuse TLS 1.1 anyway; lower them so that only the client's
    // explicit `minVersion` can make the handshake fail.
    const savedMinVersion = tls.DEFAULT_MIN_VERSION;
    const savedCiphers = tls.DEFAULT_CIPHERS;
    tls.DEFAULT_MIN_VERSION = 'TLSv1';
    tls.DEFAULT_CIPHERS = 'DEFAULT:@SECLEVEL=0';
    try {
      // Control: with the lowered defaults, TLS 1.1 does negotiate.
      const control = tls.connect({
        host: 'localhost',
        port: server.port,
        ca: readFileSync(serverCert.certPath),
      });
      const protocol = await new Promise<string | null>((resolve, reject) => {
        control.once('secureConnect', () => resolve(control.getProtocol()));
        control.once('error', reject);
      });
      control.destroy();
      expect(protocol).toBe('TLSv1.1');
      const handshakes = server.connections.length;

      await expect(
        SyslogClient.create('localhost', server.port, {
          protocol: 'tls',
          cafilePath: serverCert.certPath,
          retryAttempts: 1,
        }),
      ).rejects.toThrow(/protocol|version/iu);
      expect(server.connections).toHaveLength(handshakes);
    } finally {
      tls.DEFAULT_MIN_VERSION = savedMinVersion;
      tls.DEFAULT_CIPHERS = savedCiphers;
    }
  });

  it('reconnects over TLS, never in the clear', async () => {
    const server = await tlsServer();
    const client = track(
      await SyslogClient.create('localhost', server.port, {
        protocol: 'tls',
        cafilePath: serverCert.certPath,
      }),
    );
    await client.saveSmtpTlsReportToSyslog([sampleSmtpTlsReport()]);
    const { length } = await server.waitForBytes(1);
    const socket = handlerOf(client).socket as TLSSocket;
    server.connections[0]?.destroy();
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    await client.saveSmtpTlsReportToSyslog([sampleSmtpTlsReport()]);
    // A plain connection would never reach the TLS server's connections.
    await server.waitForBytes(length + 1);
    expect(server.connections).toHaveLength(2);
    expect(handlerOf(client).socket).toBeInstanceOf(tls.TLSSocket);
  });

  it('test_tls_loads_ca_when_cafile_provided', async () => {
    const server = await tlsServer();
    const client = track(
      await SyslogClient.create('localhost', server.port, {
        protocol: 'tls',
        cafilePath: serverCert.certPath,
      }),
    );
    const socket = handlerOf(client).socket as TLSSocket;
    expect(socket.authorized).toBe(true);
    expect(['TLSv1.2', 'TLSv1.3']).toContain(socket.getProtocol());

    await client.saveSmtpTlsReportToSyslog([sampleSmtpTlsReport()]);
    const data = await server.waitForBytes(1);
    const [frame = ''] = nulFrames(
      await server.waitForBytes(data.indexOf(0) + 1),
    );
    expect(frame.startsWith('<14>{"organization_name": "example.com"')).toBe(
      true,
    );
  });

  it('verifies the server certificate (no CA file: self-signed is refused)', async () => {
    const server = await tlsServer();
    const capture = captureLogs('tsdmarc_syslog');
    try {
      await expect(
        SyslogClient.create('localhost', server.port, {
          protocol: 'tls',
          retryAttempts: 1,
        }),
      ).rejects.toThrow(/self-signed certificate/u);
      expect(capture.output).toEqual([
        expect.stringMatching(
          /^ERROR:tsdmarc_syslog:Syslog connection failed after 1 attempts: .*self-signed certificate/u,
        ),
      ]);
    } finally {
      capture.restore();
    }
  });

  it('checks the hostname against the certificate', async () => {
    const otherCert = makeSelfSignedCertificate('other.example');
    const server = track(
      await startTlsServer({ cert: otherCert.cert, key: otherCert.key }),
    );
    // The SAN is localhost/127.0.0.1, so "localhost" passes...
    const client = track(
      await SyslogClient.create('localhost', server.port, {
        protocol: 'tls',
        cafilePath: otherCert.certPath,
      }),
    );
    expect((handlerOf(client).socket as TLSSocket).authorized).toBe(true);
    // ...and a name the certificate doesn't list fails.
    await expect(
      SyslogClient.create('127.0.0.2', server.port, {
        protocol: 'tls',
        cafilePath: otherCert.certPath,
        retryAttempts: 1,
      }),
    ).rejects.toThrow();
  });

  it('test_tls_loads_client_cert_when_both_paths_provided', async () => {
    const server = await tlsServer({
      requestCert: true,
      rejectUnauthorized: true,
      ca: [clientCert.cert],
    });
    track(
      await SyslogClient.create('localhost', server.port, {
        protocol: 'tls',
        cafilePath: serverCert.certPath,
        certfilePath: clientCert.certPath,
        keyfilePath: clientCert.keyPath,
      }),
    );
    await vi.waitFor(() => expect(server.connections).toHaveLength(1));
    const peer = (server.connections[0] as TLSSocket).getPeerCertificate();
    expect(peer.subject.CN).toBe('tsdmarc-client');
  });

  it('test_tls_warns_when_only_certfile_provided', async () => {
    // Half-configured client auth (cert without key, or vice versa) is a
    // config bug that disables client auth silently. The code warns.
    const server = await tlsServer({
      requestCert: true,
      rejectUnauthorized: false,
    });
    let capture: LogCapture | null = captureLogs('tsdmarc_syslog', WARNING);
    try {
      track(
        await SyslogClient.create('localhost', server.port, {
          protocol: 'tls',
          cafilePath: serverCert.certPath,
          certfilePath: clientCert.certPath,
        }),
      );
      expect(
        capture.output.some(line =>
          line.includes('Both certfile_path and keyfile_path'),
        ),
      ).toBe(true);
      expect(capture.output).toEqual([
        'WARNING:tsdmarc_syslog:Both certfile_path and keyfile_path are required for client certificate authentication. Client authentication will not be used.',
      ]);
    } finally {
      capture.restore();
      capture = null;
    }
    await vi.waitFor(() => expect(server.connections).toHaveLength(1));
    const peer = (server.connections[0] as TLSSocket).getPeerCertificate();
    expect(Object.keys(peer)).toHaveLength(0);
  });

  it('test_tls_wraps_socket_with_server_hostname', async () => {
    // server_name is used as the TLS SNI / certificate-verification hostname.
    const server = await tlsServer();
    track(
      await SyslogClient.create('localhost', server.port, {
        protocol: 'tls',
        cafilePath: serverCert.certPath,
      }),
    );
    await vi.waitFor(() => expect(server.connections).toHaveLength(1));
    expect(
      (server.connections[0] as TLSSocket & { servername: string }).servername,
    ).toBe('localhost');
  });

  it('test_tls_retries_then_succeeds', async () => {
    // Transient connection failures retry up to retry_attempts times: the
    // server drops the first connection before the handshake.
    const server = await tlsServer();
    let rawConnections = 0;
    server.server.prependListener('connection', (socket: Socket) => {
      rawConnections += 1;
      if (rawConnections === 1) {
        socket.destroy();
      }
    });
    const sleep = vi.spyOn(syslogTimers, 'sleep').mockResolvedValue();
    const capture = captureLogs('tsdmarc_syslog', WARNING);
    try {
      track(
        await SyslogClient.create('localhost', server.port, {
          protocol: 'tls',
          cafilePath: serverCert.certPath,
          retryAttempts: 3,
          retryDelay: 1,
        }),
      );
      expect(rawConnections).toBe(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(1);
      expect(capture.output).toEqual([
        expect.stringMatching(
          /^WARNING:tsdmarc_syslog:Syslog connection attempt 1\/3 failed: .+\. Retrying in 1 seconds\.\.\.$/u,
        ),
      ]);
    } finally {
      capture.restore();
    }
  });

  it('test_tls_raises_after_exhausting_retries', async () => {
    // Nothing listens on port 1.
    const port = 1;
    const sleep = vi.spyOn(syslogTimers, 'sleep');
    const capture = captureLogs('tsdmarc_syslog', WARNING);
    try {
      await expect(
        SyslogClient.create('127.0.0.1', port, {
          protocol: 'tls',
          retryAttempts: 2,
          retryDelay: 0,
        }),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(sleep).toHaveBeenCalledWith(0);
      expect(capture.output).toEqual([
        expect.stringMatching(
          /^WARNING:tsdmarc_syslog:Syslog connection attempt 1\/2 failed: /u,
        ),
        expect.stringMatching(
          /^ERROR:tsdmarc_syslog:Syslog connection failed after 2 attempts: /u,
        ),
      ]);
    } finally {
      capture.restore();
    }
  });

  it('retries a failing certificate file like a connection failure', async () => {
    const server = await tlsServer();
    await expect(
      SyslogClient.create('localhost', server.port, {
        protocol: 'tls',
        certfilePath: '/nonexistent/cert.pem',
        keyfilePath: '/nonexistent/key.pem',
        retryAttempts: 2,
        retryDelay: 0,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('SyslogClient init: invalid settings', () => {
  // Typos in the protocol field fail loudly.
  it('test_invalid_protocol_raises_value_error', async () => {
    const error = await SyslogClient.create('s', 514, {
      protocol: 'udb',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('ValueError');
    expect((error as Error).message).toContain('udb');
    expect((error as Error).message).toContain("'udp', 'tcp', or 'tls'");
  });

  it('test_zero_retry_attempts_raises_value_error', async () => {
    // retry_attempts < 1 means the TCP/TLS connect loop never runs; it
    // raises instead of configuring a broken client.
    const server = track(await startTcpServer());
    const error = await SyslogClient.create('127.0.0.1', server.port, {
      protocol: 'tcp',
      retryAttempts: 0,
    }).catch((caught: unknown) => caught);
    expect((error as Error).name).toBe('ValueError');
    expect((error as Error).message).toContain('retry_attempts');
    expect(server.connections).toHaveLength(0);
    expect(syslogLogger.handlers).toHaveLength(0);
  });
});

describe('SyslogClient save', () => {
  // save* methods emit one syslog message per CSV row, each a JSON
  // payload. A wrong format would break downstream parsers.
  async function clientWithServer(): Promise<[SyslogClient, UdpServer]> {
    const server = track(await startUdpServer());
    const client = track(await SyslogClient.create('127.0.0.1', server.port));
    return [client, server];
  }

  it('test_save_aggregate_emits_json_per_row', async () => {
    const [client, server] = await clientWithServer();
    await client.saveAggregateReportToSyslog([sampleAggregateReport()]);
    const messages = await server.receive();
    expect(messages).toHaveLength(1);
    const payload = parseMessage(messages[0] as Buffer) as Record<
      string,
      unknown
    >;
    expect(payload.source_ip_address).toBe('192.0.2.1');
    expect(payload.count).toBe(9);
    expect(payload.org_name).toBe('example.com');
  });

  it('test_save_failure_emits_json_per_report', async () => {
    const [client, server] = await clientWithServer();
    await client.saveFailureReportToSyslog([sampleFailureReport()]);
    const messages = await server.receive();
    expect(messages).toHaveLength(1);
    const payload = parseMessage(messages[0] as Buffer) as Record<
      string,
      unknown
    >;
    expect(payload.reported_domain).toBe('example.com');
    expect(payload.source_ip_address).toBe('192.0.2.5');
  });

  it('test_save_smtp_tls_emits_json_per_policy', async () => {
    const [client, server] = await clientWithServer();
    await client.saveSmtpTlsReportToSyslog([sampleSmtpTlsReport()]);
    const messages = await server.receive();
    expect(messages).toHaveLength(1);
    const payload = parseMessage(messages[0] as Buffer) as Record<
      string,
      unknown
    >;
    expect(payload.policy_domain).toBe('example.com');
  });

  it('sends one message per row, in order', async () => {
    const [client, server] = await clientWithServer();
    await client.saveAggregateReportToSyslog([
      sampleAggregateReport({ count: 1 }),
      sampleAggregateReport({ count: 2 }),
      sampleAggregateReport({ count: 3 }),
    ]);
    const messages = await server.receive(3);
    expect(
      messages.map(
        message => (parseMessage(message) as { count: number }).count,
      ),
    ).toEqual([1, 2, 3]);
  });

  it('reports a failed send on stderr and fails the save', async () => {
    const server = track(await startTcpServer());
    const client = track(
      await SyslogClient.create('127.0.0.1', server.port, { protocol: 'tcp' }),
    );
    // The server goes away: the next sends fail.
    await server.close();
    const socket = handlerOf(client).socket as Socket;
    await vi.waitFor(() => expect(socket.writable).toBe(false));
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    await expect(
      client.saveSmtpTlsReportToSyslog([sampleSmtpTlsReport()]),
    ).rejects.toThrow(SyslogError);
    await expect(
      client.saveSmtpTlsReportToSyslog([sampleSmtpTlsReport()]),
    ).rejects.toThrow(`1 message(s) not sent to 127.0.0.1:${server.port}`);
    const written = stderr.mock.calls.map(([text]) => String(text)).join('');
    stderr.mockRestore();
    expect(written).toContain('--- Logging error ---');
  });

  it('reconnects after the server drops the connection', async () => {
    const server = track(await startTcpServer());
    const client = track(
      await SyslogClient.create('127.0.0.1', server.port, { protocol: 'tcp' }),
    );
    await client.saveSmtpTlsReportToSyslog([sampleSmtpTlsReport()]);
    const { length } = await server.waitForBytes(1);
    const socket = handlerOf(client).socket as Socket;
    await vi.waitFor(() => expect(server.connections).toHaveLength(1));
    server.connections[0]?.destroy();
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    await client.saveSmtpTlsReportToSyslog([sampleSmtpTlsReport()]);
    await server.waitForBytes(length + 1);
    expect(server.connections).toHaveLength(2);
    expect(handlerOf(client).socket).not.toBe(socket);
  });

  it('backs off while the server stays down', async () => {
    const server = track(await startTcpServer());
    const client = track(
      await SyslogClient.create('127.0.0.1', server.port, { protocol: 'tcp' }),
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await server.close();
    const socket = handlerOf(client).socket as Socket;
    await vi.waitFor(() => expect(socket.writable).toBe(false));
    const createSocket = vi.spyOn(handlerOf(client), 'createSocket');
    await expect(
      client.saveSmtpTlsReportToSyslog([
        sampleSmtpTlsReport(),
        sampleSmtpTlsReport(),
      ]),
    ).rejects.toThrow('message(s) not sent');
    expect(createSocket).toHaveBeenCalledOnce();
  });

  it('keeps UDP best-effort: a failed datagram does not fail the save', async () => {
    const server = track(await startUdpServer());
    const client = track(await SyslogClient.create('127.0.0.1', server.port));
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    client.logger.info('x'.repeat(70_000));
    await client.saveSmtpTlsReportToSyslog([]);
    expect(stderr).toHaveBeenCalled();
  });
});

/** Counts the datagrams `server` gets from now on. */
function countDatagrams(server: UdpServer): () => number {
  let count = 0;
  server.socket.on('message', () => {
    count += 1;
  });
  return () => count;
}

describe('SyslogClient isolation', () => {
  it("sends each client's rows only to its own server", async () => {
    const serverA = track(await startUdpServer());
    const serverB = track(await startUdpServer());
    const receivedA = countDatagrams(serverA);
    const receivedB = countDatagrams(serverB);
    const clientA = track(await SyslogClient.create('127.0.0.1', serverA.port));
    const clientB = track(await SyslogClient.create('127.0.0.1', serverB.port));
    await clientA.saveAggregateReportToSyslog([sampleAggregateReport()]);
    await clientB.saveSmtpTlsReportToSyslog([sampleSmtpTlsReport()]);
    await Promise.all([serverA.receive(1), serverB.receive(1)]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(receivedA()).toBe(1);
    expect(receivedB()).toBe(1);
  });

  it("does not send a client's connection warnings to another server", async () => {
    const server = track(await startUdpServer());
    const received = countDatagrams(server);
    track(await SyslogClient.create('127.0.0.1', server.port));
    vi.spyOn(syslogTimers, 'sleep').mockResolvedValue();
    await expect(
      SyslogClient.create('127.0.0.1', 1, {
        protocol: 'tcp',
        retryAttempts: 2,
      }),
    ).rejects.toThrow('ECONNREFUSED');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(received()).toBe(0);
  });

  it('leaves nothing on a shared logger', async () => {
    const server = track(await startUdpServer());
    const client = track(await SyslogClient.create('127.0.0.1', server.port));
    expect(syslogLogger.handlers).toEqual([]);
    expect(client.logger).not.toBe(syslogLogger);
  });
});

describe('SyslogClient close', () => {
  it('test_close_removes_and_closes_handler', async () => {
    const server = track(await startTcpServer());
    const client = await SyslogClient.create('127.0.0.1', server.port, {
      protocol: 'tcp',
    });
    const handler = handlerOf(client);
    await vi.waitFor(() => expect(server.connections).toHaveLength(1));
    await client.close();
    expect(syslogLogger.handlers).not.toContain(handler);
    expect(handler.socket).toBeNull();
    await server.waitForClose();
  });

  it('sends what was queued before closing', async () => {
    const server = track(await startTcpServer());
    const client = await SyslogClient.create('127.0.0.1', server.port, {
      protocol: 'tcp',
    });
    client.logger.info('last words');
    await client.close();
    const data = await server.waitForBytes('<14>last words\0'.length);
    expect(data.toString()).toBe('<14>last words\0');
    await server.waitForClose();
  });
});

describe('SyslogClient backward-compatible alias', () => {
  it('test_forensic_alias_points_to_failure_method', async () => {
    const server = track(await startUdpServer());
    const client = track(await SyslogClient.create('127.0.0.1', server.port));
    const failure = vi.spyOn(client, 'saveFailureReportToSyslog');
    await client.saveForensicReportToSyslog([sampleFailureReport()]);
    expect(failure).toHaveBeenCalledWith([sampleFailureReport()]);
    const [message] = await server.receive();
    expect(
      (parseMessage(message as Buffer) as { reported_domain: string })
        .reported_domain,
    ).toBe('example.com');
  });
});

describe('integers beyond 2^53', () => {
  it('sends a count exactly, like json.dumps(row)', async () => {
    const server = track(await startUdpServer());
    const client = track(await SyslogClient.create('127.0.0.1', server.port));
    await client.saveAggregateReportToSyslog([
      sampleAggregateReport({ count: 99_999_999_999_999_999_999n }),
    ]);
    const [message] = await server.receive();
    expect(message?.toString('utf8')).toContain(
      '"count": 99999999999999999999,',
    );
  });
});
