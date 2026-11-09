// Port of tests/test_loganalytics.py. ClientSecretCredential and
// LogsIngestionClient are the SDK boundary; the SDK's error types are real.

import { AggregateLogsUploadError } from '@azure/monitor-ingestion';
import {
  type AggregateReport,
  captureLogs,
  type FailureReport,
  type SMTPTLSReport,
} from 'tsdmarc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LogAnalyticsClient,
  LogAnalyticsConfig,
  LogAnalyticsException,
  type LogAnalyticsResults,
  type LogAnalyticsSettings,
} from './index';

const azure = vi.hoisted(() => {
  const credentials: unknown[][] = [];
  const clients: FakeLogsClient[] = [];
  const state: {
    uploadError: Error | null;
    upload: ((stream: string) => Promise<void>) | null;
  } = { uploadError: null, upload: null };
  class FakeCredential {
    constructor(...args: unknown[]) {
      credentials.push(args);
    }
  }
  class FakeLogsClient {
    readonly endpoint: string;
    readonly credential: unknown;
    readonly upload = vi.fn(
      (_ruleId: string, stream: string, _logs: unknown[]) =>
        state.upload?.(stream) ??
        (state.uploadError
          ? Promise.reject(state.uploadError)
          : Promise.resolve()),
    );
    readonly options: unknown;
    constructor(endpoint: string, credential: unknown, options?: unknown) {
      this.endpoint = endpoint;
      this.credential = credential;
      this.options = options;
      clients.push(this);
    }
  }
  return { clients, credentials, FakeCredential, FakeLogsClient, state };
});

type FakeLogsClient = InstanceType<typeof azure.FakeLogsClient>;

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: azure.FakeCredential,
}));
vi.mock('@azure/monitor-ingestion', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LogsIngestionClient: azure.FakeLogsClient,
}));

function validSettings(
  overrides: Partial<LogAnalyticsSettings> = {},
): LogAnalyticsSettings {
  return {
    clientId: 'cid',
    clientSecret: 'csec',
    tenantId: 'tid',
    dce: 'https://dce.example.com',
    dcrImmutableId: 'dcr-123',
    dcrAggregateStream: 'agg-stream',
    dcrFailureStream: 'fail-stream',
    dcrSmtpTlsStream: 'tls-stream',
    ...overrides,
  };
}

function results(
  overrides: Partial<Record<keyof LogAnalyticsResults, object[]>> = {},
): LogAnalyticsResults {
  return {
    aggregateReports: [],
    failureReports: [],
    smtpTlsReports: [],
    ...overrides,
  } as LogAnalyticsResults;
}

function lastLogsClient(): FakeLogsClient {
  const logsClient = azure.clients.at(-1);
  if (!logsClient) {
    throw new Error('no LogsIngestionClient created');
  }
  return logsClient;
}

async function publishWith(
  reports: LogAnalyticsResults,
  flags: { aggregate?: boolean; failure?: boolean; smtpTls?: boolean } = {},
  settings: LogAnalyticsSettings = validSettings(),
): Promise<FakeLogsClient> {
  await new LogAnalyticsClient(settings).publishResults(
    reports,
    flags.aggregate ?? true,
    flags.failure ?? true,
    flags.smtpTls ?? true,
  );
  return lastLogsClient();
}

beforeEach(() => {
  azure.clients.length = 0;
  azure.credentials.length = 0;
  azure.state.uploadError = null;
});

describe('LogAnalyticsConfig', () => {
  // A typo on any attribute would silently drop data into the wrong stream.
  it('stores every field', () => {
    const config = new LogAnalyticsConfig(validSettings());
    expect({ ...config }).toEqual(validSettings());
  });
});

