import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, OutKind, OutboxState } from '../../shared/types.js';
import { ConnectError, type AdapterFactory, type ChannelAdapter } from '../channels/types.js';
import { createCtx, type Ctx } from '../context.js';
import { openDb } from '../db/db.js';
import { makeProject } from '../db/testing.test-helpers.js';
import { fixedClock } from '../engine/clock.js';
import {
  connectChannel, disconnectChannel, channelSummary, microsoftPoll, microsoftSetup, microsoftStart, paceLine, pendingFor, saveMicrosoftClientId,
} from './channels.js';
import { UserError } from './errors.js';

const clock = fixedClock('2026-11-02T10:00:00Z');
const CLIENT_ID = '11111111-2222-3333-4444-555555555555';

interface Stub extends ChannelAdapter {
  inputs: Record<string, string>[];
}

function stub(channel: Channel, connect?: ChannelAdapter['connect']): Stub {
  const inputs: Record<string, string>[] = [];
  return {
    channel,
    inputs,
    connect:
      connect ??
      (async (input) => {
        inputs.push(input);
        return { identity: input.address ?? 'who', secret: { ...input } };
      }),
    send: async () => ({ ok: true, externalId: null }),
    poll: async () => [],
    close: async () => undefined,
  };
}

let ctx: Ctx;
let adapters: Stub[];
let nextConnect: ChannelAdapter['connect'] | undefined;

beforeEach(() => {
  clock.set('2026-11-02T10:00:00Z');
  adapters = [];
  nextConnect = undefined;
  const factory: AdapterFactory = (ch) => {
    const a = stub(ch, nextConnect);
    adapters.push(a);
    return a;
  };
  ctx = createCtx({ db: openDb(':memory:'), clock, factory, env: {} });
  ctx.repo.updateSettings({ timezone: 'Africa/Lagos' });
});

function queue(channel: Channel, kind: OutKind, state: OutboxState = 'scheduled', projectId?: number) {
  const project = projectId ? { id: projectId } : (ctx.repo.listProjects()[0] ?? makeProject(ctx.repo));
  const n = ctx.repo.listPeople().length + 1;
  const person = ctx.repo.insertPerson({ projectId: project.id, name: `Person ${n}`, source: 'paste', email: `p${n}@x.com` });
  return ctx.repo.insertOutbox({ personId: person.id, channel, kind, body: 'Hi', state, origin: 'auto', sendAfter: '2026-11-03T08:00:00.000Z' });
}

describe('pendingFor', () => {
  it('counts scheduled and awaiting items on that channel by kind', () => {
    queue('linkedin', 'invite');
    queue('linkedin', 'invite', 'awaiting_ok');
    queue('linkedin', 'invite', 'sent');
    queue('linkedin', 'invite', 'cancelled');
    queue('linkedin', 'follow_up');
    queue('linkedin', 'thanks');
    queue('email', 'hello');
    queue('x', 'hello');
    expect(pendingFor(ctx, 'linkedin')).toEqual({ invites: 2, followUps: 2, emails: 0, messages: 0 });
  });

  it('counts every email on the email channel and every message on X', () => {
    queue('email', 'hello');
    queue('email', 'follow_up');
    queue('email', 'reply');
    queue('x', 'hello');
    queue('x', 'follow_up');
    expect(pendingFor(ctx, 'email')).toEqual({ invites: 0, followUps: 0, emails: 3, messages: 0 });
    expect(pendingFor(ctx, 'x')).toEqual({ invites: 0, followUps: 0, emails: 0, messages: 2 });
  });

  it('counts across projects', () => {
    const second = makeProject(ctx.repo);
    queue('email', 'hello');
    queue('email', 'hello', 'scheduled', second.id);
    expect(pendingFor(ctx, 'email').emails).toBe(2);
  });
});

