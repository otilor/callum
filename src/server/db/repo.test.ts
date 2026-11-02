import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { Repo } from './repo.js';
import { makeProject } from './testing.test-helpers.js';

let repo: Repo;
let tick: number;
let projectId: number;
beforeEach(() => {
  tick = 0;
  repo = new Repo(openDb(':memory:'), () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString());
  projectId = makeProject(repo).id;
});

describe('settings', () => {
  it('has defaults', () => {
    expect(repo.getSettings()).toEqual({
      senderName: null, senderEmail: null, timezone: 'UTC', onboarded: false, currentProjectId: null,
      pauseState: 'running', pausedUntil: null, notifications: null, morningBrief: true,
    });
  });
  it('round-trips updates', () => {
    const next = repo.updateSettings({ senderName: 'Ada', pauseState: 'paused', onboarded: true, currentProjectId: projectId });
    expect(next.senderName).toBe('Ada');
    expect(repo.getSettings()).toEqual(next);
    expect(repo.getSettings().pauseState).toBe('paused');
    expect(repo.getSettings().currentProjectId).toBe(projectId);
    expect(repo.getSettings().timezone).toBe('UTC');
  });
});

describe('channels', () => {
  it('returns disconnected defaults in order email, linkedin, x', () => {
    expect(repo.listChannels().map((c) => c.channel)).toEqual(['email', 'linkedin', 'x']);
    expect(repo.getChannel('x')).toEqual({
      channel: 'x', status: 'disconnected', identity: null, connectedAt: null,
      pausedUntil: null, halfPaceUntil: null, invitesBlockedUntil: null, lastPolledAt: null,
    });
  });
  it('updates a channel', () => {
    const c = repo.updateChannel('email', { status: 'connected', identity: 'ada@x.com' });
    expect(c.status).toBe('connected');
    expect(repo.listChannels()[0]).toEqual(c);
    expect(repo.getChannel('linkedin').status).toBe('disconnected');
  });
  it('round-trips secrets and never lists them', () => {
    expect(repo.getChannelSecret('email')).toBeNull();
    repo.setChannelSecret('email', { smtpPassword: 'hunter2' });
    expect(repo.getChannelSecret('email')).toEqual({ smtpPassword: 'hunter2' });
    repo.updateChannel('email', { status: 'connected' });
    expect(JSON.stringify(repo.listChannels())).not.toContain('hunter2');
    expect(JSON.stringify(repo.getChannel('email'))).not.toContain('hunter2');
    repo.setChannelSecret('email', null);
    expect(repo.getChannelSecret('email')).toBeNull();
  });
});

