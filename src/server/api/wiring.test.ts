import { describe, expect, it } from 'vitest';
import type { AppState, Person } from '../../shared/types.js';
import { TemplateWriter } from '../ai/templates.js';
import type { Writer } from '../ai/writer.js';
import { createCtx, type Ctx } from '../context.js';
import { openDb } from '../db/db.js';
import { fixedClock } from '../engine/clock.js';
import { UserError } from '../services/errors.js';
import { createApp } from './app.js';
import { FEATURE_ROUTES } from './features.js';
import { channelsRoutes } from './routes/channels.js';
import { keysRoutes } from './routes/keys.js';
import { peopleRoutes } from './routes/people.js';
import { personRoutes } from './routes/person.js';
import { weeklyRoutes } from './routes/weekly.js';

const MONDAY = '2026-11-02T10:00:00.000Z';
const SECRET = 'sk-ant-INTEG-SECRET-0123456789';

function setup(opts: { demo?: boolean; env?: NodeJS.ProcessEnv; writers?: string[]; verify?: (key: string) => Promise<void> } = {}) {
  const clock = fixedClock(MONDAY);
  const writers = opts.writers ?? [];
  const ctx = createCtx({
    db: openDb(':memory:'), clock, demo: opts.demo ?? true, env: opts.env ?? {}, dataDir: '/tmp/callum-test',
    makeWriter: (env): Writer => {
      writers.push(env.ANTHROPIC_API_KEY ?? '');
      return new TemplateWriter(clock);
    },
  });
  ctx.repo.updateSettings({ senderName: 'Ada Obi', senderEmail: 'ada@example.com', timezone: 'Africa/Lagos' });
  // The key routes are swapped for ones that do not call Anthropic.
  const routes = opts.verify
    ? [personRoutes(ctx), peopleRoutes(ctx), channelsRoutes(ctx), keysRoutes(ctx, { verify: opts.verify }), weeklyRoutes(ctx)]
    : FEATURE_ROUTES.map((build) => build(ctx));
  const app = createApp(ctx, { password: null, webDir: null, extraRoutes: routes, onError: () => undefined });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, ctx, writers, get: (p: string) => send('GET', p), post: (p: string, b: unknown = {}) => send('POST', p, b), del: (p: string) => send('DELETE', p) };
}

const state = async (h: ReturnType<typeof setup>) => (await (await h.get('/api/state')).json()) as AppState;

describe('settings', () => {
  it('takes morningBrief and openAtLogin as on or off, and nothing else', async () => {
    const h = setup();
    const res = await h.post('/api/settings', { morningBrief: false, openAtLogin: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ morningBrief: false, openAtLogin: true });
    for (const bad of [{ morningBrief: 'no' }, { openAtLogin: 1 }, { morningBrief: null }]) {
      const refused = await h.post('/api/settings', bad);
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: 'Pick on or off.' });
    }
    expect((await state(h)).settings).toMatchObject({ morningBrief: false, openAtLogin: true });
  });
});

describe('the feature routes', () => {
  it('mounts the person page, adding people, channels, the Claude key and the weekly note', async () => {
    const h = setup();
    const person = h.ctx.repo.insertPerson({ name: 'Kemi Eze', source: 'paste', projectId: h.ctx.repo.insertProject({ name: 'Reconciliation', offer: 'You help.', tone: 'warm' }).id, email: 'kemi@okopay.com' });
    // Task 17's richer page, not the generic one.
    const page = (await (await h.get(`/api/people/${person.id}`)).json()) as { projectName?: string; path?: unknown; switchable?: unknown };
    expect(page.projectName).toBe('Reconciliation');
    expect(page).toHaveProperty('switchable');
    for (const [method, path] of [
      ['GET', '/api/channels/email/summary'], ['GET', '/api/weekly'], ['GET', '/api/quiet'], ['GET', '/api/channels/email/microsoft/setup'],
    ] as const) {
      const res = await (method === 'GET' ? h.get(path) : h.post(path));
      expect(res.status, path).toBe(200);
    }
    for (const path of ['/api/people/preview', '/api/people/commit', '/api/people/describe', '/api/people/sample', '/api/people/discard-project', '/api/settings/claude-key', '/api/people/1/switch-channel', '/api/people/1/wake']) {
      const res = await h.post(path, {});
      expect(res.status, path).not.toBe(404);
    }
  });

  it('connects a channel through the channel module, which also remembers the sender address', async () => {
    const h = setup();
    const res = await h.post('/api/channels/email/connect', { address: 'ada@example.com' });
    expect(res.status).toBe(200);
    const account = (await res.json()) as { identity: string };
    expect((await state(h)).settings.senderEmail).toBe(account.identity);
  });

  it('is five modules, all of them in the list main.ts builds the app from', () => {
    expect(FEATURE_ROUTES).toHaveLength(5);
  });
});

