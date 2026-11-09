// The minimal reports test_syslog.py and test_gelf.py feed to the outputs,
// written in parsedmarc's snake_case and converted to tsdmarc's types.

import { toCamelCaseKeys } from '../serialize';
import type { AggregateReport, FailureReport, SMTPTLSReport } from '../types';

const NO_AUTH_RESULTS = { dkim: [], spf: [] };

const PASSING_AUTH_RESULTS = {
  dkim: [
    {
      domain: 'example.com',
      selector: 's1',
      result: 'pass',
      human_result: null,
    },
  ],
  spf: [
    {
      domain: 'example.com',
      scope: 'mfrom',
      result: 'pass',
      human_result: null,
    },
  ],
};

export function sampleAggregateReport(
  options: {
    count?: number | bigint;
    orgName?: string;
    withAuthResults?: boolean;
  } = {},
): AggregateReport {
  const {
    count = 9,
    orgName = 'example.com',
    withAuthResults = false,
  } = options;
  const report = {
    xml_schema: 'draft',
    xml_namespace: null,
    report_metadata: {
      org_name: orgName,
      org_email: 'dmarc@example.com',
      org_extra_contact_info: null,
      report_id: 'agg-1',
      begin_date: '2024-01-01 00:00:00',
      end_date: '2024-01-02 00:00:00',
      timespan_requires_normalization: false,
      original_timespan_seconds: 86_400,
      errors: [],
      generator: null,
    },
    policy_published: {
      domain: 'example.com',
      adkim: 'r',
      aspf: 'r',
      p: 'none',
      sp: 'none',
      pct: null,
      fo: null,
      np: null,
      testing: null,
      discovery_method: null,
    },
    records: [
      {
        interval_begin: '2024-01-01 00:00:00',
        interval_end: '2024-01-02 00:00:00',
        normalized_timespan: false,
        source: {
          ip_address: '192.0.2.1',
          country: 'US',
          reverse_dns: null,
          base_domain: null,
          name: null,
          type: null,
          asn: 64_496,
          as_name: 'Example AS',
          as_domain: 'example.net',
        },
        count,
        alignment: { spf: true, dkim: true, dmarc: true },
        policy_evaluated: {
          disposition: 'none',
          dkim: 'pass',
          spf: 'pass',
          policy_override_reasons: [],
        },
        identifiers: {
          header_from: 'example.com',
          envelope_from: 'example.com',
          envelope_to: null,
        },
        auth_results: withAuthResults ? PASSING_AUTH_RESULTS : NO_AUTH_RESULTS,
      },
    ],
  };
  return toCamelCaseKeys(report) as AggregateReport;
}

export function sampleFailureReport(): FailureReport {
  const report = {
    feedback_type: 'auth-failure',
    user_agent: 'test/1.0',
    version: '1',
    original_envelope_id: null,
    original_mail_from: 'x@example.com',
    original_rcpt_to: null,
    arrival_date: 'Thu, 1 Jan 2024 00:00:00 +0000',
    arrival_date_utc: '2024-01-01 00:00:00',
    authentication_results: null,
    delivery_result: 'other',
    auth_failure: ['dmarc'],
    authentication_mechanisms: [],
    dkim_domain: null,
    reported_domain: 'example.com',
    sample_headers_only: true,
    source: {
      ip_address: '192.0.2.5',
      country: 'US',
      reverse_dns: null,
      base_domain: null,
      name: null,
      type: null,
      asn: 64_496,
      as_name: 'Example AS',
      as_domain: 'example.net',
    },
    sample: '...',
    parsed_sample: { subject: 'Test' },
  };
  return toCamelCaseKeys(report) as FailureReport;
}

export function sampleSmtpTlsReport(): SMTPTLSReport {
  const report = {
    organization_name: 'example.com',
    begin_date: '2024-02-03T00:00:00Z',
    end_date: '2024-02-04T00:00:00Z',
    contact_info: 'tls@example.com',
    report_id: 'tls-1',
    policies: [
      {
        policy_domain: 'example.com',
        policy_type: 'sts',
        successful_session_count: 100,
        failed_session_count: 0,
      },
    ],
  };
  return toCamelCaseKeys(report) as SMTPTLSReport;
}
