import { describe, expect, it } from 'vitest';
import { findBrowser, installedChannel, type BrowserProbes } from './browser.js';

function probes(found: { chrome?: boolean; msedge?: boolean; bundled?: string | null }, order: string[] = []): BrowserProbes {
  return {
    chrome: async () => (order.push('chrome'), found.chrome ?? false),
    msedge: async () => (order.push('msedge'), found.msedge ?? false),
    bundled: async () => (order.push('bundled'), found.bundled ?? null),
  };
}

describe('findBrowser', () => {
  it('picks Chrome first', async () => {
    const order: string[] = [];
    expect(await findBrowser(probes({ chrome: true, msedge: true, bundled: '/pw/chrome' }, order))).toEqual({ channel: 'chrome' });
    expect(order).toEqual(['chrome']);
  });

  it('then Edge', async () => {
    const order: string[] = [];
    expect(await findBrowser(probes({ msedge: true, bundled: '/pw/chrome' }, order))).toEqual({ channel: 'msedge' });
    expect(order).toEqual(['chrome', 'msedge']);
  });

  it('then the Chromium that comes with Playwright', async () => {
    const order: string[] = [];
    expect(await findBrowser(probes({ bundled: '/pw/chrome' }, order))).toEqual({ executablePath: '/pw/chrome' });
    expect(order).toEqual(['chrome', 'msedge', 'bundled']);
  });

  it('is null when nothing is installed', async () => {
    expect(await findBrowser(probes({}))).toBeNull();
  });

  it('treats a probe that throws as not found', async () => {
    const broken: BrowserProbes = {
      chrome: async () => {
        throw new Error('no permission');
      },
      msedge: async () => true,
      bundled: async () => null,
    };
    expect(await findBrowser(broken)).toEqual({ channel: 'msedge' });
  });
});

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
