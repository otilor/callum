import type { Channel, ChannelAccount, Incident, NewIncident, OutboxItem, Person } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { addLocalDays, localParts, startOfLocalDay } from '../engine/time.js';
import { chooseChannel, personTz, switchChannel } from '../engine/lifecycle.js';
import { nextMonday } from '../engine/windows.js';

const DAY_MS = 86_400_000;
const CHANNEL_NAME: Record<Channel, string> = { email: 'email', linkedin: 'LinkedIn', x: 'X' };

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const waiting = (n: number, noun: string): string =>
  n === 0 ? `No ${noun}s are waiting` : `${n} ${plural(n, `${noun} is`, `${noun}s are`)} waiting`;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Wednesday at 9:00": an exact time in the user's words and zone. */
export function formatSlot(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${WEEKDAYS[p.weekday]} at ${p.hour}:${String(p.minute).padStart(2, '0')}`;
}

/** What each incident says, in the design's words. */
export const INCIDENT_COPY = {
  linkedin_check: "LinkedIn asked to check it's you, so Callum paused LinkedIn to keep your account safe. Email and X keep going.",
  linkedin_weekly_limit: "LinkedIn's weekly invite limit is reached. New invites wait until Monday. Messages to your connections keep going.",
  x_limit: "X stopped accepting Callum's messages because your X plan's daily limit is reached. DMs resume tomorrow at 9:00.",
  mailbox_signed_out: (provider: string, address: string, n: number): string =>
    `${provider} signed Callum out of ${address}. ${waiting(n, 'email')} and nothing was lost.`,
  x_signed_out: (n: number): string => `X signed Callum out. ${waiting(n, 'message')} and nothing was lost.`,
  linkedin_signed_out: (n: number): string => `LinkedIn signed Callum out. ${waiting(n, 'message')} and nothing was lost.`,
  /** `fallback` is where the bounced people go next; null when nobody had anywhere else to go. */
  bounces: (n: number, domain: string, fallback: string | null): string => {
    const one = n === 1;
    const head = `${n} ${one ? 'address' : 'addresses'} at ${domain} bounced. Callum removed ${one ? 'it' : 'them'}`;
    return fallback ? `${head} and will try ${fallback} for ${one ? 'that person' : 'those people'}.` : `${head}.`;
  },
  send_failed: (first: string, reason: string): string =>
    `Your reply to ${first} didn't go out: ${reason.trim().replace(/\.+$/, '')}. It's saved here.`,
  /** The mailbox's own daily limit stopped a reply; it goes at the next slot. */
  send_deferred: (first: string, slot: string): string => `Your reply to ${first} goes ${slot}. Your mailbox reached today's limit.`,
  /** A reply could not be read after several tries; it is on the dock as it came. */
  reply_unread: (first: string): string => `Callum couldn't read a reply from ${first}. It's on your dock.`,
  reply_unread_unknown: (channel: string, senders: string[] = []): string => {
    const shown = senders.slice(-3);
    const from = shown.length > 0 ? ` from ${shown.join(', ')}` : '';
    return `Callum couldn't read a reply${from} on ${channel}. Check it by hand.`;
  },
  /** A channel's check for new messages has stopped answering. */
  not_answering: (channel: string): string => `${channel} isn't answering. Callum will keep trying.`,
  /** Callum was closed while a reply was on its way, so nobody knows whether it left. */
  /** Gmail's daily sending limit: email waits until the user's next day. */
  mailbox_limit: "Your mailbox reached its daily sending limit, so Callum paused email until tomorrow. Nothing is lost and replies keep arriving.",
  send_unsure: (first: string): string =>
    `Callum was closed while your reply to ${first} was going out. It may have gone, so check your Sent folder before you try again.`,
  /** Callum's own messages that were stopped or did not go, for one channel on one day. `what` reads "3 follow-ups" or "a follow-up". */
  auto_failed: (what: string, channel: Channel, when: string): string =>
    `Callum couldn't send ${what} ${channel === 'email' ? 'by email' : `by ${CHANNEL_NAME[channel]}`} ${when}`,
  /** Three sends in a row that Callum could not confirm: the channel is paused so nothing goes twice. */
  channel_paused: (channel: Channel): string => {
    switch (channel) {
      case 'linkedin': return "LinkedIn changed something and Callum couldn't confirm 3 sends in a row. It paused LinkedIn so nothing goes twice. Check LinkedIn, then resume.";
      case 'x': return "X changed something and Callum couldn't confirm 3 sends in a row. It paused X so nothing goes twice. Check X, then resume.";
      case 'email': return "Callum couldn't confirm 3 emails in a row. It paused email so nothing goes twice. Check your Sent folder, then resume.";
    }
  },
} as const;

