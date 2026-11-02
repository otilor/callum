import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneToast } from './PhoneToast.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PhoneToast', () => {
  it('says what is happening while Undo works, then what happened once the window closes', () => {
    const onGone = vi.fn();
    render(<PhoneToast toast={{ id: 1, text: 'Sending your reply to Kemi', then: 'Sent to Kemi', undo: { ms: 5000, run: vi.fn() } }} onGone={onGone} />);
    expect(screen.getByText('Sending your reply to Kemi')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5100);
    });
    expect(screen.getByText('Sent to Kemi')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(onGone).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onGone).toHaveBeenCalledWith(1);
  });

  it('goes away with the Undo window when there is nothing more to say', () => {
    const onGone = vi.fn();
    render(<PhoneToast toast={{ id: 2, text: 'Sending', undo: { ms: 4000, run: vi.fn() } }} onGone={onGone} />);
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(onGone).toHaveBeenCalledWith(2);
  });
});
