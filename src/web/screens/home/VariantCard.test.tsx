import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api.js';
import { appState, channel, incident, NOW, outboxItem, person } from '../../test/fixtures.js';
import { VariantStack } from './VariantCard.js';

const mocks = vi.hoisted(() => ({ retry: vi.fn(), remove: vi.fn(), act: vi.fn() }));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const now = () => NOW;

function stack(state = appState(), over: Partial<React.ComponentProps<typeof VariantStack>> = {}) {
  const props = { state, onReconnect: vi.fn(), onChanged: vi.fn(), now, ...over };
  return { ...render(<VariantStack {...props} />), props };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('VariantStack', () => {
  it('shows nothing when nothing is wrong', () => {
    expect(stack().container).toBeEmptyDOMElement();
  });

  it('reconnects the signed-out channel', async () => {
    const s = appState({ incidents: [incident(1, 'mailbox_signed_out', { message: 'Google signed Callum out of gabriel@yourcompany.com. 3 emails are waiting and nothing was lost.' })] });
    const { props } = stack(s);
    const card = screen.getByRole('region', { name: 'Google signed Callum out' });
    expect(within(card).getByText('Today at 9:14')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Reconnect Google' }));
    expect(props.onReconnect).toHaveBeenCalledWith('email');
  });

  it('tries a failed reply again, and copies it', async () => {
    mocks.retry.mockResolvedValue({ id: 32 });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const s = appState({
      people: [person(9, 'Tomás Ortega')],
      incidents: [incident(6, 'send_failed', { personId: 9, message: "Your reply to Tomás didn't go out: Gmail says the mailbox is full. It's saved here.", detail: '{"outboxId":31}' })],
      outbox: [outboxItem(31, 9, { state: 'failed', body: 'Hi Tomás, Thursday at 14:00 works well.' })],
    });
    const { props } = stack(s);
    expect(screen.getByText('Hi Tomás, Thursday at 14:00 works well.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Hi Tomás, Thursday at 14:00 works well.');
    expect(await screen.findByText('Copied. Paste it wherever you talk to Tomás.')).toBeInTheDocument();
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('retries and says the reply is on its way', async () => {
    mocks.retry.mockResolvedValue({ id: 32 });
    const s = appState({
      people: [person(9, 'Tomás Ortega')],
      incidents: [incident(6, 'send_failed', { personId: 9, message: "Your reply to Tomás didn't go out: Gmail says the mailbox is full. It's saved here.", detail: '{"outboxId":31}' })],
      outbox: [outboxItem(31, 9, { state: 'failed', body: 'Hi' })],
    });
    const { props } = stack(s);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.retry).toHaveBeenCalledWith(31);
    expect(await screen.findByText('Trying again. Your reply to Tomás leaves in a few seconds.')).toBeInTheDocument();
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('moves the waiting LinkedIn invites to email', async () => {
    mocks.act.mockResolvedValue({ text: '2 people get their hello by email instead.', personIds: [], action: null });
    const s = appState({
      people: [1, 2].map((i) => person(i, `Li ${i}`, { channel: 'linkedin', linkedinUrl: `https://linkedin.com/in/${i}` })),
      incidents: [incident(7, 'linkedin_weekly_limit', { channel: 'linkedin', message: "LinkedIn's weekly invite limit is reached. New invites wait until Monday." })],
    });
    const { props } = stack(s);
    await userEvent.click(screen.getByRole('button', { name: 'Move these 2 to email' }));
    expect(mocks.act).toHaveBeenCalledWith({ kind: 'switch_channel', label: 'Move 2 to email', args: { personIds: [1, 2], channel: 'email' } }, 1);
    expect(await screen.findByText('2 people get their hello by email instead.')).toBeInTheDocument();
    expect(props.onChanged).toHaveBeenCalled();
  });

  it('says why when Callum could not do it, and keeps the buttons', async () => {
    mocks.act.mockRejectedValue(new ApiError(422, 'Nobody can move yet.'));
    const s = appState({
      people: [person(1, 'Li One', { channel: 'linkedin' })],
      incidents: [incident(7, 'linkedin_weekly_limit', { channel: 'linkedin', message: "LinkedIn's weekly invite limit is reached." })],
    });
    stack(s);
    await userEvent.click(screen.getByRole('button', { name: 'Move this 1 to email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nobody can move yet.');
    expect(screen.getByRole('button', { name: 'Wait until Monday' })).toBeEnabled();
  });

  it('skips bounced people instead', async () => {
    mocks.remove.mockResolvedValue({});
    const s = appState({
      people: [person(5, 'Fi One'), person(6, 'Fi Two')],
      incidents: [incident(3, 'bounces', { message: '2 addresses at x.com bounced. Callum removed them and will try LinkedIn for those people.', detail: JSON.stringify({ domain: 'x.com', people: [{ id: 5, fallback: 'linkedin' }, { id: 6, fallback: 'linkedin' }] }) })],
    });
    stack(s);
    await userEvent.click(screen.getByRole('button', { name: 'Skip them instead' }));
    expect(mocks.remove).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Those 2 people won't hear from you. Everyone else carries on.")).toBeInTheDocument();
  });

  it('opens the X plan page in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const s = appState({
      channels: [channel('email'), channel('linkedin'), channel('x', 'paused', { pausedUntil: '2026-11-03T23:00:00.000Z' })],
      incidents: [incident(5, 'x_limit', { channel: 'x', message: "X stopped accepting Callum's messages because your X plan's daily limit is reached." })],
    });
    stack(s);
    await userEvent.click(screen.getByRole('button', { name: 'Raise the X plan' }));
    expect(open).toHaveBeenCalledWith('https://developer.x.com/en/portal/products', '_blank', 'noopener');
    open.mockRestore();
  });

  it('remembers Okay on a quiet card', async () => {
    const s = appState({ people: [person(11, 'Ruth Mensah', { status: 'stopped', replyKind: 'stop', repliedAt: '2026-11-03T06:31:00.000Z', lastInbound: 'Please take me off your list.' })] });
    const first = stack(s);
    expect(screen.getByText('Please take me off your list.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Okay' }));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    expect(stack(s).container).toBeEmptyDOMElement();
  });
});

describe('VariantStack with collapse (the desktop Home)', () => {
  const older = { createdAt: '2026-11-03T06:00:00.000Z' };
  const newer = { createdAt: '2026-11-03T08:30:00.000Z' };
  const three = () => appState({
    channels: [channel('email', 'error'), channel('linkedin'), channel('x', 'paused', { pausedUntil: '2026-11-03T23:00:00.000Z' })],
    incidents: [
      incident(1, 'mailbox_signed_out', { message: 'Google signed Callum out of gabriel@yourcompany.com.', ...older }),
      incident(2, 'linkedin_weekly_limit', { channel: 'linkedin', message: "LinkedIn's weekly invite limit is reached.", ...older }),
      incident(3, 'x_limit', { channel: 'x', message: "X stopped accepting Callum's messages because your X plan's daily limit is reached.", ...newer }),
    ],
  });

  it('shows only the newest card and a quiet button that counts the rest', () => {
    stack(three(), { collapse: true });
    expect(screen.getByRole('heading', { name: 'X stopped taking messages' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Google signed Callum out' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "LinkedIn's weekly limit" })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 more things need you' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the rest from the keyboard and closes them again', async () => {
    const user = userEvent.setup();
    stack(three(), { collapse: true });
    await user.tab(); // the newest card's first button
    const more = screen.getByRole('button', { name: '2 more things need you' });
    more.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'Google signed Callum out' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "LinkedIn's weekly limit" })).toBeInTheDocument();
    const fewer = screen.getByRole('button', { name: 'Show fewer' });
    expect(fewer).toHaveAttribute('aria-expanded', 'true');
    expect(fewer).toHaveAttribute('aria-controls', document.querySelector('.vc-rest')?.id ?? 'missing');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('heading', { name: 'Google signed Callum out' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 more things need you' })).toBeInTheDocument();
  });

  it('says one more thing needs you, in the singular', () => {
    const s = three();
    stack({ ...s, incidents: s.incidents.slice(1) }, { collapse: true });
    expect(screen.getByRole('button', { name: '1 more thing needs you' })).toBeInTheDocument();
  });

  it('puts a card that needs you before a quiet notice, even when the notice is newer', () => {
    const quiet = person(11, 'Ruth Mensah', { status: 'stopped', replyKind: 'stop', repliedAt: '2026-11-03T09:00:00.000Z', lastInbound: 'Please take me off your list.' });
    const s = appState({
      people: [quiet],
      incidents: [incident(1, 'mailbox_signed_out', { message: 'Google signed Callum out of gabriel@yourcompany.com.', ...older })],
    });
    stack(s, { collapse: true });
    expect(screen.getByRole('heading', { name: 'Google signed Callum out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 more thing needs you' })).toBeInTheDocument();
  });

  it('shows a single card as it is, with no button', () => {
    const s = three();
    stack({ ...s, incidents: s.incidents.slice(2) }, { collapse: true });
    expect(screen.getByRole('heading', { name: 'X stopped taking messages' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more thing/ })).not.toBeInTheDocument();
  });

  it('keeps every card on screen when collapse is off, as on the phone', () => {
    stack(three());
    expect(screen.getAllByRole('region')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /more thing/ })).not.toBeInTheDocument();
  });
});
