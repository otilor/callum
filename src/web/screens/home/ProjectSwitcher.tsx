import { useEffect, useId, useRef, useState } from 'react';
import type { AppState, Person, Project } from '../../../shared/types.js';
import { api, ApiError } from '../../api.js';
import { marbleBackground } from '../../ui/Marble.js';
import { useToast } from '../../ui/Toast.js';
import { formatSlot } from '../../ui/format.js';
import './ProjectSwitcher.css';

export interface ProjectSwitcherProps {
  state: AppState;
  /** The project being viewed. */
  project: Project;
  refresh: () => Promise<void>;
  now?: () => Date;
  /** `New project` opens the Task 18 flow. Without it the entry is not shown. */
  onNewProject?: () => void;
}

const CLOSENESS: Record<Person['stage'], number> = { talking: 0, following: 1, hello: 2, stranger: 3 };
const ALIVE: Person['status'][] = ['active', 'waiting', 'snoozed', 'held', 'resting'];

function poss(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`;
}

function errorText(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

/** Faces for one row: the people furthest along first, so the row looks like the project feels. */
function strip(people: Person[]): Person[] {
  return [...people].sort((a, b) => CLOSENESS[a.stage] - CLOSENESS[b.stage] || a.id - b.id).slice(0, 7);
}

function counts(state: AppState, p: Project) {
  const mine = state.people.filter((x) => x.projectId === p.id && ALIVE.includes(x.status));
  const talking = mine.filter((x) => x.stage === 'talking' || x.status === 'waiting').length;
  const scheduled = state.outbox.filter((o) => (o.state === 'scheduled' || o.state === 'awaiting_ok') && mine.some((x) => x.id === o.personId)).length;
  return { people: mine, n: mine.length, talking, scheduled };
}

function line(state: AppState, p: Project, now: Date): string {
  const c = counts(state, p);
  if (p.state === 'paused') {
    return p.pausedUntil ? `Paused until ${formatSlot(p.pausedUntil, state.settings.timezone, now)}` : 'Paused until you resume';
  }
  const people = `${c.n} ${c.n === 1 ? 'person' : 'people'}`;
  return c.talking > 0 ? `${people}, ${c.talking} talking` : people;
}

function download(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * The project anchor in the top bar and the sheet it opens in place: one row per project that is running or paused,
 * with a `…` menu for Pause, Wrap up and Rename, and `New project` at the bottom.
 */
export function ProjectSwitcher({ state, project, refresh, now = () => new Date(), onNewProject }: ProjectSwitcherProps) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const rows = state.projects.filter((p) => p.state !== 'wrapped');
  const alone = rows.length <= 1;

  const close = () => {
    setOpen(false);
    setMenu(null);
    setConfirm(null);
    setRenaming(null);
    setError('');
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menu !== null || confirm !== null || renaming !== null) {
        setMenu(null);
        setConfirm(null);
        setRenaming(null);
        setError('');
      } else {
        close();
        anchor.current?.focus();
      }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open, menu, confirm, renaming]);

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const pick = (p: Project) =>
    run(async () => {
      if (p.id !== project.id) {
        await api.setCurrentProject(p.id);
        await refresh();
      }
      close();
    });

  const togglePause = (p: Project) =>
    run(async () => {
      if (p.state === 'paused') {
        await api.resumeProject(p.id);
        toast(`${p.name} is running again.`);
      } else {
        await api.pauseProject(p.id, null);
        toast(`${p.name} is paused. Nothing goes out from it until you resume.`);
      }
      setMenu(null);
      await refresh();
    });

  const wrap = (p: Project, andDownload: boolean) =>
    run(async () => {
      if (andDownload) download(api.exportCsvUrl(p.id));
      await api.wrapProject(p.id);
      const other = rows.find((r) => r.id !== p.id);
      if (p.id === project.id && other) await api.setCurrentProject(other.id);
      toast(`${andDownload ? `${poss(p.name)} people are downloading. ` : ''}${p.name} is wrapped up. Its scheduled hellos are cancelled.`);
      setConfirm(null);
      await refresh();
      close();
    });

  const saveName = (p: Project) =>
    run(async () => {
      const name = draft.trim();
      if (!name) {
        setError(`A project needs a name. Callum kept “${p.name}”. Type a name to save.`);
        return;
      }
      if (rows.some((r) => r.id !== p.id && r.name.toLowerCase() === name.toLowerCase())) {
        setError(`You already have a project called ${name}. Callum kept the old name. Pick another name.`);
        return;
      }
      await api.updateProject(p.id, { name });
      toast(`Renamed to ${name}`);
      setRenaming(null);
      await refresh();
    });

  return (
    <div className="psw" ref={root}>
      <button
        ref={anchor}
        type="button"
        className={`psw-anchor${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Projects, now showing ${project.name}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="psw-name">{project.name}</span>
        <span className="psw-chev" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
        </span>
      </button>

      {open ? (
        <div className="psw-sheet panel-in" id={id} role="dialog" aria-label="Your projects">
          {rows.map((p) => {
            const c = counts(state, p);
            const faces = strip(c.people);
            const isCurrent = p.id === project.id;
            const wrapOff = alone;
            return (
              <div key={p.id} className="psw-rowwrap">
                <div className={`psw-row${isCurrent ? ' is-current' : ''}`}>
                  {renaming === p.id ? (
                    <form
                      className="psw-rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveName(p);
                      }}
                    >
                      <label htmlFor={`${id}-rn`} className="psw-label">Project name</label>
                      <div className="psw-rename-row">
                        <input id={`${id}-rn`} className="psw-input" type="text" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
                        <button type="submit" className="psw-save" disabled={busy}>Save</button>
                        <button type="button" className="psw-cancel" aria-label="Cancel rename" onClick={() => { setRenaming(null); setError(''); }}>
                          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" /></svg>
                        </button>
                      </div>
                      {error ? <p className="psw-error" role="alert">{error}</p> : null}
                    </form>
                  ) : (
                    <>
                      <button type="button" className="psw-pick" aria-current={isCurrent ? 'true' : undefined} disabled={busy} onClick={() => void pick(p)}>
                        <span className="psw-pick-name">{p.name}</span>
                        <span className="psw-strip" aria-hidden="true">
                          {faces.map((f) => (
                            <span key={f.id} style={{ background: marbleBackground(300 + f.id) }} />
                          ))}
                        </span>
                        <span className="psw-line">{line(state, p, now())}</span>
                      </button>
                      <button
                        type="button"
                        className="psw-dots"
                        aria-label={`More for ${p.name}`}
                        aria-haspopup="menu"
                        aria-expanded={menu === p.id}
                        onClick={() => {
                          setConfirm(null);
                          setMenu(menu === p.id ? null : p.id);
                        }}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="#1D2140" aria-hidden="true"><circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" /></svg>
                      </button>
                    </>
                  )}
                </div>

                {menu === p.id ? (
                  <div className="psw-menu panel-in" role="menu">
                    <button type="button" role="menuitem" className="psw-item" disabled={busy} onClick={() => void togglePause(p)}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>
                      {p.state === 'paused' ? `Resume ${p.name}` : `Pause ${p.name}`}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="psw-item"
                      aria-disabled={wrapOff}
                      onClick={() => {
                        if (wrapOff) return;
                        setMenu(null);
                        setConfirm(p.id);
                      }}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" /><path d="M10 16l-4-4 4-4M6 12h10" /></svg>
                      <span className="psw-item-text">
                        <span>Wrap up</span>
                        {wrapOff ? <span className="psw-item-hint">Callum keeps at least one project</span> : null}
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="psw-item"
                      onClick={() => {
                        setMenu(null);
                        setDraft(p.name);
                        setError('');
                        setRenaming(p.id);
                      }}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z" /></svg>
                      Rename
                    </button>
                  </div>
                ) : null}

                {confirm === p.id ? (
                  <div className="psw-confirm panel-in">
                    <p>
                      {`Wrap up ${p.name}? `}
                      {c.scheduled === 0 ? 'No hellos are scheduled. ' : `${c.scheduled} scheduled ${c.scheduled === 1 ? 'hello is' : 'hellos are'} cancelled. `}
                      {c.talking === 0 ? '' : c.talking === 1 ? '1 person you’re talking with stays in your dock. ' : `${c.talking} people you’re talking with stay in your dock. `}
                      {`Download ${poss(p.name)} people first.`}
                    </p>
                    <div className="psw-confirm-row">
                      <button type="button" className="psw-save" disabled={busy} onClick={() => void wrap(p, true)}>Download and wrap up</button>
                      <button type="button" className="psw-white" disabled={busy} onClick={() => void wrap(p, false)}>Wrap up</button>
                      <button type="button" className="psw-quiet" onClick={() => setConfirm(null)}>Keep it</button>
                    </div>
                    {error ? <p className="psw-error" role="alert">{error}</p> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {error && renaming === null && confirm === null ? <p className="psw-error psw-error-pad" role="alert">{error}</p> : null}
          {onNewProject ? (
            <button
              type="button"
              className="psw-new"
              onClick={() => {
                close();
                onNewProject();
              }}
            >
              <span className="psw-plus" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.8" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              </span>
              New project
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
