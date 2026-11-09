// Port of the parts of google.oauth2.credentials.Credentials that the Gmail
// backend uses: reading and writing the authorized-user `token.json` in the
// exact format Python's google-auth uses, so a token file works with both
// mailsuite and tsdmarc.

import { readFile } from 'node:fs/promises';

import {
  type Credentials,
  OAuth2Client,
  type OAuth2ClientOptions,
} from 'google-auth-library';

/** Google's token endpoint; google-auth always uses it for authorized users. */
export const GOOGLE_OAUTH2_TOKEN_ENDPOINT =
  'https://oauth2.googleapis.com/token';

/** google-auth's REFRESH_THRESHOLD: a token this close to expiry is expired. */
const REFRESH_THRESHOLD_MS = 225_000;
const DEFAULT_UNIVERSE_DOMAIN = 'googleapis.com';
const REQUIRED_FIELDS = ['refresh_token', 'client_id', 'client_secret'];
const EXPIRY_FRACTION = /\..*$/u;
const TRAILING_Z = /Z+$/u;

export interface AuthorizedUserCredentialsFields {
  token: string | null;
  refreshToken: string | null;
  tokenUri?: string;
  clientId: string | null;
  clientSecret: string | null;
  scopes: string[] | null;
  /** Access token expiry (UTC instant). `null`: unknown, never expires. */
  expiry: Date | null;
  universeDomain?: string;
  account?: string;
}

/** Transport settings for the token endpoint (google-auth-library's gaxios). */
export type TransporterOptions = NonNullable<
  OAuth2ClientOptions['transporterOptions']
>;

/** Python's `datetime.isoformat()` of a naive UTC datetime, plus `Z`. */
function formatExpiry(expiry: Date): string {
  const iso = expiry.toISOString();
  const milliseconds = expiry.getUTCMilliseconds();
  const base = iso.slice(0, 'YYYY-MM-DDTHH:MM:SS'.length);
  if (milliseconds === 0) {
    return `${base}Z`;
  }
  return `${base}.${String(milliseconds * 1000).padStart(6, '0')}Z`;
}

