import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMediaQuery } from './useMediaQuery.js';

const realMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

function fake(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      for (const fn of listeners) fn();
    },
    listeners,
  };
}

describe('useMediaQuery', () => {
  it('answers for the window now and follows it as it changes', () => {
    const win = fake(true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 720px)'));
    expect(result.current).toBe(true);
    act(() => win.set(false));
    expect(result.current).toBe(false);
  });

  it('lets go of the listener when the page is done with it', () => {
    const win = fake(false);
    const { unmount } = renderHook(() => useMediaQuery('(max-width: 720px)'));
    expect(win.listeners.size).toBe(1);
    unmount();
    expect(win.listeners.size).toBe(0);
  });

  it('is false where the browser cannot say', () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    const { result } = renderHook(() => useMediaQuery('(max-width: 720px)'));
    expect(result.current).toBe(false);
    vi.restoreAllMocks();
  });
});
