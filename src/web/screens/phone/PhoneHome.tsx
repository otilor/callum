import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { AppState, Channel, Person, Project } from '../../../shared/types.js';
import { api } from '../../api.js';
import { ErrorNote } from '../../ui/ErrorNote.js';
import { formatSlot, joinNames } from '../../ui/format.js';
import { IncidentCards } from '../home/IncidentCard.js';
import { PhoneDeck, WaitingLine, dockPeople } from './PhoneDeck.js';
import type { Notify } from './PhoneNotice.js';
import { PhoneToast, type PhoneToastData } from './PhoneToast.js';
import { PhoneSheet } from './PhoneSheet.js';
import { PhoneStages } from './PhoneRiver.js';
import { ProjectSheet } from './ProjectSheet.js';
import './Phone.css';
import './PhoneApp.css';

const UNDO_MS = 10_000;

function greeting(now: Date, tz: string): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export interface PhoneHomeProps {
  state: AppState;
  /** The project on screen. */
  project: Project | null;
  refresh(): Promise<void>;
  /** The river, already drawn for a narrow screen. PhoneHome gives it a strip as wide as the screen. */
  river: ReactNode | ((tools: { onFace(person: Person): void }) => ReactNode);
  /** The dock: the faces of the people who want to talk. */
  dock?: ReactNode;
  /** The Ask bar. On the phone it hides behind an icon and opens in a sheet. */
  ask?: ReactNode;
  /** The avatar at the top right: opens Your Callum. */
  onOpenAccount?(): void;
  /** `New project` in the project sheet. */
  onNewProject?(): void;
  /** `Reconnect Google` and its kin. */
  onReconnect(channel: Channel): void;
  /** Opens a person's conversation, for an incident about a reply that was not kept. */
  onOpenPerson?(personId: number): void;
  /** Hellos still to OK while more than one project runs: a compact banner under the brief, after the V4Phone board. */
  dayOne?: { left: number; onOpen(): void };
  now?: () => Date;
}

