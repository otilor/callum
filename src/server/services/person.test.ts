import { beforeEach, describe, expect, it } from 'vitest';
import type { Channel, NewPerson, Person, Project, Scope } from '../../shared/types.js';
import { createCtx, type Ctx } from '../context.js';
import { openDb } from '../db/db.js';
import { fixedClock } from '../engine/clock.js';
import { UserError } from './errors.js';
import { canSwitchAt, moveTo, personDetail, restAgain, wakeEarly } from './person.js';

/** Monday 11:00 in Lagos. */
const MONDAY = '2026-11-02T10:00:00.000Z';
const FRIDAY_HELLO = '2026-10-30T08:12:00.000Z';
const THURSDAY_9 = '2026-11-05T08:00:00.000Z';

let clock: ReturnType<typeof fixedClock>;
let ctx: Ctx;
let project: Project;
let scopes: Scope[];

function connect(...channels: Channel[]): void {
  for (const ch of channels) ctx.repo.updateChannel(ch, { status: 'connected', identity: ch, connectedAt: MONDAY });
}

function add(over: Partial<NewPerson> = {}): Person {
  return ctx.repo.insertPerson({ projectId: project.id, name: 'Chidi Okeke', source: 'csv', company: 'Marina Ledger', role: 'Co-founder', ...over });
}

/** An email person whose hello went out on Friday morning and whose follow-up is due Thursday at 9:00. */
function afterHello(over: Partial<NewPerson> = {}): Person {
  const p = add({
    email: 'chidi@marinaledger.com', linkedinUrl: 'https://www.linkedin.com/in/chidi', channel: 'email', stage: 'hello', touches: 1,
    lastTouchAt: FRIDAY_HELLO, nextTouchAt: THURSDAY_9, ...over,
  });
  ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'out', kind: 'hello', subject: 'Hello', body: 'Hi Chidi', at: FRIDAY_HELLO, externalId: null });
  return p;
}

beforeEach(() => {
  clock = fixedClock(MONDAY);
  ctx = createCtx({ db: openDb(':memory:'), clock, demo: true, env: {}, dataDir: '/tmp/callum-test' });
  ctx.repo.updateSettings({ timezone: 'Africa/Lagos', senderEmail: 'ada@example.com' });
  project = ctx.repo.insertProject({ name: 'Reconciliation', offer: 'You help fintech teams' });
  ctx.repo.updateProject(project.id, { startedAt: '2026-10-29T10:00:00.000Z' });
  connect('email', 'linkedin');
  scopes = [];
  ctx.bus.on((s) => scopes.push(s));
});

