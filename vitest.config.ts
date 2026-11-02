import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          include: ['src/server/**/*.test.{ts,tsx}', 'src/shared/**/*.test.{ts,tsx}'],
          pool: 'forks',
          // node:sqlite prints an ExperimentalWarning; keep test output pristine.
          execArgv: ['--disable-warning=ExperimentalWarning'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          include: ['src/web/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['src/web/test/setup.ts'],
        },
      },
    ],
  },
});
