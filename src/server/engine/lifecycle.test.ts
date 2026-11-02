import { describe, expect, it } from 'vitest';
import type { Person } from '../../shared/types.js';
import { addDays, addLocalDays, zonedTime } from './time.js';
import {
  afterSent,
  afterUserSent,
  canMoveProject,
  chooseChannel,
  correct,
  hold,
  moveProject,
  nextKind,
  nextTouchTime,
  nudge,
  onAccepted,
  onInbound,
  personTz,
  resume,
  rest,
  restDue,
  snooze,
  stageFor,
  switchChannel,
  touchPath,
  unsnooze,
  wake,
} from './lifecycle.js';

const tz = 'Africa/Lagos';
// 2026-11-03 is a Tuesday.
const lagos = (day: number, hour: number, minute = 0) => zonedTime(tz, 2026, 11, day, hour, minute);

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: 1, projectId: 1, name: 'Kemi Eze', firstName: 'Kemi', company: 'Oko Pay', role: 'CFO',
    email: 'kemi@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/kemi-eze', xHandle: 'kemieze',
    timezone: null, channel: 'email', stage: 'stranger', status: 'active', touches: 0,
    lastTouchAt: null, nextTouchAt: null, linkedinState: 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null,
    draft: null, lastInbound: null, repliedAt: null, source: 'csv', note: null,
    createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('personTz', () => {
  it('uses the person time zone when set, else the user time zone', () => {
    expect(personTz(person({ timezone: 'America/New_York' }), tz)).toBe('America/New_York');
    expect(personTz(person(), tz)).toBe(tz);
  });
});

describe('chooseChannel', () => {
  it('prefers email, then linkedin, then x', () => {
    expect(chooseChannel(person(), ['x', 'linkedin', 'email'])).toBe('email');
    expect(chooseChannel(person(), ['x', 'linkedin'])).toBe('linkedin');
    expect(chooseChannel(person(), ['x'])).toBe('x');
  });
  it('skips channels that are not connected', () => {
    expect(chooseChannel(person(), ['linkedin'])).toBe('linkedin');
  });
  it('skips channels the person has no address for', () => {
    expect(chooseChannel(person({ email: null }), ['email', 'linkedin'])).toBe('linkedin');
    expect(chooseChannel(person({ email: null, linkedinUrl: null }), ['email', 'linkedin', 'x'])).toBe('x');
  });
  it('returns null when nothing fits', () => {
    expect(chooseChannel(person({ email: null, linkedinUrl: null, xHandle: null }), ['email', 'linkedin', 'x'])).toBeNull();
    expect(chooseChannel(person(), [])).toBeNull();
  });
});

describe('stageFor', () => {
  it('maps touch counts to stages', () => {
    expect([0, 1, 2, 3].map(stageFor)).toEqual(['stranger', 'hello', 'following', 'following']);
  });
});

describe('nextKind', () => {
  it('email and x: hello, then two follow-ups, then nothing', () => {
    for (const channel of ['email', 'x'] as const) {
      const kinds = [0, 1, 2, 3].map((touches) => nextKind(person({ channel, touches })));
      expect(kinds).toEqual(['hello', 'follow_up', 'follow_up', null]);
    }
  });
  it('linkedin: someone already connected gets a hello, not an invitation, and then follow-ups, not a thank-you', () => {
    expect(nextKind(person({ channel: 'linkedin', touches: 0, linkedinState: 'connected' }))).toBe('hello');
    expect(nextKind(person({ channel: 'linkedin', touches: 1, linkedinState: 'connected' }))).toBe('follow_up');
    expect(nextKind(person({ channel: 'linkedin', touches: 2, linkedinState: 'connected' }))).toBe('follow_up');
    expect(nextKind(person({ channel: 'linkedin', touches: 3, linkedinState: 'connected' }))).toBeNull();
  });
  it('linkedin: invite, wait for acceptance, thanks, follow-up', () => {
    expect(nextKind(person({ channel: 'linkedin', touches: 0 }))).toBe('invite');
    expect(nextKind(person({ channel: 'linkedin', touches: 1, linkedinState: 'invited' }))).toBeNull();
    expect(nextKind(person({ channel: 'linkedin', touches: 1, linkedinState: 'connected', invitedAt: '2026-11-01T10:00:00.000Z' }))).toBe('thanks');
    expect(nextKind(person({ channel: 'linkedin', touches: 2, linkedinState: 'connected' }))).toBe('follow_up');
    expect(nextKind(person({ channel: 'linkedin', touches: 3, linkedinState: 'connected' }))).toBeNull();
  });
  it('is null without a channel and for people already talking', () => {
    expect(nextKind(person({ channel: null }))).toBeNull();
    expect(nextKind(person({ touches: 1, stage: 'talking' }))).toBeNull();
  });
});

