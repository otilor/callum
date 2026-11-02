import { useState } from 'react';
import type { Person, Project } from '../../../shared/types.js';
import { api } from '../../api.js';
import { ErrorNote } from '../../ui/ErrorNote.js';
import { saveFile, type SaveFile } from './download.js';
import './Leave.css';

export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

export interface ProjectWrapResult { cancelledFollowUps: number; cancelledHellos: number; summary: string }

/** The first hellos still waiting to go in this project, and the people who are talking with the person using Callum. */
export function wrapCounts(project: Project, people: Person[]): { scheduled: number; talking: number } {
  const mine = people.filter((p) => p.projectId === project.id);
  return {
    scheduled: mine.filter((p) => p.status === 'active' && p.touches === 0).length,
    talking: mine.filter((p) => p.status === 'waiting' || p.stage === 'talking').length,
  };
}

export interface ProjectWrapConfirmProps {
  project: Project;
  people: Person[];
  /** Called with the server's answer once the project is wrapped up. */
  onDone(result: ProjectWrapResult, downloaded: boolean): void;
  /** `Keep it`. */
  onKeep(): void;
  save?: SaveFile;
}

/** Wrapping up one project, asked in place: the project row's own confirm, not the global Leave sheet. */
export function ProjectWrapConfirm({ project, people, onDone, onKeep, save = saveFile }: ProjectWrapConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { scheduled, talking } = wrapCounts(project, people);
  const text = `Wrap up ${project.name}? ${scheduled} scheduled ${scheduled === 1 ? 'hello is' : 'hellos are'} cancelled. ${talking} ${talking === 1 ? 'person' : 'people'} you're talking with stay in your dock. Download ${possessive(project.name)} people first.`;

  async function wrap(download: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (download) {
        await save(api.exportJsonUrl(project.id), `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-people.json`);
        await save(api.exportCsvUrl(project.id), `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-people.csv`);
      }
      onDone(await api.wrapProject(project.id), download);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Something went wrong. Callum kept everything as it was.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pw-confirm fade-in" role="group" aria-label={`Wrap up ${project.name}`}>
      <p className="pw-text">{text}</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="pw-actions">
        <button type="button" className="pw-primary" aria-busy={busy} onClick={() => void wrap(true)}>Download and wrap up</button>
        <button type="button" className="pw-quiet" aria-busy={busy} onClick={() => void wrap(false)}>Wrap up</button>
        <button type="button" className="pw-ghost" onClick={onKeep}>Keep it</button>
      </div>
    </div>
  );
}
