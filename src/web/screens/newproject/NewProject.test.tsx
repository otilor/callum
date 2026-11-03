import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddCommit, AddPreview, AppState, ChannelAccount, Person, PreviewPerson, Project } from '../../../shared/types.js';
import { ApiError } from '../../api.js';
import { ToastProvider } from '../../ui/Toast.js';
import { NewProject } from './NewProject.js';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  updateProject: vi.fn(),
  start: vi.fn(),
  setCurrentProject: vi.fn(),
  preview: vi.fn(),
  commit: vi.fn(),
  undo: vi.fn(),
  describe: vi.fn(),
  sample: vi.fn(),
  discardProject: vi.fn(),
}));
vi.mock('../../api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../api.js')>();
  const { createProject, updateProject, start, setCurrentProject, ...people } = mocks;
  return { ...real, api: { ...real.api, createProject, updateProject, start, setCurrentProject }, peopleApi: people };
});

const MONDAY = new Date('2026-11-02T10:00:00Z');
const FRIDAY = new Date('2026-11-06T10:00:00Z');

function channel(ch: ChannelAccount['channel'], status: ChannelAccount['status']): ChannelAccount {
  return { channel: ch, status, identity: status === 'connected' ? 'x' : null, connectedAt: null, pausedUntil: null, halfPaceUntil: null, invitesBlockedUntil: null, lastPolledAt: null };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1, name: 'Reconciliation', offer: 'You help fintech teams', audience: null, tone: 'warm', sample: null, calendarUrl: null, approvalsLeft: 0,
    startedAt: MONDAY.toISOString(), state: 'running', pausedUntil: null, createdAt: MONDAY.toISOString(), updatedAt: MONDAY.toISOString(), ...over,
  };
}

function appState(over: Partial<AppState> = {}): AppState {
  return {
    settings: { senderName: 'Ada', senderEmail: 'ada@example.com', timezone: 'Africa/Lagos', onboarded: true, currentProjectId: 1, pauseState: 'running', pausedUntil: null, notifications: null, morningBrief: true },
    projects: [project()],
    channels: [channel('email', 'connected'), channel('linkedin', 'connected'), channel('x', 'disconnected')],
    people: [], outbox: [], incidents: [], demo: false, canFind: false, claudeEngine: null, claudeConnected: false, auth: { password: false },
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], acceptedIds: [], nextSendAt: null, line: '' },
    ...over,
  };
}

function previewPerson(key: string, name: string, over: Partial<PreviewPerson> = {}): PreviewPerson {
  return { key, name, firstName: name.split(' ')[0] ?? name, projectId: 0, source: 'paste', email: `${key}@example.com`, company: 'Kumasi Foods', role: 'Head of People', ...over };
}

function person(id: number, name: string): Person {
  return {
    id, projectId: 2, name, firstName: name.split(' ')[0] ?? name, company: 'Kumasi Foods', role: null, email: `p${id}@example.com`, linkedinUrl: null, xHandle: null,
    timezone: null, channel: 'email', stage: 'stranger', status: 'active', touches: 0, lastTouchAt: null, nextTouchAt: null, linkedinState: 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, source: 'paste', note: null,
    createdAt: MONDAY.toISOString(), updatedAt: MONDAY.toISOString(),
  };
}

const THREE: AddPreview = {
  batchId: 'batch-1',
  added: [previewPerson('0', 'Yaw Mensah'), previewPerson('1', 'Efua Boateng'), previewPerson('2', 'Kwame Asante')],
  groups: [{ reason: 'other_project', line: '1 is already in Reconciliation', names: ['Kemi Eze'], projectName: 'Reconciliation' }],
};

const OFFER = 'You help growing teams run payroll without spreadsheets.';