describe('the Claude key', () => {
  it('is checked, saved apart from the settings, and used without a restart', async () => {
    const writers: string[] = [];
    const checked: string[] = [];
    const h = setup({ writers, verify: async (k) => void checked.push(k) });
    expect((await state(h)).claudeConnected).toBe(false);
    expect(writers).toEqual(['']);

    const saved = await h.post('/api/settings/claude-key', { key: `  ${SECRET}  ` });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ claudeConnected: true });
    expect(checked).toEqual([SECRET]);
    expect(h.ctx.repo.getChannelSecret('anthropic')).toEqual({ key: SECRET });
    expect(writers).toEqual(['', SECRET]);
    expect((await state(h)).claudeConnected).toBe(true);

    const removed = await h.del('/api/settings/claude-key');
    expect(await removed.json()).toEqual({ claudeConnected: false });
    expect(h.ctx.repo.getChannelSecret('anthropic')).toBeNull();
    expect(writers).toEqual(['', SECRET, '']);
    expect((await state(h)).claudeConnected).toBe(false);
  });

  it('refuses an empty key, a key with spaces, and a key Claude does not accept, saving nothing', async () => {
    const h = setup({ verify: async () => { throw new UserError("Claude didn't accept that key. Check that you copied all of it."); } });
    expect((await h.post('/api/settings/claude-key', { key: '   ' })).status).toBe(422);
    expect((await h.post('/api/settings/claude-key', { key: 'sk ant' })).status).toBe(422);
    const refused = await h.post('/api/settings/claude-key', { key: SECRET });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "Claude didn't accept that key. Check that you copied all of it." });
    expect(h.ctx.repo.getChannelSecret('anthropic')).toBeNull();
    expect((await state(h)).claudeConnected).toBe(false);
  });

  it('puts the environment first: a saved key does not replace ANTHROPIC_API_KEY, and removing it keeps the connection', async () => {
    const writers: string[] = [];
    const h = setup({ writers, env: { ANTHROPIC_API_KEY: 'sk-ant-from-env' }, verify: async () => undefined });
    expect(h.ctx.claudeKey).toBe('env');
    await h.post('/api/settings/claude-key', { key: SECRET });
    expect(writers.at(-1)).toBe('sk-ant-from-env');
    await h.del('/api/settings/claude-key');
    expect((await state(h)).claudeConnected).toBe(true);
  });

  it('never appears in any response', async () => {
    const h = setup({ verify: async () => undefined });
    const seen: string[] = [];
    const record = async (res: Response) => void seen.push(await res.text());
    record(await h.post('/api/settings/claude-key', { key: SECRET }));
    await record(await h.post('/api/settings/claude-key', { key: SECRET }));
    h.ctx.repo.insertProject({ name: 'Reconciliation', offer: 'You help.', tone: 'warm' });
    const person: Person = h.ctx.repo.insertPerson({ name: 'Kemi Eze', source: 'paste', projectId: 1, email: 'kemi@okopay.com' });
    for (const path of [
      '/api/state', '/api/projects', `/api/people/${person.id}`, '/api/export.json', '/api/export.csv', '/api/weekly', '/api/quiet', '/api/plan',
      '/api/channels/email/summary', '/api/channels/email/microsoft/setup', '/api/wrap/summary', '/api/events',
    ]) {
      if (path === '/api/events') continue;
      await record(await h.get(path));
    }
    await record(await h.del('/api/settings/claude-key'));
    await record(await h.post('/api/settings/claude-key', { key: SECRET }));
    await record(await h.post('/api/settings', { senderName: 'Ada' }));
    await record(await h.post('/api/wrap', { deleteData: false }));
    expect(seen.length).toBeGreaterThan(10);
    for (const text of seen) expect(text).not.toContain(SECRET);
  });
});

