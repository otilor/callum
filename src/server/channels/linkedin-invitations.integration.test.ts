// Invitations from the LinkedIn adapter, run in a real browser against the local stand-in: notes, the More menu,
// pending invitations, the Premium note offer, failures that must not count as sent, limits and security checks.
import { describe, expect, it } from 'vitest';
import { message, useLinkedin } from './__fixtures__/linkedin/harness.js';
import { VALID_COOKIE } from './__fixtures__/linkedin/server.js';
import { clampNote } from './linkedin-detect.js';

describe('linkedin invitations against a local LinkedIn stand-in', () => {
  const li = useLinkedin();

  describe('invitations', () => {
    it('fills the clamped note and sends from the Connect button', async () => {
      const long = `${'I liked your talk on payments rails and how teams ship them. '.repeat(8)}`;
      expect(long.length).toBeGreaterThan(280);
      const before = li.fixture.invites.length;
      const result = await li.main.send(message('kemi', { body: long }));
      expect(result).toEqual({ ok: true, externalId: null });
      expect(li.fixture.invites.slice(before)).toEqual([{ slug: 'kemi', note: clampNote(long) }]);
      expect(li.fixture.invites.at(-1)?.note.length).toBeLessThanOrEqual(280);
    });

    it('finds Connect under More and never clicks the People also viewed buttons', async () => {
      const before = li.fixture.invites.length;
      const result = await li.main.send(message('tunde', { body: 'Hello Tunde.' }));
      expect(result.ok).toBe(true);
      expect(li.fixture.invites.slice(before)).toEqual([{ slug: 'tunde', note: 'Hello Tunde.' }]);
      expect(li.fixture.invites.some((i) => i.slug.startsWith('decoy'))).toBe(false);
    });

    it('says LinkedIn signed Callum out when every page redirects back to itself, and never that it may have sent', async () => {
      const before = li.fixture.invites.length;
      li.fixture.loopAll = true;
      try {
        expect(await li.main.send(message('kemi'))).toEqual({ ok: false, error: { code: 'auth', message: expect.stringContaining('signed Callum out') } });
      } finally {
        li.fixture.loopAll = false;
      }
      // One page looping while the feed loads is not a sign-out: it is tried again later.
      expect(await li.main.send(message('loop'))).toEqual({ ok: false, error: { code: 'temporary', message: expect.stringContaining('try again later') } });
      expect(li.fixture.invites).toHaveLength(before);
    });

    describe("LinkedIn's late-2026 profile page", () => {
      it('finds the top card by its h2 name, opens "More", and sends from the Connect link with the note', async () => {
        const before = li.fixture.invites.length;
        const result = await li.main.send(message('arlan', { body: 'Hi Arlan, congrats on the seed.' }));
        expect(result).toEqual({ ok: true, externalId: null });
        expect(li.fixture.invites.slice(before)).toEqual([{ slug: 'arlan', note: 'Hi Arlan, congrats on the seed.' }]);
        expect(li.fixture.invites.some((i) => i.slug.startsWith('decoy'))).toBe(false);
      });

      it('sends without the note when the monthly notes are used up', async () => {
        const before = li.fixture.invites.length;
        expect(await li.main.send(message('nora', { body: 'Hello Nora.' }))).toEqual({ ok: true, externalId: null, noteDropped: true });
        expect(li.fixture.invites.slice(before)).toEqual([{ slug: 'nora', note: '' }]);
      });

      it('says already connected only for a 1st-degree card, never because an open profile shows Message', async () => {
        expect(await li.main.send(message('ife'))).toMatchObject({ ok: false, error: { code: 'already_connected' } });
      });
    });

    it('treats an invitation that is already pending as sent, without sending another', async () => {
      const before = li.fixture.invites.length;
      expect(await li.main.send(message('pia'))).toEqual({ ok: true, externalId: null });
      expect(li.fixture.invites).toHaveLength(before);
    });

    it('sends without the note and says so when a free account is offered Premium instead of a note box', async () => {
      const before = li.fixture.invites.length;
      const result = await li.main.send(message('freebie', { body: 'Hello Free.' }));
      expect(result).toEqual({ ok: true, externalId: null, noteDropped: true });
      expect(li.fixture.invites.slice(before)).toEqual([{ slug: 'freebie', note: '' }]);
    });

    it('does not claim success when the dialog closes with an error and no Pending button appears', async () => {
      const before = li.fixture.invites.length;
      const result = await li.main.send(message('toast'));
      expect(result).toMatchObject({ ok: false, error: { code: 'unknown', message: expect.stringContaining("didn't confirm the invitation") } });
      expect(li.fixture.invites).toHaveLength(before);
    });

    it('does not report sent when the Pending button goes away again after the pause', async () => {
      // Pauses are real here: Pending shows, then is taken back half a second later, before the final look.
      const slow = await li.build({ liAt: VALID_COOKIE }, { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 700))) });
      const result = await slow.send(message('flicker'));
      expect(result).toMatchObject({ ok: false, error: { code: 'unknown', message: expect.stringContaining('took it back') } });
      // A person reading the error is told, in plain words, that it was not counted as sent.
      expect(result.ok ? '' : result.error.message).toContain("didn't count it as sent");
    });

    it('explains people it cannot invite', async () => {
      expect(await li.main.send(message('celeb'))).toMatchObject({ ok: false, error: { code: 'invalid_recipient', message: expect.stringContaining("doesn't offer Connect") } });
      expect(await li.main.send(message('ada'))).toMatchObject({ ok: false, error: { code: 'already_connected', message: expect.stringContaining('already connected') } });
      expect(await li.main.send(message('nobody'))).toMatchObject({ ok: false, error: { code: 'invalid_recipient', message: expect.stringContaining("wasn't found") } });
      expect(await li.main.send(message(null))).toMatchObject({ ok: false, error: { code: 'invalid_recipient' } });
      expect(await li.main.send(message('ghost'))).toMatchObject({ ok: false, error: { code: 'invalid_recipient', message: expect.stringContaining("wasn't found") } });
    });

    it('treats a page without Connect as a channel problem, not a verdict on the person', async () => {
      const invite = await li.main.send(message('odd'));
      expect(invite).toMatchObject({ ok: false, error: { code: 'unknown', message: expect.stringContaining('LinkedIn may have changed its page') } });
      const dm = await li.main.send(message('odd', { kind: 'follow_up' }));
      expect(dm).toMatchObject({ ok: false, error: { code: 'unknown' } });
      // No raw browser wording reaches the person.
      for (const r of [invite, dm]) expect(JSON.stringify(r)).not.toMatch(/locator|Timeout|waiting for/i);
    });

    it('stops with checkpoint when LinkedIn asks for a security check', async () => {
      const result = await li.main.send(message('blocked'));
      expect(result).toMatchObject({ ok: false, error: { code: 'checkpoint' } });
    });

    it('stops with weekly_limit when the limit appears on Connect or after Send', async () => {
      const before = li.fixture.invites.length;
      expect(await li.main.send(message('capped'))).toMatchObject({ ok: false, error: { code: 'weekly_limit' } });
      expect(await li.main.send(message('limited'))).toMatchObject({ ok: false, error: { code: 'weekly_limit' } });
      expect(li.fixture.invites).toHaveLength(before);
    });
  });
});
