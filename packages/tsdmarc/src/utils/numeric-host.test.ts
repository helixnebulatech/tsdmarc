import { describe, expect, it } from 'vitest';

import { inetAton, numericHost } from './numeric-host';

// Expected values match Python's maxminddb / glibc getaddrinfo.
describe('numericHost', () => {
  it('accepts inet_aton forms like getaddrinfo', () => {
    expect(inetAton('1.2.3')).toBe('1.2.0.3');
    expect(inetAton('010.1.1.1')).toBe('8.1.1.1');
    expect(inetAton('0x7f.1')).toBe('127.0.0.1');
    expect(inetAton('1')).toBe('0.0.0.1');
    expect(inetAton('8.8.8.8')).toBe('8.8.8.8');
    expect(inetAton('256.1.1.1')).toBeNull();
    expect(inetAton('1.2.3.256')).toBeNull();
    expect(inetAton('1..2')).toBeNull();
    expect(inetAton('08.1.1.1')).toBeNull();
    expect(inetAton(' 8.8.8.8')).toBeNull();
  });

  it('passes IPv6 through and rejects anything else with Python’s message', () => {
    expect(numericHost('2001:db8::1')).toBe('2001:db8::1');
    for (const ip of ['not-an-ip', '::zz', '', ' 8.8.8.8']) {
      expect(() => numericHost(ip)).toThrow(
        `'${ip}' does not appear to be an IPv4 or IPv6 address.`,
      );
    }
  });

  it('quotes the text verbatim like maxminddb (no repr escaping)', () => {
    // maxminddb: "'it's' ...", "'x\x1by' ..." with the raw ESC byte.
    for (const ip of ["it's", 'a"b', 'x\u001By', 'é', 'a\nb']) {
      expect(() => numericHost(ip)).toThrow(
        `'${ip}' does not appear to be an IPv4 or IPv6 address.`,
      );
    }
    expect(() => numericHost('x\u0000y')).toThrow(
      'argument 1 contains an embedded null character',
    );
  });
});
