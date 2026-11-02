import { describe, expect, it } from 'vitest';
import { cleanUserAgent, installedChannel, launchOptions } from './linkedin.js';

describe('installedChannel', () => {
  it('prefers Chrome, then Edge, where Playwright looks for them', () => {
    const only = (...paths: string[]) => (p: string) => paths.includes(p);
    expect(installedChannel(only('/opt/google/chrome/chrome', '/opt/microsoft/msedge/msedge'), 'linux', {})).toBe('chrome');
    expect(installedChannel(only('/opt/microsoft/msedge/msedge'), 'linux', {})).toBe('msedge');
    expect(installedChannel(only(), 'linux', {})).toBeNull();
    expect(installedChannel(only('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'darwin', {})).toBe('chrome');
    expect(installedChannel(only('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), 'darwin', {})).toBe('msedge');
  });

  it('looks in the Windows program folders', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\g\\AppData\\Local' };
    const seen: string[] = [];
    expect(installedChannel((p) => (seen.push(p), p.endsWith('msedge.exe') && p.includes('x86')), 'win32', env)).toBe('msedge');
    expect(seen.some((p) => p.includes('chrome.exe'))).toBe(true);
  });
});

describe('launchOptions', () => {
  it('runs a real browser without automation giveaways, the same for sign-in and work', () => {
    const work = launchOptions({ headless: true, channel: 'chrome' });
    const signIn = launchOptions({ headless: false, channel: 'chrome' });
    for (const options of [work, signIn]) {
      expect(options.channel).toBe('chrome');
      expect(options.args).toContain('--disable-blink-features=AutomationControlled');
      expect(options.ignoreDefaultArgs).toContain('--enable-automation');
      expect(options.locale).toBe('en-US');
    }
    expect(work.headless).toBe(true);
    expect(signIn.headless).toBe(false);
  });

  it('falls back to the full Chromium, not the headless shell, when no Chrome or Edge is installed', () => {
    expect(launchOptions({ headless: true, channel: null }).channel).toBe('chromium');
  });

  it('adds a user agent only when asked', () => {
    expect(launchOptions({ headless: true, channel: 'chrome' })).not.toHaveProperty('userAgent');
    expect(launchOptions({ headless: true, channel: 'chrome', userAgent: 'UA' })).toMatchObject({ userAgent: 'UA' });
  });
});

describe('cleanUserAgent', () => {
  it('drops the word Headless', () => {
    expect(cleanUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    );
  });
});
