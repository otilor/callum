import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api.js';
import { appState, NOW, person } from '../../test/phoneLeaveFixtures.js';
import { ToastProvider } from '../../ui/Toast.js';
import { LeaveSheet } from './LeaveSheet.js';
import { rememberWrap } from './Wrapped.js';

const mocks = vi.hoisted(() => ({
  pause: vi.fn(),
  resumeAll: vi.fn(),
  wrap: vi.fn(),
  wrapSummary: vi.fn(),
  startAgain: vi.fn(),
  exportJsonUrl: vi.fn(() => '/api/export.json'),
  exportCsvUrl: vi.fn(() => '/api/export.csv'),
}));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const LINE = 'Callum said hello to 36 people for you. 8 replied, and 2 calls got booked.';
const SUMMARY = 'Nobody else hears from you. 28 follow-ups and 4 first hellos are cancelled.';
const refresh = vi.fn(() => Promise.resolve());
const onClose = vi.fn();
const save = vi.fn(async (_url: string, name: string) => ({ name, href: `blob:${name}`, bytes: 2048 }));

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockClear();
  refresh.mockClear();
  onClose.mockClear();
  save.mockClear();
  mocks.pause.mockResolvedValue({});
  mocks.resumeAll.mockResolvedValue({});
  mocks.wrapSummary.mockResolvedValue({ line: LINE });
  mocks.wrap.mockResolvedValue({ cancelledFollowUps: 28, cancelledHellos: 4, summary: SUMMARY });
  mocks.startAgain.mockResolvedValue({});
  rememberWrap(null);
});

function setup(state = appState({ people: [person(1, 'Kemi', { status: 'waiting', stage: 'talking' }), person(2, 'Tunde')] })) {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <LeaveSheet state={state} refresh={refresh} onClose={onClose} now={() => NOW} save={save} />
    </ToastProvider>,
  );
  return user;
}

