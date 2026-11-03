import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast.js';

function Fire({ withAction = false, onAction = () => {} }: { withAction?: boolean; onAction?: () => void }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast('Sent to Kemi', withAction ? { action: { label: 'Undo', onAction } } : undefined)}>
      Fire
    </button>
  );
}

afterEach(() => vi.useRealTimers());

describe('Toast', () => {
  it('shows the text politely and lets it go after a few seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    render(<ToastProvider><Fire /></ToastProvider>);
    await user.click(screen.getByRole('button', { name: 'Fire' }));
    expect(screen.getByRole('status')).toHaveTextContent('Sent to Kemi');
    act(() => {
      vi.advanceTimersByTime(3300);
    });
    expect(screen.queryByText('Sent to Kemi')).not.toBeInTheDocument();
  });

  it('runs the action and closes', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<ToastProvider><Fire withAction onAction={onAction} /></ToastProvider>);
    await user.click(screen.getByRole('button', { name: 'Fire' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Sent to Kemi')).not.toBeInTheDocument();
  });

  it('refuses to be used without a provider, so a message is never lost silently', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Fire />)).toThrow('useToast needs a ToastProvider above it');
    spy.mockRestore();
  });
});
