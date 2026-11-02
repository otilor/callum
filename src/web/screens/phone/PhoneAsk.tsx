import { useState } from 'react';
import type { AppState, AskAction, AskAnswer, Project } from '../../../shared/types.js';
import { api, ApiError } from '../../api.js';
import { Marble, lookForStage } from '../../ui/Marble.js';
import type { Notify } from './PhoneNotice.js';

export interface PhoneAskProps {
  state: AppState;
  project: Project | null;
  notify: Notify;
  refresh(): Promise<void> | void;
}

/** Things worth asking right now: who is warming up, more like the last person who replied, and the channel switch that fits. */
export function askChips(state: AppState, projectId: number | null): string[] {
  const chips = ["Who's warming up?"];
  const replied = state.people
    .filter((p) => (projectId === null || p.projectId === projectId) && p.repliedAt && p.role?.trim() && p.status !== 'stopped' && p.status !== 'closed')
    .sort((a, b) => (b.repliedAt ?? '').localeCompare(a.repliedAt ?? ''))[0];
  if (replied) chips.push(`Find 10 more like ${replied.firstName}`);
  const li = state.channels.find((c) => c.channel === 'linkedin');
  if (li?.status === 'connected') chips.push('Pause LinkedIn');
  else if (li?.status === 'paused') chips.push('Resume LinkedIn');
  return chips;
}

const whyText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.');

interface Shown { asked: string; answer: AskAnswer | null; error: string | null; done: string | null; undo: AskAction | null }

/** The Ask tab: type or tap a chip, read the answer, then say yes to what Callum offers. */
export function PhoneAsk({ state, project, notify, refresh }: PhoneAskProps) {
  const [text, setText] = useState('');
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const projectId = project?.id ?? state.settings.currentProjectId ?? undefined;

  const ask = async (raw: string) => {
    const typed = raw.trim();
    if (!typed || busy) return;
    setText('');
    setBusy(true);
    setShown({ asked: typed, answer: null, error: null, done: null, undo: null });
    try {
      const answer = await api.ask(typed, projectId);
      setShown({ asked: typed, answer, error: null, done: null, undo: null });
    } catch (e) {
      setShown({ asked: typed, answer: null, error: whyText(e), done: null, undo: null });
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: AskAction) => {
    if (busy || !shown) return;
    setBusy(true);
    try {
      const result = await api.act(action, projectId);
      // A pause can be taken back with one tap; nothing else here can.
      const undo: AskAction | null =
        action.kind === 'pause_channel'
          ? { kind: 'resume_channel', label: `Resume ${action.args.channel === 'linkedin' ? 'LinkedIn' : action.args.channel === 'x' ? 'X' : 'email'}`, args: action.args }
          : null;
      setShown({ asked: shown.asked, answer: { text: result.text, personIds: result.personIds, action: null }, error: null, done: result.text, undo });
      await refresh();
    } catch (e) {
      setShown({ ...shown, error: whyText(e) });
    } finally {
      setBusy(false);
    }
  };

  const takeBack = async (action: AskAction) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.act(action, projectId);
      setShown(null);
      notify(result.text);
      await refresh();
    } catch (e) {
      notify(whyText(e));
    } finally {
      setBusy(false);
    }
  };

  const chips = askChips(state, projectId ?? null);
  const people = shown?.answer ? shown.answer.personIds.flatMap((id) => state.people.find((p) => p.id === id) ?? []) : [];
  const action = shown?.answer?.action ?? null;

  return (
    <div className="pa-tab pa-ask">
      <div className="pa-ask-body">
        {!shown ? (
          <div className="pa-ask-empty">
            <span className="pa-ask-mark" aria-hidden="true" />
            <h2>Ask Callum</h2>
            <p>About your people, or who to meet next.</p>
          </div>
        ) : (
          <>
            <p className="pa-asked fade-in">{shown.asked}</p>
            <div className="pa-answer fade-in" aria-live="polite">
              <span className="pa-answer-mark" aria-hidden="true" />
              <div className="pa-answer-body">
                {shown.answer === null && shown.error === null ? <p className="pa-answer-text">Callum is thinking.</p> : null}
                {shown.error ? <p className="pa-answer-text pa-answer-error" role="alert">{shown.error}</p> : null}
                {shown.answer ? (
                  <>
                    {people.length > 0 ? (
                      <div className="pa-answer-faces">
                        {people.slice(0, 8).map((p) => (
                          <span key={p.id} className="pa-answer-face">
                            <Marble seed={300 + p.id} size={28} tone={lookForStage(p.stage).tone} ring={lookForStage(p.stage).ring} />
                            <span>{p.firstName}</span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <p className="pa-answer-text">{shown.answer.text}</p>
                  </>
                ) : null}
                {action ? (
                  <div className="pa-answer-actions">
                    <button type="button" className="pa-primary" disabled={busy} onClick={() => void act(action)}>{action.label}</button>
                    <button type="button" className="pa-soft" onClick={() => setShown(null)}>Not now</button>
                  </div>
                ) : null}
                {shown.undo ? (
                  <div className="pa-answer-actions">
                    <button type="button" className="pa-soft" disabled={busy} onClick={() => void takeBack(shown.undo as AskAction)}>Undo</button>
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="pa-ask-dock">
        <div className="pa-chips" role="group" aria-label="Things to ask">
          {chips.map((c) => (
            <button key={c} type="button" className="pa-chip" disabled={busy} onClick={() => void ask(c)}>{c}</button>
          ))}
        </div>
        <form
          className="pa-ask-pill"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(text);
          }}
        >
          <label htmlFor="pa-ask-in" className="sr-only">Ask Callum</label>
          <input
            id="pa-ask-in"
            type="text"
            value={text}
            placeholder="Ask Callum"
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="pa-send" aria-label="Send" disabled={busy || text.trim() === ''}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V6M6 11l6-6 6 6" /></svg>
          </button>
        </form>
      </div>
    </div>
  );
}
