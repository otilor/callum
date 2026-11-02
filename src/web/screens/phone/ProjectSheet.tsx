import { useState } from 'react';
import type { AppState, Project } from '../../../shared/types.js';
import { api } from '../../api.js';
import { ErrorNote } from '../../ui/ErrorNote.js';
import { formatSlot, joinNames } from '../../ui/format.js';
import { Marble } from '../../ui/Marble.js';
import { breakChoices } from '../leave/breakDates.js';
import { PhoneSheet } from './PhoneSheet.js';
import type { PhoneToastData } from './PhoneToast.js';

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
  notify(toast: Omit<PhoneToastData, 'id'>): void;
  /** The button that opened the sheet. */
  returnTo?: HTMLElement | null;
  now: Date;
}

/** The phone's project switcher: a sheet from the bottom with one row for each project that is running or paused. */
export function ProjectSheet({ state, currentId, refresh, onClose, onNewProject, notify, returnTo, now }: ProjectSheetProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = state.projects.filter((p) => p.state !== 'wrapped');

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

  /** Pausing from the phone is a short rest: until 9:00 on the next Monday, the same as Take a break. */
  function pauseOrResume(p: Project) {
    if (p.state === 'paused') {
      return run(async () => {
        await api.resumeProject(p.id);
        notify({ text: `${p.name} is back to work` });
      });
    }
    const until = breakChoices(now, state.settings.timezone)[0]?.until ?? now;
    return run(async () => {
      await api.pauseProject(p.id, until.toISOString());
      const others = state.projects.filter((o) => o.id !== p.id && o.state === 'running');
      notify({ text: others.length > 0 ? `${p.name} is paused. ${joinNames(others.map((o) => o.name))} keeps going.` : `${p.name} is paused.` });
    });
  }

  return (
    <PhoneSheet label="Your projects" onClose={onClose} returnTo={returnTo ?? null}>
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
                onClick={() => void pauseOrResume(p)}
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
    </PhoneSheet>
  );
}
