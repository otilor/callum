import type {
  AwayPerson, Channel, Message, OutboxItem, Person, Project, QuietSnapshot, ReferralCard, SentHello,
} from '../../shared/types.js';
import { classifyReply, offerSentence } from '../ai/templates.js';
import type { Ctx } from '../context.js';
import { findPlaceholders, OPT_OUT_LINE, placeholderMessage } from '../engine/guard.js';
import { chooseChannel } from '../engine/lifecycle.js';
import { localParts, startOfLocalDay } from '../engine/time.js';
import { UNDO_MS } from '../outbox/outbox.js';
import { shiftDays } from './noteTime.js';
import { readNoteSettings, writeNoteSettings } from './noteSettings.js';

/** Something the user can fix, in words for the user. The routes answer these with 422. */
export class NoteError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'NoteError';
  }
}

const DAY_MS = 86_400_000;
/** Callum has to have been paused this long before it asks whether to resume. */
const PAUSE_REMINDER_MS = 3 * DAY_MS;
const DAY_TWO_WINDOW_MS = 3 * DAY_MS;
const AWAY_LOOKBACK_MS = 21 * DAY_MS;
const REFERRAL_LINK_MS = 10 * 60_000;
const SENT_SHOWN = 3;

const live = (p: Person): boolean => p.status !== 'removed';
const isHello = (m: Message): boolean => m.direction === 'out' && (m.kind === 'hello' || m.kind === 'invite');

/**
 * Notes when a pause began. Called on every runner tick and on every read of the quiet moments, so "paused for three days"
 * is true to within a few seconds. Returns the instant the current pause began, or null while Callum is running.
 */
export function trackPause(ctx: Ctx): string | null {
  const settings = readNoteSettings(ctx);
  if (settings.pauseState !== 'paused') {
    if (settings.pausedSince) writeNoteSettings(ctx, { pausedSince: null });
    return null;
  }
  if (settings.pausedSince) return settings.pausedSince;
  const since = ctx.clock.now().toISOString();
  writeNoteSettings(ctx, { pausedSince: since });
  return since;
}

function projectFor(ctx: Ctx, projectId: number | undefined): Project | null {
  const { repo } = ctx;
  if (projectId !== undefined) return repo.getProject(projectId);
  const settings = repo.getSettings();
  return (settings.currentProjectId !== null ? repo.getProject(settings.currentProjectId) : null)
    ?? repo.listProjects({ state: ['running'] })[0] ?? repo.listProjects()[0] ?? null;
}

function sentHellos(ctx: Ctx, people: Person[]): SentHello[] {
  const sent: SentHello[] = [];
  for (const p of people) {
    for (const m of ctx.repo.listMessages(p.id)) {
      if (isHello(m)) sent.push({ personId: p.id, name: p.name, channel: m.channel, at: m.at, text: m.body.replace(OPT_OUT_LINE, '').trim() });
    }
  }
  return sent.sort((a, b) => b.at.localeCompare(a.at) || b.personId - a.personId);
}

function day2(ctx: Ctx, project: Project, people: Person[], tz: string, now: Date): QuietSnapshot['day2'] {
  if (project.startedAt === null || now.getTime() - new Date(project.startedAt).getTime() >= DAY_TWO_WINDOW_MS) return null;
  if (people.some((p) => p.repliedAt !== null || p.status === 'waiting' || p.stage === 'talking')) return null;
  const sent = sentHellos(ctx, people);
  if (sent.length === 0) return null;
  const yesterday = shiftDays(startOfLocalDay(now, tz), -1, tz).toISOString();

  const ids = new Set(people.map((p) => p.id));
  const coming = ctx.repo
    .listOutbox({ state: ['scheduled'] })
    .filter((i) => i.origin === 'auto' && ids.has(i.personId) && (i.kind === 'hello' || i.kind === 'invite') && i.sendAfter > now.toISOString());
  const first = coming[0];
  const dayKey = (iso: string): string => {
    const p = localParts(new Date(iso), tz);
    return `${p.year}-${p.month}-${p.day}`;
  };
  return {
    sentYesterday: sent.filter((s) => s.at >= yesterday).length,
    nextCount: first ? coming.filter((i) => dayKey(i.sendAfter) === dayKey(first.sendAfter)).length : 0,
    nextAt: first ? first.sendAfter : null,
    sent: sent.slice(0, SENT_SHOWN),
  };
}

const answered = (p: Person): boolean => p.repliedAt !== null && p.replyKind !== 'stop' && p.replyKind !== 'hostile' && p.status !== 'stopped';

