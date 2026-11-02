import { describe, expect, it } from 'vitest';
import { firstSlotAfterStart, isSendingTime, nextLocalHour, nextMonday, nextSendingTime } from './windows.js';
import { zonedTime } from './time.js';

const LAGOS = 'Africa/Lagos';
const NY = 'America/New_York';
// 2026-11-02 is a Monday.
const lagos = (day: number, hour: number, minute = 0) => zonedTime(LAGOS, 2026, 11, day, hour, minute);

describe('isSendingTime', () => {
  it('is true on Tuesday 10:00', () => expect(isSendingTime(lagos(3, 10), LAGOS)).toBe(true));
  it('includes 9:00 and excludes 17:00', () => {
    expect(isSendingTime(lagos(3, 9), LAGOS)).toBe(true);
    expect(isSendingTime(lagos(3, 8, 59), LAGOS)).toBe(false);
    expect(isSendingTime(lagos(3, 16, 59), LAGOS)).toBe(true);
    expect(isSendingTime(lagos(3, 17), LAGOS)).toBe(false);
  });
  it('is false on Saturday and Sunday', () => {
    expect(isSendingTime(lagos(7, 10), LAGOS)).toBe(false);
    expect(isSendingTime(lagos(8, 10), LAGOS)).toBe(false);
  });
});

describe('nextSendingTime', () => {
  it('returns the same instant when already sending time', () => {
    const d = lagos(3, 10);
    expect(nextSendingTime(d, LAGOS).toISOString()).toBe(d.toISOString());
  });
  it('moves Friday 18:00 to Monday 9:00', () => {
    expect(nextSendingTime(lagos(6, 18), LAGOS).toISOString()).toBe(lagos(9, 9).toISOString());
  });
  it('moves Tuesday 07:00 to Tuesday 9:00', () => {
    expect(nextSendingTime(lagos(3, 7), LAGOS).toISOString()).toBe(lagos(3, 9).toISOString());
  });
  it('moves Saturday to Monday 9:00', () => {
    expect(nextSendingTime(lagos(7, 12), LAGOS).toISOString()).toBe(lagos(9, 9).toISOString());
  });
  it('Review Focus 1: New York across the March DST change stays 9:00 local', () => {
    expect(nextSendingTime(new Date('2027-03-13T20:00:00Z'), NY).toISOString()).toBe('2027-03-15T13:00:00.000Z');
    expect(isSendingTime(new Date('2027-03-15T13:30:00Z'), NY)).toBe(true);
    expect(isSendingTime(new Date('2027-03-15T12:30:00Z'), NY)).toBe(false);
  });
});

describe('firstSlotAfterStart', () => {
  it('never uses the same day', () => {
    expect(firstSlotAfterStart(lagos(2, 8), LAGOS).toISOString()).toBe(lagos(3, 9).toISOString());
  });
  it('skips the weekend', () => {
    expect(firstSlotAfterStart(lagos(6, 15), LAGOS).toISOString()).toBe(lagos(9, 9).toISOString());
  });
  it('uses the recipient local day', () => {
    // Fri 23:30 UTC is already Sat 00:30 in Lagos, so the next weekday is Monday.
    expect(firstSlotAfterStart(new Date('2026-11-06T23:30:00Z'), LAGOS).toISOString()).toBe(lagos(9, 9).toISOString());
  });
});

describe('nextLocalHour', () => {
  it('gives the next weekday at that hour', () => {
    expect(nextLocalHour(lagos(3, 12), LAGOS, 11).toISOString()).toBe(lagos(4, 11).toISOString());
  });
  it('skips the weekend', () => {
    expect(nextLocalHour(lagos(6, 12), LAGOS, 11).toISOString()).toBe(lagos(9, 11).toISOString());
  });
  it('is strictly after: exactly at the hour goes to the next day', () => {
    expect(nextLocalHour(lagos(3, 11), LAGOS, 11).toISOString()).toBe(lagos(4, 11).toISOString());
  });
});

describe('nextMonday', () => {
  it('gives the following Monday at local midnight', () => {
    expect(nextMonday(lagos(4, 12), LAGOS).toISOString()).toBe(lagos(9, 0).toISOString());
  });
  it('is strictly after when already Monday', () => {
    expect(nextMonday(lagos(2, 0), LAGOS).toISOString()).toBe(lagos(9, 0).toISOString());
  });
  it('takes an hour', () => {
    expect(nextMonday(lagos(4, 12), LAGOS, 9).toISOString()).toBe(lagos(9, 9).toISOString());
  });
});
