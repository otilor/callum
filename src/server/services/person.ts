import {
  CHANNELS,
  type Availability, type Channel, type Message, type OutboxItem, type PathState, type PersonFull, type PersonPathStep, type Person, type Project,
  type ProjectMove, type Switchable,
} from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { normalizeEmail, normalizeLinkedinUrl, normalizeXHandle } from '../db/handles.js';
import {
  canMoveProject, CHANNEL_SWITCH_GAP_DAYS, nextKind, nextTouchTime, personTz, REST_AFTER_LAST_DAYS, INVITE_TIMEOUT_DAYS, MAX_TOUCHES,
  switchChannel, touchPath, wake,
} from '../engine/lifecycle.js';
import { addDays, localParts } from '../engine/time.js';
import { firstSlotAfterStart, nextSendingTime } from '../engine/windows.js';
import { UNDO_MS } from '../outbox/outbox.js';
import { UserError } from './errors.js';

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const NAME: Record<Channel, string> = { email: 'email', linkedin: 'LinkedIn', x: 'X' };
const BY: Record<Channel, string> = { email: 'by email', linkedin: 'on LinkedIn', x: 'on X' };
const LAST_MESSAGE: Record<Channel, string> = { email: 'email', linkedin: 'LinkedIn message', x: 'X message' };
const USER_KINDS = new Set(['reply', 'booking', 'close']);

// ---- words for times ------------------------------------------------------------------------------------

const dayNumber = (d: Date, tz: string): number => {
  const p = localParts(d, tz);
  return Date.UTC(p.year, p.month - 1, p.day) / DAY_MS;
};

/** `today`, `tomorrow`, `Thursday` inside the coming week, then `19 November`. */
export function dayText(at: Date, tz: string, now: Date): string {
  const ahead = dayNumber(at, tz) - dayNumber(now, tz);
  if (ahead === 0) return 'today';
  if (ahead === 1) return 'tomorrow';
  if (ahead > 1 && ahead < 7) return WEEKDAYS[localParts(at, tz).weekday] ?? '';
  const p = localParts(at, tz);
  return `${p.day} ${MONTHS[p.month - 1]}`;
}

const clockText = (at: Date, tz: string): string => {
  const p = localParts(at, tz);
  return `${p.hour}:${String(p.minute).padStart(2, '0')}`;
};

/** `Thursday at 9:00`. */
export const slotText = (at: Date, tz: string, now: Date): string => `${dayText(at, tz, now)} at ${clockText(at, tz)}`;

const iso = (d: Date): string => d.toISOString();
const ms = (s: string | null): number | null => (s === null ? null : new Date(s).getTime());

// ---- who can do what ------------------------------------------------------------------------------------

function requirePerson(ctx: Ctx, id: number): Person {
  const person = ctx.repo.getPerson(id);
  if (!person) throw new UserError("Callum can't find that person.", 404);
  return person;
}

const handleOf = (p: Person, ch: Channel): string | null => (ch === 'email' ? p.email : ch === 'linkedin' ? p.linkedinUrl : p.xHandle);

function connectedChannels(ctx: Ctx): Channel[] {
  return ctx.repo.listChannels().filter((a) => a.status !== 'disconnected').map((a) => a.channel);
}

/** Why a person's channel cannot change right now, or null when it can. */
function moveBlock(p: Person): string | null {
  const first = p.firstName;
  if (p.status === 'stopped') return `${first} asked not to be contacted.`;
  if (p.status === 'closed' || p.status === 'removed') return `${first}'s conversation is closed.`;
  if (p.status === 'resting') return `${first} is resting. Bring ${first} back first.`;
  if (p.status === 'held') return `Resume ${first} first.`;
  if (p.status === 'waiting' || p.status === 'snoozed' || p.stage === 'talking') {
    return `${first} is talking with you${p.channel ? ` on ${NAME[p.channel]}` : ''}, so Callum keeps it there.`;
  }
  return null;
}

/**
 * When Callum could start writing to a person on a new channel: a week after the last message, inside sending hours.
 * `inGap` is true while that week has not passed yet.
 */
export function canSwitchAt(ctx: Ctx, person: Person): { at: Date; inGap: boolean } {
  const now = ctx.clock.now();
  const tz = personTz(person, ctx.repo.getSettings().timezone);
  const last = ms(person.lastTouchAt);
  const gapEnds = last === null ? now : addDays(new Date(last), CHANNEL_SWITCH_GAP_DAYS);
  const earliest = gapEnds.getTime() > now.getTime() ? gapEnds : now;
  return { at: nextSendingTime(earliest, tz), inGap: gapEnds.getTime() > now.getTime() };
}

