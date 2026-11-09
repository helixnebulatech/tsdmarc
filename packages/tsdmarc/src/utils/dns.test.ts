// Ported from parsedmarc tests/test_utils.py: TestUtilsDnsCaching,
// TestQueryDnsRetries, TestEncryptedDnsNameservers, plus coverage of the
// resolver logic and the dnspython-compatible text forms the port adds.
//
// DNS is faked at the transport boundary: `node:dns/promises`' Resolver
// (plain DNS), the global `fetch` (DNS over HTTPS) and `node:tls`'
// `connect` (DNS over TLS).

import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type * as TlsModule from 'node:tls';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExpiringDict } from '../config';
import { captureLogs, DEBUG } from '../log';
import {
  Do53Nameserver,
  DoHNameserver,
  DoTNameserver,
  enrichNameservers,
  getReverseDns,
  InvalidNameserverError,
  nameserversToResolverInput,
  parseDotNameserver,
  queryDns,
  type DnsCache,
} from './dns';
import {
  BadEscape,
  BadResponse,
  DNSException,
  DNSSyntaxError,
  IDNAException,
  LifetimeTimeout,
  NoAnswer,
  NoNameservers,
  NXDOMAIN,
  UnknownRdatatype,
} from './dns-errors';
import {
  decodeMessage,
  makeQuery,
  rdataToText,
  RDATATYPES,
} from './dns-message';
import {
  escapifyString,
  ipv6Aton,
  ipv6Ntoa,
  nameFromText,
  nameToText,
  reverseNameFromAddress,
} from './dns-text';

interface FakeResolverCall {
  name: string;
  rrtype: string;
  servers: string[];
  options: { timeout: number; tries: number };
}

const dnsMock = vi.hoisted(() => ({
  handler: (_call: FakeResolverCall): unknown => {
    throw new Error('no DNS handler configured');
  },
  calls: [] as FakeResolverCall[],
}));

vi.mock('node:dns/promises', () => {
  class Resolver {
    private servers: string[] = [];
    constructor(private readonly options: { timeout: number; tries: number }) {}
    setServers(servers: string[]): void {
      this.servers = servers;
    }
    cancel(): void {
      // nothing in flight
    }
    async resolve(name: string, rrtype: string): Promise<unknown> {
      const call = {
        name,
        rrtype,
        servers: this.servers,
        options: this.options,
      };
      dnsMock.calls.push(call);
      return dnsMock.handler(call);
    }
  }
  return { Resolver };
});

const tlsMock = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock('node:tls', async importOriginal => {
  const actual = await importOriginal<typeof TlsModule>();
  return { ...actual, connect: tlsMock.connect };
});

function nodeError(code: string): Error {
  return Object.assign(new Error(`queryA ${code} example.com`), { code });
}

function cacheWith(entries: [string, string[]][]): DnsCache {
  const cache: DnsCache = new ExpiringDict({ maxLen: 100, maxAgeSeconds: 60 });
  for (const [key, value] of entries) {
    cache.set(key, value);
  }
  return cache;
}

/** Length of the question section of a single-question message. */
function questionEnd(wire: Uint8Array): number {
  let offset = 12;
  while (wire[offset] !== 0) {
    offset += (wire[offset] as number) + 1;
  }
  return offset + 1 + 4;
}

function encodeName(name: string): number[] {
  const bytes: number[] = [];
  for (const label of name.split('.').filter(Boolean)) {
    bytes.push(label.length, ...Buffer.from(label, 'latin1'));
  }
  bytes.push(0);
  return bytes;
}

/** A response answering the PTR query in `request` with `answer`. */
function ptrResponse(
  request: Uint8Array,
  answer = 'dns.example.',
  idDelta = 0,
): Uint8Array {
  const end = questionEnd(request);
  const id = (((request[0] as number) << 8) | (request[1] as number)) + idDelta;
  const header = [id >> 8, id & 0xff, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0];
  const rdata = encodeName(answer);
  const record = [
    0xc0,
    0x0c,
    0,
    12,
    0,
    1,
    0,
    0,
    1,
    0x2c,
    rdata.length >> 8,
    rdata.length & 0xff,
    ...rdata,
  ];
  return Uint8Array.from([...header, ...request.subarray(12, end), ...record]);
}

afterEach(() => {
  dnsMock.calls.length = 0;
  dnsMock.handler = () => {
    throw new Error('no DNS handler configured');
  };
  tlsMock.connect.mockReset();
  vi.unstubAllGlobals();
});

