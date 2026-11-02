import { describe, expect, it } from 'vitest';
import type { Person } from '../../shared/types.js';
import { dispatchDue } from '../runner/dispatch.js';
import { harness, type Harness } from '../runner/testing.test-helpers.js';
import { NoteError, quietSnapshot, realReply, sendReferral, trackPause } from './quiet.js';

const OPT_OUT = "If this isn't for you, just reply stop and I won't write again.";

function hello(h: Harness, p: Person, at: string, body = 'Hi, a quick note.'): void {
  h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'out', kind: 'hello', subject: 'Quick question', body, at, externalId: null });
}

describe('quietSnapshot: empty and day two', () => {
  it('is empty when nobody is in the river', () => {
    const h = harness();
    const q = quietSnapshot(h.ctx);
    expect(q.empty).toBe(true);
    expect(q.projectId).toBe(h.project.id);
    expect([q.day2, q.used, q.paused]).toEqual([null, null, null]);
    expect(q.away).toEqual([]);
    expect(q.referrals).toEqual([]);
  });

  it('is empty for a project that has nobody, even when another project has people', () => {
    const h = harness();
    h.person();
    const second = h.ctx.repo.insertProject({ name: 'Payroll' });
    expect(quietSnapshot(h.ctx, second.id).empty).toBe(true);
    expect(quietSnapshot(h.ctx, h.project.id).empty).toBe(false);
  });

  it('describes day two: what went out, what comes next, and the last few hellos', () => {
    const h = harness();
    const people = Array.from({ length: 5 }, (_, i) => h.person({ name: `Person${i} Test`, stage: 'hello', touches: 1, lastTouchAt: '2026-11-02T10:00:00.000Z' }));
    people.forEach((p, i) => hello(h, p, `2026-11-02T1${i}:00:00.000Z`, `Hi ${p.firstName}.\n\n${OPT_OUT}`));
    // Hellos for three more people wait for tomorrow at 9:00 in Lagos.
    for (let i = 0; i < 3; i++) h.ctx.outbox.queueAuto(h.person().id, 'hello', 'Hi', 'Quick question', new Date('2026-11-04T08:00:00.000Z'), false);
    const q = quietSnapshot(h.ctx);
    expect(q.day2?.sentYesterday).toBe(5);
    expect(q.day2?.nextCount).toBe(3);
    expect(q.day2?.nextAt).toBe('2026-11-04T08:00:00.000Z');
    expect(q.day2?.sent.map((s) => s.name)).toEqual(['Person4 Test', 'Person3 Test', 'Person2 Test']);
    expect(q.day2?.sent[0]?.text).toBe('Hi Person4.');
    expect(q.used).toBeNull();
  });

  it('is not day two once someone has replied, or after three days', () => {
    const h = harness();
    const a = h.person({ stage: 'hello', touches: 1 });
    hello(h, a, '2026-11-02T11:00:00.000Z');
    expect(quietSnapshot(h.ctx).day2).not.toBeNull();
    h.ctx.repo.updatePerson(a.id, { status: 'waiting', repliedAt: '2026-11-03T07:00:00.000Z', replyKind: 'interested' });
    expect(quietSnapshot(h.ctx).day2).toBeNull();
    h.ctx.repo.updatePerson(a.id, { status: 'active', repliedAt: null, replyKind: null });
    h.clock.set('2026-11-06T08:30:00.000Z');
    expect(quietSnapshot(h.ctx).day2).toBeNull();
  });
});

describe('quietSnapshot: group used up', () => {
  it('says when every stranger has heard from you, who replied and when the rest finish', () => {
    const h = harness();
    const replied = ['Kemi', 'Tunde'].map((n) => h.person({ name: `${n} Test`, status: 'waiting', stage: 'talking', touches: 1, repliedAt: '2026-11-03T07:00:00.000Z', replyKind: 'interested' }));
    h.person({ stage: 'following', touches: 2, nextTouchAt: '2026-11-10T08:00:00.000Z' });
    h.person({ stage: 'hello', touches: 1, nextTouchAt: '2026-11-13T08:00:00.000Z' });
    const q = quietSnapshot(h.ctx);
    expect(q.used).toEqual({
      replied: replied.map((p) => ({ id: p.id, first: p.firstName })), repliedCount: 2, finishing: 2, finishBy: '2026-11-13T08:00:00.000Z',
    });
  });

  it('is not used up while a stranger is waiting for a first hello', () => {
    const h = harness();
    h.person({ stage: 'hello', touches: 1 });
    h.person();
    expect(quietSnapshot(h.ctx).used).toBeNull();
  });

  it('is not used up while hellos wait for an OK', () => {
    const h = harness();
    const p = h.person({ stage: 'hello', touches: 1 });
    h.ctx.outbox.queueAuto(h.person({ stage: 'hello', touches: 1 }).id, 'hello', 'Hi', 'Hi', new Date('2026-11-04T08:00:00.000Z'), true);
    expect(p.id).toBeGreaterThan(0);
    expect(quietSnapshot(h.ctx).used).toBeNull();
  });
});

