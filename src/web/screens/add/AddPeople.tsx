import { useState } from 'react';
import type { AddCommit, Person, Project } from '../../../shared/types.js';
import { peopleApi } from '../../api.js';
import { useToast } from '../../ui/Toast.js';
import { useHeadingFocus } from '../../ui/useHeadingFocus.js';
import { Wordmark } from '../../ui/Wordmark.js';
import { messageOf, useWhoFinder, type Way } from './useWhoFinder.js';
import { River } from './River.js';
import { AlertLine, WhoPanel } from './WhoPanel.js';
import { firstHelloWords, firstOf } from './words.js';
import './AddPeople.css';

export interface AddPeopleProps {
  project: Project;
  /** The people of this project, for the river under the sheet. */
  people: Person[];
  /** The user's time zone, to say when the first hellos can go out. */
  timezone: string;
  onClose(): void;
  now?: () => Date;
}

const AGAIN: Record<Way, string> = { csv: 'Choose another file', paste: 'Paste again', link: 'Use another link', describe: 'Describe again' };
/** How long the Undo stays on the toast. */
export const UNDO_MS = 10000;

function sentences(line: string): { title: string; rest: string } {
  const [first = '', ...more] = line.split('. ');
  const rest = more.join('. ').replace(/^First hellos from (.+?)\./, 'First hellos go out from $1, within your daily limits.');
  return { title: first.endsWith('.') ? first : `${first}.`, rest };
}

/** Add people to a project that is already running: four ways in, a preview of who joins and who is skipped, then Add. */
export function AddPeople({ project, people, timezone, onClose, now = () => new Date() }: AddPeopleProps) {
  const toast = useToast();
  const headingRef = useHeadingFocus();
  const finder = useWhoFinder(project.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<AddCommit | null>(null);
  const [joined, setJoined] = useState<Person[]>([]);

  const undo = async (batchId: string, brought: Person[]) => {
    try {
      await peopleApi.undo(batchId);
    } catch (e) {
      toast(messageOf(e));
      return;
    }
    const gone = new Set(brought.map((p) => p.id));
    setJoined((all) => all.filter((p) => !gone.has(p.id)));
    setDone(null);
    toast('Undone. Nobody was added.');
    // People Claude found are shown again as they were; searching again would take minutes and find others.
    if (!finder.found?.web) await finder.rerun();
  };

  const add = async () => {
    const found = finder.found;
    if (!found || busy || finder.kept.length === 0) return;
    setBusy(true);
    setError('');
    finder.settle();
    try {
      // From a live search, only the people on screen: others found since are not added unseen.
      const result = await peopleApi.commit({ batchId: found.batchId, projectId: project.id, drop: finder.dropped, ...(found.web ? { only: found.people.map((p) => p.key) } : {}) });
      const brought = result.added;
      setDone(result);
      setJoined((all) => [...all, ...result.added]);
      if (result.added.length > 0) {
        toast(result.line, { ms: UNDO_MS, action: { label: 'Undo', onAction: () => void undo(found.batchId, brought) } });
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const again = () => {
    setDone(null);
    setError('');
    finder.reset();
  };

  const everyone = [...people.filter((p) => p.status !== 'removed' && !joined.some((j) => j.id === p.id)), ...joined];
  const n = finder.kept.length;
  const slot = firstHelloWords(now(), timezone);
  const text = done ? sentences(done.line) : null;

  const finished = done ? (
    <div className="ap-done fade-in">
      <span className="ap-done-check" aria-hidden="true">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </span>
      <p className="ap-done-title">{text?.title}</p>
      {text?.rest ? <p className="ap-done-sub">{text.rest}</p> : null}
      {done.groups.length > 0 ? <p className="ap-done-skipped">{`Left out: ${done.groups.map((g) => g.line).join(', ')}.`}</p> : null}
      {error ? <AlertLine>{error}</AlertLine> : null}
      <button type="button" className="ap-btn ap-btn-quiet" onClick={again}>Add more people</button>
    </div>
  ) : undefined;

  return (
    <main className="ap-root" data-screen="add-people">
      <header className="ap-header">
        <Wordmark project={project.name} />
        <div className="ap-header-right">
          <span className="ap-status"><i data-state={project.state} aria-hidden="true" />{project.state === 'running' ? 'Running' : project.state === 'paused' ? 'Paused' : 'Wrapped up'}</span>
          <button type="button" className="ap-back" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
            River
          </button>
        </div>
      </header>

      <div className="ap-intro">
        <h1 ref={headingRef} tabIndex={-1}>Who else should Callum meet?</h1>
        <p>{`New people join the river as strangers. Nobody hears from Callum before ${slot}.`}</p>
      </div>

      <WhoPanel finder={finder} replace={finished} onNotFit={(p) => toast(`${firstOf(p)} is out and will not join.`)}>
        <div className="ap-actions">
          <button type="button" className="ap-btn ap-btn-ink ap-btn-lg" aria-busy={busy} disabled={busy || n === 0} onClick={() => void add()}>
            {`Add ${n} ${n === 1 ? 'person' : 'people'}`}
          </button>
          <button type="button" className="ap-btn ap-btn-quiet ap-btn-lg" onClick={finder.reset}>{AGAIN[finder.way]}</button>
        </div>
        {error ? <AlertLine>{error}</AlertLine> : null}
      </WhoPanel>

      <River people={everyone} lit={joined.length > 0} />
    </main>
  );
}
