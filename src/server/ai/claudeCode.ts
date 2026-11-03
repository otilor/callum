import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { claudeCodeEnv, spawnRunner, type Runner } from './model.js';

/** Whether Claude Code is on this computer, and signed in. Shown in Your Callum. */
export interface ClaudeCodeStatus {
  found: boolean;
  /** False when it was found but would not run, so asking the user to sign in would be the wrong advice. */
  runs?: boolean;
  signedIn: boolean;
  /** How it signed in, as Claude Code says: `claude.ai` for a Claude plan. Null when not signed in. */
  account: string | null;
}

/**
 * What to run for a `claude` found at this path. npm installs a small launcher (`claude.cmd` on Windows, a link to
 * `cli.js` elsewhere); Callum runs the `cli.js` behind it on its own Node, because Node won't start a `.cmd` without a
 * shell and the launcher needs a `node` on a PATH that a desktop app may not have.
 */
function program(file: string, platform: NodeJS.Platform): string | null {
  if (/\.(cmd|bat|ps1)$/i.test(file)) {
    const cli = join(dirname(file), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    return existsSync(cli) ? cli : null;
  }
  if (!runnable(file, platform)) return null;
  try {
    const real = realpathSync(file);
    return /\.(c|m)?js$/i.test(real) ? real : file;
  } catch {
    return file;
  }
}

function runnable(file: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32' && process.platform !== 'win32') accessSync(file, constants.X_OK);
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
  if (given) return program(given, platform);
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const home = env.HOME || env.USERPROFILE || homedir();
  const sep = platform === 'win32' ? ';' : delimiter;
  const dirs = [
    ...(env.PATH ?? env.Path ?? '').split(sep).filter(Boolean),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    ...(platform === 'win32'
      ? [env.APPDATA ? join(env.APPDATA, 'npm') : join(home, 'AppData', 'Roaming', 'npm')]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      const found = program(file, platform);
      if (found) return found;
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
  const res = await run(path, ['auth', 'status'], { input: '', cwd, timeoutMs: 20_000, env: claudeCodeEnv(path) });
  if (res.code === null && !res.stdout) return { found: true, runs: false, signedIn: false, account: null };
  try {
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) as { loggedIn?: unknown; authMethod?: unknown };
    const signedIn = out.loggedIn === true;
    return { found: true, runs: true, signedIn, account: signedIn && typeof out.authMethod === 'string' ? out.authMethod : null };
  } catch {
    // An older Claude Code prints words, not JSON. Anything else that isn't JSON means it didn't really run.
    if (res.code === 0) return { found: true, runs: true, signedIn: true, account: null };
    if (/not logged in|log ?in|sign ?in/i.test(res.stdout + res.stderr)) return { found: true, runs: true, signedIn: false, account: null };
    return { found: true, runs: false, signedIn: false, account: null };
  }
}
