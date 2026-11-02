import { useEffect, useState } from 'react';
import type { AppState, Channel, Project } from '../../../shared/types.js';
import { CHANNELS } from '../../../shared/types.js';
import { api, ApiError } from '../../api.js';
import { Marble } from '../../ui/Marble.js';
import { pauseChoices } from '../home/quietCopy.js';
import { CHANNEL_LABEL, paceFallback, pauseLine } from './phoneCopy.js';
import type { Notify } from './PhoneNotice.js';

export interface PhoneYouProps {
  state: AppState;
  project: Project | null;
  tz: string;
  now: Date;
  notify: Notify;
  refresh(): Promise<void> | void;
  /** `Everything else in Your Callum`. Left out, the link is not drawn. */
  onOpenSettings?(): void;
  /** `Wrap up and leave`. Left out, the link is not drawn. */
  onLeave?(): void;
}

const GLYPH: Record<Channel, string> = { email: '@', linkedin: 'in', x: 'X' };
const whyText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.');

/** The pace line of each connected channel, from the server. Until it arrives, a line that is true without it. */
function usePaceLines(state: AppState): Partial<Record<Channel, string>> {
  const [lines, setLines] = useState<Partial<Record<Channel, string>>>({});
  const key = state.channels.map((c) => `${c.channel}:${c.status}:${c.pausedUntil ?? ''}:${c.halfPaceUntil ?? ''}`).join('|');
  useEffect(() => {
    let live = true;
    for (const acc of state.channels) {
      if (acc.status !== 'connected' && acc.status !== 'paused') continue;
      api.channelSummary(acc.channel).then(
        (s) => {
          if (live) setLines((cur) => ({ ...cur, [acc.channel]: s.paceLine }));
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
    // The channel list changing is the cue to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return lines;
}

/** The You tab: who Callum writes as, what you offer, where it reaches people, and a break. */
export function PhoneYou({ state, project, tz, now, notify, refresh, onOpenSettings, onLeave }: PhoneYouProps) {
  const [breakOpen, setBreakOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const lines = usePaceLines(state);
  const { settings } = state;
  const paused = settings.pauseState === 'paused';
  const pausedLine = pauseLine(state, project, tz);

  const pause = async (iso: string, label: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.pause(iso);
      setBreakOpen(false);
      notify(`Paused until ${label}`);
      await refresh();
    } catch (e) {
      notify(whyText(e));
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.resumeAll();
      notify('Callum is back at work');
      await refresh();
    } catch (e) {
      notify(whyText(e));
    } finally {
      setBusy(false);
    }
  };

  const name = settings.senderName?.trim() || 'You';

  return (
    <div className="pa-tab pa-you">
      <div className="pa-you-head">
        <Marble seed={7} size={56} tone="warm" ring="var(--ink)" />
        <div>
          <h1>{name}</h1>
          {settings.senderEmail ? <span>Sending as {settings.senderEmail}</span> : null}
        </div>
      </div>

      {project?.offer ? (
        <section className="pa-card" aria-label="What you offer">
          <span className="pa-card-label">What you offer</span>
          <p>{project.offer}</p>
        </section>
      ) : null}

      <section className="pa-card" aria-labelledby="pa-channels">
        <span id="pa-channels" className="pa-card-label">Where Callum reaches people</span>
        {CHANNELS.map((ch) => {
          const acc = state.channels.find((c) => c.channel === ch);
          const on = acc?.status === 'connected' && !paused;
          const line = paused ? 'Waits while Callum is paused' : lines[ch] ?? paceFallback(acc, tz);
          return (
            <div key={ch} className="pa-channel">
              <span className="pa-glyph" aria-hidden="true">{GLYPH[ch]}<i className={on ? 'pa-on' : 'pa-off'} /></span>
              <span className="pa-channel-text">
                <span className="pa-channel-name">{CHANNEL_LABEL[ch]}</span>
                <span className="pa-channel-pace">{line}</span>
              </span>
            </div>
          );
        })}
      </section>

      <section className="pa-break" aria-label="Take a break">
        {paused || pausedLine ? (
          <div className="pa-break-on fade-in">
            <span>{pausedLine ?? 'Callum is paused.'}</span>
            {paused ? <button type="button" className="pa-soft" disabled={busy} onClick={() => void resume()}>Resume</button> : null}
          </div>
        ) : (
          <>
            <button type="button" className="pa-soft pa-break-btn" aria-expanded={breakOpen} onClick={() => setBreakOpen(!breakOpen)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M9 5v14M15 5v14" /></svg>
              Take a break
            </button>
            {breakOpen ? (
              <div className="pa-break-open fade-in">
                <span>Nothing automatic goes out. Replies still reach you.</span>
                <div role="group" aria-label="Pause until" className="pa-break-choices">
                  {pauseChoices(now, tz).map((c) => (
                    <button key={c.iso} type="button" className="pa-chip" disabled={busy} onClick={() => void pause(c.iso, c.label)}>{c.label}</button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

      <div className="pa-you-links">
        {onOpenSettings ? <button type="button" className="pa-link" onClick={onOpenSettings}>Everything else in Your Callum</button> : null}
        {onLeave ? <button type="button" className="pa-link pa-link-quiet" onClick={onLeave}>Wrap up and leave</button> : null}
      </div>
    </div>
  );
}
