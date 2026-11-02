import { useRef, type CSSProperties, type ReactNode } from 'react';
import type { Person, Project } from '../../../shared/types.js';
import { marbleBackground } from '../../ui/Marble.js';
import { formatWhen } from '../../ui/when.js';
import { channelPhrase } from './dock.js';

/** Where a waiting face floats above the river, as a percentage across and px down. Same spots as the boards. */
const SLOTS = [{ x: 72, y: 92 }, { x: 81, y: 128 }, { x: 90, y: 100 }, { x: 63, y: 122 }, { x: 56, y: 86 }];
/** The water starts here, in the stage's own pixels, and the dashed lines run down to it. */
export const RIVER_TOP = 285;

function slotFor(index: number): { x: number; y: number } {
  const base = SLOTS[index % SLOTS.length]!;
  const ring = Math.floor(index / SLOTS.length);
  return { x: Math.max(8, base.x - ring * 6), y: base.y + (ring % 2 === 0 ? 0 : -18) };
}

export interface DockProps {
  /** People who wait on you, oldest reply first, from every project. */
  people: Person[];
  projects: Project[];
  tz: string;
  now: Date;
  /** What to say when nobody waits. */
  idle: string;
  /** Said first, as in `Good morning`. */
  greeting: string;
  /** Replaces the idle line, for the quiet moments. */
  quiet?: ReactNode;
  /** Sits above the line, in the same column: the brief and the incident card. */
  above?: ReactNode;
  /** Opens the deck, at one person's card when an id is given. */
  onOpenDeck: (personId?: number) => void;
}

/**
 * The dock: where people who replied wait for you. The line and the newest reply sit on the left, and each person
 * floats above the river on a dashed line, ringed in sun.
 */
export function Dock({ people, projects, tz, now, idle, greeting, quiet, above, onOpenDeck }: DockProps) {
  const slots = useRef(new Map<number, number>());
  // A person keeps their spot while they wait; a spot opens up when they leave.
  const live = new Set(people.map((p) => p.id));
  for (const id of [...slots.current.keys()]) if (!live.has(id)) slots.current.delete(id);
  const used = new Set(slots.current.values());
  for (const p of people) {
    if (slots.current.has(p.id)) continue;
    let at = 0;
    while (used.has(at)) at++;
    used.add(at);
    slots.current.set(p.id, at);
  }

  const n = people.length;
  const many = projects.filter((p) => p.state !== 'wrapped').length > 1;
  const projectName = (p: Person) => projects.find((x) => x.id === p.projectId)?.name ?? '';
  const latest = people.reduce<Person | null>((best, p) => (!best || (p.repliedAt ?? '') > (best.repliedAt ?? '') ? p : best), null);

  return (
    <>
      <div className="stage-preview">
        {above}
        {n === 0 && quiet ? (
          quiet
        ) : (
          <p className="dock-line">
            <span className="dock-dot" aria-hidden="true" />
            {n === 0 ? idle : `${greeting}. ${n === 1 ? '1 person wants' : `${n} people want`} to talk.`}
          </p>
        )}
        {n > 0 && latest ? (
          <>
            <p key={latest.id} className="dock-bubble">{latest.lastInbound ? `“${latest.lastInbound}”` : `${latest.firstName} replied.`}</p>
            <div className="dock-open">
              <button type="button" className="dock-open-btn" onClick={() => onOpenDeck()}>
                {n === 1 ? 'Open reply' : 'Go through them'}
              </button>
              {many ? <span className="home-tag">{projectName(latest)}</span> : null}
              <span className="dock-meta">
                {[latest.name, latest.company ? `at ${latest.company}` : null].filter(Boolean).join(' ')}, {channelPhrase(latest.channel)}
                {latest.repliedAt ? `, ${formatWhen(latest.repliedAt, tz, now)}` : ''}
              </span>
            </div>
          </>
        ) : null}
      </div>

      <div className="dock-faces">
        {people.map((p) => {
          const at = slotFor(slots.current.get(p.id) ?? 0);
          const top = at.y + 36 + 8;
          const style: CSSProperties = { left: `${at.x}%`, top: at.y };
          return (
            <div key={p.id} className="dock-spot">
              <span className="dock-name" style={{ left: `${at.x}%`, top: at.y - (many ? 82 : 64) }}>
                <span className="dock-first">{p.firstName}</span>
                {many ? <span className="dock-tag">{projectName(p)}</span> : null}
              </span>
              <span className="dock-line-down" aria-hidden="true" style={{ left: `${at.x}%`, top, height: Math.max(0, RIVER_TOP + 30 - top) }} />
              <button
                type="button"
                className="dock-face"
                aria-label={`${p.name}, replied and waiting on you`}
                onClick={() => onOpenDeck(p.id)}
                style={{ ...style, background: marbleBackground(300 + p.id) }}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
