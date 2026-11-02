import type { CSSProperties } from 'react';
import type { Stage } from '../../shared/types.js';

const PAL = ['#FF7A59', '#FFC145', '#4CB5F5', '#7BC67E', '#8C6CFF', '#F26CA7', '#2EC4B6', '#FF9F1C'];

function hash(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** The gradient "marble" every face is made of. The same seed always gives the same face. */
export function marbleBackground(n: number): string {
  const a = PAL[n % 8] ?? '#FF7A59';
  let b = PAL[(n * 3 + 2) % 8] ?? '#FFC145';
  let c = PAL[(n * 5 + 5) % 8] ?? '#4CB5F5';
  if (b === a) b = PAL[(n + 3) % 8] ?? b;
  if (c === a || c === b) c = PAL[(n + 6) % 8] ?? c;
  const ax = Math.round(18 + hash(n * 1.7) * 44);
  const ay = Math.round(14 + hash(n * 2.3) * 44);
  return `radial-gradient(circle at ${ax}% ${ay}%, ${b} 0 20%, transparent 58%), radial-gradient(circle at ${100 - ax}% ${100 - ay}%, ${c} 0 16%, transparent 54%), ${a}`;
}

export type MarbleTone = 'grey' | 'cool' | 'warm';

/** Grey for strangers, then colour as a person gets closer. */
const LOOK: Record<MarbleTone, { filter: string; ring: string }> = {
  grey: { filter: 'grayscale(1) brightness(1.12)', ring: '#D5D9E4' },
  cool: { filter: 'grayscale(0.62)', ring: '#A9B8F5' },
  warm: { filter: 'saturate(1.1)', ring: '#3F52D9' },
};

/** The look for each stage of the way to you: strangers grey, hello and following cool, talking in full colour. */
export function lookForStage(stage: Stage): { tone: MarbleTone; ring: string } {
  switch (stage) {
    case 'stranger': return { tone: 'grey', ring: '#D5D9E4' };
    case 'hello': return { tone: 'cool', ring: '#A9B8F5' };
    case 'following': return { tone: 'cool', ring: '#6E86F2' };
    case 'talking': return { tone: 'warm', ring: '#3F52D9' };
  }
}

export interface MarbleProps {
  seed: number;
  size?: number;
  tone?: MarbleTone;
  /** A ring colour; `null` draws none, and leaving it out uses the tone's own. */
  ring?: string | null;
  className?: string;
  style?: CSSProperties;
}

export function Marble({ seed, size = 40, tone = 'grey', ring, className, style }: MarbleProps) {
  const look = LOOK[tone];
  const ringColor = ring === undefined ? look.ring : ring;
  return (
    <span
      aria-hidden="true"
      className={className ? `marble ${className}` : 'marble'}
      style={{
        display: 'inline-block',
        flex: '0 0 auto',
        width: size,
        height: size,
        borderRadius: '50%',
        border: '2.5px solid #FFFFFF',
        boxSizing: 'border-box',
        background: marbleBackground(seed),
        filter: look.filter,
        boxShadow: ringColor ? `0 0 0 1.5px ${ringColor}` : 'none',
        ...style,
      }}
    />
  );
}
