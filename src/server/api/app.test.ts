import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppState, OutboxItem, Person, Project } from '../../shared/types.js';
import { TemplateWriter } from '../ai/templates.js';
import { ConnectError, type AdapterFactory } from '../channels/types.js';
import { createCtx, type Ctx } from '../context.js';
import { openDb } from '../db/db.js';
import { fixedClock } from '../engine/clock.js';
import { ApolloSource } from '../leads/apollo.js';
import { UserError } from '../services/errors.js';
import { createApp, SOMETHING_WENT_WRONG } from './app.js';

const MONDAY = '2026-11-02T10:00:00.000Z';

interface SetupOptions {
  demo?: boolean;
  password?: string | null;
  factory?: AdapterFactory;
  extraRoutes?: Hono[];
  webDir?: string | null;
  runner?: { tick(): Promise<unknown> };
}

function setup(opts: SetupOptions = {}) {
  const clock = fixedClock(MONDAY);
  const ctx = createCtx({
    db: openDb(':memory:'), clock, writer: new TemplateWriter(clock), demo: opts.demo ?? true, env: {}, dataDir: '/tmp/callum-test',
    ...(opts.factory ? { factory: opts.factory } : {}),
  });
  ctx.repo.updateSettings({ senderName: 'Ada Obi', senderEmail: 'ada@example.com', timezone: 'Africa/Lagos' });
  const problems: unknown[] = [];
  const app = createApp(ctx, {
    password: opts.password ?? null,
    webDir: opts.webDir ?? null,
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.extraRoutes ? { extraRoutes: opts.extraRoutes } : {}),
    onError: (e) => problems.push(e),
  });
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const get = (path: string, headers?: Record<string, string>) => send('GET', path, undefined, headers);
  const post = (path: string, body: unknown = {}, headers?: Record<string, string>) => send('POST', path, body, headers);
  return { app, ctx, clock, get, post, problems };
}
type Harness = ReturnType<typeof setup>;

const state = async (h: Harness) => (await (await h.get('/api/state')).json()) as AppState;
const names = (n: number, domain = 'okopay.com') => Array.from({ length: n }, (_, i) => `Person${i + 1} Test <p${i + 1}@${domain}>`).join('\n');

/** Email connected, one project and `n` people in it. */
async function ready(h: Harness, n: number): Promise<Project> {
  expect((await h.post('/api/channels/email/connect', { address: 'ada@example.com' })).status).toBe(200);
  const project = (await (await h.post('/api/projects', { offer: 'You help fintech teams close the books faster', name: 'Reconciliation' })).json()) as Project;
  const res = await h.post('/api/leads/import', { paste: names(n), projectId: project.id });
  expect(res.status).toBe(200);
  return project;
}

describe('state', () => {
  it('answers with the whole app state and none of the secrets', async () => {
    const h = setup();
    h.ctx.repo.setChannelSecret('email', { password: 'hunter2-secret', accessToken: 'token-abc', refreshToken: 'refresh-xyz' });
    h.ctx.repo.updateChannel('email', { status: 'connected', identity: 'ada@example.com' });
    const res = await h.get('/api/state');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as AppState;
    expect(Object.keys(body).sort()).toEqual(['brief', 'channels', 'demo', 'incidents', 'outbox', 'people', 'projects', 'settings']);
    expect(body.demo).toBe(true);
    expect(body.channels.map((c) => c.channel).sort()).toEqual(['email', 'linkedin', 'x']);
    const text = JSON.stringify(body);
    for (const secret of ['hunter2-secret', 'token-abc', 'refresh-xyz', 'password', 'accessToken']) expect(text).not.toContain(secret);
  });

  it('answers 404 in JSON for a route it does not have', async () => {
    const h = setup();
    const res = await h.get('/api/nothing-here');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Callum can't find that." });
  });
});

