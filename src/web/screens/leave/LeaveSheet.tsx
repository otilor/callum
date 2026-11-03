import { useEffect, useId, useState, type ReactNode } from 'react';
import type { AppState, Person } from '../../../shared/types.js';
import { api } from '../../api.js';
import { ErrorNote } from '../../ui/ErrorNote.js';
import { Marble } from '../../ui/Marble.js';
import { formatSlot, joinNames } from '../../ui/format.js';
import { useToast } from '../../ui/Toast.js';
import { breakChoices, earliestPick, pickedBreak, type BreakChoice } from './breakDates.js';
import { formatBytes, saveFile, type SaveFile, type SavedFile } from './download.js';
import { LeaveFrame } from './LeaveFrame.js';
import { rememberWrap, Wrapped } from './Wrapped.js';

type View = 'choose' | 'wrap';
type Pick = BreakChoice['key'] | 'date';

const BREAK_LINES = ['New hellos stop right away', 'Follow-ups freeze in place', 'No double messages when you come back'];
/** The one thing a deletion keeps, said at the moment of choosing it. */
const STOP_LIST_NOTE = 'People who asked you to stop stay on a private do-not-contact list, so they never hear from you again.';
const WRAP_TITLES = ['Download everything', 'Hand conversations back', 'Stop everyone else', 'Delete my data from this computer'] as const;

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

const MoonIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
  </svg>
);
const DoorIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" />
    <path d="M10 16l-4-4 4-4M6 12h10" />
  </svg>
);

function Faces({ people }: { people: Person[] }) {
  return (
    <span className="lv-faces" aria-hidden="true">
      {people.slice(0, 6).map((p) => (
        <Marble key={p.id} seed={300 + p.id} size={34} tone="warm" ring={null} style={{ marginRight: -8 }} />
      ))}
    </span>
  );
}

function Switch({ label, on, onToggle }: { label: string; on: boolean; onToggle(): void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="lv-switch" data-on={on} onClick={onToggle}>
      <span className="lv-knob" aria-hidden="true" />
    </button>
  );
}

