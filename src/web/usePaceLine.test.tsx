import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import { paceLineOf, usePaceLines } from './usePaceLine.js';

const mocks = vi.hoisted(() => ({ channelSummary: vi.fn() }));
vi.mock('./api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api.js')>()), api: mocks }));

beforeEach(() => mocks.channelSummary.mockReset());

describe('paceLineOf', () => {
  it('prefers the server line and falls back when there is none', () => {
    expect(paceLineOf({ paceLine: '20 a day now, 70 from next week' }, 'x')).toBe('20 a day now, 70 from next week');
    expect(paceLineOf({ paceLine: ' ' }, 'fallback')).toBe('fallback');
    expect(paceLineOf(null, 'fallback')).toBe('fallback');
  });
});

describe('usePaceLines', () => {
  it('reads each channel and leaves out the ones that cannot be read', async () => {
    mocks.channelSummary.mockImplementation(async (ch: string) => {
      if (ch === 'x') throw new ApiError(0, 'down');
      return { pending: { invites: 0, followUps: 0, emails: 0, messages: 0 }, paceLine: `${ch} line` };
    });
    const { result } = renderHook(() => usePaceLines(['email', 'x']));
    await waitFor(() => expect(result.current).toEqual({ email: 'email line' }));
  });
});
