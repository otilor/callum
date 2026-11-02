// Which browser Callum drives for LinkedIn. Plain Node only (no `electron` import), so the server and the tests can use it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

export interface BrowserChoice {
  channel?: 'chrome' | 'msedge';
  executablePath?: string;
}

/** Each probe answers "is it here?"; `bundled` answers with the path of Playwright's own Chromium, or null. */
export interface BrowserProbes {
  chrome(): boolean | Promise<boolean>;
  msedge(): boolean | Promise<boolean>;
  bundled(): string | null | Promise<string | null>;
}

/** Playwright looks for an installed Chrome or Edge in these places, so these are the ones that work. */
export function browserPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Record<'chrome' | 'msedge', string[]> {
  if (platform === 'darwin') {
    return {
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    };
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    return {
      chrome: roots.map((r) => join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      msedge: roots.map((r) => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    };
  }
  return { chrome: ['/opt/google/chrome/chrome'], msedge: ['/opt/microsoft/msedge/msedge'] };
}

/** A real installed browser looks like the one the person signs in with, so prefer Chrome, then Edge. */
export function installedChannel(
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): 'chrome' | 'msedge' | null {
  const paths = browserPaths(platform, env);
  if (paths.chrome.some(exists)) return 'chrome';
  if (paths.msedge.some(exists)) return 'msedge';
  return null;
}

export function systemProbes(
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): BrowserProbes {
  const paths = browserPaths(platform, env);
  return {
    chrome: () => paths.chrome.some(exists),
    msedge: () => paths.msedge.some(exists),
    bundled: () => {
      const fromEnv = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim();
      if (fromEnv && exists(fromEnv)) return fromEnv;
      try {
        const bundled = chromium.executablePath();
        return bundled && exists(bundled) ? bundled : null;
      } catch {
        return null;
      }
    },
  };
}

/** Chrome, then Edge, then Playwright's Chromium when one is present. Null when this computer has none of them. */
export async function findBrowser(probes: BrowserProbes = systemProbes()): Promise<BrowserChoice | null> {
  const has = async (probe: () => boolean | Promise<boolean>): Promise<boolean> => {
    try {
      return await probe();
    } catch {
      return false;
    }
  };
  if (await has(probes.chrome)) return { channel: 'chrome' };
  if (await has(probes.msedge)) return { channel: 'msedge' };
  try {
    const executablePath = await probes.bundled();
    if (executablePath) return { executablePath };
  } catch {
    // an unreadable install counts as not there
  }
  return null;
}
