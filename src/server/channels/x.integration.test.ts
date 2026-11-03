// Drives the X adapter with the real global `fetch` against a local HTTP server that speaks the X API v2
// (response shapes, status codes, rate-limit headers, rotating refresh tokens). It never reaches x.com.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../engine/clock.js';
import { createXAdapter } from './x.js';
import { ConnectError, type OutboundMessage } from './types.js';

const RATE_MESSAGE = "X stopped accepting Callum's messages because your X plan's daily limit is reached. DMs resume tomorrow.";

interface DmEvent { id: string; event_type: 'MessageCreate'; text: string; sender_id: string; created_at: string; dm_conversation_id: string }

const ME = { id: '2244994945', name: 'Gabriel Femi', username: 'Founder' };
const USERS: Record<string, { id: string; name: string; username: string }> = {
  kemi_ok: { id: '1001', name: 'Kemi Okoye', username: 'Kemi_OK' },
  quiet: { id: '1002', name: 'Quiet Person', username: 'quiet' },
};
const BY_ID = Object.fromEntries(Object.values(USERS).map((u) => [u.id, u]));

const state = {
  validTokens: new Set<string>(),
  refreshTokens: new Set<string>(),
  lookups: [] as string[],
  dms: [] as Array<{ to: string; text: string; auth: string | undefined; contentType: string | undefined }>,
  refreshes: [] as URLSearchParams[],
  refreshAuth: [] as Array<string | undefined>,
  limited: false,
  dmEvents: [] as DmEvent[],
  eventRequests: [] as URLSearchParams[],
  issued: 0,
};

