import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, ChannelAccount, Person, Project } from '../../../shared/types.js';
import { ApiError } from '../../api.js';
import { ToastProvider } from '../../ui/Toast.js';
import { FirstRun } from './FirstRun.js';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  microsoftStart: vi.fn(),
  microsoftPoll: vi.fn(),
  channelSummary: vi.fn(),
  suggestOffer: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  importLeads: vi.fn(),
  search: vi.fn(),
  remove: vi.fn(),
  sample: vi.fn(),
  plan: vi.fn(),
  start: vi.fn(),
}));
vi.mock('../../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api.js')>()),
  api: mocks,
  channelSetup: { microsoft: () => Promise.resolve({ configured: true, source: 'env' }), saveMicrosoftClientId: vi.fn() },
}));

const NOW = new Date('2026-11-02T10:00:00Z');
const OFFER = "You help fintech teams take reconciliation off their ops team's plate.";

function channel(ch: ChannelAccount['channel'], status: ChannelAccount['status'] = 'disconnected', identity: string | null = null): ChannelAccount {
  return { channel: ch, status, identity, connectedAt: null, pausedUntil: null, halfPaceUntil: null, invitesBlockedUntil: null, lastPolledAt: null };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1, name: 'Reconciliation', offer: OFFER, audience: null, tone: 'warm', sample: null, calendarUrl: null,
    approvalsLeft: 10, startedAt: null, state: 'running', pausedUntil: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...over,
  };
}

function person(id: number, name: string, over: Partial<Person> = {}): Person {
  return {
    id, projectId: 1, name, firstName: name.split(' ')[0] ?? name, company: 'Oko Pay', role: 'Founder', email: `p${id}@okopay.com`, linkedinUrl: null, xHandle: null,
    timezone: null, channel: null, stage: 'stranger', status: 'active', touches: 0, lastTouchAt: null, nextTouchAt: null, linkedinState: 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, source: 'paste', note: null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...over,
  };
}

function appState(over: Partial<AppState> = {}): AppState {
  return {
    settings: { senderName: null, senderEmail: 'gabriel@yourcompany.com', timezone: 'Africa/Lagos', onboarded: false, currentProjectId: null, pauseState: 'running', pausedUntil: null, notifications: null, morningBrief: true },
    projects: [],
    channels: [channel('email'), channel('linkedin'), channel('x')],
    people: [],
    outbox: [],
    incidents: [],
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], nextSendAt: null, line: '' },
    demo: false, apolloConnected: false, claudeConnected: false,
    ...over,
  };
}

const PLAN = {
  firstSendAt: '2026-11-03T08:00:00.000Z',
  total: 2,
  byChannel: { email: 2, linkedin: 0, x: 0 },
  line: 'Tomorrow from 9:00 their time: 2 hellos, 2 by email. Nothing goes out today.',
};

/** The plan's line without its closing sentence, which the line under it says again. */
const PLAN_SHOWN = 'Tomorrow from 9:00 their time: 2 hellos, 2 by email.';

const refresh = vi.fn(() => Promise.resolve());

function setup(state: AppState = appState(), now: Date = NOW) {
  const user = userEvent.setup();
  render(<ToastProvider><FirstRun state={state} refresh={refresh} now={() => now} pollMs={20} /></ToastProvider>);
  return user;
}

/** Everything a person can read, including what sits inside fields. */
function everythingShown(): string {
  const values = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).map((el) => el.value);
  return [document.body.textContent ?? '', ...values].join('\n');
}

/** Pastes instead of typing key by key, so a busy machine does not run a test out of time. */
async function fill(user: ReturnType<typeof userEvent.setup>, field: HTMLElement, text: string) {
  await user.click(field);
  await user.paste(text);
}

async function connectGoogle(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
  const sheet = await screen.findByRole('dialog');
  await fill(user, within(sheet).getByLabelText('Email address'), 'gabriel@yourcompany.com');
  await fill(user, within(sheet).getByLabelText('App password'), 'abcd efgh ijkl mnop');
  await user.click(within(sheet).getByRole('button', { name: 'Connect' }));
  await within(sheet).findByText(/Sending from gabriel@yourcompany.com\./);
  await user.click(within(sheet).getByRole('button', { name: 'Done' }));
  await screen.findByText('20 a day now, 120 by week 3');
}

