import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import './UndoToast.css';

export const UNDO_MS = 10_000;

/**
 * How long Undo still works for a send, by the server's own clock: the window it gave (`undoUntil` less `updatedAt`), less
 * the time the call took from `startedAt` (a `performance.now()` reading from before it). 0 when the window is already shut.
 */
export function undoMsLeft(item: { undoUntil: string | null; updatedAt: string; createdAt: string }, startedAt: number): number {
  if (!item.undoUntil) return 0;
  const opened = Date.parse(item.undoUntil) - Date.parse(item.updatedAt || item.createdAt);
  if (!Number.isFinite(opened)) return 0;
  return Math.max(0, Math.min(UNDO_MS, opened - (performance.now() - startedAt)));
}

type Kind = 'pending' | 'event' | 'info';
interface Item {
  id: number;
  kind: Kind;
  text: string;
  ms: number;
  /** When a send's window closes (ms since the epoch), and how far into it the ring starts when it comes on screen late. */
  until: number;
  lead: number;
  onUndo?: () => Promise<string | void> | string | void;
  doneText?: string;
  failText?: string;
}

export interface PendingToast {
  text: string;
  /** How long Undo works. Default 10 seconds. */
  ms?: number;
  onUndo: () => Promise<string | void> | string | void;
  /** Shown briefly once the undo window has closed. */
  doneText?: string;
  /** Said when Undo could not take the send back. Default: `Too late. It already went out.` */
  failText?: string;
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
  /** True while a send can still be undone. Leaving the screen then would lose the Undo. */
  undoing: boolean;
}

/** Most undo toasts on screen at once; a fourth waits for a slot, and its window keeps running while it waits. */
const MAX_VISIBLE = 3;

function Ring({ ms, lead, toastKey }: { ms: number; lead: number; toastKey: number }) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r="8.5" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2.5" />
      <circle
        key={toastKey}
        className="undo-ring"
        cx="11" cy="11" r="8.5" fill="none" stroke="#FFB020" strokeWidth="2.5" strokeLinecap="round" transform="rotate(-90 11 11)"
        style={{ strokeDasharray: 53.41, strokeDashoffset: 0, animationDuration: `${ms}ms`, animationDelay: `${-lead}ms` }}
      />
    </svg>
  );
}

interface View { stack: Item[]; line: Item | null }

/**
 * Holds the sends that can still be undone (each with its own ring and its own clock) and one plain line below them.
 * A send never leaves before its window closes, whatever else arrives. Plain timers, so the screens stay simple.
 */
class ToastController {
  alive = true;
  private stack: Item[] = [];
  private line: Item | null = null;
  /** Lines that wait while a send can be undone, and sends beyond the visible three. */
  private waiting: Item[] = [];
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private lineTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private next = 1;

  constructor(private readonly set: (view: View) => void) {}

  id(): number {
    return this.next++;
  }

  get undoing(): boolean {
    return this.stack.length > 0;
  }

  private publish(): void {
    if (this.alive) this.set({ stack: [...this.stack], line: this.line });
  }

  private showLine(item: Item | null): void {
    clearTimeout(this.lineTimer);
    this.line = item;
    if (item) this.lineTimer = setTimeout(() => {
      if (this.line === item) {
        this.line = null;
        this.publish();
        this.flushSoon(300);
      }
    }, item.ms);
    this.publish();
  }

  /** A send enters the stack with the time it has left: a send that waited for a slot is already part-way through its window. */
  private open(item: Item): void {
    const left = Math.max(0, item.until - Date.now());
    const shown: Item = { ...item, lead: Math.max(0, item.ms - left) };
    this.stack.push(shown);
    this.timers.set(shown.id, setTimeout(() => this.expire(shown.id), left));
    this.publish();
  }

  pending(item: Item): void {
    if (this.stack.length < MAX_VISIBLE) this.open(item);
    else this.waiting.push(item);
  }

  private expire(id: number): void {
    this.timers.delete(id);
    const at = this.stack.findIndex((i) => i.id === id);
    if (at < 0 || !this.alive) return;
    const [item] = this.stack.splice(at, 1);
    this.publish();
    if (item?.doneText) this.showLine({ id: this.id(), kind: 'info', text: item.doneText, ms: 2600, until: 0, lead: 0 });
    this.flushSoon(300);
  }

