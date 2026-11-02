// The conversation half of the LinkedIn adapter run against the local stand-in: sending messages (including with
// restored chat windows and failing sends) and polling for accepted invitations and replies.
import { describe, expect, it } from 'vitest';
import { NOW, message, useLinkedin } from './__fixtures__/linkedin/harness.js';
import { VALID_COOKIE } from './__fixtures__/linkedin/server.js';

describe('linkedin conversations against a local LinkedIn stand-in', () => {
  const li = useLinkedin();

  describe('messages', () => {
    it('opens the composer from the profile and sends, keeping line breaks', async () => {
      const before = li.fixture.messages.length;
      const body = 'Thanks for connecting, Ada.\n\nWould Thursday at 9:00 work for a short talk?';
      const result = await li.main.send(message('ada', { kind: 'thanks', body }));
      expect(result).toEqual({ ok: true, externalId: null });
      expect(li.fixture.messages.slice(before)).toEqual([{ slug: 'ada', text: body }]);
    });

    it('sends to the right person even when LinkedIn restored a chat window for someone else', async () => {
      const before = li.fixture.messages.length;
      // Ada's page restores a closable window for another person; Bola's restores one that cannot be closed.
      expect(await li.main.send(message('bola', { kind: 'follow_up', body: 'Hello Bola.' }))).toEqual({ ok: true, externalId: null });
      expect(await li.main.send(message('ada', { kind: 'follow_up', body: 'Hello Ada.' }))).toEqual({ ok: true, externalId: null });
      expect(li.fixture.messages.slice(before)).toEqual([
        { slug: 'bola', text: 'Hello Bola.' },
        { slug: 'ada', text: 'Hello Ada.' },
      ]);
      expect(li.fixture.messages.some((m) => m.slug.startsWith('decoy'))).toBe(false);
    });

    it('does not claim success when the box empties but LinkedIn fails to send', async () => {
      const before = li.fixture.messages.length;
      const result = await li.main.send(message('flaky', { kind: 'follow_up', body: 'Hello Flo.' }));
      // The message shows at once and is then marked "Failed to send. Retry": that is not a sent message.
      expect(result).toMatchObject({ ok: false, error: { code: 'unknown', message: expect.stringContaining("couldn't send the message") } });
      expect(li.fixture.messages).toHaveLength(before);
    });

    it('needs a new message, not an identical earlier one, as proof of sending', async () => {
      const before = li.fixture.messages.length;
      // The conversation already ends with the very same text.
      const ok = await li.main.send(message('echo', { kind: 'follow_up', body: 'Hello Echo.' }));
      expect(ok).toEqual({ ok: true, externalId: null });
      expect(li.fixture.messages.slice(before)).toEqual([{ slug: 'echo', text: 'Hello Echo.' }]);
      // A window that swallows the message, with the same text already at the end of the conversation.
      expect(await li.main.send(message('mute', { kind: 'follow_up', body: 'Hello Mute.' }))).toMatchObject({ ok: false, error: { code: 'unknown' } });
      const failed = await li.main.send(message('echofail', { kind: 'follow_up', body: 'Hello Echo.' }));
      expect(failed).toMatchObject({ ok: false, error: { code: 'unknown' } });
      expect(li.fixture.messages).toHaveLength(before + 1);
    });

    it('does not message someone it is not connected to', async () => {
      const before = li.fixture.messages.length;
      const result = await li.main.send(message('kemi', { kind: 'follow_up' }));
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_recipient' } });
      expect(li.fixture.messages).toHaveLength(before);
    });
  });

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

    it('reports a single new reply in the top row, the conversation LinkedIn already has open', async () => {
      const fresh = await li.build({ liAt: VALID_COOKIE });
      const replies = (await fresh.poll(new Date(2026, 10, 2, 11, 0))).flatMap((e) => (e.type === 'reply' ? [e] : []));
      expect(replies.map((r) => [r.from.linkedinUrl, r.text])).toEqual([['https://www.linkedin.com/in/zoe', 'Can we talk Thursday at 9:00?']]);
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
