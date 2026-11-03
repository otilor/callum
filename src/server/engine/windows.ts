import { localParts, weekdayOf, zonedTime } from './time.js';

export const SEND_START_HOUR = 9;
export const SEND_END_HOUR = 17;

const isWeekday = (weekday: number) => weekday >= 1 && weekday <= 5;

/** Mon-Fri, 9:00 <= local time < 17:00. */
export function isSendingTime(d: Date, tz: string): boolean {
  const p = localParts(d, tz);
  return isWeekday(p.weekday) && p.hour >= SEND_START_HOUR && p.hour < SEND_END_HOUR;
}

/** The first instant strictly after `from` that is `hour`:00 local on a day whose weekday passes `allowed`. */
function nextAt(from: Date, tz: string, hour: number, allowed: (weekday: number) => boolean): Date {
  const p = localParts(from, tz);
  for (let i = 0; i <= 8; i++) {
    if (!allowed(weekdayOf(p.year, p.month, p.day + i))) continue;
    const candidate = zonedTime(tz, p.year, p.month, p.day + i, hour);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  throw new Error(`No slot found after ${from.toISOString()} in ${tz}`);
}

/** `from` if it is already sending time, else the next 9:00 on a weekday. */
export function nextSendingTime(from: Date, tz: string): Date {
  return isSendingTime(from, tz) ? from : nextAt(from, tz, SEND_START_HOUR, isWeekday);
}

/** 9:00 on the next weekday after `startedAt`'s local day, never the same day. */
export function firstSlotAfterStart(startedAt: Date, tz: string): Date {
  const p = localParts(startedAt, tz);
  for (let i = 1; i <= 8; i++) {
    if (isWeekday(weekdayOf(p.year, p.month, p.day + i))) {
      return zonedTime(tz, p.year, p.month, p.day + i, SEND_START_HOUR);
    }
  }
  throw new Error('unreachable');
}

/** The next weekday at `hour`:00 local, strictly after `from`. */
export function nextLocalHour(from: Date, tz: string, hour: number): Date {
  return nextAt(from, tz, hour, isWeekday);
}

/** The next Monday at `hour` (default 0) local, strictly after `from`. */
export function nextMonday(from: Date, tz: string, hour = 0): Date {
  return nextAt(from, tz, hour, (weekday) => weekday === 1);
}
