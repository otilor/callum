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
    expect(mocks.act).toHaveBeenCalledWith({ kind: 'switch_channel', label: 'Move 2 to email', args: { personIds: [1, 2], channel: 'email' } });
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
