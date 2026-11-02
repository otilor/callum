import type { Channel, NewMessage, Person } from '../../shared/types.js';
import type { InboundEvent } from '../channels/types.js';
import type { Ctx } from '../context.js';
import { afterUserSent, chooseChannel, onAccepted, onInbound, personTz } from '../engine/lifecycle.js';
import { importPeople } from '../leads/import.js';
import { channelCheckpoint, handleBounce } from './incidents.js';

type Reply = Extract<InboundEvent, { type: 'reply' }>;

/** People who must never be touched by an event: they said stop or are gone. */
const finished = (p: Person): boolean => p.status === 'stopped' || p.status === 'removed';

function atOf(ctx: Ctx, iso: string): Date {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? ctx.clock.now() : d;
}

/** Applies what a channel reported, in order. An error leaves the rest for the next poll. */
export async function handleInbound(ctx: Ctx, ch: Channel, events: InboundEvent[]): Promise<void> {
  for (const event of events) {
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
  const { patch, cancelPending, toDock } = onInbound(current, classification, event.text, at, personTz(current, settings.timezone));
  let draft: string | undefined;
  if (toDock) {
    const written = await writer.write('reply', { ...write, person: { ...current, ...patch } });
    draft = written.body;
  }

  // The writer may have taken a while; someone else may have stopped them in the meantime.
  const latest = repo.getPerson(found.id);
  if (seen()) return;
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
  if (!person || finished(person) || person.status === 'closed' || person.stage === 'talking') return;
  repo.transaction(() => {
    repo.updatePerson(person.id, afterUserSent(person, 'reply', atOf(ctx, atIso)));
    ctx.outbox.cancelPending(person.id, ['auto']);
  });
  ctx.bus.emit('people');
}