describe('LogAnalyticsClient init', () => {
  // Validation guards against a half-configured deployment that would fail
  // late inside the Azure SDK with confusing errors.
  it('accepts a complete config', () => {
    const client = new LogAnalyticsClient(validSettings());
    expect(client.conf.clientId).toBe('cid');
    expect(client.conf.dcrImmutableId).toBe('dcr-123');
  });

  it.each([
    'clientId',
    'clientSecret',
    'tenantId',
    'dce',
    'dcrImmutableId',
  ] as const)('raises when %s is missing', key => {
    expect(() => new LogAnalyticsClient(validSettings({ [key]: '' }))).toThrow(
      new LogAnalyticsException(
        'Invalid configuration. One or more required settings are missing.',
      ),
    );
  });

  it('accepts missing stream names', () => {
    expect(
      () =>
        new LogAnalyticsClient(
          validSettings({
            dcrAggregateStream: '',
            dcrFailureStream: '',
            dcrSmtpTlsStream: '',
          }),
        ),
    ).not.toThrow();
  });
});

describe('publishJson', () => {
  // Wraps upload and translates Azure upload errors to the module's own
  // exception type, so the CLI reports them uniformly.
  it('forwards to the logs client', async () => {
    const client = new LogAnalyticsClient(validSettings());
    const logsClient = new azure.FakeLogsClient('x', null);
    await client.publishJson([{ a: 1 }], logsClient, 'agg-stream');
    expect(logsClient.upload).toHaveBeenCalledExactlyOnceWith(
      'dcr-123',
      'agg-stream',
      [{ a: 1 }],
    );
  });

  it('translates an upload error with the first cause', async () => {
    const client = new LogAnalyticsClient(validSettings());
    const logsClient = new azure.FakeLogsClient('x', null);
    logsClient.upload.mockRejectedValue(
      new AggregateLogsUploadError([
        { failedLogs: [{ a: 1 }], cause: new Error('forbidden') },
        { failedLogs: [{ a: 2 }], cause: new Error('later') },
      ]),
    );
    await expect(
      client.publishJson([{ a: 1 }], logsClient, 'stream'),
    ).rejects.toThrow(new LogAnalyticsException('Upload failed: forbidden'));
  });

  it('translates an HTTP RestError', async () => {
    const client = new LogAnalyticsClient(validSettings());
    const logsClient = new azure.FakeLogsClient('x', null);
    const restError = Object.assign(new Error('Status code 403'), {
      name: 'RestError',
    });
    logsClient.upload.mockRejectedValue(restError);
    await expect(
      client.publishJson([{ a: 1 }], logsClient, 'stream'),
    ).rejects.toThrow(
      new LogAnalyticsException('Upload failed: Status code 403'),
    );
  });

  it('lets other errors through', async () => {
    const client = new LogAnalyticsClient(validSettings());
    const logsClient = new azure.FakeLogsClient('x', null);
    const error = new TypeError('bad input');
    logsClient.upload.mockRejectedValue(error);
    await expect(
      client.publishJson([{ a: 1 }], logsClient, 'stream'),
    ).rejects.toBe(error);
  });
});

