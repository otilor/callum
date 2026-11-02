// Drives the real LinkedIn adapter in a real (headless) Chromium against a local stand-in for linkedin.com.
// Nothing here touches the live site; the markup and flows the stand-in mimics are described in __fixtures__/linkedin.
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../engine/clock.js';
import { FIXTURE_USER, VALID_COOKIE, startLinkedinFixture, type LinkedinFixture } from './__fixtures__/linkedin/server.js';
import { createLinkedinAdapter } from './linkedin.js';
import { clampNote } from './linkedin-detect.js';
import { ConnectError, type ChannelAdapter, type OutboundMessage } from './types.js';

// Monday 2 November 2026, 15:00 in the process time zone (the messaging list shows local clock times).
const NOW = new Date(2026, 10, 2, 15, 0, 0);
const noSleep = async () => undefined;
vi.setConfig({ testTimeout: 30_000 });

function message(slug: string | null, over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    to: { name: 'Someone', email: null, linkedinUrl: slug ? `https://www.linkedin.com/in/${slug}` : null, xHandle: null },
    kind: 'invite',
    subject: null,
    body: 'Hi, I enjoyed your talk on payments.',
    inReplyTo: null,
    ...over,
  };
}

describe('linkedin adapter against a local LinkedIn stand-in', () => {
  let fixture: LinkedinFixture;
  const dirs: string[] = [];
  const adapters: ChannelAdapter[] = [];
  let main: ChannelAdapter;

  async function dataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'callum-li-'));
    dirs.push(dir);
    return dir;
  }

  async function build(secret: Record<string, string> | null, extra: Record<string, unknown> = {}): Promise<ChannelAdapter> {
    const adapter = createLinkedinAdapter(secret, {
      dataDir: await dataDir(),
      baseUrl: fixture.baseUrl,
      sleep: noSleep,
      clock: fixedClock(NOW.toISOString()),
      ...extra,
    });
    adapters.push(adapter);
    return adapter;
  }

  beforeAll(async () => {
    fixture = await startLinkedinFixture();
    main = await build(null);
    await main.connect({ liAt: VALID_COOKIE });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(adapters.map((a) => a.close()));
    await fixture.close();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  describe('connect', () => {
    it('sets the li_at cookie, opens the feed and reads the name from the Me menu', async () => {
      let ctx: BrowserContext | null = null;
      const adapter = await build(null, {
        launch: async (dir: string, options: Parameters<typeof chromium.launchPersistentContext>[1]) => (ctx = await chromium.launchPersistentContext(dir, options)),
      });
      const result = await adapter.connect({ liAt: `  ${VALID_COOKIE} ` });
      expect(result).toEqual({ identity: FIXTURE_USER, secret: { liAt: VALID_COOKIE } });
      const cookie = (await (ctx as unknown as BrowserContext).cookies(fixture.baseUrl)).find((c) => c.name === 'li_at');
      expect(cookie?.value).toBe(VALID_COOKIE);
      expect(fixture.hits).toContain('GET /feed/');
    });

    it('refuses a cookie LinkedIn does not accept', async () => {
      const adapter = await build(null);
      await expect(adapter.connect({ liAt: 'expired' })).rejects.toBeInstanceOf(ConnectError);
      expect(await adapter.send(message('kemi'))).toMatchObject({ ok: false, error: { code: 'auth' } });
    });

    it('opens a sign-in window, waits for the feed, and keeps the session', async () => {
      let ctx: BrowserContext | null = null;
      let headlessSeen: boolean | undefined;
      const dir = await dataDir();
      const adapter = createLinkedinAdapter(null, {
        dataDir: dir,
        baseUrl: fixture.baseUrl,
        sleep: noSleep,
        loginHeaded: false, // this machine has no display; the adapter would otherwise open a visible window
        launch: async (profile, options) => {
          headlessSeen = options?.headless;
          return (ctx = await chromium.launchPersistentContext(profile, options));
        },
      });
      adapters.push(adapter);

      const connecting = adapter.connect({});
      // The person typing their details into the window.
      await expect
        .poll(() => (ctx as BrowserContext | null)?.pages().some((p) => p.url().endsWith('/login')), { timeout: 20_000 })
        .toBe(true);
      const page = (ctx as unknown as BrowserContext).pages().find((p) => p.url().endsWith('/login'));
      await page?.fill('#username', 'gabriel@example.com');
      await page?.fill('#password', 'hunter2');
      await page?.click('button[type="submit"]');

      const result = await connecting;
      expect(result.identity).toBe(FIXTURE_USER);
      expect(result.secret).toEqual({ liAt: VALID_COOKIE });
      expect(headlessSeen).toBe(true);

      // The adapter now works from the saved session, and forgetting it removes the profile from disk.
      expect(await adapter.send(message('pia'))).toEqual({ ok: true, externalId: null });
      await expect(stat(join(dir, 'linkedin-profile'))).resolves.toBeTruthy();
      await adapter.forget?.();
      await expect(stat(join(dir, 'linkedin-profile'))).rejects.toThrow();
      expect(await adapter.send(message('pia'))).toMatchObject({ ok: false, error: { code: 'auth' } });
    }, 60_000);

    it('gives up on sign-in with a plain message when nobody finishes', async () => {
      const adapter = await build(null, { loginHeaded: false, loginTimeoutMs: 1500 });
      await expect(adapter.connect({})).rejects.toThrow(/sign-in didn't finish/);
    });
  });

  describe('invitations', () => {
    it('fills the clamped note and sends from the Connect button', async () => {
      const long = `${'I liked your talk on payments rails and how teams ship them. '.repeat(8)}`;
      expect(long.length).toBeGreaterThan(280);
      const before = fixture.invites.length;
      const result = await main.send(message('kemi', { body: long }));
      expect(result).toEqual({ ok: true, externalId: null });
      expect(fixture.invites.slice(before)).toEqual([{ slug: 'kemi', note: clampNote(long) }]);
      expect(fixture.invites.at(-1)?.note.length).toBeLessThanOrEqual(280);
    });

    it('finds Connect under More and never clicks the People also viewed buttons', async () => {
      const before = fixture.invites.length;
      const result = await main.send(message('tunde', { body: 'Hello Tunde.' }));
      expect(result.ok).toBe(true);
      expect(fixture.invites.slice(before)).toEqual([{ slug: 'tunde', note: 'Hello Tunde.' }]);
      expect(fixture.invites.some((i) => i.slug.startsWith('decoy'))).toBe(false);
    });

    it('treats an invitation that is already pending as sent, without sending another', async () => {
      const before = fixture.invites.length;
      expect(await main.send(message('pia'))).toEqual({ ok: true, externalId: null });
      expect(fixture.invites).toHaveLength(before);
    });

    it('explains people it cannot invite', async () => {
      expect(await main.send(message('celeb'))).toMatchObject({ ok: false, error: { code: 'invalid_recipient', message: expect.stringContaining("doesn't offer Connect") } });
      expect(await main.send(message('ada'))).toMatchObject({ ok: false, error: { code: 'invalid_recipient', message: expect.stringContaining('already connected') } });
      expect(await main.send(message('nobody'))).toMatchObject({ ok: false, error: { code: 'invalid_recipient', message: expect.stringContaining("wasn't found") } });
      expect(await main.send(message(null))).toMatchObject({ ok: false, error: { code: 'invalid_recipient' } });
    });

    it('stops with checkpoint when LinkedIn asks for a security check', async () => {
      const result = await main.send(message('blocked'));
      expect(result).toMatchObject({ ok: false, error: { code: 'checkpoint' } });
    });

    it('stops with weekly_limit when the limit appears on Connect or after Send', async () => {
      const before = fixture.invites.length;
      expect(await main.send(message('capped'))).toMatchObject({ ok: false, error: { code: 'weekly_limit' } });
      expect(await main.send(message('limited'))).toMatchObject({ ok: false, error: { code: 'weekly_limit' } });
      expect(fixture.invites).toHaveLength(before);
    });
  });

  describe('messages', () => {
    it('opens the composer from the profile and sends, keeping line breaks', async () => {
      const before = fixture.messages.length;
      const body = 'Thanks for connecting, Ada.\n\nWould Thursday at 9:00 work for a short talk?';
      const result = await main.send(message('ada', { kind: 'thanks', body }));
      expect(result).toEqual({ ok: true, externalId: null });
      expect(fixture.messages.slice(before)).toEqual([{ slug: 'ada', text: body }]);
    });

    it('does not message someone it is not connected to', async () => {
      const before = fixture.messages.length;
      const result = await main.send(message('kemi', { kind: 'follow_up' }));
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_recipient' } });
      expect(fixture.messages).toHaveLength(before);
    });
  });

  describe('poll', () => {
    it('reports accepted connections and replies newer than since, with the person who wrote', async () => {
      const events = await main.poll(new Date(2026, 10, 2, 0, 0, 0));
      expect(events.filter((e) => e.type === 'accepted').map((e) => e.type === 'accepted' && e.linkedinUrl)).toEqual([
        'https://www.linkedin.com/in/ada',
        'https://www.linkedin.com/in/ben-ward',
      ]);
      const replies = events.filter((e) => e.type === 'reply');
      expect(replies).toEqual([
        {
          type: 'reply',
          from: { linkedinUrl: 'https://www.linkedin.com/in/ada', name: 'Ada Obi' },
          text: 'Yes, Thursday at 9:00 works for me.',
          at: new Date(2026, 10, 2, 10, 32).toISOString(),
          externalId: expect.stringContaining('/messaging/thread/2-ada/'),
        },
      ]);
    });

    it('looks back three days without since, skips threads whose last message is the user\'s, and never repeats a reply', async () => {
      const events = await main.poll(null);
      const replies = events.flatMap((e) => (e.type === 'reply' ? [e] : []));
      // Ada was reported by the previous poll of this adapter; Ben's "Sun" thread is new; Tunde's is older than three days.
      expect(replies.map((r) => r.from.linkedinUrl)).toEqual(['https://www.linkedin.com/in/ben-ward']);
      expect(replies[0]?.text).toBe('Sounds good, send me the details.');
      expect(replies[0]?.at).toBe(new Date(2026, 10, 1, 23, 59, 59).toISOString());
      expect(await main.poll(null).then((all) => all.filter((e) => e.type === 'reply'))).toEqual([]);
    });

    it('reports a checkpoint instead of events when LinkedIn blocks the lists', async () => {
      fixture.challengeLists = true;
      try {
        expect(await main.poll(null)).toEqual([{ type: 'checkpoint', at: NOW.toISOString() }]);
      } finally {
        fixture.challengeLists = false;
      }
    });
  });

  describe('searchPeople', () => {
    const search = (limit: number, q = 'payments') => main.searchPeople?.(`https://www.linkedin.com/search/results/people/?keywords=${q}&origin=GLOBAL_SEARCH_HEADER`, limit);

    it('returns people with name, role and company from the headline, skipping hidden members', async () => {
      expect(await search(2)).toEqual([
        { name: 'Kemi Okoye', source: 'linkedin_search', linkedinUrl: 'https://www.linkedin.com/in/kemi', role: 'Head of Payments', company: 'Okopay' },
        { name: 'Tunde Bello', source: 'linkedin_search', linkedinUrl: 'https://www.linkedin.com/in/tunde', role: 'Payments builder and writer' },
      ]);
    });

    it('goes on to the next page for more, and stops when LinkedIn has no more results', async () => {
      const people = await search(50);
      expect(people?.map((p) => p.name)).toEqual(['Kemi Okoye', 'Tunde Bello', 'Ada Obi']);
      expect(people?.[2]).toMatchObject({ role: 'Product lead', company: 'Fernhill' });
      const pages = fixture.hits.filter((h) => h === 'GET /search/results/people/').length;
      expect(pages).toBeGreaterThanOrEqual(3);
    });

    it('rejects an address that is not a LinkedIn people search', async () => {
      await expect(main.searchPeople?.('https://example.com/search/results/people/?keywords=a', 5)).rejects.toThrow(/people search address/);
      await expect(main.searchPeople?.('https://www.linkedin.com/feed/', 5)).rejects.toThrow(/people search address/);
      await expect(main.searchPeople?.('not a url', 5)).rejects.toThrow(/people search address/);
    });
  });
});
