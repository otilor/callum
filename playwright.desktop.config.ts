// The desktop app's own spec: the real Electron app on a throwaway data folder (see e2e/desktop.spec.ts).
// Prepare first (`npm run desktop:prepare`); on Linux without a display run it as `xvfb-run -a npm run e2e:desktop`.
import { defineConfig } from '@playwright/test';

// The app's server reads its database with node:sqlite, which Node still marks as experimental.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' ');

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'desktop.spec.ts',
  outputDir: 'test-results-desktop',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-desktop' }]] : [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
