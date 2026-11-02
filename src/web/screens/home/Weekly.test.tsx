import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeeklyAnswer, WeeklyNote } from '../../../shared/types.js';
import { ApiError } from '../../api.js';
import { Weekly } from './Weekly.js';

const mocks = vi.hoisted(() => ({ weekly: vi.fn(), weeklySeen: vi.fn(), act: vi.fn() }));
vi.mock('../../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api.js')>()),
  api: { act: mocks.act },
  noteApi: { weekly: mocks.weekly, weeklySeen: mocks.weeklySeen },
}));

const NOTE: WeeklyNote = {
  title: 'Last week, in people',
  at: '2026-11-02T07:30:00.000Z',
  senderFirst: 'Gabriel',
  hellos: 42,
  replied: [
    { id: 1, first: 'Kemi', booked: true, name: 'Kemi Eze', company: 'Oko Pay', projectId: 1, text: 'Kemi replied on Tuesday and you sent your calendar link.', mail: 'Calendar link sent.' },
    { id: 2, first: 'Zainab', booked: false, name: 'Zainab Musa', company: 'Lagoon Pay', projectId: 1, text: 'Zainab replied on Wednesday. Your reply is waiting.', mail: 'Waiting on you.' },
  ],
  line: 'Callum said hello to 42 people. 6 replied and 2 calls are booked.',
  warming: [{ id: 5, first: 'Chidi', projectId: 1, text: 'Chidi accepted your LinkedIn invite. A follow-up goes out tomorrow at 11:00.' }],
  resting: { count: 9, backOn: '16 November' },
  suggestion: {
    text: "Kemi's colleagues look like a good fit. Find 10 more like Kemi?",
    action: { kind: 'find_more', label: 'Find 10 more like Kemi', args: { likePersonId: 1, query: null, count: 10 } },
    projectId: 1,
  },
  nextAt: '2026-11-09T07:30:00.000Z',
  groups: [],
};

function answer(over: Partial<WeeklyAnswer> = {}, note: Partial<WeeklyNote> = {}): WeeklyAnswer {
  return {
    note: { ...NOTE, ...note },
    email: { subject: 'Your week: 6 replies, 2 calls booked', text: 'Morning Gabriel,\n\nCallum said hello to 42 people.' },
    shouldOpen: false,
    ...over,
  };
}

const view = (props: Partial<React.ComponentProps<typeof Weekly>> = {}) => render(<Weekly tz="Africa/Lagos" {...props} />);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.weeklySeen.mockResolvedValue({ seenAt: '2026-11-02T07:31:00.000Z' });
});

