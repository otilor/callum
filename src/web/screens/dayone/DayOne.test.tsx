import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, OutboxItem, Person, Project } from '../../../shared/types.js';
import { DayOne } from './DayOne.js';

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  skip: vi.fn(),
  undo: vi.fn(),
  settings: vi.fn(),
}));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const NOW = new Date('2026-11-02T10:00:00Z');
const SLOT = '2026-11-03T08:00:00.000Z'; // Tuesday 9:00 in Lagos

const NAMES = ['Kemi Eze', 'Tunde Bello', 'Ada Nwosu', 'Femi Adeyemi'];

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1, name: 'Reconciliation', offer: 'You help fintech teams.', audience: null, tone: 'warm', sample: null, calendarUrl: null,
    approvalsLeft: 10, startedAt: NOW.toISOString(), state: 'running', pausedUntil: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...over,
  };
}

function person(id: number, name: string, over: Partial<Person> = {}): Person {
  return {
    id, projectId: 1, name, firstName: name.split(' ')[0] ?? name, company: 'Oko Pay', role: 'Founder', email: `p${id}@okopay.com`, linkedinUrl: null, xHandle: null,
    timezone: null, channel: 'email', stage: 'stranger', status: 'active', touches: 0, lastTouchAt: null, nextTouchAt: SLOT, linkedinState: 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, source: 'paste', note: null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...over,
  };
}

function item(id: number, personId: number, body: string, over: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id, personId, channel: 'email', kind: 'hello', subject: null, body, state: 'awaiting_ok', origin: 'auto', sendAfter: SLOT, undoUntil: null, error: null,
    approvalCounted: false, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...over,
  };
}

function appState(over: Partial<AppState> = {}): AppState {
  const people = NAMES.map((n, i) => person(i + 1, n));
  return {
    settings: { senderName: null, senderEmail: 'gabriel@yourcompany.com', timezone: 'Africa/Lagos', onboarded: true, currentProjectId: 1, pauseState: 'running', pausedUntil: null, notifications: null },
    projects: [project({ approvalsLeft: 7 })],
    channels: [],
    people,
    outbox: people.map((p, i) => item(100 + i, p.id, `Hi ${p.firstName}, would a quick chat be useful?`)),
    incidents: [],
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], nextSendAt: SLOT, line: '' },
    demo: false,
    ...over,
  };
}

const refresh = vi.fn(() => Promise.resolve());
const onLeave = vi.fn();

function setup(state: AppState = appState()) {
  const user = userEvent.setup();
  const current = state.projects[0]!;
  const view = render(<DayOne state={state} project={current} refresh={refresh} now={() => NOW} onLeave={onLeave} />);
  return { user, ...view };
}

