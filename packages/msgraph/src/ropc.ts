// Username/password (OAuth 2.0 ROPC) credential, the counterpart of Python
// azure-identity's `UsernamePasswordCredential` as mailsuite builds it.
//
// mailsuite passes `client_credential=client_secret`, so MSAL runs the flow
// as a *confidential* client (the secret goes in the token request) when a
// secret is given, and as a public client otherwise. @azure/identity for
// Node only has the public-client flow and no `authenticate()`, so the token
// requests are made here with `fetch`, with the same parameters MSAL sends.
//
// Behavior kept from Python (`InteractiveCredential` with
// `disable_automatic_authentication=True`):
// - `authenticate()` always signs in with the password and returns the
//   `AuthenticationRecord` that mailsuite saves in `token_file`.
// - `getToken()` only works silently: a cached access token, or a refresh
//   with the refresh token. Without a prior `authenticate()`, or when the
//   refresh fails, it throws `AuthenticationRequiredError`.
// - A saved AuthenticationRecord is ignored (Python's credential drops the
//   `authentication_record` argument).

import {
  type AccessToken,
  type AuthenticationRecord,
  type GetTokenOptions,
  type TokenCredential,
  AuthenticationError,
  AuthenticationRequiredError,
} from '@azure/identity';

/** azure-identity's default authority host (`AzureAuthorityHosts.AzurePublicCloud`). */
export const DEFAULT_AUTHORITY_HOST = 'https://login.microsoftonline.com';

/** MSAL adds these to every user sign-in (`OIDC_DEFAULT_SCOPES`). */
const OIDC_SCOPES = ['openid', 'profile', 'offline_access'] as const;

/** MSAL treats an access token expiring within 5 minutes as expired. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const SECONDS_TO_MS = 1000;

/** `AuthenticationRecord` format version written by azure-identity (Python and JS). */
const AUTH_RECORD_VERSION = '1.0';

/** Default timeout for token requests, in seconds. */
export const DEFAULT_TOKEN_REQUEST_TIMEOUT = 100;

export interface UsernamePasswordCredentialOptions {
  /** Tenant id or domain. Default: `"organizations"`, like Python. */
  tenantId?: string;
  clientId: string;
  /** Client secret: makes the request as a confidential client. */
  clientSecret?: string | null;
  username: string;
  password: string;
  /**
   * Authority host. Default: `AZURE_AUTHORITY_HOST` or
   * `https://login.microsoftonline.com`, like azure-identity.
   */
  authorityHost?: string;
  /** Timeout for each token request, in seconds. Default: 100. */
  timeout?: number;
  /** `fetch` implementation. Default: the global `fetch`. */
  fetch?: typeof fetch;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  id_token?: string;
  client_info?: string;
  error?: string;
  error_description?: string;
}

interface CachedToken {
  token: string;
  expiresOnTimestamp: number;
}

function decodeBase64UrlJson(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(
    Buffer.from(value, 'base64url').toString('utf8'),
  );
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new TypeError('not a JSON object');
  }
  return decoded as Record<string, unknown>;
}

function claim(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== 'string') {
    throw new TypeError(`missing claim ${name}`);
  }
  return value;
}

/**
 * Build an AuthenticationRecord from a token response, like Python's
 * `_build_auth_record` (the id token is not verified, as in MSAL: it came
 * straight from the token endpoint over TLS).
 */
export function buildAuthRecord(response: TokenResponse): AuthenticationRecord {
  try {
    const payload = response.id_token?.split('.')[1];
    if (payload === undefined) {
      throw new TypeError('no id token');
    }
    const idToken = decodeBase64UrlJson(payload);
    let homeAccountId: string;
    if (response.client_info === undefined) {
      // MSAL uses the subject claim when the STS doesn't send client_info.
      homeAccountId = claim(idToken, 'sub');
    } else {
      const clientInfo = decodeBase64UrlJson(response.client_info);
      homeAccountId = `${String(clientInfo.uid)}.${String(clientInfo.utid)}`;
    }
    // "iss" is the URL of the issuing tenant, e.g. https://authority/tenant
    const issuer = new URL(claim(idToken, 'iss'));
    const tid = idToken.tid;
    const tenantId =
      typeof tid === 'string' && tid
        ? tid
        : issuer.pathname.replaceAll(/^\/+|\/+$/gu, '');
    // Microsoft Entra ID returns "preferred_username", ADFS returns "upn".
    const preferred = idToken.preferred_username;
    const username =
      typeof preferred === 'string' && preferred
        ? preferred
        : claim(idToken, 'upn');
    return {
      authority: issuer.host,
      clientId: claim(idToken, 'aud'),
      homeAccountId,
      tenantId,
      username,
      version: AUTH_RECORD_VERSION,
    } as AuthenticationRecord;
  } catch (error) {
    throw new AuthenticationError(
      400,
      {
        error: 'invalid_id_token',
        error_description:
          'Failed to build AuthenticationRecord from unexpected identity token',
      },
      { cause: error },
    );
  }
}

