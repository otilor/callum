import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemplateWriter } from '../ai/templates.js';
import { createCtx, type Ctx } from '../context.js';
import { openDb } from '../db/db.js';
import { fixedClock } from '../engine/clock.js';
import type { Writer } from '../ai/writer.js';
import { ConnectError } from '../channels/types.js';
import { Runner, planDue, planProjectNow } from './runner.js';
import { ctxWith, fakeAdapter, harness, NOW, type FakeAdapter, type Harness } from './testing.test-helpers.js';

const MIN = 60_000;
const DAY = 86_400_000;
const FOLLOW_UP = { touches: 1, stage: 'hello' as const, lastTouchAt: '2026-10-29T09:00:00.000Z', nextTouchAt: '2026-11-03T08:00:00.000Z' };

function runnerFor(h: Harness, opts: ConstructorParameters<typeof Runner>[1] = {}): { runner: Runner; errors: unknown[] } {
  const errors: unknown[] = [];
  return { runner: new Runner(h.ctx, { onError: (e) => errors.push(e), ...opts }), errors };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Runner.tick: sending', () => {
  it('plans, writes and sends a follow-up for someone who is due', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', ...FOLLOW_UP });
    const { runner, errors } = runnerFor(h);
    await runner.tick();
    expect(errors).toEqual([]);
    expect(h.adapters.email.sent).toHaveLength(1);
    expect(h.adapters.email.sent[0]).toMatchObject({ kind: 'follow_up', to: { email: 'kemi@okopay.com' } });
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ touches: 2, stage: 'following', lastTouchAt: NOW });
    expect(h.ctx.repo.getPerson(p.id)?.nextTouchAt).toBe('2026-11-09T08:30:00.000Z'); // six local days on
    expect(h.ctx.repo.listMessages(p.id)).toMatchObject([{ kind: 'follow_up', direction: 'out' }]);
    expect(h.scopes).toEqual(expect.arrayContaining(['people', 'outbox']));
  });

  it('plans a follow-up that falls due at 17:00 but sends it at the next 9:00', async () => {
    const h = harness({ now: '2026-11-03T16:00:00.000Z' }); // 17:00 in Lagos
    const p = h.person({ ...FOLLOW_UP });
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.adapters.email.sent).toEqual([]);
    expect(h.ctx.repo.listOutbox({ personId: p.id })).toMatchObject([{ state: 'scheduled', kind: 'follow_up', sendAfter: '2026-11-04T08:00:00.000Z' }]);
    h.clock.set('2026-11-04T08:00:00Z');
    await runner.tick();
    expect(h.adapters.email.sent).toHaveLength(1);
  });

  it('sends once when two ticks overlap, and hands both callers the same promise', async () => {
    const h = harness();
    h.person({ ...FOLLOW_UP });
    const { runner } = runnerFor(h);
    const a = runner.tick();
    const b = runner.tick();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(h.adapters.email.sent).toHaveLength(1);
    await runner.tick();
    expect(h.adapters.email.sent).toHaveLength(1);
  });

  it('does not send to someone who says stop in the same tick', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', ...FOLLOW_UP });
    const queued = h.ctx.outbox.queueAuto(p.id, 'follow_up', 'Following up', 'S', new Date(NOW), false);
    h.adapters.email.inbox.push([{ type: 'reply', from: { email: 'kemi@okopay.com' }, text: 'Please stop emailing me', at: NOW, externalId: '<stop@x>' }]);
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.adapters.email.sent).toEqual([]);
    expect(h.ctx.repo.getPerson(p.id)?.status).toBe('stopped');
    expect(h.ctx.repo.getOutbox(queued.id)?.state).toBe('cancelled');
    expect(h.ctx.repo.listOutbox({ state: ['scheduled', 'awaiting_ok'] })).toEqual([]);
  });

  it('puts an interested reply on the dock instead of sending', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', ...FOLLOW_UP });
    h.ctx.outbox.queueAuto(p.id, 'follow_up', 'Following up', 'S', new Date(NOW), false);
    h.adapters.email.inbox.push([{ type: 'reply', from: { email: 'kemi@okopay.com' }, text: 'Interesting timing. Can we talk Thursday at 9:00?', at: NOW, externalId: '<yes@x>' }]);
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.adapters.email.sent).toEqual([]);
    const after = h.ctx.repo.getPerson(p.id);
    expect(after?.status).toBe('waiting');
    expect(after?.draft?.length).toBeGreaterThan(0);
    expect(h.ctx.repo.listOutbox({ state: ['scheduled', 'awaiting_ok'] })).toEqual([]);
  });

  it('keeps the follow-up but sends it after the return date for an out-of-office note', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', ...FOLLOW_UP });
    h.ctx.outbox.queueAuto(p.id, 'follow_up', 'Following up', 'S', new Date(NOW), false);
    h.adapters.email.inbox.push([{ type: 'reply', from: { email: 'kemi@okopay.com' }, text: "I'm out of the office until 20 November", at: NOW, externalId: '<ooo@x>' }]);
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.adapters.email.sent).toEqual([]);
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'active', nextTouchAt: '2026-11-23T08:00:00.000Z' });
    expect(h.ctx.repo.listOutbox({ personId: p.id, state: ['scheduled'] })).toMatchObject([{ sendAfter: '2026-11-23T08:00:00.000Z' }]);
    h.clock.set('2026-11-23T08:00:00Z');
    await runner.tick();
    expect(h.adapters.email.sent).toHaveLength(1);
  });

  it('pauses LinkedIn on a check while email carries on in the same tick', async () => {
    const h = harness();
    const li = h.person({ channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/kemi', email: null });
    const mail = h.person({ email: 'kemi@okopay.com', ...FOLLOW_UP });
    h.adapters.linkedin.results.push({ ok: false, error: { code: 'checkpoint', message: 'check' } });
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('paused');
    expect(h.ctx.repo.listIncidents({ open: true }).map((i) => i.kind)).toEqual(['linkedin_check']);
    expect(h.adapters.email.sent).toHaveLength(1);
    expect(h.ctx.repo.getPerson(mail.id)?.touches).toBe(2);
    expect(h.ctx.repo.getPerson(li.id)?.touches).toBe(0);
    await runner.tick();
    expect(h.adapters.linkedin.sent).toHaveLength(1); // not tried again while paused
  });

  it('only sends project 1 when project 2 is paused', async () => {
    const h = harness();
    const second = h.ctx.repo.insertProject({ name: 'Payroll', offer: 'Payroll for small teams' });
    h.ctx.repo.updateProject(second.id, { startedAt: '2026-11-02T10:00:00.000Z', state: 'paused', pausedUntil: '2026-11-20T00:00:00.000Z', approvalsLeft: 0 });
    const a = h.person({ ...FOLLOW_UP });
    const b = h.person({ projectId: second.id, ...FOLLOW_UP });
    h.ctx.outbox.queueAuto(b.id, 'follow_up', 'queued before the pause', 'S', new Date(NOW), false);
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.adapters.email.sent).toHaveLength(1);
    expect(h.ctx.repo.getPerson(a.id)?.touches).toBe(2);
    expect(h.ctx.repo.getPerson(b.id)?.touches).toBe(1);
  });

  it('shares the email cap across projects, earliest due first', async () => {
    const h = harness();
    const second = h.ctx.repo.insertProject({ name: 'Payroll', offer: 'Payroll for small teams' });
    h.ctx.repo.updateProject(second.id, { startedAt: '2026-11-02T10:00:00.000Z', approvalsLeft: 0 });
    const project = new Map<string, number>();
    for (let i = 0; i < 15; i++) {
      const a = h.person({ ...FOLLOW_UP, nextTouchAt: new Date(Date.parse(NOW) - (60 - i * 2) * MIN).toISOString() });
      const b = h.person({ projectId: second.id, ...FOLLOW_UP, nextTouchAt: new Date(Date.parse(NOW) - (59 - i * 2) * MIN).toISOString() });
      project.set(a.email ?? '', h.project.id);
      project.set(b.email ?? '', second.id);
    }
    // 30 people, interleaved by when they became due: the first 20 are ten from each project, in that order.
    const dueOrder = h.ctx.repo.listPeople().sort((x, y) => (x.nextTouchAt ?? '').localeCompare(y.nextTouchAt ?? '')).slice(0, 20).map((p) => p.email);
    const { runner } = runnerFor(h);
    await runner.tick();
    const sent = h.adapters.email.sent.map((m) => m.to.email ?? '');
    expect(sent).toHaveLength(20);
    expect(sent).toEqual(dueOrder);
    expect(sent.filter((e) => project.get(e) === h.project.id)).toHaveLength(10);
    expect(sent.filter((e) => project.get(e) === second.id)).toHaveLength(10);
    // The other ten were not even written: the mailbox has no room for them today.
    expect(h.ctx.repo.listOutbox({ state: ['scheduled', 'awaiting_ok'] })).toEqual([]);
  });
});