interface BounceDetail { domain: string; people: { id: number; fallback: Channel | null }[] }

function parseBounceDetail(detail: string | null): BounceDetail | null {
  if (!detail) return null;
  try {
    const d = JSON.parse(detail) as Partial<BounceDetail>;
    return typeof d.domain === 'string' && Array.isArray(d.people) ? { domain: d.domain, people: d.people } : null;
  } catch {
    return null;
  }
}

function sameUtcDay(a: string, b: Date): boolean {
  return a.slice(0, 10) === b.toISOString().slice(0, 10);
}

/** The open incident this one would repeat: same channel and kind; bounces also the same domain on the same UTC day, failed replies the same person. */
function findOpen(ctx: Ctx, i: NewIncident): Incident | null {
  const now = ctx.clock.now();
  for (const open of ctx.repo.listIncidents({ open: true })) {
    if (open.channel !== i.channel || open.kind !== i.kind) continue;
    if (i.kind === 'bounces') {
      if (parseBounceDetail(open.detail)?.domain !== parseBounceDetail(i.detail ?? null)?.domain || !sameUtcDay(open.createdAt, now)) continue;
    }
    if ((i.kind === 'send_failed' || i.kind === 'reply_unread') && open.personId !== (i.personId ?? null)) continue;
    // Callum's own messages that did not go are one card for each channel and day, not one for each person.
    if (i.kind === 'send_failed') {
      const mine = parseAutoDetail(i.detail ?? null);
      const theirs = parseAutoDetail(open.detail);
      if ((mine === null) !== (theirs === null) || (mine && theirs && mine.day !== theirs.day)) continue;
    }
    return open;
  }
  return null;
}

/** Records an incident, or updates the open one it repeats instead of adding another. */
export function openIncident(ctx: Ctx, i: NewIncident): Incident {
  const open = findOpen(ctx, i);
  const incident = open
    ? ctx.repo.updateIncident(open.id, { message: i.message, detail: i.detail ?? open.detail })
    : ctx.repo.insertIncident(i);
  ctx.bus.emit('incidents');
  return incident;
}

/** Resolves open incidents of these kinds on a channel. Returns how many. */
function resolveIncidents(ctx: Ctx, ch: Channel, kinds: Incident['kind'][] | null): number {
  const at = ctx.clock.now().toISOString();
  let n = 0;
  for (const i of ctx.repo.listIncidents({ open: true })) {
    if (i.channel !== ch || (kinds && !kinds.includes(i.kind))) continue;
    ctx.repo.updateIncident(i.id, { state: 'resolved', resolvedAt: at });
    n++;
  }
  if (n > 0) ctx.bus.emit('incidents');
  return n;
}

export function resolveChannelIncidents(ctx: Ctx, ch: Channel, kinds: Incident['kind'][]): void {
  resolveIncidents(ctx, ch, kinds);
}

/**
 * The user finished whatever stopped the channel. Back to connected, at half pace for a week when asked. Settles the
 * incidents that were about the channel being stopped or signed out; a weekly limit or a saved reply is still true afterwards.
 */
export function resumeChannel(ctx: Ctx, ch: Channel, pace: 'half' | 'full'): ChannelAccount {
  const now = ctx.clock.now();
  const account = ctx.repo.updateChannel(ch, {
    status: 'connected',
    pausedUntil: null,
    halfPaceUntil: pace === 'half' ? new Date(now.getTime() + 7 * DAY_MS).toISOString() : null,
  });
  resolveIncidents(ctx, ch, ['linkedin_check', 'x_limit', 'mailbox_limit', 'mailbox_signed_out', 'x_signed_out', 'linkedin_signed_out', 'channel_paused']);
  // A fresh start: the run of sends Callum could not confirm begins again from nothing.
  unconfirmedRuns(ctx).delete(ch);
  ctx.bus.emit('channels');
  return account;
}

function providerName(secret: Record<string, string> | null): string {
  switch (secret?.provider) {
    case 'google': return 'Google';
    case 'microsoft': return 'Microsoft';
    default: return 'Your mail server';
  }
}