/** A ROPC credential with Python's confidential-client support. */
export class UsernamePasswordCredential implements TokenCredential {
  readonly #options: UsernamePasswordCredentialOptions;
  readonly #tokenUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #accessTokens = new Map<string, CachedToken>();
  #refreshToken: string | null = null;
  #authRecord: AuthenticationRecord | null = null;

  constructor(options: UsernamePasswordCredentialOptions) {
    this.#options = options;
    const host = (
      options.authorityHost ??
      process.env.AZURE_AUTHORITY_HOST ??
      DEFAULT_AUTHORITY_HOST
    ).replace(/\/+$/u, '');
    const authority = new URL(host);
    if (authority.protocol !== 'https:') {
      throw new Error('The authority host must use https');
    }
    const tenant = encodeURIComponent(options.tenantId ?? 'organizations');
    this.#tokenUrl = `${authority.origin}/${tenant}/oauth2/v2.0/token`;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs =
      (options.timeout ?? DEFAULT_TOKEN_REQUEST_TIMEOUT) * SECONDS_TO_MS;
  }

  /** The record from the last sign-in, or `null`. */
  get authenticationRecord(): AuthenticationRecord | null {
    return this.#authRecord;
  }

  /** Sign in with the username and password (Python's `authenticate()`). */
  async authenticate(scopes: string | string[]): Promise<AuthenticationRecord> {
    const scopeList = typeof scopes === 'string' ? [scopes] : scopes;
    const response = await this.#requestToken(scopeList, {
      grant_type: 'password',
      username: this.#options.username,
      password: this.#options.password,
    });
    // This may be the first sign-in, or the user may have changed.
    this.#authRecord = buildAuthRecord(response);
    this.#accessTokens.clear();
    this.#store(scopeList, response);
    return this.#authRecord;
  }

  async getToken(
    scopes: string | string[],
    options?: GetTokenOptions,
  ): Promise<AccessToken> {
    const scopeList = typeof scopes === 'string' ? [scopes] : scopes;
    if (scopeList.length === 0) {
      throw new Error("'getToken' requires at least one scope");
    }
    const key = scopeKey(scopeList);
    const cached = this.#accessTokens.get(key);
    if (
      cached !== undefined &&
      cached.expiresOnTimestamp - EXPIRY_MARGIN_MS > Date.now()
    ) {
      return cached;
    }
    const refreshToken = this.#refreshToken;
    if (this.#authRecord === null || refreshToken === null) {
      throw new AuthenticationRequiredError({
        scopes: scopeList,
        ...(options ? { getTokenOptions: options } : {}),
        message:
          'Automatic authentication is disabled; call authenticate() first',
      });
    }
    try {
      const response = await this.#requestToken(scopeList, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      return this.#store(scopeList, response);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw new AuthenticationRequiredError({
          scopes: scopeList,
          ...(options ? { getTokenOptions: options } : {}),
          message: error.message,
          cause: error,
        });
      }
      throw error;
    }
  }

  #store(scopes: string[], response: TokenResponse): CachedToken {
    const expiresIn = Number(response.expires_in);
    const token: CachedToken = {
      token: response.access_token ?? '',
      expiresOnTimestamp:
        Date.now() +
        (Number.isFinite(expiresIn) ? expiresIn : 0) * SECONDS_TO_MS,
    };
    this.#accessTokens.set(scopeKey(scopes), token);
    if (response.refresh_token) {
      this.#refreshToken = response.refresh_token;
    }
    return token;
  }

  async #requestToken(
    scopes: string[],
    grant: Record<string, string>,
  ): Promise<TokenResponse> {
    // Same parameters as MSAL's UsernamePasswordClient / RefreshTokenClient.
    const body = new URLSearchParams({
      client_id: this.#options.clientId,
      ...grant,
      scope: [...scopes, ...OIDC_SCOPES].join(' '),
      client_info: '1',
    });
    const secret = this.#options.clientSecret;
    if (secret !== null && secret !== undefined && secret !== '') {
      body.set('client_secret', secret);
    }
    const response = await this.#fetch(this.#tokenUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await response.text();
    let parsed: TokenResponse;
    try {
      parsed = JSON.parse(text) as TokenResponse;
    } catch {
      throw new AuthenticationError(response.status, text);
    }
    if (!response.ok || typeof parsed.access_token !== 'string') {
      throw new AuthenticationError(response.status, {
        error: parsed.error ?? 'invalid_response',
        error_description:
          parsed.error_description ??
          'The token endpoint returned no access token',
      });
    }
    return parsed;
  }
}

function scopeKey(scopes: string[]): string {
  return [...scopes].sort().join(' ');
}
