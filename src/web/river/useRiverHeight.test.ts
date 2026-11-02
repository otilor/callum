import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RIVER_MAX, RIVER_MIN, riverHeightFor, useRiverHeight } from './useRiverHeight.js';

describe('riverHeightFor', () => {
  it('is min(280, window height - 560), so the Ask bar stays on the screen', () => {
    expect(riverHeightFor(1440)).toBe(RIVER_MAX);
    expect(riverHeightFor(840)).toBe(280);
    expect(riverHeightFor(768)).toBe(208);
    expect(riverHeightFor(720)).toBe(160);
  });

  it('takes off the padding a desktop window puts above the page', () => {
    expect(riverHeightFor(840, 28)).toBe(252);
  });

  it('never gets so small that faces have no room', () => {
    expect(riverHeightFor(500)).toBe(RIVER_MIN);
  });
});

describe('useRiverHeight', () => {
  afterEach(() => vi.restoreAllMocks());

  it('follows the window as it is resized', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768);
    const { result } = renderHook(() => useRiverHeight());
    expect(result.current).toBe(208);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe(RIVER_MAX);
  });

  it('counts the top padding of the page body', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(840);
    document.body.style.paddingTop = '28px';
    const { result } = renderHook(() => useRiverHeight());
    expect(result.current).toBe(252);
    document.body.style.paddingTop = '';
  });
});
