import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AppState, Channel, Correction, OutboxItem, Person, PersonFull, PersonPathStep, Stage } from '../../../shared/types.js';
import { api, ApiError } from '../../api.js';
import { formatSlot } from '../../ui/format.js';
import { lookForStage, Marble } from '../../ui/Marble.js';
import { useToast } from '../../ui/Toast.js';
import { useHeadingFocus } from '../../ui/useHeadingFocus.js';
import { Wordmark } from '../../ui/Wordmark.js';
import { Actions } from './Actions.js';
import { Thread, type PendingSend } from './Thread.js';
import { CHANNEL_NAME, dayLong, LAST_MESSAGE, sentence, whenShort } from './when.js';
import './PersonView.css';

const BROKEN = 'Something went wrong. Callum kept everything as it was.';
const UNDO_MS = 10_000;
const STRIP_SIZE = 8;

const messageOf = (e: unknown): string => (e instanceof ApiError && e.message ? e.message : BROKEN);

export interface PersonViewProps {
  state: AppState;
  personId: number;
  /** Another person was picked from the strip or found by name. */
  onOpen(personId: number): void;
  /** Back to the river. */
  onBack(): void;
  /** The time the page works from; the clock when left out. */
  now?: () => Date;
  /** Shown in a sheet over Home: Home keeps the header, and the river under the sheet is how you pick someone else. */
  embedded?: boolean;
}

// ---- how a person looks ---------------------------------------------------------------------------------

const STAGE_WORD: Record<Stage, string> = { stranger: 'Stranger', hello: 'Said hello', following: 'Following up', talking: 'Talking' };

/** Waiting and snoozed people have written back, so they are talking as far as the way to you goes. */
const effectiveStage = (p: Person): Stage => (p.status === 'waiting' || p.status === 'snoozed' ? 'talking' : p.stage);
const quiet = (p: Person): boolean => p.status === 'stopped' || p.status === 'resting' || p.status === 'closed' || p.status === 'removed';

function faceStyle(p: Person, size: number, selected: boolean) {
  const look = lookForStage(effectiveStage(p));
  const ring = quiet(p) ? '#E7E9F0' : p.status === 'held' ? '#E7E9F0' : look.ring;
  const spread = size > 60 ? 5 : 1.5;
  const filter = quiet(p) ? 'grayscale(1) brightness(1.08)' : p.status === 'held' ? 'grayscale(1)' : undefined;
  const opacity = p.status === 'stopped' ? 0.55 : p.status === 'resting' || p.status === 'closed' ? 0.7 : p.status === 'held' ? 0.7 : 1;
  const booked = p.badge === 'booked' && p.status !== 'stopped';
  return {
    tone: quiet(p) ? ('grey' as const) : look.tone,
    ring: null,
    style: {
      ...(filter ? { filter } : {}),
      opacity,
      boxShadow: selected
        ? '0 0 0 3px #3F52D9'
        : `0 0 0 ${spread}px ${booked ? '#FFB020' : ring}${booked && size > 60 ? ', 0 18px 36px -14px rgba(255,176,32,0.7)' : ''}`,
    },
  };
}

function stageChip(p: Person, tz: string): { word: string; dot: string } {
  if (p.status === 'stopped') return { word: 'Stopped', dot: '#D9480F' };
  if (p.status === 'closed') return { word: 'Closed', dot: '#C5CAD6' };
  if (p.status === 'resting') return { word: p.restUntil ? `Resting until ${dayLong(p.restUntil, tz)}` : 'Resting', dot: '#C5CAD6' };
  if (p.status === 'held') return { word: 'On hold', dot: '#C5CAD6' };
  const stage = effectiveStage(p);
  return { word: STAGE_WORD[stage], dot: lookForStage(stage).ring };
}

function channelChip(p: Person): string {
  if (p.channel === 'email') return p.email ?? 'Email';
  if (p.channel === 'linkedin') return 'LinkedIn';
  if (p.channel === 'x') return p.xHandle ? `X · @${p.xHandle}` : 'X';
  return 'No channel yet';
}

// ---- the page --------------------------------------------------------------------------------------------

