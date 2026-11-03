const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Parts { year: number; month: number; day: number; hour: number; minute: number }

function partsIn(date: Date, tz: string): Parts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

const dayNumber = (p: Parts) => Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
const weekdayOf = (p: Parts) => WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()] ?? '';

/** `today`, `tomorrow`, `yesterday`, `Fri` inside a week either way, else `12 Nov`. */
export function dayLabel(iso: string, tz: string, now: Date): string {
  const at = partsIn(new Date(iso), tz);
  const here = partsIn(now, tz);
  const gap = dayNumber(at) - dayNumber(here);
  if (gap === 0) return 'today';
  if (gap === 1) return 'tomorrow';
  if (gap === -1) return 'yesterday';
  if (Math.abs(gap) < 7) return weekdayOf(at).slice(0, 3);
  return `${at.day} ${MONTHS[at.month - 1]}`;
}

/** The weekday in full when it is inside the coming week, else `12 Nov`: for `comes back on Monday`. */
export function dayName(iso: string, tz: string, now: Date): string {
  const at = partsIn(new Date(iso), tz);
  const gap = dayNumber(at) - dayNumber(partsIn(now, tz));
  if (gap >= 1 && gap <= 7) return weekdayOf(at);
  if (gap === 0) return 'today';
  return `${at.day} ${MONTHS[at.month - 1]}`;
}

/** `today at 7:40`, `yesterday at 16:05`, `Tue at 9:00`, `12 Nov at 9:00`: for something that already happened. */
export function formatWhen(iso: string, tz: string, now: Date): string {
  const at = partsIn(new Date(iso), tz);
  return `${dayLabel(iso, tz, now)} at ${at.hour}:${String(at.minute).padStart(2, '0')}`;
}

/** The hour of day in the person's time zone, for greetings. */
export function hourIn(now: Date, tz: string): number {
  return partsIn(now, tz).hour;
}