describe('Runner.tick: planning', () => {
  it('gives a stranger the first slot after Start, and sends nothing on the day Start was pressed', async () => {
    const h = harness();
    h.ctx.repo.updateProject(h.project.id, { startedAt: NOW });
    const p = h.person();
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.ctx.repo.getPerson(p.id)?.nextTouchAt).toBe('2026-11-04T08:00:00.000Z');
    expect(h.ctx.repo.listOutbox()).toEqual([]);
    h.clock.set('2026-11-04T08:00:00Z');
    await runner.tick();
    expect(h.adapters.email.sent).toHaveLength(1);
    expect(h.adapters.email.sent[0]?.kind).toBe('hello');
  });

  it('sends a stranger added well after Start at the next sending time', async () => {
    const h = harness({ now: '2026-11-07T10:00:00.000Z' }); // Saturday
    const p = h.person();
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.ctx.repo.getPerson(p.id)?.nextTouchAt).toBe('2026-11-09T08:00:00.000Z');
    expect(h.adapters.email.sent).toEqual([]);
  });

  it('asks for an OK on the first hellos, only as many as are left, and lets later people join', async () => {
    const h = harness({ approvalsLeft: 3 });
    for (let i = 0; i < 2; i++) h.person();
    const { runner } = runnerFor(h);
    await runner.tick();
    const awaiting = () => h.ctx.repo.listOutbox({ state: ['awaiting_ok'] });
    expect(awaiting()).toHaveLength(2);
    expect(h.adapters.email.sent).toEqual([]);
    h.person(); // added later
    h.person(); // and one too many
    await runner.tick();
    expect(awaiting()).toHaveLength(3);
    await runner.tick();
    expect(awaiting()).toHaveLength(3);

    // One is approved: two OKs are left and two are still waiting, so nothing else is asked.
    h.ctx.outbox.approve(awaiting()[0]!.id);
    await runner.tick();
    expect(awaiting()).toHaveLength(2);
    expect(h.ctx.repo.getProject(h.project.id)?.approvalsLeft).toBe(2);
  });

  it('counts approvals per project', async () => {
    const h = harness({ approvalsLeft: 1 });
    const second = h.ctx.repo.insertProject({ name: 'Payroll', offer: 'Payroll for small teams' });
    h.ctx.repo.updateProject(second.id, { startedAt: '2026-11-02T10:00:00.000Z', approvalsLeft: 2 });
    for (let i = 0; i < 3; i++) {
      h.person();
      h.person({ projectId: second.id });
    }
    const { runner } = runnerFor(h);
    await runner.tick();
    const items = h.ctx.repo.listOutbox({ state: ['awaiting_ok'] });
    const byProject = (id: number) => items.filter((i) => h.ctx.repo.getPerson(i.personId)?.projectId === id).length;
    expect(byProject(h.project.id)).toBe(1);
    expect(byProject(second.id)).toBe(2);
  });

  it('does not ask for an OK on a follow-up', async () => {
    const h = harness({ approvalsLeft: 5 });
    h.person({ ...FOLLOW_UP });
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.adapters.email.sent).toHaveLength(1);
  });

  it('picks a channel for a person who has none yet', async () => {
    const h = harness();
    const p = h.person({ channel: null, email: null, linkedinUrl: 'https://www.linkedin.com/in/kemi' });
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.ctx.repo.getPerson(p.id)?.channel).toBe('linkedin');
    expect(h.adapters.linkedin.sent[0]?.kind).toBe('invite');
  });

  it('leaves alone anyone it should not write to', async () => {
    const h = harness();
    const second = h.ctx.repo.insertProject({ name: 'Not started', offer: 'Something' });
    h.person({ status: 'held', ...FOLLOW_UP });
    h.person({ status: 'waiting', ...FOLLOW_UP });
    h.person({ status: 'stopped', ...FOLLOW_UP });
    h.person({ ...FOLLOW_UP, stage: 'talking' });
    h.person({ projectId: second.id, ...FOLLOW_UP });
    h.person({ touches: 3, stage: 'following', lastTouchAt: NOW });
    h.person({ nextTouchAt: '2026-11-05T08:00:00.000Z', touches: 1, stage: 'hello' }); // not due yet
    h.person({ channel: null, email: null });
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.ctx.repo.listOutbox()).toEqual([]);
  });

  it.each([
    ['everything is paused', (h: Harness) => h.ctx.repo.updateSettings({ pauseState: 'paused', pausedUntil: '2026-11-20T00:00:00.000Z' })],
    ['the project is paused', (h: Harness) => h.ctx.repo.updateProject(h.project.id, { state: 'paused', pausedUntil: '2026-11-20T00:00:00.000Z' })],
    ['the project is wrapped', (h: Harness) => h.ctx.repo.updateProject(h.project.id, { state: 'wrapped' })],
    ['the project was not started', (h: Harness) => h.ctx.repo.updateProject(h.project.id, { startedAt: null })],
  ])('writes nothing while %s', async (_name, change) => {
    const h = harness();
    h.person({ ...FOLLOW_UP });
    change(h);
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.ctx.repo.listOutbox()).toEqual([]);
  });

  it('does not write a person twice while something is waiting for them or needs the user', async () => {
    const h = harness({ now: '2026-11-03T16:00:00.000Z' });
    const waiting = h.person({ ...FOLLOW_UP });
    const blocked = h.person({ ...FOLLOW_UP });
    h.ctx.repo.insertOutbox({ personId: blocked.id, channel: 'email', kind: 'follow_up', body: 'Price [YOUR PRICE]', state: 'blocked', origin: 'auto', sendAfter: NOW, error: 'x' });
    const { runner } = runnerFor(h);
    await runner.tick();
    await runner.tick();
    await runner.tick();
    expect(h.ctx.repo.listOutbox({ personId: waiting.id })).toHaveLength(1);
    expect(h.ctx.repo.listOutbox({ personId: blocked.id })).toHaveLength(1);
  });

  it('writes with a placeholder, then blocks it instead of sending', async () => {
    const h = harness();
    const p = h.person({ ...FOLLOW_UP });
    const ctx = ctxWith(h, { write: async () => ({ subject: 'Hello', body: 'Our price is [YOUR PRICE].' }) });
    await new Runner(ctx).tick();
    expect(h.adapters.email.sent).toEqual([]);
    expect(h.ctx.repo.listOutbox({ personId: p.id })).toMatchObject([{ state: 'blocked', error: expect.stringContaining('[YOUR PRICE]') }]);
  });

  it('keeps going when the writer fails for one person', async () => {
    const h = harness();
    const a = h.person({ ...FOLLOW_UP });
    const b = h.person({ ...FOLLOW_UP });
    const real = h.ctx.writer;
    const ctx = ctxWith(h, {
      write: async (kind, c) => {
        if (c.person.id === a.id) throw new Error('model unavailable');
        return real.write(kind, c);
      },
    });
    const errors: unknown[] = [];
    await new Runner(ctx, { onError: (e) => errors.push(e) }).tick();
    expect(h.ctx.repo.getPerson(b.id)?.touches).toBe(2);
    expect(h.ctx.repo.getPerson(a.id)?.touches).toBe(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('model unavailable');
  });
});

