import { describe, expect, it } from 'vitest';
import type { Channel, MessageKind, Person } from '../../shared/types.js';
import { harness, type Harness } from '../runner/testing.test-helpers.js';
import { makeProject } from '../db/testing.test-helpers.js';
import { currentWeekStart, maybeSendWeekly, weeklyEmail, weeklyNote } from './weekly.js';
import { writeNoteSettings } from './noteSettings.js';

// Lagos is UTC+1 all year. Monday 2 November 8:30 there is 07:30 UTC.
const MONDAY_NOTE = '2026-11-02T07:30:00.000Z';
const WEEK_START = new Date('2026-10-26T07:30:00.000Z');

function out(h: Harness, personId: number, kind: MessageKind, at: string, channel: Channel = 'email'): void {
  h.ctx.repo.insertMessage({ personId, channel, direction: 'out', kind, subject: null, body: 'Hi', at, externalId: null });
}

/** A seeded week: 5 hellos, 3 replies (2 booked), a reply that said stop, two warming and two resting. */
function seedWeek(h: Harness): Record<string, Person> {
  const { repo } = h.ctx;
  const kemi = h.person({ name: 'Kemi Eze', company: 'Oko Pay', stage: 'talking', repliedAt: '2026-10-27T09:40:00.000Z', replyKind: 'interested' });
  const femi = h.person({ name: 'Femi Adeyemi', company: 'Eko Wallet', stage: 'talking', repliedAt: '2026-10-29T10:00:00.000Z', replyKind: 'interested' });
  const zainab = h.person({
    name: 'Zainab Musa', company: 'Lagoon Pay', status: 'waiting', repliedAt: '2026-10-28T16:00:00.000Z', replyKind: 'question', draft: 'Hi Zainab, happy to share pricing.',
  });
  const tunde = h.person({ name: 'Tunde Bello', status: 'stopped', repliedAt: '2026-10-28T12:00:00.000Z', replyKind: 'stop' });
  const chidi = h.person({ name: 'Chidi Okeke', channel: 'linkedin', stage: 'following', linkedinState: 'connected', touches: 2, nextTouchAt: '2026-11-03T10:00:00.000Z' });
  const ada = h.person({ name: 'Ada Nwosu', channel: 'linkedin', stage: 'following', linkedinState: 'connected', touches: 2 });
  const rest1 = h.person({ name: 'Rest One', status: 'resting', restUntil: '2026-11-16T09:00:00.000Z' });
  const rest2 = h.person({ name: 'Rest Two', status: 'resting', restUntil: '2026-11-20T09:00:00.000Z' });
  for (const p of [kemi, femi, zainab, tunde, chidi]) out(h, p.id, 'hello', '2026-10-26T09:12:00.000Z');
  // Said hello the week before: not part of this week's count.
  out(h, ada.id, 'invite', '2026-10-20T09:00:00.000Z', 'linkedin');
  out(h, kemi.id, 'booking', '2026-10-27T11:00:00.000Z');
  out(h, femi.id, 'booking', '2026-10-29T12:00:00.000Z');
  repo.updatePerson(chidi.id, {});
  return { kemi, femi, zainab, tunde, chidi, ada, rest1, rest2 };
}

