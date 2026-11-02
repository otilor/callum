import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Incident, OutboxItem } from '../../shared/types.js';
import { TemplateWriter } from '../ai/templates.js';
import { createCtx } from '../context.js';
import { openDb } from '../db/db.js';
import { fixedClock } from '../engine/clock.js';
import { MAY_HAVE_GONE } from '../services/actions.js';
import { createApp } from './app.js';

const MONDAY = '2026-11-02T10:00:00.000Z';

function setup(opts: { password?: string | null; webDir?: string | null; trustProxy?: boolean; tick?: () => Promise<unknown> } = {}) {
  const clock = fixedClock(MONDAY);
  const ctx = createCtx({ db: openDb(':memory:'), clock, writer: new TemplateWriter(clock), demo: true, env: {}, dataDir: '/tmp/callum-test' });
  ctx.repo.updateSettings({ senderName: 'Ada Obi', senderEmail: 'ada@example.com', timezone: 'Africa/Lagos' });
  ctx.repo.updateChannel('email', { status: 'connected', identity: 'ada@example.com', connectedAt: '2026-11-01T08:00:00.000Z' });
  ctx.repo.updateChannel('linkedin', { status: 'connected', identity: 'ada', connectedAt: '2026-11-01T08:00:00.000Z' });
  const project = ctx.repo.insertProject({ name: 'Reconciliation', offer: 'You help fintech teams close the books faster' });
  ctx.repo.updateProject(project.id, { startedAt: '2026-11-01T09:00:00.000Z' });
  const problems: unknown[] = [];
  const app = createApp(ctx, {
    password: opts.password ?? null, webDir: opts.webDir ?? null, trustProxy: opts.trustProxy === true,
    ...(opts.tick ? { runner: { tick: opts.tick } } : {}), onError: (e) => problems.push(e),
  });
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, env?: unknown) =>
    app.request(path, {
      method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
  return { app, ctx, project, problems, get: (p: string, h?: Record<string, string>) => send('GET', p, undefined, h), post: (p: string, b: unknown = {}, h?: Record<string, string>, env?: unknown) => send('POST', p, b, h, env) };
}

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe('nobody can frame Callum', () => {
  it('says so on every kind of response: the API, an error, a refusal, a missing page, the event stream and the page itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'callum-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Callum</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    const h = setup({ webDir: dir });
    const responses: [string, Response][] = [
      ['state', await h.get('/api/state')],
      ['an error', await h.post('/api/channels/email/resume', { pace: 'sideways' })],
      ['a missing person', await h.get('/api/people/9999')],
      ['a missing route', await h.get('/api/nothing-here')],
      ['a cross-site request', await h.get('/api/state', { 'sec-fetch-site': 'cross-site' })],
      ['the page', await h.get('/')],
      ['a file of the page', await h.get('/assets/app.js')],
      ['a page that is not there', await h.get('/no/such/page')],
    ];
    const events = await h.get('/api/events');
    responses.push(['the event stream', events]);
    for (const [what, res] of responses) {
      expect(res.headers.get('x-frame-options'), what).toBe('DENY');
      expect(res.headers.get('content-security-policy'), what).toBe("frame-ancestors 'none'");
    }
    await events.body?.cancel();
    expect(responses[4]![1].status).toBe(403);
  });

  it('says so on the sign-in screen too, before anyone has signed in', async () => {
    const h = setup({ password: 'open sesame' });
    const res = await h.get('/api/state');
    expect(res.status).toBe(401);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });
});

