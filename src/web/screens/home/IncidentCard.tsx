import { findPlaceholders, offerSaysEnough } from '../../../shared/placeholders.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppState, Channel, Incident, OutboxItem, Person } from '../../../shared/types.js';
import { api, ApiError } from '../../api.js';
import { ErrorNote } from '../../ui/ErrorNote.js';
import { formatSlot } from '../../ui/format.js';
import { Marble } from '../../ui/Marble.js';
import { autoItems } from './incidentVariants.js';
import { useToast } from '../../ui/Toast.js';
import './Incident.css';

const LINKEDIN_FEED = 'https://www.linkedin.com/feed/';
const KEPT_MS = 9000;
const DISMISSED_KEY = 'callum.incidents.dismissed';
const CHANNEL_NAME: Record<Channel, string> = { email: 'email', linkedin: 'LinkedIn', x: 'X' };

type Phase = 'alert' | 'waiting' | 'clear' | 'resumed';
type Pace = 'half' | 'full';

/** The channels whose people hold still on the river: stopped by a check, a sign-out or a daily limit. */
export function stillChannels(state: AppState): Channel[] {
  return state.channels.filter((c) => c.status === 'paused' || c.status === 'error').map((c) => c.channel);
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

function openLinkedIn(): void {
  window.open(LINKEDIN_FEED, '_blank', 'noopener');
}

function readDismissed(): Set<number> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((n): n is number => typeof n === 'number') : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(ids: Set<number>): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    // Without storage the notice simply comes back after a reload.
  }
}

/** The people on this channel who are held up, newest first, for the faces and the count. */
function waitingFor(state: AppState, ch: Channel): Person[] {
  return state.people.filter((p) => p.channel === ch && (p.status === 'active' || p.status === 'resting') && p.stage !== 'talking');
}

interface BounceDetail { domain?: string; people?: unknown[] }

function bounceCount(incident: Incident): number {
  try {
    const d = JSON.parse(incident.detail ?? 'null') as BounceDetail | null;
    return Array.isArray(d?.people) ? d.people.length : 0;
  } catch {
    return 0;
  }
}

/** A reply the mailbox's daily limit held back: it goes by itself, so the notice only needs reading. */
function isDeferred(incident: Incident): boolean {
  try {
    return (JSON.parse(incident.detail ?? 'null') as { deferred?: unknown } | null)?.deferred === true;
  } catch {
    return false;
  }
}

function outboxIdOf(incident: Incident): number | null {
  try {
    const d = JSON.parse(incident.detail ?? 'null') as { outboxId?: unknown } | null;
    return typeof d?.outboxId === 'number' ? d.outboxId : null;
  } catch {
    return null;
  }
}

/** `Google signed Callum out of …` gives `Google`; anything else gives null. */
function signedOutProvider(incident: Incident): string | null {
  const m = /^(Google|Microsoft) signed Callum out/.exec(incident.message);
  return m?.[1] ?? null;
}

function titleOf(incident: Incident, state: AppState): string {
  switch (incident.kind) {
    case 'linkedin_check': return "LinkedIn wants to check it's you";
    case 'linkedin_weekly_limit': return "LinkedIn's weekly limit";
    case 'x_limit': return 'X stopped taking messages';
    case 'mailbox_limit': return 'Your mailbox reached its daily limit';
    case 'mailbox_signed_out': {
      const subject = /^(.*?) signed Callum out/.exec(incident.message)?.[1];
      return subject ? `${subject} signed Callum out` : `${CHANNEL_NAME[incident.channel]} needs to be connected again`.replace(/^./, (c) => c.toUpperCase());
    }
    case 'x_signed_out': return 'X signed Callum out';
    case 'linkedin_signed_out': return 'LinkedIn signed Callum out';
    case 'not_answering': return `${CHANNEL_NAME[incident.channel].replace(/^./, (c) => c.toUpperCase())} isn't answering`;
    case 'reply_unread': {
      const who = state.people.find((p) => p.id === incident.personId);
      return who ? `Callum couldn't read a reply from ${who.firstName}` : "Callum couldn't read a reply";
    }
    case 'bounces': {
      const n = bounceCount(incident);
      return n > 0 ? `${n} ${n === 1 ? 'email' : 'emails'} bounced` : 'Some emails bounced';
    }
    case 'channel_paused': return `${CHANNEL_NAME[incident.channel].replace(/^./, (c) => c.toUpperCase())} is paused`;
    case 'needs_offer': return 'Callum needs one line from you';
    case 'send_failed': {
      // Callum's own messages: the sentence that says how many is the title.
      if (autoItems(incident.detail) !== null) return incident.message;
      const who = state.people.find((p) => p.id === incident.personId);
      if (isDeferred(incident)) return who ? `Your reply to ${who.firstName} is waiting` : 'Your reply is waiting';
      return who ? `Your reply to ${who.firstName} didn't go out` : "Your reply didn't go out";
    }
  }
}

