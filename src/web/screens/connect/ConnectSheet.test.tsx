import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, ChannelAccount } from '../../../shared/types.js';
import { ApiError } from '../../api.js';
import { ConnectSheet, type ConnectSheetProps } from './ConnectSheet.js';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  channelSummary: vi.fn(),
  microsoftStart: vi.fn(),
  microsoftPoll: vi.fn(),
  setup: vi.fn(),
}));
vi.mock('../../api.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api.js')>();
  return { ...original, api: { ...mocks, microsoftStart: mocks.microsoftStart, microsoftPoll: mocks.microsoftPoll }, channelSetup: { microsoft: mocks.setup, saveMicrosoftClientId: vi.fn() } };
});

function account(ch: Channel, status: ChannelAccount['status'] = 'connected', identity: string | null = null): ChannelAccount {
  return { channel: ch, status, identity, connectedAt: null, pausedUntil: null, halfPaceUntil: null, invitesBlockedUntil: null, lastPolledAt: null };
}

const PACE = { email: '20 a day this week, 120 by week 3', linkedin: '15 invites a day, runs on this computer while Callum is open', x: '20 messages a day' };

function setup(over: Partial<ConnectSheetProps> = {}) {
  const user = userEvent.setup();
  const onConnected = vi.fn();
  const onClose = vi.fn();
  render(<ConnectSheet accounts={{}} onConnected={onConnected} onClose={onClose} pollMs={10} {...over} />);
  return { user, onConnected, onClose };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.connect.mockImplementation((ch: Channel, fields: Record<string, string>) => Promise.resolve(account(ch, 'connected', fields.address ?? (ch === 'x' ? '@gabriel' : 'Gabriel'))));
  mocks.channelSummary.mockImplementation((ch: Channel) => Promise.resolve({ pending: { invites: 0, followUps: 0, emails: 0, messages: 0 }, paceLine: PACE[ch] }));
  mocks.setup.mockResolvedValue({ configured: true, source: 'env' });
});

describe('Email tab', () => {
  it('warns about a personal address without blocking it', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText('Email address'), 'gabriel@gmail.com');
    expect(screen.getByText('This looks like a personal address. Cold email works best from your company address.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Email address'));
    await user.type(screen.getByLabelText('Email address'), 'gabriel@yourcompany.com');
    expect(screen.queryByText(/personal address/)).not.toBeInTheDocument();
  });

  it('shows the three app-password steps with the Google link', () => {
    setup();
    expect(screen.getByText('Turn on 2-step verification')).toBeInTheDocument();
    expect(screen.getByText('Create an app password called Callum')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Google/ })).toHaveAttribute('href', 'https://myaccount.google.com/apppasswords');
  });

  it('connects Google with spaces taken out of the password and says how fast it will send', async () => {
    const { user, onConnected } = setup();
    await user.type(screen.getByLabelText('Email address'), 'gabriel@yourcompany.com');
    await user.type(screen.getByLabelText('App password'), 'abcd efgh ijkl mnop');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(mocks.connect).toHaveBeenCalledWith('email', { provider: 'google', address: 'gabriel@yourcompany.com', password: 'abcdefghijklmnop' });
    expect(await screen.findByText('Sending from gabriel@yourcompany.com. 20 a day this week, 120 by week 3.')).toBeInTheDocument();
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ identity: 'gabriel@yourcompany.com' }), 'email');
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('shows the server\'s words under the field and keeps what was typed', async () => {
    mocks.connect.mockRejectedValueOnce(new ApiError(422, "Google didn't accept that password. App passwords are 16 letters, with no spaces."));
    const { user, onConnected } = setup();
    await user.type(screen.getByLabelText('Email address'), 'gabriel@yourcompany.com');
    await user.type(screen.getByLabelText('App password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Google didn't accept that password. App passwords are 16 letters, with no spaces.");
    expect(screen.getByLabelText('App password')).toHaveValue('wrong');
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('asks for the address and the password before calling the server', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Add the email address to send from.');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('takes server names for another provider', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Another provider' }));
    await user.type(screen.getByLabelText('Sending server'), 'smtp.acme.test:465');
    await user.type(screen.getByLabelText('Inbox server'), 'imap.acme.test');
    await user.type(screen.getByLabelText('Email address'), 'gabriel@acme.test');
    await user.type(screen.getByLabelText('Email password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(mocks.connect).toHaveBeenCalledWith('email', {
      provider: 'custom', address: 'gabriel@acme.test', password: 'secret', smtpHost: 'smtp.acme.test', smtpPort: '465', imapHost: 'imap.acme.test', imapPort: '993',
    });
  });

  it('signs in to Microsoft with a short code and connects', async () => {
    mocks.microsoftStart.mockResolvedValue({ userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: '2026-11-02T10:15:00.000Z' });
    mocks.microsoftPoll.mockResolvedValueOnce({ status: 'waiting' }).mockResolvedValue({ status: 'connected', account: account('email', 'connected', 'gabriel@contoso.com') });
    const { user, onConnected } = setup({ provider: 'microsoft' });
    expect(screen.queryByLabelText('App password')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Email address'), 'gabriel@contoso.com');
    await user.click(screen.getByRole('button', { name: 'Open Microsoft' }));
    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
    expect(screen.getByText(/on Microsoft's page. Callum waits here./)).toBeInTheDocument();
    expect(mocks.microsoftStart).toHaveBeenCalledWith('gabriel@contoso.com');
    expect(await screen.findByText(/Sending from gabriel@contoso.com\./)).toBeInTheDocument();
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ identity: 'gabriel@contoso.com' }), 'email');
  });

  it('says why Microsoft is not ready when the one-time app setup is missing', async () => {
    mocks.setup.mockResolvedValue({ configured: false, source: null });
    setup({ provider: 'microsoft' });
    expect(await screen.findByText(/Microsoft needs a one-time app setup on this computer first\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /How to set it up/ })).toHaveAttribute('href', 'https://github.com/otilor/callum/blob/main/docs/SETUP.md#microsoft');
    expect(screen.getByRole('button', { name: 'Open Microsoft' })).toBeDisabled();
  });

  it('starts again with a new code when the first one ran out', async () => {
    mocks.microsoftStart.mockResolvedValue({ userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: '2026-11-02T10:15:00.000Z' });
    mocks.microsoftPoll.mockResolvedValue({ status: 'expired' });
    const { user } = setup({ provider: 'microsoft' });
    await user.type(screen.getByLabelText('Email address'), 'gabriel@contoso.com');
    await user.click(screen.getByRole('button', { name: 'Open Microsoft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code ran out. Open Microsoft again for a new one.');
    expect(screen.getByRole('button', { name: 'Open Microsoft' })).toBeEnabled();
  });

  it('shows a connected address and lets the person use another', async () => {
    const { user } = setup({ accounts: { email: account('email', 'connected', 'ada@acme.test') } });
    expect(await screen.findByText('Sending from ada@acme.test. 20 a day this week, 120 by week 3.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use another address' }));
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });

  it('opens on the form when reconnecting', () => {
    setup({ accounts: { email: account('email', 'error', 'ada@acme.test') }, reconnect: true });
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });
});