describe('Runner.tick: housekeeping', () => {
  it('resumes after a break once its date has passed', async () => {
    const h = harness();
    h.ctx.repo.updateSettings({ pauseState: 'paused', pausedUntil: '2026-11-03T09:00:00.000Z' });
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.ctx.repo.getSettings()).toMatchObject({ pauseState: 'paused' });
    h.clock.set('2026-11-03T09:00:00Z');
    await runner.tick();
    expect(h.ctx.repo.getSettings()).toMatchObject({ pauseState: 'running', pausedUntil: null });
    expect(h.scopes).toContain('settings');
  });

  it('does not end a break that has no date', async () => {
    const h = harness();
    h.ctx.repo.updateSettings({ pauseState: 'paused', pausedUntil: null });
    await runnerFor(h).runner.tick();
    expect(h.ctx.repo.getSettings().pauseState).toBe('paused');
  });

  it('resumes a project whose break is over, and sends for it', async () => {
    const h = harness();
    h.ctx.repo.updateProject(h.project.id, { state: 'paused', pausedUntil: '2026-11-03T08:00:00.000Z' });
    h.person({ ...FOLLOW_UP });
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.ctx.repo.getProject(h.project.id)).toMatchObject({ state: 'running', pausedUntil: null });
    expect(h.adapters.email.sent).toHaveLength(1);
    expect(h.scopes).toContain('projects');
  });

  it('leaves a paused project that has no date, and a wrapped one', async () => {
    const h = harness();
    const second = h.ctx.repo.insertProject({ name: 'Wrapped', offer: 'x' });
    h.ctx.repo.updateProject(h.project.id, { state: 'paused', pausedUntil: null });
    h.ctx.repo.updateProject(second.id, { state: 'wrapped' });
    await runnerFor(h).runner.tick();
    expect(h.ctx.repo.listProjects().map((p) => p.state)).toEqual(['paused', 'wrapped']);
  });

  it('brings X back after its limit day and clears the notice, but waits for the user on LinkedIn', async () => {
    const h = harness();
    h.ctx.repo.updateChannel('x', { status: 'paused', pausedUntil: '2026-11-03T08:00:00.000Z' });
    h.ctx.repo.updateChannel('linkedin', { status: 'paused', pausedUntil: '2026-11-03T08:00:00.000Z' });
    h.ctx.repo.insertIncident({ channel: 'x', kind: 'x_limit', message: 'x' });
    h.ctx.repo.insertIncident({ channel: 'linkedin', kind: 'linkedin_check', message: 'l' });
    await runnerFor(h).runner.tick();
    expect(h.ctx.repo.getChannel('x')).toMatchObject({ status: 'connected', pausedUntil: null });
    expect(h.ctx.repo.getChannel('linkedin').status).toBe('paused');
    expect(h.ctx.repo.listIncidents({ open: true }).map((i) => i.kind)).toEqual(['linkedin_check']);
  });

  it('lets LinkedIn invites go again when the week has turned', async () => {
    const h = harness();
    h.ctx.repo.updateChannel('linkedin', { invitesBlockedUntil: '2026-11-03T08:00:00.000Z' });
    h.ctx.repo.insertIncident({ channel: 'linkedin', kind: 'linkedin_weekly_limit', message: 'w' });
    await runnerFor(h).runner.tick();
    expect(h.ctx.repo.getChannel('linkedin').invitesBlockedUntil).toBeNull();
    expect(h.ctx.repo.listIncidents({ open: true })).toEqual([]);
  });

  it('puts a snoozed person back on the dock at their time', async () => {
    const h = harness();
    const p = h.person({ status: 'snoozed', stage: 'talking', snoozedUntil: '2026-11-03T08:00:00.000Z' });
    const later = h.person({ status: 'snoozed', stage: 'talking', snoozedUntil: '2026-11-03T08:30:00.001Z' });
    await runnerFor(h).runner.tick();
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'waiting', snoozedUntil: null });
    expect(h.ctx.repo.getPerson(later.id)?.status).toBe('snoozed');
  });

  it('rests someone four days after their last follow-up, for 90 days', async () => {
    const h = harness();
    const p = h.person({ touches: 3, stage: 'following', lastTouchAt: '2026-10-30T08:00:00.000Z' });
    const early = h.person({ touches: 3, stage: 'following', lastTouchAt: '2026-10-31T08:00:00.000Z' });
    await runnerFor(h).runner.tick();
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ status: 'resting', restUntil: new Date(Date.parse(NOW) + 90 * DAY).toISOString() });
    expect(h.ctx.repo.getPerson(early.id)?.status).toBe('active');
  });

  it('rests a LinkedIn invite that nobody accepted in 14 days', async () => {
    const h = harness();
    const p = h.person({ channel: 'linkedin', email: null, linkedinUrl: 'https://www.linkedin.com/in/kemi', touches: 1, stage: 'hello', linkedinState: 'invited', invitedAt: '2026-10-20T08:00:00.000Z' });
    await runnerFor(h).runner.tick();
    expect(h.ctx.repo.getPerson(p.id)?.status).toBe('resting');
  });

  it('wakes a resting person after 90 days and starts them again', async () => {
    const h = harness();
    const p = h.person({ status: 'resting', touches: 3, stage: 'following', lastTouchAt: '2026-08-01T08:00:00.000Z', restUntil: '2026-11-03T08:00:00.000Z' });
    const still = h.person({ status: 'resting', touches: 3, stage: 'following', restUntil: '2026-11-04T08:00:00.000Z' });
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.ctx.repo.getPerson(still.id)?.status).toBe('resting');
    // Woken, they start again as a stranger and the next hello is planned.
    const after = h.ctx.repo.getPerson(p.id);
    expect(after).toMatchObject({ status: 'active', touches: 1, stage: 'hello', restUntil: null });
    expect(h.adapters.email.sent.map((m) => m.kind)).toEqual(['hello']);
  });

  it('takes back what was queued for someone who goes to rest', async () => {
    const h = harness();
    const p = h.person({ touches: 3, stage: 'following', lastTouchAt: '2026-10-30T08:00:00.000Z' });
    const item = h.ctx.outbox.queueAuto(p.id, 'follow_up', 'x', 'S', new Date('2026-11-09T08:00:00Z'), false);
    await runnerFor(h).runner.tick();
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('cancelled');
  });
});

