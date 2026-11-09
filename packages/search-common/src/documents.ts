// The document classes of parsedmarc/elastic.py and parsedmarc/opensearch.py
// (identical in both), as field schemas.
//
// Field names and types match the DSL declarations one for one, including
// their quirks: `message_count` and `original_timespan_seconds` are declared
// as the bare `Integer` class (not an instance), so the DSL does not treat
// them as fields; and several values parsedmarc saves (`org_name` on SMTP
// TLS documents, `policy_string`, `source_base_domain`, ...) are not declared
// at all. Both kinds are stored as given, so they are absent here.

import {
  type DocumentSchema,
  type Field,
  type IndexMapping,
  indexMapping,
  schemaMapping,
} from './dsl';

const TEXT: Field = { type: 'text' };
const KEYWORD: Field = { type: 'keyword' };
const INTEGER: Field = { type: 'integer' };
const BOOLEAN: Field = { type: 'boolean' };
const DATE: Field = { type: 'date' };
const IP: Field = { type: 'ip' };

/** `Text(multi=True, fields={"keyword": Keyword(ignore_above=256)})`. */
const COMBINED_TEXT: Field = {
  type: 'text',
  fields: { keyword: { type: 'keyword', ignore_above: 256 } },
};

const POLICY_OVERRIDE_DOC: DocumentSchema = { type: TEXT, comment: TEXT };

const PUBLISHED_POLICY_DOC: DocumentSchema = {
  domain: TEXT,
  adkim: TEXT,
  aspf: TEXT,
  p: TEXT,
  sp: TEXT,
  pct: INTEGER,
  fo: TEXT,
  np: KEYWORD,
  testing: KEYWORD,
  discovery_method: KEYWORD,
};

const DKIM_RESULT_DOC: DocumentSchema = {
  domain: TEXT,
  selector: TEXT,
  result: TEXT,
  human_result: TEXT,
};

const SPF_RESULT_DOC: DocumentSchema = {
  domain: TEXT,
  scope: TEXT,
  result: TEXT,
  human_result: TEXT,
};

/** `_AggregateReportDoc` (index `dmarc_aggregate`). */
export const AGGREGATE_REPORT_DOC: DocumentSchema = {
  xml_schema: TEXT,
  xml_namespace: KEYWORD,
  org_name: TEXT,
  org_email: TEXT,
  org_extra_contact_info: TEXT,
  report_id: TEXT,
  date_range: DATE,
  date_begin: DATE,
  date_end: DATE,
  normalized_timespan: BOOLEAN,
  errors: TEXT,
  published_policy: { type: 'object', properties: PUBLISHED_POLICY_DOC },
  source_ip_address: IP,
  source_country: TEXT,
  source_reverse_dns: TEXT,
  source_base_domain: TEXT,
  source_type: TEXT,
  source_name: TEXT,
  source_asn: INTEGER,
  source_as_name: TEXT,
  source_as_domain: TEXT,
  disposition: TEXT,
  dkim_aligned: BOOLEAN,
  spf_aligned: BOOLEAN,
  passed_dmarc: BOOLEAN,
  policy_overrides: { type: 'nested', properties: POLICY_OVERRIDE_DOC },
  header_from: TEXT,
  envelope_from: TEXT,
  envelope_to: TEXT,
  // Nested only in the DSL's in-memory shape: create_indexes() never
  // installs this mapping, so the cluster maps these as plain `object`
  // (parsedmarc issue #169).
  dkim_results: { type: 'nested', properties: DKIM_RESULT_DOC },
  spf_results: { type: 'nested', properties: SPF_RESULT_DOC },
  dkim_results_combined: COMBINED_TEXT,
  spf_results_combined: COMBINED_TEXT,
  np: KEYWORD,
  testing: KEYWORD,
  discovery_method: KEYWORD,
  generator: TEXT,
};

const EMAIL_ADDRESS_DOC: DocumentSchema = { display_name: TEXT, address: TEXT };

/** `_EmailAttachmentDoc`. */
export const EMAIL_ATTACHMENT_DOC: DocumentSchema = {
  filename: TEXT,
  content_type: TEXT,
  sha256: TEXT,
};

/**
 * The `sample.headers` fields a failure index maps: those the shipped
 * Grafana and OpenSearch dashboards (`dashboards/`) know, and a few more
 * that help to trace a message. Header names come from the sender, and with
 * dynamic mapping each new one adds a field until the index reaches
 * `index.mapping.total_fields.limit` (1,000 by default), after which every
 * sample with an unmapped header is rejected until the next index.
 */
export const INDEXED_SAMPLE_HEADERS: readonly string[] = [
  'authentication-results',
  'auto-submitted',
  'cc',
  'content-transfer-encoding',
  'content-type',
  'date',
  'delivered-to',
  'dkim-signature',
  'from',
  'in-reply-to',
  'list-id',
  'message-id',
  'mime-version',
  'received',
  'received-spf',
  'references',
  'reply-to',
  'return-path',
  'sender',
  'subject',
  'thread-index',
  'thread-topic',
  'to',
  'user-agent',
  'x-auto-response-suppress',
  'x-exclaimer-md-config',
  'x-linkedin-fe',
  'x-mailer',
  'x-ms-exchange-generated-message-source',
  'x-ms-exchange-inbox-rules-loop',
  'x-ms-exchange-parent-message-id',
  'x-ms-exchange-transport-fromentityheader',
  'x-ms-has-attach',
  'x-ms-tnef-correlator',
  'x-onpremexternalip',
  'x-originating-ip',
];

