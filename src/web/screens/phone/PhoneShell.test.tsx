import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState, NOW, person } from '../../test/phoneLeaveFixtures.js';
import { ToastProvider } from '../../ui/Toast.js';
import { PhoneShell } from './PhoneShell.js';

const mocks = vi.hoisted(() => ({ person: vi.fn(), draft: vi.fn() }));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const refresh = vi.fn(() => Promise.resolve());
const tunde = () => person(5, 'Tunde', { stage: 'following', touches: 1, nextTouchAt: '2026-11-04T08:00:00.000Z' });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  refresh.mockClear();
  mocks.person.mockResolvedValue({ person: tunde(), messages: [], path: [] });
});

function show(props: Partial<React.ComponentProps<typeof PhoneShell>> = {}) {
  const state = appState({ people: [person(1, 'Kemi', { stage: 'hello' }), tunde()] });
  return render(
    <ToastProvider>
      <PhoneShell state={state} project={state.projects[0] ?? null} refresh={refresh} onReconnect={vi.fn()} onOpenSettings={vi.fn()} onLeave={vi.fn()} now={() => NOW} {...props} />
    </ToastProvider>,
  );
}

describe('PhoneShell', () => {
  it('draws the river as tall as the strip that holds it, so no face is cut off', () => {
    const { container } = show();
    expect(container.querySelector<HTMLElement>('.river-field')?.style.height).toBe('108px');
  });

  it('opens a person from their face in the river', async () => {
    const user = userEvent.setup();
    show();
    const river = screen.getByRole('group', { name: 'Your river' });
    await user.click(within(river).getByRole('button', { name: /Tunde Eze/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Tunde Eze' });
    expect(sheet).toBeInTheDocument();
    expect(mocks.person).toHaveBeenCalledWith(5);
  });

  it('shows the Day one banner when asked, and opens Day one from it', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    show({ dayOne: { left: 6, onOpen } });
    expect(screen.getByText('6 of 10 hellos left to OK in Reconciliation')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK the hellos' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
