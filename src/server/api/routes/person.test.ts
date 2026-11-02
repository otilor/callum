import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Person, PersonFull, Project } from '../../../shared/types.js';
import { createCtx, type Ctx } from '../../context.js';
import { openDb } from '../../db/db.js';
import { fixedClock } from '../../engine/clock.js';
import { personRoutes } from './person.js';

const MONDAY = '2026-11-02T10:00:00.000Z';
let clock: ReturnType<typeof fixedClock>;
let ctx: Ctx;
let app: Hono;
let project: Project;

const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  app.request(`/api${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });

function add(over: Partial<Person> = {}): Person {
  return ctx.repo.insertPerson({ projectId: project.id, name: 'Chidi Okeke', source: 'csv', email: 'chidi@marinaledger.com', channel: 'email', ...over });
}

beforeEach(() => {
  clock = fixedClock(MONDAY);
  ctx = createCtx({ db: openDb(':memory:'), clock, demo: true, env: {}, dataDir: '/tmp/callum-test' });
  ctx.repo.updateSettings({ timezone: 'Africa/Lagos' });
  project = ctx.repo.insertProject({ name: 'Reconciliation' });
  for (const ch of ['email', 'linkedin'] as const) ctx.repo.updateChannel(ch, { status: 'connected', identity: ch, connectedAt: MONDAY });
  app = new Hono().route('/api', personRoutes(ctx));
});

describe('person routes', () => {
  it('GET /people/:id answers with the whole picture', async () => {
    const p = add();
    const res = await call('GET', `/people/${p.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PersonFull;
    expect(body.person.id).toBe(p.id);
    expect(body.why).toBe("Callum picked email because Chidi's address is verified.");
    expect(body.switchable.map((s) => s.channel)).toEqual(['linkedin']);
    expect(JSON.stringify(body)).not.toMatch(/password|accessToken/);
  });

  it('answers 404 with a sentence for someone who is not there, or an id that is not a number', async () => {
    const missing = await call('GET', '/people/999');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Callum can't find that person." });
    expect((await call('GET', '/people/abc')).status).toBe(404);
  });

  it('switches to another channel with a new address', async () => {
    const p = add();
    const res = await call('POST', `/people/${p.id}/switch-channel`, { channel: 'linkedin', handle: 'https://www.linkedin.com/in/chidi' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: p.id, channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/chidi' });
  });

  it('answers 422 with the plain sentence for a bad address', async () => {
    const p = add({ email: null, linkedinUrl: 'https://www.linkedin.com/in/chidi', channel: 'linkedin' });
    const res = await call('POST', `/people/${p.id}/switch-channel`, { channel: 'email', handle: 'nope' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "That doesn't look like an email address." });
  });

  it('asks which channel when none comes', async () => {
    const res = await call('POST', `/people/${add().id}/switch-channel`, {});
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Pick email, LinkedIn or X.' });
  });

  it('rejects a body that is not JSON', async () => {
    const res = await app.request(`/api/people/${add().id}/switch-channel`, { method: 'POST', body: '{nope' });
    expect(res.status).toBe(400);
  });

  it('wakes a resting person and rests them again within 10 seconds', async () => {
    const p = add({ stage: 'following', touches: 3, status: 'resting', restUntil: '2027-02-03T08:00:00.000Z' });
    const woke = await call('POST', `/people/${p.id}/wake`);
    expect(woke.status).toBe(200);
    expect(await woke.json()).toMatchObject({ undoUntil: '2026-11-02T10:00:10.000Z', person: { status: 'active', stage: 'stranger' } });
    clock.advance(4_000);
    const back = await call('POST', `/people/${p.id}/rest`);
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ status: 'resting', restUntil: '2027-02-03T08:00:00.000Z' });
  });

  it('answers 422 when it is too late to rest them again', async () => {
    const p = add({ stage: 'following', touches: 3, status: 'resting', restUntil: '2027-02-03T08:00:00.000Z' });
    await call('POST', `/people/${p.id}/wake`);
    clock.advance(11_000);
    const res = await call('POST', `/people/${p.id}/rest`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Too late to undo.' });
  });
});
