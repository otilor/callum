import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autostartEntry, getOpenAtLogin, setOpenAtLogin, type LoginDeps } from './login.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'callum-login-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const fakeApp = () => {
  const state = { openAtLogin: false };
  return {
    state,
    app: {
      setLoginItemSettings: vi.fn((s: { openAtLogin: boolean }) => void (state.openAtLogin = s.openAtLogin)),
      getLoginItemSettings: () => ({ openAtLogin: state.openAtLogin }),
    },
  };
};

describe('autostartEntry', () => {
  it('starts Callum hidden in the tray', () => {
    const text = autostartEntry('/opt/Callum/callum');
    expect(text).toContain('[Desktop Entry]');
    expect(text).toContain('Name=Callum');
    expect(text).toContain('Exec="/opt/Callum/callum" --hidden');
    expect(text).not.toContain('!');
  });
});

describe('open at login', () => {
  it('uses the login items on macOS and Windows', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const { app, state } = fakeApp();
      const deps: LoginDeps = { app, platform, home, execPath: '/x', env: {} };
      expect(await setOpenAtLogin(deps, true)).toBe(true);
      expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, args: ['--hidden'] });
      expect(await getOpenAtLogin(deps)).toBe(true);
      expect(await setOpenAtLogin(deps, false)).toBe(false);
      expect(state.openAtLogin).toBe(false);
    }
  });

  it('writes and removes an autostart entry on Linux', async () => {
    const { app } = fakeApp();
    const deps: LoginDeps = { app, platform: 'linux', home, execPath: '/usr/bin/callum', env: { APPIMAGE: '/home/g/Callum.AppImage' } };
    const file = join(home, '.config', 'autostart', 'callum.desktop');
    expect(await getOpenAtLogin(deps)).toBe(false);
    expect(await setOpenAtLogin(deps, true)).toBe(true);
    expect(await readFile(file, 'utf8')).toContain('Exec="/home/g/Callum.AppImage" --hidden');
    expect(await getOpenAtLogin(deps)).toBe(true);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(await setOpenAtLogin(deps, false)).toBe(false);
    await expect(stat(file)).rejects.toThrow();
    // turning it off twice is fine
    expect(await setOpenAtLogin(deps, false)).toBe(false);
  });

  it('honours XDG_CONFIG_HOME on Linux', async () => {
    const { app } = fakeApp();
    const deps: LoginDeps = { app, platform: 'linux', home, execPath: '/usr/bin/callum', env: { XDG_CONFIG_HOME: join(home, 'cfg') } };
    await setOpenAtLogin(deps, true);
    expect(await readFile(join(home, 'cfg', 'autostart', 'callum.desktop'), 'utf8')).toContain('Exec="/usr/bin/callum" --hidden');
  });
});