export function PersonView({ state, personId, onOpen, onBack, now = () => new Date(), embedded = false }: PersonViewProps) {
  const [q, setQ] = useState('');
  const tz = state.settings.timezone;
  const query = q.trim().toLowerCase();

  const people = state.people.filter((p) => p.status !== 'removed');
  const matches = query
    ? people.filter((p) => `${p.name} ${p.company ?? ''}`.toLowerCase().includes(query))
    : [...people].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let shown = matches.slice(0, STRIP_SIZE);
  if (!query && !shown.some((p) => p.id === personId)) {
    const current = people.find((p) => p.id === personId);
    if (current) shown = [...shown.slice(0, STRIP_SIZE - 1), current];
  }
  const more = Math.max(0, matches.length - STRIP_SIZE);

  const open = (id: number) => {
    setQ('');
    onOpen(id);
  };
  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = shown[0];
      if (first) open(first.id);
    } else if (e.key === 'Escape' && q) {
      // Clearing the search is all Escape does here; with nothing typed it closes the sheet.
      e.preventDefault();
      setQ('');
    }
  };

  const here = state.people.find((p) => p.id === personId);
  const running = state.settings.pauseState;

  return (
    <main className={`pv${embedded ? ' is-embedded' : ''}`} data-screen="person">
      {embedded ? null : <header className="pv-bar">
        <Wordmark project={state.projects.find((p) => p.id === here?.projectId)?.name ?? null} />
        <div className="pv-bar-end">
          <span className="pv-chip pv-hide-narrow">
            <span className="pv-dot" style={{ background: running === 'running' ? 'var(--green)' : 'var(--tick)' }} aria-hidden="true" />
            {running === 'running' ? 'Running' : running === 'paused' ? 'Paused' : 'Wrapped up'}
          </span>
          <button type="button" className="pv-back" aria-label="Back to the river" onClick={onBack}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            River
          </button>
        </div>
      </header>}

      <div className="pv-find-row">
        <div className="pv-find">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#646B85" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4 4" />
          </svg>
          <label className="sr-only" htmlFor="pv-find">Find someone</label>
          <input id="pv-find" type="text" value={q} placeholder="Find someone" autoComplete="off" onChange={(e) => setQ(e.target.value)} onKeyDown={onFindKey} />
          {q ? (
            <button type="button" className="pv-clear" aria-label="Clear" onClick={() => setQ('')}>
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>
          ) : null}
        </div>
        {embedded && !query ? null : <div className="pv-strip" role="list" aria-label={query ? `People matching ${q.trim()}` : 'Recently'}>
          {shown.map((p) => {
            const look = faceStyle(p, 42, p.id === personId);
            return (
              <div className="pv-face-item" role="listitem" key={p.id}>
                <button type="button" className="pv-peek" aria-label={`${p.name}${p.company ? `, ${p.company}` : ''}`} aria-pressed={p.id === personId} onClick={() => open(p.id)}>
                  <Marble seed={300 + p.id} size={42} tone={look.tone} ring={look.ring} style={{ display: 'block', width: '100%', height: '100%', ...look.style }} />
                </button>
                <span className="pv-face-name" data-on={p.id === personId ? 'true' : undefined}>{p.firstName}</span>
              </div>
            );
          })}
          {more > 0 ? <span className="pv-more">and {more} more</span> : null}
        </div>}
        {query && matches.length === 0 ? <p className="pv-nomatch fade-in" role="status">Nobody called '{q.trim()}' in your river.</p> : null}
      </div>

      <Pane key={personId} state={state} personId={personId} tz={tz} now={now} onBack={onBack} />
    </main>
  );
}

// ---- one person ----------------------------------------------------------------------------------------------

