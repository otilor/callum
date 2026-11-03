import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Channel, ChannelAccount, OutboxItem, Person, Project } from '../../../shared/types.js';
import { ApiError, type ClaudeInfo } from '../../api.js';
import { ToastProvider } from '../../ui/Toast.js';
import type { CallumDesktop } from '../../../shared/desktop.js';
import { YourCallum, disconnectText, type YourCallumProps } from './YourCallum.js';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  updateProject: vi.fn(),
  sample: vi.fn(),
  channelSummary: vi.fn(),
  disconnect: vi.fn(),
  pauseProject: vi.fn(),
  resumeProject: vi.fn(),
  wrapProject: vi.fn(),
  connect: vi.fn(),
  exportJsonUrl: (projectId?: number) => (projectId ? `/api/export.json?projectId=${projectId}` : '/api/export.json'),
  exportCsvUrl: (projectId?: number) => (projectId ? `/api/export.csv?projectId=${projectId}` : '/api/export.csv'),
  setup: vi.fn(),
  saveClientId: vi.fn(),
  saveClaude: vi.fn(),
  removeClaude: vi.fn(),
  claudeInfo: vi.fn(),
}));
vi.mock('../../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api.js')>()),
  api: mocks,
  channelSetup: { microsoft: mocks.setup, saveMicrosoftClientId: mocks.saveClientId },
  claudeKeyApi: { save: mocks.saveClaude, remove: mocks.removeClaude, info: mocks.claudeInfo },
}));

const NOW = new Date('2026-11-02T10:00:00Z');
const refresh = vi.fn(() => Promise.resolve());
const download = vi.fn();

function desktopBridge(over: Partial<CallumDesktop> = {}): CallumDesktop {
  return { isDesktop: true, version: '0.1.0', platform: 'linux', setOpenAtLogin: vi.fn().mockResolvedValue(false), getOpenAtLogin: vi.fn().mockResolvedValue(false), ...over };
}

function channel(ch: Channel, status: ChannelAccount['status'] = 'disconnected', identity: string | null = null): ChannelAccount {
  return { channel: ch, status, identity, connectedAt: '2026-10-20T09:00:00.000Z', pausedUntil: null, halfPaceUntil: null, invitesBlockedUntil: null, lastPolledAt: null };
}

function project(id: number, name: string, over: Partial<Project> = {}): Project {
  return {
    id, name, offer: `${name} offer`, audience: null, tone: 'warm', sample: `Hi Kemi, this is the ${name} hello.`, calendarUrl: null,
    approvalsLeft: 0, startedAt: NOW.toISOString(), state: 'running', pausedUntil: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...over,
  };
}

function person(id: number, projectId: number, over: Partial<Person> = {}): Person {
  return {
    id, projectId, name: `Person ${id}`, firstName: id === 1 ? 'Kemi' : `Person${id}`, company: 'Oko Pay', role: null, email: `p${id}@x.com`, linkedinUrl: null, xHandle: null,
    timezone: null, channel: 'email', stage: 'stranger', status: 'active', touches: 0, lastTouchAt: null, nextTouchAt: null, linkedinState: 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, source: 'paste', note: null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...over,
  };
}

function item(id: number, personId: number, over: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id, personId, channel: 'email', kind: 'hello', subject: null, body: 'Hi', state: 'scheduled', origin: 'auto', sendAfter: NOW.toISOString(),
    undoUntil: null, error: null, approvalCounted: false, claimedAt: null, detail: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over,
  };
}

function appState(over: Partial<AppState> = {}): AppState {
  return {
    settings: {
      senderName: 'Gabriel', senderEmail: 'gabriel@yourcompany.com', timezone: 'Africa/Lagos', onboarded: true, currentProjectId: 1, pauseState: 'running',
      pausedUntil: null, notifications: true, morningBrief: true,
    },
    projects: [project(1, 'Reconciliation'), project(2, 'Payroll')],
    channels: [channel('email', 'connected', 'gabriel@yourcompany.com'), channel('linkedin', 'connected', 'Gabriel'), channel('x')],
    people: [person(1, 1), person(2, 1, { stage: 'talking' }), person(3, 2)],
    outbox: [item(1, 1), item(2, 3)],
    incidents: [],
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], acceptedIds: [], nextSendAt: null, line: '' },
    demo: false, canFind: false, claudeEngine: null, claudeConnected: false, auth: { password: false },
    ...over,
  };
}

