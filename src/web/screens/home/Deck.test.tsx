import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxItem, Person, Project } from '../../../shared/types.js';
import { Deck } from './Deck.js';
import { useUndoToasts } from './UndoToast.js';

const mocks = vi.hoisted(() => ({
  reply: vi.fn(), book: vi.fn(), close: vi.fn(), snooze: vi.fn(), undo: vi.fn(), correct: vi.fn(), draft: vi.fn(), updateProject: vi.fn(),
}));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const NOW = new Date('2026-11-02T10:00:00Z');

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1, name: 'Reconciliation', offer: null, audience: null, tone: 'warm', sample: null, calendarUrl: 'https://cal.com/gabriel',
    approvalsLeft: 0, startedAt: null, state: 'running', pausedUntil: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over,
  };
}

function waiting(id: number, name: string, over: Partial<Person> = {}): Person {
  return {
    id, projectId: 1, name, firstName: name.split(' ')[0] ?? name, company: 'Oko Pay', role: 'Founder', email: `p${id}@okopay.com`, linkedinUrl: null, xHandle: null,
    timezone: null, channel: 'email', stage: 'talking', status: 'waiting', touches: 1, lastTouchAt: null, nextTouchAt: null, linkedinState: 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: 'interested', suggested: 'reply',
    draft: "Thanks Kemi, glad the timing works. I'll send a short deck tonight.", lastInbound: "This is timely. We're rebuilding our month-end close in December.",
    repliedAt: '2026-11-02T07:40:00Z', source: 'paste', note: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...over,
  };
}

function sent(id: number, over: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id, personId: 1, channel: 'email', kind: 'reply', subject: null, body: 'x', state: 'scheduled', origin: 'user', sendAfter: NOW.toISOString(),
    undoUntil: new Date(NOW.getTime() + 10_000).toISOString(), error: null, approvalCounted: false, claimedAt: null, detail: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over,
  };
}

const refresh = vi.fn(() => Promise.resolve());
const onClose = vi.fn();

function Harness({ people, projects = [project()], startAt }: { people: Person[]; projects?: Project[]; startAt?: number }) {
  const toasts = useUndoToasts();
  return (
    <>
      <Deck people={people} projects={projects} tz="Africa/Lagos" now={() => NOW} startAt={startAt} toasts={toasts} refresh={refresh} onClose={onClose} />
      {toasts.node}
    </>
  );
}

const kemi = () => waiting(1, 'Kemi Eze');
const femi = () => waiting(2, 'Femi Adeyemi', {
  lastInbound: 'What does pricing look like for a team of six?',
  draft: "Hi Femi, for a team of six it's [YOUR PRICE] a month, and setup is included. Want a two-minute walkthrough video first?",
  repliedAt: '2026-11-01T17:20:00Z',
});

