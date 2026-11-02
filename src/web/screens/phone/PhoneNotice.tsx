import { useCallback, useEffect, useRef, useState } from 'react';

export interface NoticeOptions {
  /** Shows an Undo button for as long as the notice stays. */
  undo?: () => void | Promise<void>;
  /** How long it stays, in milliseconds. */
  ms?: number;
}
export type Notify = (text: string, options?: NoticeOptions) => void;

interface Notice { id: number; text: string; undo?: () => void | Promise<void> }

/** One line at the bottom of the phone, above the bar, with an optional Undo. A newer line replaces the older one. */
export function usePhoneNotice(): { notice: Notice | null; notify: Notify; clear(id: number): void } {
  const [notice, setNotice] = useState<Notice | null>(null);
  const next = useRef(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback((id: number) => {
    setNotice((cur) => (cur?.id === id ? null : cur));
  }, []);

  const notify = useCallback<Notify>(
    (text, options) => {
      if (timer.current) clearTimeout(timer.current);
      const id = next.current++;
      setNotice({ id, text, ...(options?.undo ? { undo: options.undo } : {}) });
      timer.current = setTimeout(() => clear(id), options?.ms ?? (options?.undo ? 10_000 : 3_200));
    },
    [clear],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { notice, notify, clear };
}

export function PhoneNotice({ notice, onDone }: { notice: Notice | null; onDone(id: number): void }) {
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
              onClick={() => {
                const undo = notice.undo;
                onDone(notice.id);
                void undo?.();
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
