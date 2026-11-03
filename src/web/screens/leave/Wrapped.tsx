import { useState } from 'react';
import type { AppState } from '../../../shared/types.js';
import { api } from '../../api.js';
import { ErrorNote } from '../../ui/ErrorNote.js';
import { formatBytes, type SavedFile } from './download.js';
import { LeaveFrame } from './LeaveFrame.js';

/** What the wrap-up that just ran produced, kept for the screen that follows it (the page swaps screens the moment the wrap lands). */
export interface WrapMemory {
  /** `Callum said hello to 36 people for you. 8 replied, and 2 calls got booked.`, read before anything was deleted. */
  line: string | null;
  /** `Nobody else hears from you. 28 follow-ups and 4 first hellos are cancelled.` */
  summary: string;
  files: SavedFile[];
}

let remembered: WrapMemory | null = null;

export function rememberWrap(memory: WrapMemory | null): void {
  remembered = memory;
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

export interface WrappedProps {
  state: AppState;
  refresh(): Promise<void>;
  /** Overrides what was remembered from the wrap-up; mostly for tests. */
  memory?: WrapMemory | null;
}

/** Done: Callum has wrapped up. What was saved can be saved again, and starting again is one tap away. */
export function Wrapped({ state, refresh, memory }: WrappedProps) {
  const [wrap] = useState<WrapMemory | null>(() => memory ?? remembered);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Nothing was deleted when people are still here, so the export routes still have something to give.
  const kept = state.people.length > 0;
  const files: { name: string; href: string; size: string | null }[] = wrap?.files.length
    ? wrap.files.map((f) => ({ name: f.name, href: f.href, size: formatBytes(f.bytes) }))
    : kept
      ? [
          { name: 'callum-people.json', href: api.exportJsonUrl(), size: null },
          { name: 'callum-people.csv', href: api.exportCsvUrl(), size: null },
        ]
      : [];

  async function startAgain() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      await api.startAgain();
      rememberWrap(null);
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <LeaveFrame people={state.people} gone viewKey="done">
      <section className="lv-view lv-done step-in" aria-labelledby="lv-done-title">
        <span className="lv-sun" aria-hidden="true" />
        <h1 id="lv-done-title" className="lv-title" tabIndex={-1}>All wrapped up</h1>
        <p className="lv-lede">
          {wrap?.line ? `${wrap.line} ` : ''}Thanks for letting Callum help.
        </p>
        {wrap?.summary ? <p className="lv-note">{wrap.summary}</p> : null}
        {files.length > 0 ? (
          <ul className="lv-files" aria-label="Your export">
            {files.map((f) => (
              <li key={f.name} className="lv-file fade-in">
                <span className="lv-file-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 3h8l4 4v14H6z" />
                    <path d="M14 3v4h4M12 11v6M9.5 14.5L12 17l2.5-2.5" />
                  </svg>
                </span>
                <span className="lv-file-text">
                  <span className="lv-file-name">{f.name}</span>
                  <span className="lv-file-meta">{f.size ? `${f.size}, saved to your downloads` : 'Ready to download'}</span>
                </span>
                <a className="lv-file-again" href={f.href} download={f.name}>Download again</a>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <button type="button" className="lv-primary lv-primary-lg" onClick={() => void startAgain()} aria-busy={starting}>
          Start again any time
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </section>
    </LeaveFrame>
  );
}