beforeEach(() => {
  mocks.reply.mockResolvedValue(sent(50));
  mocks.book.mockResolvedValue(sent(51, { kind: 'booking' }));
  mocks.close.mockResolvedValue(sent(52, { kind: 'close' }));
  mocks.snooze.mockResolvedValue({ ...kemi(), status: 'snoozed', snoozedUntil: '2026-11-09T08:00:00Z' });
  mocks.undo.mockResolvedValue(sent(50, { state: 'cancelled' }));
  mocks.correct.mockResolvedValue(kemi());
  mocks.draft.mockResolvedValue({ body: 'A fresh draft for you.' });
  mocks.updateProject.mockResolvedValue(project());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Deck', () => {
  it("shows the person's message, Callum's draft and the way the reply goes", () => {
    render(<Harness people={[kemi()]} />);
    const card = screen.getByRole('article', { name: 'Reply from Kemi Eze' });
    expect(within(card).getByRole('heading', { name: 'Kemi Eze' })).toBeInTheDocument();
    expect(within(card).getByText('Founder at Oko Pay')).toBeInTheDocument();
    expect(within(card).getByText(/This is timely\./)).toBeInTheDocument();
    expect(within(card).getByText('Reply goes by email')).toBeInTheDocument();
    expect(within(card).getByRole('textbox', { name: 'Your reply to Kemi' })).toHaveValue("Thanks Kemi, glad the timing works. I'll send a short deck tonight.");
    expect(within(card).getByText("Callum's draft, in your warm voice")).toBeInTheDocument();
  });

  it('rings the suggested action only', () => {
    render(<Harness people={[kemi()]} />);
    expect(screen.getByRole('button', { name: 'Reply' })).toHaveClass('is-suggested');
    for (const name of ['Close politely', 'Snooze', 'Book a call']) expect(screen.getByRole('button', { name })).not.toHaveClass('is-suggested');
    expect(screen.getByText('Suggested: reply. Callum drafted it.')).toBeInTheDocument();
  });

  it('moves the ring to Book a call when that is what Callum suggests', () => {
    render(<Harness people={[waiting(1, 'Kemi Eze', { suggested: 'book' })]} />);
    expect(screen.getByRole('button', { name: 'Book a call' })).toHaveClass('is-suggested');
    expect(screen.getByRole('button', { name: 'Reply' })).not.toHaveClass('is-suggested');
  });

  it('sends the edited draft and shows the undo toast', async () => {
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} />);
    const box = screen.getByRole('textbox', { name: 'Your reply to Kemi' });
    await user.clear(box);
    await user.type(box, 'Tuesday works.');
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledWith(1, 'Tuesday works.'));
    expect(await screen.findByText('Sending your reply to Kemi')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('takes a reply back with Undo', async () => {
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} />);
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mocks.undo).toHaveBeenCalledWith(50));
    expect(await screen.findByText('Not sent. Your reply to Kemi is back.')).toBeInTheDocument();
    // The card is back, because the person is still waiting.
    expect(await screen.findByRole('article', { name: 'Reply from Kemi Eze' })).toBeInTheDocument();
  });

  it('says so when Undo comes too late, and keeps the card gone', async () => {
    mocks.undo.mockRejectedValue(new Error('Already sent'));
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} />);
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mocks.undo).toHaveBeenCalledWith(50));
    expect(await screen.findByText('Too late. Your reply already went to Kemi.')).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Reply from Kemi Eze' })).not.toBeInTheDocument();
  });

  it('puts the cursor on the name when a card arrives, and on the next card after an answer', async () => {
    const user = userEvent.setup();
    render(<Harness people={[kemi(), femi()]} />);
    expect(screen.getByRole('heading', { name: 'Kemi Eze' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Snooze' }));
    expect(await screen.findByRole('heading', { name: 'Femi Adeyemi' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Femi Adeyemi' })).toHaveFocus());
  });

  it('keeps Reply off for an empty draft and says to write a few words', async () => {
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} />);
    await user.clear(screen.getByRole('textbox', { name: 'Your reply to Kemi' }));
    expect(screen.getByText('Write a few words first.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it('says plainly when Callum could not write a draft', async () => {
    mocks.draft.mockRejectedValue(new Error('offline'));
    render(<Harness people={[waiting(1, 'Kemi Eze', { draft: null })]} />);
    expect(await screen.findByText("Callum couldn't write a draft. Write your own.")).toBeInTheDocument();
  });

  it('closes the menu on Escape before it closes the deck', async () => {
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} />);
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('turns Reply off while the draft holds a placeholder, and says why', async () => {
    const user = userEvent.setup();
    render(<Harness people={[femi()]} />);
    expect(screen.getByText('Add your price first. Callum never sends a message with [YOUR PRICE] in it.')).toBeInTheDocument();
    const reply = screen.getByRole('button', { name: 'Reply' });
    expect(reply).toHaveAttribute('aria-disabled', 'true');
    await user.click(reply);
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it('highlights the placeholder inside the draft', () => {
    const { container } = render(<Harness people={[femi()]} />);
    expect(container.querySelector('mark.draft-hole')).toHaveTextContent('[YOUR PRICE]');
  });

  it('leaves the price out with one tap and lets the reply go', async () => {
    const user = userEvent.setup();
    render(<Harness people={[femi()]} />);
    await user.click(screen.getByRole('button', { name: 'Leave the price out' }));
    expect(screen.getByRole('textbox', { name: 'Your reply to Femi' })).toHaveValue('Want a two-minute walkthrough video first?');
    expect(screen.queryByText(/Callum never sends a message/)).not.toBeInTheDocument();
    const reply = screen.getByRole('button', { name: 'Reply' });
    expect(reply).not.toHaveAttribute('aria-disabled');
    await user.click(reply);
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledWith(2, 'Want a two-minute walkthrough video first?'));
  });

  it('says why Book a call is off without a calendar link, and saves one inline', async () => {
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} projects={[project({ calendarUrl: null })]} />);
    expect(screen.getByText('Add your calendar link first')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Book a call' }));
    expect(mocks.book).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Calendar link'), 'not a link');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That does not look like a link');
    await user.clear(screen.getByLabelText('Calendar link'));
    await user.type(screen.getByLabelText('Calendar link'), 'https://cal.com/gabriel');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalledWith(1, { calendarUrl: 'https://cal.com/gabriel' }));
    await waitFor(() => expect(screen.queryByText('Add your calendar link first')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Book a call' }));
    await waitFor(() => expect(mocks.book).toHaveBeenCalledWith(1));
  });

  it('books a call and says the link is on its way', async () => {
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} />);
    await user.click(screen.getByRole('button', { name: 'Book a call' }));
    await waitFor(() => expect(mocks.book).toHaveBeenCalledWith(1));
    expect(await screen.findByText('Sending Kemi your calendar link')).toBeInTheDocument();
  });

  it('snoozes and says when the person comes back', async () => {
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} />);
    await user.click(screen.getByRole('button', { name: 'Snooze' }));
    await waitFor(() => expect(mocks.snooze).toHaveBeenCalledWith(1));
    expect(await screen.findByText('Kemi comes back on Monday')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All caught up' })).toBeInTheDocument();
  });

  it('closes politely', async () => {
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} />);
    await user.click(screen.getByRole('button', { name: 'Close politely' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledWith(1));
    expect(await screen.findByText('Thanking Kemi. No more follow-ups.')).toBeInTheDocument();
  });

  it('corrects from the menu', async () => {
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} />);
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'Never contact' }));
    await waitFor(() => expect(mocks.correct).toHaveBeenCalledWith(1, 'never_contact'));
    expect(await screen.findByText("Callum won't contact Kemi again")).toBeInTheDocument();
  });

  it('offers all three corrections', async () => {
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} />);
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: "That's an auto-reply" }));
    await waitFor(() => expect(mocks.correct).toHaveBeenCalledWith(1, 'auto_reply'));
  });

  it('shows what went wrong and keeps the card when a send fails', async () => {
    mocks.reply.mockRejectedValueOnce(new Error('Gmail did not accept the message.'));
    const user = userEvent.setup();
    render(<Harness people={[kemi()]} />);
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    expect(await screen.findByText('Gmail did not accept the message.')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Reply from Kemi Eze' })).toBeInTheDocument();
  });

  it('asks Callum for a draft when there is none', async () => {
    render(<Harness people={[waiting(1, 'Kemi Eze', { draft: null })]} />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Your reply to Kemi' })).toHaveValue('A fresh draft for you.'));
    expect(mocks.draft).toHaveBeenCalledWith(1, 'reply');
  });

  it('goes through the oldest reply first, or the one that was tapped', () => {
    const { unmount } = render(<Harness people={[femi(), kemi()]} />);
    expect(screen.getByRole('article', { name: 'Reply from Femi Adeyemi' })).toBeInTheDocument();
    unmount();
    render(<Harness people={[femi(), kemi()]} startAt={1} />);
    expect(screen.getByRole('article', { name: 'Reply from Kemi Eze' })).toBeInTheDocument();
  });

  it('moves to the next card after one is answered', async () => {
    const user = userEvent.setup();
    render(<Harness people={[femi(), kemi()]} />);
    // Femi replied first, so hers is the first card.
    await user.click(screen.getByRole('button', { name: 'Leave the price out' }));
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    expect(await screen.findByRole('article', { name: 'Reply from Kemi Eze' })).toBeInTheDocument();
  });

  it('names the project only when there is more than one', () => {
    const { unmount } = render(<Harness people={[kemi()]} />);
    expect(screen.queryByText('Reconciliation')).not.toBeInTheDocument();
    unmount();
    render(<Harness people={[kemi()]} projects={[project(), project({ id: 2, name: 'Payroll' })]} />);
    expect(screen.getByText('Reconciliation')).toBeInTheDocument();
  });

  it('says all caught up when nobody waits, and goes back to the river', async () => {
    const user = userEvent.setup();
    render(<Harness people={[]} />);
    expect(screen.getByRole('heading', { name: 'All caught up' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the river' }));
    expect(onClose).toHaveBeenCalled();
  });
});
