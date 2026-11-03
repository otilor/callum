const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Parts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

function partsIn(date: Date, tz: string): Parts {
  const found = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(date);
  const get = (type: string): number => Number(found.find((p) => p.type === type)?.value ?? 0);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return { year, month, day, hour: get('hour') % 24, minute: get('minute'), weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** 0 for Sunday to 6 for Saturday, where `iso` falls in `tz`. */
export function weekdayIn(iso: string, tz: string): number {
  return partsIn(new Date(iso), tz).weekday;
}

/** `8:30` */
export function timeOf(iso: string, tz: string): string {
  const p = partsIn(new Date(iso), tz);
  return `${p.hour}:${String(p.minute).padStart(2, '0')}`;
}

/** `Monday 2 November` */
export function dayLong(iso: string, tz: string): string {
  const p = partsIn(new Date(iso), tz);
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}`;
}

/** `2 November` */
export function dayShort(iso: string, tz: string): string {
  const p = partsIn(new Date(iso), tz);
  return `${p.day} ${MONTHS[p.month - 1]}`;
}

/** `Monday 2 November, 8:30` */
export function dayAndTime(iso: string, tz: string): string {
  return `${dayLong(iso, tz)}, ${timeOf(iso, tz)}`;
}

/** A calendar date such as `2026-11-20`, as `Friday 20 November`. */
export function dateOnly(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** `Friday at 17:20` for a time in the past week, else `13 November at 17:20`. */
export function sinceText(iso: string, tz: string, now: Date): string {
  const p = partsIn(new Date(iso), tz);
  const here = partsIn(now, tz);
  const ahead = Date.UTC(here.year, here.month - 1, here.day) / 86_400_000 - Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
  const time = timeOf(iso, tz);
  return ahead < 7 ? `${WEEKDAYS[p.weekday]} at ${time}` : `${p.day} ${MONTHS[p.month - 1]} at ${time}`;
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** `three days`; past ten it stays a figure. */
export function daysWord(n: number): string {
  return `${NUMBER_WORDS[n] ?? n} ${n === 1 ? 'day' : 'days'}`;
}

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The instant it is 9:00 on a calendar day in `tz`. */
export function nineAmIso(y: number, m: number, d: number, tz: string): string {
  const wall = Date.UTC(y, m - 1, d, 9, 0);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(guess), tz);
    guess += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return new Date(guess).toISOString();
}

export interface PauseChoice { label: string; iso: string }

/** Where a long pause can end: the next two Mondays at 9:00, and the next 6 January. */
export function pauseChoices(now: Date, tz: string): PauseChoice[] {
  const here = partsIn(now, tz);
  const toMonday = ((8 - here.weekday) % 7) || 7;
  const at = (offset: number): PauseChoice => {
    const d = new Date(Date.UTC(here.year, here.month - 1, here.day + offset));
    const iso = nineAmIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), tz);
    return { iso, label: dayLong(iso, tz) };
  };
  const newYear = (year: number): PauseChoice => ({ iso: nineAmIso(year, 1, 6, tz), label: '6 January' });
  const january = newYear(here.year);
  return [at(toMonday), at(toMonday + 7), january.iso > now.toISOString() ? january : newYear(here.year + 1)];
}