describe('people', () => {
  it('inserts with defaults and normalized handles', () => {
    const p = repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv', email: 'Kemi@OkoPay.com' });
    expect(p.firstName).toBe('Kemi');
    expect(p.stage).toBe('stranger');
    expect(p.status).toBe('active');
    expect(p.email).toBe('kemi@okopay.com');
    expect(p.touches).toBe(0);
    expect(p.projectId).toBe(projectId);
    expect(p.linkedinState).toBe('none');
    expect(p.channel).toBeNull();
    expect(p.createdAt).toBe(p.updatedAt);
    expect(repo.getPerson(p.id)).toEqual(p);
    expect(repo.getPerson(999)).toBeNull();
  });

  it('keeps an explicit firstName', () => {
    expect(repo.insertPerson({ projectId, name: 'Kemi Eze', firstName: 'Kem', source: 'paste' }).firstName).toBe('Kem');
  });

  it('updates, normalizes and bumps updatedAt', () => {
    const p = repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv' });
    const u = repo.updatePerson(p.id, { xHandle: '@KemiEze', stage: 'hello', touches: 1, nextTouchAt: '2026-02-01T09:00:00.000Z' });
    expect(u.xHandle).toBe('kemieze');
    expect(u.stage).toBe('hello');
    expect(u.nextTouchAt).toBe('2026-02-01T09:00:00.000Z');
    expect(u.createdAt).toBe(p.createdAt);
    expect(u.updatedAt).not.toBe(p.updatedAt);
  });

  it('keeps stored handles when a patch value is undefined', () => {
    const p = repo.insertPerson({
      projectId, name: 'Kemi Eze', source: 'csv', email: 'kemi@okopay.com', linkedinUrl: 'https://linkedin.com/in/kemi-eze', xHandle: '@kemieze',
    });
    const u = repo.updatePerson(p.id, { email: undefined, linkedinUrl: undefined, xHandle: undefined, stage: 'hello' });
    expect(u.stage).toBe('hello');
    expect(u.email).toBe('kemi@okopay.com');
    expect(u.linkedinUrl).toBe('https://www.linkedin.com/in/kemi-eze');
    expect(u.xHandle).toBe('kemieze');
    expect(repo.updatePerson(p.id, { email: null }).email).toBeNull();
  });

  it('matches handles regardless of formatting (Review Focus 3)', () => {
    const kemi = repo.insertPerson({
      projectId, name: 'Kemi Eze', source: 'csv', email: 'kemi@okopay.com', linkedinUrl: 'https://linkedin.com/in/Kemi-Eze', xHandle: '@kemieze',
    });
    repo.insertPerson({ projectId, name: 'Other One', source: 'csv', email: 'other@x.com' });
    expect(repo.findPersonByHandle({ email: 'KEMI@okopay.com' })?.id).toBe(kemi.id);
    expect(repo.findPersonByHandle({ linkedinUrl: 'www.linkedin.com/in/kemi-eze/?x=1' })?.id).toBe(kemi.id);
    expect(repo.findPersonByHandle({ xHandle: 'https://x.com/KemiEze' })?.id).toBe(kemi.id);
    expect(repo.findPersonByHandle({ email: 'nobody@x.com' })).toBeNull();
    expect(repo.findPersonByHandle({})).toBeNull();
    expect(repo.findPersonByHandle({ email: null, linkedinUrl: 'https://linkedin.com/company/oko' })).toBeNull();
  });

  it('filters by status and stage, ordered by id', () => {
    const a = repo.insertPerson({ projectId, name: 'A One', source: 'csv' });
    const b = repo.insertPerson({ projectId, name: 'B Two', source: 'csv', status: 'stopped' });
    const c = repo.insertPerson({ projectId, name: 'C Three', source: 'csv', stage: 'hello' });
    expect(repo.listPeople().map((p) => p.id)).toEqual([a.id, b.id, c.id]);
    expect(repo.listPeople({ status: ['stopped'] }).map((p) => p.id)).toEqual([b.id]);
    expect(repo.listPeople({ stage: ['hello'], status: ['active'] }).map((p) => p.id)).toEqual([c.id]);
    expect(repo.listPeople({ status: [] })).toEqual([]);
  });
});

