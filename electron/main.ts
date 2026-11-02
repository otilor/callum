// Callum's desktop app. It runs Callum's own server on this computer (a free port on 127.0.0.1, no password),
// shows it in a window, and keeps it running from the tray when the window is closed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { startServer, type RunningServer } from '../src/server/main.js';
import { getOpenAtLogin, HIDDEN_FLAG, setOpenAtLogin, type LoginDeps } from './login.js';
import { createNotifier, type Notifier } from './notify.js';
import { createTray, nextMondayMorning, type CallumTray, type TrayStatus } from './tray.js';

app.setName('Callum');
// Tests start the app on a throwaway folder. This has to happen before anything asks for the user data path.
const userDataOverride = process.env.CALLUM_USER_DATA?.trim();
if (userDataOverride) app.setPath('userData', resolve(userDataOverride));

const mac = process.platform === 'darwin';
const e2e = process.env.CALLUM_E2E === '1';
// Both the unpacked project and the packaged archive have this shape: <root>/dist/electron/main.js.
const root = resolve(import.meta.dirname, '../..');

let server: RunningServer | null = null;
let win: BrowserWindow | null = null;
let tray: CallumTray | null = null;
let notifier: Notifier | null = null;
let quitting = false;
let stopping = false;
const timers: NodeJS.Timeout[] = [];

// ---- small remembered things (not Callum's data): which one-time notes were shown ---------------------------

interface Prefs {
  backgroundNoteShown?: boolean;
  briefShownOn?: string;
}

const prefsFile = () => join(app.getPath('userData'), 'desktop.json');

function readPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(prefsFile(), 'utf8')) as Prefs;
  } catch {
    return {};
  }
}

