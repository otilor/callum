import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChannelAccount } from '../../../shared/types.js';
import { api, ApiError, type DeviceCodeStart } from '../../api.js';
import { Button } from '../../ui/Button.js';
import { ErrorLine } from './icons.js';
import { Sheet } from './Sheet.js';

export const PERSONAL_DOMAINS = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'];
export const NEVER_SEES = 'Callum sends from your own accounts and never sees your passwords.';

export function isPersonalAddress(address: string): boolean {
  const domain = address.trim().toLowerCase().split('@')[1] ?? '';
  return PERSONAL_DOMAINS.includes(domain);
}

function messageOf(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

export interface EmailSheetProps {
  provider: 'google' | 'microsoft';
  /** Google: signs in with the app password and resolves when the account is connected. */
  onConnect(fields: Record<string, string>): Promise<void>;
  /** Microsoft: the device-code sign-in finished. */
  onConnected(account: ChannelAccount | undefined): void;
  onClose(): void;
  pollMs?: number;
}

export function EmailSheet({ provider: initial, onConnect, onConnected, onClose, pollMs = 3000 }: EmailSheetProps) {
  const [provider, setProvider] = useState(initial);
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [device, setDevice] = useState<DeviceCodeStart | null>(null);
  const finished = useRef(onConnected);
  finished.current = onConnected;

  // Microsoft: wait here for the person to enter the code on Microsoft's page.
  useEffect(() => {
    if (!device) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await api.microsoftPoll(address.trim());
        if (stopped) return;
        if (res.status === 'connected') {
          finished.current(res.account);
          return;
        }
        if (res.status === 'expired') {
          setDevice(null);
          setError('That code ran out. Open Microsoft again for a new one.');
          return;
        }
        if (res.status === 'denied') {
          setDevice(null);
          setError('Microsoft said no. Open Microsoft again when you are ready.');
          return;
        }
      } catch (e) {
        if (stopped) return;
        setDevice(null);
        setError(messageOf(e));
        return;
      }
      timer = setTimeout(() => void tick(), pollMs);
    };
    timer = setTimeout(() => void tick(), pollMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [device, address, pollMs]);

  const addressOk = /^[^@\s]+@[^@\s]+$/.test(address.trim());

  const submitGoogle = async () => {
    if (busy) return;
    setError('');
    if (!addressOk) return setError('Add the email address to send from.');
    const clean = password.replace(/\s+/g, '');
    if (!clean) return setError('Add the app password for that address.');
    setBusy(true);
    try {
      await onConnect({ provider: 'google', address: address.trim(), password: clean });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  const openMicrosoft = async () => {
    if (busy) return;
    setError('');
    if (!addressOk) return setError('Add the email address to send from.');
    setBusy(true);
    try {
      setDevice(await api.microsoftStart(address.trim()));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: 'google' | 'microsoft') => {
    if (busy || device) return;
    setProvider(next);
    setError('');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (provider === 'google') void submitGoogle();
    else if (!device) void openMicrosoft();
  };

  return (
    <Sheet label="Connect your email" onClose={onClose}>
      <h2>Connect your email</h2>
      <div className="sheet-seg" role="group" aria-label="Email provider">
        <button type="button" className="seg-btn" aria-pressed={provider === 'google'} onClick={() => switchTo('google')}>Google</button>
        <button type="button" className="seg-btn" aria-pressed={provider === 'microsoft'} onClick={() => switchTo('microsoft')}>Microsoft</button>
      </div>

      <form className="sheet-form" onSubmit={submit}>
        <label className="sheet-field">
          <span>Your email address</span>
          <input
            className="sheet-input"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            value={address}
            disabled={busy || device !== null}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="you@yourcompany.com"
          />
        </label>
        {isPersonalAddress(address) ? (
          <p className="sheet-warn">This looks like a personal address. Cold email works best from your company address.</p>
        ) : null}

        {provider === 'google' ? (
          <>
            <p>
              Google needs an app password. Open Google, make one called Callum and paste it here.{' '}
              <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Open Google</a>
            </p>
            <label className="sheet-field">
              <span>App password</span>
              <input
                className="sheet-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="16 letters"
              />
            </label>
          </>
        ) : device ? (
          <>
            <p>
              Enter <strong className="sheet-code">{device.userCode}</strong> on Microsoft's page. Callum waits here.
            </p>
            <p>
              <a href={device.verificationUri} target="_blank" rel="noreferrer">Open Microsoft's page</a>
            </p>
            <div className="sheet-wait" role="status">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3F52D9" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                <path d="M12 3a9 9 0 0 1 9 9" />
              </svg>
              Waiting for Microsoft
            </div>
          </>
        ) : (
          <p>Microsoft shows you a short code. You enter it on their page, so Callum never handles your password.</p>
        )}

        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <p>{NEVER_SEES}</p>
        <div className="sheet-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {provider === 'google' ? (
            <Button type="submit" aria-busy={busy} disabled={busy}>{busy ? 'Connecting' : 'Connect'}</Button>
          ) : device ? null : (
            <Button type="submit" aria-busy={busy} disabled={busy}>Open Microsoft</Button>
          )}
        </div>
      </form>
    </Sheet>
  );
}
