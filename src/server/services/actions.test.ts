import { describe, expect, it, vi } from 'vitest';
import type { Person } from '../../shared/types.js';
import {
  approve, book, close, correct, draft, editBlocked, hold, nudge, personDetail, remove, reply, resume, retry, skip, snooze, undo,
} from './actions.js';
import { start } from './onboarding.js';
import { harness, type Harness } from './testing.test-helpers.js';

/** Someone who wrote back and is waiting on the dock. */
function waiting(h: Harness, overrides: Partial<Person> = {}): Person {
  const p = h.person({
    name: 'Kemi Eze', status: 'waiting', stage: 'following', touches: 1, channel: 'email', replyKind: 'interested', suggested: 'reply',
    lastInbound: 'Tell me more', repliedAt: '2026-11-02T09:00:00.000Z', lastTouchAt: '2026-10-30T09:00:00.000Z', ...overrides,
  });
  h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'out', kind: 'hello', subject: 'Quick question, Kemi', body: 'Hi Kemi', at: '2026-10-30T09:00:00.000Z', externalId: null });
  h.ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'in', kind: 'inbound', subject: 'Re: Quick question, Kemi', body: 'Tell me more', at: '2026-11-02T09:00:00.000Z', externalId: null });
  return p;
}

async function started(n = 12): Promise<Harness & { people: Person[] }> {
  const h = harness();
  const people = h.strangers(n);
  await start(h.ctx, h.project.id);
  h.scopes.length = 0;
  return Object.assign(h, { people });
}

const awaiting = (h: Harness) => h.ctx.repo.listOutbox({ state: ['awaiting_ok'] });

describe('approve, skip and undo', () => {
  it('approving ten hellos spends the ten OKs, then Callum goes on its own', async () => {
    const h = await started();
    for (const item of awaiting(h)) {
      const sent = approve(h.ctx, item.id);
      expect(sent).toMatchObject({ state: 'scheduled', approvalCounted: true });
      expect(sent.undoUntil).toBe('2026-11-02T10:00:10.000Z');
    }
    expect(h.ctx.repo.getProject(h.project.id)?.approvalsLeft).toBe(0);
    expect(h.scopes).toEqual(expect.arrayContaining(['outbox', 'projects']));
  });

  it('takes an edited body', async () => {
    const h = await started();
    const [item] = awaiting(h);
    expect(approve(h.ctx, item!.id, 'Hi, a shorter note.').body).toBe('Hi, a shorter note.');
  });

  it('refuses a body with a blank in it, naming the blank', async () => {
    const h = await started();
    const [item] = awaiting(h);
    expect(() => approve(h.ctx, item!.id, 'It costs [YOUR PRICE] a month')).toThrow(
      'Add your price first. Callum never sends a message with [YOUR PRICE] in it.',
    );
    expect(h.ctx.repo.getOutbox(item!.id)?.state).toBe('awaiting_ok');
  });

  it('refuses an empty body, a missing item and a message that is not waiting', async () => {
    const h = await started();
    const [item] = awaiting(h);
    expect(() => approve(h.ctx, item!.id, '   ')).toThrow('Write something first.');
    expect(() => approve(h.ctx, 9999)).toThrow("Callum can't find that message.");
    approve(h.ctx, item!.id);
    expect(() => approve(h.ctx, item!.id)).toThrow(/^This message is not waiting for an OK\.$/);
  });

  it('refuses an invite note over 280 characters', async () => {
    const h = harness({ connected: ['linkedin'] });
    h.person({ email: null, linkedinUrl: 'https://www.linkedin.com/in/tunde' });
    await start(h.ctx, h.project.id);
    const [item] = awaiting(h);
    expect(() => approve(h.ctx, item!.id, 'x'.repeat(281))).toThrow('An invite note can be 280 characters at most.');
    expect(approve(h.ctx, item!.id, 'x'.repeat(280)).state).toBe('scheduled');
  });

  it('skip stops the person, keeps the OK, and queues the next stranger', async () => {
    const h = await started();
    const [first] = awaiting(h);
    await skip(h.ctx, first!.id);
    expect(h.ctx.repo.getOutbox(first!.id)?.state).toBe('cancelled');
    expect(h.ctx.repo.getPerson(first!.personId)).toMatchObject({ status: 'stopped', nextTouchAt: null });
    expect(h.ctx.repo.getProject(h.project.id)?.approvalsLeft).toBe(10);
    const now = awaiting(h);
    expect(now).toHaveLength(10);
    expect(now.map((i) => i.personId)).toContain(h.people[10]!.id);
    expect(now.map((i) => i.personId)).not.toContain(h.people[11]!.id);
    expect(h.scopes).toEqual(expect.arrayContaining(['people', 'outbox']));
  });

  it('skip queues nothing more when every person already has a hello, and only works on a hello waiting for an OK', async () => {
    const h = await started(10);
    const [first] = awaiting(h);
    await skip(h.ctx, first!.id);
    expect(awaiting(h)).toHaveLength(9);
    await expect(skip(h.ctx, first!.id)).rejects.toThrow('This hello is not waiting for an OK.');
  });

  it('skip does not queue a replacement when the OKs are used up', async () => {
    const h = await started(12);
    for (const item of awaiting(h)) approve(h.ctx, item.id);
    expect(awaiting(h)).toHaveLength(0);
    // Callum goes on its own now: nothing is waiting for an OK, so there is nothing to skip.
    await expect(skip(h.ctx, h.ctx.repo.listOutbox()[0]!.id)).rejects.toThrow('This hello is not waiting for an OK.');
  });

  it('undo puts the hello back and gives the OK back, until the window closes', async () => {
    const h = await started();
    const [item] = awaiting(h);
    approve(h.ctx, item!.id);
    expect(h.ctx.repo.getProject(h.project.id)?.approvalsLeft).toBe(9);
    expect(undo(h.ctx, item!.id).state).toBe('awaiting_ok');
    expect(h.ctx.repo.getProject(h.project.id)?.approvalsLeft).toBe(10);
    approve(h.ctx, item!.id);
    h.clock.advance(11_000);
    expect(() => undo(h.ctx, item!.id)).toThrow('Too late to undo');
  });
});

