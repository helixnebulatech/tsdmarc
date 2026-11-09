// Node equivalent of google_auth_oauthlib's InstalledAppFlow, used by the
// Gmail backend's "installed_app" auth mode. Python's
// `flow.run_local_server()` starts a loopback HTTP server, prints the
// authorization URL, waits for Google's redirect, checks `state` and
// exchanges the code (with PKCE) for tokens. google-auth-library has no
// such helper, so it is implemented here.

import { spawn } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { getLogger, logger, sanitizeForLog } from 'tsdmarc';

import { AuthorizedUserCredentials } from './credentials';

/** The `installed` (or `web`) section of a Google client secrets file. */
export interface ClientConfig {
  client_id: string;
  client_secret?: string;
  auth_uri?: string;
  token_uri?: string;
  redirect_uris?: string[];
}

export interface RunLocalServerOptions {
  /** Hostname used in the redirect URI. Default: `localhost`. */
  host?: string;
  /** Address the server listens on. Default: `127.0.0.1` (loopback only). */
  bindAddr?: string;
  /** Port to listen on; `0` picks a free port. Default: `8080`. */
  port?: number;
  /** Open the URL in the default browser. Default: `true` (as in Python). */
  openBrowser?: boolean;
  /** Message printed with the URL (`{url}` is replaced). Empty: print nothing. */
  authorizationPromptMessage?: string;
  /** Text shown in the browser once the redirect is received. */
  successMessage?: string;
  /** Seconds to wait for the redirect. `null`: wait forever (Python's default). */
  timeoutSeconds?: number | null;
  /** HTTP timeout for the token exchange, in milliseconds. Default: 60000. */
  requestTimeout?: number;
  /** `fetch` used for the token exchange (tests, proxies). */
  fetchImplementation?: typeof fetch;
  /** Where the prompt is printed. Default: `process.stdout`. */
  output?: { write: (text: string) => unknown };
  /** Called instead of the built-in browser launcher when `openBrowser` is true. */
  openUrl?: (url: string) => void;
}

/** Raised when no redirect arrives within `timeoutSeconds`. */
export class WSGITimeoutError extends Error {
  override name = 'WSGITimeoutError';
}

/** Raised when the redirect carries an error or no code. */
export class OAuthFlowError extends Error {
  override name = 'OAuthFlowError';
}

const DEFAULT_AUTH_PROMPT_MESSAGE =
  'Please visit this URL to authorize this application: {url}';
const DEFAULT_WEB_SUCCESS_MESSAGE =
  'The authentication flow has completed. You may close this window.';
const DEFAULT_AUTH_URI = 'https://accounts.google.com/o/oauth2/auth';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** google_auth_oauthlib.flow's module logger. */
const flowLogger = getLogger('google_auth_oauthlib.flow');
const MS_PER_SECOND = 1000;
// oauthlib's generate_token() and google_auth_oauthlib's code verifier.
const STATE_LENGTH = 30;
const STATE_CHARACTERS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_VERIFIER_LENGTH = 128;
const CODE_VERIFIER_CHARACTERS = `${STATE_CHARACTERS}-._~`;

function randomString(length: number, characters: string): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += characters[randomInt(characters.length)];
  }
  return value;
}

/** S256 PKCE challenge: unpadded base64url SHA-256 of the verifier. */
export function codeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * Read a client secrets file (`from_client_secrets_file`). Like
 * google_auth_oauthlib, accepts a `web` or `installed` client.
 */
export async function loadClientSecretsFile(
  clientSecretsFile: string,
): Promise<ClientConfig> {
  const parsed: unknown = JSON.parse(await readFile(clientSecretsFile, 'utf8'));
  const record = (parsed ?? {}) as Record<string, unknown>;
  const section = (record.web ?? record.installed) as ClientConfig | undefined;
  if (typeof section !== 'object' || section === null) {
    throw new Error('Client secrets must be for a web or installed app.');
  }
  if (typeof section.client_id !== 'string') {
    throw new Error('Client secrets is not in the correct format.');
  }
  return section;
}

