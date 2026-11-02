import type { Correction, Message, OutboxItem, PathStep, Person, Project } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { findPlaceholders } from '../engine/guard.js';
import * as life from '../engine/lifecycle.js';
import { personTz } from '../engine/lifecycle.js';
import { nextMonday } from '../engine/windows.js';
import type { WriteContext } from '../ai/writer.js';
import { PlaceholderError } from '../outbox/outbox.js';
import { planProjectNow } from '../runner/runner.js';
import { canWriteBy, parseWhen, requirePerson, requireProject, userTz } from './common.js';
import { asUserError, UserError, userFacing } from './errors.js';

/** A LinkedIn invitation note can be this long at most. */
const INVITE_NOTE_MAX = 280;
type HandKind = 'reply' | 'booking' | 'close';

function requireItem(ctx: Ctx, id: number): OutboxItem {
  const item = ctx.repo.getOutbox(id);
  if (!item) throw new UserError("Callum can't find that message.", 404);
  return item;
}

/** The words the user typed, trimmed; nothing at all is not a message. */
function cleanBody(body: string): string {
  const text = typeof body === 'string' ? body.trim() : '';
  if (text === '') throw new UserError('Write something first.');
  return text;
}

function checkInvite(kind: OutboxItem['kind'], body: string): void {
  if (kind === 'invite' && body.length > INVITE_NOTE_MAX) throw new UserError(`An invite note can be ${INVITE_NOTE_MAX} characters at most.`);
}

function checkNoBlanks(body: string, subject: string | null): void {
  const found = [...new Set([...(subject ? findPlaceholders(subject) : []), ...findPlaceholders(body)])];
  if (found.length > 0) throw asUserError(new PlaceholderError(found));
}

function writeContext(ctx: Ctx, person: Person, project: Project): WriteContext {
  return {
    person, project, settings: ctx.repo.getSettings(), channel: person.channel ?? 'email', history: ctx.repo.listMessages(person.id),
  };
}

/** Only someone who wrote back (waiting) or is already talking can be written to by hand. */
function assertCanWrite(person: Person): void {
  if (canWriteBy(person)) return;
  if (person.status === 'stopped') throw new UserError(`${person.firstName} asked not to be contacted.`);
  if (person.status === 'closed') throw new UserError(`${person.firstName}'s conversation is closed.`);
  throw new UserError(`${person.firstName} isn't waiting to hear from you.`);
}

function assertOnDock(person: Person): void {
  if (person.status !== 'waiting') throw new UserError(`${person.firstName} isn't on the dock.`);
}

// ---- first hellos ----------------------------------------------------------

/** The user says yes to a hello (optionally with edited words). It leaves after the undo window. */
export function approve(ctx: Ctx, outboxId: number, body?: string): OutboxItem {
  const item = requireItem(ctx, outboxId);
  if (item.state !== 'awaiting_ok') throw new UserError('This message is not waiting for an OK');
  const text = body === undefined ? item.body : cleanBody(body);
  checkInvite(item.kind, text);
  const next = userFacing(() => ctx.outbox.approve(outboxId, body === undefined ? undefined : text));
  ctx.bus.emit('projects');
  return next;
}

/** "Don't contact": the person is stopped, the OK is kept, and the next stranger's hello takes its place. */
export async function skip(ctx: Ctx, outboxId: number): Promise<void> {
  const item = requireItem(ctx, outboxId);
  if (item.state !== 'awaiting_ok') throw new UserError('This hello is not waiting for an OK.');
  const person = requirePerson(ctx, item.personId);
  ctx.repo.transaction(() => {
    ctx.outbox.cancelPending(person.id, ['auto']);
    ctx.repo.updatePerson(person.id, { status: 'stopped', nextTouchAt: null });
  });
  ctx.bus.emit('people');
  ctx.bus.emit('outbox');
  await planProjectNow(ctx, person.projectId, { early: true });
}

/** Takes an approved hello back while its undo window is open. */
export function undo(ctx: Ctx, outboxId: number): OutboxItem {
  requireItem(ctx, outboxId);
  const next = userFacing(() => ctx.outbox.undo(outboxId));
  ctx.bus.emit('projects');
  return next;
}

// ---- messages the user wrote that did not go --------------------------------

