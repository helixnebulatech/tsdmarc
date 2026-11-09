// Credential construction for the Microsoft Graph backend, ported from
// mailsuite.mailbox.graph (`AuthMethod`, `_get_cache_args`, `_load_token`,
// `_cache_auth_record`, `_generate_credential`).
//
// Delegated flows store the `AuthenticationRecord` in `tokenFile`, in the
// same JSON format as Python's azure-identity. DeviceCode also loads it and
// persists the MSAL token cache (through `@azure/identity-cache-persistence`,
// the Node counterpart of Python's msal-extensions), so later runs sign in
// silently. UsernamePassword signs in with the password on every connect, as
// in Python, and keeps its tokens in memory (see `./ropc`).

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type AuthenticationRecord,
  ClientAssertionCredential,
  ClientCertificateCredential,
  ClientSecretCredential,
  DeviceCodeCredential,
  deserializeAuthenticationRecord,
  serializeAuthenticationRecord,
  type TokenCachePersistenceOptions,
  type TokenCredential,
} from '@azure/identity';
import { logger } from 'tsdmarc';

import { enableCachePersistence } from './cache-persistence';
import { UsernamePasswordCredential } from './ropc';

/** Authentication methods, by name (Python's `AuthMethod` enum). */
export const AuthMethod: {
  readonly DeviceCode: 1;
  readonly UsernamePassword: 2;
  readonly ClientSecret: 3;
  readonly Certificate: 4;
  readonly ClientAssertion: 5;
} = {
  DeviceCode: 1,
  UsernamePassword: 2,
  ClientSecret: 3,
  Certificate: 4,
  ClientAssertion: 5,
} as const;

export type AuthMethodName = keyof typeof AuthMethod;

/** Default token cache name. parsedmarc passes `"parsedmarc"`. */
export const DEFAULT_TOKEN_CACHE_NAME = 'mailsuite';

/** Returns a client assertion (a signed JWT) for ClientAssertion auth. */
export type ClientAssertionProvider = () => string | Promise<string>;

export interface CacheArgs {
  tokenCachePersistenceOptions?: TokenCachePersistenceOptions;
  authenticationRecord?: AuthenticationRecord;
}

export interface GenerateCredentialOptions {
  clientId?: string;
  clientSecret?: string | null;
  tenantId?: string;
  username?: string | null;
  password?: string | null;
  certificatePath?: string | null;
  certificatePassword?: string | Uint8Array | null;
  allowUnencryptedStorage?: boolean;
  cacheName?: string;
  clientAssertionProvider?: ClientAssertionProvider | null;
  /** Timeout of UsernamePassword token requests, in seconds. Default: 100. */
  timeout?: number;
  /** `fetch` for UsernamePassword token requests. Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** Contents of the token file, or `null` if it doesn't exist (`_load_token`). */
export async function loadToken(tokenPath: string): Promise<string | null> {
  if (!existsSync(tokenPath)) {
    return null;
  }
  return await readFile(tokenPath, 'utf8');
}

/** Save the AuthenticationRecord, creating parent directories (`_cache_auth_record`). */
export async function cacheAuthRecord(
  record: AuthenticationRecord,
  tokenPath: string,
): Promise<void> {
  const token = serializeAuthenticationRecord(record);
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, token);
}

/**
 * Token cache persistence options plus the saved AuthenticationRecord, if
 * any (`_get_cache_args`). When `@azure/identity-cache-persistence` is not
 * installed or fails to load, tokens are only cached in memory and a warning
 * says which.
 */
