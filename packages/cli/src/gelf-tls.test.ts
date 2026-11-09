// The `[gelf]` certificate options, a tsdmarc addition: GELF over TLS
// verifies the Graylog certificate against the system CAs by default
// (pygelf doesn't verify at all), `cafile` adds a CA bundle and
// `skip_certificate_verification = true` restores pygelf's behavior.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  type GelfClient,
  GelfTlsHandler,
  parseSmtpTlsReportJson,
  type SMTPTLSReport,
} from 'tsdmarc';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  type CertificateFiles,
  makeSelfSignedCertificate,
  nulFrames,
  type StreamServer,
  startTlsServer,
} from '../../tsdmarc/src/test/sockets';
import { parseConfig } from './config';
import { ConfigParser } from './configparser';
import { applyEnvOverrides } from './env';
import { type CliOptions, createOptions } from './options';
import {
  closeOutputClients,
  gelfClientOptions,
  initOutputClients,
} from './outputs';

async function parsedGelf(
  settings: Record<string, string>,
  env: NodeJS.ProcessEnv = {},
): Promise<CliOptions> {
  const config = new ConfigParser();
  config.addSection('gelf');
  for (const [key, value] of Object.entries(settings)) {
    config.set('gelf', key, value);
  }
  applyEnvOverrides(config, env);
  const opts = createOptions();
  await parseConfig(config, opts);
  return opts;
}

const TLS_GELF = { host: 'localhost', port: '12201', mode: 'tls' };

describe('[gelf] certificate options', () => {
  it('verifies against the system CAs by default', async () => {
    const opts = await parsedGelf(TLS_GELF);
    expect(opts.gelfCafile).toBeNull();
    expect(opts.gelfSkipCertificateVerification).toBe(false);
    expect(gelfClientOptions(opts)).toEqual({
      tls: { caCerts: null, validate: true },
    });
  });

  it('reads cafile (expanded) and skip_certificate_verification', async () => {
    const opts = await parsedGelf({
      ...TLS_GELF,
      cafile: '~/graylog-ca.pem',
      skip_certificate_verification: 'yes',
    });
    expect(opts.gelfCafile).toBe(path.join(homedir(), 'graylog-ca.pem'));
    expect(opts.gelfSkipCertificateVerification).toBe(true);
    expect(gelfClientOptions(opts)).toEqual({
      tls: {
        caCerts: path.join(homedir(), 'graylog-ca.pem'),
        validate: false,
      },
    });
  });

  it('rejects a skip_certificate_verification that is not a boolean', async () => {
    await expect(
      parsedGelf({ ...TLS_GELF, skip_certificate_verification: 'maybe' }),
    ).rejects.toThrow('Not a boolean: maybe');
  });

  it('takes both keys from TSDMARC_ and PARSEDMARC_ variables', async () => {
    const opts = await parsedGelf(TLS_GELF, {
      PARSEDMARC_GELF_CAFILE: '/etc/parsedmarc/ca.pem',
      TSDMARC_GELF_CAFILE: '/etc/tsdmarc/ca.pem',
      PARSEDMARC_GELF_SKIP_CERTIFICATE_VERIFICATION: 'true',
    });
    expect(opts.gelfCafile).toBe('/etc/tsdmarc/ca.pem');
    expect(opts.gelfSkipCertificateVerification).toBe(true);
    const tsdmarcOnly = await parsedGelf(TLS_GELF, {
      TSDMARC_GELF_SKIP_CERTIFICATE_VERIFICATION: 'false',
      PARSEDMARC_GELF_SKIP_CERTIFICATE_VERIFICATION: 'true',
    });
    expect(tsdmarcOnly.gelfSkipCertificateVerification).toBe(false);
  });

  it('ignores both keys unless mode = tls', async () => {
    const opts = await parsedGelf({
      host: 'localhost',
      port: '12201',
      mode: 'udp',
      cafile: '/etc/ca.pem',
      skip_certificate_verification: 'true',
    });
    expect(gelfClientOptions(opts)).toEqual({});
  });

  it('passes them to the GelfClient TLS handler', async () => {
    const opts = await parsedGelf({
      ...TLS_GELF,
      skip_certificate_verification: 'true',
    });
    const clients = await initOutputClients(opts);
    try {
      const client = clients.get('gelf_client') as GelfClient;
      expect(client.handler).toBeInstanceOf(GelfTlsHandler);
      expect((client.handler as GelfTlsHandler).tlsOptions).toMatchObject({
        rejectUnauthorized: false,
      });
    } finally {
      await closeOutputClients(clients);
    }
  });
});

describe('[gelf] against a local TLS server with a self-signed certificate', () => {
  let certificate: CertificateFiles;
  let report: SMTPTLSReport;
  const servers: StreamServer[] = [];

  beforeAll(() => {
    certificate = makeSelfSignedCertificate('localhost');
    report = parseSmtpTlsReportJson(
      readFileSync(
        new URL('../../../samples/smtp_tls/smtp_tls.json', import.meta.url),
      ),
    );
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()));
  });

  /** Sends one SMTP TLS report with the given `[gelf]` keys. */
  async function send(extra: Record<string, string>): Promise<StreamServer> {
    const server = await startTlsServer({
      cert: certificate.cert,
      key: certificate.key,
    });
    servers.push(server);
    const opts = await parsedGelf({
      ...TLS_GELF,
      port: String(server.port),
      ...extra,
    });
    const clients = await initOutputClients(opts);
    try {
      const client = clients.get('gelf_client') as GelfClient;
      await client.saveSmtpTlsReportToGelf(report);
    } finally {
      await closeOutputClients(clients);
    }
    return server;
  }

  it('refuses the certificate by default', async () => {
    await expect(send({})).rejects.toThrow('self-signed certificate');
    expect(servers[0]?.received()).toHaveLength(0);
  });

  it('trusts it with cafile', async () => {
    const server = await send({ cafile: certificate.certPath });
    const frames = nulFrames(await server.waitForBytes(1));
    expect(JSON.parse(frames[0] ?? '')).toMatchObject({
      short_message: 'parsedmarc smtptls report',
    });
  });

  it('accepts it with skip_certificate_verification = true', async () => {
    const server = await send({ skip_certificate_verification: 'true' });
    expect(nulFrames(await server.waitForBytes(1)).length).toBeGreaterThan(0);
  });
});