function setup(state: AppState = appState(), props: Partial<YourCallumProps> = {}) {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <YourCallum state={state} refresh={refresh} download={download} now={() => NOW} pollMs={10} {...props} />
    </ToastProvider>,
  );
  return user;
}

const SUMMARY: Record<Channel, { pending: { invites: number; followUps: number; emails: number; messages: number }; paceLine: string }> = {
  email: { pending: { invites: 0, followUps: 0, emails: 14, messages: 0 }, paceLine: '20 emails a day across both projects, 120 by week 3' },
  linkedin: { pending: { invites: 6, followUps: 2, emails: 0, messages: 0 }, paceLine: '15 invites a day across both projects, runs on this computer while Callum is open' },
  x: { pending: { invites: 0, followUps: 0, emails: 0, messages: 3 }, paceLine: '20 messages a day across both projects' },
};

beforeEach(() => {
  for (const fn of [mocks.settings, mocks.updateProject, mocks.sample, mocks.channelSummary, mocks.disconnect, mocks.pauseProject, mocks.resumeProject, mocks.wrapProject, mocks.connect, mocks.setup, mocks.saveClientId, mocks.saveClaude, mocks.removeClaude, mocks.claudeInfo]) fn.mockReset();
  mocks.claudeInfo.mockResolvedValue(info());
  refresh.mockClear();
  download.mockClear();
  mocks.channelSummary.mockImplementation((ch: Channel) => Promise.resolve(SUMMARY[ch]));
  mocks.settings.mockResolvedValue({});
  mocks.updateProject.mockImplementation((id: number, patch: Partial<Project>) => Promise.resolve(project(id, 'Reconciliation', patch)));
  mocks.sample.mockImplementation((tone: string) => Promise.resolve({ body: `Hi Kemi, this is the ${tone} hello.`, to: { name: 'Kemi Eze', company: 'Oko Pay' } }));
  mocks.disconnect.mockImplementation((ch: Channel) => Promise.resolve(channel(ch)));
  mocks.pauseProject.mockResolvedValue(project(1, 'Reconciliation', { state: 'paused' }));
  mocks.resumeProject.mockResolvedValue(project(1, 'Reconciliation'));
  mocks.wrapProject.mockResolvedValue({ cancelledFollowUps: 0, cancelledHellos: 1, summary: 'Nobody else in Reconciliation hears from you. 0 follow-ups and 1 first hellos are cancelled.' });
  mocks.setup.mockResolvedValue({ configured: false, source: null });
});
afterEach(() => {
  delete window.callumDesktop;
});

describe('Your Callum', () => {
  it('puts the cursor on the page heading when it opens', () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Your Callum' })).toHaveFocus();
  });
});

describe('You', () => {
  it('saves the first name when the field is left', async () => {
    const user = setup();
    expect(screen.getByRole('button', { name: /^You Gabriel, sending as gabriel@yourcompany.com/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^You / }));
    const field = screen.getByLabelText('Your first name, as people see it');
    await user.clear(field);
    await user.type(field, 'Gabi');
    await user.tab();
    expect(mocks.settings).toHaveBeenCalledWith({ senderName: 'Gabi' });
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText('Emails go out from gabriel@yourcompany.com, in every project')).toBeInTheDocument();
  });
});

