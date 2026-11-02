import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, OutboxItem, Person, Project } from '../shared/types.js';
import { ApiError } from './api.js';
import { App, dayOneAsBanner, screenFor } from './App.js';

const mocks = vi.hoisted(() => ({ state: vi.fn(), login: vi.fn(), logout: vi.fn(), sample: vi.fn(), channelSummary: vi.fn() }));
vi.mock('./api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api.js')>()), api: mocks }));

const AT = '2026-11-02T10:00:00.000Z';

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1, name: 'Reconciliation', offer: 'You help teams reconcile.', audience: null, tone: 'warm', sample: null, calendarUrl: null, approvalsLeft: 10,
    startedAt: AT, state: 'running', pausedUntil: null, createdAt: AT, updatedAt: AT, ...over,
  };
}

function awaiting(): OutboxItem {
  return {
    id: 5, personId: 1, channel: 'email', kind: 'hello', subject: 'Hi', body: 'Hi', state: 'awaiting_ok', origin: 'auto', sendAfter: AT,
    undoUntil: null, error: null, approvalCounted: false, claimedAt: null, detail: null, createdAt: AT, updatedAt: AT,
  };
}

function kemi(over: Partial<Person> = {}): Person {
  return {
    id: 1, projectId: 1, name: 'Kemi Eze', firstName: 'Kemi', company: 'Oko Pay', role: 'Founder', email: 'kemi@okopay.com', linkedinUrl: null, xHandle: null,
    timezone: null, channel: 'email', stage: 'stranger', status: 'active', touches: 0, lastTouchAt: null, nextTouchAt: AT, linkedinState: 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, source: 'paste', note: null,
    createdAt: AT, updatedAt: AT, ...over,
  };
}

function appState(over: Partial<AppState> = {}, settings: Partial<AppState['settings']> = {}): AppState {
  return {
    settings: { senderName: null, senderEmail: null, timezone: 'UTC', onboarded: true, currentProjectId: 1, pauseState: 'running', pausedUntil: null, notifications: null, morningBrief: true, ...settings },
    projects: [project()], channels: [], people: [], outbox: [], incidents: [], demo: false, apolloConnected: false, claudeConnected: false, auth: { password: false },
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], acceptedIds: [], nextSendAt: null, line: 'All caught up. Callum keeps the river moving.' },
    ...over,
  };
}

beforeEach(() => {
  mocks.state.mockReset();
  mocks.login.mockReset();
  mocks.logout.mockReset();
  mocks.sample.mockReset().mockResolvedValue({ body: 'Hi Kemi' });
  mocks.channelSummary.mockReset().mockResolvedValue({ pending: 0, paceLine: '' });
  localStorage.clear();
});

describe('screenFor', () => {
  it('picks the screen the state calls for', () => {
    expect(screenFor(appState({}, { onboarded: false }), null)).toBe('first-run');
    expect(screenFor(appState({}, { pauseState: 'wrapped' }), project())).toBe('wrapped');
    // Starting again sets onboarded to false: the wrapped screen still comes first.
    expect(screenFor(appState({}, { pauseState: 'wrapped', onboarded: false }), null)).toBe('wrapped');
    expect(screenFor(appState({ people: [kemi()], outbox: [awaiting()] }), project())).toBe('day-one');
    expect(screenFor(appState({ people: [kemi()], outbox: [awaiting()] }), project({ approvalsLeft: 0 }))).toBe('home');
    // Hellos waiting in another project do not hold this one on Day one.
    expect(screenFor(appState({ people: [kemi({ projectId: 2 })], outbox: [awaiting()] }), project())).toBe('home');
    expect(screenFor(appState(), project())).toBe('home');
  });
});

describe('Day one beside other projects', () => {
  const second = () => project({ id: 2, name: 'Payroll', approvalsLeft: 0 });
  const waiting = () => kemi({ id: 2, projectId: 2, name: 'Femi Ade', firstName: 'Femi', stage: 'talking', status: 'waiting', repliedAt: AT, lastInbound: 'Tell me more.' });

  it('is a banner on Home when another project runs and someone waits in the dock', async () => {
    const state = appState({ projects: [project(), second()], people: [kemi(), waiting()], outbox: [awaiting()] });
    expect(dayOneAsBanner(state, project())).toBe(true);
    mocks.state.mockResolvedValue(state);
    const user = userEvent.setup();
    const { container } = render(<App />);
    expect(await screen.findByText('1 of 10 hellos left to OK in Reconciliation')).toBeInTheDocument();
    expect(container.querySelector('main')).toHaveAttribute('data-screen', 'home');
    expect(screen.getByRole('button', { name: 'Femi Ade, replied and waiting on you' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'OK the hellos' }));
    await waitFor(() => expect(container.querySelector('main')).toHaveAttribute('data-screen', 'day-one'));
    await user.click(screen.getByRole('button', { name: 'Back to the river' }));
    await waitFor(() => expect(container.querySelector('main')).toHaveAttribute('data-screen', 'home'));
  });

  it('stays full screen when nobody waits, or when it is the only project', async () => {
    const lonely = appState({ people: [kemi()], outbox: [awaiting()] });
    expect(dayOneAsBanner(lonely, project())).toBe(false);
    const quiet = appState({ projects: [project(), second()], people: [kemi()], outbox: [awaiting()] });
    expect(dayOneAsBanner(quiet, project())).toBe(false);
    mocks.state.mockResolvedValue(quiet);
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector('main')).toHaveAttribute('data-screen', 'day-one'));
    // The project switcher is there, since another project runs.
    expect(screen.getByRole('button', { name: 'Projects, now showing Reconciliation' })).toBeInTheDocument();
  });
});

