import { render, screen } from '@testing-library/react';
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
});
