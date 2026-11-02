import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Message, OutboxItem, Person, PersonFull, Project } from '../../../shared/types.js';
import { ApiError } from '../../api.js';
import { ToastProvider } from '../../ui/Toast.js';
import { PersonView } from './PersonView.js';

const mocks = vi.hoisted(() => ({
  personFull: vi.fn(),
  nudge: vi.fn(),
  hold: vi.fn(),
  resume: vi.fn(),
  correct: vi.fn(),
  reply: vi.fn(),
  undo: vi.fn(),
  wake: vi.fn(),
  rest: vi.fn(),
  switchChannel: vi.fn(),
  moveToProject: vi.fn(),
}));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const NOW = new Date('2026-11-02T10:00:00.000Z');
const now = () => NOW;
const FRIDAY = '2026-10-30T08:12:00.000Z';
const THURSDAY = '2026-11-05T08:00:00.000Z';

function project(id: number, name: string): Project {
  return {
    id, name, offer: null, audience: null, tone: 'warm', sample: null, calendarUrl: null, approvalsLeft: 0, startedAt: FRIDAY,
    state: 'running', pausedUntil: null, createdAt: FRIDAY, updatedAt: FRIDAY,
  };
}

function person(id: number, name: string, over: Partial<Person> = {}): Person {
  return {
    id, projectId: 1, name, firstName: name.split(' ')[0] ?? name, company: 'Marina Ledger', role: 'Co-founder', email: `p${id}@marinaledger.com`,
    linkedinUrl: null, xHandle: null, timezone: null, channel: 'email', stage: 'hello', status: 'active', touches: 1, lastTouchAt: FRIDAY,
    nextTouchAt: THURSDAY, linkedinState: 'none', invitedAt: null, snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null,
    draft: null, lastInbound: null, repliedAt: null, source: 'csv', note: null, createdAt: FRIDAY, updatedAt: FRIDAY,
    ...over,
  };
}

function message(id: number, direction: 'in' | 'out', kind: Message['kind'], body: string, at: string, over: Partial<Message> = {}): Message {
  return { id, personId: 1, channel: 'email', direction, kind, subject: null, body, at, externalId: null, ...over };
}

function full(p: Person, over: Partial<PersonFull> = {}): PersonFull {
  return {
    person: p,
    messages: [message(1, 'out', 'hello', 'Hi Chidi, would a quick chat be useful?', FRIDAY)],
    path: [
      { label: 'Hello', at: FRIDAY, done: true, state: 'done' },
      { label: 'Follow-up', at: THURSDAY, done: false, state: 'next' },
      { label: 'Last follow-up', at: null, done: false, state: 'later' },
    ],
    next: 'Follow-up goes out Thursday at 9:00 by email',
    why: "Callum picked email because Chidi's address is verified.",
    switchable: [{
      channel: 'linkedin', at: '2026-11-06T08:12:00.000Z', available: true,
      reason: 'Callum can switch Chidi to LinkedIn from Friday, a week after the last email.',
    }],
    projectMoves: [{ projectId: 2, name: 'Payroll', reason: "Chidi has already heard from you about Reconciliation. Callum can move them once they're resting." }],
    nudge: { ok: true, reason: null },
    closedNote: null,
    projectName: 'Reconciliation',
    ...over,
  };
}

function appState(people: Person[], over: Partial<AppState> = {}): AppState {
  return {
    settings: { senderName: 'Ada Obi', senderEmail: 'ada@example.com', timezone: 'Africa/Lagos', onboarded: true, currentProjectId: 1, pauseState: 'running', pausedUntil: null, notifications: null, morningBrief: true },
    projects: [project(1, 'Reconciliation'), project(2, 'Payroll')],
    channels: [],
    people,
    outbox: [],
    incidents: [],
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], nextSendAt: null, line: '' },
    demo: false, apolloConnected: false, claudeConnected: false,
    ...over,
  };
}

const CHIDI = person(1, 'Chidi Okeke');
const KEMI = person(2, 'Kemi Eze', { company: 'Oko Pay' });
const TUNDE = person(3, 'Tunde Bello', { company: 'Ireti Labs' });

function Harness({ state, id = 1, onBack = () => {}, onOpenSpy }: { state: AppState; id?: number; onBack?: () => void; onOpenSpy?: (id: number) => void }) {
  const [open, setOpen] = useState(id);
  return (
    <ToastProvider>
      <PersonView state={state} personId={open} now={now} onBack={onBack} onOpen={(next) => { onOpenSpy?.(next); setOpen(next); }} />
    </ToastProvider>
  );
}

