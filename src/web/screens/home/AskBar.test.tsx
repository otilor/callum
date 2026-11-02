import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Person, Project } from '../../../shared/types.js';
import { AskBar } from './AskBar.js';

const mocks = vi.hoisted(() => ({ ask: vi.fn(), act: vi.fn() }));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const AT = '2026-11-02T10:00:00.000Z';
const project: Project = {
  id: 7, name: 'Reconciliation', offer: null, audience: null, tone: 'warm', sample: null, calendarUrl: null, approvalsLeft: 0,
  startedAt: AT, state: 'running', pausedUntil: null, createdAt: AT, updatedAt: AT,
};
const kemi = { id: 1, projectId: 7, name: 'Kemi Eze', firstName: 'Kemi' } as Person;
const femi = { id: 2, projectId: 7, name: 'Femi Adeyemi', firstName: 'Femi' } as Person;

beforeEach(() => {
  mocks.ask.mockReset();
  mocks.act.mockReset();
});

describe('AskBar', () => {
  it('names the project in its placeholder', () => {
    render(<AskBar project={project} people={[]} />);
    expect(screen.getByPlaceholderText('Ask Callum about Reconciliation')).toBeInTheDocument();
  });

  it('blinks a caret only while the river is empty and the bar has no words', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<AskBar project={project} people={[]} />);
    expect(container.querySelector('.qm-caret')).toBeNull();
    rerender(<AskBar project={project} people={[]} caret />);
    expect(container.querySelector('.qm-caret')).not.toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Ask Callum' }), 'Find');
    expect(container.querySelector('.qm-caret')).toBeNull();
  });

  it('offers three chips on focus, the second named after the newest replier', async () => {
    const user = userEvent.setup();
    render(<AskBar project={project} people={[kemi]} likeName="Kemi" />);
    await user.click(screen.getByRole('textbox', { name: 'Ask Callum' }));
    expect(screen.getByRole('button', { name: "Who's warming up?" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find 20 more like Kemi' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause LinkedIn' })).toBeInTheDocument();
  });

  it('asks about the current project and shows the answer with faces and one action', async () => {
    mocks.ask.mockResolvedValue({
      text: 'LinkedIn is paused until Monday at 9:00. Email keeps going.',
      personIds: [1, 2],
      action: { kind: 'pause_channel', label: 'Pause LinkedIn', args: { channel: 'linkedin' } },
    });
    mocks.act.mockResolvedValue({ text: 'LinkedIn is paused.', personIds: [1], action: null });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<AskBar project={project} people={[kemi, femi]} onChanged={onChanged} />);

    await user.type(screen.getByRole('textbox', { name: 'Ask Callum' }), 'pause LinkedIn{Enter}');
    expect(mocks.ask).toHaveBeenCalledWith('pause LinkedIn', 7);
    const answer = await screen.findByRole('region', { name: "Callum's answer" });
    expect(answer).toHaveTextContent('pause LinkedIn');
    expect(await screen.findByText('LinkedIn is paused until Monday at 9:00. Email keeps going.')).toBeInTheDocument();
    expect(screen.getByText('Kemi')).toBeInTheDocument();
    expect(screen.getByText('Femi')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pause LinkedIn' }));
    expect(mocks.act).toHaveBeenCalledWith({ kind: 'pause_channel', label: 'Pause LinkedIn', args: { channel: 'linkedin' } }, 7);
    expect(await screen.findByText('LinkedIn is paused.')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Pause LinkedIn' })).not.toBeInTheDocument();
  });

  it('answers a chip tap, and says plainly when Callum could not', async () => {
    mocks.ask.mockRejectedValue(new Error('Callum could not read that. Try asking another way.'));
    const user = userEvent.setup();
    render(<AskBar project={project} people={[]} />);
    await user.click(screen.getByRole('textbox', { name: 'Ask Callum' }));
    await user.click(screen.getByRole('button', { name: "Who's warming up?" }));
    expect(mocks.ask).toHaveBeenCalledWith("Who's warming up?", 7);
    expect(await screen.findByRole('alert')).toHaveTextContent('Callum could not read that. Try asking another way.');
  });

  it('lets the keyboard reach a chip: Tab from the field, then Enter or Space', async () => {
    mocks.ask.mockResolvedValue({ text: 'Two people are warming up.', personIds: [], action: null });
    const user = userEvent.setup();
    const { unmount } = render(<AskBar project={project} people={[]} />);
    await user.click(screen.getByRole('textbox', { name: 'Ask Callum' }));
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: "Who's warming up?" })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(mocks.ask).toHaveBeenCalledWith("Who's warming up?", 7);
    await screen.findByText('Two people are warming up.');
    unmount();

    mocks.ask.mockClear();
    render(<AskBar project={project} people={[]} />);
    await user.click(screen.getByRole('textbox', { name: 'Ask Callum' }));
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: /Find 20 more/ })).toHaveFocus();
    await user.keyboard(' ');
    expect(mocks.ask).toHaveBeenCalledWith('Find 20 more people', 7);
  });

  it('closes the chips when focus leaves the bar', async () => {
    const user = userEvent.setup();
    render(
      <>
        <AskBar project={project} people={[]} />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.click(screen.getByRole('textbox', { name: 'Ask Callum' }));
    expect(screen.getByRole('button', { name: "Who's warming up?" })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: "Who's warming up?" })).not.toBeInTheDocument());
  });

  it('does nothing on an empty Enter', async () => {
    const user = userEvent.setup();
    render(<AskBar project={project} people={[]} />);
    await user.click(screen.getByRole('textbox', { name: 'Ask Callum' }));
    await user.keyboard('{Enter}');
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it('drops the result of an action when a newer question has replaced the answer', async () => {
    let finish: (a: unknown) => void = () => {};
    mocks.ask
      .mockResolvedValueOnce({ text: 'First answer.', personIds: [], action: { kind: 'pause_channel', label: 'Pause LinkedIn', args: { channel: 'linkedin' } } })
      .mockResolvedValueOnce({ text: 'Second answer.', personIds: [], action: null });
    mocks.act.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<AskBar project={project} people={[]} />);
    const box = screen.getByRole('textbox', { name: 'Ask Callum' });
    await user.type(box, 'one{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Pause LinkedIn' }));
    await user.type(box, 'two{Enter}');
    await screen.findByText('Second answer.');
    finish({ text: 'LinkedIn is paused.', personIds: [], action: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('LinkedIn is paused.')).not.toBeInTheDocument();
    expect(screen.getByText('Second answer.')).toBeInTheDocument();
  });
});
