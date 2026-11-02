import type { CSSProperties } from 'react';
import type { Person } from '../../../shared/types.js';
import { Marble } from '../../ui/Marble.js';

const MAX_FACES = 24;
const ZONES: [string, number][] = [['strangers', 14.5], ['said hello', 38], ['following up', 62], ['talking', 84.5]];
const RING: Record<string, string> = { strangers: '#D5D9E4', 'said hello': '#A9B8F5', 'following up': '#6E86F2', talking: '#3F52D9' };

function hash(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Where the i-th face drifts in: three rows, a column at a time, a little loose. The column spacing lives in CSS
 * (`--face-dx`), so a narrow screen can spread the faces out instead of piling them up.
 */
function place(i: number): CSSProperties {
  const col = Math.floor(i / 3);
  const row = i % 3;
  const jitter = (hash(i * 3.1 + 1) - 0.5) * 1.2;
  const y = 0.36 + row * 0.15 + (hash(i * 5.7 + 2) - 0.5) * 0.06 + (col % 2) * 0.04;
  return { left: `calc(var(--face-x0) + ${col + 0.5} * var(--face-dx) + ${jitter.toFixed(2)}%)`, top: `${(y * 100).toFixed(1)}%` };
}

/** The river under First run: the people Callum has found, grey on the left, with a count per stage. */
export function RiverStrip({ people, planning }: { people: Person[]; planning: boolean }) {
  const faces = people.slice(0, MAX_FACES);
  return (
    <div className="fr-river-wrap" aria-hidden="true">
      <div className="fr-river">
        <svg aria-hidden="true" viewBox="0 0 1000 300" preserveAspectRatio="none">
          <defs>
            <linearGradient id="fr-bed" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#EEF0F6" stopOpacity="0" />
              <stop offset="0.07" stopColor="#EEF0F6" stopOpacity="1" />
              <stop offset="0.5" stopColor="#ECEFFB" stopOpacity="1" />
              <stop offset="0.82" stopColor="#FFF4DD" stopOpacity="1" />
              <stop offset="1" stopColor="#FFEBC2" stopOpacity="1" />
            </linearGradient>
          </defs>
          <path d="M0,50 C160,25 320,70 500,45 C680,20 840,65 1000,35 L1000,262 C840,285 680,240 500,262 C320,284 160,245 0,258 Z" fill="url(#fr-bed)" />
          <path d="M0,105 C180,82 340,130 500,104 C660,80 820,124 1000,96" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 22" />
          <path d="M0,155 C170,136 330,180 500,154 C670,130 830,174 1000,146" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 22" />
          <path d="M0,205 C180,192 340,228 500,204 C660,184 820,222 1000,196" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 22" />
        </svg>
        {faces.map((p, i) => {
          const next = planning && i < 12;
          const where = place(i);
          return (
            <Marble
              key={p.id}
              seed={300 + p.id}
              size={22}
              tone={next ? 'cool' : 'grey'}
              ring={next ? '#A9B8F5' : '#D5D9E4'}
              className={next ? 'face next-ring' : 'face'}
              style={{ marginLeft: -11, marginTop: -11, ...where, opacity: next ? 1 : 0.72, animationDelay: `${Math.min(i, 24) * 30}ms` }}
            />
          );
        })}
      </div>
      <div className="fr-zones">
        {ZONES.map(([name, at], i) => (
          <div key={name} className="fr-zone" style={{ left: `${at}%` }}>
            <strong>{i === 0 ? people.length : 0}</strong>
            <span>
              <i style={{ borderColor: RING[name] ?? '#D5D9E4' }} aria-hidden="true" />
              {name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
