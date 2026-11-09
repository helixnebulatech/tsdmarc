// Output clients: creation (all-or-nothing), teardown, the search
// backends' module state, and index name helpers.

import * as elastic from '@tsdmarc/elasticsearch';
import { KafkaClient } from '@tsdmarc/kafka';
import * as opensearch from '@tsdmarc/opensearch';
import { PostgreSQLClient } from '@tsdmarc/postgres';
import { S3Client } from '@tsdmarc/s3';
import {
  createParserConfig,
  DEFAULT_DNS_MAX_RETRIES,
  DEFAULT_DNS_TIMEOUT,
  HECClient,
  IP_ADDRESS_CACHE,
  ipInfoState,
  LokiClient,
  type LokiTimestampMode,
  logger,
  type ParserConfig,
  pslOverrides,
  redactUrlCredentials,
  REVERSE_DNS_MAP,
  SEEN_AGGREGATE_REPORT_IDS,
  SyslogClient,
  WebhookClient,
  GelfClient,
  type GelfClientOptions,
} from 'tsdmarc';

import type { IndexPrefixDomainMap } from './config';
import { ConfigurationError } from './errors';
import type { CliOptions } from './options';

/** Anything with a `close()` (sync or async). */
export interface Closable {
  close: () => unknown;
}

/**
 * Output clients by name (`s3_client`, `postgresql_client`,
 * `syslog_client`, `hec_client`, `kafka_client`, `gelf_client`,
 * `webhook_client`, `loki_client`, `elasticsearch`, `opensearch`), in
 * creation order.
 */
export type OutputClients = Map<string, Closable>;

type ElasticsearchClient = NonNullable<
  ReturnType<typeof elastic.getDefaultConnection>
>;
type OpenSearchClient = NonNullable<
  ReturnType<typeof opensearch.getDefaultConnection>
>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A `RuntimeError` naming the output, chained to the SDK's error. */
export class OutputClientError extends Error {
  override name = 'RuntimeError';
}

/**
 * Owns the Elasticsearch client so it takes part in
 * {@link closeOutputClients}. Holds the client setHosts() registered rather
 * than looking the `default` connection up at close time: a SIGHUP reload
 * builds the replacement clients before closing the old ones, so by then
 * the `default` connection is the new client.
 */
export class ElasticsearchHandle {
  readonly connection: ElasticsearchClient;

  constructor(connection: ElasticsearchClient) {
    this.connection = connection;
  }

  async close(): Promise<void> {
    try {
      await this.connection.close();
    } catch {
      // Best-effort and silent, so the second step below still runs.
    }
    try {
      // Give up the `default` connection only while it is still ours: a
      // reload may already have pointed it at a new client.
      if (elastic.getDefaultConnection() === this.connection) {
        elastic.setDefaultConnection(null);
      }
    } catch {
      // Best-effort and silent: not actionable during teardown.
    }
  }
}

/** Owns the OpenSearch client; see {@link ElasticsearchHandle}. */
export class OpenSearchHandle {
  readonly connection: OpenSearchClient;

  constructor(connection: OpenSearchClient) {
    this.connection = connection;
  }

  async close(): Promise<void> {
    try {
      await this.connection.close();
    } catch {
      // Best-effort and silent, so the second step below still runs.
    }
    try {
      if (opensearch.getDefaultConnection() === this.connection) {
        opensearch.setDefaultConnection(null);
      }
    } catch {
      // Best-effort and silent: not actionable during teardown.
    }
  }
}

/**
 * Normalize an `index_prefix_domain_map` key into an index name prefix:
 * lowercased, stripped of surrounding whitespace and then underscores,
 * spaces and hyphens replaced with underscores, plus a trailing `_`. A key
 * that normalizes to nothing yields `_`, which is exactly what the save
 * path writes under for it.
 */
export function normalizeIndexPrefix(prefix: string): string {
  const normalized = prefix
    .toLowerCase()
    .trim()
    .replace(/^_+|_+$/gu, '')
    .replaceAll(' ', '_')
    .replaceAll('-', '_');
  return `${normalized}_`;
}

