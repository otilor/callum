import { existsSync, mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { createCtx, type Ctx } from './context.js';
import { openDb } from './db/db.js';
import { readEnv } from './env.js';
import { Runner } from './runner/runner.js';

export const TICK_EVERY_MS = 5_000;

export interface StartOptions {
  dataDir: string;
  host: string;
  /** 0 picks a free port. */
  port: number;
  password: string | null;
  /** The built web app. Not served when null. */
  webDir: string | null;
  env?: NodeJS.ProcessEnv;
  /** Where the one line saying Callum is running goes. Defaults to the console. */
  log?: (line: string) => void;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
  ctx: Ctx;
}

/** The built web app next to the server code, when there is one. */
export function defaultWebDir(): string | null {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/web');
  return existsSync(join(dir, 'index.html')) ? dir : null;
}

function hostZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A first-time Callum starts in this computer's time zone (or TZ_DEFAULT), not in UTC. */
function setDefaultTimezone(ctx: Ctx, preferred: string | null): void {
  const settings = ctx.repo.getSettings();
  if (settings.timezone !== 'UTC' || settings.onboarded) return;
  const zone = [preferred, hostZone()].find((z): z is string => z !== null && z !== 'UTC' && validZone(z));
  if (zone) ctx.repo.updateSettings({ timezone: zone });
}

function addressOf(host: string, port: number): string {
  const shown = host === '127.0.0.1' || host === '0.0.0.0' || host === '::' || host === '::1' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

/** Opens the database, starts looking for work and answers requests. Everything it opened is closed again by `close`. */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const db = openDb(join(opts.dataDir, 'callum.db'));
  const ctx = createCtx({ db, demo: readEnv(env).demo, dataDir: opts.dataDir, env });
  setDefaultTimezone(ctx, readEnv(env).timezone);

  // Every pass is remembered until it ends, so closing waits for work that is already under way.
  const runner = new Runner(ctx);
  const passes = new Set<Promise<void>>();
  const tracked = {
    tick(): Promise<void> {
      const pass: Promise<void> = runner.tick().finally(() => passes.delete(pass));
      passes.add(pass);
      return pass;
    },
  };
  const report = (err: unknown) => console.error(`[callum] ${err instanceof Error ? err.message : String(err)}`);
  const timer = setInterval(() => tracked.tick().catch(report), TICK_EVERY_MS);

  let server: Server;
  const stopWork = async () => {
    clearInterval(timer);
    await Promise.allSettled([...passes]);
    await ctx.adapters.closeAll();
    db.close();
  };
  try {
    const app = createApp(ctx, { password: opts.password, webDir: opts.webDir, runner: tracked });
    server = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }) as Server;
    await new Promise<void>((resolveListening, reject) => {
      server.once('listening', resolveListening);
      server.once('error', reject);
    });
  } catch (err) {
    await stopWork();
    throw err;
  }

  const url = addressOf(opts.host, (server.address() as AddressInfo).port);
  log(`Callum is running at ${url}`);

  let closing: Promise<void> | null = null;
  return {
    url,
    ctx,
    close() {
      closing ??= (async () => {
        clearInterval(timer);
        // Live-event streams stay open for as long as a page is, so they are cut for the port to be freed.
        await new Promise<void>((resolveClosed) => {
          server.close(() => resolveClosed());
          server.closeAllConnections();
        });
        await stopWork();
      })();
      return closing;
    },
  };
}

async function main(): Promise<void> {
  const env = readEnv();
  const running = await startServer({
    dataDir: env.dataDir,
    host: env.host,
    port: env.port,
    password: env.password,
    webDir: defaultWebDir(),
  });
  let leaving = false;
  const leave = () => {
    if (leaving) return;
    leaving = true;
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', leave);
  process.on('SIGTERM', leave);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`Callum could not start. ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
