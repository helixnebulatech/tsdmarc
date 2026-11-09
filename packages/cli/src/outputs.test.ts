// Ported from parsedmarc's tests/test_cli.py: TestSearchBackendHandles,
// TestInitOutputClientsRollback, TestNormalizeIndexPrefix and
// TestMigrationIndexNames.

import * as elastic from '@tsdmarc/elasticsearch';
import { KafkaClient } from '@tsdmarc/kafka';
import * as opensearch from '@tsdmarc/opensearch';
import { S3Client } from '@tsdmarc/s3';
import { captureLogs, DEBUG, logger } from 'tsdmarc';
import { describe, expect, it, vi } from 'vitest';

import { parseConfig } from './config';
import { ConfigParser } from './configparser';
import { applyEnvOverrides } from './env';
import { createOptions, type CliOptions } from './options';
import {
  closeOutputClients,
  ElasticsearchHandle,
  initOutputClients,
  migrationIndexNames,
  normalizeIndexPrefix,
  OpenSearchHandle,
  OutputClientError,
} from './outputs';

type ElasticClient = Parameters<typeof elastic.setDefaultConnection>[0];
type OpenSearchClient = Parameters<typeof opensearch.setDefaultConnection>[0];

/**
 * Stand-in for an Elasticsearch/OpenSearch client held in the real
 * connection state. Records close() calls and nothing else.
 */
class FakeSearchConnection {
  readonly name: string;
  closeCount = 0;

  constructor(name: string) {
    this.name = name;
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }
}

/** A client whose close() fails (its transport is already broken). */
class RaisingSearchConnection extends FakeSearchConnection {
  override close(): Promise<void> {
    this.closeCount += 1;
    return Promise.reject(new Error('transport already closed'));
  }
}

const asElastic = (connection: FakeSearchConnection): ElasticClient =>
  connection as unknown as ElasticClient;
const asOpenSearch = (connection: FakeSearchConnection): OpenSearchClient =>
  connection as unknown as OpenSearchClient;

// A host nothing listens on; every cluster call is mocked, so the clients
// are only constructed (which opens no socket).
const UNREACHABLE_HOSTS = ['127.0.0.1:9299'];

/** The options `initOutputClients()` reads, with every output off. */
function outputClientOpts(overrides: Partial<CliOptions>): CliOptions {
  return { ...createOptions(), ...overrides };
}

describe('TestSearchBackendHandles', () => {
  // The handles must close the client they were built for, not whatever
  // holds the `default` connection at close time: a SIGHUP reload registers
  // the replacement client before it closes the old handles.

  it('testElasticsearchHandleClosesItsOwnConnectionAfterReload', async () => {
    const oldConn = new FakeSearchConnection('old');
    const newConn = new FakeSearchConnection('new');
    elastic.setDefaultConnection(asElastic(oldConn));
    const handle = new ElasticsearchHandle(elastic.getDefaultConnection()!);
    // What a reload does before the old handle is closed.
    elastic.setDefaultConnection(asElastic(newConn));

    await handle.close();

    expect(oldConn.closeCount).toBe(1);
    expect(newConn.closeCount).toBe(0);
    expect(elastic.getDefaultConnection()).toBe(newConn);
  });

  it('testElasticsearchHandleReleasesAliasOnShutdown', async () => {
    const conn = new FakeSearchConnection('only');
    elastic.setDefaultConnection(asElastic(conn));
    const handle = new ElasticsearchHandle(elastic.getDefaultConnection()!);

    await handle.close();

    expect(conn.closeCount).toBe(1);
    expect(elastic.getDefaultConnection()).toBeNull();
  });

  it('testElasticsearchHandleCloseIsBestEffort', async () => {
    const conn = new RaisingSearchConnection('raiser');
    elastic.setDefaultConnection(asElastic(conn));
    const handle = new ElasticsearchHandle(elastic.getDefaultConnection()!);

    await handle.close();

    expect(conn.closeCount).toBe(1);
    expect(elastic.getDefaultConnection()).toBeNull();

    await handle.close();

    expect(conn.closeCount).toBe(2);
  });

  it('testOpenSearchHandleClosesItsOwnConnectionAfterReload', async () => {
    const oldConn = new FakeSearchConnection('old');
    const newConn = new FakeSearchConnection('new');
    opensearch.setDefaultConnection(asOpenSearch(oldConn));
    const handle = new OpenSearchHandle(opensearch.getDefaultConnection()!);
    opensearch.setDefaultConnection(asOpenSearch(newConn));

    await handle.close();

    expect(oldConn.closeCount).toBe(1);
    expect(newConn.closeCount).toBe(0);
    expect(opensearch.getDefaultConnection()).toBe(newConn);
  });

  it('testOpenSearchHandleReleasesAliasOnShutdown', async () => {
    const conn = new FakeSearchConnection('only');
    opensearch.setDefaultConnection(asOpenSearch(conn));
    const handle = new OpenSearchHandle(opensearch.getDefaultConnection()!);

    await handle.close();

    expect(conn.closeCount).toBe(1);
    expect(opensearch.getDefaultConnection()).toBeNull();
  });

  it('testOpenSearchHandleCloseIsBestEffort', async () => {
    const conn = new RaisingSearchConnection('raiser');
    opensearch.setDefaultConnection(asOpenSearch(conn));
    const handle = new OpenSearchHandle(opensearch.getDefaultConnection()!);

    await handle.close();

    expect(conn.closeCount).toBe(1);
    expect(opensearch.getDefaultConnection()).toBeNull();

    await handle.close();

    expect(conn.closeCount).toBe(2);
  });
});