function resolveSendFailed(ctx: Ctx, outboxId: number): void {
  const at = ctx.clock.now().toISOString();
  let any = false;
  for (const incident of ctx.repo.listIncidents({ open: true })) {
    if (incident.kind !== 'send_failed' || incident.detail === null) continue;
    let id: unknown;
    try {
      id = (JSON.parse(incident.detail) as { outboxId?: unknown }).outboxId;
    } catch {
      continue;
    }
    if (id !== outboxId) continue;
    ctx.repo.updateIncident(incident.id, { state: 'resolved', resolvedAt: at });
    any = true;
  }
  if (any) ctx.bus.emit('incidents');
}

/** Sends the same words again. The failed one is replaced and its incident is settled. */
export function retry(ctx: Ctx, outboxId: number): OutboxItem {
  const item = requireItem(ctx, outboxId);
  if (item.state !== 'failed' || item.origin !== 'user') throw new UserError('Only a message that did not go out can be tried again.');
  const person = requirePerson(ctx, item.personId);
  assertCanWrite(person);
  const kind = item.kind as HandKind;
  const next = userFacing(() => ctx.outbox.queueUserSend(item.personId, kind, item.body, item.subject));
  ctx.repo.updateOutbox(item.id, { state: 'cancelled' });
  resolveSendFailed(ctx, item.id);
  ctx.bus.emit('outbox');
  return next;
}

/** The user fixed the words of a message Callum would not send. It goes back in line (or back for an OK). */
export function editBlocked(ctx: Ctx, outboxId: number, body: string, subject?: string | null): OutboxItem {
  const item = requireItem(ctx, outboxId);
  if (item.state !== 'blocked') throw new UserError('This message is not stuck.');
  const text = cleanBody(body);
  const nextSubject = subject === undefined ? item.subject : subject;
  checkInvite(item.kind, text);
  checkNoBlanks(text, nextSubject);
  const person = requirePerson(ctx, item.personId);
  if (item.origin === 'user') {
    const next = userFacing(() => ctx.outbox.queueUserSend(item.personId, item.kind as HandKind, text, nextSubject));
    ctx.repo.updateOutbox(item.id, { state: 'cancelled' });
    ctx.bus.emit('outbox');
    return next;
  }
  const project = requireProject(ctx, person.projectId);
  const needsOk = !item.approvalCounted && project.approvalsLeft > 0 && (item.kind === 'hello' || item.kind === 'invite');
  const now = ctx.clock.now().getTime();
  const next = ctx.repo.updateOutbox(item.id, {
    body: text, subject: nextSubject, error: null, state: needsOk ? 'awaiting_ok' : 'scheduled',
    sendAfter: new Date(Math.max(now, new Date(item.sendAfter).getTime())).toISOString(),
  });
  ctx.bus.emit('outbox');
  return next;
}

// ---- the dock ----------------------------------------------------------------

function sendByHand(ctx: Ctx, person: Person, kind: HandKind, body: string): OutboxItem {
  assertCanWrite(person);
  if (!person.channel) throw new UserError(`Callum has no way to reach ${person.firstName} yet.`);
  return userFacing(() => ctx.outbox.queueUserSend(person.id, kind, cleanBody(body)));
}

/** Sends the user's reply (with Undo). */
export function reply(ctx: Ctx, personId: number, body: string): OutboxItem {
  return sendByHand(ctx, requirePerson(ctx, personId), 'reply', body);
}

function calendarOf(project: Project): string {
  const url = project.calendarUrl?.trim();
  if (!url) throw new UserError('Add your calendar link first');
  return url;
}

/** Sends the calendar link. The words are Callum's unless the user wrote their own. */
export async function book(ctx: Ctx, personId: number, body?: string): Promise<OutboxItem> {
  const person = requirePerson(ctx, personId);
  const project = requireProject(ctx, person.projectId);
  calendarOf(project);
  assertCanWrite(person);
  const text = body ?? (await ctx.writer.write('booking', writeContext(ctx, person, project))).body;
  return sendByHand(ctx, requirePerson(ctx, personId), 'booking', text);
}

/** A short polite close. */
export async function close(ctx: Ctx, personId: number, body?: string): Promise<OutboxItem> {
  const person = requirePerson(ctx, personId);
  const project = requireProject(ctx, person.projectId);
  assertCanWrite(person);
  const text = body ?? (await ctx.writer.write('close', writeContext(ctx, person, project))).body;
  return sendByHand(ctx, requirePerson(ctx, personId), 'close', text);
}

