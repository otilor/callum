import { useEffect, useState } from 'react';

export interface PhoneToastData {
  id: number;
  text: string;
  /** Said for a moment once the Undo window has closed, in place of `text`. */
  then?: string;
  /** An Undo that is open for `ms` milliseconds, drawn as a ring running down. */
  undo?: { ms: number; run(): void };
}

const PLAIN_MS = 2800;

/** The one message at the bottom of the phone screen. Undo shows a ring that runs out with the undo window. */
export function PhoneToast({ toast, onGone }: { toast: PhoneToastData | null; onGone(id: number): void }) {
  const id = toast?.id;
  const ms = toast ? (toast.undo?.ms ?? PLAIN_MS) : 0;
  const then = toast?.undo ? toast.then : undefined;
  /** The id of the toast whose Undo window has closed and now says what happened. */
  const [closed, setClosed] = useState<number | null>(null);
  const settled = id !== undefined && closed === id;
  useEffect(() => {
    if (id === undefined || settled) return;
    const timer = setTimeout(() => (then ? setClosed(id) : onGone(id)), ms);
    return () => clearTimeout(timer);
  }, [id, ms, then, settled, onGone]);
  useEffect(() => {
    if (!settled || id === undefined) return;
    const timer = setTimeout(() => onGone(id), PLAIN_MS);
    return () => clearTimeout(timer);
  }, [settled, id, onGone]);

  return (
    <div className="ph-toast-slot" role="status" aria-live="polite">
      {toast ? (
        <div className="ph-toast fade-in" key={toast.id} data-undo={Boolean(toast.undo) && !settled}>
          {toast.undo && !settled ? (
            <svg className="ph-ring-svg" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <circle cx="11" cy="11" r="8.5" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2.5" />
              <circle className="ph-ring" cx="11" cy="11" r="8.5" fill="none" stroke="#FFB020" strokeWidth="2.5" strokeLinecap="round" transform="rotate(-90 11 11)" style={{ animationDuration: `${toast.undo.ms}ms` }} />
            </svg>
          ) : (
            <span className="ph-toast-dot" aria-hidden="true" />
          )}
          <span className="ph-toast-text">{settled && then ? then : toast.text}</span>
          {toast.undo && !settled ? (
            <button
              type="button"
              className="ph-toast-undo"
              onClick={() => {
                toast.undo?.run();
                onGone(toast.id);
              }}
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
