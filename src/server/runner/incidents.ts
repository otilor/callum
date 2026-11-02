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
  /** Callum was closed while a reply was on its way, so nobody knows whether it left. */
  send_unsure: (first: string): string =>
    `Callum was closed while your reply to ${first} was going out. It may have gone, so check your Sent folder before you try again.`,
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
    if (i.kind === 'send_failed' && open.personId !== (i.personId ?? null)) continue;
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
 * incidents that were about the channel being stopped; a weekly limit or a saved reply is still true afterwards.
 */
export function resumeChannel(ctx: Ctx, ch: Channel, pace: 'half' | 'full'): ChannelAccount {
  const now = ctx.clock.now();
  const account = ctx.repo.updateChannel(ch, {
    status: 'connected',
    pausedUntil: null,
    halfPaceUntil: pace === 'half' ? new Date(now.getTime() + 7 * DAY_MS).toISOString() : null,
  });
  resolveIncidents(ctx, ch, ['linkedin_check', 'x_limit']);
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
  const tz = personTz(person, ctx.repo.getSettings().timezone);
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
