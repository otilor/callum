import { describe, expect, it, vi } from 'vitest';
import { savedPort, startOnSavedPort } from './port.js';

describe('savedPort', () => {
  it('takes a real port and nothing else', () => {
    expect(savedPort(51234)).toBe(51234);
    for (const bad of [undefined, null, '4600', 0, 80, 70000, 4600.5, Number.NaN]) expect(savedPort(bad)).toBeNull();
  });
});

describe('startOnSavedPort', () => {
  it('tries the saved port first and keeps it', async () => {
    const start = vi.fn((port: number) => Promise.resolve({ port }));
    expect(await startOnSavedPort(start, 51234)).toEqual({ port: 51234 });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('asks for any free port when nothing was saved', async () => {
    const start = vi.fn((port: number) => Promise.resolve({ port }));
    expect(await startOnSavedPort(start, undefined)).toEqual({ port: 0 });
    expect(start.mock.calls).toEqual([[0]]);
  });

  it('falls back to a free port when the saved one is taken, and says so', async () => {
    const start = vi.fn((port: number) => (port === 51234 ? Promise.reject(new Error('listen EADDRINUSE')) : Promise.resolve({ port })));
    const log = vi.fn();
    expect(await startOnSavedPort(start, 51234, log)).toEqual({ port: 0 });
    expect(start.mock.calls).toEqual([[51234], [0]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('51234'));
  });

  it('does not hide a failure on port 0', async () => {
    await expect(startOnSavedPort(() => Promise.reject(new Error('disk full')), undefined)).rejects.toThrow('disk full');
  });
});