describe('out of office', () => {
  const AWAY = "Thanks for your email. I'm out of the office until 20 November with limited access to email.";

  function awayPerson(h: Harness): Person {
    const p = h.person({ name: 'Kemi Eze', stage: 'hello', touches: 1, lastTouchAt: '2026-11-02T10:00:00.000Z', nextTouchAt: '2026-11-23T08:00:00.000Z' });
    hello(h, p, '2026-11-02T10:00:00.000Z');
    h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'in', kind: 'inbound', subject: null, body: AWAY, at: '2026-11-03T08:10:00.000Z', externalId: null });
    return h.ctx.repo.getPerson(p.id) as Person;
  }

  it('finds the person who is away, when they are back and when Callum follows up', () => {
    const h = harness();
    const p = awayPerson(h);
    const q = quietSnapshot(h.ctx);
    expect(q.away).toHaveLength(1);
    expect(q.away[0]).toMatchObject({ personId: p.id, first: 'Kemi', until: '2026-11-20', followUpAt: '2026-11-23T08:00:00.000Z', text: AWAY });
  });

  it('does not call a real reply an auto-reply', () => {
    const h = harness();
    const p = h.person({ stage: 'hello', touches: 1, nextTouchAt: '2026-11-23T08:00:00.000Z' });
    h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'in', kind: 'inbound', subject: null, body: 'Not now, but try me in January.', at: '2026-11-03T08:10:00.000Z', externalId: null });
    expect(quietSnapshot(h.ctx).away).toEqual([]);
  });

  it('moves them to the dock with a drafted reply when the user says it is a real reply', async () => {
    const h = harness();
    const p = awayPerson(h);
    h.ctx.outbox.queueAuto(p.id, 'follow_up', 'Hi again', 'Re: Quick question', new Date('2026-11-23T08:00:00.000Z'), false);
    const next = await realReply(h.ctx, p.id);
    expect(next).toMatchObject({ status: 'waiting', replyKind: 'interested', suggested: 'reply', nextTouchAt: null, lastInbound: AWAY, repliedAt: '2026-11-03T08:10:00.000Z' });
    expect(next.draft).toBeTruthy();
    expect(h.ctx.repo.listOutbox({ personId: p.id, state: ['scheduled', 'awaiting_ok'] })).toEqual([]);
    expect(quietSnapshot(h.ctx).away).toEqual([]);
    // Saying it twice changes nothing.
    expect((await realReply(h.ctx, p.id)).draft).toBe(next.draft);
  });

  it('refuses when the person has not written back', async () => {
    const h = harness();
    const p = h.person({ stage: 'hello', touches: 1 });
    hello(h, p, '2026-11-02T10:00:00.000Z');
    await expect(realReply(h.ctx, p.id)).rejects.toThrow(new NoteError(`${p.firstName} has not written back yet`));
  });
});