describe('LeaveSheet: take a break', () => {
  it('offers the three breaks and a date, and Until Monday is the first', async () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Take a break, or wrap up?' })).toBeInTheDocument();
    for (const label of ['Until Monday', 'Two weeks', 'Until January 6', 'Pick a date']) {
      expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('radio', { name: 'Until Monday' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Pause until Monday' })).toBeInTheDocument();
  });

  it('Two weeks pauses until 9:00 in the user time zone, fourteen days on', async () => {
    const user = setup();
    await user.click(screen.getByRole('radio', { name: 'Two weeks' }));
    await user.click(screen.getByRole('button', { name: 'Pause for two weeks' }));
    // Monday 2 November 11:00 in Lagos plus 14 days, at 9:00 Lagos (UTC+1).
    expect(mocks.pause).toHaveBeenCalledWith('2026-11-16T08:00:00.000Z');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Until Monday and Until January 6 pause until 9:00 on those days', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Pause until Monday' }));
    expect(mocks.pause).toHaveBeenLastCalledWith('2026-11-09T08:00:00.000Z');
    await user.click(screen.getByRole('radio', { name: 'Until January 6' }));
    await user.click(screen.getByRole('button', { name: 'Pause until January 6' }));
    expect(mocks.pause).toHaveBeenLastCalledWith('2027-01-06T08:00:00.000Z');
  });

  it('Until Monday starts from the next day: on a Monday morning it is next week, not this morning', () => {
    // Monday 2 November, 08:00 in Lagos, before the 9:00 that day.
    const early = new Date('2026-11-02T07:00:00Z');
    render(
      <ToastProvider>
        <LeaveSheet state={appState()} refresh={refresh} onClose={onClose} now={() => early} save={save} />
      </ToastProvider>,
    );
    return userEvent.setup().click(screen.getByRole('button', { name: 'Pause until Monday' })).then(() => {
      expect(mocks.pause).toHaveBeenCalledWith('2026-11-09T08:00:00.000Z');
    });
  });

  it('Until January 6 on the morning of January 6 means next year', async () => {
    const morning = new Date('2027-01-06T07:00:00Z');
    render(
      <ToastProvider>
        <LeaveSheet state={appState()} refresh={refresh} onClose={onClose} now={() => morning} save={save} />
      </ToastProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Until January 6' }));
    await user.click(screen.getByRole('button', { name: 'Pause until January 6' }));
    expect(mocks.pause).toHaveBeenCalledWith('2028-01-06T08:00:00.000Z');
  });

  it('a picked date ends at 9:00 that day and cannot be today', async () => {
    const user = setup();
    await user.click(screen.getByRole('radio', { name: 'Pick a date' }));
    const button = screen.getByRole('button', { name: 'Pick a date' });
    expect(button).toBeDisabled();
    const input = screen.getByLabelText('Callum comes back on');
    expect(input).toHaveAttribute('min', '2026-11-03');
    await user.type(input, '2026-12-01');
    await user.click(screen.getByRole('button', { name: 'Pause until December 1' }));
    expect(mocks.pause).toHaveBeenCalledWith('2026-12-01T08:00:00.000Z');
  });

  it('says why when the pause did not go through', async () => {
    mocks.pause.mockRejectedValue(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Pause until Monday' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Callum can't be reached");
  });

  it('while paused it says when things start and Resume brings Callum back', async () => {
    const state = appState({
      settings: { ...appState().settings, pauseState: 'paused', pausedUntil: '2026-11-09T08:00:00.000Z' },
      people: [person(1, 'Kemi', { status: 'waiting' })],
    });
    const user = setup(state);
    expect(screen.getByRole('heading', { name: 'Callum is resting until 9 Nov at 9:00' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing goes out until then\./)).toBeInTheDocument();
    expect(screen.getByText(/your 1 conversation stays yours/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.resumeAll).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Callum is back. Everyone picks up where they left off.')).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Change the date goes back to the choices', async () => {
    const state = appState({ settings: { ...appState().settings, pauseState: 'paused', pausedUntil: '2026-11-09T08:00:00.000Z' } });
    const user = setup(state);
    await user.click(screen.getByRole('button', { name: 'Change the date' }));
    expect(screen.getByRole('heading', { name: 'Take a break, or wrap up?' })).toBeInTheDocument();
  });

  it('Back to the river closes it', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Back to the river' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('LeaveSheet: wrap up', () => {
  async function openWrap(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Wrap up' }));
    await screen.findByRole('heading', { name: 'Wrap up Callum' });
  }

  it('shows what happens, with the work so far, and keeps the download on and the delete off', async () => {
    const user = setup();
    await openWrap(user);
    expect(await screen.findByText(new RegExp(LINE))).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Download everything' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Delete my data from this computer' })).not.toBeChecked();
    expect(screen.getByText('Kemi keeps talking with you in your own inbox')).toBeInTheDocument();
    expect(screen.queryByText("You won't be able to get these conversations back.")).not.toBeInTheDocument();
  });

  it('with Delete on and Download off it warns, then wraps up with deletion and shows the summary', async () => {
    const user = setup();
    await openWrap(user);
    await user.click(screen.getByRole('switch', { name: 'Download everything' }));
    await user.click(screen.getByRole('switch', { name: 'Delete my data from this computer' }));
    expect(screen.getByRole('alert')).toHaveTextContent("You won't be able to get these conversations back.");
    expect(screen.getByText("Callum deletes everything here once your files are saved. This can't be undone.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wrap up Callum' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Wrap up and delete' }));
    expect(save).not.toHaveBeenCalled();
    expect(mocks.wrap).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('heading', { name: 'All wrapped up' })).toBeInTheDocument();
    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.getByText(/Callum said hello to 36 people for you\. 8 replied, and 2 calls got booked\. Thanks for letting Callum help\./)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  const STOP_NOTE = 'People who asked you to stop stay on a private do-not-contact list, so they never hear from you again.';

  it('says what a deletion keeps, only when deleting, and again on the step before it happens', async () => {
    const user = setup();
    await openWrap(user);
    expect(screen.queryByText(STOP_NOTE)).not.toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Delete my data from this computer' }));
    expect(screen.getByText(STOP_NOTE)).toBeInTheDocument();
    expect(STOP_NOTE).not.toContain('!');
    await user.click(screen.getByRole('button', { name: 'Wrap up and delete' }));
    await screen.findByRole('heading', { name: 'Your files are saved' });
    expect(screen.getByText(STOP_NOTE)).toBeInTheDocument();
  });

  it('downloads the JSON and the spreadsheet before it wraps, and offers them again afterwards', async () => {
    const order: string[] = [];
    save.mockImplementation(async (_url: string, name: string) => {
      order.push(`save ${name}`);
      return { name, href: `blob:${name}`, bytes: 2048 };
    });
    mocks.wrap.mockImplementation(async () => {
      order.push('wrap');
      return { cancelledFollowUps: 28, cancelledHellos: 4, summary: SUMMARY };
    });
    const user = setup();
    await openWrap(user);
    await user.click(screen.getByRole('button', { name: 'Wrap up Callum' }));
    expect(await screen.findByRole('heading', { name: 'All wrapped up' })).toBeInTheDocument();
    expect(save).toHaveBeenNthCalledWith(1, '/api/export.json', 'callum-people.json');
    expect(save).toHaveBeenNthCalledWith(2, '/api/export.csv', 'callum-people.csv');
    expect(order).toEqual(['save callum-people.json', 'save callum-people.csv', 'wrap']);
    expect(mocks.wrap).toHaveBeenCalledWith(false);
    const again = screen.getAllByRole('link', { name: 'Download again' });
    expect(again.map((a) => a.getAttribute('href'))).toEqual(['blob:callum-people.json', 'blob:callum-people.csv']);
  });

  it('wraps nothing when the download fails, so nothing is lost', async () => {
    save.mockRejectedValueOnce(new Error('The download did not work, so Callum kept everything as it was.'));
    const user = setup();
    await openWrap(user);
    await user.click(screen.getByRole('switch', { name: 'Delete my data from this computer' }));
    await user.click(screen.getByRole('button', { name: 'Wrap up and delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The download did not work');
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(screen.queryByText('Your files are saved')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wrap up and delete' })).toBeInTheDocument();
  });

  it('with the download and the delete both on, it saves the files first and deletes only after a second press', async () => {
    const user = setup();
    await openWrap(user);
    await user.click(screen.getByRole('switch', { name: 'Delete my data from this computer' }));
    await user.click(screen.getByRole('button', { name: 'Wrap up and delete' }));
    expect(await screen.findByRole('heading', { name: 'Your files are saved' })).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(2);
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(screen.getAllByRole('link', { name: 'Download again' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Delete and wrap up' }));
    expect(mocks.wrap).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('heading', { name: 'All wrapped up' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Download again' }).map((a) => a.getAttribute('href'))).toEqual(['blob:callum-people.json', 'blob:callum-people.csv']);
  });

  it('Keep Callum on the saved step deletes nothing', async () => {
    const user = setup();
    await openWrap(user);
    await user.click(screen.getByRole('switch', { name: 'Delete my data from this computer' }));
    await user.click(screen.getByRole('button', { name: 'Wrap up and delete' }));
    await screen.findByRole('heading', { name: 'Your files are saved' });
    await user.click(screen.getByRole('button', { name: 'Keep Callum' }));
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Take a break, or wrap up?' })).toBeInTheDocument();
  });

  it('reads what the work so far was before it wraps, when that has not come back yet', async () => {
    let release: (v: { line: string }) => void = () => {};
    mocks.wrapSummary.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const user = setup();
    await openWrap(user);
    await user.click(screen.getByRole('button', { name: 'Wrap up Callum' }));
    expect(mocks.wrap).not.toHaveBeenCalled();
    release({ line: LINE });
    expect(await screen.findByRole('heading', { name: 'All wrapped up' })).toBeInTheDocument();
    expect(mocks.wrap).toHaveBeenCalledWith(false);
    expect(screen.getByText(new RegExp(LINE))).toBeInTheDocument();
  });

  it('Keep Callum goes back and changes nothing', async () => {
    const user = setup();
    await openWrap(user);
    await user.click(screen.getByRole('button', { name: 'Keep Callum' }));
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Take a break, or wrap up?' })).toBeInTheDocument();
  });
});