describe('keys and wrapping up', () => {
  it('wrap up and delete forgets the saved Claude key', async () => {
    const writers: string[] = [];
    const h = setup({ demo: false, writers, verify: async () => undefined });
    await h.post('/api/settings/claude-key', { key: SECRET });
    const before = await state(h);
    expect(before.claudeConnected).toBe(true);
    expect(before.claudeEngine).toBe('api');
    expect(before.canFind).toBe(true);

    await h.post('/api/wrap', { deleteData: true });
    const after = await state(h);
    expect(after.claudeConnected).toBe(false);
    expect(after.claudeEngine).toBeNull();
    expect(after.canFind).toBe(false);
    expect(h.ctx.repo.getChannelSecret('anthropic')).toBeNull();
    expect(writers.at(-1)).toBe('');
  });

  it('wrap up without deleting keeps it', async () => {
    const h = setup({ verify: async () => undefined });
    await h.post('/api/settings/claude-key', { key: SECRET });
    await h.post('/api/wrap', { deleteData: false });
    expect((await state(h)).claudeConnected).toBe(true);
  });
});

describe('Claude in the state', () => {
  it('runs on a key from the environment or a saved one, and never shows it', async () => {
    const none = await state(setup({ demo: false }));
    expect([none.claudeEngine, none.canFind, none.claudeConnected]).toEqual([null, false, false]);
    const fromEnv = await state(setup({ demo: false, env: { ANTHROPIC_API_KEY: 'env-key-123' } }));
    expect([fromEnv.claudeEngine, fromEnv.canFind, fromEnv.claudeConnected]).toEqual(['api', true, true]);
    expect(JSON.stringify(fromEnv)).not.toContain('env-key-123');
  });

  it('runs on Claude Code when there is no key, and the key wins when there is one', async () => {
    const db = openDb(':memory:');
    const ctx = createCtx({ db, env: {}, dataDir: '/tmp/callum-test', claudeCodePath: '/usr/local/bin/claude' });
    expect(ctx.model?.engine).toBe('claude_code');
    expect(ctx.finder).not.toBeNull();
    ctx.repo.setChannelSecret('anthropic', { key: SECRET });
    ctx.reloadKeys();
    expect(ctx.model?.engine).toBe('api');
    ctx.repo.setChannelSecret('anthropic', null);
    ctx.reloadKeys();
    expect(ctx.model?.engine).toBe('claude_code');
  });

  it('reads a saved key when Callum starts', async () => {
    const db = openDb(':memory:');
    const first = createCtx({ db, env: {}, dataDir: '/tmp/callum-test' });
    first.repo.setChannelSecret('anthropic', { key: SECRET });
    const again: Ctx = createCtx({ db, env: {}, dataDir: '/tmp/callum-test' });
    expect(again.claudeKey).toBe('saved');
    expect(again.model?.engine).toBe('api');
  });
});

