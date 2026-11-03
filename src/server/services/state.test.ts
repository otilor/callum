import { describe, expect, it } from 'vitest';
import { brief, getState } from './state.js';
import { createProject } from './projects.js';
import { harness } from './testing.test-helpers.js';

describe('getState', () => {
  it('hides removed people and shows open incidents only', () => {
    const h = harness();
    const kept = h.person({ name: 'Kemi Eze' });
    h.person({ name: 'Gone Away', status: 'removed' });
    h.ctx.repo.insertIncident({ channel: 'x', kind: 'x_limit', message: 'open one' });
    const done = h.ctx.repo.insertIncident({ channel: 'x', kind: 'x_limit', message: 'old one' });
    h.ctx.repo.updateIncident(done.id, { state: 'resolved', resolvedAt: '2026-11-02T09:00:00.000Z' });
    const state = getState(h.ctx, { password: false });
    expect(state.people.map((p) => p.id)).toEqual([kept.id]);
    expect(state.incidents.map((i) => i.message)).toEqual(['open one']);
    expect(state.demo).toBe(true);
    expect(state.settings.timezone).toBe('Africa/Lagos');
    expect(state.channels.map((c) => c.channel)).toEqual(['email', 'linkedin', 'x']);
  });

  it('includes every project', async () => {
    const h = harness();
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    expect(getState(h.ctx, { password: false }).projects.map((p) => p.id)).toEqual([h.project.id, second.id]);
  });

  it('chooses which outbox items to show', () => {
    const h = harness();
    const p = h.person({ channel: 'email' });
    const now = h.clock.now();
    const q = (state: 'awaiting_ok' | 'scheduled' | 'failed' | 'blocked' | 'sent' | 'cancelled', extra: Record<string, unknown> = {}) =>
      h.ctx.repo.insertOutbox({ personId: p.id, channel: 'email', kind: 'follow_up', body: 'x', state, origin: 'auto', sendAfter: now.toISOString(), ...extra });
    const awaiting = q('awaiting_ok');
    const autoLater = q('scheduled');
    const autoUndo = q('scheduled', { undoUntil: '2026-11-02T10:00:05.000Z' });
    const autoUndoClosed = q('scheduled', { undoUntil: '2026-11-02T09:59:50.000Z' });
    const user = q('scheduled', { origin: 'user', kind: 'reply' });
    const failed = q('failed');
    const blocked = q('blocked');
    q('sent');
    q('cancelled');
    const ids = getState(h.ctx, { password: false }).outbox.map((i) => i.id);
    expect(ids).toEqual([awaiting.id, autoUndo.id, user.id, failed.id, blocked.id].sort((a, b) => a - b));
    expect(ids).not.toContain(autoLater.id);
    expect(ids).not.toContain(autoUndoClosed.id);
  });

  it('drops failed and blocked items older than a week', () => {
    const h = harness();
    const p = h.person({ channel: 'email' });
    const old = h.ctx.repo.insertOutbox({ personId: p.id, channel: 'email', kind: 'follow_up', body: 'x', state: 'failed', origin: 'auto', sendAfter: '2026-10-01T00:00:00.000Z' });
    expect(getState(h.ctx, { password: false }).outbox.map((i) => i.id)).toContain(old.id);
    h.clock.advance(8 * 86_400_000);
    expect(getState(h.ctx, { password: false }).outbox.map((i) => i.id)).not.toContain(old.id);
  });

  it('never carries a secret', () => {
    const h = harness();
    h.ctx.repo.setChannelSecret('email', { password: 'hunter2-secret', accessToken: 'tok-123', refreshToken: 'ref-456' });
    h.ctx.repo.setChannelSecret('x', { accessToken: 'x-tok' });
    h.person();
    const state = getState(h.ctx, { password: true });
    // The only mention of a password is whether there is one.
    expect(state.auth).toEqual({ password: true });
    const json = JSON.stringify({ ...state, auth: undefined });
    expect(json).not.toContain('password');
    expect(json).not.toContain('accessToken');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('tok-123');
  });
});

