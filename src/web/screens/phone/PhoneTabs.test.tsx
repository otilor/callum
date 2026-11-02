import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Message, Person } from '../../../shared/types.js';
import { ApiError } from '../../api.js';
import { NOW, appState, channel, person, project } from '../../test/fixtures.js';
import { PhoneTabs } from './PhoneTabs.js';

const mocks = vi.hoisted(() => ({
  person: vi.fn(), draft: vi.fn(), reply: vi.fn(), undo: vi.fn(), snooze: vi.fn(), nudge: vi.fn(), hold: vi.fn(), resume: vi.fn(),
  ask: vi.fn(), act: vi.fn(), pause: vi.fn(), resumeAll: vi.fn(), channelSummary: vi.fn(),
}));
vi.mock('../../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api.js')>()),
  api: mocks,
}));

const iso = (s: string) => new Date(s).toISOString();

/** Tuesday 3 November, 9:30 in Lagos. */
const kemi = person(1, 'Kemi Eze', {
  stage: 'talking', status: 'waiting', channel: 'email', role: 'Founder', company: 'Oko Pay', replyKind: 'interested', suggested: 'reply',
  lastInbound: "This is timely. We're rebuilding our month-end close in December. Could we talk on Thursday?",
  repliedAt: iso('2026-11-03T06:40:00Z'), draft: "Thanks Kemi, glad the timing works. Thursday at 14:00 suits me.",
});
const zainab = person(2, 'Zainab Musa', {
  stage: 'talking', status: 'waiting', company: 'Lagoon Pay', lastInbound: 'Not right now. Try me again in the new year.',
  repliedAt: iso('2026-11-02T15:05:00Z'),
});
const tunde = person(3, 'Tunde Bello', { stage: 'talking', status: 'active', badge: 'booked', repliedAt: iso('2026-10-29T12:02:00Z'), company: 'Ireti Labs', role: 'COO' });
const ada = person(4, 'Ada Nwosu', {
  stage: 'following', channel: 'linkedin', linkedinState: 'connected', touches: 2, nextTouchAt: iso('2026-11-03T10:00:00Z'), role: 'Founder', company: 'Kudi Rails',
});
const chidi = person(5, 'Chidi Okeke', { stage: 'following', touches: 1, nextTouchAt: iso('2026-11-05T08:00:00Z') });
const ngozi = person(6, 'Ngozi Ibe', { stage: 'following', touches: 2, nextTouchAt: iso('2026-11-05T08:00:00Z') });
const emeka = person(7, 'Emeka Obi', { stage: 'following', touches: 1, nextTouchAt: iso('2026-11-06T08:00:00Z') });
const hello = person(8, 'Seun Ojo', { stage: 'hello', touches: 1, nextTouchAt: iso('2026-11-06T08:00:00Z') });
const strangerA = person(9, 'Dayo Ogunleye');
const strangerB = person(10, 'Sade Afolabi');
const paying = person(11, 'Yaw Mensah', {
  projectId: 2, stage: 'talking', status: 'waiting', lastInbound: 'Happy to look. We run 140 people on a spreadsheet today.', repliedAt: iso('2026-11-03T07:05:00Z'),
});

function state(over: Partial<AppState> = {}, people: Person[] = [kemi, zainab, tunde, ada, chidi, ngozi, emeka, hello, strangerA, strangerB]): AppState {
  return appState({
    people,
    brief: { wantToTalk: people.filter((p) => p.status === 'waiting').length, sentYesterday: 12, acceptedRecently: ['Ada'], acceptedIds: people.filter((p) => p.firstName === 'Ada').map((p) => p.id), nextSendAt: null, line: '' },
    ...over,
  });
}

function thread(over: Message[] = []): { person: Person; messages: Message[]; path: never[] } {
  return { person: kemi, path: [], messages: over };
}

const MSGS: Message[] = [
  { id: 1, personId: 1, channel: 'email', direction: 'out', kind: 'hello', subject: 'Hi', body: 'Hi Kemi, congrats on the launch. Worth a short chat?', at: iso('2026-10-26T08:12:00Z'), externalId: null },
  { id: 2, personId: 1, channel: 'email', direction: 'in', kind: 'inbound', subject: null, body: "This is timely. Could we talk on Thursday?", at: iso('2026-11-03T06:40:00Z'), externalId: null },
];

