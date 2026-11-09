// Expected values from Python's str(ipaddress.ip_address(value)).

import { describe, expect, it } from 'vitest';

import { normalizeIpAddress } from './ip';

const VALID: [string, string][] = [
  ['192.0.2.1', '192.0.2.1'],
  ['0.0.0.0', '0.0.0.0'],
  ['255.255.255.255', '255.255.255.255'],
  ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
  ['2001:db8::', '2001:db8::'],
  ['::', '::'],
  ['::1', '::1'],
  ['1::', '1::'],
  ['2001:0db8:0000:0000:0001:0000:0000:0001', '2001:db8::1:0:0:1'],
  ['1:0:0:1:0:0:0:1', '1:0:0:1::1'],
  ['1:0:0:0:1:0:0:1', '1::1:0:0:1'],
  ['::ffff:192.0.2.5', '::ffff:192.0.2.5'],
  ['::FFFF:c000:0205', '::ffff:192.0.2.5'],
  ['::ffff:0:0', '::ffff:0.0.0.0'],
  ['::192.0.2.5', '::c000:205'],
  ['64:ff9b::192.0.2.5', '64:ff9b::c000:205'],
  ['fe80::1%eth0', 'fe80::1%eth0'],
  ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
  ['1:2:3:4:5:6:7::', '1:2:3:4:5:6:7:0'],
  ['::1:2:3:4:5:6:7', '0:1:2:3:4:5:6:7'],
  ['1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5:6:102:304'],
  ['0:0:0:0:0:0:0:0', '::'],
  ['::0:0:1', '::1'],
  ['1:0::0:1', '1::1'],
];

const INVALID: [string, string][] = [
  ['256.1.1.1', "'256.1.1.1' does not appear to be an IPv4 or IPv6 address"],
  ['01.2.3.4', "'01.2.3.4' does not appear to be an IPv4 or IPv6 address"],
  ['1.2.3', "'1.2.3' does not appear to be an IPv4 or IPv6 address"],
  ['1.2.3.4.5', "'1.2.3.4.5' does not appear to be an IPv4 or IPv6 address"],
  ['1.2.3.4/32', "'1.2.3.4/32' does not appear to be an IPv4 or IPv6 address"],
  ['', "'' does not appear to be an IPv4 or IPv6 address"],
  [' 1.2.3.4', "' 1.2.3.4' does not appear to be an IPv4 or IPv6 address"],
  ['fe80::1%', "'fe80::1%' does not appear to be an IPv4 or IPv6 address"],
  [
    'fe80::1%a%b',
    "'fe80::1%a%b' does not appear to be an IPv4 or IPv6 address",
  ],
  [
    '1:2:3:4:5:6:7:8:9',
    "'1:2:3:4:5:6:7:8:9' does not appear to be an IPv4 or IPv6 address",
  ],
  ['1::2::3', "'1::2::3' does not appear to be an IPv4 or IPv6 address"],
  [
    ':1:2:3:4:5:6:7',
    "':1:2:3:4:5:6:7' does not appear to be an IPv4 or IPv6 address",
  ],
  [
    '1:2:3:4:5:6:7:',
    "'1:2:3:4:5:6:7:' does not appear to be an IPv4 or IPv6 address",
  ],
  ['12345::', "'12345::' does not appear to be an IPv4 or IPv6 address"],
  ['g::1', "'g::1' does not appear to be an IPv4 or IPv6 address"],
  [
    '1:2:3:4:5:6:7:1.2.3.4',
    "'1:2:3:4:5:6:7:1.2.3.4' does not appear to be an IPv4 or IPv6 address",
  ],
  ['not-an-ip', "'not-an-ip' does not appear to be an IPv4 or IPv6 address"],
  ["it's", '"it\'s" does not appear to be an IPv4 or IPv6 address'],
  ['٣.1.1.1', "'٣.1.1.1' does not appear to be an IPv4 or IPv6 address"],
  [
    '1:2:3:4:5:6:7:8:9:10:11',
    "'1:2:3:4:5:6:7:8:9:10:11' does not appear to be an IPv4 or IPv6 address",
  ],
];

describe('normalizeIpAddress', () => {
  it.each(VALID)('%s → %s', (value, canonical) => {
    expect(normalizeIpAddress(value)).toBe(canonical);
  });

  it.each(INVALID)('rejects %s', (value, message) => {
    expect(() => normalizeIpAddress(value)).toThrow(message);
  });
});
