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
    settings: { senderName: null, senderEmail: null, timezone: 'UTC', onboarded: true, currentProjectId, pauseState: 'running', pausedUntil: null, notifications: null },
    projects, channels: [], people: [], outbox: [], incidents: [], demo: false,
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], nextSendAt: null, line: '' },
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

  it('closes the stream when the page goes away', async () => {
    mocks.state.mockResolvedValue(appState([project(1)]));
    const { result, unmount } = renderHook(() => useAppState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    const source = FakeEventSource.last;
    unmount();
    expect(source?.closed).toBe(true);
  });
});
