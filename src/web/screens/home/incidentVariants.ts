import type { AppState, AskAction, Channel, Incident, Person, QuietSnapshot } from '../../../shared/types.js';
import { formatSlot } from '../../ui/format.js';
import { dayLong, dayShort, plural, timeOf, weekdayIn } from './quietCopy.js';

/**
 * What can break, in the words of the V3Breaks board: one card per situation, with what happened, what Callum did,
 * the one next step, and the people who wait. Task 15's IncidentCard renders these for every kind except the LinkedIn check.
 */
export type VariantKey = 'signed_out' | 'bounces' | 'x_limit' | 'send_failed' | 'weekly_limit' | 'stop' | 'reply_unread' | 'not_answering';

export interface VariantLine { kind: 'what' | 'did' | 'next'; text: string }

/** What a button does. The renderer runs it; `incidentVariants.test.ts` pins what each variant offers. */
export type VariantAction =
  | { kind: 'reconnect'; channel: Channel }
  | { kind: 'dismiss' }
  | { kind: 'open_person'; personId: number }
  | { kind: 'link'; url: string }
  | { kind: 'skip_bounced'; personIds: number[] }
  | { kind: 'retry'; outboxId: number; first: string }
  | { kind: 'copy'; text: string; first: string }
  | { kind: 'switch_channel'; action: Extract<AskAction, { kind: 'switch_channel' }>; projectId: number | null };

export interface VariantButton { label: string; action: VariantAction }

export interface IncidentVariant {
  key: VariantKey;
  /** Stable across reloads, so a dismissal can be remembered. */
  id: string;
  incidentId: number | null;
  title: string;
  /** `Today at 9:14` */
  when: string;
  /** The person's own words (the reply that did not go out, the message that said stop). */
  quote: string | null;
  lines: VariantLine[];
  /** The people who wait, shown as grey faces, and the line under them. */
  waitIds: number[];
  waitLine: string | null;
  primary: VariantButton;
  secondary: VariantButton | null;
  /** The face on the left of the title: a person, or the channel's glyph. */
  icon: { personId: number | null; glyph: 'mail' | 'x' | 'in' | null; badge: 'pause' | 'error' | null };
}

const CHANNEL_NAME: Record<Channel, string> = { email: 'email', linkedin: 'LinkedIn', x: 'X' };
const X_PLAN_URL = 'https://developer.x.com/en/portal/products';
const STOP_SHOWN_MS = 24 * 3_600_000;

export function whenText(iso: string, tz: string, now: Date): string {
  const day = (d: Date): number => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
    const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return Date.UTC(n('year'), n('month') - 1, n('day')) / 86_400_000;
  };
  const ahead = day(now) - day(new Date(iso));
  const time = timeOf(iso, tz);
  if (ahead <= 0) return `Today at ${time}`;
  if (ahead === 1) return `Yesterday at ${time}`;
  if (ahead < 7) return `${dayLong(iso, tz).split(' ')[0]} at ${time}`;
  return `${dayShort(iso, tz)} at ${time}`;
}

/** When X sends again after a pause that ends at midnight: 9:00, and not on a weekend. */
function xResumes(untilIso: string, tz: string): string {
  let at = new Date(new Date(untilIso).getTime() + 9 * 3_600_000);
  for (let i = 0; i < 2 && [0, 6].includes(weekdayIn(at.toISOString(), tz)); i++) at = new Date(at.getTime() + 86_400_000);
  return at.toISOString();
}

const sentences = (text: string): string[] => text.trim().split(/(?<=[.?!])\s+/).filter(Boolean);

/** People Callum is holding for a channel: in the river, waiting for their next message on it. */
export function waitingOn(people: Person[], channel: Channel): Person[] {
  return people.filter((p) => p.channel === channel && p.status === 'active' && p.stage !== 'talking' && p.nextTouchAt !== null);
}

function othersKeepGoing(state: AppState, except: Channel): string {
  const names = state.channels.filter((c) => c.channel !== except && c.status === 'connected').map((c) => CHANNEL_NAME[c.channel]);
  if (names.length === 0) return '';
  const list = names.length === 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return ` ${list.charAt(0).toUpperCase()}${list.slice(1)} ${names.length === 1 ? 'keeps' : 'keep'} going.`;
}

