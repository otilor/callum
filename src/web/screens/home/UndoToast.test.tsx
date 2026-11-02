import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undoMsLeft, useUndoToasts, type UndoToasts } from './UndoToast.js';

let toasts: UndoToasts;
function Harness() {
  toasts = useUndoToasts();
  return toasts.node;
}

const ok = () => Promise.resolve('Not sent.');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useUndoToasts: stacked sends', () => {
  it('keeps every send on screen with its own Undo, and none is dropped by a newer one', () => {
    render(<Harness />);
    act(() => {
      toasts.pending({ text: 'Sending your reply to Kemi', onUndo: ok });
      toasts.pending({ text: 'Sending your reply to Femi', onUndo: ok });
    });
    expect(screen.getByText('Sending your reply to Kemi')).toBeInTheDocument();
    expect(screen.getByText('Sending your reply to Femi')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(2);
    expect(document.querySelectorAll('.undo-ring')).toHaveLength(2);
  });

  it('lets the older send run out on its own clock while the newer one keeps going', () => {
    render(<Harness />);
    act(() => {
      toasts.pending({ text: 'First', ms: 4000, onUndo: ok });
    });
    act(() => {
      vi.advanceTimersByTime(3000);
      toasts.pending({ text: 'Second', ms: 4000, onUndo: ok });
    });
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByText('First')).not.toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
  });

  it('takes back only the send whose Undo was pressed', async () => {
    const first = vi.fn(ok);
    const second = vi.fn(ok);
    render(<Harness />);
    act(() => {
      toasts.pending({ text: 'First', onUndo: first });
      toasts.pending({ text: 'Second', onUndo: second });
    });
    const row = screen.getByText('Second').closest('.undo-toast') as HTMLElement;
    await act(async () => {
      within(row).getByRole('button', { name: 'Undo' }).click();
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Not sent.')).toBeInTheDocument();
  });

  it('shows three at a time and brings a fourth in when a place opens, with its window already running', () => {
    render(<Harness />);
    act(() => {
      toasts.pending({ text: 'One', ms: 3000, onUndo: ok });
      vi.advanceTimersByTime(500);
      toasts.pending({ text: 'Two', ms: 10_000, onUndo: ok });
      toasts.pending({ text: 'Three', ms: 10_000, onUndo: ok });
      toasts.pending({ text: 'Four', ms: 10_000, onUndo: ok });
    });
    expect(screen.queryByText('Four')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(3);
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText('Four')).toBeInTheDocument();
    // It waited about 3 seconds of its 10, so the ring starts that far in.
    const ring = screen.getByText('Four').closest('.undo-toast')!.querySelector<SVGCircleElement>('.undo-ring')!;
    expect(parseFloat(ring.style.animationDelay)).toBeLessThan(-2000);
  });

  it('says what happened once a send has gone, and says so when Undo comes too late', async () => {
    render(<Harness />);
    act(() => {
      toasts.pending({ text: 'Sending', ms: 1000, doneText: 'Sent to Kemi', onUndo: ok });
    });
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText('Sent to Kemi')).toBeInTheDocument();

    act(() => {
      toasts.pending({ text: 'Sending again', failText: 'Too late. Your calendar link already went to Femi.', onUndo: () => Promise.reject(new Error('gone')) });
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Undo' }).click();
    });
    expect(screen.getByText('Too late. Your calendar link already went to Femi.')).toBeInTheDocument();
  });

  it('holds a plain line back while a send can still be undone', () => {
    render(<Harness />);
    act(() => {
      toasts.pending({ text: 'Sending', ms: 2000, onUndo: ok });
      toasts.info('Kemi replied');
    });
    expect(screen.queryByText('Kemi replied')).not.toBeInTheDocument();
    expect(toasts.undoing).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText('Kemi replied')).toBeInTheDocument();
  });
});

describe('undoMsLeft', () => {
  const item = (over: object = {}) => ({ undoUntil: '2026-11-02T10:00:10.000Z', updatedAt: '2026-11-02T10:00:00.000Z', createdAt: '2026-11-02T09:59:00.000Z', ...over });

  it('is the window the server gave, by its own clock, less what the call took', () => {
    vi.spyOn(performance, 'now').mockReturnValue(2500);
    expect(undoMsLeft(item(), 1000)).toBe(8500);
    expect(undoMsLeft(item({ undoUntil: '2026-11-02T10:00:04.000Z' }), 1000)).toBe(2500);
    vi.restoreAllMocks();
  });

  it('is nothing when the window is shut or there never was one', () => {
    vi.spyOn(performance, 'now').mockReturnValue(20_000);
    expect(undoMsLeft(item(), 0)).toBe(0);
    expect(undoMsLeft(item({ undoUntil: null }), 0)).toBe(0);
    vi.restoreAllMocks();
  });
});
