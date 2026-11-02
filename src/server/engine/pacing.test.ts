import { describe, expect, it } from 'vitest';
import { capFor, emailDailyCap, linkedinInviteCap } from './pacing.js';
import type { ChannelAccount } from '../../shared/types.js';

const DAY = 86_400_000;
const connectedAt = new Date('2026-10-01T09:00:00Z');
const at = (days: number) => new Date(connectedAt.getTime() + days * DAY);
const now = new Date('2026-11-02T10:00:00Z');
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

function account(over: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    channel: 'linkedin', status: 'connected', identity: 'me', connectedAt: connectedAt.toISOString(),
    pausedUntil: null, halfPaceUntil: null, invitesBlockedUntil: null, lastPolledAt: null, ...over,
  };
}

describe('emailDailyCap', () => {
  it('ramps 20, 70, 120', () => {
    expect(emailDailyCap(connectedAt, at(0))).toBe(20);
    expect(emailDailyCap(connectedAt, at(6))).toBe(20);
    expect(emailDailyCap(connectedAt, at(7))).toBe(70);
    expect(emailDailyCap(connectedAt, at(13))).toBe(70);
    expect(emailDailyCap(connectedAt, at(14))).toBe(120);
    expect(emailDailyCap(connectedAt, at(60))).toBe(120);
  });
  it('treats just under a day as day 0 and just under 7 days as day 6', () => {
    expect(emailDailyCap(connectedAt, new Date(at(1).getTime() - 1))).toBe(20);
    expect(emailDailyCap(connectedAt, new Date(at(7).getTime() - 1))).toBe(20);
  });
});

describe('linkedinInviteCap', () => {
  it('is 15 by default', () => expect(linkedinInviteCap(account(), now)).toBe(15));
  it('is 7 while half pace is in the future', () => {
    expect(linkedinInviteCap(account({ halfPaceUntil: iso(DAY) }), now)).toBe(7);
  });
  it('is back to 15 once half pace has passed', () => {
    expect(linkedinInviteCap(account({ halfPaceUntil: iso(-1000) }), now)).toBe(15);
  });
  it('is 0 while invites are blocked, even at half pace', () => {
    expect(linkedinInviteCap(account({ invitesBlockedUntil: iso(DAY), halfPaceUntil: iso(DAY) }), now)).toBe(0);
  });
});

describe('capFor', () => {
  it('routes email to the ramp', () => {
    expect(capFor('email', 'hello', account({ channel: 'email' }), at(3))).toBe(20);
  });
  it('routes linkedin invites to the invite cap', () => {
    expect(capFor('linkedin', 'invite', account(), now)).toBe(15);
    expect(capFor('linkedin', 'invite', account({ halfPaceUntil: iso(DAY) }), now)).toBe(7);
  });
  it('gives other linkedin kinds 40', () => {
    expect(capFor('linkedin', 'thanks', account(), now)).toBe(40);
    expect(capFor('linkedin', 'follow_up', account(), now)).toBe(40);
  });
  it('gives X 20', () => expect(capFor('x', 'hello', account({ channel: 'x' }), now)).toBe(20));
  it('never caps user-initiated sends', () => {
    for (const kind of ['reply', 'booking', 'close'] as const) {
      expect(capFor('email', kind, account({ channel: 'email' }), now)).toBe(Infinity);
      expect(capFor('linkedin', kind, account(), now)).toBe(Infinity);
      expect(capFor('x', kind, account({ channel: 'x' }), now)).toBe(Infinity);
    }
  });
});
