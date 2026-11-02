import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INCIDENT_COPY } from '../../../server/runner/incidents.js';
import type { AppState, Incident, OutboxItem } from '../../../shared/types.js';
import { ApiError } from '../../api.js';
import { appState, channel, incident, outboxItem, person } from '../../test/phoneLeaveFixtures.js';
import { ToastProvider } from '../../ui/Toast.js';
import { IncidentCards, stillChannels } from './IncidentCard.js';

const mocks = vi.hoisted(() => ({ resumeChannel: vi.fn(), retry: vi.fn(), editBlocked: vi.fn(), dismissIncident: vi.fn() }));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const refresh = vi.fn(() => Promise.resolve());
const onReconnect = vi.fn();
let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.resumeChannel.mockReset();
  mocks.retry.mockReset();
  mocks.editBlocked.mockReset();
  mocks.dismissIncident.mockReset();
  mocks.dismissIncident.mockResolvedValue({});
  refresh.mockClear();
  onReconnect.mockClear();
  open = vi.fn();
  vi.stubGlobal('open', open);
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

function setup(state: AppState) {
  const user = userEvent.setup();
  const view = render(
    <ToastProvider>
      <IncidentCards state={state} refresh={refresh} onReconnect={onReconnect} now={() => new Date('2026-11-02T10:00:00Z')} />
    </ToastProvider>,
  );
  return { user, ...view };
}

const waitingOnLinkedIn = [person(1, 'Ada', { channel: 'linkedin' }), person(2, 'Chidi', { channel: 'linkedin' }), person(3, 'Kemi')];