describe('what Your Callum shows about Claude', () => {
  it('says where Claude runs and whether Claude Code is signed in, never with a key', async () => {
    const ctx = createCtx({ db: openDb(':memory:'), env: {}, dataDir: '/tmp/callum-test', claudeCodePath: '/usr/local/bin/claude', findClaudeCode: () => '/usr/local/bin/claude' });
    const asked: (string | null)[] = [];
    const status = async (path: string | null) => {
      asked.push(path);
      return { found: true, signedIn: true, account: 'claude.ai' };
    };
    const app = createApp(ctx, { password: null, webDir: null, extraRoutes: [keysRoutes(ctx, { status, verify: async () => undefined })], onError: () => undefined });
    const info = async () => (await (await app.request('/api/settings/claude')).json()) as Record<string, unknown>;
    expect(await info()).toEqual({ engine: 'claude_code', keySource: null, claudeCode: { found: true, signedIn: true, account: 'claude.ai' }, lastError: null });
    expect(asked).toEqual(['/usr/local/bin/claude']);

    await app.request('/api/settings/claude-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: SECRET }) });
    const withKey = await info();
    expect(withKey).toMatchObject({ engine: 'api', keySource: 'saved' });
    expect(JSON.stringify(withKey)).not.toContain(SECRET);
  });

  it('clears an old "not signed in" once Claude Code says it is signed in', async () => {
    const ctx = createCtx({ db: openDb(':memory:'), env: {}, dataDir: '/tmp/callum-test', claudeCodePath: '/usr/local/bin/claude' });
    const model = ctx.model as NonNullable<typeof ctx.model>;
    model.lastError = "Claude Code isn't signed in on this computer. Open a terminal, run claude, and sign in with your Claude account.";
    let signedIn = false;
    const app = createApp(ctx, { password: null, webDir: null, extraRoutes: [keysRoutes(ctx, { status: async () => ({ found: true, runs: true, signedIn, account: signedIn ? 'claude.ai' : null }) })], onError: () => undefined });
    expect(await (await app.request('/api/settings/claude')).json()).toMatchObject({ lastError: expect.stringContaining("isn't signed in") });
    signedIn = true;
    expect(await (await app.request('/api/settings/claude')).json()).toMatchObject({ claudeCode: { signedIn: true }, lastError: null });
  });

  it('finds Claude Code installed after Callum started', async () => {
    let installed: string | null = null;
    const ctx = createCtx({ db: openDb(':memory:'), env: {}, dataDir: '/tmp/callum-test', claudeCodePath: null, findClaudeCode: () => installed });
    const app = createApp(ctx, { password: null, webDir: null, extraRoutes: [keysRoutes(ctx, { status: async (p) => ({ found: p !== null, signedIn: false, account: null }) })], onError: () => undefined });
    expect(await (await app.request('/api/settings/claude')).json()).toMatchObject({ engine: null, claudeCode: { found: false } });
    expect(ctx.finder).toBeNull();
    installed = '/home/ada/.local/bin/claude';
    expect(await (await app.request('/api/settings/claude')).json()).toMatchObject({ engine: 'claude_code', claudeCode: { found: true, signedIn: false } });
    expect(ctx.finder).not.toBeNull();
  });

  it('never runs Claude Code in the demo', async () => {
    const ctx = createCtx({ db: openDb(':memory:'), demo: true, env: {}, dataDir: '/tmp/callum-test' });
    const app = createApp(ctx, { password: null, webDir: null, extraRoutes: [keysRoutes(ctx, { status: () => { throw new Error('ran'); } })], onError: () => undefined });
    expect(await (await app.request('/api/settings/claude')).json()).toEqual({ engine: null, keySource: null, claudeCode: { found: false, signedIn: false, account: null }, lastError: null });
  });
});

describe('a message that did not go', () => {
  it('is tried again from the page, which settles its notice', async () => {
    const h = setup();
    const project = h.ctx.repo.insertProject({ name: 'Reconciliation', offer: 'You help.', tone: 'warm' });
    const person = h.ctx.repo.insertPerson({ name: 'Kemi Eze', source: 'paste', projectId: project.id, email: 'kemi@okopay.com', channel: 'email', status: 'waiting', stage: 'talking' });
    h.ctx.repo.updateChannel('email', { status: 'connected', identity: 'ada@example.com' });
    const failed = h.ctx.repo.insertOutbox({ personId: person.id, channel: 'email', kind: 'reply', body: 'Thursday at 14:00 works.', state: 'failed', origin: 'user', sendAfter: MONDAY, error: 'The mailbox said no' });
    h.ctx.repo.insertIncident({ channel: 'email', kind: 'send_failed', message: "Your reply to Kemi didn't go out: the mailbox said no. It's saved here.", detail: JSON.stringify({ outboxId: failed.id }), personId: person.id });
    expect((await state(h)).incidents.filter((i) => i.kind === 'send_failed')).toHaveLength(1);

    const res = await h.post(`/api/outbox/${failed.id}/retry`);
    expect(res.status).toBe(200);
    const after = await state(h);
    expect(after.incidents.filter((i) => i.kind === 'send_failed')).toEqual([]);
    expect(after.outbox.filter((o) => o.state === 'scheduled' && o.personId === person.id)).toHaveLength(1);
  });
});

describe('the demo', () => {
  it('seeds the fresh and the morning scene, and refuses others', async () => {
    const h = setup({ demo: true });
    expect((await h.post('/api/demo/seed', { scene: 'fresh' })).status).toBe(200);
    expect((await state(h)).projects.length).toBeGreaterThan(0);
    expect((await state(h)).settings.onboarded).toBe(false);
    expect((await h.post('/api/demo/seed', { scene: 'morning' })).status).toBe(200);
    expect((await state(h)).settings.onboarded).toBe(true);
    expect((await h.post('/api/demo/seed', { scene: 'evening' })).status).toBe(422);
  });
});