describe('POST /api/outbox/:id/edit', () => {
  function blocked(h: ReturnType<typeof setup>): OutboxItem {
    const p = h.ctx.repo.insertPerson({ projectId: h.project.id, name: 'Kemi Eze', source: 'csv', email: 'kemi@okopay.com', channel: 'email', stage: 'hello', touches: 1 });
    return h.ctx.repo.insertOutbox({
      personId: p.id, channel: 'email', kind: 'follow_up', subject: 'Following up', body: 'The pilot is [YOUR PRICE] a month.',
      state: 'blocked', origin: 'auto', sendAfter: MONDAY, error: 'There is a blank left in this message.',
    });
  }

  it('puts the fixed words back in line', async () => {
    const h = setup();
    const item = blocked(h);
    const res = await h.post(`/api/outbox/${item.id}/edit`, { body: 'The pilot is 400 dollars a month.' });
    expect(res.status).toBe(200);
    expect(h.ctx.repo.getOutbox(item.id)).toMatchObject({ state: 'scheduled', body: 'The pilot is 400 dollars a month.', error: null });
  });

  it('keeps the subject when none is sent and changes it when one is', async () => {
    const h = setup();
    const item = blocked(h);
    await h.post(`/api/outbox/${item.id}/edit`, { body: 'The pilot is 400 dollars a month.', subject: 'A quick follow-up' });
    expect(h.ctx.repo.getOutbox(item.id)?.subject).toBe('A quick follow-up');
  });

  it('refuses words that still have a blank in them, in plain words, and changes nothing', async () => {
    const h = setup();
    const item = blocked(h);
    const res = await h.post(`/api/outbox/${item.id}/edit`, { body: 'The pilot is [YOUR PRICE] a month.' });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).not.toBe('');
    expect(h.ctx.repo.getOutbox(item.id)).toMatchObject({ state: 'blocked' });
  });

  it('needs words, and a message that is stuck', async () => {
    const h = setup();
    const item = blocked(h);
    expect((await h.post(`/api/outbox/${item.id}/edit`, {})).status).toBe(422);
    h.ctx.repo.updateOutbox(item.id, { state: 'scheduled' });
    const res = await h.post(`/api/outbox/${item.id}/edit`, { body: 'Hello again.' });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toBe('This message is not stuck.');
  });
});

describe('POST /api/outbox/:id/retry for Callum\'s own messages', () => {
  function failed(h: ReturnType<typeof setup>, detail: string | null): OutboxItem {
    const p = h.ctx.repo.insertPerson({ projectId: h.project.id, name: 'Kemi Eze', source: 'csv', email: 'kemi@okopay.com', channel: 'email', stage: 'hello', touches: 1 });
    return h.ctx.repo.insertOutbox({ personId: p.id, channel: 'email', kind: 'follow_up', subject: 'Hi', body: 'Hello again.', state: 'failed', origin: 'auto', sendAfter: MONDAY, error: 'The server said no.', detail });
  }

  it('tries a failed one again straight away', async () => {
    const h = setup();
    const item = failed(h, null);
    const res = await h.post(`/api/outbox/${item.id}/retry`);
    expect(res.status).toBe(200);
    expect(h.ctx.repo.getOutbox(item.id)).toMatchObject({ state: 'scheduled', error: null });
  });

  it('asks first when it may have gone out already, and sends again only when told to', async () => {
    const h = setup();
    const item = failed(h, JSON.stringify({ maybeSent: true }));
    const asked = await h.post(`/api/outbox/${item.id}/retry`);
    expect(asked.status).toBe(409);
    expect(await errorOf(asked)).toBe(MAY_HAVE_GONE);
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('failed');
    const sure = await h.post(`/api/outbox/${item.id}/retry`, { again: true });
    expect(sure.status).toBe(200);
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('scheduled');
  });
});

describe('POST /api/incidents/:id/dismiss', () => {
  const open = (h: ReturnType<typeof setup>, kind: Incident['kind'], channel: Incident['channel'] = 'email', detail?: string) =>
    h.ctx.repo.insertIncident({ channel, kind, message: 'Something to read', ...(detail ? { detail } : {}) });

  it('settles a notice that has been read', async () => {
    const h = setup();
    const note = open(h, 'bounces');
    const res = await h.post(`/api/incidents/${note.id}/dismiss`);
    expect(res.status).toBe(200);
    expect(h.ctx.repo.listIncidents({ open: true })).toEqual([]);
    expect(h.ctx.repo.listIncidents()[0]).toMatchObject({ state: 'resolved' });
  });

  it('leaves open a notice about something still in the way, and says nothing is wrong with that', async () => {
    const h = setup();
    for (const kind of ['linkedin_check', 'mailbox_signed_out', 'x_limit', 'channel_paused'] as const) open(h, kind, kind === 'x_limit' ? 'x' : 'linkedin');
    for (const incident of h.ctx.repo.listIncidents({ open: true })) {
      const res = await h.post(`/api/incidents/${incident.id}/dismiss`);
      expect(res.status).toBe(200);
    }
    expect(h.ctx.repo.listIncidents({ open: true })).toHaveLength(4);
  });

  it('leaves open the notice about Callum\'s own messages that still need the user', async () => {
    const h = setup();
    const note = open(h, 'send_failed', 'email', JSON.stringify({ auto: true, day: '2026-11-02', outboxId: 1, outboxIds: [1], personIds: [1] }));
    await h.post(`/api/incidents/${note.id}/dismiss`);
    expect(h.ctx.repo.listIncidents({ open: true })).toHaveLength(1);
  });

  it('says it cannot find a notice that is not there', async () => {
    const h = setup();
    const res = await h.post('/api/incidents/999/dismiss');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("Callum can't find that notice.");
  });
});

