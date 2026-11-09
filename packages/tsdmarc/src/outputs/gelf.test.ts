// Port of tests/test_gelf.py, plus packet-level tests against real
// UDP/TCP/TLS servers on 127.0.0.1 (pygelf's wire format, recorded with
// parsedmarc 11.0.5 on Python 3.14).

import { hostname } from 'node:os';
import type { TLSSocket } from 'node:tls';
import { inflateSync } from 'node:zlib';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CaptureHandler, getLogger, INFO, type LogRecord } from '../log';
import {
  sampleAggregateReport,
  sampleFailureReport,
  sampleSmtpTlsReport,
} from '../test/output-samples';
import {
  type CertificateFiles,
  makeSelfSignedCertificate,
  nulFrames,
  startTcpServer,
  startTlsServer,
  startUdpServer,
  type UdpServer,
} from '../test/sockets';
import {
  ContextFilter,
  GelfError,
  GelfClient,
  GelfTcpHandler,
  GelfTlsHandler,
  GelfUdpHandler,
  logContextData,
  packGelf,
  splitGelf,
} from './gelf';

// `_parsedmarc` of the packet parsedmarc sends for
// sampleAggregateReport({ orgName: 'exämple.com' }): compact JSON with
// non-ASCII escaped (json.dumps' ensure_ascii).
const PYTHON_PARSEDMARC_FIELD =
  '{"xml_schema":"draft","org_name":"ex\\u00e4mple.com","org_email":"dmarc@example.com","org_extra_contact_info":"","report_id":"agg-1","begin_date":"2024-01-01 00:00:00","end_date":"2024-01-02 00:00:00","normalized_timespan":false,"errors":"","domain":"example.com","adkim":"r","aspf":"r","p":"none","sp":"none","np":"","pct":"","fo":"","testing":"","discovery_method":"","source_ip_address":"192.0.2.1","source_country":"US","source_reverse_dns":"","source_base_domain":"","source_name":"","source_type":"","source_asn":64496,"source_as_name":"Example AS","source_as_domain":"example.net","count":9,"spf_aligned":true,"dkim_aligned":true,"dmarc_aligned":true,"disposition":"none","policy_override_reasons":"","policy_override_comments":"","envelope_from":"example.com","header_from":"example.com","envelope_to":"","dkim_domains":"","dkim_selectors":"","dkim_results":"","spf_domains":"","spf_scopes":"","spf_results":""}';

function escapeRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&');
}

/** A whole pygelf packet, with any timestamp. */
function pythonPacket(shortMessage: string, parsedmarc: string): RegExp {
  const head = `{"version":"1.1","short_message":${JSON.stringify(shortMessage)},"timestamp":`;
  const tail = `,"level":6,"host":${JSON.stringify(hostname())},"_stack_info":null,"_taskName":null,"_parsedmarc":${parsedmarc}}`;
  return new RegExp(
    `^${escapeRegExp(head)}\\d+(\\.\\d+)?${escapeRegExp(tail)}$`,
    'u',
  );
}

const gelfLogger = getLogger('tsdmarc_gelf');
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
  // The tsdmarc_gelf logger is module-level: each client adds a handler and
  // a filter to it.
  gelfLogger.handlers.length = 0;
  gelfLogger.filters.length = 0;
});

describe('GelfClient init', () => {
  // The mode picks the transport. A typo in the config (`udb`) must fail
  // loudly, not silently pick the wrong transport.
  it('test_init_udp_picks_udp_handler', () => {
    const client = track(new GelfClient('graylog.example.com', 12_201, 'udp'));
    expect(client.handler).toBeInstanceOf(GelfUdpHandler);
    expect(client.handler).toMatchObject({
      host: 'graylog.example.com',
      port: 12_201,
      includeExtraFields: true,
      compress: true,
      chunkSize: 1300,
    });
  });

  it('test_init_tcp_picks_tcp_handler', () => {
    const client = track(new GelfClient('g', 12_201, 'tcp'));
    expect(client.handler).toBeInstanceOf(GelfTcpHandler);
    expect(client.handler).not.toBeInstanceOf(GelfTlsHandler);
    expect(client.handler).toMatchObject({
      host: 'g',
      port: 12_201,
      includeExtraFields: true,
      compress: false,
    });
  });

  it('test_init_tls_picks_tls_handler', () => {
    const client = track(new GelfClient('g', 12_201, 'tls'));
    expect(client.handler).toBeInstanceOf(GelfTlsHandler);
    expect(client.handler).toMatchObject({
      host: 'g',
      port: 12_201,
      includeExtraFields: true,
    });
  });

  it('test_init_unknown_mode_raises_keyerror', () => {
    expect(() => new GelfClient('g', 12_201, 'udb')).toThrow(
      expect.objectContaining({ name: 'KeyError', message: "'udb'" }),
    );
  });
});

