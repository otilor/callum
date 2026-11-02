import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChannelAccount } from '../../../shared/types.js';
import { api, ApiError, channelSetup, type DeviceCodeStart, type MicrosoftSetup } from '../../api.js';
import { CheckMark, ErrorLine, External, isPersonalAddress, MICROSOFT_SETUP_DOC, Spinner } from './parts.js';

export type EmailProvider = 'google' | 'microsoft' | 'other';

const PROVIDERS: { key: EmailProvider; name: string }[] = [
  { key: 'google', name: 'Google' },
  { key: 'microsoft', name: 'Microsoft' },
  { key: 'other', name: 'Another provider' },
];

export function messageOf(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

interface Step { text: string; link?: { label: string; href: string } }

const GOOGLE_STEPS: Step[] = [
  { text: 'Turn on 2-step verification' },
  { text: 'Create an app password called Callum', link: { label: 'Open Google', href: 'https://myaccount.google.com/apppasswords' } },
  { text: 'Paste it here' },
];
const MICROSOFT_STEPS: Step[] = [
  { text: 'Add your Microsoft address' },
  { text: 'Open Microsoft and enter the short code Callum shows' },
  { text: 'Come back here. Callum notices the moment you are in' },
];

function Steps({ steps, last }: { steps: Step[]; last?: boolean }) {
  return (
    <ol className="cx-steps">
      {steps.map((s, i) => (
        <li key={s.text}>
          <span className="cx-step-n" data-on={last && i === steps.length - 1} aria-hidden="true">{i + 1}</span>
          <span className="cx-step-t">{s.text}</span>
          {s.link ? (
            <a className="cx-link" href={s.link.href} target="_blank" rel="noopener noreferrer">{s.link.label}<External /></a>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** `smtp.example.com` or `smtp.example.com:465`. */
function splitServer(value: string, port: string): { host: string; port: string } {
  const [host = '', given] = value.trim().split(':');
  return { host: host.trim(), port: (given ?? '').trim() || port };
}

export interface EmailConnectProps {
  account: ChannelAccount | undefined;
  /** Start with the form even if an address is already connected. */
  again: boolean;
  provider: EmailProvider;
  onConnected(account: ChannelAccount | undefined): void;
  onBusy(busy: boolean): void;
  onAgain(): void;
  /** How often to ask Microsoft whether the code was entered. */
  pollMs: number;
}

export function EmailConnect({ account, again, provider: initial, onConnected, onBusy, onAgain, pollMs }: EmailConnectProps) {
  const [provider, setProvider] = useState<EmailProvider>(initial);
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [smtp, setSmtp] = useState('');
  const [imap, setImap] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [device, setDevice] = useState<DeviceCodeStart | null>(null);
  const [setup, setSetup] = useState<MicrosoftSetup | null>(null);
  const [pace, setPace] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const finished = useRef(onConnected);
  finished.current = onConnected;
  const report = useRef(onBusy);
  report.current = onBusy;

  const connected = account?.status === 'connected' && !again;

  useEffect(() => {
    report.current(busy || device !== null);
  }, [busy, device]);

  useEffect(() => {
    if (provider !== 'microsoft' || setup) return;
    let live = true;
    channelSetup
      .microsoft()
      .then((s) => live && setSetup(s))
      // If the server cannot say, let the person try; the server answers with the real reason.
      .catch(() => live && setSetup({ configured: true, source: null }));
    return () => {
      live = false;
    };
  }, [provider, setup]);

  // The line under "Sending from": how fast, as the server counts it.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    api
      .channelSummary('email')
      .then((s) => live && setPace(s.paceLine))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [connected, account?.identity]);

  // Microsoft: wait here for the person to enter the code on Microsoft's page.
  useEffect(() => {
    if (!device) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (message: string) => {
      setDevice(null);
      setError(message);
    };
    const tick = async () => {
      try {
        const res = await api.microsoftPoll(address.trim());
        if (stopped) return;
        if (res.status === 'connected') {
          setDevice(null);
          finished.current(res.account);
          return;
        }
        if (res.status === 'expired') return stop('That code ran out. Open Microsoft again for a new one.');
        if (res.status === 'denied') return stop('Microsoft said no. Open Microsoft again when you are ready.');
      } catch (e) {
        if (stopped) return;
        // A request that never got an answer (or got a server error) says nothing about the code: ask again at the
        // next interval, until the code runs out. An answer that refuses the request is final.
        const unanswered = e instanceof ApiError && (e.status === 0 || e.status >= 500);
        if (!unanswered) return stop(messageOf(e));
        if (Date.parse(device.expiresAt) <= Date.now()) return stop('That code ran out. Open Microsoft again for a new one.');
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
  const fail = (message: string) => {
    setError(message);
    setShake((n) => n + 1);
  };

  const submitPassword = async () => {
    if (busy) return;
    setError('');
    if (!addressOk) return fail('Add the email address to send from.');
    const clean = provider === 'google' ? password.replace(/\s+/g, '') : password;
    if (!clean) return fail(provider === 'google' ? 'Add the app password for that address.' : 'Add the email password.');
    let fields: Record<string, string>;
    if (provider === 'google') {
      fields = { provider: 'google', address: address.trim(), password: clean };
    } else {
      const out = splitServer(smtp, '587');
      const inn = splitServer(imap, '993');
      if (!out.host || !inn.host) return fail('Add both mail servers. Whoever runs your email can tell you these.');
      fields = { provider: 'custom', address: address.trim(), password: clean, smtpHost: out.host, smtpPort: out.port, imapHost: inn.host, imapPort: inn.port };
    }
    setBusy(true);
    try {
      const done = await api.connect('email', fields);
      setPassword('');
      finished.current(done);
    } catch (err) {
      fail(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const openMicrosoft = async () => {
    if (busy || device) return;
    setError('');
    if (!addressOk) return fail('Add the email address to send from.');
    setBusy(true);
    try {
      setDevice(await api.microsoftStart(address.trim()));
    } catch (err) {
      fail(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: EmailProvider) => {
    if (busy || device) return;
    setProvider(next);
    setError('');
    setPassword('');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (provider === 'microsoft') void openMicrosoft();
    else void submitPassword();
  };

  if (connected) {
    return (
      <div className="cx-done fade-in">
        <span className="cx-done-disc"><CheckMark size={28} /><span className="cx-ring" aria-hidden="true" /></span>
        <p className="cx-done-title">{`Sending from ${account?.identity ?? 'your address'}.${pace ? ` ${pace}.` : ''}`}</p>
        <p className="cx-quiet">Replies land in your own inbox too.</p>
        <button type="button" className="cx-text-btn" onClick={onAgain}>Use another address</button>
      </div>
    );
  }

  const microsoftBlocked = provider === 'microsoft' && setup !== null && !setup.configured;
  const personal = isPersonalAddress(address);

  return (
    <form className="cx-form" onSubmit={submit} noValidate>
      <div className="cx-chips" role="group" aria-label="Email provider">
        {PROVIDERS.map((p) => (
          <button key={p.key} type="button" className="cx-chip" aria-pressed={provider === p.key} onClick={() => switchTo(p.key)}>{p.name}</button>
        ))}
      </div>
      {microsoftBlocked ? (
        <p className="cx-quiet">
          Microsoft needs a one-time app setup on this computer first.{' '}
          <a className="cx-link" href={MICROSOFT_SETUP_DOC} target="_blank" rel="noopener noreferrer">How to set it up<External /></a>
        </p>
      ) : null}

      {provider === 'google' ? <Steps steps={GOOGLE_STEPS} last={password.trim().length > 0} /> : null}
      {provider === 'microsoft' && !microsoftBlocked ? <Steps steps={MICROSOFT_STEPS} /> : null}

      {provider === 'other' ? (
        <>
          <div className="cx-two">
            <label className="cx-field">
              <span>Sending server</span>
              <input className="cx-input" type="text" value={smtp} onChange={(e) => setSmtp(e.target.value)} placeholder="smtp.yourcompany.com" autoComplete="off" spellCheck={false} />
            </label>
            <label className="cx-field">
              <span>Inbox server</span>
              <input className="cx-input" type="text" value={imap} onChange={(e) => setImap(e.target.value)} placeholder="imap.yourcompany.com" autoComplete="off" spellCheck={false} />
            </label>
          </div>
          <p className="cx-quiet">Whoever runs your email can tell you these.</p>
        </>
      ) : null}

      <label className="cx-field">
        <span>Email address</span>
        <input
          className="cx-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={address}
          disabled={busy || device !== null}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="you@yourcompany.com"
        />
      </label>
      {personal ? <p className="cx-note fade-in">This looks like a personal address. Cold email works best from your company address.</p> : null}

      {provider !== 'microsoft' ? (
        <label className="cx-field" data-shake={error ? (shake % 2 ? 'a' : 'b') : 'off'}>
          <span>{provider === 'google' ? 'App password' : 'Email password'}</span>
          <input
            className="cx-input"
            type="text"
            value={password}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            placeholder={provider === 'google' ? 'abcd efgh ijkl mnop' : 'Your email password'}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      ) : null}

      {provider === 'microsoft' && device ? (
        <div className="cx-device fade-in" role="status">
          <p>
            Enter <strong className="cx-code">{device.userCode}</strong> on Microsoft's page. Callum waits here.
          </p>
          <a className="cx-link" href={device.verificationUri} target="_blank" rel="noopener noreferrer">Open Microsoft's page<External /></a>
          <span className="cx-wait"><Spinner />Waiting for Microsoft</span>
          <button type="button" className="cx-text-btn" onClick={() => setDevice(null)}>Cancel</button>
        </div>
      ) : null}

      {error ? <ErrorLine>{error}</ErrorLine> : null}

      {provider === 'microsoft' ? (
        device ? null : (
          <button type="submit" className="cx-primary" disabled={busy || microsoftBlocked} aria-busy={busy}>
            {busy ? <Spinner light /> : null}Open Microsoft
          </button>
        )
      ) : (
        <button type="submit" className="cx-primary" disabled={busy} aria-busy={busy}>
          {busy ? <Spinner light /> : null}{busy ? 'Connecting' : 'Connect'}
        </button>
      )}
    </form>
  );
}