describe('publishResults', () => {
  // Each report type is gated by its save flag and a configured stream.
  it('publishes aggregate reports to the aggregate stream in snake_case', async () => {
    const logs = captureLogs();
    try {
      const logsClient = await publishWith(
        results({
          aggregateReports: [
            { reportMetadata: { orgName: 'a' } } as unknown as AggregateReport,
          ],
        }),
      );
      expect(logsClient.upload).toHaveBeenCalledExactlyOnceWith(
        'dcr-123',
        'agg-stream',
        [{ report_metadata: { org_name: 'a' } }],
      );
      expect(logs.output).toEqual([
        'INFO:tsdmarc:Publishing aggregate reports.',
        'INFO:tsdmarc:Successfully pushed aggregate reports.',
      ]);
    } finally {
      logs.restore();
    }
  });

  it('publishes failure reports to the failure stream', async () => {
    const logsClient = await publishWith(
      results({
        failureReports: [{ reportedDomain: 'f' } as unknown as FailureReport],
      }),
    );
    expect(logsClient.upload).toHaveBeenCalledExactlyOnceWith(
      'dcr-123',
      'fail-stream',
      [{ reported_domain: 'f' }],
    );
  });

  it('publishes SMTP TLS reports to the SMTP TLS stream', async () => {
    const logsClient = await publishWith(
      results({
        smtpTlsReports: [{ organizationName: 't' } as unknown as SMTPTLSReport],
      }),
    );
    expect(logsClient.upload).toHaveBeenCalledExactlyOnceWith(
      'dcr-123',
      'tls-stream',
      [{ organization_name: 't' }],
    );
  });

  it('publishes all three together', async () => {
    const logsClient = await publishWith(
      results({
        aggregateReports: [{}],
        failureReports: [{}],
        smtpTlsReports: [{}],
      }),
    );
    expect(logsClient.upload).toHaveBeenCalledTimes(3);
    expect(logsClient.upload.mock.calls.map(call => call[1])).toEqual([
      'agg-stream',
      'fail-stream',
      'tls-stream',
    ]);
  });

  it('skips aggregate reports with saveAggregate false', async () => {
    const logsClient = await publishWith(results({ aggregateReports: [{}] }), {
      aggregate: false,
    });
    expect(logsClient.upload).not.toHaveBeenCalled();
  });

  it('skips failure reports with saveFailure false', async () => {
    const logsClient = await publishWith(results({ failureReports: [{}] }), {
      failure: false,
    });
    expect(logsClient.upload).not.toHaveBeenCalled();
  });

  it('skips SMTP TLS reports with saveSmtpTls false', async () => {
    const logsClient = await publishWith(results({ smtpTlsReports: [{}] }), {
      smtpTls: false,
    });
    expect(logsClient.upload).not.toHaveBeenCalled();
  });

  it('publishes nothing for empty results', async () => {
    const logsClient = await publishWith(results());
    expect(logsClient.upload).not.toHaveBeenCalled();
  });

  it('skips a report type whose stream is not configured', async () => {
    // A single client handles whatever streams are set.
    const logsClient = await publishWith(
      results({ aggregateReports: [{}] }),
      {},
      validSettings({ dcrAggregateStream: '' }),
    );
    expect(logsClient.upload).not.toHaveBeenCalled();
  });

  it('builds the credential from the config', async () => {
    // A rename or order shuffle would authenticate as the wrong principal.
    await publishWith(results());
    expect(azure.credentials).toEqual([
      ['tid', 'cid', 'csec', { additionalPolicies: [expect.any(Object)] }],
    ]);
  });

  // azure-core (Python) times requests out after 300 s; the JS pipeline has
  // no default, so a stalled DCE or token endpoint would hang forever.
  it("gives every request azure-core's 300 s timeout", async () => {
    const logsClient = await publishWith(results());
    type Policy = {
      position: string;
      policy: {
        sendRequest: (
          request: { timeout: number },
          next: (request: { timeout: number }) => Promise<unknown>,
        ) => Promise<unknown>;
      };
    };
    const clientPolicies = (
      logsClient.options as { additionalPolicies: Policy[] }
    ).additionalPolicies;
    const credentialOptions = azure.credentials[0]?.[3] as
      | { additionalPolicies: Policy[] }
      | undefined;
    const credentialPolicies = credentialOptions?.additionalPolicies ?? [];
    for (const policies of [clientPolicies, credentialPolicies]) {
      expect(policies).toHaveLength(1);
      const [entry] = policies;
      // perRetry: each retry attempt gets its own timeout.
      expect(entry?.position).toBe('perRetry');
      const sent: number[] = [];
      const next = (request: { timeout: number }): Promise<unknown> => {
        sent.push(request.timeout);
        return Promise.resolve({});
      };
      await entry?.policy.sendRequest({ timeout: 0 }, next);
      // An explicit per-request timeout is kept.
      await entry?.policy.sendRequest({ timeout: 5000 }, next);
      expect(sent).toEqual([300_000, 5000]);
    }
  });

  it('builds the logs client from the DCE and the credential', async () => {
    const logsClient = await publishWith(results());
    expect(azure.clients).toHaveLength(1);
    expect(logsClient.endpoint).toBe('https://dce.example.com');
    expect(logsClient.credential).toBeInstanceOf(azure.FakeCredential);
  });

  it('raises LogAnalyticsException when an upload fails', async () => {
    azure.state.uploadError = new AggregateLogsUploadError([
      { failedLogs: [], cause: new Error('denied') },
    ]);
    await expect(
      publishWith(results({ aggregateReports: [{}] })),
    ).rejects.toThrow(new LogAnalyticsException('Upload failed: denied'));
  });
});

