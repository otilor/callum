// Starts the real desktop app (Electron) on a throwaway data folder. Needs `npm run desktop:prepare` first;
// on Linux without a display run it as `xvfb-run -a npx playwright test e2e/desktop.spec.ts`.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const MAIN = 'dist/electron/main.js';
// A root user (a container) and most CI machines cannot use Chromium's sandbox; there is no display or graphics card either.
const flags = ['--disable-gpu', ...(process.getuid?.() === 0 || process.env.CI ? ['--no-sandbox'] : [])];

let userData: string;
let env: Record<string, string>;
let app: ElectronApplication;
let page: Page;
let origin: string;

test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'callum-desktop-'));
  env = { ...(process.env as Record<string, string>), CALLUM_DEMO: '1', CALLUM_USER_DATA: userData, CALLUM_E2E: '1', XDG_CONFIG_HOME: join(userData, 'config') };
  app = await electron.launch({ args: [...flags, MAIN], env });
  page = await app.firstWindow();
  origin = new URL(page.url()).origin;
});

test.afterAll(async () => {
  await app.close().catch(() => undefined);
  await rm(userData, { recursive: true, force: true });
});

const isVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()));
const state = async () => (await fetch(`${origin}/api/state`)).json() as Promise<{ settings: { pauseState: string }; demo: boolean }>;

test('the window shows First run', async () => {
  await expect(page.locator('[data-screen="first-run"]')).toBeVisible();
  expect(new URL(page.url()).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(await isVisible()).toBe(true);
  expect((await state()).demo).toBe(true);
});

test('gives the page the desktop bridge and nothing from Node', async () => {
  const bridge = await page.evaluate(() => ({
    desktop: window.callumDesktop?.isDesktop,
    version: window.callumDesktop?.version,
    platform: window.callumDesktop?.platform,
    node: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
  }));
  expect(bridge).toEqual({ desktop: true, version: expect.stringMatching(/^\d+\.\d+\.\d+/), platform: process.platform, node: 'undefined', process: 'undefined' });
});

test('closing the window leaves Callum running', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(isVisible).toBe(false);
  // Still alive: the window is only hidden, and the server answers.
  expect(app.process().exitCode).toBeNull();
  expect((await state()).settings.pauseState).toBe('running');
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});

test('a second launch brings the first window back instead of starting another Callum', async () => {
  expect(await isVisible()).toBe(false);
  const electronBinary = (await import('electron')).default as unknown as string;
  const second = spawn(electronBinary, [...flags, MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  second.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  second.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => second.once('exit', (c) => resolve(c)));
  expect(code).toBe(0);
  expect(output).not.toContain('Callum is running');
  await expect.poll(isVisible).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(new URL(page.url()).origin).toBe(origin);
});

test('the tray menu has Open Callum, the status, the break and Quit Callum', async () => {
  const items = () => page.evaluate(() => window.callumDesktop?.e2e?.trayItems());
  expect(await items()).toEqual(['Open Callum', 'Running', 'Take a break until Monday', 'Quit Callum']);

  // Take a break goes through the real route, and the menu follows.
  expect(await page.evaluate(() => window.callumDesktop?.e2e?.clickTrayItem('Take a break until Monday'))).toBe(true);
  await expect.poll(async () => (await state()).settings.pauseState).toBe('paused');
  await expect.poll(async () => (await items())?.[2]).toBe('Resume');
  expect((await items())?.[1]).toMatch(/^Paused until /);
  expect(await page.evaluate(() => window.callumDesktop?.e2e?.clickTrayItem('Resume'))).toBe(true);
  await expect.poll(async () => (await state()).settings.pauseState).toBe('running');
  await expect.poll(async () => (await items())?.[2]).toBe('Take a break until Monday');

  // Open Callum brings a hidden window back.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
  await expect.poll(isVisible).toBe(false);
  expect(await page.evaluate(() => window.callumDesktop?.e2e?.clickTrayItem('Open Callum'))).toBe(true);
  await expect.poll(isVisible).toBe(true);
});

test('open at login is applied and remembered in settings', async () => {
  // macOS and Windows would change the real login items of whoever runs this.
  test.skip(process.platform !== 'linux', 'only Linux keeps this in a folder the test can point elsewhere');
  const settings = async () => (await state()).settings as { openAtLogin?: boolean };
  expect(await page.evaluate(() => window.callumDesktop?.getOpenAtLogin())).toBe(false);
  expect(await page.evaluate(() => window.callumDesktop?.setOpenAtLogin(true))).toBe(true);
  expect((await settings()).openAtLogin).toBe(true);
  expect(await page.evaluate(() => window.callumDesktop?.setOpenAtLogin(false))).toBe(false);
  expect((await settings()).openAtLogin).toBe(false);
});

test('Quit stops Callum and exits with code 0', async () => {
  const exited = new Promise<number | null>((resolve) => app.process().once('exit', (code) => resolve(code)));
  expect(await page.evaluate(() => window.callumDesktop?.e2e?.clickTrayItem('Quit Callum'))).toBe(true);
  expect(await exited).toBe(0);
  // The port is free again.
  await expect(fetch(`${origin}/api/state`)).rejects.toThrow();
});
