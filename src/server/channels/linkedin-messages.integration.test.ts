// Sending messages from the LinkedIn adapter, run against the local stand-in: restored chat windows, proof that a
// message was really sent, failures shown by LinkedIn, and people who are not connections.
import { describe, expect, it } from 'vitest';
import { message, useLinkedin } from './__fixtures__/linkedin/harness.js';

describe('linkedin messages against a local LinkedIn stand-in', () => {
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

    it('does not call a delivered message failed because its own words mention failing or retrying', async () => {
      const before = li.fixture.messages.length;
      const body = "I couldn't send the deck earlier, so I'm happy to retry Thursday. It said Failed to send once.";
      expect(await li.main.send(message('ada', { kind: 'follow_up', body }))).toEqual({ ok: true, externalId: null });
      expect(li.fixture.messages.slice(before)).toEqual([{ slug: 'ada', text: body }]);
    });

    it('sees a failure shown only as a toast, and one shown only beside the message', async () => {
      expect(await li.main.send(message('toasty', { kind: 'follow_up', body: 'Hello Toa.' }))).toMatchObject({ ok: false, error: { code: 'unknown' } });
      expect(await li.main.send(message('flaky', { kind: 'follow_up', body: 'Hello Flo.' }))).toMatchObject({ ok: false, error: { code: 'unknown' } });
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
});
