// SQL of parsedmarc/postgres.py, with pg's $n placeholders instead of
// psycopg's %s. The schema (tables, columns, types, constraints and
// indexes) is the same, so both write to the same database.

/** Names of the statements in {@link SQL}. */
export type SqlName =
  | 'insertAggregateReport'
  | 'insertAggregateRecord'
  | 'insertAggregateRecordDkim'
  | 'insertAggregateRecordSpf'
  | 'insertAggregateRecordPolicyOverride'
  | 'selectFailureDuplicate'
  | 'insertFailureReport'
  | 'insertFailureSampleAddress'
  | 'insertSmtpTlsReport'
  | 'insertSmtpTlsPolicy'
  | 'insertSmtpTlsFailureDetail';

/** The DDL `createTables()` runs, in order. */
export const DDL_STATEMENTS: readonly string[] = [
  `
    CREATE TABLE IF NOT EXISTS dmarc_aggregate_report (
        id                      BIGSERIAL PRIMARY KEY,
        xml_schema              TEXT,
        xml_namespace           TEXT,
        org_name                TEXT NOT NULL,
        org_email               TEXT,
        org_extra_contact_info  TEXT,
        generator               TEXT,
        report_id               TEXT NOT NULL,
        begin_date              TIMESTAMPTZ NOT NULL,
        end_date                TIMESTAMPTZ NOT NULL,
        errors                  TEXT[],
        domain                  TEXT NOT NULL,
        adkim                   TEXT,
        aspf                    TEXT,
        policy                  TEXT,
        subdomain_policy        TEXT,
        pct                     TEXT,
        fo                      TEXT,
        np                      TEXT,
        testing                 TEXT,
        discovery_method        TEXT,
        UNIQUE (org_name, report_id, domain, begin_date, end_date)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dmarc_aggregate_record (
        id                  BIGSERIAL PRIMARY KEY,
        report_id           BIGINT NOT NULL
                                REFERENCES dmarc_aggregate_report(id)
                                ON DELETE CASCADE,
        interval_begin      TIMESTAMPTZ,
        interval_end        TIMESTAMPTZ,
        source_ip_address   INET,
        source_country      TEXT,
        source_reverse_dns  TEXT,
        source_base_domain  TEXT,
        source_name         TEXT,
        source_type         TEXT,
        message_count       INTEGER NOT NULL,
        spf_aligned         BOOLEAN,
        dkim_aligned        BOOLEAN,
        dmarc_passed        BOOLEAN,
        disposition         TEXT,
        policy_dkim         TEXT,
        policy_spf          TEXT,
        header_from         TEXT,
        envelope_from       TEXT,
        envelope_to         TEXT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dmarc_aggregate_record_dkim (
        id           BIGSERIAL PRIMARY KEY,
        record_id    BIGINT NOT NULL
                         REFERENCES dmarc_aggregate_record(id)
                         ON DELETE CASCADE,
        domain       TEXT,
        selector     TEXT,
        result       TEXT,
        human_result TEXT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dmarc_aggregate_record_spf (
        id           BIGSERIAL PRIMARY KEY,
        record_id    BIGINT NOT NULL
                         REFERENCES dmarc_aggregate_record(id)
                         ON DELETE CASCADE,
        domain       TEXT,
        scope        TEXT,
        result       TEXT,
        human_result TEXT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dmarc_aggregate_record_policy_override (
        id            BIGSERIAL PRIMARY KEY,
        record_id     BIGINT NOT NULL
                          REFERENCES dmarc_aggregate_record(id)
                          ON DELETE CASCADE,
        override_type TEXT,
        comment       TEXT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dmarc_failure_report (
        id                          BIGSERIAL PRIMARY KEY,
        feedback_type               TEXT,
        user_agent                  TEXT,
        version                     TEXT,
        original_envelope_id        TEXT,
        original_mail_from          TEXT,
        original_rcpt_to            TEXT,
        arrival_date                TIMESTAMPTZ,
        arrival_date_utc            TIMESTAMPTZ,
        authentication_results      TEXT,
        delivery_result             TEXT,
        auth_failure                TEXT[],
        authentication_mechanisms   TEXT[],
        dkim_domain                 TEXT,
        reported_domain             TEXT,
        sample_headers_only         BOOLEAN,
        source_ip_address           INET,
        source_country              TEXT,
        source_reverse_dns          TEXT,
        source_base_domain          TEXT,
        source_name                 TEXT,
        source_type                 TEXT,
        sample                      TEXT,
        sample_date                 TEXT,
        sample_subject              TEXT,
        sample_body                 TEXT,
        sample_has_defects          BOOLEAN,
        sample_headers              JSONB,
        sample_from                 JSONB,
        sample_to                   JSONB
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dmarc_failure_sample_address (
        id           BIGSERIAL PRIMARY KEY,
        report_id    BIGINT NOT NULL
                         REFERENCES dmarc_failure_report(id)
                         ON DELETE CASCADE,
        address_type TEXT,
        display_name TEXT,
        address      TEXT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS smtp_tls_report (
        id                BIGSERIAL PRIMARY KEY,
        organization_name TEXT NOT NULL,
        begin_date        TIMESTAMPTZ NOT NULL,
        end_date          TIMESTAMPTZ NOT NULL,
        contact_info      TEXT,
        report_id         TEXT NOT NULL,
        UNIQUE (organization_name, report_id, begin_date, end_date)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS smtp_tls_policy (
        id                      BIGSERIAL PRIMARY KEY,
        report_id               BIGINT NOT NULL
                                    REFERENCES smtp_tls_report(id)
                                    ON DELETE CASCADE,
        policy_domain           TEXT,
        policy_type             TEXT,
        policy_strings          TEXT[],
        mx_host_patterns        TEXT[],
        successful_session_count INTEGER,
        failed_session_count    INTEGER
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS smtp_tls_failure_detail (
        id                      BIGSERIAL PRIMARY KEY,
        policy_id               BIGINT NOT NULL
                                    REFERENCES smtp_tls_policy(id)
                                    ON DELETE CASCADE,
        result_type             TEXT,
        failed_session_count    INTEGER,
        sending_mta_ip          INET,
        receiving_ip            INET,
        receiving_mx_hostname   TEXT,
        receiving_mx_helo       TEXT,
        additional_info_uri     TEXT,
        failure_reason_code     TEXT
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_agg_report_begin_date
        ON dmarc_aggregate_report (begin_date)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_agg_record_report_id
        ON dmarc_aggregate_record (report_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_agg_record_header_from
        ON dmarc_aggregate_record (header_from)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_failure_report_arrival_date
        ON dmarc_failure_report (arrival_date_utc)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_smtp_tls_report_begin_date
        ON smtp_tls_report (begin_date)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_smtp_tls_policy_report_id
        ON smtp_tls_policy (report_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_agg_record_dkim_record_id
        ON dmarc_aggregate_record_dkim (record_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_agg_record_spf_record_id
        ON dmarc_aggregate_record_spf (record_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_agg_record_override_record_id
        ON dmarc_aggregate_record_policy_override (record_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_failure_sample_address_report_id
        ON dmarc_failure_sample_address (report_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_smtp_tls_failure_detail_policy_id
        ON smtp_tls_failure_detail (policy_id)
  `,
];

