import { useEffect, useState } from 'react';
import type { Channel, Person } from '../../../shared/types.js';
import { api, ApiError, type PlanPreview } from '../../api.js';
import { Button } from '../../ui/Button.js';
import { formatSlot } from '../../ui/format.js';
import { lookForStage, Marble } from '../../ui/Marble.js';
import { ErrorLine } from './icons.js';

const TICKS: [string, number][] = [['9:00', 0], ['9:30', 25], ['10:00', 50], ['10:30', 75], ['11:00', 100]];
const GLYPH: Record<Channel, string> = { email: '@', linkedin: 'in', x: 'X' };
const FACES = 12;

/** Which channel each of the first hellos goes on, in the order the plan counted them. */
export function channelsOf(byChannel: Record<Channel, number>, n: number): Channel[] {
  const all: Channel[] = [];
  for (const ch of ['email', 'linkedin', 'x'] as const) for (let i = 0; i < byChannel[ch]; i++) all.push(ch);
  return all.slice(0, n);
}

/** The plan's own closing sentence, which the line under it says again. */
export function withoutNothingToday(line: string): string {
  return line.replace(/\s*Nothing goes out today\.\s*$/, '');
}

export interface PlanProps {
  projectId: number;
  people: Person[];
  timezone: string;
  now: Date;
  error: string;
  starting: boolean;
  onBack(): void;
  onStart(): void;
}

export function Plan({ projectId, people, timezone, now, error, starting, onBack, onStart }: PlanProps) {
  const [plan, setPlan] = useState<PlanPreview | null>(null);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    let current = true;
    api
      .plan(projectId)
      .then((p) => {
        if (current) setPlan(p);
      })
      .catch((e: unknown) => {
        if (current) setFailed(e instanceof ApiError ? e.message : 'Something went wrong. Callum kept everything as it was.');
      });
    return () => {
      current = false;
    };
  }, [projectId]);

  // Only the day comes from the clock; hellos always start at 9:00 their time.
  const day = plan ? (formatSlot(plan.firstSendAt, timezone, now).split(' at ')[0] ?? '') : '';
  const title = day === 'tomorrow' ? "Here's tomorrow" : day ? `Here's ${day}` : "Here's tomorrow";
  const faces = plan ? people.slice(0, Math.min(FACES, plan.total)) : [];
  const channels = plan ? channelsOf(plan.byChannel, faces.length) : [];

  return (
    <section className="fr-step fr-plan step-in" aria-labelledby="q5">
      <h1 id="q5" className="fr-title">{title}</h1>
      <div className="fr-plan-card">
        <div className="fr-plan-axis" aria-hidden="true">
          <span className="fr-plan-track" />
          {TICKS.map(([label, at]) => (
            <span key={label}>
              <span className="fr-plan-tick" style={{ left: `${at}%` }} />
              <span className="fr-plan-time" style={{ left: `${at}%` }}>{label}</span>
            </span>
          ))}
          {faces.map((p, k) => {
            const left = `${(k * 10 / 120 * 100).toFixed(2)}%`;
            const delay = `${k * 60}ms`;
            const look = lookForStage('hello');
            return (
              <span key={p.id}>
                <span className="fr-plan-stem pop-in" style={{ left, animationDelay: delay }} />
                <span className="fr-plan-face pop-in" style={{ left, animationDelay: delay }}>
                  <Marble seed={300 + p.id} size={40} tone={look.tone} ring={look.ring} />
                </span>
                <span className="fr-plan-badge pop-in" style={{ left, animationDelay: `${k * 60 + 120}ms` }}>{GLYPH[channels[k] ?? 'email']}</span>
              </span>
            );
          })}
        </div>
      </div>
      <div className="fr-plan-lines" aria-live="polite">
        <p className="line-1">{plan ? withoutNothingToday(plan.line) : failed ? '' : 'Callum is planning'}</p>
        <p className="line-2">Nothing goes out today. You'll OK the first 10 before they go.</p>
      </div>
      {failed ? <ErrorLine>{failed}</ErrorLine> : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="fr-actions">
        <Button size="lg" variant="quiet" onClick={onBack}>Back</Button>
        <Button size="lg" className="fr-start" aria-busy={starting} disabled={!plan || starting} onClick={onStart}>
          <span className="fr-start-dot" aria-hidden="true" />
          {plan ? `Start ${day} at 9:00` : 'Start'}
        </Button>
      </div>
    </section>
  );
}