describe('personDetail: next, why and switchable', () => {
  it('says what goes out next, on which channel, at an exact time', () => {
    const detail = personDetail(ctx, afterHello().id);
    expect(detail.next).toBe('Follow-up goes out Thursday at 9:00 by email');
    expect(detail.projectName).toBe('Reconciliation');
    expect(detail.messages).toHaveLength(1);
  });

  it('blocks a LinkedIn switch three days after a hello, with the exact reason', () => {
    const detail = personDetail(ctx, afterHello().id);
    expect(detail.switchable).toEqual([
      {
        channel: 'linkedin', available: true, at: '2026-11-06T08:12:00.000Z',
        reason: 'Callum can switch Chidi to LinkedIn from Friday, a week after the last email.',
      },
    ]);
  });

  it('lists only channels that are connected', () => {
    expect(personDetail(ctx, afterHello().id).switchable.map((s) => s.channel)).toEqual(['linkedin']);
    connect('x');
    expect(personDetail(ctx, afterHello({ name: 'Ngozi Ibe', email: 'ngozi@x.com', linkedinUrl: null }).id).switchable.map((s) => s.channel)).toEqual(['linkedin', 'x']);
  });

  it('asks for a handle the person does not have', () => {
    const p = afterHello({ name: 'Ngozi Ibe', email: 'ngozi@bariga.com', linkedinUrl: null });
    expect(personDetail(ctx, p.id).switchable).toEqual([{ channel: 'linkedin', at: null, reason: "Add Ngozi's LinkedIn first", available: true }]);
  });

  it('has no reason once the week has passed, and says when the move would start', () => {
    clock.set('2026-11-09T10:00:00.000Z');
    const detail = personDetail(ctx, afterHello().id);
    expect(detail.switchable).toEqual([{ channel: 'linkedin', at: '2026-11-09T10:00:00.000Z', reason: null, available: true }]);
  });

  it('refuses every switch for someone who is talking', () => {
    const p = afterHello({ stage: 'talking', status: 'waiting', replyKind: 'interested', repliedAt: '2026-11-02T08:40:00.000Z' });
    expect(personDetail(ctx, p.id).switchable).toEqual([
      { channel: 'linkedin', at: null, available: false, reason: 'Chidi is talking with you on email, so Callum keeps it there.' },
    ]);
  });

  it.each([
    ['email', { email: 'k@okopay.com' }, "Callum picked email because Kemi's address is verified."],
    ['linkedin', { email: null, linkedinUrl: 'https://www.linkedin.com/in/kemi' }, 'Callum picked LinkedIn because Kemi is on LinkedIn and has no email.'],
    ['x', { email: null, linkedinUrl: null, xHandle: 'kemi' }, 'Callum picked X because Kemi is only reachable on X.'],
  ] as const)('explains the %s channel', (channel, handles, why) => {
    const p = add({ name: 'Kemi Eze', channel, ...handles });
    expect(personDetail(ctx, p.id).why).toBe(why);
  });

  it('has no why before a channel is picked', () => {
    expect(personDetail(ctx, add({ name: 'Kemi Eze', email: 'k@okopay.com' }).id).why).toBeNull();
  });

  it('schedules a stranger from the project start, and waits for the OK when one is pending', () => {
    const p = add({ name: 'Kemi Eze', email: 'k@okopay.com', channel: 'email' });
    expect(personDetail(ctx, p.id).next).toBe('First hello goes out today at 11:00 by email');
    ctx.outbox.queueAuto(p.id, 'hello', 'Hi Kemi', 'Hello', new Date('2026-11-03T08:00:00.000Z'), true);
    expect(personDetail(ctx, p.id).next).toBe('First hello waits for your OK before it goes by email');
  });

  it('says Start has not been pressed yet', () => {
    ctx.repo.updateProject(project.id, { startedAt: null });
    expect(personDetail(ctx, add({ name: 'Kemi Eze', email: 'k@okopay.com' }).id).next).toBe('Callum starts on Kemi once you press Start');
  });

  it('says what the last follow-up means', () => {
    const p = add({ name: 'Kemi Eze', email: 'k@okopay.com', channel: 'email', stage: 'following', touches: 3, lastTouchAt: '2026-10-30T08:00:00.000Z' });
    expect(personDetail(ctx, p.id).next).toBe('That was the last follow-up. If Kemi stays quiet, Kemi rests from tomorrow');
  });

  it('says when a resting person starts again, and that a stopped one never does', () => {
    const resting = add({ name: 'Mei Lin', xHandle: 'mei', channel: 'x', stage: 'following', touches: 3, status: 'resting', restUntil: '2027-02-03T08:00:00.000Z' });
    expect(personDetail(ctx, resting.id).next).toBe('Mei rests until 3 February, then starts again as a stranger');
    const stopped = add({ name: 'Ruth Adeleke', email: 'r@palm.com', channel: 'email', status: 'stopped', replyKind: 'stop' });
    const detail = personDetail(ctx, stopped.id);
    expect(detail.next).toBe('Nothing goes to Ruth, ever again');
    expect(detail.closedNote).toBe("Ruth asked not to be contacted. Callum stopped everything and won't reach out again.");
  });

  it('knows the note differs when the user chose never to contact', () => {
    const p = add({ name: 'Ruth Adeleke', email: 'r@palm.com', channel: 'email', status: 'stopped', replyKind: 'interested' });
    expect(personDetail(ctx, p.id).closedNote).toBe(
      'You asked Callum never to contact Ruth. Everything was cancelled, and Callum skips Ruth in any list you bring later.',
    );
  });

  it('never ends a next line with a full stop, so a sentence made of one has exactly one', () => {
    const lines = [
      afterHello(),
      add({ name: 'Kemi Eze', email: 'k@okopay.com', channel: 'email', stage: 'following', touches: 3, lastTouchAt: '2026-10-30T08:00:00.000Z' }),
      add({ name: 'Ngozi Ibe', linkedinUrl: 'https://www.linkedin.com/in/ngozi', channel: 'linkedin', stage: 'hello', touches: 1, linkedinState: 'invited', invitedAt: '2026-10-30T08:00:00.000Z', lastTouchAt: '2026-10-30T08:00:00.000Z', nextTouchAt: null }),
      add({ name: 'Mei Lin', xHandle: 'mei', channel: 'x', status: 'resting', restUntil: '2027-02-03T08:00:00.000Z' }),
      add({ name: 'Ruth A', email: 'r@o.com', channel: 'email', status: 'stopped' }),
    ].map((p) => personDetail(ctx, p.id).next);
    for (const line of lines) {
      expect(line).not.toBeNull();
      expect(line).not.toMatch(/\.$/);
    }
  });

  it('calls only an email or X follow-up the last one, since LinkedIn has its own steps', () => {
    const email = add({ name: 'Kemi Eze', email: 'k@okopay.com', channel: 'email', stage: 'following', touches: 2, lastTouchAt: FRIDAY_HELLO, nextTouchAt: THURSDAY_9 });
    expect(personDetail(ctx, email.id).next).toBe('Last follow-up goes out Thursday at 9:00 by email');
    const linkedin = add({ name: 'Ngozi Ibe', linkedinUrl: 'https://www.linkedin.com/in/ngozi', channel: 'linkedin', stage: 'following', touches: 2, linkedinState: 'connected', lastTouchAt: FRIDAY_HELLO, nextTouchAt: THURSDAY_9 });
    expect(personDetail(ctx, linkedin.id).next).toBe('Follow-up goes out Thursday at 9:00 on LinkedIn');
  });

  it('throws a 404 UserError for someone who is not there', () => {
    expect(() => personDetail(ctx, 999)).toThrow(UserError);
  });
});

