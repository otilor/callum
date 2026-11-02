import type { Channel, Message, OutboxItem, OutKind, Person } from '../../shared/types.js';
import type { ChannelAdapter, ChannelError, OutboundMessage, SendResult } from '../channels/types.js';
import type { Ctx } from '../context.js';
import { capFor } from '../engine/pacing.js';
import { findPlaceholders, placeholderMessage, withOptOut } from '../engine/guard.js';
import { afterSent, afterUserSent, personTz } from '../engine/lifecycle.js';
import { addLocalDays, startOfLocalDay } from '../engine/time.js';
import { isSendingTime, nextSendingTime } from '../engine/windows.js';
import {
  channelCheckpoint, channelRateLimited, channelSignedOut, handleBounce, sendFailed, weeklyInviteLimit,
} from './incidents.js';

const RETRY_AFTER_MS = 15 * 60_000;

// Items whose send is in flight. Two overlapping runs must never send the same item twice.
const inFlight = new WeakMap<Ctx, Set<number>>();
function sendingSet(ctx: Ctx): Set<number> {
  let set = inFlight.get(ctx);
  if (!set) {
    set = new Set();
    inFlight.set(ctx, set);
  }
  return set;
}

const NEVER_MESSAGE: ReadonlySet<Person['status']> = new Set(['stopped', 'closed', 'removed', 'held']);

/** Kinds that count against the same daily cap as this one. LinkedIn invites have their own; everything else shares. */
function capKinds(channel: Channel, kind: OutKind): OutKind[] {
  if (channel === 'linkedin') return kind === 'invite' ? ['invite'] : ['hello', 'thanks', 'follow_up'];
  return ['hello', 'invite', 'thanks', 'follow_up'];
}

const iso = (d: Date): string => d.toISOString();

/** The first sending slot of a later day, and not before `notBefore` when given. */
function tomorrow(ctx: Ctx, person: Person, notBefore: Date | null = null): Date {
  const user = ctx.repo.getSettings().timezone;
  const tz = personTz(person, user);
  const dayAfter = addLocalDays(startOfLocalDay(ctx.clock.now(), user), 1, user);
  const slot = nextSendingTime(dayAfter, tz);
  return notBefore && notBefore.getTime() > slot.getTime() ? nextSendingTime(notBefore, tz) : slot;
}

