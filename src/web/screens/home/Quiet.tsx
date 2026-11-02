import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AskAnswer, AwayPerson, Channel, Project, QuietSnapshot, ReferralCard } from '../../../shared/types.js';
import { api, ApiError, noteApi } from '../../api.js';
import { formatSlot } from '../../ui/format.js';
import { Marble } from '../../ui/Marble.js';
import { dateOnly, dayLong, daysWord, pauseChoices, plural, sinceText, timeOf } from './quietCopy.js';
import './Quiet.css';

export type QuietMoment = 'paused' | 'offline' | 'referral' | 'away' | 'empty' | 'used' | 'day2';

const BROKEN = 'Something went wrong. Callum kept everything as it was.';
const CHANNEL_NAME: Record<Channel, string> = { email: 'Email', linkedin: 'LinkedIn', x: 'X' };
const messageOf = (e: unknown): string => (e instanceof ApiError ? e.message : BROKEN);

/**
 * Which quiet moment Home shows, if any. Things that need a decision come first; the others only when no reply waits in
 * the dock, because a reply is what the person is here for.
 */
export function pickMoment(input: { quiet: QuietSnapshot | null; offline: boolean; waiting: number }): QuietMoment | null {
  const { quiet, offline, waiting } = input;
  if (quiet?.paused) return 'paused';
  if (offline) return 'offline';
  if (quiet && quiet.referrals.length > 0) return 'referral';
  if (quiet && quiet.away.length > 0) return 'away';
  if (!quiet || waiting > 0) return null;
  if (quiet.empty) return 'empty';
  if (quiet.used) return 'used';
  if (quiet.day2) return 'day2';
  return null;
}

/** Starter chips for an empty river: who the project is for, when the project says. Callum does not guess an audience for people. */
export function starterChips(project: Project | null): string[] {
  const own = project?.audience?.trim();
  return own ? [own] : [];
}

/** The blinking caret the empty river puts in the Ask bar. Place it inside the bar, beside the input, while the input is empty. */
export function AskCaret() {
  return <span className="qm-caret" aria-hidden="true" />;
}

export interface QuietProps {
  /** `GET /quiet` for the current project. Nothing shows until it has arrived. */
  quiet: QuietSnapshot | null;
  project: Project | null;
  tz: string;
  /** The server cannot be reached. */
  offline: boolean;
  /** People waiting in the dock. */
  waiting: number;
  /** Ask the server again now (the `refresh` of `useAppState`). */
  onTryNow(): void | Promise<unknown>;
  /** Something changed on the server: read the state and the quiet moments again. */
  onChanged(): void;
  /** A starter chip was picked: put it in the Ask bar. */
  onAsk?(text: string): void;
  /** Opens the add people flow. */
  onBringList?(): void;
  /** Today, for the times in the cards. */
  now?: () => Date;
  /** Show this moment whatever the data says. */
  moment?: QuietMoment;
}

