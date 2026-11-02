import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as time from '../src/server/engine/time.js';
import { startServer, type RunningServer } from '../src/server/main.js';
import type { DesktopServer, TimeApi } from './server-api.js';

// The desktop shell loads the compiled server and uses it through the shapes in server-api.ts. These assignments are
// checked by `tsc`, so a change to the server that breaks the shell fails the typecheck, and the test runs what the shell calls.
const asDesktop = (s: RunningServer): DesktopServer => s;
const asTime = (): TimeApi => time;

let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

describe('what the desktop shell uses from the server', () => {
  it('is there, with the shapes the shell expects', async () => {
    running = await startServer({ dataDir: join(mkdtempSync(join(tmpdir(), 'callum-shell-')), 'data'), host: '127.0.0.1', port: 0, password: null, webDir: null, env: { CALLUM_DEMO: '1' }, log: () => undefined });
    const server = asDesktop(running);
    const { repo, bus } = server.ctx;
    expect(repo.getSettings()).toMatchObject({ pauseState: 'running', pausedUntil: null });
    expect(repo.getChannel('linkedin').status).toBe('disconnected');
    expect(repo.listIncidents({ open: true })).toEqual([]);
    expect(repo.listPeople({ status: ['waiting'] })).toEqual([]);
    repo.updateSettings({ openAtLogin: true });
    expect(repo.getSettings().openAtLogin).toBe(true);
    let heard: string | null = null;
    const off = bus.on((scope) => (heard = scope));
    bus.emit('settings');
    off();
    expect(heard).toBe('settings');
    expect(asTime().localParts(new Date('2026-11-04T07:31:00Z'), 'Africa/Lagos')).toMatchObject({ hour: 8, minute: 31, weekday: 3 });
  });
});
