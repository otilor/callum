import { describe, expect, it } from 'vitest';
import { ConnectError } from './types.js';
import { cleanUserAgent, createLinkedinAdapter, launchOptions } from './linkedin.js';

describe('launchOptions', () => {
  it('runs a real browser without automation giveaways, the same for sign-in and work', () => {
    const work = launchOptions({ headless: true, browser: { channel: 'chrome' } });
    const signIn = launchOptions({ headless: false, browser: { channel: 'chrome' } });
    for (const options of [work, signIn]) {
      expect(options.channel).toBe('chrome');
      expect(options.args).toContain('--disable-blink-features=AutomationControlled');
      expect(options.args).toContain('--test-type');
      expect(options.ignoreDefaultArgs).toContain('--enable-automation');
      expect(options.locale).toBe('en-US');
    }
    expect(work.headless).toBe(true);
    expect(signIn.headless).toBe(false);
  });

  it("runs Playwright's own full Chromium by path when no Chrome or Edge is installed", () => {
    const options = launchOptions({ headless: true, browser: { executablePath: '/pw/chromium/chrome' } });
    expect(options.executablePath).toBe('/pw/chromium/chrome');
    expect(options).not.toHaveProperty('channel');
  });

  it('adds a user agent only when asked', () => {
    expect(launchOptions({ headless: true, browser: { channel: 'chrome' } })).not.toHaveProperty('userAgent');
    expect(launchOptions({ headless: true, browser: { channel: 'chrome' }, userAgent: 'UA' })).toMatchObject({ userAgent: 'UA' });
  });
});

describe('cleanUserAgent', () => {
  it('drops the word Headless', () => {
    expect(cleanUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    );
  });
});

describe('without Chrome or Edge', () => {
  const NEEDS_BROWSER = 'LinkedIn needs Google Chrome or Microsoft Edge on this computer. Install one, then try again.';

  it('says what to install when connecting', async () => {
    const adapter = createLinkedinAdapter(null, { dataDir: '/nonexistent/callum', findBrowser: async () => null });
    const failure = await adapter.connect({ liAt: 'abc' }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConnectError);
    expect((failure as ConnectError).message).toBe(NEEDS_BROWSER);
  });

  it('says it too when sending, as a problem that clears itself', async () => {
    const adapter = createLinkedinAdapter({ liAt: 'abc' }, { dataDir: '/nonexistent/callum', findBrowser: async () => null });
    const result = await adapter.send({ kind: 'invite', to: { name: 'Kemi Eze', email: null, linkedinUrl: 'https://www.linkedin.com/in/kemi', xHandle: null }, subject: null, body: 'Hi Kemi', inReplyTo: null });
    expect(result).toMatchObject({ ok: false, error: { code: 'temporary', message: NEEDS_BROWSER } });
  });
});