const SIGNED_OUT_KIND = { email: 'mailbox_signed_out', linkedin: 'linkedin_signed_out', x: 'x_signed_out' } as const;

function signedOutMessage(ctx: Ctx, ch: Channel): string {
  const n = ctx.repo.listOutbox({ state: ['scheduled'] }).filter((i) => i.channel === ch).length;
  if (ch === 'email') {
    const secret = ctx.repo.getChannelSecret('email');
    const address = ctx.repo.getChannel('email').identity ?? secret?.address ?? 'your mailbox';
    return INCIDENT_COPY.mailbox_signed_out(providerName(secret), address, n);
  }
  return ch === 'x' ? INCIDENT_COPY.x_signed_out(n) : INCIDENT_COPY.linkedin_signed_out(n);
}

/** The channel's sign-in no longer works: stop it, keep everything queued, and say how many messages wait. */
export function channelSignedOut(ctx: Ctx, ch: Channel): Incident {
  ctx.repo.updateChannel(ch, { status: 'error' });
  ctx.bus.emit('channels');
  return openIncident(ctx, { channel: ch, kind: SIGNED_OUT_KIND[ch], message: signedOutMessage(ctx, ch) });
}

/** Messages keep arriving in the outbox while a channel is signed out; keep the count in the notice true. */
export function refreshSignedOutCount(ctx: Ctx): void {
  for (const open of ctx.repo.listIncidents({ open: true })) {
    if (open.kind !== SIGNED_OUT_KIND[open.channel]) continue;
    const message = signedOutMessage(ctx, open.channel);
    if (message === open.message) continue;
    ctx.repo.updateIncident(open.id, { message });
    ctx.bus.emit('incidents');
  }
}

/** LinkedIn asked to check it's the user: pause it. Email and X carry on. */
export function channelCheckpoint(ctx: Ctx, ch: Channel): Incident {
  ctx.repo.updateChannel(ch, { status: 'paused', pausedUntil: null });
  ctx.bus.emit('channels');
  return openIncident(ctx, { channel: ch, kind: 'linkedin_check', message: INCIDENT_COPY.linkedin_check });
}

/** LinkedIn's weekly invite limit: no invites until Monday 00:00 in the user's time zone. Returns that instant. */
export function weeklyInviteLimit(ctx: Ctx, ch: Channel): Date {
  const until = nextMonday(ctx.clock.now(), ctx.repo.getSettings().timezone);
  ctx.repo.updateChannel(ch, { invitesBlockedUntil: until.toISOString() });
  ctx.bus.emit('channels');
  openIncident(ctx, { channel: ch, kind: 'linkedin_weekly_limit', message: INCIDENT_COPY.linkedin_weekly_limit });
  return until;
}

/** The start of the user's next day. */
export function nextLocalMidnight(ctx: Ctx): Date {
  const tz = ctx.repo.getSettings().timezone;
  return addLocalDays(startOfLocalDay(ctx.clock.now(), tz), 1, tz);
}

/**
 * The mailbox said its daily sending limit is reached. Automatic email stops until the user's next day, in one step, rather
 * than every waiting message finding out for itself. The channel stays connected so replies and stops keep arriving;
 * `pausedUntil` is the hold. Returns the instant it lifts.
 */
export function mailboxLimitReached(ctx: Ctx, ch: Channel, item: OutboxItem): Date | null {
  if (ch !== 'email') return null;
  const until = nextLocalMidnight(ctx);
  ctx.repo.updateChannel(ch, { pausedUntil: until.toISOString() });
  ctx.bus.emit('channels');
  // A reply of the user's that hit the limit has its own notice, with the time it goes.
  if (item.origin === 'auto') openIncident(ctx, { channel: ch, kind: 'mailbox_limit', message: INCIDENT_COPY.mailbox_limit });
  return until;
}

/** True while automatic email is held back by the mailbox's daily limit. */
export function mailboxHeld(account: ChannelAccount, now: Date): boolean {
  return account.channel === 'email' && account.status === 'connected' && account.pausedUntil !== null && new Date(account.pausedUntil).getTime() > now.getTime();
}

/** The next day has come: email goes again and the notice is settled. */
export function releaseMailboxLimit(ctx: Ctx): void {
  const account = ctx.repo.getChannel('email');
  if (account.status !== 'connected' || account.pausedUntil === null || new Date(account.pausedUntil).getTime() > ctx.clock.now().getTime()) return;
  ctx.repo.updateChannel('email', { pausedUntil: null });
  resolveIncidents(ctx, 'email', ['mailbox_limit']);
  ctx.bus.emit('channels');
}