function nextStepOf(incident: Incident): string {
  switch (incident.kind) {
    case 'linkedin_check': return 'Finish the check on LinkedIn, then come back to resume.';
    case 'mailbox_signed_out': {
      const provider = signedOutProvider(incident);
      return incident.channel === 'email' ? `Reconnect ${provider ?? 'your email'} to send them.` : `Connect ${CHANNEL_NAME[incident.channel]} again to carry on.`;
    }
    case 'x_signed_out':
    case 'linkedin_signed_out': return `Connect ${CHANNEL_NAME[incident.channel]} again to carry on.`;
    case 'not_answering': return 'Callum keeps trying. If it stays quiet, connect it again.';
    case 'channel_paused': return `Check ${CHANNEL_NAME[incident.channel]}, then resume it here.`;
    case 'reply_unread': return incident.personId === null ? 'Check that channel by hand, then press Okay.' : 'Open the conversation and read it yourself.';
    case 'send_failed': return isDeferred(incident) ? 'Nothing to do. It goes by itself.' : 'Try again, or copy it and send it another way.';
    default: return 'Nothing to do.';
  }
}

function when(incident: Incident, state: AppState, now: Date): string {
  const text = formatSlot(incident.createdAt, state.settings.timezone, now);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ChannelBadge({ channel, paused }: { channel: Channel; paused: boolean }) {
  return (
    <span className="inc-badge" aria-hidden="true">
      {channel === 'linkedin' ? 'in' : channel === 'x' ? 'X' : (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
          <path d="M4 7l8 6 8-6" />
        </svg>
      )}
      <span className="inc-badge-mark" data-kind={paused ? 'pause' : 'error'}>
        {paused ? (
          <svg width="8" height="8" viewBox="0 0 8 8">
            <rect x="1" y="0.5" width="2" height="7" rx="0.8" fill="#FFFFFF" />
            <rect x="5" y="0.5" width="2" height="7" rx="0.8" fill="#FFFFFF" />
          </svg>
        ) : (
          <svg width="9" height="9" viewBox="0 0 10 10">
            <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        )}
      </span>
    </span>
  );
}

function Lines({ what, next }: { what: string; next: string }) {
  return (
    <ol className="inc-lines">
      <li>
        <span className="inc-dot" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z" /></svg>
        </span>
        <span>{what}</span>
      </li>
      <li>
        <span className="inc-dot inc-dot-ink" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </span>
        <span className="inc-next">{next}</span>
      </li>
    </ol>
  );
}

function WaitStrip({ people, line }: { people: Person[]; line: string }) {
  return (
    <div className="inc-wait">
      <span className="inc-wait-faces" aria-hidden="true">
        {people.slice(0, 6).map((p) => (
          <Marble key={p.id} seed={300 + p.id} size={28} tone="grey" ring={null} style={{ marginRight: -6, border: '2px solid #F4F5F9', opacity: 0.7 }} />
        ))}
      </span>
      <span>{line}</span>
    </div>
  );
}

function Shell({ incident, state, now, titleId, paused, children }: { incident: Incident; state: AppState; now: Date; titleId: string; paused: boolean; children: ReactNode }) {
  return (
    <section className="inc-card card-in" aria-labelledby={titleId} data-kind={incident.kind}>
      <div className="inc-head">
        <ChannelBadge channel={incident.channel} paused={paused} />
        <div className="inc-head-text">
          <h2 id={titleId} className="inc-title" tabIndex={-1}>{titleOf(incident, state)}</h2>
          <span className="inc-when">{when(incident, state, now)}</span>
        </div>
      </div>
      {children}
    </section>
  );
}

/** The project and question of an ask for what the user offers. */
function offerAskOf(incident: Incident): { projectId: number; question: string } | null {
  try {
    const d = JSON.parse(incident.detail ?? 'null') as { projectId?: unknown; question?: unknown } | null;
    return typeof d?.projectId === 'number' && typeof d.question === 'string' ? { projectId: d.projectId, question: d.question } : null;
  } catch {
    return null;
  }
}

/** Callum stopped before writing to anyone in a project: one line from the user about what they offer, and it carries on. */
function OfferAsk({ incident, state, refresh, titleId }: { incident: Incident; state: AppState; refresh(): Promise<void>; titleId: string }) {
  const toast = useToast();
  const ask = offerAskOf(incident);
  const project = ask ? state.projects.find((p) => p.id === ask.projectId) : undefined;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ask || !project) return null;
  const inputId = `inc-offer-${incident.id}`;
  const save = async () => {
    const offer = text.trim();
    if (!offer || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.updateProject(project.id, { offer });
      await refresh();
      // A bare link Callum could not read, a name, or a blank: still not enough to write from.
      if (!offerSaysEnough(saved.offer)) {
        setError(`Callum still can't say what ${project.name} does from that. Say it in a few words, like the example.`);
        return;
      }
      toast(`Thanks. Callum writes to people in ${project.name} now.`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="inc-card card-in" aria-labelledby={titleId} data-kind={incident.kind}>
      <div className="inc-head">
        <div className="inc-head-text">
          <h2 id={titleId} className="inc-title" tabIndex={-1}>{titleOf(incident, state)}</h2>
        </div>
      </div>
      <p className="inc-ask-what">{incident.message}</p>
      <form className="inc-ask" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label htmlFor={inputId} className="inc-ask-label">{ask.question}</label>
        <input
          id={inputId}
          className="inc-ask-input"
          type="text"
          value={text}
          maxLength={300}
          autoComplete="off"
          placeholder="I help founders hire engineers, or paste https://yoursite.com"
          onChange={(e) => setText(e.target.value)}
        />
        {project.offer && findPlaceholders(project.offer).length === 0 ? <p className="inc-ask-was">You said: {project.offer}</p> : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="inc-actions">
          <button type="submit" className="inc-primary" aria-busy={busy} disabled={!text.trim() || busy}>Save</button>
        </div>
      </form>
    </section>
  );
}

/** True when the channel may have sent this message before it failed (so the user is asked before it goes again). */
function mayHaveGone(item: OutboxItem): boolean {
  try {
    const d = JSON.parse(item.detail ?? 'null') as { maybeSent?: unknown; thrown?: unknown } | null;
    return d?.maybeSent === true || d?.thrown === true;
  } catch {
    return false;
  }
}

const ASK_AGAIN = 'This may have gone out already. Send again?';

/** One person on a notice about Callum's own messages: what is wrong, and the way out of it. */
function StuckRow({ item, person, refresh, onOpenPerson }: { item: OutboxItem; person: Person; refresh(): Promise<void>; onOpenPerson?: (id: number) => void }) {
  const [phase, setPhase] = useState<'idle' | 'editing' | 'asking'>('idle');
  const [text, setText] = useState(item.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await task();
      setPhase('idle');
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const blocked = item.state === 'blocked';
  return (
    <li className="inc-row">
      <Marble seed={300 + person.id} size={36} tone="warm" ring="#D9480F" />
      <div className="inc-row-main">
        <span className="inc-row-name">{person.name}</span>
        <span className="inc-row-why">
          {blocked ? (item.error ?? 'Callum stopped this message.') : mayHaveGone(item) ? "Callum couldn't confirm it went out." : (item.error ?? "It didn't go out.")}
        </span>
        {phase === 'editing' ? (
          <>
            <textarea className="inc-edit" aria-label={`Message to ${person.firstName}`} value={text} rows={5} onChange={(e) => setText(e.target.value)} />
            <div className="inc-actions">
              <button type="button" className="inc-primary" aria-busy={busy} disabled={busy || text.trim() === ''} onClick={() => void run(async () => void (await api.editBlocked(item.id, text)))}>
                Save and send
              </button>
              <button type="button" className="inc-quiet" disabled={busy} onClick={() => setPhase('idle')}>Cancel</button>
            </div>
          </>
        ) : phase === 'asking' ? (
          <>
            <p className="inc-row-ask">{ASK_AGAIN}</p>
            <div className="inc-actions">
              <button type="button" className="inc-primary" aria-busy={busy} disabled={busy} onClick={() => void run(async () => void (await api.retry(item.id, true)))}>Send again</button>
              <button type="button" className="inc-quiet" disabled={busy} onClick={() => setPhase('idle')}>Not now</button>
            </div>
          </>
        ) : (
          <div className="inc-actions">
            {blocked ? (
              <button type="button" className="inc-primary" onClick={() => { setText(item.body); setPhase('editing'); }}>Fix it</button>
            ) : (
              <button
                type="button"
                className="inc-primary"
                aria-busy={busy}
                disabled={busy}
                onClick={() => (mayHaveGone(item) ? setPhase('asking') : void run(async () => void (await api.retry(item.id))))}
              >
                Try again
              </button>
            )}
            {onOpenPerson ? <button type="button" className="inc-quiet" onClick={() => onOpenPerson(person.id)}>Open {person.firstName}</button> : null}
          </div>
        )}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </li>
  );
}

/** Callum's own messages that were stopped or did not go: one card for the channel and day, with the people on it. */
function StuckCard({ incident, state, now, titleId, refresh, onOpenPerson }: {
  incident: Incident; state: AppState; now: Date; titleId: string; refresh(): Promise<void>; onOpenPerson?: (id: number) => void;
}) {
  const ids = autoItems(incident.detail) ?? [];
  const rows = ids.flatMap((id) => {
    const item = state.outbox.find((o) => o.id === id);
    const person = item ? state.people.find((p) => p.id === item.personId) : undefined;
    return item && person && (item.state === 'blocked' || item.state === 'failed') ? [{ item, person }] : [];
  });
  return (
    <section className="inc-card card-in" aria-labelledby={titleId} data-kind="send_failed">
      <div className="inc-head">
        <ChannelBadge channel={incident.channel} paused={false} />
        <div className="inc-head-text">
          <h2 id={titleId} className="inc-title inc-title-sm" tabIndex={-1}>{incident.message}</h2>
          <span className="inc-when">{when(incident, state, now)}</span>
        </div>
      </div>
      <p className="inc-row-lead">Callum holds these people until you decide. Nobody else is held up.</p>
      <ul className="inc-rows" aria-label="People whose message did not go">
        {rows.map(({ item, person }) => (
          <StuckRow key={item.id} item={item} person={person} refresh={refresh} {...(onOpenPerson ? { onOpenPerson } : {})} />
        ))}
      </ul>
    </section>
  );
}

export interface IncidentCardProps {
  incident: Incident;
  state: AppState;
  refresh(): Promise<void>;
  /** Opens the connect sheet for the channel (`Reconnect Google` opens the email one). */
  onReconnect(channel: Channel): void;
  /** `Okay`: the notice is read and goes away on this computer. */
  onDismiss(id: number): void;
  /** LinkedIn is back on. The list keeps the card on screen a few seconds so the person can read what happens next. */
  onResumed?(incident: Incident): void;
  /** Opens a person's conversation, for a reply whose words are no longer kept here. */
  onOpenPerson?(personId: number): void;
  now?: () => Date;
}

/** What happened, what Callum did, and the one next step, for a single open incident. */
export function IncidentCard({ incident, state, refresh, onReconnect, onDismiss, onResumed, onOpenPerson, now = () => new Date() }: IncidentCardProps) {
  const toast = useToast();
  const titleId = `inc-title-${incident.id}`;
  const [phase, setPhase] = useState<Phase>('alert');
  const [pace, setPace] = useState<Pace>('half');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retried, setRetried] = useState(false);
  const waiting = waitingFor(state, incident.channel);
  const at = now();

  // Each step of the LinkedIn check is a new heading, so a screen reader is taken to it.
  const firstPhase = useRef(true);
  useEffect(() => {
    if (firstPhase.current) {
      firstPhase.current = false;
      return;
    }
    document.getElementById(titleId)?.focus();
  }, [phase, titleId]);

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- Callum needs to know what the user offers ---------------------------------------------------------------------
  if (incident.kind === 'needs_offer') return <OfferAsk incident={incident} state={state} refresh={refresh} titleId={titleId} />;

  // ---- LinkedIn wants to check it's you ------------------------------------------------------------------------------
  if (incident.kind === 'linkedin_check') {
    const waitLine = waiting.length === 0 ? 'Nobody is waiting on LinkedIn. Nothing is lost.' : `${waiting.length} ${waiting.length === 1 ? 'person waits' : 'people wait'} for LinkedIn. Nothing is lost.`;

    if (phase === 'resumed') {
      return (
        <section className="inc-card inc-card-small card-in" aria-labelledby={titleId} data-kind={incident.kind}>
          <span className="inc-status"><span className="inc-status-dot" aria-hidden="true" /><span id={titleId} tabIndex={-1}>LinkedIn is back on</span></span>
          <p className="inc-sub">
            {waiting.length > 0 ? `The ${waiting.length === 1 ? 'person' : `${waiting.length} people`} who waited go${waiting.length === 1 ? 'es' : ''} first. ` : ''}
            {pace === 'half' ? '7 invites a day for a week, then 15.' : '15 invites a day.'}
          </p>
        </section>
      );
    }

    if (phase === 'waiting') {
      return (
        <section className="inc-card card-in" aria-labelledby={titleId} data-kind={incident.kind}>
          <div className="inc-head">
            <span className="inc-badge" aria-hidden="true">
              <svg className="inc-spin" width="28" height="28" viewBox="0 0 28 28">
                <circle cx="14" cy="14" r="11" fill="none" stroke="#E7E9F0" strokeWidth="3" />
                <path d="M14 3a11 11 0 0 1 11 11" fill="none" stroke="#1D2140" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </span>
            <div className="inc-head-text">
              <h2 id={titleId} className="inc-title" tabIndex={-1}>Finish the check on LinkedIn</h2>
              <span className="inc-when">Finish the check, then come back.</span>
            </div>
          </div>
          <div className="inc-actions">
            <button type="button" className="inc-primary" onClick={() => setPhase('clear')}>Done, I've finished the check</button>
            <button type="button" className="inc-quiet" onClick={openLinkedIn}>Open LinkedIn again</button>
          </div>
        </section>
      );
    }

    if (phase === 'clear') {
      const paces: { key: Pace; name: string; sub: string; label: string; rec: boolean }[] = [
        { key: 'half', name: 'Half pace for a week', sub: '7 invites a day for a week, then back to 15', label: 'Half pace for a week (7 invites a day)', rec: true },
        { key: 'full', name: 'Full pace', sub: '15 invites a day from now', label: 'Full pace (15 a day)', rec: false },
      ];
      return (
        <section className="inc-card card-in" aria-labelledby={titleId} data-kind={incident.kind}>
          <div className="inc-head">
            <span className="inc-badge inc-badge-ink" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </span>
            <div className="inc-head-text">
              <h2 id={titleId} className="inc-title" tabIndex={-1}>All clear</h2>
              <span className="inc-when">LinkedIn is happy again. How should Callum restart?</span>
            </div>
          </div>
          <div className="inc-paces" role="radiogroup" aria-label="LinkedIn pace">
            {paces.map((p) => (
              <button key={p.key} type="button" role="radio" aria-checked={pace === p.key} aria-label={p.label} className="inc-pace" onClick={() => setPace(p.key)}>
                <span className="inc-radio" aria-hidden="true" />
                <span className="inc-pace-text"><span className="inc-pace-name">{p.name}</span><span className="inc-pace-sub">{p.sub}</span></span>
                {p.rec ? <span className="inc-rec">Recommended</span> : null}
              </button>
            ))}
          </div>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="inc-actions">
            <button
              type="button"
              className="inc-primary"
              aria-busy={busy}
              onClick={() =>
                void run(async () => {
                  await api.resumeChannel('linkedin', pace, true);
                  setPhase('resumed');
                  onResumed?.(incident);
                  toast(pace === 'half' ? 'LinkedIn is back on at half pace for a week' : 'LinkedIn is back on at full pace');
                  await refresh();
                })
              }
            >
              Resume LinkedIn
            </button>
          </div>
        </section>
      );
    }

    return (
      <Shell incident={incident} state={state} now={at} titleId={titleId} paused>
        <Lines what={incident.message} next={nextStepOf(incident)} />
        <WaitStrip people={waiting} line={waitLine} />
        <div className="inc-actions">
          <button
            type="button"
            className="inc-primary"
            onClick={() => {
              openLinkedIn();
              setPhase('waiting');
              toast('LinkedIn opened in a new tab');
            }}
          >
            Open LinkedIn
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 16L16 8M9 8h7v7" /></svg>
          </button>
        </div>
      </Shell>
    );
  }

  // ---- email (or another channel) signed out -------------------------------------------------------------------------
  if (incident.kind === 'mailbox_signed_out' || incident.kind === 'x_signed_out' || incident.kind === 'linkedin_signed_out') {
    const provider = signedOutProvider(incident);
    const label = incident.channel === 'email' ? `Reconnect ${provider ?? 'email'}` : `Reconnect ${CHANNEL_NAME[incident.channel]}`;
    const people = waitingFor(state, incident.channel);
    return (
      <Shell incident={incident} state={state} now={at} titleId={titleId} paused={false}>
        {/* The title says who signed Callum out and the strip below says who waits, so this line does neither. */}
        <Lines what={`Callum paused ${CHANNEL_NAME[incident.channel]}. Nothing was lost.`} next={nextStepOf(incident)} />
        {people.length > 0 ? <WaitStrip people={people} line={`${people.length} ${people.length === 1 ? 'person waits' : 'people wait'} for ${CHANNEL_NAME[incident.channel]}. Nothing is lost.`} /> : null}
        <div className="inc-actions">
          <button type="button" className="inc-primary" onClick={() => onReconnect(incident.channel)}>{label}</button>
        </div>
      </Shell>
    );
  }

  // ---- a channel that has stopped answering ------------------------------------------------------------------------------
  if (incident.kind === 'not_answering') {
    const name = CHANNEL_NAME[incident.channel];
    return (
      <Shell incident={incident} state={state} now={at} titleId={titleId} paused={false}>
        <Lines what={incident.message} next={nextStepOf(incident)} />
        <div className="inc-actions">
          <button type="button" className="inc-primary" onClick={() => onReconnect(incident.channel)}>Connect {name} again</button>
          <button type="button" className="inc-quiet" onClick={() => onDismiss(incident.id)}>Okay</button>
        </div>
      </Shell>
    );
  }

  // ---- a reply Callum could not read -----------------------------------------------------------------------------------
  if (incident.kind === 'reply_unread') {
    const person = state.people.find((p) => p.id === incident.personId);
    return (
      <Shell incident={incident} state={state} now={at} titleId={titleId} paused={false}>
        <Lines what={incident.message} next={nextStepOf(incident)} />
        <div className="inc-actions">
          {person && onOpenPerson ? (
            <button type="button" className="inc-primary" onClick={() => onOpenPerson(person.id)}>Open {person.firstName}'s conversation</button>
          ) : null}
          <button type="button" className={person && onOpenPerson ? 'inc-quiet' : 'inc-primary'} onClick={() => onDismiss(incident.id)}>Okay</button>
        </div>
      </Shell>
    );
  }

  // ---- Callum's own messages that did not go ---------------------------------------------------------------------------
  if (incident.kind === 'send_failed' && autoItems(incident.detail) !== null) {
    return <StuckCard incident={incident} state={state} now={at} titleId={titleId} refresh={refresh} {...(onOpenPerson ? { onOpenPerson } : {})} />;
  }

  // ---- a channel paused because Callum could not confirm its sends ------------------------------------------------------
  if (incident.kind === 'channel_paused') {
    const name = CHANNEL_NAME[incident.channel];
    return (
      <Shell incident={incident} state={state} now={at} titleId={titleId} paused>
        <Lines what={incident.message} next={nextStepOf(incident)} />
        {waiting.length > 0 ? <WaitStrip people={waiting} line={`${waiting.length} ${waiting.length === 1 ? 'person waits' : 'people wait'} for ${name}. Nothing is lost.`} /> : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="inc-actions">
          <button
            type="button"
            className="inc-primary"
            aria-busy={busy}
            onClick={() =>
              void run(async () => {
                await api.resumeChannel(incident.channel, 'full', true);
                toast(`${name.replace(/^./, (c) => c.toUpperCase())} is back on`);
                await refresh();
              })
            }
          >
            I've checked, resume {name}
          </button>
        </div>
      </Shell>
    );
  }

  // ---- a reply that did not go ---------------------------------------------------------------------------------------
  if (incident.kind === 'send_failed' && !isDeferred(incident)) {
    const outboxId = outboxIdOf(incident);
    const item: OutboxItem | undefined = state.outbox.find((o) => o.id === outboxId);
    const person = state.people.find((p) => p.id === incident.personId);
    const first = person?.firstName ?? 'them';
    return (
      <Shell incident={incident} state={state} now={at} titleId={titleId} paused={false}>
        {item ? <p className="inc-quote">{item.body}</p> : null}
        <Lines what={incident.message} next={retried ? 'Callum is sending it again.' : item ? nextStepOf(incident) : 'Try again, or open the conversation and write it again.'} />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="inc-actions">
          <button
            type="button"
            className="inc-primary"
            disabled={outboxId === null || retried}
            aria-busy={busy}
            onClick={() =>
              void run(async () => {
                if (outboxId === null) return;
                await api.retry(outboxId);
                setRetried(true);
                await refresh();
              })
            }
          >
            Try again
          </button>
          {item ? (
            <button
              type="button"
              className="inc-quiet"
              onClick={() => {
                const copied = navigator.clipboard?.writeText(item.body);
                if (!copied) {
                  setError('Callum could not reach the clipboard. Select the message above and copy it.');
                  return;
                }
                copied.then(
                  () => toast(`Copied. Paste it wherever you talk to ${first}.`),
                  () => setError('Callum could not reach the clipboard. Select the message above and copy it.'),
                );
              }}
            >
              Copy
            </button>
          ) : person && onOpenPerson ? (
            <button type="button" className="inc-quiet" onClick={() => onOpenPerson(person.id)}>
              Open {first}'s conversation
            </button>
          ) : null}
        </div>
      </Shell>
    );
  }

  // ---- told, nothing to do: bounces and daily or weekly limits ---------------------------------------------------------
  return (
    <Shell incident={incident} state={state} now={at} titleId={titleId} paused={incident.kind !== 'bounces'}>
      <Lines what={incident.message} next={nextStepOf(incident)} />
      <div className="inc-actions">
        <button type="button" className="inc-primary" onClick={() => onDismiss(incident.id)}>Okay</button>
      </div>
    </Shell>
  );
}

export interface IncidentCardsProps {
  state: AppState;
  refresh(): Promise<void>;
  onReconnect(channel: Channel): void;
  /** Opens a person's conversation (the face popover). */
  onOpenPerson?(personId: number): void;
  /** Which incidents this stack draws; the others belong to another card on the same screen. All of them when left out. */
  include?(incident: Incident): boolean;
  now?: () => Date;
}

/** One card for each open incident. Notices that only need reading go away on `Okay` and stay away on this computer. */
export function IncidentCards({ state, refresh, onReconnect, onOpenPerson, include, now }: IncidentCardsProps) {
  const [dismissed, setDismissed] = useState<Set<number>>(readDismissed);
  const [kept, setKept] = useState<Incident[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const t of live) clearTimeout(t);
    };
  }, []);

  // An ask about a project that is gone has nothing to draw, so it does not leave an empty stack behind.
  const drawable = (i: Incident) => i.kind !== 'needs_offer' || state.projects.some((p) => p.id === offerAskOf(i)?.projectId);
  const open = state.incidents.filter((i) => i.state === 'open' && !dismissed.has(i.id) && drawable(i) && (include ? include(i) : true));
  const lingering = kept.filter((k) => !open.some((o) => o.id === k.id));
  const shown = [...open, ...lingering].sort((a, b) => a.id - b.id);
  if (shown.length === 0) return null;

  return (
    <div className="inc-stack" role="region" aria-label="Needs your attention">
      {shown.map((incident) => (
        <IncidentCard
          key={incident.id}
          incident={incident}
          state={state}
          refresh={refresh}
          onReconnect={onReconnect}
          {...(now ? { now } : {})}
          {...(onOpenPerson ? { onOpenPerson } : {})}
          onDismiss={(id) => {
            const next = new Set(dismissed).add(id);
            writeDismissed(next);
            setDismissed(next);
            // Okay settles the notice on the server too. One that stays true until it is fixed comes back unchanged and stays hidden here.
            void api.dismissIncident(id).then(() => refresh(), () => undefined);
          }}
          onResumed={(done) => {
            setKept((all) => [...all.filter((k) => k.id !== done.id), done]);
            timers.current.push(setTimeout(() => setKept((all) => all.filter((k) => k.id !== done.id)), KEPT_MS));
          }}
        />
      ))}
    </div>
  );
}