beforeEach(() => {
  mocks.approve.mockResolvedValue(item(100, 1, 'x', { state: 'scheduled', undoUntil: new Date(NOW.getTime() + 10_000).toISOString() }));
  mocks.skip.mockResolvedValue(item(100, 1, 'x', { state: 'cancelled' }));
  mocks.undo.mockResolvedValue(item(100, 1, 'x'));
  mocks.settings.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('DayOne', () => {
  it('asks for the first 10 hellos and shows the first message', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'OK the first 10 hellos' })).toBeInTheDocument();
    expect(screen.getByText('After these, Callum runs on its own.')).toBeInTheDocument();
    expect(screen.getByText('Starts tomorrow at 9:00')).toBeInTheDocument();
    expect(screen.getByText('Kemi Eze')).toBeInTheDocument();
    expect(screen.getByText('Founder at Oko Pay')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Message to Kemi/ })).toHaveValue('Hi Kemi, would a quick chat be useful?');
    expect(screen.getByText('Click the message to change any words.')).toBeInTheDocument();
    expect(screen.getByText('7 left')).toBeInTheDocument();
  });

  it('says where replies land and that it is normal to wait', () => {
    setup();
    expect(screen.getByText(/Replies land here\./)).toBeInTheDocument();
    expect(screen.getByText(/It's normal for this/)).toBeInTheDocument();
  });

  it('sends an edited message with the OK and says Callum learns from it', async () => {
    const { user } = setup();
    const box = screen.getByRole('textbox', { name: /Message to Kemi/ });
    await user.clear(box);
    await user.type(box, 'edited text');
    expect(screen.getByText('Edited. Callum learns from this.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(100, 'edited text'));
    expect(refresh).toHaveBeenCalled();
    expect(await screen.findByText("Kemi's hello goes out tomorrow at 9:00")).toBeInTheDocument();
  });

  it('approves an unedited message without sending the text again', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(100, undefined));
  });

  it('moves on to the next person after an OK', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByText('Tunde Bello')).toBeInTheDocument();
    expect(screen.queryByText('Kemi Eze')).not.toBeInTheDocument();
    expect(screen.getByText('6 left')).toBeInTheDocument();
  });

  it('undoes an OK from the toast', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mocks.undo).toHaveBeenCalledWith(100));
    expect(await screen.findByText('Kemi Eze')).toBeInTheDocument();
    expect(screen.getByText('Not sent. Nothing went to Kemi.')).toBeInTheDocument();
  });

  it('says so when Undo comes too late', async () => {
    mocks.undo.mockRejectedValue(new Error('Already sent'));
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText("Too late. Kemi's hello already went out.")).toBeInTheDocument();
  });

  it('puts the cursor in the next message after an OK', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    const next = await screen.findByRole('textbox', { name: /Message to Tunde/ });
    await waitFor(() => expect(next).toHaveFocus());
  });

  it('keeps See your river off while the last OK can still be undone', async () => {
    const { user } = setup(appState({ projects: [project({ approvalsLeft: 1 })], outbox: [item(100, 1, 'Hi Kemi')] }));
    await user.click(screen.getByRole('button', { name: 'OK' }));
    const go = await screen.findByRole('button', { name: 'See your river' });
    expect(go).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mocks.undo).toHaveBeenCalled());
  });

  it('says their time only when the person has a time zone of their own', async () => {
    const people = [person(1, 'Kemi Eze', { timezone: 'Europe/London' })];
    const { user } = setup(appState({ people, outbox: [item(100, 1, 'Hi Kemi')], projects: [project({ approvalsLeft: 5 })] }));
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByText(/Kemi's hello goes out .* their time/)).toBeInTheDocument();
  });

  it('does not count a wrapped project as company', () => {
    setup(appState({ projects: [project({ approvalsLeft: 7 }), project({ id: 2, name: 'Old', state: 'wrapped' })] }));
    expect(screen.getByText('7 left')).toBeInTheDocument();
  });

  it('can go back to Home while hellos are still waiting', async () => {
    const onBack = vi.fn();
    const state = appState();
    const user = userEvent.setup();
    render(<DayOne state={state} project={state.projects[0]!} refresh={refresh} now={() => NOW} onLeave={onLeave} onBack={onBack} />);
    await user.click(screen.getByRole('button', { name: 'Back to the river' }));
    expect(onBack).toHaveBeenCalled();
  });

  it("leaves a person alone with Don't contact", async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: "Don't contact" }));
    await waitFor(() => expect(mocks.skip).toHaveBeenCalledWith(100));
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(await screen.findByText("Callum won't contact Kemi")).toBeInTheDocument();
    expect(await screen.findByText('Tunde Bello')).toBeInTheDocument();
  });

  it('shows what went wrong when the OK does not go through', async () => {
    mocks.approve.mockRejectedValueOnce(new Error('Callum can not reach the server.'));
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByText('Callum can not reach the server.')).toBeInTheDocument();
    expect(screen.getByText('Kemi Eze')).toBeInTheDocument();
  });

  it("says That's all 10 once nothing is left, and the hour Callum starts", () => {
    setup(appState({ outbox: [], projects: [project({ approvalsLeft: 0 })], brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], nextSendAt: SLOT, line: '' } }));
    expect(screen.getByRole('heading', { name: "That's all 10" })).toBeInTheDocument();
    expect(screen.getByText('From tomorrow at 9:00, Callum runs on its own.')).toBeInTheDocument();
    expect(screen.getByText('Want a tap when someone replies?')).toBeInTheDocument();
  });

  it('turns notifications on after the browser agrees', async () => {
    const request = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { requestPermission: request, permission: 'default' }));
    const empty = appState({ outbox: [], projects: [project({ approvalsLeft: 0 })] });
    const { user } = setup(empty);
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(mocks.settings).toHaveBeenCalledWith({ notifications: true }));
    expect(request).toHaveBeenCalled();
    expect(await screen.findByText("Done. You'll get a tap the moment someone replies.")).toBeInTheDocument();
    expect(screen.queryByText('Want a tap when someone replies?')).not.toBeInTheDocument();
  });

  it('does not turn notifications on when the browser says no', async () => {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { requestPermission: vi.fn().mockResolvedValue('denied'), permission: 'default' }));
    const { user } = setup(appState({ outbox: [], projects: [project({ approvalsLeft: 0 })] }));
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('Okay. Replies will wait for you right here.')).toBeInTheDocument();
    expect(mocks.settings).not.toHaveBeenCalledWith({ notifications: true });
  });

  it('lets the person decline the tap', async () => {
    const { user } = setup(appState({ outbox: [], projects: [project({ approvalsLeft: 0 })] }));
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('Okay. Replies will wait for you right here.')).toBeInTheDocument();
    expect(mocks.settings).toHaveBeenCalledWith({ notifications: false });
  });

  it('goes to the river from the done screen', async () => {
    const { user } = setup(appState({ outbox: [], projects: [project({ approvalsLeft: 0 })] }));
    await user.click(screen.getByRole('button', { name: 'See your river' }));
    expect(onLeave).toHaveBeenCalled();
  });

  it('names the project only when there is more than one', () => {
    const payroll = project({ id: 2, name: 'Payroll', approvalsLeft: 7 });
    const state = appState({
      projects: [project({ approvalsLeft: 10 }), payroll],
      people: [person(1, 'Kemi Eze'), person(5, 'Yaw Mensah', { projectId: 2 })],
      outbox: [item(100, 1, 'Hi Kemi'), item(105, 5, 'Hi Yaw')],
    });
    render(<DayOne state={state} project={payroll} refresh={refresh} now={() => NOW} onLeave={onLeave} />);
    expect(screen.getByText('7 of 10 hellos left to OK in Payroll')).toBeInTheDocument();
    expect(screen.getByText('Yaw Mensah')).toBeInTheDocument();
    expect(screen.queryByText('Kemi Eze')).not.toBeInTheDocument();
    const river = screen.getByRole('group', { name: 'Your river' });
    expect(within(river).getAllByRole('img')).toHaveLength(1);
  });

  it('puts only the current project into the river', () => {
    setup();
    const river = screen.getByRole('group', { name: 'Your river' });
    expect(within(river).getAllByRole('img')).toHaveLength(4);
    expect(within(river).getByRole('img', { name: 'Kemi Eze, Strangers' })).toBeInTheDocument();
  });

  it('shows an invite note for a LinkedIn hello', () => {
    const state = appState();
    state.people[0] = person(1, 'Kemi Eze', { channel: 'linkedin' });
    state.outbox[0] = item(100, 1, 'Hi Kemi, I would love to connect.', { channel: 'linkedin', kind: 'invite' });
    setup(state);
    expect(screen.getByText('LinkedIn')).toBeInTheDocument();
    expect(screen.getByText('Invite note, tomorrow at 9:00')).toBeInTheDocument();
  });
});
