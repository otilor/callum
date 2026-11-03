import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WeeklyAnswer, WeeklyGroup, WeeklyReply, WeeklyRest, WeeklyWarm } from '../../../shared/types.js';
import { api, ApiError, noteApi } from '../../api.js';
import { trapTab } from '../../ui/focusTrap.js';
import { useHeadingFocus } from '../../ui/useHeadingFocus.js';
import { Marble } from '../../ui/Marble.js';
import { dayAndTime, dayLong, timeOf } from './quietCopy.js';
import './Weekly.css';

export interface WeeklyProps {
  /** The user's time zone, for the dates in the note. */
  tz: string;
  /** Called after Callum added people for the person, so Home reads its state again. */
  onChanged?: () => void;
  /** Opens a person in Home's popover. The link in the note is left out without it. */
  onOpenPerson?: (id: number) => void;
  /** Each time this number goes up the note opens (the account menu's `Your week, in people`). */
  openSignal?: number;
}

type Suggestion = 'idle' | 'looking' | 'found' | 'later';

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#1D2140" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.4 6.3 5 8.8l4.6-5.2" />
    </svg>
  );
}

function RepliedFaces({ replied, picked, onPick }: { replied: WeeklyReply[]; picked: string | null; onPick: (key: string) => void }) {
  return (
    <div role="list" aria-label="Replied this week" className="wk-faces">
      {replied.map((r) => {
        const key = `r${r.id}`;
        const on = picked === key;
        return (
          <div role="listitem" key={r.id} className="wk-person">
            <button
              type="button"
              className={on ? 'wk-peek wk-peek-on' : 'wk-peek'}
              aria-label={`${r.name}${r.company ? `, ${r.company}` : ''}, ${r.booked ? 'call booked' : 'replied'}`}
              aria-pressed={on}
              onClick={() => onPick(key)}
            >
              <Marble seed={300 + r.id} size={60} tone="warm" ring="#FFB020" className={on ? 'wk-marble wk-marble-on' : 'wk-marble'} />
              {r.booked ? <span className="wk-booked" aria-hidden="true"><Check /></span> : null}
            </button>
            <span className={on ? 'wk-first wk-first-on' : 'wk-first'}>{r.first}</span>
          </div>
        );
      })}
    </div>
  );
}

function WarmingFaces({ warming, picked, onPick }: { warming: WeeklyWarm[]; picked: string | null; onPick: (key: string) => void }) {
  return (
    <div role="list" aria-label="Warming up" className="wk-faces wk-faces-small">
      {warming.map((w) => {
        const key = `w${w.id}`;
        const on = picked === key;
        return (
          <div role="listitem" key={w.id} className="wk-person wk-person-small">
            <button type="button" className="wk-peek" aria-label={`${w.first}, warming up`} aria-pressed={on} onClick={() => onPick(key)}>
              <Marble seed={300 + w.id} size={42} tone="cool" ring={on ? '#3F52D9' : '#6E86F2'} />
            </button>
            <span className={on ? 'wk-first wk-first-on' : 'wk-first'}>{w.first}</span>
          </div>
        );
      })}
    </div>
  );
}

function Resting({ resting }: { resting: WeeklyRest }) {
  if (resting.count === 0) return <p className="wk-quiet">Nobody is resting.</p>;
  const dots = Math.min(resting.count, 4);
  return (
    <div className="wk-rest">
      <span className="wk-dots" aria-hidden="true">
        {Array.from({ length: dots }, (_, i) => <i key={i} />)}
      </span>
      <span className="wk-quiet">
        {resting.count} {resting.count === 1 ? 'person' : 'people'}
        {resting.backOn ? `, back on ${resting.backOn}` : ''}
      </span>
    </div>
  );
}

function Picked({ replied, warming, picked, onOpenPerson }: {
  replied: WeeklyReply[]; warming: WeeklyWarm[]; picked: string | null; onOpenPerson: ((id: number) => void) | undefined;
}) {
  const r = replied.find((x) => `r${x.id}` === picked);
  const w = warming.find((x) => `w${x.id}` === picked);
  if (r) {
    return (
      <p className="wk-pick wk-pick-sun fade-in" key={picked}>
        <span>{r.text}</span>
        {onOpenPerson ? <button type="button" onClick={() => onOpenPerson(r.id)}>Open {r.first}</button> : null}
      </p>
    );
  }
  return w ? <p className="wk-pick fade-in" key={picked}>{w.text}</p> : null;
}