/** Home for a narrow screen: the project switcher, the brief, the river, and the people who want to talk as cards. */
export function PhoneHome({ state, project, refresh, river, dock, ask, onOpenAccount, onNewProject, onReconnect, onOpenPerson, dayOne, now = () => new Date() }: PhoneHomeProps) {
  const at = now();
  const tz = state.settings.timezone;
  const [sheet, setSheet] = useState<'projects' | 'ask' | null>(null);
  const [toast, setToast] = useState<PhoneToastData | null>(null);
  const nextId = useRef(1);
  const [error, setError] = useState<string | null>(null);
  /** The person whose sheet is open: a face in the river and a row under it both open it. */
  const [sheetId, setSheetId] = useState<number | null>(null);

  const notify = useCallback((t: Omit<PhoneToastData, 'id'>) => setToast({ ...t, id: nextId.current++ }), []);
  /** The person sheet speaks through `Notify`; this screen's toast takes the same words, and an Undo with its window. */
  const sheetNotify = useCallback<Notify>(
    (text, options) => notify({ text, ...(options?.undo ? { undo: { ms: options.ms ?? UNDO_MS, run: () => void options.undo?.() } } : {}) }),
    [notify],
  );
  const gone = useCallback((id: number) => setToast((cur) => (cur?.id === id ? null : cur)), []);

  const trigger = useRef<HTMLElement | null>(null);
  const openSheet = (kind: 'projects' | 'ask') => (e: React.MouseEvent<HTMLElement>) => {
    trigger.current = e.currentTarget;
    setSheet(kind);
  };

  const { brief } = state;
  const running = state.settings.pauseState === 'running';
  const waiting = dockPeople(state).length;
  const others = state.projects.filter((p) => p.state === 'running' && p.id !== project?.id);
  const projectPaused = project?.state === 'paused';
  const hasMore = state.projects.filter((p) => p.state !== 'wrapped').length > 1;
  const pills: ReactNode[] = [];
  if (brief.sentYesterday > 0) pills.push(<span key="sent" className="ph-pill-info"><i className="ph-ring-dot" aria-hidden="true" />{brief.sentYesterday} {brief.sentYesterday === 1 ? 'hello went' : 'hellos went'} out yesterday</span>);
  if (brief.acceptedRecently.length > 0) pills.push(<span key="acc" className="ph-pill-info">{joinNames(brief.acceptedRecently)} accepted</span>);
  if (brief.nextSendAt) pills.push(<span key="next" className="ph-pill-info">Next hello {formatSlot(brief.nextSendAt, tz, at)}</span>);
  if (pills.length === 0) pills.push(<span key="fine" className="ph-pill-info"><i className="ph-green-dot" aria-hidden="true" />All fine</span>);

  async function resumeProject() {
    if (!project) return;
    setError(null);
    try {
      await api.resumeProject(project.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Something went wrong. Callum kept everything as it was.');
    }
  }

  return (
    <div className="ph-root" data-screen="phone-home" data-ask={Boolean(ask)}>
      <header className="ph-top">
        <button type="button" className="ph-switch" aria-haspopup="dialog" aria-label={`Switch project, now ${project?.name ?? 'none'}`} onClick={openSheet('projects')}>
          <span className="ph-mark"><span className="ph-mark-dot" aria-hidden="true" />callum</span>
          {project ? (
            <>
              <span className="ph-sep" aria-hidden="true">·</span>
              <span className="ph-project">{project.name}</span>
            </>
          ) : null}
          {hasMore ? (
            <span className="ph-caret" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </span>
          ) : null}
        </button>
        <div className="ph-top-right">
          {running ? null : <span className="ph-status"><i className="ph-grey-dot" aria-hidden="true" />Paused</span>}
          {onOpenAccount ? (
            <button type="button" className="ph-account" aria-label="Your Callum" onClick={onOpenAccount}>
              <span className="ph-account-face" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      <main className="ph-main">
        <IncidentCards state={state} refresh={refresh} onReconnect={onReconnect} {...(onOpenPerson ? { onOpenPerson } : {})} now={now} />

        <section className="ph-brief" aria-labelledby="ph-brief-title">
          <h1 id="ph-brief-title" className="ph-hello">{greeting(at, tz)}</h1>
          <div className="ph-pills">{pills}</div>
        </section>

        {projectPaused && project ? (
          <div className="ph-paused">
            <span>{others.length > 0 ? `${project.name} is paused. ${joinNames(others.map((o) => o.name))} keeps going.` : `${project.name} is paused.`}</span>
            <button type="button" onClick={() => void resumeProject()}>Resume</button>
          </div>
        ) : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {dayOne ? (
          <div className="ph-dayone">
            <span className="ph-dayone-text">
              <span className="ph-dayone-line">{`${dayOne.left} of 10 hellos left to OK in ${project?.name ?? 'this project'}`}</span>
              <span className="ph-dayone-segs" aria-hidden="true">
                {Array.from({ length: 10 }, (_, i) => (
                  <span key={i} className={i < 10 - dayOne.left ? 'is-ok' : ''} />
                ))}
              </span>
            </span>
            <button type="button" className="ph-dayone-btn" onClick={dayOne.onOpen}>OK the hellos</button>
          </div>
        ) : null}

        <section className="ph-river" aria-label="Your river" data-still={projectPaused || !running}>
          {typeof river === 'function' ? river({ onFace: (p) => setSheetId(p.id) }) : river}
        </section>
        {dock ? <div className="ph-dock">{dock}</div> : null}

        <div className="ph-count">
          <WaitingLine count={waiting} />
        </div>
        <PhoneDeck state={state} refresh={refresh} notify={notify} now={at} />
        <PhoneStages state={state} project={project} tz={tz} now={at} notify={sheetNotify} refresh={refresh} openId={sheetId} onOpen={setSheetId} hideWant />
      </main>

      {ask ? (
        <button type="button" className="ph-ask-fab" aria-label="Ask Callum" aria-haspopup="dialog" onClick={openSheet('ask')}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V16A2.5 2.5 0 0 1 4 13.5z" /></svg>
        </button>
      ) : null}

      <PhoneToast toast={toast} onGone={gone} />

      {sheet === 'projects' ? (
        <ProjectSheet
          state={state}
          currentId={project?.id ?? null}
          refresh={refresh}
          onClose={() => setSheet(null)}
          notify={notify}
          returnTo={trigger.current}
          {...(onNewProject ? { onNewProject } : {})}
          now={at}
        />
      ) : null}
      {sheet === 'ask' && ask ? (
        <PhoneSheet label="Ask Callum" onClose={() => setSheet(null)} returnTo={trigger.current}>
          {ask}
        </PhoneSheet>
      ) : null}
    </div>
  );
}