/**
 * Replace the GELF handler with one that records each record's message and
 * `parsedmarc` payload (Python's _install_capturing_handler).
 */
function installCapturingHandler(client: GelfClient): CaptureHandler {
  client.logger.removeHandler(client.handler);
  const handler = new CaptureHandler();
  client.logger.addHandler(handler);
  client.handler = handler;
  return handler;
}

function captured(
  record: LogRecord | undefined,
): [string, Record<string, unknown>] {
  expect(record).toBeDefined();
  return [
    record?.message ?? '',
    record?.extra.parsedmarc as Record<string, unknown>,
  ];
}

describe('GelfClient.saveAggregateReportToGelf', () => {
  // One log record per aggregate CSV row, with the row on `parsedmarc`.
  it('test_emits_one_record_per_csv_row_with_payload', async () => {
    const client = new GelfClient('g', 12_201, 'udp');
    const handler = installCapturingHandler(client);
    await client.saveAggregateReportToGelf([
      sampleAggregateReport({ count: 7, withAuthResults: true }),
    ]);
    expect(handler.records).toHaveLength(1);
    const [message, payload] = captured(handler.records[0]);
    expect(message).toBe('parsedmarc aggregate report');
    expect(payload.source_ip_address).toBe('192.0.2.1');
    expect(payload.header_from).toBe('example.com');
    expect(payload.count).toBe(7);
  });

  it('test_clears_context_after_emit', async () => {
    // The payload is reset to null after the loop so a later unrelated log
    // call doesn't carry stale DMARC data.
    const client = new GelfClient('g', 12_201, 'udp');
    installCapturingHandler(client);
    await client.saveAggregateReportToGelf([sampleAggregateReport()]);
    expect(logContextData.parsedmarc).toBeNull();
  });
});

describe('GelfClient.saveFailureReportToGelf', () => {
  it('test_emits_one_record_per_failure_report', async () => {
    const client = new GelfClient('g', 12_201, 'udp');
    const handler = installCapturingHandler(client);
    await client.saveFailureReportToGelf([sampleFailureReport()]);
    expect(handler.records).toHaveLength(1);
    const [message, payload] = captured(handler.records[0]);
    expect(message).toBe('parsedmarc failure report');
    expect(payload.source_ip_address).toBe('192.0.2.5');
    expect(payload.reported_domain).toBe('example.com');
  });

  it('leaves the last row in the context, like parsedmarc', async () => {
    const client = new GelfClient('g', 12_201, 'udp');
    installCapturingHandler(client);
    await client.saveFailureReportToGelf([sampleFailureReport()]);
    expect(logContextData.parsedmarc).toMatchObject({
      reported_domain: 'example.com',
    });
  });
});

describe('GelfClient.saveSmtpTlsReportToGelf', () => {
  it('test_emits_one_record_per_policy', async () => {
    const client = new GelfClient('g', 12_201, 'udp');
    const handler = installCapturingHandler(client);
    await client.saveSmtpTlsReportToGelf([sampleSmtpTlsReport()]);
    expect(handler.records).toHaveLength(1);
    const [message, payload] = captured(handler.records[0]);
    expect(message).toBe('parsedmarc smtptls report');
    expect(payload.policy_domain).toBe('example.com');
    expect(payload.successful_session_count).toBe(100);
  });
});

describe('ContextFilter', () => {
  // Copies logContextData.parsedmarc onto the record so the handler sends
  // it as an extra field.
  it('test_filter_copies_thread_local_onto_record', () => {
    logContextData.parsedmarc = { hello: 'world' };
    try {
      const record: LogRecord = {
        name: 'x',
        level: INFO,
        levelName: 'INFO',
        message: 'msg',
        created: Date.now(),
        extra: {},
      };
      expect(new ContextFilter().filter(record)).toBe(true);
      expect(record.extra.parsedmarc).toEqual({ hello: 'world' });
    } finally {
      logContextData.parsedmarc = null;
    }
  });

  it('fails like Python when nothing was ever saved', () => {
    const saved = logContextData.parsedmarc;
    delete logContextData.parsedmarc;
    try {
      const client = new GelfClient('g', 12_201, 'udp');
      installCapturingHandler(client);
      expect(() => client.logger.info('early')).toThrow(
        "'_thread._local' object has no attribute 'parsedmarc'",
      );
    } finally {
      logContextData.parsedmarc = saved;
    }
  });
});