describe('weeklyNote', () => {
  it('counts the week and says it in one line', () => {
    const h = harness({ now: MONDAY_NOTE });
    seedWeek(h);
    const note = weeklyNote(h.ctx, WEEK_START);
    expect(note.title).toBe('Last week, in people');
    expect(note.hellos).toBe(5);
    expect(note.line).toBe('Callum said hello to 5 people. 3 replied and 2 calls are booked.');
    expect(note.at).toBe(MONDAY_NOTE);
    expect(note.senderFirst).toBe('Ada');
    expect(note.nextAt).toBe('2026-11-09T07:30:00.000Z');
  });

  it('lists who replied, calls first, and never counts someone who said stop', () => {
    const h = harness({ now: MONDAY_NOTE });
    seedWeek(h);
    const { replied } = weeklyNote(h.ctx, WEEK_START);
    expect(replied.map((r) => [r.first, r.booked])).toEqual([['Femi', true], ['Kemi', true], ['Zainab', false]]);
    expect(replied[2]?.text).toBe('Zainab replied on Wednesday. Callum drafted a reply for you.');
    expect(replied[0]?.company).toBe('Eko Wallet');
  });

  it('suggests more people like the booked replier who answered last', () => {
    const h = harness({ now: MONDAY_NOTE });
    const people = seedWeek(h);
    const { suggestion } = weeklyNote(h.ctx, WEEK_START);
    expect(suggestion?.text).toBe("Femi's colleagues look like a good fit. Find 10 more like Femi?");
    expect(suggestion?.action).toEqual({
      kind: 'find_more', label: 'Find 10 more like Femi', args: { likePersonId: people.femi?.id, query: null, count: 10 },
    });
    expect(suggestion?.projectId).toBe(h.project.id);
  });

  it('suggests nothing when nobody booked', () => {
    const h = harness({ now: MONDAY_NOTE });
    const p = h.person({ name: 'Zainab Musa', status: 'waiting', repliedAt: '2026-10-28T16:00:00.000Z', replyKind: 'question' });
    out(h, p.id, 'hello', '2026-10-26T09:12:00.000Z');
    const note = weeklyNote(h.ctx, WEEK_START);
    expect(note.suggestion).toBeNull();
    expect(note.line).toBe('Callum said hello to 1 person. 1 replied and 0 calls are booked.');
  });

  it('shows who is warming up and who is resting', () => {
    const h = harness({ now: MONDAY_NOTE });
    seedWeek(h);
    const note = weeklyNote(h.ctx, WEEK_START);
    expect(note.warming.map((w) => w.first).sort()).toEqual(['Ada', 'Chidi']);
    expect(note.warming.find((w) => w.first === 'Chidi')?.text).toBe('Chidi accepted your LinkedIn invite. A follow-up goes out tomorrow at 11:00.');
    expect(note.resting).toEqual({ count: 2, backOn: '16 November' });
  });

  it('says so plainly when nobody has replied', () => {
    const h = harness({ now: MONDAY_NOTE });
    const p = h.person();
    out(h, p.id, 'hello', '2026-10-27T09:00:00.000Z');
    const note = weeklyNote(h.ctx, WEEK_START);
    expect(note.line).toBe('Callum said hello to 1 person. Nobody has replied yet.');
    expect(note.replied).toEqual([]);
    expect(note.resting).toEqual({ count: 0, backOn: null });
  });

  it('covers every project, grouped by project when there is more than one, with one suggestion', () => {
    const h = harness({ now: MONDAY_NOTE });
    seedWeek(h);
    expect(weeklyNote(h.ctx, WEEK_START).groups).toEqual([]);
    const payroll = makeProject(h.ctx.repo, { name: 'Payroll' });
    const yaw = h.ctx.repo.insertPerson({ projectId: payroll.id, name: 'Yaw Darko', source: 'csv', email: 'yaw@pay.com', channel: 'email', status: 'waiting', repliedAt: '2026-10-30T09:00:00.000Z', replyKind: 'interested' });
    out(h, yaw.id, 'hello', '2026-10-28T09:00:00.000Z');
    const note = weeklyNote(h.ctx, WEEK_START);
    expect(note.hellos).toBe(6);
    expect(note.replied).toHaveLength(4);
    expect(note.groups.map((g) => g.name)).toEqual(['Reconciliation', 'Payroll']);
    expect(note.groups[0]?.line).toBe('Callum said hello to 5 people. 3 replied and 2 calls are booked.');
    expect(note.groups[1]?.line).toBe('Callum said hello to 1 person. 1 replied and 0 calls are booked.');
    expect(note.groups[1]?.replied.map((r) => r.first)).toEqual(['Yaw']);
    expect(note.suggestion?.projectId).toBe(h.project.id);
  });

  it('keeps names that look like placeholders out of the note', () => {
    const h = harness({ now: MONDAY_NOTE });
    const p = h.person({ name: '{first_name} Eze', company: '[COMPANY]', status: 'waiting', repliedAt: '2026-10-28T16:00:00.000Z', replyKind: 'question' });
    out(h, p.id, 'hello', '2026-10-26T09:12:00.000Z');
    const email = weeklyEmail(weeklyNote(h.ctx, WEEK_START));
    expect(email.text).not.toMatch(/[[\]{}]/);
  });
});

