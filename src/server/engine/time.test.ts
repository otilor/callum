import { describe, expect, it } from 'vitest';
import { addDays, addLocalDays, localParts, startOfLocalDay, zonedTime } from './time.js';
import { fixedClock } from './clock.js';

describe('zonedTime', () => {
  it('converts Lagos wall time (UTC+1, no DST)', () => {
    expect(zonedTime('Africa/Lagos', 2026, 11, 3, 9).toISOString()).toBe('2026-11-03T08:00:00.000Z');
  });
  it('is correct on both sides of the New York DST change', () => {
    expect(zonedTime('America/New_York', 2027, 3, 15, 9).toISOString()).toBe('2027-03-15T13:00:00.000Z');
    expect(zonedTime('America/New_York', 2027, 3, 12, 9).toISOString()).toBe('2027-03-12T14:00:00.000Z');
  });
  it('honours minutes', () => {
    expect(zonedTime('Africa/Lagos', 2026, 11, 3, 9, 30).toISOString()).toBe('2026-11-03T08:30:00.000Z');
  });
});

describe('localParts', () => {
  it('reports weekday 1 for a Monday in UTC', () => {
    const p = localParts(new Date('2026-11-02T12:00:00Z'), 'UTC');
    expect(p).toEqual({ year: 2026, month: 11, day: 2, hour: 12, minute: 0, weekday: 1 });
  });
  it('reports midnight as hour 0, not 24', () => {
    expect(localParts(new Date('2026-11-02T23:00:00Z'), 'Africa/Lagos').hour).toBe(0);
  });
  it('moves to the next local day ahead of UTC', () => {
    const p = localParts(new Date('2026-11-02T23:30:00Z'), 'Africa/Lagos');
    expect([p.day, p.weekday, p.hour, p.minute]).toEqual([3, 2, 0, 30]);
  });
});

describe('day helpers', () => {
  it('startOfLocalDay gives local midnight', () => {
    expect(startOfLocalDay(new Date('2026-11-02T12:00:00Z'), 'Africa/Lagos').toISOString()).toBe('2026-11-01T23:00:00.000Z');
  });
  it('addDays adds 24h multiples', () => {
    expect(addDays(new Date('2027-03-13T14:00:00Z'), 1).toISOString()).toBe('2027-03-14T14:00:00.000Z');
  });
  it('addLocalDays keeps the wall time across DST', () => {
    const before = zonedTime('America/New_York', 2027, 3, 13, 9);
    expect(addLocalDays(before, 1, 'America/New_York').toISOString()).toBe('2027-03-14T13:00:00.000Z');
    expect(addLocalDays(before, 30, 'America/New_York').toISOString()).toBe('2027-04-12T13:00:00.000Z');
  });
});

describe('fixedClock', () => {
  it('sets and advances', () => {
    const c = fixedClock('2026-11-02T10:00:00Z');
    expect(c.now().toISOString()).toBe('2026-11-02T10:00:00.000Z');
    c.advance(60_000);
    expect(c.now().toISOString()).toBe('2026-11-02T10:01:00.000Z');
    c.set('2026-12-01T00:00:00Z');
    expect(c.now().toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});