describe('afterSent', () => {
  const sentAt = lagos(3, 10); // Tuesday 10:00

  it('hello: first touch, next touch exactly 4 local days later', () => {
    const patch = afterSent(person(), 'hello', sentAt, tz);
    expect(patch.touches).toBe(1);
    expect(patch.stage).toBe('hello');
    expect(patch.lastTouchAt).toBe(sentAt.toISOString());
    expect(patch.nextTouchAt).toBe(addLocalDays(sentAt, 4, tz).toISOString());
  });
  it('first follow-up: second touch, next touch 6 days later', () => {
    const patch = afterSent(person({ touches: 1 }), 'follow_up', sentAt, tz);
    expect(patch.touches).toBe(2);
    expect(patch.stage).toBe('following');
    expect(patch.nextTouchAt).toBe(addLocalDays(sentAt, 6, tz).toISOString());
  });
  it('last follow-up: third touch, nothing scheduled and no rest date yet', () => {
    const patch = afterSent(person({ touches: 2 }), 'follow_up', sentAt, tz);
    expect(patch.touches).toBe(3);
    expect(patch.stage).toBe('following');
    expect(patch.nextTouchAt).toBeNull();
    expect(patch.restUntil).toBeUndefined();
    expect(patch.lastTouchAt).toBe(sentAt.toISOString());
  });
  it('keeps a higher stage the person already has', () => {
    expect(afterSent(person({ stage: 'following' }), 'hello', sentAt, tz).stage).toBe('following');
    expect(afterSent(person({ stage: 'hello', touches: 1 }), 'follow_up', sentAt, tz).stage).toBe('following');
    expect(afterSent(person({ stage: 'talking', touches: 1 }), 'follow_up', sentAt, tz).stage).toBe('talking');
  });
  it('invite: marks the invite as sent and waits for acceptance', () => {
    const patch = afterSent(person({ channel: 'linkedin' }), 'invite', sentAt, tz);
    expect(patch.touches).toBe(1);
    expect(patch.stage).toBe('hello');
    expect(patch.linkedinState).toBe('invited');
    expect(patch.invitedAt).toBe(sentAt.toISOString());
    expect(patch.nextTouchAt).toBeNull();
  });
  it('thanks: second touch, follow-up 5 local days later', () => {
    const patch = afterSent(person({ channel: 'linkedin', touches: 1, linkedinState: 'connected' }), 'thanks', sentAt, tz);
    expect(patch.touches).toBe(2);
    expect(patch.stage).toBe('following');
    expect(patch.nextTouchAt).toBe(addLocalDays(sentAt, 5, tz).toISOString());
  });
  it('linkedin follow-up after the thank-you is the last touch', () => {
    const patch = afterSent(person({ channel: 'linkedin', touches: 2, linkedinState: 'connected' }), 'follow_up', sentAt, tz);
    expect(patch.touches).toBe(3);
    expect(patch.nextTouchAt).toBeNull();
  });
  it('user kinds delegate to afterUserSent', () => {
    expect(afterSent(person({ touches: 1 }), 'reply', sentAt, tz)).toEqual(afterUserSent(person({ touches: 1 }), 'reply', sentAt));
    expect(afterSent(person(), 'close', sentAt, tz)).toEqual(afterUserSent(person(), 'close', sentAt));
  });
  it('does not mutate the person', () => {
    const p = person();
    afterSent(p, 'hello', sentAt, tz);
    expect(p).toEqual(person());
  });
});

