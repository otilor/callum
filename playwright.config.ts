// The journeys: Callum's built server in demo mode on a throwaway data folder, driven through a real browser.
// Build first (`npm run build && npm run build:server`), then `npm run e2e`.
// The desktop app has its own spec and its own command (see e2e/desktop.spec.ts), so it is not part of this run.
import { defineConfig } from '@playwright/test';

// The specs read the server's database with node:sqlite, which Node still marks as experimental.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' ');

export default defineConfig({
  testDir: 'e2e/journeys',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  // Every spec file starts its own Callum on a free port, so files can run side by side.
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    browserName: 'chromium',
    // On CI the Google Chrome that comes with the runner is used, so no browser is downloaded.
    ...(process.env.CI ? { channel: 'chrome' } : {}),
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: process.getuid?.() === 0 || process.env.CI ? ['--no-sandbox'] : [] },
  },
});
