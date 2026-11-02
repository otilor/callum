import type { Channel, PersonLead } from '../../shared/types.js';
import type { Clock } from '../engine/clock.js';
import type { ChannelAdapter, InboundEvent, OutboundMessage, Recipient } from './types.js';

// Replies a person in demo mode may send. Because only hashes divisible by 3 reply,
// indexes 0 and 3 are the ones a demo actually reaches: a pricing question and a stop.
export const DEMO_REPLIES: readonly string[] = [
  'Can you tell me more about pricing?',
  'Thanks for reaching out. Could you send a couple of examples from teams like ours?',
  'Interesting timing. Can we talk Thursday at 9:00?',
  'Please take me off your list.',
  'Not right now, but check back in the new year.',
  'Who else are you working with in this space?',
];

/** Stable 32-bit FNV-1a. */
export function demoHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Who a demo LinkedIn search "finds": fixed, so a demo reads the same every time. */
const DEMO_SEARCH: readonly { name: string; role: string; company: string }[] = [
  { name: 'Amara Nwosu', role: 'Founder', company: 'Ledgerly' },
  { name: 'Tobi Adeyemi', role: 'Head of Finance', company: 'Payloop' },
  { name: 'Lerato Mokoena', role: 'CEO', company: 'Kudi Labs' },
  { name: 'Yaw Boateng', role: 'Co-founder', company: 'Mintbox' },
  { name: 'Zainab Bello', role: 'CFO', company: 'Paywise' },
  { name: 'Chidi Okafor', role: 'Founder', company: 'Stackpay' },
];

const IDENTITY: Record<Channel, string> = {
  email: 'you@yourcompany.com',
  linkedin: 'You on LinkedIn',
  x: '@you',
};

interface Contact {
  to: Recipient;
  firstSentAt: number;
  invitedAt: number | null;
  replied: boolean;
  accepted: boolean;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function createDemoAdapter(
  channel: Channel,
  clock: Clock,
  opts: { replyAfterMs?: number; acceptAfterMs?: number } = {},
): ChannelAdapter {
  const replyAfterMs = opts.replyAfterMs ?? 90_000;
  const acceptAfterMs = opts.acceptAfterMs ?? 60_000;
  const contacts = new Map<string, Contact>();

  return {
    channel,
    async connect() {
      return { identity: IDENTITY[channel], secret: {} };
    },
    async send(msg: OutboundMessage) {
      const key = msg.to.name;
      const now = clock.now().getTime();
      const existing = contacts.get(key);
      const contact: Contact = existing ?? { to: msg.to, firstSentAt: now, invitedAt: null, replied: false, accepted: false };
      contact.to = msg.to;
      if (msg.kind === 'invite' && contact.invitedAt === null) contact.invitedAt = now;
      contacts.set(key, contact);
      return { ok: true as const, externalId: null };
    },
    async poll() {
      const now = clock.now();
      const at = now.toISOString();
      const events: InboundEvent[] = [];
      for (const contact of contacts.values()) {
        const h = demoHash(contact.to.name);
        if (!contact.replied && h % 3 === 0 && now.getTime() - contact.firstSentAt >= replyAfterMs) {
          contact.replied = true;
          const from: { email?: string; linkedinUrl?: string; xHandle?: string; name?: string } = { name: contact.to.name };
          if (contact.to.email) from.email = contact.to.email;
          if (contact.to.linkedinUrl) from.linkedinUrl = contact.to.linkedinUrl;
          if (contact.to.xHandle) from.xHandle = contact.to.xHandle;
          events.push({ type: 'reply', from, text: DEMO_REPLIES[h % DEMO_REPLIES.length] ?? '', at, externalId: null });
        }
        if (
          channel === 'linkedin' &&
          !contact.accepted &&
          contact.invitedAt !== null &&
          h % 2 === 0 &&
          now.getTime() - contact.invitedAt >= acceptAfterMs
        ) {
          contact.accepted = true;
          events.push({
            type: 'accepted',
            linkedinUrl: contact.to.linkedinUrl ?? `https://www.linkedin.com/in/${slug(contact.to.name)}`,
            at,
          });
        }
      }
      return events;
    },
    ...(channel === 'linkedin'
      ? {
          async searchPeople(_url: string, limit: number): Promise<PersonLead[]> {
            return DEMO_SEARCH.slice(0, Math.max(0, limit)).map((p) => ({
              name: p.name, source: 'linkedin_search' as const, role: p.role, company: p.company,
              linkedinUrl: `https://www.linkedin.com/in/${slug(p.name)}`,
            }));
          },
        }
      : {}),
    async close() {},
  };
}
