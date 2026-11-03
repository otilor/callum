import { chmodSync, existsSync, mkdtempSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../shared/types.js';
import { fixedClock } from './engine/clock.js';
import { Runner } from './runner/runner.js';
import { startServer, type RunningServer } from './main.js';

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

async function start(over: Partial<Parameters<typeof startServer>[0]> = {}) {
  const lines: string[] = [];
  const dataDir = over.dataDir ?? join(mkdtempSync(join(tmpdir(), 'callum-boot-')), 'data');
  const server = await startServer({
    host: '127.0.0.1', port: 0, password: null, webDir: null, env: { CALLUM_DEMO: '1' }, log: (l) => lines.push(l), ...over, dataDir,
  });
  running.push(server);
  return { server, lines, dataDir };
}

describe('startServer', () => {
  it('serves the app on a free port, says where, and stops cleanly', async () => {
    const { server, lines, dataDir } = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.url).not.toBe('http://127.0.0.1:0');
    expect(lines).toEqual([`Callum is running at ${server.url.replace('127.0.0.1', 'localhost')}`]);

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

  it('goes by the clock it is given, and the runner can be driven by the caller', async () => {
    const clock = fixedClock('2026-11-03T09:00:00.000Z');
    const { server } = await start({ clock, tickEveryMs: 3_600_000 });
    expect(server.ctx.clock).toBe(clock);
    // What the demo scene wrote is stamped with that clock, not the computer's.
    expect(server.ctx.repo.listProjects()[0]?.createdAt).toBe('2026-11-03T09:00:00.000Z');
    await expect(server.runner.tick()).resolves.toBeUndefined();
  });

  it('waits for the runner for at most 5 seconds when it closes', async () => {
    const stop = vi.spyOn(Runner.prototype, 'stop');
    try {
      const { server } = await start();
      await server.close();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith({ timeoutMs: 5000 });
    } finally {
      stop.mockRestore();
    }
  });

  it('puts a demo Callum with nothing in it in front of a scene, and leaves a used one alone', async () => {
    const { server, dataDir } = await start();
    expect(server.ctx.repo.listProjects().length).toBeGreaterThan(0);
    expect(server.ctx.repo.getSettings().onboarded).toBe(false);
    server.ctx.repo.updateSettings({ senderName: 'Ada Obi' });
    const projects = server.ctx.repo.listProjects().length;
    await server.close();
    const again = await start({ dataDir });
    expect(again.server.ctx.repo.listProjects()).toHaveLength(projects);
    expect(again.server.ctx.repo.getSettings().senderName).toBe('Ada Obi');
  });

  it('starts a real (not demo) Callum empty', async () => {
    const { server } = await start({ env: { CALLUM_CLAUDE_CODE: 'off' } });
    expect(server.ctx.repo.listProjects()).toEqual([]);
    expect(server.ctx.demo).toBe(false);
  });

  it('keeps the morning scene for CALLUM_DEMO_SCENE=morning', async () => {
    const { server } = await start({ env: { CALLUM_DEMO: '1', CALLUM_DEMO_SCENE: 'morning' } });
    expect(server.ctx.repo.getSettings().onboarded).toBe(true);
    expect(server.ctx.repo.listPeople({ status: ['waiting'] }).length).toBeGreaterThan(0);
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

  it('will not open to other computers without a password', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'callum-boot-')), 'data');
    for (const host of ['0.0.0.0', '::', '192.168.1.20']) {
      await expect(startServer({ dataDir, host, port: 0, password: null, webDir: null, env: { CALLUM_CLAUDE_CODE: 'off' }, log: () => undefined })).rejects.toThrow(
        'Callum needs CALLUM_PASSWORD to be reached from other computers.',
      );
    }
    expect(existsSync(dataDir)).toBe(false);
  });

  it('opens to other computers when there is a password', async () => {
    const { server } = await start({ host: '0.0.0.0', password: 'open sesame' });
    expect(server.url).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it('tightens a data folder that was left open', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'callum-boot-'));
    chmodSync(dataDir, 0o755);
    await start({ dataDir });
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it('fails in words when the port is taken, and leaves nothing open', async () => {
    const first = await start();
    const port = Number(new URL(first.server.url).port);
    await expect(
      startServer({ dataDir: join(mkdtempSync(join(tmpdir(), 'callum-boot-')), 'data'), host: '127.0.0.1', port, password: null, webDir: null, env: { CALLUM_CLAUDE_CODE: 'off' }, log: () => undefined }),
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