describe('TestUtilsDnsCaching', () => {
  it('testQueryDnsUsesCacheHit: returns cached result without querying', async () => {
    const cache = cacheWith([['example.com_A', ['1.2.3.4']]]);
    expect(await queryDns('example.com', 'A', { cache })).toEqual(['1.2.3.4']);
    expect(dnsMock.calls).toHaveLength(0);
  });

  it('testQueryDnsCachesResult: stores the result when the cache is non-empty', async () => {
    // Pre-populate: parsedmarc tests `if cache:` and an empty ExpiringDict is falsy
    const cache = cacheWith([['seed_key', ['seed']]]);
    dnsMock.handler = () => ['1.2.3.4'];
    const result = await queryDns('test-cache.example.com', 'A', { cache });
    expect(result).toEqual(['1.2.3.4']);
    expect(cache.get('test-cache.example.com_A')).toEqual(['1.2.3.4']);
  });

  it('an empty cache is neither read nor written, like parsedmarc', async () => {
    const cache: DnsCache = new ExpiringDict({
      maxLen: 100,
      maxAgeSeconds: 60,
    });
    dnsMock.handler = () => ['1.2.3.4'];
    await queryDns('example.com', 'A', { cache });
    expect(cache.size).toBe(0);
  });

  it('testReverseDnsReturnsNoneOnFailure: null on DNS errors', async () => {
    dnsMock.handler = () => {
      throw nodeError('ENOTFOUND');
    };
    const capture = captureLogs(undefined, DEBUG);
    try {
      expect(await getReverseDns('203.0.113.1')).toBeNull();
    } finally {
      capture.restore();
    }
    expect(capture.output).toContain(
      'DEBUG:tsdmarc:get_reverse_dns(203.0.113.1) exception: The DNS query name does not exist: 1.113.0.203.in-addr.arpa.',
    );
  });

  it('getReverseDns returns null for text that is not an IP address', async () => {
    expect(await getReverseDns('not-an-ip')).toBeNull();
    expect(dnsMock.calls).toHaveLength(0);
  });

  it('getReverseDns queries the PTR of the reverse name and keeps the first answer', async () => {
    dnsMock.handler = () => ['dns.google', 'other.example'];
    expect(await getReverseDns('8.8.8.8')).toBe('dns.google');
    expect(dnsMock.calls[0]).toMatchObject({
      name: '8.8.8.8.in-addr.arpa',
      rrtype: 'PTR',
    });
  });
});