function Group({ group }: { group: WeeklyGroup }) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <section className="wk-group" aria-label={group.name}>
      <h3>{group.name}</h3>
      <p className="wk-gline">{group.line}</p>
      {group.replied.length ? <RepliedFaces replied={group.replied} picked={picked} onPick={(k) => setPicked(picked === k ? null : k)} /> : null}
      <Picked replied={group.replied} warming={group.warming} picked={picked} onOpenPerson={undefined} />
      {group.warming.length || group.resting.count ? (
        <div className="wk-pair">
          {group.warming.length ? <WarmingFaces warming={group.warming} picked={picked} onPick={(k) => setPicked(picked === k ? null : k)} /> : null}
          <Resting resting={group.resting} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Your week, in people. A button that opens the weekly note as a sheet over the river, and opens it by itself the first
 * time the person visits after Monday 8:30. The note covers every project and shows the plain-text email beside it on request.
 */
export function Weekly({ tz, onChanged, onOpenPerson, openSignal = 0 }: WeeklyProps) {
  const [answer, setAnswer] = useState<WeeklyAnswer | null>(null);
  const [open, setOpen] = useState(false);
  const [emailOn, setEmailOn] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [sug, setSug] = useState<Suggestion>('idle');
  const [sugText, setSugText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const marked = useRef(false);
  const titleId = useId();
  const headingRef = useHeadingFocus(open, open);

  const markSeen = useCallback(() => {
    if (marked.current) return;
    marked.current = true;
    noteApi.weeklySeen().catch(() => {
      marked.current = false;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    noteApi.weekly().then(
      (a) => {
        if (!alive) return;
        setAnswer(a);
        if (a.shouldOpen) {
          setOpen(true);
          markSeen();
        }
      },
      () => {
        // The note is a nicety: when it cannot be read there is simply no button.
      },
    );
    return () => {
      alive = false;
    };
  }, [markSeen]);

  // The account menu asks for the note by number; the first value is only where it starts.
  const firstSignal = useRef(openSignal);
  useEffect(() => {
    if (openSignal === firstSignal.current) return;
    setOpen(true);
    markSeen();
  }, [openSignal, markSeen]);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // A note with nothing in it has no heading to land on: the cursor goes to its one button.
    if (!headingRef.current) closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else trapTab(e, stage.current);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!answer) return null;
  const { note, email } = answer;
  if (note.hellos === 0 && note.replied.length === 0) {
    // Asked for from the menu in a week with nothing in it: say so, instead of doing nothing.
    return open ? createPortal(
      <div className="wk-empty-back" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div className="wk-empty" role="dialog" aria-modal="true" aria-label="Your week, in people">
          <h2>Your week, in people</h2>
          <p>Nothing to tell yet. Once Callum has said hello to people, their week shows up here.</p>
          <button type="button" ref={closeButton} className="wk-empty-close" onClick={close}>Close</button>
        </div>
      </div>,
      document.body,
    ) : null;
  }

  async function findMore() {
    const s = note.suggestion;
    if (!s || sug === 'looking') return;
    setSug('looking');
    setError(null);
    try {
      const result = await api.act(s.action, s.projectId);
      setSugText(result.text);
      setSug('found');
      onChanged?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.');
      setSug('idle');
    }
  }

  const pickIn = (key: string) => setPicked(picked === key ? null : key);
  const grouped = note.groups.length > 1;
  const likeId = note.suggestion?.action.kind === 'find_more' ? note.suggestion.action.args.likePersonId : null;

  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="wk-pill soft"
        onClick={() => {
          setOpen(true);
          markSeen();
        }}
      >
        <span className="wk-pill-faces" aria-hidden="true">
          {note.replied.slice(0, 3).map((r) => <Marble key={r.id} seed={300 + r.id} size={26} tone="warm" ring="#FFB020" className="wk-pill-face" />)}
        </span>
        Your week, in people
      </button>

      {open ? createPortal(
        <div className="wk-layer">
          <div className="wk-veil" onClick={close} aria-hidden="true" />
          <div ref={stage} className={emailOn ? 'wk-stage wk-stage-pair' : 'wk-stage'} role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <section className="wk-note">
              <div className="wk-head">
                <div>
                  <span className="wk-date">{dayAndTime(note.at, tz)}</span>
                  <h1 ref={headingRef} tabIndex={-1} id={titleId}>{note.title}</h1>
                </div>
                <button type="button" ref={closeButton} className="wk-close" onClick={close} aria-label="Close the note">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M3 3l8 8M11 3l-8 8" />
                  </svg>
                </button>
              </div>

              {grouped ? (
                <>
                  <p className="wk-line">{note.line}</p>
                  {note.groups.map((g) => <Group key={g.projectId} group={g} />)}
                </>
              ) : (
                <>
                  {note.replied.length ? (
                    <div className="wk-block">
                      <RepliedFaces replied={note.replied} picked={picked} onPick={pickIn} />
                      <Picked replied={note.replied} warming={note.warming} picked={picked} onOpenPerson={onOpenPerson} />
                    </div>
                  ) : null}
                  <p className="wk-line">{note.line}</p>
                  <div className="wk-pair">
                    <div className="wk-col">
                      <span className="wk-label">Warming up</span>
                      {note.warming.length ? <WarmingFaces warming={note.warming} picked={picked} onPick={pickIn} /> : <p className="wk-quiet">Nobody yet.</p>}
                    </div>
                    <div className="wk-col wk-col-rest">
                      <span className="wk-label">Resting</span>
                      <Resting resting={note.resting} />
                    </div>
                  </div>
                  {!note.replied.length ? <Picked replied={note.replied} warming={note.warming} picked={picked} onOpenPerson={onOpenPerson} /> : null}
                </>
              )}

              {note.suggestion ? (
                <div className="wk-idea" aria-live="polite">
                  <span className="wk-idea-face" aria-hidden="true">
                    {likeId !== null ? <Marble seed={300 + likeId} size={46} tone="warm" ring="#FFB020" /> : null}
                  </span>
                  <div className="wk-idea-body">
                    {sug === 'idle' ? (
                      <div className="fade-in">
                        <p>{note.suggestion.text}</p>
                        <div className="wk-row">
                          <button type="button" className="soft wk-dark" onClick={() => void findMore()}>{note.suggestion.action.kind === 'find_more' ? `Find ${note.suggestion.action.args.count} more` : note.suggestion.action.label}</button>
                          <button type="button" className="soft wk-light" onClick={() => setSug('later')}>Not now</button>
                        </div>
                        {error ? <p className="wk-error" role="alert">{error}</p> : null}
                      </div>
                    ) : null}
                    {sug === 'looking' ? (
                      <p className="wk-looking fade-in">
                        <span className="wk-pulses" aria-hidden="true"><i /><i /><i /></span>
                        Callum is looking
                      </p>
                    ) : null}
                    {sug === 'found' ? <p className="fade-in">{sugText}</p> : null}
                    {sug === 'later' ? (
                      <div className="fade-in">
                        <p>Okay. Callum will ask again next Monday.</p>
                        <div className="wk-row"><button type="button" className="soft wk-light" onClick={() => setSug('idle')}>Find them now</button></div>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="wk-foot">
                <button type="button" className="soft wk-light" aria-pressed={emailOn} onClick={() => setEmailOn(!emailOn)}>
                  {emailOn ? 'Hide the email' : 'See it as email'}
                </button>
                <span className="wk-quiet">Next note {dayLong(note.nextAt, tz)} at {timeOf(note.nextAt, tz)}</span>
              </div>
            </section>

            {emailOn ? (
              <section className="wk-mail" aria-label="The same note as an email">
                <span className="wk-label">As it lands in your inbox</span>
                <div className="wk-mail-card">
                  <h2>{email.subject}</h2>
                  <p className="wk-mail-meta">From Callum, to you. {dayAndTime(note.at, tz)}.</p>
                  <pre className="wk-mail-text">{email.text}</pre>
                </div>
              </section>
            ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
