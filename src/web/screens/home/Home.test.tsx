import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, OutboxItem, Person, Project } from '../../../shared/types.js';
import { marbleBackground } from '../../ui/Marble.js';
import { ToastProvider } from '../../ui/Toast.js';
import { Home, type HomeProps } from './Home.js';

const mocks = vi.hoisted(() => ({
  pause: vi.fn(), resumeAll: vi.fn(), resumeProject: vi.fn(), pauseProject: vi.fn(), setCurrentProject: vi.fn(), wrapProject: vi.fn(), updateProject: vi.fn(),
  person: vi.fn(), nudge: vi.fn(), hold: vi.fn(), resume: vi.fn(), ask: vi.fn(), act: vi.fn(),
  exportCsvUrl: vi.fn((id?: number) => `/api/export.csv?projectId=${id}`),
}));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const NOW = new Date('2026-11-02T10:00:00Z');
const AT = NOW.toISOString();
const clock = () => NOW;
const refresh = vi.fn(() => Promise.resolve());

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1, name: 'Reconciliation', offer: null, audience: null, tone: 'warm', sample: null, calendarUrl: 'https://cal.com/gabriel', approvalsLeft: 0,
    startedAt: AT, state: 'running', pausedUntil: null, createdAt: AT, updatedAt: AT, ...over,
  };
}

function person(id: number, name: string, over: Partial<Person> = {}): Person {
  return {
    id, projectId: 1, name, firstName: name.split(' ')[0] ?? name, company: 'Oko Pay', role: 'Founder', email: `p${id}@okopay.com`, linkedinUrl: null, xHandle: null,
    timezone: null, channel: 'email', stage: 'hello', status: 'active', touches: 1, lastTouchAt: null, nextTouchAt: '2026-11-03T09:00:00Z', linkedinState: 'none',
    invitedAt: null, snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null,
    source: 'paste', note: null, createdAt: AT, updatedAt: AT, ...over,
  };
}

const replied = (id: number, name: string, over: Partial<Person> = {}) =>
  person(id, name, {
    stage: 'talking', status: 'waiting', replyKind: 'interested', suggested: 'reply', draft: 'Thanks, talk soon.', lastInbound: `Hello from ${name}`,
    repliedAt: `2026-11-02T0${id}:00:00Z`, ...over,
  });

function appState(over: Partial<AppState> = {}, settings: Partial<AppState['settings']> = {}): AppState {
  return {
    settings: { senderName: 'Gabriel', senderEmail: null, timezone: 'UTC', onboarded: true, currentProjectId: 1, pauseState: 'running', pausedUntil: null, notifications: null, morningBrief: true, ...settings },
    projects: [project()],
    channels: [
      { channel: 'email', status: 'connected', identity: 'g@x.com', connectedAt: AT, pausedUntil: null, halfPaceUntil: null, invitesBlockedUntil: null, lastPolledAt: null },
      { channel: 'linkedin', status: 'connected', identity: 'g', connectedAt: AT, pausedUntil: null, halfPaceUntil: null, invitesBlockedUntil: null, lastPolledAt: null },
    ],
    people: [], outbox: [], incidents: [], demo: false, apolloConnected: false, claudeConnected: false, auth: { password: false },
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], acceptedIds: [], nextSendAt: null, line: '' },
    ...over,
  };
}

function view(state: AppState, props: Partial<HomeProps> = {}) {
  const current = state.projects.find((p) => p.id === state.settings.currentProjectId) ?? state.projects[0]!;
  return render(
    <ToastProvider>
      <Home state={state} project={current} refresh={refresh} now={clock} {...props} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset?.();
  mocks.exportCsvUrl.mockImplementation((id?: number) => `/api/export.csv?projectId=${id}`);
  mocks.person.mockResolvedValue({ person: person(9, 'x'), messages: [], path: [] });
  refresh.mockClear();
});