describe('reply, book and close', () => {
  it('refuses a person who is not waiting or talking', () => {
    const h = harness();
    const p = h.person({ channel: 'email' });
    expect(() => reply(h.ctx, p.id, 'Hello')).toThrow("Person1 isn't waiting to hear from you.");
    const stopped = h.person({ channel: 'email', status: 'stopped' });
    expect(() => reply(h.ctx, stopped.id, 'Hello')).toThrow('Person2 asked not to be contacted.');
  });

  it('queues a reply with the undo window', () => {
    const h = harness();
    const kemi = waiting(h);
    const item = reply(h.ctx, kemi.id, 'Thanks Kemi, happy to share more.');
    expect(item).toMatchObject({ kind: 'reply', origin: 'user', state: 'scheduled', channel: 'email', undoUntil: '2026-11-02T10:00:10.000Z' });
    expect(h.scopes).toContain('outbox');
  });

  it('also answers someone already talking', () => {
    const h = harness();
    const p = h.person({ channel: 'email', stage: 'talking', status: 'active' });
    expect(reply(h.ctx, p.id, 'Next Thursday works').state).toBe('scheduled');
  });

  it('names the blank when the reply has one, and refuses an empty reply', () => {
    const h = harness();
    const kemi = waiting(h);
    expect(() => reply(h.ctx, kemi.id, 'It is [YOUR PRICE]')).toThrow('Add your price first. Callum never sends a message with [YOUR PRICE] in it.');
    expect(() => reply(h.ctx, kemi.id, '  ')).toThrow('Write something first.');
    expect(h.ctx.repo.listOutbox()).toEqual([]);
  });

  it('book needs the calendar link of the person\'s project', async () => {
    const h = harness({ calendarUrl: null });
    const kemi = waiting(h);
    await expect(book(h.ctx, kemi.id)).rejects.toMatchObject({ name: 'UserError', message: 'Add your calendar link first' });
  });

  it('book writes the message with the calendar link by default, or sends what the user wrote', async () => {
    const h = harness();
    const kemi = waiting(h);
    const item = await book(h.ctx, kemi.id);
    expect(item).toMatchObject({ kind: 'booking', origin: 'user', state: 'scheduled' });
    expect(item.body).toContain('https://cal.example.com/ada');
    const own = await book(h.ctx, kemi.id, 'Grab a time: https://cal.example.com/ada');
    expect(own.body).toBe('Grab a time: https://cal.example.com/ada');
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('cancelled');
  });

  it('close writes a polite close by default', async () => {
    const h = harness();
    const kemi = waiting(h);
    const item = await close(h.ctx, kemi.id);
    expect(item).toMatchObject({ kind: 'close', origin: 'user' });
    expect(item.body).toContain("won't follow up");
    expect((await close(h.ctx, kemi.id, 'All the best, Kemi.')).body).toBe('All the best, Kemi.');
  });

  it('close and book refuse someone who is not waiting', async () => {
    const h = harness();
    const p = h.person({ channel: 'email' });
    await expect(close(h.ctx, p.id)).rejects.toThrow("Person1 isn't waiting to hear from you.");
    await expect(book(h.ctx, p.id)).rejects.toThrow("Person1 isn't waiting to hear from you.");
  });
});

