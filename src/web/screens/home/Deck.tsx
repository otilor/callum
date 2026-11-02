import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Correction, OutboxItem, Person, Project, SuggestedAction } from '../../../shared/types.js';
import { api } from '../../api.js';
import { DraftField } from '../../ui/DraftField.js';
import { findPlaceholders, guardLine, leaveOutLabel, removePlaceholderSentence } from '../../ui/highlight.js';
import { marbleBackground } from '../../ui/Marble.js';
import { dayName, formatWhen } from '../../ui/when.js';
import { prefersReducedMotion } from '../firstrun/motion.js';
import { channelName, channelPhrase } from './dock.js';
import { UNDO_MS, type UndoToasts } from './UndoToast.js';
import './Deck.css';

type Act = 'reply' | 'book' | 'snooze' | 'close';
const LEAVE_MS = 430;
/** How each card leaves: a reply lifts away, a booking slides right, a snooze slides left, a close sinks and fades. */
const EXIT: Record<Act, string> = { reply: 'up', book: 'right', snooze: 'left', close: 'down' };

const SUGGEST: Record<SuggestedAction, string> = {
  reply: 'Suggested: reply. Callum drafted it.',
  book: 'Suggested: book a call.',
  snooze: 'Suggested: snooze until Monday.',
  close: 'Suggested: close politely.',
};

export interface DeckProps {
  /** Everyone who waits on you, oldest reply first, from every project. */
  people: Person[];
  projects: Project[];
  tz: string;
  now?: () => Date;
  /** The card to show first. */
  startAt?: number;
  toasts: Pick<UndoToasts, 'pending' | 'info'>;
  refresh: () => Promise<void>;
  onClose: () => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

function validUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

const stroke = { fill: 'none', stroke: '#1D2140', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function ActButton({ label, size, suggested, tone, onClick, disabled, children }: {
  label: string; size: number; suggested: boolean; tone: 'quiet' | 'ink' | 'sun'; onClick: () => void; disabled?: boolean; children: ReactNode;
}) {
  return (
    <div className="deck-act-wrap">
      <button
        type="button"
        className={`deck-act deck-act-${tone} ${suggested ? 'is-suggested' : ''}`}
        aria-label={label}
        aria-disabled={disabled ? 'true' : undefined}
        style={{ width: size, height: size }}
        onClick={onClick}
      >
        {children}
      </button>
      <span aria-hidden="true" className={`deck-act-label ${suggested ? 'is-on' : ''}`}>{label}</span>
    </div>
  );
}

/**
 * The reply deck: one card for each person who answered, oldest first. Their message, Callum's draft in a sun-tinted box
 * you can change, and four ways to answer. Anything that sends can be undone for ten seconds.
 */
export function Deck({ people, projects, tz, now, startAt, toasts, refresh, onClose }: DeckProps) {
  const clock = now ?? (() => new Date());
  const [order, setOrder] = useState<number[]>(() => {
    const ids = people.map((p) => p.id);
    return startAt !== undefined && ids.includes(startAt) ? [startAt, ...ids.filter((i) => i !== startAt)] : ids;
  });
  const [handled, setHandled] = useState<Set<number>>(new Set());
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [fetched, setFetched] = useState<Record<number, string>>({});
  const [failedDraft, setFailedDraft] = useState<Set<number>>(new Set());
  const [leaving, setLeaving] = useState<{ id: number; act: Act } | null>(null);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const [calendar, setCalendar] = useState<{ open: boolean; value: string; error: string }>({ open: false, value: '', error: '' });
  const [savedCalendar, setSavedCalendar] = useState<Record<number, string>>({});

  const live = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  // Someone who answers while the deck is open joins the end of the line.
  useEffect(() => {
    setOrder((o) => {
      const added = people.map((p) => p.id).filter((id) => !o.includes(id));
      return added.length > 0 ? [...o, ...added] : o;
    });
  }, [people]);

  const currentId = order.find((id) => live.has(id) && !handled.has(id));
  const person = currentId !== undefined ? live.get(currentId) : undefined;
  const project = person ? projects.find((p) => p.id === person.projectId) : undefined;
  const many = projects.filter((p) => p.state !== 'wrapped').length > 1;
  const calendarUrl = person ? (savedCalendar[person.projectId] ?? project?.calendarUrl ?? null) : null;

  // A reply with no draft yet gets one from Callum.
  const asked = useRef(new Set<number>());
  useEffect(() => {
    if (!person || person.draft || drafts[person.id] !== undefined || fetched[person.id] !== undefined || asked.current.has(person.id)) return;
    asked.current.add(person.id);
    api.draft(person.id, 'reply').then(
      (r) => setFetched((f) => ({ ...f, [person.id]: r.body })),
      () => {
        setFetched((f) => ({ ...f, [person.id]: '' }));
        setFailedDraft((set) => new Set(set).add(person.id));
      },
    );
  }, [person, drafts, fetched]);

  // Escape closes what is open inside the card first (the menu, the calendar field), and the deck only after that.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menu) setMenu(false);
      else if (calendar.open) setCalendar((c) => ({ ...c, open: false, error: '' }));
      else onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose, menu, calendar.open]);

