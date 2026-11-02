// Runs in the window before the page, with the page's own world kept apart (contextIsolation). It hands the page
// one small object, `window.callumDesktop`, and nothing else from Electron or Node.
// Built as CommonJS (tsconfig.preload.json) because a sandboxed preload cannot be an ES module.
import { contextBridge, ipcRenderer } from 'electron';

const api: Record<string, unknown> = {
  isDesktop: true,
  version: ipcRenderer.sendSync('callum:version') as string,
  platform: ipcRenderer.sendSync('callum:platform') as string,
  setOpenAtLogin: (openAtLogin: boolean): Promise<boolean> => ipcRenderer.invoke('callum:open-at-login:set', Boolean(openAtLogin)),
  getOpenAtLogin: (): Promise<boolean> => ipcRenderer.invoke('callum:open-at-login:get'),
};

// Only for the end-to-end tests, which start the app with CALLUM_E2E=1.
if (process.argv.includes('--callum-e2e')) {
  api.e2e = {
    trayItems: (): Promise<string[]> => ipcRenderer.invoke('callum:test:trayItems'),
    clickTrayItem: (label: string): Promise<boolean> => ipcRenderer.invoke('callum:test:clickTrayItem', label),
  };
}

contextBridge.exposeInMainWorld('callumDesktop', api);
