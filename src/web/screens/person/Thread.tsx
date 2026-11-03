import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { Message, PersonFull } from '../../../shared/types.js';
import { Marble } from '../../ui/Marble.js';
import { dayLong, messageMeta, sentence, threadMeta, voiceOf, whenShort } from './when.js';

/** A message the user wrote that is still inside its 10 seconds, or on its way out. */
export interface PendingSend { id: number; text: string; undoUntil: string | null }

type Entry =
  | { kind: 'message'; message: Message }
  | { kind: 'note'; text: string; dot: string }
  | { kind: 'pending'; send: PendingSend };

/** The conversation in order, with the notes between: nothing sent yet, an accepted invite, a stop, a rest. */
function entriesOf(detail: PersonFull, tz: string, now: Date, pending: PendingSend[]): Entry[] {
  const { person, messages } = detail;
  const first = person.firstName;
  const ordered = [...messages].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
  const out: Entry[] = [];
  const lastInvite = ordered.map((m) => m.kind).lastIndexOf('invite');
  ordered.forEach((message, i) => {
    out.push({ kind: 'message', message });
    if (i === lastInvite && person.linkedinState === 'connected') out.push({ kind: 'note', text: `${first} accepted your invite`, dot: '#6E86F2' });
  });
  if (ordered.length === 0) {
    out.push({ kind: 'note', text: detail.next && person.status === 'active' ? `Nothing sent yet. ${sentence(detail.next)}` : 'Nothing sent yet.', dot: '#D5D9E4' });
  }
  if (person.status === 'stopped') {
    const stop = detail.path.find((s) => s.state === 'stop')?.at ?? person.updatedAt;
    out.push({ kind: 'note', text: `Callum stopped everything for ${first} · ${whenShort(stop, tz, now)}`, dot: '#D9480F' });
  }
  if (person.status === 'resting' && person.restUntil) {
    out.push({ kind: 'note', text: `No reply after three messages. ${first} rests until ${dayLong(person.restUntil, tz)}.`, dot: '#B9BFCE' });
  }
  for (const send of pending) out.push({ kind: 'pending', send });
  return out;
}

export interface ThreadProps {
  detail: PersonFull;
  tz: string;
  now: Date;
  pending: PendingSend[];
  /** The email address messages go out from, when the person is on email. */
  senderEmail: string | null;
  canCorrect: boolean;
  onCorrect(kind: 'auto_reply' | 'wrong_person'): void;
  canWrite: boolean;
  draft: string;
  onDraft(text: string): void;
  onSend(): void;
  writing: boolean;
  writeError: string | null;
}

function writeNote(detail: PersonFull, senderEmail: string | null): string {
  const channel = detail.person.channel;
  if (channel === 'email') return `Goes by email${senderEmail ? ` from ${senderEmail}` : ''}, with 10 seconds to undo`;
  if (channel === 'linkedin') return 'Goes on LinkedIn as you, with 10 seconds to undo';
  if (channel === 'x') return 'Goes on X as you, with 10 seconds to undo';
  return 'Goes out with 10 seconds to undo';
}

export function Thread({ detail, tz, now, pending, senderEmail, canCorrect, onCorrect, canWrite, draft, onDraft, onSend, writing, writeError }: ThreadProps) {
  const { person, messages } = detail;
  const first = person.firstName;
  const entries = entriesOf(detail, tz, now, pending);
  const scroller = useRef<HTMLDivElement>(null);
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'in');

  // The newest message is the one that matters: start at the bottom, and follow new ones down.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, person.id]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };
  const canSend = draft.trim() !== '' && !writing;

  return (
    <section className="pv-thread pv-swap" aria-label={`Everything with ${first}`} key={person.id}>
      <div className="pv-thread-head">
        <h2>Everything with {first}</h2>
        <span className="pv-quiet">{threadMeta(messages)}</span>
      </div>
      <div className="pv-scroll" ref={scroller} tabIndex={0} role="region" aria-label={`Messages with ${first}`}>
        {entries.map((entry, i) => {
          if (entry.kind === 'note') {
            return (
              <p className="pv-note fade-in" key={`n${i}`}>
                <span className="pv-note-rule" aria-hidden="true" />
                <span className="pv-note-text"><span className="pv-note-dot" aria-hidden="true" style={{ background: entry.dot }} />{entry.text}</span>
                <span className="pv-note-rule" aria-hidden="true" />
              </p>
            );
          }
          if (entry.kind === 'pending') {
            const open = entry.send.undoUntil !== null && new Date(entry.send.undoUntil).getTime() > now.getTime();
            return (
              <div className="pv-msg pv-mine msg-in" key={`p${entry.send.id}`} data-voice="you" data-pending="true">
                <span className="pv-meta pv-sending">{open ? 'Sending in a few seconds' : 'Sending'}</span>
                <p className="pv-bubble pv-bubble-you pv-bubble-pending">{entry.send.text}</p>
              </div>
            );
          }
          const m = entry.message;
          const voice = voiceOf(m);
          const correctable = canCorrect && lastInbound?.id === m.id;
          return (
            <div className={`pv-msg fade-in ${voice === 'them' ? 'pv-theirs' : 'pv-mine'}`} key={`m${m.id}`} data-voice={voice}>
              <span className="pv-meta">
                {voice === 'callum' ? <span className="pv-sun-dot" aria-hidden="true" /> : null}
                {voice === 'them' ? <Marble seed={300 + person.id} size={22} tone="warm" ring={null} /> : null}
                <span>{messageMeta(m, person, tz, now)}</span>
              </span>
              <p className={`pv-bubble pv-bubble-${voice}`}>{m.body}</p>
              {correctable ? (
                <div className="pv-fixes">
                  <button type="button" onClick={() => onCorrect('auto_reply')}>That's an auto-reply</button>
                  <button type="button" onClick={() => onCorrect('wrong_person')}>Wrong person</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {canWrite ? (
        <>
          <div className="pv-compose">
            <label className="sr-only" htmlFor="pv-write">Write to {first}</label>
            <textarea
              id="pv-write"
              rows={1}
              value={draft}
              placeholder={`Write to ${first}`}
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={onKey}
            />
            <button type="button" className="pv-send" aria-label={`Send to ${first}`} aria-disabled={!canSend} onClick={() => canSend && onSend()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
          {writeError ? <p className="pv-error" role="alert">{writeError}</p> : null}
          <span className="pv-quiet pv-write-note">{writeNote(detail, senderEmail)}</span>
        </>
      ) : null}
    </section>
  );
}