describe('GelfClient.close', () => {
  it('test_close_removes_and_closes_handler', async () => {
    const client = new GelfClient('g', 12_201, 'udp');
    const handler = client.handler as GelfUdpHandler;
    const closeAsync = vi.spyOn(handler, 'closeAsync');
    await client.close();
    expect(closeAsync).toHaveBeenCalledOnce();
    // The handler is no longer attached after close().
    expect(client.logger.handlers).not.toContain(handler);
  });
});

describe('GelfClient backward-compatible alias', () => {
  it('test_forensic_alias_points_to_failure_method', async () => {
    const client = new GelfClient('g', 12_201, 'udp');
    const handler = installCapturingHandler(client);
    const failure = vi.spyOn(client, 'saveFailureReportToGelf');
    await client.saveForensicReportToGelf([sampleFailureReport()]);
    expect(failure).toHaveBeenCalledOnce();
    expect(handler.records[0]?.message).toBe('parsedmarc failure report');
  });
});

describe('GELF over UDP', () => {
  it("sends pygelf's packet: zlib-compressed compact JSON", async () => {
    const server = track(await startUdpServer());
    const client = track(new GelfClient('127.0.0.1', server.port, 'udp'));
    await client.saveAggregateReportToGelf([
      sampleAggregateReport({ orgName: 'exämple.com' }),
    ]);
    const [packet] = await server.receive();
    expect(packet?.subarray(0, 2)).toEqual(Buffer.from([0x78, 0x9c]));
    const text = inflateSync(packet as Buffer).toString('latin1');
    expect(text).toMatch(
      pythonPacket('parsedmarc aggregate report', PYTHON_PARSEDMARC_FIELD),
    );
    const { timestamp } = JSON.parse(text) as { timestamp: number };
    expect(Math.abs(timestamp - Date.now() / 1000)).toBeLessThan(60);
  });

  it('splits messages above chunkSize into GELF chunks', async () => {
    const server = track(await startUdpServer());
    const handler = track(
      new GelfUdpHandler('127.0.0.1', server.port, {
        includeExtraFields: true,
        chunkSize: 64,
      }),
    );
    const logger = getLogger('tsdmarc_gelf_chunks');
    logger.setLevel(INFO);
    logger.addHandler(handler);
    try {
      logger.info('x'.repeat(50), {
        extra: { random: Math.random().toString(36).repeat(20) },
      });
      await handler.drain();
    } finally {
      logger.removeHandler(handler);
    }
    const first = await server.receive();
    const count = first[0]?.[11] ?? 0;
    expect(count).toBeGreaterThan(1);
    const chunks = [...first, ...(await server.receive(count - 1))];
    const messageId = chunks[0]?.subarray(2, 10);
    chunks.forEach((chunk, index) => {
      expect(chunk.subarray(0, 2)).toEqual(Buffer.from([0x1e, 0x0f]));
      expect(chunk.subarray(2, 10)).toEqual(messageId);
      expect(chunk[10]).toBe(index);
      expect(chunk[11]).toBe(count);
      expect(chunk.length).toBeLessThanOrEqual(12 + 64);
    });
    const gelf = JSON.parse(
      inflateSync(
        Buffer.concat(chunks.map(chunk => chunk.subarray(12))),
      ).toString(),
    ) as Record<string, unknown>;
    expect(gelf.short_message).toBe('x'.repeat(50));
    expect(gelf).toHaveProperty('_random');
  });

  it('refuses more than 127 chunks, like struct.pack("b")', () => {
    expect(() => splitGelf(new Uint8Array(128), 1)).toThrow(
      "'b' format requires -128 <= number <= 127",
    );
    expect(splitGelf(new Uint8Array(127), 1)).toHaveLength(127);
  });
});

