import type {
  Message, Person, WeeklyEmail, WeeklyGroup, WeeklyNote, WeeklyReply, WeeklyRest, WeeklySuggestion, WeeklyWarm,
} from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { findPlaceholders } from '../engine/guard.js';
import { endOfLocalDay, lastNoteAt, localParts } from '../engine/time.js';
import { dayMonth, dayName, shiftDays, slotText } from './noteTime.js';
import { readNoteSettings, writeNoteSettings } from './noteSettings.js';

const TITLE = 'Last week, in people';
const MAX_WARMING = 10;
/** A weekly email that did not go is tried again after this long. */
const RETRY_MS = 30 * 60_000;

/** Names and companies come from lists people pasted in: nothing in them may look like a placeholder. */
const clean = (s: string): string => s.replace(/[[\]{}]/g, '').replace(/\s+/g, ' ').trim();
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The start of the week the note due at `noteAt` is about: seven days earlier, same wall time. */
export function weekStartFor(noteAt: Date, tz: string): Date {
  return shiftDays(noteAt, -7, tz);
}

/** The week the current note covers: the note was last due on a Monday at 8:30, and it looks back a week. */
export function currentWeekStart(now: Date, tz: string): Date {
  return weekStartFor(lastNoteAt(now, tz), tz);
}

interface Dossier { person: Person; messages: Message[] }

const inWindow = (iso: string | null, from: Date, to: Date): boolean =>
  iso !== null && iso >= from.toISOString() && iso < to.toISOString();

/** The way the note says how the week went. */
function summaryLine(hellos: number, replied: number, booked: number): string {
  const head = `Callum said hello to ${hellos} ${plural(hellos, 'person', 'people')}.`;
  if (replied === 0) return `${head} Nobody has replied yet.`;
  return `${head} ${replied} replied and ${booked} ${plural(booked, 'call is', 'calls are')} booked.`;
}

function replyText(p: Person, booked: boolean, tz: string): { text: string; mail: string } {
  const first = clean(p.firstName);
  const day = p.repliedAt ? dayName(new Date(p.repliedAt), tz) : 'last week';
  if (booked) return { text: `${first} replied on ${day} and you sent your calendar link.`, mail: 'Calendar link sent.' };
  switch (p.status) {
    case 'waiting':
      return p.draft
        ? { text: `${first} replied on ${day}. Callum drafted a reply for you.`, mail: 'Callum drafted a reply for you.' }
        : { text: `${first} replied on ${day}. Your reply is waiting.`, mail: 'Waiting on you.' };
    case 'snoozed': {
      const back = p.snoozedUntil ? dayMonth(new Date(p.snoozedUntil), tz) : null;
      return back
        ? { text: `${first} said not now. Callum follows up on ${back}.`, mail: `Follow-up on ${back}.` }
        : { text: `${first} replied on ${day} and is resting.`, mail: 'Resting.' };
    }
    case 'closed':
      return { text: `${first} replied on ${day}. You closed it politely.`, mail: 'Closed politely.' };
    default:
      return p.stage === 'talking'
        ? { text: `${first} replied on ${day} and you answered.`, mail: 'You answered.' }
        : { text: `${first} replied on ${day}.`, mail: 'Replied.' };
  }
}

function warmText(p: Person, tz: string, now: Date): string {
  const first = clean(p.firstName);
  const next = p.nextTouchAt ? ` A follow-up goes out ${slotText(p.nextTouchAt, tz, now)}.` : '';
  if (p.linkedinState === 'connected') return `${first} accepted your LinkedIn invite.${next}`;
  return `${first} has heard from you ${p.touches} ${plural(p.touches, 'time', 'times')}.${next}`;
}

function restOf(people: Person[], tz: string): WeeklyRest {
  const resting = people.filter((p) => p.status === 'resting');
  const dates = resting.flatMap((p) => (p.restUntil ? [p.restUntil] : [])).sort();
  const first = dates[0];
  return { count: resting.length, backOn: first ? dayMonth(new Date(first), tz) : null };
}

interface Tally { hellos: number; replied: WeeklyReply[]; warming: WeeklyWarm[]; resting: WeeklyRest }

function tally(ctx: Ctx, dossiers: Dossier[], from: Date, to: Date, tz: string): Tally {
  const now = ctx.clock.now();
  let hellos = 0;
  const replied: (WeeklyReply & { at: string })[] = [];
  const warming: (WeeklyWarm & { at: string })[] = [];
  for (const { person: p, messages } of dossiers) {
    if (messages.some((m) => m.direction === 'out' && (m.kind === 'hello' || m.kind === 'invite') && inWindow(m.at, from, to))) hellos++;
    const answered = inWindow(p.repliedAt, from, to) && p.replyKind !== 'stop' && p.replyKind !== 'hostile' && p.status !== 'stopped';
    if (answered) {
      const booked = messages.some((m) => m.direction === 'out' && m.kind === 'booking' && m.at >= (p.repliedAt ?? ''));
      replied.push({
        id: p.id, first: clean(p.firstName), booked, name: clean(p.name), company: p.company ? clean(p.company) : null,
        projectId: p.projectId, ...replyText(p, booked, tz), at: p.repliedAt ?? '',
      });
    } else if (p.status === 'active' && p.stage !== 'talking' && (p.stage === 'following' || p.linkedinState === 'connected')) {
      warming.push({ id: p.id, first: clean(p.firstName), projectId: p.projectId, text: warmText(p, tz, now), at: p.updatedAt });
    }
  }
  // Calls first, then the newest answer.
  replied.sort((a, b) => Number(b.booked) - Number(a.booked) || b.at.localeCompare(a.at) || a.id - b.id);
  warming.sort((a, b) => b.at.localeCompare(a.at) || a.id - b.id);
  return {
    hellos,
    replied: replied.map(({ at: _at, ...r }) => r),
    warming: warming.slice(0, MAX_WARMING).map(({ at: _at, ...w }) => w),
    resting: restOf(dossiers.map((d) => d.person), tz),
  };
}

