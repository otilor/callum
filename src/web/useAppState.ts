import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Project } from '../shared/types.js';
import { api, ApiError } from './api.js';

const DEBOUNCE_MS = 150;
const RETRY_MS = 3000;

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
  refresh(): Promise<void>;
}

/** `/api/state`, kept current: the page listens to `/api/events` and fetches again, at most every 150 ms, when something changed. */
export function useAppState(): AppStateHandle {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [offline, setOffline] = useState(false);
  const asked = useRef(0);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
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

  // While the server cannot be reached, ask again every few seconds so the page recovers on its own.
  useEffect(() => {
    if (!offline) return;
    const timer = setInterval(() => void refresh(), RETRY_MS);
    return () => clearInterval(timer);
  }, [offline, refresh]);

  useEffect(() => {
    if (!loaded || locked || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), DEBOUNCE_MS);
    };
    // A broken stream is only "offline" if the server cannot be reached either; the browser reconnects by itself.
    const broken = () => void refresh();
    // When the stream comes back after a break, catch up on what was missed (the first open needs nothing: state is already fetched).
    let opened = false;
    const open = () => {
      if (opened) changed();
      opened = true;
    };
    source.addEventListener('changed', changed);
    source.addEventListener('error', broken);
    source.addEventListener('open', open);
    return () => {
      clearTimeout(timer);
      source.removeEventListener('changed', changed);
      source.removeEventListener('error', broken);
      source.removeEventListener('open', open);
      source.close();
    };
  }, [loaded, locked, refresh]);

  return { state, loading, locked, offline, currentProject: pickCurrentProject(state), refresh };
}