describe('afterUserSent', () => {
  const at = lagos(4, 11);
  it('reply: talking, badge sent, draft cleared', () => {
    const p = person({ status: 'waiting', draft: 'Hi Kemi', nextTouchAt: lagos(5, 9).toISOString() });
    expect(afterUserSent(p, 'reply', at)).toEqual({ status: 'active', stage: 'talking', badge: 'sent', draft: null, nextTouchAt: null });
  });
  it('booking: talking, badge booked', () => {
    expect(afterUserSent(person({ status: 'waiting' }), 'booking', at)).toEqual({ status: 'active', stage: 'talking', badge: 'booked', draft: null, nextTouchAt: null });
  });
  it('close: closed, draft cleared', () => {
    expect(afterUserSent(person({ status: 'waiting', draft: 'x' }), 'close', at)).toEqual({ status: 'closed', draft: null, nextTouchAt: null });
  });
});

describe('onAccepted', () => {
  it('connects and schedules the thank-you for the next weekday at 11:00 local', () => {
    const patch = onAccepted(person({ channel: 'linkedin', touches: 1, linkedinState: 'invited' }), lagos(3, 12), tz);
    expect(patch.linkedinState).toBe('connected');
    expect(patch.nextTouchAt).toBe(lagos(4, 11).toISOString());
  });
  it('skips the weekend', () => {
    const patch = onAccepted(person({ channel: 'linkedin' }), lagos(6, 15), tz); // Friday 15:00
    expect(patch.nextTouchAt).toBe(lagos(9, 11).toISOString());
  });
});

describe('restDue and rest', () => {
  const third = lagos(3, 10);
  const done = person({ touches: 3, stage: 'following', lastTouchAt: third.toISOString() });

  it('is due exactly 4 days after the third touch, not at 3 days 23 hours', () => {
    expect(restDue(done, addDays(third, 4))).toBe(true);
    expect(restDue(done, new Date(addDays(third, 4).getTime() - 3_600_000))).toBe(false);
    expect(restDue(done, addDays(third, 3))).toBe(false);
  });
  it('is not due before the third touch, or for people who are not active', () => {
    expect(restDue(person({ touches: 2, lastTouchAt: third.toISOString() }), addDays(third, 10))).toBe(false);
    expect(restDue({ ...done, status: 'waiting' }, addDays(third, 10))).toBe(false);
    expect(restDue({ ...done, status: 'held' }, addDays(third, 10))).toBe(false);
    expect(restDue({ ...done, stage: 'talking' }, addDays(third, 10))).toBe(false);
  });
  it('times out an unaccepted invite at 14 days', () => {
    const invited = person({ channel: 'linkedin', touches: 1, linkedinState: 'invited', invitedAt: third.toISOString(), lastTouchAt: third.toISOString() });
    expect(restDue(invited, addDays(third, 14))).toBe(true);
    expect(restDue(invited, new Date(addDays(third, 14).getTime() - 1))).toBe(false);
    expect(restDue({ ...invited, linkedinState: 'connected' }, addDays(third, 30))).toBe(false);
  });
  it('rest: resting for 90 days with nothing scheduled', () => {
    const now = lagos(10, 9);
    expect(rest(done, now)).toEqual({ status: 'resting', restUntil: addDays(now, 90).toISOString(), nextTouchAt: null });
  });
  it('wake: starts over', () => {
    const p = person({ status: 'resting', stage: 'following', touches: 3, linkedinState: 'invited', invitedAt: third.toISOString(), restUntil: third.toISOString(), badge: 'sent' });
    expect(wake(p)).toMatchObject({ status: 'active', stage: 'stranger', touches: 0, linkedinState: 'none', invitedAt: null, restUntil: null, nextTouchAt: null, badge: null });
  });
});

