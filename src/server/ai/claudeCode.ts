import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnRunner, type Runner } from './model.js';

/** Whether Claude Code is on this computer, and signed in. Shown in Your Callum. */
export interface ClaudeCodeStatus {
  found: boolean;
  signedIn: boolean;
  /** How it signed in, as Claude Code says: `claude.ai` for a Claude plan. Null when not signed in. */
  account: string | null;
}

function runnable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `claude` program: `CALLUM_CLAUDE_PATH` when set, then the PATH, then where its installers put it. A desktop app
 * opened from the Dock or Start menu often has a short PATH, so the usual install places are checked too.
 */
export function findClaudeCode(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const given = env.CALLUM_CLAUDE_PATH?.trim();
  if (given) return runnable(given) ? given : null;
  const names = platform === 'win32' ? ['claude.exe'] : ['claude'];
  const home = env.HOME || env.USERPROFILE || homedir();
  const dirs = [
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const file = join(dir, name);
      if (runnable(file)) return file;
    }
  }
  return null;
}

/** Asks Claude Code whether it is signed in (`claude auth status`). Never reads its credentials. */
export async function claudeCodeStatus(path: string | null, cwd: string, run: Runner = spawnRunner): Promise<ClaudeCodeStatus> {
  if (!path) return { found: false, signedIn: false, account: null };
  try {
    mkdirSync(cwd, { recursive: true });
  } catch {
    // Only somewhere quiet to run in.
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const res = await run(path, ['auth', 'status'], { input: '', cwd, timeoutMs: 20_000, env });
  if (res.code === null && !res.stdout) return { found: false, signedIn: false, account: null };
  try {
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) as { loggedIn?: unknown; authMethod?: unknown };
    const signedIn = out.loggedIn === true;
    return { found: true, signedIn, account: signedIn && typeof out.authMethod === 'string' ? out.authMethod : null };
  } catch {
    return { found: true, signedIn: res.code === 0, account: null };
  }
}
