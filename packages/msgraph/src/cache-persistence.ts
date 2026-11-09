// Optional MSAL token cache persistence. `@azure/identity-cache-persistence`
// stores the cache in the OS keychain (or a plain file when unencrypted
// storage is allowed), like Python's msal-extensions. It pulls in native
// modules, so it is an optional peer dependency loaded on demand.

import { type IdentityPlugin, useIdentityPlugin } from '@azure/identity';

const PLUGIN_MODULE = '@azure/identity-cache-persistence';

/**
 * Outcome of loading the plugin: registered, not installed, or installed
 * but failed to load (e.g. a native module built for another platform).
 */
export type CachePersistenceStatus =
  | { status: 'enabled' }
  | { status: 'missing' }
  | { status: 'failed'; error: unknown };

let registration: Promise<CachePersistenceStatus> | null = null;

/** Whether `error` says the plugin package itself can't be resolved. */
export function isPluginMissing(error: unknown, specifier: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { code } = error as { code?: unknown };
  // A missing dependency *of* the plugin is a broken install, not "missing".
  return (
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
    error.message.includes(`'${specifier}'`)
  );
}

/** Import the plugin and register it with azure-identity. */
export async function loadCachePersistence(
  load: () => Promise<unknown> = () => import(PLUGIN_MODULE),
  specifier: string = PLUGIN_MODULE,
): Promise<CachePersistenceStatus> {
  let plugin: { cachePersistencePlugin?: IdentityPlugin };
  try {
    plugin = (await load()) as { cachePersistencePlugin?: IdentityPlugin };
  } catch (error) {
    return isPluginMissing(error, specifier)
      ? { status: 'missing' }
      : { status: 'failed', error };
  }
  try {
    if (typeof plugin.cachePersistencePlugin !== 'function') {
      throw new TypeError(`${specifier} has no cachePersistencePlugin export`);
    }
    useIdentityPlugin(plugin.cachePersistencePlugin);
    return { status: 'enabled' };
  } catch (error) {
    return { status: 'failed', error };
  }
}

/**
 * Register the cache persistence plugin with azure-identity once (the
 * result is memoized).
 */
export function enableCachePersistence(): Promise<CachePersistenceStatus> {
  registration ??= loadCachePersistence();
  return registration;
}
