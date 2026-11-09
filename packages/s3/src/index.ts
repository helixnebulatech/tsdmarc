// Port of parsedmarc/s3.py, on the AWS SDK v3.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client as AwsS3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import {
  type AggregateReport,
  type FailureReport,
  humanTimestampToDatetime,
  logger,
  pyJsonDumps,
  pyStr,
  type PyDateTime,
  type ReportType,
  type SMTPTLSReport,
  toSnakeCaseKeys,
} from 'tsdmarc';

/** The report fields copied to the S3 object's metadata. */
const METADATA_KEYS: readonly string[] = [
  'org_name',
  'org_email',
  'report_id',
  'begin_date',
  'end_date',
  'reported_domain',
  'arrival_date',
];

export type S3Report = AggregateReport | FailureReport | SMTPTLSReport;

export interface S3ClientOptions {
  /** The region name; the SDK's default chain when omitted. */
  regionName?: string | null;
  /** The endpoint URL (for S3-compatible services). */
  endpointUrl?: string | null;
  /** The access key ID; the SDK's default credential chain when omitted. */
  accessKeyId?: string | null;
  /** The secret access key. */
  secretAccessKey?: string | null;
  /**
   * Never replace an existing object (tsdmarc only; default `false`, which
   * overwrites like parsedmarc). The key's hash only covers fields that
   * aren't secret, so a forged report that copies them still lands on the
   * real report's key. Objects are written with `If-None-Match: *`; when the
   * key holds different content, this report is saved as
   * `<id>_<hash>-<sha256 of the body>.json`, and an identical one is
   * skipped. Needs `s3:GetObject` as well as `s3:PutObject`, and a service
   * that supports conditional writes: the first save checks it and throws if
   * the service ignores the header.
   */
  preventOverwrite?: boolean;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Printable ASCII. */
const PRINTABLE_FIRST = 0x20;
const PRINTABLE_LAST = 0x7e;

function printableExcept(excluded: string): ReadonlySet<string> {
  const safe = new Set<string>();
  for (let code = PRINTABLE_FIRST; code <= PRINTABLE_LAST; code += 1) {
    const char = String.fromCodePoint(code);
    if (!excluded.includes(char)) {
      safe.add(char);
    }
  }
  return safe;
}

/**
 * Printable ASCII except `%`, which is always encoded so that
 * `urllib.parse.unquote()` (or `decodeURIComponent()`) reverses the
 * encoding exactly. botocore rejects non-ASCII metadata and a bare CR or LF.
 */
const METADATA_SAFE = printableExcept('%');
/**
 * The same, minus `/` (the key delimiter) and every printable character in
 * the AWS object key "characters to avoid" list, so a report ID always
 * stays one key segment. ":" and "@", which real report IDs use, are kept.
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html
 */
const KEY_SEGMENT_SAFE = printableExcept('%/\\{}^[]"<>~#|`');
/**
 * User-defined metadata is limited to 2 KB (keys and values, UTF-8 bytes).
 * At most seven metadata keys exist; 7 * 256 bytes plus the names (with
 * their "x-amz-meta-" prefixes) is 1,940 bytes.
 */
const MAX_METADATA_VALUE_LENGTH = 256;
/** An object key is at most 1,024 bytes of UTF-8, prefix included. */
const MAX_KEY_LENGTH = 1024;
/** Hex characters of the SHA-256 digest appended to each key (64 bits). */
const KEY_HASH_LENGTH = 16;
const HIGH_SURROGATE_FIRST = 0xd8_00;
const LOW_SURROGATE_LAST = 0xdf_ff;

/**
 * parsedmarc's `_percent_encode()`: `value` as UTF-8, with only `safe`
 * characters kept as-is, cut to at most `maxLength` characters. The result
 * is ASCII and cut between whole input characters, so neither a `%XX`
 * triplet nor a UTF-8 sequence is split. A lone surrogate becomes `?`.
 */
function percentEncode(
  value: string,
  safe: ReadonlySet<string>,
  maxLength: number,
): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    let piece: string;
    if (safe.has(char)) {
      piece = char;
    } else if (code >= HIGH_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST) {
      // quote(errors="replace"): a lone surrogate has no UTF-8 encoding.
      piece = '?';
    } else {
      piece = '';
      for (const byte of Buffer.from(char, 'utf8')) {
        piece += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
    if (result.length + piece.length > maxLength) {
      break;
    }
    result += piece;
  }
  return result;
}

/** An S3 metadata value: percent-encoded and at most 256 characters. */
function metadataValue(value: unknown): string {
  return percentEncode(pyStr(value), METADATA_SAFE, MAX_METADATA_VALUE_LENGTH);
}

/** Python's default `str` ordering (code points, not UTF-16 units). */
function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return a.length - b.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A copy with every plain object's keys sorted, like `sort_keys=True`. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted(compareCodePoints)) {
    sorted[key] = sortKeysDeep(value[key]);
  }
  return sorted;
}

