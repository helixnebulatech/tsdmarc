// DNS errors, ported from dnspython's `dns.exception` and `dns.resolver`.
//
// parsedmarc lets dnspython's exceptions reach its callers (`query_dns()`
// raises them, `get_reverse_dns()` swallows every `DNSException`), so the
// port keeps the same hierarchy and message text:
//
//   DNSException
//   ├─ DNSTimeout
//   │  └─ LifetimeTimeout
//   ├─ DNSFormError
//   │  ├─ BadResponse
//   │  └─ NameTooLong
//   ├─ DNSSyntaxError
//   │  ├─ EmptyLabel
//   │  └─ LabelTooLong
//   ├─ NXDOMAIN
//   ├─ YXDOMAIN
//   ├─ NoAnswer
//   ├─ NoNameservers
//   ├─ NoMetaqueries
//   └─ UnknownRdatatype

/** Base class of every DNS error (dnspython's `dns.exception.DNSException`). */
export class DNSException extends Error {
  override name = 'DNSException';
}

/** The DNS operation timed out (`dns.exception.Timeout`). */
export class DNSTimeout extends DNSException {
  override name = 'DNSTimeout';

  /** Seconds waited, when known. */
  readonly timeout: number | null;

  constructor(timeout: number | null = null) {
    super(
      timeout === null
        ? 'The DNS operation timed out.'
        : `The DNS operation timed out after ${timeout.toFixed(3)} seconds`,
    );
    this.timeout = timeout;
  }
}

/** One failed attempt against one nameserver during a resolution. */
export interface ResolutionError {
  /** The nameserver, as dnspython prints it (`Do53:1.1.1.1@53`, a URL, ...). */
  nameserver: string;
  /** Whether the attempt used TCP (or a stream transport). */
  tcp: boolean;
  port: number;
  /** The error raised, or the response code text (`SERVFAIL`). */
  error: unknown;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorsToText(errors: readonly ResolutionError[]): string {
  return errors
    .map(
      entry => `Server ${entry.nameserver} answered ${errorText(entry.error)}`,
    )
    .join('; ');
}

/** The resolution lifetime expired (`dns.resolver.LifetimeTimeout`). */
export class LifetimeTimeout extends DNSTimeout {
  override name = 'LifetimeTimeout';
  readonly errors: readonly ResolutionError[];

  constructor(timeout: number, errors: readonly ResolutionError[]) {
    super(timeout);
    this.message = `The resolution lifetime expired after ${timeout.toFixed(3)} seconds: ${errorsToText(errors)}`;
    this.errors = errors;
  }
}

/** DNS message is malformed (`dns.exception.FormError`). */
export class DNSFormError extends DNSException {
  override name = 'DNSFormError';

  constructor(message = 'DNS message is malformed.') {
    super(message);
  }
}

/** A DNS response does not respond to the question asked (`dns.query.BadResponse`). */
export class BadResponse extends DNSFormError {
  override name = 'BadResponse';

  constructor(
    message = 'A DNS query response does not respond to the question asked.',
  ) {
    super(message);
  }
}

/** Text input is malformed (`dns.exception.SyntaxError`). */
export class DNSSyntaxError extends DNSException {
  override name = 'DNSSyntaxError';

  constructor(message = 'Text input is malformed.') {
    super(message);
  }
}

/** An escaped code in a name is invalid (`dns.name.BadEscape`). */
export class BadEscape extends DNSSyntaxError {
  override name = 'BadEscape';

  constructor() {
    super('An escaped code in a text format of DNS name is invalid.');
  }
}

/** IDNA encoding failed (`dns.name.IDNAException`). */
export class IDNAException extends DNSException {
  override name = 'IDNAException';

  constructor(detail: string) {
    super(`IDNA processing exception: ${detail}`);
  }
}

/** A DNS label is empty (`dns.name.EmptyLabel`). */
export class EmptyLabel extends DNSSyntaxError {
  override name = 'EmptyLabel';

  constructor() {
    super('A DNS label is empty.');
  }
}

/** A DNS label is > 63 octets long (`dns.name.LabelTooLong`). */
export class LabelTooLong extends DNSSyntaxError {
  override name = 'LabelTooLong';

  constructor() {
    super('A DNS label is > 63 octets long.');
  }
}

/** A DNS name is > 255 octets long (`dns.name.NameTooLong`). */
export class NameTooLong extends DNSFormError {
  override name = 'NameTooLong';

  constructor() {
    super('A DNS name is > 255 octets long.');
  }
}

/** The DNS query name does not exist (`dns.resolver.NXDOMAIN`). */
export class NXDOMAIN extends DNSException {
  override name = 'NXDOMAIN';
  /** The names that were tried, in text form with the final dot. */
  readonly qnames: readonly string[];

  constructor(qnames: readonly string[]) {
    const prefix =
      qnames.length > 1
        ? 'None of DNS query names exist'
        : 'The DNS query name does not exist';
    super(`${prefix}: ${qnames.join(', ')}`);
    this.qnames = qnames;
  }
}

/** The DNS query name is too long after DNAME substitution (`dns.resolver.YXDOMAIN`). */
export class YXDOMAIN extends DNSException {
  override name = 'YXDOMAIN';

  constructor() {
    super('The DNS query name is too long after DNAME substitution.');
  }
}

/** The DNS response does not contain an answer to the question (`dns.resolver.NoAnswer`). */
export class NoAnswer extends DNSException {
  override name = 'NoAnswer';

  /** @param question The question as dnspython prints it (`example.com. IN TXT`). */
  constructor(question: string) {
    super(
      `The DNS response does not contain an answer to the question: ${question}`,
    );
  }
}

/** All nameservers failed to answer the query (`dns.resolver.NoNameservers`). */
export class NoNameservers extends DNSException {
  override name = 'NoNameservers';
  readonly errors: readonly ResolutionError[];

  /** @param question The question as dnspython prints it (`example.com. IN TXT`). */
  constructor(question: string, errors: readonly ResolutionError[]) {
    super(
      `All nameservers failed to answer the query ${question}: ${errorsToText(errors)}`,
    );
    this.errors = errors;
  }
}

/** DNS metaqueries are not allowed (`dns.resolver.NoMetaqueries`). */
export class NoMetaqueries extends DNSException {
  override name = 'NoMetaqueries';

  constructor() {
    super('DNS metaqueries are not allowed.');
  }
}

/** DNS resource record type is unknown (`dns.rdatatype.UnknownRdatatype`). */
export class UnknownRdatatype extends DNSException {
  override name = 'UnknownRdatatype';

  constructor(message = 'DNS resource record type is unknown.') {
    super(message);
  }
}