describe('onInbound', () => {
  const at = lagos(4, 10);
  const base = { kind: 'interested', suggested: 'reply', returnDate: null } as const;

  it('stop: stopped and pending sends cancelled, nothing on the dock', () => {
    const r = onInbound(person({ touches: 1 }), { ...base, kind: 'stop', suggested: 'close' }, 'Please take me off your list.', at, tz);
    expect(r.patch.status).toBe('stopped');
    expect(r.patch.nextTouchAt).toBeNull();
    expect(r.cancelPending).toBe(true);
    expect(r.toDock).toBe(false);
  });
  it('hostile: closed, cancelled, not on the dock', () => {
    const r = onInbound(person({ touches: 1 }), { ...base, kind: 'hostile', suggested: 'close' }, 'Go away', at, tz);
    expect(r.patch.status).toBe('closed');
    expect(r.cancelPending).toBe(true);
    expect(r.toDock).toBe(false);
  });
  it('interested: waiting, on the dock, pending cancelled, reply recorded', () => {
    const r = onInbound(person({ touches: 1, nextTouchAt: lagos(7, 10).toISOString() }), base, 'Tell me more', at, tz);
    expect(r.patch).toMatchObject({
      status: 'waiting', replyKind: 'interested', suggested: 'reply', lastInbound: 'Tell me more',
      repliedAt: at.toISOString(), nextTouchAt: null,
    });
    expect(r.toDock).toBe(true);
    expect(r.cancelPending).toBe(true);
  });
  it('referral and not_now are treated as ordinary replies', () => {
    for (const kind of ['referral', 'not_now', 'not_interested', 'question'] as const) {
      const r = onInbound(person(), { kind, suggested: 'snooze', returnDate: null }, 'text', at, tz);
      expect(r.patch.status).toBe('waiting');
      expect(r.patch.replyKind).toBe(kind);
      expect(r.patch.suggested).toBe('snooze');
      expect(r.toDock).toBe(true);
    }
  });
  it('out of office with a return date: off the dock, next touch after the return', () => {
    const current = lagos(5, 10);
    const r = onInbound(person({ touches: 1, nextTouchAt: current.toISOString() }), { kind: 'out_of_office', suggested: 'snooze', returnDate: '2026-11-20' }, 'Away', at, tz);
    expect(r.toDock).toBe(false);
    expect(r.cancelPending).toBe(false);
    expect(r.patch.status).toBeUndefined();
    expect(new Date(r.patch.nextTouchAt ?? '').getTime()).toBeGreaterThanOrEqual(lagos(21, 9).getTime());
    // 21 November is a Saturday, so the first sending slot is Monday 23rd at 9:00.
    expect(r.patch.nextTouchAt).toBe(lagos(23, 9).toISOString());
  });
  it('out of office never moves the next touch earlier', () => {
    const later = lagos(30, 10);
    const r = onInbound(person({ nextTouchAt: later.toISOString() }), { kind: 'out_of_office', suggested: 'snooze', returnDate: '2026-11-09' }, 'Away', at, tz);
    expect(r.patch.nextTouchAt).toBe(later.toISOString());
  });
  it('out of office changes nothing when there is no scheduled touch or nothing left to send', () => {
    const oo = { kind: 'out_of_office', suggested: 'snooze', returnDate: '2026-11-20' } as const;
    expect(onInbound(person({ touches: 1, nextTouchAt: null }), oo, 'Away', at, tz).patch).toEqual({});
    const invited = person({ channel: 'linkedin', touches: 1, linkedinState: 'invited', nextTouchAt: lagos(7, 10).toISOString() });
    expect(onInbound(invited, oo, 'Away', at, tz).patch).toEqual({});
    expect(onInbound(person({ touches: 3, nextTouchAt: lagos(7, 10).toISOString() }), oo, 'Away', at, tz).patch).toEqual({});
  });
  it('out of office without a return date changes nothing', () => {
    const r = onInbound(person({ nextTouchAt: lagos(7, 10).toISOString() }), { kind: 'out_of_office', suggested: 'snooze', returnDate: null }, 'Away', at, tz);
    expect(r.patch).toEqual({});
    expect(r.toDock).toBe(false);
    expect(r.cancelPending).toBe(false);
  });
  it('out of office ignores a malformed return date', () => {
    const r = onInbound(person(), { kind: 'out_of_office', suggested: 'snooze', returnDate: 'next week' }, 'Away', at, tz);
    expect(r.patch).toEqual({});
  });
});