function Pane({ state, personId, tz, now, onBack }: { state: AppState; personId: number; tz: string; now: () => Date; onBack(): void }) {
  const toast = useToast();
  const [detail, setDetail] = useState<PersonFull | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [local, setLocal] = useState<(PendingSend & { createdAt: string }) | null>(null);
  const asked = useRef(0);
  // The cursor goes to the name once the page has loaded, and stays put while it refreshes.
  const headingRef = useHeadingFocus(detail === null, detail !== null);

  const load = useCallback(async (): Promise<PersonFull | null> => {
    const ticket = ++asked.current;
    try {
      const next = await api.personFull(personId);
      if (ticket === asked.current) {
        setDetail(next);
        setLoadError(null);
      }
      return next;
    } catch (e) {
      if (ticket === asked.current) setLoadError(messageOf(e));
      return null;
    }
  }, [personId]);

  // Fetch again whenever the live state moves, so a reply or a send shows up by itself.
  useEffect(() => {
    void load();
  }, [load, state]);

  // A message that has left its 10 seconds is in the thread by now; stop showing the waiting copy.
  useEffect(() => {
    if (!local) return;
    const timer = setTimeout(() => setLocal(null), UNDO_MS + 1500);
    return () => clearTimeout(timer);
  }, [local]);

  if (!detail) {
    return (
      <div className="pv-cols">
        <section className="pv-left" aria-label="Person">
          {loadError ? (
            <>
              <p className="pv-error" role="alert">{loadError}</p>
              <button type="button" className="pv-act" data-primary="true" onClick={onBack}>Go back to the river</button>
            </>
          ) : (
            <p className="pv-quiet" role="status">Callum is opening this page</p>
          )}
        </section>
      </div>
    );
  }

  const { person } = detail;
  const first = person.firstName;
  const at = now();

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const nudge = () => run(async () => {
    await api.nudge(person.id);
    const fresh = await load();
    toast(fresh?.next ? sentence(fresh.next) : 'Nudged.');
  });
  const hold = () => run(async () => {
    await api.hold(person.id);
    await load();
    toast(`Holding ${first}. Nothing goes out until you resume.`);
  });
  const resume = () => run(async () => {
    await api.resume(person.id);
    const fresh = await load();
    toast(fresh?.next ? `${first} is back in the river. ${sentence(fresh.next)}` : `${first} is back in the river.`);
  });
  const never = () => run(async () => {
    await api.correct(person.id, 'never_contact');
    await load();
    toast(`${first} won't hear from Callum again.`);
  });
  const wake = () => run(async () => {
    const woke = await api.wake(person.id);
    await load();
    toast(woke.next ? `${first} is back. ${sentence(woke.next)}` : `${first} is back.`, {
      ms: UNDO_MS,
      action: {
        label: 'Undo',
        onAction: () => {
          void api.rest(person.id).then(
            async () => {
              await load();
              toast(`Undone. ${first} keeps resting.`);
            },
            (e: unknown) => toast(messageOf(e)),
          );
        },
      },
    });
  });
  const moveChannel = async (channel: Channel, handle?: string): Promise<string | null> => {
    if (busy) return 'Callum is still finishing the last thing. Try again in a moment.';
    setBusy(true);
    try {
      const old = person.channel;
      const moved = await api.switchChannel(person.id, channel, handle);
      await load();
      const gap = person.lastTouchAt !== null && new Date(person.lastTouchAt).getTime() + 7 * 86_400_000 > at.getTime();
      const when = moved.nextTouchAt ? ` The first message goes ${formatSlot(moved.nextTouchAt, tz, now())}${gap && old ? `, a week after the last ${LAST_MESSAGE[old]}` : ''}.` : '';
      toast(`${first} moves to ${CHANNEL_NAME[channel]}.${when}`);
      return null;
    } catch (e) {
      return messageOf(e);
    } finally {
      setBusy(false);
    }
  };
  const moveProject = (projectId: number) => run(async () => {
    await api.moveToProject(person.id, projectId);
    await load();
    toast(`${first} moves to ${state.projects.find((p) => p.id === projectId)?.name ?? 'the other project'}.`);
  });
  const correct = (kind: Extract<Correction, 'auto_reply' | 'wrong_person'>) => run(async () => {
    await api.correct(person.id, kind);
    if (kind === 'wrong_person') {
      toast(`Got it. Callum takes ${first} out of the river and learns from it.`);
      onBack();
      return;
    }
    await load();
    toast('Got it. Callum treats that as an auto-reply and learns from it.');
  });

  const send = async () => {
    const text = draft.trim();
    if (!text || writing) return;
    setWriting(true);
    setWriteError(null);
    try {
      const item = await api.reply(person.id, text);
      setDraft('');
      setLocal({ id: item.id, text, undoUntil: item.undoUntil, createdAt: item.createdAt });
      toast(`Your note to ${first} goes in 10 seconds`, {
        ms: UNDO_MS,
        action: {
          label: 'Undo',
          onAction: () => {
            void api.undo(item.id).then(
              () => {
                setLocal(null);
                setDraft(text);
                toast('Undone. Your note is back in the box.');
              },
              (e: unknown) => toast(messageOf(e)),
            );
          },
        },
      });
    } catch (e) {
      setWriteError(messageOf(e));
    } finally {
      setWriting(false);
    }
  };

  // Notes still inside their 10 seconds: the ones the state knows of, and the one just sent (until the thread shows it).
  const queued: OutboxItem[] = state.outbox.filter((i) => i.personId === person.id && i.origin === 'user' && i.state === 'scheduled');
  const pending: PendingSend[] = queued.map((i) => ({ id: i.id, text: i.body, undoUntil: i.undoUntil }));
  if (local && !queued.some((i) => i.id === local.id) && !detail.messages.some((m) => m.direction === 'out' && m.at >= local.createdAt && m.body === local.text)) {
    pending.push(local);
  }

  const chip = stageChip(person, tz);
  const look = faceStyle(person, 112, false);
  const canWrite = person.status === 'waiting' || (person.status === 'active' && person.stage === 'talking');
  // Corrections are for a reply that is still waiting on the dock.
  const canCorrect = person.replyKind !== null && person.status === 'waiting';

  return (
    <div className="pv-cols">
      <section className="pv-left pv-swap" aria-label={person.name}>
        <div className="pv-who">
          <span className="pv-big">
            <Marble seed={300 + person.id} size={112} tone={look.tone} ring={look.ring} className="pv-big-face" style={{ border: '3px solid #FFFFFF', ...look.style }} />
            {person.badge === 'booked' && person.status !== 'stopped' ? (
              <span className="pv-badge" data-kind="booked" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M3.5 10h17" /></svg>
              </span>
            ) : null}
            {person.status === 'held' ? (
              <span className="pv-badge" data-kind="held" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 14 14"><rect x="2.5" y="2" width="3" height="10" rx="1.2" fill="#FFFFFF" /><rect x="8.5" y="2" width="3" height="10" rx="1.2" fill="#FFFFFF" /></svg>
              </span>
            ) : null}
          </span>
          <div className="pv-names">
            <h1 ref={headingRef} tabIndex={-1}>{person.name}</h1>
            <span className="pv-sub">{[person.role, person.company].filter(Boolean).join(' at ')}</span>
          </div>
        </div>

        <div className="pv-chips">
          <span className="pv-chip"><span className="pv-dot" style={chip.dot === '#D5D9E4' ? { border: '2px solid #C5CAD6' } : { background: chip.dot }} aria-hidden="true" />{chip.word}</span>
          <span className="pv-chip">{channelChip(person)}</span>
          {detail.projectName ? <span className="pv-chip" data-testid="project-chip">{detail.projectName}</span> : null}
        </div>

        <ol className="pv-path" aria-label="The path so far">
          {detail.path.map((step, i) => (
            <PathRow key={`${step.label}${i}`} step={step} last={i === detail.path.length - 1} tz={tz} now={at} />
          ))}
        </ol>

        <div className="pv-next">
          {detail.next ? (
            <p className="pv-next-line">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
              <span>{detail.next}</span>
            </p>
          ) : null}
          {detail.why ? <p className="pv-why">{detail.why}</p> : null}
        </div>

        <Actions
          key={`${person.id}-${person.status}`}
          detail={detail}
          busy={busy}
          onNudge={nudge}
          onHold={hold}
          onResume={resume}
          onWake={wake}
          onMoveChannel={moveChannel}
          onMoveProject={moveProject}
          onNever={never}
        />
      </section>

      <Thread
        detail={detail}
        tz={tz}
        now={at}
        pending={pending}
        senderEmail={state.settings.senderEmail}
        canCorrect={canCorrect}
        onCorrect={correct}
        canWrite={canWrite}
        draft={draft}
        onDraft={setDraft}
        onSend={send}
        writing={writing}
        writeError={writeError}
      />
    </div>
  );
}

function PathRow({ step, last, tz, now }: { step: PersonPathStep; last: boolean; tz: string; now: Date }) {
  const day = step.state === 'rest' && step.at ? `until ${dayLong(step.at, tz)}` : step.at ? whenShort(step.at, tz, now) : '';
  return (
    <li className="pv-step" data-state={step.state}>
      <span className="pv-rail" aria-hidden="true">
        {last ? null : <span className="pv-line" data-done={step.state === 'done' || step.state === 'sun' ? 'true' : undefined} />}
        <span className="pv-pin" />
      </span>
      <span className="pv-step-text">
        <span className="pv-step-label">{step.label}</span>
        <span className="pv-quiet">{day}</span>
      </span>
    </li>
  );
}
