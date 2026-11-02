import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../engine/clock.js';
import { MICROSOFT_SCOPE, OAuthError, pollDeviceToken, refreshAccessToken, startDeviceCode } from './microsoft-oauth.js';

// A local stand-in for login.microsoftonline.com that answers with Microsoft's real response shapes.
let server: Server;
let baseUrl: string;
const requests: Array<{ path: string; form: URLSearchParams }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', form: new URLSearchParams(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/common/oauth2/v2.0`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function respond(status: number, body: unknown) {
  reply = { status, body };
  requests.length = 0;
}
const clock = fixedClock('2026-11-02T10:00:00Z');

describe('startDeviceCode', () => {
  it('asks for the IMAP and SMTP scopes and returns the code to show', async () => {
    respond(200, {
      user_code: 'FJ4KQ9ZTX',
      device_code: 'DAQABAAEAAADe-device',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900,
      interval: 5,
      message: 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code FJ4KQ9ZTX to authenticate.',
    });
    const code = await startDeviceCode('client-1', { baseUrl });
    expect(code).toEqual({ deviceCode: 'DAQABAAEAAADe-device', userCode: 'FJ4KQ9ZTX', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900, interval: 5 });
    expect(requests[0]?.path).toBe('/common/oauth2/v2.0/devicecode');
    expect(requests[0]?.form.get('client_id')).toBe('client-1');
    expect(requests[0]?.form.get('scope')).toBe(MICROSOFT_SCOPE);
    expect(MICROSOFT_SCOPE).toBe('offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send');
  });

  it('throws the description Microsoft gives when the client id is unknown', async () => {
    respond(400, { error: 'invalid_request', error_description: "AADSTS700016: Application with identifier 'nope' was not found in the directory." });
    const failure = startDeviceCode('nope', { baseUrl });
    await expect(failure).rejects.toBeInstanceOf(OAuthError);
    await expect(failure).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('AADSTS700016') });
  });
});

describe('pollDeviceToken', () => {
  it('keeps waiting while the person has not finished', async () => {
    respond(400, { error: 'authorization_pending', error_description: 'AADSTS70016: Pending end-user authorization.' });
    expect(await pollDeviceToken('client-1', 'dev', { baseUrl })).toEqual({ status: 'waiting' });
    expect(requests[0]?.path).toBe('/common/oauth2/v2.0/token');
    expect(requests[0]?.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(requests[0]?.form.get('device_code')).toBe('dev');
    expect(requests[0]?.form.get('client_id')).toBe('client-1');
    respond(400, { error: 'slow_down' });
    expect(await pollDeviceToken('client-1', 'dev', { baseUrl })).toEqual({ status: 'waiting' });
  });

  it('reports expired and denied', async () => {
    respond(400, { error: 'expired_token' });
    expect(await pollDeviceToken('c', 'd', { baseUrl })).toEqual({ status: 'expired' });
    respond(400, { error: 'authorization_declined' });
    expect(await pollDeviceToken('c', 'd', { baseUrl })).toEqual({ status: 'denied' });
    respond(400, { error: 'access_denied' });
    expect(await pollDeviceToken('c', 'd', { baseUrl })).toEqual({ status: 'denied' });
  });

  it('returns the tokens and when the access token runs out', async () => {
    respond(200, { token_type: 'Bearer', scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send', expires_in: 3599, ext_expires_in: 3599, access_token: 'access-1', refresh_token: 'refresh-1' });
    expect(await pollDeviceToken('c', 'd', { baseUrl, clock })).toEqual({
      status: 'connected',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: '2026-11-02T10:59:59.000Z',
    });
  });

  it('throws on a failure that is not part of the dance', async () => {
    respond(400, { error: 'invalid_client', error_description: 'AADSTS7000218: The request body must contain client_assertion or client_secret.' });
    await expect(pollDeviceToken('c', 'd', { baseUrl })).rejects.toMatchObject({ code: 'invalid_client' });
  });
});

describe('refreshAccessToken', () => {
  it('trades the refresh token for a new pair', async () => {
    respond(200, { token_type: 'Bearer', scope: 'x', expires_in: 3600, access_token: 'access-2', refresh_token: 'refresh-2' });
    expect(await refreshAccessToken('client-1', 'refresh-1', { baseUrl, clock })).toEqual({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: '2026-11-02T11:00:00.000Z' });
    expect(requests[0]?.form.get('grant_type')).toBe('refresh_token');
    expect(requests[0]?.form.get('refresh_token')).toBe('refresh-1');
    expect(requests[0]?.form.get('client_id')).toBe('client-1');
    expect(requests[0]?.form.get('scope')).toBe(MICROSOFT_SCOPE);
  });

  it('keeps the old refresh token when Microsoft does not rotate it', async () => {
    respond(200, { token_type: 'Bearer', expires_in: 3600, access_token: 'access-3' });
    expect((await refreshAccessToken('c', 'refresh-1', { baseUrl, clock })).refreshToken).toBe('refresh-1');
  });

  it('throws invalid_grant when the refresh token was revoked', async () => {
    respond(400, { error: 'invalid_grant', error_description: 'AADSTS70000: The user must sign in again.' });
    await expect(refreshAccessToken('c', 'old', { baseUrl })).rejects.toMatchObject({ name: 'OAuthError', code: 'invalid_grant' });
  });

  it('uses an injected fetch', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ expires_in: 60, access_token: 'a', refresh_token: 'r' }), { status: 200 });
    }) as typeof fetch;
    await refreshAccessToken('c', 'r0', { fetch: fakeFetch, clock });
    expect(calls).toEqual(['https://login.microsoftonline.com/common/oauth2/v2.0/token']);
  });
});