/** Spy on close() of whatever client is the `default` connection now. */
function spyOnRegisteredClose(
  getConnection: () => { close: () => unknown } | null,
  closed: unknown[],
  implementation?: () => Promise<void>,
): unknown {
  const client = getConnection();
  if (client === null) {
    throw new Error('no client registered');
  }
  const realClose = client.close.bind(client);
  vi.spyOn(client, 'close').mockImplementation(async () => {
    closed.push(client);
    if (implementation === undefined) {
      await realClose();
    } else {
      await implementation();
    }
  });
  return client;
}

describe('TestInitOutputClientsRollback', () => {
  // initOutputClients() is all-or-nothing against the search backends'
  // `default` connection: setHosts() registers its client right away, but
  // the index migration and later outputs can still fail.

  it('test_interrupt_after_set_hosts_restores_the_previous_elasticsearch_client', async () => {
    const oldConn = new FakeSearchConnection('old');
    elastic.setDefaultConnection(asElastic(oldConn));
    const closed: unknown[] = [];
    const registered: unknown[] = [];
    vi.mocked(elastic.migrateIndexes).mockImplementation(async () => {
      // Whatever setHosts() registered a moment ago.
      registered.push(
        spyOnRegisteredClose(elastic.getDefaultConnection, closed),
      );
      throw new Error('interrupted');
    });

    const opts = outputClientOpts({
      saveAggregate: true,
      elasticsearchHosts: UNREACHABLE_HOSTS,
      elasticsearchTimeout: 1.0,
    });
    await expect(initOutputClients(opts)).rejects.toThrow('interrupted');

    expect(registered).toHaveLength(1);
    const newConn = registered[0];
    expect(newConn).not.toBe(oldConn);
    expect(elastic.getDefaultConnection()).toBe(oldConn);
    expect(closed).toEqual([newConn]);
    expect(oldConn.closeCount).toBe(0);
  });

  it('test_interrupt_after_set_hosts_restores_the_previous_opensearch_client', async () => {
    const oldConn = new FakeSearchConnection('old');
    opensearch.setDefaultConnection(asOpenSearch(oldConn));
    const closed: unknown[] = [];
    const registered: unknown[] = [];
    vi.mocked(opensearch.migrateIndexes).mockImplementation(async () => {
      // The OpenSearch client's close() calls itself (callback API), so
      // the spy does not delegate to it; the client never opened a socket.
      registered.push(
        spyOnRegisteredClose(opensearch.getDefaultConnection, closed, () =>
          Promise.resolve(),
        ),
      );
      throw new Error('interrupted');
    });

    const opts = outputClientOpts({
      saveAggregate: true,
      opensearchHosts: UNREACHABLE_HOSTS,
      opensearchTimeout: 1.0,
    });
    await expect(initOutputClients(opts)).rejects.toThrow('interrupted');

    expect(registered).toHaveLength(1);
    const newConn = registered[0];
    expect(newConn).not.toBe(oldConn);
    expect(opensearch.getDefaultConnection()).toBe(oldConn);
    expect(closed).toEqual([newConn]);
    expect(oldConn.closeCount).toBe(0);
  });

  it('test_failure_with_no_previous_alias_leaves_the_alias_unset', async () => {
    elastic.setDefaultConnection(null);
    const closed: unknown[] = [];
    const registered: unknown[] = [];
    vi.mocked(elastic.migrateIndexes).mockImplementation(async () => {
      registered.push(
        spyOnRegisteredClose(elastic.getDefaultConnection, closed),
      );
      throw new Error('interrupted');
    });

    const opts = outputClientOpts({
      saveAggregate: true,
      elasticsearchHosts: UNREACHABLE_HOSTS,
      elasticsearchTimeout: 1.0,
    });
    await expect(initOutputClients(opts)).rejects.toThrow('interrupted');

    expect(elastic.getDefaultConnection()).toBeNull();
    expect(registered).toHaveLength(1);
    expect(closed).toEqual(registered);
  });

  it('test_failure_in_a_later_output_closes_everything_already_built', async () => {
    // Elasticsearch is fully built, then OpenSearch fails (awssigv4 without
    // aws_region); the Kafka client built earlier must be closed too.
    const oldEs = new FakeSearchConnection('old es');
    const oldOs = new FakeSearchConnection('old os');
    elastic.setDefaultConnection(asElastic(oldEs));
    opensearch.setDefaultConnection(asOpenSearch(oldOs));
    const closed: unknown[] = [];
    const built: unknown[] = [];
    vi.mocked(elastic.migrateIndexes).mockImplementation(async () => {
      built.push(spyOnRegisteredClose(elastic.getDefaultConnection, closed));
    });
    const kafkaClient = { close: vi.fn(async () => undefined) };
    const kafkaCreate = vi
      .spyOn(KafkaClient, 'create')
      .mockResolvedValue(kafkaClient as unknown as KafkaClient);

    const opts = outputClientOpts({
      saveAggregate: true,
      kafkaHosts: ['kafka.example.com:9092'],
      elasticsearchHosts: UNREACHABLE_HOSTS,
      elasticsearchTimeout: 1.0,
      opensearchHosts: UNREACHABLE_HOSTS,
      opensearchAuthType: 'awssigv4',
    });
    const error: unknown = await initOutputClients(opts).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('RuntimeError');
    expect((error as Error).message).toContain('aws_region');
    expect(kafkaCreate).toHaveBeenCalledOnce();
    expect(kafkaClient.close).toHaveBeenCalledOnce();
    expect(built).toEqual(closed);
    expect(closed).toHaveLength(1);
    expect(elastic.getDefaultConnection()).toBe(oldEs);
    expect(opensearch.getDefaultConnection()).toBe(oldOs);
    expect(oldEs.closeCount).toBe(0);
    expect(oldOs.closeCount).toBe(0);
  });

  it('test_a_failed_build_does_not_leave_the_serverless_flag_flipped', async () => {
    const oldEs = new FakeSearchConnection('old es');
    elastic.setDefaultConnection(asElastic(oldEs));
    elastic.setServerless(false);
    const during: boolean[] = [];
    vi.mocked(elastic.migrateIndexes).mockImplementation(async () => {
      // Runs after setHosts() has written both the connection and the flag.
      during.push(elastic.getServerless());
    });

    const opts = outputClientOpts({
      saveAggregate: true,
      elasticsearchHosts: UNREACHABLE_HOSTS,
      elasticsearchTimeout: 1.0,
      elasticsearchServerless: true,
      opensearchHosts: UNREACHABLE_HOSTS,
      opensearchAuthType: 'awssigv4',
    });
    await expect(initOutputClients(opts)).rejects.toMatchObject({
      name: 'RuntimeError',
    });

    expect(during).toEqual([true]);
    expect(elastic.getServerless()).toBe(false);
    expect(elastic.getDefaultConnection()).toBe(oldEs);
  });

  it('test_an_interrupt_during_teardown_still_restores_the_alias', async () => {
    // Python: a KeyboardInterrupt raised by the client's own close() escapes
    // the handle (which swallows only Exception), so the rollback closes the
    // client a second time. JS has no uncatchable errors: the handle swallows
    // the close() failure and still releases the connection, so the client
    // is closed once and the previous one is registered again.
    const oldEs = new FakeSearchConnection('old es');
    const oldOs = new FakeSearchConnection('old os');
    elastic.setDefaultConnection(asElastic(oldEs));
    opensearch.setDefaultConnection(asOpenSearch(oldOs));
    const attempted: unknown[] = [];
    vi.mocked(elastic.migrateIndexes).mockImplementation(async () => {
      spyOnRegisteredClose(elastic.getDefaultConnection, attempted, () =>
        Promise.reject(new Error('interrupted')),
      );
    });

    const opts = outputClientOpts({
      saveAggregate: true,
      elasticsearchHosts: UNREACHABLE_HOSTS,
      elasticsearchTimeout: 1.0,
      opensearchHosts: UNREACHABLE_HOSTS,
      opensearchAuthType: 'awssigv4',
    });
    await expect(initOutputClients(opts)).rejects.toThrow('aws_region');

    expect(attempted).toHaveLength(1);
    expect(elastic.getDefaultConnection()).toBe(oldEs);
    expect(opensearch.getDefaultConnection()).toBe(oldOs);
    expect(oldEs.closeCount).toBe(0);
  });

  it('test_a_discarded_client_that_cannot_be_closed_still_returns_the_alias', async () => {
    const oldConn = new FakeSearchConnection('old');
    elastic.setDefaultConnection(asElastic(oldConn));
    const attempted: unknown[] = [];
    vi.mocked(elastic.migrateIndexes).mockImplementation(async () => {
      spyOnRegisteredClose(elastic.getDefaultConnection, attempted, () =>
        Promise.reject(new Error('transport already closed')),
      );
      throw new Error('interrupted');
    });

    const opts = outputClientOpts({
      saveAggregate: true,
      elasticsearchHosts: UNREACHABLE_HOSTS,
      elasticsearchTimeout: 1.0,
    });
    await expect(initOutputClients(opts)).rejects.toThrow('interrupted');

    expect(attempted).toHaveLength(1);
    expect(elastic.getDefaultConnection()).toBe(oldConn);
  });

  it('test_successful_init_hands_the_alias_to_the_new_client', async () => {
    const oldConn = new FakeSearchConnection('old');
    elastic.setDefaultConnection(asElastic(oldConn));
    const closed: unknown[] = [];
    vi.mocked(elastic.migrateIndexes).mockImplementation(async () => {
      spyOnRegisteredClose(elastic.getDefaultConnection, closed);
    });

    const opts = outputClientOpts({
      saveAggregate: true,
      elasticsearchHosts: UNREACHABLE_HOSTS,
      elasticsearchTimeout: 1.0,
    });
    const clients = await initOutputClients(opts);
    const newConn = elastic.getDefaultConnection();

    expect(newConn).not.toBe(oldConn);
    expect(closed).toEqual([]);
    expect(oldConn.closeCount).toBe(0);
    expect([...clients.keys()].sort()).toEqual(['elasticsearch']);

    await clients.get('elasticsearch')?.close();

    expect(closed).toEqual([newConn]);
  });
});

