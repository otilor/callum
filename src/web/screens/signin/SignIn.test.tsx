import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api.js';
import { SignIn } from './SignIn.js';

const mocks = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock('../../api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api.js')>()), api: mocks }));

const refresh = vi.fn(() => Promise.resolve());

function setup(mode: 'starting' | 'locked' = 'locked') {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<SignIn mode={mode} refresh={refresh} wakeMs={0} />);
  return user;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mocks.login.mockReset();
  refresh.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SignIn', () => {
  it('says Callum is starting while the first fetch is pending', () => {
    setup('starting');
    expect(screen.getByRole('heading', { name: 'Callum is starting' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('asks for the password it was installed with', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'This Callum is private' })).toBeInTheDocument();
    expect(screen.getByText('Enter the password you set when you installed it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('shows and hides what was typed', async () => {
    const user = setup();
    const field = screen.getByLabelText('Password');
    await user.type(field, 'reconcile');
    expect(field).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(field).toHaveAttribute('type', 'password');
  });

  it('answers a wrong password in plain words and keeps the field', async () => {
    mocks.login.mockRejectedValue(new ApiError(401, 'Sign in first'));
    const user = setup();
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That's not the password. Ask whoever set up this Callum, or check CALLUM_PASSWORD on the server.");
    expect(screen.getByLabelText('Password')).toHaveValue('nope');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows "Checking" while the server looks', async () => {
    let finish: () => void = () => undefined;
    mocks.login.mockReturnValue(new Promise<void>((res) => { finish = res; }));
    const user = setup();
    await user.type(screen.getByLabelText('Password'), 'reconcile');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('button', { name: 'Checking' })).toBeDisabled();
    await act(async () => finish());
  });

  it('counts down a lockout live and unlocks when it ends', async () => {
    mocks.login.mockRejectedValue(new ApiError(429, 'Too many tries. Try again in 3 s.', { retryAfter: 3 }));
    const user = setup();
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('button', { name: 'Try again in 3 s' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent("That's 5 wrong tries, so sign-in is paused for a minute. Nothing else changed.");
    expect(screen.getByLabelText('Password')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Password')).toHaveFocus();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole('button', { name: 'Try again in 2 s' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('Password')).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('wakes up and refreshes once the password is right', async () => {
    mocks.login.mockResolvedValue({ ok: true });
    const user = setup();
    await user.type(screen.getByLabelText('Password'), 'reconcile');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(mocks.login).toHaveBeenCalledWith('reconcile');
    expect(await screen.findByRole('heading', { name: 'Callum is waking up' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('says so when the server cannot be reached', async () => {
    mocks.login.mockRejectedValue(new ApiError(0, "Callum can't be reached. Check that it is still running."));
    const user = setup();
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Callum can't be reached. Check that it is still running.");
  });

  it('never uses an exclamation mark', async () => {
    mocks.login.mockRejectedValue(new ApiError(401, 'Sign in first'));
    const user = setup();
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain('!');
  });
});