/**
 * What dynamic mapping gives a string, so that the listed headers map as in
 * parsedmarc (`sample.headers.from.keyword`). `dynamic: false` keeps every
 * other header in `_source`, without a field: visible, not searchable.
 */
const SAMPLE_HEADERS_MAPPING = {
  dynamic: false,
  properties: Object.fromEntries(
    INDEXED_SAMPLE_HEADERS.map(name => [
      name,
      {
        type: 'text',
        fields: { keyword: { type: 'keyword', ignore_above: 256 } },
      },
    ]),
  ),
};

/** `_FailureSampleDoc`. */
export const FAILURE_SAMPLE_DOC: DocumentSchema = {
  raw: TEXT,
  // A dynamic Object() in the DSL; the save functions map it as above.
  headers: { type: 'object', indexMapping: SAMPLE_HEADERS_MAPPING },
  headers_only: BOOLEAN,
  to: { type: 'nested', properties: EMAIL_ADDRESS_DOC },
  subject: TEXT,
  filename_safe_subject: TEXT,
  _from: { type: 'object', properties: EMAIL_ADDRESS_DOC },
  date: DATE,
  reply_to: { type: 'nested', properties: EMAIL_ADDRESS_DOC },
  cc: { type: 'nested', properties: EMAIL_ADDRESS_DOC },
  bcc: { type: 'nested', properties: EMAIL_ADDRESS_DOC },
  body: TEXT,
  attachments: { type: 'nested', properties: EMAIL_ATTACHMENT_DOC },
};

/** `_FailureReportDoc` (index `dmarc_failure`). */
export const FAILURE_REPORT_DOC: DocumentSchema = {
  feedback_type: TEXT,
  user_agent: TEXT,
  version: TEXT,
  original_mail_from: TEXT,
  arrival_date: DATE,
  domain: TEXT,
  original_envelope_id: TEXT,
  authentication_results: TEXT,
  delivery_results: TEXT,
  source_ip_address: IP,
  source_country: TEXT,
  source_reverse_dns: TEXT,
  source_asn: INTEGER,
  source_as_name: TEXT,
  source_as_domain: TEXT,
  source_authentication_mechanisms: TEXT,
  source_auth_failures: TEXT,
  dkim_domain: TEXT,
  original_rcpt_to: TEXT,
  sample: { type: 'object', properties: FAILURE_SAMPLE_DOC },
};

const SMTP_TLS_FAILURE_DETAILS_DOC: DocumentSchema = {
  result_type: TEXT,
  sending_mta_ip: IP,
  receiving_mx_helo: TEXT,
  receiving_mx_hostname: TEXT,
  receiving_ip: IP,
  failed_session_count: INTEGER,
  additional_information_uri: TEXT,
  failure_reason_code: TEXT,
};

const SMTP_TLS_POLICY_DOC: DocumentSchema = {
  policy_domain: TEXT,
  policy_type: TEXT,
  policy_strings: TEXT,
  mx_host_patterns: TEXT,
  successful_session_count: INTEGER,
  failed_session_count: INTEGER,
  failure_details: { type: 'nested', properties: SMTP_TLS_FAILURE_DETAILS_DOC },
};

/** `_SMTPTLSReportDoc` (index `smtp_tls`). */
export const SMTP_TLS_REPORT_DOC: DocumentSchema = {
  organization_name: TEXT,
  date_range: DATE,
  date_begin: DATE,
  date_end: DATE,
  contact_info: TEXT,
  report_id: TEXT,
  policies: { type: 'nested', properties: SMTP_TLS_POLICY_DOC },
  policies_combined: COMBINED_TEXT,
  failure_details_combined: COMBINED_TEXT,
};

export interface DocumentMappings {
  readonly aggregate: { properties: Record<string, unknown> };
  readonly failure: { properties: Record<string, unknown> };
  readonly smtpTls: { properties: Record<string, unknown> };
}

/**
 * The mappings parsedmarc's document classes declare. `createIndexes()`
 * does not install them (neither does parsedmarc): the shipped dashboards
 * rely on dynamic mapping. They are exported for reference and for users
 * who manage index templates themselves.
 */
export const DOCUMENT_MAPPINGS: DocumentMappings = {
  aggregate: schemaMapping(AGGREGATE_REPORT_DOC),
  failure: schemaMapping(FAILURE_REPORT_DOC),
  smtpTls: schemaMapping(SMTP_TLS_REPORT_DOC),
};

/** What the save functions create indexes with (see `indexMapping()`). */
export const INDEX_MAPPINGS: {
  readonly aggregate: IndexMapping;
  readonly failure: IndexMapping;
  readonly smtpTls: IndexMapping;
} = {
  aggregate: indexMapping(AGGREGATE_REPORT_DOC),
  failure: indexMapping(FAILURE_REPORT_DOC),
  smtpTls: indexMapping(SMTP_TLS_REPORT_DOC),
};
