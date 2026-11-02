import { useCallback, useState } from 'react';
import type { AppState, Channel } from '../../../shared/types.js';
import { api, ApiError } from '../../api.js';
import { Marble } from '../../ui/Marble.js';
import { allVariants, type IncidentVariant, type VariantAction } from './incidentVariants.js';
import './VariantCard.css';

const BROKEN = 'Something went wrong. Callum kept everything as it was.';
const STORE = 'callum.dismissed-notices';

function readDismissed(): string[] {
  try {
    const raw = window.localStorage.getItem(STORE);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Notices the person has said Okay to, kept in this browser only (a convenience; losing it just shows the notice again). */
export function useDismissed(): [Set<string>, (id: string) => void] {
  const [ids, setIds] = useState<string[]>(readDismissed);
  const add = useCallback((id: string) => {
    setIds((all) => {
      const next = all.includes(id) ? all : [...all.slice(-49), id];
      try {
        window.localStorage.setItem(STORE, JSON.stringify(next));
      } catch {
        // private windows and blocked storage: the notice comes back on reload, nothing else.
      }
      return next;
    });
  }, []);
  return [new Set(ids), add];
}

function Glyph({ kind }: { kind: 'what' | 'did' | 'next' }) {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (kind === 'what') return <svg {...common} stroke="#1D2140"><circle cx="8" cy="8" r="6" /><path d="M8 5v3.4M8 11h.01" /></svg>;
  if (kind === 'did') return <svg {...common} stroke="#1D2140"><path d="M3.5 8.4l3 3 6-6.8" /></svg>;
  return <svg {...common} stroke="#FFFFFF"><path d="M3 8h10M9 4l4 4-4 4" /></svg>;
}

function Icon({ v }: { v: IncidentVariant }) {
  const { personId, glyph, badge } = v.icon;
  return (
    <span className={personId !== null ? 'vc-icon vc-icon-person' : 'vc-icon'} aria-hidden="true">
      {personId !== null ? <Marble seed={300 + personId} size={52} tone={v.key === 'stop' ? 'grey' : 'warm'} ring={v.key === 'send_failed' ? '#D9480F' : '#D5D9E4'} /> : null}
      {glyph === 'mail' ? (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M4 7l8 6 8-6" /></svg>
      ) : glyph ? <b>{glyph === 'x' ? 'X' : 'in'}</b> : null}
      {badge ? (
        <i className={badge === 'error' ? 'vc-badge vc-badge-error' : 'vc-badge'}>
          {badge === 'pause'
            ? <svg width="9" height="9" viewBox="0 0 10 10" fill="#fff"><rect x="2" y="1.5" width="2" height="7" rx="0.6" /><rect x="6" y="1.5" width="2" height="7" rx="0.6" /></svg>
            : <svg width="9" height="9" viewBox="0 0 10 10" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"><path d="M2 2l6 6M8 2L2 8" /></svg>}
        </i>
      ) : null}
    </span>
  );
}

export interface VariantCardProps {
  variant: IncidentVariant;
  /** Opens the connect sheet of a channel. */
  onReconnect(channel: Channel): void;
  /** Opens a person's conversation (a reply Callum could not read). */
  onOpenPerson?(personId: number): void;
  /** The person said Okay: the card goes. */
  onDismiss(id: string): void;
  /** Something changed on the server: read the state again. */
  onChanged(): void;
}

/** One thing that went wrong, or that Callum wants you to know, as the V3Breaks board draws it. */
export function VariantCard({ variant: v, onReconnect, onOpenPerson, onDismiss, onChanged }: VariantCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(action: VariantAction) {
    if (busy) return;
    setError(null);
    try {
      switch (action.kind) {
        case 'reconnect':
          onReconnect(action.channel);
          return;
        case 'dismiss':
          onDismiss(v.id);
          // A notice that came from the server is settled there too, not only hidden in this browser.
          if (v.incidentId !== null) void api.dismissIncident(v.incidentId).then(() => onChanged(), () => undefined);
          return;
        case 'open_person':
          onOpenPerson?.(action.personId);
          return;
        case 'link':
          window.open(action.url, '_blank', 'noopener');
          return;
        case 'copy': {
          if (!navigator.clipboard) throw new ApiError(0, 'Callum could not copy it. Select the text above and copy it by hand.');
          await navigator.clipboard.writeText(action.text);
          setDone(`Copied. Paste it wherever you talk to ${action.first}.`);
          return;
        }
        default:
          break;
      }
      setBusy(true);
      if (action.kind === 'skip_bounced') {
        for (const id of action.personIds) await api.remove(id);
        setDone(`Those ${action.personIds.length} people won't hear from you. Everyone else carries on.`);
      } else if (action.kind === 'retry') {
        await api.retry(action.outboxId);
        setDone(`Trying again. Your reply to ${action.first} leaves in a few seconds.`);
      } else {
        const result = await api.act(action.action, action.projectId ?? undefined);
        setDone(result.text);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : BROKEN);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`vc vc-${v.key}`} aria-labelledby={`${v.id}-title`}>
      <div className="vc-head">
        <Icon v={v} />
        <div>
          <h2 id={`${v.id}-title`}>{v.title}</h2>
          <span>{v.when}</span>
        </div>
      </div>
      {v.quote ? <p className={v.key === 'stop' ? 'vc-quote vc-quote-soft' : 'vc-quote'}>{v.quote}</p> : null}
      <ol className="vc-lines">
        {v.lines.map((l) => (
          <li key={l.kind} className={l.kind === 'next' ? 'vc-next' : undefined}>
            <span className={l.kind === 'next' ? 'vc-disc vc-disc-dark' : 'vc-disc'}><Glyph kind={l.kind} /></span>
            <span>{l.text}</span>
          </li>
        ))}
      </ol>
      {v.waitLine ? (
        <div className="vc-wait">
          <span className="vc-faces" aria-hidden="true">{v.waitIds.slice(0, 8).map((id) => <Marble key={id} seed={300 + id} size={26} tone="grey" ring={null} className="vc-face" />)}</span>
          <span>{v.waitLine}</span>
        </div>
      ) : null}
      {done ? (
        <p className="vc-done fade-in" role="status">{done}</p>
      ) : (
        <div className="vc-actions">
          <button type="button" className="vc-dark" disabled={busy} aria-busy={busy} onClick={() => void run(v.primary.action)}>{v.primary.label}</button>
          {v.secondary ? <button type="button" className="vc-light" disabled={busy} onClick={() => void run(v.secondary!.action)}>{v.secondary.label}</button> : null}
        </div>
      )}
      {error ? <p className="vc-error" role="alert">{error}</p> : null}
    </section>
  );
}

/** Every notice the situation calls for, minus the ones the person has said Okay to. */
export function VariantStack({ state, onReconnect, onOpenPerson, onChanged, now }: {
  state: AppState; onReconnect(channel: Channel): void; onOpenPerson?(personId: number): void; onChanged(): void; now?: () => Date;
}) {
  const [dismissed, dismiss] = useDismissed();
  // Read again whenever the state is.
  const variants = allVariants(state, (now ?? (() => new Date()))()).filter((v) => !dismissed.has(v.id));
  if (variants.length === 0) return null;
  return (
    <div className="vc-stack">
      {variants.map((v) => <VariantCard key={v.id} variant={v} onReconnect={onReconnect} {...(onOpenPerson ? { onOpenPerson } : {})} onDismiss={dismiss} onChanged={onChanged} />)}
    </div>
  );
}
