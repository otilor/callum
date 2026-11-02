import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Channel, ChannelAccount } from '../../../shared/types.js';
import { Button } from '../../ui/Button.js';
import './Connect.css';
import { EmailConnect, type EmailProvider } from './EmailConnect.js';
import { LinkedinConnect } from './LinkedinConnect.js';
import { CHANNEL_NAMES, ChannelGlyph, CheckMark } from './parts.js';
import { XConnect } from './XConnect.js';

const ORDER: Channel[] = ['email', 'linkedin', 'x'];

export interface ConnectSheetProps {
  /** The tab to open on. */
  channel?: Channel;
  /** Which email provider to open on. */
  provider?: EmailProvider;
  /** What is connected right now, so a connected tab can say so. */
  accounts: Partial<Record<Channel, ChannelAccount>>;
  /** Open the tab on its form even when it is already connected (Reconnect). */
  reconnect?: boolean;
  /** A channel finished connecting. The sheet stays open to say so. */
  onConnected(account: ChannelAccount | undefined, channel: Channel): void | Promise<void>;
  onClose(): void;
  /** How often to ask Microsoft whether the code was entered. */
  pollMs?: number;
}

const NAME_OF_PANEL: Record<Channel, string> = { email: 'Email', linkedin: 'LinkedIn', x: 'X' };

/** One sheet for all three channels: Email, LinkedIn and X tabs, each with its own sign-in. */
export function ConnectSheet({ channel = 'email', provider = 'google', accounts, reconnect = false, onConnected, onClose, pollMs = 3000 }: ConnectSheetProps) {
  const [tab, setTab] = useState<Channel>(channel);
  const [local, setLocal] = useState<Partial<Record<Channel, ChannelAccount>>>({});
  const [again, setAgain] = useState<Partial<Record<Channel, boolean>>>(reconnect ? { [channel]: true } : {});
  const [working, setWorking] = useState<Channel | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const tabs = useRef<Partial<Record<Channel, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, []);

  const merged = useMemo(() => ({ ...accounts, ...local }), [accounts, local]);

  const connected = (ch: Channel) => (done: ChannelAccount | undefined) => {
    if (done) setLocal((l) => ({ ...l, [ch]: done }));
    setAgain((a) => ({ ...a, [ch]: false }));
    void onConnected(done, ch);
  };
  const busy = (ch: Channel) => (on: boolean) => setWorking((w) => (on ? ch : w === ch ? null : w));

  // Arrow keys move between the tabs; only the selected tab is in the tab order.
  const onTabKey = (e: KeyboardEvent, ch: Channel) => {
    if (working !== null) return;
    const at = ORDER.indexOf(ch);
    const next =
      e.key === 'ArrowRight' ? ORDER[(at + 1) % ORDER.length]
      : e.key === 'ArrowLeft' ? ORDER[(at + ORDER.length - 1) % ORDER.length]
      : e.key === 'Home' ? ORDER[0]
      : e.key === 'End' ? ORDER[ORDER.length - 1]
      : undefined;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabs.current[next]?.focus();
  };

  const doneIn = (ch: Channel) => merged[ch]?.status === 'connected' && !again[ch];

  return (
    <div
      className="cs-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="cs"
        role="dialog"
        aria-modal="true"
        aria-label="Connect a channel"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className="cs-title">Connect a channel</h2>

        <div className="cs-tabs" role="tablist" aria-label="Channels">
          {ORDER.map((ch) => (
            <button
              key={ch}
              type="button"
              role="tab"
              id={`cs-tab-${ch}`}
              aria-selected={tab === ch}
              aria-controls="cs-panel"
              tabIndex={tab === ch ? 0 : -1}
              ref={(el) => {
                tabs.current[ch] = el;
              }}
              onKeyDown={(e) => onTabKey(e, ch)}
              className="cs-tab"
              disabled={working !== null && working !== ch}
              onClick={() => setTab(ch)}
            >
              <span className="cs-disc-wrap">
                <span className="cs-disc" data-on={tab === ch} data-done={doneIn(ch)}><ChannelGlyph channel={ch} size={26} /></span>
                {doneIn(ch) ? <span className="cs-tick pop-in" aria-hidden="true"><CheckMark size={12} /></span> : null}
              </span>
              <span className="cs-tab-name">{CHANNEL_NAMES[ch]}</span>
            </button>
          ))}
        </div>

        <section className="cs-panel step-in" key={tab} id="cs-panel" role="tabpanel" aria-label={NAME_OF_PANEL[tab]} aria-labelledby={`cs-tab-${tab}`}>
          {tab === 'email' ? (
            <EmailConnect
              account={merged.email}
              again={Boolean(again.email)}
              provider={provider}
              pollMs={pollMs}
              onConnected={connected('email')}
              onBusy={busy('email')}
              onAgain={() => setAgain((a) => ({ ...a, email: true }))}
            />
          ) : null}
          {tab === 'linkedin' ? <LinkedinConnect account={merged.linkedin} again={Boolean(again.linkedin)} onConnected={connected('linkedin')} onBusy={busy('linkedin')} /> : null}
          {tab === 'x' ? <XConnect account={merged.x} again={Boolean(again.x)} onConnected={connected('x')} onBusy={busy('x')} /> : null}
        </section>

        <p className="cs-foot">These stay on the computer running Callum. Disconnect any time in Your Callum.</p>
        <div className="cs-actions">
          <Button variant={doneIn(tab) ? 'primary' : 'ghost'} onClick={onClose}>{doneIn(tab) ? 'Done' : 'Close'}</Button>
        </div>
      </div>
    </div>
  );
}