function used(project: Project, people: Person[], awaiting: number): QuietSnapshot['used'] {
  if (project.startedAt === null || people.length === 0 || awaiting > 0) return null;
  if (people.some((p) => p.status === 'active' && p.stage === 'stranger')) return null;
  if (!people.some((p) => p.touches > 0 || p.repliedAt !== null)) return null;
  const replied = people.filter(answered);
  const finishing = people.filter((p) => p.status === 'active' && (p.stage === 'hello' || p.stage === 'following'));
  const last = finishing.flatMap((p) => (p.nextTouchAt ? [p.nextTouchAt] : [])).sort().pop() ?? null;
  return {
    replied: replied.slice(0, 4).map((p) => ({ id: p.id, first: p.firstName })),
    repliedCount: replied.length,
    finishing: finishing.length,
    finishBy: last,
  };
}

function away(ctx: Ctx, now: Date): AwayPerson[] {
  const found: AwayPerson[] = [];
  const recent = new Date(now.getTime() - AWAY_LOOKBACK_MS).toISOString();
  for (const p of ctx.repo.listPeople({ status: ['active'] })) {
    if (p.replyKind !== null || p.repliedAt !== null || p.stage === 'talking' || p.touches < 1) continue;
    if (p.updatedAt < recent || p.nextTouchAt === null || p.nextTouchAt <= now.toISOString()) continue;
    const last = ctx.repo.listMessages(p.id).at(-1);
    if (!last || last.direction !== 'in') continue;
    const read = classifyReply(last.body, new Date(last.at));
    if (read.kind !== 'out_of_office') continue;
    found.push({
      personId: p.id, projectId: p.projectId, first: p.firstName, name: p.name, company: p.company, role: p.role,
      until: read.returnDate, followUpAt: p.nextTouchAt, text: last.body.replace(/\s+/g, ' ').trim().slice(0, 280), at: last.at,
    });
  }
  return found.sort((a, b) => b.at.localeCompare(a.at));
}

/** What the referrer said about the person, from after their name: `runs finance at Oko Pay`. */
function contextAfter(note: string | null, name: string, referrerCompany: string | null): string | null {
  if (!note) return null;
  const lower = note.toLowerCase();
  for (const needle of [name, name.split(/\s+/)[0] ?? name]) {
    const at = lower.indexOf(needle.toLowerCase());
    if (at < 0) continue;
    const rest = note.slice(at + needle.length).replace(/^[\s,:-]+/, '');
    const sentence = (rest.split(/(?<=[a-z0-9])[.?!](?:\s|$)/i)[0] ?? '').replace(/[.?!]+$/, '').trim();
    if (!/^[a-z]/.test(sentence) || sentence.length < 4 || sentence.length > 120) continue;
    return referrerCompany ? sentence.replace(/\bhere\b/i, `at ${referrerCompany}`) : sentence;
  }
  return null;
}

/** The draft for a person someone pointed us to. It names the person who did. */
function referralWords(ctx: Ctx, p: Person, referrer: Person | null): { subject: string; draft: string } {
  const project = ctx.repo.getProject(p.projectId);
  const intro = referrer ? `${referrer.firstName} suggested I reach out.` : "I was told you're the right person to talk to.";
  return {
    subject: referrer ? `${referrer.firstName} suggested I get in touch` : 'A quick question',
    draft: `Hi ${p.firstName}, ${intro} ${offerSentence(project?.offer)} Would a short call next week be useful?`,
  };
}

function referrerOf(ctx: Ctx, p: Person): Person | null {
  const born = new Date(p.createdAt).getTime();
  let best: { person: Person; gap: number } | null = null;
  for (const c of ctx.repo.listPeople({ projectId: p.projectId })) {
    if (c.replyKind !== 'referral' || c.repliedAt === null || c.id === p.id) continue;
    const gap = Math.abs(born - new Date(c.repliedAt).getTime());
    if (gap <= REFERRAL_LINK_MS && (!best || gap < best.gap)) best = { person: c, gap };
  }
  return best?.person ?? null;
}

function isFreshReferral(ctx: Ctx, p: Person): boolean {
  return p.source === 'referral' && p.status === 'active' && p.stage === 'stranger' && p.touches === 0
    && ctx.repo.listOutbox({ personId: p.id, state: ['awaiting_ok', 'scheduled', 'blocked', 'failed'] }).length === 0
    && !ctx.repo.listMessages(p.id).some((m) => m.direction === 'out');
}

function referrals(ctx: Ctx): ReferralCard[] {
  const cards: ReferralCard[] = [];
  for (const p of ctx.repo.listPeople({ status: ['active'] })) {
    if (!isFreshReferral(ctx, p)) continue;
    const referrer = referrerOf(ctx, p);
    const words = referralWords(ctx, p, referrer);
    cards.push({
      personId: p.id, projectId: p.projectId, first: p.firstName, name: p.name, company: p.company,
      referrer: referrer ? { id: referrer.id, first: referrer.firstName, name: referrer.name, company: referrer.company } : null,
      context: contextAfter(p.note, p.name, referrer?.company ?? null),
      channel: p.channel ?? chooseChannel(p, ctx.repo.listChannels().filter((c) => c.status === 'connected').map((c) => c.channel)),
      subject: words.subject, draft: words.draft,
    });
  }
  return cards;
}