function StepDisc({ n, status }: { n: number; status: 'idle' | 'busy' | 'done' | 'skipped' }) {
  if (status === 'busy') {
    return (
      <span className="lv-disc" aria-hidden="true">
        <svg className="lv-spin" width="22" height="22" viewBox="0 0 28 28">
          <circle cx="14" cy="14" r="11" fill="none" stroke="#E7E9F0" strokeWidth="3" />
          <path d="M14 3a11 11 0 0 1 11 11" fill="none" stroke="#1D2140" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (status === 'done' || status === 'skipped') {
    return (
      <span className="lv-disc" data-done={status} aria-hidden="true">
        <svg className="pop-in" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
    );
  }
  return <span className="lv-disc" aria-hidden="true">{n}</span>;
}

export interface LeaveSheetProps {
  state: AppState;
  refresh(): Promise<void>;
  /** `Back to the river`. */
  onClose(): void;
  now?: () => Date;
  /** How a file is handed to the browser. Only tests change it. */
  save?: SaveFile;
}

/** Take a break, or wrap up. Both are global: every project rests, or every project is wrapped. */
export function LeaveSheet({ state, refresh, onClose, now = () => new Date(), save = saveFile }: LeaveSheetProps) {
  const toast = useToast();
  const dateId = useId();
  const tz = state.settings.timezone;
  const paused = state.settings.pauseState === 'paused';

  const [view, setView] = useState<View>('choose');
  const [changing, setChanging] = useState(false);
  const [pick, setPick] = useState<Pick>('monday');
  const [day, setDay] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [exportOn, setExportOn] = useState(true);
  const [deleteOn, setDeleteOn] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [progress, setProgress] = useState(-1);
  // Both the copy and the deletion were asked for: the files are saved, and the person presses once more before anything is deleted.
  const [saved, setSaved] = useState<SavedFile[] | null>(null);
  const [outcome, setOutcome] = useState<{ line: string | null; summary: string; files: SavedFile[] } | null>(null);

  const working = view === 'wrap' && progress >= 0;
  const talking = state.people.filter((p) => p.status === 'waiting' || p.stage === 'talking');

  // What a wrap-up would say about the work so far, read before anything is cancelled or deleted.
  useEffect(() => {
    if (view !== 'wrap') return;
    let alive = true;
    api
      .wrapSummary()
      .then((r) => alive && setLine(r.line))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [view]);

  if (outcome) return <Wrapped state={state} refresh={refresh} memory={outcome} />;

  const choices = breakChoices(now(), tz);
  const picked = pick === 'date' ? pickedBreak(day, now(), tz) : null;
  const chosen: BreakChoice | null = pick === 'date' ? picked : (choices.find((c) => c.key === pick) ?? null);

  async function startBreak() {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.pause(chosen.until.toISOString());
      setChanging(false);
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.resumeAll();
      setChanging(false);
      toast('Callum is back. Everyone picks up where they left off.');
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function finishWrap(files: SavedFile[], summaryLine: string | null) {
    setProgress(1);
    try {
      const result = await api.wrap(deleteOn);
      setProgress(WRAP_TITLES.length);
      const memory = { line: summaryLine, summary: result.summary, files };
      rememberWrap(memory);
      setSaved(null);
      setOutcome(memory);
      await refresh();
    } catch (e) {
      setError(messageOf(e));
      setProgress(-1);
    }
  }

  async function confirmWrap() {
    if (working) return;
    setError(null);
    setProgress(0);
    // The line about the work so far has to be read before anything is cancelled or deleted.
    let summaryLine = line;
    if (summaryLine === null) {
      try {
        summaryLine = (await api.wrapSummary()).line;
        setLine(summaryLine);
      } catch {
        summaryLine = null;
      }
    }
    const files: SavedFile[] = [];
    if (exportOn) {
      try {
        files.push(await save(api.exportJsonUrl(), 'callum-people.json'));
        files.push(await save(api.exportCsvUrl(), 'callum-people.csv'));
      } catch (e) {
        // Nothing is wrapped or deleted unless the copy is safely on this computer.
        setError(messageOf(e));
        setProgress(-1);
        return;
      }
    }
    if (exportOn && deleteOn) {
      setSaved(files);
      setProgress(-1);
      return;
    }
    await finishWrap(files, summaryLine);
  }

  async function deleteAndWrap() {
    if (working || !saved) return;
    setError(null);
    setProgress(1);
    await finishWrap(saved, line);
  }

  // ---- resting -------------------------------------------------------------------------------------------------------
  if (paused && !changing && view === 'choose') {
    const until = state.settings.pausedUntil;
    const stay = talking.length;
    return (
      <LeaveFrame people={state.people} still onBack={onClose} viewKey="resting">
        <section className="lv-view lv-rest step-in" aria-labelledby="lv-rest-title">
          <span className="lv-moon" aria-hidden="true">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
            </svg>
          </span>
          <h1 id="lv-rest-title" className="lv-title" tabIndex={-1}>
            {until ? `Callum is resting until ${formatSlot(until, tz, now())}` : 'Callum is resting'}
          </h1>
          <p className="lv-lede">
            {until ? 'Nothing goes out until then.' : 'Nothing goes out until you resume.'} Replies still reach you
            {stay > 0 ? `, and your ${stay} ${stay === 1 ? 'conversation stays' : 'conversations stay'} yours.` : '.'}
          </p>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="lv-actions lv-actions-center">
            <button type="button" className="lv-primary" onClick={() => void resume()} aria-busy={busy}>Resume</button>
            <button type="button" className="lv-quiet" onClick={() => setChanging(true)}>Change the date</button>
          </div>
        </section>
      </LeaveFrame>
    );
  }

  // ---- wrapping up ---------------------------------------------------------------------------------------------------
  if (view === 'wrap' && saved) {
    return (
      <LeaveFrame people={state.people} still viewKey={working ? 'deleting' : 'saved'}>
        <section className="lv-view lv-wrap step-in" aria-labelledby="lv-saved-title">
          <div className="lv-head">
            <h1 id="lv-saved-title" className="lv-title" tabIndex={-1}>Your files are saved</h1>
            <p className="lv-lede lv-lede-sm">They are on this computer now. Callum deletes its copies when you go on, and that can't be undone.</p>
            <p className="lv-lede lv-lede-sm">{STOP_LIST_NOTE}</p>
          </div>
          <ul className="lv-files" aria-label="Saved files">
            {saved.map((f) => (
              <li key={f.name} className="lv-file">
                <span className="lv-file-text">
                  <span className="lv-file-name">{f.name}</span>
                  <span className="lv-file-meta">{formatBytes(f.bytes)}, saved to your downloads</span>
                </span>
                <a className="lv-file-again" href={f.href} download={f.name}>Download again</a>
              </li>
            ))}
          </ul>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="lv-actions">
            <button type="button" className="lv-primary" onClick={() => void deleteAndWrap()} aria-busy={working}>Delete and wrap up</button>
            <button
              type="button"
              className="lv-quiet"
              disabled={working}
              onClick={() => {
                setSaved(null);
                setError(null);
                setView('choose');
                toast('Callum keeps going. Nothing changed.');
              }}
            >
              Keep Callum
            </button>
          </div>
        </section>
      </LeaveFrame>
    );
  }

  if (view === 'wrap') {
    // Progress 0: the copy is being saved. 1: Callum is cancelling and (if asked) deleting. 4: finished.
    const statuses = WRAP_TITLES.map((_, i): 'idle' | 'busy' | 'done' | 'skipped' => {
      const skipped = (i === 0 && !exportOn) || (i === 3 && !deleteOn);
      if (!working) return 'idle';
      if (progress >= WRAP_TITLES.length) return skipped ? 'skipped' : 'done';
      if (progress === 0) return i === 0 ? (skipped ? 'skipped' : 'busy') : 'idle';
      if (i === 0) return skipped ? 'skipped' : 'done';
      return skipped ? 'skipped' : 'busy';
    });
    const subs: ReactNode[] = [
      'Every person and message, as a spreadsheet and a JSON file',
      talking.length > 0
        ? `${talking.length > 3 ? `${talking.slice(0, 3).map((p) => p.firstName).join(', ')} and ${talking.length - 3} more` : joinNames(talking.map((p) => p.firstName))} ${talking.length === 1 ? 'keeps' : 'keep'} talking with you in your own inbox`
        : 'Anyone who writes back finds you in your own inbox',
      'Nobody else hears from you. Waiting hellos and follow-ups are cancelled.',
      deleteOn ? 'Callum forgets every person and message it holds here' : 'Callum keeps its copy here, in case you start again',
    ];
    const warn = !exportOn && deleteOn && !working;
    return (
      <LeaveFrame people={state.people} still onBack={working ? undefined : () => { setError(null); setView('choose'); }} viewKey={working ? 'working' : 'wrap'}>
        <section className="lv-view lv-wrap step-in" aria-labelledby="lv-wrap-title">
          <div className="lv-head">
            <h1 id="lv-wrap-title" className="lv-title" tabIndex={-1}>{working ? 'Wrapping up' : 'Wrap up Callum'}</h1>
            <p className="lv-lede lv-lede-sm">
              {working
                ? 'This takes a few seconds. Please keep this window open.'
                : `${line ? `${line} ` : ''}Here is exactly what happens. You can keep Callum until the last step.`}
            </p>
          </div>
          <ol className="lv-steps">
            {WRAP_TITLES.map((title, i) => {
              const status = statuses[i] ?? 'idle';
              const toggle = i === 0 ? () => setExportOn((v) => !v) : i === 3 ? () => setDeleteOn((v) => !v) : null;
              return (
                <li key={title} className="lv-step" data-dim={working && status === 'idle'}>
                  <StepDisc n={i + 1} status={status} />
                  <span className="lv-step-text">
                    <span className="lv-step-title">{title}</span>
                    <span className="lv-step-sub">{status === 'skipped' ? 'Skipped' : subs[i]}</span>
                  </span>
                  {toggle && !working ? <Switch label={title} on={i === 0 ? exportOn : deleteOn} onToggle={toggle} /> : null}
                  {!toggle && !working ? <span className="lv-step-note">Always</span> : null}
                </li>
              );
            })}
          </ol>
          {warn ? <ErrorNote>You won't be able to get these conversations back.</ErrorNote> : null}
          {deleteOn && !working ? <p className="lv-note">Callum deletes everything here once your files are saved. This can't be undone.</p> : null}
          {deleteOn && !working ? <p className="lv-note">{STOP_LIST_NOTE}</p> : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {!working ? (
            <div className="lv-actions">
              <button type="button" className="lv-primary" onClick={() => void confirmWrap()}>{deleteOn ? 'Wrap up and delete' : 'Wrap up Callum'}</button>
              <button
                type="button"
                className="lv-quiet"
                onClick={() => {
                  setError(null);
                  setView('choose');
                  toast('Callum keeps going. Nothing changed.');
                }}
              >
                Keep Callum
              </button>
            </div>
          ) : null}
        </section>
      </LeaveFrame>
    );
  }

  // ---- choose --------------------------------------------------------------------------------------------------------
  return (
    <LeaveFrame people={state.people} still={paused} onBack={onClose} viewKey="choose">
      <section className="lv-view lv-choose step-in" aria-labelledby="lv-choose-title">
        <div className="lv-head lv-head-center">
          <h1 id="lv-choose-title" className="lv-title lv-title-xl" tabIndex={-1}>Take a break, or wrap up?</h1>
          <p className="lv-lede">Either way, nobody gets a strange message from you.</p>
        </div>
        <div className="lv-choices">
          <article className="lv-card" aria-labelledby="lv-break-title">
            <div className="lv-card-head">
              <span className="lv-card-icon" aria-hidden="true"><MoonIcon /></span>
              <div>
                <h2 id="lv-break-title" className="lv-card-title">Take a break</h2>
                <span className="lv-card-sub">Everyone waits exactly where they are.</span>
              </div>
            </div>
            <div className="lv-chips" role="radiogroup" aria-label="How long">
              {choices.map((c) => (
                <button key={c.key} type="button" role="radio" aria-checked={pick === c.key} className="lv-chip" onClick={() => setPick(c.key)}>
                  {c.label}
                </button>
              ))}
              <button type="button" role="radio" aria-checked={pick === 'date'} className="lv-chip" onClick={() => setPick('date')}>
                Pick a date
              </button>
            </div>
            {pick === 'date' ? (
              <div className="lv-date fade-in">
                <label htmlFor={dateId}>Callum comes back on</label>
                <input id={dateId} type="date" value={day} min={earliestPick(now(), tz)} onChange={(e) => setDay(e.target.value)} />
              </div>
            ) : null}
            <ul className="lv-list">
              {BREAK_LINES.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            {error && !working ? <ErrorNote>{error}</ErrorNote> : null}
            <button type="button" className="lv-primary lv-push" onClick={() => void startBreak()} disabled={!chosen} aria-busy={busy}>
              {chosen ? chosen.button : 'Pick a date'}
            </button>
          </article>

          <article className="lv-card" aria-labelledby="lv-wrap-card-title">
            <div className="lv-card-head">
              <span className="lv-card-icon" aria-hidden="true"><DoorIcon /></span>
              <div>
                <h2 id="lv-wrap-card-title" className="lv-card-title">Wrap up</h2>
                <span className="lv-card-sub">Take everything with you, nothing held back.</span>
              </div>
            </div>
            <div className="lv-talking">
              <Faces people={talking} />
              <span>
                {talking.length === 0
                  ? 'Nobody is talking with you right now'
                  : `${talking.length} ${talking.length === 1 ? 'conversation goes' : 'conversations go'} back to you`}
              </span>
            </div>
            <ul className="lv-list">
              <li>Export every person and message</li>
              <li>Everyone else stops hearing from you</li>
              <li>Your conversations stay with you</li>
            </ul>
            <button
              type="button"
              className="lv-quiet lv-push"
              onClick={() => {
                setError(null);
                setProgress(-1);
                setView('wrap');
              }}
            >
              Wrap up
            </button>
          </article>
        </div>
      </section>
    </LeaveFrame>
  );
}