export async function getCacheArgs(
  tokenPath: string,
  allowUnencryptedStorage: boolean,
  cacheName: string = DEFAULT_TOKEN_CACHE_NAME,
): Promise<CacheArgs> {
  const cacheArgs: CacheArgs = {};
  const persistence = await enableCachePersistence();
  if (persistence.status === 'enabled') {
    cacheArgs.tokenCachePersistenceOptions = {
      enabled: true,
      name: cacheName,
      unsafeAllowUnencryptedStorage: allowUnencryptedStorage,
    };
  } else if (persistence.status === 'missing') {
    logger.warning(
      'Install @azure/identity-cache-persistence to persist the Microsoft Graph token cache between runs; tokens are cached in memory only',
    );
  } else {
    const { error } = persistence;
    logger.warning(
      `Failed to load @azure/identity-cache-persistence (${error instanceof Error ? error.message : String(error)}); the Microsoft Graph token cache is kept in memory only`,
    );
  }
  const authRecord = await loadToken(tokenPath);
  if (authRecord) {
    cacheArgs.authenticationRecord =
      deserializeAuthenticationRecord(authRecord);
  }
  return cacheArgs;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) {
    // Python raises KeyError for a missing keyword argument.
    throw new TypeError(`${name} is required`);
  }
  return value;
}

/** Build the azure-identity credential for an auth method (`_generate_credential`). */
export async function generateCredential(
  authMethod: string,
  tokenPath: string,
  options: GenerateCredentialOptions = {},
): Promise<TokenCredential> {
  const cacheName = options.cacheName ?? DEFAULT_TOKEN_CACHE_NAME;
  if (authMethod === 'DeviceCode') {
    return new DeviceCodeCredential({
      clientId: required(options.clientId, 'client_id'),
      disableAutomaticAuthentication: true,
      tenantId: required(options.tenantId, 'tenant_id'),
      ...(await getCacheArgs(
        tokenPath,
        options.allowUnencryptedStorage ?? false,
        cacheName,
      )),
    });
  }
  if (authMethod === 'UsernamePassword') {
    // Python's UsernamePasswordCredential: a confidential client when a
    // client secret is given (`client_credential`), the "organizations"
    // tenant, no automatic sign-in. Python reads and parses token_file here
    // and then drops the record, so only a malformed file has an effect.
    const savedRecord = await loadToken(tokenPath);
    if (savedRecord) {
      deserializeAuthenticationRecord(savedRecord);
    }
    return new UsernamePasswordCredential({
      clientId: required(options.clientId, 'client_id'),
      clientSecret: options.clientSecret ?? null,
      username: required(options.username ?? undefined, 'username'),
      password: required(options.password ?? undefined, 'password'),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  if (authMethod === 'ClientAssertion') {
    const provider = options.clientAssertionProvider;
    if (provider === null || provider === undefined) {
      throw new Error(
        "client_assertion or client_assertion_provider is required when auth_method is 'ClientAssertion'",
      );
    }
    return new ClientAssertionCredential(
      required(options.tenantId, 'tenant_id'),
      required(options.clientId, 'client_id'),
      async () => await provider(),
    );
  }
  if (authMethod === 'ClientSecret') {
    return new ClientSecretCredential(
      required(options.tenantId, 'tenant_id'),
      required(options.clientId, 'client_id'),
      required(options.clientSecret ?? undefined, 'client_secret'),
    );
  }
  if (authMethod === 'Certificate') {
    const certificatePath = options.certificatePath;
    if (!certificatePath) {
      throw new Error(
        "certificate_path is required when auth_method is 'Certificate'",
      );
    }
    const password = options.certificatePassword;
    return new ClientCertificateCredential(
      required(options.tenantId, 'tenant_id'),
      required(options.clientId, 'client_id'),
      {
        certificatePath,
        ...(password === null || password === undefined
          ? {}
          : {
              certificatePassword:
                typeof password === 'string'
                  ? password
                  : new TextDecoder().decode(password),
            }),
      },
    );
  }
  throw new Error(`Auth method ${authMethod} not found`);
}

/** App-only methods; the others are delegated (a signed-in user). */
export function isAppOnlyAuthMethod(authMethod: string): boolean {
  return (
    authMethod === 'ClientSecret' ||
    authMethod === 'Certificate' ||
    authMethod === 'ClientAssertion'
  );
}