describe('Runner.tick: polling', () => {
  it('polls every connected channel on the first tick and again once its interval has passed', async () => {
    const h = harness();
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.adapters.email.polls).toEqual([null]);
    expect(h.adapters.x.polls).toEqual([null]);
    expect(h.adapters.linkedin.polls).toEqual([null]);

    h.clock.advance(1 * MIN);
    await runner.tick();
    expect(h.adapters.email.polls).toHaveLength(1);
    h.clock.advance(1 * MIN);
    await runner.tick();
    // Email is polled every two minutes and gets the time of the poll before, not the end of it.
    expect(h.adapters.email.polls).toEqual([null, new Date(NOW)]);
    expect(h.adapters.x.polls).toHaveLength(1);
    h.clock.advance(3 * MIN);
    await runner.tick();
    expect(h.adapters.x.polls).toEqual([null, new Date(NOW)]);
    expect(h.adapters.email.polls).toHaveLength(3);
    expect(h.adapters.email.polls[2]?.toISOString()).toBe(new Date(Date.parse(NOW) + 2 * MIN).toISOString());
    expect(h.ctx.repo.getChannel('email').lastPolledAt).toBe(new Date(Date.parse(NOW) + 5 * MIN).toISOString());
  });

  it('takes the intervals from the options', async () => {
    const h = harness();
    const { runner } = runnerFor(h, { pollEveryMs: { email: 10 * MIN } });
    await runner.tick();
    h.clock.advance(5 * MIN);
    await runner.tick();
    expect(h.adapters.email.polls).toHaveLength(1);
    h.clock.advance(5 * MIN);
    await runner.tick();
    expect(h.adapters.email.polls).toHaveLength(2);
  });

  it('polls LinkedIn only during the sending hours', async () => {
    const h = harness({ now: '2026-11-07T10:00:00.000Z' }); // Saturday
    const { runner } = runnerFor(h);
    await runner.tick();
    expect(h.adapters.linkedin.polls).toEqual([]);
    expect(h.adapters.email.polls).toHaveLength(1);
    h.clock.set('2026-11-09T09:00:00Z'); // Monday 10:00
    await runner.tick();
    expect(h.adapters.linkedin.polls).toHaveLength(1);
  });

  it('does not poll a channel that is not connected', async () => {
    const h = harness({ connected: ['email'] });
    await runnerFor(h).runner.tick();
    expect(h.adapters.x.polls).toEqual([]);
    expect(h.adapters.linkedin.polls).toEqual([]);
  });

  it('handles what a poll brings in the same tick', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', ...FOLLOW_UP });
    h.adapters.email.inbox.push([{ type: 'outbound_seen', email: 'kemi@okopay.com', at: NOW, externalId: '<mine@x>' }]);
    await runnerFor(h).runner.tick();
    expect(h.ctx.repo.getPerson(p.id)).toMatchObject({ stage: 'talking', badge: 'sent' });
    expect(h.adapters.email.sent).toEqual([]);
  });

  it('signs email out when the poll is refused, and stops sending', async () => {
    const h = harness();
    h.ctx.repo.setChannelSecret('email', { provider: 'microsoft', address: 'ada@example.com' });
    h.person({ ...FOLLOW_UP });
    h.adapters.email.pollError = new ConnectError('auth');
    const { runner, errors } = runnerFor(h);
    await runner.tick();
    expect(errors).toEqual([]);
    expect(h.ctx.repo.getChannel('email').status).toBe('error');
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{ kind: 'mailbox_signed_out', message: 'Microsoft signed Callum out of ada@example.com. 1 email is waiting and nothing was lost.' }]);
    expect(h.adapters.email.sent).toEqual([]);
  });

  it('also treats a coded auth error from X as signed out', async () => {
    const h = harness();
    h.adapters.x.pollError = new ConnectError('X signed Callum out. Connect X again from Your Callum.', 'auth');
    await runnerFor(h).runner.tick();
    expect(h.ctx.repo.getChannel('x').status).toBe('error');
    expect(h.ctx.repo.listIncidents({ open: true })).toMatchObject([{ channel: 'x', kind: 'x_signed_out', message: 'X signed Callum out. No messages are waiting and nothing was lost.' }]);
  });

  it('reports another poll failure, keeps the old since, and tries again after the interval', async () => {
    const h = harness();
    const { runner, errors } = runnerFor(h);
    await runner.tick();
    h.clock.advance(2 * MIN);
    h.adapters.email.pollError = new Error("Couldn't reach the mail server");
    await runner.tick();
    expect(errors).toHaveLength(1);
    expect(h.ctx.repo.getChannel('email')).toMatchObject({ status: 'connected', lastPolledAt: NOW });
    h.clock.advance(1 * MIN);
    await runner.tick();
    expect(h.adapters.email.polls).toHaveLength(2); // not hammered
    h.clock.advance(1 * MIN);
    await runner.tick();
    expect(h.adapters.email.polls).toEqual([null, new Date(NOW), new Date(NOW)]);
  });

  it('gives up on a poll that never answers', async () => {
    const h = harness();
    h.adapters.x.poll = () => new Promise(() => undefined);
    const { runner, errors } = runnerFor(h, { pollTimeoutMs: 20 });
    await runner.tick();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toMatch(/too long/);
    expect(h.adapters.email.polls).toHaveLength(1);
  });

  it('keeps an event it could not handle, handles the others, holds the person, and tries it again later', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', ...FOLLOW_UP });
    const other = h.person({ email: 'ola@okopay.com', stage: 'talking' });
    h.ctx.outbox.queueAuto(p.id, 'follow_up', 'Following up', 'S', new Date(NOW), false);
    let fail = true;
    const real = h.ctx.writer;
    const ctx = ctxWith(h, {
      classify: async (t, c) => {
        if (fail && c.person.id === p.id) throw new Error('model down');
        return real.classify(t, c);
      },
    });
    const stop = { type: 'reply' as const, from: { email: 'kemi@okopay.com' }, text: 'Please stop emailing me', at: NOW, externalId: '<stop@x>' };
    const hello = { type: 'reply' as const, from: { email: 'ola@okopay.com' }, text: 'Tell me more about pricing', at: NOW, externalId: '<ola@x>' };
    h.adapters.email.inbox.push([stop, hello]);
    const errors: unknown[] = [];
    const runner = new Runner(ctx, { onError: (e) => errors.push(e) });
    await runner.tick();

    expect(errors.map((e) => (e as Error).message)).toEqual(['model down']);
    expect(h.ctx.repo.getPerson(other.id)?.status).toBe('waiting'); // the rest of the batch went through
    expect(h.ctx.repo.getChannel('email').lastPolledAt).toBe(NOW); // and the poll is done: the event is kept, not re-fetched
    expect(h.ctx.repo.listInboundFailures()).toMatchObject([{ channel: 'email', externalId: '<stop@x>', attempts: 1, personId: p.id }]);
    // Until the stop has been read, nothing automatic goes to that person.
    expect(h.adapters.email.sent).toEqual([]);

    fail = false;
    h.clock.advance(61_000);
    await runner.tick();
    expect(h.ctx.repo.listInboundFailures()).toEqual([]);
    expect(h.ctx.repo.getPerson(p.id)?.status).toBe('stopped');
    expect(h.ctx.repo.listMessages(p.id)).toHaveLength(1);
    expect(h.adapters.email.sent).toEqual([]);
  });

  it('handles a poll that finishes after the tick gave up on it, exactly once', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', stage: 'talking' });
    const stop = { type: 'reply' as const, from: { email: 'kemi@okopay.com' }, text: 'Please stop emailing me', at: NOW, externalId: '<stop@x>' };
    h.adapters.email.inbox.push([stop], [stop]);
    h.adapters.email.delayMs = 60;
    const { runner, errors } = runnerFor(h, { pollTimeoutMs: 10 });
    await runner.tick();
    expect((errors[0] as Error).message).toMatch(/too long/);
    expect(h.ctx.repo.getPerson(p.id)?.status).toBe('active'); // not yet
    // While it is still out, the channel is not asked again.
    h.clock.advance(3 * MIN);
    await runner.tick();
    expect(h.adapters.email.polls).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(h.ctx.repo.getPerson(p.id)?.status).toBe('stopped');
    expect(h.ctx.repo.listMessages(p.id).filter((m) => m.direction === 'in')).toHaveLength(1);
    expect(h.ctx.repo.getChannel('email').lastPolledAt).toBe(NOW);
    h.clock.advance(3 * MIN);
    await runner.tick();
    expect(h.adapters.email.polls).toHaveLength(2);
    expect(h.ctx.repo.listMessages(p.id).filter((m) => m.direction === 'in')).toHaveLength(1);
    expect(h.adapters.email.sent).toEqual([]);
  });

  it('waits for a poll under way when asked to stop', async () => {
    const h = harness();
    const p = h.person({ email: 'kemi@okopay.com', stage: 'talking' });
    h.adapters.email.inbox.push([{ type: 'reply', from: { email: 'kemi@okopay.com' }, text: 'Tell me more about pricing', at: NOW, externalId: '<a@x>' }]);
    h.adapters.email.delayMs = 40;
    const { runner } = runnerFor(h, { pollTimeoutMs: 5000 });
    runner.start(100_000);
    const slow = runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runner.stop();
    await slow;
    expect(h.ctx.repo.listMessages(p.id)).toHaveLength(1);
  });

  it('does not wait for ever on a poll that never answers when stopping', async () => {
    const h = harness();
    h.adapters.x.poll = () => new Promise(() => undefined);
    const { runner } = runnerFor(h, { pollTimeoutMs: 20 });
    await runner.tick();
    await expect(runner.stop()).resolves.toBeUndefined();
  });
});