describe('TestNormalizeIndexPrefix', () => {
  it('test_lowercases_and_strips', () => {
    expect(normalizeIndexPrefix(' Acme ')).toBe('acme_');
  });

  it('test_replaces_spaces_and_hyphens', () => {
    expect(normalizeIndexPrefix('Acme Corp-2')).toBe('acme_corp_2_');
  });

  it('test_strips_surrounding_underscores', () => {
    expect(normalizeIndexPrefix('_tenant_')).toBe('tenant_');
  });

  it('test_key_that_normalizes_to_nothing_yields_a_bare_underscore', () => {
    // The save path writes such a report to `_dmarc_aggregate-*`, so the
    // migration path has to target the same name.
    expect(normalizeIndexPrefix('_')).toBe('_');
    expect(normalizeIndexPrefix('   ')).toBe('_');
  });
});

describe('TestMigrationIndexNames', () => {
  const map = (entries: Record<string, string[]>): Map<string, string[]> =>
    new Map(Object.entries(entries));

  it('test_nothing_configured_is_unchanged', () => {
    expect(migrationIndexNames('dmarc_aggregate', null, null, null)).toEqual([
      'dmarc_aggregate',
    ]);
    expect(
      migrationIndexNames('dmarc_aggregate', null, null, new Map()),
    ).toEqual(['dmarc_aggregate']);
  });

  it('test_suffix_also_targets_the_unsuffixed_name', () => {
    expect(migrationIndexNames('dmarc_aggregate', 'prod', null, null)).toEqual([
      'dmarc_aggregate_prod',
      'dmarc_aggregate',
    ]);
  });

  it('test_empty_suffix_adds_no_duplicate', () => {
    expect(migrationIndexNames('dmarc_aggregate', '', null, null)).toEqual([
      'dmarc_aggregate',
    ]);
  });

  it('test_domain_map_fans_out_after_the_unprefixed_name', () => {
    expect(
      migrationIndexNames(
        'dmarc_aggregate',
        null,
        null,
        map({
          'Acme Corp': ['acme.example'],
          'widgets-inc': ['widgets.example'],
        }),
      ),
    ).toEqual([
      'dmarc_aggregate',
      'acme_corp_dmarc_aggregate',
      'widgets_inc_dmarc_aggregate',
    ]);
  });

  it('test_keys_that_normalize_identically_are_deduplicated', () => {
    expect(
      migrationIndexNames(
        'dmarc_aggregate',
        null,
        null,
        map({ 'acme corp': ['a.example'], 'Acme-Corp': ['b.example'] }),
      ),
    ).toEqual(['dmarc_aggregate', 'acme_corp_dmarc_aggregate']);
  });

  it('test_configured_prefix_suppresses_the_domain_map_fan_out', () => {
    expect(
      migrationIndexNames(
        'dmarc_aggregate',
        'prod',
        'corp_',
        map({ acme: ['acme.example'] }),
      ),
    ).toEqual(['corp_dmarc_aggregate_prod', 'corp_dmarc_aggregate']);
  });

  it('test_configured_prefix_is_used_verbatim', () => {
    expect(
      migrationIndexNames('dmarc_aggregate', null, 'My-Prefix ', null),
    ).toEqual(['My-Prefix dmarc_aggregate']);
  });

  it('test_both_axes_compose_in_save_time_order', () => {
    expect(
      migrationIndexNames(
        'smtp_tls',
        'prod',
        null,
        map({ acme: ['acme.example'] }),
      ),
    ).toEqual([
      'smtp_tls_prod',
      'smtp_tls',
      'acme_smtp_tls_prod',
      'acme_smtp_tls',
    ]);
  });

  it('test_key_normalizing_to_an_underscore_is_targeted', () => {
    expect(
      migrationIndexNames(
        'dmarc_aggregate',
        null,
        null,
        map({ _: ['acme.example'] }),
      ),
    ).toEqual(['dmarc_aggregate', '_dmarc_aggregate']);
  });
});

