import type { Channel, Message, OutboxItem, OutKind, Person } from '../../shared/types.js';
import type { ChannelError, OutboundMessage, SendResult } from '../channels/types.js';
import type { Ctx } from '../context.js';
import { findPlaceholders, placeholderMessage, withOptOut } from '../engine/guard.js';
import { afterSent, afterUserSent, personTz } from '../engine/lifecycle.js';
import { capFor } from '../engine/pacing.js';
import { addLocalDays, startOfLocalDay } from '../engine/time.js';
import { isSendingTime, nextSendingTime } from '../engine/windows.js';
import { heldBackPeople } from './inbound.js';
import {
  channelCheckpoint, channelRateLimited, channelSignedOut, handleBounce, replyDeferred, resolveSendFailed, sendFailed, sendUnsure,
  weeklyInviteLimit,
} from './incidents.js';

const RETRY_AFTER_MS = 15 * 60_000;
export const COULD_NOT_RECORD = 'Sent, but Callum could not record it. Check your Sent folder before trying again.';
export const CLOSED_WHILE_SENDING = 'Callum was closed while this was going out. It may have been sent, so check before trying again.';

// Items whose send is in flight. Two overlapping runs must never send the same item twice. Keyed on the outbox
// because the ctx object is copied around (spread) while the outbox is the one shared thing.
const inFlight = new WeakMap<object, Set<number>>();
function sendingSet(ctx: Ctx): Set<number> {
  let set = inFlight.get(ctx.outbox);
  if (!set) {
    set = new Set();
    inFlight.set(ctx.outbox, set);
  }
  return set;
}

// Claims of sends under way in this process, across every ctx on any database. A ctx created while one is in flight
// (a second one on the same file) must not mistake it for a claim left by a crashed run.
const liveClaims = new Set<string>();
const claimKey = (item: { id: number; claimedAt: string | null }): string => `${item.id}@${item.claimedAt ?? ''}`;

const NEVER_MESSAGE: ReadonlySet<Person['status']> = new Set(['stopped', 'closed', 'removed', 'held']);

