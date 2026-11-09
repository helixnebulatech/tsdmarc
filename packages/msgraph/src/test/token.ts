// Token endpoint answers for the UsernamePassword (ROPC) tests.

/** Token endpoint path for the default "organizations" tenant. */
export const TOKEN_PATH = '/organizations/oauth2/v2.0/token';

export function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function fakeIdToken(claims: Record<string, unknown>): string {
  return `${base64Url({ alg: 'none' })}.${base64Url(claims)}.sig`;
}

export const ID_TOKEN_CLAIMS = {
  aud: 'cid',
  iss: 'https://login.microsoftonline.com/tenant-guid/v2.0',
  tid: 'tenant-guid',
  preferred_username: 'user@example.com',
  sub: 'subject',
};

export function tokenResponse(
  accessToken: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    token_type: 'Bearer',
    access_token: accessToken,
    refresh_token: `refresh-${accessToken}`,
    expires_in: 3600,
    id_token: fakeIdToken(ID_TOKEN_CLAIMS),
    client_info: base64Url({ uid: 'uid', utid: 'utid' }),
    ...extra,
  };
}
