import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppState, Channel, OutboxItem, Person, Project } from '../../../shared/types.js';
import { api } from '../../api.js';
import { River, type FaceMark } from '../../river/River.js';
import { isStill, stillChannels } from '../../river/state.js';
import { AccountMenu, type AccountSlots } from '../../ui/AccountMenu.js';
import { marbleBackground } from '../../ui/Marble.js';
import { formatSlot } from '../../ui/format.js';
import { Wordmark } from '../../ui/Wordmark.js';
import { useUndoToasts, UNDO_MS } from '../home/UndoToast.js';
import { prefersReducedMotion } from '../firstrun/motion.js';
import './DayOne.css';

const TOTAL = 10;
const LEAVE_MS = 380;
const CHANNEL_LABEL: Record<Channel, string> = { email: 'Email', linkedin: 'LinkedIn', x: 'X' };

export interface DayOneProps {
  state: AppState;
  /** The project being viewed: Day one is about its hellos only. */
  project: Project;
  refresh: () => Promise<void>;
  now?: () => Date;
  /** The person is done and asked to see the river. */
  onLeave?: () => void;
  /** What the account menu offers. */
  account?: AccountSlots;
  /** The project switcher, shown beside the wordmark when there is more than one project. */
  switcher?: ReactNode;
  /** Goes back to Home with hellos still waiting, so replies are never stuck behind Day one. */
  onBack?: () => void;
}

