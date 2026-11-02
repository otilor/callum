// "Open Callum when your computer starts". macOS and Windows have login items; on Linux it is an autostart entry.
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface LoginDeps {
  app: {
    setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void;
    getLoginItemSettings(options?: { args?: string[] }): { openAtLogin: boolean };
  };
  platform: NodeJS.Platform;
  home: string;
  /** What to start: the running binary (an AppImage starts through $APPIMAGE). */
  execPath: string;
  /** Arguments that come before ours: the app folder, when running from source with `electron .`. */
  execArgs?: string[];
  env: NodeJS.ProcessEnv;
}

/** Started by the computer, Callum opens straight into the tray instead of in front of whatever the person is doing. */
export const HIDDEN_FLAG = '--hidden';

/**
 * One word of an Exec line, as the Desktop Entry specification wants it: quoted, with the characters the shell would use
 * escaped once for quoting and once more for the file's own string escaping (so a backslash becomes four), and `%` doubled.
 */
export function execArgument(arg: string): string {
  const quoted = arg.replace(/[\\"`$]/g, (c) => `\\${c}`);
  return `"${quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')}"`;
}

export function autostartEntry(exec: string, args: string[] = []): string {
  const line = [exec, ...args].map(execArgument).join(' ');
  return ['[Desktop Entry]', 'Type=Application', 'Name=Callum', 'Comment=Keeps your outreach going in the background', `Exec=${line} ${HIDDEN_FLAG}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
}

function autostartFile(deps: LoginDeps): string {
  const config = deps.env.XDG_CONFIG_HOME?.trim() || join(deps.home, '.config');
  return join(config, 'autostart', 'callum.desktop');
}

/** On Windows a login item is told apart by its arguments, so they have to be the same when asking as when setting. */
const windowsArgs = (deps: LoginDeps) => (deps.platform === 'win32' ? { args: [HIDDEN_FLAG] } : undefined);

export async function getOpenAtLogin(deps: LoginDeps): Promise<boolean> {
  if (deps.platform === 'linux') return stat(autostartFile(deps)).then(() => true, () => false);
  return deps.app.getLoginItemSettings(windowsArgs(deps)).openAtLogin;
}

/** Applies the choice and returns what the computer now says. */
export async function setOpenAtLogin(deps: LoginDeps, openAtLogin: boolean): Promise<boolean> {
  if (deps.platform === 'linux') {
    const file = autostartFile(deps);
    if (openAtLogin) {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, autostartEntry(deps.env.APPIMAGE?.trim() || deps.execPath, deps.env.APPIMAGE?.trim() ? [] : deps.execArgs));
    } else {
      await rm(file, { force: true });
    }
  } else {
    deps.app.setLoginItemSettings({ openAtLogin, args: [HIDDEN_FLAG] });
  }
  return getOpenAtLogin(deps);
}
