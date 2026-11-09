// Loading the optional @azure/identity-cache-persistence plugin: "not
// installed" and "installed but broken" are told apart.

import { describe, expect, it, vi } from 'vitest';

import { isPluginMissing, loadCachePersistence } from './cache-persistence';

const identity = vi.hoisted(() => ({ plugins: [] as unknown[] }));

vi.mock('@azure/identity', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIdentityPlugin: (plugin: unknown): void => {
    identity.plugins.push(plugin);
  },
}));

const SPECIFIER = '@azure/identity-cache-persistence';

function notFound(specifier: string): Error {
  return Object.assign(
    new Error(`Cannot find package '${specifier}' imported from /app/x.js`),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );
}

describe('loadCachePersistence', () => {
  it('registers the plugin', async () => {
    const plugin = (): void => undefined;
    const status = await loadCachePersistence(() =>
      Promise.resolve({ cachePersistencePlugin: plugin }),
    );
    expect(status).toEqual({ status: 'enabled' });
    expect(identity.plugins).toContain(plugin);
  });

  it('reports a missing package', async () => {
    const status = await loadCachePersistence(() =>
      Promise.reject(notFound(SPECIFIER)),
    );
    expect(status).toEqual({ status: 'missing' });
  });

  it('reports a missing dependency of the plugin as a failure', async () => {
    const error = notFound('@azure/msal-node-extensions');
    const status = await loadCachePersistence(() => Promise.reject(error));
    expect(status).toEqual({ status: 'failed', error });
  });

  it('reports a native module that fails to load', async () => {
    const error = new Error('keytar.node: invalid ELF header');
    const status = await loadCachePersistence(() => Promise.reject(error));
    expect(status).toEqual({ status: 'failed', error });
  });

  it('reports a module without the plugin export', async () => {
    const status = await loadCachePersistence(() => Promise.resolve({}));
    expect(status.status).toBe('failed');
  });
});

describe('isPluginMissing', () => {
  it('accepts CommonJS-style errors too', () => {
    const error = Object.assign(
      new Error(`Cannot find module '${SPECIFIER}'`),
      { code: 'MODULE_NOT_FOUND' },
    );
    expect(isPluginMissing(error, SPECIFIER)).toBe(true);
    expect(isPluginMissing('nope', SPECIFIER)).toBe(false);
  });
});
