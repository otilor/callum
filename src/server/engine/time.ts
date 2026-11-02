// Time-zone arithmetic. Intl only, no date libraries. All other engine code goes through here.

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(d: Date, tz: string): LocalParts {
  const v: Record<string, number> = {};
  for (const part of formatterFor(tz).formatToParts(d)) {
    if (part.type !== 'literal') v[part.type] = Number(part.value);
  }
  const year = v.year ?? 0;
  const month = v.month ?? 1;
  const day = v.day ?? 1;
  return {
    year,
    month,
    day,
    hour: (v.hour ?? 0) % 24,
    minute: v.minute ?? 0,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Weekday (0 = Sunday) of a calendar date, independent of any zone. Day may overflow the month. */
export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The instant at which the wall clock in `tz` reads the given date and time. Correct across DST. */
export function zonedTime(tz: string, year: number, month: number, day: number, hour: number, minute = 0): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wall - shown;
  }
  return new Date(guess);
}

export function startOfLocalDay(d: Date, tz: string): Date {
  const p = localParts(d, tz);
  return zonedTime(tz, p.year, p.month, p.day, 0);
}

/** Adds whole 24-hour multiples. */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** Same wall time n calendar days later in `tz`. */
export function addLocalDays(d: Date, n: number, tz: string): Date {
  const p = localParts(d, tz);
  return zonedTime(tz, p.year, p.month, p.day + n, p.hour, p.minute);
}