/** Launch the platform's URL opener, detached; failures are only logged. */
function openInBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', error => {
      logger.debug(`Could not open a browser: ${String(error)}`);
    });
    child.unref();
  } catch (error) {
    logger.debug(`Could not open a browser: ${String(error)}`);
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** The request's URL, or `null` when it can't be parsed (`GET //`). */
function requestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

/**
 * Wait for the OAuth redirect: the first `GET /` request with our `state`.
 * Anything else the local port receives (another process, a web page, the
 * favicon, a stale tab) gets a 4xx and is ignored, so it can't end the flow.
 */
function waitForRedirect(
  server: Server,
  state: string,
  successMessage: string,
  timeoutSeconds: number | null,
): Promise<URL> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    if (timeoutSeconds !== null) {
      timer = setTimeout(() => {
        reject(
          new WSGITimeoutError(
            'Timed out waiting for response from authorization server',
          ),
        );
      }, timeoutSeconds * MS_PER_SECOND);
    }
    // Stop the timer if the flow ends early (the server closes first).
    server.once('close', () => clearTimeout(timer));
    server.on('request', (request: IncomingMessage, response) => {
      const reply = (status: number, body: string): void => {
        response.writeHead(status, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end(body);
      };
      const url = requestUrl(request);
      if (url === null) {
        reply(400, 'Bad request');
        return;
      }
      if (request.method !== 'GET' || url.pathname !== '/') {
        reply(404, 'Not found');
        return;
      }
      if (url.searchParams.get('state') !== state) {
        reply(400, 'Bad request');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(successMessage);
      clearTimeout(timer);
      resolve(url);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/**
 * Run the installed-app OAuth flow with a loopback redirect server
 * (`InstalledAppFlow.run_local_server`). Returns the credentials to store
 * in the token file.
 */
export async function runLocalServer(
  clientConfig: ClientConfig,
  scopes: string[],
  options: RunLocalServerOptions = {},
): Promise<AuthorizedUserCredentials> {
  const host = options.host ?? 'localhost';
  const bindAddr = options.bindAddr ?? '127.0.0.1';
  const promptMessage =
    options.authorizationPromptMessage ?? DEFAULT_AUTH_PROMPT_MESSAGE;
  const successMessage = options.successMessage ?? DEFAULT_WEB_SUCCESS_MESSAGE;
  const output = options.output ?? process.stdout;
  const tokenUri = clientConfig.token_uri ?? DEFAULT_TOKEN_URI;

  const server = createServer();
  try {
    await listen(server, options.port ?? 8080, bindAddr);
    const { port } = server.address() as AddressInfo;
    const redirectUri = `http://${host}:${port}/`;

    const client = new OAuth2Client({
      clientId: clientConfig.client_id,
      clientSecret: clientConfig.client_secret,
      redirectUri,
      endpoints: {
        oauth2AuthBaseUrl: clientConfig.auth_uri ?? DEFAULT_AUTH_URI,
        oauth2TokenUrl: tokenUri,
      },
      transporterOptions: {
        timeout: options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
        retry: false,
        ...(options.fetchImplementation
          ? { fetchImplementation: options.fetchImplementation }
          : {}),
      },
    });
    const state = randomString(STATE_LENGTH, STATE_CHARACTERS);
    const codeVerifier = randomString(
      CODE_VERIFIER_LENGTH,
      CODE_VERIFIER_CHARACTERS,
    );
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      state,
      code_challenge: codeChallenge(codeVerifier),
      code_challenge_method: CodeChallengeMethod.S256,
    });

    const redirect = waitForRedirect(
      server,
      state,
      successMessage,
      options.timeoutSeconds ?? null,
    );
    // Awaited below; this only keeps an early failure from going unhandled.
    redirect.catch(() => undefined);
    if (options.openBrowser ?? true) {
      (options.openUrl ?? openInBrowser)(authUrl);
    }
    if (promptMessage) {
      const message = promptMessage.replace('{url}', authUrl);
      // Like run_local_server: logged on google_auth_oauthlib's own logger
      // (silent unless configured) and printed once. Logging it on the
      // library logger would show it twice on the CLI's console.
      flowLogger.info(message);
      output.write(`${message}\n`);
    }

    const response = await redirect;
    const error = response.searchParams.get('error');
    if (error) {
      // Query text ends up in logs through the caller.
      const description = response.searchParams.get('error_description');
      throw new OAuthFlowError(
        sanitizeForLog(
          description ? `(${error}) ${description}` : `(${error})`,
        ),
      );
    }
    const code = response.searchParams.get('code');
    if (!code) {
      throw new OAuthFlowError(
        '(invalid_request) Missing code parameter in response.',
      );
    }

    const { tokens } = await client.getToken({
      code,
      codeVerifier,
      redirect_uri: redirectUri,
    });
    if (!tokens.access_token) {
      throw new Error(
        'There is no access token for this session, did you call fetch_token?',
      );
    }
    return new AuthorizedUserCredentials({
      token: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenUri,
      clientId: clientConfig.client_id,
      clientSecret: clientConfig.client_secret ?? null,
      scopes,
      expiry:
        typeof tokens.expiry_date === 'number'
          ? new Date(tokens.expiry_date)
          : null,
    });
  } finally {
    await closeServer(server);
  }
}
