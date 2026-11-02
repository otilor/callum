import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import './UndoToast.css';

export const UNDO_MS = 10_000;

type Kind = 'pending' | 'event' | 'info';
interface Item {
  id: number;
  kind: Kind;
  text: string;
  ms: number;
  onUndo?: () => Promise<string | void> | string | void;
  doneText?: string;
}

export interface PendingToast {
  text: string;
  /** How long Undo works. Default 10 seconds. */
  ms?: number;
  onUndo: () => Promise<string | void> | string | void;
  /** Shown briefly once the undo window has closed. */
  doneText?: string;
}

export interface UndoToasts {
  /** Put this once on the screen. */
  node: ReactNode;
  /** A send that can still be undone: a ring counts the seconds down. */
  pending(t: PendingToast): void;
  /** A plain line that goes away by itself. */
  info(text: string, ms?: number): void;
  /** Something that happened in the river. It waits its turn while an undo is pending. */
  event(text: string, ms?: number): void;
  /** Take whatever is showing away. */
  clear(): void;
}

function Ring({ ms, toastKey }: { ms: number; toastKey: number }) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r="8.5" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2.5" />
      <circle
        key={toastKey}
        className="undo-ring"
        cx="11" cy="11" r="8.5" fill="none" stroke="#FFB020" strokeWidth="2.5" strokeLinecap="round" transform="rotate(-90 11 11)"
        style={{ strokeDasharray: 53.41, strokeDashoffset: 0, animationDuration: `${ms}ms` }}
      />
    </svg>
  );
}

/** Holds the one toast on screen and the ones waiting for it. Plain timers, so the screens stay simple. */
class ToastController {
  current: Item | null = null;
  alive = true;
  private queue: Item[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private next = 1;

  constructor(private readonly set: (item: Item | null) => void) {}

  id(): number {
    return this.next++;
  }

  private show(item: Item | null): void {
    clearTimeout(this.timer);
    this.current = item;
    this.set(item);
  }

  present(item: Item): void {
    this.show(item);
    this.timer = setTimeout(() => this.expire(item), item.ms);
  }

  private expire(item: Item): void {
    if (!this.alive) return;
    if (item.kind === 'pending' && item.doneText) {
      this.present({ id: this.id(), kind: 'info', text: item.doneText, ms: 2600 });
      return;
    }
    this.show(null);
    this.flushSoon(item.kind === 'pending' ? 600 : 300);
  }

  private flushSoon(delay: number): void {
    if (this.queue.length === 0) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const queued = this.queue.shift();
      if (queued && this.alive) this.present(queued);
    }, delay);
  }

  /** A line that is not a send waits while an undo is pending, so Undo never moves from under the cursor. */
  offer(item: Item): void {
    if (this.current?.kind === 'pending') this.queue.push(item);
    else this.present(item);
  }

  async undo(): Promise<void> {
    const item = this.current;
    if (!item || item.kind !== 'pending' || !item.onUndo) return;
    this.show(null);
    let line: string | void;
    try {
      line = await item.onUndo();
    } catch {
      this.flushSoon(300);
      return;
    }
    if (!this.alive) return;
    if (typeof line === 'string' && line) this.present({ id: this.id(), kind: 'info', text: line, ms: 2600 });
    else this.flushSoon(300);
  }

  clear(): void {
    this.queue = [];
    this.show(null);
  }

  dispose(): void {
    this.alive = false;
    clearTimeout(this.timer);
  }
}

/**
 * The toast of Home and Day one: a dark pill at the top. A send shows a 10-second ring and Undo. Events that arrive while
 * an undo is pending are queued and shown after it.
 */
export function useUndoToasts(): UndoToasts {
  const [current, setCurrent] = useState<Item | null>(null);
  const ctl = useRef<ToastController | null>(null);
  if (!ctl.current) ctl.current = new ToastController(setCurrent);
  const c = ctl.current;

  useEffect(() => {
    c.alive = true;
    return () => c.dispose();
  }, [c]);

  // The calls never change, so screens can list them as effect dependencies.
  const calls = useMemo(
    () => ({
      // A newer send replaces the one showing; the older one still goes out when its own window closes.
      pending: (t: PendingToast) =>
        c.present({ id: c.id(), kind: 'pending', text: t.text, ms: t.ms ?? UNDO_MS, onUndo: t.onUndo, ...(t.doneText ? { doneText: t.doneText } : {}) }),
      info: (text: string, ms = 3200) => c.offer({ id: c.id(), kind: 'info', text, ms }),
      event: (text: string, ms = 4200) => c.offer({ id: c.id(), kind: 'event', text, ms }),
      clear: () => c.clear(),
    }),
    [c],
  );

  const node = (
    <div className="undo-wrap" aria-live="polite">
      {current ? (
        <div key={current.id} className={`undo-toast ${current.kind === 'pending' ? 'undo-pending' : ''} ${current.id % 2 ? 'toast-a' : 'toast-b'}`}>
          {current.kind === 'pending' ? <Ring ms={current.ms} toastKey={current.id} /> : null}
          {current.kind === 'event' ? <span className="undo-dot" aria-hidden="true" /> : null}
          <span className="undo-text">{current.text}</span>
          {current.kind === 'pending' ? (
            <button type="button" className="undo-btn" onClick={() => void c.undo()}>
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
  return { node, ...calls };
}
