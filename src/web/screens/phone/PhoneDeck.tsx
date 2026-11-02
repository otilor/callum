import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, OutboxItem, Person } from '../../../shared/types.js';
import { placeholderMessage, findPlaceholders } from '../../../server/engine/guard.js';
import { api } from '../../api.js';
import { ErrorNote } from '../../ui/ErrorNote.js';
import { formatSlot } from '../../ui/format.js';
import { Marble } from '../../ui/Marble.js';
import { prefersReducedMotion } from '../firstrun/motion.js';
import type { PhoneToastData } from './PhoneToast.js';

const LEAVE_MS = 420;
const UNDO_MS = 10_000;

/** `${personId}:${repliedAt}`: a person who writes again is a new card, even after the last one was answered. */
const cardKey = (p: Person) => `${p.id}:${p.repliedAt ?? ''}`;
const CHANNEL_NAME = { email: 'Email', linkedin: 'LinkedIn', x: 'X' } as const;

type Kind = 'reply' | 'book' | 'close' | 'snooze';

/** `Leave the price out` for `[YOUR PRICE]`; a placeholder with no name in it just says `Leave it out`. */
function leaveOutLabel(placeholder: string): string {
  if (!placeholder.startsWith('[')) return 'Leave it out';
  const what = placeholder.slice(1, -1).replace(/_/g, ' ').trim().toLowerCase().replace(/^your(\s+|$)/, '');
  return what ? `Leave the ${what} out` : 'Leave it out';
}

