import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Project } from '../shared/types.js';
import { PING_EVERY_MS } from '../shared/stream.js';
import { api, ApiError, onUnreachable } from './api.js';

const DEBOUNCE_MS = 150;
const RETRY_MS = 3000;
/** The stream says it is alive every `PING_EVERY_MS`; hearing nothing for twice that means it is stuck, not quiet. */
const SILENT_MS = 2 * PING_EVERY_MS;

/** The project last viewed, else the first one that is running, else the first one. */
export function pickCurrentProject(state: AppState | null): Project | null {
  if (!state) return null;
  const { projects, settings } = state;
  return projects.find((p) => p.id === settings.currentProjectId) ?? projects.find((p) => p.state === 'running') ?? projects[0] ?? null;
}

export interface AppStateHandle {
  state: AppState | null;
  /** The first fetch has not answered yet. */
  loading: boolean;
  /** The server wants a password (it answered 401). */
  locked: boolean;
  /** The live stream broke and the server could not be reached either. */
  offline: boolean;
  currentProject: Project | null;
  /** Fetches state again. With `strict`, a failure that is not a 401 is thrown to the caller as well as noted. */
  refresh(opts?: { strict?: boolean }): Promise<void>;
}

/** `/api/state`, kept current: the page listens to `/api/events` and fetches again, at most every 150 ms, when something changed. */
export function useAppState(): AppStateHandle {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [offline, setOffline] = useState(false);
  const asked = useRef(0);
  const alive = useRef(true);

  const refresh = useCallback(async (opts?: { strict?: boolean }) => {
    const ticket = ++asked.current;
    try {
      const next = await api.state();
      if (!alive.current || ticket !== asked.current) return;
      setState(next);
      setLocked(false);
      setOffline(false);
    } catch (e) {
      if (!alive.current || ticket !== asked.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setLocked(true);
        setOffline(false);
      } else {
        setOffline(true);
        if (opts?.strict) throw e;
      }
    } finally {
      if (alive.current && ticket === asked.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const loaded = state !== null;

  // The browser knows before any request does when the network goes: say so, and look again the moment it is back.
  useEffect(() => {
    const down = () => setOffline(true);
    const up = () => void refresh();
    window.addEventListener('offline', down);
    window.addEventListener('online', up);
    // Any call that got no answer is a reason to look again: a button pressed while the server is gone says so at once.
    const off = onUnreachable(() => void refresh());
    return () => {
      window.removeEventListener('offline', down);
      window.removeEventListener('online', up);
      off();
    };
  }, [refresh]);

  // While the server cannot be reached, ask again every few seconds so the page recovers on its own.
  useEffect(() => {
    if (!offline) return;
    const timer = setInterval(() => void refresh(), RETRY_MS);
    return () => clearInterval(timer);
  }, [offline, refresh]);

  useEffect(() => {
    if (!loaded || locked || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), DEBOUNCE_MS);
    };
    // A broken stream is only "offline" if the server cannot be reached either; the browser reconnects by itself.
    const broken = () => void refresh();
    // Anything the stream says, even a ping, shows it is alive. When it says nothing for too long it is closed and opened again.
    const heard = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(reconnect, SILENT_MS);
    };
    // When the stream comes back after a break, catch up on what was missed (the first open needs nothing: state is already fetched).
    let opened = false;
    const open = () => {
      if (opened) changed();
      opened = true;
      heard();
    };
    const onChanged = () => {
      heard();
      changed();
    };
    function connect() {
      source = new EventSource('/api/events');
      source.addEventListener('changed', onChanged);
      source.addEventListener('ping', heard);
      source.addEventListener('error', broken);
      source.addEventListener('open', open);
      heard();
    }
    function drop() {
      if (!source) return;
      source.removeEventListener('changed', onChanged);
      source.removeEventListener('ping', heard);
      source.removeEventListener('error', broken);
      source.removeEventListener('open', open);
      source.close();
      source = null;
    }
    function reconnect() {
      if (closed) return;
      drop();
      connect();
      void refresh();
    }
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      drop();
    };
  }, [loaded, locked, refresh]);

  return { state, loading, locked, offline, currentProject: pickCurrentProject(state), refresh };
}
