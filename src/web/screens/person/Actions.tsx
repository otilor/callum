import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Channel, PersonFull } from '../../../shared/types.js';
import { CHANNEL_NAME } from './when.js';

export interface ActionsProps {
  detail: PersonFull;
  busy: boolean;
  onNudge(): void;
  onHold(): void;
  onResume(): void;
  onWake(): void;
  /** Moves to another channel, with the address when one was typed. Answers the sentence to show when it did not work. */
  onMoveChannel(channel: Channel, handle?: string): Promise<string | null>;
  onMoveProject(projectId: number): void;
  onNever(): void;
}

interface Action { key: string; label: string; off: boolean; reason: string | null; run(): void }

const handleOf = (d: PersonFull, ch: Channel): string | null =>
  ch === 'email' ? d.person.email : ch === 'linkedin' ? d.person.linkedinUrl : d.person.xHandle;

const FIELD: Record<Channel, { label: (first: string) => string; placeholder: string; type: string }> = {
  email: { label: (f) => `Email address for ${f}`, placeholder: 'name@company.com', type: 'email' },
  linkedin: { label: (f) => `LinkedIn link for ${f}`, placeholder: 'linkedin.com/in/name', type: 'text' },
  x: { label: (f) => `X handle for ${f}`, placeholder: '@name', type: 'text' },
};

export function Actions({ detail, busy, onNudge, onHold, onResume, onWake, onMoveChannel, onMoveProject, onNever }: ActionsProps) {
  const { person } = detail;
  const first = person.firstName;
  const [adding, setAdding] = useState<Channel | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const neverRef = useRef<HTMLButtonElement>(null);
  const backToNever = useRef(false);

  // Keep closes the question; the keyboard goes back to the button that opened it.
  useEffect(() => {
    if (!confirming && backToNever.current) {
      backToNever.current = false;
      neverRef.current?.focus();
    }
  }, [confirming]);

  if (detail.closedNote) return <p className="pv-closed fade-in">{detail.closedNote}</p>;

  const actions: Action[] = [];
  if (person.status === 'resting') {
    actions.push({ key: 'wake', label: `Wake ${first} now`, off: false, reason: null, run: onWake });
  } else {
    if (detail.nudge.ok || detail.nudge.reason) {
      actions.push({ key: 'nudge', label: 'Nudge now', off: !detail.nudge.ok, reason: detail.nudge.ok ? null : detail.nudge.reason, run: onNudge });
    }
    if (person.status === 'held') {
      actions.push({ key: 'resume', label: 'Resume', off: false, reason: null, run: onResume });
    } else if (person.status === 'active' && person.stage !== 'talking') {
      actions.push({ key: 'hold', label: 'Hold', off: false, reason: null, run: onHold });
    }
    for (const s of detail.switchable) {
      actions.push({
        key: `move-${s.channel}`, label: `Move to ${CHANNEL_NAME[s.channel]}`, off: !s.available, reason: s.reason,
        run: () => {
          setError(null);
          if (handleOf(detail, s.channel) === null) {
            setAdding(s.channel);
            setValue('');
            return;
          }
          setAdding(null);
          void onMoveChannel(s.channel).then((problem) => setError(problem));
        },
      });
    }
  }
  const firstOn = actions.findIndex((a) => !a.off);

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!adding || value.trim() === '') return;
    const channel = adding;
    void onMoveChannel(channel, value).then((problem) => {
      setError(problem);
      if (!problem) {
        setAdding(null);
        setValue('');
      }
    });
  };

  return (
    <div className="pv-actions">
      <div className="pv-btns">
        {actions.map((a, i) => (
          <button
            key={a.key}
            type="button"
            className="pv-act"
            data-primary={i === firstOn ? 'true' : undefined}
            aria-disabled={a.off || busy}
            aria-describedby={a.reason ? `pv-why-${a.key}` : undefined}
            onClick={() => !a.off && !busy && a.run()}
          >
            {a.label}
          </button>
        ))}
      </div>
      {actions.filter((a) => a.reason).map((a) => (
        <p className="pv-reason fade-in" id={`pv-why-${a.key}`} key={a.key}>
          <span className="pv-reason-dot" aria-hidden="true" />{a.reason}
        </p>
      ))}

      {adding ? (
        <form className="pv-handle fade-in" onSubmit={save}>
          <label className="sr-only" htmlFor="pv-handle">{FIELD[adding].label(first)}</label>
          <input
            id="pv-handle"
            type={FIELD[adding].type}
            value={value}
            placeholder={FIELD[adding].placeholder}
            autoComplete="off"
            autoFocus
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
          <button type="submit" aria-disabled={value.trim() === '' || busy}>Save</button>
        </form>
      ) : null}
      {error ? <p className="pv-error fade-in" role="alert">{error}</p> : null}

      {detail.projectMoves.length > 0 ? (
        <div className="pv-moves" role="group" aria-label="Move to another project">
          {detail.projectMoves.map((m) => (
            <div className="pv-move" key={m.projectId}>
              <button
                type="button"
                className="pv-act"
                aria-disabled={m.reason !== null || busy}
                aria-describedby={m.reason ? `pv-proj-${m.projectId}` : undefined}
                onClick={() => m.reason === null && !busy && onMoveProject(m.projectId)}
              >
                Move to {m.name}
              </button>
              {m.reason ? <span className="pv-reason-beside" id={`pv-proj-${m.projectId}`}>{m.reason}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {confirming ? (
        <div className="pv-confirm fade-in" role="alertdialog" aria-label={`Never contact ${first}`}>
          <p>Never contact {first}? Callum cancels everything still waiting and won't reach out again, even if {first} shows up in a list later.</p>
          <div className="pv-confirm-btns">
            <button type="button" data-ink onClick={onNever}>Never contact {first}</button>
            <button
              type="button"
              autoFocus
              onClick={() => {
                backToNever.current = true;
                setConfirming(false);
              }}
            >
              Keep
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="pv-never" ref={neverRef} onClick={() => setConfirming(true)}>Never contact {first}</button>
      )}
    </div>
  );
}
