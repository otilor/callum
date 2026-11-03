import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { FEATURE_ROUTES } from './api/features.js';
import { createCtx, type Ctx } from './context.js';
import { openDb } from './db/db.js';
import { seedScene } from './demo/seed.js';
import { readEnv } from './env.js';
import type { Clock } from './engine/clock.js';
import { Runner, type RunnerOptions } from './runner/runner.js';

export const TICK_EVERY_MS = 5_000;
/** How long closing waits for a poll that does not answer before the database is closed anyway. */
export const STOP_WAIT_MS = 5_000;

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
  /** The time Callum goes by. Defaults to the computer's clock; tests and the real-mail run set their own. */
  clock?: Clock;
  /** How often Callum looks for work, in milliseconds. A test that runs the passes itself sets this high. */
  tickEveryMs?: number;
  /** How the runner polls and plans. Tests shorten the time between polls. */
  runnerOptions?: RunnerOptions;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
  ctx: Ctx;
  /** The one doing the work, so a test can run a pass now instead of waiting for the next. */
  runner: Runner;
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

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
}

/** The address to open. A loopback host is given as its number so a name that resolves elsewhere cannot get in the way. */
function addressOf(host: string, port: number): string {
  if (isLoopback(host)) return `http://${host.includes(':') ? '[::1]' : host === 'localhost' ? '127.0.0.1' : host}:${port}`;
  if (host === '0.0.0.0' || host === '::') return `http://localhost:${port}`;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** Opens the database, starts looking for work and answers requests. Everything it opened is closed again by `close`. */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  if (opts.password === null && !isLoopback(opts.host)) {
    throw new Error('Callum needs CALLUM_PASSWORD to be reached from other computers.');
  }
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.dataDir, 0o700);
  const db = openDb(join(opts.dataDir, 'callum.db'));
  const conf = readEnv(env);
  const ctx = createCtx({ db, demo: conf.demo, dataDir: opts.dataDir, env, ...(opts.clock ? { clock: opts.clock } : {}) });
  setDefaultTimezone(ctx, conf.timezone);
  // A demo Callum with nothing in it starts with a scene to look at.
  if (conf.demo && ctx.repo.listProjects().length === 0) {
    seedScene(ctx, env.CALLUM_DEMO_SCENE?.trim() === 'morning' ? 'morning' : 'fresh');
    setDefaultTimezone(ctx, conf.timezone);
  }

  const runner = new Runner(ctx, opts.runnerOptions);
  runner.start(opts.tickEveryMs ?? TICK_EVERY_MS);

  let server: Server;
  const stopWork = async () => {
    // Waits for the pass and the polls under way, but no longer than 5 seconds for a poll that never answers.
    await runner.stop({ timeoutMs: STOP_WAIT_MS });
    await ctx.adapters.closeAll();
    db.close();
  };
  try {
    const app = createApp(ctx, { password: opts.password, webDir: opts.webDir, runner, trustProxy: conf.trustProxy, extraRoutes: FEATURE_ROUTES.map((build) => build(ctx)) });
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
  log(`Callum is running at ${url.replace('127.0.0.1', 'localhost')}`);

  let closing: Promise<void> | null = null;
  return {
    url,
    ctx,
    runner,
    close() {
      closing ??= (async () => {
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
