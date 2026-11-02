import { describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../engine/clock.js';
import { createXAdapter } from './x.js';
import { ConnectError, type OutboundMessage } from './types.js';

const RATE_MESSAGE = "X stopped accepting Callum's messages because your X plan's daily limit is reached. DMs resume tomorrow.";
const HELLO: OutboundMessage = {
  to: { name: 'Kemi Okoye', email: null, linkedinUrl: null, xHandle: 'kemi_ok' },
  kind: 'hello',
  subject: null,
  body: 'Hi Kemi',
  inReplyTo: null,
};
const SECRET = { accessToken: 'tok1', refreshToken: 'ref1', clientId: 'cid', userId: '100', username: 'founder' };

interface Call { method: string; url: string; headers: Record<string, string>; body: string | null }
type Handler = (call: Call) => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { method: init?.method ?? 'GET', url: String(input), headers, body: typeof init?.body === 'string' ? init.body : null };
    calls.push(call);
    return handler(call);
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

const adapterWith = (f: ReturnType<typeof fakeFetch>, secret: Record<string, string> | null = SECRET, extra = {}) =>
  createXAdapter(secret, { fetch: f.fetch, clock: fixedClock('2026-11-02T10:00:00Z'), ...extra });

describe('x connect', () => {
  it('verifies the token and returns @username with the user id in the secret', async () => {
    const f = fakeFetch(() => json(200, { data: { id: '100', username: 'Founder', name: 'Gabriel' } }));
    const result = await createXAdapter(null, { fetch: f.fetch }).connect({ accessToken: 'tok1', refreshToken: 'ref1', clientId: 'cid' });
    expect(result.identity).toBe('@founder');
    expect(result.secret).toEqual({ accessToken: 'tok1', refreshToken: 'ref1', clientId: 'cid', userId: '100', username: 'founder' });
    expect(f.calls[0]?.url).toBe('https://api.x.com/2/users/me');
    expect(f.calls[0]?.headers.authorization).toBe('Bearer tok1');
  });

  it('keeps a client secret in the secret and checks the token can read messages', async () => {
    const f = fakeFetch((c) => (c.url.includes('/dm_events') ? json(200, { meta: { result_count: 0 } }) : json(200, { data: { id: '100', username: 'founder' } })));
    const out = await createXAdapter(null, { fetch: f.fetch }).connect({ accessToken: 'tok1', refreshToken: 'ref1', clientId: 'cid', clientSecret: 'shh' });
    expect(out.secret).toMatchObject({ clientSecret: 'shh' });
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.x.com/2/users/me', 'https://api.x.com/2/dm_events?max_results=1']);
  });

  it('refuses a token without Direct Messages access in plain words', async () => {
    const f = fakeFetch((c) => (c.url.includes('/dm_events') ? json(403, { title: 'Forbidden', status: 403 }) : json(200, { data: { id: '100', username: 'founder' } })));
    await expect(createXAdapter(null, { fetch: f.fetch }).connect({ accessToken: 'tok1' })).rejects.toThrow(
      "This X token can't read messages. Give the app Direct Messages read and write access, then connect again.",
    );
  });

  it('blames the plan, not the scope, when X says the client is not allowed to read messages', async () => {
    const f = fakeFetch((c) =>
      c.url.includes('/dm_events')
        ? json(403, { title: 'Client Forbidden', reason: 'client-not-enrolled', type: 'https://api.twitter.com/2/problems/client-forbidden' })
        : json(200, { data: { id: '100', username: 'founder' } }),
    );
    await expect(createXAdapter(null, { fetch: f.fetch }).connect({ accessToken: 'tok1' })).rejects.toThrow(/plan includes direct messages/);
  });

  it('asks for an access token when none is given', async () => {
    const f = fakeFetch(() => json(200, {}));
    await expect(createXAdapter(null, { fetch: f.fetch }).connect({})).rejects.toBeInstanceOf(ConnectError);
    expect(f.calls).toHaveLength(0);
  });

  it('explains a rejected token and an unreachable X', async () => {
    const rejected = fakeFetch(() => json(401, { title: 'Unauthorized', status: 401 }));
    await expect(createXAdapter(null, { fetch: rejected.fetch }).connect({ accessToken: 'bad' })).rejects.toThrow(/Check the access token/);
    const down = createXAdapter(null, {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(down.connect({ accessToken: 'tok' })).rejects.toThrow(/reach X/);
  });

  it('refreshes once at connect when the access token is stale', async () => {
    let me = 0;
    const f = fakeFetch((c) => {
      if (c.url.endsWith('/oauth2/token')) return json(200, { access_token: 'new', refresh_token: 'newref', expires_in: 7200 });
      return ++me === 1 ? json(401, {}) : json(200, { data: { id: '100', username: 'founder' } });
    });
    const out = await createXAdapter(null, { fetch: f.fetch }).connect({ accessToken: 'old', refreshToken: 'ref1', clientId: 'cid' });
    expect(out.secret).toMatchObject({ accessToken: 'new', refreshToken: 'newref', userId: '100' });
  });
});

describe('x send', () => {
  it('resolves the handle once across two sends and posts the text', async () => {
    const f = fakeFetch((c) => {
      if (c.url.includes('/users/by/username/')) return json(200, { data: { id: '555', username: 'kemi_ok' } });
      return json(201, { data: { dm_conversation_id: '100-555', dm_event_id: 'ev1' } });
    });
    const adapter = adapterWith(f);
    const first = await adapter.send(HELLO);
    const second = await adapter.send({ ...HELLO, kind: 'follow_up', body: 'Following up' });
    expect(first).toEqual({ ok: true, externalId: 'ev1' });
    expect(second.ok).toBe(true);
    const lookups = f.calls.filter((c) => c.url.includes('/users/by/username/'));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.url).toBe('https://api.x.com/2/users/by/username/kemi_ok');
    const posts = f.calls.filter((c) => c.method === 'POST');
    expect(posts.map((p) => p.url)).toEqual(Array(2).fill('https://api.x.com/2/dm_conversations/with/555/messages'));
    expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual({ text: 'Hi Kemi' });
    expect(posts[0]?.headers['content-type']).toBe('application/json');
  });

  it('turns 429 into rate_limit with the plan message', async () => {
    const f = fakeFetch((c) =>
      c.url.includes('/users/by/')
        ? json(200, { data: { id: '555' } })
        : json(429, { title: 'Too Many Requests' }, { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': '1793700000' }),
    );
    expect(await adapterWith(f).send(HELLO)).toEqual({ ok: false, error: { code: 'rate_limit', message: RATE_MESSAGE } });
  });

  it('refreshes the token once on 401, saves it, and retries', async () => {
    const saved: Array<Record<string, string>> = [];
    let dmAttempts = 0;
    const f = fakeFetch((c) => {
      if (c.url.endsWith('/oauth2/token')) return json(200, { access_token: 'tok2', refresh_token: 'ref2', expires_in: 7200, token_type: 'bearer' });
      if (c.url.includes('/users/by/')) return json(200, { data: { id: '555' } });
      dmAttempts++;
      return c.headers.authorization === 'Bearer tok2' ? json(201, { data: { dm_event_id: 'ev9' } }) : json(401, { title: 'Unauthorized' });
    });
    const adapter = adapterWith(f, SECRET, { onSecretChange: (s: Record<string, string>) => saved.push(s) });
    expect(await adapter.send(HELLO)).toEqual({ ok: true, externalId: 'ev9' });
    expect(dmAttempts).toBe(2);
    const refresh = f.calls.find((c) => c.url.endsWith('/oauth2/token'));
    expect(refresh?.url).toBe('https://api.x.com/2/oauth2/token');
    expect(refresh?.headers.authorization).toBeUndefined(); // a public app sends only its client id
    expect(refresh?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(refresh?.body ?? '').get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(refresh?.body ?? '').get('refresh_token')).toBe('ref1');
    expect(new URLSearchParams(refresh?.body ?? '').get('client_id')).toBe('cid');
    expect(saved).toEqual([{ ...SECRET, accessToken: 'tok2', refreshToken: 'ref2' }]);
    // The next send uses the new token without refreshing again.
    await adapter.send(HELLO);
    expect(f.calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(1);
  });

  it('reports auth when 401 cannot be refreshed or the retry is also rejected', async () => {
    const noRefresh = fakeFetch(() => json(401, {}));
    const bare = createXAdapter({ accessToken: 'tok1', userId: '100', username: 'founder' }, { fetch: noRefresh.fetch });
    const result = await bare.send(HELLO);
    expect(result).toMatchObject({ ok: false, error: { code: 'auth' } });
    expect(noRefresh.calls.some((c) => c.url.endsWith('/oauth2/token'))).toBe(false);

    const stillBad = fakeFetch((c) => (c.url.endsWith('/oauth2/token') ? json(200, { access_token: 'tok2' }) : json(401, {})));
    expect(await adapterWith(stillBad).send(HELLO)).toMatchObject({ ok: false, error: { code: 'auth' } });
    expect(stillBad.calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(1);

    const refreshDenied = fakeFetch((c) => (c.url.endsWith('/oauth2/token') ? json(400, { error: 'invalid_request' }) : json(401, {})));
    expect(await adapterWith(refreshDenied).send(HELLO)).toMatchObject({ ok: false, error: { code: 'auth' } });
  });

  it('maps unknown people and closed DMs to invalid_recipient', async () => {
    const missing = fakeFetch(() =>
      json(200, { errors: [{ title: 'Not Found Error', detail: 'Could not find user with username: [kemi_ok].', type: 'https://api.twitter.com/2/problems/resource-not-found' }] }),
    );
    expect(await adapterWith(missing).send(HELLO)).toMatchObject({ ok: false, error: { code: 'invalid_recipient' } });

    const closed = fakeFetch((c) =>
      c.url.includes('/users/by/') ? json(200, { data: { id: '555' } }) : json(403, { title: 'Forbidden', detail: 'You cannot send messages to this user.', status: 403 }),
    );
    expect(await adapterWith(closed).send(HELLO)).toMatchObject({ ok: false, error: { code: 'invalid_recipient' } });

    const notFound = fakeFetch(() => json(404, {}));
    expect(await adapterWith(notFound).send(HELLO)).toMatchObject({ ok: false, error: { code: 'invalid_recipient' } });

    expect(await adapterWith(fakeFetch(() => json(200, {}))).send({ ...HELLO, to: { ...HELLO.to, xHandle: null } })).toMatchObject({
      ok: false,
      error: { code: 'invalid_recipient' },
    });
  });

  it('treats a plan without DM access as auth, not as a bad recipient', async () => {
    const f = fakeFetch(() =>
      json(403, { title: 'Client Forbidden', reason: 'client-not-enrolled', detail: 'Your app is not attached to a Project.', type: 'https://api.twitter.com/2/problems/client-forbidden' }),
    );
    expect(await adapterWith(f).send(HELLO)).toMatchObject({ ok: false, error: { code: 'auth' } });
  });

  it('maps server trouble and a dead network to temporary', async () => {
    expect(await adapterWith(fakeFetch(() => json(503, {}))).send(HELLO)).toMatchObject({ ok: false, error: { code: 'temporary' } });
    const down = createXAdapter(SECRET, {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    expect(await down.send(HELLO)).toMatchObject({ ok: false, error: { code: 'temporary' } });
  });

  it('maps a message that was sent and whose answer was lost to unknown, not temporary', async () => {
    const calls: string[] = [];
    const f = fakeFetch((c) => {
      calls.push(`${c.method} ${c.url}`);
      if (c.method === 'GET') return json(200, { data: { id: '200', username: 'kemi_ok' } });
      throw new TypeError('terminated');
    });
    const result = await adapterWith(f).send(HELLO);
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown' } });
    expect(result.ok ? '' : result.error.message).toMatch(/may have gone/);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  it('keeps a failed lookup temporary, since nothing was sent', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await adapterWith(f).send(HELLO)).toMatchObject({ ok: false, error: { code: 'temporary' } });
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('reports auth when nothing is connected', async () => {
    const f = fakeFetch(() => json(200, {}));
    expect(await createXAdapter(null, { fetch: f.fetch }).send(HELLO)).toMatchObject({ ok: false, error: { code: 'auth' } });
    expect(f.calls).toHaveLength(0);
  });
});

describe('x poll', () => {
  const page = {
    data: [
      { id: 'e3', event_type: 'MessageCreate', sender_id: '555', text: 'Yes, Thursday works', created_at: '2026-11-02T09:30:00.000Z', dm_conversation_id: '100-555' },
      { id: 'e2', event_type: 'MessageCreate', sender_id: '100', text: 'Hi Kemi', created_at: '2026-11-02T09:00:00.000Z', dm_conversation_id: '100-555' },
      { id: 'e1', event_type: 'MessageCreate', sender_id: '555', text: 'older reply', created_at: '2026-11-01T08:00:00.000Z', dm_conversation_id: '100-555' },
    ],
    includes: { users: [{ id: '555', username: 'Kemi_OK', name: 'Kemi Okoye' }, { id: '100', username: 'founder', name: 'Gabriel' }] },
    meta: { result_count: 3 },
  };

  it('asks for message events with sender expansion and emits replies after since', async () => {
    const f = fakeFetch(() => json(200, page));
    const events = await adapterWith(f).poll(new Date('2026-11-02T00:00:00Z'));
    expect(events).toEqual([
      { type: 'reply', from: { xHandle: 'kemi_ok', name: 'Kemi Okoye' }, text: 'Yes, Thursday works', at: '2026-11-02T09:30:00.000Z', externalId: 'e3' },
    ]);
    const url = new URL(f.calls[0]?.url ?? '');
    expect(url.pathname).toBe('/2/dm_events');
    expect(url.searchParams.get('event_types')).toBe('MessageCreate');
    expect(url.searchParams.get('dm_event.fields')).toBe('sender_id,text,created_at');
    expect(url.searchParams.get('expansions')).toBe('sender_id');
    expect(url.searchParams.get('user.fields')).toBe('username');
  });

  it('never reports the same event twice', async () => {
    const adapter = adapterWith(fakeFetch(() => json(200, page)));
    expect(await adapter.poll(null)).toHaveLength(2);
    expect(await adapter.poll(null)).toEqual([]);
  });

  it('looks back three days when there is no since, and follows next_token while events are new enough', async () => {
    const f = fakeFetch((c) => {
      const token = new URL(c.url).searchParams.get('pagination_token');
      if (!token) {
        return json(200, {
          data: [{ id: 'p1', event_type: 'MessageCreate', sender_id: '555', text: 'one', created_at: '2026-11-02T09:00:00.000Z' }],
          includes: { users: [{ id: '555', username: 'kemi_ok' }] },
          meta: { next_token: 'abc' },
        });
      }
      return json(200, {
        data: [
          { id: 'p2', event_type: 'MessageCreate', sender_id: '555', text: 'two', created_at: '2026-10-31T12:00:00.000Z' },
          { id: 'p3', event_type: 'MessageCreate', sender_id: '555', text: 'too old', created_at: '2026-10-20T12:00:00.000Z' },
        ],
        includes: { users: [{ id: '555', username: 'kemi_ok' }] },
        meta: { next_token: 'def' },
      });
    });
    const events = await adapterWith(f).poll(null);
    expect(events.map((e) => (e.type === 'reply' ? e.text : ''))).toEqual(['two', 'one']); // oldest first
    // The second page already reached events older than three days, so there is no third request.
    expect(f.calls).toHaveLength(2);
  });

  it('skips events whose sender is not in the expansion and returns nothing for an empty page', async () => {
    const stranger = fakeFetch(() => json(200, { data: [{ id: 'z', event_type: 'MessageCreate', sender_id: '999', text: 'hi', created_at: '2026-11-02T09:30:00.000Z' }], includes: { users: [] } }));
    expect(await adapterWith(stranger).poll(null)).toEqual([]);
    expect(await adapterWith(fakeFetch(() => json(200, { meta: { result_count: 0 } }))).poll(null)).toEqual([]);
  });

  it('throws a clear error when X refuses the poll', async () => {
    await expect(adapterWith(fakeFetch(() => json(429, {}))).poll(null)).rejects.toThrow(/daily limit/);
    await expect(adapterWith(fakeFetch(() => json(401, {}))).poll(null)).rejects.toMatchObject({ code: 'auth', message: 'X signed Callum out. Connect X again from Your Callum.' });
    await expect(createXAdapter(null, { fetch: fakeFetch(() => json(200, {})).fetch }).poll(null)).rejects.toBeInstanceOf(ConnectError);
    await expect(adapterWith(fakeFetch(() => json(500, {}))).poll(null)).rejects.toThrow(/X/);
  });
});