describe('TestQueryDnsRetries', () => {
  it('testTransientErrorIsRetried', async () => {
    // A refused connection takes the only nameserver out of the mix
    // (NoNameservers, which parsedmarc retries); the second attempt answers.
    let attempt = 0;
    dnsMock.handler = () => {
      attempt += 1;
      if (attempt === 1) {
        throw nodeError('ECONNREFUSED');
      }
      return ['192.0.2.1'];
    };
    const records = await queryDns('example.com', 'A', {
      nameservers: ['192.0.2.53'],
      timeout: 0.1,
      retries: 1,
    });
    expect(records).toEqual(['192.0.2.1']);
    expect(dnsMock.calls).toHaveLength(2);
    // A single nameserver: the per-attempt timeout is min(1, timeout)
    expect(dnsMock.calls[0]?.options).toEqual({ timeout: 100, tries: 1 });
    expect(dnsMock.calls[0]?.servers).toEqual(['192.0.2.53']);
  });

  it('testErrorRaisedAfterRetriesExhausted', async () => {
    dnsMock.handler = () => {
      throw nodeError('ECONNREFUSED');
    };
    // parsedmarc's test raises OSError from a patched Resolver.resolve; with
    // the resolver ported, the socket error surfaces as NoNameservers.
    const error = await queryDns('example.com', 'A', {
      nameservers: ['192.0.2.53'],
      timeout: 0.1,
      retries: 2,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoNameservers);
    expect((error as Error).message).toBe(
      'All nameservers failed to answer the query example.com. IN A: Server Do53:192.0.2.53@53 answered Connection refused',
    );
    expect(dnsMock.calls).toHaveLength(3);
  });

  it('non-retryable errors propagate immediately', async () => {
    dnsMock.handler = () => {
      throw nodeError('ENODATA');
    };
    await expect(
      queryDns('example.com', 'TXT', { retries: 3 }),
    ).rejects.toThrow(new NoAnswer('example.com. IN TXT'));
    expect(dnsMock.calls).toHaveLength(1);
  });

  it('a lifetime timeout is raised after the budget and retried', async () => {
    dnsMock.handler = () => {
      throw nodeError('ETIMEOUT');
    };
    const error = await queryDns('example.com', 'A', {
      nameservers: ['192.0.2.53'],
      timeout: 0.05,
      retries: 1,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LifetimeTimeout);
    expect((error as Error).message).toMatch(
      /^The resolution lifetime expired after \d+\.\d{3} seconds: Server Do53:192\.0\.2\.53@53 answered The DNS operation timed out\.$/u,
    );
    // Two attempts, each at least one query
    expect(dnsMock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Do53 timeout', () => {
  it('a silent server times out after the configured timeout, not later', async () => {
    // c-ares never answers (Bun rounds its timeout up to whole seconds).
    dnsMock.handler = () => new Promise(() => undefined);
    const started = performance.now();
    const error = await queryDns('example.com', 'A', {
      nameservers: ['192.0.2.53'],
      timeout: 0.5,
      retries: 0,
    }).catch((caught: unknown) => caught);
    const elapsed = performance.now() - started;
    expect(error).toBeInstanceOf(LifetimeTimeout);
    expect((error as Error).message).toMatch(
      /answered The DNS operation timed out\.$/u,
    );
    // Well under the old 2x (1 s), with room for a loaded machine.
    expect(elapsed).toBeGreaterThanOrEqual(490);
    expect(elapsed).toBeLessThan(900);
  });
});

/** A TXT answer to `request` (EDNS dropped), optionally truncated. */
function txtResponse(
  request: Uint8Array,
  bytes: number[],
  truncated = false,
): Buffer {
  const end = questionEnd(request);
  const header = Buffer.from(request.subarray(0, 12));
  header[2] = 0x81 | (truncated ? 0x02 : 0);
  header[3] = 0x80;
  header.writeUInt16BE(truncated ? 0 : 1, 6);
  header.writeUInt16BE(0, 10);
  const question = request.subarray(12, end);
  if (truncated) {
    return Buffer.concat([header, question]);
  }
  const rdata = [bytes.length, ...bytes];
  const record = [0xc0, 0x0c, 0, 16, 0, 1, 0, 0, 0, 60, 0, rdata.length];
  return Buffer.concat([header, question, Buffer.from([...record, ...rdata])]);
}

describe.skipIf(process.platform !== 'linux')(
  'Do53 over the wire (scoped IPv6 nameservers)',
  () => {
    const request = {
      name: nameFromText('example.com.'),
      rdtype: 16,
      rdtypeText: 'TXT',
    };

    it('keeps the %scope, skips junk and prints raw TXT bytes', async () => {
      const server = createSocket('udp6');
      server.on('message', (data, source) => {
        // Junk and a reply to another ID come first: both are ignored.
        server.send(Buffer.from([1, 2, 3]), source.port, source.address);
        const wrongId = txtResponse(data, [0x41]);
        wrongId[0] = (wrongId[0] as number) ^ 0xff;
        server.send(wrongId, source.port, source.address);
        server.send(
          txtResponse(data, [0xff, 0x41]),
          source.port,
          source.address,
        );
      });
      await new Promise<void>(resolve => server.bind(0, '::1', resolve));
      try {
        const nameserver = new Do53Nameserver('::1%lo', server.address().port);
        expect(await nameserver.query(request, 2)).toEqual({
          kind: 'answer',
          records: ['"\\255A"'],
        });
      } finally {
        server.close();
      }
    });

    it('retries a truncated answer over TCP', async () => {
      const udp = createSocket('udp6');
      udp.on('message', (data, source) => {
        udp.send(txtResponse(data, [], true), source.port, source.address);
      });
      await new Promise<void>(resolve => udp.bind(0, '::1', resolve));
      const { port } = udp.address();
      const tcp = createServer(socket => {
        socket.once('data', (frame: Buffer) => {
          const answer = txtResponse(frame.subarray(2), [0x62]);
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(answer.length);
          socket.end(Buffer.concat([prefix, answer]));
        });
      });
      await new Promise<void>(resolve => tcp.listen(port, '::1', resolve));
      try {
        const nameserver = new Do53Nameserver('::1%lo', port);
        expect(await nameserver.query(request, 2)).toEqual({
          kind: 'answer',
          records: ['"b"'],
        });
      } finally {
        udp.close();
        tcp.close();
      }
    });

    it('times out at the configured timeout', async () => {
      const server = createSocket('udp6');
      await new Promise<void>(resolve => server.bind(0, '::1', resolve));
      try {
        const nameserver = new Do53Nameserver('::1%lo', server.address().port);
        const started = performance.now();
        await expect(nameserver.query(request, 0.5)).rejects.toThrow(
          'The DNS operation timed out.',
        );
        expect(performance.now() - started).toBeLessThan(900);
      } finally {
        server.close();
      }
    });
  },
);

describe('resolver failover (dnspython semantics)', () => {
  it('a SERVFAIL nameserver is skipped and the next one answers', async () => {
    dnsMock.handler = call => {
      if (call.servers[0] === '192.0.2.1') {
        throw nodeError('ESERVFAIL');
      }
      return ['v=spf1 -all'].map(text => [text]);
    };
    const records = await queryDns('example.com', 'TXT', {
      nameservers: ['192.0.2.1', '192.0.2.2'],
    });
    expect(records).toEqual(['v=spf1 -all']);
    expect(dnsMock.calls.map(call => call.servers[0])).toEqual([
      '192.0.2.1',
      '192.0.2.2',
    ]);
  });

  it('the default nameservers are Cloudflare, IPv6 servers included', async () => {
    dnsMock.handler = () => {
      throw nodeError('EREFUSED');
    };
    await expect(queryDns('example.com', 'A')).rejects.toBeInstanceOf(
      NoNameservers,
    );
    expect(dnsMock.calls.map(call => call.servers[0])).toEqual([
      '1.1.1.1',
      '1.0.0.1',
      '2606:4700:4700::1111',
      '2606:4700:4700::1001',
    ]);
  });

  it('NXDOMAIN is raised without trying other nameservers', async () => {
    dnsMock.handler = () => {
      throw nodeError('ENOTFOUND');
    };
    await expect(
      queryDns('Missing.Example.com', 'A', {
        nameservers: ['192.0.2.1', '192.0.2.2'],
      }),
    ).rejects.toThrow(new NXDOMAIN(['missing.example.com.']));
    expect(dnsMock.calls).toHaveLength(1);
  });

  it('an invalid nameserver string is rejected like dnspython does', async () => {
    await expect(
      queryDns('example.com', 'A', { nameservers: ['dns.google'] }),
    ).rejects.toThrow(
      new InvalidNameserverError(
        'nameserver dns.google is not a dns.nameserver.Nameserver instance or text form, IP address, nor a valid https URL',
      ),
    );
  });

  it('record types are validated before querying', async () => {
    await expect(queryDns('example.com', 'BOGUS')).rejects.toBeInstanceOf(
      UnknownRdatatype,
    );
    expect(dnsMock.calls).toHaveLength(0);
  });
});

describe('record text forms (dnspython to_text + parsedmarc cleanup)', () => {
  it('formats MX, TXT, AAAA, PTR, SOA, SRV and CAA answers', async () => {
    const answers: Record<string, unknown> = {
      MX: [{ priority: 10, exchange: 'mail.example.com' }],
      TXT: [['v=spf1 ', 'include:"x" -all'], ['a\\b']],
      AAAA: ['2001:0db8:0000:0000:0000:0000:0000:0001'],
      PTR: ['host.example.net'],
      SOA: {
        nsname: 'ns1.example.com',
        hostmaster: 'hostmaster.example.com',
        serial: 2024010101,
        refresh: 7200,
        retry: 3600,
        expire: 1209600,
        minttl: 300,
      },
      SRV: [{ priority: 0, weight: 5, port: 5060, name: 'sip.example.com' }],
      CAA: [{ critical: 0, issue: 'letsencrypt.org' }],
    };
    dnsMock.handler = call => answers[call.rrtype];
    expect(await queryDns('example.com', 'mx')).toEqual([
      '10 mail.example.com',
    ]);
    // Each string is quoted and escaped, then the quotes are removed
    expect(await queryDns('example.com', 'TXT')).toEqual([
      'v=spf1  include:\\x\\ -all',
      'a\\\\b',
    ]);
    expect(await queryDns('example.com', 'AAAA')).toEqual(['2001:db8::1']);
    expect(await queryDns('1.0.0.1.in-addr.arpa', 'PTR')).toEqual([
      'host.example.net',
    ]);
    expect(await queryDns('example.com', 'SOA')).toEqual([
      'ns1.example.com. hostmaster.example.com. 2024010101 7200 3600 1209600 300',
    ]);
    expect(await queryDns('_sip._udp.example.com', 'SRV')).toEqual([
      '0 5 5060 sip.example.com',
    ]);
    expect(await queryDns('example.com', 'CAA')).toEqual([
      '0 issue letsencrypt.org',
    ]);
  });

  it('duplicate records are dropped, as in a dnspython rdataset', async () => {
    dnsMock.handler = () => ['A.example.', 'a.example', 'b.example'];
    expect(await queryDns('1.0.0.1.in-addr.arpa', 'PTR')).toEqual([
      'A.example',
      'b.example',
    ]);
  });

  it('TXT bytes outside printable ASCII use \\DDD escapes', () => {
    // dnspython: '"hello \\"you\\"" "a\\\\b" "\\007" "\\195\\169"'
    const strings = ['hello "you"', 'a\\b', '\u0007', 'Ã©'];
    expect(
      strings
        .map(
          value =>
            `"${escapifyString(Uint8Array.from(Buffer.from(value, 'latin1')))}"`,
        )
        .join(' '),
    ).toBe('"hello \\"you\\"" "a\\\\b" "\\007" "\\195\\169"');
  });

  it('names escape special and non-printable bytes like dnspython', () => {
    const labels = [
      Buffer.from('we(ird'),
      Buffer.from('na;me'),
      Uint8Array.from([0, 255]),
      Buffer.from('a b'),
      new Uint8Array(),
    ];
    expect(nameToText(labels)).toBe('we\\(ird.na\\;me.\\000\\255.a\\032b.');
  });

  it('IPv6 text matches dns.ipv6.inet_ntoa', () => {
    const cases: Record<string, string> = {
      '2001:db8::1': '2001:db8::1',
      '::ffff:1.2.3.4': '::ffff:1.2.3.4',
      '::1.2.3.4': '::1.2.3.4',
      '1:0:0:2:0:0:0:3': '1:0:0:2::3',
      '::1': '::1',
      '2001:db8:0:0:1:0:0:1': '2001:db8::1:0:0:1',
      '::': '::',
      'fe80::': 'fe80::',
      '0:0:0:0:0:1:0:0': '::1:0:0',
      '2001:DB8:0:0:0:0:0:0': '2001:db8::',
      '0:0:0:0:0:ffff:0:0': '::ffff:0.0.0.0',
      '1:2:3:4:5:6:7:8': '1:2:3:4:5:6:7:8',
      '1::2:3:4:5:6:7': '1:0:2:3:4:5:6:7',
    };
    for (const [input, expected] of Object.entries(cases)) {
      expect(ipv6Ntoa(ipv6Aton(input))).toBe(expected);
    }
  });

  it('reverse names match dns.reversename.from_address', () => {
    expect(reverseNameFromAddress('8.8.8.8')).toBe('8.8.8.8.in-addr.arpa.');
    expect(reverseNameFromAddress('2001:db8::1')).toBe(
      '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.',
    );
    expect(reverseNameFromAddress('::ffff:1.2.3.4')).toBe(
      '4.3.2.1.in-addr.arpa.',
    );
    for (const bad of [
      '256.1.1.1',
      '01.1.1.1',
      'not-an-ip',
      '1.2.3',
      '',
      '1:2:3:4:5:6:7:8:9',
      'fe80::1%eth0',
    ]) {
      expect(() => reverseNameFromAddress(bad)).toThrow(DNSSyntaxError);
    }
  });

  it('wire-format rdata prints like dnspython', () => {
    const query = makeQuery(nameFromText('example.com'), RDATATYPES.TXT, 1);
    const end = questionEnd(query.wire);
    const txt = Buffer.from(
      '\u000bhello "you"\u0003a\\b\u0001\u0007\u0002Ã©',
      'latin1',
    );
    const record = [
      0xc0,
      0x0c,
      0,
      16,
      0,
      1,
      0,
      0,
      0,
      60,
      0,
      txt.length,
      ...txt,
    ];
    const wire = Uint8Array.from([
      0,
      1,
      0x81,
      0x80,
      0,
      1,
      0,
      1,
      0,
      0,
      0,
      0,
      ...query.wire.subarray(12, end),
      ...record,
    ]);
    const message = decodeMessage(wire);
    expect(rdataToText(message.answer[0] as never)).toBe(
      '"hello \\"you\\"" "a\\\\b" "\\007" "\\195\\169"',
    );
  });
});

describe('TestEncryptedDnsNameservers', () => {
  it('test_plain_ip_entries_are_passed_through_untouched', () => {
    const entries = ['1.1.1.1', '2606:4700:4700::1111'];
    const mapped = nameserversToResolverInput(entries);
    expect(mapped).toHaveLength(2);
    expect(mapped).toEqual(entries);
  });

  it('test_https_entry_becomes_a_session_doh_nameserver', () => {
    const url = 'https://cloudflare-dns.com/dns-query';
    const [mapped] = nameserversToResolverInput([url]);
    expect(mapped).toBeInstanceOf(DoHNameserver);
    expect((mapped as DoHNameserver).url).toBe(url);
    expect((mapped as DoHNameserver).wantGet).toBe(false);
  });

  it('test_uppercase_scheme_is_recognized', () => {
    const [mapped] = nameserversToResolverInput([
      'HTTPS://cloudflare-dns.com/dns-query',
    ]);
    expect(mapped).toBeInstanceOf(DoHNameserver);
  });

  it('test_tls_entry_defaults_to_port_853_with_no_hostname', () => {
    const [mapped] = nameserversToResolverInput(['tls://9.9.9.9']);
    expect(mapped).toBeInstanceOf(DoTNameserver);
    expect(mapped).toMatchObject({
      address: '9.9.9.9',
      port: 853,
      hostname: null,
    });
  });

  it('warns once per tls:// entry without a #hostname', () => {
    const capture = captureLogs(undefined, DEBUG);
    try {
      parseDotNameserver('tls://192.0.2.53');
      parseDotNameserver('tls://192.0.2.53');
      parseDotNameserver('tls://192.0.2.54#dns.example');
    } finally {
      capture.restore();
    }
    expect(capture.output).toEqual([
      'WARNING:tsdmarc:DNS over TLS nameserver tls://192.0.2.53 has no #hostname: only the certificate chain is verified, so any server with a publicly trusted certificate for any name can answer. Use tls://ip[:port]#hostname with the TLS certificate identity of the server',
    ]);
  });

  it('test_tls_entry_port_and_hostname_are_parsed', () => {
    const mapped = parseDotNameserver('tls://9.9.9.9:8853#dns.quad9.net');
    expect(mapped).toMatchObject({
      address: '9.9.9.9',
      port: 8853,
      hostname: 'dns.quad9.net',
    });
  });

  it('test_bracketed_ipv6_tls_entry_is_parsed', () => {
    const mapped = parseDotNameserver('tls://[2620:fe::fe]:853#dns.quad9.net');
    expect(mapped).toMatchObject({ address: '2620:fe::fe', port: 853 });
  });

  it('test_mixed_list_preserves_order_and_types', () => {
    const mapped = nameserversToResolverInput([
      '1.1.1.1',
      'https://cloudflare-dns.com/dns-query',
      'tls://9.9.9.9#dns.quad9.net',
    ]);
    expect(mapped[0]).toBe('1.1.1.1');
    expect(mapped[1]).toBeInstanceOf(DoHNameserver);
    expect(mapped[2]).toBeInstanceOf(DoTNameserver);
  });

  it('test_tls_entry_without_a_host_is_rejected', () => {
    expect(() => nameserversToResolverInput(['tls://'])).toThrow(/tls:\/\//u);
    expect(() => nameserversToResolverInput(['tls://'])).toThrow(RangeError);
  });

  it('test_tls_entry_with_a_hostname_instead_of_an_ip_is_rejected', () => {
    expect(() => nameserversToResolverInput(['tls://dns.quad9.net'])).toThrow(
      'Invalid DNS over TLS nameserver tls://dns.quad9.net: dns.quad9.net is not an IP address',
    );
  });

  it('test_tls_entry_with_an_invalid_port_is_rejected', () => {
    expect(() =>
      nameserversToResolverInput(['tls://9.9.9.9:notaport']),
    ).toThrow(
      'Invalid DNS over TLS nameserver tls://9.9.9.9:notaport: the port is not an integer from 0 to 65535 (percent-encode any /, ? or # in a password)',
    );
    expect(() => nameserversToResolverInput(['tls://9.9.9.9:70000'])).toThrow(
      'Invalid DNS over TLS nameserver tls://9.9.9.9:70000: the port is not an integer from 0 to 65535 (percent-encode any /, ? or # in a password)',
    );
  });

  it.each([
    ['tls://9.9.9.9/dns.quad9.net', 'tls://9.9.9.9/dns.quad9.net'],
    ['tls://user@9.9.9.9', 'tls://***@9.9.9.9'],
    [
      'tls://9.9.9.9?hostname=dns.quad9.net',
      'tls://9.9.9.9?hostname=dns.quad9.net',
    ],
  ])('test_tls_entry_with_a_path_is_rejected: %s', (entry, shown) => {
    expect(() => nameserversToResolverInput([entry])).toThrow(shown);
  });

  it('test_unsplittable_entry_is_left_for_dnspython_to_reject', () => {
    const entry = 'https://[::1';
    const [mapped] = nameserversToResolverInput([entry]);
    expect(mapped).toBe(entry);
    expect(() => enrichNameservers([entry])).toThrow(RangeError);
  });

  it('test_doh_query_returns_answers: POSTs the query and parses the answer', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response(ptrResponse(init.body as Uint8Array), {
          status: 200,
          headers: { 'content-type': 'application/dns-message' },
        });
      }),
    );
    const records = await queryDns('1.0.0.1.in-addr.arpa', 'PTR', {
      cache: cacheWith([['seed', ['seed']]]),
      nameservers: ['https://dns.example/dns-query'],
      timeout: 2,
    });
    expect(records).toEqual(['dns.example']);
    expect(requests).toHaveLength(1);
    const [{ url, init }] = requests as [{ url: string; init: RequestInit }];
    expect(url).toBe('https://dns.example/dns-query');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      accept: 'application/dns-message',
      'content-type': 'application/dns-message',
    });
    const sent = decodeMessage(init.body as Uint8Array);
    expect(nameToText(sent.question[0]?.name ?? [])).toBe(
      '1.0.0.1.in-addr.arpa.',
    );
    expect(sent.question[0]?.rdtype).toBe(RDATATYPES.PTR);
    // EDNS0 with a 1232-byte payload, like dnspython's resolver
    expect(sent.additional[0]).toMatchObject({ rdtype: 41, rdclass: 1232 });
  });

  it('DoH credentials go in a Basic header and never reach an error', async () => {
    const url = 'https://user:s3cret%21@dns.example/dns-query';
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (target: string, init: RequestInit) => {
        // What Node's fetch does with credentials in the URL.
        if (target.includes('@')) {
          throw new TypeError(
            `Request cannot be constructed from a URL that includes credentials: ${target}`,
          );
        }
        requests.push({ url: target, init });
        return new Response(null, { status: 500 });
      }),
    );
    const nameserver = new DoHNameserver(url);
    expect(nameserver.toString()).toBe(
      'https://user:***@dns.example/dns-query',
    );
    const error = await queryDns('example.com', 'TXT', {
      nameservers: [url],
      timeout: 0.05,
      retries: 0,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DNSException);
    expect(String(error)).not.toContain('s3cret');
    expect(String((error as Error).message)).toContain(
      'https://user:***@dns.example/dns-query responded with status code 500',
    );
    expect(requests[0]?.url).toBe('https://dns.example/dns-query');
    expect(requests[0]?.init.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('user:s3cret!').toString('base64')}`,
    });
  });

  it('a DoH URL fetch cannot parse does not show its password', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (target: string) => {
        throw new TypeError(`Failed to parse URL from ${target}`);
      }),
    );
    const url = 'https://user:s3c#ret@dns.example:bad/dns-query';
    const error = await new DoHNameserver(url)
      .query(
        {
          name: nameFromText('example.com'),
          rdtype: RDATATYPES.TXT,
          rdtypeText: 'TXT',
        },
        0.05,
      )
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain('Invalid URL');
    expect(String(error)).not.toContain('s3c');
  });

  it('DoH GET sends the query base64url-encoded in the dns parameter', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const wire = Buffer.from(
          new URL(url).searchParams.get('dns') ?? '',
          'base64url',
        );
        return new Response(ptrResponse(Uint8Array.from(wire)), {
          status: 200,
        });
      }),
    );
    const nameserver = new DoHNameserver('https://dns.example/dns-query', true);
    const outcome = await nameserver.query(
      {
        name: nameFromText('1.0.0.1.in-addr.arpa'),
        rdtype: RDATATYPES.PTR,
        rdtypeText: 'PTR',
      },
      2,
    );
    expect(outcome).toEqual({ kind: 'answer', records: ['dns.example.'] });
    expect(urls[0]).toMatch(
      /^https:\/\/dns\.example\/dns-query\?dns=[A-Za-z0-9_-]+$/u,
    );
  });

  it('a DoH response to a different query ID is rejected (BadResponse)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init: RequestInit) =>
          new Response(
            ptrResponse(init.body as Uint8Array, 'dns.example.', 1),
            { status: 200 },
          ),
      ),
    );
    const error = await queryDns('1.0.0.1.in-addr.arpa', 'PTR', {
      nameservers: ['https://dns.example/dns-query'],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoNameservers);
    expect((error as NoNameservers).errors[0]?.error).toBeInstanceOf(
      BadResponse,
    );
  });

  it('test_dot_query_returns_answers_and_passes_the_tls_hostname', async () => {
    const written: Buffer[] = [];
    tlsMock.connect.mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), {
        write: (frame: Buffer) => {
          written.push(frame);
          const response = ptrResponse(Uint8Array.from(frame.subarray(2)));
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(response.length);
          // Deliver in two chunks to exercise reassembly
          const data = Buffer.concat([prefix, response]);
          setImmediate(() => {
            socket.emit('data', data.subarray(0, 5));
            socket.emit('data', data.subarray(5));
          });
          return true;
        },
        destroy: vi.fn(),
      });
      setImmediate(() => socket.emit('secureConnect'));
      return socket;
    });
    const records = await queryDns('1.0.0.1.in-addr.arpa', 'PTR', {
      cache: cacheWith([['seed', ['seed']]]),
      nameservers: ['tls://9.9.9.9#dns.quad9.net'],
      timeout: 2,
    });
    expect(records).toEqual(['dns.example']);
    expect(tlsMock.connect).toHaveBeenCalledOnce();
    const [options] = tlsMock.connect.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(options).toMatchObject({
      host: '9.9.9.9',
      port: 853,
      servername: 'dns.quad9.net',
      ALPNProtocols: ['dot'],
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    });
    expect(written).toHaveLength(1);
    expect((written[0] as Buffer).readUInt16BE(0)).toBe(
      (written[0] as Buffer).length - 2,
    );
  });

  it('DoT without #hostname sends no SNI and skips only the hostname check', () => {
    const nameserver = parseDotNameserver('tls://9.9.9.9');
    expect(nameserver.hostname).toBeNull();
    expect(nameserver.toString()).toBe('DoT:9.9.9.9@853');
  });

  it('a DoT connection error takes the nameserver out (NoNameservers)', async () => {
    tlsMock.connect.mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        destroy: vi.fn(),
      });
      setImmediate(() =>
        socket.emit(
          'error',
          Object.assign(new Error('connect ECONNREFUSED 9.9.9.9:853'), {
            code: 'ECONNREFUSED',
          }),
        ),
      );
      return socket;
    });
    const error = await queryDns('example.com', 'A', {
      nameservers: ['tls://9.9.9.9'],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoNameservers);
    expect((error as Error).message).toBe(
      'All nameservers failed to answer the query example.com. IN A: Server DoT:9.9.9.9@853 answered connect ECONNREFUSED 9.9.9.9:853',
    );
  });
});

describe('getReverseDns logging', () => {
  it('escapes a sender-controlled source_ip in the debug line', async () => {
    const capture = captureLogs(undefined, DEBUG);
    let hostname: string | null;
    try {
      hostname = await getReverseDns('1.2.3.4\nforged line');
    } finally {
      capture.restore();
    }
    expect(hostname).toBeNull();
    expect(capture.output).toEqual([
      'DEBUG:tsdmarc:get_reverse_dns(1.2.3.4\\nforged line) exception: Text input is malformed.',
    ]);
  });
});

describe('name parsing', () => {
  beforeEach(() => {
    dnsMock.handler = () => ['192.0.2.1'];
  });

  it('rejects empty labels before querying', async () => {
    await expect(queryDns('a..example.com', 'A')).rejects.toThrow(
      'A DNS label is empty.',
    );
    expect(dnsMock.calls).toHaveLength(0);
  });

  it('encodes internationalized names with IDNA', async () => {
    await queryDns('пример.рф', 'A');
    expect(dnsMock.calls[0]?.name).toBe('xn--e1afmkfd.xn--p1ai');
  });

  it('applies IDNA 2008 like dnspython (errors and messages)', () => {
    // From dns.name.from_text(...) in the venv.
    const cases: [string, string][] = [
      ['😀.com', "Codepoint U+1F600 at position 1 of '😀' not allowed"],
      ['a☃b.com', "Codepoint U+2603 at position 2 of 'a☃b' not allowed"],
      ['€.com', "Codepoint U+20AC at position 1 of '€' not allowed"],
      ['x·y.com', "Codepoint U+00B7 not allowed at position 2 in 'x·y'"],
      ['a‍.com', "Joiner U+200D not allowed at position 2 in 'a\\u200d'"],
    ];
    for (const [name, detail] of cases) {
      let caught: unknown;
      try {
        nameFromText(name);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(IDNAException);
      expect((caught as Error).message).toBe(
        `IDNA processing exception: ${detail}`,
      );
    }
    expect(nameToText(nameFromText('l·l.com'))).toBe('xn--ll-0ea.com.');
    expect(nameToText(nameFromText('ÄB.com'))).toBe('xn--b-zfa.com.');
    expect(nameToText(nameFromText('Ⅻ.com'))).toBe('xii.com.');
    expect(() => nameFromText('\\256.com')).toThrow(BadEscape);
    expect(() => nameFromText('a\\')).toThrow(BadEscape);
  });
});

// parsedmarc's TestNameserverCredentialsNotLeaked (GHSA-hjr3-rx4c-24cv):
// nameserver URL credentials must not reach an error message or the log.
describe('TestNameserverCredentialsNotLeaked', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [
      'https://doh:p4ss/w0rd@dns.example/dns-query',
      'Invalid DNS over HTTPS nameserver https://***@dns.example/dns-query',
    ],
    [
      'https://doh:p4ss?w0rd@dns.example/dns-query',
      'Invalid DNS over HTTPS nameserver https://***@dns.example/dns-query',
    ],
    [
      'tls://dot:p4ss#w0rd@192.0.2.53',
      'Invalid DNS over TLS nameserver tls://***@192.0.2.53',
    ],
    [
      'https://dns.example:notaport/dns-query',
      'Invalid DNS over HTTPS nameserver https://dns.example:notaport/',
    ],
  ])(
    'test_malformed_https_and_tls_ports_are_reported_without_secrets: %s',
    async (entry, shown) => {
      const fetchMock = vi.fn(() => {
        throw new Error('no query may be sent');
      });
      vi.stubGlobal('fetch', fetchMock);
      const error = await queryDns('1.0.0.1.in-addr.arpa', 'PTR', {
        nameservers: [entry],
        timeout: 0.2,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InvalidNameserverError);
      expect(error).toBeInstanceOf(RangeError);
      // Python's type(e).__name__, which the CLI pre-flight prints
      expect((error as Error).name).toBe('ValueError');
      expect((error as Error).message).toContain(shown);
      expect((error as Error).cause).toBeUndefined();
      for (const secret of ['p4ss', 'w0rd']) {
        expect((error as Error).message).not.toContain(secret);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('test_dnspython_rejection_of_an_entry_is_masked', async () => {
    const entry = 'https://doh:S3CRETPW@[dns.example/dns-query';
    const error = await queryDns('1.0.0.1.in-addr.arpa', 'PTR', {
      nameservers: [entry],
      timeout: 0.2,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toContain(
      'https://doh:***@[dns.example/dns-query',
    );
    expect((error as Error).message).not.toContain('S3CRETPW');
    expect((error as Error).cause).toBeUndefined();
  });

  it('test_get_reverse_dns_debug_log_masks_nameserver_credentials', async () => {
    const url = 'https://doh:S3CRETPW@dns.example/dns-query';
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error(`connection to ${url} refused (S3CRETPW)`);
      }),
    );
    const capture = captureLogs(undefined, DEBUG);
    let result: string | null;
    try {
      result = await getReverseDns('192.0.2.1', {
        nameservers: [url],
        timeout: 0.2,
        retries: 0,
      });
    } finally {
      capture.restore();
    }
    expect(result).toBeNull();
    const output = capture.output.join('\n');
    expect(output).toContain('get_reverse_dns(192.0.2.1) exception:');
    expect(output).toContain('https://doh:***@dns.example/dns-query');
    expect(output).not.toContain('S3CRETPW');
  });
});