function pausedFor(ctx: Ctx, now: Date): QuietSnapshot['paused'] {
  const since = trackPause(ctx);
  if (since === null || now.getTime() - new Date(since).getTime() < PAUSE_REMINDER_MS) return null;
  const people = ctx.repo.listPeople({ status: ['active'] });
  return {
    since,
    days: Math.floor((now.getTime() - new Date(since).getTime()) / DAY_MS),
    hellos: people.filter((p) => p.stage === 'stranger' && p.touches === 0).length,
    followUps: people.filter((p) => p.touches > 0 && p.nextTouchAt !== null && p.stage !== 'talking').length,
  };
}

/** Everything the quiet moments of Home need, for one project (the current one when none is given). */
export function quietSnapshot(ctx: Ctx, projectId?: number): QuietSnapshot {
  const now = ctx.clock.now();
  const tz = ctx.repo.getSettings().timezone;
  const project = projectFor(ctx, projectId);
  const people = project ? ctx.repo.listPeople({ projectId: project.id }).filter(live) : [];
  const ids = new Set(people.map((p) => p.id));
  const awaiting = ctx.repo.listOutbox({ state: ['awaiting_ok'] }).filter((i) => ids.has(i.personId)).length;
  return {
    projectId: project?.id ?? null,
    empty: people.length === 0,
    day2: project ? day2(ctx, project, people, tz, now) : null,
    used: project ? used(project, people, awaiting) : null,
    away: away(ctx, now),
    referrals: referrals(ctx),
    paused: pausedFor(ctx, now),
  };
}

/** The user says an auto-reply was a real one: the person moves to the dock with a drafted answer. */
export async function realReply(ctx: Ctx, personId: number): Promise<Person> {
  const { repo } = ctx;
  const person = repo.getPerson(personId);
  if (!person || !live(person)) throw new NoteError('Callum could not find that person');
  if (person.status === 'waiting') return person;
  const last = repo.listMessages(person.id).at(-1);
  if (!last || last.direction !== 'in') throw new NoteError(`${person.firstName} has not written back yet`);
  if (person.status !== 'active') throw new NoteError(`${person.firstName} is not in the river right now`);
  const project = repo.getProject(person.projectId);
  if (!project) throw new NoteError('Callum could not find that person\'s project');
  const patch: Partial<Person> = {
    status: 'waiting', replyKind: 'interested', suggested: 'reply', lastInbound: last.body, repliedAt: last.at, nextTouchAt: null,
  };
  const draft = await ctx.writer.write('reply', {
    person: { ...person, ...patch }, project, settings: repo.getSettings(), channel: last.channel, history: repo.listMessages(person.id),
  });
  // Look again: writing takes a while and the person may have moved.
  const fresh = repo.getPerson(person.id);
  if (!fresh || fresh.status !== 'active') return fresh ?? person;
  const next = repo.transaction(() => {
    ctx.outbox.cancelPending(person.id, ['auto']);
    return repo.updatePerson(person.id, { ...patch, draft: draft.body });
  });
  ctx.bus.emit('people');
  ctx.bus.emit('outbox');
  return next;
}

/** The user's hello to a person someone pointed us to, sent like any message the user writes: after the undo window. */
export function sendReferral(ctx: Ctx, personId: number, body: string, subject?: string | null): OutboxItem {
  const { repo } = ctx;
  const person = repo.getPerson(personId);
  if (!person || !live(person)) throw new NoteError('Callum could not find that person');
  if (!isFreshReferral(ctx, person)) throw new NoteError(`${person.firstName} has already heard from you or is not waiting for a first hello.`);
  const text = body.trim();
  if (!text) throw new NoteError(`Write a line to ${person.firstName} first`);
  const placeholder = findPlaceholders(text)[0];
  if (placeholder) throw new NoteError(placeholderMessage(placeholder));

  const connected = repo.listChannels().filter((c) => c.status === 'connected').map((c) => c.channel);
  const channel = person.channel && connected.includes(person.channel) ? person.channel : chooseChannel(person, connected);
  if (!channel) throw new NoteError(`Callum has no way to reach ${person.firstName} yet. Add an email address or a profile link, and connect that channel.`);

  const words = referralWords(ctx, person, referrerOf(ctx, person));
  const mailSubject = channel === 'email' ? (subject?.trim() || words.subject) : null;
  if (mailSubject && findPlaceholders(mailSubject).length > 0) throw new NoteError(placeholderMessage(findPlaceholders(mailSubject)[0] as string));

  const at = new Date(ctx.clock.now().getTime() + UNDO_MS).toISOString();
  const item = repo.transaction(() => {
    if (person.channel !== channel) repo.updatePerson(person.id, { channel });
    return repo.insertOutbox({
      personId: person.id, channel, kind: 'hello', subject: mailSubject, body: text,
      state: 'scheduled', origin: 'user', sendAfter: at, undoUntil: at,
    });
  });
  ctx.bus.emit('outbox');
  ctx.bus.emit('people');
  return item;
}