describe('debug logs never show credentials in URLs', () => {
  it('masks user:password@ in Elasticsearch, OpenSearch, and HEC URLs', async () => {
    vi.mocked(elastic.migrateIndexes).mockResolvedValue(undefined);
    vi.mocked(opensearch.migrateIndexes).mockResolvedValue(undefined);
    const capture = captureLogs(logger, DEBUG);
    try {
      const clients = await initOutputClients(
        outputClientOpts({
          saveAggregate: true,
          elasticsearchHosts: ['https://elastic:EsS3cret@127.0.0.1:9299'],
          elasticsearchTimeout: 1.0,
          opensearchHosts: ['https://admin:OsS3cret@127.0.0.1:9299'],
          opensearchTimeout: 1.0,
          hec: 'https://splunk:HecS3cret@127.0.0.1:8088/services/collector',
          hecToken: 'token',
          hecIndex: 'dmarc',
        }),
      );
      await closeOutputClients(clients);
    } finally {
      capture.restore();
    }
    const output = capture.output.join('\n');
    expect(output).not.toMatch(/S3cret/u);
    expect(output).toContain(
      "Initializing Elasticsearch client: hosts=['https://elastic:***@127.0.0.1:9299'], ssl=True",
    );
    expect(output).toContain(
      "Initializing OpenSearch client: hosts=['https://admin:***@127.0.0.1:9299'], ssl=True",
    );
    expect(output).toContain(
      'Initializing Splunk HEC client: url=https://splunk:***@127.0.0.1:8088/services/collector',
    );
  });
});

