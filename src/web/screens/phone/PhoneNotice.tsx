import { useCallback, useEffect, useRef, useState } from 'react';

export interface NoticeOptions {
  /** Shows an Undo button for as long as the notice stays. */
  undo?: () => void | Promise<void>;
  /** How long it stays, in milliseconds. */
  ms?: number;
}
export type Notify = (text: string, options?: NoticeOptions) => void;

interface Notice { id: number; text: string; ms: number; undo?: () => void | Promise<void> }

/**
 * One line at the bottom of the phone, above the bar, with an optional Undo. A plain line is replaced by a newer one.
 * A line with an Undo is never dropped: whatever comes while it is showing waits behind it.
 */
export function usePhoneNotice(): { notice: Notice | null; notify: Notify; clear(id: number): void } {
  const [notice, setNotice] = useState<Notice | null>(null);
  const current = useRef<Notice | null>(null);
  const queue = useRef<Notice[]>([]);
  const next = useRef(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useRef<(id: number) => void>(() => undefined);

  const show = useCallback((n: Notice | null) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    current.current = n;
    setNotice(n);
    if (n) timer.current = setTimeout(() => clear.current(n.id), n.ms);
  }, []);

  clear.current = (id: number) => {
    if (current.current?.id !== id) return;
    show(queue.current.shift() ?? null);
  };

  const notify = useCallback<Notify>(
    (text, options) => {
      const n: Notice = { id: next.current++, text, ms: options?.ms ?? (options?.undo ? 10_000 : 3_200), ...(options?.undo ? { undo: options.undo } : {}) };
      if (current.current?.undo) queue.current.push(n);
      else show(n);
    },
    [show],
  );

  const stable = useCallback((id: number) => clear.current(id), []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { notice, notify, clear: stable };
}

export function PhoneNotice({ notice, onDone }: { notice: Notice | null; onDone(id: number): void }) {
  const [taken, setTaken] = useState<number | null>(null);
  return (
    <p className="pa-notice" aria-live="polite">
      {notice ? (
        <span key={notice.id} className="pa-notice-pill fade-in">
          <span className="pa-notice-dot" aria-hidden="true" />
          {notice.text}
          {notice.undo ? (
            <button
              type="button"
              className="pa-notice-undo"
              disabled={taken === notice.id}
              onClick={async () => {
                setTaken(notice.id);
                // Whatever the undo says is queued behind this line, and this line goes once the undo has finished.
                try {
                  await notice.undo?.();
                } finally {
                  onDone(notice.id);
                }
              }}
            >
              Undo
            </button>
          ) : null}
        </span>
      ) : null}
    </p>
  );
}