function switchables(ctx: Ctx, p: Person, connected: Channel[]): Switchable[] {
  const userTz = ctx.repo.getSettings().timezone;
  const now = ctx.clock.now();
  const block = moveBlock(p);
  const out: Switchable[] = [];
  for (const channel of CHANNELS) {
    if (channel === p.channel || !connected.includes(channel)) continue;
    if (block) {
      out.push({ channel, at: null, reason: block, available: false });
      continue;
    }
    const { at, inGap } = canSwitchAt(ctx, p);
    if (handleOf(p, channel) === null) {
      out.push({ channel, at: null, reason: `Add ${p.firstName}'s ${NAME[channel]} first`, available: true });
    } else if (inGap) {
      const noun = p.channel ? LAST_MESSAGE[p.channel] : 'message';
      out.push({
        channel, at: iso(at), available: true,
        reason: `Callum can switch ${p.firstName} to ${NAME[channel]} from ${dayText(at, userTz, now)}, a week after the last ${noun}.`,
      });
    } else {
      out.push({ channel, at: iso(at), reason: null, available: true });
    }
  }
  return out;
}

/** The reason a person cannot move to another project, in the words of the move itself. */
function projectMoveReason(ctx: Ctx, p: Person): string | null {
  const verdict = canMoveProject(p);
  if (verdict.ok) return null;
  const from = ctx.repo.getProject(p.projectId)?.name ?? 'another project';
  switch (verdict.reason) {
    case 'talking':
    case 'waiting':
      return `${p.firstName} is talking with you about ${from}. Finish that conversation first.`;
    case 'in_progress':
      return `${p.firstName} has already heard from you about ${from}. Callum can move them once they're resting.`;
    case 'stopped':
      return `${p.firstName} asked not to be contacted.`;
    case 'closed':
      return `${p.firstName}'s conversation is closed.`;
  }
}

// ---- what comes next ------------------------------------------------------------------------------------

interface Plan { line: string | null; at: Date | null }

const KIND_LABEL: Record<string, string> = { hello: 'First hello', invite: 'The invite', thanks: 'The thank-you', follow_up: 'Follow-up' };

function plan(ctx: Ctx, p: Person, project: Project | null, pending: OutboxItem[], connected: Channel[]): Plan {
  const first = p.firstName;
  const now = ctx.clock.now();
  const userTz = ctx.repo.getSettings().timezone;
  const tz = personTz(p, userTz);
  const none = (line: string | null): Plan => ({ line, at: null });

  switch (p.status) {
    case 'stopped': return none(`Nothing goes to ${first}, ever again`);
    case 'closed': return none(`Nothing more goes to ${first}`);
    case 'removed': return none(null);
    case 'held': return none(`Nothing goes to ${first} until you resume`);
    case 'resting': {
      const until = p.restUntil === null ? null : new Date(p.restUntil);
      return none(until ? `${first} rests until ${dayText(until, userTz, now)}, then starts again as a stranger` : `${first} is resting, then starts again as a stranger`);
    }
    case 'waiting': return none(`${first} wrote back and is waiting for your answer`);
    case 'snoozed': {
      const until = p.snoozedUntil === null ? null : new Date(p.snoozedUntil);
      return none(until ? `You snoozed ${first} until ${slotText(until, userTz, now)}` : `You snoozed ${first}`);
    }
    case 'active': break;
  }
  if (p.stage === 'talking') return none(`${first} is talking with you, so Callum stays out of it`);
  if (project && project.state === 'wrapped') return none(`${project.name} is wrapped up, so nothing goes to ${first}`);
  if (project && project.state === 'paused') return none(`${project.name} is paused, so nothing goes to ${first} yet`);
  if (project && project.startedAt === null) return none(`Callum starts on ${first} once you press Start`);

  const channel = p.channel;
  const queued = pending.find((i) => i.origin === 'auto');
  if (queued && channel) {
    const at = new Date(queued.sendAfter);
    const label = KIND_LABEL[queued.kind] ?? 'The next message';
    if (queued.state === 'awaiting_ok') return { line: `${label} waits for your OK before it goes ${BY[channel]}`, at };
    return { line: `${label} goes out ${slotText(at, userTz, now)} ${BY[channel]}`, at };
  }

  const kind = nextKind(p);
  if (kind === null) {
    const last = ms(p.lastTouchAt);
    if (p.touches >= MAX_TOUCHES && last !== null) {
      const restFrom = addDays(new Date(last), REST_AFTER_LAST_DAYS);
      return none(`That was the last follow-up. If ${first} stays quiet, ${first} rests from ${dayText(restFrom, userTz, now)}.`);
    }
    const invited = ms(p.invitedAt);
    if (p.linkedinState === 'invited' && invited !== null) {
      const giveUp = addDays(new Date(invited), INVITE_TIMEOUT_DAYS);
      return none(`Waiting for ${first} to accept the invite. If nothing comes, ${first} rests from ${dayText(giveUp, userTz, now)}.`);
    }
    return none(null);
  }
  const via = channel ?? connected.find((c) => handleOf(p, c) !== null) ?? null;
  if (via === null) return none(`Callum has no connected channel that reaches ${first}`);

  let due: Date | null = p.nextTouchAt === null ? null : new Date(p.nextTouchAt);
  if (due === null) {
    if (p.stage === 'stranger' && p.touches === 0) {
      const started = project?.startedAt ? new Date(project.startedAt) : now;
      const slot = firstSlotAfterStart(started, tz);
      due = slot.getTime() > now.getTime() ? slot : nextSendingTime(now, tz);
    } else {
      due = nextTouchTime(p, now, tz);
    }
  }
  if (due === null) return none(null);
  const at = due.getTime() > now.getTime() ? due : nextSendingTime(now, tz);
  const label = kind === 'follow_up' && p.touches >= 2 ? 'Last follow-up' : (KIND_LABEL[kind] ?? 'The next message');
  return { line: `${label} goes out ${slotText(at, userTz, now)} ${BY[via]}`, at };
}

