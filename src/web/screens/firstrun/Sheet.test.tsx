import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet.js';

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button">Before</button>
      <button type="button" onClick={() => setOpen(true)}>Open it</button>
      <button type="button">After</button>
      {open ? (
        <Sheet
          label="Pick one"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <button type="button">First</button>
          <input aria-label="Middle" />
          <button type="button">Last</button>
        </Sheet>
      ) : null}
    </div>
  );
}

describe('Sheet', () => {
  it('is a labelled modal dialog and shuts the page behind it', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    expect(screen.getByRole('dialog', { name: 'Pick one' })).toHaveAttribute('aria-modal', 'true');
    expect(container).toHaveAttribute('inert');
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull();
  });

  it('keeps Tab and Shift+Tab inside the sheet', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    screen.getByRole('button', { name: 'First' }).focus();
    await user.tab();
    expect(screen.getByLabelText('Middle')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
  });

  it('closes on Escape from anywhere, frees the page and returns focus to the opener', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    await user.click(opener);
    screen.getByLabelText('Middle').focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container).not.toHaveAttribute('inert');
    expect(opener).toHaveFocus();
  });

  it('closes on a tap outside the card', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    await user.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