/** The statements the save methods run. */
export const SQL: Readonly<Record<SqlName, string>> = {
  insertAggregateReport: `
    INSERT INTO dmarc_aggregate_report (
        xml_schema, xml_namespace, org_name, org_email,
        org_extra_contact_info, generator, report_id,
        begin_date, end_date, errors,
        domain, adkim, aspf, policy,
        subdomain_policy, pct, fo,
        np, testing, discovery_method
    ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17,
        $18, $19, $20
    )
    ON CONFLICT (org_name, report_id, domain,
                 begin_date, end_date)
    DO NOTHING
    RETURNING id
  `,
  insertAggregateRecord: `
    INSERT INTO dmarc_aggregate_record (
        report_id, interval_begin, interval_end,
        source_ip_address, source_country,
        source_reverse_dns, source_base_domain,
        source_name, source_type,
        message_count,
        spf_aligned, dkim_aligned, dmarc_passed,
        disposition, policy_dkim, policy_spf,
        header_from, envelope_from, envelope_to
    ) VALUES (
        $1, $2, $3,
        $4, $5, $6, $7, $8, $9,
        $10,
        $11, $12, $13,
        $14, $15, $16,
        $17, $18, $19
    )
    RETURNING id
  `,
  insertAggregateRecordDkim: `
    INSERT INTO dmarc_aggregate_record_dkim
        (record_id, domain, selector, result,
         human_result)
    VALUES ($1, $2, $3, $4, $5)
  `,
  insertAggregateRecordSpf: `
    INSERT INTO dmarc_aggregate_record_spf
        (record_id, domain, scope, result,
         human_result)
    VALUES ($1, $2, $3, $4, $5)
  `,
  insertAggregateRecordPolicyOverride: `
    INSERT INTO dmarc_aggregate_record_policy_override
        (record_id, override_type, comment)
    VALUES ($1, $2, $3)
  `,
  selectFailureDuplicate: `
    SELECT 1 FROM dmarc_failure_report
    WHERE arrival_date_utc IS NOT DISTINCT FROM $1
      AND sample_subject   IS NOT DISTINCT FROM $2
      AND sample_from      IS NOT DISTINCT FROM $3
      AND sample_to        IS NOT DISTINCT FROM $4
    LIMIT 1
  `,
  insertFailureReport: `
    INSERT INTO dmarc_failure_report (
        feedback_type, user_agent, version,
        original_envelope_id, original_mail_from,
        original_rcpt_to, arrival_date, arrival_date_utc,
        authentication_results, delivery_result,
        auth_failure, authentication_mechanisms,
        dkim_domain, reported_domain, sample_headers_only,
        source_ip_address, source_country,
        source_reverse_dns, source_base_domain,
        source_name, source_type,
        sample, sample_date, sample_subject,
        sample_body, sample_has_defects,
        sample_headers, sample_from, sample_to
    ) VALUES (
        $1, $2, $3,
        $4, $5,
        $6, $7, $8,
        $9, $10,
        $11, $12,
        $13, $14, $15,
        $16, $17,
        $18, $19,
        $20, $21,
        $22, $23, $24,
        $25, $26,
        $27, $28, $29
    )
    RETURNING id
  `,
  insertFailureSampleAddress: `
    INSERT INTO dmarc_failure_sample_address
        (report_id, address_type,
         display_name, address)
    VALUES ($1, $2, $3, $4)
  `,
  insertSmtpTlsReport: `
    INSERT INTO smtp_tls_report (
        organization_name, begin_date, end_date,
        contact_info, report_id
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (organization_name, report_id,
                 begin_date, end_date)
    DO NOTHING
    RETURNING id
  `,
  insertSmtpTlsPolicy: `
    INSERT INTO smtp_tls_policy (
        report_id, policy_domain, policy_type,
        policy_strings, mx_host_patterns,
        successful_session_count, failed_session_count
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `,
  insertSmtpTlsFailureDetail: `
    INSERT INTO smtp_tls_failure_detail (
        policy_id, result_type,
        failed_session_count,
        sending_mta_ip, receiving_ip,
        receiving_mx_hostname, receiving_mx_helo,
        additional_info_uri, failure_reason_code
    ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9
    )
  `,
};
