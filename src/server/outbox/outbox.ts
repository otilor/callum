import type { Bus } from '../bus.js';
import type { Repo } from '../db/repo.js';
import type { Clock } from '../engine/clock.js';
import { findPlaceholders } from '../engine/guard.js';
import type { Channel, OutboxItem, OutKind } from '../../shared/types.js';

export const UNDO_MS = 10_000;

export class PlaceholderError extends Error {
  constructor(public placeholders: string[]) {
    super(`Message still has ${placeholders.join(', ')} in it`);
    this.name = 'PlaceholderError';
  }
}

export class UndoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndoError';
  }
}

export class Outbox {
  constructor(
    private repo: Repo,
    private clock: Clock,
    private bus: Bus,
  ) {}

  /** A message the user wrote by hand: goes out after the undo window. */
  queueUserSend(
    personId: number,
    kind: 'reply' | 'booking' | 'close',
    body: string,
    subject: string | null = null,
  ): OutboxItem {
    this.assertNoPlaceholders(body, subject);
    const { channel } = this.personChannel(personId);
    const now = this.clock.now().getTime();
    const at = this.afterUndoWindow().toISOString();
    const item = this.repo.transaction(() => {
      // An earlier message whose undo window has closed is already on its way: leave it.
      for (const old of this.repo.listOutbox({ personId, state: ['scheduled'] })) {
        if (old.origin === 'user' && old.undoUntil !== null && new Date(old.undoUntil).getTime() > now) {
          this.repo.updateOutbox(old.id, { state: 'cancelled' });
        }
      }
      return this.repo.insertOutbox({
        personId, channel, kind, body, subject,
        state: 'scheduled', origin: 'user', sendAfter: at, undoUntil: at,
      });
    });
    this.bus.emit('outbox');
    return item;
  }

  /**
   * A message Callum wrote. Placeholders are allowed in here on purpose: the runner
   * blocks them at send time so the user sees what is wrong.
   */
  queueAuto(
    personId: number,
    kind: OutKind,
    body: string,
    subject: string | null,
    sendAfter: Date,
    awaitingOk: boolean,
  ): OutboxItem {
    const { channel } = this.personChannel(personId);
    const item = this.repo.insertOutbox({
      personId, channel, kind, body, subject,
      state: awaitingOk ? 'awaiting_ok' : 'scheduled', origin: 'auto', sendAfter: sendAfter.toISOString(),
    });
    this.bus.emit('outbox');
    return item;
  }

  /** The user says yes to a message waiting for an OK. Starts the undo window. */
  approve(id: number, editedBody?: string): OutboxItem {
    const item = this.require(id);
    if (item.state !== 'awaiting_ok') throw new UndoError('This message is not waiting for an OK');
    const body = editedBody ?? item.body;
    this.assertNoPlaceholders(body, item.subject);
    const undoUntil = this.afterUndoWindow();
    const sendAfter = new Date(Math.max(new Date(item.sendAfter).getTime(), undoUntil.getTime()));
    const next = this.repo.transaction(() => {
      const left = this.repo.getSettings().approvalsLeft;
      const counted = left > 0;
      if (counted) this.repo.updateSettings({ approvalsLeft: left - 1 });
      return this.repo.updateOutbox(id, {
        body, state: 'scheduled', sendAfter: sendAfter.toISOString(), undoUntil: undoUntil.toISOString(),
        approvalCounted: counted,
      });
    });
    this.bus.emit('outbox');
    return next;
  }

  /** Take a message back while its undo window is still open. */
  undo(id: number): OutboxItem {
    const item = this.require(id);
    const open = item.state === 'scheduled' && item.undoUntil !== null
      && new Date(item.undoUntil).getTime() > this.clock.now().getTime();
    if (!open) throw new UndoError('Too late to undo');
    const next = this.repo.transaction(() => {
      if (item.origin === 'user') return this.repo.updateOutbox(id, { state: 'cancelled' });
      if (item.approvalCounted) {
        this.repo.updateSettings({ approvalsLeft: this.repo.getSettings().approvalsLeft + 1 });
      }
      return this.repo.updateOutbox(id, { state: 'awaiting_ok', undoUntil: null, approvalCounted: false });
    });
    this.bus.emit('outbox');
    return next;
  }

  /** Cancel what is still waiting for a person. Returns how many were cancelled. */
  cancelPending(personId: number, origins: ('auto' | 'user')[] = ['auto']): number {
    const items = this.repo
      .listOutbox({ personId, state: ['awaiting_ok', 'scheduled'] })
      .filter((i) => origins.includes(i.origin));
    this.repo.transaction(() => {
      for (const i of items) this.repo.updateOutbox(i.id, { state: 'cancelled' });
    });
    if (items.length > 0) this.bus.emit('outbox');
    return items.length;
  }

  due(): OutboxItem[] {
    return this.repo.listOutbox({ state: ['scheduled'], dueBefore: this.clock.now().toISOString() });
  }

  pendingFor(personId: number): OutboxItem[] {
    return this.repo.listOutbox({ personId, state: ['awaiting_ok', 'scheduled'] });
  }

  private afterUndoWindow(): Date {
    return new Date(this.clock.now().getTime() + UNDO_MS);
  }

  private personChannel(personId: number): { channel: Channel } {
    const person = this.repo.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    if (!person.channel) throw new Error(`${person.firstName} has no channel to send on yet`);
    return { channel: person.channel };
  }

  private require(id: number): OutboxItem {
    const item = this.repo.getOutbox(id);
    if (!item) throw new Error(`Outbox item ${id} not found`);
    return item;
  }

  private assertNoPlaceholders(body: string, subject: string | null): void {
    const found = [...new Set([...(subject ? findPlaceholders(subject) : []), ...findPlaceholders(body)])];
    if (found.length > 0) throw new PlaceholderError(found);
  }
}