describe('snooze, hold, resume, nudge, unsnooze', () => {
  const now = lagos(4, 10);
  it('snooze', () => {
    const until = lagos(20, 9);
    expect(snooze(person({ status: 'waiting' }), until)).toEqual({ status: 'snoozed', snoozedUntil: until.toISOString(), nextTouchAt: null });
  });
  it('unsnooze goes back to the dock', () => {
    expect(unsnooze(person({ status: 'snoozed', snoozedUntil: now.toISOString() }))).toEqual({ status: 'waiting', snoozedUntil: null });
  });
  it('hold', () => {
    expect(hold(person())).toEqual({ status: 'held' });
  });
  it('resume moves an overdue touch to the next sending time', () => {
    const overdue = lagos(2, 10).toISOString();
    const patch = resume(person({ status: 'held', touches: 1, nextTouchAt: overdue }), lagos(7, 12), tz); // Saturday
    expect(patch.status).toBe('active');
    expect(patch.nextTouchAt).toBe(lagos(9, 9).toISOString());
  });
  it('resume respects the gap after the last touch', () => {
    const last = lagos(6, 10); // Friday
    const overdue = lagos(7, 10).toISOString();
    const p = person({ status: 'held', touches: 1, lastTouchAt: last.toISOString(), nextTouchAt: overdue });
    // The 4-day gap ends Tuesday 10:00, after the overdue time but before the next Wednesday we resume on.
    expect(resume(p, lagos(9, 12), tz).nextTouchAt).toBe(lagos(10, 10).toISOString());
  });
  it('resume keeps a touch that is still in the future', () => {
    const future = lagos(9, 10).toISOString();
    const patch = resume(person({ status: 'held', touches: 1, nextTouchAt: future }), now, tz);
    expect(patch).toEqual({ status: 'active' });
  });
  it('nudge makes the next touch due now', () => {
    expect(nudge(person({ touches: 1, nextTouchAt: lagos(9, 10).toISOString() }), now)).toEqual({ nextTouchAt: now.toISOString() });
  });
});

