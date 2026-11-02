import type { Channel, ChannelAccount, OutKind } from '../../shared/types.js';

export const LINKEDIN_INVITE_CAP = 15;
export const LINKEDIN_HALF_PACE_CAP = 7;
export const LINKEDIN_MESSAGE_CAP = 40;
export const X_DAILY_CAP = 20;

const DAY_MS = 86_400_000;

/** Email ramps with the age of the connection: 20 (days 0-6), 70 (days 7-13), 120 (day 14 on). */
export function emailDailyCap(connectedAt: Date, now: Date): number {
  const day = Math.floor((now.getTime() - connectedAt.getTime()) / DAY_MS);
  if (day < 7) return 20;
  if (day < 14) return 70;
  return 120;
}

export function linkedinInviteCap(acc: ChannelAccount, now: Date): number {
  const t = now.getTime();
  if (acc.invitesBlockedUntil && new Date(acc.invitesBlockedUntil).getTime() > t) return 0;
  if (acc.halfPaceUntil && new Date(acc.halfPaceUntil).getTime() > t) return LINKEDIN_HALF_PACE_CAP;
  return LINKEDIN_INVITE_CAP;
}

const USER_INITIATED: ReadonlySet<OutKind> = new Set<OutKind>(['reply', 'booking', 'close']);

/** Messages per day for this channel and kind. User-initiated sends are never capped. */
export function capFor(channel: Channel, kind: OutKind, acc: ChannelAccount, now: Date): number {
  if (USER_INITIATED.has(kind)) return Infinity;
  switch (channel) {
    case 'email':
      return emailDailyCap(acc.connectedAt ? new Date(acc.connectedAt) : now, now);
    case 'linkedin':
      return kind === 'invite' ? linkedinInviteCap(acc, now) : LINKEDIN_MESSAGE_CAP;
    case 'x':
      return X_DAILY_CAP;
  }
}
