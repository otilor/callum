import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, OutboxItem, Person, Project } from '../../../shared/types.js';
import { ApiError } from '../../api.js';
import { ToastProvider } from '../../ui/Toast.js';
import { ProjectSwitcher } from './ProjectSwitcher.js';

const mocks = vi.hoisted(() => ({
  setCurrentProject: vi.fn(), updateProject: vi.fn(), pauseProject: vi.fn(), resumeProject: vi.fn(), wrapProject: vi.fn(),
  exportCsvUrl: vi.fn((id?: number) => `/api/export.csv?projectId=${id}`),
}));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const NOW = new Date('2026-11-02T10:00:00Z');
const AT = NOW.toISOString();
const refresh = vi.fn(() => Promise.resolve());

const project = (id: number, name: string, over: Partial<Project> = {}): Project => ({
  id, name, offer: null, audience: null, tone: 'warm', sample: null, calendarUrl: null, approvalsLeft: 0, startedAt: AT, state: 'running', pausedUntil: null,
  createdAt: AT, updatedAt: AT, ...over,
});

const person = (id: number, projectId: number, over: Partial<Person> = {}): Person => ({
  id, projectId, name: `Person ${id}`, firstName: `P${id}`, company: null, role: null, email: null, linkedinUrl: null, xHandle: null, timezone: null, channel: 'email',
  stage: 'hello', status: 'active', touches: 1, lastTouchAt: null, nextTouchAt: null, linkedinState: 'none', invitedAt: null, snoozedUntil: null, restUntil: null,
  badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, source: 'paste', note: null, createdAt: AT, updatedAt: AT, ...over,
});

const scheduled = (id: number, personId: number): OutboxItem => ({
  id, personId, channel: 'email', kind: 'hello', subject: null, body: 'x', state: 'scheduled', origin: 'auto', sendAfter: AT, undoUntil: null, error: null,
  approvalCounted: false, claimedAt: null, detail: null, createdAt: AT, updatedAt: AT,
});

function state(over: Partial<AppState> = {}): AppState {
  return {
    settings: { senderName: null, senderEmail: null, timezone: 'UTC', onboarded: true, currentProjectId: 1, pauseState: 'running', pausedUntil: null, notifications: null, morningBrief: true },
    projects: [project(1, 'Reconciliation'), project(2, 'Payroll')],
    channels: [], people: [], outbox: [], incidents: [], demo: false, canFind: false, claudeEngine: null, claudeConnected: false, auth: { password: false },
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], acceptedIds: [], nextSendAt: null, line: '' },
    ...over,
  };
}