async function reachOffer(user: ReturnType<typeof userEvent.setup>) {
  await connectGoogle(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  return screen.findByLabelText('What you offer, in one line');
}

async function reachWho(user: ReturnType<typeof userEvent.setup>) {
  await reachOffer(user);
  await user.click(screen.getByRole('button', { name: 'Looks right' }));
  await screen.findByRole('heading', { name: 'Who do you want to meet?' });
}

async function importTwo(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Bring a list' }));
  await user.click(screen.getByLabelText('Paste names, one per line, or a LinkedIn search link'));
  await user.paste('Kemi Eze, kemi@okopay.com\nTunde Bello, tunde@ireti.com');
  await user.click(screen.getByRole('button', { name: 'Use my list' }));
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  refresh.mockClear();
  mocks.channelSummary.mockResolvedValue({ pending: { invites: 0, followUps: 0, emails: 0, messages: 0 }, paceLine: '20 a day this week, 120 by week 3' });
  mocks.connect.mockImplementation((ch: ChannelAccount['channel']) => Promise.resolve(channel(ch, 'connected', 'gabriel@yourcompany.com')));
  mocks.suggestOffer.mockResolvedValue({ offer: OFFER });
  mocks.createProject.mockResolvedValue(project());
  mocks.updateProject.mockImplementation((_id: number, patch: Partial<Project>) => Promise.resolve(project(patch)));
  mocks.importLeads.mockResolvedValue({ added: [person(11, 'Kemi Eze'), person(12, 'Tunde Bello', { company: 'Ireti Labs', role: 'CEO' })], skipped: [] });
  mocks.remove.mockResolvedValue({});
  mocks.sample.mockImplementation((tone: string) => Promise.resolve({ body: `Hi Kemi, this is the ${tone} hello.` }));
  mocks.plan.mockResolvedValue(PLAN);
  mocks.start.mockResolvedValue({ firstSendAt: PLAN.firstSendAt });
});

describe('Welcome', () => {
  it('makes the three promises and offers Google and Microsoft', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Callum reaches out for you.' })).toBeInTheDocument();
    expect(screen.getByText('Sounds like you')).toBeInTheDocument();
    expect(screen.getByText('Safe daily limits')).toBeInTheDocument();
    expect(screen.getByText('Running in five minutes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Microsoft' })).toBeInTheDocument();
    expect(screen.getByText('Callum sends from your own accounts and never sees your passwords.')).toBeInTheDocument();
  });

  it('Continue with Google opens the email sheet and keeps the mail server out of sight', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    const sheet = await screen.findByRole('dialog', { name: 'Connect a channel' });
    expect(within(sheet).getByRole('button', { name: 'Google' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.body.textContent).not.toMatch(/smtp|imap|gmail\.com:/i);
    expect(within(sheet).getByRole('link', { name: /Open Google/ })).toHaveAttribute('href', 'https://myaccount.google.com/apppasswords');
  });
});