function Spinner() {
  return (
    <svg className="qm-spin" width="12" height="12" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="11" fill="none" stroke="#E7E9F0" strokeWidth="4" />
      <path d="M14 3a11 11 0 0 1 11 11" fill="none" stroke="#1D2140" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

function Done({ dot, head, line, children }: { dot: string; head: string; line: string; children?: ReactNode }) {
  return (
    <div className="qm-done" role="status">
      <span className="qm-head fade-in"><i style={{ background: dot }} aria-hidden="true" />{head}</span>
      <p className="qm-body fade-in">{line}</p>
      {children}
    </div>
  );
}

// ---- the moments ---------------------------------------------------------------------------------------

function Empty({ project, onAsk, onBringList }: Pick<QuietProps, 'project' | 'onAsk' | 'onBringList'>) {
  return (
    <div className="qm-card">
      <p className="qm-big qm-hero">Your river is empty.</p>
      <p className="qm-lede">
        Tell Callum who you want to meet{onBringList ? <>, or <button type="button" className="qm-link" onClick={onBringList}>bring a list</button></> : null}.
      </p>
      {onAsk && starterChips(project).length > 0 ? (
        <div className="qm-chips" role="group" aria-label="Ways to start">
          {starterChips(project).map((text) => (
            <button key={text} type="button" className="qm-chip" onClick={() => onAsk(text)}>{text}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DayTwo({ day2, tz, now }: { day2: NonNullable<QuietSnapshot['day2']>; tz: string; now: Date }) {
  const [peek, setPeek] = useState(false);
  return (
    <div className="qm-card">
      <div className="qm-pills">
        <span className="qm-since">Since yesterday</span>
        <span className="qm-pill"><i className="qm-ring qm-ring-hello" aria-hidden="true" />{day2.sentYesterday} {plural(day2.sentYesterday, 'hello went', 'hellos went')} out</span>
      </div>
      <p className="qm-big">No replies yet, which is normal this early.</p>
      <p className="qm-lede">Callum will tap you the moment someone answers.</p>
      <div className="qm-row">
        {day2.nextAt && day2.nextCount > 0 ? (
          <span className="qm-next">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.3" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            Next: {day2.nextCount} {plural(day2.nextCount, 'hello', 'hellos')} {formatSlot(day2.nextAt, tz, now)}
          </span>
        ) : null}
        <button type="button" className="qm-soft" aria-expanded={peek} onClick={() => setPeek(!peek)}>{peek ? 'Hide' : 'See what went out'}</button>
      </div>
      {peek ? (
        <ul className="qm-peek">
          {day2.sent.map((m, i) => (
            <li key={`${m.personId}-${m.at}`} className="qm-peek-card fade-in" style={{ animationDelay: `${i * 90}ms` }}>
              <Marble seed={300 + m.personId} size={30} tone="cool" ring="#A9B8F5" />
              <div>
                <strong>{m.name}</strong>
                <span>{CHANNEL_NAME[m.channel]}, {sinceText(m.at, tz, now)}</span>
                <p>{m.text}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Used({ used, project, tz, onChanged }: { used: NonNullable<QuietSnapshot['used']>; project: Project | null; tz: string; onChanged(): void }) {
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = used.replied[0];
  const rest = used.finishing > 0 && used.finishBy
    ? ` The other ${used.finishing} finish their follow-ups by ${dayLong(used.finishBy, tz)}, then rest.`
    : '';
  const heard = used.repliedCount > 0 ? `${used.repliedCount} ${plural(used.repliedCount, 'person', 'people')} replied.` : 'Nobody has replied yet.';

  async function findMore() {
    if (!first || busy) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.ask(`Find more like ${first.first}`, project?.id));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function add(answered: AskAnswer) {
    if (!answered.action || busy) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api.act(answered.action, project?.id);
      setAdded(done.text);
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (added) {
    return <div className="qm-card"><Done dot="#22B07D" head="New people" line={added} /></div>;
  }
  return (
    <div className="qm-card">
      <p className="qm-big">Everyone in this group has heard from you.</p>
      <p className="qm-lede">{heard}{rest}</p>
      {answer ? (
        <div className="qm-answer fade-in">
          <p>{answer.text}</p>
          <div className="qm-actions">
            {answer.action ? <button type="button" className="qm-dark" disabled={busy} onClick={() => void add(answer)}>{answer.action.label}</button> : null}
            <button type="button" className="qm-light" onClick={() => setAnswer(null)}>Not now</button>
          </div>
        </div>
      ) : first ? (
        <div className="qm-row">
          <span className="qm-stack" aria-hidden="true">
            {used.replied.map((r) => <Marble key={r.id} seed={300 + r.id} size={30} tone="warm" ring="#FFB020" className="qm-stack-face" />)}
          </span>
          <button type="button" className="qm-dark" disabled={busy} onClick={() => void findMore()}>Find more like the people who replied</button>
        </div>
      ) : null}
      {error ? <p className="qm-error" role="alert">{error}</p> : null}
    </div>
  );
}

function Offline({ onTryNow }: { onTryNow: QuietProps['onTryNow'] }) {
  const [trying, setTrying] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);
  async function tryNow() {
    if (trying) return;
    setTrying(true);
    try {
      await onTryNow();
    } finally {
      if (alive.current) setTrying(false);
    }
  }
  return (
    <>
      <div className="qm-band" role="status">
        <i aria-hidden="true" />
        <span>Callum can't be reached right now. It keeps trying.</span>
        <button type="button" onClick={() => void tryNow()}>{trying ? <Spinner /> : null}{trying ? 'Trying' : 'Try now'}</button>
      </div>
      <div className="qm-card">
        <p className="qm-big">What you see here may be a little behind.</p>
        <p className="qm-lede">Callum catches up as soon as it can be reached.</p>
      </div>
    </>
  );
}

function awayTitle(a: AwayPerson): string {
  return a.until ? `${a.first} is away until ${dateOnly(a.until)}.` : `${a.first} is away.`;
}

function Away({ people, tz, now, onChanged }: { people: AwayPerson[]; tz: string; now: Date; onChanged(): void }) {
  const [settled, setSettled] = useState<Record<number, 'ok' | 'real'>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = people.filter((p) => !settled[p.personId]);
  const shown = open[0] ?? people[0];
  if (!shown) return null;
  const state = settled[shown.personId];
  const when = shown.followUpAt ? `${dayLong(shown.followUpAt, tz)} at ${timeOf(shown.followUpAt, tz)}` : null;

  async function okay() {
    if (busy || !shown) return;
    setBusy(true);
    setError(null);
    try {
      await noteApi.awaySeen(shown.personId);
      setSettled({ ...settled, [shown.personId]: 'ok' });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function real() {
    if (busy || !shown) return;
    setBusy(true);
    setError(null);
    try {
      await noteApi.realReply(shown.personId);
      setSettled({ ...settled, [shown.personId]: 'real' });
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qm-card">
      <div className="qm-who">
        <span className="qm-away-face" role="img" aria-label={`${shown.name}${shown.company ? `, ${shown.company}` : ''}, away`}>
          <Marble seed={300 + shown.personId} size={60} tone="grey" ring={state === 'real' ? '#FFB020' : '#D5D9E4'} />
          <i aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round"><path d="M3 8a3 3 0 0 1 6 0M1.5 10h9M6 2.2v1.3M2.4 4.2l.9.9M9.6 4.2l-.9.9" /></svg>
          </i>
        </span>
        <div>
          <p className="qm-big qm-big-tight">{state === 'real' ? `${shown.first} wrote back.` : awayTitle(shown)}</p>
          {shown.projectName ? <span className="qm-tag">{shown.projectName}</span> : null}
        </div>
      </div>
      {!state ? (
        <>
          {when ? <p className="qm-lede">Callum will wait and follow up on {when}.</p> : <p className="qm-lede">Callum will wait for {shown.first} and follow up later.</p>}
          <div className="qm-bubble">
            <p>{shown.text}</p>
            <span>Auto-reply from {shown.name}{shown.company ? `, ${shown.company}` : ''}, {sinceText(shown.at, tz, now)}</span>
          </div>
          <div className="qm-actions">
            <button type="button" className="qm-dark" disabled={busy} onClick={() => void okay()}>Okay</button>
            <button type="button" className="qm-light" disabled={busy} onClick={() => void real()}>It's a real reply</button>
          </div>
          {error ? <p className="qm-error" role="alert">{error}</p> : null}
        </>
      ) : state === 'ok' ? (
        <Done dot="#C5CAD6" head={`${shown.first} rests until they are back`} line={when ? `Callum holds ${shown.first}'s follow-up until ${when}.` : `Callum holds ${shown.first}'s follow-up.`} />
      ) : (
        <Done dot="#FFB020" head={`${shown.first} moved to your replies`} line={`Callum drafted an answer to ${shown.first}'s message. It waits for you.`} />
      )}
      {open.length > 1 ? <p className="qm-more">and {open.length - 1} more {plural(open.length - 1, 'person is', 'people are')} away</p> : null}
    </div>
  );
}

type ReferralPhase = { kind: 'idle' } | { kind: 'sending' } | { kind: 'pending'; outboxId: number } | { kind: 'sent' } | { kind: 'later' };

function Referral({ card, onChanged, onPhase }: { card: ReferralCard; onChanged(): void; onPhase(phase: ReferralPhase['kind'], card: ReferralCard): void }) {
  const [draft, setDraft] = useState(card.draft);
  const [phase, setPhase] = useState<ReferralPhase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pendingTimer.current), []);
  // Once the hello is sent the card no longer comes from the server, so Quiet keeps it on screen until the person is done with it.
  useEffect(() => onPhase(phase.kind, card), [phase.kind, card, onPhase]);

  const said = card.referrer
    ? card.context ? `${card.referrer.first} said ${card.first} ${card.context}.` : `${card.referrer.first} pointed to ${card.name}.`
    : `A reply pointed to ${card.name}.`;

  async function send() {
    if (phase.kind === 'sending') return;
    setError(null);
    setPhase({ kind: 'sending' });
    try {
      const item = await noteApi.referralHello(card.personId, draft, card.subject);
      setPhase({ kind: 'pending', outboxId: item.id });
      onChanged();
      // The undo window is 10 seconds: after it the hello is on its way.
      pendingTimer.current = setTimeout(() => setPhase({ kind: 'sent' }), 10_000);
    } catch (e) {
      setError(messageOf(e));
      setPhase({ kind: 'idle' });
    }
  }
  async function undo(outboxId: number) {
    clearTimeout(pendingTimer.current);
    try {
      await api.undo(outboxId);
      setPhase({ kind: 'idle' });
      onChanged();
    } catch (e) {
      setError(messageOf(e));
      setPhase({ kind: 'sent' });
    }
  }

  return (
    <section className="qm-card qm-referral" aria-label={`${card.name}, warm introduction`}>
      <div className="qm-who">
        <Marble seed={300 + card.personId} size={52} tone="cool" ring="#A9B8F5" />
        <div>
          <p className="qm-title"><strong>{card.name}</strong><span className="qm-tag">Warm intro</span>{card.projectName ? <span className="qm-tag">{card.projectName}</span> : null}</p>
          <p className="qm-said">{said}</p>
        </div>
      </div>
      {phase.kind === 'idle' || phase.kind === 'sending' ? (
        <>
          <label htmlFor={`qm-draft-${card.personId}`} className="qm-label"><i aria-hidden="true" />Hello to {card.first}, drafted by Callum</label>
          <textarea id={`qm-draft-${card.personId}`} className="qm-draft" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="qm-actions">
            <button type="button" className="qm-dark" disabled={phase.kind === 'sending'} onClick={() => void send()}>Send to {card.first}</button>
            <button type="button" className="qm-light" onClick={() => setPhase({ kind: 'later' })}>Later</button>
            {card.channel ? <span className="qm-hint">By {card.channel === 'email' ? 'email' : card.channel === 'x' ? 'X' : 'LinkedIn'}</span> : null}
          </div>
          {error ? <p className="qm-error" role="alert">{error}</p> : null}
        </>
      ) : null}
      {phase.kind === 'pending' ? (
        <div className="qm-done" role="status">
          <p className="qm-body fade-in">Your hello to {card.first} leaves in a few seconds. Undo if you want to change it.</p>
          <div className="qm-actions"><button type="button" className="qm-light" onClick={() => void undo(phase.outboxId)}>Undo</button></div>
        </div>
      ) : null}
      {phase.kind === 'sent' ? <Done dot="#22B07D" head="Sent" line={`${card.first} is in the river now.`} /> : null}
      {phase.kind === 'later' ? (
        <Done dot="#C5CAD6" head="Saved for later" line={`Callum writes to ${card.first} tomorrow if you don't.`}>
          <div className="qm-actions"><button type="button" className="qm-light" onClick={() => setPhase({ kind: 'idle' })}>Write it now</button></div>
        </Done>
      ) : null}
    </section>
  );
}

function Paused({ paused, tz, now, onChanged }: { paused: NonNullable<QuietSnapshot['paused']>; tz: string; now: Date; onChanged(): void }) {
  const [pick, setPick] = useState(false);
  const [done, setDone] = useState<{ head: string; line: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = pauseChoices(now, tz);

  async function run(work: () => Promise<unknown>, result: { head: string; line: string }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      setDone(result);
      setPick(false);
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) return <div className="qm-card"><Done dot="#22B07D" head={done.head} line={done.line} /></div>;
  const waiting = [
    paused.hellos > 0 ? `${paused.hellos} ${plural(paused.hellos, 'hello', 'hellos')}` : null,
    paused.followUps > 0 ? `${paused.followUps} ${plural(paused.followUps, 'follow-up', 'follow-ups')}` : null,
  ].filter((x): x is string => x !== null);
  return (
    <div className="qm-card">
      <span className="qm-since"><i className="qm-ring qm-ring-idle" aria-hidden="true" />Paused since {sinceText(paused.since, tz, now)}</span>
      <p className="qm-big">Callum has been paused for {daysWord(paused.days)}. Resume, or pick a date?</p>
      {!pick && waiting.length > 0 ? <p className="qm-lede">{waiting.join(' and ')} {waiting.length === 1 && paused.hellos + paused.followUps === 1 ? 'is' : 'are'} waiting. Replies still reach you.</p> : null}
      <div className="qm-actions">
        <button type="button" className="qm-dark" disabled={busy} onClick={() => void run(() => api.resumeAll(), { head: 'Running again', line: 'Callum is running again. What was waiting goes out at the usual pace, from the next sending hours.' })}>Resume</button>
        <button type="button" className="qm-light" aria-expanded={pick} onClick={() => setPick(!pick)}>Pick a date</button>
      </div>
      {pick ? (
        <div className="qm-chips fade-in" role="group" aria-label="Stay paused until">
          <span className="qm-since">Until</span>
          {choices.map((c) => (
            <button key={c.iso} type="button" className="qm-chip" disabled={busy} onClick={() => void run(() => api.pause(c.iso), { head: `Paused until ${c.label}`, line: `Callum starts again on ${c.label} at 9:00. Replies still reach you, and you can resume any time.` })}>{c.label}</button>
          ))}
        </div>
      ) : null}
      {error ? <p className="qm-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** The quiet moments of Home: what Callum says when there is nothing to do, or one small thing to decide. */
export function Quiet(props: QuietProps) {
  const { quiet, project, tz, offline, waiting, onTryNow, onChanged, onAsk, onBringList } = props;
  const now = (props.now ?? (() => new Date()))();
  const [sticky, setSticky] = useState<ReferralCard | null>(null);
  const stickyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(stickyTimer.current), []);

  const card = sticky ?? quiet?.referrals[0] ?? null;
  const moment = props.moment ?? (sticky ? 'referral' : pickMoment({ quiet, offline, waiting }));
  const onPhase = useCallback((kind: ReferralPhase['kind'], shown: ReferralCard) => {
    clearTimeout(stickyTimer.current);
    // Idle or sending: nothing to hold on to yet, and after an undo the card that is already held stays until the server lists it again.
    if (kind === 'idle' || kind === 'sending') return;
    setSticky(shown);
    // A hello that has gone and been seen makes room for the next card after a few seconds.
    if (kind === 'sent' || kind === 'later') stickyTimer.current = setTimeout(() => setSticky(null), 8000);
  }, []);
  if (!moment) return null;
  return (
    <div className="qm" data-moment={moment}>
      {moment === 'paused' && quiet?.paused ? <Paused paused={quiet.paused} tz={tz} now={now} onChanged={onChanged} /> : null}
      {moment === 'offline' ? <Offline onTryNow={onTryNow} /> : null}
      {moment === 'referral' && card ? <Referral key={card.personId} card={card} onChanged={onChanged} onPhase={onPhase} /> : null}
      {moment === 'away' && quiet ? <Away people={quiet.away} tz={tz} now={now} onChanged={onChanged} /> : null}
      {moment === 'empty' ? <Empty project={project} onAsk={onAsk} onBringList={onBringList} /> : null}
      {moment === 'used' && quiet?.used ? <Used used={quiet.used} project={project} tz={tz} onChanged={onChanged} /> : null}
      {moment === 'day2' && quiet?.day2 ? <DayTwo day2={quiet.day2} tz={tz} now={now} /> : null}
    </div>
  );
}