describe('referrals', () => {
  function referral(h: Harness): { kemi: Person; sam: Person } {
    const kemi = h.person({ name: 'Kemi Eze', company: 'Oko Pay', status: 'waiting', stage: 'hello', touches: 1, replyKind: 'referral', repliedAt: h.clock.now().toISOString() });
    const sam = h.ctx.repo.insertPerson({
      projectId: h.project.id, name: 'Sam Bello', source: 'referral', email: 'sam@okopay.com', note: 'Not me, but Sam Bello runs finance here and owns this.',
    });
    return { kemi, sam };
  }

  it('finds the person someone pointed to, who said so, and drafts a hello that names them', () => {
    const h = harness();
    const { kemi, sam } = referral(h);
    const card = quietSnapshot(h.ctx).referrals[0];
    expect(card).toMatchObject({
      personId: sam.id, first: 'Sam', name: 'Sam Bello', context: 'runs finance at Oko Pay and owns this', channel: 'email',
      referrer: { id: kemi.id, first: 'Kemi', name: 'Kemi Eze', company: 'Oko Pay' },
      subject: 'Kemi suggested I get in touch',
    });
    expect(card?.draft).toBe(
      "Hi Sam, Kemi suggested I reach out. I help fintech teams take reconciliation off their ops team's plate. Would a short call next week be useful?",
    );
  });

  it('still makes a card when nothing says who pointed', () => {
    const h = harness();
    const sam = h.ctx.repo.insertPerson({ projectId: h.project.id, name: 'Sam Bello', source: 'referral', email: 'sam@okopay.com', note: null });
    const card = quietSnapshot(h.ctx).referrals[0];
    expect(card).toMatchObject({ personId: sam.id, referrer: null, context: null });
    expect(card?.draft).toContain("I was told you're the right person to talk to.");
  });

  it('sends the hello like any message the user writes, and the person moves into the river when it goes', async () => {
    const h = harness();
    const { sam } = referral(h);
    const body = 'Hi Sam, Kemi suggested I reach out. Would a short call next week be useful?';
    const item = sendReferral(h.ctx, sam.id, body);
    expect(item).toMatchObject({ kind: 'hello', origin: 'user', state: 'scheduled', channel: 'email', subject: 'Kemi suggested I get in touch', body });
    expect(item.undoUntil).toBe('2026-11-03T08:30:10.000Z');
    expect(quietSnapshot(h.ctx).referrals).toEqual([]);

    h.clock.advance(11_000);
    expect(await dispatchDue(h.ctx)).toBe(1);
    const mail = h.adapters.email.sent[0];
    expect(mail?.to.email).toBe('sam@okopay.com');
    expect(mail?.body).toBe(`${body}\n\n${OPT_OUT}`);
    expect(h.ctx.repo.getPerson(sam.id)).toMatchObject({ stage: 'hello', touches: 1 });
  });

  it('can be undone in the window like any other send', () => {
    const h = harness();
    const { sam } = referral(h);
    const item = sendReferral(h.ctx, sam.id, 'Hi Sam, Kemi suggested I reach out.');
    h.ctx.outbox.undo(item.id);
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('cancelled');
    expect(quietSnapshot(h.ctx).referrals).toHaveLength(1);
  });

  it('says why it cannot send', () => {
    const h = harness();
    const { sam } = referral(h);
    expect(() => sendReferral(h.ctx, sam.id, '   ')).toThrow('Write a line to Sam first');
    expect(() => sendReferral(h.ctx, sam.id, 'Hi Sam, [YOUR PRICE] a month.')).toThrow(NoteError);
    expect(() => sendReferral(h.ctx, sam.id, 'Hi Sam, [YOUR PRICE] a month.')).toThrow('[YOUR PRICE]');
    sendReferral(h.ctx, sam.id, 'Hi Sam.');
    expect(() => sendReferral(h.ctx, sam.id, 'Hi Sam again.')).toThrow('Sam has already heard from you');
  });

  it('says when there is no way to reach them', () => {
    const h = harness({ connected: ['linkedin'] });
    const sam = h.ctx.repo.insertPerson({ projectId: h.project.id, name: 'Sam Bello', source: 'referral', email: 'sam@okopay.com' });
    expect(() => sendReferral(h.ctx, sam.id, 'Hi Sam.')).toThrow('Callum has no way to reach Sam yet');
  });
});

describe('paused for three days', () => {
  it('notes when a pause began and asks about it after three days', () => {
    const h = harness();
    h.person();
    h.person({ stage: 'hello', touches: 1, nextTouchAt: '2026-11-05T08:00:00.000Z' });
    expect(trackPause(h.ctx)).toBeNull();
    h.ctx.repo.updateSettings({ pauseState: 'paused', pausedUntil: null });
    expect(trackPause(h.ctx)).toBe('2026-11-03T08:30:00.000Z');
    expect(quietSnapshot(h.ctx).paused).toBeNull();

    h.clock.set('2026-11-06T08:30:00.000Z');
    expect(quietSnapshot(h.ctx).paused).toEqual({ since: '2026-11-03T08:30:00.000Z', days: 3, hellos: 1, followUps: 1 });

    h.ctx.repo.updateSettings({ pauseState: 'running' });
    expect(quietSnapshot(h.ctx).paused).toBeNull();
    h.ctx.repo.updateSettings({ pauseState: 'paused' });
    expect(trackPause(h.ctx)).toBe('2026-11-06T08:30:00.000Z');
  });
});