function suggestionFor(ctx: Ctx, dossiers: Dossier[], from: Date, to: Date): WeeklySuggestion | null {
  let best: Person | null = null;
  for (const { person: p, messages } of dossiers) {
    if (!inWindow(p.repliedAt, from, to) || p.replyKind === 'stop' || p.replyKind === 'hostile' || p.status === 'stopped') continue;
    if (!messages.some((m) => m.direction === 'out' && m.kind === 'booking' && m.at >= (p.repliedAt ?? ''))) continue;
    if (!best || (p.repliedAt ?? '') > (best.repliedAt ?? '')) best = p;
  }
  if (!best) return null;
  const first = clean(best.firstName);
  return {
    text: `${first}'s colleagues look like a good fit. Find 10 more like ${first}?`,
    action: { kind: 'find_more', label: `Find 10 more like ${first}`, args: { likePersonId: best.id, query: null, count: 10 } },
    projectId: best.projectId,
  };
}

/**
 * The note for the week that starts at `weekStart` and runs seven days. It covers every project; when there is more
 * than one it also comes grouped by project, with one suggestion overall.
 */
export function weeklyNote(ctx: Ctx, weekStart: Date): WeeklyNote {
  const { repo } = ctx;
  const tz = repo.getSettings().timezone;
  const to = shiftDays(weekStart, 7, tz);
  const dossiers: Dossier[] = repo.listPeople().filter((p) => p.status !== 'removed').map((person) => ({ person, messages: repo.listMessages(person.id) }));
  const all = tally(ctx, dossiers, weekStart, to, tz);
  const booked = all.replied.filter((r) => r.booked).length;

  const projects = repo.listProjects();
  const groups: WeeklyGroup[] = projects.length < 2 ? [] : projects.flatMap((project) => {
    const mine = dossiers.filter((d) => d.person.projectId === project.id);
    if (mine.length === 0) return [];
    const t = tally(ctx, mine, weekStart, to, tz);
    return [{
      projectId: project.id, name: clean(project.name),
      line: summaryLine(t.hellos, t.replied.length, t.replied.filter((r) => r.booked).length),
      replied: t.replied, warming: t.warming, resting: t.resting,
    }];
  });

  const senderName = repo.getSettings().senderName;
  return {
    title: TITLE,
    at: to.toISOString(),
    senderFirst: senderName ? clean(senderName.trim().split(/\s+/)[0] ?? '') || null : null,
    hellos: all.hellos,
    replied: all.replied,
    line: summaryLine(all.hellos, all.replied.length, booked),
    warming: all.warming,
    resting: all.resting,
    suggestion: suggestionFor(ctx, dossiers, weekStart, to),
    nextAt: shiftDays(to, 7, tz).toISOString(),
    groups,
  };
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function warmingLine(warming: WeeklyWarm[]): string | null {
  if (warming.length === 0) return null;
  // The note text says who accepted; the others are getting follow-ups.
  const accepted = warming.filter((w) => w.text.includes('accepted your LinkedIn invite')).map((w) => w.first);
  const others = warming.filter((w) => !w.text.includes('accepted your LinkedIn invite')).map((w) => w.first);
  const parts: string[] = [];
  if (accepted.length) parts.push(`${joinNames(accepted)} accepted on LinkedIn.`);
  if (others.length) parts.push(`${joinNames(others)} ${others.length === 1 ? 'is' : 'are'} getting follow-ups.`);
  return `Warming up: ${parts.join(' ')}`;
}

function restingLine(r: WeeklyRest): string | null {
  if (r.count === 0) return null;
  const head = `${r.count} ${plural(r.count, 'person', 'people')}`;
  return `Resting: ${r.backOn ? `${head}, back on ${r.backOn}.` : `${head}.`}`;
}

function replyLines(replied: WeeklyReply[]): string[] {
  return replied.map((r) => `${r.name}${r.company ? `, ${r.company}` : ''}. ${r.mail}`);
}

/** The note as a plain-text email. */
export function weeklyEmail(note: WeeklyNote): WeeklyEmail {
  const r = note.replied.length;
  const b = note.replied.filter((x) => x.booked).length;
  const subject = r === 0
    ? `Your week: ${note.hellos} ${plural(note.hellos, 'hello', 'hellos')}, no replies yet`
    : `Your week: ${r} ${plural(r, 'reply', 'replies')}, ${b} ${plural(b, 'call', 'calls')} booked`;

  const lines: string[] = [note.senderFirst ? `Morning ${note.senderFirst},` : 'Morning,', ''];
  const section = (replied: WeeklyReply[], warming: WeeklyWarm[], resting: WeeklyRest): void => {
    if (replied.length) lines.push(...replyLines(replied), '');
    for (const extra of [warmingLine(warming), restingLine(resting)]) if (extra) lines.push(extra, '');
  };
  if (note.groups.length > 1) {
    lines.push(note.line, '');
    for (const g of note.groups) {
      lines.push(g.name, g.line, '');
      section(g.replied, g.warming, g.resting);
    }
  } else {
    lines.push(note.line, '');
    section(note.replied, note.warming, note.resting);
  }
  if (note.suggestion) {
    const fit = (note.suggestion.text.split('. ')[0] ?? '').replace(/\.$/, '');
    lines.push(`One idea: ${fit}. Open Callum and ask it: ${note.suggestion.action.label}.`, '');
  }
  lines.push('Callum sends this every Monday at 8:30 from your own address, so it never lands in spam. Change it in Your Callum.');
  return { subject, text: lines.join('\n') };
}

/** `2026-11-02`: the local date of the Monday a weekly note is for. */
function weekKey(noteAt: Date, tz: string): string {
  const p = localParts(noteAt, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Taken before the email goes out, so two overlapping ticks never send the same week twice. */
const sending = new WeakSet<Ctx>();

/**
 * Sends the weekly email once a week: on the Monday at 8:30 (user time), or later that Monday if Callum was off, to the
 * user's own address through their email channel. Needs email connected and `morningBrief` not switched off. An empty
 * week sends nothing but is not looked at again. A send that fails is tried again in half an hour and reported by throwing.
 * Returns true when an email went out.
 */
export async function maybeSendWeekly(ctx: Ctx): Promise<boolean> {
  if (sending.has(ctx)) return false;
  const now = ctx.clock.now();
  const settings = readNoteSettings(ctx);
  if (!settings.onboarded || settings.pauseState === 'wrapped' || settings.morningBrief === false) return false;
  const to = settings.senderEmail?.trim();
  if (!to || ctx.repo.getChannel('email').status !== 'connected') return false;

  const tz = settings.timezone;
  const noteAt = lastNoteAt(now, tz);
  // Which Monday it is for is kept as a local date, so changing the time zone on a Monday cannot send the same week again.
  const key = weekKey(noteAt, tz);
  if (settings.lastWeeklyFor ? settings.lastWeeklyFor === key : settings.lastWeeklyAt && settings.lastWeeklyAt >= noteAt.toISOString()) return false;
  // The note is a Monday morning thing: it is not sent on Wednesday because Callum was switched off on Monday.
  if (now.getTime() >= endOfLocalDay(noteAt, tz).getTime()) return false;
  if (settings.weeklyTriedAt && now.getTime() - new Date(settings.weeklyTriedAt).getTime() < RETRY_MS) return false;
  const adapter = ctx.adapters.get('email');
  if (!adapter) return false;

  sending.add(ctx);
  try {
    const note = weeklyNote(ctx, weekStartFor(noteAt, tz));
    if (note.hellos === 0 && note.replied.length === 0) {
      writeNoteSettings(ctx, { lastWeeklyAt: now.toISOString(), lastWeeklyFor: key });
      return false;
    }
    const mail = weeklyEmail(note);
    if (findPlaceholders(mail.subject).length > 0 || findPlaceholders(mail.text).length > 0) {
      writeNoteSettings(ctx, { weeklyTriedAt: now.toISOString() });
      throw new Error('The weekly note has a placeholder in it, so Callum did not send it');
    }
    const result = await adapter.send({
      to: { name: settings.senderName?.trim() || 'You', email: to, linkedinUrl: null, xHandle: null },
      kind: 'reply', subject: mail.subject, body: mail.text, inReplyTo: null,
    }).catch((err: unknown) => ({ ok: false as const, error: { code: 'unknown' as const, message: err instanceof Error ? err.message : 'Callum could not send it' } }));
    if (!result.ok) {
      writeNoteSettings(ctx, { weeklyTriedAt: now.toISOString() });
      throw new Error(`The weekly note did not go out: ${result.error.message}`);
    }
    writeNoteSettings(ctx, { lastWeeklyAt: now.toISOString(), lastWeeklyFor: key, weeklyTriedAt: null });
    ctx.bus.emit('settings');
    return true;
  } finally {
    sending.delete(ctx);
  }
}

/** Where the user's time says the note opens: the Monday at 8:30 that last passed. */
export function noteDue(ctx: Ctx): { noteAt: Date; weekStart: Date } {
  const tz = ctx.repo.getSettings().timezone;
  const noteAt = lastNoteAt(ctx.clock.now(), tz);
  return { noteAt, weekStart: weekStartFor(noteAt, tz) };
}
