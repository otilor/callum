import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, OutboxItem, Person, Project } from '../shared/types.js';
import { ApiError } from './api.js';
import { App, screenFor } from './App.js';

const mocks = vi.hoisted(() => ({ state: vi.fn(), login: vi.fn(), logout: vi.fn() }));
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
    undoUntil: null, error: null, approvalCounted: false, createdAt: AT, updatedAt: AT,
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
    settings: { senderName: null, senderEmail: null, timezone: 'UTC', onboarded: true, currentProjectId: 1, pauseState: 'running', pausedUntil: null, notifications: null, ...settings },
    projects: [project()], channels: [], people: [], outbox: [], incidents: [], demo: false,
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], nextSendAt: null, line: 'All caught up. Callum keeps the river moving.' },
    ...over,
  };
}

beforeEach(() => {
  mocks.state.mockReset();
  mocks.login.mockReset();
  mocks.logout.mockReset();
  localStorage.clear();
});

describe('screenFor', () => {
  it('picks the screen the state calls for', () => {
    expect(screenFor(appState({}, { onboarded: false }), null)).toBe('first-run');
    expect(screenFor(appState({}, { pauseState: 'wrapped' }), project())).toBe('wrapped');
    expect(screenFor(appState({ people: [kemi()], outbox: [awaiting()] }), project())).toBe('day-one');
    expect(screenFor(appState({ people: [kemi()], outbox: [awaiting()] }), project({ approvalsLeft: 0 }))).toBe('home');
    // Hellos waiting in another project do not hold this one on Day one.
    expect(screenFor(appState({ people: [kemi({ projectId: 2 })], outbox: [awaiting()] }), project())).toBe('home');
    expect(screenFor(appState(), project())).toBe('home');
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
    await waitFor(() => expect(second.container.querySelector('main')).toHaveAttribute('data-screen', 'wrapped'));
  });

  it('asks for the password on a 401, says when it is wrong, and lets the person in once it is right', async () => {
    mocks.state.mockRejectedValueOnce(new ApiError(401, 'Sign in first'));
    mocks.login.mockRejectedValueOnce(new ApiError(401, "That's not the password."));
    const user = userEvent.setup();
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'This Callum is private.' })).toBeInTheDocument();
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

  it('offers Sign out only to a browser that signed in, and goes back to the password card', async () => {
    localStorage.setItem('callum.signed-in', '1');
    mocks.state.mockResolvedValue(appState({ people: [kemi()], outbox: [awaiting()] }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Your account' }));
    mocks.logout.mockResolvedValue({ ok: true });
    mocks.state.mockRejectedValue(new ApiError(401, 'Sign in first'));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'This Callum is private.' })).toBeInTheDocument();
    expect(mocks.logout).toHaveBeenCalled();
    expect(localStorage.getItem('callum.signed-in')).toBeNull();
  });

  it('says plainly when Callum cannot be reached at first', async () => {
    mocks.state.mockRejectedValue(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    render(<App />);
    expect(await screen.findByText("Callum can't be reached. Check that it is still running.")).toBeInTheDocument();
  });
});