describe('brief', () => {
  it('counts people who want to talk, in the plural and the singular', () => {
    const h = harness();
    expect(brief(h.ctx).line).toBe('All caught up. Callum keeps the river moving.');
    h.person({ status: 'waiting' });
    expect(brief(h.ctx)).toMatchObject({ wantToTalk: 1, line: '1 person wants to talk.' });
    h.person({ status: 'waiting' });
    h.person({ status: 'waiting' });
    h.person({ status: 'snoozed' });
    expect(brief(h.ctx)).toMatchObject({ wantToTalk: 3, line: '3 people want to talk.' });
  });

  it('counts waiting people in every project', async () => {
    const h = harness();
    const second = await createProject(h.ctx, { offer: 'You help teams with payroll', name: 'Payroll' });
    h.person({ status: 'waiting' });
    h.person({ status: 'waiting', projectId: second.id });
    expect(brief(h.ctx).line).toBe('2 people want to talk.');
  });

  it('is gentle in the first days, then settles', () => {
    const h = harness();
    h.ctx.repo.updateProject(h.project.id, { startedAt: '2026-11-01T10:00:00.000Z' });
    expect(brief(h.ctx).line).toBe('No replies yet, which is normal this early. Callum will tap you the moment someone answers.');
    h.clock.set('2026-11-04T10:00:01.000Z');
    expect(brief(h.ctx).line).toBe('All caught up. Callum keeps the river moving.');
  });

  it('counts what went out in the previous local day, automatic messages only', () => {
    const h = harness();
    const p = h.person({ channel: 'email' });
    const m = (at: string, kind: 'hello' | 'reply', channel: 'email' | 'linkedin' = 'email') =>
      h.ctx.repo.insertMessage({ personId: p.id, channel, direction: 'out', kind, subject: null, body: 'x', at, externalId: null });
    // Lagos is an hour ahead of UTC: Sunday 1 November runs from 23:00 UTC on Saturday to 23:00 UTC on Sunday.
    m('2026-10-31T22:59:00.000Z', 'hello');   // Saturday evening
    m('2026-10-31T23:00:00.000Z', 'hello');   // Sunday 00:00
    m('2026-11-01T12:00:00.000Z', 'hello', 'linkedin');
    m('2026-11-01T12:00:00.000Z', 'reply');
    m('2026-11-01T22:59:00.000Z', 'hello');   // Sunday 23:59
    m('2026-11-01T23:00:00.000Z', 'hello');   // Monday 00:00
    expect(brief(h.ctx).sentYesterday).toBe(3);
  });

  it('names people whose LinkedIn invitation was accepted in the last day', () => {
    const h = harness({ connected: ['email', 'linkedin'] });
    const fresh = h.person({ name: 'Tunde Ade', linkedinState: 'connected', channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/tunde' });
    h.person({ name: 'Bola Ojo', linkedinState: 'invited', channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/bola' });
    expect(brief(h.ctx).acceptedRecently).toEqual(['Tunde']);
    h.clock.advance(25 * 3_600_000);
    expect(brief(h.ctx).acceptedRecently).toEqual([]);
    expect(fresh.linkedinState).toBe('connected');
  });

  it('gives the earliest time something is due to go', () => {
    const h = harness();
    const p = h.person({ channel: 'email' });
    expect(brief(h.ctx).nextSendAt).toBeNull();
    h.ctx.outbox.queueAuto(p.id, 'hello', 'Hi', 'Hello', new Date('2026-11-04T08:00:00.000Z'), false);
    h.ctx.outbox.queueAuto(p.id, 'follow_up', 'Hi', 'Hello', new Date('2026-11-03T08:00:00.000Z'), false);
    h.ctx.outbox.queueAuto(p.id, 'follow_up', 'Hi', 'Hello', new Date('2026-11-02T08:00:00.000Z'), true);
    expect(brief(h.ctx).nextSendAt).toBe('2026-11-03T08:00:00.000Z');
  });
});

describe('getState: connections and the brief', () => {
  it('says whether Claude is there and where it runs, never with a key', () => {
    const h = harness();
    const before = getState(h.ctx, { password: false });
    // The demo finds made-up people without Claude.
    expect(before).toMatchObject({ canFind: true, claudeConnected: false, claudeEngine: null });
    h.ctx.repo.setChannelSecret('anthropic', { key: 'sk-ant-secret-key' });
    h.ctx.reloadKeys();
    const after = getState(h.ctx, { password: false });
    expect(after).toMatchObject({ canFind: true, claudeConnected: true, claudeEngine: 'api' });
    expect(JSON.stringify(after)).not.toContain('secret-key');
  });

  it('names the people who accepted by id as well as by first name', () => {
    const h = harness();
    const ada = h.person({ name: 'Ada Obi', linkedinUrl: 'https://www.linkedin.com/in/ada', channel: 'linkedin' });
    h.ctx.repo.updatePerson(ada.id, { linkedinState: 'connected' });
    const { brief } = getState(h.ctx, { password: false });
    expect(brief.acceptedRecently).toEqual(['Ada']);
    expect(brief.acceptedIds).toEqual([ada.id]);
  });
});