describe('correct', () => {
  const now = lagos(4, 10);
  it('auto_reply with touches left: active again, scheduled after the gap, reply fields cleared', () => {
    const p = person({
      status: 'waiting', touches: 1, stage: 'hello', replyKind: 'interested', suggested: 'reply', draft: 'Hi',
      lastInbound: 'Out of office', repliedAt: now.toISOString(), lastTouchAt: lagos(3, 10).toISOString(),
    });
    const patch = correct(p, 'auto_reply', now, tz);
    expect(patch).toMatchObject({ status: 'active', replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null });
    // Hello went out Tuesday 10:00; 4 days later is Saturday, so the follow-up waits for Monday 9:00.
    expect(patch.nextTouchAt).toBe(lagos(9, 9).toISOString());
  });
  it('auto_reply schedules now when the gap has already passed', () => {
    const patch = correct(person({ status: 'waiting', touches: 1, lastTouchAt: zonedTime(tz, 2026, 10, 28, 10).toISOString() }), 'auto_reply', now, tz);
    expect(patch.nextTouchAt).toBe(now.toISOString());
  });
  it('auto_reply outside sending hours waits for the next one', () => {
    const patch = correct(person({ status: 'waiting', touches: 1 }), 'auto_reply', lagos(7, 12), tz);
    expect(patch.nextTouchAt).toBe(lagos(9, 9).toISOString());
  });
  it('auto_reply with no touches left: active with nothing scheduled, not rested', () => {
    const patch = correct(person({ status: 'waiting', touches: 3, stage: 'following', replyKind: 'interested' }), 'auto_reply', now, tz);
    expect(patch.status).toBe('active');
    expect(patch.nextTouchAt).toBeNull();
    expect(patch.restUntil).toBeUndefined();
    expect(patch.replyKind).toBeNull();
    expect(patch.draft).toBeNull();
  });
  it('auto_reply while a LinkedIn invite is still open keeps waiting for acceptance', () => {
    const patch = correct(person({ status: 'waiting', channel: 'linkedin', touches: 1, linkedinState: 'invited' }), 'auto_reply', now, tz);
    expect(patch.status).toBe('active');
    expect(patch.nextTouchAt).toBeNull();
  });
  it('auto_reply for someone already talking never puts them back on the automatic path', () => {
    const p = person({ status: 'waiting', touches: 3, stage: 'talking', badge: 'sent', replyKind: 'interested', suggested: 'reply', draft: 'x', lastInbound: 'hi', repliedAt: now.toISOString() });
    expect(correct(p, 'auto_reply', now, tz)).toEqual({
      status: 'active', replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, nextTouchAt: null,
    });
    const early = { ...p, touches: 1 };
    expect(correct(early, 'auto_reply', now, tz).nextTouchAt).toBeNull();
  });
  it('wrong_person removes, never_contact stops', () => {
    expect(correct(person({ status: 'waiting' }), 'wrong_person', now, tz).status).toBe('removed');
    expect(correct(person({ status: 'waiting' }), 'never_contact', now, tz).status).toBe('stopped');
    expect(correct(person({ status: 'waiting' }), 'never_contact', now, tz).nextTouchAt).toBeNull();
  });
});

describe('switchChannel', () => {
  it('respects the 7-day gap from the last touch', () => {
    const last = lagos(3, 10); // Tuesday
    const patch = switchChannel(person({ touches: 1, lastTouchAt: last.toISOString(), linkedinState: 'invited' }), 'x', lagos(4, 10), tz);
    expect(patch.channel).toBe('x');
    expect(patch.linkedinState).toBe('none');
    expect(patch.nextTouchAt).toBe(addDays(last, 7).toISOString()); // next Tuesday 10:00 is a sending time
    expect(patch.touches).toBe(0);
    expect(patch.invitedAt).toBeNull();
    expect(patch.stage).toBeUndefined();
    expect(patch.lastTouchAt).toBeUndefined();
  });
  it('restarts the sequence on the new channel', () => {
    const now = lagos(20, 10);
    const fromEmail = person({ touches: 1, stage: 'hello', lastTouchAt: lagos(3, 10).toISOString() });
    const toLinkedin = { ...fromEmail, ...switchChannel(fromEmail, 'linkedin', now, tz) };
    expect(nextKind(toLinkedin)).toBe('invite');
    const fromLinkedin = person({ channel: 'linkedin', touches: 2, stage: 'following', linkedinState: 'connected', lastTouchAt: lagos(3, 10).toISOString() });
    const toEmail = { ...fromLinkedin, ...switchChannel(fromLinkedin, 'email', now, tz) };
    expect(toEmail.stage).toBe('following');
    expect(nextKind(toEmail)).toBe('hello');
  });
  it('lands on the next sending time when the gap ends off-hours', () => {
    const last = lagos(3, 18); // Tuesday 18:00, gap ends Tuesday 18:00
    const patch = switchChannel(person({ touches: 1, lastTouchAt: last.toISOString() }), 'email', lagos(4, 10), tz);
    expect(patch.nextTouchAt).toBe(lagos(11, 9).toISOString());
  });
  it('uses now when the last touch is long ago, or there was none', () => {
    const now = lagos(20, 10);
    expect(switchChannel(person({ touches: 1, lastTouchAt: lagos(3, 10).toISOString() }), 'x', now, tz).nextTouchAt).toBe(now.toISOString());
    expect(switchChannel(person(), 'linkedin', now, tz).nextTouchAt).toBe(now.toISOString());
  });
});

