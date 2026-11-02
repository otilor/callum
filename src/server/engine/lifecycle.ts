// Person lifecycle: pure rules that turn a person plus an event into a patch.
// Nothing here reads the clock or mutates its input; callers apply the patches.
import type { Channel, Correction, OutKind, PathStep, Person, ReplyKind, Stage, SuggestedAction } from '../../shared/types.js';
import { addDays, addLocalDays, zonedTime } from './time.js';
import { nextLocalHour, nextSendingTime } from './windows.js';

export const MAX_TOUCHES = 3;
export const GAP_AFTER_TOUCH_1_DAYS = 4;
export const GAP_AFTER_TOUCH_2_DAYS = 6;
export const REST_AFTER_LAST_DAYS = 4;
export const REST_DAYS = 90;
export const INVITE_TIMEOUT_DAYS = 14;
export const LINKEDIN_FOLLOWUP_DAYS = 5;
export const LINKEDIN_THANKS_HOUR = 11;
export const CHANNEL_SWITCH_GAP_DAYS = 7;

const iso = (d: Date) => d.toISOString();
const ms = (s: string | null) => (s === null ? null : new Date(s).getTime());

/** The time zone to use for this person's sending hours. */
export function personTz(p: Person, userTz: string): string {
  return p.timezone ?? userTz;
}

/** The first connected channel (email, then LinkedIn, then X) that the person can be reached on. */
export function chooseChannel(p: Person, connected: Channel[]): Channel | null {
  if (connected.includes('email') && p.email) return 'email';
  if (connected.includes('linkedin') && p.linkedinUrl) return 'linkedin';
  if (connected.includes('x') && p.xHandle) return 'x';
  return null;
}

export function stageFor(touches: number): Stage {
  if (touches <= 0) return 'stranger';
  return touches === 1 ? 'hello' : 'following';
}

/** What Callum would send next on its own, or null when it has to wait or is finished. */
export function nextKind(p: Person): OutKind | null {
  if (p.stage === 'talking' || p.touches >= MAX_TOUCHES) return null;
  if (p.channel === 'email' || p.channel === 'x') return p.touches === 0 ? 'hello' : 'follow_up';
  if (p.channel === 'linkedin') {
    if (p.touches === 0) return 'invite';
    if (p.touches === 1 && p.linkedinState === 'connected') return 'thanks';
    if (p.touches === 2) return 'follow_up';
  }
  return null;
}

/** Patch after an outbound message went out. */
export function afterSent(p: Person, kind: OutKind, sentAt: Date, tz: string): Partial<Person> {
  if (kind === 'reply' || kind === 'booking' || kind === 'close') return afterUserSent(p, kind, sentAt);
  const touches = p.touches + 1;
  const patch: Partial<Person> = {
    touches,
    stage: stageFor(touches),
    lastTouchAt: iso(sentAt),
    nextTouchAt: null,
  };
  if (kind === 'invite') {
    patch.linkedinState = 'invited';
    patch.invitedAt = iso(sentAt);
  } else if (kind === 'hello') {
    patch.nextTouchAt = iso(addLocalDays(sentAt, GAP_AFTER_TOUCH_1_DAYS, tz));
  } else if (kind === 'thanks') {
    patch.nextTouchAt = iso(addLocalDays(sentAt, LINKEDIN_FOLLOWUP_DAYS, tz));
  } else if (touches < MAX_TOUCHES) {
    patch.nextTouchAt = iso(addLocalDays(sentAt, GAP_AFTER_TOUCH_2_DAYS, tz));
  }
  return patch;
}

/** Patch after the user sent a reply, a booking message or a closing note from the dock. */
export function afterUserSent(_p: Person, kind: 'reply' | 'booking' | 'close', _at: Date): Partial<Person> {
  if (kind === 'close') return { status: 'closed', draft: null, nextTouchAt: null };
  return { status: 'active', stage: 'talking', badge: kind === 'booking' ? 'booked' : 'sent', draft: null, nextTouchAt: null };
}

/** A LinkedIn invite was accepted: the thank-you goes out at the next 11:00 on a weekday. */
export function onAccepted(_p: Person, at: Date, tz: string): Partial<Person> {
  return { linkedinState: 'connected', nextTouchAt: iso(nextLocalHour(at, tz, LINKEDIN_THANKS_HOUR)) };
}

/** True when the person has had all their touches (or an unanswered invite) and should rest. */
export function restDue(p: Person, now: Date): boolean {
  if (p.status !== 'active' || p.stage === 'talking') return false;
  const last = ms(p.lastTouchAt);
  if (p.touches >= MAX_TOUCHES && last !== null) {
    return addDays(new Date(last), REST_AFTER_LAST_DAYS).getTime() <= now.getTime();
  }
  const invited = ms(p.invitedAt);
  if (p.linkedinState === 'invited' && invited !== null) {
    return addDays(new Date(invited), INVITE_TIMEOUT_DAYS).getTime() <= now.getTime();
  }
  return false;
}

export function rest(_p: Person, now: Date): Partial<Person> {
  return { status: 'resting', restUntil: iso(addDays(now, REST_DAYS)), nextTouchAt: null };
}