describe('POST /api/channels/:ch/resume', () => {
  const resume = (h: ReturnType<typeof setup>, ch: string, body: unknown = { pace: 'half' }) => h.post(`/api/channels/${ch}/resume`, body);

  it('does not mark a channel connected that is signed out, and points to the way back', async () => {
    const h = setup();
    h.ctx.repo.updateChannel('linkedin', { status: 'error' });
    const res = await resume(h, 'linkedin');
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toContain('Reconnect LinkedIn first');
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('error');
  });

  it('refuses while a signed-out notice is open', async () => {
    const h = setup();
    h.ctx.repo.updateChannel('linkedin', { status: 'paused' });
    h.ctx.repo.insertIncident({ channel: 'linkedin', kind: 'linkedin_signed_out', message: 'LinkedIn signed Callum out.' });
    const res = await resume(h, 'linkedin');
    expect(res.status).toBe(422);
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('paused');
  });

  it('refuses while X is out of room for the day', async () => {
    const h = setup();
    h.ctx.repo.updateChannel('x', { status: 'paused', identity: 'ada' });
    h.ctx.repo.insertIncident({ channel: 'x', kind: 'x_limit', message: 'X is out of room.' });
    const res = await resume(h, 'x');
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toContain('out of room for today');
    expect(h.ctx.repo.getChannel('x').status).toBe('paused');
  });

  it('refuses while a LinkedIn check is open, unless the notice\'s own button says the check is done', async () => {
    const h = setup();
    h.ctx.repo.updateChannel('linkedin', { status: 'paused' });
    h.ctx.repo.insertIncident({ channel: 'linkedin', kind: 'linkedin_check', message: 'LinkedIn asked to check it\'s you.' });
    const stray = await resume(h, 'linkedin');
    expect(stray.status).toBe(422);
    expect(await errorOf(stray)).toContain('Finish the check on LinkedIn first');
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('paused');
    const done = await resume(h, 'linkedin', { pace: 'half', checked: true });
    expect(done.status).toBe(200);
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('connected');
    expect(h.ctx.repo.listIncidents({ open: true })).toEqual([]);
  });

  it('resumes a channel that is only paused', async () => {
    const h = setup();
    h.ctx.repo.updateChannel('linkedin', { status: 'paused' });
    expect((await resume(h, 'linkedin', { pace: 'full' })).status).toBe(200);
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('connected');
  });
});

describe('the sign-in lockout behind a reverse proxy', () => {
  const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
  const login = (h: ReturnType<typeof setup>, forwarded: string | null, address = '172.18.0.2') =>
    h.post('/api/login', { password: 'wrong' }, forwarded === null ? {} : { 'x-forwarded-for': forwarded }, from(address));

  it('without CALLUM_TRUST_PROXY ignores X-Forwarded-For, so nobody can pick the address they are counted under', async () => {
    const h = setup({ password: 'open sesame' });
    for (let i = 0; i < 5; i++) expect((await login(h, `203.0.113.${i}`)).status).toBe(401);
    // Five wrong tries from the one address the connection really came from: it is locked, whatever the header said.
    expect((await login(h, '198.51.100.9')).status).toBe(429);
  });

  it('with it counts the address the proxy saw, so one person locked out does not lock out everyone behind the proxy', async () => {
    const h = setup({ password: 'open sesame', trustProxy: true });
    for (let i = 0; i < 5; i++) expect((await login(h, '203.0.113.7')).status).toBe(401);
    expect((await login(h, '203.0.113.7')).status).toBe(429);
    // Someone else behind the same proxy is not locked.
    expect((await login(h, '203.0.113.8')).status).toBe(401);
  });

  it('with it uses the last address in the header: what a client wrote before the proxy is not trusted', async () => {
    const h = setup({ password: 'open sesame', trustProxy: true });
    for (let i = 0; i < 5; i++) expect((await login(h, `10.9.9.${i}, 203.0.113.7`)).status).toBe(401);
    expect((await login(h, '10.1.1.1, 203.0.113.7')).status).toBe(429);
  });
});
