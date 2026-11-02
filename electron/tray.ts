// The tray icon and its menu. The menu text and the break arithmetic are plain functions so they can be tested without Electron;
// `createTray` takes the few Electron pieces it needs.
import { join } from 'node:path';
import type { Menu, MenuItemConstructorOptions, NativeImage, Tray } from 'electron';
import { localParts, zonedTime } from '../src/server/engine/time.js';

export interface TrayStatus {
  pauseState: 'running' | 'paused' | 'wrapped';
  pausedUntil: string | null;
  /** An open problem on LinkedIn that only the person can fix. */
  linkedinNeedsYou: boolean;
}

export interface TrayActions {
  open(): void;
  takeBreak(): void;
  resume(): void;
  quit(): void;
}

const DAY_MS = 86_400_000;

/** 9:00 on the next Monday (never today), in the person's time zone. */
export function nextMondayMorning(now: Date, tz: string): Date {
  const today = localParts(now, tz);
  const ahead = (1 - today.weekday + 7) % 7 || 7;
  return zonedTime(tz, today.year, today.month, today.day + ahead, 9, 0);
}

export function statusLine(status: TrayStatus, tz: string, now: Date): string {
  if (status.pauseState === 'wrapped') return 'Wrapped up';
  if (status.pauseState === 'paused') {
    if (!status.pausedUntil) return 'Paused';
    const until = new Date(status.pausedUntil);
    const within = until.getTime() - now.getTime() < 7 * DAY_MS;
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...(within ? { weekday: 'long' } : { month: 'long', day: 'numeric' }) }).format(until);
    return `Paused until ${name}`;
  }
  if (status.linkedinNeedsYou) return 'LinkedIn needs you';
  return 'Running';
}

export function menuTemplate(status: TrayStatus, tz: string, now: Date, actions: TrayActions): MenuItemConstructorOptions[] {
  const paused = status.pauseState === 'paused';
  return [
    { label: 'Open Callum', click: () => actions.open() },
    { type: 'separator' },
    { label: statusLine(status, tz, now), enabled: false },
    paused ? { label: 'Resume', click: () => actions.resume() } : { label: 'Take a break until Monday', click: () => actions.takeBreak() },
    { type: 'separator' },
    { label: 'Quit Callum', click: () => actions.quit() },
  ];
}

/** The Electron pieces the tray needs, passed in so this file never imports `electron` itself. */
export interface TrayApi {
  Tray: new (image: NativeImage) => Tray;
  Menu: Pick<typeof Menu, 'buildFromTemplate'>;
  nativeImage: { createFromPath(path: string): NativeImage };
}

export interface TrayOptions {
  /** Folder holding trayTemplate.png, trayTemplate@2x.png, tray.png and tray@2x.png. */
  iconDir: string;
  platform: NodeJS.Platform;
  actions: TrayActions;
  read(): { status: TrayStatus; timezone: string };
  now(): Date;
}

export interface CallumTray {
  /** Rebuild the menu from the latest state. */
  refresh(): void;
  /** The menu as last built, for tests. */
  template(): MenuItemConstructorOptions[];
  destroy(): void;
}

export function createTray(api: TrayApi, opts: TrayOptions): CallumTray {
  const mac = opts.platform === 'darwin';
  const image = api.nativeImage.createFromPath(join(opts.iconDir, mac ? 'trayTemplate.png' : 'tray.png'));
  // On macOS a template image is drawn in the menu bar's own colour, light or dark.
  if (mac) image.setTemplateImage(true);
  const tray = new api.Tray(image);
  tray.setToolTip('Callum');
  let current: MenuItemConstructorOptions[] = [];
  let menu: Menu | null = null;

  const refresh = () => {
    const { status, timezone } = opts.read();
    current = menuTemplate(status, timezone, opts.now(), opts.actions);
    menu = api.Menu.buildFromTemplate(current);
    // On macOS a menu set on the icon would swallow the click, so there the menu opens on a right-click instead.
    if (!mac) tray.setContextMenu(menu);
  };
  // Clicking the icon opens the window. (Linux's indicator only shows the menu, which starts with Open Callum.)
  tray.on('click', () => opts.actions.open());
  if (mac) tray.on('right-click', () => menu && tray.popUpContextMenu(menu));
  refresh();

  return { refresh, template: () => current, destroy: () => tray.destroy() };
}