/** The words to start the editor with: Callum's saved draft for a reply, else a fresh one. */
export async function draft(ctx: Ctx, personId: number, kind: 'reply' | 'booking' | 'close'): Promise<string> {
  const person = requirePerson(ctx, personId);
  const project = requireProject(ctx, person.projectId);
  if (kind === 'booking') calendarOf(project);
  if (kind === 'reply' && person.draft?.trim()) return person.draft;
  return (await ctx.writer.write(kind, writeContext(ctx, person, project))).body;
}

/** Back on the dock at the time given, by default next Monday at 9:00 in the user's time zone. */
export function snooze(ctx: Ctx, personId: number, until?: string): Person {
  const person = requirePerson(ctx, personId);
  assertOnDock(person);
  const now = ctx.clock.now();
  let when: Date;
  if (until === undefined) {
    when = nextMonday(now, userTz(ctx), 9);
  } else {
    when = parseWhen(until);
    if (when.getTime() <= now.getTime()) throw new UserError('Pick a date in the future.');
  }
  const next = ctx.repo.updatePerson(person.id, life.snooze(person, when));
  ctx.bus.emit('people');
  return next;
}

/** Callum read the reply wrongly. */
export function correct(ctx: Ctx, personId: number, kind: Correction): Person {
  const person = requirePerson(ctx, personId);
  assertOnDock(person);
  const patch = life.correct(person, kind, ctx.clock.now(), personTz(person, userTz(ctx)));
  const next = ctx.repo.transaction(() => {
    if (kind !== 'auto_reply') ctx.outbox.cancelPending(person.id, ['auto', 'user']);
    return ctx.repo.updatePerson(person.id, patch);
  });
  ctx.bus.emit('people');
  ctx.bus.emit('outbox');
  return next;
}

// ---- faces -------------------------------------------------------------------

/** Makes the next touch due now. It still waits for sending hours and the daily limits. */
export function nudge(ctx: Ctx, personId: number): Person {
  const person = requirePerson(ctx, personId);
  if (person.status !== 'active') throw new UserError(`Callum can't nudge ${person.firstName} right now.`);
  if (life.nextKind(person) === null) throw new UserError(`Callum has nothing more to send ${person.firstName}.`);
  const next = ctx.repo.updatePerson(person.id, life.nudge(person, ctx.clock.now()));
  ctx.bus.emit('people');
  return next;
}

/** Nothing goes to them until Resume. */
export function hold(ctx: Ctx, personId: number): Person {
  const person = requirePerson(ctx, personId);
  if (person.status === 'held') throw new UserError(`${person.firstName} is already on hold.`);
  if (person.status !== 'active') throw new UserError(`Callum can't put ${person.firstName} on hold right now.`);
  const next = ctx.repo.transaction(() => {
    ctx.outbox.cancelPending(person.id, ['auto']);
    return ctx.repo.updatePerson(person.id, life.hold(person));
  });
  ctx.bus.emit('people');
  ctx.bus.emit('outbox');
  return next;
}

export function resume(ctx: Ctx, personId: number): Person {
  const person = requirePerson(ctx, personId);
  if (person.status !== 'held') throw new UserError(`${person.firstName} isn't on hold.`);
  const next = ctx.repo.updatePerson(person.id, life.resume(person, ctx.clock.now(), personTz(person, userTz(ctx))));
  ctx.bus.emit('people');
  return next;
}

/** "Not a fit", from the list of people before Start. Someone who asked to stop stays stopped. */
export function remove(ctx: Ctx, personId: number): Person {
  const person = requirePerson(ctx, personId);
  if (person.status === 'stopped') throw new UserError(`${person.firstName} asked not to be contacted.`);
  if (person.status === 'removed') return person;
  if (person.replyKind !== null || person.stage === 'talking' || person.status === 'waiting' || person.status === 'snoozed' || person.status === 'closed') {
    throw new UserError(`${person.firstName} has written back, so Callum keeps them.`);
  }
  const next = ctx.repo.transaction(() => {
    ctx.outbox.cancelPending(person.id, ['auto']);
    return ctx.repo.updatePerson(person.id, { status: 'removed', nextTouchAt: null });
  });
  ctx.bus.emit('people');
  ctx.bus.emit('outbox');
  return next;
}

export function personDetail(ctx: Ctx, personId: number): { person: Person; messages: Message[]; path: PathStep[] } {
  const person = requirePerson(ctx, personId);
  return { person, messages: ctx.repo.listMessages(person.id), path: life.touchPath(person, personTz(person, userTz(ctx))) };
}
