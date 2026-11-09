// Port of parsedmarc/types.py.
//
// The API uses camelCase. Output integrations (JSON, CSV, Elasticsearch,
// OpenSearch, Splunk, Kafka, S3, Postgres, Log Analytics, syslog, GELF and
// webhooks) write the snake_case keys parsedmarc uses, through
// `toSnakeCaseKeys()` in `./serialize`. Every camelCase key here maps 1:1 to
// the parsedmarc key with the same words (`ipAddress` → `ip_address`).

export type ReportType = 'aggregate' | 'failure' | 'smtp_tls';

export interface AggregateReportMetadata {
  orgName: string;
  orgEmail: string;
  orgExtraContactInfo: string | null;
  reportId: string;
  beginDate: string;
  endDate: string;
  timespanRequiresNormalization: boolean;
  /** A `bigint` only beyond ±2^53 (Python ints are unbounded). */
  originalTimespanSeconds: number | bigint;
  errors: string[];
  generator: string | null;
}

export interface AggregatePolicyPublished {
  domain: string;
  adkim: string;
  aspf: string;
  p: string;
  sp: string;
  pct: string | null;
  fo: string | null;
  np: string | null;
  testing: string | null;
  discoveryMethod: string | null;
}

export interface IPSourceInfo {
  ipAddress: string;
  country: string | null;
  reverseDns: string | null;
  baseDomain: string | null;
  name: string | null;
  type: string | null;
  asn: number | null;
  asName: string | null;
  asDomain: string | null;
}

/** Same shape as {@link IPSourceInfo}; returned by `getIpAddressInfo()`. */
export type IPAddressInfo = IPSourceInfo;

export interface ReverseDNSService {
  name: string;
  type: string | null;
}

/** Base domain → service, loaded from `base_reverse_dns_map.csv`. */
export type ReverseDNSMap = Map<string, ReverseDNSService>;

export interface AggregateAlignment {
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
}

export interface AggregateIdentifiers {
  headerFrom: string;
  envelopeFrom: string | null;
  envelopeTo: string | null;
}

export interface AggregatePolicyOverrideReason {
  type: string | null;
  comment: string | null;
}

export interface AggregateAuthResultDKIM {
  domain: string;
  result: string;
  selector: string;
  humanResult: string | null;
}

export interface AggregateAuthResultSPF {
  domain: string;
  result: string;
  scope: string;
  humanResult: string | null;
}

export interface AggregateAuthResults {
  dkim: AggregateAuthResultDKIM[];
  spf: AggregateAuthResultSPF[];
}

export interface AggregatePolicyEvaluated {
  disposition: string;
  dkim: string;
  spf: string;
  policyOverrideReasons: AggregatePolicyOverrideReason[];
}

export interface AggregateRecord {
  intervalBegin: string;
  intervalEnd: string;
  /** True when the record was split into daily buckets. */
  normalizedTimespan: boolean;
  source: IPSourceInfo;
  /** A `bigint` only beyond 2^53 (Python ints are unbounded). */
  count: number | bigint;
  alignment: AggregateAlignment;
  policyEvaluated: AggregatePolicyEvaluated;
  disposition: string;
  identifiers: AggregateIdentifiers;
  authResults: AggregateAuthResults;
}

export interface AggregateReport {
  xmlSchema: string;
  xmlNamespace: string | null;
  reportMetadata: AggregateReportMetadata;
  policyPublished: AggregatePolicyPublished;
  records: AggregateRecord[];
}

export interface EmailAddress {
  displayName: string | null;
  address: string;
  local: string | null;
  domain: string | null;
}

export interface EmailAttachment {
  filename?: string | null;
  /** The filename reduced to a safe basename, or null (mail-parser). */
  safeFilename?: string | null;
  mailContentType?: string | null;
  sha256?: string | null;
  payload?: string;
  contentTransferEncoding?: string;
  binary?: boolean;
  charset?: string | null;
  [key: string]: unknown;
}

/**
 * One Received header of a parsed email, as mail-parser reports it (the
 * first hop first). Clause keys (`from`, `by`, `with`, `id`, `for`, `via`)
 * hold the clause text; `raw` replaces them when the header is unparseable.
 */
