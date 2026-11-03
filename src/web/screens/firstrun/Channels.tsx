import type { Channel, ChannelAccount } from '../../../shared/types.js';
import { Button } from '../../ui/Button.js';
import { CheckIcon, MailIcon, XMark } from './icons.js';
import { paceFor } from './pace.js';

const ORDER: Channel[] = ['email', 'linkedin', 'x'];

export interface ChannelsProps {
  accounts: Partial<Record<Channel, ChannelAccount>>;
  /** The channel being signed in right now. */
  busy: Channel | null;
  /** The channel that just connected, so its ring can play once. */
  ringing: { channel: Channel; key: number } | null;
  onPick(channel: Channel): void;
  onNext(): void;
}

export function Channels({ accounts, busy, ringing, onPick, onNext }: ChannelsProps) {
  const anyOn = ORDER.some((ch) => accounts[ch]?.status === 'connected');
  return (
    <section className="fr-step fr-channels step-in" aria-labelledby="q1">
      <h1 id="q1" className="fr-title">Where should Callum reach people?</h1>
      <div className="fr-ch-row">
        {ORDER.map((ch) => {
          const meta = paceFor(ch);
          const account = accounts[ch];
          const on = account?.status === 'connected';
          const working = busy === ch;
          const sub = working ? 'Connecting' : on ? (ch === 'email' ? (account?.identity ?? 'Connected') : meta.line) : account?.status === 'error' ? 'Sign in again' : 'Connect';
          const sub2 = on ? (ch === 'email' ? meta.line : meta.line2) : '';
          return (
            <div className="fr-ch-item" key={ch}>
              <span className="fr-disc-wrap">
                <button type="button" className="fr-disc" aria-pressed={on} aria-label={`Connect ${meta.name}`} data-busy={working} onClick={() => onPick(ch)}>
                  {ch === 'email' ? <MailIcon /> : null}
                  {ch === 'linkedin' ? <span className="fr-disc-in" aria-hidden="true">in</span> : null}
                  {ch === 'x' ? <XMark /> : null}
                </button>
                {working ? (
                  <svg className="fr-spin" aria-hidden="true" viewBox="0 0 148 148">
                    <circle cx="74" cy="74" r="71" fill="none" stroke="#3F52D9" strokeWidth="3" strokeLinecap="round" strokeDasharray="110 400" />
                  </svg>
                ) : null}
                {on && ringing?.channel === ch ? <span key={ringing.key} className="fr-ring" aria-hidden="true" /> : null}
                {on ? <span className="fr-check pop-in" aria-hidden="true"><CheckIcon /></span> : null}
              </span>
              <span className="fr-ch-label">
                <span className="fr-ch-name">{meta.name}</span>
                <span className="fr-ch-sub" title={sub}>{sub}</span>
                <span className="fr-ch-sub2">{sub2}</span>
              </span>
            </div>
          );
        })}
      </div>
      <p className="fr-quiet" style={{ maxWidth: '52ch', marginTop: -10 }}>Each sign-in happens on that service's own page. Callum never sees your passwords.</p>
      <Button disabled={!anyOn} onClick={onNext}>Next</Button>
    </section>
  );
}