function show(opts: { state?: AppState; now?: Date } = {}) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const onOpen = vi.fn();
  render(
    <ToastProvider>
      <NewProject state={opts.state ?? appState()} refresh={refresh} onClose={onClose} onOpen={onOpen} now={() => opts.now ?? MONDAY} />
    </ToastProvider>,
  );
  return { refresh, onClose, onOpen };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.sample.mockResolvedValue({ body: 'Hi Yaw, I help growing teams run payroll without spreadsheets. Would a quick chat help?', to: { name: 'Yaw Mensah', company: 'Kumasi Foods' } });
});

async function writeOffer(user: ReturnType<typeof userEvent.setup>, text = OFFER) {
  await user.click(screen.getByLabelText('What you offer, in one line'));
  await user.paste(text);
}

async function toPeople(user: ReturnType<typeof userEvent.setup>) {
  await writeOffer(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

async function pasteThree(user: ReturnType<typeof userEvent.setup>) {
  mocks.preview.mockResolvedValue(THREE);
  await user.click(screen.getByRole('tab', { name: 'Paste names' }));
  await user.click(screen.getByLabelText(/One person per line/));
  await user.paste('Yaw Mensah, yaw@kumasifoods.com\nEfua Boateng, efua@osuhealth.com\nKwame Asante, kwame@temacables.com');
  await user.click(screen.getByRole('button', { name: 'Read the names' }));
  await screen.findByText('3 people join Payroll');
}

describe('NewProject, the offer', () => {
  it('asks what you offer and holds Next until there is a line', async () => {
    const user = userEvent.setup();
    show();
    expect(screen.getByRole('heading', { name: 'What do you offer?' })).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Reconciliation keeps going')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Write one line about what you offer first.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'What do you offer?' })).toBeInTheDocument();
    await writeOffer(user);
    expect(screen.getByText('Callum will call this')).toBeInTheDocument();
    expect(screen.getByText('Payroll', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'false');
  });

  it('fills in the Payroll example', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: 'Try the Payroll example' }));
    expect(screen.getByLabelText('What you offer, in one line')).toHaveValue('You help growing teams in Lagos and Accra run payroll without spreadsheets.');
    expect(screen.getByText('Payroll', { selector: 'strong' })).toBeInTheDocument();
  });

  it('renames the project, and refuses a name that is taken', async () => {
    const user = userEvent.setup();
    show({ state: appState({ projects: [project({ name: 'Payroll' })] }) });
    await writeOffer(user);
    // The suggested name is taken: say so, and hold Next.
    expect(screen.getByRole('alert')).toHaveTextContent('You already have a project called Payroll. Nothing has started yet. Pick another name.');
    expect(screen.getByText('Pick another name to continue.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rename this project' }));
    const input = screen.getByLabelText('Project name');
    await user.clear(input);
    await user.type(input, 'payroll');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('You already have a project called Payroll.');
    await user.clear(input);
    await user.type(input, 'Payroll for Accra{Enter}');
    expect(screen.getByText('Payroll for Accra', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'false');
  });

  it('keeps the suggested name when the new one is left empty', async () => {
    const user = userEvent.setup();
    show();
    await writeOffer(user);
    await user.click(screen.getByRole('button', { name: 'Rename this project' }));
    await user.clear(screen.getByLabelText('Project name'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('A project needs a name. Callum kept "Payroll". Type a name to save.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Payroll', { selector: 'strong' })).toBeInTheDocument();
  });

  it('closes back to the project it came from', async () => {
    const user = userEvent.setup();
    const { onClose } = show();
    await user.click(screen.getByRole('button', { name: 'Back to Reconciliation' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('NewProject, who to meet', () => {
  it('reuses the four ways, previews for a project that does not exist yet, and says who is in another project', async () => {
    const user = userEvent.setup();
    show();
    await toPeople(user);
    expect(screen.getByRole('heading', { name: 'Who should Callum meet?' })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    ['Describe who', 'Drop a CSV', 'Paste names', 'LinkedIn search link'].forEach((n, i) => expect(tabs[i]).toHaveAccessibleName(n));
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Describe someone, or bring a list, to continue.')).toBeInTheDocument();

    await pasteThree(user);
    expect(mocks.preview).toHaveBeenCalledWith({ paste: expect.stringContaining('Yaw Mensah'), projectId: null });
    await user.click(screen.getByRole('button', { name: /is already in Reconciliation/ }));
    expect(screen.getByText(/Kemi Eze is in Reconciliation\. Each person belongs to one project, so they stay there\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'These 3 look right' })).toHaveAttribute('aria-disabled', 'false');
  });

  it('leaves someone out with Not a fit', async () => {
    const user = userEvent.setup();
    show();
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: /Efua Boateng/ }));
    await user.click(screen.getByRole('button', { name: 'Not a fit' }));
    expect(screen.getByText('Efua stays out of Payroll')).toBeInTheDocument();
    expect(screen.getByText('2 people join Payroll')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'These 2 look right' })).toBeInTheDocument();
  });

  it('goes back to the offer and forward again without losing the list', async () => {
    const user = userEvent.setup();
    show();
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('What you offer, in one line')).toHaveValue(OFFER);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('3 people join Payroll')).toBeInTheDocument();
  });
});