describe('reports past the service limit', () => {
  const oversized = (id: string): object => ({
    reportId: id,
    sample: 'x'.repeat(1_000_001),
  });
  const logsClient = (): FakeLogsClient => {
    const [client] = azure.clients;
    if (!client) {
      throw new Error('no logs client');
    }
    return client;
  };

  beforeEach(() => {
    azure.clients.length = 0;
    azure.state.uploadError = null;
  });

  afterEach(() => {
    azure.state.upload = null;
  });

  it('leaves an oversized report out and uploads the rest', async () => {
    const client = new LogAnalyticsClient(validSettings());
    const capture = captureLogs();
    try {
      await client.publishResults(
        results({
          smtpTlsReports: [oversized('big\nforged'), { reportId: 'ok' }],
        }),
        true,
        true,
        true,
      );
    } finally {
      capture.restore();
    }
    const uploads = logsClient().upload.mock.calls;
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.[2]).toEqual([{ report_id: 'ok' }]);
    expect(capture.output.join('\n')).toContain(
      'Report big\\nforged not sent to Log Analytics',
    );
  });

  it('skips the upload when every report is oversized', async () => {
    const client = new LogAnalyticsClient(validSettings());
    const uploader = { upload: vi.fn(() => Promise.resolve()) };
    await client.publishJson(
      [{ report_id: 'x', sample: 'x'.repeat(1_000_001) }],
      uploader,
      'stream',
    );
    expect(uploader.upload).not.toHaveBeenCalled();
  });

  it('counts a report of exactly the limit as sendable', async () => {
    const client = new LogAnalyticsClient(validSettings());
    const uploader = { upload: vi.fn(() => Promise.resolve()) };
    const padding = 1_000_000 - JSON.stringify({ a: '' }).length;
    await client.publishJson([{ a: 'x'.repeat(padding) }], uploader, 'stream');
    expect(uploader.upload).toHaveBeenCalledTimes(1);
  });

  it('still publishes the other streams when one fails', async () => {
    const client = new LogAnalyticsClient(validSettings());
    const failure = new Error('boom');
    const uploads: string[] = [];
    azure.state.upload = (stream: string): Promise<void> => {
      uploads.push(stream);
      return stream === 'agg-stream'
        ? Promise.reject(failure)
        : Promise.resolve();
    };
    await expect(
      client.publishResults(
        results({
          aggregateReports: [{}],
          failureReports: [{}],
          smtpTlsReports: [{}],
        }),
        true,
        true,
        true,
      ),
    ).rejects.toBe(failure);
    expect(uploads).toEqual(['agg-stream', 'fail-stream', 'tls-stream']);
  });

  it('reports every failed stream together', async () => {
    const client = new LogAnalyticsClient(validSettings());
    azure.state.upload = (stream: string): Promise<void> =>
      Promise.reject(new Error(`bad ${stream}`));
    const error: unknown = await client
      .publishResults(
        results({ aggregateReports: [{}], smtpTlsReports: [{}] }),
        true,
        true,
        true,
      )
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LogAnalyticsException);
    expect((error as Error).message).toBe('bad agg-stream; bad tls-stream');
  });
});

describe('integers beyond 2^53', () => {
  it('uploads counts the SDK can serialize, exactly like Python', async () => {
    const logsClient = await publishWith(
      results({
        aggregateReports: [
          {
            records: [{ count: 99_999_999_999_999_999_999n }],
          } as unknown as AggregateReport,
        ],
      }),
    );
    const logs = logsClient.upload.mock.calls[0]?.[2];
    // The SDK serializes (and sizes its chunks) with JSON.stringify().
    expect(JSON.stringify(logs)).toBe(
      '[{"records":[{"count":99999999999999999999}]}]',
    );
  });
});
