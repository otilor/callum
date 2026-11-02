import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppState } from '../shared/types.js';
import { startServer, type RunningServer } from './main.js';

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

async function start(over: Partial<Parameters<typeof startServer>[0]> = {}) {
  const lines: string[] = [];
  const dataDir = join(mkdtempSync(join(tmpdir(), 'callum-boot-')), 'data');
  const server = await startServer({
    dataDir, host: '127.0.0.1', port: 0, password: null, webDir: null, env: { CALLUM_DEMO: '1' }, log: (l) => lines.push(l), ...over,
  });
  running.push(server);
  return { server, lines, dataDir };
}

describe('startServer', () => {
  it('serves the app on a free port, says where, and stops cleanly', async () => {
    const { server, lines, dataDir } = await start();
    expect(server.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(server.url).not.toBe('http://localhost:0');
    expect(lines).toEqual([`Callum is running at ${server.url}`]);

    const res = await fetch(`${server.url}/api/state`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as AppState;
    expect(state.demo).toBe(true);
    expect(server.ctx.repo.listChannels()).toHaveLength(3);
    expect(existsSync(join(dataDir, 'callum.db'))).toBe(true);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);

    const port = Number(new URL(server.url).port);
    await server.close();
    await expect(fetch(`${server.url}/api/state`)).rejects.toThrow();
    // The port is free again.
    await new Promise<void>((resolve, reject) => {
      const probe = createServer().once('error', reject).listen(port, '127.0.0.1', () => probe.close(() => resolve()));
    });
  });

  it('closes even while a page is listening for live events', async () => {
    const { server } = await start();
    const res = await fetch(`${server.url}/api/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected');
    server.ctx.bus.emit('people');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: changed\ndata: {"scope":"people"}');
    await server.close();
    await reader.read().catch(() => undefined);
  });

  it('keeps a password in front of the api', async () => {
    const { server } = await start({ password: 'open sesame' });
    expect((await fetch(`${server.url}/api/state`)).status).toBe(401);
    const login = await fetch(`${server.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'open sesame' }) });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await fetch(`${server.url}/api/state`, { headers: { cookie } })).status).toBe(200);
  });

  it('starts a first-time Callum in the time zone it was given instead of UTC', async () => {
    const { server } = await start({ env: { CALLUM_DEMO: '1', TZ_DEFAULT: 'Africa/Lagos' } });
    expect(server.ctx.repo.getSettings().timezone).toBe('Africa/Lagos');
  });

  it('keeps the time zone someone chose when it starts again', async () => {
    const first = await start({ env: { CALLUM_DEMO: '1', TZ_DEFAULT: 'Africa/Lagos' } });
    first.server.ctx.repo.updateSettings({ timezone: 'Europe/London', onboarded: true });
    await first.server.close();
    const again = await startServer({
      dataDir: first.dataDir, host: '127.0.0.1', port: 0, password: null, webDir: null, env: { CALLUM_DEMO: '1', TZ_DEFAULT: 'Asia/Tokyo' }, log: () => undefined,
    });
    running.push(again);
    expect(again.ctx.repo.getSettings().timezone).toBe('Europe/London');
  });

  it('fails in words when the port is taken, and leaves nothing open', async () => {
    const first = await start();
    const port = Number(new URL(first.server.url).port);
    await expect(
      startServer({ dataDir: join(mkdtempSync(join(tmpdir(), 'callum-boot-')), 'data'), host: '127.0.0.1', port, password: null, webDir: null, env: {}, log: () => undefined }),
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