describe('Weekly', () => {
  it('opens by itself on the first visit after Monday 8:30, and says it has been seen', async () => {
    mocks.weekly.mockResolvedValue(answer({ shouldOpen: true }));
    view();
    const dialog = await screen.findByRole('dialog', { name: 'Last week, in people' });
    expect(within(dialog).getByText('Monday 2 November, 8:30')).toBeInTheDocument();
    expect(within(dialog).getByText('Callum said hello to 42 people. 6 replied and 2 calls are booked.')).toBeInTheDocument();
    expect(within(dialog).getByText('9 people, back on 16 November')).toBeInTheDocument();
    expect(within(dialog).getByText('Next note Monday 9 November, 8:30')).toBeInTheDocument();
    expect(mocks.weeklySeen).toHaveBeenCalledTimes(1);
  });

  it('stays closed on a later visit and opens from Your week, in people', async () => {
    mocks.weekly.mockResolvedValue(answer());
    view();
    const open = await screen.findByRole('button', { name: 'Your week, in people' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(open);
    expect(screen.getByRole('dialog', { name: 'Last week, in people' })).toBeInTheDocument();
  });

  it('closes with the button or Escape and hands focus back', async () => {
    mocks.weekly.mockResolvedValue(answer());
    view();
    const open = await screen.findByRole('button', { name: 'Your week, in people' });
    await userEvent.click(open);
    await userEvent.click(screen.getByRole('button', { name: 'Close the note' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(open).toHaveFocus();
    await userEvent.click(open);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows nothing when the week was empty or the note cannot be read', async () => {
    mocks.weekly.mockResolvedValue(answer({}, { hellos: 0, replied: [] }));
    const { container, unmount } = view();
    await waitFor(() => expect(mocks.weekly).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    mocks.weekly.mockRejectedValue(new ApiError(0, "Callum can't be reached."));
    const again = view();
    await waitFor(() => expect(mocks.weekly).toHaveBeenCalledTimes(2));
    expect(again.container).toBeEmptyDOMElement();
  });

  it('says more about a face when it is picked, and opens that person', async () => {
    mocks.weekly.mockResolvedValue(answer({ shouldOpen: true }));
    const onOpenPerson = vi.fn();
    view({ onOpenPerson });
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Zainab Musa, Lagoon Pay, replied' }));
    expect(within(dialog).getByText('Zainab replied on Wednesday. Your reply is waiting.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open Zainab' }));
    expect(onOpenPerson).toHaveBeenCalledWith(2);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chidi, warming up' }));
    expect(within(dialog).getByText(/Chidi accepted your LinkedIn invite/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Kemi Eze, Oko Pay, call booked' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the plain email beside the note', async () => {
    mocks.weekly.mockResolvedValue(answer({ shouldOpen: true }));
    view();
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'See it as email' }));
    const mail = screen.getByRole('region', { name: 'The same note as an email' });
    expect(within(mail).getByRole('heading', { name: 'Your week: 6 replies, 2 calls booked' })).toBeInTheDocument();
    expect(mail).toHaveTextContent('Morning Gabriel,');
    await userEvent.click(screen.getByRole('button', { name: 'Hide the email' }));
    expect(screen.queryByRole('region', { name: 'The same note as an email' })).not.toBeInTheDocument();
  });

  it('finds more people like the one who replied and says what happened', async () => {
    mocks.weekly.mockResolvedValue(answer({ shouldOpen: true }));
    mocks.act.mockResolvedValue({ text: 'Added 10 people. They start as strangers.', personIds: [], action: null });
    const onChanged = vi.fn();
    view({ onChanged });
    await screen.findByRole('dialog');
    expect(screen.getByText("Kemi's colleagues look like a good fit. Find 10 more like Kemi?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Find 10 more' }));
    expect(await screen.findByText('Added 10 people. They start as strangers.')).toBeInTheDocument();
    expect(mocks.act).toHaveBeenCalledWith(NOTE.suggestion?.action, 1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('says why when it could not find people, and lets the person try again', async () => {
    mocks.weekly.mockResolvedValue(answer({ shouldOpen: true }));
    mocks.act.mockRejectedValue(new ApiError(422, 'Callum needs a list for that. Bring a CSV or a LinkedIn search link.'));
    view();
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Find 10 more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Callum needs a list for that.');
    expect(screen.getByRole('button', { name: 'Find 10 more' })).toBeInTheDocument();
  });

  it('asks again next Monday when the person says not now', async () => {
    mocks.weekly.mockResolvedValue(answer({ shouldOpen: true }));
    view();
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.getByText('Okay. Callum will ask again next Monday.')).toBeInTheDocument();
    expect(mocks.act).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Find them now' }));
    expect(screen.getByRole('button', { name: 'Find 10 more' })).toBeInTheDocument();
  });

  it('groups by project when there is more than one, with one suggestion', async () => {
    const group = (projectId: number, name: string, line: string, first: string) => ({
      projectId, name, line,
      replied: [{ id: projectId * 10, first, booked: false, name: `${first} Test`, company: null, projectId, text: `${first} replied on Tuesday.`, mail: 'Replied.' }],
      warming: [], resting: { count: 0, backOn: null },
    });
    mocks.weekly.mockResolvedValue(answer({ shouldOpen: true }, {
      groups: [
        group(1, 'Reconciliation', 'Callum said hello to 30 people. 3 replied and 2 calls are booked.', 'Kemi'),
        group(2, 'Payroll', 'Callum said hello to 12 people. 1 replied and 0 calls are booked.', 'Yaw'),
      ],
    }));
    view();
    const dialog = await screen.findByRole('dialog');
    const reconciliation = within(dialog).getByRole('region', { name: 'Reconciliation' });
    expect(within(reconciliation).getByText('Callum said hello to 30 people. 3 replied and 2 calls are booked.')).toBeInTheDocument();
    expect(within(reconciliation).getByRole('button', { name: 'Kemi Test, replied' })).toBeInTheDocument();
    const payroll = within(dialog).getByRole('region', { name: 'Payroll' });
    expect(within(payroll).getByText('Callum said hello to 12 people. 1 replied and 0 calls are booked.')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: /^Find \d+ more$/ })).toHaveLength(1);
    await userEvent.click(within(payroll).getByRole('button', { name: 'Yaw Test, replied' }));
    expect(within(payroll).getByText('Yaw replied on Tuesday.')).toBeInTheDocument();
  });
});