/**
 * LinkedIn showed that the user is already connected to this person, so the invitation is moot: it is not a bad address.
 * The person is marked connected and the planner writes a message instead. Their LinkedIn address stays.
 */
export function alreadyConnected(ctx: Ctx, personId: number): void {
  ctx.outbox.cancelPending(personId, ['auto']);
  ctx.repo.updatePerson(personId, { linkedinState: 'connected', nextTouchAt: null });
  ctx.bus.emit('outbox');
  ctx.bus.emit('people');
}

/** X (or another account) is out of room for today: pause it until the user's next midnight. */
export function channelRateLimited(ctx: Ctx, ch: Channel, reason: string): Date {
  const until = nextLocalMidnight(ctx);
  ctx.repo.updateChannel(ch, { status: 'paused', pausedUntil: until.toISOString() });
  ctx.bus.emit('channels');
  const message = /credit/i.test(reason) ? reason : INCIDENT_COPY.x_limit;
  openIncident(ctx, { channel: ch, kind: 'x_limit', message });
  return until;
}

/** The user's own message did not go: say so, with the provider's reason. The message stays saved on its outbox item. */
export function sendFailed(ctx: Ctx, item: OutboxItem, person: Person, reason: string): Incident {
  return openIncident(ctx, {
    channel: item.channel,
    kind: 'send_failed',
    message: INCIDENT_COPY.send_failed(person.firstName, reason),
    detail: JSON.stringify({ outboxId: item.id }),
    personId: person.id,
  });
}

/** A reply the mailbox's limit held back: say exactly when it goes. */
export function replyDeferred(ctx: Ctx, item: OutboxItem, person: Person, slot: Date): Incident {
  // The user reads this, so the time is in the user's own zone, whatever zone the person is in.
  const tz = ctx.repo.getSettings().timezone;
  return openIncident(ctx, {
    channel: item.channel,
    kind: 'send_failed',
    message: INCIDENT_COPY.send_deferred(person.firstName, formatSlot(slot, tz)),
    detail: JSON.stringify({ outboxId: item.id, deferred: true }),
    personId: person.id,
  });
}

/** A reply was closed in the middle of sending: nobody knows whether it left. */
export function sendUnsure(ctx: Ctx, item: OutboxItem, person: Person): Incident {
  return openIncident(ctx, {
    channel: item.channel,
    kind: 'send_failed',
    message: INCIDENT_COPY.send_unsure(person.firstName),
    detail: JSON.stringify({ outboxId: item.id, maybeSent: true }),
    personId: person.id,
  });
}

/** The user's message to this person went out after all; the notice about it is settled. */
export function resolveSendFailed(ctx: Ctx, personId: number, ch: Channel): void {
  const at = ctx.clock.now().toISOString();
  let n = 0;
  for (const i of ctx.repo.listIncidents({ open: true })) {
    if (i.kind !== 'send_failed' || i.channel !== ch || i.personId !== personId) continue;
    ctx.repo.updateIncident(i.id, { state: 'resolved', resolvedAt: at });
    n++;
  }
  if (n > 0) ctx.bus.emit('incidents');
}

function clearHandle(ch: Channel): Partial<Person> {
  switch (ch) {
    case 'email': return { email: null };
    case 'linkedin': return { linkedinUrl: null };
    case 'x': return { xHandle: null };
  }
}

function fallbackName(people: BounceDetail['people']): string | null {
  const found = [...new Set(people.flatMap((p) => (p.fallback ? [p.fallback] : [])))];
  if (found.length === 0) return null;
  return found.length === 1 ? CHANNEL_NAME[found[0] as Channel] : 'another channel';
}

function recordBounce(ctx: Ctx, person: Person, address: string, fallback: Channel | null): void {
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  const key: NewIncident = { channel: 'email', kind: 'bounces', message: '', detail: JSON.stringify({ domain, people: [] }) };
  const existing = parseBounceDetail(findOpen(ctx, key)?.detail ?? null);
  const people = [...(existing?.people ?? []).filter((p) => p.id !== person.id), { id: person.id, fallback }];
  openIncident(ctx, {
    ...key,
    message: INCIDENT_COPY.bounces(people.length, domain, fallbackName(people)),
    detail: JSON.stringify({ domain, people }),
  });
}

