import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api.js';
import { person, project } from '../../test/phoneLeaveFixtures.js';
import { possessive, ProjectWrapConfirm } from './ProjectWrapConfirm.js';

const mocks = vi.hoisted(() => ({
  wrapProject: vi.fn(),
  exportJsonUrl: vi.fn((id?: number) => `/api/export.json?projectId=${id}`),
  exportCsvUrl: vi.fn((id?: number) => `/api/export.csv?projectId=${id}`),
}));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const RESULT = { cancelledFollowUps: 2, cancelledHellos: 6, summary: 'Nobody else in Payroll hears from you. 2 follow-ups and 6 first hellos are cancelled.' };
const save = vi.fn(async (_u: string, name: string) => ({ name, href: `blob:${name}`, bytes: 10 }));
const onDone = vi.fn();
const onKeep = vi.fn();

beforeEach(() => {
  mocks.wrapProject.mockReset().mockResolvedValue(RESULT);
  save.mockClear();
  onDone.mockClear();
  onKeep.mockClear();
});

const payroll = project({ id: 2, name: 'Payroll' });
const people = [
  ...[1, 2, 3, 4, 5, 6].map((id) => person(id, `P${id}`, { projectId: 2, touches: 0, stage: 'stranger' })),
  person(7, 'Kemi', { projectId: 2, status: 'waiting', stage: 'talking' }),
  person(8, 'Tunde', { projectId: 2, stage: 'talking' }),
  person(9, 'Other', { projectId: 1, touches: 0 }),
];

function setup() {
  const user = userEvent.setup();
  render(<ProjectWrapConfirm project={payroll} people={people} onDone={onDone} onKeep={onKeep} save={save} />);
  return user;
}

describe('ProjectWrapConfirm', () => {
  it('asks in the words of the project settings board', () => {
    setup();
    expect(screen.getByText("Wrap up Payroll? 6 scheduled hellos are cancelled. 2 people you're talking with stay in your dock. Download Payroll's people first.")).toBeInTheDocument();
  });

  it('Download and wrap up saves the project people first, then wraps that project', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Download and wrap up' }));
    expect(save).toHaveBeenCalledWith('/api/export.json?projectId=2', 'payroll-people.json');
    expect(save).toHaveBeenCalledWith('/api/export.csv?projectId=2', 'payroll-people.csv');
    expect(mocks.wrapProject).toHaveBeenCalledWith(2);
    expect(onDone).toHaveBeenCalledWith(RESULT, true);
  });

  it('Wrap up wraps without a download, and Keep it leaves everything alone', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Wrap up' }));
    expect(save).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith(RESULT, false);
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onKeep).toHaveBeenCalledTimes(1);
  });

  it('does not wrap when the download fails', async () => {
    save.mockRejectedValueOnce(new Error('The download did not work, so Callum kept everything as it was.'));
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Download and wrap up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The download did not work');
    expect(mocks.wrapProject).not.toHaveBeenCalled();
  });

  it('says why when the server refuses', async () => {
    mocks.wrapProject.mockRejectedValue(new ApiError(422, 'Callum keeps at least one project.'));
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Wrap up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Callum keeps at least one project.');
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('possessive', () => {
  it('adds an apostrophe, and an s unless the name ends in one', () => {
    expect(possessive('Payroll')).toBe("Payroll's");
    expect(possessive('Sales')).toBe("Sales'");
  });
});