function threading(history: Message[], channel: Channel): { inReplyTo: string | null; subject: string | null } {
  const mine = history.filter((m) => m.channel === channel);
  const lastId = [...mine].reverse().find((m) => m.externalId)?.externalId ?? null;
  const lastSubject = [...mine].reverse().find((m) => m.subject)?.subject ?? null;
  return { inReplyTo: channel === 'email' ? lastId : null, subject: lastSubject };
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

function failureOf(err: unknown): ChannelError {
  return { code: 'unknown', message: err instanceof Error && err.message ? err.message : 'Callum could not send this' };
}

/** Sends everything that is due and allowed. Returns how many messages went out. */
export async function dispatchDue(ctx: Ctx): Promise<number> {
  let sent = 0;
  for (const due of ctx.outbox.due()) {
    if (sendingSet(ctx).has(due.id)) continue;
    if (await dispatchOne(ctx, due.id)) sent++;
  }
  return sent;
}

async function dispatchOne(ctx: Ctx, id: number): Promise<boolean> {
  const { repo, clock } = ctx;
  const now = clock.now();
  const item = repo.getOutbox(id);
  if (!item || item.state !== 'scheduled' || new Date(item.sendAfter).getTime() > now.getTime()) return false;

  const person = repo.getPerson(item.personId);
  const skip = !person || NEVER_MESSAGE.has(person.status) || (item.origin === 'auto' && person.status !== 'active');
  if (skip) {
    repo.updateOutbox(item.id, { state: 'cancelled' });
    ctx.bus.emit('outbox');
    return false;
  }

  const settings = repo.getSettings();
  const project = repo.getProject(person.projectId);
  if (item.origin === 'auto' && (settings.pauseState !== 'running' || project?.state !== 'running')) return false;

  const account = repo.getChannel(item.channel);
  if (account.status !== 'connected') return false;
  const adapter = ctx.adapters.get(item.channel);
  if (!adapter) return false;

  const found = [...findPlaceholders(item.subject ?? ''), ...findPlaceholders(item.body)];
  if (found.length > 0) {
    repo.updateOutbox(item.id, { state: 'blocked', error: placeholderMessage(found[0] as string) });
    ctx.bus.emit('outbox');
    return false;
  }

  if (item.origin === 'auto') {
    const tz = personTz(person, settings.timezone);
    if (!isSendingTime(now, tz)) {
      repo.updateOutbox(item.id, { sendAfter: iso(nextSendingTime(now, tz)) });
      ctx.bus.emit('outbox');
      return false;
    }
    const cap = capFor(item.channel, item.kind, account, now);
    const used = repo.countOut(item.channel, capKinds(item.channel, item.kind), iso(startOfLocalDay(now, settings.timezone)));
    if (used >= cap) {
      const blocked = item.kind === 'invite' && account.invitesBlockedUntil ? new Date(account.invitesBlockedUntil) : null;
      repo.updateOutbox(item.id, { sendAfter: iso(tomorrow(ctx, person, blocked)) });
      ctx.bus.emit('outbox');
      return false;
    }
  }

  const sending = sendingSet(ctx);
  if (sending.has(item.id)) return false;
  sending.add(item.id);
  try {
    // Nothing above waited, but anything that could have changed the item gets a last look before it leaves.
    if (repo.getOutbox(item.id)?.state !== 'scheduled') return false;
    const result = await send(ctx, adapter, item, person);
    if (result.ok) {
      afterSend(ctx, item, person.id, result);
      return true;
    }
    onFailure(ctx, item, person, result.error);
    return false;
  } finally {
    sending.delete(item.id);
  }
}

async function send(ctx: Ctx, adapter: ChannelAdapter, item: OutboxItem, person: Person): Promise<SendResult> {
  const thread = threading(ctx.repo.listMessages(person.id), item.channel);
  const subject = item.subject ?? (item.channel === 'email' && thread.subject ? replySubject(thread.subject) : null);
  const msg: OutboundMessage = {
    to: { name: person.name, email: person.email, linkedinUrl: person.linkedinUrl, xHandle: person.xHandle },
    kind: item.kind,
    subject,
    body: item.channel === 'email' ? withOptOut(item.body) : item.body,
    inReplyTo: item.kind === 'hello' || item.kind === 'invite' ? null : thread.inReplyTo,
  };
  try {
    return await adapter.send(msg);
  } catch (err) {
    return { ok: false, error: failureOf(err) };
  }
}

function afterSend(ctx: Ctx, item: OutboxItem, personId: number, result: Extract<SendResult, { ok: true }>): void {
  const { repo } = ctx;
  const now = ctx.clock.now();
  const sentBody = item.channel === 'email' ? withOptOut(item.body) : item.body;
  const thread = threading(repo.listMessages(personId), item.channel);
  repo.transaction(() => {
    repo.insertMessage({
      personId, channel: item.channel, direction: 'out', kind: item.kind,
      subject: item.subject ?? (item.channel === 'email' && thread.subject && item.kind !== 'hello' ? replySubject(thread.subject) : null),
      // An invitation that lost its note went out empty: that is what the person got.
      body: result.noteDropped ? '' : sentBody,
      at: iso(now), externalId: result.externalId,
    });
    repo.updateOutbox(item.id, { state: 'sent', error: null });
    // Read the person again: they may have changed while the message was on its way.
    const person = repo.getPerson(personId);
    if (person) {
      const tz = personTz(person, repo.getSettings().timezone);
      const patch = item.origin === 'user' && (item.kind === 'reply' || item.kind === 'booking' || item.kind === 'close')
        ? afterUserSent(person, item.kind, now)
        : afterSent(person, item.kind, now, tz);
      repo.updatePerson(personId, patch);
    }
  });
  // The user has taken over: whatever Callum had lined up for them goes.
  if (item.origin === 'user') ctx.outbox.cancelPending(personId, ['auto']);
  ctx.bus.emit('outbox');
  ctx.bus.emit('people');
}

function onFailure(ctx: Ctx, item: OutboxItem, person: Person, error: ChannelError): void {
  const { repo, clock } = ctx;
  const now = clock.now();
  switch (error.code) {
    case 'auth':
      channelSignedOut(ctx, item.channel, error.message);
      return;
    case 'checkpoint':
      channelCheckpoint(ctx, item.channel);
      return;
    case 'rate_limit':
      if (item.channel === 'x') channelRateLimited(ctx, 'x', error.message);
      else repo.updateOutbox(item.id, { sendAfter: iso(tomorrow(ctx, person)) });
      ctx.bus.emit('outbox');
      return;
    default:
  }

  if (item.origin === 'user') {
    repo.updateOutbox(item.id, { state: 'failed', error: error.message });
    sendFailed(ctx, item, person, error.message);
    ctx.bus.emit('outbox');
    return;
  }

  switch (error.code) {
    case 'weekly_limit': {
      const until = weeklyInviteLimit(ctx, item.channel);
      repo.updateOutbox(item.id, { sendAfter: iso(tomorrow(ctx, person, until)) });
      break;
    }
    case 'bounce':
    case 'invalid_recipient':
      repo.updateOutbox(item.id, { state: 'cancelled', error: error.message });
      handleBounce(ctx, person.id, item.channel);
      break;
    case 'temporary':
      repo.updateOutbox(item.id, { sendAfter: iso(new Date(now.getTime() + RETRY_AFTER_MS)) });
      break;
    default:
      // Nobody knows whether it went. Sending it again could double a hello, so it waits for the user to look.
      repo.updateOutbox(item.id, { state: 'failed', error: error.message });
  }
  ctx.bus.emit('outbox');
}
