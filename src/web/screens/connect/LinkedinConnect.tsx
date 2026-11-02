import { useEffect, useRef, useState } from 'react';
import type { ChannelAccount } from '../../../shared/types.js';
import { api } from '../../api.js';
import { messageOf } from './EmailConnect.js';
import { CheckMark, Chevron, ErrorLine, Spinner } from './parts.js';

export interface LinkedinConnectProps {
  account: ChannelAccount | undefined;
  again: boolean;
  onConnected(account: ChannelAccount | undefined): void;
  onBusy(busy: boolean): void;
}

const COOKIE_MIN = 24;

export function LinkedinConnect({ account, again, onConnected, onBusy }: LinkedinConnectProps) {
  const [waitingOn, setWaitingOn] = useState<'window' | 'cookie' | null>(null);
  const [shake, setShake] = useState(0);
  const [error, setError] = useState('');
  const [serverOpen, setServerOpen] = useState(false);
  const [cookie, setCookie] = useState('');
  const [cookieError, setCookieError] = useState(false);
  const [viaCookie, setViaCookie] = useState(false);
  const [pace, setPace] = useState<string | null>(null);
  // Each try gets a number; the answer to an older try (a window that was reopened or cancelled) is ignored.
  const attempt = useRef(0);
  const alive = useRef(true);
  const finished = useRef(onConnected);
  finished.current = onConnected;
  const report = useRef(onBusy);
  report.current = onBusy;

  const waiting = waitingOn !== null;
  const connected = account?.status === 'connected' && !again && !waiting;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    report.current(waiting);
  }, [waiting]);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    api
      .channelSummary('linkedin')
      .then((s) => live && setPace(s.paceLine))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [connected]);

  const run = async (fields: Record<string, string>) => {
    const mine = ++attempt.current;
    setError('');
    setWaitingOn(fields.liAt ? 'cookie' : 'window');
    try {
      const done = await api.connect('linkedin', fields);
      if (!alive.current || mine !== attempt.current) return;
      setWaitingOn(null);
      setViaCookie(Boolean(fields.liAt));
      setServerOpen(false);
      setCookie('');
      finished.current(done);
    } catch (e) {
      if (!alive.current || mine !== attempt.current) return;
      setWaitingOn(null);
      setError(messageOf(e));
    }
  };

  const useCookie = () => {
    if (cookie.trim().length < COOKIE_MIN) {
      setShake((n) => n + 1);
      return setCookieError(true);
    }
    setCookieError(false);
    void run({ liAt: cookie.trim() });
  };

  const cancel = () => {
    attempt.current += 1;
    setWaitingOn(null);
  };

  if (connected) {
    const who = account?.identity ?? 'your account';
    return (
      <div className="cx-done fade-in">
        <span className="cx-done-disc"><CheckMark size={28} /><span className="cx-ring" aria-hidden="true" /></span>
        <p className="cx-done-title">{viaCookie ? `Connected from this server as ${who}` : `Connected as ${who}`}</p>
        <p className="cx-quiet">{`${pace ?? '15 invites a day'}. Callum pauses itself if LinkedIn asks anything.`}</p>
      </div>
    );
  }

  return (
    <div className="cx-form">
      {waiting ? (
        <div className="cx-wait-block fade-in" role="status">
          <span className="cx-wait-disc" aria-hidden="true">in<Spinner size={64} /></span>
          {waitingOn === 'cookie' ? (
            <p className="cx-done-title">Checking the cookie with LinkedIn</p>
          ) : (
            <>
              <p className="cx-done-title">Finish signing in on the LinkedIn window</p>
              <p className="cx-quiet">Callum notices the moment you're in. Can't see the window?</p>
              <div className="cx-row">
                <button type="button" className="cx-pill" onClick={() => void run({})}>Reopen the window</button>
                <button type="button" className="cx-text-btn" onClick={cancel}>Cancel</button>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <ul className="cx-points">
            <li>Callum runs LinkedIn on this computer while Callum is open.</li>
            <li>You sign in on LinkedIn's own page. Callum never sees your password.</li>
            <li>15 invites a day, working hours only. It pauses itself if LinkedIn asks anything.</li>
          </ul>
          {error ? <ErrorLine>{error}</ErrorLine> : null}
          <button type="button" className="cx-primary" onClick={() => void run({})}>Open LinkedIn</button>
          <div className="cx-server">
            <button type="button" className="cx-disclose" aria-expanded={serverOpen} onClick={() => setServerOpen((o) => !o)}>
              Running Callum on a server?<Chevron />
            </button>
            {serverOpen ? (
              <div className="cx-form fade-in">
                <p className="cx-quiet">
                  A server has no window to sign in on. Open linkedin.com in your own browser, then Developer tools, Application, Cookies, and copy the value called li_at.
                </p>
                <label className="cx-field" data-shake={cookieError ? (shake % 2 ? 'a' : 'b') : 'off'}>
                  <span>LinkedIn session cookie</span>
                  <span className="cx-inline">
                    <input
                      className="cx-input"
                      type="text"
                      value={cookie}
                      aria-invalid={cookieError ? true : undefined}
                      onChange={(e) => {
                        setCookie(e.target.value);
                        setCookieError(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          useCookie();
                        }
                      }}
                      placeholder="Paste li_at here"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button type="button" className="cx-primary" onClick={useCookie}>Connect</button>
                  </span>
                </label>
                {cookieError ? <ErrorLine>That cookie looks too short. Copy the whole li_at value.</ErrorLine> : null}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