describe('draft', () => {
  it('gives the draft Callum already wrote for a reply, else writes one', async () => {
    const h = harness();
    const kemi = waiting(h, { draft: 'Thanks Kemi. Would Thursday work?' });
    expect(await draft(h.ctx, kemi.id, 'reply')).toBe('Thanks Kemi. Would Thursday work?');
    const tunde = waiting(h, { name: 'Tunde Ade' });
    expect(await draft(h.ctx, tunde.id, 'reply')).toContain('Tunde');
  });

  it('writes the booking and closing notes, and needs the calendar link for a booking', async () => {
    const h = harness();
    const kemi = waiting(h);
    expect(await draft(h.ctx, kemi.id, 'booking')).toContain('https://cal.example.com/ada');
    expect(await draft(h.ctx, kemi.id, 'close')).toContain("won't follow up");
    h.ctx.repo.updateProject(h.project.id, { calendarUrl: null });
    await expect(draft(h.ctx, kemi.id, 'booking')).rejects.toThrow('Add your calendar link first');
  });
});

describe('retry and editBlocked', () => {
  function failedReply(h: Harness) {
    const kemi = waiting(h);
    const item = h.ctx.repo.insertOutbox({
      personId: kemi.id, channel: 'email', kind: 'reply', body: 'Thanks Kemi', state: 'failed', origin: 'user',
      sendAfter: '2026-11-02T09:00:00.000Z', error: 'Mailbox full',
    });
    const incident = h.ctx.repo.insertIncident({
      channel: 'email', kind: 'send_failed', message: "Your reply to Kemi didn't go out: Mailbox full. It's saved here.",
      detail: JSON.stringify({ outboxId: item.id }), personId: kemi.id,
    });
    return { kemi, item, incident };
  }

  it('sends the same words again and clears the incident', () => {
    const h = harness();
    const { item, incident } = failedReply(h);
    const again = retry(h.ctx, item.id);
    expect(again).toMatchObject({ kind: 'reply', origin: 'user', state: 'scheduled', body: 'Thanks Kemi' });
    expect(again.id).not.toBe(item.id);
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('cancelled');
    expect(h.ctx.repo.listIncidents({ open: true }).map((i) => i.id)).not.toContain(incident.id);
    expect(h.scopes).toEqual(expect.arrayContaining(['outbox', 'incidents']));
  });

  it('only retries a user message that failed', () => {
    const h = harness();
    const kemi = waiting(h);
    const sched = h.ctx.outbox.queueUserSend(kemi.id, 'reply', 'Hi');
    expect(() => retry(h.ctx, sched.id)).toThrow('Only a message that did not go out can be tried again.');
    const auto = h.ctx.repo.insertOutbox({ personId: kemi.id, channel: 'email', kind: 'follow_up', body: 'x', state: 'failed', origin: 'auto', sendAfter: '2026-11-02T09:00:00.000Z' });
    expect(() => retry(h.ctx, auto.id)).toThrow('Only a message that did not go out can be tried again.');
  });

  it('keeps the failed message when the retry itself is refused', () => {
    const h = harness();
    const { kemi, item } = failedReply(h);
    h.ctx.repo.updatePerson(kemi.id, { status: 'stopped' });
    expect(() => retry(h.ctx, item.id)).toThrow('Kemi asked not to be contacted.');
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('failed');
  });

  function blocked(h: Harness, overrides: { kind?: 'hello' | 'follow_up'; approvalCounted?: boolean } = {}) {
    const p = h.person({ channel: 'email' });
    return h.ctx.repo.insertOutbox({
      personId: p.id, channel: 'email', kind: overrides.kind ?? 'follow_up', subject: 'Hi', body: 'It is [YOUR PRICE]', state: 'blocked', origin: 'auto',
      sendAfter: '2026-11-02T09:00:00.000Z', error: 'Add your price first.', approvalCounted: overrides.approvalCounted ?? false,
    });
  }

  it('lets the user fix a blocked follow-up, which then goes at the next slot', () => {
    const h = harness();
    h.ctx.repo.updateProject(h.project.id, { approvalsLeft: 0 });
    const item = blocked(h);
    const fixed = editBlocked(h.ctx, item.id, 'It is 40 dollars a month.');
    expect(fixed).toMatchObject({ state: 'scheduled', body: 'It is 40 dollars a month.', error: null, sendAfter: '2026-11-02T10:00:00.000Z' });
  });

  it('puts a fixed first hello back to wait for the OK while OKs are left', () => {
    const h = harness();
    h.ctx.repo.updateProject(h.project.id, { approvalsLeft: 10 });
    const item = blocked(h, { kind: 'hello' });
    expect(editBlocked(h.ctx, item.id, 'Fixed hello').state).toBe('awaiting_ok');
  });

  it('refuses a fix that still has a blank, and a message that is not stuck', () => {
    const h = harness();
    const item = blocked(h);
    expect(() => editBlocked(h.ctx, item.id, 'Still [YOUR PRICE]')).toThrow('Add your price first. Callum never sends a message with [YOUR PRICE] in it.');
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('blocked');
    const kemi = waiting(h);
    const sched = h.ctx.outbox.queueUserSend(kemi.id, 'reply', 'Hi');
    expect(() => editBlocked(h.ctx, sched.id, 'x')).toThrow('This message is not stuck.');
  });
});

