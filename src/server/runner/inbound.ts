import type { Channel, NewMessage, Person } from '../../shared/types.js';
import type { InboundEvent } from '../channels/types.js';
import type { Ctx } from '../context.js';
import { afterUserSent, chooseChannel, onAccepted, onInbound, personTz } from '../engine/lifecycle.js';
import { importPeople } from '../leads/import.js';
import { INCIDENT_COPY, channelCheckpoint, handleBounce, openIncident } from './incidents.js';

type Reply = Extract<InboundEvent, { type: 'reply' }>;

/** People who must never be touched by an event: they said stop or are gone. */
const finished = (p: Person): boolean => p.status === 'stopped' || p.status === 'removed';

function atOf(ctx: Ctx, iso: string): Date {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? ctx.clock.now() : d;
}

export const MAX_INBOUND_ATTEMPTS = 5;
const RETRY_STEP_MS = 60_000;

/**
 * Applies what a channel reported, in order. Each event stands alone: one that fails is kept (see `inbound_failed`) to be
 * tried again, reported, and the rest still go through. Adapters mark events seen when they return them, so an event
 * that is dropped here would never come again.
 */
export async function handleInbound(ctx: Ctx, ch: Channel, events: InboundEvent[], report?: (err: unknown) => void): Promise<void> {
  for (const event of events) {
    try {
      await handleEvent(ctx, ch, event);
    } catch (err) {
      keepFailed(ctx, ch, event, err);
      report?.(err);
    }
  }
}

/** One event. Throws when it cannot be handled; nothing is half-applied. */
export async function handleEvent(ctx: Ctx, ch: Channel, event: InboundEvent): Promise<void> {
  switch (event.type) {
    case 'reply':
      await onReply(ctx, ch, event);
      break;
    case 'accepted':
      onAcceptedInvite(ctx, event.linkedinUrl, event.at);
      break;
    case 'bounce': {
      const person = ctx.repo.findPersonByHandle({ email: event.email });
      if (person) handleBounce(ctx, person.id, 'email');
      break;
    }
    case 'outbound_seen':
      onOutboundSeen(ctx, event.email, event.externalId, event.at);
      break;
    case 'checkpoint':
      channelCheckpoint(ctx, ch);
      break;
  }
}

function personOf(ctx: Ctx, event: InboundEvent): number | null {
  switch (event.type) {
    case 'reply':
      return ctx.repo.findPersonByHandle({ email: event.from.email ?? null, linkedinUrl: event.from.linkedinUrl ?? null, xHandle: event.from.xHandle ?? null })?.id ?? null;
    case 'accepted': return ctx.repo.findPersonByHandle({ linkedinUrl: event.linkedinUrl })?.id ?? null;
    case 'bounce':
    case 'outbound_seen': return ctx.repo.findPersonByHandle({ email: event.email })?.id ?? null;
    case 'checkpoint': return null;
  }
}

function keepFailed(ctx: Ctx, ch: Channel, event: InboundEvent, err: unknown): void {
  const json = JSON.stringify(event);
  const message = err instanceof Error ? err.message : String(err);
  const externalId = 'externalId' in event ? event.externalId : null;
  try {
    const same = ctx.repo.listInboundFailures().find((f) => f.channel === ch && f.event === json);
    if (same) ctx.repo.updateInboundFailure(same.id, { attempts: same.attempts, error: message });
    else ctx.repo.insertInboundFailure({ channel: ch, externalId, personId: personOf(ctx, event), event: json, error: message });
  } catch {
    // The store itself is failing; the error is still reported by the caller.
  }
}

/** People with an inbound event that has not been read yet. Nothing automatic goes to them until it has been. */
export function heldBackPeople(ctx: Ctx): Set<number> {
  const held = new Set<number>();
  for (const f of ctx.repo.listInboundFailures()) {
    if (f.personId !== null && f.attempts < MAX_INBOUND_ATTEMPTS) held.add(f.personId);
  }
  return held;
}