/**
 * parsedmarc's `_report_hash()`: the first 16 hex characters of the SHA-256
 * digest of the report type and the fields that identify the report, as
 * `json.dumps(..., sort_keys=True, separators=(",", ":"), default=str)`.
 * Only fields from the report itself are hashed, never enrichment, so a
 * retried report keeps its key. Changing this recipe moves every object.
 */
function reportHash(reportType: string, fields: readonly unknown[]): string {
  const canonical = pyJsonDumps(sortKeysDeep([reportType, ...fields]), {
    separators: [',', ':'],
    default: String,
  });
  return createHash('sha256')
    .update(canonical, 'utf8')
    .digest('hex')
    .slice(0, KEY_HASH_LENGTH);
}

/**
 * The object key: the report ID percent-encoded into one segment and
 * shortened so the whole key fits in S3's 1,024-byte limit, then `suffix`.
 */
function objectKey(prefix: string, reportId: string, suffix: string): string {
  const budget = MAX_KEY_LENGTH - Buffer.byteLength(prefix) - suffix.length;
  return `${prefix}${percentEncode(reportId, KEY_SEGMENT_SAFE, budget)}${suffix}`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text.toWellFormed()).digest('hex');
}

/** Attempts when a conditional write races a delete (`409`) or a read misses. */
const MAX_CONDITIONAL_ATTEMPTS = 3;
const HTTP_PRECONDITION_FAILED = 412;
const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;

/** `mapping[key]`, raising like Python's `KeyError` when it is missing. */
function required(mapping: Record<string, unknown>, key: string): unknown {
  if (!(key in mapping)) {
    throw new TypeError(`'${key}'`);
  }
  return mapping[key];
}

/** The HTTP status of an SDK error, if any. */
function httpStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object' || !('$metadata' in error)) {
    return;
  }
  const metadata = error.$metadata;
  if (metadata === null || typeof metadata !== 'object') {
    return;
  }
  const status = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

/** Written once per client to check that the service honors If-None-Match. */
const CONDITIONAL_WRITE_PROBE = '.tsdmarc-conditional-write-check';

/**
 * botocore's default timeouts (`DEFAULT_TIMEOUT = 60`): 60 s to connect and
 * 60 s without data on the socket (urllib3's read timeout applies to each
 * read, i.e. an idle timeout, which is the SDK's `socketTimeout`).
 */
const CONNECT_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 60_000;

/** The object metadata: the known keys, without null values, encoded. */
function buildObjectMetadata(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (keys.includes(key) && value !== null && value !== undefined) {
      metadata[key] = metadataValue(value);
    }
  }
  return metadata;
}

/** The SDK's default region chain, falling back to us-east-1 like boto3. */
const defaultRegion = async (): Promise<string> => {
  const probe = new AwsS3Client({});
  try {
    return await probe.config.region();
  } catch {
    return 'us-east-1';
  } finally {
    probe.destroy();
  }
};

/** A client for interacting with Amazon S3. */
export class S3Client {
  readonly bucketName: string;
  readonly bucketPath: string;
  readonly metadataKeys: readonly string[] = METADATA_KEYS;
  /** Whether existing objects are kept (see {@link S3ClientOptions}). */
  readonly preventOverwrite: boolean;
  /** The AWS SDK client. */
  readonly s3: AwsS3Client;
  #conditionalWritesChecked: Promise<void> | undefined;