describe('personDetail: the path', () => {
  it('uses the real times of what was sent and marks what is next', () => {
    const path = personDetail(ctx, afterHello().id).path;
    expect(path.map((s) => [s.label, s.state, s.at])).toEqual([
      ['Hello', 'done', FRIDAY_HELLO],
      ['Follow-up', 'next', THURSDAY_9],
      ['Last follow-up', 'later', null],
    ]);
  });

  it('shows a reply in sun and what the user answered', () => {
    const p = afterHello({ stage: 'talking', status: 'active', repliedAt: '2026-11-02T06:40:00.000Z', replyKind: 'interested', badge: 'sent' });
    ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'in', kind: 'inbound', subject: null, body: 'Timely.', at: '2026-11-02T06:40:00.000Z', externalId: 'a' });
    ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction: 'out', kind: 'reply', subject: null, body: 'Glad.', at: '2026-11-02T07:02:00.000Z', externalId: null });
    expect(personDetail(ctx, p.id).path.map((s) => [s.label, s.state])).toEqual([
      ['Hello', 'done'], ['Replied', 'sun'], ['You answered', 'done'],
    ]);
  });

  it('keeps the steps in the order they happened when they write again after the answer', () => {
    const p = afterHello({ stage: 'talking', status: 'waiting', repliedAt: '2026-11-02T08:15:00.000Z', replyKind: 'interested' });
    const msg = (direction: 'in' | 'out', kind: 'inbound' | 'reply', at: string) =>
      ctx.repo.insertMessage({ personId: p.id, channel: 'email', direction, kind, subject: null, body: 'x', at, externalId: direction === 'in' ? at : null });
    msg('in', 'inbound', '2026-11-02T06:40:00.000Z');
    msg('out', 'reply', '2026-11-02T07:02:00.000Z');
    msg('in', 'inbound', '2026-11-02T08:15:00.000Z');
    const path = personDetail(ctx, p.id).path;
    expect(path.map((s) => [s.label, s.at])).toEqual([
      ['Hello', FRIDAY_HELLO], ['Replied', '2026-11-02T06:40:00.000Z'], ['You answered', '2026-11-02T07:02:00.000Z'], ['Wrote back', '2026-11-02T08:15:00.000Z'],
    ]);
  });

  it('asks for your answer as the next step while someone waits', () => {
    const p = afterHello({ stage: 'talking', status: 'waiting', repliedAt: '2026-11-02T06:40:00.000Z', replyKind: 'interested' });
    expect(personDetail(ctx, p.id).path.at(-1)).toEqual({ label: 'Your answer', at: null, done: false, state: 'next' });
  });

  it('ends a stopped person on the stop, and a resting one on the rest', () => {
    const stopped = add({ name: 'Ruth Adeleke', email: 'r@palm.com', channel: 'email', stage: 'hello', touches: 1, status: 'stopped', replyKind: 'stop', repliedAt: '2026-11-02T09:00:00.000Z', lastTouchAt: FRIDAY_HELLO });
    expect(personDetail(ctx, stopped.id).path.map((s) => [s.label, s.state])).toEqual([['Hello', 'done'], ['Replied', 'sun'], ['Asked to stop', 'stop']]);
    const resting = add({ name: 'Mei Lin', xHandle: 'mei', channel: 'x', stage: 'following', touches: 3, status: 'resting', restUntil: '2027-02-03T08:00:00.000Z' });
    const path = personDetail(ctx, resting.id).path;
    expect(path.at(-1)).toMatchObject({ label: 'Resting', state: 'rest', at: '2027-02-03T08:00:00.000Z' });
    expect(path.filter((s) => s.state === 'done')).toHaveLength(3);
  });

  it('marks the next step held while on hold', () => {
    expect(personDetail(ctx, afterHello({ status: 'held' }).id).path.map((s) => s.state)).toEqual(['done', 'held', 'later']);
  });
});