function providerOf(message: string): string {
  return /^(.+?) signed Callum out/.exec(message)?.[1] ?? 'Your mail';
}

function parseBounce(detail: string | null): { domain: string; people: { id: number; fallback: Channel | null }[] } | null {
  if (!detail) return null;
  try {
    const d = JSON.parse(detail) as { domain?: unknown; people?: unknown };
    if (typeof d.domain !== 'string' || !Array.isArray(d.people)) return null;
    return { domain: d.domain, people: d.people as { id: number; fallback: Channel | null }[] };
  } catch {
    return null;
  }
}

function parseOutboxId(detail: string | null): number | null {
  if (!detail) return null;
  try {
    const id = (JSON.parse(detail) as { outboxId?: unknown }).outboxId;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

const OKAY: VariantButton = { label: 'Okay', action: { kind: 'dismiss' } };

function signedOut(i: Incident, state: AppState, base: Pick<IncidentVariant, 'id' | 'incidentId' | 'when'>): IncidentVariant | null {
  const parts = sentences(i.message);
  const waiting = waitingOn(state.people, i.channel);
  const name = CHANNEL_NAME[i.channel];
  const provider = i.channel === 'email' ? providerOf(i.message) : null;
  const who = provider ?? name;
  const what = [parts[0] ?? i.message];
  if (provider === 'Google' || provider === 'Microsoft') what.push('This usually follows a password change.');
  const rest = parts.slice(1).join(' ');
  return {
    ...base, key: 'signed_out',
    title: `${who} signed Callum out`,
    quote: null,
    lines: [
      { kind: 'what', text: what.join(' ') },
      { kind: 'did', text: `Callum paused ${name}.${rest ? ` ${rest}` : ''}${othersKeepGoing(state, i.channel)}` },
      { kind: 'next', text: `Reconnect ${who} to send them.` },
    ],
    waitIds: waiting.map((p) => p.id),
    waitLine: waiting.length ? `${waiting.length} ${plural(waiting.length, 'person waits', 'people wait')} for ${name}. Nothing is lost.` : null,
    primary: { label: `Reconnect ${who}`, action: { kind: 'reconnect', channel: i.channel } },
    secondary: null,
    icon: { personId: null, glyph: i.channel === 'email' ? 'mail' : i.channel === 'x' ? 'x' : 'in', badge: 'pause' },
  };
}

function bounces(i: Incident, base: Pick<IncidentVariant, 'id' | 'incidentId' | 'when'>): IncidentVariant {
  const d = parseBounce(i.detail);
  const n = d?.people.length ?? 1;
  const parts = sentences(i.message);
  const kept = (d?.people ?? []).filter((p) => p.fallback !== null).map((p) => p.id);
  const where = d ? `${n} ${plural(n, 'address', 'addresses')} at ${d.domain} ${plural(n, "doesn't exist anymore", "don't exist anymore")}.` : (parts[0] ?? i.message);
  return {
    ...base, key: 'bounces',
    title: `${n} ${plural(n, 'email', 'emails')} bounced`, quote: null,
    lines: [
      { kind: 'what', text: where },
      { kind: 'did', text: `${parts.slice(1).join(' ') || 'Callum removed them.'} Your address is safe.` },
      { kind: 'next', text: kept.length ? "Nothing to do. Skip them if you'd rather not." : 'Nothing to do.' },
    ],
    waitIds: d?.people.map((p) => p.id) ?? [],
    waitLine: d ? `${n} ${plural(n, 'person', 'people')} at ${d.domain}` : null,
    primary: OKAY,
    secondary: kept.length ? { label: 'Skip them instead', action: { kind: 'skip_bounced', personIds: kept } } : null,
    icon: { personId: null, glyph: 'mail', badge: 'error' },
  };
}

function xLimit(i: Incident, state: AppState, base: Pick<IncidentVariant, 'id' | 'incidentId' | 'when'>, tz: string, now: Date): IncidentVariant {
  const waiting = waitingOn(state.people, 'x');
  const until = state.channels.find((c) => c.channel === 'x')?.pausedUntil;
  const parts = sentences(i.message);
  return {
    ...base, key: 'x_limit',
    title: 'X stopped taking messages', quote: null,
    lines: [
      { kind: 'what', text: parts[0] ?? i.message },
      { kind: 'did', text: `Callum paused X${until ? ' until tomorrow' : ''}.${othersKeepGoing(state, 'x')}` },
      { kind: 'next', text: until ? `Nothing to do. Messages resume ${formatSlot(xResumes(until, tz), tz, now)}.` : 'Nothing to do.' },
    ],
    waitIds: waiting.map((p) => p.id),
    waitLine: waiting.length ? `${waiting.length} ${plural(waiting.length, 'person waits', 'people wait')} for X. Nothing is lost.` : null,
    primary: OKAY,
    secondary: { label: 'Raise the X plan', action: { kind: 'link', url: X_PLAN_URL } },
    icon: { personId: null, glyph: 'x', badge: 'pause' },
  };
}

function sendFailed(i: Incident, state: AppState, base: Pick<IncidentVariant, 'id' | 'incidentId' | 'when'>): IncidentVariant | null {
  const outboxId = parseOutboxId(i.detail);
  const item = outboxId === null ? undefined : state.outbox.find((o) => o.id === outboxId);
  const person = i.personId === null ? undefined : state.people.find((p) => p.id === i.personId);
  if (!item || !person || (item.state !== 'failed' && item.state !== 'blocked')) return null;
  const reason = /didn't go out:\s*(.+?)\.?\s*It's saved here\.?$/.exec(i.message)?.[1] ?? item.error ?? 'the message did not go';
  const first = person.firstName;
  return {
    ...base, key: 'send_failed',
    title: `Your reply to ${first} didn't go out`, quote: item.body,
    lines: [
      { kind: 'what', text: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.` },
      { kind: 'did', text: `Callum kept your reply here, word for word, and won't send ${first} anything else until you decide.` },
      { kind: 'next', text: 'Try again, or copy it and send it another way.' },
    ],
    waitIds: [], waitLine: null,
    primary: { label: 'Try again', action: { kind: 'retry', outboxId: item.id, first } },
    secondary: { label: 'Copy', action: { kind: 'copy', text: item.body, first } },
    icon: { personId: person.id, glyph: null, badge: null },
  };
}

function weeklyLimit(i: Incident, state: AppState, base: Pick<IncidentVariant, 'id' | 'incidentId' | 'when'>): IncidentVariant {
  const parts = sentences(i.message);
  const emailOn = state.channels.some((c) => c.channel === 'email' && c.status === 'connected');
  // Invites that have not gone out yet, for people Callum could write to instead.
  // Only the project on screen: a move is made inside one project, and the server checks the people against it.
  const projectId = state.settings.currentProjectId;
  const waiting = state.people.filter((p) => (projectId === null || p.projectId === projectId) && p.channel === 'linkedin' && p.status === 'active' && p.stage === 'stranger' && p.touches === 0 && p.linkedinState === 'none' && p.email !== null);
  const move = emailOn && waiting.length > 0;
  const n = waiting.length;
  return {
    ...base, key: 'weekly_limit',
    title: "LinkedIn's weekly limit", quote: null,
    lines: [
      { kind: 'what', text: parts[0] ?? i.message },
      { kind: 'did', text: parts.slice(1).join(' ') || 'New invites wait until Monday.' },
      { kind: 'next', text: move ? `Nothing to do, or move the ${n} waiting ${plural(n, 'person', 'people')} to email.` : 'Nothing to do.' },
    ],
    waitIds: waiting.map((p) => p.id),
    waitLine: n ? `${n} ${plural(n, 'invite waits', 'invites wait')} until Monday` : null,
    primary: move
      ? {
        label: `Move ${n === 1 ? 'this 1' : `these ${n}`} to email`,
        action: {
          kind: 'switch_channel',
          action: { kind: 'switch_channel', label: `Move ${n} to email`, args: { personIds: waiting.map((p) => p.id), channel: 'email' } },
          projectId,
        },
      }
      : OKAY,
    secondary: move ? { label: 'Wait until Monday', action: { kind: 'dismiss' } } : null,
    icon: { personId: null, glyph: 'in', badge: 'pause' },
  };
}

/** A reply Callum could not read: it is on the dock as it came, so the next step is to read it and answer. */
function replyUnread(i: Incident, state: AppState, base: Pick<IncidentVariant, 'id' | 'incidentId' | 'when'>): IncidentVariant {
  const person = i.personId === null ? undefined : state.people.find((p) => p.id === i.personId);
  const name = CHANNEL_NAME[i.channel];
  return {
    ...base, key: 'reply_unread',
    title: person ? `Callum couldn't read a reply from ${person.firstName}` : "Callum couldn't read a reply",
    quote: null,
    lines: [
      { kind: 'what', text: sentences(i.message)[0] ?? i.message },
      { kind: 'did', text: person ? `Callum kept the reply as it came and holds everything else for ${person.firstName} until you have read it.` : 'Callum kept what it could and carries on with everyone else.' },
      { kind: 'next', text: person ? `Open ${person.firstName}'s conversation and answer.` : `Look at ${name} by hand, then press Okay.` },
    ],
    waitIds: [], waitLine: null,
    primary: person ? { label: `Open ${person.firstName}'s conversation`, action: { kind: 'open_person', personId: person.id } } : OKAY,
    secondary: person ? { label: 'Okay', action: { kind: 'dismiss' } } : null,
    icon: { personId: person?.id ?? null, glyph: person ? null : i.channel === 'email' ? 'mail' : i.channel === 'x' ? 'x' : 'in', badge: person ? null : 'error' },
  };
}

/** A channel that stopped answering: Callum keeps asking, and it clears itself once the channel answers. */
function notAnswering(i: Incident, base: Pick<IncidentVariant, 'id' | 'incidentId' | 'when'>): IncidentVariant {
  const name = CHANNEL_NAME[i.channel];
  const title = `${name.charAt(0).toUpperCase()}${name.slice(1)} isn't answering`;
  return {
    ...base, key: 'not_answering',
    title, quote: null,
    lines: [
      { kind: 'what', text: `${title}.` },
      { kind: 'did', text: 'Callum keeps trying, and nothing waiting is lost. This clears itself once it answers.' },
      { kind: 'next', text: `If it stays quiet, connect ${name} again.` },
    ],
    waitIds: [], waitLine: null,
    primary: { label: `Connect ${name} again`, action: { kind: 'reconnect', channel: i.channel } },
    secondary: { label: 'Okay', action: { kind: 'dismiss' } },
    icon: { personId: null, glyph: i.channel === 'email' ? 'mail' : i.channel === 'x' ? 'x' : 'in', badge: 'error' },
  };
}

/**
 * The card for an open incident, or null for the ones this module does not draw: the LinkedIn check (its own flow in
 * IncidentCard) and a failed reply whose message is no longer in the outbox.
 */
export function incidentVariant(incident: Incident, state: AppState, now: Date): IncidentVariant | null {
  const tz = state.settings.timezone;
  const base = { id: `incident-${incident.id}`, incidentId: incident.id, when: whenText(incident.createdAt, tz, now) };
  switch (incident.kind) {
    case 'mailbox_signed_out':
    case 'x_signed_out':
    case 'linkedin_signed_out': return signedOut(incident, state, base);
    case 'reply_unread': return replyUnread(incident, state, base);
    case 'not_answering': return notAnswering(incident, base);
    case 'bounces': return bounces(incident, base);
    case 'x_limit': return xLimit(incident, state, base, tz, now);
    case 'send_failed': return sendFailed(incident, state, base);
    case 'linkedin_weekly_limit': return weeklyLimit(incident, state, base);
    case 'linkedin_check': return null;
  }
}

/** Everyone who asked not to be contacted in the last day: a quiet card each, nothing to decide. */
export function stopVariants(state: AppState, now: Date): IncidentVariant[] {
  const since = new Date(now.getTime() - STOP_SHOWN_MS).toISOString();
  const tz = state.settings.timezone;
  return state.people
    .filter((p) => p.status === 'stopped' && p.replyKind === 'stop' && p.repliedAt !== null && p.repliedAt >= since)
    .sort((a, b) => (b.repliedAt ?? '').localeCompare(a.repliedAt ?? ''))
    .map((p) => ({
      key: 'stop' as const,
      id: `stop-${p.id}-${p.repliedAt}`,
      incidentId: null,
      title: `${p.firstName} asked not to be contacted`,
      when: whenText(p.repliedAt ?? '', tz, now),
      quote: p.lastInbound,
      lines: [
        { kind: 'did' as const, text: `Callum stopped everything and won't reach out again. It stays in ${p.firstName}'s history.` },
        { kind: 'next' as const, text: 'Nothing to do.' },
      ],
      waitIds: [], waitLine: null,
      primary: OKAY, secondary: null,
      icon: { personId: p.id, glyph: null, badge: null },
    }));
}

/** Every card the situation calls for, open incidents first. */
export function allVariants(state: AppState, now: Date): IncidentVariant[] {
  const fromIncidents = state.incidents.flatMap((i) => {
    const v = i.state === 'open' ? incidentVariant(i, state, now) : null;
    return v ? [v] : [];
  });
  return [...fromIncidents, ...stopVariants(state, now)];
}

// ---- the faces in the river ----------------------------------------------------------------------------

export type FaceMarkKind = 'pause' | 'error' | 'in' | 'mail' | 'x' | 'stop' | 'away' | 'intro';

/** How a face in the river reacts to what is going on: a mark in its corner, stillness, fading. */
export interface FaceReaction {
  mark: FaceMarkKind | null;
  /** Grey and still: Callum is holding this person. */
  still: boolean;
  faded: boolean;
  /** A red ring: a message to this person did not go. */
  errorRing: boolean;
  /** Said for screen readers, added to the face's label. */
  label: string;
}

const CALM: FaceReaction = { mark: null, still: false, faded: false, errorRing: false, label: '' };
const FALLBACK_MARK: Record<Channel, FaceMarkKind> = { email: 'mail', linkedin: 'in', x: 'x' };

/** Which faces react, and how, for the open incidents, the people who asked to stop, and the quiet moments. */
export function faceReactions(state: AppState, quiet: QuietSnapshot | null = null, now: Date = new Date()): Map<number, FaceReaction> {
  const out = new Map<number, FaceReaction>();
  const set = (id: number, r: Partial<FaceReaction>): void => {
    out.set(id, { ...CALM, ...(out.get(id) ?? {}), ...r });
  };
  const alive = new Set(state.people.map((p) => p.id));
  for (const i of state.incidents) {
    if (i.state !== 'open') continue;
    if (i.kind === 'mailbox_signed_out' || i.kind === 'x_limit' || i.kind === 'x_signed_out' || i.kind === 'linkedin_signed_out') {
      for (const p of waitingOn(state.people, i.channel)) set(p.id, { mark: 'pause', still: true, label: 'waiting' });
    } else if (i.kind === 'linkedin_weekly_limit') {
      for (const p of state.people) {
        if (p.channel === 'linkedin' && p.status === 'active' && p.stage === 'stranger' && p.touches === 0 && p.linkedinState === 'none') set(p.id, { mark: 'pause', still: true, label: 'waiting' });
      }
    } else if (i.kind === 'bounces') {
      for (const b of parseBounce(i.detail)?.people ?? []) {
        if (alive.has(b.id) && b.fallback) set(b.id, { mark: FALLBACK_MARK[b.fallback], label: `moved to ${CHANNEL_NAME[b.fallback]}` });
      }
    } else if (i.kind === 'send_failed' && i.personId !== null && alive.has(i.personId)) {
      set(i.personId, { mark: 'error', errorRing: true, label: 'reply did not go' });
    } else if (i.kind === 'linkedin_check') {
      for (const p of waitingOn(state.people, 'linkedin')) set(p.id, { mark: 'pause', still: true, label: 'waiting' });
    }
  }
  for (const v of stopVariants(state, now)) {
    const id = v.icon.personId;
    if (id !== null) set(id, { mark: 'stop', faded: true, label: 'asked not to be contacted' });
  }
  for (const a of quiet?.away ?? []) if (alive.has(a.personId)) set(a.personId, { mark: 'away', still: true, label: `away until ${a.until ?? 'later'}` });
  for (const r of quiet?.referrals ?? []) if (alive.has(r.personId)) set(r.personId, { mark: 'intro', label: 'warm introduction' });
  return out;
}
