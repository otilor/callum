import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { harness, type Harness } from '../../runner/testing.test-helpers.js';
import { weeklyRoutes } from './weekly.js';

const MONDAY_NOTE = '2026-11-02T07:30:00.000Z';

function mount(h: Harness): Hono {
  return new Hono().route('/api', weeklyRoutes(h.ctx));
}

const post = (app: Hono, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(app.request(`/api${path}`, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }));

function seed(h: Harness): void {
  const kemi = h.person({ name: 'Kemi Eze', stage: 'talking', repliedAt: '2026-10-27T09:40:00.000Z', replyKind: 'interested' });
  h.ctx.repo.insertMessage({ personId: kemi.id, channel: 'email', direction: 'out', kind: 'hello', subject: null, body: 'Hi', at: '2026-10-26T09:12:00.000Z', externalId: null });
  h.ctx.repo.insertMessage({ personId: kemi.id, channel: 'email', direction: 'out', kind: 'booking', subject: null, body: 'Hi', at: '2026-10-27T11:00:00.000Z', externalId: null });
}

describe('GET /api/weekly', () => {
  it('answers with the current note, its email and that it should open once', async () => {
    const h = harness({ now: MONDAY_NOTE });
    seed(h);
    const app = mount(h);
    const res = await app.request('/api/weekly');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { note: { line: string; at: string }; email: { subject: string; text: string }; shouldOpen: boolean };
    expect(body.note.line).toBe('Callum said hello to 1 person. 1 replied and 1 call is booked.');
    expect(body.note.at).toBe(MONDAY_NOTE);
    expect(body.email.subject).toBe('Your week: 1 reply, 1 call booked');
    expect(body.shouldOpen).toBe(true);

    expect(((await (await post(app, '/weekly/seen')).json()) as { seenAt: string }).seenAt).toBe(MONDAY_NOTE);
    expect(((await (await app.request('/api/weekly')).json()) as { shouldOpen: boolean }).shouldOpen).toBe(false);

    // A new Monday brings a new note that has not been seen.
    h.clock.set('2026-11-09T08:00:00.000Z');
    h.ctx.repo.insertMessage({ personId: 1, channel: 'email', direction: 'out', kind: 'hello', subject: null, body: 'Hi', at: '2026-11-04T09:00:00.000Z', externalId: null });
    expect(((await (await app.request('/api/weekly')).json()) as { shouldOpen: boolean }).shouldOpen).toBe(true);
  });

  it('does not open an empty week by itself', async () => {
    const h = harness({ now: MONDAY_NOTE });
    const body = (await (await mount(h).request('/api/weekly')).json()) as { shouldOpen: boolean };
    expect(body.shouldOpen).toBe(false);
  });
});

describe('GET /api/quiet', () => {
  it('answers for the current project, or the one asked for', async () => {
    const h = harness();
    const app = mount(h);
    const now = (await (await app.request('/api/quiet')).json()) as { projectId: number; empty: boolean };
    expect(now).toMatchObject({ projectId: h.project.id, empty: true });
    expect((await app.request(`/api/quiet?projectId=${h.project.id}`)).status).toBe(200);
    expect((await app.request('/api/quiet?projectId=99')).status).toBe(404);
    expect((await app.request('/api/quiet?projectId=abc')).status).toBe(404);
  });
});

describe('POST /api/people/:id/real-reply', () => {
  it('moves an auto-reply to the dock', async () => {
    const h = harness();
    const p = h.person({ stage: 'hello', touches: 1, nextTouchAt: '2026-11-23T08:00:00.000Z' });
    h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'in', kind: 'inbound', subject: null, body: "I'm out of the office until 20 November.", at: '2026-11-03T08:10:00.000Z', externalId: null });
    const res = await post(mount(h), `/people/${p.id}/real-reply`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: p.id, status: 'waiting', suggested: 'reply' });
  });

  it('answers 404 for someone Callum does not know and 422 in plain words when it cannot', async () => {
    const h = harness();
    const app = mount(h);
    expect((await post(app, '/people/99/real-reply')).status).toBe(404);
    const p = h.person({ stage: 'hello', touches: 1 });
    const res = await post(app, `/people/${p.id}/real-reply`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: `${p.firstName} has not written back yet` });
  });
});

describe('POST /api/people/:id/away-seen', () => {
  it('keeps an out-of-office card from coming back', async () => {
    const h = harness();
    const p = h.person({ stage: 'hello', touches: 1, lastTouchAt: '2026-11-02T10:00:00.000Z', nextTouchAt: '2026-11-23T08:00:00.000Z' });
    h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'out', kind: 'hello', subject: null, body: 'Hi', at: '2026-11-02T10:00:00.000Z', externalId: null });
    h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'in', kind: 'inbound', subject: null, body: "I'm out of the office until 20 November.", at: '2026-11-03T08:10:00.000Z', externalId: null });
    const app = mount(h);
    expect(((await (await app.request('/api/quiet')).json()) as { away: unknown[] }).away).toHaveLength(1);
    const res = await post(app, `/people/${p.id}/away-seen`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(((await (await app.request('/api/quiet')).json()) as { away: unknown[] }).away).toEqual([]);
    expect((await post(app, '/people/99/away-seen')).status).toBe(404);
  });
});

describe('POST /api/people/:id/referral-hello', () => {
  it('queues the user hello and answers with the outbox item', async () => {
    const h = harness();
    const sam = h.ctx.repo.insertPerson({ projectId: h.project.id, name: 'Sam Bello', source: 'referral', email: 'sam@okopay.com' });
    const res = await post(mount(h), `/people/${sam.id}/referral-hello`, { body: 'Hi Sam, Kemi suggested I reach out.', subject: 'Kemi suggested I write' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ personId: sam.id, kind: 'hello', origin: 'user', state: 'scheduled', subject: 'Kemi suggested I write' });
  });

  it('says what is wrong in words', async () => {
    const h = harness();
    const app = mount(h);
    const sam = h.ctx.repo.insertPerson({ projectId: h.project.id, name: 'Sam Bello', source: 'referral', email: 'sam@okopay.com' });
    const res = await post(app, `/people/${sam.id}/referral-hello`, { body: 'Hi Sam, [YOUR PRICE].' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain('[YOUR PRICE]');
    expect((await post(app, `/people/${sam.id}/referral-hello`, {})).status).toBe(422);
    expect((await post(app, '/people/99/referral-hello', { body: 'Hi' })).status).toBe(404);
  });
});