type Verdict = 'ok' | 'skip';
interface Card { item: OutboxItem; person: Person }
interface Leaving extends Card { kind: Verdict }

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function Check({ size = 16, color = '#FFFFFF', width = 2.8 }: { size?: number; color?: string; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

/**
 * Day one: the person OKs the first 10 hellos one card at a time, then Callum runs on its own.
 * The river sits underneath so the faces they approve light up where they will go.
 */
export function DayOne({ state, project, refresh, now, onLeave, account = {}, switcher, onBack }: DayOneProps) {
  const clock = now ?? (() => new Date());
  const tz = state.settings.timezone;
  const toasts = useUndoToasts();
  const { info: toastInfo, pending: toastPending } = toasts;

  const people = useMemo(() => state.people.filter((p) => p.projectId === project.id), [state.people, project.id]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const awaiting = useMemo(
    () => state.outbox.filter((o) => o.state === 'awaiting_ok' && byId.has(o.personId)).sort((a, b) => a.id - b.id),
    [state.outbox, byId],
  );

  const [decided, setDecided] = useState<Record<number, Verdict>>({});
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [error, setError] = useState('');
  const [notif, setNotif] = useState<'on' | 'no' | null>(null);
  const [notifError, setNotifError] = useState('');
  const [skipped, setSkipped] = useState(0);
  const msg = useRef<HTMLTextAreaElement>(null);
  const refocus = useRef(false);

  const visible = useMemo(() => awaiting.filter((o) => !decided[o.id]), [awaiting, decided]);
  const firstPerson = visible[0] ? byId.get(visible[0].personId) : undefined;
  // While a card flies away it stays on screen, even if the next state has already dropped it.
  const card: Card | null = leaving ?? (visible[0] && firstPerson ? { item: visible[0], person: firstPerson } : null);

  // An OK counts the moment it is sent, before the next state arrives.
  const okStillListed = awaiting.filter((o) => decided[o.id] === 'ok').length;
  const left = Math.max(0, project.approvalsLeft - okStillListed);
  const reviewing = card !== null;
  const lonely = state.projects.filter((p) => p.state !== 'wrapped').length <= 1;

  // The hour Callum starts is read off the earliest hello; it is kept once the hellos are all approved.
  const earliest = awaiting.reduce<string | null>((min, o) => (min === null || o.sendAfter < min ? o.sendAfter : min), null);
  const remembered = useRef<string | null>(null);
  useEffect(() => {
    if (earliest) remembered.current = earliest;
  }, [earliest]);
  const slotIso = earliest ?? remembered.current ?? state.brief.nextSendAt;
  const slot = slotIso ? formatSlot(slotIso, tz, clock()) : 'tomorrow at 9:00';

  const marks = useMemo(() => {
    const out: Record<number, FaceMark> = {};
    awaiting.slice(0, 12).forEach((o) => {
      out[o.personId] = 'next';
    });
    for (const o of awaiting) {
      const v = decided[o.id];
      if (v === 'ok') out[o.personId] = 'ok';
      if (v === 'skip') out[o.personId] = 'skipped';
    }
    const first = visible[0];
    if (first) out[first.personId] = 'current';
    return out;
  }, [awaiting, decided, visible]);

  // After an OK or a skip the cursor goes to the next message, so the keyboard can carry on without a click.
  const cardId = card?.item.id;
  useEffect(() => {
    if (!refocus.current || cardId === undefined || leaving) return;
    refocus.current = false;
    msg.current?.focus();
  }, [cardId, leaving]);

  const text = card ? (edits[card.item.id] ?? card.item.body) : '';
  const edited = card ? edits[card.item.id] !== undefined && edits[card.item.id] !== card.item.body : false;

  async function decide(kind: Verdict) {
    if (!card || leaving) return;
    const target: Leaving = { kind, item: card.item, person: card.person };
    setError('');
    setLeaving(target);
    try {
      const body = kind === 'ok' && edited ? text : undefined;
      const [result] = await Promise.all([kind === 'ok' ? api.approve(target.item.id, body) : api.skip(target.item.id), wait(prefersReducedMotion() ? 0 : LEAVE_MS)]);
      setDecided((d) => ({ ...d, [target.item.id]: kind }));
      refocus.current = true;
      const first = target.person.firstName;
      if (kind === 'ok') {
        const when = formatSlot(target.item.sendAfter, target.person.timezone ?? tz, clock());
        const ms = result.undoUntil ? Math.min(UNDO_MS, Math.max(1000, Date.parse(result.undoUntil) - clock().getTime())) : UNDO_MS;
        toastPending({
          text: `${first}'s hello goes out ${when}${target.person.timezone ? ' their time' : ''}`,
          failText: `Too late. ${first}'s hello already went out.`,
          ms,
          onUndo: async () => {
            await api.undo(target.item.id);
            setDecided((d) => {
              const next = { ...d };
              delete next[target.item.id];
              return next;
            });
            await refresh();
            return `Not sent. Nothing went to ${first}.`;
          },
        });
      } else {
        setSkipped((n) => n + 1);
        toastInfo(`Callum won't contact ${first}`);
      }
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLeaving(null);
    }
  }

  async function answerNotifications(on: boolean) {
    setNotifError('');
    let granted = false;
    if (on && typeof Notification !== 'undefined') {
      try {
        granted = (await Notification.requestPermission()) === 'granted';
      } catch {
        granted = false;
      }
    }
    try {
      await api.settings({ notifications: granted });
      setNotif(granted ? 'on' : 'no');
    } catch (e) {
      setNotifError(errorText(e));
    }
  }

  const askNotif = !reviewing && state.settings.notifications === null && notif === null;
  const doneIn = TOTAL - left;
  const segs = Array.from({ length: TOTAL }, (_, i) => (i < doneIn ? 'ok' : i === doneIn && reviewing ? 'now' : 'todo'));
  const counter = lonely ? `${left} left` : `${left} of ${TOTAL} hellos left to OK in ${project.name}`;
  const channelLabel = card ? CHANNEL_LABEL[card.item.channel] : '';
  const when = card ? formatSlot(card.item.sendAfter, card.person.timezone ?? tz, clock()) : '';

  return (
    <main className="d1" data-screen="day-one">
      {toasts.node}
      <header className="d1-header">
        <div className="d1-brand">
          <Wordmark />
          {switcher ? (
            <>
              <span className="wm-sep" aria-hidden="true">·</span>
              {switcher}
            </>
          ) : null}
        </div>
        <div className="d1-right">
          {slotIso ? (
            <span className="d1-pill">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="8.5" />
                <path d="M12 7.5V12l3 2" />
              </svg>
              Starts {slot}
            </span>
          ) : null}
          {onBack ? (
            <button type="button" className="d1-back" onClick={onBack}>Back to the river</button>
          ) : null}
          <AccountMenu slots={account} />
        </div>
      </header>

      <div className="d1-main">
        {reviewing && card ? (
          <section className="d1-section" aria-labelledby="d1-title">
            <div className="d1-head">
              <h1 id="d1-title" className="d1-title">OK the first {TOTAL} hellos</h1>
              <p className="d1-sub">After these, Callum runs on its own.</p>
            </div>
            <div className="d1-progress">
              <div className="d1-segs" aria-hidden="true">
                {segs.map((s, i) => (
                  <span key={i} className={`d1-seg d1-seg-${s}`} />
                ))}
              </div>
              <span className="d1-count">{counter}</span>
            </div>
            <article
              key={card.item.id}
              className={`d1-card ${card.item.id % 2 ? 'd1-in-a' : 'd1-in-b'} ${leaving ? `d1-out-${leaving.kind}` : ''}`}
              aria-label={`First message to ${card.person.name}`}
            >
              <div className="d1-who">
                <span className="d1-face" aria-hidden="true" style={{ background: marbleBackground(300 + card.person.id) }} />
                <span className="d1-name">
                  <span className="d1-name-main">{card.person.name}</span>
                  <span className="d1-name-sub">{[card.person.role, card.person.company].filter(Boolean).join(' at ')}</span>
                </span>
                <span className="d1-meta">
                  <span className="d1-chip">{channelLabel}</span>
                  <span className="d1-when">{card.item.kind === 'invite' ? 'Invite note, ' : ''}{when}</span>
                </span>
              </div>
              <label className="sr-only" htmlFor="d1-msg">{`Message to ${card.person.firstName}. You can change any words.`}</label>
              <textarea
                id="d1-msg"
                ref={msg}
                className="d1-msg"
                rows={4}
                value={text}
                onChange={(e) => setEdits((all) => ({ ...all, [card.item.id]: e.target.value }))}
              />
              <div className="d1-actions">
                <span className="d1-hint">{edited ? 'Edited. Callum learns from this.' : 'Click the message to change any words.'}</span>
                <button type="button" className="d1-btn d1-btn-quiet" onClick={() => void decide('skip')} disabled={leaving !== null}>
                  Don't contact
                </button>
                <button type="button" className="d1-btn d1-btn-ok" onClick={() => void decide('ok')} disabled={leaving !== null}>
                  <Check />
                  OK
                </button>
              </div>
              {error ? <p className="d1-error" role="alert">{error}</p> : null}
            </article>
          </section>
        ) : (
          <section className="d1-section d1-done step-in" aria-labelledby="d1-done">
            <span className="d1-tick" aria-hidden="true"><Check size={32} width={2.6} /></span>
            <div className="d1-head">
              <h1 id="d1-done" className="d1-title">{left <= 0 ? `That's all ${TOTAL}` : "That's everyone for now"}</h1>
              <p className="d1-sub d1-sub-big">
                {left <= 0
                  ? `${skipped > 0 ? `Callum will leave ${skipped} ${skipped === 1 ? 'person' : 'people'} alone. ` : ''}From ${slot}, Callum runs on its own.`
                  : 'Callum asks for your OK again when more people join.'}
              </p>
            </div>
            {askNotif ? (
              <div className="d1-ask fade-in">
                <span className="d1-bell" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
                    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
                  </svg>
                </span>
                <span className="d1-ask-text">Want a tap when someone replies?</span>
                <button type="button" className="d1-btn d1-btn-white" onClick={() => void answerNotifications(false)}>Not now</button>
                <button type="button" className="d1-btn d1-btn-ink" onClick={() => void answerNotifications(true)}>Turn on</button>
              </div>
            ) : null}
            {notifError ? <p className="d1-error" role="alert">{notifError}</p> : null}
            {notif ? (
              <p className="d1-notif fade-in">
                {notif === 'on' ? "Done. You'll get a tap the moment someone replies." : 'Okay. Replies will wait for you right here.'}
              </p>
            ) : null}
            <button type="button" className="d1-go" disabled={toasts.undoing} onClick={() => onLeave?.()}>
              See your river
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </section>
        )}
      </div>

      <div className="d1-bottom">
        <River
          className="d1-river"
          compact
          people={people}
          running={!isStill(state, project)}
          still={stillChannels(state)}
          marks={marks}
          overlay={
            <div className="d1-place">
              <span className="d1-place-text">Replies land here.<br />It's normal for this<br />to stay quiet a few days.</span>
              <span className="d1-place-ring" aria-hidden="true" />
            </div>
          }
        />
      </div>
    </main>
  );
}