describe('snooze, correct, nudge, hold, resume, remove', () => {
  it('snoozes until next Monday at 9:00 in the user\'s time zone by default', () => {
    const h = harness();
    const kemi = waiting(h);
    const snoozed = snooze(h.ctx, kemi.id);
    expect(snoozed).toMatchObject({ status: 'snoozed', snoozedUntil: '2026-11-09T08:00:00.000Z' });
    expect(h.scopes).toContain('people');
  });

  it('snoozes until the date given, which must be ahead', () => {
    const h = harness();
    const kemi = waiting(h);
    expect(() => snooze(h.ctx, kemi.id, '2026-11-01T00:00:00.000Z')).toThrow('Pick a date in the future.');
    expect(snooze(h.ctx, kemi.id, '2026-11-12T08:00:00.000Z').snoozedUntil).toBe('2026-11-12T08:00:00.000Z');
    expect(() => snooze(h.ctx, kemi.id)).toThrow("Kemi isn't on the dock.");
  });

  it('corrects a misread reply', () => {
    const h = harness();
    const a = waiting(h, { name: 'Ada One' });
    const w = waiting(h, { name: 'Wrong Person' });
    const n = waiting(h, { name: 'Nina Never' });
    expect(correct(h.ctx, a.id, 'auto_reply')).toMatchObject({ status: 'active', replyKind: null, lastInbound: null });
    expect(correct(h.ctx, w.id, 'wrong_person').status).toBe('removed');
    expect(correct(h.ctx, n.id, 'never_contact').status).toBe('stopped');
    expect(() => correct(h.ctx, n.id, 'auto_reply')).toThrow("Nina isn't on the dock.");
  });

  it('never contact cancels what was queued for them', () => {
    const h = harness();
    const n = waiting(h, { name: 'Nina Never' });
    const item = h.ctx.outbox.queueUserSend(n.id, 'reply', 'Hello again');
    correct(h.ctx, n.id, 'never_contact');
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('cancelled');
  });

  it('nudges the next touch to now', () => {
    const h = harness();
    const p = h.person({ channel: 'email', stage: 'hello', touches: 1, nextTouchAt: '2026-11-06T08:00:00.000Z' });
    expect(nudge(h.ctx, p.id).nextTouchAt).toBe('2026-11-02T10:00:00.000Z');
    const talking = h.person({ channel: 'email', stage: 'talking', status: 'active' });
    expect(() => nudge(h.ctx, talking.id)).toThrow('Callum has nothing more to send Person2.');
  });

  it('holds a person and cancels what was queued, then resumes them', () => {
    const h = harness();
    const p = h.person({ channel: 'email', stage: 'hello', touches: 1 });
    const item = h.ctx.outbox.queueAuto(p.id, 'follow_up', 'Hi again', 'Re', h.clock.now(), false);
    expect(hold(h.ctx, p.id).status).toBe('held');
    expect(h.ctx.repo.getOutbox(item.id)?.state).toBe('cancelled');
    expect(() => hold(h.ctx, p.id)).toThrow('Person1 is already on hold.');
    expect(resume(h.ctx, p.id).status).toBe('active');
    expect(() => resume(h.ctx, p.id)).toThrow("Person1 isn't on hold.");
  });

  it('a resumed person whose touch fell due while held moves to the next sending slot', () => {
    const h = harness();
    const p = h.person({ channel: 'email', stage: 'hello', touches: 1, lastTouchAt: '2026-10-28T09:00:00.000Z', nextTouchAt: '2026-11-01T09:00:00.000Z', status: 'held' });
    expect(resume(h.ctx, p.id).nextTouchAt).toBe('2026-11-02T10:00:00.000Z');
  });

  it('removes someone who is not a fit, but never turns a stop into a removal', async () => {
    const h = await started(3);
    const [item] = awaiting(h);
    const gone = remove(h.ctx, item!.personId);
    expect(gone.status).toBe('removed');
    expect(h.ctx.repo.getOutbox(item!.id)?.state).toBe('cancelled');
    const stopped = h.person({ status: 'stopped' });
    expect(() => remove(h.ctx, stopped.id)).toThrow('Person4 asked not to be contacted.');
    const kemi = waiting(h);
    expect(() => remove(h.ctx, kemi.id)).toThrow('Kemi has written back, so Callum keeps them.');
  });
});