describe('Runner: planning limits', () => {
  it('writes no more than the channel can send today, less what is already lined up', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      const lined = h.person({ ...FOLLOW_UP, nextTouchAt: '2026-11-10T08:00:00.000Z' });
      h.ctx.outbox.queueAuto(lined.id, 'follow_up', 'Later today', 'S', new Date('2026-11-03T14:00:00Z'), false);
    }
    for (let i = 0; i < 30; i++) h.person({ ...FOLLOW_UP });
    const queued = await planDue(h.ctx);
    expect(queued).toBe(15); // 20 a day, 5 already lined up
    expect(h.ctx.repo.listOutbox({ state: ['scheduled'] })).toHaveLength(20);
  });

  it('counts what already went out today, and picks the rest up the next day', async () => {
    const h = harness();
    const done = h.person({ stage: 'talking' });
    for (let i = 0; i < 18; i++) {
      h.ctx.repo.insertMessage({ personId: done.id, channel: 'email', direction: 'out', kind: 'follow_up', subject: null, body: 'x', at: '2026-11-03T07:00:00.000Z', externalId: null });
    }
    for (let i = 0; i < 5; i++) h.person({ ...FOLLOW_UP });
    expect(await planDue(h.ctx)).toBe(2);
    h.clock.set('2026-11-04T08:00:00Z');
    expect(await planDue(h.ctx)).toBe(3);
  });

  it('stops writing when its time is up and leaves the rest for the next tick', async () => {
    const h = harness();
    let wall = 0;
    const ctx = ctxWith(h, {
      write: async (kind, c) => {
        wall += 10_000;
        return h.ctx.writer.write(kind, c);
      },
    });
    for (let i = 0; i < 8; i++) h.person({ ...FOLLOW_UP });
    expect(await planDue(ctx, { budgetMs: 25_000, wallNow: () => wall })).toBe(3);
    wall = 0;
    expect(await planDue(ctx, { budgetMs: 25_000, wallNow: () => wall })).toBe(3);
    expect(h.ctx.repo.listOutbox({ state: ['scheduled'] })).toHaveLength(6);
  });

  it('sends the user reply before a slow writer is even asked', async () => {
    const h = harness();
    const talker = h.person({ status: 'waiting', stage: 'talking' });
    h.ctx.outbox.queueUserSend(talker.id, 'reply', 'Thursday at 9:00 works.');
    h.clock.advance(11_000);
    h.person({ ...FOLLOW_UP });
    let userSentWhenWriting: boolean | null = null;
    const ctx = ctxWith(h, {
      write: async (kind, c) => {
        userSentWhenWriting = h.adapters.email.sent.some((m) => m.kind === 'reply');
        return h.ctx.writer.write(kind, c);
      },
    });
    await new Runner(ctx).tick();
    expect(userSentWhenWriting).toBe(true);
  });

  it('fills Day one ahead of the slot for the start button, without the time budget or the daily room', async () => {
    const h = harness({ approvalsLeft: 3 });
    h.ctx.repo.updateProject(h.project.id, { startedAt: NOW });
    for (let i = 0; i < 5; i++) h.person();
    expect(await planDue(h.ctx)).toBe(0); // not due until the next weekday 9:00
    let wall = 0;
    const slow = ctxWith(h, { write: async (kind, c) => { wall += 60_000; return h.ctx.writer.write(kind, c); } });
    await planProjectNow(slow, h.project.id, { early: true });
    const waiting = h.ctx.repo.listOutbox({ state: ['awaiting_ok'] });
    expect(waiting).toHaveLength(3);
    expect(waiting.every((i) => i.sendAfter === '2026-11-04T08:00:00.000Z')).toBe(true);
    expect(wall).toBe(180_000);
    expect(h.adapters.email.sent).toEqual([]);
  });

  it('plans one project through the runner', async () => {
    const h = harness({ approvalsLeft: 2 });
    h.ctx.repo.updateProject(h.project.id, { startedAt: NOW });
    h.ctx.repo.updateSettings({ pauseState: 'paused', pausedUntil: null });
    h.person();
    h.person();
    h.person();
    await new Runner(h.ctx).planProject(h.project.id, { early: true });
    expect(h.ctx.repo.listOutbox({ state: ['awaiting_ok'] })).toHaveLength(2);
  });

  it('is still there for the start button to call', async () => {
    const h = harness();
    h.person({ ...FOLLOW_UP });
    expect(await planDue(h.ctx)).toBe(1);
  });
});

