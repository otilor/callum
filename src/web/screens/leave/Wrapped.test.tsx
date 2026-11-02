import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api.js';
import { appState, person } from '../../test/phoneLeaveFixtures.js';
import { rememberWrap, Wrapped } from './Wrapped.js';

const mocks = vi.hoisted(() => ({
  startAgain: vi.fn(),
  exportJsonUrl: vi.fn(() => '/api/export.json'),
  exportCsvUrl: vi.fn(() => '/api/export.csv'),
}));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const refresh = vi.fn(() => Promise.resolve());
beforeEach(() => {
  mocks.startAgain.mockReset();
  refresh.mockClear();
  rememberWrap(null);
});

describe('Wrapped', () => {
  it('thanks the person and starts again with one tap', async () => {
    mocks.startAgain.mockResolvedValue({});
    const user = userEvent.setup();
    render(<Wrapped state={appState()} refresh={refresh} memory={{ line: null, summary: 'Nobody else hears from you.', files: [] }} />);
    expect(screen.getByRole('heading', { name: 'All wrapped up' })).toBeInTheDocument();
    expect(screen.getByText('Thanks for letting Callum help.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Your export' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Start again any time/ }));
    expect(mocks.startAgain).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
  });

  it('offers the export again from the routes when the people are still here', () => {
    render(<Wrapped state={appState({ people: [person(1, 'Kemi')] })} refresh={refresh} />);
    const links = screen.getAllByRole('link', { name: 'Download again' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/api/export.json', '/api/export.csv']);
  });

  it('says so when starting again did not work', async () => {
    mocks.startAgain.mockRejectedValue(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    const user = userEvent.setup();
    render(<Wrapped state={appState()} refresh={refresh} />);
    await user.click(screen.getByRole('button', { name: /Start again any time/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Callum can't be reached");
    expect(refresh).not.toHaveBeenCalled();
  });
});
