import type { Skipped } from '../../server/leads/parse.js';

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

/** `today at 9:00`, `tomorrow at 9:00`, `Thursday at 9:00` inside the coming week, then `12 Nov at 9:00`. */
export function formatSlot(iso: string, tz: string, now: Date): string {
  const at = partsIn(new Date(iso), tz);
  const here = partsIn(now, tz);
  const dayOf = (p: Parts) => Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
  const ahead = dayOf(at) - dayOf(here);
  const time = `${at.hour}:${String(at.minute).padStart(2, '0')}`;
  if (ahead === 0) return `today at ${time}`;
  if (ahead === 1) return `tomorrow at ${time}`;
  if (ahead > 1 && ahead < 7) return `${WEEKDAYS[new Date(Date.UTC(at.year, at.month - 1, at.day)).getUTCDay()]} at ${time}`;
  return `${at.day} ${MONTHS[at.month - 1]} at ${time}`;
}

/** `Nneka`, `Nneka and Temi`, `Ada, Nneka and Temi`. */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

const NAME_KEYS: [string, string][] = [
  ['payroll', 'Payroll'], ['reconcil', 'Reconciliation'], ['invoic', 'Invoicing'], ['recruit', 'Recruiting'], ['hiring', 'Hiring'],
  ['onboard', 'Onboarding'], ['complian', 'Compliance'], ['expense', 'Expenses'], ['billing', 'Billing'], ['benefit', 'Benefits'],
  ['treasury', 'Treasury'], ['security', 'Security'], ['analytic', 'Analytics'], ['accounting', 'Accounting'], ['insur', 'Insurance'],
  ['procure', 'Procurement'], ['tax', 'Tax'],
];
const STOP_WORDS = new Set([
  'that', 'with', 'their', 'teams', 'team', 'help', 'helps', 'without', 'growing', 'companies', 'lagos', 'accra', 'which', 'about',
  'people', 'plate', 'take', 'from', 'your', 'every',
]);

/**
 * A short project name read off the offer, shown under the offer field while the person types.
 * The server names the project when none is sent, so this is the preview of that, never a different rule.
 */
export function suggestProjectName(offer: string): string {
  const low = offer.toLowerCase();
  let best = -1;
  let name = '';
  for (const [key, label] of NAME_KEYS) {
    const at = low.indexOf(key);
    if (at >= 0 && (best < 0 || at < best)) {
      best = at;
      name = label;
    }
  }
  if (name) return name;
  const word = low.replace(/[^a-z ]/g, ' ').split(/\s+/).find((w) => w.length > 5 && !STOP_WORDS.has(w));
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : '';
}

/** `Skipped 3: 1 is already on your list, 2 are already in Payroll.` Empty when nobody was skipped. */
export function skippedLine(skipped: Skipped[]): string {
  if (skipped.length === 0) return '';
  const groups = new Map<string, number>();
  for (const s of skipped) {
    const key = s.reason === 'other_project' ? `other_project\u0000${s.projectName ?? 'another project'}` : s.reason;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [key, n] of groups) {
    const one = n === 1;
    const [reason, project] = key.split('\u0000') as [string, string | undefined];
    const phrase =
      reason === 'duplicate' ? `${one ? 'is' : 'are'} already on your list`
      : reason === 'known' ? `${one ? 'is' : 'are'} already known to Callum`
      : reason === 'stopped' ? 'asked not to be contacted'
      : reason === 'other_project' ? `${one ? 'is' : 'are'} already in ${project}`
      : `${one ? 'has' : 'have'} no email or profile to write to`;
    parts.push(`${n} ${phrase}`);
  }
  return `Skipped ${skipped.length}: ${parts.join(', ')}.`;
}