describe('Runner: a real restart', () => {
  it('records a reply once when a fresh adapter brings it again after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'callum-restart-'));
    try {
      const file = join(dir, 'callum.db');
      const clock = fixedClock(NOW);
      const event = { type: 'reply' as const, from: { email: 'kemi@okopay.com' }, text: 'Tell me more about pricing', at: NOW, externalId: '<same@x>' };
      const boot = (): { ctx: Ctx; adapter: FakeAdapter } => {
        const adapter = fakeAdapter('email');
        const ctx = createCtx({ db: openDb(file), clock, writer: new TemplateWriter(clock), factory: () => adapter, env: {}, dataDir: dir });
        ctx.repo.updateChannel('email', { status: 'connected', identity: 'ada@example.com', connectedAt: '2026-11-02T08:00:00.000Z' });
        return { ctx, adapter };
      };
      const first = boot();
      first.ctx.repo.updateSettings({ timezone: 'Africa/Lagos', senderName: 'Ada Obi', senderEmail: 'ada@example.com' });
      const project = first.ctx.repo.insertProject({ name: 'One', offer: 'You help fintech teams take reconciliation off their ops team' });
      const person = first.ctx.repo.insertPerson({ projectId: project.id, name: 'Kemi Eze', source: 'csv', email: 'kemi@okopay.com', channel: 'email', stage: 'talking' });
      first.adapter.inbox.push([event]);
      const one = new Runner(first.ctx, { onError: () => undefined });
      await one.tick();
      await one.stop();
      expect(first.ctx.repo.listMessages(person.id)).toHaveLength(1);

      // Restart: a new process, a new adapter that has seen nothing, and the same mailbox still showing the message.
      const second = boot();
      second.adapter.inbox.push([event]);
      second.ctx.repo.updateChannel('email', { lastPolledAt: null });
      const two = new Runner(second.ctx, { onError: () => undefined });
      await two.tick();
      await two.stop();
      expect(second.adapter.polls).toHaveLength(1);
      expect(second.ctx.repo.listMessages(person.id)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Runner.start', () => {
  it('ticks on an interval until stopped', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { runner } = runnerFor(h);
    const tick = vi.spyOn(runner, 'tick').mockResolvedValue(undefined);
    runner.start(1000);
    runner.start(1000); // a second start does not double the timers
    await vi.advanceTimersByTimeAsync(3500);
    expect(tick).toHaveBeenCalledTimes(3);
    runner.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('reports a failing tick without throwing and keeps going', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { runner, errors } = runnerFor(h);
    const tick = vi.spyOn(runner, 'tick').mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    runner.start(1000);
    await vi.advanceTimersByTimeAsync(2500);
    runner.stop();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('disk full');
  });

  it('logs to the console by default', async () => {
    vi.useFakeTimers();
    const h = harness();
    const runner = new Runner(h.ctx);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(runner, 'tick').mockRejectedValueOnce(new Error('disk full'));
    runner.start(1000);
    await vi.advanceTimersByTimeAsync(1500);
    runner.stop();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    log.mockRestore();
  });
});
