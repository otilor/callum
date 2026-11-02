import { useState, type FormEvent } from 'react';
import type { Channel, ChannelAccount } from '../../../shared/types.js';
import { ApiError } from '../../api.js';
import { Button } from '../../ui/Button.js';
import { ErrorLine } from './icons.js';
import { Sheet } from './Sheet.js';

function messageOf(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

interface ConnectProps {
  onConnect(fields: Record<string, string>): Promise<void>;
  onClose(): void;
}

export function LinkedinSheet({ onConnect, onClose }: ConnectProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [liAt, setLiAt] = useState('');

  const connect = async (fields: Record<string, string>) => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await onConnect(fields);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <Sheet label="Connect LinkedIn" onClose={onClose}>
      <h2>Connect LinkedIn</h2>
      <p>You sign in on LinkedIn's own page. Callum never sees your password.</p>
      {busy ? (
        <div className="sheet-wait" role="status">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3F52D9" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <path d="M12 3a9 9 0 0 1 9 9" />
          </svg>
          Finish signing in on the LinkedIn window
        </div>
      ) : null}
      <details>
        <summary>Running Callum on a server?</summary>
        <label className="sheet-field">
          <span>li_at cookie</span>
          <input
            className="sheet-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={liAt}
            disabled={busy}
            onChange={(e) => setLiAt(e.target.value)}
            placeholder="Paste the li_at value from your browser"
          />
        </label>
      </details>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="sheet-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {liAt.trim() ? (
          <Button aria-busy={busy} disabled={busy} onClick={() => void connect({ liAt: liAt.trim() })}>Use this cookie</Button>
        ) : (
          <Button aria-busy={busy} disabled={busy} onClick={() => void connect({})}>Open LinkedIn</Button>
        )}
      </div>
    </Sheet>
  );
}

export function XSheet({ onConnect, onClose }: ConnectProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    const token = accessToken.trim();
    if (token.length < 20) return setError("That doesn't look like an X access token.");
    const fields: Record<string, string> = { accessToken: token };
    if (refreshToken.trim()) fields.refreshToken = refreshToken.trim();
    if (clientId.trim()) fields.clientId = clientId.trim();
    if (clientSecret.trim()) fields.clientSecret = clientSecret.trim();
    setBusy(true);
    try {
      await onConnect(fields);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  const field = (label: string, value: string, set: (v: string) => void, secret = true) => (
    <label className="sheet-field">
      <span>{label}</span>
      <input
        className="sheet-input"
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={busy}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );

  return (
    <Sheet label="Connect X" onClose={onClose}>
      <h2>Connect X</h2>
      <p>Sending messages on X needs a paid X plan. Paste the access token from your X developer app.</p>
      <form className="sheet-form" onSubmit={(e) => void submit(e)}>
        {field('Access token', accessToken, setAccessToken)}
        <details>
          <summary>Tokens that refresh themselves</summary>
          <div className="sheet-form">
            {field('Refresh token', refreshToken, setRefreshToken)}
            {field('Client ID', clientId, setClientId, false)}
            {field('Client secret', clientSecret, setClientSecret)}
          </div>
        </details>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <div className="sheet-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" aria-busy={busy} disabled={busy}>{busy ? 'Connecting' : 'Connect'}</Button>
        </div>
      </form>
    </Sheet>
  );
}

const NAMES: Record<Channel, string> = { email: 'Email', linkedin: 'LinkedIn', x: 'X' };

/** What a connected channel looks like when its disc is tapped again. */
export function ConnectedSheet({ account, onDisconnect, onClose }: { account: ChannelAccount; onDisconnect(): Promise<void>; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = NAMES[account.channel];
  return (
    <Sheet label={`${name} is connected`} onClose={onClose}>
      <h2>{name} is connected</h2>
      {account.identity ? <p>Sending as {account.identity}.</p> : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="sheet-actions">
        <Button
          variant="quiet"
          aria-busy={busy}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await onDisconnect();
            } catch (e) {
              setError(messageOf(e));
              setBusy(false);
            }
          }}
        >
          Disconnect
        </Button>
        <Button onClick={onClose}>Done</Button>
      </div>
    </Sheet>
  );
}