describe('touchPath', () => {
  it('email: hello, follow-up, last follow-up', () => {
    const path = touchPath(person(), tz);
    expect(path.map((s) => s.label)).toEqual(['Hello', 'Follow-up', 'Last follow-up']);
    expect(path.map((s) => s.done)).toEqual([false, false, false]);
  });
  it('email after the first hello: first step done with its time, next step scheduled', () => {
    const last = lagos(3, 10);
    const next = lagos(7, 10);
    const path = touchPath(person({ touches: 1, lastTouchAt: last.toISOString(), nextTouchAt: next.toISOString() }), tz);
    expect(path).toEqual([
      { label: 'Hello', at: last.toISOString(), done: true },
      { label: 'Follow-up', at: next.toISOString(), done: false },
      { label: 'Last follow-up', at: null, done: false },
    ]);
  });
  it('linkedin has four steps and Invite is done after the invite', () => {
    const sent = lagos(3, 10);
    const path = touchPath(person({ channel: 'linkedin', touches: 1, linkedinState: 'invited', invitedAt: sent.toISOString(), lastTouchAt: sent.toISOString() }), tz);
    expect(path.map((s) => s.label)).toEqual(['Invite', 'Accepted', 'Thank-you', 'Follow-up']);
    expect(path.map((s) => s.done)).toEqual([true, false, false, false]);
    expect(path[0]?.at).toBe(sent.toISOString());
  });
  it('linkedin accepted: thank-you scheduled', () => {
    const next = lagos(4, 11);
    const path = touchPath(person({ channel: 'linkedin', touches: 1, linkedinState: 'connected', invitedAt: lagos(2, 10).toISOString(), lastTouchAt: lagos(2, 10).toISOString(), nextTouchAt: next.toISOString() }), tz);
    expect(path.map((s) => s.done)).toEqual([true, true, false, false]);
    expect(path[2]).toEqual({ label: 'Thank-you', at: next.toISOString(), done: false });
  });
});

describe('nextTouchTime', () => {
  const now = lagos(10, 10); // Tuesday 10:00
  it('is null when there is nothing to send automatically', () => {
    expect(nextTouchTime(person({ touches: 3 }), now, tz)).toBeNull();
    expect(nextTouchTime(person({ channel: 'linkedin', touches: 1, linkedinState: 'invited' }), now, tz)).toBeNull();
    expect(nextTouchTime(person({ touches: 1, stage: 'talking' }), now, tz)).toBeNull();
  });
  it('first hello and invite go at the next sending time', () => {
    expect(nextTouchTime(person(), now, tz)?.toISOString()).toBe(now.toISOString());
    expect(nextTouchTime(person({ channel: 'linkedin' }), lagos(7, 12), tz)?.toISOString()).toBe(lagos(9, 9).toISOString());
  });
  it('waits 4 local days after touch 1 and 6 after touch 2', () => {
    const last = lagos(3, 10);
    expect(nextTouchTime(person({ touches: 1, lastTouchAt: last.toISOString() }), lagos(4, 10), tz)?.toISOString()).toBe(lagos(9, 9).toISOString());
    expect(nextTouchTime(person({ touches: 2, lastTouchAt: last.toISOString() }), lagos(4, 10), tz)?.toISOString()).toBe(lagos(9, 10).toISOString());
    expect(nextTouchTime(person({ touches: 2, lastTouchAt: lagos(2, 10).toISOString() }), lagos(3, 10), tz)?.toISOString()).toBe(lagos(9, 9).toISOString());
    expect(nextTouchTime(person({ touches: 2, lastTouchAt: lagos(10, 10).toISOString() }), lagos(11, 10), tz)?.toISOString()).toBe(lagos(16, 10).toISOString());
  });
  it('linkedin: thank-you at the next 11:00 weekday, follow-up 5 days after it', () => {
    const connected = person({ channel: 'linkedin', touches: 1, linkedinState: 'connected', invitedAt: lagos(2, 10).toISOString() });
    expect(nextTouchTime(connected, lagos(6, 15), tz)?.toISOString()).toBe(lagos(9, 11).toISOString());
    const thanked = { ...connected, touches: 2, lastTouchAt: lagos(4, 11).toISOString() };
    expect(nextTouchTime(thanked, lagos(5, 10), tz)?.toISOString()).toBe(lagos(9, 11).toISOString());
    expect(nextTouchTime({ ...thanked, lastTouchAt: lagos(10, 11).toISOString() }, lagos(11, 10), tz)?.toISOString()).toBe(lagos(16, 9).toISOString()); // day 5 is a Sunday
  });
});