describe('personDetail', () => {
  it('gives the person, their messages in order and the path', () => {
    const h = harness();
    const kemi = waiting(h);
    const detail = personDetail(h.ctx, kemi.id);
    expect(detail.person.id).toBe(kemi.id);
    expect(detail.messages.map((m) => m.direction)).toEqual(['out', 'in']);
    expect(detail.path.map((s) => s.label)).toEqual(['Hello', 'Follow-up', 'Last follow-up']);
    expect(() => personDetail(h.ctx, 9999)).toThrow("Callum can't find that person.");
  });
});

describe('never contact', () => {
  it('works for anyone who is not already stopped or removed, and drops what was queued', () => {
    const h = harness();
    const active = h.person({ channel: 'email', stage: 'hello', touches: 1 });
    const queued = h.ctx.outbox.queueAuto(active.id, 'follow_up', 'Hi again', 'Re', h.clock.now(), false);
    expect(correct(h.ctx, active.id, 'never_contact')).toMatchObject({ status: 'stopped', nextTouchAt: null });
    expect(h.ctx.repo.getOutbox(queued.id)?.state).toBe('cancelled');
    for (const status of ['held', 'resting', 'snoozed', 'closed'] as const) {
      const p = h.person({ channel: 'email', status });
      expect(correct(h.ctx, p.id, 'never_contact').status).toBe('stopped');
    }
    const talking = h.person({ channel: 'email', stage: 'talking' });
    expect(correct(h.ctx, talking.id, 'never_contact').status).toBe('stopped');
  });

  it('refuses someone already stopped or removed, and the other corrections still need the dock', () => {
    const h = harness();
    const stopped = h.person({ status: 'stopped' });
    const removed = h.person({ status: 'removed' });
    expect(() => correct(h.ctx, stopped.id, 'never_contact')).toThrow('Person1 asked not to be contacted.');
    expect(() => correct(h.ctx, removed.id, 'never_contact')).toThrow("Person2 isn't on your list.");
    const active = h.person({ channel: 'email' });
    expect(() => correct(h.ctx, active.id, 'wrong_person')).toThrow("Person3 isn't on the dock.");
    expect(() => correct(h.ctx, active.id, 'auto_reply')).toThrow("Person3 isn't on the dock.");
  });
});

