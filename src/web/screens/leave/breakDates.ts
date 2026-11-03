import { localParts, zonedTime } from '../../../server/engine/time.js';
import { nextMonday } from '../../../server/engine/windows.js';

/** Callum starts again at 9:00 in the person's own time zone. */
const RESUME_HOUR = 9;

export type BreakKey = 'monday' | 'two' | 'jan';

export interface BreakChoice {
  key: BreakKey;
  /** The chip. */
  label: string;
  /** The button that starts the break. */
  button: string;
  until: Date;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dayName(month: number, day: number): string {
  return `${MONTHS[month - 1] ?? ''} ${day}`;
}

/** The three ready-made breaks, as 9:00 in `tz`: next Monday, two weeks from today, the next January 6. */
export function breakChoices(now: Date, tz: string): BreakChoice[] {
  const here = localParts(now, tz);
  // Monday and January 6 are searched from the start of the next local day, so a break never ends today.
  const tomorrow = zonedTime(tz, here.year, here.month, here.day + 1, 0);
  const jan = zonedTime(tz, here.year, 1, 6, RESUME_HOUR);
  return [
    { key: 'monday', label: 'Until Monday', button: 'Pause until Monday', until: nextMonday(tomorrow, tz, RESUME_HOUR) },
    { key: 'two', label: 'Two weeks', button: 'Pause for two weeks', until: zonedTime(tz, here.year, here.month, here.day + 14, RESUME_HOUR) },
    {
      key: 'jan',
      label: 'Until January 6',
      button: 'Pause until January 6',
      until: jan.getTime() >= tomorrow.getTime() ? jan : zonedTime(tz, here.year + 1, 1, 6, RESUME_HOUR),
    },
  ];
}

/** Tomorrow in `tz`, as `YYYY-MM-DD`: the earliest day a break can end. */
export function earliestPick(now: Date, tz: string): string {
  const p = localParts(now, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day + 1)).toISOString().slice(0, 10);
}

/** A break that ends on a day the person picked (`YYYY-MM-DD`). Null when the day is missing or not after today. */
export function pickedBreak(isoDay: string, now: Date, tz: string): BreakChoice | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const until = zonedTime(tz, year, month, day, RESUME_HOUR);
  const back = localParts(until, tz);
  if (back.year !== year || back.month !== month || back.day !== day) return null;
  if (until.getTime() <= now.getTime()) return null;
  const name = dayName(month, day);
  return { key: 'monday', label: name, button: `Pause until ${name}`, until };
}
