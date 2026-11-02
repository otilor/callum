import type { Stage } from '../../../shared/types.js';
import { Marble } from '../../ui/Marble.js';
import './AddPeople.css';

/** Anyone who can be a face in the river. */
export interface RiverFace { id: number; stage: Stage }

interface Zone { name: string; stages: Stage[]; x0: number; x1: number; size: number; ring: string; filter: string; opacity: number }
const ZONES: Zone[] = [
  { name: 'strangers', stages: ['stranger'], x0: 4, x1: 25, size: 18, ring: '#D5D9E4', filter: 'grayscale(1) brightness(1.12)', opacity: 0.62 },
  { name: 'said hello', stages: ['hello'], x0: 29, x1: 49, size: 22, ring: '#A9B8F5', filter: 'grayscale(0.62)', opacity: 0.9 },
  { name: 'following up', stages: ['following'], x0: 53, x1: 72, size: 28, ring: '#6E86F2', filter: 'grayscale(0.28)', opacity: 1 },
  { name: 'talking', stages: ['talking'], x0: 76, x1: 94, size: 34, ring: '#3F52D9', filter: 'none', opacity: 1 },
];
const MAX_PER_ZONE = 24;

function hash(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** The river under the sheet: everyone in the project by how far along they are, with a count for each stretch. */
export function River({ people, lit, blank = false }: { people: RiverFace[]; lit?: boolean; blank?: boolean }) {
  return (
    <div className="ap-river-wrap" aria-hidden="true">
      <div className="ap-river">
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none">
          <defs>
            <linearGradient id="ap-bed" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#EEF0F6" stopOpacity="0" />
              <stop offset="0.07" stopColor="#EEF0F6" stopOpacity="1" />
              <stop offset="0.5" stopColor="#ECEFFB" stopOpacity="1" />
              <stop offset="0.82" stopColor="#FFF4DD" stopOpacity="1" />
              <stop offset="1" stopColor="#FFEBC2" stopOpacity="1" />
            </linearGradient>
          </defs>
          <path d="M0,22 C160,6 320,36 500,18 C680,2 840,32 1000,12 L1000,188 C840,200 680,172 500,188 C320,202 160,176 0,184 Z" fill="url(#ap-bed)" />
          <path className="ap-current" d="M0,70 C180,54 340,88 500,70 C660,54 820,84 1000,64" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
          <path className="ap-current ap-current-slow" d="M0,130 C170,116 330,148 500,128 C670,110 830,142 1000,122" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
        </svg>
        {ZONES.map((z, zi) => {
          const here = people.filter((p) => z.stages.includes(p.stage)).slice(0, MAX_PER_ZONE);
          const cols = Math.max(1, Math.ceil(here.length / 4));
          const cw = (z.x1 - z.x0) / Math.max(cols, 3);
          return here.map((p, k) => {
            const col = Math.floor(k / 4);
            const row = k % 4;
            const x = z.x0 + (col + 0.5) * cw + (hash(p.id * 3.1 + 1) - 0.5) * cw * 0.4;
            const y = here.length <= 2 ? 34 + k * 30 : 22 + row * 18 + (col % 2) * 6 + (hash(p.id * 5.7 + 2) - 0.5) * 5;
            return (
              <Marble
                key={p.id}
                seed={300 + p.id}
                size={z.size}
                ring={z.ring}
                className="ap-face"
                style={{
                  position: 'absolute', left: `${x.toFixed(2)}%`, top: `${y.toFixed(1)}%`, marginLeft: -z.size / 2, marginTop: -z.size / 2,
                  filter: z.filter, opacity: z.opacity, border: '2px solid #FFFFFF', animationDelay: `${Math.min(zi * 8 + k, 40) * 22}ms`,
                }}
              />
            );
          });
        })}
      </div>
      <div className="ap-lanes">
        {ZONES.map((z, zi) => (
          <span key={z.name} className="ap-lane" style={{ left: `${((z.x0 + z.x1) / 2).toFixed(1)}%` }}>
            <span className="ap-lane-n" data-lit={zi === 0 && lit === true}>{blank ? '\u00a0' : people.filter((p) => z.stages.includes(p.stage)).length}</span>
            <span className="ap-lane-name">
              <i style={zi === 0 ? { border: '2px solid #C5CAD6' } : { background: z.ring }} />
              {z.name}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

