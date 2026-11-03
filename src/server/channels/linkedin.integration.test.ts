// Drives the real LinkedIn adapter in a real (headless) browser against a local stand-in for linkedin.com.
// Nothing here touches the live site; the markup and flows the stand-in mimics are described in __fixtures__/linkedin.
// This file covers signing in, the browser's identity and people search; invitations are in
// linkedin-invitations.integration.test.ts and messages and polling in linkedin-conversations.integration.test.ts
// (separate files so they run side by side).
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { useLinkedin, message } from './__fixtures__/linkedin/harness.js';
import { FIXTURE_USER, VALID_COOKIE } from './__fixtures__/linkedin/server.js';
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

    it("reads the name from the user's own profile when the header has no Me menu it knows", async () => {
      li.fixture.newHeader = true;
      try {
        const adapter = await li.build(null);
        const result = await adapter.connect({ liAt: VALID_COOKIE });
        expect(result).toEqual({ identity: FIXTURE_USER, secret: { liAt: VALID_COOKIE } });
        expect(li.fixture.hits).toContain('GET /in/me/');
      } finally {
        li.fixture.newHeader = false;
      }
    });

    it('explains in plain words when LinkedIn cannot be reached', async () => {
      const unreachable = 'http://127.0.0.1:1';
      const offline = "Couldn't open LinkedIn. Check your internet connection and try again.";
      await expect((await li.build(null, { baseUrl: unreachable })).connect({ liAt: 'abc' })).rejects.toThrow(offline);
      const signedIn = await li.build({ liAt: 'abc' }, { baseUrl: unreachable });
      await expect(signedIn.poll(null)).rejects.toThrow("Couldn't check LinkedIn for replies. Callum will try again.");
      await expect(signedIn.searchPeople?.('https://www.linkedin.com/search/results/people/?keywords=a', 3)).rejects.toThrow("Couldn't search LinkedIn right now.");
      const window = await li.build(null, { baseUrl: unreachable, loginHeaded: false });
      await expect(window.connect({})).rejects.toThrow(offline);
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