/**
 * An address (or LinkedIn or X handle) is no good. Forget it, move the person to the next channel they can be reached on
 * (or remove them when there is none), drop what was waiting to go, and tell the user once per domain per day.
 * Anyone who is talking, waiting, stopped or closed keeps their status: only the dead handle goes.
 */
export function handleBounce(ctx: Ctx, personId: number, ch: Channel): void {
  const person = ctx.repo.getPerson(personId);
  if (!person) return;
  const address = ch === 'email' ? person.email : null;
  const clear = clearHandle(ch);
  const inFlow = (person.status === 'active' || person.status === 'resting') && person.stage !== 'talking';
  if (person.status === 'stopped' || !inFlow || person.channel !== ch) {
    // A stopped person keeps every handle, so the stop holds on all of them.
    if (person.status !== 'stopped') ctx.repo.updatePerson(person.id, clear);
    ctx.bus.emit('people');
    return;
  }
  const after: Person = { ...person, ...clear };
  const usable = ctx.repo.listChannels().filter((c) => c.channel !== ch && (c.status === 'connected' || c.status === 'paused')).map((c) => c.channel);
  const next = chooseChannel(after, usable);
  const tz = personTz(person, ctx.repo.getSettings().timezone);
  if (next) {
    const move = person.status === 'resting' ? { channel: next } : switchChannel(after, next, ctx.clock.now(), tz);
    ctx.repo.updatePerson(person.id, { ...clear, ...move });
  } else {
    ctx.repo.updatePerson(person.id, { ...clear, status: 'removed', nextTouchAt: null });
  }
  ctx.outbox.cancelPending(person.id, ['auto']);
  if (ch === 'email' && address) recordBounce(ctx, person, address, next);
  ctx.bus.emit('people');
}

// ---- Callum's own messages that were stopped or did not go ---------------------------------------------------

/** What a grouped notice remembers: the day it is for and the outbox items it is about. */
export interface AutoDetail { auto: true; day: string; outboxId: number; outboxIds: number[]; personIds: number[] }

export function parseAutoDetail(detail: string | null): AutoDetail | null {
  if (!detail) return null;
  try {
    const d = JSON.parse(detail) as Partial<AutoDetail>;
    if (d.auto !== true || typeof d.day !== 'string' || !Array.isArray(d.outboxIds)) return null;
    return {
      auto: true, day: d.day, outboxId: typeof d.outboxId === 'number' ? d.outboxId : (d.outboxIds[0] as number),
      outboxIds: d.outboxIds.filter((n): n is number => typeof n === 'number'),
      personIds: Array.isArray(d.personIds) ? d.personIds.filter((n): n is number => typeof n === 'number') : [],
    };
  } catch {
    return null;
  }
}

const KIND_ONE: Record<string, string> = { hello: 'a first hello', invite: 'an invite', thanks: 'a thank-you', follow_up: 'a follow-up' };
const KIND_MANY: Record<string, string> = { hello: 'first hellos', invite: 'invites', thanks: 'thank-yous', follow_up: 'follow-ups' };