export function wake(_p: Person): Partial<Person> {
  return {
    status: 'active', stage: 'stranger', touches: 0, linkedinState: 'none', invitedAt: null,
    restUntil: null, nextTouchAt: null, badge: null,
  };
}

function validReturnDate(s: string | null): { y: number; m: number; d: number } | null {
  const match = s === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Patch and side effects for a classified inbound message. */
export function onInbound(
  p: Person,
  c: { kind: ReplyKind; suggested: SuggestedAction; returnDate: string | null },
  text: string,
  at: Date,
  tz: string,
): { patch: Partial<Person>; cancelPending: boolean; toDock: boolean } {
  if (c.kind === 'out_of_office') {
    const back = validReturnDate(c.returnDate);
    if (!back) return { patch: {}, cancelPending: false, toDock: false };
    const day9 = zonedTime(tz, back.y, back.m, back.d + 1, 9);
    const earliest = nextSendingTime(day9, tz);
    const current = ms(p.nextTouchAt);
    const next = current !== null && current > earliest.getTime() ? new Date(current) : earliest;
    return { patch: { nextTouchAt: iso(next) }, cancelPending: false, toDock: false };
  }
  const base: Partial<Person> = { replyKind: c.kind, lastInbound: text, repliedAt: iso(at), nextTouchAt: null };
  if (c.kind === 'stop') return { patch: { ...base, status: 'stopped' }, cancelPending: true, toDock: false };
  if (c.kind === 'hostile') return { patch: { ...base, status: 'closed' }, cancelPending: true, toDock: false };
  return { patch: { ...base, status: 'waiting', suggested: c.suggested }, cancelPending: true, toDock: true };
}

export function snooze(_p: Person, until: Date): Partial<Person> {
  return { status: 'snoozed', snoozedUntil: iso(until), nextTouchAt: null };
}

export function unsnooze(_p: Person): Partial<Person> {
  return { status: 'waiting', snoozedUntil: null };
}

export function hold(_p: Person): Partial<Person> {
  return { status: 'held' };
}

/** Back to work after a hold or pause; a touch that fell due in the meantime moves to the next sending time. */
export function resume(p: Person, now: Date, tz: string): Partial<Person> {
  const due = ms(p.nextTouchAt);
  if (due !== null && due < now.getTime()) return { status: 'active', nextTouchAt: iso(nextSendingTime(now, tz)) };
  return { status: 'active' };
}

/** Make the next touch due right now. */
export function nudge(_p: Person, now: Date): Partial<Person> {
  return { nextTouchAt: iso(now) };
}

/** The user said Callum read a reply wrongly. */
export function correct(p: Person, kind: Correction, now: Date, tz: string): Partial<Person> {
  if (kind === 'wrong_person') return { status: 'removed', nextTouchAt: null };
  if (kind === 'never_contact') return { status: 'stopped', nextTouchAt: null };
  const cleared: Partial<Person> = { status: 'active', replyKind: null, draft: null };
  if (nextKind(p) !== null) return { ...cleared, nextTouchAt: iso(nextSendingTime(now, tz)) };
  // An open LinkedIn invite is still waiting on the other person; the invite timeout will rest them.
  if (p.channel === 'linkedin' && p.linkedinState === 'invited') return { ...cleared, nextTouchAt: null };
  return { ...cleared, ...rest(p, now) };
}

/** Move to another channel and restart the sequence there, at least a week after the last touch. The stage stays as it is. */
export function switchChannel(p: Person, ch: Channel, now: Date, tz: string): Partial<Person> {
  const last = ms(p.lastTouchAt);
  const earliest = last === null ? now : new Date(Math.max(now.getTime(), addDays(new Date(last), CHANNEL_SWITCH_GAP_DAYS).getTime()));
  return { channel: ch, touches: 0, linkedinState: 'none', invitedAt: null, nextTouchAt: iso(nextSendingTime(earliest, tz)) };
}

/** The steps shown in the face popover, with when each happened or is due. */
export function touchPath(p: Person, _tz: string): PathStep[] {
  // `at` for the step just done is lastTouchAt and for the step coming up is nextTouchAt; others are unknown.
  const at = (index: number): string | null => {
    if (index === p.touches - 1) return p.lastTouchAt;
    if (index === p.touches) return p.nextTouchAt;
    return null;
  };
  if (p.channel === 'linkedin') {
    const accepted = p.linkedinState === 'connected' || p.touches >= 2;
    return [
      { label: 'Invite', at: p.touches >= 1 ? p.invitedAt ?? at(0) : at(0), done: p.touches >= 1 },
      { label: 'Accepted', at: null, done: accepted },
      { label: 'Thank-you', at: at(1), done: p.touches >= 2 },
      { label: 'Follow-up', at: at(2), done: p.touches >= 3 },
    ];
  }
  return [
    { label: 'Hello', at: at(0), done: p.touches >= 1 },
    { label: 'Follow-up', at: at(1), done: p.touches >= 2 },
    { label: 'Last follow-up', at: at(2), done: p.touches >= 3 },
  ];
}
