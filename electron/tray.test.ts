import { describe, expect, it, vi } from 'vitest';
import * as time from '../src/server/engine/time.js';
import { menuTemplate, nextMondayMorning, statusLine, type TrayStatus } from './tray.js';

const running: TrayStatus = { pauseState: 'running', pausedUntil: null, linkedinNeedsYou: false };
const actions = () => ({ open: vi.fn(), takeBreak: vi.fn(), resume: vi.fn(), quit: vi.fn() });

describe('statusLine', () => {
  it('says Running when nothing is wrong', () => {
    expect(statusLine(running, 'Africa/Lagos', new Date('2026-11-02T10:00:00Z'))).toBe('Running');
  });

  it('names the day a break ends', () => {
    const paused: TrayStatus = { pauseState: 'paused', pausedUntil: '2026-11-09T08:00:00.000Z', linkedinNeedsYou: false };
    expect(statusLine(paused, 'Africa/Lagos', new Date('2026-11-02T10:00:00Z'))).toBe('Paused until Monday');
  });

  it('names the date when the break is more than a week away', () => {
    const paused: TrayStatus = { pauseState: 'paused', pausedUntil: '2027-01-06T08:00:00.000Z', linkedinNeedsYou: false };
    expect(statusLine(paused, 'Africa/Lagos', new Date('2026-11-02T10:00:00Z'))).toBe('Paused until January 6');
  });

  it('says Paused for a break with no end', () => {
    expect(statusLine({ pauseState: 'paused', pausedUntil: null, linkedinNeedsYou: false }, 'UTC', new Date())).toBe('Paused');
  });

  it('says when LinkedIn needs the person, unless everything is paused anyway', () => {
    expect(statusLine({ ...running, linkedinNeedsYou: true }, 'UTC', new Date())).toBe('LinkedIn needs you');
    expect(statusLine({ pauseState: 'paused', pausedUntil: '2026-11-09T08:00:00.000Z', linkedinNeedsYou: true }, 'UTC', new Date('2026-11-02T10:00:00Z'))).toBe('Paused until Monday');
  });

  it('says so when Callum is wrapped up', () => {
    expect(statusLine({ ...running, pauseState: 'wrapped' }, 'UTC', new Date())).toBe('Wrapped up');
  });
});

describe('nextMondayMorning', () => {
  it('is 9:00 on the next Monday in the person\'s time zone', () => {
    // Monday 2 November 2026 10:00 in Lagos: the next Monday is 9 November.
    expect(nextMondayMorning(new Date('2026-11-02T09:00:00Z'), 'Africa/Lagos', time).toISOString()).toBe('2026-11-09T08:00:00.000Z');
    // Wednesday: the Monday after.
    expect(nextMondayMorning(new Date('2026-11-04T09:00:00Z'), 'Africa/Lagos', time).toISOString()).toBe('2026-11-09T08:00:00.000Z');
    // Sunday evening in New York is already Monday in UTC, but not there.
    expect(nextMondayMorning(new Date('2026-11-09T02:00:00Z'), 'America/New_York', time).toISOString()).toBe('2026-11-09T14:00:00.000Z');
  });
});

describe('menuTemplate', () => {
  it('has Open Callum, the status, the break and Quit Callum', () => {
    const items = menuTemplate(running, 'UTC', new Date('2026-11-02T10:00:00Z'), actions()).filter((i) => i.type !== 'separator');
    expect(items.map((i) => i.label)).toEqual(['Open Callum', 'Running', 'Take a break until Monday', 'Quit Callum']);
    expect(items[1]?.enabled).toBe(false);
  });

  it('offers Resume while paused', () => {
    const paused: TrayStatus = { pauseState: 'paused', pausedUntil: '2026-11-09T08:00:00.000Z', linkedinNeedsYou: false };
    const items = menuTemplate(paused, 'UTC', new Date('2026-11-02T10:00:00Z'), actions()).filter((i) => i.type !== 'separator');
    expect(items.map((i) => i.label)).toEqual(['Open Callum', 'Paused until Monday', 'Resume', 'Quit Callum']);
  });

  it('wires each item to its action', () => {
    const a = actions();
    const items = menuTemplate(running, 'UTC', new Date(), a).filter((i) => i.type !== 'separator');
    for (const item of items) (item.click as (() => void) | undefined)?.();
    expect(a.open).toHaveBeenCalledOnce();
    expect(a.takeBreak).toHaveBeenCalledOnce();
    expect(a.quit).toHaveBeenCalledOnce();
    expect(a.resume).not.toHaveBeenCalled();
  });
});
