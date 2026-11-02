import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface PhoneSheetProps {
  label: string;
  onClose(): void;
  /** What opened the sheet. Focus goes back to it when the sheet closes. */
  returnTo?: HTMLElement | null;
  children: ReactNode;
}

/** A sheet from the bottom of the phone screen. Focus moves in, Tab stays inside, Escape or a tap outside closes it, and focus goes back. */
export function PhoneSheet({ label, onClose, returnTo, children }: PhoneSheetProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trigger = returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    ref.current?.focus();
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
    // The trigger is read once, when the sheet opens.
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const box = ref.current;
    if (!box) return;
    const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      box.focus();
      return;
    }
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <div className="ph-veil" aria-hidden="true" onClick={onClose} />
      <div ref={ref} className="ph-sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        <span className="ph-grab" aria-hidden="true" />
        {children}
      </div>
    </>
  );
}