describe('paceLine', () => {
  const connectEmailAt = (iso: string) => ctx.repo.updateChannel('email', { status: 'connected', identity: 'a@x.com', connectedAt: iso });

  it('email ramps over three weeks', () => {
    connectEmailAt('2026-11-02T09:00:00.000Z');
    expect(paceLine(ctx, 'email')).toBe('20 a day this week, 120 by week 3');
    clock.set('2026-11-09T10:00:00Z');
    expect(paceLine(ctx, 'email')).toBe('70 a day this week, 120 from next week');
    clock.set('2026-11-16T10:00:00Z');
    expect(paceLine(ctx, 'email')).toBe('120 a day');
  });

  it('email starts at the first step before it is connected', () => {
    expect(paceLine(ctx, 'email')).toBe('20 a day this week, 120 by week 3');
  });

  it('linkedin runs on this computer at 15 invites a day', () => {
    expect(paceLine(ctx, 'linkedin')).toBe('15 invites a day, runs on this computer while Callum is open');
  });

  it('linkedin at half pace says until when', () => {
    ctx.repo.updateChannel('linkedin', { status: 'connected', halfPaceUntil: '2026-11-05T09:00:00.000Z' });
    expect(paceLine(ctx, 'linkedin')).toBe('7 invites a day until Thursday, then 15');
    ctx.repo.updateChannel('linkedin', { halfPaceUntil: '2026-11-20T09:00:00.000Z' });
    expect(paceLine(ctx, 'linkedin')).toBe('7 invites a day until 20 Nov, then 15');
  });

  it('linkedin ignores a half pace that already ended', () => {
    ctx.repo.updateChannel('linkedin', { status: 'connected', halfPaceUntil: '2026-10-30T09:00:00.000Z' });
    expect(paceLine(ctx, 'linkedin')).toBe('15 invites a day, runs on this computer while Callum is open');
  });

  it('x sends 20 messages a day', () => {
    expect(paceLine(ctx, 'x')).toBe('20 messages a day');
  });

  it('says the pace is shared once there is more than one project', () => {
    connectEmailAt('2026-11-02T09:00:00.000Z');
    makeProject(ctx.repo);
    makeProject(ctx.repo);
    expect(paceLine(ctx, 'email')).toBe('20 emails a day across both projects, 120 by week 3');
    expect(paceLine(ctx, 'linkedin')).toBe('15 invites a day across both projects, runs on this computer while Callum is open');
    expect(paceLine(ctx, 'x')).toBe('20 messages a day across both projects');
    makeProject(ctx.repo);
    expect(paceLine(ctx, 'x')).toBe('20 messages a day across all 3 projects');
  });

  it('does not count a wrapped project', () => {
    makeProject(ctx.repo);
    const gone = makeProject(ctx.repo);
    ctx.repo.updateProject(gone.id, { state: 'wrapped' });
    expect(paceLine(ctx, 'x')).toBe('20 messages a day');
  });

  it('is part of the channel summary', () => {
    queue('x', 'hello');
    expect(channelSummary(ctx, 'x')).toEqual({ pending: { invites: 0, followUps: 0, emails: 0, messages: 1 }, paceLine: '20 messages a day' });
  });
});

describe('connect and disconnect', () => {
  it('connects through the registry and stores the account', async () => {
    const account = await connectChannel(ctx, 'email', { provider: 'google', address: 'you@x.com', password: 'abcdabcdabcdabcd' });
    expect(account).toMatchObject({ channel: 'email', status: 'connected', identity: 'you@x.com' });
    expect(ctx.repo.getChannelSecret('email')).toMatchObject({ address: 'you@x.com' });
  });

  it('keeps the connected email address as the sender, and leaves it alone for other channels', async () => {
    await connectChannel(ctx, 'email', { provider: 'google', address: 'you@x.com', password: 'abcdabcdabcdabcd' });
    expect(ctx.repo.getSettings().senderEmail).toBe('you@x.com');
    await connectChannel(ctx, 'linkedin', {});
    expect(ctx.repo.getSettings().senderEmail).toBe('you@x.com');
  });

  it('turns a refused connection into the words for the person', async () => {
    nextConnect = async () => {
      throw new ConnectError("Google didn't accept that password. App passwords are 16 letters, with no spaces.");
    };
    const failure = connectChannel(ctx, 'email', { provider: 'google', address: 'you@x.com', password: 'bad' });
    await expect(failure).rejects.toBeInstanceOf(UserError);
    await expect(failure).rejects.toMatchObject({ message: "Google didn't accept that password. App passwords are 16 letters, with no spaces.", status: 422 });
    expect(ctx.repo.getChannel('email').status).toBe('disconnected');
  });

  it('lets an unexpected failure through unchanged', async () => {
    nextConnect = async () => {
      throw new TypeError('boom');
    };
    await expect(connectChannel(ctx, 'x', { accessToken: 'a'.repeat(30) })).rejects.toBeInstanceOf(TypeError);
  });

  it('disconnects, clears the secret and keeps the queue waiting', async () => {
    await connectChannel(ctx, 'linkedin', {});
    const item = queue('linkedin', 'invite');
    const account = await disconnectChannel(ctx, 'linkedin');
    expect(account).toMatchObject({ status: 'disconnected', identity: null });
    expect(ctx.repo.getChannelSecret('linkedin')).toBeNull();
    expect(ctx.repo.getOutbox(item.id)?.state).toBe('scheduled');
  });
});

