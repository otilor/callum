import { describe, expect, it } from 'vitest';
import { formatCount, formatSlot, joinNames, skippedLine, suggestProjectName } from './format.js';

const NOW = new Date('2026-11-02T10:00:00Z'); // Monday 11:00 in Lagos
const TZ = 'Africa/Lagos';

describe('formatSlot', () => {
  it('says today, tomorrow, the weekday inside a week, then the date', () => {
    expect(formatSlot('2026-11-02T15:00:00Z', TZ, NOW)).toBe('today at 16:00');
    expect(formatSlot('2026-11-03T08:00:00Z', TZ, NOW)).toBe('tomorrow at 9:00');
    expect(formatSlot('2026-11-05T08:00:00Z', TZ, NOW)).toBe('Thursday at 9:00');
    expect(formatSlot('2026-11-08T08:30:00Z', TZ, NOW)).toBe('Sunday at 9:30');
    expect(formatSlot('2026-11-12T08:00:00Z', TZ, NOW)).toBe('12 Nov at 9:00');
  });

  it('reads the calendar day in the given zone, not in UTC', () => {
    // 23:30 UTC on Monday is already Tuesday 00:30 in Lagos.
    expect(formatSlot('2026-11-02T23:30:00Z', TZ, NOW)).toBe('tomorrow at 0:30');
    expect(formatSlot('2026-11-02T23:30:00Z', 'UTC', NOW)).toBe('today at 23:30');
  });

  it('uses the date for a day a week out, so the weekday is never ambiguous', () => {
    expect(formatSlot('2026-11-09T08:00:00Z', TZ, NOW)).toBe('9 Nov at 9:00');
  });
});

describe('joinNames', () => {
  it('joins with commas and and', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Nneka'])).toBe('Nneka');
    expect(joinNames(['Nneka', 'Temi'])).toBe('Nneka and Temi');
    expect(joinNames(['Ada', 'Nneka', 'Temi'])).toBe('Ada, Nneka and Temi');
  });
});

describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(48000)).toBe('48,000');
    expect(formatCount(7)).toBe('7');
  });
});

describe('suggestProjectName', () => {
  it('names the project after what is offered', () => {
    expect(suggestProjectName('You help fintech teams take reconciliation off their ops team\'s plate.')).toBe('Reconciliation');
    expect(suggestProjectName('You help growing teams in Lagos and Accra run payroll without spreadsheets.')).toBe('Payroll');
  });

  it('falls back to the first long word and to nothing', () => {
    expect(suggestProjectName('We build lighting for restaurants')).toBe('Lighting');
    expect(suggestProjectName('')).toBe('');
    expect(suggestProjectName('you help us')).toBe('');
  });
});

describe('skippedLine', () => {
  it('counts skipped people by reason in plain words', () => {
    expect(skippedLine([])).toBe('');
    expect(
      skippedLine([
        { name: 'A', reason: 'duplicate' },
        { name: 'B', reason: 'stopped' },
        { name: 'C', reason: 'other_project', projectName: 'Payroll' },
        { name: 'D', reason: 'other_project', projectName: 'Payroll' },
        { name: 'E', reason: 'no_channel' },
      ]),
    ).toBe('Skipped 5: 1 is already on your list, 1 asked not to be contacted, 2 are already in Payroll, 1 has no email or profile to write to.');
  });
});
