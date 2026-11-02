import type { Channel, Person, Project } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { localParts } from '../engine/time.js';
import { UserError } from './errors.js';

export function requirePerson(ctx: Ctx, id: number): Person {
  const person = ctx.repo.getPerson(id);
  if (!person) throw new UserError("Callum can't find that person.", 404);
  return person;
}

export function requireProject(ctx: Ctx, id: number): Project {
  const project = ctx.repo.getProject(id);
  if (!project) throw new UserError("Callum can't find that project.", 404);
  return project;
}

export const userTz = (ctx: Ctx): string => ctx.repo.getSettings().timezone;

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The channel as a name inside a sentence. */
export const CHANNEL_NAME: Record<Channel, string> = { email: 'email', linkedin: 'LinkedIn', x: 'X' };
/** The channel after "by" or "on", as in "8 by email and 4 on LinkedIn". */
export const CHANNEL_PHRASE: Record<Channel, string> = { email: 'by email', linkedin: 'on LinkedIn', x: 'on X' };

/** "Kemi", "Kemi and Tunde", "Kemi, Tunde and Bola". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** An exact time in the user's words: "Thursday at 9:00", or "January 6 at 9:00" when it is more than a week away. */
export function whenText(at: Date, tz: string, now: Date): string {
  const p = localParts(at, tz);
  const time = `${p.hour}:${String(p.minute).padStart(2, '0')}`;
  if (at.getTime() - now.getTime() > 6 * 86_400_000) return `${MONTHS[p.month - 1]} ${p.day} at ${time}`;
  return `${WEEKDAYS[p.weekday]} at ${time}`;
}

export const weekdayName = (weekday: number): string => WEEKDAYS[weekday] ?? '';

/** An ISO instant the caller sent, checked. */
export function parseWhen(iso: string): Date {
  const d = new Date(iso);
  if (typeof iso !== 'string' || Number.isNaN(d.getTime())) throw new UserError('Pick a date Callum can read.');
  return d;
}

/** True when the person can be written to by hand from the dock: they wrote back and are waiting, or are already talking. */
export function canWriteBy(p: Person): boolean {
  return p.status === 'waiting' || (p.status === 'active' && p.stage === 'talking');
}