describe('currentWeekStart', () => {
  it('is the Monday at 8:30 a week before the last note', () => {
    expect(currentWeekStart(new Date('2026-11-02T07:30:00.000Z'), 'Africa/Lagos').toISOString()).toBe('2026-10-26T07:30:00.000Z');
    // Monday 8:00 is still before the note: it is last week's.
    expect(currentWeekStart(new Date('2026-11-02T07:00:00.000Z'), 'Africa/Lagos').toISOString()).toBe('2026-10-19T07:30:00.000Z');
    expect(currentWeekStart(new Date('2026-11-05T12:00:00.000Z'), 'Africa/Lagos').toISOString()).toBe('2026-10-26T07:30:00.000Z');
  });
});

describe('weeklyEmail', () => {
  it('writes the plain-text version', () => {
    const h = harness({ now: MONDAY_NOTE });
    seedWeek(h);
    const mail = weeklyEmail(weeklyNote(h.ctx, WEEK_START));
    expect(mail.subject).toBe('Your week: 3 replies, 2 calls booked');
    expect(mail.text).toBe([
      'Morning Ada,',
      '',
      'Callum said hello to 5 people. 3 replied and 2 calls are booked.',
      '',
      'Femi Adeyemi, Eko Wallet. Calendar link sent.',
      'Kemi Eze, Oko Pay. Calendar link sent.',
      'Zainab Musa, Lagoon Pay. Callum drafted a reply for you.',
      '',
      'Warming up: Chidi and Ada accepted on LinkedIn.',
      '',
      'Resting: 2 people, back on 16 November.',
      '',
      "One idea: Femi's colleagues look like a good fit. Open Callum and ask it: Find 10 more like Femi.",
      '',
      'Callum sends this every Monday at 8:30 from your own address, so it never lands in spam. Change it in Your Callum.',
    ].join('\n'));
    expect(mail.text).not.toContain('!');
  });

  it('groups by project when there is more than one', () => {
    const h = harness({ now: MONDAY_NOTE });
    seedWeek(h);
    const payroll = makeProject(h.ctx.repo, { name: 'Payroll' });
    const yaw = h.ctx.repo.insertPerson({ projectId: payroll.id, name: 'Yaw Darko', source: 'csv', channel: 'email', status: 'waiting', repliedAt: '2026-10-30T09:00:00.000Z', replyKind: 'interested' });
    out(h, yaw.id, 'hello', '2026-10-28T09:00:00.000Z');
    const text = weeklyEmail(weeklyNote(h.ctx, WEEK_START)).text;
    expect(text).toContain('\nReconciliation\nCallum said hello to 5 people.');
    expect(text).toContain('\nPayroll\nCallum said hello to 1 person. 1 replied and 0 calls are booked.');
    expect(text.indexOf('Reconciliation')).toBeLessThan(text.indexOf('Payroll'));
    expect(text.match(/One idea/g)).toHaveLength(1);
  });

  it('has a different subject before anyone replies', () => {
    const h = harness({ now: MONDAY_NOTE });
    out(h, h.person().id, 'hello', '2026-10-27T09:00:00.000Z');
    expect(weeklyEmail(weeklyNote(h.ctx, WEEK_START)).subject).toBe('Your week: 1 hello, no replies yet');
  });
});