describe('errors', () => {
  const failing = new Hono();
  failing.get('/user', () => {
    throw new UserError('Add your calendar link first', 422, { field: 'calendarUrl' });
  });
  failing.get('/gone', () => {
    throw new UserError('Nobody by that name', 404);
  });
  failing.get('/boom', () => {
    throw new Error('SQLITE_CONSTRAINT: secret detail');
  });

  it('shows a UserError with its status, message and detail', async () => {
    const h = setup({ extraRoutes: [failing] });
    const res = await h.get('/api/user');
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Add your calendar link first', detail: { field: 'calendarUrl' } });
    const gone = await h.get('/api/gone');
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'Nobody by that name' });
  });

  it('says only the calm line for anything unexpected, and reports the real cause', async () => {
    const h = setup({ extraRoutes: [failing] });
    const res = await h.get('/api/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: SOMETHING_WENT_WRONG });
    expect(SOMETHING_WENT_WRONG).toBe('Something went wrong. Callum kept everything as it was.');
    expect(String(h.problems[0])).toContain('secret detail');
  });

  it('turns a channel that will not connect into a 422 with its own words', async () => {
    const factory: AdapterFactory = (channel) => ({
      channel,
      connect: () => Promise.reject(new ConnectError("That app password didn't work. Check it and try again.")),
      send: () => Promise.reject(new Error('unused')),
      poll: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    });
    const h = setup({ factory });
    const res = await h.post('/api/channels/email/connect', { address: 'ada@example.com', password: 'x' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "That app password didn't work. Check it and try again." });
  });

  it('refuses a body that is not JSON', async () => {
    const h = setup();
    const res = await h.app.request('/api/settings', { method: 'POST', body: '{nope' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Callum couldn't read that request.");
  });

  it('mounts route modules from other parts of Callum under /api', async () => {
    const extra = new Hono().get('/extra/ping', (c) => c.json({ pong: true }));
    const h = setup({ extraRoutes: [extra] });
    expect(await (await h.get('/api/extra/ping')).json()).toEqual({ pong: true });
  });
});

describe('channels and settings', () => {
  it('connects email through the demo adapter and remembers the sender address', async () => {
    const h = setup();
    const res = await h.post('/api/channels/email/connect', { address: 'ada@example.com' });
    expect(res.status).toBe(200);
    const account = (await res.json()) as { channel: string; status: string; identity: string };
    expect(account).toMatchObject({ channel: 'email', status: 'connected' });
    expect((await state(h)).channels.find((c) => c.channel === 'email')?.status).toBe('connected');
    expect((await state(h)).settings.senderEmail).toBe(account.identity);
  });

  it('disconnects, and knows no channel called fax', async () => {
    const h = setup();
    await h.post('/api/channels/email/connect', {});
    const res = await h.post('/api/channels/email/disconnect');
    expect(((await res.json()) as { status: string }).status).toBe('disconnected');
    expect((await h.post('/api/channels/fax/connect', {})).status).toBe(404);
  });

  it('resumes a paused channel at half pace, and refuses one that is not connected', async () => {
    const h = setup();
    expect((await h.post('/api/channels/linkedin/resume', { pace: 'half' })).status).toBe(422);
    await h.post('/api/channels/linkedin/connect', {});
    h.ctx.repo.updateChannel('linkedin', { status: 'paused' });
    const res = await h.post('/api/channels/linkedin/resume', { pace: 'half' });
    const account = (await res.json()) as { status: string; halfPaceUntil: string };
    expect(account.status).toBe('connected');
    expect(account.halfPaceUntil).toBe('2026-11-09T10:00:00.000Z');
    expect((await h.post('/api/channels/linkedin/resume', { pace: 'slow' })).status).toBe(422);
  });

  it('saves the sender name, time zone and notifications, and ignores what moved to projects', async () => {
    const h = setup();
    const res = await h.post('/api/settings', { senderName: ' Ada Obi ', timezone: 'Europe/London', notifications: true, offer: 'ignored', tone: 'direct' });
    expect(res.status).toBe(200);
    const settings = (await res.json()) as Record<string, unknown>;
    expect(settings).toMatchObject({ senderName: 'Ada Obi', timezone: 'Europe/London', notifications: true });
    expect(settings).not.toHaveProperty('offer');
    expect(settings).not.toHaveProperty('tone');
    expect((await h.post('/api/settings', { timezone: 'Mars/Olympus' })).status).toBe(422);
    expect((await h.post('/api/settings', { notifications: 'yes' })).status).toBe(422);
  });

  it('tells the page when settings change', async () => {
    const h = setup();
    const seen: string[] = [];
    h.ctx.bus.on((s) => seen.push(s));
    await h.post('/api/settings', { senderName: 'Ada' });
    expect(seen).toContain('settings');
  });
});

describe('projects', () => {
  it('creates, lists, and refuses a name that is taken', async () => {
    const h = setup();
    const one = await h.post('/api/projects', { offer: 'Reconciliation for fintech teams', name: 'Reconciliation' });
    expect(one.status).toBe(200);
    const first = (await one.json()) as Project;
    expect(first).toMatchObject({ name: 'Reconciliation', offer: 'Reconciliation for fintech teams', tone: 'warm' });
    const second = (await (await h.post('/api/projects', { offer: 'Payroll for small shops', name: 'Payroll' })).json()) as Project;

    const list = (await (await h.get('/api/projects')).json()) as Project[];
    expect(list.map((p) => p.name)).toEqual(['Reconciliation', 'Payroll']);

    const dup = await h.post('/api/projects', { offer: 'Something else', name: 'Reconciliation' });
    expect(dup.status).toBe(422);
    const copy = ((await dup.json()) as { error: string }).error;
    expect(copy).toContain('Reconciliation');

    const rename = await h.post(`/api/projects/${second.id}`, { name: 'Reconciliation', audience: 'Shop owners' });
    expect(rename.status).toBe(422);
    expect(((await rename.json()) as { error: string }).error).toBe(copy);
    // The rename failed, so the audience that came with it did not stick either.
    expect(h.ctx.repo.getProject(second.id)).toMatchObject({ name: 'Payroll', audience: null });
  });

  it('renames and updates in one request', async () => {
    const h = setup();
    const p = (await (await h.post('/api/projects', { offer: 'Offer one', name: 'One' })).json()) as Project;
    const res = await h.post(`/api/projects/${p.id}`, { name: 'Uno', tone: 'direct', audience: 'Finance leads' });
    expect(await res.json()).toMatchObject({ id: p.id, name: 'Uno', tone: 'direct', audience: 'Finance leads' });
    expect((await h.post('/api/projects/999', { tone: 'warm' })).status).toBe(404);
    expect((await h.post(`/api/projects/${p.id}`, { tone: 'shouty' })).status).toBe(422);
  });

  it('needs an offer to start one', async () => {
    const h = setup();
    expect((await h.post('/api/projects', { name: 'Empty' })).status).toBe(422);
  });

  it('pauses, resumes and wraps a project and makes one current', async () => {
    const h = setup();
    const a = (await (await h.post('/api/projects', { offer: 'A', name: 'A' })).json()) as Project;
    const b = (await (await h.post('/api/projects', { offer: 'B', name: 'B' })).json()) as Project;
    const paused = (await (await h.post(`/api/projects/${b.id}/pause`, { until: '2026-11-09T08:00:00.000Z' })).json()) as Project;
    expect(paused).toMatchObject({ state: 'paused', pausedUntil: '2026-11-09T08:00:00.000Z' });
    expect(((await (await h.post(`/api/projects/${b.id}/resume`)).json()) as Project).state).toBe('running');
    const settings = (await (await h.post('/api/projects/current', { id: b.id })).json()) as { currentProjectId: number };
    expect(settings.currentProjectId).toBe(b.id);
    const wrapped = (await (await h.post(`/api/projects/${a.id}/wrap`)).json()) as { summary: string };
    expect(wrapped.summary).toBe('Nobody else in A hears from you. 0 follow-ups and 0 first hellos are cancelled.');
    expect((await h.post('/api/projects/current', { id: a.id })).status).toBe(422);
    expect((await h.post('/api/projects/current', {})).status).toBe(404);
  });
});

describe('adding people', () => {
  it('imports a pasted list and answers with who was added', async () => {
    const h = setup();
    const project = (await (await h.post('/api/projects', { offer: 'Offer', name: 'One' })).json()) as Project;
    const res = await h.post('/api/leads/import', { paste: 'Kemi Eze <kemi@okopay.com>\nTunde Bello <tunde@payvault.io>', projectId: project.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { added: Person[]; skipped: unknown[] };
    expect(body.added).toHaveLength(2);
    expect(body.added.map((p) => p.firstName)).toEqual(['Kemi', 'Tunde']);
    expect(body.added.every((p) => p.stage === 'stranger' && p.projectId === project.id)).toBe(true);
    expect((await state(h)).people).toHaveLength(2);
  });

  it('reads a CSV and reports who it skipped', async () => {
    const h = setup();
    await h.post('/api/projects', { offer: 'Offer', name: 'One' });
    const csv = 'Name,Email,Company\nKemi Eze,kemi@okopay.com,Oko Pay\nKemi Again,kemi@okopay.com,Oko Pay\n';
    const body = (await (await h.post('/api/leads/import', { csv })).json()) as { added: Person[]; skipped: { reason: string }[] };
    expect(body.added).toHaveLength(1);
    expect(body.skipped.map((s) => s.reason)).toEqual(['duplicate']);
  });

  it('puts people in the project it was told, and in the current one when it was told nothing', async () => {
    const h = setup();
    const one = (await (await h.post('/api/projects', { offer: 'One', name: 'One' })).json()) as Project;
    const two = (await (await h.post('/api/projects', { offer: 'Two', name: 'Two' })).json()) as Project;
    await h.post('/api/leads/import', { paste: 'Kemi Eze <kemi@okopay.com>', projectId: two.id });
    await h.post('/api/leads/import', { paste: 'Tunde Bello <tunde@payvault.io>' });
    const people = (await state(h)).people;
    expect(people.find((p) => p.firstName === 'Kemi')?.projectId).toBe(two.id);
    expect(people.find((p) => p.firstName === 'Tunde')?.projectId).toBe(one.id);
    // Someone in project 2 is not added to project 1 as well.
    const again = (await (await h.post('/api/leads/import', { paste: 'Kemi Eze <kemi@okopay.com>', projectId: one.id })).json()) as { added: Person[]; skipped: { reason: string }[] };
    expect(again.added).toEqual([]);
    expect(again.skipped[0]?.reason).toBe('other_project');
  });

  it('refuses an empty import and a project that does not exist', async () => {
    const h = setup();
    const empty = await h.post('/api/leads/import', { projectId: 99 });
    expect(empty.status).toBe(404);
    await h.post('/api/projects', { offer: 'Offer', name: 'One' });
    expect((await h.post('/api/leads/import', {})).status).toBe(422);
    expect((await h.post('/api/leads/import', { paste: '   ' })).status).toBe(422);
  });

  it('needs LinkedIn connected, and a LinkedIn link, to read a search', async () => {
    const h = setup();
    await h.post('/api/projects', { offer: 'Offer', name: 'One' });
    const notConnected = await h.post('/api/leads/import', { linkedinSearchUrl: 'https://www.linkedin.com/search/results/people/?keywords=cfo' });
    expect(notConnected.status).toBe(422);
    expect(((await notConnected.json()) as { error: string }).error).toBe('Connect LinkedIn first, then Callum can read that search.');
    const elsewhere = await h.post('/api/leads/import', { linkedinSearchUrl: 'https://example.com/search' });
    expect(((await elsewhere.json()) as { error: string }).error).toBe("That doesn't look like a LinkedIn search link.");
  });

  it('reads a LinkedIn search through the connected LinkedIn adapter', async () => {
    const asked: { url: string; limit: number }[] = [];
    const factory: AdapterFactory = (channel) => ({
      channel,
      connect: () => Promise.resolve({ identity: 'Ada on LinkedIn', secret: {} }),
      send: () => Promise.reject(new Error('unused')),
      poll: () => Promise.resolve([]),
      close: () => Promise.resolve(),
      searchPeople: (url, limit) => {
        asked.push({ url, limit });
        return Promise.resolve([{ name: 'Kemi Eze', source: 'linkedin_search' as const, linkedinUrl: 'https://www.linkedin.com/in/kemi-eze' }]);
      },
    });
    const h = setup({ factory });
    await h.post('/api/projects', { offer: 'Offer', name: 'One' });
    await h.post('/api/channels/linkedin/connect', {});
    const res = await h.post('/api/leads/import', { linkedinSearchUrl: 'linkedin.com/search/results/people/?keywords=cfo' });
    const body = (await res.json()) as { added: Person[] };
    expect(body.added.map((p) => p.name)).toEqual(['Kemi Eze']);
    expect(asked).toEqual([{ url: 'https://linkedin.com/search/results/people/?keywords=cfo', limit: 100 }]);
  });
});

describe('searching with Apollo', () => {
  it('asks for a list when Apollo is not connected', async () => {
    const h = setup();
    await h.post('/api/projects', { offer: 'Offer', name: 'One' });
    const res = await h.post('/api/leads/search', { query: 'heads of finance in Lagos' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Callum needs a list for that. Bring a CSV or a LinkedIn search link.' });
  });

  it('looks people up and adds them to the project', async () => {
    const h = setup();
    const project = (await (await h.post('/api/projects', { offer: 'Offer', name: 'One' })).json()) as Project;
    const calls: string[] = [];
    h.ctx.apollo = new ApolloSource('key', (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const json = url.includes('api_search')
        ? { people: [{ id: 'a1', first_name: 'Kemi', last_name_obfuscated: 'Ez***', title: 'Head of Finance', has_email: true, organization: { name: 'Oko Pay' } }], pagination: { total_entries: 40, total_pages: 2 } }
        : { matches: [{ id: 'a1', first_name: 'Kemi', last_name: 'Eze', name: 'Kemi Eze', title: 'Head of Finance', email_status: 'verified', email: 'kemi@okopay.com', organization: { name: 'Oko Pay' } }], credits_consumed: 1 };
      return Promise.resolve(new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } }));
    });
    const res = await h.post('/api/leads/search', { query: 'heads of finance', count: 5, projectId: project.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; added: Person[]; skipped: unknown[]; creditsUsed: number };
    expect(body.total).toBe(40);
    expect(body.creditsUsed).toBe(1);
    expect(body.added.map((p) => [p.name, p.email, p.source, p.projectId])).toEqual([['Kemi Eze', 'kemi@okopay.com', 'apollo', project.id]]);
    expect(calls).toHaveLength(2);
  });

  it('adds the people it had already looked up when Apollo stops part way, and says so', async () => {
    const h = setup();
    await h.post('/api/projects', { offer: 'Offer', name: 'One' });
    const previews = Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, first_name: `P${i}`, last_name_obfuscated: 'Ez***', has_email: true, organization: { name: 'Oko Pay' } }));
    let enrichCalls = 0;
    h.ctx.apollo = new ApolloSource('key', (input: string | URL | Request) => {
      if (String(input).includes('api_search')) {
        return Promise.resolve(new Response(JSON.stringify({ people: previews, pagination: { total_entries: 11, total_pages: 1 } })));
      }
      enrichCalls += 1;
      if (enrichCalls > 1) return Promise.resolve(new Response('{}', { status: 429 }));
      const matches = previews.slice(0, 10).map((p) => ({ id: p.id, first_name: p.first_name, last_name: 'Eze', name: `${p.first_name} Eze`, email_status: 'verified', email: `${p.first_name.toLowerCase()}@okopay.com` }));
      return Promise.resolve(new Response(JSON.stringify({ matches, credits_consumed: 10 })));
    });
    const res = await h.post('/api/leads/search', { query: 'finance', count: 11 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { added: Person[]; creditsUsed: number; error: string };
    expect(body.added).toHaveLength(10);
    expect(body.creditsUsed).toBe(10);
    expect(body.error).toContain("Apollo's lookup limit is reached");
    expect(body.error).toContain('10');
  });

  it('turns an Apollo failure into its own plain words', async () => {
    const h = setup();
    await h.post('/api/projects', { offer: 'Offer', name: 'One' });
    h.ctx.apollo = new ApolloSource('key', () => Promise.resolve(new Response('{}', { status: 401 })));
    const res = await h.post('/api/leads/search', { query: 'cfo' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("Apollo didn't accept the API key");
  });
});

describe('starting and approving', () => {
  it('starts a project: ten first hellos wait for an OK, and approving one leaves nine', async () => {
    const h = setup();
    const project = await ready(h, 12);
    const res = await h.post('/api/start', { projectId: project.id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { firstSendAt: string }).firstSendAt).toBe('2026-11-03T08:00:00.000Z');

    const waiting = (await state(h)).outbox.filter((i) => i.state === 'awaiting_ok');
    expect(waiting).toHaveLength(10);
    expect((await state(h)).settings.onboarded).toBe(true);

    const approve = await h.post(`/api/outbox/${waiting[0]!.id}/approve`, {});
    expect(approve.status).toBe(200);
    expect(((await approve.json()) as OutboxItem).state).toBe('scheduled');
    expect((await state(h)).outbox.filter((i) => i.state === 'awaiting_ok')).toHaveLength(9);
  });

  it('shows the plan before starting, and the sample hello in a tone', async () => {
    const h = setup();
    const project = await ready(h, 12);
    const plan = (await (await h.get(`/api/plan?projectId=${project.id}`)).json()) as { line: string; total: number };
    expect(plan.line).toBe('Tomorrow from 9:00 their time: 12 hellos, 12 by email. Nothing goes out today.');
    const sample = (await (await h.get(`/api/sample?tone=direct&projectId=${project.id}`)).json()) as { body: string };
    expect(sample.body).toContain('Person1');
    expect((await h.get('/api/sample?tone=shouty')).status).toBe(422);
  });

  it('will not start without a channel or people, in words', async () => {
    const h = setup();
    const project = (await (await h.post('/api/projects', { offer: 'Offer', name: 'One' })).json()) as Project;
    const none = await h.post('/api/start', { projectId: project.id });
    expect(none.status).toBe(422);
    expect(((await none.json()) as { error: string }).error).toBe('Connect a channel first');
    await h.post('/api/channels/email/connect', {});
    const empty = await h.post('/api/start', { projectId: project.id });
    expect(((await empty.json()) as { error: string }).error).toBe('Add some people first');
  });

  it('skips a hello and a person who is not a fit', async () => {
    const h = setup();
    const project = await ready(h, 12);
    await h.post('/api/start', { projectId: project.id });
    const items = (await state(h)).outbox.filter((i) => i.state === 'awaiting_ok');
    const skipped = (await (await h.post(`/api/outbox/${items[0]!.id}/skip`)).json()) as OutboxItem;
    expect(skipped.state).toBe('cancelled');
    const person = (await state(h)).people.find((p) => p.id === items[1]!.personId)!;
    const removed = (await (await h.post(`/api/people/${person.id}/remove`)).json()) as Person;
    expect(removed.status).toBe('removed');
    expect((await state(h)).people.some((p) => p.id === person.id)).toBe(false);
  });
});

describe('a person who wrote back', () => {
  async function waitingPerson(h: Harness): Promise<Person> {
    const project = await ready(h, 2);
    const person = h.ctx.repo.listPeople({ projectId: project.id })[0]!;
    return h.ctx.repo.updatePerson(person.id, {
      status: 'waiting', stage: 'talking', channel: 'email', touches: 1, replyKind: 'interested', suggested: 'reply',
      lastInbound: 'Can you tell me more about pricing?', repliedAt: MONDAY,
    });
  }

  it('shows the whole conversation', async () => {
    const h = setup();
    const person = await waitingPerson(h);
    h.ctx.repo.insertMessage({
      personId: person.id, channel: 'email', direction: 'in', kind: 'inbound', subject: 'Re: hello', body: 'Can you tell me more about pricing?', at: MONDAY, externalId: '<a@b>',
    });
    const detail = (await (await h.get(`/api/people/${person.id}`)).json()) as { person: Person; messages: unknown[]; path: unknown[] };
    expect(detail.person.id).toBe(person.id);
    expect(detail.messages).toHaveLength(1);
    expect(Array.isArray(detail.path)).toBe(true);
    expect((await h.get('/api/people/9999')).status).toBe(404);
    expect((await h.get('/api/people/abc')).status).toBe(404);
  });

  it('refuses a reply with a blank still in it, with the guard copy', async () => {
    const h = setup();
    const person = await waitingPerson(h);
    const res = await h.post(`/api/people/${person.id}/reply`, { body: 'Our price is [YOUR PRICE] a month.' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('Add your price first. Callum never sends a message with [YOUR PRICE] in it.');
  });

  it('sends a reply after the undo window, and undo cancels it', async () => {
    const h = setup();
    const person = await waitingPerson(h);
    const sent = await h.post(`/api/people/${person.id}/reply`, { body: 'It starts at 40 a month. Want a quick call?' });
    expect(sent.status).toBe(200);
    const item = (await sent.json()) as OutboxItem;
    expect(item).toMatchObject({ state: 'scheduled', origin: 'user', kind: 'reply' });
    expect(item.undoUntil).toBe('2026-11-02T10:00:10.000Z');
    const undone = (await (await h.post(`/api/outbox/${item.id}/undo`)).json()) as OutboxItem;
    expect(undone.state).toBe('cancelled');
  });

  it('will not book without a calendar link, and offers a draft', async () => {
    const h = setup();
    const person = await waitingPerson(h);
    const book = await h.post(`/api/people/${person.id}/book`, {});
    expect(book.status).toBe(422);
    expect(((await book.json()) as { error: string }).error).toBe('Add your calendar link first');
    const draft = await h.get(`/api/people/${person.id}/draft?kind=reply`);
    expect(typeof ((await draft.json()) as { body: string }).body).toBe('string');
    expect((await h.get(`/api/people/${person.id}/draft?kind=poem`)).status).toBe(422);
  });

  it('snoozes, holds, resumes and corrects', async () => {
    const h = setup();
    const person = await waitingPerson(h);
    const stranger = h.ctx.repo.listPeople().find((p) => p.status === 'active')!;
    expect(((await (await h.post(`/api/people/${stranger.id}/hold`)).json()) as Person).status).toBe('held');
    expect(((await (await h.post(`/api/people/${stranger.id}/resume`)).json()) as Person).status).toBe('active');
    const snoozed = (await (await h.post(`/api/people/${person.id}/snooze`, {})).json()) as Person;
    expect(snoozed.status).toBe('snoozed');
    expect(snoozed.snoozedUntil).toBe('2026-11-09T08:00:00.000Z');

    h.ctx.repo.updatePerson(stranger.id, { status: 'waiting', stage: 'talking', channel: 'email', touches: 1, replyKind: 'interested', suggested: 'reply' });
    expect((await h.post(`/api/people/${stranger.id}/correct`, { kind: 'nonsense' })).status).toBe(422);
    expect((await h.post(`/api/people/${stranger.id}/correct`, { kind: 'wrong_person' })).status).toBe(200);
  });

  it('moves a stranger to another project, and keeps a talking person where they are', async () => {
    const h = setup();
    const person = await waitingPerson(h);
    const other = (await (await h.post('/api/projects', { offer: 'Payroll', name: 'Payroll' })).json()) as Project;
    const stranger = h.ctx.repo.listPeople().find((p) => p.status === 'active')!;
    const moved = (await (await h.post(`/api/people/${stranger.id}/move`, { projectId: other.id })).json()) as Person;
    expect(moved.projectId).toBe(other.id);
    const refused = await h.post(`/api/people/${person.id}/move`, { projectId: other.id });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe(`${person.firstName} is talking with you about Reconciliation. Finish that conversation first.`);
  });
});

describe('ask', () => {
  it('answers a question, and says what it cannot do', async () => {
    const h = setup();
    const project = await ready(h, 2);
    const unknown = (await (await h.post('/api/ask', { text: 'sing me a song', projectId: project.id })).json()) as { text: string; action: unknown };
    expect(unknown.text).toBe("Callum can find people, pause a channel, change the tone, or tell you who's warming up.");
    const find = (await (await h.post('/api/ask', { text: 'find 20 more like Person1', projectId: project.id })).json()) as { text: string };
    expect(find.text).toBe('Callum needs a list for that. Bring a CSV or a LinkedIn search link.');
    expect((await h.post('/api/ask', { projectId: project.id })).status).toBe(422);
  });

  it('carries out an action Callum offered', async () => {
    const h = setup();
    const project = await ready(h, 2);
    await h.post('/api/channels/linkedin/connect', {});
    const answer = (await (await h.post('/api/ask/act', { projectId: project.id, action: { kind: 'pause_channel', label: 'Pause LinkedIn', args: { channel: 'linkedin' } } })).json()) as { text: string };
    expect(typeof answer.text).toBe('string');
    expect((await state(h)).channels.find((c) => c.channel === 'linkedin')?.status).toBe('paused');
    expect((await h.post('/api/ask/act', { projectId: project.id })).status).toBe(422);
  });
});

describe('leaving', () => {
  it('pauses everything until a date and resumes', async () => {
    const h = setup();
    await ready(h, 2);
    const paused = (await (await h.post('/api/pause', { until: '2026-11-16T08:00:00.000Z' })).json()) as { pauseState: string; pausedUntil: string };
    expect(paused).toMatchObject({ pauseState: 'paused', pausedUntil: '2026-11-16T08:00:00.000Z' });
    expect(((await (await h.post('/api/resume')).json()) as { pauseState: string }).pauseState).toBe('running');
  });

  it('wraps up, keeping or deleting the data', async () => {
    const h = setup();
    const project = await ready(h, 12);
    await h.post('/api/start', { projectId: project.id });
    const summary = (await (await h.get('/api/wrap/summary')).json()) as { line: string };
    expect(summary.line).toBe('Callum said hello to 0 people for you. 0 replied, and 0 calls got booked.');
    const wrapped = (await (await h.post('/api/wrap', { deleteData: false })).json()) as { cancelledHellos: number; summary: string };
    expect(wrapped.cancelledHellos).toBe(10);
    expect(wrapped.summary).toBe('Nobody else hears from you. 0 follow-ups and 10 first hellos are cancelled.');
    expect((await state(h)).settings.pauseState).toBe('wrapped');
    expect((await state(h)).people).toHaveLength(12);

    await h.post('/api/wrap', { deleteData: true });
    const after = await state(h);
    expect(after.people).toEqual([]);
    expect(after.settings.pauseState).toBe('wrapped');
  });

  it('starts again with the people kept', async () => {
    const h = setup();
    const project = await ready(h, 3);
    await h.post('/api/start', { projectId: project.id });
    await h.post('/api/wrap', { deleteData: false });
    const settings = (await (await h.post('/api/start-again')).json()) as { onboarded: boolean; pauseState: string };
    expect(settings).toMatchObject({ onboarded: false, pauseState: 'running' });
    expect((await state(h)).people).toHaveLength(3);
  });

  it('downloads everything as CSV and as JSON', async () => {
    const h = setup();
    const project = await ready(h, 2);
    h.ctx.repo.updatePerson(h.ctx.repo.listPeople({ projectId: project.id })[0]!.id, { company: 'Oko, Pay' });

    const csv = await h.get('/api/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="callum-export-2026-11-02.csv"');
    const text = await csv.text();
    expect(text).toContain('"Oko, Pay"');

    const json = await h.get(`/api/export.json?projectId=${project.id}`);
    expect(json.headers.get('content-type')).toContain('application/json');
    expect(json.headers.get('content-disposition')).toBe('attachment; filename="callum-export-2026-11-02.json"');
    const data = (await json.json()) as { people: { name: string; messages: unknown[] }[] };
    expect(data.people).toHaveLength(2);
    expect(data.people[0]).toHaveProperty('messages');
    expect((await h.get('/api/export.csv?projectId=999')).status).toBe(404);
  });
});

describe('demo', () => {
  it('has no demo seed outside demo mode', async () => {
    const h = setup({ demo: false });
    const res = await h.post('/api/demo/seed', { scene: 'morning' });
    expect(res.status).toBe(404);
  });

  it('knows only the morning scene in demo mode', async () => {
    const h = setup({ demo: true });
    expect((await h.post('/api/demo/seed', { scene: 'evening' })).status).toBe(422);
  });
});

describe('live events', () => {
  it('writes a changed event when something changes', async () => {
    const h = setup();
    const abort = new AbortController();
    const res = await h.app.request('/api/events', { signal: abort.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    h.ctx.bus.emit('people');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: changed');
    expect(text).toContain('data: {"scope":"people"}');
    abort.abort();
    await reader.cancel().catch(() => undefined);
  });
});

describe('the password', () => {
  it('keeps everything behind it until sign-in', async () => {
    const h = setup({ password: 'open sesame' });
    const blocked = await h.get('/api/state');
    expect(blocked.status).toBe(401);
    expect(await blocked.json()).toEqual({ error: 'Sign in first' });
    expect((await h.get('/api/events')).status).toBe(401);
    expect((await h.post('/api/start')).status).toBe(401);

    expect((await h.post('/api/login', { password: 'wrong' })).status).toBe(401);
    const ok = await h.post('/api/login', { password: 'open sesame' });
    expect(ok.status).toBe(200);
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await h.get('/api/state', { cookie })).status).toBe(200);
  });

  it('does not guard the web page itself, so the sign-in can be shown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'callum-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Callum</title>');
    const h = setup({ password: 'open sesame', webDir: dir });
    expect((await h.get('/')).status).toBe(200);
  });
});

describe('requests from other sites', () => {
  it('refuses a post that comes from another origin when there is no password', async () => {
    const h = setup();
    const res = await h.post('/api/settings', { senderName: 'Mallory' }, { origin: 'https://evil.example', host: 'localhost:4600' });
    expect(res.status).toBe(403);
    expect(h.ctx.repo.getSettings().senderName).toBe('Ada Obi');
  });

  it('takes a post from its own page, and a get from anywhere', async () => {
    const h = setup();
    const own = await h.post('/api/settings', { senderName: 'Ada' }, { origin: 'http://localhost:4600', host: 'localhost:4600' });
    expect(own.status).toBe(200);
    expect((await h.get('/api/state', { origin: 'https://evil.example', host: 'localhost:4600' })).status).toBe(200);
  });
});

describe('waking the runner', () => {
  it('asks it to look for work after a change, but not after a read or a failure', async () => {
    const tick = vi.fn(() => Promise.resolve());
    const h = setup({ runner: { tick } });
    await h.get('/api/state');
    expect(tick).not.toHaveBeenCalled();
    await h.post('/api/settings', { timezone: 'Mars/Olympus' });
    expect(tick).not.toHaveBeenCalled();
    await h.post('/api/settings', { senderName: 'Ada' });
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the runner, and survives it failing', async () => {
    let finish: () => void = () => undefined;
    const slow = { tick: () => new Promise<void>((resolve) => { finish = resolve; }) };
    const h = setup({ runner: slow });
    expect((await h.post('/api/settings', { senderName: 'Ada' })).status).toBe(200);
    finish();

    const broken = setup({ runner: { tick: () => Promise.reject(new Error('runner down')) } });
    expect((await broken.post('/api/settings', { senderName: 'Ada' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(String(broken.problems[0])).toContain('runner down');
  });
});

describe('the web app', () => {
  function web() {
    const root = mkdtempSync(join(tmpdir(), 'callum-site-'));
    const dir = join(root, 'web');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Callum</title><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'app-1a2b3c.js'), 'console.log(1)');
    writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, 'secret.txt'), 'not for the web');
    return setup({ webDir: dir });
  }

  it('serves files with their types, and keeps built files cached', async () => {
    const h = web();
    const js = await h.get('/assets/app-1a2b3c.js');
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toBe('console.log(1)');
    expect((await h.get('/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml');
    const index = await h.get('/');
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.headers.get('cache-control')).toBe('no-cache');
  });

  it('answers any other address with the app, so it can handle its own routes', async () => {
    const h = web();
    const res = await h.get('/people/3');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });

  it('says 404 for a missing file and never answers an API address with the page', async () => {
    const h = web();
    expect((await h.get('/assets/missing.js')).status).toBe(404);
    const api = await h.get('/api/missing');
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toContain('application/json');
  });

  it('does not leave the web folder', async () => {
    const h = web();
    for (const path of ['/..%2Fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2F..%2Fsecret.txt']) {
      const res = await h.get(path);
      expect(await res.text()).not.toContain('not for the web');
    }
  });

  it('serves nothing when there is no web folder', async () => {
    const h = setup();
    expect((await h.get('/')).status).toBe(404);
  });
});

export type { Ctx };
