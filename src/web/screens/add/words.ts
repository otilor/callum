import type { PreviewPerson, SkipGroup } from '../../../shared/types.js';
import { joinNames } from '../../ui/format.js';

/** A stable number for a face, so the same person always gets the same marble. */
export function seedOf(text: string): number {
  let h = 7;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) >>> 0;
  return 600 + (h % 1000);
}

export const firstOf = (p: PreviewPerson): string => p.firstName ?? (p.name.split(/\s+/)[0] || p.name);

export function shownName(p: PreviewPerson): string {
  return p.name;
}

export function shownSub(p: PreviewPerson): string {
  return [p.role, p.company].filter(Boolean).join(' at ') || p.email || p.linkedinUrl || p.xHandle || '';
}

export function faceLabel(p: PreviewPerson): string {
  const sub = shownSub(p);
  return sub ? `${shownName(p)}, ${sub}` : shownName(p);
}

/** `Tomorrow` or `Monday`: the day Callum can first write, counting weekdays from `now` in the user's time zone. */
export function firstHelloWords(now: Date, tz: string): string {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
  const ahead = weekday === 'Fri' ? 3 : weekday === 'Sat' ? 2 : 1;
  return ahead === 1 ? 'tomorrow at 9:00' : 'Monday at 9:00';
}

const MAX_NAMES = 5;
function namesIn(group: SkipGroup): string {
  const names = group.names;
  if (names.length <= MAX_NAMES) return joinNames(names);
  const more = names.length - MAX_NAMES;
  return `${names.slice(0, MAX_NAMES).join(', ')} and ${more} more`;
}

/** The sentence under a skipped group when it opens: who, and why they stay out. */
export function skipDetail(group: SkipGroup): string {
  const who = namesIn(group);
  const one = group.names.length === 1;
  switch (group.reason) {
    case 'known':
      return `${who} ${one ? 'is' : 'are'} in your Sent folder, so no cold hello for them.`;
    case 'duplicate':
      return `${who} ${one ? 'is' : 'are'} already in Callum. They hear from you once.`;
    case 'other_project':
      return `${who} ${one ? 'is' : 'are'} in ${group.projectName ?? 'another project'}. Each person belongs to one project, so they stay there.`;
    case 'stopped':
      return `${who} asked to stop. Callum never writes to them again, in any project.`;
    case 'no_channel':
      return `${who} ${one ? 'has' : 'have'} a name and nothing else. Add an email or a profile link and bring the list again.`;
  }
}
