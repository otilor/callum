import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Project } from '../shared/types.js';
import { ApiError } from './api.js';
import { pickCurrentProject, useAppState } from './useAppState.js';

const mocks = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock('./api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api.js')>()), api: mocks }));

class FakeEventSource {
  static last: FakeEventSource | null = null;
  closed = false;
  private listeners = new Map<string, Set<() => void>>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(fn));
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  has(type: string) {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  close() {
    this.closed = true;
  }
}

function project(id: number, over: Partial<Project> = {}): Project {
  return {
    id, name: `P${id}`, offer: null, audience: null, tone: 'warm', sample: null, calendarUrl: null, approvalsLeft: 10, startedAt: null,
    state: 'running', pausedUntil: null, createdAt: '2026-11-02T10:00:00.000Z', updatedAt: '2026-11-02T10:00:00.000Z', ...over,
  };
}

function appState(projects: Project[], currentProjectId: number | null = null): AppState {
  return {
    settings: { senderName: null, senderEmail: null, timezone: 'UTC', onboarded: true, currentProjectId, pauseState: 'running', pausedUntil: null, notifications: null, morningBrief: true },
    projects, channels: [], people: [], outbox: [], incidents: [], demo: false, canFind: false, claudeEngine: null, claudeConnected: false, auth: { password: false },
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], acceptedIds: [], nextSendAt: null, line: '' },
  };
}

beforeEach(() => {
  mocks.state.mockReset();
  FakeEventSource.last = null;
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pickCurrentProject', () => {
  it('prefers the project last viewed, then the first running one', () => {
    expect(pickCurrentProject(null)).toBeNull();
    expect(pickCurrentProject(appState([]))).toBeNull();
    expect(pickCurrentProject(appState([project(1), project(2)], 2))?.id).toBe(2);
    expect(pickCurrentProject(appState([project(1, { state: 'paused' }), project(2)], null))?.id).toBe(2);
    expect(pickCurrentProject(appState([project(1, { state: 'wrapped' })], 9))?.id).toBe(1);
  });
});

describe('useAppState', () => {
  it('loads state and exposes the current project', async () => {
    mocks.state.mockResolvedValue(appState([project(1), project(2)], 2));
    const { result } = renderHook(() => useAppState());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.loading).toBe(false);
    expect(result.current.currentProject?.id).toBe(2);
    expect(FakeEventSource.last?.url).toBe('/api/events');
  });

  it('is locked when the server answers 401, and says nothing about being offline', async () => {
    mocks.state.mockRejectedValue(new ApiError(401, 'Sign in first'));
    const { result } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.locked).toBe(true));
    expect(result.current.offline).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(FakeEventSource.last).toBeNull();
  });

  it('fetches again once, 150 ms after a burst of changed events', async () => {
    mocks.state.mockResolvedValue(appState([project(1)]));
    const { result } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    vi.useFakeTimers();
    mocks.state.mockClear();
    act(() => {
      FakeEventSource.last?.emit('changed');
      FakeEventSource.last?.emit('changed');
      FakeEventSource.last?.emit('changed');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    expect(mocks.state).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(mocks.state).toHaveBeenCalledTimes(1);
  });

  it('goes offline when the stream breaks and the next fetch fails, and recovers when it answers', async () => {
    mocks.state.mockResolvedValue(appState([project(1)]));
    const { result } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    mocks.state.mockRejectedValueOnce(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    act(() => FakeEventSource.last?.emit('error'));
    await waitFor(() => expect(result.current.offline).toBe(true));
    expect(result.current.state).not.toBeNull();
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.offline).toBe(false);
  });

  it('knows at once when the browser goes offline, and looks again when it is back', async () => {
    mocks.state.mockResolvedValue(appState([project(1)]));
    const { result } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current.offline).toBe(true);
    mocks.state.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(mocks.state).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.offline).toBe(false));
  });

  it('looks again when any call gets no answer at all', async () => {
    mocks.state.mockResolvedValue(appState([project(1)]));
    const { result } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    mocks.state.mockClear();
    mocks.state.mockRejectedValueOnce(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    // A button pressed while the server is gone: the request itself fails with status 0.
    const real = await vi.importActual<typeof import('./api.js')>('./api.js');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(real.api.nudge(3)).rejects.toMatchObject({ status: 0 });
    vi.unstubAllGlobals();
    vi.stubGlobal('EventSource', FakeEventSource);
    await waitFor(() => expect(mocks.state).toHaveBeenCalled());
    await waitFor(() => expect(result.current.offline).toBe(true));
  });

  describe('the stream watchdog', () => {
    async function open() {
      mocks.state.mockResolvedValue(appState([project(1)]));
      const hook = renderHook(() => useAppState());
      await waitFor(() => expect(hook.result.current.state).not.toBeNull());
      vi.useFakeTimers();
      // The watchdog was armed under real timers; a ping re-arms it under the fake ones.
      act(() => FakeEventSource.last?.emit('ping'));
      return hook;
    }

    it('opens the stream again when nothing is heard for twice the ping interval', async () => {
      await open();
      const first = FakeEventSource.last;
      mocks.state.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(49_000);
      });
      expect(FakeEventSource.last).toBe(first);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(first?.closed).toBe(true);
      expect(FakeEventSource.last).not.toBe(first);
      expect(FakeEventSource.last?.closed).toBe(false);
      // It also catches up on whatever was missed.
      expect(mocks.state).toHaveBeenCalled();
    });

    it('stays quiet while the server keeps pinging', async () => {
      await open();
      const first = FakeEventSource.last;
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(25_000);
          first?.emit('ping');
        });
      }
      expect(FakeEventSource.last).toBe(first);
      expect(first?.closed).toBe(false);
    });
  });

  it('closes the stream when the page goes away', async () => {
    mocks.state.mockResolvedValue(appState([project(1)]));
    const { result, unmount } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    const source = FakeEventSource.last;
    unmount();
    expect(source?.closed).toBe(true);
  });
});