function writePrefs(patch: Prefs): void {
  try {
    mkdirSync(dirname(prefsFile()), { recursive: true });
    writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...patch }));
  } catch (err) {
    console.error(`[callum] could not save desktop.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- the window ----------------------------------------------------------------------------------------------

function showWindow(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Only web and mail addresses leave the app, and they leave for the person's own browser or mail program. */
function openOutside(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') void shell.openExternal(url);
  } catch {
    // not an address
  }
}

function noteBackground(): void {
  if (mac || readPrefs().backgroundNoteShown || !Notification.isSupported()) return;
  const note = new Notification({ title: 'Callum', body: 'Callum keeps working in the background. Open it from the tray.' });
  note.on('click', showWindow);
  note.show();
  writePrefs({ backgroundNoteShown: true });
}

function createWindow(url: string, startHidden: boolean): BrowserWindow {
  const appOrigin = new URL(url).origin;
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 380,
    minHeight: 640,
    show: false,
    title: 'Callum',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    ...(mac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    icon: join(app.isPackaged ? process.resourcesPath : join(root, 'build'), 'icon.png'),
    webPreferences: {
      preload: join(root, 'dist/preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A hidden window keeps its page alive, so live updates and the page's own notifications keep working.
      backgroundThrottling: false,
      additionalArguments: e2e ? ['--callum-e2e'] : [],
    },
  });

  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openOutside(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== appOrigin) {
      event.preventDefault();
      openOutside(target);
    }
  });

  if (mac) {
    // The traffic lights sit on the page's top edge: leave them room, and let the strip above the page drag the window.
    window.webContents.on('did-finish-load', () => {
      void window.webContents.insertCSS(
        'body{padding-top:28px;box-sizing:border-box}body::before{content:"";position:fixed;top:0;left:0;right:0;height:28px;-webkit-app-region:drag;z-index:2147483647}',
      );
    });
  }

  window.once('ready-to-show', () => {
    if (!startHidden) window.show();
  });
  window.on('close', (event) => {
    if (quitting) return;
    // Closing the window only hides it: Callum keeps sending.
    event.preventDefault();
    window.hide();
    noteBackground();
  });
  void window.loadURL(url);
  return window;
}

// ---- the tray and what it asks the server to do -----------------------------------------------------------------

async function call(path: string, body?: unknown): Promise<unknown> {
  if (!server) throw new Error('Callum is not running yet.');
  const res = await fetch(`${server.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

function readTrayStatus(running: RunningServer): { status: TrayStatus; timezone: string } {
  const { repo } = running.ctx;
  const settings = repo.getSettings();
  const linkedin = repo.getChannel('linkedin');
  return {
    timezone: settings.timezone,
    status: {
      pauseState: settings.pauseState,
      pausedUntil: settings.pausedUntil,
      linkedinNeedsYou: linkedin.status === 'error' || repo.listIncidents({ open: true }).some((i) => i.channel === 'linkedin'),
    },
  };
}

function tellAboutTrouble(what: string, err: unknown): void {
  console.error(`[callum] ${what}: ${err instanceof Error ? err.message : String(err)}`);
  if (Notification.isSupported()) new Notification({ title: 'Callum', body: `Callum could not ${what}. Open Callum and try again.` }).show();
}

function startTray(running: RunningServer): void {
  const refresh = () => tray?.refresh();
  tray = createTray(
    { Tray, Menu, nativeImage },
    {
      iconDir: app.isPackaged ? join(process.resourcesPath, 'tray') : join(root, 'build/tray'),
      platform: process.platform,
      now: () => new Date(),
      read: () => readTrayStatus(running),
      actions: {
        open: showWindow,
        takeBreak: () => {
          const until = nextMondayMorning(new Date(), running.ctx.repo.getSettings().timezone).toISOString();
          call('/api/pause', { until }).then(refresh, (err: unknown) => tellAboutTrouble('take a break', err));
        },
        resume: () => {
          call('/api/resume', {}).then(refresh, (err: unknown) => tellAboutTrouble('resume', err));
        },
        quit: () => app.quit(),
      },
    },
  );
  const stopListening = running.ctx.bus.on(refresh);
  timers.push(setInterval(refresh, 60_000));
  app.once('will-quit', stopListening);
}

// ---- notifications from here ---------------------------------------------------------------------------------

function startNotifier(running: RunningServer): void {
  const { repo, bus } = running.ctx;
  notifier = createNotifier({
    bus,
    waitingPeople: () => repo.listPeople({ status: ['waiting'] }).map((p) => ({ id: p.id, firstName: p.firstName })),
    settings: () => {
      const s = repo.getSettings();
      return { notifications: s.notifications, timezone: s.timezone };
    },
    brief: async () => {
      try {
        const state = (await call('/api/state')) as { brief?: { line?: string } };
        return typeof state.brief?.line === 'string' ? { line: state.brief.line } : null;
      } catch {
        return null;
      }
    },
    show: ({ title, body }) => {
      if (!Notification.isSupported()) return;
      const note = new Notification({ title, body });
      note.on('click', showWindow);
      note.show();
    },
    hasRenderer: () => !!win && !win.isDestroyed() && !win.webContents.isCrashed(),
    now: () => new Date(),
    briefStore: { get: () => readPrefs().briefShownOn ?? null, set: (day) => writePrefs({ briefShownOn: day }) },
  });
  timers.push(setInterval(() => void notifier?.tick(), 60_000));
  void notifier.tick();
}

// ---- what the page may ask of this program -------------------------------------------------------------------

function loginDeps(): LoginDeps {
  return { app, platform: process.platform, home: homedir(), execPath: process.execPath, env: process.env };
}

function startIpc(running: RunningServer): void {
  const fromOurWindow = (sender: Electron.WebContents) => !!win && !win.isDestroyed() && sender === win.webContents;
  ipcMain.on('callum:version', (event) => {
    event.returnValue = app.getVersion();
  });
  ipcMain.on('callum:platform', (event) => {
    event.returnValue = process.platform;
  });
  ipcMain.handle('callum:open-at-login:get', async (event) => {
    if (!fromOurWindow(event.sender)) throw new Error('Not allowed.');
    return getOpenAtLogin(loginDeps());
  });
  ipcMain.handle('callum:open-at-login:set', async (event, openAtLogin: unknown) => {
    if (!fromOurWindow(event.sender)) throw new Error('Not allowed.');
    const actual = await setOpenAtLogin(loginDeps(), openAtLogin === true);
    running.ctx.repo.updateSettings({ openAtLogin: actual });
    running.ctx.bus.emit('settings');
    return actual;
  });

  if (e2e) {
    const items = () => (tray?.template() ?? []).filter((i): i is MenuItemConstructorOptions & { label: string } => i.type !== 'separator' && !!i.label);
    ipcMain.handle('callum:test:trayItems', () => items().map((i) => i.label));
    ipcMain.handle('callum:test:clickTrayItem', (_event, label: string) => {
      const item = items().find((i) => i.label === label);
      if (!item?.click) return false;
      (item.click as () => void)();
      return true;
    });
  }
}

// ---- leaving ---------------------------------------------------------------------------------------------------

/** Stops the runner and the server before the program ends, so nothing is cut off half way through a send. */
async function shutDown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearInterval(timer);
  notifier?.stop();
  try {
    await server?.close();
  } catch (err) {
    console.error(`[callum] could not stop cleanly: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    tray?.destroy();
    app.exit(0);
  }
}

// ---- start -------------------------------------------------------------------------------------------------------

async function boot(): Promise<void> {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac ? [{ role: 'appMenu' as const }] : [{ label: 'Callum', submenu: [{ role: 'quit' as const, label: 'Quit Callum' }] }]),
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  if (process.platform === 'win32') app.setAppUserModelId('app.callum.desktop');
  const webIndex = join(root, 'dist/web/index.html');
  if (!existsSync(webIndex)) console.error('[callum] dist/web is missing: run "npm run build" first.');

  try {
    server = await startServer({
      dataDir: join(app.getPath('userData'), 'data'),
      host: '127.0.0.1',
      port: 0,
      password: null,
      webDir: existsSync(webIndex) ? dirname(webIndex) : null,
      env: process.env,
    });
  } catch (err) {
    dialog.showErrorBox('Callum could not start', err instanceof Error ? err.message : String(err));
    app.exit(1);
    return;
  }

  const origin = new URL(server.url).origin;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'notifications' && contents.getURL().startsWith(origin));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permission === 'notifications' && requestingOrigin === origin);

  // The computer's own record of "open at login" wins; Callum's setting follows it (and is put back after a move or reinstall).
  const saved = server.ctx.repo.getSettings().openAtLogin;
  if (saved) await setOpenAtLogin(loginDeps(), true).catch(() => false);

  startIpc(server);
  startTray(server);
  startNotifier(server);
  const startHidden = process.argv.includes(HIDDEN_FLAG) || (mac && app.getLoginItemSettings().wasOpenedAtLogin);
  win = createWindow(server.url, startHidden);
}

if (!app.requestSingleInstanceLock()) {
  // Callum is already running here: the first one gets told, and this one leaves before it starts anything.
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  // The window being closed is not the end: Callum stays in the tray.
  app.on('window-all-closed', () => undefined);
  app.on('before-quit', (event) => {
    quitting = true;
    if (server && !stopping) {
      event.preventDefault();
      void shutDown();
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());
  void app.whenReady().then(boot);
}