const refresh = vi.fn(async () => undefined);
const view = (s: AppState = state(), props: Partial<React.ComponentProps<typeof PhoneTabs>> = {}) =>
  render(<PhoneTabs state={s} project={s.projects[0] ?? null} refresh={refresh} now={() => NOW} {...props} />);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.person.mockResolvedValue(thread(MSGS));
  mocks.channelSummary.mockResolvedValue({ pending: { invites: 0, followUps: 0, emails: 0, messages: 0 }, paceLine: '20 a day this week, 120 by week 3' });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PhoneTabs', () => {
  it('has a bottom bar with River, Ask and You, and starts on River', () => {
    view();
    const nav = screen.getByRole('navigation', { name: 'Places' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['River', 'Ask', 'You']);
    expect(within(nav).getByRole('button', { name: /River/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Good morning' })).toBeInTheDocument();
  });

  it('moves between the three places', async () => {
    const user = userEvent.setup();
    const onTab = vi.fn();
    view(state(), { onTab });
    const nav = screen.getByRole('navigation', { name: 'Places' });
    await user.click(within(nav).getByRole('button', { name: /Ask/ }));
    expect(screen.getByRole('heading', { name: 'Ask Callum' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /Ask/ })).toHaveAttribute('aria-current', 'page');
    await user.click(within(nav).getByRole('button', { name: /You/ }));
    expect(screen.getByText('Where Callum reaches people')).toBeInTheDocument();
    await user.click(within(nav).getByRole('button', { name: /River/ }));
    expect(screen.getByRole('heading', { name: 'Good morning' })).toBeInTheDocument();
    expect(onTab.mock.calls.map((c) => c[0])).toEqual(['ask', 'you', 'river']);
  });

  it('follows a tab it is given', () => {
    view(state(), { tab: 'you' });
    expect(screen.getByText('Where Callum reaches people')).toBeInTheDocument();
  });

  it('shows how many want to talk on River while another tab is open', async () => {
    const user = userEvent.setup();
    view();
    const nav = screen.getByRole('navigation', { name: 'Places' });
    expect(within(nav).queryByLabelText('2 want to talk')).not.toBeInTheDocument();
    await user.click(within(nav).getByRole('button', { name: /Ask/ }));
    expect(within(nav).getByLabelText('2 want to talk')).toHaveTextContent('2');
  });

  it('draws the River tab it is handed instead of its own', () => {
    view(state(), { river: <p>Task fifteen river</p> });
    expect(screen.getByText('Task fifteen river')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Good morning' })).not.toBeInTheDocument();
  });
});

describe('River tab', () => {
  it('lists people by how far along they are, with the brief on top', () => {
    view();
    expect(screen.getByText('2 want to talk')).toBeInTheDocument();
    expect(screen.getByText('12 hellos sent yesterday')).toBeInTheDocument();
    expect(screen.getByText('Ada accepted')).toBeInTheDocument();
    const heads = ['Want to talk', 'Talking', 'Following up', 'Said hello', 'Strangers'];
    for (const h of heads) expect(screen.getByText(h)).toBeInTheDocument();
    expect(screen.getByText('2 people wait for a first hello.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Kemi Eze/ })).toHaveTextContent("This is timely. We're rebuilding");
    expect(screen.getByRole('button', { name: /Tunde Bello/ })).toHaveTextContent('Call booked');
    expect(screen.getByRole('button', { name: /Ada Nwosu/ })).toHaveTextContent('Follow-up today at 11:00');
  });

  it('draws the strip with a labelled face for everyone', () => {
    view();
    const strip = screen.getByRole('region', { name: 'Reconciliation river' });
    expect(within(strip).getByRole('img', { name: 'Kemi Eze, want to talk' })).toBeInTheDocument();
    expect(within(strip).getByRole('img', { name: 'Ada Nwosu, following up' })).toBeInTheDocument();
    expect(within(strip).getByRole('img', { name: 'Dayo Ogunleye, strangers' })).toBeInTheDocument();
  });

  it('folds the long following-up list behind "N more"', async () => {
    const user = userEvent.setup();
    view();
    expect(screen.queryByRole('button', { name: /Emeka Obi/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '1 more' }));
    expect(screen.getByRole('button', { name: /Emeka Obi/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.queryByRole('button', { name: /Emeka Obi/ })).not.toBeInTheDocument();
  });

  it('mixes projects in Want to talk, with a tag, and keeps the stages to the current project', () => {
    const s = state({ projects: [project(), project({ id: 2, name: 'Payroll' })] }, [kemi, paying, ada, person(12, 'Halima Garba', { projectId: 2, stage: 'following', touches: 1, nextTouchAt: iso('2026-11-05T08:00:00Z') })]);
    view(s);
    const kemiRow = screen.getByRole('button', { name: /Kemi Eze/ });
    const yawRow = screen.getByRole('button', { name: /Yaw Mensah/ });
    expect(within(kemiRow).getByText('Reconciliation')).toBeInTheDocument();
    expect(within(yawRow).getByText('Payroll')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ada Nwosu/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Halima Garba/ })).not.toBeInTheDocument();
  });

  it('names no project when there is only one', () => {
    view();
    expect(within(screen.getByRole('button', { name: /Kemi Eze/ })).queryByText('Reconciliation')).not.toBeInTheDocument();
  });

  it('says so when Callum is paused, and leaves the rest of the list as it is', () => {
    const s = state();
    s.settings = { ...s.settings, pauseState: 'paused', pausedUntil: iso('2026-11-09T08:00:00Z') };
    view(s);
    expect(screen.getByText('Callum is paused until Monday 9 November. Replies still reach you, and nothing automatic goes out.')).toBeInTheDocument();
    expect(screen.getByText('Their first hellos wait while Callum is paused.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Kemi Eze/ })).toBeInTheDocument();
  });

  it('is calm when nobody is in the river', () => {
    view(state({}, []));
    expect(screen.getByText('All caught up')).toBeInTheDocument();
    expect(screen.getByText('Nobody is in this river yet. Add people from your computer, or ask Callum to find some.')).toBeInTheDocument();
  });
});

describe('person sheet', () => {
  it('opens on a tap with the thread and the draft, and closes with Escape', async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: /Kemi Eze/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Kemi Eze' });
    expect(within(sheet).getByText('Founder at Oko Pay, Email')).toBeInTheDocument();
    expect(await within(sheet).findByText('Hi Kemi, congrats on the launch. Worth a short chat?')).toBeInTheDocument();
    expect(within(sheet).getByText('Callum, Email, Monday 26 October at 9:12')).toBeInTheDocument();
    expect(within(sheet).getByText('Email, today at 7:40')).toBeInTheDocument();
    expect(within(sheet).getByRole('textbox', { name: /Callum's draft/ })).toHaveValue('Thanks Kemi, glad the timing works. Thursday at 14:00 suits me.');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks Callum for a draft when none is saved', async () => {
    const user = userEvent.setup();
    mocks.draft.mockResolvedValue({ body: 'Totally fair, Zainab. I will check back in January.' });
    view();
    await user.click(screen.getByRole('button', { name: /Zainab Musa/ }));
    const box = await screen.findByRole('textbox', { name: /Callum's draft/ });
    await waitFor(() => expect(box).toHaveValue('Totally fair, Zainab. I will check back in January.'));
    expect(mocks.draft).toHaveBeenCalledWith(2, 'reply');
  });

  it('sends the reply, says it is sending, and takes it back on Undo', async () => {
    const user = userEvent.setup();
    mocks.reply.mockResolvedValue({ id: 91, createdAt: iso('2026-11-03T08:30:00Z'), undoUntil: iso('2026-11-03T08:30:10Z') });
    mocks.undo.mockResolvedValue({ id: 91 });
    view();
    await user.click(screen.getByRole('button', { name: /Kemi Eze/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Kemi Eze' });
    await user.click(within(sheet).getByRole('button', { name: 'Send' }));
    expect(mocks.reply).toHaveBeenCalledWith(1, 'Thanks Kemi, glad the timing works. Thursday at 14:00 suits me.');
    expect(await screen.findByText('Sending your reply to Kemi')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(mocks.undo).toHaveBeenCalledWith(91);
    expect(await screen.findByText('Not sent. Kemi is back with you.')).toBeInTheDocument();
  });

  it('keeps Undo for as long as the server does, counted from when it queued the message', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // Queued at 08:30:00 with a 6 second window: the phone clock is not the server's, so only the gap counts.
    mocks.reply.mockResolvedValue({ id: 92, createdAt: iso('2026-11-03T08:30:00Z'), undoUntil: iso('2026-11-03T08:30:06Z') });
    view();
    await user.click(screen.getByRole('button', { name: /Kemi Eze/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Kemi Eze' });
    await user.click(within(sheet).getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('does not lose Undo when another line arrives; it waits behind', async () => {
    mocks.reply.mockResolvedValue({ id: 93, createdAt: iso('2026-11-03T08:30:00Z'), undoUntil: iso('2026-11-03T08:30:10Z') });
    mocks.undo.mockResolvedValue({ id: 93 });
    mocks.snooze.mockResolvedValue({ ...zainab, status: 'snoozed', snoozedUntil: iso('2026-11-09T08:00:00Z') });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: /Kemi Eze/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Kemi Eze' })).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Sending your reply to Kemi')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Zainab Musa/ }));
    mocks.draft.mockResolvedValue({ body: 'Fair enough.' });
    await user.click(within(await screen.findByRole('dialog', { name: 'Zainab Musa' })).getByRole('button', { name: 'Snooze' }));
    await waitFor(() => expect(mocks.snooze).toHaveBeenCalled());
    // The Undo for Kemi is still on screen, and the snooze line is waiting behind it.
    expect(screen.getByText('Sending your reply to Kemi')).toBeInTheDocument();
    expect(screen.queryByText('Zainab comes back Monday at 9:00')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(mocks.undo).toHaveBeenCalledWith(93);
    expect(await screen.findByText('Zainab comes back Monday at 9:00')).toBeInTheDocument();
  });

  it('keeps Tab inside the sheet', async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: /Kemi Eze/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Kemi Eze' });
    const items = within(sheet).getAllByRole('button');
    (items[items.length - 1] as HTMLElement).focus();
    await user.tab();
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(within(sheet).getAllByRole('button')[0]);
    await user.tab({ shift: true });
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
  });

  it('will not send an empty reply', async () => {
    const user = userEvent.setup();
    view(state({}, [{ ...kemi, draft: null }]));
    mocks.draft.mockResolvedValue({ body: '' });
    await user.click(screen.getByRole('button', { name: /Kemi Eze/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Kemi Eze' });
    await screen.findByText('Write a line first. Send waits for words.');
    await user.click(within(sheet).getByRole('button', { name: 'Send' }));
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it('shows the server\'s own words when the send fails, and stays open', async () => {
    const user = userEvent.setup();
    mocks.reply.mockRejectedValue(new ApiError(422, 'Email is paused, so Callum cannot send this yet.'));
    view();
    await user.click(screen.getByRole('button', { name: /Kemi Eze/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Kemi Eze' });
    await user.click(within(sheet).getByRole('button', { name: 'Send' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Email is paused, so Callum cannot send this yet.');
    expect(screen.getByRole('dialog', { name: 'Kemi Eze' })).toBeInTheDocument();
  });

  it('snoozes and says when they come back', async () => {
    const user = userEvent.setup();
    mocks.snooze.mockResolvedValue({ ...kemi, status: 'snoozed', snoozedUntil: iso('2026-11-09T08:00:00Z') });
    view();
    await user.click(screen.getByRole('button', { name: /Kemi Eze/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Kemi Eze' });
    await user.click(within(sheet).getByRole('button', { name: 'Snooze' }));
    expect(mocks.snooze).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Kemi comes back Monday at 9:00')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('nudges someone in the river, then explains when it goes out', async () => {
    const user = userEvent.setup();
    mocks.nudge.mockResolvedValue({ ...chidi });
    mocks.person.mockResolvedValue({ person: chidi, messages: [], path: [{ label: 'Hello', at: null, done: true }, { label: 'Follow-up', at: iso('2026-11-05T08:00:00Z'), done: false }] });
    view();
    await user.click(screen.getByRole('button', { name: /Chidi Okeke/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Chidi Okeke' });
    expect(await within(sheet).findByText('Next: follow-up Thursday at 9:00.')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Nudge now' }));
    expect(mocks.nudge).toHaveBeenCalledWith(5);
    expect(await screen.findByText("Nudged. Chidi's next message goes out as soon as sending hours allow.")).toBeInTheDocument();
  });

  it('holds and resumes', async () => {
    const user = userEvent.setup();
    mocks.hold.mockResolvedValue({ ...chidi, status: 'held' });
    mocks.resume.mockResolvedValue({ ...chidi });
    const { rerender } = view();
    await user.click(screen.getByRole('button', { name: /Chidi Okeke/ }));
    let sheet = await screen.findByRole('dialog', { name: 'Chidi Okeke' });
    await user.click(within(sheet).getByRole('button', { name: 'Hold' }));
    expect(mocks.hold).toHaveBeenCalledWith(5);
    expect(await screen.findByText('Chidi is on hold. Nothing goes out until you resume.')).toBeInTheDocument();

    const held = state({}, [kemi, { ...chidi, status: 'held' }]);
    rerender(<PhoneTabs state={held} project={held.projects[0] ?? null} refresh={refresh} now={() => NOW} />);
    sheet = screen.getByRole('dialog', { name: 'Chidi Okeke' });
    expect(within(sheet).getByText('Resume Chidi first to nudge.')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Nudge now' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(within(sheet).getByRole('button', { name: 'Resume' }));
    expect(mocks.resume).toHaveBeenCalledWith(5);
  });

  it('leaves someone you are talking with alone', async () => {
    const user = userEvent.setup();
    mocks.person.mockResolvedValue({ person: tunde, messages: [], path: [] });
    view();
    await user.click(screen.getByRole('button', { name: /Tunde Bello/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Tunde Bello' });
    expect(await within(sheet).findByText('Callum stays quiet with Tunde. You talk from here.')).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Nudge now' })).not.toBeInTheDocument();
  });
});

describe('Ask tab', () => {
  const open = async (s: AppState = state()) => {
    const user = userEvent.setup();
    view(s, { tab: 'ask' });
    return user;
  };

  it('starts with chips that fit the river', async () => {
    await open();
    expect(screen.getByRole('heading', { name: 'Ask Callum' })).toBeInTheDocument();
    expect(screen.getByText('About your people, or who to meet next.')).toBeInTheDocument();
    const chips = within(screen.getByRole('group', { name: 'Things to ask' })).getAllByRole('button').map((b) => b.textContent);
    expect(chips).toEqual(["Who's warming up?", 'Find 10 more like Kemi', 'Pause LinkedIn']);
  });

  it('shows an answer with the faces it is about', async () => {
    const user = await open(state({ channels: [channel('email'), channel('linkedin', 'connected'), channel('x', 'disconnected')] }));
    mocks.ask.mockResolvedValue({ text: '2 people are warming up.', personIds: [4, 5], action: null });
    await user.click(screen.getByRole('button', { name: "Who's warming up?" }));
    expect(mocks.ask).toHaveBeenCalledWith("Who's warming up?", 1);
    expect(await screen.findByText('2 people are warming up.')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Chidi')).toBeInTheDocument();
  });

  it('asks what is typed, and nothing when it is blank', async () => {
    const user = await open();
    mocks.ask.mockResolvedValue({ text: 'Callum can look for 20 people.', personIds: [], action: null });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Ask Callum' }), 'find 20 founders{Enter}');
    expect(mocks.ask).toHaveBeenCalledWith('find 20 founders', 1);
    expect(await screen.findByText('Callum can look for 20 people.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask Callum' })).toHaveValue('');
  });

  it('does what Callum offers when told to, and says what happened', async () => {
    const user = await open();
    const action = { kind: 'find_more' as const, label: 'Find 10 more like Kemi', args: { likePersonId: 1, query: null, count: 10 } };
    mocks.ask.mockResolvedValue({ text: 'Callum can look for 10 more like Kemi. That uses about 10 Apollo credits.', personIds: [1], action });
    mocks.act.mockResolvedValue({ text: '10 people joined the river. Their first hellos go out tomorrow at 9:00.', personIds: [], action: null });
    await user.type(screen.getByRole('textbox', { name: 'Ask Callum' }), 'find more like Kemi{Enter}');
    const offer = await screen.findByText('Callum can look for 10 more like Kemi. That uses about 10 Apollo credits.');
    const card = offer.closest('.pa-answer') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Find 10 more like Kemi' }));
    expect(mocks.act).toHaveBeenCalledWith(action, 1);
    expect(await screen.findByText('10 people joined the river. Their first hellos go out tomorrow at 9:00.')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('lets "Not now" clear the answer', async () => {
    const user = await open();
    const action = { kind: 'set_tone' as const, label: 'Use a direct tone', args: { tone: 'direct' as const } };
    mocks.ask.mockResolvedValue({ text: 'Callum can write in a direct tone from now on.', personIds: [], action });
    await user.type(screen.getByRole('textbox', { name: 'Ask Callum' }), 'be more direct{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(mocks.act).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Ask Callum' })).toBeInTheDocument();
  });

  it('offers Undo after a pause', async () => {
    const user = await open();
    const action = { kind: 'pause_channel' as const, label: 'Pause LinkedIn', args: { channel: 'linkedin' as const } };
    mocks.ask.mockResolvedValue({ text: 'Callum can pause LinkedIn. Nothing new goes out there until you resume.', personIds: [], action });
    mocks.act.mockResolvedValueOnce({ text: 'Paused LinkedIn. Nothing new goes out there until you resume.', personIds: [], action: null });
    mocks.act.mockResolvedValueOnce({ text: 'Resumed LinkedIn.', personIds: [], action: null });
    await user.type(screen.getByRole('textbox', { name: 'Ask Callum' }), 'pause linkedin{Enter}');
    const offer = await screen.findByText('Callum can pause LinkedIn. Nothing new goes out there until you resume.');
    await user.click(within(offer.closest('.pa-answer') as HTMLElement).getByRole('button', { name: 'Pause LinkedIn' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(mocks.act).toHaveBeenLastCalledWith({ kind: 'resume_channel', label: 'Resume LinkedIn', args: { channel: 'linkedin' } }, 1);
    expect(await screen.findByText('Resumed LinkedIn.')).toBeInTheDocument();
  });

  it('shows the server\'s words when asking fails', async () => {
    const user = await open();
    mocks.ask.mockRejectedValue(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    await user.type(screen.getByRole('textbox', { name: 'Ask Callum' }), 'who is warm{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent("Callum can't be reached. Check that it is still running.");
  });
});

describe('You tab', () => {
  const open = (s: AppState = state(), props: Partial<React.ComponentProps<typeof PhoneTabs>> = {}) => {
    const user = userEvent.setup();
    view(s, { tab: 'you', ...props });
    return user;
  };

  it('shows who Callum writes as, the offer, and the pace of each channel', async () => {
    open(state({ channels: [channel('email'), channel('linkedin'), channel('x', 'disconnected')] }));
    expect(screen.getByRole('heading', { name: 'Gabriel Femi' })).toBeInTheDocument();
    expect(screen.getByText('Sending as gabriel@yourcompany.com')).toBeInTheDocument();
    expect(screen.getByText("You help fintech teams take reconciliation off their ops team's plate.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('20 a day this week, 120 by week 3')).toHaveLength(2));
    expect(screen.getByText('Not connected yet')).toBeInTheDocument();
  });

  it('falls back to a true line when the pace has not arrived', () => {
    mocks.channelSummary.mockRejectedValue(new ApiError(0, 'no'));
    open(state({ channels: [channel('email'), channel('linkedin', 'paused', { pausedUntil: iso('2026-11-09T08:00:00Z') }), channel('x', 'error')] }));
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Paused until Monday 9 November')).toBeInTheDocument();
    expect(screen.getByText('Needs to be connected again')).toBeInTheDocument();
  });

  it('takes a break until the day picked', async () => {
    mocks.pause.mockResolvedValue({});
    const user = open();
    await user.click(screen.getByRole('button', { name: 'Take a break' }));
    expect(screen.getByText('Nothing automatic goes out. Replies still reach you.')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Pause until' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Monday 9 November', 'Monday 16 November', '6 January']);
    await user.click(within(group).getByRole('button', { name: 'Monday 9 November' }));
    expect(mocks.pause).toHaveBeenCalledWith('2026-11-09T08:00:00.000Z');
    expect(await screen.findByText('Paused until Monday 9 November')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the break that is on, and resumes it', async () => {
    mocks.resumeAll.mockResolvedValue({});
    const s = state();
    s.settings = { ...s.settings, pauseState: 'paused', pausedUntil: iso('2026-11-09T08:00:00Z') };
    const user = open(s);
    expect(screen.queryByRole('button', { name: 'Take a break' })).not.toBeInTheDocument();
    expect(screen.getByText(/Callum is paused until Monday 9 November/)).toBeInTheDocument();
    expect(screen.getAllByText('Waits while Callum is paused')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.resumeAll).toHaveBeenCalled();
    expect(await screen.findByText('Callum is back at work')).toBeInTheDocument();
  });

  it('draws the links only when they go somewhere', async () => {
    const onOpenSettings = vi.fn();
    const onLeave = vi.fn();
    const user = open(state(), { onOpenSettings, onLeave });
    await user.click(screen.getByRole('button', { name: 'Everything else in Your Callum' }));
    await user.click(screen.getByRole('button', { name: 'Wrap up and leave' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('leaves the links out when nothing is wired to them', () => {
    open();
    expect(screen.queryByRole('button', { name: 'Everything else in Your Callum' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wrap up and leave' })).not.toBeInTheDocument();
  });
});