describe('App', () => {
  it('shows First run until Callum is set up', async () => {
    mocks.state.mockResolvedValue(appState({ projects: [] }, { onboarded: false }));
    render(<App />);
    expect(screen.getByText('Callum is starting')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Callum reaches out for you.' })).toBeInTheDocument();
  });

  it('shows Home with the project beside the wordmark', async () => {
    mocks.state.mockResolvedValue(appState());
    const { container } = render(<App />);
    expect(await screen.findByRole('button', { name: 'Projects, now showing Reconciliation' })).toHaveTextContent('Reconciliation');
    expect(container.querySelector('main')).toHaveAttribute('data-screen', 'home');
  });

  it('shows Day one while hellos wait for an OK, and Leave done when wrapped', async () => {
    mocks.state.mockResolvedValue(appState({ people: [kemi()], outbox: [awaiting()] }));
    const first = render(<App />);
    await waitFor(() => expect(first.container.querySelector('main')).toHaveAttribute('data-screen', 'day-one'));
    first.unmount();
    mocks.state.mockResolvedValue(appState({}, { pauseState: 'wrapped' }));
    const second = render(<App />);
    expect(await screen.findByRole('heading', { name: 'All wrapped up' })).toBeInTheDocument();
    second.unmount();
  });

  it('asks for the password on a 401, says when it is wrong, and lets the person in once it is right', async () => {
    mocks.state.mockRejectedValueOnce(new ApiError(401, 'Sign in first'));
    mocks.login.mockRejectedValueOnce(new ApiError(401, "That's not the password."));
    const user = userEvent.setup();
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'This Callum is private' })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That's not the password.");

    mocks.login.mockResolvedValueOnce({ ok: true });
    mocks.state.mockResolvedValue(appState());
    await user.clear(screen.getByPlaceholderText('Password'));
    await user.type(screen.getByPlaceholderText('Password'), 'right');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(container.querySelector('main')).toHaveAttribute('data-screen', 'home'));
    expect(mocks.login).toHaveBeenLastCalledWith('right');
  });

  it('leaves the checking state and shows the error when the state cannot be fetched after signing in', async () => {
    mocks.state.mockRejectedValueOnce(new ApiError(401, 'Sign in first'));
    mocks.login.mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'This Callum is private' });
    mocks.state.mockRejectedValue(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    await user.type(screen.getByPlaceholderText('Password'), 'right');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Callum can't be reached. Check that it is still running.");
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('offers Sign out only when the server asks for a password, and goes back to the password card', async () => {
    mocks.state.mockResolvedValue(appState({ people: [kemi()], outbox: [awaiting()], auth: { password: true } }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Your account' }));
    mocks.logout.mockResolvedValue({ ok: true });
    mocks.state.mockRejectedValue(new ApiError(401, 'Sign in first'));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'This Callum is private' })).toBeInTheDocument();
    expect(mocks.logout).toHaveBeenCalled();
  });

  it('offers no Sign out when there is no password', async () => {
    mocks.state.mockResolvedValue(appState({ people: [kemi()], outbox: [awaiting()] }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Your account' }));
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Your Callum' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Take a break or wrap up' })).toBeInTheDocument();
  });

  it('opens Your Callum and the leave sheet from the account menu, and comes back', async () => {
    mocks.state.mockResolvedValue(appState());
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Your account' }));
    await user.click(screen.getByRole('menuitem', { name: 'Your Callum' }));
    expect(await screen.findByRole('heading', { name: 'Your Callum' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /back/i }));
    await waitFor(() => expect(container.querySelector('main')).toHaveAttribute('data-screen', 'home'));
    await user.click(screen.getByRole('button', { name: 'Your account' }));
    await user.click(screen.getByRole('menuitem', { name: 'Take a break or wrap up' }));
    expect(await screen.findByRole('button', { name: /Back to the river/ })).toBeInTheDocument();
  });

  it('says plainly when Callum cannot be reached at first', async () => {
    mocks.state.mockRejectedValue(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    render(<App />);
    expect(await screen.findByText("Callum can't be reached. Check that it is still running.")).toBeInTheDocument();
  });

  it('on a phone, Back from Your Callum lands on the tab it was opened from', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width') || query.includes('prefers-reduced-motion'),
      media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      mocks.state.mockResolvedValue(appState());
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: 'You' }));
      await user.click(await screen.findByRole('button', { name: 'Everything else in Your Callum' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Your Callum' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /back/i }));
      expect(await screen.findByRole('button', { name: 'Everything else in Your Callum' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'You' })).toHaveAttribute('aria-current', 'page');
    } finally {
      window.matchMedia = real;
    }
  });
});
