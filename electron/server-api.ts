// The small part of the server the desktop shell uses, written out here so electron/ compiles on its own to dist/electron.
// (The server compiles to dist/server and is loaded from there at run time; electron/server-api.test.ts checks that
// the real `startServer` result still fits these shapes.)

export interface TimeApi {
  localParts(d: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number };
  zonedTime(tz: string, year: number, month: number, day: number, hour: number, minute?: number): Date;
}

export interface DesktopSettings {
  timezone: string;
  pauseState: 'running' | 'paused' | 'wrapped';
  pausedUntil: string | null;
  notifications: boolean | null;
  openAtLogin?: boolean;
}

export interface DesktopServer {
  url: string;
  close(): Promise<void>;
  ctx: {
    bus: {
      on(fn: (scope: string) => void): () => void;
      emit(scope: 'settings'): void;
    };
    repo: {
      getSettings(): DesktopSettings;
      updateSettings(patch: { openAtLogin: boolean }): unknown;
      getChannel(channel: 'linkedin'): { status: string };
      listIncidents(filter: { open?: boolean }): { channel: string }[];
      listPeople(filter: { status?: ['waiting'] }): { id: number; firstName: string }[];
    };
  };
}

export interface ServerModule {
  startServer(opts: {
    dataDir: string;
    host: string;
    port: number;
    password: string | null;
    webDir: string | null;
    env?: NodeJS.ProcessEnv;
  }): Promise<DesktopServer>;
}