describe('messages', () => {
  it('lists by at then id', () => {
    const p = repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv' });
    const base = { personId: p.id, channel: 'email' as const, subject: null, externalId: null };
    const m2 = repo.insertMessage({ ...base, direction: 'in', kind: 'inbound', body: 'later', at: '2026-01-03T00:00:00.000Z' });
    const m1 = repo.insertMessage({ ...base, direction: 'out', kind: 'hello', body: 'first', at: '2026-01-02T00:00:00.000Z' });
    const m3 = repo.insertMessage({ ...base, direction: 'out', kind: 'reply', body: 'same time', at: '2026-01-03T00:00:00.000Z' });
    expect(repo.listMessages(p.id).map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
    expect(repo.listMessages(999)).toEqual([]);
  });

  it('counts only outbound rows of the kinds and channel since the instant', () => {
    const p = repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv' });
    const add = (channel: 'email' | 'linkedin', direction: 'in' | 'out', kind: 'hello' | 'follow_up' | 'inbound', at: string) =>
      repo.insertMessage({ personId: p.id, channel, direction, kind, subject: null, body: 'x', at, externalId: null });
    const since = '2026-01-02T00:00:00.000Z';
    add('email', 'out', 'hello', '2026-01-01T23:59:59.000Z'); // before
    add('email', 'out', 'hello', '2026-01-02T00:00:00.000Z'); // on the instant
    add('email', 'out', 'hello', '2026-01-02T10:00:00.000Z');
    add('email', 'out', 'follow_up', '2026-01-02T11:00:00.000Z');
    add('email', 'in', 'inbound', '2026-01-02T12:00:00.000Z');
    add('linkedin', 'out', 'hello', '2026-01-02T13:00:00.000Z');
    expect(repo.countOut('email', ['hello'], since)).toBe(2);
    expect(repo.countOut('email', ['hello', 'follow_up'], since)).toBe(3);
    expect(repo.countOut('email', null, since)).toBe(3);
    expect(repo.countOut('linkedin', null, since)).toBe(1);
    expect(repo.countOut('x', null, since)).toBe(0);
    expect(repo.countOut('email', [], since)).toBe(0);
  });

  it('finds a message by its provider id, channel and direction', () => {
    const p = repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv' });
    const base = { personId: p.id, subject: null, body: 'x', at: '2026-01-02T00:00:00.000Z' };
    repo.insertMessage({ ...base, channel: 'email', direction: 'in', kind: 'inbound', externalId: '<in@x>' });
    repo.insertMessage({ ...base, channel: 'email', direction: 'out', kind: 'hello', externalId: '<out@x>' });
    expect(repo.hasMessageWithExternalId('email', '<in@x>', 'in')).toBe(true);
    expect(repo.hasMessageWithExternalId('email', '<in@x>', 'out')).toBe(false);
    expect(repo.hasMessageWithExternalId('email', '<out@x>', 'out')).toBe(true);
    expect(repo.hasMessageWithExternalId('x', '<in@x>', 'in')).toBe(false);
    expect(repo.hasMessageWithExternalId('email', '<nope@x>', 'in')).toBe(false);
  });
});

describe('outbox', () => {
  const mk = (personId: number, sendAfter: string, state: 'scheduled' | 'awaiting_ok' = 'scheduled') =>
    ({ personId, channel: 'email' as const, kind: 'hello' as const, body: 'Hi', state, origin: 'auto' as const, sendAfter });

  it('inserts with defaults and updates', () => {
    const p = repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv' });
    const o = repo.insertOutbox(mk(p.id, '2026-01-05T09:00:00.000Z'));
    expect(o.subject).toBeNull();
    expect(o.undoUntil).toBeNull();
    expect(o.error).toBeNull();
    expect(o.approvalCounted).toBe(false);
    expect(repo.getOutbox(o.id)).toEqual(o);
    expect(repo.updateOutbox(o.id, { approvalCounted: true }).approvalCounted).toBe(true);
    expect(repo.listOutbox()[0]?.approvalCounted).toBe(true);
    expect(repo.updateOutbox(o.id, { approvalCounted: false }).approvalCounted).toBe(false);
    expect(repo.getOutbox(999)).toBeNull();
    const u = repo.updateOutbox(o.id, { state: 'failed', error: 'boom', undoUntil: '2026-01-05T09:00:10.000Z' });
    expect(u.state).toBe('failed');
    expect(u.error).toBe('boom');
    expect(u.updatedAt).not.toBe(o.updatedAt);
  });

  it('filters by state, person and due time, ordered by send_after then id', () => {
    const p = repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv' });
    const q = repo.insertPerson({ projectId, name: 'Ola Bode', source: 'csv' });
    const late = repo.insertOutbox(mk(p.id, '2026-01-07T09:00:00.000Z'));
    const early = repo.insertOutbox(mk(p.id, '2026-01-05T09:00:00.000Z'));
    const awaiting = repo.insertOutbox(mk(q.id, '2026-01-04T09:00:00.000Z', 'awaiting_ok'));
    const tie = repo.insertOutbox(mk(q.id, '2026-01-05T09:00:00.000Z'));
    expect(repo.listOutbox().map((o) => o.id)).toEqual([awaiting.id, early.id, tie.id, late.id]);
    expect(repo.listOutbox({ state: ['scheduled'], dueBefore: '2026-01-06T00:00:00.000Z' }).map((o) => o.id)).toEqual([early.id, tie.id]);
    expect(repo.listOutbox({ state: ['awaiting_ok'] }).map((o) => o.id)).toEqual([awaiting.id]);
    expect(repo.listOutbox({ personId: q.id }).map((o) => o.id)).toEqual([awaiting.id, tie.id]);
    expect(repo.listOutbox({ dueBefore: '2026-01-05T09:00:00.000Z' }).map((o) => o.id)).toEqual([awaiting.id, early.id, tie.id]);
  });
});

describe('incidents', () => {
  it('inserts, resolves and filters', () => {
    const a = repo.insertIncident({ channel: 'linkedin', kind: 'linkedin_check', message: 'Check needed' });
    const b = repo.insertIncident({ channel: 'email', kind: 'bounces', message: 'Bounces', detail: 'three', personId: null });
    expect(a.state).toBe('open');
    expect(a.detail).toBeNull();
    expect(a.resolvedAt).toBeNull();
    const r = repo.updateIncident(a.id, { state: 'resolved', resolvedAt: '2026-01-02T00:00:00.000Z' });
    expect(r.state).toBe('resolved');
    expect(repo.listIncidents().map((i) => i.id)).toEqual([a.id, b.id]);
    expect(repo.listIncidents({ open: true }).map((i) => i.id)).toEqual([b.id]);
    expect(repo.listIncidents({ open: false }).map((i) => i.id)).toEqual([a.id]);
  });
});

describe('deleteAll', () => {
  it('empties people and resets settings and channels', () => {
    const p = repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv' });
    repo.insertMessage({ personId: p.id, channel: 'email', direction: 'out', kind: 'hello', subject: null, body: 'x', at: '2026-01-02T00:00:00.000Z', externalId: null });
    repo.insertOutbox({ personId: p.id, channel: 'email', kind: 'hello', body: 'x', state: 'scheduled', origin: 'auto', sendAfter: '2026-01-02T00:00:00.000Z' });
    repo.insertIncident({ channel: 'email', kind: 'bounces', message: 'm' });
    repo.updateSettings({ senderName: 'Ada', onboarded: true });
    repo.updateChannel('email', { status: 'connected' });
    repo.setChannelSecret('email', { a: 'b' });
    repo.deleteAll();
    expect(repo.listPeople()).toEqual([]);
    expect(repo.listProjects()).toEqual([]);
    expect(repo.listOutbox()).toEqual([]);
    expect(repo.listIncidents()).toEqual([]);
    expect(repo.listMessages(p.id)).toEqual([]);
    expect(repo.getSettings().senderName).toBeNull();
    expect(repo.getSettings().onboarded).toBe(false);
    expect(repo.getChannel('email').status).toBe('disconnected');
    expect(repo.getChannelSecret('email')).toBeNull();
  });
});

describe('transaction', () => {
  it('commits all writes, returns the result', () => {
    const n = repo.transaction(() => {
      repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv' });
      repo.insertPerson({ projectId, name: 'Ada Obi', source: 'csv' });
      return 2;
    });
    expect(n).toBe(2);
    expect(repo.listPeople()).toHaveLength(2);
  });
  it('rolls everything back on a throw and rethrows', () => {
    expect(() => repo.transaction(() => {
      repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv' });
      throw new Error('nope');
    })).toThrow('nope');
    expect(repo.listPeople()).toEqual([]);
  });
  it('nests: an inner failure that is caught keeps the outer writes', () => {
    repo.transaction(() => {
      repo.insertPerson({ projectId, name: 'Kemi Eze', source: 'csv' });
      try {
        repo.transaction(() => { repo.insertPerson({ projectId, name: 'Ada Obi', source: 'csv' }); throw new Error('inner'); });
      } catch { /* expected */ }
    });
    expect(repo.listPeople().map((p) => p.name)).toEqual(['Kemi Eze']);
  });
});