export interface EmailReceivedHop {
  hop: number;
  delay: number;
  date?: string;
  dateUtc?: string;
  envelopeFrom?: string;
  envelopeSender?: string;
  raw?: string;
  [key: string]: unknown;
}

/**
 * A parsed email, in the shape parsedmarc builds from mail-parser's JSON
 * (`parse_email()`). Only the fields parsedmarc relies on are typed; other
 * header-derived keys may be present. `headers` maps raw header names to
 * values and is copied verbatim to the output (its keys are not converted).
 */
export interface ParsedEmail {
  headers: Record<string, unknown>;
  subject: string | null;
  filenameSafeSubject: string | null;
  date: string | null;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  deliveredTo?: EmailAddress[];
  attachments: EmailAttachment[];
  body: string | null;
  hasDefects?: boolean;
  defects?: unknown;
  defectsCategories?: unknown;
  received?: EmailReceivedHop[];
  /** Domains of the To and Reply-To addresses. */
  toDomains?: string[];
  /** UTC offset of the Date header in hours (`"+2.0"`). */
  timezone?: string;
  addressHeaderDefects?: unknown[];
  receivedHeaderDefects?: unknown[];
  dateHeaderDefects?: unknown[];
  [key: string]: unknown;
}

export interface FailureReport {
  feedbackType: string | null;
  userAgent: string | null;
  version: string | null;
  originalEnvelopeId: string | null;
  originalMailFrom: string | null;
  originalRcptTo: string | null;
  arrivalDate: string;
  arrivalDateUtc: string;
  authenticationResults: string | null;
  deliveryResult: string | null;
  authFailure: string[];
  authenticationMechanisms: string[];
  dkimDomain: string | null;
  reportedDomain: string;
  sampleHeadersOnly: boolean;
  source: IPSourceInfo;
  sample: string;
  parsedSample: ParsedEmail;
  /** The `Message-ID` field of the feedback report, when present. */
  messageId?: string;
  /** The `Reported-URI` field of the feedback report, when present. */
  reportedUri?: string;
  /**
   * Every other field of the feedback report is kept, keyed by its name
   * lowercased with `-` → `_` and then camelCased (`Incidents` →
   * `incidents`, `X-Custom-Field` → `xCustomField`).
   */
  [field: string]: unknown;
}

/** Backward-compatible alias of {@link FailureReport}. */
export type ForensicReport = FailureReport;

export interface SMTPTLSFailureDetails {
  resultType: string;
  /** A `bigint` only beyond 2^53 (the report's JSON integer, exact). */
  failedSessionCount: number | bigint;
  sendingMtaIp?: string;
  receivingIp?: string;
  receivingMxHostname?: string;
  receivingMxHelo?: string;
  additionalInfoUri?: string;
  failureReasonCode?: string;
  ipAddress?: string;
}

export interface SMTPTLSPolicy {
  policyDomain: string;
  policyType: string;
  /** A `bigint` only beyond 2^53 (the report's JSON integer, exact). */
  successfulSessionCount: number | bigint;
  /** A `bigint` only beyond 2^53 (the report's JSON integer, exact). */
  failedSessionCount: number | bigint;
  policyStrings?: string[];
  mxHostPatterns?: string[];
  failureDetails?: SMTPTLSFailureDetails[];
}

export interface SMTPTLSReport {
  organizationName: string;
  beginDate: string;
  endDate: string;
  contactInfo: string | string[];
  reportId: string;
  policies: SMTPTLSPolicy[];
}

export interface AggregateParsedReport {
  reportType: 'aggregate';
  report: AggregateReport;
}

export interface FailureParsedReport {
  reportType: 'failure';
  report: FailureReport;
}

/** Backward-compatible alias of {@link FailureParsedReport}. */
export type ForensicParsedReport = FailureParsedReport;

export interface SMTPTLSParsedReport {
  reportType: 'smtp_tls';
  report: SMTPTLSReport;
}

export type ParsedReport =
  | AggregateParsedReport
  | FailureParsedReport
  | SMTPTLSParsedReport;

export interface ParsingResults {
  aggregateReports: AggregateReport[];
  failureReports: FailureReport[];
  smtpTlsReports: SMTPTLSReport[];
}