/** google-auth's expiry parsing: drop `Z` and fractions, read as UTC. */
function parseExpiry(value: string): Date {
  const trimmed = value.replace(TRAILING_Z, '').replace(EXPIRY_FRACTION, '');
  const date = new Date(`${trimmed}Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `time data ${JSON.stringify(trimmed)} does not match format '%Y-%m-%dT%H:%M:%S'`,
    );
  }
  return date;
}

/** `json.dumps` with Python's default `", "` / `": "` separators. */
function pythonJsonDumps(value: Record<string, unknown>): string {
  const entries = Object.entries(value).map(([key, item]) => {
    const rendered = Array.isArray(item)
      ? `[${item.map(element => JSON.stringify(element)).join(', ')}]`
      : JSON.stringify(item);
    return `${JSON.stringify(key)}: ${rendered}`;
  });
  return `{${entries.join(', ')}}`;
}

/** google-auth-library's `GetTokenResponse` (not exported by the package). */
interface GetTokenResponse {
  tokens: Credentials;
  res: Awaited<ReturnType<OAuth2Client['transporter']['request']>> | null;
}

/** google-auth-library's own retry settings for token requests. */
const TOKEN_REQUEST_RETRY = {
  retry: true,
  retryConfig: {
    httpMethodsToRetry: ['GET', 'PUT', 'POST', 'HEAD', 'OPTIONS', 'DELETE'],
  },
};

/**
 * An OAuth2Client whose refresh-token grant also sends `scope`, like
 * google-auth's `reauth.refresh_grant()` (google-auth-library leaves it
 * out). Used for the explicit refresh and the automatic one before API calls.
 */
class ScopedRefreshOAuth2Client extends OAuth2Client {
  readonly #scope: string | undefined;

  constructor(options: OAuth2ClientOptions, scopes: string[] | null) {
    super(options);
    this.#scope = scopes?.length ? scopes.join(' ') : undefined;
  }

  protected override async refreshTokenNoCache(
    refreshToken?: string | null,
  ): Promise<GetTokenResponse> {
    if (!refreshToken) {
      throw new Error('No refresh token is set.');
    }
    const data = new URLSearchParams({ grant_type: 'refresh_token' });
    if (this._clientId) {
      data.set('client_id', this._clientId);
    }
    if (this._clientSecret) {
      data.set('client_secret', this._clientSecret);
    }
    data.set('refresh_token', refreshToken);
    if (this.#scope) {
      data.set('scope', this.#scope);
    }
    const res = await this.transporter.request<Credentials>({
      ...TOKEN_REQUEST_RETRY,
      method: 'POST',
      url: this.endpoints.oauth2TokenUrl.toString(),
      data,
    });
    const tokens: Credentials & { expires_in?: number } = res.data;
    if (tokens.expires_in) {
      tokens.expiry_date = Date.now() + tokens.expires_in * 1000;
      delete tokens.expires_in;
    }
    this.emit('tokens', tokens);
    return { tokens, res };
  }
}

/** OAuth 2.0 user credentials, as stored in the Gmail token file. */
export class AuthorizedUserCredentials {
  token: string | null;
  refreshToken: string | null;
  tokenUri: string;
  clientId: string | null;
  clientSecret: string | null;
  scopes: string[] | null;
  expiry: Date | null;
  universeDomain: string;
  account: string;

  constructor(fields: AuthorizedUserCredentialsFields) {
    this.token = fields.token;
    this.refreshToken = fields.refreshToken;
    this.tokenUri = fields.tokenUri ?? GOOGLE_OAUTH2_TOKEN_ENDPOINT;
    this.clientId = fields.clientId;
    this.clientSecret = fields.clientSecret;
    this.scopes = fields.scopes;
    this.expiry = fields.expiry;
    this.universeDomain = fields.universeDomain ?? DEFAULT_UNIVERSE_DOMAIN;
    this.account = fields.account ?? '';
  }

  /** `Credentials.from_authorized_user_info()`. */
  static fromAuthorizedUserInfo(
    info: Record<string, unknown>,
    scopes?: string[] | null,
  ): AuthorizedUserCredentials {
    const missing = REQUIRED_FIELDS.filter(field => !(field in info));
    if (missing.length > 0) {
      throw new Error(
        `Authorized user info was not in the expected format, missing fields ${missing.join(', ')}.`,
      );
    }
    const text = (key: string): string | null => {
      const value = info[key];
      return typeof value === 'string' ? value : null;
    };

    const expiryText = text('expiry');
    // A token saved without an expiry is treated as already expired.
    const expiry = expiryText
      ? parseExpiry(expiryText)
      : new Date(Date.now() - REFRESH_THRESHOLD_MS);

    let resolvedScopes = scopes ?? null;
    if (resolvedScopes === null && 'scopes' in info) {
      const stored = info.scopes;
      if (typeof stored === 'string') {
        resolvedScopes = stored.split(' ');
      } else if (Array.isArray(stored)) {
        resolvedScopes = stored.map(String);
      }
    }

    return new AuthorizedUserCredentials({
      token: text('token'),
      refreshToken: text('refresh_token'),
      // google-auth always overrides the stored token_uri.
      tokenUri: GOOGLE_OAUTH2_TOKEN_ENDPOINT,
      clientId: text('client_id'),
      clientSecret: text('client_secret'),
      scopes: resolvedScopes,
      expiry,
      universeDomain: text('universe_domain') ?? DEFAULT_UNIVERSE_DOMAIN,
      account: text('account') ?? '',
    });
  }

  /** `Credentials.from_authorized_user_file()`. */
  static async fromAuthorizedUserFile(
    filename: string,
    scopes?: string[] | null,
  ): Promise<AuthorizedUserCredentials> {
    const info: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (typeof info !== 'object' || info === null || Array.isArray(info)) {
      throw new Error(
        'Authorized user info was not in the expected format, missing fields refresh_token, client_id, client_secret.',
      );
    }
    return AuthorizedUserCredentials.fromAuthorizedUserInfo(
      info as Record<string, unknown>,
      scopes,
    );
  }

  /** The token is past (or within 3m45s of) its expiry. */
  get expired(): boolean {
    if (this.expiry === null) {
      return false;
    }
    return Date.now() >= this.expiry.getTime() - REFRESH_THRESHOLD_MS;
  }

  /** There is a token and it has not expired. */
  get valid(): boolean {
    return this.token !== null && !this.expired;
  }

  /** `Credentials.to_json()`: the token file contents. */
  toJson(): string {
    const prep: Record<string, unknown> = {
      token: this.token,
      refresh_token: this.refreshToken,
      token_uri: this.tokenUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scopes: this.scopes,
      universe_domain: this.universeDomain,
      account: this.account,
    };
    if (this.expiry !== null) {
      prep.expiry = formatExpiry(this.expiry);
    }
    // Like Python, drop entries that are None.
    for (const [key, value] of Object.entries(prep)) {
      if (value === null || value === undefined) {
        delete prep[key];
      }
    }
    return pythonJsonDumps(prep);
  }

  /** An OAuth2Client carrying these credentials; it refreshes them as needed. */
  toOAuth2Client(transporterOptions?: TransporterOptions): OAuth2Client {
    const client = new ScopedRefreshOAuth2Client(
      {
        clientId: this.clientId ?? undefined,
        clientSecret: this.clientSecret ?? undefined,
        endpoints: { oauth2TokenUrl: this.tokenUri },
        ...(transporterOptions ? { transporterOptions } : {}),
      },
      this.scopes,
    );
    client.setCredentials({
      access_token: this.token,
      refresh_token: this.refreshToken,
      expiry_date: this.expiry === null ? null : this.expiry.getTime(),
      scope: this.scopes?.join(' '),
      token_type: 'Bearer',
    });
    return client;
  }

  /** Get a new access token with the refresh token (`Credentials.refresh`). */
  async refresh(transporterOptions?: TransporterOptions): Promise<void> {
    if (!(this.refreshToken && this.clientId && this.clientSecret)) {
      throw new Error(
        'The credentials do not contain the necessary fields need to refresh the access token. You must specify refresh_token, token_uri, client_id, and client_secret.',
      );
    }
    const { credentials } =
      await this.toOAuth2Client(transporterOptions).refreshAccessToken();
    this.token = credentials.access_token ?? null;
    this.refreshToken = credentials.refresh_token ?? this.refreshToken;
    this.expiry =
      typeof credentials.expiry_date === 'number'
        ? new Date(credentials.expiry_date)
        : null;
  }
}
