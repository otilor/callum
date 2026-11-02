import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddCommit, AddPreview, Described, Person, PreviewPerson, Project } from '../../../shared/types.js';
import { ApiError } from '../../api.js';
import { ToastProvider } from '../../ui/Toast.js';
import { AddPeople } from './AddPeople.js';

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  commit: vi.fn(),
  undo: vi.fn(),
  describe: vi.fn(),
  connectApollo: vi.fn(),
  sample: vi.fn(),
}));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), peopleApi: mocks }));

const NOW = new Date('2026-11-02T10:00:00Z');

const project: Project = {
  id: 1, name: 'Payroll', offer: 'You help teams run payroll', audience: null, tone: 'warm', sample: null, calendarUrl: null,
  approvalsLeft: 10, startedAt: NOW.toISOString(), state: 'running', pausedUntil: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
};

function previewPerson(key: string, name: string, over: Partial<PreviewPerson> = {}): PreviewPerson {
  return { key, name, firstName: name.split(' ')[0] ?? name, projectId: 1, source: 'paste', email: `${key}@example.com`, company: 'Oko Pay', role: 'Founder', ...over };
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

const THREE: AddPreview = {
  batchId: 'batch-1',
  added: [previewPerson('0', 'Kemi Eze'), previewPerson('1', 'Femi Ade'), previewPerson('2', 'Tunde Bello')],
  groups: [
    { reason: 'known', line: "1 you've emailed before", names: ['Ada Nwosu'] },
    { reason: 'other_project', line: '2 are already in Invoicing', names: ['Seun Ojo', 'Ruth Adeleke'], projectName: 'Invoicing' },
  ],
};

function show(people: Person[] = [person(1, 'Sade Bello')]) {
  const onClose = vi.fn();
  render(
    <ToastProvider>
      <AddPeople project={project} people={people} timezone="Africa/Lagos" onClose={onClose} now={() => NOW} />
    </ToastProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});

async function pasteAndRead(user: ReturnType<typeof userEvent.setup>, text = 'Kemi Eze, kemi@okopay.com') {
  await user.click(screen.getByRole('tab', { name: 'Paste names' }));
  await user.click(screen.getByLabelText(/One person per line/));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Read the names' }));
}

describe('AddPeople', () => {
  it('says when the first hellos can go out and offers the four ways in', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Who else should Callum meet?' })).toBeInTheDocument();
    expect(screen.getByText('New people join the river as strangers. Nobody hears from Callum before tomorrow at 9:00.')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    ['Drop a CSV', 'Paste names', 'LinkedIn search link', 'Describe who'].forEach((name, i) => expect(tabs[i]).toHaveAccessibleName(name));
    expect(tabs).toHaveLength(4);
    expect(screen.getByRole('tab', { name: 'Drop a CSV' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Drop a CSV here, or choose one')).toBeInTheDocument();
  });

  it('names Monday when tomorrow is a weekend', () => {
    render(
      <ToastProvider>
        <AddPeople project={project} people={[]} timezone="Africa/Lagos" onClose={() => {}} now={() => new Date('2026-11-06T10:00:00Z')} />
      </ToastProvider>,
    );
    expect(screen.getByText(/before Monday at 9:00\./)).toBeInTheDocument();
  });

  it('pastes names, previews who joins and who is skipped, adds them, and offers Undo', async () => {
    const user = userEvent.setup();
    mocks.preview.mockResolvedValue(THREE);
    const result: AddCommit = {
      added: [person(10, 'Kemi Eze'), person(11, 'Femi Ade'), person(12, 'Tunde Bello')],
      line: '3 people join the river. First hellos from tomorrow at 9:00.', groups: [],
    };
    mocks.commit.mockResolvedValue(result);
    mocks.undo.mockResolvedValue({ removed: 3 });
    show();

    await pasteAndRead(user, 'Kemi Eze, kemi@okopay.com\nFemi Ade, femi@ledgerly.io');
    expect(mocks.preview).toHaveBeenCalledWith({ paste: 'Kemi Eze, kemi@okopay.com\nFemi Ade, femi@ledgerly.io', projectId: 1 });
    expect(await screen.findByText('3 new people')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '3 new people' }).children).toHaveLength(3);
    expect(screen.getByText('3 skipped, and why')).toBeInTheDocument();

    // A skipped group opens in place and names its people.
    const group = screen.getByRole('button', { name: /you've emailed before/ });
    expect(group).toHaveAttribute('aria-expanded', 'false');
    await user.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Ada Nwosu is in your Sent folder/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /are already in Invoicing/ }));
    expect(screen.getByText(/Seun Ojo and Ruth Adeleke are in Invoicing\. Each person belongs to one project/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add 3 people' }));
    expect(mocks.commit).toHaveBeenCalledWith({ batchId: 'batch-1', projectId: 1, drop: [] });
    expect(await screen.findByText('3 people join the river.', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('First hellos go out from tomorrow at 9:00, within your daily limits.')).toBeInTheDocument();
    const toast = screen.getByRole('status');
    expect(within(toast).getByText('3 people join the river. First hellos from tomorrow at 9:00.')).toBeInTheDocument();

    // Undo takes them back and brings the preview back, with a fresh batch.
    mocks.preview.mockResolvedValue({ ...THREE, batchId: 'batch-2' });
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(mocks.undo).toHaveBeenCalledWith('batch-1');
    expect(await screen.findByText('Undone. Nobody was added.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Add 3 people' })).toBeInTheDocument();
  });

  it('leaves out someone marked Not a fit before anything is added', async () => {
    const user = userEvent.setup();
    mocks.preview.mockResolvedValue(THREE);
    mocks.commit.mockResolvedValue({ added: [person(10, 'Kemi Eze'), person(12, 'Tunde Bello')], line: '2 people join the river. First hellos from tomorrow at 9:00.', groups: [] });
    show();
    await pasteAndRead(user);
    await user.click(await screen.findByRole('button', { name: /Femi Ade, Founder at Oko Pay/ }));
    expect(screen.getByText('Femi Ade', { selector: 'strong' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Not a fit' }));
    expect(screen.getByText('Femi is out and will not join.')).toBeInTheDocument();
    expect(screen.getByText('2 new people')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add 2 people' }));
    expect(mocks.commit).toHaveBeenCalledWith({ batchId: 'batch-1', projectId: 1, drop: ['1'] });
  });

  it('reads a CSV file the way it was saved', async () => {
    const user = userEvent.setup();
    mocks.preview.mockResolvedValue(THREE);
    show();
    const file = new File(['Name,Email\nKemi Eze,kemi@okopay.com\n'], 'founders.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText('Choose a CSV'), file);
    await waitFor(() => expect(mocks.preview).toHaveBeenCalled());
    const body = mocks.preview.mock.calls[0]?.[0] as { csvBase64: string; projectId: number };
    expect(Buffer.from(body.csvBase64, 'base64').toString('utf8')).toBe('Name,Email\nKemi Eze,kemi@okopay.com\n');
    expect(body.projectId).toBe(1);
    expect(await screen.findByText('3 new people')).toBeInTheDocument();
  });

  it('checks a LinkedIn search link before reading it', async () => {
    const user = userEvent.setup();
    mocks.preview.mockResolvedValue({ ...THREE, groups: [] });
    show();
    await user.click(screen.getByRole('tab', { name: 'LinkedIn search link' }));
    await user.type(screen.getByLabelText('LinkedIn search link'), 'https://www.linkedin.com/feed/');
    await user.click(screen.getByRole('button', { name: 'Read it' }));
    expect(screen.getByRole('alert')).toHaveTextContent("That isn't a LinkedIn people search. It should start with linkedin.com/search/results/people.");
    expect(mocks.preview).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('LinkedIn search link'));
    await user.type(screen.getByLabelText('LinkedIn search link'), 'linkedin.com/search/results/people/?keywords=fintech');
    await user.click(screen.getByRole('button', { name: 'Read it' }));
    expect(mocks.preview).toHaveBeenCalledWith({ linkedinSearchUrl: 'https://linkedin.com/search/results/people/?keywords=fintech', projectId: 1 });
    expect(await screen.findByText('3 people from the search')).toBeInTheDocument();
  });

  it('shows what the server said when it cannot read a list', async () => {
    const user = userEvent.setup();
    mocks.preview.mockRejectedValue(new ApiError(422, "Callum didn't find anyone in that. Each person needs a name and an email, a LinkedIn link or an X handle."));
    show();
    await pasteAndRead(user);
    expect(await screen.findByRole('alert')).toHaveTextContent("Callum didn't find anyone in that.");
    expect(screen.getByRole('button', { name: 'Read the names' })).toBeInTheDocument();
  });

  it('shows the error when adding fails and keeps the preview', async () => {
    const user = userEvent.setup();
    mocks.preview.mockResolvedValue(THREE);
    mocks.commit.mockRejectedValue(new ApiError(410, 'That list is no longer here. Bring it again.'));
    show();
    await pasteAndRead(user);
    await user.click(await screen.findByRole('button', { name: 'Add 3 people' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That list is no longer here. Bring it again.');
    expect(screen.getByRole('button', { name: 'Add 3 people' })).toBeEnabled();
  });
});

describe('AddPeople, describing who', () => {
  const rows = (n: number): PreviewPerson[] =>
    ['Kemi', 'Femi', 'Tunde'].slice(0, n).map((first, i) => ({
      key: `apollo-${i}`, apolloId: `apollo-${i}`, hasEmail: true, name: `${first} Ez***`, firstName: first, source: 'apollo' as const, projectId: 1,
      role: 'Head of Finance', company: ['Oko Pay', 'Ledgerly', 'Sent Co'][i] ?? 'Co',
    }));
  const found = (over: Partial<Described> = {}): Described => ({ batchId: 'apollo-batch', total: 3, people: rows(3), narrow: null, line: 'Callum found 3', ...over });

  it('says what is missing without Apollo, connects it with a key, and looks again', async () => {
    const user = userEvent.setup();
    mocks.describe.mockRejectedValueOnce(new ApiError(422, 'Describing people needs a people search connected. Bring a list instead, or connect Apollo in Your Callum.', { detail: { code: 'no_apollo' } }));
    mocks.connectApollo.mockResolvedValue({ connected: true });
    show();
    await user.click(screen.getByRole('tab', { name: 'Describe who' }));
    await user.type(screen.getByLabelText('Describe who you want to meet'), 'heads of finance in Accra');
    await user.click(screen.getByRole('button', { name: 'Look' }));
    expect(await screen.findByText(/Describing people needs a people search connected/)).toBeInTheDocument();

    mocks.describe.mockResolvedValue(found());
    await user.click(screen.getByRole('button', { name: 'Connect Apollo' }));
    await user.type(screen.getByLabelText('Apollo API key'), 'key-123');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(mocks.connectApollo).toHaveBeenCalledWith('key-123');
    expect(await screen.findByText('Apollo is connected. Callum can look for people now.')).toBeInTheDocument();
    expect(await screen.findByText('Callum found 3')).toBeInTheDocument();
    expect(mocks.describe).toHaveBeenLastCalledWith({ query: 'heads of finance in Accra', filters: [], projectId: 1 });
  });

  it('shows 3 rows by first name and company, drops one, says the credits, and names them after adding', async () => {
    const user = userEvent.setup();
    mocks.describe.mockResolvedValue(found());
    mocks.commit.mockResolvedValue({
      added: [person(10, 'Kemi Eze'), person(12, 'Tunde Bello')], groups: [], creditsUsed: 2,
      line: '2 people join the river. First hellos from tomorrow at 9:00. That used 2 Apollo credits.',
    });
    show();
    await user.click(screen.getByRole('tab', { name: 'Describe who' }));
    await user.click(screen.getByRole('button', { name: 'Heads of finance at fintechs' }));
    expect(await screen.findByText('Callum found 3')).toBeInTheDocument();
    expect(screen.getByText('Adding uses about 3 Apollo credits.')).toBeInTheDocument();

    // Apollo rows show a first name and a company, never the hidden last name.
    expect(screen.queryByRole('button', { name: /Ez\*\*\*/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Femi, Ledgerly' }));
    expect(screen.getByText('Femi', { selector: 'strong' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Not a fit' }));
    expect(screen.getByText('Femi is out. No credit goes on Femi.')).toBeInTheDocument();
    expect(screen.getByText('Adding uses about 2 Apollo credits.')).toBeInTheDocument();
    expect(mocks.commit).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Add 2 people' }));
    expect(mocks.commit).toHaveBeenCalledWith({ batchId: 'apollo-batch', projectId: 1, drop: ['apollo-1'] });
    expect(await screen.findByText('First hellos go out from tomorrow at 9:00, within your daily limits. That used 2 Apollo credits.')).toBeInTheDocument();
  });

  it('asks to narrow a search of thousands, and looks again with the chips chosen', async () => {
    const user = userEvent.setup();
    mocks.describe.mockResolvedValueOnce(found({ total: 2300, narrow: ['Seed to Series A', '20 to 200 people', 'Accra only'], line: "That's about 2,300 people. Narrow it down?" }));
    show();
    await user.click(screen.getByRole('tab', { name: 'Describe who' }));
    await user.type(screen.getByLabelText('Describe who you want to meet'), 'heads of finance in Accra{Enter}');
    expect(await screen.findByText("That's about 2,300 people.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accra only' }));
    expect(screen.getByRole('button', { name: 'Accra only' })).toHaveAttribute('aria-pressed', 'true');
    mocks.describe.mockResolvedValueOnce(found({ total: 400, batchId: 'narrow-batch' }));
    await user.click(screen.getByRole('button', { name: 'Find the 3 closest fits' }));
    expect(mocks.describe).toHaveBeenLastCalledWith({ query: 'heads of finance in Accra', filters: ['Accra only'], projectId: 1 });
    expect(await screen.findByText('Callum found 3')).toBeInTheDocument();
  });

  it('goes on with the first rows when nothing was chosen to narrow', async () => {
    const user = userEvent.setup();
    mocks.describe.mockResolvedValueOnce(found({ total: 2300, narrow: ['Seed to Series A'], line: "That's about 2,300 people. Narrow it down?" }));
    show();
    await user.click(screen.getByRole('tab', { name: 'Describe who' }));
    await user.type(screen.getByLabelText('Describe who you want to meet'), 'cfo{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Find the 3 closest fits' }));
    expect(mocks.describe).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Callum found 3')).toBeInTheDocument();
  });

  it('says so when nobody matched, and offers a wider search', async () => {
    const user = userEvent.setup();
    mocks.describe.mockResolvedValueOnce({ batchId: null, total: 0, people: [], narrow: null, line: "Nobody matched 'heads of ops in Accra'. Try a wider role or a nearby city." });
    show();
    await user.click(screen.getByRole('tab', { name: 'Describe who' }));
    await user.type(screen.getByLabelText('Describe who you want to meet'), 'heads of ops in Accra{Enter}');
    expect(await screen.findByText("Nobody matched 'heads of ops in Accra'. Try a wider role or a nearby city.")).toBeInTheDocument();
    mocks.describe.mockResolvedValueOnce(found());
    await user.click(screen.getByRole('button', { name: 'heads of ops' }));
    expect(mocks.describe).toHaveBeenLastCalledWith({ query: 'heads of ops', filters: [], projectId: 1 });
  });

  it('shows what Apollo said when part of a look-up failed, and keeps who was found', async () => {
    const user = userEvent.setup();
    mocks.describe.mockResolvedValue(found());
    mocks.commit.mockResolvedValue({
      added: [person(10, 'Kemi Eze')], groups: [{ reason: 'no_channel', line: '1 has no email or LinkedIn', names: ['Femi Ade'] }], creditsUsed: 1,
      warning: "Apollo's lookup limit is reached. Try again in an hour.",
      line: '1 person joins the river. First hellos from tomorrow at 9:00. That used 1 Apollo credit.',
    });
    show();
    await user.click(screen.getByRole('tab', { name: 'Describe who' }));
    await user.type(screen.getByLabelText('Describe who you want to meet'), 'cfo{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Add 3 people' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Apollo's lookup limit is reached. Try again in an hour.");
    expect(screen.getByText('Left out: 1 has no email or LinkedIn.')).toBeInTheDocument();
  });
});

describe('AddPeople, the river', () => {
  it('counts the people of the project by how far along they are and grows when people join', async () => {
    const user = userEvent.setup();
    mocks.preview.mockResolvedValue(THREE);
    mocks.commit.mockResolvedValue({ added: [person(10, 'Kemi Eze')], line: '1 person joins the river. First hellos from tomorrow at 9:00.', groups: [] });
    show([person(1, 'Sade Bello'), person(2, 'Yaw Mensah', { stage: 'hello' }), person(3, 'Ama Ofori', { stage: 'talking' })]);
    const lanes = () => Array.from(document.querySelectorAll('.ap-lane')).map((l) => l.textContent);
    expect(lanes()).toEqual(['1strangers', '1said hello', '0following up', '1talking']);
    await pasteAndRead(user);
    await user.click(await screen.findByRole('button', { name: 'Add 3 people' }));
    await screen.findByText('1 person joins the river.', { selector: 'p' });
    expect(lanes()[0]).toBe('2strangers');
  });

  it('goes back to the river', async () => {
    const user = userEvent.setup();
    const { onClose } = show();
    await user.click(screen.getByRole('button', { name: 'River' }));
    expect(onClose).toHaveBeenCalled();
  });
});