function whyLine(ctx: Ctx, p: Person, connected: Channel[]): string | null {
  const first = p.firstName;
  if (p.status === 'stopped') return `Callum also skips ${first} in any list you bring later.`;
  if (p.status === 'resting') return 'Resting keeps you persistent without being pushy. Three messages, then 90 days of quiet.';
  switch (p.channel) {
    case 'email': return `Callum picked email because ${first}'s address is verified.`;
    case 'linkedin':
      if (!p.email) return `Callum picked LinkedIn because ${first} is on LinkedIn and has no email.`;
      if (!connected.includes('email')) return "Callum picked LinkedIn because email isn't connected.";
      return `Callum is reaching ${first} on LinkedIn.`;
    case 'x':
      if (!p.email && !p.linkedinUrl) return `Callum picked X because ${first} is only reachable on X.`;
      return `Callum is reaching ${first} on X.`;
    default: return null;
  }
}

function closedNote(p: Person): string | null {
  const first = p.firstName;
  if (p.status === 'stopped') {
    if (p.replyKind === 'stop') return `${first} asked not to be contacted. Callum stopped everything and won't reach out again.`;
    return `You asked Callum never to contact ${first}. Everything was cancelled, and Callum skips ${first} in any list you bring later.`;
  }
  if (p.status === 'closed') return `Your conversation with ${first} is closed. Nothing more goes out.`;
  return null;
}

function nudgeAvailability(p: Person, plan: Plan, ctx: Ctx): Availability {
  const first = p.firstName;
  const no = (reason: string | null): Availability => ({ ok: false, reason });
  if (p.status === 'held') return no(`Resume ${first} to nudge.`);
  if (p.status === 'waiting' || p.status === 'snoozed') return no(`Nudge now is for people Callum is still reaching. ${first} wrote back.`);
  if (p.status !== 'active') return no(null);
  if (p.stage === 'talking') return no(`Nudge now is for people Callum is still reaching. ${first} already talks with you.`);
  const kind = nextKind(p);
  if (kind === null) {
    if (p.touches >= MAX_TOUCHES) return no(`${first} has had all three messages, so there is nothing left to nudge.`);
    return no(`Callum is waiting for ${first} to accept the invite.`);
  }
  if (p.touches === 0) {
    const when = plan.at ? ` ${first}'s goes ${slotText(plan.at, ctx.repo.getSettings().timezone, ctx.clock.now())}.` : '';
    return no(`Nudge now works after the first hello.${when}`);
  }
  return { ok: true, reason: null };
}

// ---- the path ---------------------------------------------------------------------------------------

