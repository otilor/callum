import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import type { Channel, Person, Stage } from '../../shared/types.js';
import { marbleBackground } from '../ui/Marble.js';
import { riverLayout, STAGE_LABEL, STAGE_ORDER, type RiverItem } from './layout.js';
import './River.css';

/** How a face is dressed for the step Day one is on. */
export type FaceMark = 'current' | 'next' | 'ok' | 'skipped';

export interface RiverProps {
  people: Person[];
  /** The water flows while Callum is running and stands still when it is not. */
  running: boolean;
  /** Channels that are paused: their faces go grey with a pause badge. */
  still: Channel[];
  /** Opens a person. Without it the faces are only pictures. */
  onFace?: (person: Person) => void;
  /** A smaller river, for under Day one and for narrow screens. */
  compact?: boolean;
  /** Decides when a snoozed person is due back. Defaults to the clock. */
  now?: () => Date;
  /** The person whose popover is open. */
  selectedId?: number | null;
  /** Rendered next to the selected face, above it. */
  popover?: ReactNode;
  /** Faces with a message on its way: they show a pulsing sun badge. */
  sendingIds?: number[];
  marks?: Record<number, FaceMark>;
  /** Drawn inside the water (a banner, the place replies land). */
  overlay?: ReactNode;
  onGroup?: (stage: Stage) => void;
  /** Height of the water in px. Default 280, or 160 when compact. */
  height?: number;
  className?: string;
}

interface Look { filter: string; opacity: number; ring: string; ringWidth: number }

const LOOK: Record<Stage, Look> = {
  stranger: { filter: 'grayscale(1) brightness(1.12)', opacity: 0.62, ring: '#D5D9E4', ringWidth: 1.5 },
  hello: { filter: 'grayscale(0.62)', opacity: 0.9, ring: '#A9B8F5', ringWidth: 1.5 },
  following: { filter: 'grayscale(0.28)', opacity: 1, ring: '#6E86F2', ringWidth: 2 },
  talking: { filter: 'none', opacity: 1, ring: '#3F52D9', ringWidth: 2 },
};

const CENTERS = [14.5, 38, 62, 84.5];

