import { useEffect, useRef, type ReactNode } from 'react';
import type { Person } from '../../../shared/types.js';
import { Marble, lookForStage } from '../../ui/Marble.js';
import { Wordmark } from '../../ui/Wordmark.js';
import './Leave.css';

const MAX_PER_STAGE = 8;
const ZONES: Record<Person['stage'], { x0: number; x1: number; size: number }> = {
  stranger: { x0: 5, x1: 24, size: 20 },
  hello: { x0: 28, x1: 48, size: 24 },
  following: { x0: 52, x1: 72, size: 28 },
  talking: { x0: 76, x1: 93, size: 34 },
};
const STAGES: Person['stage'][] = ['stranger', 'hello', 'following', 'talking'];

function hash(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** The river along the bottom of the page: everyone where they were, resting while Callum is paused. */
function RestingRiver({ people, gone, still }: { people: Person[]; gone: boolean; still: boolean }) {
  return (
    <div className="lv-river" aria-hidden="true">
      <svg viewBox="0 0 1000 300" preserveAspectRatio="none">
        <defs>
          <linearGradient id="lv-bed" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#EEF0F6" stopOpacity="0" />
            <stop offset="0.07" stopColor="#EEF0F6" stopOpacity="1" />
            <stop offset="0.5" stopColor="#ECEFFB" stopOpacity="1" />
            <stop offset="0.82" stopColor="#FFF4DD" stopOpacity="1" />
            <stop offset="1" stopColor="#FFEBC2" stopOpacity="1" />
          </linearGradient>
        </defs>
        <path
          className="lv-bed"
          style={{ opacity: gone ? 0.45 : 1 }}
          d="M0,50 C160,25 320,70 500,45 C680,20 840,65 1000,35 L1000,262 C840,285 680,240 500,262 C320,284 160,245 0,258 Z"
          fill="url(#lv-bed)"
        />
        <path className="lv-current" data-still={still || gone} d="M0,105 C180,82 340,130 500,104 C660,80 820,124 1000,96" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
        <path className="lv-current lv-current-slow" data-still={still || gone} d="M0,155 C170,136 330,180 500,154 C670,130 830,174 1000,146" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
        <path className="lv-current" data-still={still || gone} d="M0,205 C180,192 340,228 500,204 C660,184 820,222 1000,196" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {STAGES.flatMap((stage) => {
        const zone = ZONES[stage];
        const here = people.filter((p) => p.stage === stage).slice(0, MAX_PER_STAGE);
        const cols = Math.max(1, Math.ceil(here.length / 2));
        const colWidth = (zone.x1 - zone.x0) / cols;
        const look = lookForStage(stage);
        return here.map((p, k) => {
          const col = Math.floor(k / 2);
          const x = zone.x0 + (col + 0.5) * colWidth + (hash(p.id * 3.1 + 1) - 0.5) * colWidth * 0.4;
          const y = 0.4 + (k % 2) * 0.24 + (col % 2) * 0.06 + (hash(p.id * 5.7 + 2) - 0.5) * 0.05;
          const faded = gone ? (stage === 'talking' ? 0.35 : 0.1) : still ? 0.45 : stage === 'stranger' ? 0.62 : stage === 'hello' ? 0.9 : 1;
          return (
            <Marble
              key={p.id}
              seed={300 + p.id}
              size={zone.size}
              tone={still || gone ? 'grey' : look.tone}
              ring={still || gone ? '#E7E9F0' : look.ring}
              className="lv-face"
              style={{ position: 'absolute', left: `${x.toFixed(2)}%`, top: `${(y * 100).toFixed(1)}%`, marginLeft: -zone.size / 2, marginTop: -zone.size / 2, opacity: faded }}
            />
          );
        });
      })}
    </div>
  );
}

export interface LeaveFrameProps {
  people: Person[];
  /** The river rests: a break, or a wrap. */
  still?: boolean;
  /** Everyone has gone: wrapped. */
  gone?: boolean;
  /** Shows `Back to the river` and calls this. */
  onBack?: () => void;
  /** The sun dot goes grey once Callum has wrapped up. */
  children: ReactNode;
  /** Names the heading that the page is about, so focus can move to it when the view changes. */
  viewKey: string;
}

/** The page the break and the wrap-up share: wordmark, a way back, the view, and the river underneath. */
export function LeaveFrame({ people, still = false, gone = false, onBack, children, viewKey }: LeaveFrameProps) {
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [viewKey]);

  return (
    <div className="lv-root" data-still={still || gone} data-gone={gone}>
      <header className="lv-bar">
        <span className="lv-mark" data-gone={gone}>
          <Wordmark />
        </span>
        {onBack ? (
          <button type="button" className="lv-back" onClick={onBack}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            Back to the river
          </button>
        ) : null}
      </header>
      <main className="lv-main" ref={main}>
        {children}
      </main>
      <RestingRiver people={people} still={still} gone={gone} />
    </div>
  );
}