function localDay(ctx: Ctx, d: Date): string {
  const p = localParts(d, ctx.repo.getSettings().timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `today`, `on Monday` for a notice about an earlier day this week, or `on 3 November` for an older one. */
function dayWords(ctx: Ctx, day: string): string {
  if (day === localDay(ctx, ctx.clock.now())) return 'today';
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const then = Date.UTC(y, m - 1, d);
  const [ny, nm, nd] = localDay(ctx, ctx.clock.now()).split('-').map(Number) as [number, number, number];
  if (Date.UTC(ny, nm - 1, nd) - then > 6 * 86_400_000) return `on ${d} ${MONTHS[m - 1]}`;
  return `on ${WEEKDAYS[new Date(then).getUTCDay()]}`;
}

/** The items a grouped notice still stands for: stopped or failed, and for someone Callum is still writing to. */
function liveItems(ctx: Ctx, ids: number[]): OutboxItem[] {
  const out: OutboxItem[] = [];
  for (const id of ids) {
    const item = ctx.repo.getOutbox(id);
    if (!item || (item.state !== 'blocked' && item.state !== 'failed')) continue;
    if (ctx.repo.getPerson(item.personId)?.status !== 'active') continue;
    out.push(item);
  }
  return out;
}

function autoMessage(ctx: Ctx, channel: Channel, day: string, items: OutboxItem[]): string {
  const kinds = new Set(items.map((i) => i.kind));
  const only = kinds.size === 1 ? [...kinds][0] as string : null;
  const what = items.length === 1
    ? (only ? KIND_ONE[only] : null) ?? 'a message'
    : `${items.length} ${(only ? KIND_MANY[only] : null) ?? 'messages'}`;
  return INCIDENT_COPY.auto_failed(what, channel, dayWords(ctx, day));
}

/**
 * One of Callum's own messages was stopped (it still had a blank in it) or did not go. It is added to the notice for its
 * channel and day, so twenty of them are one card with the people on it, not twenty cards.
 */
export function autoSendFailed(ctx: Ctx, item: OutboxItem): Incident {
  const day = localDay(ctx, ctx.clock.now());
  const probe: NewIncident = { channel: item.channel, kind: 'send_failed', message: '', detail: JSON.stringify({ auto: true, day, outboxId: item.id, outboxIds: [], personIds: [] }) };
  const open = findOpen(ctx, probe);
  const before = parseAutoDetail(open?.detail ?? null);
  const ids = [...new Set([...(before?.outboxIds ?? []), item.id])];
  const items = liveItems(ctx, ids);
  const detail: AutoDetail = {
    auto: true, day, outboxId: before?.outboxId ?? item.id, outboxIds: items.map((i) => i.id), personIds: [...new Set(items.map((i) => i.personId))],
  };
  return openIncident(ctx, { channel: item.channel, kind: 'send_failed', message: autoMessage(ctx, item.channel, day, items), detail: JSON.stringify(detail) });
}

/**
 * Keeps the notices about Callum's own messages true: an item the user fixed, tried again or cancelled leaves its notice,
 * and a notice with nothing left on it is settled. Called every pass and after the user acts.
 */
export function syncAutoIncidents(ctx: Ctx): void {
  const at = ctx.clock.now().toISOString();
  let changed = false;
  for (const open of ctx.repo.listIncidents({ open: true })) {
    if (open.kind !== 'send_failed') continue;
    const d = parseAutoDetail(open.detail);
    if (!d) continue;
    const items = liveItems(ctx, d.outboxIds);
    if (items.length === 0) {
      ctx.repo.updateIncident(open.id, { state: 'resolved', resolvedAt: at });
      changed = true;
      continue;
    }
    const next: AutoDetail = { ...d, outboxId: items[0]!.id, outboxIds: items.map((i) => i.id), personIds: [...new Set(items.map((i) => i.personId))] };
    const message = autoMessage(ctx, open.channel, d.day, items);
    const detail = JSON.stringify(next);
    if (message === open.message && detail === open.detail) continue;
    ctx.repo.updateIncident(open.id, { message, detail });
    changed = true;
  }
  if (changed) ctx.bus.emit('incidents');
}

// ---- sends Callum could not confirm, in a row ------------------------------------------------------------------

/** Three in a row on one channel and it stops. */
export const UNCONFIRMED_LIMIT = 3;
const runs = new WeakMap<object, Map<Channel, number>>();
const unconfirmedRuns = (ctx: Ctx): Map<Channel, number> => {
  let map = runs.get(ctx.repo);
  if (!map) runs.set(ctx.repo, (map = new Map()));
  return map;
};

/** A send went through: whatever run of unconfirmed sends there was is over. */
export function sendConfirmed(ctx: Ctx, ch: Channel): void {
  unconfirmedRuns(ctx).delete(ch);
}

/**
 * Callum's own message failed with no way to tell why. The third one in a row on a channel pauses it, because the
 * page or the service has probably changed and trying on would only stack up doubtful sends. Returns whether it paused.
 */
export function sendUnconfirmed(ctx: Ctx, ch: Channel): boolean {
  const runsOf = unconfirmedRuns(ctx);
  const n = (runsOf.get(ch) ?? 0) + 1;
  if (n < UNCONFIRMED_LIMIT) {
    runsOf.set(ch, n);
    return false;
  }
  runsOf.delete(ch);
  // Only a channel that was running is stopped; one the user already paused or signed out of stays as it is.
  if (ctx.repo.getChannel(ch).status === 'connected') {
    ctx.repo.updateChannel(ch, { status: 'paused', pausedUntil: null });
    ctx.bus.emit('channels');
  }
  openIncident(ctx, { channel: ch, kind: 'channel_paused', message: INCIDENT_COPY.channel_paused(ch) });
  return true;
}