/**
 * Every index name an index migration should target: save time builds
 * `{prefix}{baseName}_{indexSuffix}-{date}`, and both axes are widened so a
 * migration cannot skip indexes holding data. With a suffix, the suffixed
 * and the bare name (suffixed first). A configured prefix is used verbatim
 * and suppresses the domain map fan-out; otherwise the unprefixed name
 * comes first, then one per map key, normalized. Deduplicated, in
 * first-seen order.
 */
export function migrationIndexNames(
  baseName: string,
  indexSuffix: string | null | undefined,
  configuredPrefix: string | null | undefined,
  indexPrefixDomainMap: IndexPrefixDomainMap | null | undefined,
): string[] {
  const bases = [baseName];
  if (indexSuffix) {
    bases.unshift(`${baseName}_${indexSuffix}`);
  }
  let prefixes: string[];
  if (configuredPrefix) {
    prefixes = [configuredPrefix];
  } else {
    prefixes = [''];
    for (const key of indexPrefixDomainMap?.keys() ?? []) {
      const prefix = normalizeIndexPrefix(key);
      if (!prefixes.includes(prefix)) {
        prefixes.push(prefix);
      }
    }
  }
  const names: string[] = [];
  for (const prefix of prefixes) {
    for (const base of bases) {
      const name = `${prefix}${base}`;
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

/** The module state each search backend's setHosts() writes. */
export interface SearchAliasSnapshot {
  elasticsearch: ElasticsearchClient | null;
  serverless: boolean;
  opensearch: OpenSearchClient | null;
}

/**
 * Record the `default` connection of each search backend and the
 * Elasticsearch `serverless` flag, so a failed build can put back exactly
 * what it found.
 */
export function searchAliasSnapshot(): SearchAliasSnapshot {
  return {
    elasticsearch: elastic.getDefaultConnection(),
    serverless: elastic.getServerless(),
    opensearch: opensearch.getDefaultConnection(),
  };
}

async function closeQuietly(client: Closable): Promise<void> {
  try {
    await client.close();
  } catch {
    // Best-effort: the client is being discarded either way.
  }
}

/**
 * Put the state in `snapshot` back. The `serverless` flag first and
 * unconditionally; then, per backend, a client that took over the
 * `default` connection is closed and the previous one registered again (or
 * the connection removed when there was none).
 */
export async function restoreSearchAliases(
  snapshot: SearchAliasSnapshot,
): Promise<void> {
  elastic.setServerless(snapshot.serverless);
  const backends = [
    {
      current: elastic.getDefaultConnection(),
      previous: snapshot.elasticsearch,
      set: (client: ElasticsearchClient | null): void => {
        elastic.setDefaultConnection(client);
      },
    },
    {
      current: opensearch.getDefaultConnection(),
      previous: snapshot.opensearch,
      set: (client: OpenSearchClient | null): void => {
        opensearch.setDefaultConnection(client);
      },
    },
  ] as const;
  for (const backend of backends) {
    if (backend.current === backend.previous) {
      continue;
    }
    if (backend.current !== null) {
      await closeQuietly(backend.current);
    }
    (backend.set as (client: unknown) => void)(backend.previous);
  }
}

/** The core's loader state a configuration reload writes. */
export interface UtilsGlobalsSnapshot {
  pslOverrides: string[];
  ipDbPath: string | null;
  ipinfoApiToken: string | null;
}

/**
 * Record the loader state the reload writes: the PSL overrides list
 * (refilled in place, so copied by value), the selected IP database path
 * and the IPinfo API token (assigned before its probe can fail).
 */
export function utilsGlobalsSnapshot(): UtilsGlobalsSnapshot {
  return {
    pslOverrides: [...pslOverrides],
    ipDbPath: ipInfoState.ipDbPath,
    ipinfoApiToken: ipInfoState.ipinfoApiToken,
  };
}

/** Put the state in `snapshot` back; the overrides list is restored in place. */
export function restoreUtilsGlobals(snapshot: UtilsGlobalsSnapshot): void {
  pslOverrides.splice(0, pslOverrides.length, ...snapshot.pslOverrides);
  ipInfoState.ipDbPath = snapshot.ipDbPath;
  ipInfoState.ipinfoApiToken = snapshot.ipinfoApiToken;
}

function chain(prefix: string, error: unknown): OutputClientError {
  return new OutputClientError(`${prefix}: ${errorMessage(error)}`, {
    cause: error,
  });
}

/**
 * The GelfClient options of the `[gelf]` section: certificate checks for
 * `mode = tls` (verification against the system CAs by default).
 */
export function gelfClientOptions(opts: CliOptions): GelfClientOptions {
  if (opts.gelfMode !== 'tls') {
    return {};
  }
  return {
    tls: {
      caCerts: opts.gelfCafile,
      validate: !opts.gelfSkipCertificateVerification,
    },
  };
}

/** Python's `int()` on a config value (string or number). */
function toInt(value: string | number | null, fallback?: number): number {
  if (value === null || value === '') {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new TypeError(
      "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'",
    );
  }
  if (typeof value === 'number') {
    return Math.trunc(value);
  }
  if (!/^[+-]?\d+$/u.test(value.trim())) {
    throw new TypeError(`invalid literal for int() with base 10: '${value}'`);
  }
  return Number(value.trim());
}

async function buildSearchClients(
  opts: CliOptions,
  clients: OutputClients,
  indexPrefixDomainMap: IndexPrefixDomainMap | null,
): Promise<void> {
  try {
    if (opts.elasticsearchHosts) {
      logger.debug(
        `Initializing Elasticsearch client: hosts=${pyStrList(redactUrlCredentials(opts.elasticsearchHosts))}, ssl=${pyBool(opts.elasticsearchSsl)}`,
      );
      const names = (
        base: string,
        map: IndexPrefixDomainMap | null,
      ): string[] =>
        migrationIndexNames(
          base,
          opts.elasticsearchIndexSuffix,
          opts.elasticsearchIndexPrefix,
          map,
        );
      const aggregateIndexes = names('dmarc_aggregate', indexPrefixDomainMap);
      const failureIndexes = names('dmarc_failure', indexPrefixDomainMap);
      const smtpTlsIndexes = names('smtp_tls', indexPrefixDomainMap);
      // The legacy published_policy.fo migration gets the same names minus
      // the tenant fan-out: the map postdates the mapping fix.
      const legacyFoIndexes = names('dmarc_aggregate', null);
      const connection = await elastic.setHosts(opts.elasticsearchHosts, {
        useSsl: opts.elasticsearchSsl,
        sslCertPath: opts.elasticsearchSslCertPath,
        skipCertificateVerification:
          opts.elasticsearchSkipCertificateVerification,
        username: opts.elasticsearchUsername,
        password: opts.elasticsearchPassword,
        apiKey: opts.elasticsearchApiKey,
        timeout: opts.elasticsearchTimeout ?? 60.0,
        serverless: Boolean(opts.elasticsearchServerless),
      });
      logger.debug(
        `Elasticsearch index migration targets: aggregate=${pyStrList(aggregateIndexes)}, ` +
          `failure=${pyStrList(failureIndexes)}, smtp_tls=${pyStrList(smtpTlsIndexes)}, ` +
          `legacy_fo=${pyStrList(legacyFoIndexes)}`,
      );
      await elastic.migrateIndexes({
        aggregateIndexes,
        failureIndexes,
        smtpTlsIndexes,
        legacyFoIndexes,
      });
      clients.set('elasticsearch', new ElasticsearchHandle(connection));
    }
  } catch (error) {
    throw chain('Elasticsearch', error);
  }

  try {
    if (opts.opensearchHosts) {
      logger.debug(
        `Initializing OpenSearch client: hosts=${pyStrList(redactUrlCredentials(opts.opensearchHosts))}, ssl=${pyBool(opts.opensearchSsl)}`,
      );
      const names = (
        base: string,
        map: IndexPrefixDomainMap | null,
      ): string[] =>
        migrationIndexNames(
          base,
          opts.opensearchIndexSuffix,
          opts.opensearchIndexPrefix,
          map,
        );
      const aggregateIndexes = names('dmarc_aggregate', indexPrefixDomainMap);
      const failureIndexes = names('dmarc_failure', indexPrefixDomainMap);
      const smtpTlsIndexes = names('smtp_tls', indexPrefixDomainMap);
      const legacyFoIndexes = names('dmarc_aggregate', null);
      const connection = await opensearch.setHosts(opts.opensearchHosts, {
        useSsl: opts.opensearchSsl,
        sslCertPath: opts.opensearchSslCertPath,
        skipCertificateVerification: opts.opensearchSkipCertificateVerification,
        username: opts.opensearchUsername,
        password: opts.opensearchPassword,
        apiKey: opts.opensearchApiKey,
        timeout: opts.opensearchTimeout ?? 60.0,
        authType: opts.opensearchAuthType,
        awsRegion: opts.opensearchAwsRegion,
        awsService: opts.opensearchAwsService,
      });
      logger.debug(
        `OpenSearch index migration targets: aggregate=${pyStrList(aggregateIndexes)}, ` +
          `failure=${pyStrList(failureIndexes)}, smtp_tls=${pyStrList(smtpTlsIndexes)}, ` +
          `legacy_fo=${pyStrList(legacyFoIndexes)}`,
      );
      await opensearch.migrateIndexes({
        aggregateIndexes,
        failureIndexes,
        smtpTlsIndexes,
        legacyFoIndexes,
      });
      clients.set('opensearch', new OpenSearchHandle(connection));
    }
  } catch (error) {
    throw chain('OpenSearch', error);
  }
}

/** Python's `str(list_of_str)`. */
function pyStrList(values: readonly string[]): string {
  return `[${values.map(value => `'${value}'`).join(', ')}]`;
}

function pyBool(value: boolean): string {
  return value ? 'True' : 'False';
}

/**
 * Create the output clients `opts` configures, into `clients`.
 *
 * Deliberately not transactional: on failure it leaves behind the clients
 * already built and any change setHosts() made to the search backends'
 * module state. Undoing that is {@link initOutputClients}'s job; call that.
 *
 * @throws {ConfigurationError} If a required setting is missing.
 * @throws {OutputClientError} If constructing a client fails.
 */
export async function buildOutputClients(
  opts: CliOptions,
  clients: OutputClients,
  indexPrefixDomainMap: IndexPrefixDomainMap | null = null,
): Promise<OutputClients> {
  try {
    if (opts.s3Bucket) {
      logger.debug(`Initializing S3 client: bucket=${opts.s3Bucket}`);
      clients.set(
        's3_client',
        new S3Client(opts.s3Bucket, opts.s3Path ?? '', {
          regionName: opts.s3RegionName,
          endpointUrl: opts.s3EndpointUrl,
          accessKeyId: opts.s3AccessKeyId,
          secretAccessKey: opts.s3SecretAccessKey,
          preventOverwrite: opts.s3PreventOverwrite,
        }),
      );
    }
  } catch (error) {
    throw chain('S3', error);
  }

  try {
    if (opts.postgresqlHost || opts.postgresqlConnectionString) {
      logger.debug('Initializing PostgreSQL client');
      const pgClient = await PostgreSQLClient.create({
        connectionString: opts.postgresqlConnectionString,
        host: opts.postgresqlHost,
        port: toInt(opts.postgresqlPort || null, 5432),
        user: opts.postgresqlUser,
        password: opts.postgresqlPassword,
        database: opts.postgresqlDatabase,
        sslmode: opts.postgresqlSslmode,
        sslrootcert: opts.postgresqlSslrootcert,
        sslcert: opts.postgresqlSslcert,
        sslkey: opts.postgresqlSslkey,
        ...(opts.postgresqlQueryTimeout === null
          ? {}
          : { queryTimeout: opts.postgresqlQueryTimeout }),
      });
      try {
        await pgClient.createTables();
      } catch (error) {
        // Python leaves this connection to the garbage collector; an open
        // socket would keep Node running, so close it.
        await closeQuietly(pgClient);
        throw error;
      }
      clients.set('postgresql_client', pgClient);
    }
  } catch (error) {
    throw chain('PostgreSQL', error);
  }

  try {
    if (opts.syslogServer) {
      logger.debug(
        `Initializing syslog client: server=${opts.syslogServer}:${opts.syslogPort ?? 'None'}`,
      );
      clients.set(
        'syslog_client',
        await SyslogClient.create(opts.syslogServer, toInt(opts.syslogPort), {
          protocol: opts.syslogProtocol || 'udp',
          cafilePath: opts.syslogCafilePath,
          certfilePath: opts.syslogCertfilePath,
          keyfilePath: opts.syslogKeyfilePath,
          timeout: opts.syslogTimeout ?? 5.0,
          retryAttempts: opts.syslogRetryAttempts ?? 3,
          retryDelay: opts.syslogRetryDelay ?? 5,
        }),
      );
    }
  } catch (error) {
    throw chain('Syslog', error);
  }

  if (opts.hec) {
    if (opts.hecToken === null || opts.hecIndex === null) {
      throw new ConfigurationError(
        'HEC token and HEC index are required when using HEC URL',
      );
    }
    try {
      logger.debug(
        `Initializing Splunk HEC client: url=${redactUrlCredentials(opts.hec)}`,
      );
      clients.set(
        'hec_client',
        new HECClient(opts.hec, opts.hecToken, opts.hecIndex, {
          verify: !opts.hecSkipCertificateVerification,
        }),
      );
    } catch (error) {
      throw chain('Splunk HEC', error);
    }
  }

  try {
    if (opts.kafkaHosts) {
      logger.debug(
        `Initializing Kafka client: hosts=${pyStrList(redactUrlCredentials(opts.kafkaHosts))}`,
      );
      let sslContext: {
        rejectUnauthorized: boolean;
        checkServerIdentity: () => undefined;
      } | null = null;
      if (opts.kafkaSkipCertificateVerification) {
        logger.debug('Skipping Kafka certificate verification');
        sslContext = {
          rejectUnauthorized: false,
          checkServerIdentity: () => undefined,
        };
      }
      clients.set(
        'kafka_client',
        await KafkaClient.create(opts.kafkaHosts, {
          ssl: opts.kafkaSsl,
          username: opts.kafkaUsername,
          password: opts.kafkaPassword,
          sslContext,
        }),
      );
    }
  } catch (error) {
    throw chain('Kafka', error);
  }

  try {
    if (opts.gelfHost) {
      logger.debug(
        `Initializing GELF client: host=${opts.gelfHost}:${opts.gelfPort ?? 'None'}`,
      );
      clients.set(
        'gelf_client',
        new GelfClient(
          opts.gelfHost,
          toInt(opts.gelfPort),
          opts.gelfMode ?? 'None',
          gelfClientOptions(opts),
        ),
      );
    }
  } catch (error) {
    throw chain('GELF', error);
  }

  try {
    if (
      opts.webhookAggregateUrl ||
      opts.webhookFailureUrl ||
      opts.webhookSmtpTlsUrl
    ) {
      logger.debug('Initializing webhook client');
      clients.set(
        'webhook_client',
        new WebhookClient(
          opts.webhookAggregateUrl ?? '',
          opts.webhookFailureUrl ?? '',
          opts.webhookSmtpTlsUrl ?? '',
          // Unlike parsedmarc, a report the webhook didn't take is an
          // output error, so its email is kept for another attempt.
          { timeout: opts.webhookTimeout, throwOnError: true },
        ),
      );
    }
  } catch (error) {
    throw chain('Webhook', error);
  }

  try {
    if (opts.lokiUrl) {
      logger.debug(
        `Initializing Loki client: url=${redactUrlCredentials(opts.lokiUrl)}`,
      );
      clients.set(
        'loki_client',
        new LokiClient(opts.lokiUrl, {
          labels: opts.lokiLabels,
          labelFields: opts.lokiLabelFields,
          timestamp: opts.lokiTimestamp as LokiTimestampMode,
          username: opts.lokiUsername,
          password: opts.lokiPassword,
          token: opts.lokiToken,
          tenantId: opts.lokiTenantId,
          verify: !opts.lokiSkipCertificateVerification,
          ...(opts.lokiTimeout === null ? {} : { timeout: opts.lokiTimeout }),
          ...(opts.lokiBatchSize === null
            ? {}
            : { batchSize: opts.lokiBatchSize }),
        }),
      );
    }
  } catch (error) {
    throw chain('Loki', error);
  }

  // The search backends change module state (their `default` connection
  // and the Elasticsearch `serverless` flag), so they come last: a failure
  // in any other output happens before either is touched.
  if (opts.saveAggregate || opts.saveFailure || opts.saveSmtpTls) {
    await buildSearchClients(opts, clients, indexPrefixDomainMap);
  }

  return clients;
}

/**
 * Close output clients. Errors are logged as warnings and never propagate.
 * Idempotent: each client is removed as it is closed (newest first, like
 * Python's `dict.popitem()`).
 */
export async function closeOutputClients(
  clients: OutputClients,
): Promise<void> {
  while (clients.size > 0) {
    const [name, client] = [...clients].at(-1) as [string, Closable];
    clients.delete(name);
    if (typeof client.close === 'function') {
      try {
        await client.close();
      } catch (error) {
        logger.warning(`Error closing ${name}`, { error });
      }
    }
  }
}

/**
 * Create the output clients `opts` configures, all-or-nothing: on failure
 * the clients built so far are closed and the search backends' module state
 * is put back exactly as it was, so a failed SIGHUP reload leaves the
 * running configuration untouched.
 */
export async function initOutputClients(
  opts: CliOptions,
  indexPrefixDomainMap: IndexPrefixDomainMap | null = null,
): Promise<OutputClients> {
  const previousSearchState = searchAliasSnapshot();
  const clients: OutputClients = new Map();
  try {
    return await buildOutputClients(opts, clients, indexPrefixDomainMap);
  } catch (error) {
    // Teardown first, then restore: a built handle releases the `default`
    // connection as it closes, leaving it unset for the restore to
    // re-register the previous client into.
    try {
      await closeOutputClients(clients);
    } finally {
      await restoreSearchAliases(previousSearchState);
    }
    throw error;
  }
}

/**
 * The single parser configuration of a run, bound to the module-default
 * caches.
 */
export function buildParserConfig(opts: CliOptions): ParserConfig {
  return createParserConfig({
    offline: opts.offline,
    ipDbPath: opts.ipDbPath,
    alwaysUseLocalFiles: opts.alwaysUseLocalFiles,
    reverseDnsMapPath: opts.reverseDnsMapPath,
    reverseDnsMapUrl: opts.reverseDnsMapUrl,
    pslOverridesPath: opts.pslOverridesPath,
    pslOverridesUrl: opts.pslOverridesUrl,
    nameservers: opts.nameservers,
    dnsTimeout: opts.dnsTimeout ?? DEFAULT_DNS_TIMEOUT,
    dnsRetries:
      opts.dnsRetries === null
        ? DEFAULT_DNS_MAX_RETRIES
        : Math.trunc(opts.dnsRetries),
    stripAttachmentPayloads: opts.stripAttachmentPayloads,
    normalizeTimespanThresholdHours:
      opts.normalizeTimespanThresholdHours ?? 24.0,
    maxEmailSize: opts.maxEmailSize,
    maxMimeParts: opts.maxMimeParts,
    maxHeaderLines: opts.maxHeaderLines,
    maxExpandedEmailSize: opts.maxExpandedEmailSize,
    maxNormalizedRecords: opts.maxNormalizedRecords,
    maxXmlDepth: opts.maxXmlDepth,
    maxXmlNodes: opts.maxXmlNodes,
    maxSmtpTlsReportSize: opts.maxSmtpTlsReportSize,
    maxLookupsPerReport: opts.maxLookupsPerReport,
    maxFailedLookupsPerReport: opts.maxFailedLookupsPerReport,
    maxLookupTimePerReport: opts.maxLookupTimePerReport,
    jobTimeout: opts.jobTimeout,
    maxWorkerHeapMb: opts.maxWorkerHeapMb,
    ipAddressCache: IP_ADDRESS_CACHE,
    seenAggregateReportIds: SEEN_AGGREGATE_REPORT_IDS,
    reverseDnsMap: REVERSE_DNS_MAP,
  });
}