describe('Home', () => {
  it('says the river is empty and sends the cursor to the Ask bar', async () => {
    const user = userEvent.setup();
    view(appState());
    await user.click(screen.getByRole('button', { name: 'Your river is empty. Tell Callum who you want to meet.' }));
    expect(screen.getByRole('textbox', { name: 'Ask Callum' })).toHaveFocus();
    expect(screen.getByText("You're all caught up. Callum will tap you when someone replies.")).toBeInTheDocument();
  });

  it('counts the people who want to talk and opens the deck at one of them', async () => {
    const user = userEvent.setup();
    const people = [replied(1, 'Kemi Eze'), replied(2, 'Femi Adeyemi'), replied(3, 'Temi Bello'), person(4, 'Ada Obi')];
    view(appState({ people, brief: { wantToTalk: 3, sentYesterday: 12, acceptedRecently: ['Ada'], acceptedIds: people.filter((p) => p.firstName === 'Ada').map((p) => p.id), nextSendAt: '2026-11-03T09:00:00Z', line: '' } }));
    expect(screen.getByText('Good morning. 3 people want to talk.')).toBeInTheDocument();
    expect(screen.getByText('3 new replies')).toBeInTheDocument();
    expect(screen.queryByText('3 want to talk')).not.toBeInTheDocument();
    expect(screen.getByText('12 hellos went out yesterday')).toBeInTheDocument();
    expect(screen.getByText('Ada accepted')).toBeInTheDocument();
    expect(screen.getByText('Next hello tomorrow at 9:00')).toBeInTheDocument();
    expect(screen.getByText('“Hello from Temi Bello”')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Temi Bello, replied and waiting on you' }));
    const deck = await screen.findByRole('dialog', { name: 'Replies waiting for you' });
    expect(within(deck).getByRole('article', { name: 'Reply from Temi Bello' })).toBeInTheDocument();
    await user.click(within(deck).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Replies waiting for you' })).not.toBeInTheDocument();
  });

  it('opens a face in the river with where they are and Nudge now or Hold', async () => {
    mocks.person.mockResolvedValue({
      person: person(4, 'Ada Obi'), messages: [],
      path: [{ label: 'Hello', at: '2026-11-01T09:00:00Z', done: true }, { label: 'Follow-up', at: '2026-11-04T09:00:00Z', done: false }],
    });
    mocks.nudge.mockResolvedValue({});
    const user = userEvent.setup();
    view(appState({ people: [person(4, 'Ada Obi')] }));
    await user.click(await screen.findByRole('button', { name: 'Ada Obi, Said hello' }));
    const card = await screen.findByRole('dialog', { name: 'Ada Obi' });
    expect(await within(card).findByText('Follow-up')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Nudge now' }));
    expect(mocks.nudge).toHaveBeenCalledWith(4);
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the list as a table, one row per person, grouped by how close they are', async () => {
    const user = userEvent.setup();
    const people = [replied(1, 'Kemi Eze'), person(4, 'Ada Obi'), person(5, 'Chidi Okafor', { stage: 'stranger', channel: 'linkedin' }), person(6, 'Bola Ade', { stage: 'following' })];
    view(appState({ people }));
    await user.click(screen.getByRole('button', { name: 'List' }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row', { name: /Kemi|Ada|Chidi|Bola/ })).toHaveLength(4);
    const groups = within(table).getAllByRole('rowheader').map((h) => h.textContent);
    expect(groups.filter((t) => /^(Want to talk|Following up|Said hello|Strangers)/.test(t ?? ''))).toEqual(['Want to talk1', 'Following up1', 'Said hello1', 'Strangers1']);
    expect(within(table).queryByText('Reconciliation')).not.toBeInTheDocument();

    await user.click(within(table).getByRole('button', { name: /Ada Obi/ }));
    expect(await screen.findByRole('group', { name: 'Ada Obi' })).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: 'Kemi Eze, replied and waiting on you' }));
    expect(await screen.findByRole('dialog', { name: 'Replies waiting for you' })).toBeInTheDocument();
  });

  it('pauses everything from the bar and says so', async () => {
    mocks.pause.mockResolvedValue({});
    const user = userEvent.setup();
    view(appState());
    expect(screen.getByText('Running')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Take a break' }));
    expect(mocks.pause).toHaveBeenCalledWith(null);
    expect(await screen.findByText('On a break. Nothing goes out in any project until you resume.')).toBeInTheDocument();
  });

  it('stills the river of a paused project and names the one that keeps going', async () => {
    mocks.resumeProject.mockResolvedValue({});
    const user = userEvent.setup();
    const state = appState({ projects: [project({ state: 'paused' }), project({ id: 2, name: 'Payroll' })], people: [person(4, 'Ada Obi')] });
    const { container } = view(state);
    expect(screen.getByText('Reconciliation is paused. Payroll keeps going.')).toBeInTheDocument();
    expect(container.querySelector('.river')).toHaveClass('is-still');
    expect(screen.getByText('Paused')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.resumeProject).toHaveBeenCalledWith(1);
  });

  it('says only that the project is paused when it is the only one', () => {
    view(appState({ projects: [project({ state: 'paused' })] }));
    expect(screen.getByText('Reconciliation is paused.')).toBeInTheDocument();
  });

  it('tags every card with its project once there is more than one', async () => {
    const user = userEvent.setup();
    const people = [replied(1, 'Kemi Eze'), replied(2, 'Femi Adeyemi', { projectId: 2 }), person(4, 'Ada Obi'), person(5, 'Dayo Ige', { projectId: 2 })];
    view(appState({ projects: [project(), project({ id: 2, name: 'Payroll' })], people }));
    // The dock shows replies from both projects, each with its project name.
    expect(screen.getByText('Good morning. 2 people want to talk.')).toBeInTheDocument();
    expect(screen.getAllByText('Payroll').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'List' }));
    const table = screen.getByRole('table');
    // The list starts on the current project and offers the other one as a filter.
    expect(within(table).queryByText('Dayo Ige')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All projects' }));
    expect(within(screen.getByRole('table')).getByText('Dayo Ige')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByText('Payroll').length).toBeGreaterThan(0);
  });

  it('has no project filter with one project', async () => {
    const user = userEvent.setup();
    view(appState({ people: [person(4, 'Ada Obi')] }));
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.queryByRole('button', { name: 'All projects' })).not.toBeInTheDocument();
  });

  it('draws the slots the other screens fill, and nothing when they are empty', async () => {
    const onAddPeople = vi.fn();
    const user = userEvent.setup();
    const { rerender } = view(appState());
    expect(screen.queryByRole('button', { name: 'Add people' })).not.toBeInTheDocument();
    rerender(
      <ToastProvider>
        <Home
          state={appState()}
          project={project()}
          refresh={refresh}
          now={clock}
          incident={<p>LinkedIn needs you</p>}
          quiet={<p>A quiet week</p>}
          onAddPeople={onAddPeople}
          account={{ onWeekly: vi.fn() }}
        />
      </ToastProvider>,
    );
    expect(screen.getByText('LinkedIn needs you')).toBeInTheDocument();
    expect(screen.getByText('A quiet week')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add people' }));
    expect(onAddPeople).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Your account' }));
    expect(screen.getByRole('menuitem', { name: 'Your week, in people' })).toBeInTheDocument();
  });

  it('says where LinkedIn runs', () => {
    view(appState());
    expect(screen.getByText(/Email and LinkedIn are connected\. LinkedIn runs on this computer while Callum is open\./)).toBeInTheDocument();
  });

  it('tells the person when someone replies while the screen is open', async () => {
    const before = appState({ people: [person(4, 'Ada Obi')] });
    const view1 = view(before);
    const after = appState({ people: [replied(4, 'Ada Obi')] });
    view1.rerender(
      <ToastProvider>
        <Home state={after} project={project()} refresh={refresh} now={clock} />
      </ToastProvider>,
    );
    expect(await screen.findByText('Ada replied')).toBeInTheDocument();
  });

  it('keeps a reply that is on its way out of the dock', () => {
    const queued: OutboxItem = {
      id: 3, personId: 1, channel: 'email', kind: 'reply', subject: null, body: 'x', state: 'scheduled', origin: 'user', sendAfter: AT,
      undoUntil: AT, error: null, approvalCounted: false, claimedAt: null, detail: null, createdAt: AT, updatedAt: AT,
    };
    view(appState({ people: [replied(1, 'Kemi Eze')], outbox: [queued] }));
    expect(screen.queryByRole('button', { name: 'Kemi Eze, replied and waiting on you' })).not.toBeInTheDocument();
    expect(screen.getByText("You're all caught up. Callum will tap you when someone replies.")).toBeInTheDocument();
  });

  it('opens the list from a group bubble when the river has too many faces to draw', async () => {
    const user = userEvent.setup();
    const crowd = Array.from({ length: 70 }, (_, i) => person(i + 1, `Person ${i + 1}`, { stage: 'stranger' }));
    view(appState({ people: crowd }));
    await user.click(screen.getByRole('button', { name: '70 people, Strangers' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('puts the cursor on a face card and gives it back to the face on Escape', async () => {
    mocks.person.mockResolvedValue({ person: person(4, 'Ada Obi'), messages: [], path: [] });
    const user = userEvent.setup();
    view(appState({ people: [person(4, 'Ada Obi')] }));
    const face = await screen.findByRole('button', { name: 'Ada Obi, Said hello' });
    await user.click(face);
    const card = await screen.findByRole('dialog', { name: 'Ada Obi' });
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Nudge now' })).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ada Obi, Said hello' })).toHaveFocus());
  });

  it('gives the cursor back to what opened the deck', async () => {
    const user = userEvent.setup();
    view(appState({ people: [replied(1, 'Kemi Eze')] }));
    const open = screen.getByRole('button', { name: 'Open reply' });
    await user.click(open);
    expect(await screen.findByRole('dialog', { name: 'Replies waiting for you' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Replies waiting for you' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Open reply' })).toHaveFocus();
  });

  it('shows five faces at most and counts the rest in one button that opens the deck', async () => {
    const user = userEvent.setup();
    const people = Array.from({ length: 7 }, (_, i) => replied(i + 1, `Person ${i + 1}`));
    view(appState({ people }));
    expect(screen.getAllByRole('button', { name: /replied and waiting on you/ })).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: '2 more people want to talk' }));
    expect(await screen.findByRole('dialog', { name: 'Replies waiting for you' })).toBeInTheDocument();
  });

  it('shows a Day one banner when the app asks for one, and opens Day one from it', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    view(appState({ people: [person(4, 'Ada Obi')] }), { dayOne: { left: 7, onOpen } });
    expect(screen.getByText('7 of 10 hellos left to OK in Reconciliation')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK the hellos' }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('resumes both when the whole of Callum and this project are paused', async () => {
    mocks.resumeAll.mockResolvedValue({});
    mocks.resumeProject.mockResolvedValue({});
    const user = userEvent.setup();
    view(appState({ projects: [project({ state: 'paused' })] }, { pauseState: 'paused' }));
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.resumeAll).toHaveBeenCalled();
    expect(mocks.resumeProject).toHaveBeenCalledWith(1);
  });

  it('keeps a snoozed person out of the dock until the server says they are back', () => {
    const snoozed = person(4, 'Ada Obi', { status: 'snoozed', stage: 'talking', snoozedUntil: '2026-11-02T08:00:00Z', repliedAt: '2026-11-01T08:00:00Z' });
    view(appState({ people: [snoozed] }));
    expect(screen.queryByRole('button', { name: /replied and waiting on you/ })).not.toBeInTheDocument();
  });

  it('lists a snoozed person under Resting', async () => {
    const user = userEvent.setup();
    const snoozed = person(4, 'Ada Obi', { status: 'snoozed', stage: 'talking', snoozedUntil: '2026-11-09T08:00:00Z' });
    view(appState({ people: [snoozed] }));
    await user.click(screen.getByRole('button', { name: 'List' }));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('rowheader', { name: /^Resting/ })).toBeInTheDocument();
    expect(within(table).getByText(/^Back /)).toBeInTheDocument();
  });

  it('does not announce a reply that is only a snooze coming due', () => {
    const snoozed = person(4, 'Ada Obi', { status: 'snoozed', stage: 'talking', snoozedUntil: '2026-11-02T08:00:00Z' });
    const first = view(appState({ people: [snoozed] }));
    first.rerender(
      <ToastProvider>
        <Home state={appState({ people: [replied(4, 'Ada Obi')] })} project={project()} refresh={refresh} now={clock} />
      </ToastProvider>,
    );
    expect(screen.queryByText('Ada replied')).not.toBeInTheDocument();
  });

  it('names the next hello only for hellos Callum sends by itself', () => {
    const out = (id: number, over: Partial<OutboxItem>): OutboxItem => ({
      id, personId: 4, channel: 'email', kind: 'hello', subject: null, body: 'x', state: 'scheduled', origin: 'auto', sendAfter: '2026-11-03T09:00:00Z',
      undoUntil: null, error: null, approvalCounted: false, claimedAt: null, detail: null, createdAt: AT, updatedAt: AT, ...over,
    });
    const people = [person(4, 'Ada Obi')];
    const first = view(appState({ people, outbox: [out(1, { kind: 'reply', origin: 'user', sendAfter: '2026-11-02T10:01:00Z' })] }));
    expect(screen.queryByText(/Next hello goes to/)).not.toBeInTheDocument();
    first.unmount();
    view(appState({ people, outbox: [out(1, { kind: 'reply', origin: 'user', sendAfter: '2026-11-02T10:01:00Z' }), out(2, {})] }));
    expect(screen.getByText('Next hello goes to Ada')).toBeInTheDocument();
  });

  it('lists only the running project when it is the only one', async () => {
    const user = userEvent.setup();
    const people = [person(4, 'Ada Obi'), person(5, 'Old Timer', { projectId: 2 })];
    view(appState({ people, projects: [project(), project({ id: 2, name: 'Old', state: 'wrapped' })] }));
    await user.click(screen.getByRole('button', { name: 'List' }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('Ada Obi')).toBeInTheDocument();
    expect(within(table).queryByText('Old Timer')).not.toBeInTheDocument();
  });

  it('draws the face of the person the brief names, by id', () => {
    const people = [person(4, 'Ada Obi', { linkedinState: 'invited' }), person(5, 'Ada Eze', { linkedinState: 'connected' })];
    const { container } = view(appState({ people, brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: ['Ada'], acceptedIds: [5], nextSendAt: null, line: '' } }));
    expect(screen.getByRole('group', { name: 'Since yesterday' })).toBeInTheDocument();
    const face = container.querySelector('.brief-face') as HTMLElement;
    const probe = (id: number) => {
      const el = document.createElement('div');
      el.style.background = marbleBackground(300 + id);
      return el.style.background;
    };
    expect(face.style.background).toBe(probe(5));
    expect(face.style.background).not.toBe(probe(4));
  });

  it('counts only the replies since yesterday in the pill, and everyone waiting in the line', () => {
    // Kemi wrote three days ago and still waits; Femi and Temi wrote this morning.
    const people = [replied(1, 'Kemi Eze', { repliedAt: '2026-10-30T09:00:00Z' }), replied(2, 'Femi Adeyemi'), replied(3, 'Temi Bello')];
    view(appState({ people, brief: { wantToTalk: 3, sentYesterday: 0, acceptedRecently: [], acceptedIds: [], nextSendAt: null, line: '' } }));
    expect(screen.getByText('Good morning. 3 people want to talk.')).toBeInTheDocument();
    expect(screen.getByText('2 new replies')).toBeInTheDocument();
    expect(screen.queryByText(/want to talk$/, { selector: '.brief-pill' })).not.toBeInTheDocument();
  });

  it('says one new reply in the singular, and shows no pill when everyone waiting wrote before yesterday', () => {
    const one = [replied(1, 'Kemi Eze'), replied(2, 'Femi Adeyemi', { repliedAt: '2026-10-29T09:00:00Z' })];
    const first = view(appState({ people: one, brief: { wantToTalk: 2, sentYesterday: 0, acceptedRecently: [], acceptedIds: [], nextSendAt: null, line: '' } }));
    expect(screen.getByText('1 new reply')).toBeInTheDocument();
    first.unmount();
    const old = [replied(1, 'Kemi Eze', { repliedAt: '2026-10-29T09:00:00Z' })];
    view(appState({ people: old, brief: { wantToTalk: 1, sentYesterday: 0, acceptedRecently: [], acceptedIds: [], nextSendAt: null, line: '' } }));
    expect(screen.getByText('Good morning. 1 person wants to talk.')).toBeInTheDocument();
    expect(screen.queryByText(/new repl/)).not.toBeInTheDocument();
  });
});