describe('canMoveProject', () => {
  it('lets strangers who have not heard from us move, active or held', () => {
    expect(canMoveProject(person())).toEqual({ ok: true });
    expect(canMoveProject(person({ status: 'held' }))).toEqual({ ok: true });
  });
  it('lets resting people move', () => {
    const resting = person({ status: 'resting', stage: 'following', touches: 3, restUntil: '2027-02-01T09:00:00.000Z' });
    expect(canMoveProject(resting)).toEqual({ ok: true });
  });
  it('says why people in a conversation cannot move', () => {
    expect(canMoveProject(person({ stage: 'talking', status: 'active', touches: 2 }))).toEqual({ ok: false, reason: 'talking' });
    expect(canMoveProject(person({ stage: 'talking', status: 'waiting', touches: 2 }))).toEqual({ ok: false, reason: 'talking' });
    expect(canMoveProject(person({ stage: 'hello', status: 'waiting', touches: 1 }))).toEqual({ ok: false, reason: 'waiting' });
    expect(canMoveProject(person({ stage: 'hello', status: 'snoozed', touches: 1 }))).toEqual({ ok: false, reason: 'waiting' });
  });
  it('says people mid-sequence are in progress, including a held one', () => {
    expect(canMoveProject(person({ stage: 'hello', touches: 1 }))).toEqual({ ok: false, reason: 'in_progress' });
    expect(canMoveProject(person({ stage: 'following', touches: 2 }))).toEqual({ ok: false, reason: 'in_progress' });
    expect(canMoveProject(person({ stage: 'hello', touches: 1, status: 'held' }))).toEqual({ ok: false, reason: 'in_progress' });
    expect(canMoveProject(person({ channel: 'linkedin', linkedinState: 'invited', touches: 1, stage: 'hello' }))).toEqual({ ok: false, reason: 'in_progress' });
  });
  it('never moves people who stopped or were closed or removed', () => {
    expect(canMoveProject(person({ status: 'stopped' }))).toEqual({ ok: false, reason: 'stopped' });
    expect(canMoveProject(person({ status: 'closed', stage: 'talking' }))).toEqual({ ok: false, reason: 'closed' });
    expect(canMoveProject(person({ status: 'removed' }))).toEqual({ ok: false, reason: 'closed' });
  });
});

describe('moveProject', () => {
  it('sets the project and clears the next touch of a stranger', () => {
    const p = person({ nextTouchAt: lagos(4, 9).toISOString() });
    expect(moveProject(p, 2)).toEqual({ projectId: 2, nextTouchAt: null });
  });
  it('keeps the wake-up date of a resting person', () => {
    const p = person({ status: 'resting', stage: 'following', touches: 3, restUntil: '2027-02-01T09:00:00.000Z' });
    const patch = moveProject(p, 3);
    expect(patch).toEqual({ projectId: 3 });
    expect(patch).not.toHaveProperty('restUntil');
  });
  it('does not change its input', () => {
    const p = person({ nextTouchAt: lagos(4, 9).toISOString() });
    const before = { ...p };
    moveProject(p, 2);
    expect(p).toEqual(before);
  });
});
