import { systemClock, type Clock } from '../engine/clock.js';

// Exchange Online refuses app passwords for IMAP, so Microsoft mailboxes sign in with OAuth2
// device code and then talk XOAUTH2 to IMAP and SMTP.
export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
export const MICROSOFT_SCOPE = 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface OAuthOptions {
  fetch?: typeof fetch;
  /** Replaces https://login.microsoftonline.com/common/oauth2/v2.0 (tests point it at a local server). */
  baseUrl?: string;
  clock?: Clock;
}
export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }
export interface TokenSet { accessToken: string; refreshToken: string; expiresAt: string }
export type DeviceTokenResult =
  | { status: 'waiting' | 'expired' | 'denied' }
  | ({ status: 'connected' } & TokenSet);

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

interface Raw { error?: string; error_description?: string; [key: string]: unknown }

async function post(path: string, form: Record<string, string>, opts: OAuthOptions): Promise<{ ok: boolean; body: Raw }> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${opts.baseUrl ?? MICROSOFT_AUTHORITY}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  let body: Raw = {};
  try {
    body = (await res.json()) as Raw;
  } catch {
    // A non-JSON body (a proxy error page) is reported through the status below.
  }
  return { ok: res.ok, body: res.ok || body.error ? body : { error: 'http_error', error_description: `Microsoft sign-in answered ${res.status}.` } };
}

function fail(body: Raw): never {
  throw new OAuthError(body.error ?? 'unknown', body.error_description ?? body.error ?? 'Microsoft sign-in failed.');
}

function tokenSet(body: Raw, previousRefresh: string | null, clock: Clock): TokenSet {
  const accessToken = body.access_token;
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : previousRefresh;
  const expiresIn = Number(body.expires_in);
  if (typeof accessToken !== 'string' || !refreshToken || !Number.isFinite(expiresIn)) {
    throw new OAuthError('invalid_response', 'Microsoft did not return a sign-in token.');
  }
  return { accessToken, refreshToken, expiresAt: new Date(clock.now().getTime() + expiresIn * 1000).toISOString() };
}

export async function startDeviceCode(clientId: string, opts: OAuthOptions = {}): Promise<DeviceCode> {
  const { ok, body } = await post('devicecode', { client_id: clientId, scope: MICROSOFT_SCOPE }, opts);
  if (!ok) fail(body);
  if (typeof body.device_code !== 'string' || typeof body.user_code !== 'string' || typeof body.verification_uri !== 'string') {
    throw new OAuthError('invalid_response', 'Microsoft did not return a sign-in code.');
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresIn: Number(body.expires_in),
    interval: Number(body.interval) || 5,
  };
}

export async function pollDeviceToken(clientId: string, deviceCode: string, opts: OAuthOptions = {}): Promise<DeviceTokenResult> {
  const { ok, body } = await post('token', { grant_type: DEVICE_GRANT, client_id: clientId, device_code: deviceCode }, opts);
  if (ok) return { status: 'connected', ...tokenSet(body, null, opts.clock ?? systemClock) };
  switch (body.error) {
    case 'authorization_pending':
    case 'slow_down':
      return { status: 'waiting' };
    case 'expired_token':
      return { status: 'expired' };
    case 'authorization_declined':
    case 'access_denied':
      return { status: 'denied' };
    default:
      return fail(body);
  }
}

export async function refreshAccessToken(clientId: string, refreshToken: string, opts: OAuthOptions = {}): Promise<TokenSet> {
  const { ok, body } = await post('token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, scope: MICROSOFT_SCOPE }, opts);
  if (!ok) fail(body);
  return tokenSet(body, refreshToken, opts.clock ?? systemClock);
}