describe('Projects', () => {
  it('lists the running projects and opens the current one in place', () => {
    setup();
    expect(screen.getByRole('button', { name: /^Projects Reconciliation, Payroll/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reconciliation 2 people, 1 talking/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Payroll 1 person, 0 talking/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Name')).toHaveValue('Reconciliation');
    expect(screen.getByLabelText('What you offer')).toHaveValue('Reconciliation offer');
  });

  it('shows an inline error for a name that is taken and does not save it', async () => {
    const user = setup();
    const field = screen.getByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'payroll');
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a project called payroll. Callum kept the old name. Pick another name.');
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('renames a project', async () => {
    const user = setup();
    const field = screen.getByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Recon');
    await user.tab();
    expect(mocks.updateProject).toHaveBeenCalledWith(1, { name: 'Recon' });
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the server\'s words if the name is refused there', async () => {
    mocks.updateProject.mockRejectedValueOnce(new ApiError(422, 'You already have a project called Recon. Pick another name.'));
    const user = setup();
    const field = screen.getByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Recon');
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a project called Recon. Pick another name.');
  });

  it('says the calendar is empty, and what a link is for once it is set', async () => {
    const user = setup(appState({ projects: [project(1, 'Reconciliation', { calendarUrl: 'https://cal.com/gabriel' }), project(2, 'Payroll')] }));
    expect(screen.getByLabelText('Calendar link')).toHaveValue('cal.com/gabriel');
    expect(screen.getByText('Used when you tap Book a call.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Calendar link'));
    await user.tab();
    expect(mocks.updateProject).toHaveBeenCalledWith(1, { calendarUrl: null });
  });

  it('shows the empty state for a project with no calendar link', () => {
    setup();
    expect(screen.getByText('Add one so Book a call works')).toBeInTheDocument();
  });

  it('refuses a calendar link that is not a link and keeps the old one', async () => {
    const user = setup();
    const field = screen.getByLabelText('Calendar link');
    await user.type(field, 'not a link');
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent("That doesn't look like a link. Callum kept the old link. Try something like cal.com/gabriel.");
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('saves a valid calendar link with its scheme', async () => {
    const user = setup();
    await user.type(screen.getByLabelText('Calendar link'), 'cal.com/gabriel/recon');
    await user.tab();
    expect(mocks.updateProject).toHaveBeenCalledWith(1, { calendarUrl: 'https://cal.com/gabriel/recon' });
    expect(await screen.findByText('Saved. Book a call sends this link.')).toBeInTheDocument();
  });

  it('keeps a long Who to meet whole in a field that grows, and saves it on Enter', async () => {
    const user = setup();
    const who = screen.getByLabelText('Who to meet');
    // A text box that wraps, like the offer field, so a long line is never cut off.
    expect(who.tagName).toBe('TEXTAREA');
    const long = 'Founders and finance leads at fintechs in Lagos and Accra who still reconcile by hand every month';
    await user.type(who, long);
    expect(who).toHaveValue(long);
    await user.keyboard('{Enter}');
    expect(who).toHaveValue(long);
    expect(mocks.updateProject).toHaveBeenCalledWith(1, { audience: long });
  });

  it('saves what you offer when you leave the field, and refuses an empty one', async () => {
    const user = setup();
    const offer = screen.getByLabelText('What you offer');
    await user.clear(offer);
    await user.type(offer, 'You help teams close their books faster.');
    await user.tab();
    expect(mocks.updateProject).toHaveBeenCalledWith(1, { offer: 'You help teams close their books faster.' });
    await user.clear(offer);
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent('Say what you offer in one line.');
  });

  it('rewrites the sample in place when a voice is chosen, and keeps the voice', async () => {
    const user = setup();
    const bubble = screen.getByLabelText(/A first hello to Kemi at Oko Pay, in your Warm voice/);
    expect(bubble).toHaveValue('Hi Kemi, this is the Reconciliation hello.');
    await user.click(screen.getByRole('button', { name: 'Direct' }));
    expect(mocks.sample).toHaveBeenCalledWith('direct', 1);
    await waitFor(() => expect(screen.getByLabelText(/in your Direct voice/)).toHaveValue('Hi Kemi, this is the direct hello.'));
    expect(mocks.updateProject).toHaveBeenCalledWith(1, { tone: 'direct', sample: 'Hi Kemi, this is the direct hello.' });
    expect(screen.getByRole('button', { name: 'Direct' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('puts the voice back when the sample cannot be written', async () => {
    mocks.sample.mockRejectedValueOnce(new ApiError(422, 'Callum could not write that just now. Try again in a moment.'));
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Playful' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Callum could not write that just now.');
    expect(screen.getByRole('button', { name: 'Warm' })).toHaveAttribute('aria-pressed', 'true');
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('saves edited words in the sample', async () => {
    const user = setup();
    const bubble = screen.getByLabelText(/A first hello to Kemi/);
    await user.clear(bubble);
    await user.type(bubble, 'Hi Kemi, a short one.');
    await user.tab();
    expect(mocks.updateProject).toHaveBeenCalledWith(1, { sample: 'Hi Kemi, a short one.' });
  });

  it('writes a sample when the project has none yet', async () => {
    setup(appState({ projects: [project(1, 'Reconciliation', { sample: null }), project(2, 'Payroll')] }));
    expect(await screen.findByDisplayValue('Hi Kemi, this is the warm hello.')).toBeInTheDocument();
    expect(mocks.sample).toHaveBeenCalledWith('warm', 1);
  });

  it('names the person the server wrote the sample to, not whoever is first in the list', async () => {
    mocks.sample.mockResolvedValue({ body: 'Hi Yaw, a hello.', to: { name: 'Yaw Mensah', company: 'Kumasi Foods' } });
    setup(appState({ projects: [project(1, 'Reconciliation', { sample: null }), project(2, 'Payroll')] }));
    expect(await screen.findByLabelText('A first hello to Yaw at Kumasi Foods, in your Warm voice')).toHaveValue('Hi Yaw, a hello.');
  });

  it('says why a pause did not work, under the pause button and not as a wrap-up problem', async () => {
    mocks.pauseProject.mockRejectedValue(new ApiError(422, 'Callum could not pause Reconciliation just now.'));
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Pause Reconciliation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Callum could not pause Reconciliation just now.');
    // Trying again clears it.
    mocks.pauseProject.mockResolvedValue(project(1, 'Reconciliation', { state: 'paused' }));
    await user.click(screen.getByRole('button', { name: 'Pause Reconciliation' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('pauses a project and says the other keeps going', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Pause Reconciliation' }));
    expect(mocks.pauseProject).toHaveBeenCalledWith(1, null);
    expect(await screen.findByText('Reconciliation is paused. Payroll keeps going.')).toBeInTheDocument();
  });

  it('shows a paused project as paused, with a way back', async () => {
    const user = setup(appState({ projects: [project(1, 'Reconciliation', { state: 'paused', pausedUntil: '2026-11-06T08:00:00.000Z' }), project(2, 'Payroll')] }));
    expect(screen.getByRole('button', { name: /Reconciliation Paused until Friday at 9:00/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume Reconciliation' }));
    expect(mocks.resumeProject).toHaveBeenCalledWith(1);
  });

  it('asks before wrapping up, counting what is cancelled and who stays', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Wrap up Reconciliation' }));
    expect(screen.getByText('Wrap up Reconciliation? 1 scheduled hellos are cancelled. 1 people you\u2019re talking with stay in your dock. Download Reconciliation\u2019s people first.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(mocks.wrapProject).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Wrap up Reconciliation' })).toBeInTheDocument();
  });

  it('wraps up with a download', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Wrap up Reconciliation' }));
    await user.click(screen.getByRole('button', { name: 'Download and wrap up' }));
    expect(download).toHaveBeenCalledWith('/api/export.csv?projectId=1');
    expect(mocks.wrapProject).toHaveBeenCalledWith(1);
    expect(await screen.findByText(/Nobody else in Reconciliation hears from you/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('wraps up without a download', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Wrap up Reconciliation' }));
    await user.click(screen.getByRole('button', { name: 'Wrap up' }));
    expect(download).not.toHaveBeenCalled();
    expect(mocks.wrapProject).toHaveBeenCalledWith(1);
  });

  it('keeps at least one project', async () => {
    const user = setup(appState({ projects: [project(1, 'Reconciliation')] }));
    expect(screen.getByText('Callum keeps at least one project. Use Take a break to pause everything.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Wrap up Reconciliation' }));
    expect(screen.queryByRole('button', { name: 'Keep it' })).not.toBeInTheDocument();
  });

  it('lists wrapped projects with a download', async () => {
    const user = setup(appState({ projects: [project(1, 'Reconciliation'), project(2, 'Payroll', { state: 'wrapped' })] }));
    expect(screen.getByRole('heading', { name: 'Wrapped' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download Payroll' }));
    expect(download).toHaveBeenCalledWith('/api/export.csv?projectId=2');
  });

  it('offers Add people when the screen can take you there', async () => {
    const onAddPeople = vi.fn();
    const user = setup(appState(), { onAddPeople });
    await user.click(screen.getByRole('button', { name: 'Add people' }));
    expect(onAddPeople).toHaveBeenCalledWith(1);
  });
});

describe('Where Callum reaches people', () => {
  it('shows status, identity and the shared pace line for each channel', async () => {
    setup();
    const email = screen.getByText('Email').closest('.yc-ch') as HTMLElement;
    expect(within(email).getByText('gabriel@yourcompany.com')).toBeInTheDocument();
    expect(await within(email).findByText('20 emails a day across both projects, 120 by week 3.')).toBeInTheDocument();
    const x = screen.getByText('X').closest('.yc-ch') as HTMLElement;
    expect(within(x).getByText('Not connected')).toBeInTheDocument();
    expect(within(x).getByText('Nobody hears from Callum here, in any project.')).toBeInTheDocument();
    expect(screen.getByText('Two projects, sharing email and LinkedIn')).toBeInTheDocument();
  });

  it('asks before disconnecting, with the counts, and Keep it changes nothing', async () => {
    const user = setup();
    await screen.findByText(/15 invites a day across both projects.*\.$/);
    await user.click(screen.getByRole('button', { name: 'Disconnect LinkedIn' }));
    expect(screen.getByText('Disconnect LinkedIn? 6 invites and 2 follow-ups wait until you connect again, in both projects.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Disconnect LinkedIn' })).toBeInTheDocument();
  });

  it('disconnects after the confirm', async () => {
    const user = setup();
    await screen.findByText(/15 invites a day across both projects.*\.$/);
    await user.click(screen.getByRole('button', { name: 'Disconnect LinkedIn' }));
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(mocks.disconnect).toHaveBeenCalledWith('linkedin');
    expect(await screen.findByText('LinkedIn is disconnected. Everyone there waits, in both projects.')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('words the confirm for one project, for email and for nothing waiting', () => {
    expect(disconnectText('linkedin', SUMMARY.linkedin, null)).toBe('Disconnect LinkedIn? 6 invites and 2 follow-ups wait until you connect again.');
    expect(disconnectText('email', SUMMARY.email, null)).toBe('Disconnect email? 14 emails wait until you connect again. Replies still reach your inbox.');
    expect(disconnectText('x', { pending: { invites: 0, followUps: 0, emails: 0, messages: 1 }, paceLine: '' }, null)).toBe('Disconnect X? 1 message waits until you connect again.');
    expect(disconnectText('x', { pending: { invites: 0, followUps: 0, emails: 0, messages: 0 }, paceLine: '' }, null)).toBe('Disconnect X? Nobody is waiting on it.');
  });

  it('opens the connect sheet from Reconnect and Connect', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Reconnect Email' }));
    const sheet = await screen.findByRole('dialog', { name: 'Connect a channel' });
    expect(within(sheet).getByRole('tab', { name: 'Email', selected: true })).toBeInTheDocument();
    expect(within(sheet).getByLabelText('Email address')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Connect X' }));
    const xSheet = await screen.findByRole('dialog', { name: 'Connect a channel' });
    expect(within(xSheet).getByRole('tab', { name: 'X', selected: true })).toBeInTheDocument();
  });

  it('shows a channel that needs signing in again', () => {
    setup(appState({ channels: [channel('email', 'error', 'gabriel@yourcompany.com'), channel('linkedin'), channel('x')], projects: [project(1, 'Reconciliation')] }));
    const email = screen.getByText('Email').closest('.yc-ch') as HTMLElement;
    expect(within(email).getByText('Sign in again')).toBeInTheDocument();
    expect(within(email).getByRole('button', { name: 'Reconnect Email' })).toBeInTheDocument();
  });

  it('keeps the Microsoft app setup for the desktop app', async () => {
    window.callumDesktop = desktopBridge();
    mocks.saveClientId.mockResolvedValue({ configured: true, source: 'settings' });
    const user = setup();
    await user.click(screen.getByText('Microsoft setup'));
    expect(await screen.findByText(/Microsoft needs a one-time app setup on this computer first\./)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Application (client) ID'), '11111111-2222-3333-4444-555555555555');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.saveClientId).toHaveBeenCalledWith('11111111-2222-3333-4444-555555555555');
    expect(await screen.findByText('Saved. Microsoft sign-in is ready.')).toBeInTheDocument();
  });
});

describe('When Callum sends, Taps and Your data', () => {
  it('shows the sending week, read only', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: /^When Callum sends Weekdays, 9:00 to 17:00 their time/ }));
    expect(screen.getByText(/Callum never sends at night or on weekends\./)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /hours/i })).not.toBeInTheDocument();
  });

  it('turns the morning brief off and on', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: /^Taps Replies, and a brief at 8:30/ }));
    const brief = screen.getByRole('switch', { name: 'Morning brief at 8:30' });
    expect(brief).toHaveAttribute('aria-checked', 'true');
    await user.click(brief);
    expect(mocks.settings).toHaveBeenCalledWith({ morningBrief: false });
    expect(brief).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('switch', { name: 'When someone replies' }));
    expect(mocks.settings).toHaveBeenCalledWith({ notifications: false });
    expect(screen.getByRole('button', { name: /^Taps None\. Replies wait here/ })).toBeInTheDocument();
  });

  it('puts a tap back when it could not be saved', async () => {
    mocks.settings.mockRejectedValueOnce(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    const user = setup();
    await user.click(screen.getByRole('button', { name: /^Taps / }));
    await user.click(screen.getByRole('switch', { name: 'Morning brief at 8:30' }));
    expect(await screen.findByText("Callum can't be reached. Check that it is still running.")).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Morning brief at 8:30' })).toHaveAttribute('aria-checked', 'true');
  });

  it('gives Your data the same row as the others: a head with the title first and its actions after it', () => {
    setup(appState(), { onLeave: vi.fn() });
    const row = document.querySelector('[data-row="data"]') as HTMLElement;
    const head = row.firstElementChild as HTMLElement;
    expect(row).toHaveClass('yc-row');
    expect(head).toHaveClass('yc-rowhead');
    expect(head.firstElementChild).toHaveClass('yc-row-title');
    expect(head.firstElementChild).toHaveTextContent('Your data');
    expect(within(head).getByRole('button', { name: 'Download everything' })).toBeInTheDocument();
    // Every other row has the same head.
    const claude = document.querySelector('[data-row="claude"]') as HTMLElement;
    expect(claude.firstElementChild).toHaveClass('yc-rowhead');
  });

  it('downloads everything and opens the leave sheet', async () => {
    const onLeave = vi.fn();
    const user = setup(appState(), { onLeave });
    await user.click(screen.getByRole('button', { name: 'Download everything' }));
    expect(download).toHaveBeenCalledWith('/api/export.json');
    await user.click(screen.getByRole('button', { name: 'Take a break or wrap up' }));
    expect(onLeave).toHaveBeenCalled();
  });
});

describe('This computer', () => {
  it('does not show the open-at-login switch outside the desktop app', () => {
    setup();
    expect(screen.queryByText('Open Callum when your computer starts')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /This computer/ })).not.toBeInTheDocument();
  });

  it('shows it in the desktop app and tells the app', async () => {
    const setOpenAtLogin = vi.fn().mockResolvedValue(true);
    window.callumDesktop = desktopBridge({ setOpenAtLogin });
    const user = setup();
    await user.click(screen.getByRole('button', { name: /^This computer / }));
    const toggle = screen.getByRole('switch', { name: 'Open Callum when your computer starts' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(setOpenAtLogin).toHaveBeenCalledWith(true);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('starts from what the desktop app saved', async () => {
    window.callumDesktop = desktopBridge();
    const base = appState();
    const user = setup({ ...base, settings: { ...base.settings, openAtLogin: true } });
    await user.click(screen.getByRole('button', { name: /^This computer / }));
    expect(screen.getByRole('switch', { name: 'Open Callum when your computer starts' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('copy', () => {
  it('uses no exclamation mark anywhere, with every row open', async () => {
    window.callumDesktop = desktopBridge();
    const user = setup();
    for (const name of [/^You /, /^When Callum sends/, /^Taps /, /^This computer /]) await user.click(screen.getByRole('button', { name }));
    expect(document.body.textContent).not.toContain('!');
  });

  it('sounds like a person, not a dashboard', () => {
    setup();
    expect(document.body.textContent).not.toMatch(/\b(leads?|prospects?|cadence|churn|disable|the AI)\b/i);
  });
});

const info = (over: Partial<ClaudeInfo> = {}): ClaudeInfo => ({
  engine: null, keySource: null, claudeCode: { found: false, signedIn: false, account: null }, lastError: null, ...over,
});

describe('Claude', () => {
  it('offers the key form, hidden while typing', async () => {
    const user = setup();
    expect(screen.getByRole('button', { name: /^Claude Not set up/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Claude / }));
    expect(await screen.findByText('Or use a Claude API key')).toBeInTheDocument();
    expect(screen.getByLabelText('Claude API key')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves the key, forgets what was typed, and asks for the state again', async () => {
    mocks.saveClaude.mockResolvedValue({ claudeConnected: true });
    const user = setup();
    await user.click(screen.getByRole('button', { name: /^Claude / }));
    await user.type(screen.getByLabelText('Claude API key'), ' sk-ant-secret ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.saveClaude).toHaveBeenCalledWith('sk-ant-secret');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByLabelText('Claude API key')).toHaveValue('');
  });

  it('shows the reason in words when the key is refused', async () => {
    mocks.saveClaude.mockRejectedValue(new ApiError(422, 'Claude did not accept that key.'));
    const user = setup();
    await user.click(screen.getByRole('button', { name: /^Claude / }));
    await user.type(screen.getByLabelText('Claude API key'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Claude did not accept that key.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows Connected without the key, and removes it', async () => {
    mocks.removeClaude.mockResolvedValue({ claudeConnected: false });
    mocks.claudeInfo.mockResolvedValue(info({ engine: 'api', keySource: 'saved' }));
    const user = setup(appState({ claudeConnected: true, claudeEngine: 'api' }));
    expect(screen.getByRole('button', { name: /^Claude Your Claude key/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Claude / }));
    expect(await screen.findByText('Callum uses your Claude key. Remove it to use your Claude plan through Claude Code instead.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Claude API key')).not.toBeInTheDocument();
    expect(screen.queryByText('Or use a Claude API key')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(mocks.removeClaude).toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('says Claude Code is signed in and nothing else is to pay for', async () => {
    mocks.claudeInfo.mockResolvedValue(info({ engine: 'claude_code', claudeCode: { found: true, signedIn: true, account: 'gabriel@yourcompany.com' } }));
    const user = setup(appState({ canFind: true, claudeEngine: 'claude_code' }));
    expect(screen.getByRole('button', { name: /^Claude Your Claude plan/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Claude / }));
    expect(await screen.findByText('Callum writes and finds people with Claude Code on this computer, signed in with your Claude plan. Nothing else to pay for.')).toBeInTheDocument();
    expect(screen.getByLabelText('Claude API key')).toBeInTheDocument();
  });

  it('says how to sign in when Claude Code is here but not signed in', async () => {
    mocks.claudeInfo.mockResolvedValue(info({ claudeCode: { found: true, signedIn: false, account: null } }));
    const user = setup();
    await user.click(screen.getByRole('button', { name: /^Claude / }));
    expect(await screen.findByText("Claude Code is on this computer but isn't signed in. Open a terminal, run claude, and sign in with your Claude account.")).toBeInTheDocument();
  });

  it('does not ask to sign in when Claude Code was found but would not run', async () => {
    mocks.claudeInfo.mockResolvedValue(info({ claudeCode: { found: true, runs: false, signedIn: false, account: null } }));
    const user = setup();
    await user.click(screen.getByRole('button', { name: /^Claude / }));
    expect(await screen.findByText("Callum found Claude Code but couldn't run it. Open a terminal and run claude to check it works, then come back here.")).toBeInTheDocument();
    expect(screen.queryByText(/isn't signed in/)).not.toBeInTheDocument();
  });

  it('links to how to install Claude Code when it is not found', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: /^Claude / }));
    expect(await screen.findByText(/Install Claude Code and sign in with your Claude account, and Callum uses your plan\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How to install Claude Code' })).toHaveAttribute('href', 'https://code.claude.com/docs/en/setup');
  });

  it('shows the last error quietly', async () => {
    mocks.claudeInfo.mockResolvedValue(info({ lastError: 'Claude was too busy to answer. Callum will try again.' }));
    const user = setup();
    await user.click(screen.getByRole('button', { name: /^Claude / }));
    expect(await screen.findByText('Claude was too busy to answer. Callum will try again.')).toBeInTheDocument();
  });

  it('keeps it simple in the demo', async () => {
    const user = setup(appState({ demo: true }));
    await user.click(screen.getByRole('button', { name: /^Claude / }));
    expect(screen.getByText('In the demo Callum writes from its own templates.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Claude API key')).not.toBeInTheDocument();
    expect(mocks.claudeInfo).not.toHaveBeenCalled();
  });
});