  /** Sends waiting for a slot come in at once; lines come in when no send is showing. */
  private flushSoon(delay: number): void {
    if (this.waiting.length === 0) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      if (!this.alive) return;
      while (this.stack.length < MAX_VISIBLE) {
        const at = this.waiting.findIndex((i) => i.kind === 'pending');
        if (at < 0) break;
        const [queued] = this.waiting.splice(at, 1);
        if (queued) this.open(queued);
      }
      if (this.stack.length === 0 && !this.line) {
        const queued = this.waiting.shift();
        if (queued) this.showLine(queued);
      }
    }, delay);
  }

  /** A line that is not a send waits while an undo is pending, so Undo never moves from under the cursor. */
  offer(item: Item): void {
    if (this.stack.length > 0 || this.waiting.length > 0) this.waiting.push(item);
    else this.showLine(item);
  }

  async undo(id: number): Promise<void> {
    const at = this.stack.findIndex((i) => i.id === id);
    const item = this.stack[at];
    if (!item || !item.onUndo) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.stack.splice(at, 1);
    this.publish();
    let line: string | void;
    try {
      line = await item.onUndo();
    } catch {
      // A failed Undo is never silent: the person pressed it and needs to know the message went.
      if (this.alive) this.showLine({ id: this.id(), kind: 'info', text: item.failText ?? 'Too late. It already went out.', ms: 3600, until: 0, lead: 0 });
      this.flushSoon(300);
      return;
    }
    if (!this.alive) return;
    if (typeof line === 'string' && line) this.showLine({ id: this.id(), kind: 'info', text: line, ms: 2600, until: 0, lead: 0 });
    this.flushSoon(300);
  }

  clear(): void {
    this.waiting = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.stack = [];
    this.showLine(null);
  }

  dispose(): void {
    this.alive = false;
    for (const t of this.timers.values()) clearTimeout(t);
    clearTimeout(this.lineTimer);
    clearTimeout(this.flushTimer);
  }
}

/**
 * The toasts of Home and Day one: dark pills at the top. Each send shows a 10-second ring and Undo, and up to three stack,
 * newest below. Events that arrive while an undo is pending are queued and shown after it.
 */
export function useUndoToasts(): UndoToasts {
  const [view, setView] = useState<View>({ stack: [], line: null });
  const ctl = useRef<ToastController | null>(null);
  if (!ctl.current) ctl.current = new ToastController(setView);
  const c = ctl.current;

  useEffect(() => {
    c.alive = true;
    return () => c.dispose();
  }, [c]);

  // The calls never change, so screens can list them as effect dependencies.
  const calls = useMemo(
    () => ({
      pending: (t: PendingToast) => {
        const ms = t.ms ?? UNDO_MS;
        c.pending({ id: c.id(), kind: 'pending', text: t.text, ms, until: Date.now() + ms, lead: 0, onUndo: t.onUndo, ...(t.doneText ? { doneText: t.doneText } : {}), ...(t.failText ? { failText: t.failText } : {}) });
      },
      info: (text: string, ms = 3200) => c.offer({ id: c.id(), kind: 'info', text, ms, until: 0, lead: 0 }),
      event: (text: string, ms = 4200) => c.offer({ id: c.id(), kind: 'event', text, ms, until: 0, lead: 0 }),
      clear: () => c.clear(),
    }),
    [c],
  );

  const shown = [...view.stack, ...(view.line ? [view.line] : [])];
  const node = (
    <div className="undo-wrap" aria-live="polite">
      {shown.map((item) => (
        <div key={item.id} className={`undo-toast ${item.kind === 'pending' ? 'undo-pending' : ''} ${item.id % 2 ? 'toast-a' : 'toast-b'}`}>
          {item.kind === 'pending' ? <Ring ms={item.ms} lead={item.lead} toastKey={item.id} /> : null}
          {item.kind === 'event' ? <span className="undo-dot" aria-hidden="true" /> : null}
          <span className="undo-text">{item.text}</span>
          {item.kind === 'pending' ? (
            <button type="button" className="undo-btn" onClick={() => void c.undo(item.id)}>
              Undo
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
  return { node, ...calls, undoing: view.stack.length > 0 };
}
