// Drives the real LinkedIn adapter in a real (headless) browser against a local stand-in for linkedin.com.
// Nothing here touches the live site; the markup and flows the stand-in mimics are described in __fixtures__/linkedin.
// This file covers signing in, the browser's identity, invitations and people search; messages and polling are in
// linkedin-conversations.integration.test.ts (two files so they run side by side).
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { useLinkedin, message } from './__fixtures__/linkedin/harness.js';
import { FIXTURE_USER, VALID_COOKIE } from './__fixtures__/linkedin/server.js';
import { clampNote } from './linkedin-detect.js';
import { ConnectError } from './types.js';

describe('linkedin adapter against a local LinkedIn stand-in', () => {
  const li = useLinkedin();

  describe('connect', () => {
    it('sets the li_at cookie, opens the feed and reads the name from the Me menu', async () => {
      let ctx: BrowserContext | null = null;
      const adapter = await li.build(null, {
        launch: async (dir: string, options: Parameters<typeof chromium.launchPersistentContext>[1]) => (ctx = await chromium.launchPersistentContext(dir, options)),
      });
      const result = await adapter.connect({ liAt: `  ${VALID_COOKIE} ` });
      expect(result).toEqual({ identity: FIXTURE_USER, secret: { liAt: VALID_COOKIE } });
      const cookie = (await (ctx as unknown as BrowserContext).cookies(li.fixture.baseUrl)).find((c) => c.name === 'li_at');
      expect(cookie?.value).toBe(VALID_COOKIE);
      expect(li.fixture.hits).toContain('GET /feed/');
    });

    it('refuses a cookie LinkedIn does not accept', async () => {
      const adapter = await li.build(null);
      await expect(adapter.connect({ liAt: 'expired' })).rejects.toBeInstanceOf(ConnectError);
      expect(await adapter.send(message('kemi'))).toMatchObject({ ok: false, error: { code: 'auth' } });
    });

    it('opens a sign-in window, waits for the feed, and keeps the session', async () => {
      let ctx: BrowserContext | null = null;
      let headlessSeen: boolean | undefined;
      const launched: Array<Parameters<typeof chromium.launchPersistentContext>[1]> = [];
      const dir = await li.dataDir();
      const adapter = await li.build(null, {
        dataDir: dir,
        loginHeaded: false, // this machine has no display; the adapter would otherwise open a visible window
        launch: async (profile: string, options: Parameters<typeof chromium.launchPersistentContext>[1]) => {
          headlessSeen = options?.headless;
          launched.push(options);
          return (ctx = await chromium.launchPersistentContext(profile, options));
        },
      });

      const connecting = adapter.connect({});
      // The person typing their details into the window.
      await expect
        .poll(() => (ctx as BrowserContext | null)?.pages().some((p) => p.url().endsWith('/login')), { timeout: 20_000 })
        .toBe(true);
      // The window's own first tab is the sign-in page: no second tab beside it.
      expect((ctx as unknown as BrowserContext).pages()).toHaveLength(1);
      const page = (ctx as unknown as BrowserContext).pages().find((p) => p.url().endsWith('/login'));
      await page?.fill('#username', 'gabriel@example.com');
      await page?.fill('#password', 'hunter2');
      await page?.click('button[type="submit"]');

      const result = await connecting;
      expect(result.identity).toBe(FIXTURE_USER);
      expect(result.secret).toEqual({ liAt: VALID_COOKIE });
      expect(headlessSeen).toBe(true);
      // Sign-in and work run in the same browser, never as an obvious automation build.
      for (const options of launched) {
        expect(options?.channel).toBe(launched[0]?.channel);
        expect(options?.ignoreDefaultArgs).toContain('--enable-automation');
        expect(options?.args).toContain('--disable-blink-features=AutomationControlled');
      }

      // The adapter now works from the saved session, and forgetting it removes the profile from disk.
      expect(await adapter.send(message('pia'))).toEqual({ ok: true, externalId: null });
      await expect(stat(join(dir, 'linkedin-profile'))).resolves.toBeTruthy();
      await adapter.forget?.();
      await expect(stat(join(dir, 'linkedin-profile'))).rejects.toThrow();
      expect(await adapter.send(message('pia'))).toMatchObject({ ok: false, error: { code: 'auth' } });
    }, 60_000);

    it('says so when the sign-in window is closed', async () => {
      let ctx: BrowserContext | null = null;
      const adapter = await li.build(null, {
        loginHeaded: false,
        launch: async (dir: string, options: Parameters<typeof chromium.launchPersistentContext>[1]) => (ctx = await chromium.launchPersistentContext(dir, options)),
      });
      const connecting = adapter.connect({});
      const settled = connecting.then(() => 'connected', (err: Error) => err.message);
      await expect.poll(() => (ctx as BrowserContext | null)?.pages().some((p) => p.url().endsWith('/login')), { timeout: 20_000 }).toBe(true);
      await (ctx as unknown as BrowserContext).pages()[0]?.close();
      expect(await settled).toBe('The LinkedIn window was closed before you finished signing in.');
    });

    it('gives up on sign-in with a plain message when nobody finishes', async () => {
      const adapter = await li.build(null, { loginHeaded: false, loginTimeoutMs: 800 });
      await expect(adapter.connect({})).rejects.toThrow(/sign-in didn't finish/);
    });
  });

  describe('browser identity', () => {
    it('never shows LinkedIn a headless user agent or the webdriver flag', async () => {
      await expect.poll(() => li.fixture.env.length, { timeout: 10_000 }).toBeGreaterThan(0);
      expect(li.fixture.userAgents.length).toBeGreaterThan(0);
      for (const agent of li.fixture.userAgents) expect(agent).not.toContain('HeadlessChrome');
      for (const seenByPage of li.fixture.env) {
        expect(seenByPage.userAgent).not.toContain('HeadlessChrome');
        expect(seenByPage.webdriver).toBe(false);
      }
    });
  });

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

    it('explains people it cannot invite', async () => {
      expect(await li.main.send(message('celeb'))).toMatchObject({ ok: false, error: { code: 'invalid_recipient', message: expect.stringContaining("doesn't offer Connect") } });
      expect(await li.main.send(message('ada'))).toMatchObject({ ok: false, error: { code: 'invalid_recipient', message: expect.stringContaining('already connected') } });
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

  describe('searchPeople', () => {
    const search = (limit: number, q = 'payments') => li.main.searchPeople?.(`https://www.linkedin.com/search/results/people/?keywords=${q}&origin=GLOBAL_SEARCH_HEADER`, limit);

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
      const pages = li.fixture.hits.filter((h) => h === 'GET /search/results/people/').length;
      expect(pages).toBeGreaterThanOrEqual(3);
    });

    it('rejects an address that is not a LinkedIn people search', async () => {
      await expect(li.main.searchPeople?.('https://example.com/search/results/people/?keywords=a', 5)).rejects.toThrow(/people search address/);
      await expect(li.main.searchPeople?.('https://www.linkedin.com/feed/', 5)).rejects.toThrow(/people search address/);
      await expect(li.main.searchPeople?.('not a url', 5)).rejects.toThrow(/people search address/);
    });
  });
});
