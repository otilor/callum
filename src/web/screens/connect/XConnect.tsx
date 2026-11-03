import { useEffect, useState, useRef, type FormEvent } from 'react';
import type { ChannelAccount } from '../../../shared/types.js';
import { api } from '../../api.js';
import { messageOf } from './EmailConnect.js';
import { CheckMark, ErrorLine, External, Spinner } from './parts.js';

export interface XConnectProps {
  account: ChannelAccount | undefined;
  again: boolean;
  onConnected(account: ChannelAccount | undefined): void;
  onBusy(busy: boolean): void;
}

const STEPS: { text: string; link?: { label: string; href: string } }[] = [
  { text: 'Create an app at developer.x.com', link: { label: 'Open X', href: 'https://developer.x.com' } },
  { text: 'Turn on messages, read and write' },
  { text: 'Copy the access token here' },
];

export function XConnect({ account, again, onConnected, onBusy }: XConnectProps) {
  const [token, setToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(0);
  const [pace, setPace] = useState<string | null>(null);
  const finished = useRef(onConnected);
  finished.current = onConnected;
  const report = useRef(onBusy);
  report.current = onBusy;

  const connected = account?.status === 'connected' && !again;

  useEffect(() => {
    report.current(busy);
  }, [busy]);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    api
      .channelSummary('x')
      .then((s) => live && setPace(s.paceLine))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [connected]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    const clean = token.trim();
    if (clean.length < 20) {
      setError("That doesn't look like an X access token.");
      setShake((n) => n + 1);
      return;
    }
    const fields: Record<string, string> = { accessToken: clean };
    if (refreshToken.trim()) fields.refreshToken = refreshToken.trim();
    if (clientId.trim()) fields.clientId = clientId.trim();
    if (clientSecret.trim()) fields.clientSecret = clientSecret.trim();
    setBusy(true);
    try {
      const done = await api.connect('x', fields);
      setToken('');
      setRefreshToken('');
      setClientSecret('');
      finished.current(done);
    } catch (err) {
      setError(messageOf(err));
      setShake((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  if (connected) {
    return (
      <div className="cx-done fade-in">
        <span className="cx-done-disc"><CheckMark size={28} /><span className="cx-ring" aria-hidden="true" /></span>
        <p className="cx-done-title">{`${account?.identity ?? 'Your account'}. ${pace ?? '20 messages a day'}.`}</p>
        <p className="cx-quiet">X only lets Callum message people who follow you or whose messages are open.</p>
      </div>
    );
  }

  return (
    <form className="cx-form" onSubmit={(e) => void submit(e)} noValidate>
      <p className="cx-lead">X messages go through X's official API, which needs a paid X plan.</p>
      <ol className="cx-steps">
        {STEPS.map((s, i) => (
          <li key={s.text}>
            <span className="cx-step-n" data-on={i === STEPS.length - 1 && token.trim().length > 0} aria-hidden="true">{i + 1}</span>
            <span className="cx-step-t">{s.text}</span>
            {s.link ? <a className="cx-link" href={s.link.href} target="_blank" rel="noopener noreferrer">{s.link.label}<External /></a> : null}
          </li>
        ))}
      </ol>
      <label className="cx-field" data-shake={error ? (shake % 2 ? 'a' : 'b') : 'off'}>
        <span>X access token</span>
        <input
          className="cx-input"
          type="text"
          value={token}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setToken(e.target.value);
            setError('');
          }}
          placeholder="Paste your access token"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <details className="cx-more">
        <summary>Tokens that refresh themselves</summary>
        <div className="cx-form">
          <label className="cx-field"><span>Refresh token</span><input className="cx-input" type="text" value={refreshToken} disabled={busy} onChange={(e) => setRefreshToken(e.target.value)} autoComplete="off" spellCheck={false} /></label>
          <label className="cx-field"><span>Client ID</span><input className="cx-input" type="text" value={clientId} disabled={busy} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} /></label>
          <label className="cx-field"><span>Client secret</span><input className="cx-input" type="password" value={clientSecret} disabled={busy} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" spellCheck={false} /></label>
        </div>
      </details>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <button type="submit" className="cx-primary" disabled={busy} aria-busy={busy}>
        {busy ? <Spinner light /> : null}{busy ? 'Connecting' : 'Connect'}
      </button>
    </form>
  );
}
