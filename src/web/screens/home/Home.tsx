/**
 * Home: where Callum lives once it is running.
 *
 * Slots for the screens that join Home (all optional; each renders nothing until the controller passes it):
 *   incident      ReactNode   Sits above the brief, in the dock column. Task 15 passes its IncidentCard here.
 *   quiet         ReactNode   Replaces the "all caught up" line when nobody waits. Task 19 passes its quiet note here.
 *   overlay       ReactNode   Drawn inside the water, under the paused banner.
 *   account       AccountSlots  Your Callum (16), Take a break or wrap up (15), the weekly note (19), Sign out (App).
 *   onAddPeople   () => void  Shows `Add people` in the top bar (Task 18).
 *   onNewProject  () => void  Shows `New project` in the project sheet (Task 18).
 *   onOpenPerson  (id) => void  Adds `See everything` to a face's card and to list rows (Task 17).
 *   dayOne        { left, onOpen }  App passes it while this project still has hellos to OK and more than one project
 *                 runs: a banner in the water, so replies are never stuck behind Day one.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppState, Channel, Person, Project } from '../../../shared/types.js';
import type { FaceReaction } from './incidentVariants.js';
import { api } from '../../api.js';
import { River } from '../../river/River.js';
import { isStill, stillChannels } from '../../river/state.js';
import { AccountMenu, type AccountSlots } from '../../ui/AccountMenu.js';
import { CrossFade } from '../../ui/CrossFade.js';
import { marbleBackground } from '../../ui/Marble.js';
import { Wordmark } from '../../ui/Wordmark.js';
import { formatSlot, joinNames } from '../../ui/format.js';
import { hourIn } from '../../ui/when.js';
import { AskBar } from './AskBar.js';
import { Brief } from './Brief.js';
import { Deck } from './Deck.js';
import { Dock, RIVER_TOP } from './Dock.js';
import { FacePopover } from './FacePopover.js';
import { ListView } from './ListView.js';
import { ProjectSwitcher } from './ProjectSwitcher.js';
import { useUndoToasts } from './UndoToast.js';
import { channelName, dockPeople, greeting, pendingSendIds, riverPeople } from './dock.js';
import './Home.css';

export interface HomeProps {
  state: AppState;
  project: Project;
  refresh: () => Promise<void>;
  /** The clock, so tests and screenshots can fix the time. */
  now?: () => Date;
  account?: AccountSlots;
  incident?: ReactNode;
  /** A function gets `ask`, which puts words in the Ask bar (a starter chip). */
  quiet?: ReactNode | ((tools: { ask(text: string): void }) => ReactNode);
  overlay?: ReactNode;
  /** How faces react to what is going on (see `faceReactions`). */
  reactions?: ReadonlyMap<number, FaceReaction>;
  onAddPeople?: () => void;
  onNewProject?: () => void;
  onOpenPerson?: (id: number) => void;
  dayOne?: { left: number; onOpen: () => void };
}

const ALL_CHANNELS: Channel[] = ['email', 'linkedin', 'x'];
const RIVER_HEIGHT = 280;
const IDLE = "You're all caught up. Callum will tap you when someone replies.";

/** `Email and LinkedIn are connected.` plus what is paused or needs a look, and where LinkedIn runs. */
function channelLine(state: AppState): string {
  const by = (status: string) => state.channels.filter((c) => c.status === status).map((c) => channelName(c.channel));
  const connected = by('connected');
  const paused = by('paused');
  const trouble = by('error');
  const parts: string[] = [];
  if (connected.length > 0) parts.push(`${joinNames(connected)} ${connected.length === 1 ? 'is' : 'are'} connected.`);
  if (paused.length > 0) parts.push(`${joinNames(paused)} ${paused.length === 1 ? 'is' : 'are'} paused.`);
  if (trouble.length > 0) parts.push(`${joinNames(trouble)} ${trouble.length === 1 ? 'needs' : 'need'} a look.`);
  if (parts.length === 0) return 'Nothing is connected yet, so nothing goes out.';
  const linkedin = state.channels.find((c) => c.channel === 'linkedin');
  if (linkedin && (linkedin.status === 'connected' || linkedin.status === 'paused')) parts.push('LinkedIn runs on this computer while Callum is open.');
  return parts.join(' ');
}

function PauseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="2" y="1" width="3.5" height="12" rx="1.5" fill="#1D2140" />
      <rect x="8.5" y="1" width="3.5" height="12" rx="1.5" fill="#1D2140" />
    </svg>
  );
}

function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3.5 1.8v10.4a.8.8 0 0 0 1.2.7l8.3-5.2a.8.8 0 0 0 0-1.4L4.7 1.1a.8.8 0 0 0-1.2.7z" fill="#1D2140" />
    </svg>
  );
}

export function Home({ state, project, refresh, now, account = {}, incident, quiet, overlay, reactions, onAddPeople, onNewProject, onOpenPerson, dayOne }: HomeProps) {
  const clock = useMemo(() => now ?? (() => new Date()), [now]);
  const toasts = useUndoToasts();
  const [view, setView] = useState<'river' | 'list'>('river');
  const [deck, setDeck] = useState<{ startAt?: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [, tick] = useState(0);
  const askInput = useRef<HTMLInputElement>(null);
  const [prefill, setPrefill] = useState<{ text: string; n: number } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  // Faces that wait on someone and snoozed people who come due change with the clock, not only with the server.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const tz = state.settings.timezone;
  const at = clock();
  const sending = pendingSendIds(state);
  const waiting = dockPeople(state);
  const mine = state.people.filter((p) => p.projectId === project.id);
  const inRiver = riverPeople(state, project.id, sending);
  const everyone = riverPeople(state, null, sending);
  const alive = mine.filter((p) => ['active', 'waiting', 'snoozed', 'held', 'resting'].includes(p.status));
  const running = state.projects.filter((p) => p.state !== 'wrapped');
  const many = running.length > 1;
  const stillAll = isStill(state, project);
  const allPaused = state.settings.pauseState !== 'running';
  const others = running.filter((p) => p.id !== project.id && p.state === 'running');
  const selectedPerson: Person | null = selected === null ? null : inRiver.find((p) => p.id === selected) ?? null;

  // Tell the person, once, about replies and accepted invitations that arrive while the screen is open.
  const seen = useRef<Map<number, { status: Person['status']; link: Person['linkedinState'] }> | null>(null);
  useEffect(() => {
    const before = seen.current;
    const next = new Map(state.people.map((p) => [p.id, { status: p.status, link: p.linkedinState }]));
    seen.current = next;
    if (!before) return;
    for (const p of state.people) {
      const was = before.get(p.id);
      if (!was) continue;
      // Coming back from a snooze is not news: the person asked for it.
      if (p.status === 'waiting' && was.status !== 'waiting' && was.status !== 'snoozed') toasts.event(`${p.firstName} replied`);
      else if (p.linkedinState === 'connected' && was.link === 'invited') toasts.event(`${p.firstName} accepted`);
    }
    // toasts is a stable controller; only the people matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.people]);

  useEffect(() => {
    if (selected === null) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [selected]);

  // A person who left the river (replied, was removed) closes their card.
  useEffect(() => {
    if (selected !== null && !selectedPerson) setSelected(null);
  }, [selected, selectedPerson]);

  // Opening the deck remembers what opened it; closing puts the cursor back there.
  const openDeck = (startAt?: number) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDeck(startAt === undefined ? {} : { startAt });
  };
  useEffect(() => {
    if (deck) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) back.focus();
    else document.querySelector<HTMLElement>('.dock-open-btn, .dock-face, .dock-more')?.focus();
  }, [deck]);

  // Closing a face's card puts the cursor back on the face.
  const lastSelected = useRef<number | null>(null);
  useEffect(() => {
    const was = lastSelected.current;
    lastSelected.current = selected;
    if (selected === null && was !== null) document.querySelector<HTMLElement>(`.river-face[data-id="${was}"]`)?.focus();
  }, [selected]);

  const notify = useCallback((text: string) => toasts.info(text), [toasts]);

  async function toggleRun() {
    try {
      if (allPaused) {
        await api.resumeAll();
        toasts.info('Callum is back to work');
      } else {
        await api.pause(null);
        toasts.info('On a break. Nothing goes out in any project until you resume.');
      }
      await refresh();
    } catch (e) {
      toasts.info(e instanceof Error ? e.message : 'Something went wrong. Callum kept everything as it was.');
    }
  }

  async function resumeHere() {
    try {
      // Both can be paused at once: resuming only one would leave the river still.
      if (allPaused) await api.resumeAll();
      if (project.state === 'paused') await api.resumeProject(project.id);
      toasts.info(`${project.name} is back to work`);
      await refresh();
    } catch (e) {
      toasts.info(e instanceof Error ? e.message : 'Something went wrong. Callum kept everything as it was.');
    }
  }

  const latestReply = [...mine]
    .filter((p) => p.repliedAt)
    .sort((a, b) => (b.repliedAt ?? '').localeCompare(a.repliedAt ?? ''))[0];

  const nextItem = state.outbox
    .filter((o) => o.state === 'scheduled' && o.origin === 'auto' && (o.kind === 'hello' || o.kind === 'invite') && mine.some((p) => p.id === o.personId))
    .sort((a, b) => a.sendAfter.localeCompare(b.sendAfter))[0];
  const nextPerson = nextItem ? mine.find((p) => p.id === nextItem.personId) : undefined;

  const pausedLine = allPaused
    ? state.settings.pausedUntil
      ? `Callum is on a break until ${formatSlot(state.settings.pausedUntil, tz, at)}.`
      : 'Callum is on a break. Nothing goes out until you resume.'
    : others.length > 0
      ? `${project.name} is paused. ${joinNames(others.map((p) => p.name))} ${others.length === 1 ? 'keeps' : 'keep'} going.`
      : `${project.name} is paused.`;

  const empty = alive.length === 0;
  const water = (
    <>
      {stillAll ? (
        <div className="home-paused">
          <span className="home-paused-text">{pausedLine}</span>
          <button type="button" className="home-paused-btn" onClick={() => void resumeHere()}>Resume</button>
        </div>
      ) : null}
      {dayOne && !stillAll ? (
        <div className="home-dayone">
          <span className="home-dayone-segs" aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => (
              <span key={i} className={i < 10 - dayOne.left ? 'is-ok' : ''} />
            ))}
          </span>
          <span className="home-dayone-line">{`${dayOne.left} of 10 hellos left to OK in ${project.name}`}</span>
          <button type="button" className="home-dayone-btn" onClick={dayOne.onOpen}>OK the hellos</button>
        </div>
      ) : null}
      {empty && !stillAll ? (
        <button type="button" className="home-empty" onClick={() => askInput.current?.focus()}>
          Your river is empty. Tell Callum who you want to meet.
        </button>
      ) : null}
      {overlay}
    </>
  );

  return (
    <main className="home" data-screen="home">
      {toasts.node}
      <div className={`home-main${deck ? ' is-dimmed' : ''}`} inert={deck !== null}>
        <header className="home-bar">
          <div className="home-brand">
            <Wordmark />
            <span className="wm-sep" aria-hidden="true">·</span>
            <ProjectSwitcher state={state} project={project} refresh={refresh} now={clock} {...(onNewProject ? { onNewProject } : {})} />
          </div>
          <div className="home-right">
            <span className="home-pill">
              <span className={`home-status ${allPaused || stillAll ? 'is-still' : 'is-running'}`} aria-hidden="true" />
              {allPaused || stillAll ? 'Paused' : 'Running'}
            </span>
            <div className="home-toggle" role="group" aria-label="How to show people">
              <button type="button" aria-pressed={view === 'river'} className={view === 'river' ? 'is-on' : ''} onClick={() => setView('river')}>River</button>
              <button type="button" aria-pressed={view === 'list'} className={view === 'list' ? 'is-on' : ''} onClick={() => setView('list')}>List</button>
            </div>
            {onAddPeople ? (
              <button type="button" className="home-add" onClick={onAddPeople}>Add people</button>
            ) : null}
            <button
              type="button"
              className="home-run"
              aria-label={allPaused ? 'Resume Callum' : many ? 'Take a break, pauses every project' : 'Take a break'}
              onClick={() => void toggleRun()}
            >
              {allPaused ? <PlayGlyph /> : <PauseGlyph />}
            </button>
            <AccountMenu slots={account} />
          </div>
        </header>
        <p className="home-channels">{channelLine(state)}</p>

        <div className={`home-stage ${view === 'list' ? 'is-list' : 'is-river'}`}>
          <Dock
            people={waiting}
            projects={state.projects}
            tz={tz}
            now={at}
            idle={IDLE}
            greeting={greeting(hourIn(at, tz))}
            quiet={typeof quiet === 'function' ? quiet({ ask: (text) => setPrefill((p) => ({ text, n: (p?.n ?? 0) + 1 })) }) : quiet}
            above={
              <>
                {incident}
                <Brief state={state} now={at} />
              </>
            }
            onOpenDeck={openDeck}
          />

          {view === 'river' ? (
            <div className="home-river" style={{ top: RIVER_TOP }}>
              <CrossFade id={project.id}>
                <River
                  people={inRiver}
                  running={!stillAll}
                  still={stillAll ? ALL_CHANNELS : stillChannels(state)}
                  height={RIVER_HEIGHT}
                  sendingIds={[...sending]}
                  selectedId={selectedPerson?.id ?? null}
                  onFace={(p) => setSelected((s) => (s === p.id ? null : p.id))}
                  onGroup={() => setView('list')}
                  {...(reactions ? { reactions } : {})}
                  popover={
                    selectedPerson ? (
                      <FacePopover
                        person={selectedPerson}
                        project={many ? project : null}
                        tz={tz}
                        now={clock}
                        notify={notify}
                        refresh={refresh}
                        onClose={() => setSelected(null)}
                        {...(onOpenPerson ? { onOpenPerson } : {})}
                      />
                    ) : null
                  }
                  overlay={water}
                />
              </CrossFade>
            </div>
          ) : (
            <ListView
              key={project.id}
              people={everyone}
              projects={state.projects}
              currentProjectId={project.id}
              tz={tz}
              now={clock}
              notify={notify}
              refresh={refresh}
              onOpenDeck={(id) => openDeck(id)}
              {...(onOpenPerson ? { onOpenPerson } : {})}
            />
          )}
        </div>

        {view === 'river' && nextPerson && nextItem ? (
          <p className="home-next">
            <span className="home-next-face" aria-hidden="true" style={{ background: marbleBackground(300 + nextPerson.id) }} />
            <span className="home-next-text">
              <span className="home-next-title">Next hello goes to {nextPerson.firstName}</span>
              <span className="home-next-sub">{formatSlot(nextItem.sendAfter, nextPerson.timezone ?? tz, at)}</span>
            </span>
          </p>
        ) : null}

        <AskBar
          project={project}
          people={state.people}
          likeName={latestReply?.firstName ?? null}
          inputRef={askInput}
          onChanged={refresh}
          prefill={prefill}
          caret={empty && !stillAll}
          {...(onAddPeople ? { onBringList: onAddPeople } : {})}
        />
      </div>

      {deck ? (
        <Deck
          people={waiting}
          projects={state.projects}
          tz={tz}
          now={clock}
          {...(deck.startAt !== undefined ? { startAt: deck.startAt } : {})}
          toasts={toasts}
          refresh={refresh}
          onClose={() => setDeck(null)}
        />
      ) : null}
    </main>
  );
}