const CHANNEL_NAME: Record<Channel, string> = { email: 'email', linkedin: 'LinkedIn', x: 'X' };

/**
 * A reply that cannot be read is never left silent: it is stored as it came, the person goes on the dock without a
 * draft (nothing automatic reaches them there), and the user is told. Without a match only the notice is possible.
 */
function giveUp(ctx: Ctx, ch: Channel, event: InboundEvent): void {
  if (event.type !== 'reply') return;
  const { repo } = ctx;
  const person = repo.findPersonByHandle({
    email: event.from.email ?? null, linkedinUrl: event.from.linkedinUrl ?? null, xHandle: event.from.xHandle ?? null,
  });
  if (!person) {
    openIncident(ctx, { channel: ch, kind: 'reply_unread', message: INCIDENT_COPY.reply_unread_unknown(CHANNEL_NAME[ch]) });
    return;
  }
  const at = atOf(ctx, event.at);
  repo.transaction(() => {
    if (!(event.externalId && repo.hasMessageWithExternalId(ch, event.externalId, 'in'))) {
      repo.insertMessage({
        personId: person.id, channel: ch, direction: 'in', kind: 'inbound', subject: null, body: event.text,
        at: at.toISOString(), externalId: event.externalId,
      });
    }
    // Someone who said stop or was removed stays that way; everyone else is on the dock.
    if (!finished(person)) {
      repo.updatePerson(person.id, { status: 'waiting', draft: null, lastInbound: event.text, repliedAt: at.toISOString(), nextTouchAt: null });
      ctx.outbox.cancelPending(person.id, ['auto']);
    }
  });
  openIncident(ctx, { channel: ch, kind: 'reply_unread', message: INCIDENT_COPY.reply_unread(person.firstName), personId: person.id });
  ctx.bus.emit('people');
}