describe('NewProject, the voice and Start', () => {
  async function toVoice(user: ReturnType<typeof userEvent.setup>) {
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    await screen.findByRole('heading', { name: 'How should you sound?' });
  }

  it('shows a sample in each tone, written to the first person, and the channels the project shares', async () => {
    const user = userEvent.setup();
    show();
    await toVoice(user);
    expect(await screen.findByDisplayValue(/Hi Yaw, I help growing teams run payroll/)).toBeInTheDocument();
    expect(mocks.sample).toHaveBeenCalledWith({ offer: OFFER, tone: 'warm', batchId: 'batch-1', key: '0' });
    expect(screen.getByText('A first hello to Yaw Mensah at Kumasi Foods')).toBeInTheDocument();
    expect(screen.getByText('Payroll sounds Warm. Each project has its own voice.')).toBeInTheDocument();
    expect(screen.getByText('Uses your mailbox and LinkedIn. Their daily limits are shared with Reconciliation.')).toBeInTheDocument();

    mocks.sample.mockResolvedValue({ body: 'Hi Yaw, worth fifteen minutes this week?', to: { name: 'Yaw Mensah', company: 'Kumasi Foods' } });
    await user.click(screen.getByRole('button', { name: 'Direct' }));
    expect(await screen.findByDisplayValue('Hi Yaw, worth fifteen minutes this week?')).toBeInTheDocument();
    expect(mocks.sample).toHaveBeenLastCalledWith({ offer: OFFER, tone: 'direct', batchId: 'batch-1', key: '0' });
    expect(screen.getByText('Payroll sounds Direct. Each project has its own voice.')).toBeInTheDocument();
  });

  it('creates the project, adds the people and starts it, then says when the first hellos need an OK', async () => {
    const user = userEvent.setup();
    const { refresh, onOpen } = show();
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll', offer: OFFER, startedAt: null, approvalsLeft: 10 }));
    mocks.updateProject.mockImplementation(async (_id: number, patch: Partial<Project>) => project({ id: 2, name: 'Payroll', offer: OFFER, ...patch }));
    const added: AddCommit = { added: [person(21, 'Yaw Mensah'), person(22, 'Efua Boateng'), person(23, 'Kwame Asante')], line: '3 people join the river. First hellos from tomorrow at 9:00.', groups: [] };
    mocks.commit.mockResolvedValue(added);
    mocks.start.mockResolvedValue({ firstSendAt: '2026-11-03T08:00:00.000Z' });
    mocks.setCurrentProject.mockResolvedValue({});
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    await screen.findByDisplayValue(/Hi Yaw/);
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));

    expect(await screen.findByRole('heading', { name: 'Payroll is ready' })).toBeInTheDocument();
    expect(mocks.createProject).toHaveBeenCalledWith({ offer: OFFER, name: 'Payroll', tone: 'warm' });
    expect(mocks.commit).toHaveBeenCalledWith({ batchId: 'batch-1', projectId: 2, drop: [] });
    expect(mocks.start).toHaveBeenCalledWith(2);
    expect(mocks.createProject.mock.invocationCallOrder[0]).toBeLessThan(mocks.commit.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.commit.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0] ?? 0);
    expect(screen.getByText("You'll OK the first 10 hellos tomorrow from 9:00.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'See Payroll at home' }));
    expect(mocks.setCurrentProject).toHaveBeenCalledWith(2);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 2, name: 'Payroll' })));
  });

  it('says Monday over a weekend', async () => {
    const user = userEvent.setup();
    show({ now: FRIDAY });
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll', startedAt: null }));
    mocks.commit.mockResolvedValue({ added: [person(21, 'Yaw Mensah')], line: '', groups: [] });
    mocks.start.mockResolvedValue({ firstSendAt: '2026-11-09T08:00:00.000Z' });
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    expect(await screen.findByText("You'll OK the first 10 hellos Monday from 9:00.")).toBeInTheDocument();
  });

  it('sends the tone, the words the person changed, the description as the audience, and who was left out', async () => {
    const user = userEvent.setup();
    show();
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll', startedAt: null }));
    mocks.updateProject.mockImplementation(async (_id: number, patch: Partial<Project>) => project({ id: 2, name: 'Payroll', ...patch }));
    mocks.commit.mockResolvedValue({ added: [person(21, 'Yaw Mensah')], line: '', groups: [] });
    mocks.start.mockResolvedValue({ firstSendAt: '2026-11-03T08:00:00.000Z' });
    mocks.describe.mockResolvedValue({
      batchId: 'web-batch', total: 2, narrow: null, line: 'Callum found 2',
      people: [
        previewPerson('a1', 'Yaw Mensah', { firstName: 'Yaw', source: 'web' }), previewPerson('a2', 'Efua Boateng', { firstName: 'Efua', source: 'web' }),
      ],
    });
    await toPeople(user);
    await user.type(screen.getByLabelText('Describe who you want to meet'), 'heads of people in Accra{Enter}');
    expect(mocks.describe).toHaveBeenCalledWith({ query: 'heads of people in Accra', filters: [], projectId: null });
    await screen.findByText('2 people join Payroll');
    expect(screen.queryByText(/credit/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Efua Boateng, Head of People at Kumasi Foods' }));
    await user.click(screen.getByRole('button', { name: 'Not a fit' }));
    await user.click(screen.getByRole('button', { name: 'These 1 look right' }));

    await user.click(screen.getByRole('button', { name: 'Playful' }));
    const draft = await screen.findByLabelText(/First message to/);
    await user.clear(draft);
    await user.type(draft, 'Hi Yaw, who dreads the last Friday of the month?');
    expect(screen.getByText('Callum will use your words.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));

    await screen.findByRole('heading', { name: 'Payroll is ready' });
    expect(mocks.createProject).toHaveBeenCalledWith({ offer: OFFER, name: 'Payroll', tone: 'playful', audience: 'heads of people in Accra' });
    expect(mocks.updateProject).toHaveBeenCalledWith(2, { sample: 'Hi Yaw, who dreads the last Friday of the month?' });
    expect(mocks.commit).toHaveBeenCalledWith({ batchId: 'web-batch', projectId: 2, drop: ['a2'] });
  });

  it('shows no cost line on the ready screen', async () => {
    const user = userEvent.setup();
    show();
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll', startedAt: null }));
    mocks.commit.mockResolvedValue({
      added: [person(21, 'Yaw Mensah')], groups: [],
      line: '1 person joins the river. First hellos from tomorrow at 9:00.',
    });
    mocks.start.mockResolvedValue({ firstSendAt: '2026-11-03T08:00:00.000Z' });
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    expect(await screen.findByRole('heading', { name: 'Payroll is ready' })).toBeInTheDocument();
    expect(screen.queryByText(/credit/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('carries on from where it stopped when Start fails, without making the project twice', async () => {
    const user = userEvent.setup();
    show();
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll', offer: OFFER, startedAt: null }));
    mocks.commit.mockResolvedValue({ added: [person(21, 'Yaw Mensah')], line: '', groups: [] });
    mocks.start.mockRejectedValueOnce(new ApiError(422, 'Connect a channel first'));
    mocks.start.mockResolvedValueOnce({ firstSendAt: '2026-11-03T08:00:00.000Z' });
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connect a channel first');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    expect(await screen.findByRole('heading', { name: 'Payroll is ready' })).toBeInTheDocument();
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it('shows the duplicate-name error from the server and lets the person rename', async () => {
    const user = userEvent.setup();
    show();
    mocks.createProject.mockRejectedValueOnce(new ApiError(422, 'You already have a project called Payroll. Pick another name.'));
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a project called Payroll. Pick another name.');
    expect(mocks.commit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Rename this project' }));
    const input = screen.getByLabelText('Project name');
    await user.clear(input);
    await user.type(input, 'Payroll Ghana{Enter}');
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll Ghana', startedAt: null }));
    expect(screen.getByText('Payroll Ghana', { selector: 'strong' })).toBeInTheDocument();
  });

  it('says so, and creates nothing, when no channel is connected', async () => {
    const user = userEvent.setup();
    show({ state: appState({ channels: [channel('email', 'disconnected'), channel('linkedin', 'disconnected'), channel('x', 'disconnected')] }) });
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    expect(screen.getByText('No channel is connected yet. Connect one in Your Callum before you start.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Connect a channel first.');
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('goes back to the list when nobody new joined, and removes the empty project', async () => {
    const user = userEvent.setup();
    const { refresh } = show();
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll', startedAt: null }));
    mocks.discardProject.mockResolvedValue({ discarded: true });
    mocks.commit.mockResolvedValue({ added: [], line: 'Nobody new joined.', groups: [{ reason: 'duplicate', line: '3 already in Callum', names: ['A', 'B', 'C'] }] });
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nobody new joined Payroll. Choose another list or search to go on.');
    expect(screen.getByRole('heading', { name: 'Who should Callum meet?' })).toBeInTheDocument();
    expect(mocks.discardProject).toHaveBeenCalledWith(2);
    expect(refresh).toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();

    // The next try makes a fresh project rather than leaning on the one that was removed.
    mocks.commit.mockResolvedValue({ added: [person(21, 'Yaw Mensah')], line: '', groups: [] });
    mocks.start.mockResolvedValue({ firstSendAt: '2026-11-03T08:00:00.000Z' });
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    await screen.findByRole('heading', { name: 'Payroll is ready' });
    expect(mocks.createProject).toHaveBeenCalledTimes(2);
  });

  it('removes the project it made when the person closes after a failed try of any kind', async () => {
    const user = userEvent.setup();
    const { refresh, onClose } = show();
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll', startedAt: null }));
    mocks.discardProject.mockResolvedValue({ discarded: true });
    // Not a 410: the server fell over while the people were being added.
    mocks.commit.mockRejectedValue(new ApiError(500, 'Something went wrong. Callum kept everything as it was.'));
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(mocks.discardProject).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^(Close|Back to)/ }));
    expect(mocks.discardProject).toHaveBeenCalledWith(2);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });

  it('closes without touching anything when no project was made', async () => {
    const user = userEvent.setup();
    const { onClose } = show();
    await user.click(screen.getByRole('button', { name: /^(Close|Back to)/ }));
    expect(mocks.discardProject).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('puts the cursor on the heading of each question as it opens', async () => {
    const user = userEvent.setup();
    show();
    expect(screen.getByRole('heading', { name: 'What do you offer?' })).toHaveFocus();
    await toPeople(user);
    expect(screen.getByRole('heading', { name: 'Who should Callum meet?' })).toHaveFocus();
  });

  it('goes on to start when the project already has people from an earlier try', async () => {
    const user = userEvent.setup();
    show();
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll', startedAt: null }));
    mocks.discardProject.mockResolvedValue({ discarded: false });
    mocks.commit.mockResolvedValue({ added: [], line: 'Nobody new joined.', groups: [{ reason: 'other_project', line: '3 are already in Payroll', names: ['A', 'B', 'C'], projectName: 'Payroll' }] });
    mocks.start.mockResolvedValue({ firstSendAt: '2026-11-03T08:00:00.000Z' });
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    await screen.findByRole('heading', { name: 'Payroll is ready' });
    expect(mocks.start).toHaveBeenCalledWith(2);
  });

  it('reads the list again and adds the same people when Callum had forgotten it', async () => {
    const user = userEvent.setup();
    show();
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll', startedAt: null }));
    mocks.commit.mockRejectedValueOnce(new ApiError(410, 'That list is no longer here. Bring it again.'));
    mocks.commit.mockResolvedValueOnce({ added: [person(21, 'Yaw Mensah')], line: '', groups: [] });
    mocks.start.mockResolvedValue({ firstSendAt: '2026-11-03T08:00:00.000Z' });
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    mocks.preview.mockResolvedValue({ ...THREE, batchId: 'batch-2' });
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    await screen.findByRole('heading', { name: 'Payroll is ready' });
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(mocks.commit).toHaveBeenNthCalledWith(1, { batchId: 'batch-1', projectId: 2, drop: [] });
    expect(mocks.commit).toHaveBeenNthCalledWith(2, { batchId: 'batch-2', projectId: 2, drop: [] });
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
  });

  it('goes back to choosing who to meet, in plain words, when the list cannot be read again', async () => {
    const user = userEvent.setup();
    show();
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll', startedAt: null }));
    mocks.commit.mockRejectedValue(new ApiError(410, 'That list is no longer here. Bring it again.'));
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    mocks.preview.mockRejectedValue(new ApiError(422, 'Callum could not read that.'));
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Callum lost that list while you were setting up. Choose who to meet again.');
    expect(screen.getByRole('heading', { name: 'Who should Callum meet?' })).toBeInTheDocument();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('shows people found by description with no cost line beside Start', async () => {
    const user = userEvent.setup();
    show();
    mocks.describe.mockResolvedValue({
      batchId: 'web-batch', total: 2, narrow: null, line: 'Callum found 2',
      people: [previewPerson('a1', 'Yaw Mensah', { firstName: 'Yaw', source: 'web' }), previewPerson('a2', 'Efua Boateng', { firstName: 'Efua', source: 'web' })],
    });
    await toPeople(user);
    await user.type(screen.getByLabelText('Describe who you want to meet'), 'heads of people{Enter}');
    await user.click(await screen.findByRole('button', { name: 'These 2 look right' }));
    expect(screen.getByRole('heading', { name: 'How should you sound?' })).toBeInTheDocument();
    expect(screen.queryByText(/credit/i)).toBeNull();
  });

  it('starts another project from the ready screen', async () => {
    const user = userEvent.setup();
    show();
    mocks.createProject.mockResolvedValue(project({ id: 2, name: 'Payroll', startedAt: null }));
    mocks.commit.mockResolvedValue({ added: [person(21, 'Yaw Mensah')], line: '', groups: [] });
    mocks.start.mockResolvedValue({ firstSendAt: '2026-11-03T08:00:00.000Z' });
    await toPeople(user);
    await pasteThree(user);
    await user.click(screen.getByRole('button', { name: 'These 3 look right' }));
    await user.click(screen.getByRole('button', { name: 'Start Payroll' }));
    await user.click(await screen.findByRole('button', { name: 'Start another project' }));
    expect(screen.getByRole('heading', { name: 'What do you offer?' })).toBeInTheDocument();
    expect(screen.getByLabelText('What you offer, in one line')).toHaveValue('');
    const river = document.querySelector('.np-river');
    expect(river).not.toBeNull();
    expect(within(screen.getByRole('main')).queryByText('Payroll is ready')).toBeNull();
  });
});