describe('IncidentCards: LinkedIn wants to check it is you', () => {
  const state = () =>
    appState({
      channels: [channel('email', 'connected'), channel('linkedin', 'paused'), channel('x')],
      people: waitingOnLinkedIn,
      incidents: [incident(1, 'linkedin_check', INCIDENT_COPY.linkedin_check)],
    });

  it('says what happened and what to do, with the people who wait', () => {
    setup(state());
    const card = screen.getByRole('region', { name: 'Needs your attention' });
    expect(within(card).getByRole('heading', { name: "LinkedIn wants to check it's you" })).toBeInTheDocument();
    expect(within(card).getByText(INCIDENT_COPY.linkedin_check)).toBeInTheDocument();
    expect(within(card).getByText('Finish the check on LinkedIn, then come back to resume.')).toBeInTheDocument();
    expect(within(card).getByText('2 people wait for LinkedIn. Nothing is lost.')).toBeInTheDocument();
    expect(within(card).getByText('Today at 11:00')).toBeInTheDocument();
  });

  it('walks alert, waiting, clear, then resumes at half pace', async () => {
    mocks.resumeChannel.mockResolvedValue({});
    const { user } = setup(state());

    await user.click(screen.getByRole('button', { name: /Open LinkedIn/ }));
    expect(open).toHaveBeenCalledWith('https://www.linkedin.com/feed/', '_blank', 'noopener');
    expect(await screen.findByRole('heading', { name: 'Finish the check on LinkedIn' })).toBeInTheDocument();
    expect(screen.getByText('Finish the check, then come back.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: "Done, I've finished the check" }));
    expect(screen.getByRole('heading', { name: 'All clear' })).toBeInTheDocument();
    const half = screen.getByRole('radio', { name: 'Half pace for a week (7 invites a day)' });
    const full = screen.getByRole('radio', { name: 'Full pace (15 a day)' });
    expect(half).toBeChecked();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    await user.click(full);
    await user.click(half);

    await user.click(screen.getByRole('button', { name: 'Resume LinkedIn' }));
    expect(mocks.resumeChannel).toHaveBeenCalledWith('linkedin', 'half', true);
    expect(await screen.findByText('LinkedIn is back on')).toBeInTheDocument();
    expect(screen.getByText(/The 2 people who waited go first\. 7 invites a day for a week, then 15\./)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('takes focus to the heading of each new step', async () => {
    mocks.resumeChannel.mockResolvedValue({});
    const { user } = setup(state());
    await user.click(screen.getByRole('button', { name: /Open LinkedIn/ }));
    expect(screen.getByRole('heading', { name: 'Finish the check on LinkedIn' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: "Done, I've finished the check" }));
    expect(screen.getByRole('heading', { name: 'All clear' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Resume LinkedIn' }));
    expect(await screen.findByText('LinkedIn is back on')).toHaveFocus();
  });

  it('full pace sends full', async () => {
    mocks.resumeChannel.mockResolvedValue({});
    const { user } = setup(state());
    await user.click(screen.getByRole('button', { name: /Open LinkedIn/ }));
    await user.click(screen.getByRole('button', { name: "Done, I've finished the check" }));
    await user.click(screen.getByRole('radio', { name: 'Full pace (15 a day)' }));
    await user.click(screen.getByRole('button', { name: 'Resume LinkedIn' }));
    expect(mocks.resumeChannel).toHaveBeenCalledWith('linkedin', 'full', true);
  });

  it('keeps the resumed line on screen after the server settles the incident', async () => {
    mocks.resumeChannel.mockResolvedValue({});
    const first = state();
    const { user, rerender } = setup(first);
    await user.click(screen.getByRole('button', { name: /Open LinkedIn/ }));
    await user.click(screen.getByRole('button', { name: "Done, I've finished the check" }));
    await user.click(screen.getByRole('button', { name: 'Resume LinkedIn' }));
    await screen.findByText('LinkedIn is back on');
    rerender(
      <ToastProvider>
        <IncidentCards state={{ ...first, incidents: [] }} refresh={refresh} onReconnect={onReconnect} />
      </ToastProvider>,
    );
    expect(screen.getByText('LinkedIn is back on')).toBeInTheDocument();
  });

  it('says why when LinkedIn could not be resumed, and stays on the pace choice', async () => {
    mocks.resumeChannel.mockRejectedValue(new ApiError(422, 'LinkedIn is not connected.'));
    const { user } = setup(state());
    await user.click(screen.getByRole('button', { name: /Open LinkedIn/ }));
    await user.click(screen.getByRole('button', { name: "Done, I've finished the check" }));
    await user.click(screen.getByRole('button', { name: 'Resume LinkedIn' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('LinkedIn is not connected.');
    expect(screen.getByRole('heading', { name: 'All clear' })).toBeInTheDocument();
  });
});

describe('IncidentCards: the other kinds', () => {
  it('a signed-out mailbox offers Reconnect Google, which reopens the email connect sheet', async () => {
    const message = INCIDENT_COPY.mailbox_signed_out('Google', 'gabriel@yourcompany.com', 14);
    const { user } = setup(appState({ incidents: [incident(2, 'mailbox_signed_out', message)] }));
    expect(screen.getByRole('heading', { name: 'Google signed Callum out' })).toBeInTheDocument();
    // The title says who signed Callum out; the card does not repeat it, and does not count messages next to the people line.
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(screen.queryByText(/signed Callum out of/)).not.toBeInTheDocument();
    expect(screen.getByText('Callum paused email. Nothing was lost.')).toBeInTheDocument();
    expect(screen.getByText('Reconnect Google to send them.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconnect Google' }));
    expect(onReconnect).toHaveBeenCalledWith('email');
  });

  it('a signed-out custom mail server does not repeat its title or count emails that contradict the people line', () => {
    const message = INCIDENT_COPY.mailbox_signed_out('Your mail server', 'gabriel@yourcompany.com', 0);
    setup(appState({ incidents: [incident(2, 'mailbox_signed_out', message)] }));
    expect(screen.getByRole('heading', { name: 'Your mail server signed Callum out' })).toBeInTheDocument();
    expect(screen.queryByText(/No emails are waiting/)).not.toBeInTheDocument();
    expect(screen.queryByText(/signed Callum out of/)).not.toBeInTheDocument();
    expect(screen.getByText('Callum paused email. Nothing was lost.')).toBeInTheDocument();
  });

  it('bounces say how many and Okay puts the notice away for good', async () => {
    const detail = JSON.stringify({ domain: 'fieldnote.com', people: [{ id: 1, fallback: 'linkedin' }, { id: 2, fallback: null }] });
    const state = appState({ incidents: [incident(3, 'bounces', INCIDENT_COPY.bounces(2, 'fieldnote.com', 'LinkedIn'), { detail })] });
    const { user, unmount } = setup(state);
    expect(screen.getByRole('heading', { name: '2 emails bounced' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Okay' }));
    expect(screen.queryByRole('heading', { name: '2 emails bounced' })).not.toBeInTheDocument();
    // Okay settles the notice on the server too, not only in this browser.
    expect(mocks.dismissIncident).toHaveBeenCalledWith(3);
    unmount();
    setup(state);
    expect(screen.queryByRole('heading', { name: '2 emails bounced' })).not.toBeInTheDocument();
  });

  it('the X limit and the weekly LinkedIn limit are told once and dismissed with Okay', async () => {
    const state = appState({
      incidents: [incident(4, 'x_limit', INCIDENT_COPY.x_limit), incident(5, 'linkedin_weekly_limit', INCIDENT_COPY.linkedin_weekly_limit)],
    });
    const { user } = setup(state);
    expect(screen.getByRole('heading', { name: 'X stopped taking messages' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "LinkedIn's weekly limit" })).toBeInTheDocument();
    const okays = screen.getAllByRole('button', { name: 'Okay' });
    expect(okays).toHaveLength(2);
    await user.click(okays[0] as HTMLElement);
    expect(screen.queryByRole('heading', { name: 'X stopped taking messages' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "LinkedIn's weekly limit" })).toBeInTheDocument();
  });

  const failed = () =>
    appState({
      people: [person(7, 'Tomas')],
      outbox: [outboxItem(21, 7, { state: 'failed', body: "Hi Tomas, Thursday at 14:00 works well. I'll send an invite tonight." })],
      incidents: [incident(6, 'send_failed', INCIDENT_COPY.send_failed('Tomas', "Gmail says Tomas's mailbox is full"), { personId: 7, detail: JSON.stringify({ outboxId: 21 }) })],
    });

  it('a reply that did not go shows the words kept word for word, and Try again sends them', async () => {
    mocks.retry.mockResolvedValue({});
    const { user } = setup(failed());
    expect(screen.getByRole('heading', { name: "Your reply to Tomas didn't go out" })).toBeInTheDocument();
    expect(screen.getByText("Hi Tomas, Thursday at 14:00 works well. I'll send an invite tonight.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.retry).toHaveBeenCalledWith(21);
    expect(await screen.findByText('Callum is sending it again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    expect(refresh).toHaveBeenCalled();
  });

  it('when the failed reply is no longer kept it offers the conversation instead of Copy', async () => {
    const onOpenPerson = vi.fn();
    const state = { ...failed(), outbox: [] };
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <IncidentCards state={state} refresh={refresh} onReconnect={onReconnect} onOpenPerson={onOpenPerson} />
      </ToastProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Open Tomas's conversation" }));
    expect(onOpenPerson).toHaveBeenCalledWith(7);
  });

  it('Copy puts the reply on the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { user } = setup(failed());
    // user-event installs its own clipboard when it is set up, so the stand-in goes on afterwards.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith("Hi Tomas, Thursday at 14:00 works well. I'll send an invite tonight.");
    expect(await screen.findByText('Copied. Paste it wherever you talk to Tomas.')).toBeInTheDocument();
  });

  it('shows nothing when nothing is open', () => {
    const { container } = setup(appState({ incidents: [incident(9, 'x_limit', 'x', { state: 'resolved' })] }));
    expect(container.querySelector('.inc-stack')).toBeNull();
  });
});

describe('IncidentCards: the kinds the runner opens on its own', () => {
  it('an X or LinkedIn sign-out offers to connect that channel again', async () => {
    const { user } = setup(
      appState({
        channels: [channel('email', 'connected'), channel('linkedin', 'error'), channel('x', 'error')],
        incidents: [
          incident(1, 'x_signed_out', INCIDENT_COPY.x_signed_out(2)),
          incident(2, 'linkedin_signed_out', INCIDENT_COPY.linkedin_signed_out(1)),
        ],
      }),
    );
    expect(screen.getByRole('heading', { name: 'X signed Callum out' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'LinkedIn signed Callum out' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconnect X' }));
    expect(onReconnect).toHaveBeenLastCalledWith('x');
    await user.click(screen.getByRole('button', { name: 'Reconnect LinkedIn' }));
    expect(onReconnect).toHaveBeenLastCalledWith('linkedin');
  });

  it('a channel that is not answering offers to connect it again, or Okay', async () => {
    const { user } = setup(appState({ incidents: [incident(1, 'not_answering', INCIDENT_COPY.not_answering('Email'))] }));
    expect(screen.getByRole('heading', { name: "Email isn't answering" })).toBeInTheDocument();
    expect(screen.getByText('Callum keeps trying. If it stays quiet, connect it again.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect email again' }));
    expect(onReconnect).toHaveBeenCalledWith('email');
    await user.click(screen.getByRole('button', { name: 'Okay' }));
    expect(screen.queryByRole('heading', { name: "Email isn't answering" })).not.toBeInTheDocument();
  });

  it('a reply Callum could not read opens the conversation', async () => {
    const onOpenPerson = vi.fn();
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <IncidentCards
          state={appState({ people: [person(1, 'Kemi')], incidents: [incident(1, 'reply_unread', INCIDENT_COPY.reply_unread('Kemi'), { personId: 1 })] })}
          refresh={refresh}
          onReconnect={onReconnect}
          onOpenPerson={onOpenPerson}
        />
      </ToastProvider>,
    );
    expect(screen.getByRole('heading', { name: "Callum couldn't read a reply from Kemi" })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Open Kemi's conversation" }));
    expect(onOpenPerson).toHaveBeenCalledWith(1);
  });

  it('a reply on a channel with no name to open is told once and put away with Okay', async () => {
    const { user } = setup(appState({ incidents: [incident(1, 'reply_unread', INCIDENT_COPY.reply_unread_unknown('email'))] }));
    expect(screen.getByText('Check that channel by hand, then press Okay.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Okay' }));
    expect(screen.queryByRole('region', { name: 'Needs your attention' })).not.toBeInTheDocument();
  });

  it('a reply held back by the mailbox limit is only told, with nothing to retry', async () => {
    setup(
      appState({
        people: [person(1, 'Kemi')],
        incidents: [incident(1, 'send_failed', INCIDENT_COPY.send_deferred('Kemi', 'tomorrow at 9:00'), { personId: 1, detail: JSON.stringify({ outboxId: 4, deferred: true }) })],
      }),
    );
    expect(screen.getByRole('heading', { name: 'Your reply to Kemi is waiting' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Okay' })).toBeInTheDocument();
  });

  it('shows only the incidents it is asked to', () => {
    render(
      <ToastProvider>
        <IncidentCards
          state={appState({ incidents: [incident(1, 'not_answering', 'a'), incident(2, 'x_limit', 'b')] })}
          refresh={refresh}
          onReconnect={onReconnect}
          include={(i) => i.kind === 'x_limit'}
        />
      </ToastProvider>,
    );
    expect(screen.queryByRole('heading', { name: "Email isn't answering" })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'X stopped taking messages' })).toBeInTheDocument();
  });
});

describe('stillChannels', () => {
  it('lists the channels that are paused or signed out, so the river holds their people still', () => {
    const state = appState({ channels: [channel('email', 'connected'), channel('linkedin', 'paused'), channel('x', 'error')] });
    expect(stillChannels(state)).toEqual(['linkedin', 'x']);
    expect(stillChannels(appState())).toEqual([]);
  });
});

describe('IncidentCards: Callum\'s own messages that did not go', () => {
  const auto = (ids: number[], over: Partial<Incident> = {}) =>
    incident(7, 'send_failed', "Callum couldn't send 3 follow-ups by LinkedIn today", {
      channel: 'linkedin',
      detail: JSON.stringify({ auto: true, day: '2026-11-02', outboxId: ids[0], outboxIds: ids, personIds: [11, 12, 13] }),
      ...over,
    });
  const item = (id: number, personId: number, over: Partial<OutboxItem> = {}) =>
    outboxItem(id, personId, { channel: 'linkedin', kind: 'follow_up', origin: 'auto', state: 'failed', error: "LinkedIn couldn't send the message.", body: 'Hi, a quick follow-up.', ...over });
  const people = [person(11, 'Kemi', { channel: 'linkedin' }), person(12, 'Tunde', { channel: 'linkedin' }), person(13, 'Bola', { channel: 'linkedin' })];

  function stuck(over: Partial<AppState> = {}) {
    return appState({
      channels: [channel('email', 'connected'), channel('linkedin', 'connected'), channel('x')],
      people,
      outbox: [
        item(101, 11, { state: 'blocked', error: 'Add your price first. Callum never sends a message with [YOUR PRICE] in it.', body: 'The pilot is [YOUR PRICE].' }),
        item(102, 12),
        item(103, 13, { detail: '{"maybeSent":true}', error: 'Callum was closed while this was going out.' }),
      ],
      incidents: [auto([101, 102, 103])],
      ...over,
    });
  }

  it('is one card with the sentence as its title and every person on it', () => {
    setup(stuck());
    const card = screen.getByRole('region', { name: 'Needs your attention' });
    expect(within(card).getAllByRole('heading')).toHaveLength(1);
    expect(within(card).getByRole('heading', { name: "Callum couldn't send 3 follow-ups by LinkedIn today" })).toBeInTheDocument();
    for (const name of ['Kemi Eze', 'Tunde Eze', 'Bola Eze']) expect(within(card).getByText(name)).toBeInTheDocument();
    expect(card.textContent).not.toContain('!');
  });

  it('lets the user fix a blocked message in place and sends the new words', async () => {
    mocks.editBlocked.mockResolvedValue({});
    const { user } = setup(stuck());
    const row = screen.getByText('Kemi Eze').closest('li') as HTMLElement;
    expect(within(row).getByText(/Add your price first/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Fix it' }));
    const box = within(row).getByRole('textbox', { name: 'Message to Kemi' });
    expect(box).toHaveValue('The pilot is [YOUR PRICE].');
    await user.clear(box);
    await user.type(box, 'The pilot is 400 dollars.');
    await user.click(within(row).getByRole('button', { name: 'Save and send' }));
    expect(mocks.editBlocked).toHaveBeenCalledWith(101, 'The pilot is 400 dollars.');
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the server\'s words when the fixed message still has a blank', async () => {
    mocks.editBlocked.mockRejectedValue(new ApiError(422, 'Add your price first. Callum never sends a message with [YOUR PRICE] in it.'));
    const { user } = setup(stuck());
    const row = screen.getByText('Kemi Eze').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Fix it' }));
    await user.click(within(row).getByRole('button', { name: 'Save and send' }));
    expect(await within(row).findByText(/Add your price first/, { selector: '[role="alert"], [role="alert"] *' })).toBeInTheDocument();
  });

  it('tries a failed message again with one press', async () => {
    mocks.retry.mockResolvedValue({});
    const { user } = setup(stuck());
    const row = screen.getByText('Tunde Eze').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Try again' }));
    expect(mocks.retry).toHaveBeenCalledWith(102);
    expect(refresh).toHaveBeenCalled();
  });

  it('asks first when the message may have gone out already, and sends nothing until the user says yes', async () => {
    mocks.retry.mockResolvedValue({});
    const { user } = setup(stuck());
    const row = screen.getByText('Bola Eze').closest('li') as HTMLElement;
    expect(within(row).getByText("Callum couldn't confirm it went out.")).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Try again' }));
    expect(within(row).getByText('This may have gone out already. Send again?')).toBeInTheDocument();
    expect(mocks.retry).not.toHaveBeenCalled();
    await user.click(within(row).getByRole('button', { name: 'Not now' }));
    expect(mocks.retry).not.toHaveBeenCalled();
    await user.click(within(row).getByRole('button', { name: 'Try again' }));
    await user.click(within(row).getByRole('button', { name: 'Send again' }));
    expect(mocks.retry).toHaveBeenCalledWith(103, true);
  });

  it('drops a person from the card once their message is no longer stuck', () => {
    const state = stuck();
    state.outbox = state.outbox.map((o) => (o.id === 101 ? { ...o, state: 'scheduled' as const } : o));
    setup(state);
    expect(screen.queryByText('Kemi Eze')).not.toBeInTheDocument();
    expect(screen.getByText('Tunde Eze')).toBeInTheDocument();
  });
});

describe('IncidentCards: a channel paused because sends could not be confirmed', () => {
  const paused = () =>
    appState({
      channels: [channel('email', 'connected'), channel('linkedin', 'paused'), channel('x')],
      people: [person(1, 'Ada', { channel: 'linkedin' }), person(2, 'Chidi', { channel: 'linkedin' })],
      incidents: [incident(9, 'channel_paused', INCIDENT_COPY.channel_paused('linkedin'), { channel: 'linkedin' })],
    });

  it('says what happened, and resumes only after the user has checked', async () => {
    mocks.resumeChannel.mockResolvedValue({});
    const { user } = setup(paused());
    expect(screen.getByRole('heading', { name: 'LinkedIn is paused' })).toBeInTheDocument();
    expect(screen.getByText(INCIDENT_COPY.channel_paused('linkedin'))).toBeInTheDocument();
    expect(screen.getByText('2 people wait for LinkedIn. Nothing is lost.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "I've checked, resume LinkedIn" }));
    expect(mocks.resumeChannel).toHaveBeenCalledWith('linkedin', 'full', true);
  });
});
