// Shared by the journey specs: start the built Callum in demo mode on a throwaway data folder, and ask its API.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

export interface Running {
  url: string;
  dataDir: string;
  /** The server's own words on stdout and stderr, for a failing test to print. */
  output: () => string;
  stop: () => Promise<void>;
  /** Calls /api. Throws with the server's own message when it answers with an error. */
  api: <T = unknown>(path: string, body?: unknown, method?: string) => Promise<T>;
  /** Like api, but gives back the status and the body whatever they are. */
  raw: (path: string, init?: RequestInit) => Promise<{ status: number; body: any; headers: Headers }>;
  state: () => Promise<State>;
  /** Reads the server's own database (read only), for what /api/state leaves out. */
  sql: <T = Record<string, unknown>>(query: string, ...params: Array<string | number | null>) => T[];
}

/** The parts of /api/state the journeys read. */
export interface State {
  settings: { pauseState: 'running' | 'paused' | 'wrapped'; onboarded: boolean; currentProjectId: number | null; timezone: string; pausedUntil: string | null };
  projects: Array<{ id: number; name: string; tone: string; state: string; approvalsLeft: number; startedAt: string | null; calendarUrl: string | null }>;
  channels: Array<{ channel: string; status: string; identity: string | null }>;
  people: Person[];
  outbox: Outbox[];
  incidents: Array<{ id: number; kind: string; state: string }>;
  brief: { wantToTalk: number; line: string };
  demo: boolean;
  auth: { password: boolean };
}
export interface Person {
  id: number; name: string; firstName: string; projectId: number; channel: string; stage: string; status: string; touches: number;
  email: string | null; replyKind: string | null; draft: string | null; snoozedUntil: string | null; restUntil: string | null; source: string;
  nextTouchAt: string | null;
}
export interface Outbox {
  id: number; personId: number; channel: string; kind: string; subject: string | null; body: string; state: string;
  origin: string; sendAfter: string; undoUntil: string | null;
}

export interface StartOptions {
  scene?: 'fresh' | 'morning';
  password?: string;
  /** With a password, the helper signs its own API calls in unless this is false. */
  signIn?: boolean;
  env?: Record<string, string>;
}

/** Starts Callum from the build (dist/server) in demo mode. The folder it keeps its data in is removed on stop. */
export async function startCallum(opts: StartOptions = {}): Promise<Running> {
  const dataDir = await mkdtemp(join(tmpdir(), 'callum-e2e-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CALLUM_DEMO: '1',
    CALLUM_CLAUDE_CODE: 'off',
    CALLUM_DATA_DIR: dataDir,
    PORT: '0',
    CALLUM_DEMO_SCENE: opts.scene ?? 'fresh',
    ...(opts.password ? { CALLUM_PASSWORD: opts.password } : {}),
    ...opts.env,
  };
  if (!opts.password) delete env.CALLUM_PASSWORD;
  const child: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/main.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Callum did not start in 20 seconds.\n${out}`)), 20_000);
    const take = (chunk: Buffer) => {
      out += chunk.toString();
      const m = /Callum is running at (http:\/\/\S+)/.exec(out);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Callum exited with ${code} before it started.\n${out}`));
    });
  });
  const base = url.replace('localhost', '127.0.0.1');
  let cookie = '';
  const raw: Running['raw'] = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0] ?? '';
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON (a CSV, a page) */
    }
    return { status: res.status, body, headers: res.headers };
  };
  const api: Running['api'] = async (path, body, method) => {
    const res = await raw(`/api${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (res.status >= 400) throw new Error(`${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  if (opts.password && opts.signIn !== false) {
    const res = await raw('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: opts.password }) });
    if (res.status !== 200) throw new Error(`login answered ${res.status}`);
  }
  return {
    url: base,
    dataDir,
    output: () => out,
    api,
    raw,
    state: () => api<State>('/state'),
    sql<T>(query: string, ...params: Array<string | number | null>): T[] {
      // Loaded when first needed, so the warning Node prints for node:sqlite stays out of runs that never read the database.
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
      const db = new DatabaseSync(join(dataDir, 'callum.db'), { readOnly: true });
      try {
        return db.prepare(query).all(...params) as T[];
      } finally {
        db.close();
      }
    },
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8_000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Replaces everything with a demo scene and marks this week's note as seen, so it does not open over what the test is looking at. */
export async function seed(app: Running, scene: 'fresh' | 'morning'): Promise<void> {
  await app.api('/demo/seed', { scene });
  await app.api('/weekly/seen', {});
}

/** Opens Callum and waits for a screen. */
export async function openCallum(page: Page, app: Running, screen: string): Promise<void> {
  await page.goto(app.url);
  await expect(page.locator(`[data-screen="${screen}"]`)).toBeVisible();
}

export const people = (s: State, projectId?: number) => s.people.filter((p) => projectId === undefined || p.projectId === projectId);
export const byName = (s: State, name: string): Person => {
  const p = s.people.find((x) => x.name === name || x.firstName === name);
  if (!p) throw new Error(`No one called ${name} in the state.`);
  return p;
};
