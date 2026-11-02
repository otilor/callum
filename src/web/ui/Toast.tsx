import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import './ui.css';

export interface ToastAction { label: string; onAction(): void }
interface ToastItem { id: number; text: string; action?: ToastAction }
interface ToastApi { toast(text: string, opts?: { action?: ToastAction; ms?: number }): void }

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((all) => all.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastApi['toast']>(
    (text, opts) => {
      const id = next.current++;
      setItems((all) => [...all.slice(-2), { id, text, ...(opts?.action ? { action: opts.action } : {}) }]);
      timers.current.set(id, setTimeout(() => dismiss(id), opts?.ms ?? 3200));
    },
    [dismiss],
  );

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const t of live.values()) clearTimeout(t);
      live.clear();
    };
  }, []);

  const api = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="toast fade-in">
            <span className="toast-dot" aria-hidden="true" />
            <span className="toast-text">{t.text}</span>
            {t.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action?.onAction();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi['toast'] {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast needs a ToastProvider above it');
  return ctx.toast;
}