  /**
   * @param bucketName - The S3 bucket
   * @param bucketPath - The path to save reports under
   */
  constructor(
    bucketName: string,
    bucketPath: string,
    options: S3ClientOptions = {},
  ) {
    this.bucketName = bucketName;
    this.bucketPath = bucketPath;
    this.preventOverwrite = options.preventOverwrite ?? false;
    const config: S3ClientConfig = {};
    // Like boto3: the given region, else the SDK's default chain
    // (environment, shared config), else us-east-1. The lookup runs once per
    // client, like boto3 (which resolves it when the client is created).
    if (options.regionName) {
      config.region = options.regionName;
    } else {
      let region: Promise<string> | undefined;
      config.region = (): Promise<string> => {
        region ??= defaultRegion();
        return region;
      };
    }
    if (options.endpointUrl) {
      config.endpoint = options.endpointUrl;
      // boto3 switches to path-style addressing for a custom endpoint
      // (botocore/args.py), which S3-compatible services expect.
      config.forcePathStyle = true;
    }
    // Like boto3: explicit keys when given, otherwise the default chain
    // (environment, shared config, instance role, ...).
    if (options.accessKeyId || options.secretAccessKey) {
      config.credentials = {
        accessKeyId: options.accessKeyId ?? '',
        secretAccessKey: options.secretAccessKey ?? '',
      };
    }
    // boto3's default timeouts; the SDK's are unlimited.
    config.requestHandler = {
      connectionTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: READ_TIMEOUT_MS,
    };
    this.s3 = new AwsS3Client(config);
  }

  async saveAggregateReportToS3(report: AggregateReport): Promise<void> {
    await this.saveReportToS3(report, 'aggregate');
  }

  async saveFailureReportToS3(report: FailureReport): Promise<void> {
    await this.saveReportToS3(report, 'failure');
  }

  /** Backward-compatible alias of {@link saveFailureReportToS3}. */
  async saveForensicReportToS3(report: FailureReport): Promise<void> {
    await this.saveFailureReportToS3(report);
  }

  async saveSmtpTlsReportToS3(report: SMTPTLSReport): Promise<void> {
    await this.saveReportToS3(report, 'smtp_tls');
  }

