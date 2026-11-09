// Port of parsedmarc/opensearch.py.
//
// parsedmarc builds documents with opensearch-py's DSL classes and saves
// them through the DSL's global `default` connection. Here the documents are
// plain objects cleaned and serialized like the DSL does (see ./dsl and
// ./documents), and the client registered by setHosts() plays the part of
// the `default` connection.

import { readFile } from 'node:fs/promises';

import {
  Client,
  type ClientOptions,
  errors,
  Transport,
} from '@opensearch-project/opensearch';
import {
  AGGREGATE_REPORT_DOC,
  FAILURE_REPORT_DOC,
  INDEX_MAPPINGS,
  SMTP_TLS_REPORT_DOC,
} from '@tsdmarc/search-common/documents';
import {
  andQueries,
  appendTo,
  dataStreamMapping,
  integerOrNull,
  ipOrNull,
  serializeDocument,
  textValue,
  TIMESTAMP_FIELD,
  type DocumentSchema,
  type IndexMapping,
  type Query,
} from '@tsdmarc/search-common/dsl';
import {
  errorMessage,
  getKey,
  KeyError,
  setOwn,
  ValueError,
} from '@tsdmarc/search-common/python';
import {
  AGGREGATE_RECORD_FIELDS,
  findStoredRecords,
} from '@tsdmarc/search-common/resume';
import {
  humanTimestampToDatetime,
  InvalidFailureReport,
  logger,
  pyRepr,
  pyStr,
  rawJsonIntegers,
  redactUrlCredentials,
  sanitizeForLog,
  type AggregateRecord,
  type AggregateReport,
  type FailureReport,
  type PyDateTime,
  type SMTPTLSReport,
} from 'tsdmarc';

import { reindex } from './reindex';
import { withPythonRetries } from './transport';

/** Raised when an OpenSearch error occurs. */
export class OpenSearchError extends Error {
  override name = 'OpenSearchError';
}

/** Raised when a report to be saved matches an existing report. */
export class AlreadySaved extends Error {
  override name = 'AlreadySaved';
}

const MS_PER_SECOND = 1000;
const DEFAULT_MAX_INDEXES_PER_REPORT = 31;
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_PORT = 9200;
const HTTPS_PORT = 443;

// The client's mapping types only describe concrete field types; the
// object-with-properties shape below is valid but not expressible there.
type PutMappingBody = NonNullable<
  Parameters<Client['indices']['putMapping']>[0]
>['body'];

type CreateIndexMappings = NonNullable<
  NonNullable<Parameters<Client['indices']['create']>[0]>['body']
>['mappings'];

// The single `default` connection (opensearch-dsl `connections`).
let defaultConnection: Client | null = null;

// Priority of the index template createDataStreams() installs. OpenSearch
// itself installs no index templates, but plugins may; 501 stays above the
// usual priority-100 convention and matches the Elasticsearch package. The
// template's `index_patterns` is the exact stream name, so an overlap with
// another template is unlikely in the first place.
const DATA_STREAM_TEMPLATE_PRIORITY = 501;

type PutIndexTemplateBody = NonNullable<
  Parameters<Client['indices']['putIndexTemplate']>[0]
>['body'];

interface DataStreamState {
  /**
   * The template each stream was set up with, by stream name, so each one
   * costs its API calls once per client rather than once per saved
   * document, and again when the template changes (other settings or
   * mappings). parsedmarc keeps one set of names per process and clears it
   * in set_hosts(); a client from setHosts() or createClient() starts
   * empty here. Forgetting an entry is always safe: it only repeats
   * idempotent calls.
   */
  readonly ready: Map<string, string>;
  /** Set-ups in progress, so concurrent saves to a new stream share one. */
  readonly pending: Map<string, Promise<void>>;
}

const dataStreamStates = new WeakMap<Client, DataStreamState>();

// Guard query for the dkim_results_combined/spf_results_combined backfill
// (see migrateIndexes()). Matches only documents that have at least one DKIM
// or SPF auth result and are missing the corresponding combined field. Empty
// arrays are invisible to `exists`, so documents with zero DKIM/SPF results
// are skipped, and the query is idempotent: a backfilled document no longer
// matches. Each result is matched on an OR of its `domain`/`result`
// subfields as defense in depth (an empty string indexes no tokens and is
// invisible to `exists`).
const COMBINED_BACKFILL_QUERY: Query = {
  bool: {
    minimum_should_match: 1,
    should: [
      {
        bool: {
          must: [
            {
              bool: {
                minimum_should_match: 1,
                should: [
                  { exists: { field: 'dkim_results.domain' } },
                  { exists: { field: 'dkim_results.result' } },
                ],
              },
            },
          ],
          must_not: [{ exists: { field: 'dkim_results_combined' } }],
        },
      },
      {
        bool: {
          must: [
            {
              bool: {
                minimum_should_match: 1,
                should: [
                  { exists: { field: 'spf_results.domain' } },
                  { exists: { field: 'spf_results.result' } },
                ],
              },
            },
          ],
          must_not: [{ exists: { field: 'spf_results_combined' } }],
        },
      },
    ],
  },
};

// Painless script that (re)derives dkim_results_combined/spf_results_combined
// from dkim_results/spf_results, in the format saveAggregateReportToOpenSearch()
// writes: "{selector} / {domain} / {result}" per DKIM result and
// "{scope} / {domain} / {result}" per SPF result.
const COMBINED_BACKFILL_SCRIPT = [
  'List dk = new ArrayList(); ',
  'def dr = ctx._source.dkim_results; ',
  'if (dr != null) { ',
  'if (!(dr instanceof List)) { dr = [dr]; } ',
  'for (e in dr) { ',
  'if (e == null) { continue; } ',
  'def sel = e.selector != null ? e.selector : "none"; ',
  'def dom = e.domain != null ? e.domain : "none"; ',
  'def res = e.result != null ? e.result : "none"; ',
  'dk.add(sel + " / " + dom + " / " + res); ',
  '} } ',
  'ctx._source.dkim_results_combined = dk; ',
  'List sp = new ArrayList(); ',
  'def sr = ctx._source.spf_results; ',
  'if (sr != null) { ',
  'if (!(sr instanceof List)) { sr = [sr]; } ',
  'for (e in sr) { ',
  'if (e == null) { continue; } ',
  'def sc = e.scope != null ? e.scope : "mfrom"; ',
  'def dom = e.domain != null ? e.domain : "none"; ',
  'def res = e.result != null ? e.result : (e.results != null ? e.results : "none"); ',
  'sp.add(sc + " / " + dom + " / " + res); ',
  '} } ',
  'ctx._source.spf_results_combined = sp;',
].join('');

// Guard query for the policies_combined/failure_details_combined backfill
// (see migrateIndexes()), on the same principles as COMBINED_BACKFILL_QUERY.
const SMTP_TLS_COMBINED_BACKFILL_QUERY: Query = {
  bool: {
    minimum_should_match: 1,
    should: [
      {
        bool: {
          must: [
            {
              bool: {
                minimum_should_match: 1,
                should: [
                  { exists: { field: 'policies.policy_domain' } },
                  { exists: { field: 'policies.policy_type' } },
                ],
              },
            },
          ],
          must_not: [{ exists: { field: 'policies_combined' } }],
        },
      },
      {
        bool: {
          must: [
            {
              bool: {
                minimum_should_match: 1,
                should: [
                  {
                    exists: { field: 'policies.failure_details.result_type' },
                  },
                  {
                    exists: {
                      field: 'policies.failure_details.sending_mta_ip',
                    },
                  },
                ],
              },
            },
          ],
          must_not: [{ exists: { field: 'failure_details_combined' } }],
        },
      },
    ],
  },
};