describe('credentials in output client errors', () => {
  const password = 'pa/ss';

  // setHosts() is not the failure under test here: the real one runs,
  // with its real URL check, so nothing below mocks a client.
  const unparsableHosts: [string, Partial<CliOptions>][] = [
    [
      'Elasticsearch',
      { elasticsearchHosts: [`https://user:${password}@host:9200`] },
    ],
    ['OpenSearch', { opensearchHosts: [`https://user:${password}@host:9200`] }],
  ];

  it.each(unparsableHosts)(
    'keeps a password out of the error and logs for an unparsable %s URL',
    async (name, overrides) => {
      const opts = outputClientOpts({ saveAggregate: true, ...overrides });
      const logs = captureLogs(logger, DEBUG);
      logger.setLevel(DEBUG);
      let error: unknown = null;
      try {
        await initOutputClients(opts);
      } catch (caught) {
        error = caught;
      } finally {
        logs.restore();
      }
      expect(error).toBeInstanceOf(OutputClientError);
      expect((error as Error).message).toContain(`${name}: `);
      expect((error as Error).message).not.toContain(password);
      expect((error as Error).message).not.toContain('user:');
      expect(logs.output.join('\n')).not.toContain(password);
    },
  );

  it('keeps a password out of the error for a bad PostgreSQL connection string', async () => {
    const opts = outputClientOpts({
      postgresqlConnectionString: 'host=db password=my secret',
    });
    let error: unknown = null;
    try {
      await initOutputClients(opts);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OutputClientError);
    expect((error as Error).message).toContain('PostgreSQL: ');
    expect((error as Error).message).not.toContain('secret');
  });
});