function buildPath(p: Person, messages: Message[], pending: OutboxItem[], upcoming: Date | null, tz: string): PersonPathStep[] {
  const base = touchPath(p, tz);
  // The touch each step stands for: LinkedIn has "Accepted" between the invite and the thank-you, which is not a touch.
  const touchIndex = (i: number): number | null => (p.channel === 'linkedin' ? [0, null, 1, 2][i] ?? null : i);
  const sent = messages.filter((m) => m.direction === 'out' && !USER_KINDS.has(m.kind) && m.channel === p.channel).slice(-Math.max(p.touches, 0));
  const replied = p.repliedAt !== null;
  const over = replied || p.status === 'stopped' || p.status === 'closed';

  const steps: PersonPathStep[] = [];
  let nextTaken = false;
  base.forEach((step, i) => {
    const t = touchIndex(i);
    let at = step.at;
    if (step.done && t !== null) at = sent[t]?.at ?? at;
    if (step.done) {
      steps.push({ ...step, at, state: 'done' });
      return;
    }
    if (over || p.status === 'resting') return;
    const isNext = !nextTaken;
    nextTaken = true;
    const when = isNext ? (upcoming ? iso(upcoming) : at) : at;
    steps.push({ ...step, at: when, state: isNext ? (p.status === 'held' ? 'held' : 'next') : 'later' });
  });

  const push = (label: string, at: string | null, state: PathState, done = state === 'done' || state === 'sun') => steps.push({ label, at, done, state });
  const inbound = messages.filter((m) => m.direction === 'in');
  const firstIn = inbound[0];
  const lastIn = inbound[inbound.length - 1];
  if (replied) push('Replied', firstIn?.at ?? p.repliedAt, 'sun');
  const mine = messages.filter((m) => m.direction === 'out' && USER_KINDS.has(m.kind));
  const lastMine = mine[mine.length - 1];
  if (lastMine) {
    const label = lastMine.kind === 'booking' ? 'You offered a call' : lastMine.kind === 'close' ? 'You closed it' : 'You answered';
    push(label, lastMine.at, 'done');
    // They wrote again after the user's note.
    if (replied && lastIn && lastIn.at > lastMine.at) push('Wrote back', lastIn.at, 'sun');
  } else if (p.status === 'waiting') {
    push('Your answer', null, 'next', false);
  }
  if (p.status === 'snoozed') push('Snoozed', p.snoozedUntil, 'next', false);
  if (p.status === 'stopped') push(p.replyKind === 'stop' ? 'Asked to stop' : 'Stopped', p.repliedAt ?? p.updatedAt, 'stop');
  if (p.status === 'closed' && !lastMine) push('Closed', p.updatedAt, 'rest');
  if (p.status === 'resting') push('Resting', p.restUntil, 'rest', false);
  return steps;
}

// ---- the whole picture ----------------------------------------------------------------------------------

/** A person with everything the page shows: the conversation, the path with times, what comes next, why this channel, and what can be done. */
export function personDetail(ctx: Ctx, personId: number): PersonFull {
  const person = requirePerson(ctx, personId);
  const settings = ctx.repo.getSettings();
  const project = ctx.repo.getProject(person.projectId);
  const connected = connectedChannels(ctx);
  const messages = ctx.repo.listMessages(person.id);
  const pending = ctx.outbox.pendingFor(person.id);
  const next = plan(ctx, person, project, pending, connected);

  const projectMoves: ProjectMove[] = ctx.repo
    .listProjects({ state: ['running', 'paused'] })
    .filter((other) => other.id !== person.projectId)
    .map((other) => ({ projectId: other.id, name: other.name, reason: projectMoveReason(ctx, person) }));

  return {
    person,
    messages,
    path: buildPath(person, messages, pending, next.at, personTz(person, settings.timezone)),
    next: next.line,
    why: whyLine(ctx, person, connected),
    switchable: switchables(ctx, person, connected),
    projectMoves,
    nudge: nudgeAvailability(person, next, ctx),
    closedNote: closedNote(person),
    projectName: project?.name ?? '',
  };
}

// ---- move to another channel ------------------------------------------------------------------------------

const BAD_HANDLE: Record<Channel, string> = {
  email: "That doesn't look like an email address.",
  linkedin: "That doesn't look like a LinkedIn profile link.",
  x: "That doesn't look like an X handle.",
};