// Painless script that (re)derives policies_combined/failure_details_combined
// from policies/policies.failure_details, in the format
// saveSmtpTlsReportToOpenSearch() writes.
const SMTP_TLS_COMBINED_BACKFILL_SCRIPT = [
  'List pols = new ArrayList(); ',
  'List dets = new ArrayList(); ',
  'def ps = ctx._source.policies; ',
  'if (ps != null) { ',
  'if (!(ps instanceof List)) { ps = [ps]; } ',
  'for (p in ps) { ',
  'if (p == null) { continue; } ',
  'def dom = p.policy_domain != null ? p.policy_domain : "none"; ',
  'def typ = p.policy_type != null ? p.policy_type : "none"; ',
  'pols.add(dom + " / " + typ); ',
  'def fds = p.failure_details; ',
  'if (fds != null) { ',
  'if (!(fds instanceof List)) { fds = [fds]; } ',
  'for (f in fds) { ',
  'if (f == null) { continue; } ',
  'def rt = f.result_type != null ? f.result_type : "none"; ',
  'def smi = f.sending_mta_ip != null ? f.sending_mta_ip : "none"; ',
  'def ri = f.receiving_ip != null ? f.receiving_ip : "none"; ',
  'def rmh = f.receiving_mx_hostname != null ? f.receiving_mx_hostname : "none"; ',
  'dets.add(dom + " / " + typ + " / " + rt + " / " + smi + " / " + ri + " / " + rmh); ',
  '} } } } ',
  'ctx._source.policies_combined = pols; ',
  'ctx._source.failure_details_combined = dets;',
].join('');

/** The backfill queries and scripts migrateIndexes() submits. */
export const BACKFILL: {
  readonly aggregateQuery: Query;
  readonly aggregateScript: string;
  readonly smtpTlsQuery: Query;
  readonly smtpTlsScript: string;
} = {
  aggregateQuery: COMBINED_BACKFILL_QUERY,
  aggregateScript: COMBINED_BACKFILL_SCRIPT,
  smtpTlsQuery: SMTP_TLS_COMBINED_BACKFILL_QUERY,
  smtpTlsScript: SMTP_TLS_COMBINED_BACKFILL_SCRIPT,
};

export interface SetHostsOptions {
  /** Use an HTTPS connection to the server. */
  useSsl?: boolean | null;
  /** Path to the CA certificate chain (used when `useSsl` is set). */
  sslCertPath?: string | null;
  /** Skip certificate verification (used when `useSsl` is set). */
  skipCertificateVerification?: boolean;
  username?: string | null;
  password?: string | null;
  /**
   * The Base64-encoded API key. Accepted as parsedmarc accepts it, but
   * opensearch-py ignores a client-level `api_key`, so parsedmarc never
   * sends it; neither does tsdmarc.
   */
  apiKey?: string | null;
  /**
   * Request timeout in seconds (default 60). `null` means no timeout; 0 or
   * less raises `ValueError`, like opensearch-py.
   */
  timeout?: number | null;
  /** `basic` (default) or `awssigv4`. */
  authType?: string;
  /** AWS region for SigV4 auth (required for `awssigv4`). */
  awsRegion?: string | null;
  /** AWS service for SigV4 signing (default `es`; `aoss` for Serverless). */
  awsService?: string;
}