  // Each card announces itself: focus moves to the name when the deck opens and when the next card arrives.
  const nameRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, [currentId]);

  useEffect(() => {
    setError('');
    setMenu(false);
    setCalendar({ open: false, value: '', error: '' });
  }, [currentId]);

  const draft = person ? (drafts[person.id] ?? person.draft ?? fetched[person.id] ?? '') : '';
  const holes = findPlaceholders(draft);
  const empty = draft.trim() === '';
  const drafting = person !== undefined && !person.draft && drafts[person.id] === undefined && fetched[person.id] === undefined;
  const blocked = holes.length > 0 || empty;
  const suggested = person?.suggested ?? null;

  const remaining = order.filter((id) => live.has(id) && !handled.has(id) && id !== currentId).length;
  const place = currentId !== undefined ? order.indexOf(currentId) + 1 : 0;

  async function run(kind: Act) {
    if (!person || leaving) return;
    if (kind === 'reply' && blocked) return;
    if (kind === 'book' && !calendarUrl) {
      setCalendar((c) => ({ ...c, open: true }));
      return;
    }
    const target = person;
    const first = target.firstName;
    setError('');
    setLeaving({ id: target.id, act: kind });
    try {
      const call =
        kind === 'reply' ? api.reply(target.id, draft)
        : kind === 'book' ? api.book(target.id)
        : kind === 'close' ? api.close(target.id)
        : api.snooze(target.id);
      const [result] = await Promise.all([call, wait(prefersReducedMotion() ? 0 : LEAVE_MS)]);
      setHandled((h) => new Set(h).add(target.id));
      if (kind === 'snooze') {
        const until = (result as Person).snoozedUntil;
        toasts.info(`${first} comes back on ${until ? dayName(until, tz, clock()) : 'Monday'}`);
      } else {
        const item = result as OutboxItem;
        const ms = item.undoUntil ? Math.min(UNDO_MS, Math.max(1000, Date.parse(item.undoUntil) - clock().getTime())) : UNDO_MS;
        toasts.pending({
          text: kind === 'reply' ? `Sending your reply to ${first}` : kind === 'book' ? `Sending ${first} your calendar link` : `Thanking ${first}. No more follow-ups.`,
          doneText: kind === 'reply' ? `Sent to ${first}` : kind === 'book' ? `Calendar link sent to ${first}` : `Sent. Callum won't follow up with ${first} again.`,
          ms,
          failText: `Too late. Your reply already went to ${first}.`,
          onUndo: async () => {
            await api.undo(item.id);
            setHandled((h) => {
              const next = new Set(h);
              next.delete(target.id);
              return next;
            });
            await refresh();
            return kind === 'reply' ? `Not sent. Your reply to ${first} is back.` : `Not sent. ${first} is back with you.`;
          },
        });
      }
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLeaving(null);
    }
  }

  async function correct(kind: Correction) {
    if (!person) return;
    const first = person.firstName;
    const id = person.id;
    setMenu(false);
    try {
      await api.correct(id, kind);
      setHandled((h) => new Set(h).add(id));
      toasts.info(
        kind === 'auto_reply' ? `${first} is back in the river` : kind === 'wrong_person' ? `${first} is removed. Callum won't contact them` : `Callum won't contact ${first} again`,
      );
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function saveCalendar(e: FormEvent) {
    e.preventDefault();
    if (!person) return;
    const url = calendar.value.trim();
    if (!validUrl(url)) {
      setCalendar((c) => ({ ...c, error: 'That does not look like a link. Paste the full address, starting with https.' }));
      return;
    }
    try {
      await api.updateProject(person.projectId, { calendarUrl: url });
      setSavedCalendar((s) => ({ ...s, [person.projectId]: url }));
      setCalendar({ open: false, value: '', error: '' });
      await refresh();
    } catch (err) {
      setCalendar((c) => ({ ...c, error: errorText(err) }));
    }
  }

  const exit = leaving ? `out-${EXIT[leaving.act]}` : '';
  const tone = project?.tone;

  return (
    <div className="deck-veil" role="dialog" aria-modal="true" aria-label="Replies waiting for you">
      <button type="button" className="deck-close" aria-label="Close" onClick={onClose}>
        <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" /></svg>
      </button>

      {person ? (
        <>
          <div className="deck-dots" aria-hidden="true">
            {order.map((id) => {
              const here = id === currentId;
              const gone = !live.has(id) || handled.has(id);
              return <span key={id} className={`deck-dot ${here ? 'is-here' : gone ? 'is-gone' : ''}`} />;
            })}
          </div>
          <span className="sr-only">{`Reply ${place} of ${order.length}`}</span>
          <div className="deck-stack">
            {remaining >= 2 ? <span className="deck-back deck-back-2" aria-hidden="true" /> : null}
            {remaining >= 1 ? <span className="deck-back deck-back-1" aria-hidden="true" /> : null}
            <article key={person.id} className={`deck-card ${person.id % 2 ? 'deck-in-a' : 'deck-in-b'} ${exit}`} aria-label={`Reply from ${person.name}`}>
              <div className="deck-top">
                <span className="deck-chip">{channelName(person.channel)}</span>
                {many ? <span className="home-tag">{project?.name ?? ''}</span> : null}
                <span className="deck-when">{person.repliedAt ? formatWhen(person.repliedAt, tz, clock()) : ''}</span>
                <div className="deck-more">
                  <button type="button" className="deck-more-btn" aria-label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="#1D2140" aria-hidden="true"><circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" /></svg>
                  </button>
                  {menu ? (
                    <div className="deck-menu deck-pop" role="menu">
                      <button type="button" role="menuitem" onClick={() => void correct('auto_reply')}>That's an auto-reply</button>
                      <button type="button" role="menuitem" onClick={() => void correct('wrong_person')}>Wrong person</button>
                      <button type="button" role="menuitem" onClick={() => void correct('never_contact')}>Never contact</button>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="deck-who">
                <span className="deck-face" aria-hidden="true" style={{ background: marbleBackground(300 + person.id) }} />
                <h2 className="deck-name" ref={nameRef} tabIndex={-1}>{person.name}</h2>
                <span className="deck-role">{[person.role, person.company].filter(Boolean).join(' at ')}</span>
              </div>

              <p className={`deck-quote ${(person.lastInbound ?? '').length > 80 ? 'is-long' : ''}`}>
                {person.lastInbound ? `“${person.lastInbound}”` : `${person.firstName} replied.`}
              </p>
              <span className="deck-route">{`Reply goes ${channelPhrase(person.channel)}`}</span>

              <label className="deck-label" htmlFor="deck-draft">
                <span className="deck-sun" aria-hidden="true" />
                {`Callum's draft, in your ${tone ? `${tone} ` : ''}voice`}
              </label>
              <DraftField id="deck-draft" label={`Your reply to ${person.firstName}`} value={draft} onChange={(v) => setDrafts((d) => ({ ...d, [person.id]: v }))} />

              {empty && !drafting ? (
                <p className="deck-hint fade-in" role="status">
                  {failedDraft.has(person.id) && drafts[person.id] === undefined ? "Callum couldn't write a draft. Write your own." : 'Write a few words first.'}
                </p>
              ) : null}
              {holes.length > 0 ? (
                <div className="deck-guard fade-in" role="alert">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D9480F" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.6v.01" /></svg>
                  <span className="deck-guard-text">{guardLine(holes[0]!)}</span>
                  <button type="button" className="deck-fix" onClick={() => setDrafts((d) => ({ ...d, [person.id]: removePlaceholderSentence(draft, holes[0]!) }))}>
                    {leaveOutLabel(holes[0]!)}
                  </button>
                </div>
              ) : null}

              <p className="deck-suggest">
                <span className="deck-sun" aria-hidden="true" />
                {suggested ? (suggested === 'reply' && empty ? 'Suggested: reply.' : SUGGEST[suggested]) : 'Callum has no suggestion. You know this person best.'}
              </p>

              <div className="deck-actions">
                <ActButton label="Close politely" size={60} tone="quiet" suggested={suggested === 'close'} onClick={() => void run('close')}>
                  <svg width="22" height="22" viewBox="0 0 24 24" {...stroke} aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4" /></svg>
                </ActButton>
                <ActButton label="Snooze" size={60} tone="quiet" suggested={suggested === 'snooze'} onClick={() => void run('snooze')}>
                  <svg width="22" height="22" viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>
                </ActButton>
                <ActButton label="Reply" size={76} tone="ink" suggested={suggested === 'reply'} disabled={blocked} onClick={() => void run('reply')}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>
                </ActButton>
                <ActButton label="Book a call" size={60} tone="sun" suggested={suggested === 'book'} disabled={!calendarUrl} onClick={() => void run('book')}>
                  <svg width="22" height="22" viewBox="0 0 24 24" {...stroke} aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
                </ActButton>
              </div>

              {!calendarUrl ? (
                <div className="deck-note">
                  <button type="button" className="deck-note-line" onClick={() => setCalendar((c) => ({ ...c, open: true }))}>Add your calendar link first</button>
                  {calendar.open ? (
                    <form className="deck-cal fade-in" noValidate onSubmit={(e) => void saveCalendar(e)}>
                      <label className="sr-only" htmlFor="deck-cal">Calendar link</label>
                      <input id="deck-cal" type="url" inputMode="url" placeholder="https://cal.com/you" value={calendar.value} onChange={(e) => setCalendar((c) => ({ ...c, value: e.target.value, error: '' }))} autoFocus />
                      <button type="submit" className="deck-save">Save</button>
                    </form>
                  ) : null}
                  {calendar.error ? <p className="deck-error" role="alert">{calendar.error}</p> : null}
                </div>
              ) : null}
              {error ? <p className="deck-error" role="alert">{error}</p> : null}
            </article>
          </div>
        </>
      ) : (
        <div className="deck-empty deck-in-a">
          <span className="deck-sunbig" aria-hidden="true" />
          <h2>All caught up</h2>
          <p>Callum keeps the river moving. You'll get a tap when the next person replies.</p>
          <button type="button" className="deck-back-btn" onClick={onClose}>Back to the river</button>
        </div>
      )}
    </div>
  );
}
