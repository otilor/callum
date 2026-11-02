import { addLocalDays, localParts, startOfLocalDay, zonedTime } from '../engine/time.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const NOTE_HOUR = 8;
export const NOTE_MINUTE = 30;

/** The Monday at 8:30 (user time) the weekly note was last due: now, or the Monday before. */
export function lastNoteAt(now: Date, tz: string): Date {
  const p = localParts(now, tz);
  const back = (p.weekday + 6) % 7;
  const monday = zonedTime(tz, p.year, p.month, p.day - back, NOTE_HOUR, NOTE_MINUTE);
  return monday.getTime() <= now.getTime() ? monday : zonedTime(tz, p.year, p.month, p.day - back - 7, NOTE_HOUR, NOTE_MINUTE);
}

/** The same wall time n days later (or earlier) in `tz`. */
export const shiftDays = (d: Date, n: number, tz: string): Date => addLocalDays(d, n, tz);

export const dayName = (d: Date, tz: string): string => WEEKDAYS[localParts(d, tz).weekday] ?? '';

/** `16 November` */
export function dayMonth(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.day} ${MONTHS[p.month - 1]}`;
}

/** `Friday 13 November` */
export const longDay = (d: Date, tz: string): string => `${dayName(d, tz)} ${dayMonth(d, tz)}`;

export function clock(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.hour}:${String(p.minute).padStart(2, '0')}`;
}

/** `today at 9:00`, `tomorrow at 9:00`, `Thursday at 9:00` inside the coming week, then `12 November at 9:00`. */
export function slotText(iso: string, tz: string, now: Date): string {
  const at = new Date(iso);
  const dayOf = (d: Date): number => {
    const p = localParts(d, tz);
    return Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
  };
  const ahead = dayOf(at) - dayOf(now);
  const time = clock(at, tz);
  if (ahead === 0) return `today at ${time}`;
  if (ahead === 1) return `tomorrow at ${time}`;
  if (ahead > 1 && ahead < 7) return `${dayName(at, tz)} at ${time}`;
  return `${dayMonth(at, tz)} at ${time}`;
}

export { startOfLocalDay };