describe('fix round 1 behaviour', () => {
  it('undo on a hello that was never approved says there is nothing to undo', async () => {
    const h = await started();
    const [item] = awaiting(h);
    expect(() => undo(h.ctx, item!.id)).toThrow(/^Nothing to undo\.$/);
  });

  it('skip succeeds and reports it when the replacement hello cannot be written', async () => {
    const h = await started();
    const problems: unknown[] = [];
    h.ctx.onError = (e) => problems.push(e);
    vi.spyOn(h.ctx.writer, 'write').mockRejectedValue(new Error('Claude is busy'));
    const [first] = awaiting(h);
    await expect(skip(h.ctx, first!.id)).resolves.toBeUndefined();
    expect(h.ctx.repo.getPerson(first!.personId)?.status).toBe('stopped');
    expect(h.ctx.repo.getOutbox(first!.id)?.state).toBe('cancelled');
    expect(problems.map((e) => (e as Error).message)).toEqual(['Claude is busy']);
  });

  it('holding or removing someone whose approved hello has not left gives the OK back', async () => {
    const h = await started();
    const [a, b] = awaiting(h);
    approve(h.ctx, a!.id);
    approve(h.ctx, b!.id);
    expect(h.ctx.repo.getProject(h.project.id)?.approvalsLeft).toBe(8);
    hold(h.ctx, a!.personId);
    expect(h.ctx.repo.getProject(h.project.id)?.approvalsLeft).toBe(9);
    remove(h.ctx, b!.personId);
    expect(h.ctx.repo.getProject(h.project.id)?.approvalsLeft).toBe(10);
    expect(h.scopes).toContain('projects');
  });

  it('retry and editBlocked refuse while a newer reply to the same person waits', () => {
    const h = harness();
    const kemi = waiting(h);
    const failed = h.ctx.repo.insertOutbox({ personId: kemi.id, channel: 'email', kind: 'reply', body: 'Thanks Kemi', state: 'failed', origin: 'user', sendAfter: '2026-11-02T09:00:00.000Z', error: 'Mailbox full' });
    const blockedUser = h.ctx.repo.insertOutbox({ personId: kemi.id, channel: 'email', kind: 'reply', body: 'It is [YOUR PRICE]', state: 'blocked', origin: 'user', sendAfter: '2026-11-02T09:00:00.000Z' });
    const newer = reply(h.ctx, kemi.id, 'A newer reply');
    const message = 'You already have a newer reply to Kemi waiting. Send or undo that one first.';
    expect(() => retry(h.ctx, failed.id)).toThrow(message);
    expect(() => editBlocked(h.ctx, blockedUser.id, 'Fixed')).toThrow(message);
    expect(h.ctx.repo.getOutbox(failed.id)?.state).toBe('failed');
    undo(h.ctx, newer.id);
    expect(retry(h.ctx, failed.id).state).toBe('scheduled');
  });
});