describe('GELF over TCP', () => {
  it('sends uncompressed JSON, NUL-terminated', async () => {
    const server = track(await startTcpServer());
    const client = track(new GelfClient('127.0.0.1', server.port, 'tcp'));
    await client.saveAggregateReportToGelf([
      sampleAggregateReport({ orgName: 'exämple.com' }),
    ]);
    // After the save the context is null, and a plain log carries that.
    client.logger.info('plain');
    await client.close();
    await server.waitForClose();
    const frames = nulFrames(server.received());
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatch(
      pythonPacket('parsedmarc aggregate report', PYTHON_PARSEDMARC_FIELD),
    );
    expect(frames[1]).toMatch(pythonPacket('plain', 'null'));
  });

  it('drops messages silently and backs off while the server is down', async () => {
    const handler = track(new GelfTcpHandler('127.0.0.1', 1));
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const record: LogRecord = {
      name: 'x',
      level: INFO,
      levelName: 'INFO',
      message: 'lost',
      created: Date.now(),
      extra: {},
    };
    handler.handle(record);
    await handler.drain();
    expect(handler.sock).toBeNull();
    expect(handler.retryTime).toBeGreaterThan(Date.now());
    expect(handler.retryPeriod).toBe(1);
    // A second record inside the back-off window doesn't even try.
    handler.handle(record);
    await handler.drain();
    expect(handler.retryPeriod).toBe(1);
    // Once the window has passed, the next failure doubles the period.
    handler.retryTime = Date.now() - 1;
    handler.handle(record);
    await handler.drain();
    expect(handler.retryPeriod).toBe(2);
    expect(stderr).not.toHaveBeenCalled();
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

describe('GelfClient delivery over TCP', () => {
  it('fails the save when the server is down, so the batch is not lost', async () => {
    const server = await startTcpServer();
    const { port } = server;
    await server.close();
    const client = track(new GelfClient('127.0.0.1', port, 'tcp'));
    await expect(
      client.saveAggregateReportToGelf([sampleAggregateReport()]),
    ).rejects.toMatchObject({
      name: 'GelfError',
      message: expect.stringContaining(
        `1 message(s) not sent to 127.0.0.1:${port}: `,
      ),
    });
  });

  it('counts every message dropped while backing off', async () => {
    const server = await startTcpServer();
    const { port } = server;
    await server.close();
    const client = track(new GelfClient('127.0.0.1', port, 'tcp'));
    await expect(
      client.saveAggregateReportToGelf([
        sampleAggregateReport(),
        sampleAggregateReport(),
      ]),
    ).rejects.toThrow('2 message(s) not sent');
    // Reported once: the next save starts from a clean slate.
    expect((client.handler as GelfTcpHandler).takeFailures()).toBeNull();
  });

  it('sends again over a new connection when the old one was dropped', async () => {
    const server = track(await startTcpServer());
    const client = track(new GelfClient('127.0.0.1', server.port, 'tcp'));
    await client.saveSmtpTlsReportToGelf(sampleSmtpTlsReport());
    const { length } = await server.waitForBytes(1);
    const { sock } = client.handler as GelfTcpHandler;
    server.connections[0]?.destroy();
    await vi.waitFor(() => expect(sock?.destroyed).toBe(true));
    await client.saveSmtpTlsReportToGelf(sampleSmtpTlsReport());
    expect(nulFrames(await server.waitForBytes(length + 1))).toHaveLength(2);
    expect(server.connections).toHaveLength(2);
  });

  it('keeps UDP best-effort: a failed datagram does not fail the save', async () => {
    const client = track(new GelfClient('127.0.0.1', 12_201, 'udp'));
    const handler = client.handler as GelfUdpHandler;
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(handler, 'makePickle').mockReturnValue(new Uint8Array(1300 * 200));
    await client.saveSmtpTlsReportToGelf(sampleSmtpTlsReport());
    expect(stderr).toHaveBeenCalled();
  });
});

describe('GelfClient isolation', () => {
  it("sends each client's rows only to its own server", async () => {
    const serverA = track(await startUdpServer());
    const serverB = track(await startUdpServer());
    const receivedA = countDatagrams(serverA);
    const receivedB = countDatagrams(serverB);
    const clientA = track(new GelfClient('127.0.0.1', serverA.port, 'udp'));
    const clientB = track(new GelfClient('127.0.0.1', serverB.port, 'udp'));
    await clientA.saveAggregateReportToGelf([sampleAggregateReport()]);
    await clientB.saveSmtpTlsReportToGelf(sampleSmtpTlsReport());
    await Promise.all([serverA.receive(1), serverB.receive(1)]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(receivedA()).toBe(1);
    expect(receivedB()).toBe(1);
  });

  it('leaves nothing on a shared logger', () => {
    const client = track(new GelfClient('g', 12_201, 'udp'));
    expect(gelfLogger.handlers).toEqual([]);
    expect(gelfLogger.filters).toEqual([]);
    expect(client.logger).not.toBe(gelfLogger);
  });
});

describe('GELF over TLS', () => {
  let serverCert: CertificateFiles;
  let clientCert: CertificateFiles;

  beforeAll(() => {
    serverCert = makeSelfSignedCertificate('localhost');
    clientCert = makeSelfSignedCertificate('tsdmarc-client');
  });

  it('sends NUL-terminated JSON to a server it trusts', async () => {
    const server = track(
      await startTlsServer({ cert: serverCert.cert, key: serverCert.key }),
    );
    const client = track(
      new GelfClient('localhost', server.port, 'tls', {
        tls: { caCerts: serverCert.certPath },
      }),
    );
    await client.saveSmtpTlsReportToGelf(sampleSmtpTlsReport());
    const frames = nulFrames(await server.waitForBytes(1));
    expect(JSON.parse(frames[0] ?? '')).toMatchObject({
      short_message: 'parsedmarc smtptls report',
      _parsedmarc: { policy_domain: 'example.com' },
    });
    expect(
      (server.connections[0] as TLSSocket & { servername: string }).servername,
    ).toBe('localhost');
  });

  it('verifies the server certificate by default', async () => {
    const server = track(
      await startTlsServer({ cert: serverCert.cert, key: serverCert.key }),
    );
    const client = track(new GelfClient('localhost', server.port, 'tls'));
    await expect(
      client.saveSmtpTlsReportToGelf(sampleSmtpTlsReport()),
    ).rejects.toThrow(GelfError);
    // The self-signed certificate is refused: nothing is sent.
    expect(server.received()).toHaveLength(0);
    expect((client.handler as GelfTlsHandler).sock).toBeNull();
  });

  it("skips verification with validate: false (pygelf's default)", async () => {
    const server = track(
      await startTlsServer({ cert: serverCert.cert, key: serverCert.key }),
    );
    const client = track(
      new GelfClient('localhost', server.port, 'tls', {
        tls: { validate: false },
      }),
    );
    await client.saveSmtpTlsReportToGelf(sampleSmtpTlsReport());
    expect(nulFrames(await server.waitForBytes(1))).toHaveLength(1);
  });

  it('presents a client certificate', async () => {
    const server = track(
      await startTlsServer({
        cert: serverCert.cert,
        key: serverCert.key,
        requestCert: true,
        rejectUnauthorized: true,
        ca: [clientCert.cert],
      }),
    );
    const client = track(
      new GelfClient('localhost', server.port, 'tls', {
        tls: {
          caCerts: serverCert.certPath,
          certfile: clientCert.certPath,
          keyfile: clientCert.keyPath,
        },
      }),
    );
    await client.saveSmtpTlsReportToGelf(sampleSmtpTlsReport());
    await server.waitForBytes(1);
    const peer = (server.connections[0] as TLSSocket).getPeerCertificate();
    expect(peer.subject.CN).toBe('tsdmarc-client');
  });

  it('requires certfile with keyfile', () => {
    expect(
      () =>
        new GelfTlsHandler('localhost', 12_201, {
          keyfile: clientCert.keyPath,
        }),
    ).toThrow(
      expect.objectContaining({
        name: 'ValueError',
        message: 'certfile must be specified',
      }),
    );
  });
});

describe('integers beyond 2^53', () => {
  it('packs a count exactly, like pygelf', async () => {
    const client = new GelfClient('g', 12_201, 'udp');
    const handler = installCapturingHandler(client);
    await client.saveAggregateReportToGelf([
      sampleAggregateReport({ count: 99_999_999_999_999_999_999n }),
    ]);
    const [, payload] = captured(handler.records[0]);
    const packed = Buffer.from(
      packGelf({ _parsedmarc: payload }, false),
    ).toString('utf8');
    expect(packed).toContain('"count":99999999999999999999,');
  });
});
