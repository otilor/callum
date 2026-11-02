// Polling by the LinkedIn adapter, run against the local stand-in: accepted invitations and replies (rows that are
// links or clickable, the conversation LinkedIn opens by itself, who wrote last), and security checks.
import { describe, expect, it } from 'vitest';
import { NOW, message, useLinkedin } from './__fixtures__/linkedin/harness.js';
import { MEMBER_IDS, VALID_COOKIE } from './__fixtures__/linkedin/server.js';

describe('linkedin conversations against a local LinkedIn stand-in', () => {
  const li = useLinkedin();

  describe('poll', () => {
    it('reports accepted connections and replies newer than since, with the person who wrote', async () => {
      const events = await li.main.poll(new Date(2026, 10, 2, 0, 0, 0));
      expect(events.filter((e) => e.type === 'accepted').map((e) => e.type === 'accepted' && e.linkedinUrl)).toEqual([
        'https://www.linkedin.com/in/ada',
        'https://www.linkedin.com/in/ben-ward',
      ]);
      const replies = events.filter((e) => e.type === 'reply');
      expect(replies).toEqual([
        {
          type: 'reply',
          from: { linkedinUrl: 'https://www.linkedin.com/in/zoe', name: 'Zoe Zed' },
          text: 'Can we talk Thursday at 9:00?',
          at: new Date(2026, 10, 2, 11, 15).toISOString(),
          externalId: expect.stringContaining('2-zoe:'),
        },
        {
          type: 'reply',
          from: { linkedinUrl: 'https://www.linkedin.com/in/ada', name: 'Ada Obi' },
          text: 'Yes, Thursday at 9:00 works for me.',
          at: new Date(2026, 10, 2, 10, 32).toISOString(),
          externalId: expect.stringContaining('2-ada:'),
        },
      ]);
    });

    it('looks back three days without since, skips threads whose last message is the user\'s, and never repeats a reply', async () => {
      const events = await li.main.poll(null);
      const replies = events.flatMap((e) => (e.type === 'reply' ? [e] : []));
      // Ada was reported by the previous poll of this adapter; Ben's "Sun" thread is new; Tunde's is older than three days.
      expect(replies.map((r) => r.from.linkedinUrl)).toEqual(['https://www.linkedin.com/in/ben-ward']);
      expect(replies[0]?.text).toBe('Sounds good, send me the details.');
      expect(replies[0]?.at).toBe(new Date(2026, 10, 1, 23, 59, 59).toISOString());
      expect(await li.main.poll(null).then((all) => all.filter((e) => e.type === 'reply'))).toEqual([]);
    });

    it('finds replies from rows that are links and rows that are not, in one poll', async () => {
      const fresh = await li.build({ liAt: VALID_COOKIE });
      const replies = (await fresh.poll(null)).flatMap((e) => (e.type === 'reply' ? [e] : []));
      // Ada's row is a link (fast path); Ben's is a div that opens its thread when clicked.
      expect(replies.map((r) => [r.from.linkedinUrl, r.text])).toEqual([
        ['https://www.linkedin.com/in/zoe', 'Can we talk Thursday at 9:00?'],
        ['https://www.linkedin.com/in/ada', 'Yes, Thursday at 9:00 works for me.'],
        ['https://www.linkedin.com/in/ben-ward', 'Sounds good, send me the details.'],
      ]);
    });

    it('does not report the user\'s own words as a reply when the preview cannot be read', async () => {
      li.fixture.hidePreviews = true;
      try {
        const fresh = await li.build({ liAt: VALID_COOKIE });
        const replies = (await fresh.poll(null)).flatMap((e) => (e.type === 'reply' ? [e] : []));
        // Kemi's thread ends with the user's own message, and Mia's page says nothing about who wrote it: neither is a reply.
        expect(replies.map((r) => r.from.linkedinUrl)).toEqual([
          'https://www.linkedin.com/in/zoe',
          'https://www.linkedin.com/in/ada',
          'https://www.linkedin.com/in/ben-ward',
        ]);
        expect(replies.some((r) => r.text.includes('Thanks for connecting, Kemi') || r.text.includes('See you then'))).toBe(false);
      } finally {
        li.fixture.hidePreviews = false;
      }
    });

    it('reports a single new reply in the top row, the conversation LinkedIn already has open', async () => {
      const fresh = await li.build({ liAt: VALID_COOKIE });
      const replies = (await fresh.poll(new Date(2026, 10, 2, 11, 0))).flatMap((e) => (e.type === 'reply' ? [e] : []));
      expect(replies.map((r) => [r.from.linkedinUrl, r.text])).toEqual([['https://www.linkedin.com/in/zoe', 'Can we talk Thursday at 9:00?']]);
    });

    it('turns a thread header that links to a member-id address into the vanity address, once per person', async () => {
      li.fixture.memberIdHeaders = true;
      try {
        const fresh = await li.build({ liAt: VALID_COOKIE });
        const before = li.fixture.hits.length;
        const replies = (await fresh.poll(null)).flatMap((e) => (e.type === 'reply' ? [e] : []));
        // The people are reported under the address that is stored for them, never as /in/acoaab...; the member id
        // is not kept as a second address when it was resolved.
        expect(replies.map((r) => r.from.linkedinUrl)).toEqual([
          'https://www.linkedin.com/in/zoe',
          'https://www.linkedin.com/in/ada',
          'https://www.linkedin.com/in/ben-ward',
        ]);
        expect(replies.map((r) => r.from.linkedinAltUrl)).toEqual([
          `https://www.linkedin.com/in/${MEMBER_IDS.zoe?.toLowerCase()}`,
          undefined,
          `https://www.linkedin.com/in/${MEMBER_IDS['ben-ward']?.toLowerCase()}`,
        ]);
        // The member id is opened with its letter case intact.
        const opened = li.fixture.hits.slice(before).filter((h) => h.includes('/in/ACo'));
        expect(opened).toEqual([`GET /in/${MEMBER_IDS.zoe}/`, `GET /in/${MEMBER_IDS['ben-ward']}/`]);
      } finally {
        li.fixture.memberIdHeaders = false;
      }
    });

    it('reports a checkpoint instead of events when LinkedIn blocks the lists', async () => {
      li.fixture.challengeLists = true;
      try {
        expect(await li.main.poll(null)).toEqual([{ type: 'checkpoint', at: NOW.toISOString() }]);
      } finally {
        li.fixture.challengeLists = false;
      }
    });
  });
});