describe('Channels', () => {
  it('connects email with the Google preset and shows today\'s pace', async () => {
    const user = setup();
    await connectGoogle(user);
    expect(mocks.connect).toHaveBeenCalledWith('email', { provider: 'google', address: 'gabriel@yourcompany.com', password: 'abcdefghijklmnop' });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Email' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('gabriel@yourcompany.com')).toBeInTheDocument();
  });

  it('shows the server\'s words when the password is refused and keeps the sheet open', async () => {
    mocks.connect.mockRejectedValueOnce(new ApiError(422, "Google didn't accept that password. App passwords are 16 letters, with no spaces."));
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    const sheet = await screen.findByRole('dialog');
    await fill(user, within(sheet).getByLabelText('Email address'), 'gabriel@yourcompany.com');
    await fill(user, within(sheet).getByLabelText('App password'), 'wrong');
    await user.click(within(sheet).getByRole('button', { name: 'Connect' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent("Google didn't accept that password. App passwords are 16 letters, with no spaces.");
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('warns about a personal address without blocking it', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    const sheet = await screen.findByRole('dialog');
    await fill(user, within(sheet).getByLabelText('Email address'), 'gabriel@gmail.com');
    expect(within(sheet).getByText('This looks like a personal address. Cold email works best from your company address.')).toBeInTheDocument();
  });

  it('signs in to Microsoft with a short code', async () => {
    mocks.microsoftStart.mockResolvedValue({ userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: '2026-11-02T10:15:00.000Z' });
    mocks.microsoftPoll
      .mockResolvedValueOnce({ status: 'waiting' })
      .mockResolvedValue({ status: 'connected', account: channel('email', 'connected', 'gabriel@yourcompany.com') });
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Continue with Microsoft' }));
    const sheet = await screen.findByRole('dialog');
    await fill(user, within(sheet).getByLabelText('Email address'), 'gabriel@yourcompany.com');
    await user.click(within(sheet).getByRole('button', { name: 'Open Microsoft' }));
    expect(await within(sheet).findByText('ABCD-EFGH')).toBeInTheDocument();
    expect(within(sheet).getByText("Callum waits here.", { exact: false })).toBeInTheDocument();
    expect(mocks.microsoftStart).toHaveBeenCalledWith('gabriel@yourcompany.com');
    await screen.findByText('20 a day now, 120 by week 3');
  });

  it('needs one connected channel before Next', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('connects LinkedIn on its own page and X with a token', async () => {
    const user = setup(appState({ channels: [channel('email', 'connected', 'gabriel@yourcompany.com'), channel('linkedin'), channel('x')] }));
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await user.click(screen.getByRole('button', { name: 'Connect LinkedIn' }));
    const sheet = await screen.findByRole('dialog', { name: 'Connect a channel' });
    expect(within(sheet).getByRole('tab', { name: 'LinkedIn', selected: true })).toBeInTheDocument();
    expect(within(sheet).getByText("You sign in on LinkedIn's own page. Callum never sees your password.")).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Open LinkedIn' }));
    expect(mocks.connect).toHaveBeenCalledWith('linkedin', {});
    expect(await within(sheet).findByText('Connected as gabriel@yourcompany.com')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('15 invites a day')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Connect X' }));
    const xSheet = await screen.findByRole('dialog', { name: 'Connect a channel' });
    expect(within(xSheet).getByRole('tab', { name: 'X', selected: true })).toBeInTheDocument();
    await user.type(within(xSheet).getByLabelText('X access token'), 'short');
    await user.click(within(xSheet).getByRole('button', { name: 'Connect' }));
    expect(await within(xSheet).findByRole('alert')).toHaveTextContent("That doesn't look like an X access token.");
    expect(mocks.connect).not.toHaveBeenCalledWith('x', expect.anything());
  });
});

describe('Offer', () => {
  it('prefills the offer from the company site and names the project quietly', async () => {
    const user = setup();
    const field = await reachOffer(user);
    await waitFor(() => expect(field).toHaveValue(OFFER));
    expect(screen.getByText('Callum will call this')).toBeInTheDocument();
    expect(screen.getByText('Reconciliation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename this project' })).toBeInTheDocument();
  });

  it('creates the project from the offer, and the header becomes callum · name', async () => {
    const user = setup();
    await reachOffer(user);
    await user.click(screen.getByRole('button', { name: 'Looks right' }));
    await screen.findByRole('heading', { name: 'Who do you want to meet?' });
    expect(mocks.createProject).toHaveBeenCalledWith({ offer: OFFER, name: 'Reconciliation' });
    expect(screen.getByTestId('project-anchor')).toHaveTextContent('Reconciliation');
  });

  it('sends a renamed project with its name, and shows a taken name inline', async () => {
    mocks.createProject.mockRejectedValueOnce(new ApiError(422, 'You already have a project called Payroll. Pick another name.'));
    const user = setup();
    await reachOffer(user);
    await user.click(screen.getByRole('button', { name: 'Rename this project' }));
    const name = screen.getByLabelText('Project name');
    await user.clear(name);
    await user.type(name, 'Payroll');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Looks right' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a project called Payroll. Pick another name.');
    expect(mocks.createProject).toHaveBeenCalledWith({ offer: OFFER, name: 'Payroll' });
    expect(screen.getByRole('heading', { name: 'What do you offer?' })).toBeInTheDocument();
  });
});

describe('Who', () => {
  it('pours a pasted list in with a count, and Not a fit removes someone', async () => {
    const user = setup();
    await reachWho(user);
    await importTwo(user);
    expect(mocks.importLeads).toHaveBeenCalledWith({ paste: 'Kemi Eze, kemi@okopay.com\nTunde Bello, tunde@ireti.com', projectId: 1 });
    await waitFor(() => expect(screen.getByTestId('found-count')).toHaveTextContent('2'));
    expect(screen.getByText('people found')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Kemi Eze, Founder at Oko Pay' }));
    await user.click(screen.getByRole('button', { name: 'Not a fit' }));
    expect(mocks.remove).toHaveBeenCalledWith(11);
    await waitFor(() => expect(screen.getByTestId('found-count')).toHaveTextContent('1'));
    expect(screen.queryByRole('button', { name: 'Kemi Eze, Founder at Oko Pay' })).not.toBeInTheDocument();
    expect(screen.getByText('Kemi is out and will not hear from Callum.')).toBeInTheDocument();
  });

  it('says who was skipped and why', async () => {
    mocks.importLeads.mockResolvedValue({
      added: [person(11, 'Kemi Eze')],
      skipped: [{ name: 'Ada', reason: 'other_project', projectName: 'Payroll' }, { name: 'Bisi', reason: 'stopped' }],
    });
    const user = setup();
    await reachWho(user);
    await importTwo(user);
    expect(await screen.findByText('Skipped 2: 1 is already in Payroll, 1 asked not to be contacted.')).toBeInTheDocument();
  });

  it('reads a LinkedIn search link as a link and a CSV file as a CSV', async () => {
    const user = setup();
    await reachWho(user);
    await user.click(screen.getByRole('button', { name: 'Bring a list' }));
    await user.click(screen.getByLabelText('Paste names, one per line, or a LinkedIn search link'));
    await user.paste('https://www.linkedin.com/search/results/people/?keywords=cfo');
    await user.click(screen.getByRole('button', { name: 'Use my list' }));
    await waitFor(() => expect(mocks.importLeads).toHaveBeenCalledWith({ linkedinSearchUrl: 'https://www.linkedin.com/search/results/people/?keywords=cfo', projectId: 1 }));
  });

  it('sends a chosen CSV file as a CSV', async () => {
    const user = setup();
    await reachWho(user);
    await user.click(screen.getByRole('button', { name: 'Bring a list' }));
    const csv = 'name,email\nKemi Eze,kemi@okopay.com\n';
    await user.upload(screen.getByLabelText('Choose a CSV'), new File([csv], 'leads.csv', { type: 'text/csv' }));
    expect(await screen.findByText('leads.csv')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use my list' }));
    await waitFor(() => expect(mocks.importLeads).toHaveBeenCalledWith({ csv, projectId: 1 }));
  });

  it('asks for something to import before going to the server', async () => {
    const user = setup();
    await reachWho(user);
    await user.click(screen.getByRole('button', { name: 'Bring a list' }));
    await user.click(screen.getByRole('button', { name: 'Use my list' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Paste some names or a LinkedIn link first, or drop a CSV.');
    expect(mocks.importLeads).not.toHaveBeenCalled();
  });

  it('searches with a description and offers to narrow a huge answer', async () => {
    mocks.search.mockResolvedValue({ total: 48000, added: [], skipped: [] });
    const user = setup();
    await reachWho(user);
    await user.type(screen.getByLabelText('Describe who you want to meet'), 'Founders of startups{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Find them' }));
    expect(mocks.search).toHaveBeenCalledWith('Founders of startups', 25, 1);
    expect(await screen.findByText("That's about 48,000 people.")).toBeInTheDocument();
    expect(screen.getByText('Narrow it down?', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Seed to Series A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('adds what Apollo found and tells the cost', async () => {
    mocks.search.mockResolvedValue({ total: 300, added: [person(21, 'Ngozi Obi'), person(22, 'Seun Ade')], skipped: [] });
    const user = setup();
    await reachWho(user);
    await user.click(screen.getByRole('button', { name: 'Seed-stage fintech founders in Lagos' }));
    expect(screen.getByText('Callum can look for 25 people. That uses about 25 Apollo credits.')).toBeInTheDocument();
    expect(mocks.search).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Find them' }));
    expect(mocks.search).toHaveBeenCalledWith('Seed-stage fintech founders in Lagos', 25, 1);
    await waitFor(() => expect(screen.getByTestId('found-count')).toHaveTextContent('2'));
    expect(screen.getByText('That used about 2 Apollo credits.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('explains plainly when there is no people search to describe with', async () => {
    mocks.search.mockRejectedValueOnce(new ApiError(422, 'Callum needs a list for that. Bring a CSV or a LinkedIn search link.'));
    const user = setup();
    await reachWho(user);
    await user.type(screen.getByLabelText('Describe who you want to meet'), 'CFOs{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Find them' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Callum needs a list for that. Bring a CSV or a LinkedIn search link.');
    expect(screen.getByRole('button', { name: 'Bring a list' })).toBeInTheDocument();
  });
});

describe('Tone and Plan', () => {
  async function reachTone(user: ReturnType<typeof userEvent.setup>) {
    await reachWho(user);
    await importTwo(user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'How should Callum sound?' });
  }

  it('rewrites the sample for each tone and saves the tone and the edited words on the project', async () => {
    const user = setup();
    await reachTone(user);
    const box = await screen.findByLabelText('First message to Kemi');
    await waitFor(() => expect(box).toHaveValue('Hi Kemi, this is the warm hello.'));
    expect(screen.getByText('First hello to Kemi Eze at Oko Pay, by email')).toBeInTheDocument();
    expect(mocks.sample).toHaveBeenCalledWith('warm', 1);
    await user.click(screen.getByRole('button', { name: 'Direct' }));
    await waitFor(() => expect(box).toHaveValue('Hi Kemi, this is the direct hello.'));
    await user.clear(box);
    await user.type(box, 'Hi Kemi, a quick one.');
    expect(screen.getByText('Callum will use your words.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: "Here's tomorrow" });
    expect(mocks.updateProject).toHaveBeenLastCalledWith(1, { tone: 'direct', sample: 'Hi Kemi, a quick one.' });
  });

  it('shows the plan and starts tomorrow at 9:00', async () => {
    const user = setup();
    await reachTone(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(PLAN_SHOWN)).toBeInTheDocument();
    expect(screen.getByText("Nothing goes out today. You'll OK the first 10 before they go.")).toBeInTheDocument();
    expect(mocks.plan).toHaveBeenCalledWith(1);
    refresh.mockClear();
    await user.click(screen.getByRole('button', { name: 'Start tomorrow at 9:00' }));
    expect(mocks.start).toHaveBeenCalledWith(1);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('shows why it could not start, in the server\'s words', async () => {
    mocks.start.mockRejectedValueOnce(new ApiError(422, 'Connect a channel first'));
    const user = setup();
    await reachTone(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Start tomorrow at 9:00' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connect a channel first');
    expect(screen.getByRole('button', { name: 'Start tomorrow at 9:00' })).toBeEnabled();
  });
});

describe('copy', () => {
  it('never uses an exclamation mark, on any step', async () => {
    const user = setup();
    expect(everythingShown()).not.toContain('!');
    await connectGoogle(user);
    expect(everythingShown()).not.toContain('!');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('What you offer, in one line');
    expect(everythingShown()).not.toContain('!');
    await user.click(screen.getByRole('button', { name: 'Looks right' }));
    await screen.findByRole('heading', { name: 'Who do you want to meet?' });
    expect(everythingShown()).not.toContain('!');
    await importTwo(user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    expect(everythingShown()).not.toContain('!');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('First message to Kemi');
    expect(everythingShown()).not.toContain('!');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText(PLAN_SHOWN);
    expect(everythingShown()).not.toContain('!');
  });
});

describe('going back and editing', () => {
  it('updates the project with the new offer and the name it shows, rather than creating another', async () => {
    const user = setup();
    await reachWho(user);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    const field = await screen.findByLabelText('What you offer, in one line');
    await user.clear(field);
    await user.click(field);
    await user.paste('You help growing teams run payroll without spreadsheets.');
    expect(screen.getByText('Payroll')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Looks right' }));
    await screen.findByRole('heading', { name: 'Who do you want to meet?' });
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(mocks.updateProject).toHaveBeenCalledWith(1, { offer: 'You help growing teams run payroll without spreadsheets.', name: 'Payroll' });
  });

  it('shows a taken name beside the pencil and keeps the person on the offer', async () => {
    mocks.updateProject.mockRejectedValueOnce(new ApiError(422, 'You already have a project called Payroll. Pick another name.'));
    const user = setup();
    await reachWho(user);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Rename this project' }));
    const name = screen.getByLabelText('Project name');
    await user.clear(name);
    await user.type(name, 'Payroll');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Looks right' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a project called Payroll. Pick another name.');
    expect(screen.getByRole('heading', { name: 'What do you offer?' })).toBeInTheDocument();
    expect(mocks.updateProject).toHaveBeenCalledWith(1, { name: 'Payroll' });
  });

  it('writes the words used to search on the project as its audience, and an emptied sample as null', async () => {
    mocks.search.mockResolvedValue({ total: 300, added: [person(21, 'Ngozi Obi')], skipped: [] });
    const user = setup();
    await reachWho(user);
    await user.click(screen.getByRole('button', { name: 'Heads of finance at fintechs' }));
    await user.click(screen.getByRole('button', { name: 'Find them' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const box = await screen.findByLabelText('First message to Ngozi');
    await waitFor(() => expect(box).toHaveValue('Hi Kemi, this is the warm hello.'));
    await user.clear(box);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: "Here's tomorrow" });
    expect(mocks.updateProject).toHaveBeenLastCalledWith(1, { tone: 'warm', sample: null, audience: 'Heads of finance at fintechs' });
  });
});

describe('Microsoft sign-in', () => {
  async function openMicrosoft(user: ReturnType<typeof userEvent.setup>) {
    mocks.microsoftStart.mockResolvedValue({ userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: '2099-01-01T00:00:00.000Z' });
    await user.click(screen.getByRole('button', { name: 'Continue with Microsoft' }));
    const sheet = await screen.findByRole('dialog');
    await user.type(within(sheet).getByLabelText('Email address'), 'gabriel@yourcompany.com');
    await user.click(within(sheet).getByRole('button', { name: 'Open Microsoft' }));
    await within(sheet).findByText('ABCD-EFGH');
    return sheet;
  }

  it('says when the code ran out and offers a new one', async () => {
    mocks.microsoftPoll.mockResolvedValue({ status: 'expired' });
    const sheet = await openMicrosoft(setup());
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('That code ran out. Open Microsoft again for a new one.');
    expect(within(sheet).getByRole('button', { name: 'Open Microsoft' })).toBeEnabled();
  });

  it('says when Microsoft said no', async () => {
    mocks.microsoftPoll.mockResolvedValue({ status: 'denied' });
    const sheet = await openMicrosoft(setup());
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Microsoft said no. Open Microsoft again when you are ready.');
  });

  it('keeps waiting through a failed request and a waiting answer until the code is entered', async () => {
    mocks.microsoftPoll
      .mockRejectedValueOnce(new ApiError(0, "Callum can't be reached. Check that it is still running."))
      .mockResolvedValueOnce({ status: 'waiting' })
      .mockResolvedValue({ status: 'connected', account: channel('email', 'connected', 'gabriel@yourcompany.com') });
    await openMicrosoft(setup());
    await screen.findByText('20 a day now, 120 by week 3');
    expect(mocks.microsoftPoll).toHaveBeenCalledTimes(3);
  });
});

describe('when Callum cannot be reached', () => {
  it('says so under the Start button and lets the person try again', async () => {
    mocks.start.mockRejectedValueOnce(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    const user = setup();
    await connectGoogle(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('What you offer, in one line');
    await user.click(screen.getByRole('button', { name: 'Looks right' }));
    await screen.findByRole('heading', { name: 'Who do you want to meet?' });
    await importTwo(user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('First message to Kemi');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Start tomorrow at 9:00' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Callum can't be reached. Check that it is still running.");
    expect(screen.getByRole('button', { name: 'Start tomorrow at 9:00' })).toBeEnabled();
  });

  it('says so when the project cannot be saved, under the offer', async () => {
    mocks.createProject.mockRejectedValueOnce(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    const user = setup();
    await reachOffer(user);
    await user.click(screen.getByRole('button', { name: 'Looks right' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Callum can't be reached. Check that it is still running.");
    expect(screen.getByRole('heading', { name: 'What do you offer?' })).toBeInTheDocument();
  });
});

describe('Plan day', () => {
  it('starts on the day the plan says, always at 9:00', async () => {
    mocks.plan.mockResolvedValue({ ...PLAN, firstSendAt: '2026-11-09T09:00:00.000Z', line: 'Monday from 9:00 their time: 2 hellos, 2 by email. Nothing goes out today.' });
    const user = setup(appState(), new Date('2026-11-06T10:00:00Z'));
    await connectGoogle(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('What you offer, in one line');
    await user.click(screen.getByRole('button', { name: 'Looks right' }));
    await screen.findByRole('heading', { name: 'Who do you want to meet?' });
    await importTwo(user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('First message to Kemi');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('button', { name: 'Start Monday at 9:00' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "Here's Monday" })).toBeInTheDocument();
    expect(screen.getByText('Monday from 9:00 their time: 2 hellos, 2 by email.')).toBeInTheDocument();
    expect(screen.getAllByText(/Nothing goes out today/)).toHaveLength(1);
  });
});

describe('channel state', () => {
  it('lets go of its own copy once the server state shows the same, so a later disconnect shows', async () => {
    const user = userEvent.setup();
    const first = appState();
    const view = (state: AppState) => (
      <ToastProvider><FirstRun state={state} refresh={refresh} now={() => NOW} pollMs={20} /></ToastProvider>
    );
    const { rerender } = render(view(first));
    await connectGoogle(user);
    expect(screen.getByRole('button', { name: 'Connect Email' })).toHaveAttribute('aria-pressed', 'true');
    rerender(view(appState({ channels: [channel('email', 'connected', 'gabriel@yourcompany.com'), channel('linkedin'), channel('x')] })));
    expect(screen.getByRole('button', { name: 'Connect Email' })).toHaveAttribute('aria-pressed', 'true');
    rerender(view(appState()));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect Email' })).toHaveAttribute('aria-pressed', 'false'));
  });
});

describe('the sheet as a modal', () => {
  it('makes the page behind it inert and brings focus back to the disc that opened it', async () => {
    const user = setup(appState({ channels: [channel('email', 'connected', 'gabriel@yourcompany.com'), channel('linkedin'), channel('x')] }));
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    const linkedin = screen.getByRole('button', { name: 'Connect LinkedIn' });
    linkedin.focus();
    await user.click(linkedin);
    const sheet = await screen.findByRole('dialog', { name: 'Connect a channel' });
    expect(linkedin.closest('.fr-root')?.parentElement).toHaveAttribute('inert');
    await user.keyboard('{Escape}');
    expect(sheet).not.toBeInTheDocument();
    expect(linkedin.closest('.fr-root')?.parentElement).not.toHaveAttribute('inert');
    expect(linkedin).toHaveFocus();
  });
});