describe('LinkedIn tab', () => {
  it('waits for the window, can reopen it and then says who is connected', async () => {
    let resolveFirst: (a: ChannelAccount) => void = () => undefined;
    mocks.connect
      .mockImplementationOnce(() => new Promise<ChannelAccount>((res) => { resolveFirst = res; }))
      .mockResolvedValueOnce(account('linkedin', 'connected', 'Gabriel'));
    const { user, onConnected } = setup({ channel: 'linkedin' });
    await user.click(screen.getByRole('button', { name: 'Open LinkedIn' }));
    expect(mocks.connect).toHaveBeenCalledWith('linkedin', {});
    expect(await screen.findByText('Finish signing in on the LinkedIn window')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reopen the window' }));
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Connected as Gabriel')).toBeInTheDocument();
    // The first, abandoned window finishing late changes nothing.
    resolveFirst(account('linkedin', 'connected', 'Someone else'));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Connected as Gabriel')).toBeInTheDocument();
  });

  it('shows the server\'s words when the window is closed', async () => {
    mocks.connect.mockRejectedValueOnce(new ApiError(422, 'The LinkedIn window was closed before you finished signing in. Connect LinkedIn again when you are ready.'));
    const { user } = setup({ channel: 'linkedin' });
    await user.click(screen.getByRole('button', { name: 'Open LinkedIn' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The LinkedIn window was closed');
    expect(screen.getByRole('button', { name: 'Open LinkedIn' })).toBeInTheDocument();
  });

  it('keeps the li_at field behind "Running Callum on a server?" and checks its length', async () => {
    const { user } = setup({ channel: 'linkedin' });
    expect(screen.queryByLabelText('LinkedIn session cookie')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Running Callum on a server\?/ }));
    await user.type(screen.getByLabelText('LinkedIn session cookie'), 'short');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That cookie looks too short. Copy the whole li_at value.');
    await user.clear(screen.getByLabelText('LinkedIn session cookie'));
    await user.type(screen.getByLabelText('LinkedIn session cookie'), 'AQEDAS-a-long-enough-li_at-cookie-value');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(mocks.connect).toHaveBeenCalledWith('linkedin', { liAt: 'AQEDAS-a-long-enough-li_at-cookie-value' });
    expect(await screen.findByText('Connected from this server as Gabriel')).toBeInTheDocument();
  });
});

describe('X tab', () => {
  it('explains the paid plan and checks the token before asking the server', async () => {
    const { user } = setup({ channel: 'x' });
    expect(screen.getByText("X messages go through X's official API, which needs a paid X plan.")).toBeInTheDocument();
    await user.type(screen.getByLabelText('X access token'), 'short');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That doesn't look like an X access token.");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('shows the server\'s words for any other refusal', async () => {
    mocks.connect.mockRejectedValueOnce(new ApiError(422, "X didn't accept Callum's access. Check that your X plan includes direct messages."));
    const { user } = setup({ channel: 'x' });
    await user.type(screen.getByLabelText('X access token'), 'a'.repeat(40));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("X didn't accept Callum's access.");
  });

  it('connects and says who and how fast', async () => {
    const { user } = setup({ channel: 'x' });
    await user.type(screen.getByLabelText('X access token'), 'a'.repeat(40));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(mocks.connect).toHaveBeenCalledWith('x', { accessToken: 'a'.repeat(40) });
    expect(await screen.findByText('@gabriel. 20 messages a day.')).toBeInTheDocument();
  });
});

describe('the sheet', () => {
  it('switches tabs and marks the connected ones', async () => {
    const { user } = setup({ accounts: { x: account('x', 'connected', '@gabriel') } });
    const tabs = screen.getByRole('tablist', { name: 'Channels' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(3);
    await user.click(within(tabs).getByRole('tab', { name: 'X' }));
    expect(await screen.findByText('@gabriel. 20 messages a day.')).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys, and only the selected tab is a tab stop', async () => {
    const { user } = setup();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    tabs[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'LinkedIn', selected: true })).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Email', selected: true })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'X', selected: true })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const { user, onClose } = setup();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('never uses an exclamation mark', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: 'LinkedIn' }));
    await user.click(screen.getByRole('tab', { name: 'X' }));
    expect(document.body.textContent).not.toContain('!');
  });
});
