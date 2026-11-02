import type { CallumDesktop } from '../shared/desktop.js';

declare global {
  interface Window {
    /** Only in the desktop app. */
    callumDesktop?: CallumDesktop;
  }
}

export {};
