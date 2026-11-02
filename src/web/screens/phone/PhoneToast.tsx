import { useEffect } from 'react';

export interface PhoneToastData {
  id: number;
  text: string;
  /** An Undo that is open for `ms` milliseconds, drawn as a ring running down. */
  undo?: { ms: number; run(): void };
}

const PLAIN_MS = 2800;

/** The one message at the bottom of the phone screen. Undo shows a ring that runs out with the undo window. */
export function PhoneToast({ toast, onGone }: { toast: PhoneToastData | null; onGone(id: number): void }) {
  const id = toast?.id;
  const ms = toast ? (toast.undo?.ms ?? PLAIN_MS) : 0;
  useEffect(() => {
    if (id === undefined) return;
    const timer = setTimeout(() => onGone(id), ms);
    return () => clearTimeout(timer);
  }, [id, ms, onGone]);

  return (
    <div className="ph-toast-slot" role="status" aria-live="polite">
      {toast ? (
        <div className="ph-toast fade-in" key={toast.id} data-undo={Boolean(toast.undo)}>
          {toast.undo ? (
            <svg className="ph-ring-svg" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <circle cx="11" cy="11" r="8.5" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2.5" />
              <circle className="ph-ring" cx="11" cy="11" r="8.5" fill="none" stroke="#FFB020" strokeWidth="2.5" strokeLinecap="round" transform="rotate(-90 11 11)" style={{ animationDuration: `${toast.undo.ms}ms` }} />
            </svg>
          ) : (
            <span className="ph-toast-dot" aria-hidden="true" />
          )}
          <span className="ph-toast-text">{toast.text}</span>
          {toast.undo ? (
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