/** The draft without the sentences that carry a placeholder. Line breaks and blank lines stay where they were. */
function withoutPlaceholderSentences(text: string): string {
  const pieces = text.match(/[^.!?\n]*[.!?]+[ \t]*|[^.!?\n]+|\n+/g) ?? [text];
  return pieces
    .filter((piece) => findPlaceholders(piece).length === 0)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

/** Who is waiting on the person using Callum, oldest reply first, leaving out anyone whose answer is already on its way. */
export function dockPeople(state: AppState): Person[] {
  const pending = new Set(state.outbox.filter((o) => o.origin === 'user' && (o.state === 'scheduled' || o.state === 'awaiting_ok')).map((o) => o.personId));
  return state.people
    .filter((p) => p.status === 'waiting' && !pending.has(p.id))
    .sort((a, b) => (a.repliedAt ?? '9999').localeCompare(b.repliedAt ?? '9999') || a.id - b.id);
}

export interface PhoneDeckProps {
  state: AppState;
  refresh(): Promise<void>;
  notify(toast: Omit<PhoneToastData, 'id'>): void;
  now: Date;
}

/** The people who want to talk, one full-width card at a time: their words, Callum's draft, and what to do about it. */
export function PhoneDeck({ state, refresh, notify, now }: PhoneDeckProps) {
  const people = useMemo(() => dockPeople(state), [state]);
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<{ id: number; kind: Kind } | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needCalendar, setNeedCalendar] = useState<string | null>(null);
  const [calendar, setCalendar] = useState('');
  const asked = useRef(new Set<number>());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const t of live) clearTimeout(t);
    };
  }, []);

  const waiting = people.filter((p) => !handled.has(cardKey(p)));
  const card = waiting[0] ?? null;
  const cardId = card?.id;
  const cardDraft = card?.draft ?? null;

  // A person with no draft yet gets one from Callum.
  useEffect(() => {
    if (cardId === undefined || cardDraft !== null || asked.current.has(cardId)) return;
    asked.current.add(cardId);
    api
      .draft(cardId, 'reply')
      .then((r) => setDrafts((d) => (d[cardId] === undefined ? { ...d, [cardId]: r.body } : d)))
      .catch(() => setDrafts((d) => (d[cardId] === undefined ? { ...d, [cardId]: '' } : d)));
  }, [cardId, cardDraft]);

  if (!card) {
    return (
      <div className="ph-caught card-in" role="status">
        <span className="ph-sun" aria-hidden="true" />
        <h2 className="ph-caught-title">All caught up</h2>
        <p className="ph-caught-text">Callum keeps the river moving. You'll get a tap when the next person replies.</p>
      </div>
    );
  }

  const person = card;
  const draft = drafts[person.id] ?? person.draft ?? '';
  const loading = drafts[person.id] === undefined && person.draft === null;
  const holes = findPlaceholders(draft);
  const holeFound = holes.length > 0;
  const canSend = !holeFound && draft.trim().length > 0 && !busy && !leaving;
  const project = state.projects.find((p) => p.id === person.projectId) ?? null;
  const tag = state.projects.length > 1 ? project?.name : null;
  const tz = state.settings.timezone;
  const suggested = person.suggested;

  function done(kind: Kind, text: string, item: OutboxItem | null, t0: number) {
    // The undo window the server gave, less the time the call itself took, so the ring runs out when Undo really stops working.
    const opened = item?.undoUntil ? new Date(item.undoUntil).getTime() - new Date(item.updatedAt || item.createdAt).getTime() : 0;
    const undoMs = Math.min(UNDO_MS, Math.max(0, opened - (performance.now() - t0)));
    const first = person.firstName;
    const key = cardKey(person);
    setLeaving({ id: person.id, kind });
    timers.current.push(
      setTimeout(
        () => {
          setHandled((h) => new Set(h).add(key));
          setLeaving(null);
        },
        prefersReducedMotion() ? 0 : LEAVE_MS,
      ),
    );
    notify({
      text,
      ...(item && undoMs > 0
        ? {
            undo: {
              ms: undoMs,
              run: () => {
                void api
                  .undo(item.id)
                  .then(async () => {
                    setHandled((h) => {
                      const next = new Set(h);
                      next.delete(key);
                      return next;
                    });
                    notify({ text: kind === 'reply' ? `Not sent. Your reply to ${first} is back.` : `${first} is back with you.` });
                    await refresh();
                  })
                  .catch((e: unknown) => notify({ text: messageOf(e) }));
              },
            },
          }
        : {}),
    });
  }

  async function act(task: () => Promise<void>) {
    if (busy || leaving) return;
    setBusy(true);
    setError(null);
    try {
      await task();
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const send = () => {
    if (!canSend) return;
    void act(async () => {
      const t0 = performance.now();
      done('reply', `Sent to ${person.firstName}`, await api.reply(person.id, draft.trim()), t0);
    });
  };
  const book = () => {
    if (!project?.calendarUrl) {
      setNeedCalendar(person.firstName);
      return;
    }
    void act(async () => {
      const t0 = performance.now();
      done('book', `Calendar link sent to ${person.firstName}`, await api.book(person.id), t0);
    });
  };
  const saveCalendar = () => {
    const url = calendar.trim();
    if (!url) return;
    void act(async () => {
      await api.updateProject(person.projectId, { calendarUrl: url });
      setNeedCalendar(null);
      const t0 = performance.now();
      done('book', `Calendar link sent to ${person.firstName}`, await api.book(person.id), t0);
    });
  };
  const close = () =>
    void act(async () => {
      const t0 = performance.now();
      done('close', `Sent. No more follow-ups for ${person.firstName}`, await api.close(person.id), t0);
    });
  const snooze = () =>
    void act(async () => {
      const resting = await api.snooze(person.id);
      done('snooze', resting.snoozedUntil ? `${person.firstName} rests until ${formatSlot(resting.snoozedUntil, tz, now)}` : `${person.firstName} rests for now`, null, performance.now());
    });

  const pending = waiting.length;
  return (
    <div className="ph-deck">
      {pending > 1 ? <span className="ph-behind" aria-hidden="true" /> : null}
      <article className="ph-card card-in" key={person.id} aria-label={`Reply from ${person.name}`} data-leaving={leaving?.id === person.id ? leaving.kind : undefined}>
        <div className="ph-who">
          <Marble seed={300 + person.id} size={52} tone="warm" ring="#FFB020" className="ph-who-face" />
          <span className="ph-who-text">
            <span className="ph-name">{person.name}</span>
            <span className="ph-role">{[person.role, person.company].filter(Boolean).join(' at ') || ' '}</span>
          </span>
          <span className="ph-who-side">
            <span className="ph-chip">{person.channel ? CHANNEL_NAME[person.channel] : 'Email'}</span>
            <span className="ph-when">{person.repliedAt ? formatSlot(person.repliedAt, tz, now).replace(/^./, (c) => c.toUpperCase()) : ''}</span>
            {tag ? <span className="ph-tag">{tag}</span> : null}
          </span>
        </div>
        {person.lastInbound ? <p className="ph-quote">{person.lastInbound}</p> : null}
        <label className="ph-draft-label" htmlFor={`ph-draft-${person.id}`}>
          <span className="ph-sun-dot" aria-hidden="true" />
          Callum's draft, in your voice
        </label>
        <textarea
          id={`ph-draft-${person.id}`}
          className="ph-draft"
          value={draft}
          placeholder={loading ? 'Callum is writing a draft' : ''}
          readOnly={loading}
          onChange={(e) => setDrafts((d) => ({ ...d, [person.id]: e.target.value }))}
        />
        {holeFound ? (
          <div className="ph-hole fade-in" role="alert">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D9480F" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.6v.01" /></svg>
            <span>{placeholderMessage(holes[0] ?? '')}</span>
            <button type="button" onClick={() => setDrafts((d) => ({ ...d, [person.id]: withoutPlaceholderSentences(draft) }))}>
              {leaveOutLabel(holes[0] ?? '')}
            </button>
          </div>
        ) : null}
        {needCalendar ? (
          <div className="ph-calendar fade-in">
            <label htmlFor="ph-calendar">Add your calendar link first</label>
            <div className="ph-calendar-row">
              <input id="ph-calendar" type="url" inputMode="url" placeholder="https://cal.com/you" value={calendar} onChange={(e) => setCalendar(e.target.value)} />
              <button type="button" onClick={saveCalendar} aria-disabled={!calendar.trim()}>Save and send</button>
            </div>
          </div>
        ) : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <button type="button" className="ph-send" aria-disabled={!canSend} data-suggested={suggested === 'reply'} onClick={send}>
          Send
        </button>
        <div className="ph-three">
          <button type="button" className="ph-small" data-suggested={suggested === 'snooze'} onClick={snooze}>Snooze</button>
          <button type="button" className="ph-small ph-small-sun" data-suggested={suggested === 'book'} onClick={book}>Book a call</button>
          <button type="button" className="ph-small" data-suggested={suggested === 'close'} onClick={close}>Close politely</button>
        </div>
      </article>
    </div>
  );
}

export function WaitingLine({ count }: { count: number }) {
  return (
    <span className="ph-waiting">
      <span className="ph-sun-dot" aria-hidden="true" />
      {count === 0 ? 'Nobody is waiting on you' : count === 1 ? '1 person wants to talk' : `${count} people want to talk`}
    </span>
  );
}
