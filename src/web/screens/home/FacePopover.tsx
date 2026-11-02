import { useEffect, useState } from 'react';
import type { PathStep, Person, Project, Stage } from '../../../shared/types.js';
import { api } from '../../api.js';
import { marbleBackground } from '../../ui/Marble.js';
import { dayLabel, formatWhen } from '../../ui/when.js';
import { channelPhrase } from './dock.js';
import './FacePopover.css';

const STAGE_WORD: Record<Stage, string> = { stranger: 'not contacted yet', hello: 'said hello', following: 'following up', talking: 'talking' };
const RING: Record<Stage, string> = { stranger: '#D5D9E4', hello: '#A9B8F5', following: '#6E86F2', talking: '#3F52D9' };

export interface FacePopoverProps {
  person: Person;
  /** Shown as a quiet tag when there is more than one project. */
  project?: Project | null;
  tz: string;
  now: () => Date;
  /** Says something short at the top of the screen. */
  notify: (text: string) => void;
  refresh: () => Promise<void>;
  /** Draws it flat inside a list row instead of floating over the river. */
  inline?: boolean;
  onClose?: () => void;
  /** Adds `See everything`, which opens the whole conversation. */
  onOpenPerson?: (id: number) => void;
}

/** What happens next, in a calm sentence. */
function nextLine(p: Person, path: PathStep[], tz: string, now: Date): string {
  if (p.status === 'held') return `On hold. Callum won't contact ${p.firstName} until you resume.`;
  if (p.stage === 'talking') return "You're talking. Callum won't follow up while the conversation is yours.";
  if (p.linkedinState === 'invited' && p.channel === 'linkedin') return `Waiting for ${p.firstName} to accept. Callum gives it 14 days.`;
  const next = path.find((s) => !s.done && s.at);
  const at = next?.at ?? p.nextTouchAt;
  if (!at) return p.status === 'resting' ? `${p.firstName} is resting. Callum will try again later.` : `Callum has nothing queued for ${p.firstName} yet.`;
  const when = formatWhen(at, p.timezone ?? tz, now);
  if (p.stage === 'stranger') return `Callum says hello ${when.replace(' at ', ' after ')} their time.`;
  return `If ${p.firstName} doesn't reply, ${next?.label ? `the ${next.label.toLowerCase()}` : 'the next message'} goes out ${when}.`;
}

/**
 * What you can do with one face: where they are on the way to you, what comes next, and Nudge now or Hold.
 */
export function FacePopover({ person, project, tz, now, notify, refresh, inline = false, onClose, onOpenPerson }: FacePopoverProps) {
  const [path, setPath] = useState<PathStep[] | null>(null);
  const [busy, setBusy] = useState(false);
  const held = person.status === 'held';
  const talking = person.stage === 'talking';

  useEffect(() => {
    let alive = true;
    setPath(null);
    api.person(person.id).then(
      (d) => alive && setPath(d.path),
      () => alive && setPath([]),
    );
    return () => {
      alive = false;
    };
  }, [person.id, person.touches, person.stage, person.status]);

  async function run(label: 'nudge' | 'hold' | 'resume') {
    if (busy) return;
    setBusy(true);
    try {
      if (label === 'nudge') {
        await api.nudge(person.id);
        notify(`${person.firstName} is next. It goes out as soon as sending hours and pace allow.`);
      } else if (label === 'hold') {
        await api.hold(person.id);
        notify(`Callum will leave ${person.firstName} alone for now`);
      } else {
        await api.resume(person.id);
        notify(`${person.firstName} is back in the river`);
      }
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Something went wrong. Callum kept everything as it was.');
    } finally {
      setBusy(false);
    }
  }

  const first = person.firstName;
  const nudgeWhy = held ? `Resume ${first} first.` : talking ? `${first} is talking with you.` : '';
  const steps = path ?? [];
  const firstOpen = steps.findIndex((s) => !s.done);

  return (
    <div className={`pop ${inline ? 'is-inline' : 'panel-in'}`} role={inline ? 'group' : 'dialog'} aria-label={`${person.name}`}>
      <div className="pop-head">
        <span
          className="pop-face"
          aria-hidden="true"
          style={{ background: marbleBackground(300 + person.id), boxShadow: `0 0 0 1.5px ${RING[person.stage]}`, filter: held ? 'grayscale(1)' : undefined }}
        />
        <span className="pop-name">
          <span className="pop-name-main">{person.name}</span>
          <span className="pop-name-sub">
            {[person.role, person.company].filter(Boolean).join(' at ')}
          </span>
          <span className="pop-name-sub">
            {STAGE_WORD[person.stage]}{person.stage !== 'stranger' ? ` ${channelPhrase(person.channel)}` : ''}
            {project ? <span className="home-tag pop-tag">{project.name}</span> : null}
          </span>
        </span>
        {onClose ? (
          <button type="button" className="pop-close" aria-label="Close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        ) : null}
      </div>

      {steps.length > 0 ? (
        <ol className="pop-path" aria-label="The way to a conversation">
          {steps.map((s, i) => (
            <li key={`${s.label}-${i}`} className="pop-step">
              <span className="pop-line" aria-hidden="true" style={{ left: i === 0 ? '50%' : 0, right: i === steps.length - 1 ? '50%' : 0 }} />
              <span className={`pop-dot ${s.done ? 'is-done' : i === firstOpen ? 'is-next' : ''}`} aria-hidden="true" />
              <span className="pop-step-text">
                <span className="pop-step-label">{s.label}</span>
                <span className="pop-step-day">{s.at ? dayLabel(s.at, person.timezone ?? tz, now()) : ' '}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : path === null ? (
        <div className="pop-path pop-wait" aria-hidden="true"><span /><span /><span /></div>
      ) : null}

      <p className="pop-next">{nextLine(person, steps, tz, now())}</p>

      <div className="pop-actions">
        {!talking ? (
          <button type="button" className="pop-btn pop-btn-ink" disabled={busy || held} onClick={() => void run('nudge')}>
            Nudge now
          </button>
        ) : null}
        <button type="button" className="pop-btn pop-btn-quiet" disabled={busy} onClick={() => void run(held ? 'resume' : 'hold')}>
          {held ? 'Resume' : 'Hold'}
        </button>
        {onOpenPerson ? (
          <button type="button" className="pop-btn pop-btn-ghost" onClick={() => onOpenPerson(person.id)}>
            See everything
          </button>
        ) : null}
      </div>
      {nudgeWhy && !talking ? <p className="pop-why">{nudgeWhy}</p> : null}
    </div>
  );
}
