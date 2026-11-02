// Callum's desktop app. It runs Callum's own server on this computer (a free port on 127.0.0.1, no password),
// shows it in a window, and keeps it running from the tray when the window is closed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { getOpenAtLogin, HIDDEN_FLAG, setOpenAtLogin, type LoginDeps } from './login.js';
import { createNotifier, type Notifier } from './notify.js';
import type { DesktopServer, ServerModule, TimeApi } from './server-api.js';
import { createTray, nextMondayMorning, type CallumTray, type TrayStatus } from './tray.js';

app.setName('Callum');
// Tests start the app on a throwaway folder. This has to happen before anything asks for the user data path.
const userDataOverride = process.env.CALLUM_USER_DATA?.trim();
if (userDataOverride) app.setPath('userData', resolve(userDataOverride));

const mac = process.platform === 'darwin';
// The test hooks exist only in a build that is run from source, never in an installed app.
const e2e = !app.isPackaged && process.env.CALLUM_E2E === '1';
// Both the unpacked project and the packaged archive have this shape: <root>/dist/electron/main.js.
const root = resolve(import.meta.dirname, '../..');

let server: DesktopServer | null = null;
let time: TimeApi | null = null;
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

/** From package.json next to dist/: `electron dist/electron/main.js` has no app folder of its own for Electron to read it from. */
function appVersion(): string {
  try {
    const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }).version;
    if (typeof version === 'string') return version;
  } catch {
    // fall through
  }
  return app.getVersion();
}

// ---- the window ----------------------------------------------------------------------------------------------

function showWindow(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

let appOrigin = '';

/** Origins are compared parsed: a permission check hands over `http://localhost:1234/` and a page `http://localhost:1234`. */
function isAppOrigin(address: string | undefined): boolean {
  if (!address || !appOrigin) return false;
  try {
    return new URL(address).origin === appOrigin;
  } catch {
    return false;
  }
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
  appOrigin = new URL(url).origin;
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
  // Nothing but Callum's own pages loads in the window, whether by a click, a redirect or a frame.
  window.webContents.on('will-navigate', (event, target) => {
    if (!isAppOrigin(target)) {
      event.preventDefault();
      openOutside(target);
    }
  });
  window.webContents.on('will-redirect', (event, target) => {
    if (!isAppOrigin(target)) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', (event) => {
    if (!isAppOrigin(event.url)) event.preventDefault();
  });
  // If the page crashes, bring it back: Callum itself keeps running either way.
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit' && !window.isDestroyed()) window.webContents.reload();
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

function serverTime(): TimeApi {
  if (!time) throw new Error('Callum is not running yet.');
  return time;
}

function readTrayStatus(running: DesktopServer): { status: TrayStatus; timezone: string } {
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

function startTray(running: DesktopServer): void {
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
          const until = nextMondayMorning(new Date(), running.ctx.repo.getSettings().timezone, serverTime()).toISOString();
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

function startNotifier(running: DesktopServer): void {
  const { repo, bus } = running.ctx;
  notifier = createNotifier({
    bus,
    time: serverTime(),
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
  // Run from source (`electron .`), the computer has to be told the app folder as well as the program.
  return { app, platform: process.platform, home: homedir(), execPath: process.execPath, ...(app.isPackaged ? {} : { execArgs: [app.getAppPath()] }), env: process.env };
}

function startIpc(running: DesktopServer): void {
  /** Only the app's own window, showing the app's own page, may ask for anything. */
  const fromOurWindow = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    !!win && !win.isDestroyed() && event.sender === win.webContents && isAppOrigin(event.senderFrame?.url);
  ipcMain.on('callum:version', (event) => {
    event.returnValue = fromOurWindow(event) ? appVersion() : '';
  });
  ipcMain.on('callum:platform', (event) => {
    event.returnValue = fromOurWindow(event) ? process.platform : '';
  });
  ipcMain.handle('callum:open-at-login:get', async (event) => {
    if (!fromOurWindow(event)) throw new Error('Not allowed.');
    return getOpenAtLogin(loginDeps());
  });
  ipcMain.handle('callum:open-at-login:set', async (event, openAtLogin: unknown) => {
    if (!fromOurWindow(event)) throw new Error('Not allowed.');
    const actual = await setOpenAtLogin(loginDeps(), openAtLogin === true);
    running.ctx.repo.updateSettings({ openAtLogin: actual });
    running.ctx.bus.emit('settings');
    return actual;
  });

  if (e2e) {
    const items = () => (tray?.template() ?? []).filter((i): i is MenuItemConstructorOptions & { label: string } => i.type !== 'separator' && !!i.label);
    ipcMain.handle('callum:test:trayItems', (event) => {
      if (!fromOurWindow(event)) throw new Error('Not allowed.');
      return items().map((i) => i.label);
    });
    ipcMain.handle('callum:test:clickTrayItem', (event, label: string) => {
      if (!fromOurWindow(event)) throw new Error('Not allowed.');
      const item = items().find((i) => i.label === label);
      if (!item?.click) return false;
      (item.click as () => void)();
      return true;
    });
  }
}

// ---- leaving ---------------------------------------------------------------------------------------------------

/** The longest Quit waits for the runner to finish what it is doing. */
const CLOSE_TIMEOUT_MS = 15_000;

/** Quit looks instant (window and tray go at once), then stops the runner so nothing is cut off half way through a send. */
async function shutDown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearInterval(timer);
  notifier?.stop();
  if (win && !win.isDestroyed()) win.hide();
  tray?.destroy();
  let timeout: NodeJS.Timeout | undefined;
  try {
    if (server) {
      await Promise.race([
        server.close(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            console.error(`[callum] still stopping after ${CLOSE_TIMEOUT_MS / 1000} s, leaving anyway`);
            resolve();
          }, CLOSE_TIMEOUT_MS);
        }),
      ]);
    }
  } catch (err) {
    console.error(`[callum] could not stop cleanly: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
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
    // The server is built to dist/server next to this folder; it is not bundled into the shell.
    const [serverModule, timeModule] = await Promise.all([
      import(pathToFileURL(join(root, 'dist/server/main.js')).href) as Promise<ServerModule>,
      import(pathToFileURL(join(root, 'dist/server/engine/time.js')).href) as Promise<TimeApi>,
    ]);
    time = timeModule;
    server = await serverModule.startServer({
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

  appOrigin = new URL(server.url).origin;
  // Only Callum's own page may ask: for notifications, and for copying to the clipboard (the Copy buttons).
  const allowed = new Set(['notifications', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(allowed.has(permission) && isAppOrigin(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowed.has(permission) && isAppOrigin(requestingOrigin));

  // The computer's own record of "open at login" is the truth; Callum's setting follows it.
  const actual = await getOpenAtLogin(loginDeps()).catch(() => false);
  if (server.ctx.repo.getSettings().openAtLogin !== actual) server.ctx.repo.updateSettings({ openAtLogin: actual });

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