describe('Microsoft sign-in', () => {
  const env = { CALLUM_MICROSOFT_CLIENT_ID: CLIENT_ID };

  function oauthFetch(answers: Record<string, unknown>[]) {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? '')) });
      const answer = answers.shift() ?? { error: 'authorization_pending' };
      const failed = typeof answer.error === 'string';
      return new Response(JSON.stringify(answer), { status: failed ? 400 : 200, headers: { 'content-type': 'application/json' } });
    });
    return { fetch: fn as unknown as typeof fetch, calls };
  }

  const DEVICE = { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 };
  const TOKENS = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 };

  it('says whether the app setup is done, from the environment or from settings', () => {
    expect(microsoftSetup(ctx, {})).toEqual({ configured: false, source: null });
    expect(microsoftSetup(ctx, env)).toEqual({ configured: true, source: 'env' });
    saveMicrosoftClientId(ctx, CLIENT_ID.toUpperCase());
    expect(microsoftSetup(ctx, {})).toEqual({ configured: true, source: 'settings' });
    expect(ctx.repo.getSettings().microsoftClientId).toBe(CLIENT_ID);
  });

  it('refuses an id that is not an application id', () => {
    expect(() => saveMicrosoftClientId(ctx, 'hello')).toThrow(UserError);
    expect(() => saveMicrosoftClientId(ctx, 'hello')).toThrow("That doesn't look like an application (client) ID.");
  });

  it('explains the one-time setup when there is no client id', async () => {
    await expect(microsoftStart(ctx, { address: 'you@contoso.com' }, {})).rejects.toThrow('Microsoft needs a one-time app setup on this computer first.');
  });

  it('asks for the address first', async () => {
    await expect(microsoftStart(ctx, { address: 'nope' }, env)).rejects.toThrow('Add the email address to send from.');
  });

  it('starts a device code and returns what the person needs', async () => {
    const oauth = oauthFetch([DEVICE]);
    const res = await microsoftStart(ctx, { address: 'you@contoso.com' }, env, { fetch: oauth.fetch, clock });
    expect(res).toEqual({ userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: '2026-11-02T10:15:00.000Z' });
    expect(oauth.calls[0]?.body.get('client_id')).toBe(CLIENT_ID);
  });

  it('keeps waiting until the code is entered, then connects the mailbox', async () => {
    const oauth = oauthFetch([DEVICE, { error: 'authorization_pending' }, TOKENS]);
    const opts = { fetch: oauth.fetch, clock };
    await microsoftStart(ctx, { address: 'you@contoso.com' }, env, opts);
    clock.advance(6_000);
    expect(await microsoftPoll(ctx, {}, env, opts)).toEqual({ status: 'waiting' });
    clock.advance(6_000);
    const done = await microsoftPoll(ctx, {}, env, opts);
    expect(done).toMatchObject({ status: 'connected', account: { channel: 'email', status: 'connected', identity: 'you@contoso.com' } });
    expect(adapters.at(-1)?.inputs[0]).toMatchObject({
      provider: 'microsoft', address: 'you@contoso.com', clientId: CLIENT_ID, refreshToken: 'rt-1', accessToken: 'at-1',
    });
    expect(ctx.repo.getChannel('email').status).toBe('connected');
    expect(ctx.repo.getSettings().senderEmail).toBe('you@contoso.com');
  });

  it('does not ask Microsoft again before the interval has passed', async () => {
    const oauth = oauthFetch([DEVICE, TOKENS]);
    const opts = { fetch: oauth.fetch, clock };
    await microsoftStart(ctx, { address: 'you@contoso.com' }, env, opts);
    expect(await microsoftPoll(ctx, {}, env, opts)).toEqual({ status: 'waiting' });
    expect(oauth.calls).toHaveLength(1);
  });

  it('says when the code ran out, here or at Microsoft', async () => {
    const oauth = oauthFetch([DEVICE, { error: 'expired_token' }]);
    const opts = { fetch: oauth.fetch, clock };
    await microsoftStart(ctx, { address: 'you@contoso.com' }, env, opts);
    clock.advance(6_000);
    expect(await microsoftPoll(ctx, {}, env, opts)).toEqual({ status: 'expired' });
    await expect(microsoftPoll(ctx, {}, env, opts)).rejects.toThrow('Start the Microsoft sign-in first.');

    const later = oauthFetch([DEVICE]);
    await microsoftStart(ctx, { address: 'you@contoso.com' }, env, { fetch: later.fetch, clock });
    clock.advance(901_000);
    expect(await microsoftPoll(ctx, {}, env, { fetch: later.fetch, clock })).toEqual({ status: 'expired' });
    expect(later.calls).toHaveLength(1);
  });

  it('reports a refusal', async () => {
    const oauth = oauthFetch([DEVICE, { error: 'authorization_declined' }]);
    const opts = { fetch: oauth.fetch, clock };
    await microsoftStart(ctx, { address: 'you@contoso.com' }, env, opts);
    clock.advance(6_000);
    expect(await microsoftPoll(ctx, {}, env, opts)).toEqual({ status: 'denied' });
  });

  it('shows Microsoft\'s own words when it refuses the app', async () => {
    const oauth = oauthFetch([{ error: 'unauthorized_client', error_description: 'AADSTS700016: Application not found.' }]);
    await expect(microsoftStart(ctx, { address: 'you@contoso.com' }, env, { fetch: oauth.fetch, clock })).rejects.toThrow(
      "Microsoft wouldn't start the sign-in. AADSTS700016: Application not found.",
    );
  });

  it('says so when Microsoft cannot be reached', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    await expect(microsoftStart(ctx, { address: 'you@contoso.com' }, env, { fetch, clock })).rejects.toThrow(
      "Couldn't reach Microsoft. Check your connection and try again.",
    );
  });

  it('forgets the code when the mailbox refuses to connect', async () => {
    const oauth = oauthFetch([DEVICE, TOKENS]);
    const opts = { fetch: oauth.fetch, clock };
    await microsoftStart(ctx, { address: 'you@contoso.com' }, env, opts);
    nextConnect = async () => {
      throw new ConnectError("Couldn't sign in to you@contoso.com. Sign in with Microsoft again.");
    };
    clock.advance(6_000);
    await expect(microsoftPoll(ctx, {}, env, opts)).rejects.toThrow("Couldn't sign in to you@contoso.com. Sign in with Microsoft again.");
    await expect(microsoftPoll(ctx, {}, env, opts)).rejects.toThrow('Start the Microsoft sign-in first.');
  });

  it('waits five seconds longer when Microsoft says slow down', async () => {
    const oauth = oauthFetch([DEVICE, { error: 'slow_down' }, TOKENS]);
    const opts = { fetch: oauth.fetch, clock };
    await microsoftStart(ctx, { address: 'you@contoso.com' }, env, opts);
    clock.advance(6_000);
    expect(await microsoftPoll(ctx, {}, env, opts)).toEqual({ status: 'waiting' });
    expect(oauth.calls).toHaveLength(2);
    clock.advance(6_000);
    expect(await microsoftPoll(ctx, {}, env, opts)).toEqual({ status: 'waiting' });
    expect(oauth.calls).toHaveLength(2);
    clock.advance(5_000);
    expect(await microsoftPoll(ctx, {}, env, opts)).toMatchObject({ status: 'connected' });
  });

  it('keeps the code through a network failure and keeps waiting', async () => {
    const oauth = oauthFetch([DEVICE, TOKENS]);
    let fail = true;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (fail && String(input).endsWith('/token')) {
        fail = false;
        throw new TypeError('fetch failed');
      }
      return (oauth.fetch as typeof fetch)(input, init);
    }) as unknown as typeof fetch;
    const opts = { fetch: flaky, clock };
    await microsoftStart(ctx, { address: 'you@contoso.com' }, env, opts);
    clock.advance(6_000);
    expect(await microsoftPoll(ctx, {}, env, opts)).toEqual({ status: 'waiting' });
    clock.advance(6_000);
    expect(await microsoftPoll(ctx, {}, env, opts)).toMatchObject({ status: 'connected' });
  });

  it('connects the address the code was started for, whatever a later poll says', async () => {
    const oauth = oauthFetch([DEVICE, TOKENS]);
    const opts = { fetch: oauth.fetch, clock };
    await microsoftStart(ctx, { address: 'you@contoso.com' }, env, opts);
    clock.advance(6_000);
    await microsoftPoll(ctx, { address: 'someone@else.com' }, env, opts);
    expect(adapters.at(-1)?.inputs[0]?.address).toBe('you@contoso.com');
  });

  it('gives a code 15 minutes when Microsoft does not say how long', async () => {
    const oauth = oauthFetch([{ ...DEVICE, expires_in: undefined }]);
    const res = await microsoftStart(ctx, { address: 'you@contoso.com' }, env, { fetch: oauth.fetch, clock });
    expect(res.expiresAt).toBe('2026-11-02T10:15:00.000Z');
  });

  it('is always set up in demo mode', () => {
    const demo = createCtx({ db: openDb(':memory:'), clock, demo: true, env: {} });
    expect(microsoftSetup(demo, {})).toEqual({ configured: true, source: null });
  });

  it('in demo mode shows a demo code and connects on the first check', async () => {
    const demo = createCtx({ db: openDb(':memory:'), clock, demo: true, env: {} });
    const res = await microsoftStart(demo, { address: 'you@contoso.com' }, {});
    expect(res.userCode).toBe('DEMO-0000');
    const done = await microsoftPoll(demo, {}, {});
    expect(done).toMatchObject({ status: 'connected', account: { channel: 'email', status: 'connected' } });
  });
});