function cleanHandle(ch: Channel, raw: string): string {
  if (ch === 'email') {
    const email = normalizeEmail(raw);
    if (email === null || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError(BAD_HANDLE.email);
    return email;
  }
  const clean = ch === 'linkedin' ? normalizeLinkedinUrl(raw) : normalizeXHandle(raw);
  if (clean === null) throw new UserError(BAD_HANDLE[ch]);
  return clean;
}

/**
 * Moves a person to another channel and starts their sequence there, a week after the last message at the earliest.
 * A new address is checked and kept. What Callum had lined up on the old channel is cancelled.
 */
export function moveTo(ctx: Ctx, personId: number, ch: Channel, handle?: string): Person {
  const person = requirePerson(ctx, personId);
  if (!CHANNELS.includes(ch)) throw new UserError("Callum can't find that channel.", 404);
  const block = moveBlock(person);
  if (block) throw new UserError(block);
  if (ch === person.channel) return person;
  if (ctx.repo.getChannel(ch).status === 'disconnected') throw new UserError(`${NAME[ch]} isn't connected yet.`);

  const patch: Partial<Person> = {};
  if (handle !== undefined && handle.trim() !== '') {
    const clean = cleanHandle(ch, handle);
    const owner = ctx.repo.findPersonByHandle(ch === 'email' ? { email: clean } : ch === 'linkedin' ? { linkedinUrl: clean } : { xHandle: clean });
    if (owner && owner.id !== person.id) throw new UserError(`${owner.firstName} already has that ${ch === 'email' ? 'address' : 'profile'}.`);
    if (ch === 'email') patch.email = clean;
    else if (ch === 'linkedin') patch.linkedinUrl = clean;
    else patch.xHandle = clean;
  } else if (handleOf(person, ch) === null) {
    throw new UserError(`Add ${person.firstName}'s ${NAME[ch]} first`);
  }

  const tz = personTz(person, ctx.repo.getSettings().timezone);
  const moved = ctx.repo.transaction(() => {
    ctx.outbox.cancelPending(person.id, ['auto']);
    return ctx.repo.updatePerson(person.id, { ...patch, ...switchChannel(person, ch, ctx.clock.now(), tz) });
  });
  ctx.bus.emit('people');
  ctx.bus.emit('outbox');
  return moved;
}

// ---- wake early, and take it back ---------------------------------------------------------------------------

interface WakeToken { until: number; before: Pick<Person, 'status' | 'stage' | 'touches' | 'linkedinState' | 'invitedAt' | 'restUntil' | 'nextTouchAt' | 'badge'> }
const tokens = new WeakMap<object, Map<number, WakeToken>>();
const tokensOf = (ctx: Ctx): Map<number, WakeToken> => {
  let map = tokens.get(ctx.repo);
  if (!map) tokens.set(ctx.repo, (map = new Map()));
  return map;
};

/**
 * A resting person starts again now, as a stranger. For 10 seconds `restAgain` takes it back.
 * `helloAt` is when their first new hello would go.
 */
export function wakeEarly(ctx: Ctx, personId: number): { person: Person; undoUntil: string; helloAt: string } {
  const person = requirePerson(ctx, personId);
  if (person.status !== 'resting') throw new UserError(`${person.firstName} isn't resting.`);
  const now = ctx.clock.now();
  const woken = ctx.repo.updatePerson(person.id, wake(person));
  const undoUntil = now.getTime() + UNDO_MS;
  tokensOf(ctx).set(person.id, {
    until: undoUntil,
    before: {
      status: person.status, stage: person.stage, touches: person.touches, linkedinState: person.linkedinState, invitedAt: person.invitedAt,
      restUntil: person.restUntil, nextTouchAt: person.nextTouchAt, badge: person.badge,
    },
  });
  ctx.bus.emit('people');
  const tz = personTz(person, ctx.repo.getSettings().timezone);
  return { person: woken, undoUntil: new Date(undoUntil).toISOString(), helloAt: iso(nextSendingTime(now, tz)) };
}

/** Puts a person back to rest, if they were woken less than 10 seconds ago and nothing has gone out to them since. */
export function restAgain(ctx: Ctx, personId: number): Person {
  const person = requirePerson(ctx, personId);
  const token = tokensOf(ctx).get(person.id);
  const fresh = token !== undefined && token.until > ctx.clock.now().getTime();
  if (!token || !fresh || person.status !== 'active' || person.touches !== 0) {
    tokensOf(ctx).delete(person.id);
    throw new UserError('Too late to undo.');
  }
  tokensOf(ctx).delete(person.id);
  const back = ctx.repo.transaction(() => {
    ctx.outbox.cancelPending(person.id, ['auto']);
    return ctx.repo.updatePerson(person.id, token.before);
  });
  ctx.bus.emit('people');
  ctx.bus.emit('outbox');
  return back;
}
