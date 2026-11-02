import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    pool: 'forks',
    // node:sqlite prints an ExperimentalWarning; keep test output pristine.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
