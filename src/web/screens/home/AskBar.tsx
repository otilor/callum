import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import type { AskAnswer, Person, Project } from '../../../shared/types.js';
import { api } from '../../api.js';
import { marbleBackground } from '../../ui/Marble.js';
import './AskBar.css';

export interface AskBarProps {
  /** The project being viewed: the Ask bar acts on it. */
  project: Project | null;
  /** Everyone, so the faces in an answer can be drawn. */
  people: Person[];
  /** Newest replier in this project, for the `Find 20 more like {first}` chip. */
  likeName?: string | null;
  /** Lets the screen put the cursor here, as the empty river does. */
  inputRef?: Ref<HTMLInputElement>;
  /** Called after an action changed something, so the screen reads state again. */
  onChanged?: () => void | Promise<void>;
  /** Replaces the placeholder, e.g. for the empty river. */
  placeholder?: string;
  /** Puts words in the field and the cursor there (a starter chip of the quiet moments). A new `n` is a new request. */
  prefill?: { text: string; n: number } | null;
  /** Opens the add people flow, for an answer that says Callum needs a list. */
  onBringList?: () => void;
}

interface Turn { asked: string; answer: AskAnswer | null; result: AskAnswer | null; error: string; working: boolean }

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Callum kept everything as it was.';
}

/**
 * The Ask bar: say what you want, or tap a chip. The answer opens above the bar with the people it is about and one
 * button that does the thing.
 */
export function AskBar({ project, people, likeName, inputRef, onChanged, placeholder, prefill, onBringList }: AskBarProps) {
  const [text, setText] = useState('');
  const [chips, setChips] = useState(false);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [acting, setActing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const asking = useRef(0);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    field.current?.focus();
  }, [prefill?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions = [
    "Who's warming up?",
    likeName ? `Find 20 more like ${likeName}` : 'Find 20 more people',
    'Pause LinkedIn',
  ];

  async function ask(raw: string) {
    const question = raw.trim();
    if (!question) return;
    const ticket = ++asking.current;
    setText('');
    setChips(false);
    setTurn({ asked: question, answer: null, result: null, error: '', working: true });
    try {
      const answer = await api.ask(question, project?.id);
      if (ticket === asking.current) setTurn({ asked: question, answer, result: null, error: '', working: false });
    } catch (e) {
      if (ticket === asking.current) setTurn({ asked: question, answer: null, result: null, error: errorText(e), working: false });
    }
  }

  async function act() {
    const action = turn?.answer?.action;
    if (!turn || !action || acting) return;
    // A newer question may have replaced this answer while the action ran; its result then belongs to nobody.
    const ticket = asking.current;
    setActing(true);
    try {
      const result = await api.act(action, project?.id);
      if (ticket === asking.current) setTurn((t) => (t ? { ...t, result, error: '' } : t));
      await onChanged?.();
    } catch (e) {
      if (ticket === asking.current) setTurn((t) => (t ? { ...t, error: errorText(e) } : t));
    } finally {
      setActing(false);
    }
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void ask(text);
    }
  };

  const shown = turn?.result ?? turn?.answer ?? null;
  const faces = (shown?.personIds ?? []).map((id) => people.find((p) => p.id === id)).filter((p): p is Person => p !== undefined).slice(0, 6);
  const more = (shown?.personIds.length ?? 0) - faces.length;
  const action = turn?.answer?.action ?? null;
  const needsList = onBringList !== undefined && !action && shown !== null && /needs a list for that/i.test(shown.text);

  return (
    <div
      className="ab"
      onBlur={(e) => {
        // Focus moving from the input to a chip (Tab) is still inside the bar; anything else closes the chips.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setChips(false), 160);
      }}
    >
      {turn ? (
        <div className="ab-panel panel-in" role="region" aria-label="Callum's answer" aria-live="polite">
          <div className="ab-top">
            <p className="ab-asked">{turn.asked}</p>
            <button type="button" className="ab-x" aria-label="Close" onClick={() => setTurn(null)}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>
          </div>
          <div className="ab-body">
            <span className="ab-sun" aria-hidden="true" />
            <div className="ab-col">
              {turn.working ? <p className="ab-text">Callum is looking</p> : null}
              {faces.length > 0 ? (
                <div className="ab-faces">
                  {faces.map((p) => (
                    <div key={p.id} className="ab-face">
                      <span aria-hidden="true" style={{ background: marbleBackground(300 + p.id) }} />
                      <span className="ab-face-name">{p.firstName}</span>
                    </div>
                  ))}
                  {more > 0 ? <span className="ab-more">and {more} more</span> : null}
                </div>
              ) : null}
              {shown ? <p className="ab-text">{shown.text}</p> : null}
              {turn.error ? <p className="ab-error" role="alert">{turn.error}</p> : null}
              {needsList ? (
                <div className="ab-buttons">
                  <button type="button" className="ab-btn ab-btn-ink" onClick={onBringList}>Bring a list</button>
                  <button type="button" className="ab-btn ab-btn-quiet" onClick={() => setTurn(null)}>Not now</button>
                </div>
              ) : null}
              {action && !turn.result ? (
                <div className="ab-buttons">
                  <button type="button" className="ab-btn ab-btn-ink" disabled={acting} onClick={() => void act()}>{action.label}</button>
                  <button type="button" className="ab-btn ab-btn-quiet" onClick={() => setTurn(null)}>Not now</button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="ab-pill">
        <span className="ab-dot" aria-hidden="true" />
        <label className="sr-only" htmlFor="ab-input">Ask Callum</label>
        <input
          id="ab-input"
          ref={(el) => {
            field.current = el;
            if (typeof inputRef === 'function') inputRef(el);
            else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el;
          }}
          className="ab-input"
          type="text"
          value={text}
          placeholder={placeholder ?? (project ? `Ask Callum about ${project.name}` : 'Ask Callum, or tell it who to meet')}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onFocus={() => {
            clearTimeout(closeTimer.current);
            setChips(true);
          }}
          onKeyDown={onKey}
        />
        <button type="button" className="ab-send" aria-label="Send" onClick={() => void ask(text)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
      </div>

      {chips && !turn ? (
        <div className="ab-chips panel-in">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="ab-chip"
              // The mouse goes down before the input loses focus; keeping focus where it is lets the click land.
              onMouseDown={(e) => e.preventDefault()}
              onFocus={() => clearTimeout(closeTimer.current)}
              // Enter and Space both arrive as a click.
              onClick={() => void ask(s)}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