describe('personDetail: what can be done', () => {
  it('explains why Nudge now is off before the first hello', () => {
    const p = add({ name: 'Kemi Eze', email: 'k@okopay.com', channel: 'email' });
    expect(personDetail(ctx, p.id).nudge).toEqual({ ok: false, reason: "Nudge now works after the first hello. Kemi's goes today at 11:00." });
  });

  it('allows a nudge after a hello and refuses it for someone who is talking or on hold', () => {
    expect(personDetail(ctx, afterHello().id).nudge).toEqual({ ok: true, reason: null });
    expect(personDetail(ctx, afterHello({ name: 'Ada N', email: 'a@n.com', stage: 'talking' }).id).nudge.reason).toBe(
      'Nudge now is for people Callum is still reaching. Ada already talks with you.',
    );
    expect(personDetail(ctx, afterHello({ name: 'Bisi A', email: 'b@a.com', status: 'held' }).id).nudge.reason).toBe('Resume Bisi to nudge.');
  });

  it('lists the other running projects with the reason a move is refused', () => {
    const second = ctx.repo.insertProject({ name: 'Payroll' });
    const wrapped = ctx.repo.insertProject({ name: 'Old' });
    ctx.repo.updateProject(wrapped.id, { state: 'wrapped' });
    const paused = ctx.repo.insertProject({ name: 'Paused one' });
    ctx.repo.updateProject(paused.id, { state: 'paused' });
    expect(personDetail(ctx, add({ email: 'c@m.com' }).id).projectMoves).toEqual([{ projectId: second.id, name: 'Payroll', reason: null }]);
    expect(personDetail(ctx, afterHello({ name: 'Ada N', email: 'a@n.com' }).id).projectMoves).toEqual([
      { projectId: second.id, name: 'Payroll', reason: "Ada has already heard from you about Reconciliation. Callum can move them once they're resting." },
    ]);
    const talking = afterHello({ name: 'Kemi Eze', email: 'k@o.com', stage: 'talking', status: 'waiting' });
    expect(personDetail(ctx, talking.id).projectMoves[0]?.reason).toBe('Kemi is talking with you about Reconciliation. Finish that conversation first.');
  });
});