function view(s: AppState, onNewProject?: () => void) {
  return render(
    <ToastProvider>
      <ProjectSwitcher state={s} project={s.projects[0]!} refresh={refresh} now={() => NOW} {...(onNewProject ? { onNewProject } : {})} />
    </ToastProvider>,
  );
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /^Projects, now showing/ }));
  return screen.getByRole('dialog', { name: 'Your projects' });
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset?.();
  mocks.exportCsvUrl.mockImplementation((id?: number) => `/api/export.csv?projectId=${id}`);
  refresh.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('ProjectSwitcher', () => {
  it('opens a sheet with one row per project, its faces and a line about who is talking', async () => {
    const people = [
      ...Array.from({ length: 8 }, (_, i) => person(i + 1, 1, i < 3 ? { stage: 'talking' } : {})),
      person(20, 2), person(21, 2),
    ];
    const user = userEvent.setup();
    view(state({ people, projects: [project(1, 'Reconciliation'), project(2, 'Payroll', { state: 'paused', pausedUntil: '2026-11-06T09:00:00Z' })] }));
    const sheet = await open(user);
    expect(within(sheet).getByRole('button', { name: /^Reconciliation/ })).toHaveTextContent('8 people, 3 talking');
    expect(within(sheet).getByRole('button', { name: /^Reconciliation/ }).querySelectorAll('.psw-strip span')).toHaveLength(7);
    expect(within(sheet).getByRole('button', { name: /^Payroll/ })).toHaveTextContent('Paused until Friday at 9:00');
    expect(within(sheet).getByRole('button', { name: /^Reconciliation/ })).toHaveAttribute('aria-current', 'true');
  });

  it('switches project and closes', async () => {
    mocks.setCurrentProject.mockResolvedValue({});
    const user = userEvent.setup();
    view(state());
    const sheet = await open(user);
    await user.click(within(sheet).getByRole('button', { name: /^Payroll/ }));
    expect(mocks.setCurrentProject).toHaveBeenCalledWith(2);
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Your projects' })).not.toBeInTheDocument();
  });

  it('pauses and resumes a project from its menu', async () => {
    mocks.pauseProject.mockResolvedValue({});
    mocks.resumeProject.mockResolvedValue({});
    const user = userEvent.setup();
    const { unmount } = view(state());
    await open(user);
    await user.click(screen.getByRole('button', { name: 'More for Reconciliation' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pause Reconciliation' }));
    expect(mocks.pauseProject).toHaveBeenCalledWith(1, null);
    expect(await screen.findByText('Reconciliation is paused. Nothing goes out from it until you resume.')).toBeInTheDocument();
    unmount();

    view(state({ projects: [project(1, 'Reconciliation', { state: 'paused' }), project(2, 'Payroll')] }));
    await open(user);
    await user.click(screen.getByRole('button', { name: 'More for Reconciliation' }));
    await user.click(screen.getByRole('menuitem', { name: 'Resume Reconciliation' }));
    expect(mocks.resumeProject).toHaveBeenCalledWith(1);
  });

  it('asks before wrapping up, says what happens, and can download first', async () => {
    mocks.wrapProject.mockResolvedValue({ cancelledFollowUps: 1, cancelledHellos: 2, summary: 'Reconciliation is wrapped up. 2 hellos and 1 follow-up are cancelled.' });
    mocks.setCurrentProject.mockResolvedValue({});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const people = [person(1, 1, { stage: 'talking', status: 'waiting' }), person(2, 1), person(3, 1)];
    const user = userEvent.setup();
    view(state({ people, outbox: [scheduled(1, 2), scheduled(2, 3), { ...scheduled(3, 1), kind: 'reply', origin: 'user' }] }));
    await open(user);
    await user.click(screen.getByRole('button', { name: 'More for Reconciliation' }));
    await user.click(screen.getByRole('menuitem', { name: 'Wrap up' }));
    expect(screen.getByText(/Wrap up Reconciliation\? 2 scheduled hellos are cancelled\. 1 person you’re talking with stays in your dock\. Download Reconciliation’s people first\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(mocks.wrapProject).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'More for Reconciliation' }));
    await user.click(screen.getByRole('menuitem', { name: 'Wrap up' }));
    await user.click(screen.getByRole('button', { name: 'Download and wrap up' }));
    expect(click).toHaveBeenCalled();
    expect(mocks.exportCsvUrl).toHaveBeenCalledWith(1);
    expect(mocks.wrapProject).toHaveBeenCalledWith(1);
    // The project being viewed was wrapped, so the other one takes over.
    expect(mocks.setCurrentProject).toHaveBeenCalledWith(2);
    expect(await screen.findByText('Reconciliation’s people are downloading. Reconciliation is wrapped up. 2 hellos and 1 follow-up are cancelled.')).toBeInTheDocument();
  });

  it('keeps at least one project', async () => {
    const user = userEvent.setup();
    view(state({ projects: [project(1, 'Reconciliation')] }));
    await open(user);
    await user.click(screen.getByRole('button', { name: 'More for Reconciliation' }));
    const wrap = screen.getByRole('menuitem', { name: /Wrap up/ });
    expect(wrap).toHaveAttribute('aria-disabled', 'true');
    expect(wrap).toHaveTextContent('Callum keeps at least one project');
    await user.click(wrap);
    expect(screen.queryByText(/Download and wrap up/)).not.toBeInTheDocument();
    expect(mocks.wrapProject).not.toHaveBeenCalled();
  });

  it('renames in place and says when the name is taken or empty', async () => {
    mocks.updateProject.mockResolvedValue({});
    const user = userEvent.setup();
    view(state());
    await open(user);
    await user.click(screen.getByRole('button', { name: 'More for Reconciliation' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByLabelText('Project name');
    await user.clear(field);
    await user.type(field, 'payroll');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a project called payroll. Callum kept the old name. Pick another name.');
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A project needs a name. Callum kept “Reconciliation”. Type a name to save.');
    expect(mocks.updateProject).not.toHaveBeenCalled();
    await user.type(field, 'Month-end close');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.updateProject).toHaveBeenCalledWith(1, { name: 'Month-end close' });
    expect(await screen.findByText('Renamed to Month-end close')).toBeInTheDocument();
  });

  it('shows the server\'s reason when a rename fails', async () => {
    mocks.updateProject.mockRejectedValue(new ApiError(409, 'You already have a project called Month-end close.'));
    const user = userEvent.setup();
    view(state());
    await open(user);
    await user.click(screen.getByRole('button', { name: 'More for Reconciliation' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await user.type(screen.getByLabelText('Project name'), ' 2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a project called Month-end close.');
  });

  it('opens the New project flow when the app gives it one', async () => {
    const onNew = vi.fn();
    const user = userEvent.setup();
    view(state(), onNew);
    const sheet = await open(user);
    await user.click(within(sheet).getByRole('button', { name: 'New project' }));
    expect(onNew).toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Your projects' })).not.toBeInTheDocument();
  });

  it('closes with Escape and gives focus back to the anchor', async () => {
    const user = userEvent.setup();
    view(state());
    await open(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Your projects' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Projects, now showing/ })).toHaveFocus();
  });
});