const NETLOC_END = /[/?#]/u;
const TRAILING_PORT = /:(\d+)$/u;

/**
 * opensearch-py's host normalization: a host without a scheme is read as
 * `//host`; `https://` hosts default to port 443 and TLS, others to port
 * 9200; the client-level `use_ssl` turns on TLS for every host.
 */
function nodeUrl(host: string, useSsl: boolean): string {
  const withScheme = host.includes('://') ? host : `//${host}`;
  const parsed = new URL(withScheme, 'http://placeholder');
  const schemeIsHttps = withScheme.toLowerCase().startsWith('https://');
  const netloc = withScheme.split('//', 2)[1]?.split(NETLOC_END, 1)[0] ?? '';
  const hostPort = netloc.slice(netloc.lastIndexOf('@') + 1);
  const portPart = hostPort.startsWith('[')
    ? hostPort.slice(hostPort.indexOf(']') + 1)
    : hostPort;
  const explicitPort = TRAILING_PORT.exec(portPart)?.[1];
  const port =
    explicitPort ?? String(schemeIsHttps ? HTTPS_PORT : DEFAULT_PORT);
  const scheme = schemeIsHttps || useSsl ? 'https' : 'http';
  const userinfo =
    parsed.username || parsed.password
      ? `${parsed.username}:${parsed.password}@`
      : '';
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${scheme}://${userinfo}${parsed.hostname}:${port}${path}`;
}

/**
 * urllib3's timeout rules, as opensearch-py applies them: `None` means no
 * timeout (0 for opensearch-js), and a value that is not positive raises.
 */
function requestTimeoutMs(timeout: number | null): number {
  if (timeout === null) {
    return 0;
  }
  if (!(timeout > 0)) {
    throw new ValueError(
      `Attempted to set connect timeout to ${timeout}, but the timeout cannot be set to a value less than or equal to 0.`,
    );
  }
  return timeout * MS_PER_SECOND;
}

async function sigV4Options(
  awsRegion: string | null,
  awsService: string,
): Promise<Partial<ClientOptions>> {
  if (!awsRegion) {
    throw new OpenSearchError(
      "OpenSearch AWS SigV4 auth requires 'aws_region' to be set",
    );
  }
  // Loaded only for SigV4, so basic-auth users never load the AWS SDK.
  const [{ fromNodeProviderChain }, { AwsSigv4Signer }] = await Promise.all([
    import('@aws-sdk/credential-providers'),
    import('@opensearch-project/opensearch/aws'),
  ]);
  const getCredentials = fromNodeProviderChain();
  try {
    // Fail now, like boto3's get_credentials() returning None, rather than
    // with an opaque authentication error on the first request.
    await getCredentials();
  } catch {
    throw new OpenSearchError(
      'Unable to load AWS credentials for OpenSearch SigV4 authentication',
    );
  }
  // The signer's types only list 'es' and 'aoss'; parsedmarc passes the
  // configured service through as is.
  return AwsSigv4Signer({
    region: awsRegion,
    service: awsService as 'es',
    getCredentials,
  });
}

/**
 * Creates an OpenSearch client the way {@link setHosts} does, without
 * registering it as the default connection. Pass it as `client` to the save
 * functions, createIndexes() and migrateIndexes() to write to several
 * clusters from one process. Close it with `client.close()`.
 */
export async function createClient(
  hosts: string | string[],
  options: SetHostsOptions = {},
): Promise<Client> {
  const {
    useSsl = false,
    sslCertPath = null,
    skipCertificateVerification = false,
    username = null,
    password = null,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    authType = 'basic',
    awsRegion = null,
    awsService = 'es',
  } = options;
  const hostList = Array.isArray(hosts) ? hosts : [hosts];
  logger.debug(
    `Connecting to OpenSearch: hosts=${pyRepr(redactUrlCredentials(hostList))}, use_ssl=${pyRepr(useSsl)}`,
  );
  const clientOptions: ClientOptions = {
    nodes: hostList.map(host => nodeUrl(host, Boolean(useSsl))),
    // As Python's JSON parser: integers beyond 2^53 stay exact (the legacy
    // migration writes back the documents it reads), and `__proto__` is just
    // a key: a stored failure sample can hold it as a header name, and the
    // duplicate search reads that document back. Responses are never merged
    // into other objects.
    enableLongNumeralSupport: true,
    disablePrototypePoisoningProtection: true,
  };
  if (useSsl) {
    clientOptions.ssl = {
      rejectUnauthorized: !skipCertificateVerification,
      ...(sslCertPath ? { ca: await readFile(sslCertPath) } : {}),
    };
  }
  const normalizedAuthType = (authType || 'basic').trim().toLowerCase();
  if (normalizedAuthType === 'awssigv4') {
    Object.assign(clientOptions, await sigV4Options(awsRegion, awsService));
  } else if (normalizedAuthType === 'basic') {
    if (username && password) {
      clientOptions.auth = { username, password };
    }
  } else {
    throw new OpenSearchError(
      `Unsupported OpenSearch auth_type '${authType}'. ` +
        "Expected 'basic' or 'awssigv4'.",
    );
  }
  // After the auth checks, where opensearch-py's constructor would raise.
  clientOptions.requestTimeout = requestTimeoutMs(timeout);
  clientOptions.Transport = withPythonRetries(
    clientOptions.Transport ?? Transport,
  );
  return new Client(clientOptions);
}

/**
 * Sets the OpenSearch hosts to use, and registers the client as the
 * default connection the other functions use.
 *
 * A client registered by an earlier call is replaced but not closed, as in
 * parsedmarc (the DSL's connection registry only drops it): its owner may
 * still be using it or put it back (the CLI's configuration reload). Close
 * clients you no longer need with `client.close()`; on shutdown,
 * `await getDefaultConnection()?.close()` then `setDefaultConnection(null)`.
 *
 * @returns The registered client. Callers that need to close this exact
 * client later should hold on to it.
 */
export async function setHosts(
  hosts: string | string[],
  options: SetHostsOptions = {},
): Promise<Client> {
  defaultConnection = await createClient(hosts, options);
  return defaultConnection;
}

/**
 * The client registered as the `default` connection, or `null`. With
 * {@link setDefaultConnection}, lets a caller snapshot and restore the
 * module state setHosts() writes (the CLI's configuration reload).
 */
export function getDefaultConnection(): Client | null {
  return defaultConnection;
}

/** Register `client` as the `default` connection (`null` removes it). */
export function setDefaultConnection(client: Client | null): void {
  defaultConnection = client;
}

/** Selects the cluster a function writes to. */
export interface ConnectionOptions {
  /**
   * The client to use instead of the default connection setHosts()
   * registers, such as one from {@link createClient}. The default connection
   * is module state, shared by every caller in the process: an application
   * that writes to several clusters at once passes the client of each.
   */
  client?: Client | null;
}

/**
 * `client`, or the client registered by setHosts() (DSL
 * `connections.get_connection()`).
 */
function getConnection(client?: Client | null): Client {
  if (client) {
    return client;
  }
  if (defaultConnection === null) {
    throw new KeyError("There is no connection with alias 'default'.");
  }
  return defaultConnection;
}

async function indexExists(client: Client, name: string): Promise<boolean> {
  return (await client.indices.exists({ index: name })).body;
}

/** `Index(name).settings(...).create()`: the body is `{}` without settings. */
async function createIndex(
  client: Client,
  name: string,
  settings: Record<string, unknown> = {},
  mappings: IndexMapping | null = null,
): Promise<void> {
  await client.indices.create({
    index: name,
    body: {
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(mappings ? { mappings: mappings as CreateIndexMappings } : {}),
    },
  });
}

/**
 * Whether `error` is the cluster refusing to create an index that another
 * writer created after the exists check (concurrent saves to a new index).
 */
function isIndexAlreadyCreated(error: unknown): boolean {
  if (!(error instanceof errors.ResponseError)) {
    return false;
  }
  const body = error.meta.body as { error?: { type?: unknown } } | undefined;
  return body?.error?.type === 'resource_already_exists_exception';
}

/**
 * Create OpenSearch indexes that don't exist yet.
 *
 * @param settings Index settings (default: 1 shard, 0 replicas).
 * @param mappings Mappings for new indexes (default: none, as in parsedmarc).
 * @param options The cluster to use (default: the default connection).
 */
export async function createIndexes(
  names: string[],
  settings: Record<string, unknown> | null = null,
  mappings: IndexMapping | null = null,
  options: ConnectionOptions = {},
): Promise<void> {
  for (const name of names) {
    try {
      // Deliberately no `nested` mappings: the shipped dashboards cannot
      // rebuild their detail tables on them, so the dynamic `object` mapping
      // is load-bearing (parsedmarc issue #169; see the *_combined fields).
      const client = getConnection(options.client);
      if (!(await indexExists(client, name))) {
        logger.debug(`Creating OpenSearch index: ${name}`);
        try {
          await createIndex(
            client,
            name,
            settings ?? { number_of_shards: 1, number_of_replicas: 0 },
            mappings,
          );
        } catch (error) {
          // parsedmarc saves one report at a time; concurrent saves race
          // between the exists check and the create, and the loser would
          // fail its report halfway through its records.
          if (!isIndexAlreadyCreated(error)) {
            throw error;
          }
        }
      }
    } catch (error) {
      throw new OpenSearchError(`OpenSearch error: ${errorMessage(error)}`);
    }
  }
}

function dataStreamState(client: Client): DataStreamState {
  let state = dataStreamStates.get(client);
  if (state === undefined) {
    state = { ready: new Map(), pending: new Map() };
    dataStreamStates.set(client, state);
  }
  return state;
}

/**
 * Whether `error` is the cluster refusing to look up a data stream by the
 * name of an alias (`illegal_argument_exception`, HTTP 400). The index
 * exists check then reports the name as taken, with a clearer message than
 * this error.
 */
function isAliasName(error: unknown): boolean {
  if (!(error instanceof errors.ResponseError) || error.statusCode !== 400) {
    return false;
  }
  const body = error.meta.body as { error?: { type?: unknown } } | undefined;
  return body?.error?.type === 'illegal_argument_exception';
}

/** Whether `error` is an HTTP 404 (opensearch-py's `NotFoundError`). */
function isNotFound(error: unknown): boolean {
  return error instanceof errors.ResponseError && error.statusCode === 404;
}

/**
 * Whether a data stream holds `name`. OpenSearch 3 answers both a missing
 * name and a name held by a concrete index with a 404. Elasticsearch answers
 * the latter with 200 and an empty list, so, as in the Elasticsearch
 * package, look for the stream in the response rather than trust the status
 * alone.
 */
async function dataStreamExists(
  client: Client,
  name: string,
): Promise<boolean> {
  try {
    const response = await client.indices.getDataStream({ name });
    const streams = (response.body as { data_streams?: { name?: unknown }[] })
      .data_streams;
    return (streams ?? []).some(stream => stream.name === name);
  } catch (error) {
    if (isNotFound(error) || isAliasName(error)) {
      return false;
    }
    throw error;
  }
}

async function setUpDataStream(
  client: Client,
  name: string,
  body: PutIndexTemplateBody,
): Promise<void> {
  let collision = false;
  try {
    let streamExists = await dataStreamExists(client, name);
    // Checked before anything is written, so a name collision leaves no
    // template behind.
    if (!streamExists && (await indexExists(client, name))) {
      // Another writer may have created the stream between the two checks.
      streamExists = await dataStreamExists(client, name);
      collision = !streamExists;
    }
    if (!collision) {
      await client.indices.putIndexTemplate({ name, body });
      if (!streamExists) {
        logger.debug(`Creating OpenSearch data stream: ${name}`);
        try {
          await client.indices.createDataStream({ name });
        } catch (error) {
          // Concurrent saves race between the check and the create.
          if (!isIndexAlreadyCreated(error)) {
            throw error;
          }
        }
      }
    }
  } catch (error) {
    throw new OpenSearchError(`OpenSearch error: ${errorMessage(error)}`);
  }
  if (collision) {
    throw new OpenSearchError(
      `OpenSearch error: cannot create the data stream ${name}: ` +
        'an index or alias with that name already exists',
    );
  }
}

/**
 * Create OpenSearch data streams and their index templates.
 *
 * For each name, puts an index template named after the stream whose
 * `index_patterns` is exactly that name (no wildcard, so it never applies to
 * the date-suffixed indexes written without data streams), and then creates
 * the data stream if it does not exist yet. The template is put again by
 * every process that writes to the stream, so edits made to it directly do
 * not last; an ISM policy attaches itself to the stream's backing indices
 * through its own `ism_template` instead. Each name is set up once per
 * client and template.
 *
 * @param settings Index settings for the stream's backing indices (default:
 * 1 shard, 0 replicas, as in {@link createIndexes}).
 * @param mappings Mappings for the backing indices, plus `@timestamp` as a
 * date (default: only `@timestamp`, as in parsedmarc). The save functions
 * pass the mappings they create dated indexes with.
 * @param options The cluster to use (default: the default connection).
 * @throws {OpenSearchError} when a concrete index or alias already holds one
 * of the names, or the cluster returns an error. A name that fails is not
 * remembered, so the next save retries it.
 */
export async function createDataStreams(
  names: string[],
  settings: Record<string, unknown> | null = null,
  mappings: IndexMapping | null = null,
  options: ConnectionOptions = {},
): Promise<void> {
  const effectiveSettings = settings
    ? { ...settings }
    : { number_of_shards: 1, number_of_replicas: 0 };

  for (const name of names) {
    let client: Client;
    try {
      client = getConnection(options.client);
    } catch (error) {
      throw new OpenSearchError(`OpenSearch error: ${errorMessage(error)}`);
    }
    const body = {
      index_patterns: [name],
      data_stream: {},
      priority: DATA_STREAM_TEMPLATE_PRIORITY,
      template: {
        settings: effectiveSettings,
        mappings: dataStreamMapping(mappings),
      },
      _meta: {
        description:
          'Managed by tsdmarc, which overwrites it. ' +
          'Attach ISM policies with an ism_template.',
      },
    } as PutIndexTemplateBody;
    const key = JSON.stringify({ name, body });
    const state = dataStreamState(client);
    if (state.ready.get(name) === key) {
      continue;
    }
    let pending = state.pending.get(key);
    if (pending === undefined) {
      pending = setUpDataStream(client, name, body).finally(() => {
        state.pending.delete(key);
      });
      state.pending.set(key, pending);
    }
    await pending;
    state.ready.set(name, key);
  }
}

const LEGACY_FO_FIELD = 'published_policy.fo';
// The same field split into the object/leaf names a mapping body nests it
// under, so the mapping written below cannot drift from the field read.
const [LEGACY_FO_OBJECT = '', LEGACY_FO_LEAF = ''] = LEGACY_FO_FIELD.split('.');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The mapped type of `published_policy.fo` in an index, or `null` when the
 * index does not map it. Reads both the typeless response (OpenSearch has
 * no mapping types) and the Elasticsearch 6-era shape keyed by type (`doc`).
 */
async function legacyFoFieldType(
  client: Client,
  index: string,
): Promise<string | null> {
  const response = (
    await client.indices.getFieldMapping({ index, fields: [LEGACY_FO_FIELD] })
  ).body as Record<string, { mappings: Record<string, unknown> }>;
  const [firstIndex = ''] = Object.keys(response);
  let mappings: Record<string, unknown> = response[firstIndex]?.mappings ?? {};
  if (!(LEGACY_FO_FIELD in mappings)) {
    for (const typeName of ['doc', '_doc']) {
      const typed = mappings[typeName];
      if (isRecord(typed)) {
        mappings = typed;
        break;
      }
    }
  }
  const fieldMapping = mappings[LEGACY_FO_FIELD];
  if (!isRecord(fieldMapping) || Object.keys(fieldMapping).length === 0) {
    return null;
  }
  const mapping = isRecord(fieldMapping.mapping) ? fieldMapping.mapping : {};
  const leaf = isRecord(mapping[LEGACY_FO_LEAF]) ? mapping[LEGACY_FO_LEAF] : {};
  return typeof leaf.type === 'string' ? leaf.type : null;
}

export interface MigrateIndexesOptions extends ConnectionOptions {
  /** Aggregate index names (backfilled as the `name*` pattern). */
  aggregateIndexes?: string[] | null;
  /** Failure index names (accepted for API compatibility; unused). */
  failureIndexes?: string[] | null;
  /** SMTP TLS index names (backfilled as the `name*` pattern). */
  smtpTlsIndexes?: string[] | null;
  /**
   * Exact index names to check for the pre-5.0.0 `published_policy.fo`
   * `long` mapping, as the caller's prefix/suffix configuration names them.
   */
  legacyFoIndexes?: string[] | null;
}

async function migrateLegacyFoIndex(
  client: Client,
  legacyIndexName: string,
  version: number,
): Promise<void> {
  if (!(await indexExists(client, legacyIndexName))) {
    return;
  }
  if ((await legacyFoFieldType(client, legacyIndexName)) !== 'long') {
    return;
  }
  const newIndexName = `${legacyIndexName}-v${version}`;
  // Nested object form rather than a dotted key: dot expansion depends on
  // the object field's `subobjects` setting, and this shape never does.
  const body = {
    properties: {
      [LEGACY_FO_OBJECT]: {
        properties: {
          [LEGACY_FO_LEAF]: {
            type: 'text',
            fields: { keyword: { type: 'keyword', ignore_above: 256 } },
          },
        },
      },
    },
  };
  logger.info(
    `Migrating ${legacyIndexName} to ${newIndexName}: ` +
      `${LEGACY_FO_FIELD} is mapped as long, as parsedmarc ` +
      'releases before 5.0.0 declared it',
  );
  // The original is deleted only after the reindex succeeds, so a leftover
  // target index is debris of an interrupted attempt; keeping it would fail
  // every later attempt with "resource already exists".
  if (await indexExists(client, newIndexName)) {
    logger.warning(
      `Discarding ${newIndexName} left behind by an earlier ` +
        `interrupted migration of ${legacyIndexName}`,
    );
    await client.indices.delete({ index: newIndexName });
  }
  await createIndex(client, newIndexName);
  await client.indices.putMapping({
    index: newIndexName,
    body: body as PutMappingBody,
  });
  await reindex(client, legacyIndexName, newIndexName);
  await verifyCopy(client, legacyIndexName, newIndexName);
  await client.indices.delete({ index: legacyIndexName });
}

/** Documents in `index`, failing if some shard did not answer. */
async function countDocuments(client: Client, index: string): Promise<number> {
  const { body: response } = await client.count({ index });
  if ((response._shards?.failed ?? 0) > 0) {
    throw new OpenSearchError(`Could not count the documents of ${index}`);
  }
  return response.count;
}

/** The original is about to be deleted: the copy must be complete. */
async function verifyCopy(
  client: Client,
  sourceIndex: string,
  targetIndex: string,
): Promise<void> {
  await client.indices.refresh({ index: targetIndex });
  const sourceCount = await countDocuments(client, sourceIndex);
  const targetCount = await countDocuments(client, targetIndex);
  if (targetCount !== sourceCount) {
    throw new OpenSearchError(
      `${targetIndex} holds ${targetCount} documents, ` +
        `${sourceIndex} holds ${sourceCount}`,
    );
  }
}

interface BackfillTarget {
  readonly names: readonly string[];
  readonly query: Query;
  readonly script: string;
  readonly fields: string;
}

async function submitBackfills(
  client: Client,
  target: BackfillTarget,
): Promise<void> {
  for (const name of target.names) {
    const pattern = `${name}*`;
    try {
      const countResponse = await client.count({
        index: pattern,
        body: { query: target.query },
        ignore_unavailable: true,
        allow_no_indices: true,
      });
      const { count } = countResponse.body as { count?: number };
      if (!count) {
        continue;
      }
      const updateResponse = await client.updateByQuery({
        index: pattern,
        body: {
          query: target.query,
          script: { source: target.script, lang: 'painless' },
        },
        conflicts: 'proceed',
        wait_for_completion: false,
        ignore_unavailable: true,
        allow_no_indices: true,
      });
      const taskId =
        (updateResponse.body as { task?: string } | undefined)?.task ?? null;
      logger.info(
        `Backfilling ${target.fields} on ` +
          `${count} existing documents in ${pattern} (task ${pyStr(taskId)})`,
      );
    } catch (error) {
      logger.warning(
        `Failed to check/submit the ${target.fields} backfill for ` +
          `${pattern}: ${errorMessage(error)}. This ` +
          'will be retried at the next startup; the manual ' +
          '_update_by_query command in the documentation remains ' +
          'available in the meantime.',
      );
    }
  }
}

/**
 * Runs index migrations and backfills.
 *
 * First, the legacy `published_policy.fo` migration for each name in
 * `legacyFoIndexes`: an index that maps the field as `long` (parsedmarc
 * before 5.0.0) is rebuilt as a `-v2` index with the text/keyword shape, its
 * documents are reindexed into it, and the original is deleted.
 *
 * Second, it backfills `dkim_results_combined`/`spf_results_combined` on
 * aggregate documents and `policies_combined`/`failure_details_combined` on
 * SMTP TLS documents saved before those fields existed, as non-blocking
 * `update_by_query` tasks against each `name*` pattern, guarded by a cheap
 * `count`. Errors are logged as warnings, never thrown: the work is retried
 * at the next startup.
 */
export async function migrateIndexes(
  options: MigrateIndexesOptions = {},
): Promise<void> {
  const { aggregateIndexes, smtpTlsIndexes, legacyFoIndexes } = options;
  const hasAggregate = Boolean(aggregateIndexes?.length);
  const hasSmtpTls = Boolean(smtpTlsIndexes?.length);
  if (!hasAggregate && !hasSmtpTls && !legacyFoIndexes?.length) {
    return;
  }

  const version = 2;
  for (const legacyIndexName of legacyFoIndexes ?? []) {
    try {
      await migrateLegacyFoIndex(
        getConnection(options.client),
        legacyIndexName,
        version,
      );
    } catch (error) {
      logger.warning(
        'Failed the legacy published_policy.fo migration for ' +
          `${legacyIndexName}: ${errorMessage(error)}. This will be retried at the ` +
          'next startup.',
      );
    }
  }

  if (!hasAggregate && !hasSmtpTls) {
    return;
  }

  let client: Client;
  try {
    client = getConnection(options.client);
  } catch (error) {
    logger.warning(
      'Skipping the dkim_results_combined/spf_results_combined/' +
        'policies_combined/failure_details_combined backfill: could ' +
        `not get an OpenSearch connection: ${errorMessage(error)}. This will be retried ` +
        'at the next startup.',
    );
    return;
  }
  await submitBackfills(client, {
    names: aggregateIndexes ?? [],
    query: COMBINED_BACKFILL_QUERY,
    script: COMBINED_BACKFILL_SCRIPT,
    fields: 'dkim_results_combined/spf_results_combined',
  });
  await submitBackfills(client, {
    names: smtpTlsIndexes ?? [],
    query: SMTP_TLS_COMBINED_BACKFILL_QUERY,
    script: SMTP_TLS_COMBINED_BACKFILL_SCRIPT,
    fields: 'policies_combined/failure_details_combined',
  });
}

export interface SaveOptions extends ConnectionOptions {
  /** The suffix of the name of the index to save to. */
  indexSuffix?: string | null;
  /** The prefix of the name of the index to save to. */
  indexPrefix?: string | null;
  /**
   * Use monthly indexes instead of daily indexes (ignored when
   * `useDataStreams` is set).
   */
  monthlyIndexes?: boolean | null;
  /** The number of shards to use in the index (default 1). */
  numberOfShards?: number;
  /** The number of replicas to use in the index (default 0). */
  numberOfReplicas?: number;
  /**
   * Most indexes one aggregate report may spread over (default 31, 0 = no
   * limit). The sender picks the dates, and each new index takes a shard from
   * the cluster's limit; the records past this go to the report's first
   * index, with their dates intact.
   */
  maxIndexesPerReport?: number;
  /**
   * Save to a data stream named like the index, without the date suffix,
   * instead of to a dated index (see {@link createDataStreams}).
   */
  useDataStreams?: boolean;
}

/** `Search(index=...).query(...).execute()`: the number of hits. */
async function countExisting(
  options: ConnectionOptions,
  index: string,
  query: Query,
): Promise<number> {
  return (await searchExisting(options, index, query)).length;
}

/** The `_source` of the hits of `Search(index=...).query(...).execute()`. */
async function searchExisting(
  options: ConnectionOptions,
  index: string,
  query: Query,
): Promise<unknown[]> {
  const response = await getConnection(options.client).search({
    index,
    // The undated name in the list is missing until a data stream holds it.
    ignore_unavailable: true,
    body: { query },
  });
  return (response.body.hits.hits as { _source?: unknown }[]).map(
    hit => hit._source,
  );
}

/** The `_source` of up to `size` documents a duplicate search matches. */
async function storedSources(
  options: ConnectionOptions,
  index: string,
  query: Query,
  size: number,
): Promise<unknown[]> {
  const response = await getConnection(options.client).search({
    index,
    ignore_unavailable: true,
    body: { query, size, _source: [...AGGREGATE_RECORD_FIELDS] },
  });
  return (response.body.hits.hits as { _source?: unknown }[]).map(
    hit => hit._source,
  );
}

/** `Document.save()`: clean, serialize and index the document. */
async function saveDocument(
  options: ConnectionOptions,
  schema: DocumentSchema,
  index: string,
  doc: Record<string, unknown>,
): Promise<void> {
  // The client serializes with JSON.stringify(), which throws on bigints;
  // Python sends counts beyond 2^53 as exact JSON integers.
  const body = rawJsonIntegers(serializeDocument(schema, doc)) as Record<
    string,
    unknown
  >;
  // Data streams accept only op_type=create. No _id is set, so for a dated
  // index it means the same as the default.
  await getConnection(options.client).index({
    index,
    body,
    op_type: 'create',
  });
}

/** The index name without its date: also the name of the data stream. */
function undatedIndexName(base: string, options: SaveOptions): string {
  let index = base;
  if (options.indexSuffix) {
    index = `${index}_${options.indexSuffix}`;
  }
  if (options.indexPrefix) {
    index = `${options.indexPrefix}${index}`;
  }
  return index;
}

/**
 * The indexes a duplicate search covers: the dated indexes of this prefix
 * and suffix, and the data stream (or a pre-5.0.0 undated index) of the
 * same name, so duplicates are caught across a switch between the two. The
 * `-` before the date stops the wildcard at the suffix, so `prod` does not
 * reach `production` and no suffix does not reach every suffix.
 */
function searchPattern(base: string, options: SaveOptions): string {
  const name = undatedIndexName(base, options);
  return `${name}-*,${name}`;
}

function indexSettings(options: SaveOptions): Record<string, unknown> {
  return {
    number_of_shards: options.numberOfShards ?? 1,
    number_of_replicas: options.numberOfReplicas ?? 0,
  };
}

function indexDate(date: PyDateTime, monthly: boolean | null | undefined) {
  return date.strftime(monthly ? '%Y-%m' : '%Y-%m-%d');
}

function isAligned(result: string | null | undefined): boolean {
  return (
    result !== null && result !== undefined && result.toLowerCase() === 'pass'
  );
}

/** The indexes of one report, at most `maxIndexesPerReport` of them. */
class ReportIndexes {
  readonly #limit: number;
  readonly #names = new Set<string>();
  #warned = false;

  constructor(options: SaveOptions) {
    this.#limit = options.maxIndexesPerReport ?? DEFAULT_MAX_INDEXES_PER_REPORT;
  }

  /** `name`, or the report's first index once the limit is reached. */
  pick(name: string): string {
    if (
      this.#limit === 0 ||
      this.#names.has(name) ||
      this.#names.size < this.#limit
    ) {
      this.#names.add(name);
      return name;
    }
    const [first = name] = this.#names;
    if (!this.#warned) {
      this.#warned = true;
      logger.warning(
        `An aggregate report spans more than ${this.#limit} indexes; ` +
          `saving the remaining records to ${first}`,
      );
    }
    return first;
  }
}

// parsedmarc's records carry `normalized_timespan`; the core type may not
// declare it yet.
type RecordWithTimespan = AggregateRecord & { normalizedTimespan?: boolean };

/**
 * Saves a parsed DMARC aggregate report to OpenSearch, one document per
 * record.
 *
 * @throws {AlreadySaved} when the report is already in OpenSearch.
 * @throws {OpenSearchError} when OpenSearch fails or rejects the document.
 */
export async function saveAggregateReportToOpenSearch(
  aggregateReport: AggregateReport,
  options: SaveOptions = {},
): Promise<void> {
  logger.info('Saving aggregate report to OpenSearch');
  const metadata = aggregateReport.reportMetadata;
  const policy = aggregateReport.policyPublished;
  const { orgName, reportId } = metadata;
  const domain = textValue(policy.domain);
  const beginDate = humanTimestampToDatetime(metadata.beginDate, {
    toUtc: true,
  });
  const endDate = humanTimestampToDatetime(metadata.endDate, { toUtc: true });

  const searchIndex = searchPattern('dmarc_aggregate', options);
  const query = andQueries([
    { match_phrase: { org_name: orgName } },
    { match_phrase: { report_id: reportId } },
    { match_phrase: { 'published_policy.domain': domain } },
    { range: { date_begin: { gte: beginDate.isoformat() } } },
    { range: { date_end: { lte: endDate.isoformat() } } },
  ]);
  const beginDateHuman = beginDate.strftime('%Y-%m-%d %H:%M:%SZ');
  const endDateHuman = endDate.strftime('%Y-%m-%d %H:%M:%SZ');

  let existing: unknown[];
  try {
    existing = await searchExisting(options, searchIndex, query);
  } catch (error) {
    throw new OpenSearchError(
      `OpenSearch's search for existing report error: ${errorMessage(error)}`,
    );
  }
  const alreadySaved = (): AlreadySaved =>
    new AlreadySaved(
      `An aggregate report ID ${reportId} from ${orgName} about ${pyStr(domain)} ` +
        `with a date range of ${beginDateHuman} UTC to ${endDateHuman} UTC already ` +
        'exists in OpenSearch',
    );
  const records = aggregateReport.records as RecordWithTimespan[];
  const recordDocument = (
    record: RecordWithTimespan,
    policyDocument: Record<string, unknown> | null,
  ): { aggDoc: Record<string, unknown>; recordBegin: PyDateTime } => {
    const recordBegin = humanTimestampToDatetime(record.intervalBegin, {
      toUtc: true,
      assumeUtc: true,
    });
    const recordEnd = humanTimestampToDatetime(record.intervalEnd, {
      toUtc: true,
      assumeUtc: true,
    });
    const { source, policyEvaluated, identifiers } = record;
    const aggDoc: Record<string, unknown> = {
      xml_schema: aggregateReport.xmlSchema,
      xml_namespace: aggregateReport.xmlNamespace ?? null,
      org_name: metadata.orgName,
      org_email: metadata.orgEmail,
      org_extra_contact_info: metadata.orgExtraContactInfo,
      report_id: metadata.reportId,
      date_range: [recordBegin, recordEnd],
      date_begin: recordBegin,
      date_end: recordEnd,
      normalized_timespan: record.normalizedTimespan ?? null,
      errors: metadata.errors,
      published_policy: policyDocument,
      source_ip_address: source.ipAddress,
      source_country: source.country,
      source_reverse_dns: source.reverseDns,
      source_base_domain: source.baseDomain,
      source_type: source.type,
      source_name: source.name,
      source_asn: source.asn,
      source_as_name: source.asName,
      source_as_domain: source.asDomain,
      message_count: record.count,
      disposition: policyEvaluated.disposition,
      dkim_aligned: isAligned(policyEvaluated.dkim),
      spf_aligned: isAligned(policyEvaluated.spf),
      header_from: identifiers.headerFrom,
      envelope_from: identifiers.envelopeFrom,
      envelope_to: identifiers.envelopeTo,
      np: policy.np ?? null,
      testing: policy.testing ?? null,
      discovery_method: policy.discoveryMethod ?? null,
      generator: metadata.generator ?? null,
      [TIMESTAMP_FIELD]: recordBegin.isoformat(),
    };

    for (const override of policyEvaluated.policyOverrideReasons) {
      appendTo(aggDoc, 'policy_overrides', {
        type: override.type,
        comment: override.comment,
      });
    }
    for (const dkim of record.authResults.dkim) {
      appendTo(aggDoc, 'dkim_results', {
        domain: dkim.domain,
        selector: dkim.selector,
        result: dkim.result,
        human_result: dkim.humanResult ?? null,
      });
      appendTo(
        aggDoc,
        'dkim_results_combined',
        `${dkim.selector} / ${dkim.domain} / ${dkim.result}`,
      );
    }
    for (const spf of record.authResults.spf) {
      appendTo(aggDoc, 'spf_results', {
        domain: spf.domain,
        scope: spf.scope,
        result: spf.result,
        human_result: spf.humanResult ?? null,
      });
      appendTo(
        aggDoc,
        'spf_results_combined',
        `${spf.scope} / ${spf.domain} / ${spf.result}`,
      );
    }
    return { aggDoc, recordBegin };
  };

  // Deviation: parsedmarc takes any document found as the whole report, so
  // a retry after a write failed halfway lost the remaining records. When
  // what was found is part of this report, only the rest is written.
  let storedRecords: ReadonlySet<number> = new Set();
  if (existing.length > 0) {
    // Only a report with more records than documents found can be partial.
    let documents: Record<string, unknown>[] | null = null;
    if (existing.length < records.length) {
      try {
        documents = records.map(record =>
          serializeDocument(
            AGGREGATE_REPORT_DOC,
            recordDocument(record, null).aggDoc,
          ),
        );
      } catch {
        // Its write would fail as well: counted as saved, as before.
        documents = null;
      }
    }
    let stored: ReadonlySet<number> | null;
    try {
      stored = await findStoredRecords(documents, existing, async size =>
        storedSources(options, searchIndex, query, size),
      );
    } catch (error) {
      throw new OpenSearchError(
        `OpenSearch's search for existing report error: ${errorMessage(error)}`,
      );
    }
    if (stored === null) {
      throw alreadySaved();
    }
    storedRecords = stored;
    logger.warning(
      `Resuming aggregate report ID ${sanitizeForLog(pyStr(reportId))} from ` +
        `${sanitizeForLog(pyStr(orgName))}: ${stored.size} of ${records.length} ` +
        'records are already in OpenSearch',
    );
  }
  const publishedPolicy = {
    domain: policy.domain,
    adkim: policy.adkim,
    aspf: policy.aspf,
    p: policy.p,
    sp: policy.sp,
    pct: integerOrNull(policy.pct, 'pct'),
    fo: policy.fo,
    np: policy.np ?? null,
    testing: policy.testing ?? null,
    discovery_method: policy.discoveryMethod ?? null,
  };

  const indexes = new ReportIndexes(options);
  for (const [position, record] of records.entries()) {
    const { aggDoc, recordBegin } = recordDocument(record, publishedPolicy);
    let index = undatedIndexName('dmarc_aggregate', options);
    if (!options.useDataStreams) {
      // Picked for stored records too, so the others keep their index.
      index = indexes.pick(
        `${index}-${indexDate(recordBegin, options.monthlyIndexes)}`,
      );
    }
    if (storedRecords.has(position)) {
      continue;
    }
    if (options.useDataStreams) {
      await createDataStreams(
        [index],
        indexSettings(options),
        INDEX_MAPPINGS.aggregate,
        options,
      );
    } else {
      await createIndexes(
        [index],
        indexSettings(options),
        INDEX_MAPPINGS.aggregate,
        options,
      );
    }

    try {
      // _AggregateReportDoc.save() derives passed_dmarc from the alignment.
      aggDoc.passed_dmarc = aggDoc.spf_aligned || aggDoc.dkim_aligned;
      await saveDocument(options, AGGREGATE_REPORT_DOC, index, aggDoc);
    } catch (error) {
      throw new OpenSearchError(`OpenSearch error: ${errorMessage(error)}`);
    }
  }
}

/**
 * Flatten a mailparser address header (`[[display_name, address], ...]`) to
 * one string from its first address: the bare address when the display
 * name is empty, otherwise `Name <address>`. `null` when there is no address
 * (`From:`, `To: undisclosed-recipients:;`), which parsedmarc fails on.
 */
function flattenAddressHeader(value: unknown): unknown {
  if (pyLength(value) === 0) {
    return null;
  }
  const first = pyIndex(value, 0);
  if (pyIndex(first, 0) === '') {
    return pyIndex(first, 1);
  }
  return `${pyJoin(' <', first)}>`;
}

function pyLength(value: unknown): number | null {
  return Array.isArray(value) || typeof value === 'string'
    ? value.length
    : null;
}

/** `value[index]` for the lists and strings header values can be. */
function pyIndex(value: unknown, index: number): unknown {
  if (Array.isArray(value) || typeof value === 'string') {
    if (index >= value.length) {
      throw new Error('list index out of range');
    }
    return value[index];
  }
  throw new TypeError(`'${typeof value}' object is not subscriptable`);
}

/** `separator.join(value)` for a list of strings or a string. */
function pyJoin(separator: string, value: unknown): string {
  if (typeof value === 'string') {
    return [...value].join(separator);
  }
  if (Array.isArray(value)) {
    return value.map(String).join(separator);
  }
  throw new TypeError('can only join an iterable');
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Saves a parsed DMARC failure report to OpenSearch.
 *
 * @throws {AlreadySaved} when the failure sample is already in OpenSearch.
 * @throws {OpenSearchError} when OpenSearch fails or rejects the document.
 * @throws {InvalidFailureReport} when the report lacks a required field.
 */
export async function saveFailureReportToOpenSearch(
  failureReport: FailureReport,
  options: SaveOptions = {},
): Promise<void> {
  logger.info('Saving failure report to OpenSearch');
  const parsedSample = getKey(failureReport, 'parsedSample');
  const sampleDateValue = getKey(parsedSample, 'date');
  let sampleDate: PyDateTime | null = null;
  if (sampleDateValue !== null && sampleDateValue !== undefined) {
    sampleDate = humanTimestampToDatetime(String(sampleDateValue));
  }
  const originalHeaders = asRecord(getKey(parsedSample, 'headers'));
  const headers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(originalHeaders)) {
    // The cluster reads a dot in a field name as a nested object, so that
    // `Subject.x` would make `sample.headers.subject` an object in the index.
    setOwn(headers, name.toLowerCase().replaceAll('.', '_'), value);
  }

  // arrival_date_utc is a UTC wall-clock string; without assumeUtc the
  // epoch below would be read as local time and skewed by the host's offset.
  const arrivalDateUtc = String(getKey(failureReport, 'arrivalDateUtc'));
  const arrivalDate = humanTimestampToDatetime(arrivalDateUtc, {
    assumeUtc: true,
  });
  const arrivalDateEpochMilliseconds = Math.trunc(
    arrivalDate.timestamp() * MS_PER_SECOND,
  );

  const searchIndex = [
    searchPattern('dmarc_failure', options),
    searchPattern('dmarc_forensic', options),
  ].join(',');
  const queries: Query[] = [
    { match: { arrival_date: arrivalDateEpochMilliseconds } },
  ];

  let from: Record<string, unknown> | null = null;
  let to: Record<string, unknown> | null = null;
  let subject: unknown = null;
  if (Object.hasOwn(headers, 'from')) {
    // Convert the From header from a list of [name, address] to a string.
    headers.from = flattenAddressHeader(headers.from);
    if (headers.from !== null) {
      from = { 'sample.headers.from': headers.from };
      queries.push({ match_phrase: from });
    }
  }
  if (Object.hasOwn(headers, 'to')) {
    headers.to = flattenAddressHeader(headers.to);
    if (headers.to !== null) {
      to = { 'sample.headers.to': headers.to };
      queries.push({ match_phrase: to });
    }
  }
  if (Object.hasOwn(headers, 'reply-to')) {
    // Flattened like From/To so it can be displayed and aggregated; not
    // part of the dedup query.
    headers['reply-to'] = flattenAddressHeader(headers['reply-to']);
  }
  if (Object.hasOwn(headers, 'subject')) {
    subject = headers.subject;
    queries.push({ match_phrase: { 'sample.headers.subject': subject } });
  }

  let existing: number;
  try {
    existing = await countExisting(options, searchIndex, andQueries(queries));
  } catch (error) {
    throw new OpenSearchError(
      `OpenSearch's search for existing report error: ${errorMessage(error)}`,
    );
  }
  if (existing > 0) {
    throw new AlreadySaved(
      `A failure sample to ${pyStr(to)} from ${pyStr(from)} ` +
        `with a subject of ${pyStr(subject)} and arrival date of ${arrivalDateUtc} ` +
        'already exists in ' +
        'OpenSearch',
    );
  }

  const sample: Record<string, unknown> = {
    raw: getKey(failureReport, 'sample'),
    headers,
    headers_only: getKey(failureReport, 'sampleHeadersOnly'),
    date: sampleDate,
    subject: getKey(parsedSample, 'subject'),
    filename_safe_subject: getKey(parsedSample, 'filenameSafeSubject'),
    body: getKey(parsedSample, 'body'),
  };
  const addressLists = [
    ['to', 'to'],
    ['replyTo', 'reply_to'],
    ['cc', 'cc'],
    ['bcc', 'bcc'],
  ] as const;
  for (const [key, field] of addressLists) {
    for (const address of getKey(parsedSample, key) as unknown[]) {
      appendTo(sample, field, {
        display_name: getKey(address, 'displayName'),
        address: getKey(address, 'address'),
      });
    }
  }
  for (const attachment of getKey(parsedSample, 'attachments') as unknown[]) {
    appendTo(sample, 'attachments', {
      filename: getKey(attachment, 'filename'),
      content_type: getKey(attachment, 'mailContentType'),
      sha256: getKey(attachment, 'sha256'),
    });
  }

  try {
    const source = getKey(failureReport, 'source');
    const failureDoc: Record<string, unknown> = {
      feedback_type: getKey(failureReport, 'feedbackType'),
      user_agent: getKey(failureReport, 'userAgent'),
      version: getKey(failureReport, 'version'),
      original_mail_from: getKey(failureReport, 'originalMailFrom'),
      arrival_date: arrivalDateEpochMilliseconds,
      domain: getKey(failureReport, 'reportedDomain'),
      original_envelope_id: getKey(failureReport, 'originalEnvelopeId'),
      authentication_results: getKey(failureReport, 'authenticationResults'),
      delivery_results: getKey(failureReport, 'deliveryResult'),
      source_ip_address: getKey(source, 'ipAddress'),
      source_country: getKey(source, 'country'),
      source_reverse_dns: getKey(source, 'reverseDns'),
      source_base_domain: getKey(source, 'baseDomain'),
      source_asn: getKey(source, 'asn'),
      source_as_name: getKey(source, 'asName'),
      source_as_domain: getKey(source, 'asDomain'),
      authentication_mechanisms: getKey(
        failureReport,
        'authenticationMechanisms',
      ),
      auth_failure: getKey(failureReport, 'authFailure'),
      dkim_domain: getKey(failureReport, 'dkimDomain'),
      original_rcpt_to: getKey(failureReport, 'originalRcptTo'),
      sample,
      [TIMESTAMP_FIELD]: arrivalDate.isoformat(),
    };

    let index = undatedIndexName('dmarc_failure', options);
    if (options.useDataStreams) {
      await createDataStreams(
        [index],
        indexSettings(options),
        INDEX_MAPPINGS.failure,
        options,
      );
    } else {
      index = `${index}-${indexDate(arrivalDate, options.monthlyIndexes)}`;
      await createIndexes(
        [index],
        indexSettings(options),
        INDEX_MAPPINGS.failure,
        options,
      );
    }
    try {
      await saveDocument(options, FAILURE_REPORT_DOC, index, failureDoc);
    } catch (error) {
      throw new OpenSearchError(`OpenSearch error: ${errorMessage(error)}`);
    }
  } catch (error) {
    if (error instanceof KeyError) {
      throw new InvalidFailureReport(
        `Failure report missing required field: ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Saves a parsed SMTP TLS report to OpenSearch.
 *
 * @throws {AlreadySaved} when the report is already in OpenSearch.
 * @throws {OpenSearchError} when OpenSearch fails or rejects the document.
 */
export async function saveSmtpTlsReportToOpenSearch(
  report: SMTPTLSReport,
  options: SaveOptions = {},
): Promise<void> {
  logger.info('Saving SMTP TLS report to OpenSearch');
  const orgName = report.organizationName;
  const { reportId } = report;
  const beginDate = humanTimestampToDatetime(report.beginDate, { toUtc: true });
  const endDate = humanTimestampToDatetime(report.endDate, { toUtc: true });
  const beginDateHuman = beginDate.strftime('%Y-%m-%d %H:%M:%SZ');
  const endDateHuman = endDate.strftime('%Y-%m-%d %H:%M:%SZ');

  const query = andQueries([
    { match_phrase: { org_name: orgName } },
    { match_phrase: { report_id: reportId } },
    { match: { date_begin: beginDate.isoformat() } },
    { match: { date_end: endDate.isoformat() } },
  ]);
  const searchIndex = searchPattern('smtp_tls', options);

  let existing: number;
  try {
    existing = await countExisting(options, searchIndex, query);
  } catch (error) {
    throw new OpenSearchError(
      `OpenSearch's search for existing report error: ${errorMessage(error)}`,
    );
  }
  if (existing > 0) {
    throw new AlreadySaved(
      `An SMTP TLS report ID ${reportId} from ` +
        ` ${orgName} with a date range of ` +
        `${beginDateHuman} UTC to ` +
        `${endDateHuman} UTC already ` +
        'exists in OpenSearch',
    );
  }

  let index = undatedIndexName('smtp_tls', options);
  if (!options.useDataStreams) {
    index = `${index}-${indexDate(beginDate, options.monthlyIndexes)}`;
  }
  // `org_name` (not the declared `organization_name`) is what parsedmarc
  // stores, and what the dashboards query.
  const smtpTlsDoc: Record<string, unknown> = {
    org_name: report.organizationName,
    date_range: [beginDate, endDate],
    date_begin: beginDate,
    date_end: endDate,
    contact_info: report.contactInfo,
    report_id: report.reportId,
    [TIMESTAMP_FIELD]: beginDate.isoformat(),
  };

  for (const policy of report.policies) {
    const policyStrings =
      'policyStrings' in policy ? policy.policyStrings : null;
    const mxHostPatterns =
      'mxHostPatterns' in policy ? policy.mxHostPatterns : null;
    // One composed string per policy and per failure detail: dashboards
    // cannot terms-aggregate the subfields of an object array without a
    // cross-product (parsedmarc issue #169).
    const policyDomainCombined = policy.policyDomain || 'none';
    const policyTypeCombined = policy.policyType || 'none';
    appendTo(
      smtpTlsDoc,
      'policies_combined',
      `${policyDomainCombined} / ${policyTypeCombined}`,
    );
    // `policy_string` (singular) is the key parsedmarc writes.
    const policyDoc: Record<string, unknown> = {
      policy_domain: policy.policyDomain,
      policy_type: policy.policyType,
      successful_session_count: policy.successfulSessionCount,
      failed_session_count: policy.failedSessionCount,
      policy_string: policyStrings ?? null,
      mx_host_patterns: mxHostPatterns ?? null,
    };
    if ('failureDetails' in policy) {
      for (const detail of policy.failureDetails ?? []) {
        // The parser's key is additional_info_uri; the long form is
        // accepted too for reports built by other callers.
        const longForm = detail as { additionalInformationUri?: string };
        let additionalInformationUri: unknown = null;
        if ('additionalInfoUri' in detail) {
          additionalInformationUri = detail.additionalInfoUri;
        } else if ('additionalInformationUri' in detail) {
          additionalInformationUri = longForm.additionalInformationUri;
        }
        const pick = (key: keyof typeof detail): unknown =>
          key in detail ? detail[key] : null;
        const sendingMtaIp = pick('sendingMtaIp');
        const receivingIp = pick('receivingIp');
        const receivingMxHostname = pick('receivingMxHostname');
        appendTo(policyDoc, 'failure_details', {
          result_type: detail.resultType,
          ip_address: pick('ipAddress'),
          sending_mta_ip: ipOrNull(sendingMtaIp, 'sending_mta_ip'),
          receiving_mx_hostname: receivingMxHostname,
          receiving_mx_helo: pick('receivingMxHelo'),
          receiving_ip: ipOrNull(receivingIp, 'receiving_ip'),
          failed_session_count: detail.failedSessionCount,
          additional_information_uri: additionalInformationUri,
          failure_reason_code: pick('failureReasonCode'),
        });
        appendTo(
          smtpTlsDoc,
          'failure_details_combined',
          [
            policyDomainCombined,
            policyTypeCombined,
            detail.resultType || 'none',
            pyStr(sendingMtaIp || 'none'),
            pyStr(receivingIp || 'none'),
            pyStr(receivingMxHostname || 'none'),
          ].join(' / '),
        );
      }
    }
    appendTo(smtpTlsDoc, 'policies', policyDoc);
  }

  if (options.useDataStreams) {
    await createDataStreams(
      [index],
      indexSettings(options),
      INDEX_MAPPINGS.smtpTls,
      options,
    );
  } else {
    await createIndexes(
      [index],
      indexSettings(options),
      INDEX_MAPPINGS.smtpTls,
      options,
    );
  }

  try {
    await saveDocument(options, SMTP_TLS_REPORT_DOC, index, smtpTlsDoc);
  } catch (error) {
    throw new OpenSearchError(`OpenSearch error: ${errorMessage(error)}`);
  }
}

/** Backward-compatible alias of {@link saveFailureReportToOpenSearch}. */
export const saveForensicReportToOpenSearch: typeof saveFailureReportToOpenSearch =
  saveFailureReportToOpenSearch;
