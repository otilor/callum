import type { Channel } from '../../../shared/types.js';

/**
 * What a channel does on day one, in the words First run shows under its disc. Everything starts at the first step of the
 * ramp here, so these are fixed. Your Callum (Task 16) shows the live line from `api.channelSummary(ch).paceLine` instead,
 * and replaces this helper with it.
 */
export function paceFor(channel: Channel): { name: string; line: string; line2: string } {
  switch (channel) {
    case 'email': return { name: 'Email', line: '20 a day now, 120 by week 3', line2: '' };
    case 'linkedin': return { name: 'LinkedIn', line: '15 invites a day', line2: 'working hours only' };
    case 'x': return { name: 'X', line: '20 DMs a day', line2: '' };
  }
}