describe('[s3] prevent_overwrite', () => {
  async function s3ClientFor(
    settings: Record<string, string>,
  ): Promise<S3Client> {
    const config = new ConfigParser();
    config.addSection('s3');
    for (const [key, value] of Object.entries({
      bucket: 'reports',
      region_name: 'eu-west-1',
      ...settings,
    })) {
      config.set('s3', key, value);
    }
    const options = createOptions();
    await parseConfig(config, options);
    const clients = await initOutputClients(options);
    const client = clients.get('s3_client');
    await closeOutputClients(clients);
    if (!(client instanceof S3Client)) {
      throw new TypeError('no S3 client built');
    }
    return client;
  }

  it('reaches S3ClientOptions', async () => {
    expect(
      (await s3ClientFor({ prevent_overwrite: 'true' })).preventOverwrite,
    ).toBe(true);
  });

  it('is off by default, overwriting like parsedmarc', async () => {
    expect((await s3ClientFor({})).preventOverwrite).toBe(false);
    expect(
      (await s3ClientFor({ prevent_overwrite: 'no' })).preventOverwrite,
    ).toBe(false);
  });

  it('is read from TSDMARC_S3_PREVENT_OVERWRITE', async () => {
    const config = new ConfigParser();
    applyEnvOverrides(config, {
      TSDMARC_S3_BUCKET: 'reports',
      TSDMARC_S3_REGION_NAME: 'eu-west-1',
      TSDMARC_S3_PREVENT_OVERWRITE: 'yes',
    });
    const options = createOptions();
    await parseConfig(config, options);
    expect(options.s3PreventOverwrite).toBe(true);
  });

  it('rejects a value that is not a boolean', async () => {
    await expect(s3ClientFor({ prevent_overwrite: 'maybe' })).rejects.toThrow(
      'Not a boolean: maybe',
    );
  });
});
