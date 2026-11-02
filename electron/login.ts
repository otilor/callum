// "Open Callum when your computer starts". macOS and Windows have login items; on Linux it is an autostart entry.
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface LoginDeps {
  app: {
    setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void;
    getLoginItemSettings(): { openAtLogin: boolean };
  };
  platform: NodeJS.Platform;
  home: string;
  /** What to start: the running binary (an AppImage starts through $APPIMAGE). */
  execPath: string;
  env: NodeJS.ProcessEnv;
}

/** Started by the computer, Callum opens straight into the tray instead of in front of whatever the person is doing. */
export const HIDDEN_FLAG = '--hidden';

export function autostartEntry(exec: string): string {
  return ['[Desktop Entry]', 'Type=Application', 'Name=Callum', 'Comment=Keeps your outreach going in the background', `Exec="${exec}" ${HIDDEN_FLAG}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
}

function autostartFile(deps: LoginDeps): string {
  const config = deps.env.XDG_CONFIG_HOME?.trim() || join(deps.home, '.config');
  return join(config, 'autostart', 'callum.desktop');
}

export async function getOpenAtLogin(deps: LoginDeps): Promise<boolean> {
  if (deps.platform === 'linux') return stat(autostartFile(deps)).then(() => true, () => false);
  return deps.app.getLoginItemSettings().openAtLogin;
}

/** Applies the choice and returns what the computer now says. */
export async function setOpenAtLogin(deps: LoginDeps, openAtLogin: boolean): Promise<boolean> {
  if (deps.platform === 'linux') {
    const file = autostartFile(deps);
    if (openAtLogin) {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, autostartEntry(deps.env.APPIMAGE?.trim() || deps.execPath));
    } else {
      await rm(file, { force: true });
    }
  } else {
    deps.app.setLoginItemSettings({ openAtLogin, args: [HIDDEN_FLAG] });
  }
  return getOpenAtLogin(deps);
}
