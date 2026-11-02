import type { Channel, Message, Person } from '../../../shared/types.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Parts { year: number; month: number; day: number; hour: number; minute: number }

function partsIn(date: Date, tz: string): Parts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

const dayOf = (p: Parts) => Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
const clock = (p: Parts) => `${p.hour}:${String(p.minute).padStart(2, '0')}`;

/** `Today 7:40`, `Yesterday 8:02`, `Tue 9:12` inside the week either side, then `14 Oct 9:12`. */
export function whenShort(iso: string, tz: string, now: Date): string {
  const at = partsIn(new Date(iso), tz);
  const here = partsIn(now, tz);
  const ahead = dayOf(at) - dayOf(here);
  const time = clock(at);
  if (ahead === 0) return `Today ${time}`;
  if (ahead === 1) return `Tomorrow ${time}`;
  if (ahead === -1) return `Yesterday ${time}`;
  if (Math.abs(ahead) < 7) return `${WEEKDAYS[new Date(Date.UTC(at.year, at.month - 1, at.day)).getUTCDay()]} ${time}`;
  return `${at.day} ${MONTHS[at.month - 1]} ${time}`;
}

/** `3 February`: the day, for "Resting until 3 February". */
export function dayLong(iso: string, tz: string): string {
  const p = partsIn(new Date(iso), tz);
  return `${p.day} ${LONG_MONTHS[p.month - 1]}`;
}

/** A line without its full stop, as a sentence with exactly one. */
export const sentence = (line: string): string => `${line.replace(/\.+$/, '')}.`;

export const CHANNEL_NAME: Record<Channel, string> = { email: 'email', linkedin: 'LinkedIn', x: 'X' };
export const CHANNEL_BY: Record<Channel, string> = { email: 'by email', linkedin: 'on LinkedIn', x: 'on X' };
export const LAST_MESSAGE: Record<Channel, string> = { email: 'email', linkedin: 'LinkedIn message', x: 'X message' };

/** Which side of the conversation a message is on: Callum's, the user's own, or the person's. */
export type Voice = 'callum' | 'you' | 'them';
export function voiceOf(m: Message): Voice {
  if (m.direction === 'in') return 'them';
  return m.kind === 'reply' || m.kind === 'booking' || m.kind === 'close' ? 'you' : 'callum';
}

export function threadMeta(messages: Message[]): string {
  const names: Channel[] = [];
  for (const m of messages) if (!names.includes(m.channel)) names.push(m.channel);
  const count = `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`;
  if (names.length === 0) return count;
  const label = names.map((c) => (c === 'email' ? 'Email' : CHANNEL_NAME[c])).join(' and ');
  return `${label} · ${count}`;
}

/** The line above a message: who, on which channel, and the exact time. */
export function messageMeta(m: Message, person: Person, tz: string, now: Date): string {
  const voice = voiceOf(m);
  const via = m.kind === 'invite' ? 'invite note on LinkedIn' : CHANNEL_BY[m.channel];
  const who = voice === 'them' ? person.firstName : voice === 'you' ? 'You' : 'Callum';
  return `${who}, ${via} · ${whenShort(m.at, tz, now)}`;
}
