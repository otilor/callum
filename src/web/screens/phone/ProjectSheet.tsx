import { useEffect, useRef, useState } from 'react';
import type { AppState, Project } from '../../../shared/types.js';
import { api } from '../../api.js';
import { ErrorNote } from '../../ui/ErrorNote.js';
import { formatSlot } from '../../ui/format.js';
import { Marble } from '../../ui/Marble.js';

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

/** `18 people, 3 talking`, or `Paused until Monday at 9:00`. */
export function projectLine(project: Project, state: AppState, now: Date): string {
  if (project.state === 'paused') {
    return project.pausedUntil ? `Paused until ${formatSlot(project.pausedUntil, state.settings.timezone, now)}` : 'Paused';
  }
  const mine = state.people.filter((p) => p.projectId === project.id);
  const talking = mine.filter((p) => p.stage === 'talking' || p.status === 'waiting').length;
  return `${mine.length} ${mine.length === 1 ? 'person' : 'people'}, ${talking} talking`;
}

export interface ProjectSheetProps {
  state: AppState;
  currentId: number | null;
  refresh(): Promise<void>;
  onClose(): void;
  onNewProject?(): void;
  now: Date;
}

/** The phone's project switcher: a sheet from the bottom with one row for each project that is running or paused. */
export function ProjectSheet({ state, currentId, refresh, onClose, onNewProject, now }: ProjectSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = state.projects.filter((p) => p.state !== 'wrapped');

  useEffect(() => {
    ref.current?.focus();
  }, []);

  async function run(task: () => Promise<unknown>) {
    if (busy) return;
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

  return (
    <>
      <div className="ph-veil" aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        className="ph-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Your projects"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <span className="ph-grab" aria-hidden="true" />
        {rows.map((p) => {
          const line = projectLine(p, state, now);
          const faces = state.people.filter((x) => x.projectId === p.id).slice(0, 5);
          return (
            <div key={p.id} className="ph-prow" data-current={p.id === currentId}>
              <button
                type="button"
                className="ph-prow-main"
                aria-label={`${p.name}, ${line}`}
                aria-current={p.id === currentId ? 'true' : undefined}
                onClick={() =>
                  void run(async () => {
                    if (p.id !== currentId) await api.setCurrentProject(p.id);
                    onClose();
                  })
                }
              >
                <span className="ph-prow-faces" aria-hidden="true">
                  {faces.map((f) => (
                    <Marble key={f.id} seed={300 + f.id} size={32} tone="cool" ring={null} style={{ marginLeft: -10 }} />
                  ))}
                </span>
                <span className="ph-prow-text">
                  <span className="ph-prow-name">
                    {p.name}
                    {p.id === currentId ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22B07D" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                    ) : null}
                  </span>
                  <span className="ph-prow-line">{line}</span>
                </span>
              </button>
              <button
                type="button"
                className="ph-pill"
                aria-label={`${p.state === 'paused' ? 'Resume' : 'Pause'} ${p.name}`}
                onClick={() => void run(() => (p.state === 'paused' ? api.resumeProject(p.id) : api.pauseProject(p.id, null)))}
              >
                {p.state === 'paused' ? 'Resume' : 'Pause'}
              </button>
            </div>
          );
        })}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {onNewProject ? (
          <button
            type="button"
            className="ph-new"
            onClick={() => {
              onClose();
              onNewProject();
            }}
          >
            <span className="ph-new-disc" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </span>
            New project
          </button>
        ) : null}
      </div>
    </>
  );
}
