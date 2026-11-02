import { useEffect, useRef, useState } from 'react';
import type { Message, PathStep, Person } from '../../../shared/types.js';
import { api, ApiError, type PersonDetail } from '../../api.js';
import { trapTab } from '../../ui/focusTrap.js';
import { Marble, lookForStage } from '../../ui/Marble.js';
import { formatSlot, nudgeSlot } from '../../ui/format.js';
import { channelName, messageMeta, nextStepLabel } from './phoneCopy.js';
import type { Notify } from './PhoneNotice.js';

export interface PersonSheetProps {
  person: Person;
  /** The project's name, shown when more than one project is running. */
  tag?: string | null;
  tz: string;
  now: Date;
  /** Callum is paused or wrapped up, so a nudge would not go anywhere. */
  paused: boolean;
  notify: Notify;
  refresh(): Promise<void> | void;
  onClose(): void;
}

function whyText(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

type Who = 'callum' | 'them' | 'you';
const whoOf = (m: Message): Who => (m.direction === 'in' ? 'them' : m.kind === 'reply' || m.kind === 'booking' || m.kind === 'close' ? 'you' : 'callum');

function kindWord(m: Message): string {
  if (m.kind === 'invite') return `${channelName(m.channel)} invite`;
  return channelName(m.channel);
}

/** What happens next, in one line, for someone who is not waiting on you. */
export function nextLine(person: Person, path: PathStep[], tz: string, now: Date): string | null {
  const first = person.firstName;
  if (person.stage === 'talking' && person.status === 'active') return `Callum stays quiet with ${first}. You talk from here.`;
  if (person.status === 'held') return `On hold. Nothing goes to ${first} until you resume.`;
  if (person.status === 'snoozed' && person.snoozedUntil) return `${first} comes back on your list ${formatSlot(person.snoozedUntil, tz, now)}.`;
  if (person.status !== 'active') return null;
  const step = path.find((s) => !s.done && s.at);
  if (step?.at) return `Next: ${step.label.toLowerCase()} ${formatSlot(step.at, tz, now)}.`;
  const label = nextStepLabel(person);
  if (label === null && person.touches >= 3) return `That was the last message. If ${first} stays quiet, ${first} rests for 90 days.`;
  return null;
}

/** One person, from the River tab: the thread, then reply and snooze for someone waiting, or nudge and hold for someone in the river. */
export function PhonePersonSheet({ person, tag, tz, now, paused, notify, refresh, onClose }: PersonSheetProps) {
  const first = person.firstName;
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [draft, setDraft] = useState(person.draft ?? '');
  const [drafting, setDrafting] = useState(person.status === 'waiting' && !person.draft?.trim());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typed = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else trapTab(e, sheetRef.current);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    api.person(person.id).then(
      (d) => {
        if (live) setDetail(d);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [person.id]);

  useEffect(() => {
    if (!drafting) return;
    let live = true;
    api.draft(person.id, 'reply').then(
      (d) => {
        if (!live) return;
        if (!typed.current) setDraft(d.body);
        setDrafting(false);
      },
      () => {
        if (live) setDrafting(false);
      },
    );
    return () => {
      live = false;
    };
    // The draft is asked for once, when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(whyText(e));
    } finally {
      setBusy(false);
    }
  };

  const send = () =>
    run(async () => {
      const item = await api.reply(person.id, draft.trim());
      // The server's own window, from when it queued the message: the phone never promises more time than there is.
      const span = item.undoUntil ? Date.parse(item.undoUntil) - Date.parse(item.createdAt) : NaN;
      const until = Number.isFinite(span) && span > 0 ? span : 10_000;
      onClose();
      notify(`Sending your reply to ${first}`, {
        ms: until,
        undo: async () => {
          try {
            await api.undo(item.id);
            notify(`Not sent. ${first} is back with you.`);
          } catch (e) {
            notify(whyText(e));
          }
          await refresh();
        },
      });
      await refresh();
    });

  const snooze = () =>
    run(async () => {
      const next = await api.snooze(person.id);
      onClose();
      notify(next.snoozedUntil ? `${first} comes back ${formatSlot(next.snoozedUntil, tz, now)}` : `${first} is resting for now`);
      await refresh();
    });

  const nudge = () =>
    run(async () => {
      const nudgedPerson = await api.nudge(person.id);
      notify(nudgedPerson.nextTouchAt ? `Nudged. ${first}'s next message goes out from ${nudgeSlot(nudgedPerson.nextTouchAt, person.timezone, tz, now)}.` : `Nudged. ${first} is next.`);
      await refresh();
    });

  const hold = () =>
    run(async () => {
      await api.hold(person.id);
      notify(`${first} is on hold. Nothing goes out until you resume.`);
      await refresh();
    });

  const resume = () =>
    run(async () => {
      await api.resume(person.id);
      notify(`${first} is back in the river`);
      await refresh();
    });

  const waiting = person.status === 'waiting';
  const inRiver = person.status === 'active' && person.stage !== 'talking';
  const held = person.status === 'held';
  const look = lookForStage(person.stage);
  const messages = detail?.messages ?? [];
  const next = detail ? nextLine(person, detail.path, tz, now) : null;
  const nudged = person.nextTouchAt !== null && new Date(person.nextTouchAt).getTime() <= now.getTime();
  const nudgeNote = held
    ? `Resume ${first} first to nudge.`
    : paused
      ? `Callum is paused. Resume to nudge ${first}.`
      : nudged
        ? `${first}'s next message goes out from ${nudgeSlot(person.nextTouchAt ?? now.toISOString(), person.timezone, tz, now)}.`
        : nextStepLabel(person) === null
          ? `Callum has nothing more to send ${first}.`
          : null;
  const canNudge = inRiver && nudgeNote === null;
  const blank = draft.trim() === '';

  return (
    <>
      <div className="pa-veil fade-in" onClick={onClose} aria-hidden="true" />
      <section ref={sheetRef} className="pa-sheet" role="dialog" aria-modal="true" aria-labelledby="pa-sheet-name">
        <span className="pa-grip" aria-hidden="true" />
        <div className="pa-sheet-head">
          <Marble seed={300 + person.id} size={46} tone={waiting ? 'warm' : look.tone} ring={waiting ? 'var(--sun)' : look.ring} />
          <span className="pa-sheet-who">
            <span id="pa-sheet-name" className="pa-sheet-name">{person.name}</span>
            <span className="pa-sheet-role">
              {[person.role && person.company ? `${person.role} at ${person.company}` : person.role ?? person.company, channelName(person.channel), tag]
                .filter(Boolean)
                .join(', ')}
            </span>
          </span>
          <button ref={closeRef} type="button" className="pa-icon" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div className="pa-thread">
          {messages.map((m) => {
            const who = whoOf(m);
            return (
              <div key={m.id} className={`pa-msg pa-msg-${who}`}>
                <p>{m.body}</p>
                <span>{`${who === 'callum' ? 'Callum, ' : who === 'you' ? 'You, ' : ''}${messageMeta(kindWord(m), m.at, tz, now)}`}</span>
              </div>
            );
          })}
          {next ? <p className="pa-next">{next}</p> : null}
        </div>

        <div className="pa-actions">
          {waiting ? (
            <>
              <label htmlFor="pa-draft" className="pa-draft-label"><i aria-hidden="true" />Callum&apos;s draft, in your voice</label>
              <textarea
                id="pa-draft"
                className="pa-draft"
                rows={4}
                value={drafting ? '' : draft}
                placeholder={drafting ? 'Callum is writing a draft.' : 'Write a line to send'}
                disabled={drafting}
                onChange={(e) => {
                  typed.current = true;
                  setDraft(e.target.value);
                }}
              />
              <div className="pa-pair">
                <button type="button" className="pa-primary" aria-disabled={blank || drafting || busy} onClick={() => (blank || drafting ? undefined : void send())}>Send</button>
                <button type="button" className="pa-soft" disabled={busy} onClick={() => void snooze()}>Snooze</button>
              </div>
              {blank && !drafting ? <span className="pa-hint">Write a line first. Send waits for words.</span> : null}
            </>
          ) : null}
          {inRiver || held ? (
            <>
              <div className="pa-pair">
                <button type="button" className="pa-primary" aria-disabled={!canNudge || busy} onClick={() => (canNudge ? void nudge() : undefined)}>Nudge now</button>
                {held ? (
                  <button type="button" className="pa-soft" disabled={busy} onClick={() => void resume()}>Resume</button>
                ) : (
                  <button type="button" className="pa-soft" disabled={busy} onClick={() => void hold()}>Hold</button>
                )}
              </div>
              {nudgeNote ? <span className="pa-hint">{nudgeNote}</span> : null}
            </>
          ) : null}
          {error ? <span className="pa-error" role="alert">{error}</span> : null}
        </div>
      </section>
    </>
  );
}