describe('canSwitchAt', () => {
  it('waits a week after the last message, inside sending hours', () => {
    expect(canSwitchAt(ctx, afterHello())).toEqual({ at: new Date('2026-11-06T08:12:00.000Z'), inGap: true });
    expect(canSwitchAt(ctx, add({ email: 'x@y.com' }))).toEqual({ at: new Date(MONDAY), inGap: false });
  });
});

describe('moveTo', () => {
  it("answers a bad email with the plain sentence and changes nothing", () => {
    const p = afterHello({ email: null, channel: 'linkedin' });
    expect(() => moveTo(ctx, p.id, 'email', 'chidi at marina')).toThrow(new UserError("That doesn't look like an email address."));
    expect(ctx.repo.getPerson(p.id)).toMatchObject({ email: null, channel: 'linkedin' });
  });

  it('checks LinkedIn links and X handles too', () => {
    connect('x');
    const p = afterHello({ linkedinUrl: null, xHandle: null });
    expect(() => moveTo(ctx, p.id, 'linkedin', 'https://example.com/chidi')).toThrow("That doesn't look like a LinkedIn profile link.");
    expect(() => moveTo(ctx, p.id, 'x', 'not a handle!')).toThrow("That doesn't look like an X handle.");
  });

  it('keeps the new address and starts over on that channel a week after the last message', () => {
    const p = afterHello({ linkedinUrl: null, email: null, channel: 'email' });
    ctx.outbox.queueAuto(p.id, 'follow_up', 'Hi', 'Hello', new Date(THURSDAY_9), false);
    const moved = moveTo(ctx, p.id, 'linkedin', 'linkedin.com/in/Chidi-Okeke');
    expect(moved).toMatchObject({
      channel: 'linkedin', linkedinUrl: 'https://www.linkedin.com/in/chidi-okeke', touches: 0, stage: 'hello',
      nextTouchAt: '2026-11-06T08:12:00.000Z',
    });
    expect(ctx.repo.listOutbox({ personId: p.id, state: ['scheduled', 'awaiting_ok'] })).toEqual([]);
    expect(scopes).toEqual(expect.arrayContaining(['people', 'outbox']));
  });

  it('moves at once when there was no earlier message and the address is already known', () => {
    const p = add({ email: 'k@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/kemi', channel: 'email' });
    expect(moveTo(ctx, p.id, 'linkedin')).toMatchObject({ channel: 'linkedin', nextTouchAt: MONDAY });
  });

  it('asks for the address when there is none', () => {
    const p = afterHello({ linkedinUrl: null });
    expect(() => moveTo(ctx, p.id, 'linkedin')).toThrow(new UserError("Add Chidi's LinkedIn first"));
  });

  it('does not take an address that belongs to someone else', () => {
    add({ name: 'Ada Nwosu', email: 'ada@yaba.com' });
    const p = afterHello({ email: null, channel: 'linkedin' });
    expect(() => moveTo(ctx, p.id, 'email', 'ADA@yaba.com')).toThrow('Ada already has that address.');
  });

  it('refuses an address for the channel the person is already on', () => {
    const p = afterHello();
    expect(() => moveTo(ctx, p.id, 'email', 'other@marinaledger.com')).toThrow(new UserError('Chidi is already on email.'));
    expect(ctx.repo.getPerson(p.id)?.email).toBe('chidi@marinaledger.com');
  });

  it('refuses a channel that is not connected, and people who cannot move', () => {
    const p = afterHello();
    expect(() => moveTo(ctx, p.id, 'x', 'chidi')).toThrow("X isn't connected yet.");
    const talking = afterHello({ name: 'Kemi Eze', email: 'k@o.com', stage: 'talking', status: 'waiting' });
    expect(() => moveTo(ctx, talking.id, 'linkedin')).toThrow('Kemi is talking with you on email, so Callum keeps it there.');
    const stopped = afterHello({ name: 'Ruth A', email: 'r@o.com', status: 'stopped' });
    expect(() => moveTo(ctx, stopped.id, 'linkedin')).toThrow('Ruth asked not to be contacted.');
  });
});