  /**
   * Save `report` as JSON at
   * `<bucketPath>/<reportType>/year=YYYY/month=MM/day=DD/<id>_<hash>.json`,
   * where `<id>` is the report ID (the reported domain for failure reports)
   * percent-encoded into one key segment and `<hash>` covers the fields that
   * identify the report (GHSA-7wqr-f6g9-cm29).
   */
  async saveReportToS3(
    report: S3Report,
    reportType: ReportType,
  ): Promise<void> {
    const snakeReport = toSnakeCaseKeys(report) as Record<string, unknown>;
    let reportDate: PyDateTime;
    let reportId: unknown;
    let hashFields: unknown[];
    let metadataSource: Record<string, unknown>;
    if (reportType === 'smtp_tls') {
      // SMTP TLS reports (RFC 8460) are flat: they have no report_metadata,
      // and begin_date is the ISO string from the report JSON.
      reportDate = humanTimestampToDatetime(
        String(required(snakeReport, 'begin_date')),
      );
      reportId = required(snakeReport, 'report_id');
      const policies = (snakeReport.policies || []) as Record<
        string,
        unknown
      >[];
      hashFields = [
        snakeReport.organization_name,
        snakeReport.report_id,
        snakeReport.begin_date,
        snakeReport.end_date,
        policies
          .map(policy => pyStr(policy.policy_domain))
          .toSorted(compareCodePoints),
      ];
      metadataSource = {
        org_name: snakeReport.organization_name,
        report_id: snakeReport.report_id,
        begin_date: pyStr(snakeReport.begin_date),
        end_date: pyStr(snakeReport.end_date),
      };
    } else if (reportType === 'failure') {
      // Failure reports (RFC 9991) have no report_metadata and no report
      // ID: the UTC arrival date and the reported domain stand in for them.
      reportDate = humanTimestampToDatetime(
        String(required(snakeReport, 'arrival_date_utc')),
        { assumeUtc: true },
      );
      reportId = required(snakeReport, 'reported_domain');
      const source = (snakeReport.source || {}) as Record<string, unknown>;
      hashFields = [
        snakeReport.arrival_date_utc,
        snakeReport.reported_domain,
        snakeReport.original_mail_from,
        snakeReport.original_rcpt_to,
        snakeReport.original_envelope_id,
        source.ip_address,
        snakeReport.sample,
      ];
      metadataSource = {
        reported_domain: snakeReport.reported_domain,
        arrival_date: snakeReport.arrival_date_utc,
      };
    } else {
      const metadata = required(snakeReport, 'report_metadata');
      if (metadata === null || typeof metadata !== 'object') {
        throw new TypeError("'report_metadata'");
      }
      metadataSource = metadata as Record<string, unknown>;
      reportDate = humanTimestampToDatetime(
        String(required(metadataSource, 'begin_date')),
      );
      reportId = required(metadataSource, 'report_id');
      const policyPublished = (snakeReport.policy_published || {}) as Record<
        string,
        unknown
      >;
      hashFields = [
        metadataSource.org_name,
        metadataSource.report_id,
        policyPublished.domain,
        metadataSource.begin_date,
        metadataSource.end_date,
      ];
    }
    const prefix = `${this.bucketPath}/${reportType}/year=${reportDate.year}/month=${pad2(reportDate.month)}/day=${pad2(reportDate.day)}/`;
    const hash = reportHash(reportType, hashFields);
    const objectPath = objectKey(prefix, pyStr(reportId), `_${hash}.json`);
    logger.debug(
      `Saving ${reportType} report to s3://${this.bucketName}/${objectPath}`,
    );
    const objectMetadata = buildObjectMetadata(
      metadataSource,
      this.metadataKeys,
    );
    // json.dumps(report, default=str): exact ints, even beyond 2^53.
    const body = pyJsonDumps(snakeReport, { default: String });
    if (!this.preventOverwrite) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Body: body,
          Key: objectPath,
          Metadata: objectMetadata,
        }),
      );
      return;
    }
    await this.#checkConditionalWrites();
    for (let attempt = 1; ; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- attempts are sequential
      if (await this.#putIfAbsent(objectPath, body, objectMetadata)) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- attempts are sequential
      const existing = await this.#readObject(objectPath);
      if (existing === body) {
        logger.debug(`s3://${this.bucketName}/${objectPath} already saved`);
        return;
      }
      if (existing !== undefined) {
        break;
      }
      // Deleted between the write and the read: write it again.
      if (attempt >= MAX_CONDITIONAL_ATTEMPTS) {
        throw new Error(
          `s3://${this.bucketName}/${objectPath} kept changing; report not saved`,
        );
      }
    }
    // Same identifying fields, different content: a forged report (the
    // hashed fields aren't secret) or a retry with different enrichment.
    // A retry with the same content finds an identical object, which is fine.
    const alternatePath = objectKey(
      prefix,
      pyStr(reportId),
      `_${hash}-${sha256Hex(body)}.json`,
    );
    logger.warning(
      `s3://${this.bucketName}/${objectPath} holds a different ${reportType} report with the same identifying fields; saving this one as ${alternatePath}`,
    );
    await this.#putIfAbsent(alternatePath, body, objectMetadata);
  }

  /**
   * `PutObject` with `If-None-Match: *`: `false` when the key exists (412).
   * A 409 (a concurrent delete) is retried, as AWS documents.
   */
  async #putIfAbsent(
    key: string,
    body: string,
    metadata: Record<string, string>,
  ): Promise<boolean> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- attempts are sequential
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Body: body,
            Key: key,
            Metadata: metadata,
            IfNoneMatch: '*',
          }),
        );
        return true;
      } catch (error) {
        const status = httpStatus(error);
        if (status === HTTP_PRECONDITION_FAILED) {
          return false;
        }
        if (status !== HTTP_CONFLICT || attempt >= MAX_CONDITIONAL_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  /** The object's body as text, or `undefined` if it doesn't exist. */
  async #readObject(key: string): Promise<string | undefined> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      return (await response.Body?.transformToString('utf-8')) ?? '';
    } catch (error) {
      if (httpStatus(error) === HTTP_NOT_FOUND) {
        return;
      }
      throw error;
    }
  }

  /**
   * Services that don't support conditional writes (older MinIO and Ceph)
   * ignore If-None-Match and overwrite in silence. Writing a probe object
   * twice must fail the second time; otherwise saving is refused. Checked
   * once per client; a failed check is retried on the next save.
   */
  #checkConditionalWrites(): Promise<void> {
    this.#conditionalWritesChecked ??= (async () => {
      const key = `${this.bucketPath}/${CONDITIONAL_WRITE_PROBE}`;
      await this.#putIfAbsent(key, '', {});
      if (await this.#putIfAbsent(key, '', {})) {
        throw new Error(
          `S3 service ignored If-None-Match (s3://${this.bucketName}/${key} was overwritten): it does not support conditional writes, which preventOverwrite needs`,
        );
      }
    })().catch((error: unknown) => {
      this.#conditionalWritesChecked = undefined;
      throw error;
    });
    return this.#conditionalWritesChecked;
  }

  /** Release the SDK client's sockets. Never throws. */
  close(): void {
    try {
      this.s3.destroy();
    } catch {
      // Best-effort: this runs during shutdown/cleanup, and a failure to
      // close the SDK client isn't actionable here.
    }
  }
}