/** Kinds that count against the same daily cap as this one. LinkedIn invites have their own; everything else shares. */
export function capKinds(channel: Channel, kind: OutKind): OutKind[] {
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

export interface DispatchOptions {
  /** Only items of this origin. The runner sends the user's own first, before any slow planning. */
  origin?: 'user' | 'auto';
  /** Where a failure on one item is reported; the rest of the batch carries on. */
  onError?: (err: unknown) => void;
}

/** Sends everything that is due and allowed. Returns how many messages went out. */
export async function dispatchDue(ctx: Ctx, opts: DispatchOptions = {}): Promise<number> {
  const report = opts.onError ?? ctx.onError;
  const held = heldBackPeople(ctx);
  let sent = 0;
  for (const due of ctx.outbox.due()) {
    if (opts.origin && due.origin !== opts.origin) continue;
    if (sendingSet(ctx).has(due.id)) continue;
    try {
      if (await dispatchOne(ctx, due.id, held, report)) sent++;
    } catch (err) {
      report(err);
    }
  }
  return sent;
}

/**
 * Items still `sending` when Callum starts were claimed by a run that never finished. They may have gone out, so they
 * are never sent again on their own: they become failed, marked `maybeSent`, and the user decides.
 */
export function recoverSending(ctx: Ctx): number {
  const items = ctx.repo.listOutbox({ state: ['sending'] }).filter((i) => !liveClaims.has(claimKey(i)));
  for (const item of items) {
    ctx.repo.updateOutbox(item.id, { state: 'failed', error: CLOSED_WHILE_SENDING, detail: JSON.stringify({ maybeSent: true }) });
    const person = item.origin === 'user' ? ctx.repo.getPerson(item.personId) : null;
    if (person) sendUnsure(ctx, item, person);
  }
  if (items.length > 0) ctx.bus.emit('outbox');
  return items.length;
}

async function dispatchOne(ctx: Ctx, id: number, held: Set<number>, report: (err: unknown) => void): Promise<boolean> {
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
  // A reply from this person could not be read yet (it may be a stop). Nothing automatic goes meanwhile.
  if (item.origin === 'auto' && held.has(person.id)) return false;

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

  // What goes out is worked out once: the same subject, body and thread are what get recorded.
  const thread = threading(repo.listMessages(person.id), item.channel);
  const subject = item.subject ?? (item.channel === 'email' && thread.subject ? replySubject(thread.subject) : null);
  const body = item.channel === 'email' ? withOptOut(item.body) : item.body;
  const msg: OutboundMessage = {
    to: { name: person.name, email: person.email, linkedinUrl: person.linkedinUrl, xHandle: person.xHandle },
    kind: item.kind,
    subject,
    body,
    inReplyTo: item.kind === 'hello' || item.kind === 'invite' ? null : thread.inReplyTo,
  };

  const sending = sendingSet(ctx);
  if (sending.has(item.id)) return false;
  sending.add(item.id);
  let claim: string | null = null;
  try {
    // Nothing above waited, but anything that could have changed the item gets a last look before it leaves.
    if (repo.getOutbox(item.id)?.state !== 'scheduled') return false;
    // The claim is written before the channel is asked, so a crash mid-send is never mistaken for "not sent".
    repo.updateOutbox(item.id, { state: 'sending', claimedAt: iso(now) });
    claim = claimKey({ id: item.id, claimedAt: iso(now) });
    liveClaims.add(claim);
    let result: SendResult;
    let thrown = false;
    try {
      result = await adapter.send(msg);
    } catch (err) {
      thrown = true;
      result = { ok: false, error: { code: 'unknown', message: err instanceof Error && err.message ? err.message : 'Callum could not send this' } };
    }
    if (result.ok) {
      record(ctx, item, person.id, result, subject, body, report);
      return true;
    }
    if (thrown) {
      // Whether it left is unknown, so it is not put back to be sent again.
      repo.updateOutbox(item.id, { state: 'failed', error: result.error.message, detail: JSON.stringify({ thrown: true }), claimedAt: null });
      if (item.origin === 'user') sendFailed(ctx, item, person, result.error.message);
      ctx.bus.emit('outbox');
      return false;
    }
    // The channel said no: nothing left, so the item is back to waiting before the failure decides its fate.
    repo.updateOutbox(item.id, { state: 'scheduled', claimedAt: null });
    onFailure(ctx, item, person, result.error);
    return false;
  } finally {
    sending.delete(item.id);
    if (claim) liveClaims.delete(claim);
  }
}

/**
 * Writes down a send that went out. Only the transaction is tried twice; if it still cannot be written the item is failed,
 * never left to send again. What follows the commit runs once each, and a failure there is reported, not repeated.
 */
function record(
  ctx: Ctx, item: OutboxItem, personId: number, result: Extract<SendResult, { ok: true }>, subject: string | null, body: string,
  report: (err: unknown) => void,
): void {
  let lastError: unknown;
  let written = false;
  for (let attempt = 0; attempt < 2 && !written; attempt++) {
    try {
      writeSent(ctx, item, personId, result, subject, body);
      written = true;
    } catch (err) {
      lastError = err;
    }
  }
  if (!written) {
    try {
      ctx.repo.updateOutbox(item.id, { state: 'failed', error: COULD_NOT_RECORD, detail: JSON.stringify({ maybeSent: true, unrecorded: true }) });
    } catch {
      // The store is not answering at all. The item stays `sending`, which is never picked up again.
    }
    throw lastError;
  }
  if (item.origin === 'user') {
    // The user has taken over: whatever Callum had lined up for them goes, and an earlier notice about this reply is settled.
    for (const step of [() => ctx.outbox.cancelPending(personId, ['auto']), () => resolveSendFailed(ctx, personId, item.channel)]) {
      try {
        step();
      } catch (err) {
        report(err);
      }
    }
  }
  ctx.bus.emit('outbox');
  ctx.bus.emit('people');
}

function writeSent(ctx: Ctx, item: OutboxItem, personId: number, result: Extract<SendResult, { ok: true }>, subject: string | null, body: string): void {
  const { repo } = ctx;
  const now = ctx.clock.now();
  repo.transaction(() => {
    repo.insertMessage({
      personId, channel: item.channel, direction: 'out', kind: item.kind, subject,
      // An invitation that lost its note went out empty: that is what the person got.
      body: result.noteDropped ? '' : body,
      at: iso(now), externalId: result.externalId,
    });
    repo.updateOutbox(item.id, { state: 'sent', error: null, detail: null, claimedAt: null });
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
}

function onFailure(ctx: Ctx, item: OutboxItem, person: Person, error: ChannelError): void {
  const { repo, clock } = ctx;
  const now = clock.now();
  switch (error.code) {
    case 'auth':
      channelSignedOut(ctx, item.channel);
      return;
    case 'checkpoint':
      channelCheckpoint(ctx, item.channel);
      return;
    case 'rate_limit':
      if (item.channel === 'x') {
        channelRateLimited(ctx, 'x', error.message);
      } else {
        const slot = tomorrow(ctx, person);
        repo.updateOutbox(item.id, { sendAfter: iso(slot) });
        // Callum's own messages just wait; the user's reply gets a notice with the time it goes.
        if (item.origin === 'user') replyDeferred(ctx, item, person, slot);
      }
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
