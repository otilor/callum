/** What the desktop app's preload script puts on `window.callumDesktop`. It does not exist in a browser. */
export interface CallumDesktop {
  isDesktop: true;
  /** The app's version, e.g. 0.1.0. */
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
  /** Turn "Open Callum when your computer starts" on or off. Resolves to what the computer now says. */
  setOpenAtLogin(openAtLogin: boolean): Promise<boolean>;
  /** Whether Callum opens when the computer starts. */
  getOpenAtLogin(): Promise<boolean>;
  /** Only when the app was started for the end-to-end tests (CALLUM_E2E=1). */
  e2e?: {
    trayItems(): Promise<string[]>;
    clickTrayItem(label: string): Promise<boolean>;
  };
}
