// Port of parsedmarc/constants.py.

/** Version of tsdmarc itself. */
export const VERSION: string = '0.0.0';

/** parsedmarc version this port matches feature-for-feature. */
export const PARSEDMARC_COMPAT_VERSION: string = '11.2.1';

export const USER_AGENT: string = `tsdmarc/${VERSION}`;

/** DNS query timeout, in seconds. */
export const DEFAULT_DNS_TIMEOUT: number = 2.0;
export const DEFAULT_DNS_MAX_RETRIES: number = 0;

/**
 * Recommended mix of public resolvers for cross-provider DNS failover. Not
 * applied automatically: callers opt in by passing
 * `nameservers: RECOMMENDED_DNS_NAMESERVERS`. Mixing providers means a single
 * operator's anycast outage falls through to a different provider.
 */
export const RECOMMENDED_DNS_NAMESERVERS: readonly string[] = [
  '1.1.1.1',
  '8.8.8.8',
];