function reset(): void {
  state.validTokens = new Set(['good-token', 'no-dm-token']);
  state.refreshTokens = new Set(['refresh-1']);
  state.lookups = [];
  state.dms = [];
  state.refreshes = [];
  state.refreshAuth = [];
  state.limited = false;
  state.dmEvents = [];
  state.eventRequests = [];
  state.issued = 0;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/2/oauth2/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      state.refreshes.push(form);
      const refresh = form.get('refresh_token') ?? '';
      const clientId = form.get('client_id') ?? '';
      state.refreshAuth.push(req.headers.authorization);
      // A confidential app ("Web App, Automated App or Bot") must authenticate with Basic client_id:client_secret.
      if (clientId === 'conf-client' && req.headers.authorization !== `Basic ${Buffer.from('conf-client:s3cret').toString('base64')}`) {
        return send(401, { error: 'unauthorized_client', error_description: 'Missing valid authorization header' });
      }
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded' || form.get('grant_type') !== 'refresh_token' || !['client-123', 'conf-client'].includes(clientId) || !state.refreshTokens.delete(refresh)) {
        return send(400, { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' });
      }
      const n = ++state.issued;
      state.validTokens.add(`access-${n}`);
      state.refreshTokens.add(`refresh-${n + 1}`);
      return send(200, { token_type: 'bearer', expires_in: 7200, access_token: `access-${n}`, scope: 'dm.read dm.write users.read tweet.read offline.access', refresh_token: `refresh-${n + 1}` });
    }

    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !state.validTokens.has(token)) {
      return send(401, { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' });
    }

    if (url.pathname === '/2/users/me') return send(200, { data: ME });

    // A token whose app lacks the Direct Messages permission can read the profile but nothing about messages.
    if (token === 'no-dm-token' && url.pathname.includes('dm_')) {
      return send(403, { title: 'Forbidden', type: 'about:blank', status: 403, detail: 'Forbidden' });
    }

    const byUsername = /^\/2\/users\/by\/username\/([^/]+)$/.exec(url.pathname);
    if (byUsername) {
      const handle = decodeURIComponent(byUsername[1] ?? '');
      state.lookups.push(handle);
      const user = USERS[handle.toLowerCase()];
      if (user) return send(200, { data: user });
      return send(200, {
        errors: [{ value: handle, detail: `Could not find user with username: [${handle}].`, title: 'Not Found Error', resource_type: 'user', parameter: 'username', resource_id: handle, type: 'https://api.twitter.com/2/problems/resource-not-found' }],
      });
    }

    const dm = /^\/2\/dm_conversations\/with\/([^/]+)\/messages$/.exec(url.pathname);
    if (dm && req.method === 'POST') {
      const to = dm[1] ?? '';
      const payload = JSON.parse(await readBody(req)) as { text: string };
      if (state.limited) {
        return send(429, { title: 'Too Many Requests', detail: 'Too Many Requests', type: 'about:blank', status: 429 }, { 'x-rate-limit-limit': '15', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 3600) });
      }
      if (to === USERS.quiet?.id) {
        return send(403, { title: 'Forbidden', type: 'about:blank', status: 403, detail: 'You cannot send messages to this user.' });
      }
      if (!BY_ID[to]) return send(404, { title: 'Not Found Error', type: 'https://api.twitter.com/2/problems/resource-not-found', detail: 'Could not find user with id: [x].' });
      state.dms.push({ to, text: payload.text, auth: req.headers.authorization, contentType: req.headers['content-type'] });
      return send(201, { data: { dm_conversation_id: `${ME.id}-${to}`, dm_event_id: `19000${state.dms.length}` } });
    }

    if (url.pathname === '/2/dm_events') {
      state.eventRequests.push(url.searchParams);
      const all = [...state.dmEvents].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const size = Math.min(Number(url.searchParams.get('max_results') ?? '100'), 100);
      const offset = Number(url.searchParams.get('pagination_token') ?? '0');
      const slice = all.slice(offset, offset + size);
      const senders = [...new Set(slice.map((e) => e.sender_id))].flatMap((id) => (id === ME.id ? [ME] : BY_ID[id] ? [BY_ID[id]] : []));
      const next = offset + size < all.length ? String(offset + size) : undefined;
      return send(200, { data: slice, includes: { users: senders }, meta: { result_count: slice.length, ...(next ? { next_token: next } : {}) } });
    }

    return send(404, { title: 'Not Found Error', status: 404 });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/2`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(reset);

const HELLO: OutboundMessage = {
  to: { name: 'Kemi Okoye', email: null, linkedinUrl: null, xHandle: '@Kemi_OK' },
  kind: 'hello',
  subject: null,
  body: 'Hi Kemi, I enjoyed your thread on payments.',
  inReplyTo: null,
};
const clock = fixedClock('2026-11-02T10:00:00Z');
const secretFor = (over: Record<string, string> = {}) => ({ accessToken: 'good-token', userId: ME.id, username: 'founder', ...over });

describe('x adapter against a local X API v2 server', () => {
  it('connects with the real users/me response and stores the user id', async () => {
    const adapter = createXAdapter(null, { baseUrl });
    const result = await adapter.connect({ accessToken: 'good-token', refreshToken: 'refresh-1', clientId: 'client-123' });
    expect(result).toEqual({
      identity: '@founder',
      secret: { accessToken: 'good-token', refreshToken: 'refresh-1', clientId: 'client-123', userId: ME.id, username: 'founder' },
    });
  });

  it('refuses a token that cannot read messages, in plain words', async () => {
    const adapter = createXAdapter(null, { baseUrl });
    await expect(adapter.connect({ accessToken: 'no-dm-token' })).rejects.toThrow(
      "This X token can't read messages. Give the app Direct Messages read and write access, then connect again.",
    );
  });

  it('turns a rejected token into a plain connect error', async () => {
    const adapter = createXAdapter(null, { baseUrl });
    await expect(adapter.connect({ accessToken: 'nope' })).rejects.toBeInstanceOf(ConnectError);
    await expect(adapter.connect({ accessToken: 'nope' })).rejects.toThrow(/Check the access token/);
  });

  it('refreshes an expired token while connecting', async () => {
    const adapter = createXAdapter(null, { baseUrl });
    const result = await adapter.connect({ accessToken: 'expired', refreshToken: 'refresh-1', clientId: 'client-123' });
    expect(result.identity).toBe('@founder');
    expect(result.secret).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-2' });
  });

  it('sends a DM, looking the handle up once across two sends', async () => {
    const adapter = createXAdapter(secretFor(), { baseUrl });
    expect(await adapter.send(HELLO)).toEqual({ ok: true, externalId: '190001' });
    expect(await adapter.send({ ...HELLO, kind: 'follow_up', body: 'Following up on my hello.' })).toEqual({ ok: true, externalId: '190002' });
    expect(state.lookups).toEqual(['kemi_ok']);
    expect(state.dms).toEqual([
      { to: '1001', text: HELLO.body, auth: 'Bearer good-token', contentType: 'application/json' },
      { to: '1001', text: 'Following up on my hello.', auth: 'Bearer good-token', contentType: 'application/json' },
    ]);
  });

  it('refreshes on 401, stores the rotated tokens, retries, and reuses the new token afterwards', async () => {
    const saved: Array<Record<string, string>> = [];
    const adapter = createXAdapter(secretFor({ accessToken: 'expired', refreshToken: 'refresh-1', clientId: 'client-123' }), {
      baseUrl,
      onSecretChange: (s) => saved.push(s),
    });
    expect(await adapter.send(HELLO)).toEqual({ ok: true, externalId: '190001' });
    expect(state.dms[0]?.auth).toBe('Bearer access-1');
    expect(state.refreshes).toHaveLength(1);
    expect(state.refreshes[0]?.get('refresh_token')).toBe('refresh-1');
    expect(saved).toEqual([secretFor({ accessToken: 'access-1', refreshToken: 'refresh-2', clientId: 'client-123' })]);

    await adapter.send({ ...HELLO, body: 'Second' });
    expect(state.refreshes).toHaveLength(1);

    // The stored secret is enough to start again; the old single-use refresh token is not needed.
    const restarted = createXAdapter(saved[0] ?? null, { baseUrl });
    expect(await restarted.send({ ...HELLO, body: 'After restart' })).toMatchObject({ ok: true });
    expect(state.refreshes).toHaveLength(1);
  });

  it('refreshes a confidential app with Basic authentication and keeps the client secret in the secret', async () => {
    const saved: Array<Record<string, string>> = [];
    const adapter = createXAdapter(null, { baseUrl, onSecretChange: (s) => saved.push(s) });
    const connected = await adapter.connect({ accessToken: 'expired', refreshToken: 'refresh-1', clientId: 'conf-client', clientSecret: 's3cret' });
    expect(connected.secret).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-2', clientId: 'conf-client', clientSecret: 's3cret' });
    expect(state.refreshAuth).toEqual([`Basic ${Buffer.from('conf-client:s3cret').toString('base64')}`]);

    // Later refreshes (the token expires every two hours) keep working from the stored secret.
    state.validTokens.delete('access-1');
    const later = createXAdapter(connected.secret, { baseUrl, onSecretChange: (s) => saved.push(s) });
    expect(await later.send(HELLO)).toMatchObject({ ok: true });
    expect(state.refreshAuth).toHaveLength(2);
    expect(saved.at(-1)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-3', clientSecret: 's3cret' });
  });

  it('a confidential app without its secret cannot refresh and is told to connect again', async () => {
    const adapter = createXAdapter(secretFor({ accessToken: 'expired', refreshToken: 'refresh-1', clientId: 'conf-client' }), { baseUrl });
    expect(await adapter.send(HELLO)).toMatchObject({ ok: false, error: { code: 'auth', message: 'X signed Callum out. Connect X again from Your Callum.' } });
  });

  it('shares one refresh between two requests that fail at the same time', async () => {
    const adapter = createXAdapter(secretFor({ accessToken: 'expired', refreshToken: 'refresh-1', clientId: 'client-123' }), { baseUrl });
    const results = await Promise.all([adapter.send(HELLO), adapter.send({ ...HELLO, body: 'Another' })]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(state.refreshes).toHaveLength(1);
  });

  it('reports auth when the token is bad and there is nothing to refresh with', async () => {
    const adapter = createXAdapter(secretFor({ accessToken: 'expired' }), { baseUrl });
    expect(await adapter.send(HELLO)).toMatchObject({ ok: false, error: { code: 'auth' } });
    const spent = createXAdapter(secretFor({ accessToken: 'expired', refreshToken: 'used-before', clientId: 'client-123' }), { baseUrl });
    expect(await spent.send(HELLO)).toMatchObject({ ok: false, error: { code: 'auth' } });
  });

  it('maps 429 with rate-limit headers to the plan message', async () => {
    state.limited = true;
    const adapter = createXAdapter(secretFor(), { baseUrl });
    expect(await adapter.send(HELLO)).toEqual({ ok: false, error: { code: 'rate_limit', message: RATE_MESSAGE } });
    state.limited = false;
    expect(await adapter.send(HELLO)).toMatchObject({ ok: true });
  });

  it('maps a handle that does not exist (200 with errors) and a closed inbox (403) to invalid_recipient', async () => {
    const adapter = createXAdapter(secretFor(), { baseUrl });
    const missing = await adapter.send({ ...HELLO, to: { ...HELLO.to, xHandle: 'nobody_here' } });
    expect(missing).toMatchObject({ ok: false, error: { code: 'invalid_recipient' } });
    const closed = await adapter.send({ ...HELLO, to: { ...HELLO.to, xHandle: 'https://x.com/quiet' } });
    expect(closed).toMatchObject({ ok: false, error: { code: 'invalid_recipient', message: expect.stringContaining('cannot send messages') } });
  });

  it('reports temporary when X cannot be reached at all', async () => {
    const adapter = createXAdapter(secretFor(), { baseUrl: 'http://127.0.0.1:1/2' });
    expect(await adapter.send(HELLO)).toMatchObject({ ok: false, error: { code: 'temporary' } });
  });

  describe('poll', () => {
    const at = (iso: string, id: string, sender: string, text: string): DmEvent => ({ id, event_type: 'MessageCreate', text, sender_id: sender, created_at: iso, dm_conversation_id: `${ME.id}-${sender}` });

    it('asks X for message events and emits only other people\'s replies after since, oldest first', async () => {
      state.dmEvents = [
        at('2026-11-02T09:30:00.000Z', 'e4', '1001', 'Thursday at 9:00 works'),
        at('2026-11-02T09:00:00.000Z', 'e3', ME.id, 'Hi Kemi'),
        at('2026-11-02T08:00:00.000Z', 'e2', '1002', 'Not for me, thanks'),
        at('2026-10-30T08:00:00.000Z', 'e1', '1001', 'An older reply'),
      ];
      const adapter = createXAdapter(secretFor(), { baseUrl, clock });
      const events = await adapter.poll(new Date('2026-11-01T00:00:00Z'));
      expect(events).toEqual([
        { type: 'reply', from: { xHandle: 'quiet', name: 'Quiet Person' }, text: 'Not for me, thanks', at: '2026-11-02T08:00:00.000Z', externalId: 'e2' },
        { type: 'reply', from: { xHandle: 'kemi_ok', name: 'Kemi Okoye' }, text: 'Thursday at 9:00 works', at: '2026-11-02T09:30:00.000Z', externalId: 'e4' },
      ]);
      const q = state.eventRequests[0];
      expect(q?.get('event_types')).toBe('MessageCreate');
      expect(q?.get('dm_event.fields')).toBe('sender_id,text,created_at');
      expect(q?.get('expansions')).toBe('sender_id');
      expect(q?.get('user.fields')).toBe('username');
      expect(await adapter.poll(new Date('2026-11-01T00:00:00Z'))).toEqual([]);
    });

    it('pages through dm_events with pagination tokens until it reaches events older than since', async () => {
      state.dmEvents = Array.from({ length: 230 }, (_, i) => at(new Date(Date.UTC(2026, 10, 2, 9, 0, 0) - i * 60_000).toISOString(), `m${i}`, '1001', `message ${i}`));
      const adapter = createXAdapter(secretFor(), { baseUrl, clock });
      const events = await adapter.poll(new Date(Date.UTC(2026, 10, 2, 9, 0, 0) - 150 * 60_000));
      expect(events).toHaveLength(151);
      expect(state.eventRequests.map((r) => r.get('pagination_token'))).toEqual([null, '100']);
    });

    it('refreshes an expired token while polling', async () => {
      state.dmEvents = [at('2026-11-02T09:30:00.000Z', 'e4', '1001', 'Hello back')];
      const adapter = createXAdapter(secretFor({ accessToken: 'expired', refreshToken: 'refresh-1', clientId: 'client-123' }), { baseUrl, clock });
      expect(await adapter.poll(null)).toHaveLength(1);
      expect(state.refreshes).toHaveLength(1);
    });

    it('raises a clear error when X refuses', async () => {
      const adapter = createXAdapter(secretFor({ accessToken: 'expired' }), { baseUrl, clock });
      await expect(adapter.poll(null)).rejects.toMatchObject({ code: 'auth', message: 'X signed Callum out. Connect X again from Your Callum.' });
    });
  });

  it('honours an explicit token URL', async () => {
    const adapter = createXAdapter(secretFor({ accessToken: 'expired', refreshToken: 'refresh-1', clientId: 'client-123' }), {
      baseUrl,
      tokenUrl: `${baseUrl}/oauth2/token`,
    });
    expect(await adapter.send(HELLO)).toMatchObject({ ok: true });
  });
});