function useSize(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** A face is a button when it can be opened, and only a picture when it cannot. */
function Face({ onClick, children, ...rest }: { onClick: (() => void) | undefined; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  if (onClick) {
    return (
      <button type="button" onClick={onClick} {...rest}>
        {children}
      </button>
    );
  }
  return (
    <span role="img" {...rest}>
      {children}
    </span>
  );
}

function PauseGlyph({ size = 7 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" aria-hidden="true">
      <rect x="1" y="0.5" width="2" height="7" rx="0.8" fill="#FFFFFF" />
      <rect x="5" y="0.5" width="2" height="7" rx="0.8" fill="#FFFFFF" />
    </svg>
  );
}

function faceStyle(item: Extract<RiverItem, { kind: 'face' }>, width: number, h: number, still: boolean, mark: FaceMark | undefined, selected: boolean): CSSProperties {
  const p = item.person;
  const look = LOOK[p.stage];
  let filter = look.filter;
  let opacity = look.opacity;
  let ring = look.ring;
  let ringWidth = look.ringWidth;
  if (still && p.stage !== 'talking') {
    filter = 'grayscale(1) brightness(1.05)';
    opacity = 0.5;
    ring = '#D5D9E4';
    ringWidth = 1.5;
  }
  if (p.status === 'held') {
    filter = 'grayscale(1)';
    opacity = 0.32;
  }
  let shadow = `0 0 0 ${ringWidth}px ${ring}`;
  if (mark === 'ok') {
    filter = 'grayscale(0.62)';
    opacity = 1;
    shadow = '0 0 0 2px #1D2140';
  } else if (mark === 'skipped') {
    filter = 'grayscale(1)';
    opacity = 0.18;
    shadow = 'none';
  } else if (mark === 'current') {
    filter = 'grayscale(0.4)';
    opacity = 1;
    shadow = '0 0 0 2.5px #3F52D9';
  } else if (mark === 'next') {
    filter = 'grayscale(0.62)';
    opacity = 1;
    shadow = '0 0 0 2px #A9B8F5';
  }
  if (selected) shadow += ', 0 0 0 7px rgba(63,82,217,0.18)';
  const half = item.size / 2;
  return {
    left: `${((item.x / width) * 100).toFixed(2)}%`,
    top: `${((item.y / h) * 100).toFixed(2)}%`,
    width: item.size,
    height: item.size,
    margin: `-${half}px 0 0 -${half}px`,
    background: marbleBackground(300 + p.id),
    filter,
    opacity,
    boxShadow: shadow,
    animationDelay: `${Math.round((item.x / width) * 1100)}ms`,
  };
}

/**
 * The river of faces. Strangers are grey on the left; colour and size grow lane by lane to Talking on the right.
 * Faces slide to the next lane when a person moves on, and the water stands still when Callum is not running.
 */
export function River({
  people, running, still, onFace, compact = false, now, selectedId = null, popover, sendingIds, marks, overlay, onGroup, height, className,
}: RiverProps) {
  const h = height ?? (compact ? 160 : 280);
  const ref = useRef<HTMLDivElement>(null);
  const width = useSize(ref, 1000);
  const bedId = useId();
  const clock = now ?? (() => new Date());
  const layout = useMemo(
    () => riverLayout(people, width, h, { now: clock() }),
    // The clock is read when people or the size change; a snoozed person comes back on the next state update.
    [people, width, h],
  );

  // A face that moves to another lane gets a ring that spreads once, so the eye follows it.
  const lastStage = useRef(new Map<number, Stage>());
  const [pinged, setPinged] = useState<{ ids: number[]; key: number }>({ ids: [], key: 0 });
  useEffect(() => {
    const moved: number[] = [];
    const seen = new Map<number, Stage>();
    for (const p of people) {
      seen.set(p.id, p.stage);
      const before = lastStage.current.get(p.id);
      if (before && before !== p.stage) moved.push(p.id);
    }
    lastStage.current = seen;
    if (moved.length > 0) setPinged((prev) => ({ ids: moved, key: prev.key + 1 }));
  }, [people]);

  const stillSet = new Set<Channel>(still);
  const sending = new Set(sendingIds ?? []);
  const selected = layout.items.find((i): i is Extract<RiverItem, { kind: 'face' }> => i.kind === 'face' && i.person.id === selectedId);
  let popoverStyle: CSSProperties | undefined;
  if (selected && popover) {
    const pct = (selected.x / width) * 100;
    const tx = pct < 16 ? '-12%' : pct > 84 ? '-88%' : '-50%';
    popoverStyle = { left: `${pct.toFixed(2)}%`, top: `calc(${((selected.y / h) * 100).toFixed(2)}% - ${(selected.size / 2 + 14).toFixed(1)}px)`, transform: `translate(${tx}, -100%)` };
  }

  const cls = ['river', running ? 'is-running' : 'is-still', compact ? 'is-compact' : '', className].filter(Boolean).join(' ');
  return (
    <div className={cls} role="group" aria-label="Your river" ref={ref}>
      <div className="river-field" style={{ height: h }}>
        <svg className="river-bed" aria-hidden="true" viewBox="0 0 1000 300" preserveAspectRatio="none">
          <defs>
            <linearGradient id={`${bedId}-bed`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#EEF0F6" stopOpacity="0" />
              <stop offset="0.07" stopColor="#EEF0F6" stopOpacity="1" />
              <stop offset="0.5" stopColor="#ECEFFB" stopOpacity="1" />
              <stop offset="0.82" stopColor="#FFF4DD" stopOpacity="1" />
              <stop offset="1" stopColor="#FFEBC2" stopOpacity="1" />
            </linearGradient>
          </defs>
          <path d="M0,50 C160,25 320,70 500,45 C680,20 840,65 1000,35 L1000,262 C840,285 680,240 500,262 C320,284 160,245 0,258 Z" fill={`url(#${bedId}-bed)`} />
          <path className="current" d="M0,105 C180,82 340,130 500,104 C660,80 820,124 1000,96" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
          <path className="current current-slow" d="M0,155 C170,136 330,180 500,154 C670,130 830,174 1000,146" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
          <path className="current" d="M0,205 C180,192 340,228 500,204 C660,184 820,222 1000,196" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
        </svg>

        {overlay}

        {layout.items.map((item) => {
          if (item.kind === 'group') {
            const half = item.size / 2;
            const look = LOOK[item.stage];
            return (
              <button
                key={`group-${item.stage}`}
                type="button"
                className="river-group"
                aria-label={`${item.count} ${item.count === 1 ? 'person' : 'people'}, ${STAGE_LABEL[item.stage]}`}
                onClick={() => onGroup?.(item.stage)}
                style={{
                  left: `${((item.x / width) * 100).toFixed(2)}%`, top: `${((item.y / h) * 100).toFixed(2)}%`, width: item.size, height: item.size,
                  margin: `-${half}px 0 0 -${half}px`, boxShadow: `0 0 0 2px ${look.ring}`,
                }}
              >
                <span className="river-group-count">{item.count}</span>
              </button>
            );
          }
          const p = item.person;
          const isStill = p.channel !== null && stillSet.has(p.channel);
          const mark = marks?.[p.id];
          const isSending = sending.has(p.id);
          const pinging = pinged.ids.includes(p.id);
          const dressedStill = isStill && p.stage !== 'talking' && p.status !== 'held';
          return (
            <Face
              key={p.id}
              onClick={onFace ? () => onFace(p) : undefined}
              className={['river-face', dressedStill ? 'going-still' : '', mark === 'current' ? 'cur-ring' : '', mark === 'next' ? 'next-ring' : ''].filter(Boolean).join(' ')}
              aria-label={`${p.name}, ${STAGE_LABEL[p.stage]}`}
              {...(dressedStill ? { 'aria-description': `${p.channel === 'linkedin' ? 'LinkedIn' : p.channel === 'x' ? 'X' : 'Email'} is paused` } : {})}
              data-stage={p.stage}
              data-id={p.id}
              style={faceStyle(item, width, h, dressedStill, mark, selectedId === p.id)}
            >
              {pinging ? <span key={pinged.key} aria-hidden="true" className={pinged.key % 2 ? 'ping-a' : 'ping-b'} /> : null}
              {dressedStill ? <span aria-hidden="true" className="river-badge river-badge-pause"><PauseGlyph /></span> : null}
              {isSending ? <span aria-hidden="true" className="river-badge river-badge-sending" /> : null}
              {!isSending && p.stage === 'talking' && p.badge === 'sent' ? (
                <span aria-hidden="true" className="river-badge">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                </span>
              ) : null}
              {!isSending && p.stage === 'talking' && p.badge === 'booked' ? (
                <span aria-hidden="true" className="river-badge river-badge-booked">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#1D2140" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M3.5 10h17" /></svg>
                </span>
              ) : null}
            </Face>
          );
        })}

        {selected && popover ? <div className="river-popover" style={popoverStyle}>{popover}</div> : null}
      </div>

      <div className="river-zones">
        {STAGE_ORDER.map((stage, i) => (
          <div key={stage} className="river-zone" style={{ left: `${CENTERS[i]}%` }}>
            <strong>{layout.counts[stage]}</strong>
            <span>
              <i style={{ borderColor: LOOK[stage].ring }} aria-hidden="true" />
              {STAGE_LABEL[stage]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