async function show(detail: PersonFull, state?: AppState, props: Partial<Parameters<typeof Harness>[0]> = {}) {
  mocks.personFull.mockResolvedValue(detail);
  const view = render(<Harness state={state ?? appState([detail.person, KEMI, TUNDE])} id={detail.person.id} {...props} />);
  await screen.findByRole('heading', { level: 1, name: detail.person.name });
  return view;
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});

describe('the left column', () => {
  it('shows who, where they are, the path with exact times, what is next and why', async () => {
    await show(full(CHIDI));
    expect(screen.getByText('Co-founder at Marina Ledger')).toBeInTheDocument();
    const chips = screen.getByText('Said hello').parentElement!.parentElement!;
    expect(within(chips).getByText('p1@marinaledger.com')).toBeInTheDocument();
    expect(within(chips).getByTestId('project-chip')).toHaveTextContent('Reconciliation');
    const path = screen.getByRole('list', { name: 'The path so far' });
    expect(within(path).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'HelloFri 9:12', 'Follow-upThu 9:00', 'Last follow-up',
    ]);
    expect(screen.getByText('Follow-up goes out Thursday at 9:00 by email')).toBeInTheDocument();
    expect(screen.getByText("Callum picked email because Chidi's address is verified.")).toBeInTheDocument();
  });

  it('puts the reason beside an action that cannot be used', async () => {
    await show(full(CHIDI, { nudge: { ok: false, reason: "Nudge now works after the first hello. Chidi's goes today at 11:00." } }));
    const nudge = screen.getByRole('button', { name: 'Nudge now' });
    expect(nudge).toHaveAttribute('aria-disabled', 'true');
    expect(nudge).toHaveAccessibleDescription("Nudge now works after the first hello. Chidi's goes today at 11:00.");
    await userEvent.click(nudge);
    expect(mocks.nudge).not.toHaveBeenCalled();
  });

  it('nudges and says when the follow-up goes', async () => {
    mocks.nudge.mockResolvedValue(CHIDI);
    const view = await show(full(CHIDI));
    mocks.personFull.mockResolvedValue(full(CHIDI, { next: 'Follow-up goes out today at 11:00 by email' }));
    await userEvent.click(screen.getByRole('button', { name: 'Nudge now' }));
    expect(mocks.nudge).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Follow-up goes out today at 11:00 by email.')).toBeInTheDocument();
    view.unmount();
  });

  it('holds and resumes', async () => {
    mocks.hold.mockResolvedValue({ ...CHIDI, status: 'held' });
    await show(full(CHIDI));
    await userEvent.click(screen.getByRole('button', { name: 'Hold' }));
    expect(mocks.hold).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Holding Chidi. Nothing goes out until you resume.')).toBeInTheDocument();
  });

  it('shows Resume for someone on hold', async () => {
    mocks.resume.mockResolvedValue(CHIDI);
    await show(full({ ...CHIDI, status: 'held' }, { nudge: { ok: false, reason: 'Resume Chidi to nudge.' } }));
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.resume).toHaveBeenCalledWith(1);
  });

  it('moves to LinkedIn straight away when the link is known, and says when it starts', async () => {
    const known = { ...CHIDI, linkedinUrl: 'https://www.linkedin.com/in/chidi' };
    mocks.switchChannel.mockResolvedValue({ ...known, channel: 'linkedin', nextTouchAt: '2026-11-06T08:12:00.000Z' });
    await show(full(known));
    expect(screen.getByRole('button', { name: 'Move to LinkedIn' })).toHaveAccessibleDescription(
      'Callum can switch Chidi to LinkedIn from Friday, a week after the last email.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Move to LinkedIn' }));
    expect(mocks.switchChannel).toHaveBeenCalledWith(1, 'linkedin', undefined);
    expect(await screen.findByText('Chidi moves to LinkedIn. The first message goes Friday at 9:12, a week after the last email.')).toBeInTheDocument();
  });

  it('asks for an address when there is none, checks it on the server and shows the sentence', async () => {
    mocks.switchChannel.mockRejectedValueOnce(new ApiError(422, "That doesn't look like a LinkedIn profile link."));
    mocks.switchChannel.mockResolvedValueOnce({ ...CHIDI, channel: 'linkedin', nextTouchAt: '2026-11-06T08:12:00.000Z' });
    await show(full(CHIDI, { switchable: [{ channel: 'linkedin', at: null, available: true, reason: "Add Chidi's LinkedIn first" }] }));
    expect(screen.getByText("Add Chidi's LinkedIn first")).toBeInTheDocument();
    expect(mocks.switchChannel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Move to LinkedIn' }));
    const field = screen.getByLabelText('LinkedIn link for Chidi');
    await userEvent.type(field, 'example.com/chidi');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That doesn't look like a LinkedIn profile link.");
    await userEvent.clear(field);
    await userEvent.type(field, 'linkedin.com/in/chidi{Enter}');
    await waitFor(() => expect(mocks.switchChannel).toHaveBeenLastCalledWith(1, 'linkedin', 'linkedin.com/in/chidi'));
    await waitFor(() => expect(screen.queryByLabelText('LinkedIn link for Chidi')).not.toBeInTheDocument());
  });

  it('names the other project, with the reason beside it when Chidi cannot move', async () => {
    await show(full(CHIDI));
    const move = screen.getByRole('button', { name: 'Move to Payroll' });
    expect(move).toHaveAttribute('aria-disabled', 'true');
    expect(move.parentElement).toHaveTextContent("Chidi has already heard from you about Reconciliation. Callum can move them once they're resting.");
    await userEvent.click(move);
    expect(mocks.moveToProject).not.toHaveBeenCalled();
  });

  it('moves a stranger to the other project', async () => {
    mocks.moveToProject.mockResolvedValue({ ...CHIDI, projectId: 2 });
    await show(full(CHIDI, { projectMoves: [{ projectId: 2, name: 'Payroll', reason: null }] }));
    await userEvent.click(screen.getByRole('button', { name: 'Move to Payroll' }));
    expect(mocks.moveToProject).toHaveBeenCalledWith(1, 2);
    expect(await screen.findByText('Chidi moves to Payroll.')).toBeInTheDocument();
  });

  it('asks before never contacting, then calls correct', async () => {
    mocks.correct.mockResolvedValue({ ...CHIDI, status: 'stopped' });
    await show(full(CHIDI));
    await userEvent.click(screen.getByRole('button', { name: 'Never contact Chidi' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Never contact Chidi' });
    expect(dialog).toHaveTextContent("Callum cancels everything still waiting and won't reach out again, even if Chidi shows up in a list later.");
    expect(mocks.correct).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Never contact Chidi' }));
    expect(mocks.correct).toHaveBeenCalledWith(1, 'never_contact');
    expect(await screen.findByText("Chidi won't hear from Callum again.")).toBeInTheDocument();
  });

  it('lets the user keep Chidi instead, with the keyboard where it was', async () => {
    await show(full(CHIDI));
    const trigger = screen.getByRole('button', { name: 'Never contact Chidi' });
    await userEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mocks.correct).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Never contact Chidi' })).toHaveFocus();
  });

  it('keeps the form open, and the address, when another action is still running', async () => {
    mocks.nudge.mockReturnValue(new Promise(() => {}));
    await show(full(CHIDI, { switchable: [{ channel: 'linkedin', at: null, available: true, reason: "Add Chidi's LinkedIn first" }] }));
    await userEvent.click(screen.getByRole('button', { name: 'Move to LinkedIn' }));
    await userEvent.type(screen.getByLabelText('LinkedIn link for Chidi'), 'linkedin.com/in/chidi');
    await userEvent.click(screen.getByRole('button', { name: 'Nudge now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Callum is still finishing the last thing. Try again in a moment.');
    expect(screen.getByLabelText('LinkedIn link for Chidi')).toHaveValue('linkedin.com/in/chidi');
    expect(mocks.switchChannel).not.toHaveBeenCalled();
  });

  it('ends a toast made from a next line with exactly one full stop', async () => {
    mocks.nudge.mockResolvedValue(CHIDI);
    await show(full(CHIDI));
    mocks.personFull.mockResolvedValue(full(CHIDI, { next: 'That was the last follow-up. If Chidi stays quiet, Chidi rests from tomorrow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Nudge now' }));
    const text = await screen.findByText(/That was the last follow-up/, { selector: '.toast-text' });
    expect(text.textContent).toBe('That was the last follow-up. If Chidi stays quiet, Chidi rests from tomorrow.');
    expect(document.body.textContent).not.toContain('..');
  });
});

describe('the four states', () => {
  it('shows a stopped person with the reason and no actions', async () => {
    const ruth = person(4, 'Ruth Adeleke', { status: 'stopped', replyKind: 'stop' });
    await show(full(ruth, {
      closedNote: "Ruth asked not to be contacted. Callum stopped everything and won't reach out again.",
      next: 'Nothing goes to Ruth, ever again', why: 'Callum also skips Ruth in any list you bring later.', switchable: [], projectMoves: [],
      nudge: { ok: false, reason: null },
    }));
    expect(screen.getByText("Ruth asked not to be contacted. Callum stopped everything and won't reach out again.")).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nudge|Hold|Never contact|Move to/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Write to Ruth')).not.toBeInTheDocument();
  });

  it('shows a resting person with the date and wakes them with a way back', async () => {
    const mei = person(5, 'Mei Lin', { status: 'resting', restUntil: '2027-02-03T08:00:00.000Z', channel: 'x', email: null, xHandle: 'mei', stage: 'following', touches: 3 });
    mocks.wake.mockResolvedValue({ person: { ...mei, status: 'active' }, undoUntil: '2026-11-02T10:00:10.000Z', next: 'First hello goes out today at 11:00 on X' });
    mocks.rest.mockResolvedValue(mei);
    await show(full(mei, {
      next: 'Mei rests until 3 February, then starts again as a stranger', switchable: [], projectMoves: [], nudge: { ok: false, reason: null },
      path: [{ label: 'Hello', at: FRIDAY, done: true, state: 'done' }, { label: 'Resting', at: '2027-02-03T08:00:00.000Z', done: false, state: 'rest' }],
    }));
    expect(screen.getByText('Resting until 3 February')).toBeInTheDocument();
    expect(screen.getByText('until 3 February')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nudge now' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Wake Mei now' }));
    expect(mocks.wake).toHaveBeenCalledWith(5);
    expect(await screen.findByText('Mei is back. First hello goes out today at 11:00 on X.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(mocks.rest).toHaveBeenCalledWith(5);
    expect(await screen.findByText('Undone. Mei keeps resting.')).toBeInTheDocument();
  });

  it('shows a person who is talking, with the booked badge and unavailable actions explained', async () => {
    const kemi = person(2, 'Kemi Eze', { stage: 'talking', status: 'active', badge: 'booked', replyKind: 'interested' });
    await show(full(kemi, {
      messages: [], path: [], nudge: { ok: false, reason: 'Nudge now is for people Callum is still reaching. Kemi already talks with you.' },
      switchable: [{ channel: 'linkedin', at: null, available: false, reason: 'Kemi is talking with you on email, so Callum keeps it there.' }],
      projectMoves: [],
    }));
    expect(screen.getByText('Talking')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nudge now' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Move to LinkedIn' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Hold' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Write to Kemi')).toBeInTheDocument();
  });
});

describe('the thread', () => {
  const thread = [
    message(1, 'out', 'hello', "Hi Kemi, I've been following what Oko Pay is building.", '2026-10-27T08:12:00.000Z'),
    message(2, 'in', 'inbound', 'This is timely. Could you send a short deck?', '2026-11-02T06:40:00.000Z'),
    message(3, 'out', 'reply', "Thanks Kemi, I'll send a deck tonight.", '2026-11-02T07:02:00.000Z'),
  ];

  it('lists the whole conversation in order, each in its own voice, with channel and exact time', async () => {
    const kemi = person(2, 'Kemi Eze', { stage: 'talking', status: 'waiting', replyKind: 'interested' });
    // Handed over out of order on purpose.
    await show(full(kemi, { messages: [thread[2]!, thread[0]!, thread[1]!], path: [], switchable: [], projectMoves: [] }));
    const log = screen.getByRole('region', { name: 'Everything with Kemi' });
    const scroller = within(log).getByRole('region', { name: 'Messages with Kemi' });
    expect(scroller).toHaveAttribute('tabindex', '0');
    const bubbles = [...log.querySelectorAll('[data-voice]')];
    expect(bubbles.map((el) => el.getAttribute('data-voice'))).toEqual(['callum', 'them', 'you']);
    expect(bubbles[0]).toHaveTextContent('Callum, by email · Tue 9:12');
    expect(bubbles[1]).toHaveTextContent('Kemi, by email · Today 7:40');
    expect(bubbles[2]).toHaveTextContent('You, by email · Today 8:02');
    expect(bubbles[0]!.querySelector('.pv-bubble')).toHaveClass('pv-bubble-callum');
    expect(bubbles[1]!.querySelector('.pv-bubble')).toHaveClass('pv-bubble-them');
    expect(bubbles[2]!.querySelector('.pv-bubble')).toHaveClass('pv-bubble-you');
    expect(within(log).getByText('Email · 3 messages')).toBeInTheDocument();
  });

  it('puts the corrections on their last message and sends them to the server', async () => {
    mocks.correct.mockResolvedValue(person(2, 'Kemi Eze'));
    const kemi = person(2, 'Kemi Eze', { stage: 'talking', status: 'waiting', replyKind: 'interested' });
    await show(full(kemi, { messages: thread, path: [], switchable: [], projectMoves: [] }));
    const fixes = screen.getAllByRole('button', { name: "That's an auto-reply" });
    expect(fixes).toHaveLength(1);
    expect(screen.getByText('This is timely. Could you send a short deck?').parentElement).toContainElement(fixes[0]!);
    await userEvent.click(fixes[0]!);
    expect(mocks.correct).toHaveBeenCalledWith(2, 'auto_reply');
  });

  it('leaves the corrections off once the user has answered', async () => {
    const answered = person(2, 'Kemi Eze', { stage: 'talking', status: 'active', replyKind: 'interested' });
    await show(full(answered, { messages: thread, path: [], switchable: [], projectMoves: [] }));
    expect(screen.queryByRole('button', { name: "That's an auto-reply" })).not.toBeInTheDocument();
  });

  it('goes back to the river after Wrong person', async () => {
    mocks.correct.mockResolvedValue(person(2, 'Kemi Eze', { status: 'removed' }));
    const onBack = vi.fn();
    const kemi = person(2, 'Kemi Eze', { stage: 'talking', status: 'waiting', replyKind: 'interested' });
    await show(full(kemi, { messages: thread, path: [], switchable: [], projectMoves: [] }), undefined, { onBack });
    await userEvent.click(screen.getByRole('button', { name: 'Wrong person' }));
    expect(mocks.correct).toHaveBeenCalledWith(2, 'wrong_person');
    await waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it('writes a reply, shows it waiting with the 10 seconds, and takes it back on Undo', async () => {
    const item: OutboxItem = {
      id: 77, personId: 2, channel: 'email', kind: 'reply', subject: null, body: 'Thursday at 14:00 works.', state: 'scheduled', origin: 'user',
      sendAfter: '2026-11-02T10:00:10.000Z', undoUntil: '2026-11-02T10:00:10.000Z', error: null, approvalCounted: false, claimedAt: null, detail: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    };
    mocks.reply.mockResolvedValue(item);
    mocks.undo.mockResolvedValue({ ...item, state: 'cancelled' });
    const kemi = person(2, 'Kemi Eze', { stage: 'talking', status: 'waiting', replyKind: 'interested' });
    await show(full(kemi, { messages: thread, path: [], switchable: [], projectMoves: [] }));
    expect(screen.getByText('Goes by email from ada@example.com, with 10 seconds to undo')).toBeInTheDocument();
    const box = screen.getByLabelText('Write to Kemi');
    await userEvent.type(box, 'Thursday at 14:00 works.');
    await userEvent.click(screen.getByRole('button', { name: 'Send to Kemi' }));
    expect(mocks.reply).toHaveBeenCalledWith(2, 'Thursday at 14:00 works.');
    expect(box).toHaveValue('');
    expect(await screen.findByText('Your note to Kemi goes in 10 seconds')).toBeInTheDocument();
    expect(screen.getByText('Sending in a few seconds')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(mocks.undo).toHaveBeenCalledWith(77);
    await waitFor(() => expect(box).toHaveValue('Thursday at 14:00 works.'));
    expect(screen.queryByText('Sending in a few seconds')).not.toBeInTheDocument();
  });

  it('sends on Enter, and shows the server sentence when the note still has a placeholder', async () => {
    mocks.reply.mockRejectedValue(new ApiError(422, 'Fill in [YOUR PRICE] before this goes out.'));
    const kemi = person(2, 'Kemi Eze', { stage: 'talking', status: 'waiting', replyKind: 'interested' });
    await show(full(kemi, { messages: thread, path: [], switchable: [], projectMoves: [] }));
    await userEvent.type(screen.getByLabelText('Write to Kemi'), 'Our price is [[YOUR PRICE].{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Fill in [YOUR PRICE] before this goes out.');
    expect(screen.getByLabelText('Write to Kemi')).toHaveValue('Our price is [YOUR PRICE].');
  });

  it('shows a note already inside its 10 seconds, from the live state', async () => {
    const item: OutboxItem = {
      id: 9, personId: 2, channel: 'email', kind: 'reply', subject: null, body: 'On its way.', state: 'scheduled', origin: 'user',
      sendAfter: '2026-11-02T10:00:05.000Z', undoUntil: '2026-11-02T10:00:05.000Z', error: null, approvalCounted: false, claimedAt: null, detail: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    };
    const kemi = person(2, 'Kemi Eze', { stage: 'talking', status: 'waiting', replyKind: 'interested' });
    await show(full(kemi, { messages: thread, path: [], switchable: [], projectMoves: [] }), appState([kemi], { outbox: [item] }));
    expect(screen.getByText('On its way.')).toBeInTheDocument();
  });

  it('says nothing has been sent for someone new', async () => {
    const stranger = person(6, 'Bisi Alade', { stage: 'stranger', touches: 0, lastTouchAt: null, status: 'active' });
    await show(full(stranger, { messages: [], next: 'First hello goes out tomorrow at 9:00 by email', path: [] }));
    expect(screen.getByText('Nothing sent yet. First hello goes out tomorrow at 9:00 by email.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Write to Bisi')).not.toBeInTheDocument();
  });
});

describe('find someone', () => {
  it('filters the faces as you type and shows who is left', async () => {
    await show(full(CHIDI));
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    await userEvent.type(screen.getByLabelText('Find someone'), 'oko');
    const strip = screen.getByRole('list', { name: 'People matching oko' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(1);
    expect(within(strip).getByRole('button', { name: 'Kemi Eze, Oko Pay' })).toBeInTheDocument();
  });

  it('opens the first match on Enter', async () => {
    const spy = vi.fn();
    mocks.personFull.mockImplementation(async (id: number) => full(id === 3 ? TUNDE : CHIDI));
    render(<Harness state={appState([CHIDI, KEMI, TUNDE])} onOpenSpy={spy} />);
    await screen.findByRole('heading', { level: 1, name: 'Chidi Okeke' });
    await userEvent.type(screen.getByLabelText('Find someone'), 'tunde{Enter}');
    expect(spy).toHaveBeenCalledWith(3);
    expect(await screen.findByRole('heading', { level: 1, name: 'Tunde Bello' })).toBeInTheDocument();
    expect(screen.getByLabelText('Find someone')).toHaveValue('');
  });

  it('opens a face from the strip', async () => {
    const spy = vi.fn();
    mocks.personFull.mockImplementation(async (id: number) => full(id === 2 ? KEMI : CHIDI));
    render(<Harness state={appState([CHIDI, KEMI, TUNDE])} onOpenSpy={spy} />);
    await screen.findByRole('heading', { level: 1, name: 'Chidi Okeke' });
    expect(screen.getByRole('button', { name: 'Chidi Okeke, Marina Ledger' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Kemi Eze, Oko Pay' }));
    expect(spy).toHaveBeenCalledWith(2);
  });

  it('says nobody is there when nobody matches', async () => {
    await show(full(CHIDI));
    await userEvent.type(screen.getByLabelText('Find someone'), 'zzz');
    const none = screen.getByText("Nobody called 'zzz' in your river.");
    expect(none).toHaveAttribute('role', 'status');
    expect(none.closest('[role="list"]')).toBeNull();
    await userEvent.clear(screen.getByLabelText('Find someone'));
    expect(screen.queryByText(/Nobody called/)).not.toBeInTheDocument();
  });

  it('keeps the person on screen even when they are not among the latest faces', async () => {
    const many = Array.from({ length: 12 }, (_, i) => person(20 + i, `Person${i} Test`, { updatedAt: `2026-11-01T0${i % 10}:00:00.000Z`.replace('T0', 'T1') }));
    await show(full(CHIDI), appState([CHIDI, ...many]));
    expect(screen.getByRole('button', { name: 'Chidi Okeke, Marina Ledger' })).toBeInTheDocument();
  });
});

describe('when the person cannot be loaded', () => {
  it('shows the sentence and a way back', async () => {
    mocks.personFull.mockRejectedValue(new ApiError(404, "Callum can't find that person."));
    const onBack = vi.fn();
    render(<Harness state={appState([CHIDI])} onBack={onBack} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Callum can't find that person.");
    await userEvent.click(screen.getByRole('button', { name: 'Go back to the river' }));
    expect(onBack).toHaveBeenCalled();
  });
});
