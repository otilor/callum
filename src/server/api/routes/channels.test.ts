import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../../../shared/types.js';
import { ConnectError, type AdapterFactory, type ChannelAdapter } from '../../channels/types.js';
import { createCtx, type Ctx } from '../../context.js';
import { openDb } from '../../db/db.js';
import { fixedClock } from '../../engine/clock.js';
import { channelsRoutes } from './channels.js';

const clock = fixedClock('2026-11-02T10:00:00Z');
const CLIENT_ID = '11111111-2222-3333-4444-555555555555';

let ctx: Ctx;
let app: Hono;
let seen: Record<string, string>[];
let refuse: string | null;
let changes: number;
let oauthAnswers: Record<string, unknown>[];

function adapter(channel: Channel): ChannelAdapter {
  return {
    channel,
    connect: async (input) => {
      seen.push(input);
      if (refuse) throw new ConnectError(refuse);
      return { identity: input.address ?? 'who', secret: { ...input } };
    },
    send: async () => ({ ok: true, externalId: null }),
    poll: async () => [],
    close: async () => undefined,
  };
}

beforeEach(() => {
  clock.set('2026-11-02T10:00:00Z');
  seen = [];
  refuse = null;
  changes = 0;
  oauthAnswers = [];
  const factory: AdapterFactory = (ch) => adapter(ch);
  ctx = createCtx({ db: openDb(':memory:'), clock, factory, env: {} });
  const fetch = (async () => {
    const answer = oauthAnswers.shift() ?? { error: 'authorization_pending' };
    return new Response(JSON.stringify(answer), { status: typeof answer.error === 'string' ? 400 : 200 });
  }) as unknown as typeof globalThis.fetch;
  app = new Hono().route('/', channelsRoutes(ctx, { env: { CALLUM_MICROSOFT_CLIENT_ID: CLIENT_ID }, oauth: { fetch, clock }, changed: () => { changes += 1; } }));
});

const post = (path: string, json: unknown = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });

describe('channel routes', () => {
  it('connects with the fields it is given and drops anything that is not text', async () => {
    const res = await post('/channels/email/connect', { provider: 'google', address: 'you@x.com', password: 'abcdabcdabcdabcd', nested: { a: 1 }, n: 4 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ channel: 'email', status: 'connected', identity: 'you@x.com' });
    expect(seen[0]).toEqual({ provider: 'google', address: 'you@x.com', password: 'abcdabcdabcdabcd' });
    expect(changes).toBe(1);
  });

  it('answers a refusal with 422 and the adapter\'s words', async () => {
    refuse = "Google didn't accept that password. App passwords are 16 letters, with no spaces.";
    const res = await post('/channels/email/connect', { provider: 'google', address: 'you@x.com', password: 'bad' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: refuse });
    expect(changes).toBe(0);
  });

  it('knows only three channels', async () => {
    expect((await post('/channels/telegram/connect')).status).toBe(404);
    expect((await app.request('/channels/telegram/summary')).status).toBe(404);
  });

  it('disconnects', async () => {
    await post('/channels/x/connect', { accessToken: 'a'.repeat(30) });
    const res = await post('/channels/x/disconnect');
    expect(await res.json()).toMatchObject({ channel: 'x', status: 'disconnected' });
    expect(ctx.repo.getChannelSecret('x')).toBeNull();
  });

  it('summarises what waits and how fast', async () => {
    const project = ctx.repo.insertProject({ name: 'One' });
    const person = ctx.repo.insertPerson({ projectId: project.id, name: 'Kemi Eze', source: 'paste' });
    ctx.repo.insertOutbox({ personId: person.id, channel: 'linkedin', kind: 'invite', body: 'Hi', state: 'scheduled', origin: 'auto', sendAfter: '2026-11-03T08:00:00.000Z' });
    const res = await app.request('/channels/linkedin/summary');
    expect(await res.json()).toEqual({
      pending: { invites: 1, followUps: 0, emails: 0, messages: 0 },
      paceLine: '15 invites a day, runs on this computer while Callum is open',
    });
  });
});

describe('Microsoft routes', () => {
  it('walks from code to connected mailbox', async () => {
    oauthAnswers.push({ device_code: 'd', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
    const start = await post('/channels/email/microsoft/start', { address: 'you@contoso.com' });
    expect(await start.json()).toEqual({ userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: '2026-11-02T10:15:00.000Z' });
    clock.advance(6_000);
    oauthAnswers.push({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    const poll = await post('/channels/email/microsoft/poll', { address: 'you@contoso.com' });
    expect(await poll.json()).toMatchObject({ status: 'connected', account: { identity: 'you@contoso.com' } });
    expect(seen[0]).toMatchObject({ provider: 'microsoft', refreshToken: 'rt', clientId: CLIENT_ID });
    expect(changes).toBe(1);
  });

  it('answers a poll with nothing started in plain words', async () => {
    const res = await post('/channels/email/microsoft/poll');
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Start the Microsoft sign-in first.' });
  });

  it('reports and saves the app setup', async () => {
    const bare = new Hono().route('/', channelsRoutes(ctx, { env: {} }));
    expect(await (await bare.request('/channels/email/microsoft/setup')).json()).toEqual({ configured: false, source: null });
    const bad = await bare.request('/channels/email/microsoft/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'x' }) });
    expect(bad.status).toBe(422);
    const ok = await bare.request('/channels/email/microsoft/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: CLIENT_ID }) });
    expect(await ok.json()).toEqual({ configured: true, source: 'settings' });
  });

  it('says why when there is no client id', async () => {
    const bare = new Hono().route('/', channelsRoutes(ctx, { env: {} }));
    const res = await bare.request('/channels/email/microsoft/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: 'you@contoso.com' }) });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe('Microsoft needs a one-time app setup on this computer first.');
  });
});