describe('maybeSendWeekly', () => {
  function ready(now = MONDAY_NOTE): Harness {
    const h = harness({ now });
    seedWeek(h);
    return h;
  }

  it('sends one weekly email to the user at Monday 8:30 and not twice', async () => {
    const h = ready();
    expect(await maybeSendWeekly(h.ctx)).toBe(true);
    expect(h.adapters.email.sent).toHaveLength(1);
    const mail = h.adapters.email.sent[0];
    expect(mail?.to.email).toBe('ada@example.com');
    expect(mail?.subject).toBe('Your week: 3 replies, 2 calls booked');
    expect(mail?.body).toContain('Callum said hello to 5 people.');
    expect(mail?.inReplyTo).toBeNull();

    expect(await maybeSendWeekly(h.ctx)).toBe(false);
    h.clock.advance(3 * 3_600_000);
    expect(await maybeSendWeekly(h.ctx)).toBe(false);
    expect(h.adapters.email.sent).toHaveLength(1);
  });

  it('sends once even when two ticks overlap', async () => {
    const h = ready();
    const [a, b] = await Promise.all([maybeSendWeekly(h.ctx), maybeSendWeekly(h.ctx)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(h.adapters.email.sent).toHaveLength(1);
  });

  it('waits for 8:30', async () => {
    const h = ready('2026-11-02T07:29:00.000Z');
    expect(await maybeSendWeekly(h.ctx)).toBe(false);
    h.clock.set(MONDAY_NOTE);
    expect(await maybeSendWeekly(h.ctx)).toBe(true);
  });

  it('sends late on the same Monday, but not on Tuesday', async () => {
    const late = ready('2026-11-02T20:00:00.000Z');
    expect(await maybeSendWeekly(late.ctx)).toBe(true);
    const tuesday = ready('2026-11-03T07:30:00.000Z');
    expect(await maybeSendWeekly(tuesday.ctx)).toBe(false);
    expect(tuesday.adapters.email.sent).toHaveLength(0);
  });

  it('sends again the next Monday', async () => {
    const h = ready();
    await maybeSendWeekly(h.ctx);
    h.clock.set('2026-11-09T07:30:00.000Z');
    const p = h.person({ name: 'New Person' });
    out(h, p.id, 'hello', '2026-11-04T09:00:00.000Z');
    expect(await maybeSendWeekly(h.ctx)).toBe(true);
    expect(h.adapters.email.sent).toHaveLength(2);
    expect(h.adapters.email.sent[1]?.subject).toBe('Your week: 1 hello, no replies yet');
  });

  it('stays quiet when email is not connected or the morning brief is off', async () => {
    const off = ready();
    writeNoteSettings(off.ctx, { morningBrief: false });
    expect(await maybeSendWeekly(off.ctx)).toBe(false);

    const noEmail = harness({ now: MONDAY_NOTE, connected: ['linkedin'] });
    seedWeek(noEmail);
    expect(await maybeSendWeekly(noEmail.ctx)).toBe(false);
    expect(noEmail.adapters.email.sent).toHaveLength(0);
  });

  it('sends nothing for a week with no hellos and no replies, and does not look again', async () => {
    const h = harness({ now: MONDAY_NOTE });
    expect(await maybeSendWeekly(h.ctx)).toBe(false);
    out(h, h.person().id, 'hello', '2026-10-27T09:00:00.000Z');
    expect(await maybeSendWeekly(h.ctx)).toBe(false);
    expect(h.adapters.email.sent).toHaveLength(0);
  });

  it('reports a failed send and tries again after half an hour', async () => {
    const h = ready();
    h.adapters.email.results.push({ ok: false, error: { code: 'temporary', message: 'The mail server is busy' } });
    await expect(maybeSendWeekly(h.ctx)).rejects.toThrow('The weekly note did not go out: The mail server is busy');
    expect(await maybeSendWeekly(h.ctx)).toBe(false);
    expect(h.adapters.email.sent).toHaveLength(1);
    h.clock.advance(31 * 60_000);
    expect(await maybeSendWeekly(h.ctx)).toBe(true);
    expect(h.adapters.email.sent).toHaveLength(2);
  });
});
