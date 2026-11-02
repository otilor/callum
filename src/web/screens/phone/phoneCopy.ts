import type { AppState, Channel, ChannelAccount, Person, Project } from '../../../shared/types.js';
import { formatSlot } from '../../ui/format.js';
import { timeOf, dayLong, weekdayIn } from '../home/quietCopy.js';

/** The three places on the bottom bar. */
export type PhoneTab = 'river' | 'ask' | 'you';
export const PHONE_TABS: { id: PhoneTab; label: string }[] = [
  { id: 'river', label: 'River' },
  { id: 'ask', label: 'Ask' },
  { id: 'you', label: 'You' },
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DAY = 86_400_000;

function dayNumber(iso: string | Date, tz: string): number {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
  const get = (type: string) => Number(p.find((x) => x.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day')) / DAY;
}

/**
 * The short time in a row: `7:40` today, `Yesterday`, `Tomorrow`, a weekday inside the week, then `12 Nov`.
 * Works for the past (a reply) and the future (the next hello).
 */
export function shortWhen(iso: string, tz: string, now: Date): string {
  const ahead = dayNumber(iso, tz) - dayNumber(now, tz);
  if (ahead === 0) return timeOf(iso, tz);
  if (ahead === -1) return 'Yesterday';
  if (ahead === 1) return 'Tomorrow';
  if (Math.abs(ahead) < 7) return WEEKDAYS[weekdayIn(iso, tz)] ?? '';
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'numeric' }).formatToParts(d);
  const day = Number(p.find((x) => x.type === 'day')?.value ?? 0);
  const month = Number(p.find((x) => x.type === 'month')?.value ?? 1);
  return `${day} ${MONTHS[month - 1]}`;
}

/** `Email, Monday 26 October at 9:12` */
export function messageMeta(channelName: string, iso: string, tz: string, now: Date): string {
  const ahead = dayNumber(now, tz) - dayNumber(iso, tz);
  const time = timeOf(iso, tz);
  const day = ahead === 0 ? 'today' : ahead === 1 ? 'yesterday' : dayLong(iso, tz);
  return `${channelName}, ${day} at ${time}`;
}

export function channelName(ch: Channel | null): string {
  return ch === 'linkedin' ? 'LinkedIn' : ch === 'x' ? 'X' : ch === 'email' ? 'Email' : '';
}

/** Whoever wrote last first. */
const byReply = (a: Person, b: Person) => (b.repliedAt ?? b.updatedAt).localeCompare(a.repliedAt ?? a.updatedAt);

/** People who want to talk, in every project, newest reply first. */
export function wantToTalk(people: Person[]): Person[] {
  return people.filter((p) => p.status === 'waiting').sort(byReply);
}

export interface RiverGroups {
  talking: Person[];
  following: Person[];
  hello: Person[];
  strangers: Person[];
  resting: Person[];
}

const live = (p: Person) => p.status === 'active' || p.status === 'held';

/** The people of one project by how far along they are. Anyone who asked to stop, was closed or removed is left out. */
export function groupByStage(people: Person[], projectId: number | null): RiverGroups {
  const mine = people.filter((p) => projectId === null || p.projectId === projectId);
  const talking = mine.filter((p) => p.stage === 'talking' && live(p)).sort(byReply);
  const rest = mine.filter((p) => p.stage !== 'talking' && live(p));
  return {
    talking,
    following: rest.filter((p) => p.stage === 'following'),
    hello: rest.filter((p) => p.stage === 'hello'),
    strangers: rest.filter((p) => p.stage === 'stranger'),
    resting: mine.filter((p) => p.status === 'snoozed' || p.status === 'resting'),
  };
}

/** What comes next for someone Callum is writing to, by their channel and how many notes have gone. */
export function nextStepLabel(p: Person): string | null {
  if (p.stage === 'talking' || p.touches >= 3) return null;
  if (p.channel === 'linkedin') {
    if (p.touches === 0) return 'Invite';
    if (p.touches === 1) return p.linkedinState === 'connected' ? 'Thank-you' : null;
    return 'Follow-up';
  }
  if (p.channel === null) return null;
  return p.touches === 0 ? 'Hello' : p.touches === 1 ? 'Follow-up' : 'Last follow-up';
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The second line of a row. */
export function rowSub(p: Person, tz: string, now: Date): string {
  if (p.status === 'waiting') return p.lastInbound ? cut(p.lastInbound, 90) : 'Wrote back';
  if (p.status === 'snoozed') return p.snoozedUntil ? `Comes back ${formatSlot(p.snoozedUntil, tz, now)}` : 'Resting for now';
  if (p.status === 'resting') return p.restUntil ? `Comes back ${formatSlot(p.restUntil, tz, now)}` : 'Resting';
  if (p.status === 'held') return 'On hold. Nothing goes out until you resume';
  if (p.stage === 'talking') return p.badge === 'booked' ? 'Call booked' : p.badge === 'sent' ? 'You answered' : 'You are talking';
  const step = nextStepLabel(p);
  if (step && p.nextTouchAt) return `${step} ${formatSlot(p.nextTouchAt, tz, now)}`;
  if (p.channel === 'linkedin' && p.linkedinState === 'invited') return 'Invite sent. Waiting for them to accept';
  if (p.stage === 'stranger') return 'Waiting for a first hello';
  return 'Waiting for a reply';
}

/** The right-hand time of a row. */
export function rowWhen(p: Person, tz: string, now: Date): string {
  if (p.status === 'waiting' && p.repliedAt) return shortWhen(p.repliedAt, tz, now);
  if (p.status === 'snoozed' && p.snoozedUntil) return shortWhen(p.snoozedUntil, tz, now);
  if (p.stage === 'talking') return p.repliedAt ? shortWhen(p.repliedAt, tz, now) : p.lastTouchAt ? shortWhen(p.lastTouchAt, tz, now) : '';
  if (p.nextTouchAt) return shortWhen(p.nextTouchAt, tz, now);
  if (p.lastTouchAt) return shortWhen(p.lastTouchAt, tz, now);
  return '';
}

/** A line about the pause at the top of the River tab and in You, or null when Callum is running. */
export function pauseLine(state: AppState, project: Project | null, tz: string): string | null {
  const { settings } = state;
  if (settings.pauseState === 'wrapped') return 'Callum is wrapped up. Nothing goes out.';
  if (settings.pauseState === 'paused') {
    return settings.pausedUntil
      ? `Callum is paused until ${dayLong(settings.pausedUntil, tz)}. Replies still reach you, and nothing automatic goes out.`
      : 'Callum is paused. Replies still reach you, and nothing automatic goes out.';
  }
  if (project?.state === 'paused') return `${project.name} is paused. Replies still reach you, and nothing automatic goes out.`;
  return null;
}

/** The pace line of a channel when the server's own line has not arrived. */
export function paceFallback(acc: ChannelAccount | undefined, tz: string): string {
  if (!acc || acc.status === 'disconnected') return 'Not connected yet';
  if (acc.status === 'error') return 'Needs to be connected again';
  if (acc.status === 'paused') return acc.pausedUntil ? `Paused until ${dayLong(acc.pausedUntil, tz)}` : 'Paused';
  return acc.halfPaceUntil ? `Easing back in until ${dayLong(acc.halfPaceUntil, tz)}` : 'Running';
}

/** The word shown for a channel. */
export const CHANNEL_LABEL: Record<Channel, string> = { email: 'Email', linkedin: 'LinkedIn', x: 'X' };