/** Tries the kept events again, a little later each time, up to five attempts. */
export async function retryFailedInbound(ctx: Ctx, report?: (err: unknown) => void): Promise<void> {
  const now = ctx.clock.now().getTime();
  for (const f of ctx.repo.listInboundFailures()) {
    if (f.attempts >= MAX_INBOUND_ATTEMPTS) continue;
    if (new Date(f.updatedAt).getTime() + f.attempts * RETRY_STEP_MS > now) continue;
    try {
      await handleEvent(ctx, f.channel, JSON.parse(f.event) as InboundEvent);
      ctx.repo.deleteInboundFailure(f.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.repo.updateInboundFailure(f.id, { attempts: f.attempts + 1, error: message });
      if (f.attempts + 1 >= MAX_INBOUND_ATTEMPTS) {
        report?.(new Error(`Callum gave up on a ${f.channel} message after ${MAX_INBOUND_ATTEMPTS} tries: ${message}`));
        try {
          giveUp(ctx, f.channel, JSON.parse(f.event) as InboundEvent);
        } catch (err) {
          report?.(err);
        }
      }
    }
  }
}

async function onReply(ctx: Ctx, ch: Channel, event: Reply): Promise<void> {
  const { repo, writer } = ctx;
  // Adapters only remember what they have seen in this run, so the stored messages are the record.
  const seen = () => event.externalId !== null && repo.hasMessageWithExternalId(ch, event.externalId, 'in');
  if (seen()) return;
  const found = repo.findPersonByHandle({
    email: event.from.email ?? null, linkedinUrl: event.from.linkedinUrl ?? null, xHandle: event.from.xHandle ?? null,
  });
  if (!found) return;

  const at = atOf(ctx, event.at);
  const message: NewMessage = {
    personId: found.id, channel: ch, direction: 'in', kind: 'inbound', subject: null, body: event.text,
    at: at.toISOString(), externalId: event.externalId,
  };
  const project = repo.getProject(found.projectId);
  // Someone who said stop, or was removed, stays that way however they write.
  if (finished(found) || !project) {
    repo.insertMessage(message);
    ctx.bus.emit('people');
    return;
  }

  // Read it before it is stored: if the writer fails, the next poll brings the same message and it is not skipped as seen.
  const settings = repo.getSettings();
  const write = {
    person: found, project, settings, channel: ch,
    history: [...repo.listMessages(found.id), { ...message, id: 0 }],
  };
  const classification = await writer.classify(event.text, write);

  const current = repo.getPerson(found.id);
  if (!current || finished(current)) {
    repo.insertMessage(message);
    ctx.bus.emit('people');
    return;
  }
  const first = onInbound(current, classification, event.text, at, personTz(current, settings.timezone));
  let draft: string | undefined;
  if (first.toDock) {
    const written = await writer.write('reply', { ...write, person: { ...current, ...first.patch } });
    draft = written.body;
  }

  // The writer may have taken a while; the person may have changed or been stopped in the meantime. Work from what is true now.
  const latest = repo.getPerson(found.id);
  if (seen()) return;
  const { patch, cancelPending } = latest && !finished(latest)
    ? onInbound(latest, classification, event.text, at, personTz(latest, settings.timezone))
    : first;
  repo.transaction(() => {
    repo.insertMessage(message);
    if (!latest || finished(latest)) return;
    repo.updatePerson(found.id, draft === undefined ? patch : { ...patch, draft });
    if (cancelPending) {
      const stops = classification.kind === 'stop' || classification.kind === 'hostile';
      // Someone who asked not to hear from us gets nothing, not even a reply the user had lined up.
      ctx.outbox.cancelPending(found.id, stops ? ['auto', 'user'] : ['auto']);
    } else if (patch.nextTouchAt) {
      // An out-of-office note moves the follow-up that is already lined up, too.
      for (const item of ctx.outbox.pendingFor(found.id)) {
        if (item.origin === 'auto' && item.sendAfter < patch.nextTouchAt) repo.updateOutbox(item.id, { sendAfter: patch.nextTouchAt });
      }
    }
    if (classification.kind === 'referral' && classification.referral) {
      const { name, email, context } = classification.referral;
      const result = importPeople(repo, current.projectId, [{ name, source: 'referral', note: context, ...(email ? { email } : {}) }]);
      const usable = repo.listChannels().filter((c) => c.status === 'connected').map((c) => c.channel);
      for (const added of result.added) {
        const channel = chooseChannel(added, usable);
        if (channel) repo.updatePerson(added.id, { channel });
      }
    }
  });
  ctx.bus.emit('people');
  ctx.bus.emit('outbox');
}

function onAcceptedInvite(ctx: Ctx, linkedinUrl: string, atIso: string): void {
  const person = ctx.repo.findPersonByHandle({ linkedinUrl });
  // Only people Callum invited: an old connection shows up on that page too.
  if (!person || person.linkedinState !== 'invited' || finished(person) || person.status === 'closed') return;
  const tz = personTz(person, ctx.repo.getSettings().timezone);
  ctx.repo.updatePerson(person.id, onAccepted(person, atOf(ctx, atIso), tz));
  ctx.bus.emit('people');
}

function onOutboundSeen(ctx: Ctx, email: string, externalId: string | null, atIso: string): void {
  const { repo } = ctx;
  // Callum's own sends show up in the Sent folder too.
  if (externalId && repo.hasMessageWithExternalId('email', externalId, 'out')) return;
  const person = repo.findPersonByHandle({ email });
  if (!person || finished(person) || person.status === 'closed' || (person.stage === 'talking' && person.status !== 'waiting')) return;
  repo.transaction(() => {
    // Someone waiting on the dock was answered by hand: they are talking now, the draft goes, and so does anything
    // Callum or the user had lined up for them.
    repo.updatePerson(person.id, afterUserSent(person, 'reply', atOf(ctx, atIso)));
    ctx.outbox.cancelPending(person.id, ['auto', 'user']);
  });
  ctx.bus.emit('people');
}