describe('wakeEarly and restAgain', () => {
  function resting(): Person {
    return add({
      name: 'Mei Lin', xHandle: 'mei', email: null, channel: 'x', stage: 'following', touches: 3, status: 'resting',
      lastTouchAt: '2026-10-24T08:00:00.000Z', restUntil: '2027-02-03T08:00:00.000Z',
    });
  }

  it('starts a resting person again as a stranger and says what happens next', () => {
    connect('x');
    const mei = resting();
    const result = wakeEarly(ctx, mei.id);
    expect(result.undoUntil).toBe('2026-11-02T10:00:10.000Z');
    expect(result.next).toBe('First hello goes out today at 11:00 on X');
    expect(result.person).toMatchObject({ status: 'active', stage: 'stranger', touches: 0, restUntil: null });
    expect(scopes).toContain('people');
  });

  it('says the project is paused rather than promising a hello', () => {
    connect('x');
    ctx.repo.updateProject(project.id, { state: 'paused' });
    expect(wakeEarly(ctx, resting().id).next).toBe('Reconciliation is paused, so nothing goes to Mei yet');
  });

  it('says Start has not been pressed when it has not', () => {
    connect('x');
    ctx.repo.updateProject(project.id, { startedAt: null });
    expect(wakeEarly(ctx, resting().id).next).toBe('Callum starts on Mei once you press Start');
  });

  it('puts them back to rest exactly as they were within 10 seconds', () => {
    const mei = resting();
    wakeEarly(ctx, mei.id);
    clock.advance(9_000);
    const back = restAgain(ctx, mei.id);
    expect(back).toMatchObject({ status: 'resting', stage: 'following', touches: 3, restUntil: '2027-02-03T08:00:00.000Z' });
  });

  it('cancels a hello the runner lined up in the meantime', () => {
    const mei = resting();
    wakeEarly(ctx, mei.id);
    ctx.outbox.queueAuto(mei.id, 'hello', 'Hi Mei', null, new Date(MONDAY), false);
    restAgain(ctx, mei.id);
    expect(ctx.repo.listOutbox({ personId: mei.id, state: ['scheduled'] })).toEqual([]);
  });

  it('is too late after 10 seconds, and only once', () => {
    const mei = resting();
    wakeEarly(ctx, mei.id);
    clock.advance(10_001);
    expect(() => restAgain(ctx, mei.id)).toThrow(new UserError('Too late to undo.'));
    expect(ctx.repo.getPerson(mei.id)?.status).toBe('active');
    expect(() => restAgain(ctx, mei.id)).toThrow('Too late to undo.');
    expect(() => restAgain(ctx, 999)).toThrow('find that person');
  });

  it('cannot be undone once a hello has gone out, and nothing to undo is an error', () => {
    const mei = resting();
    expect(() => restAgain(ctx, mei.id)).toThrow('Too late to undo.');
    wakeEarly(ctx, mei.id);
    ctx.repo.updatePerson(mei.id, { touches: 1 });
    expect(() => restAgain(ctx, mei.id)).toThrow('Too late to undo.');
  });

  it('only wakes people who are resting', () => {
    expect(() => wakeEarly(ctx, add({ email: 'k@o.com' }).id)).toThrow("Chidi isn't resting.");
  });
});
