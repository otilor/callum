import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './Sheet.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // The inside of a closed disclosure cannot take focus; its summary can.
    const closed = el.closest('details:not([open])');
    return !closed || el.tagName === 'SUMMARY';
  });
}

/**
 * A small card over the screen, and a real modal: the page behind it is inert, Tab stays inside, Escape or a tap
 * outside closes it, and focus goes back to whatever opened it.
 */
export function Sheet({ label, onClose, bare = false, children }: { label: string; onClose(): void; /** The content brings its own headings and text styles (the Connect sheet does). */ bare?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Read while rendering, before an autofocused field inside the sheet takes focus.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => {
    const dialog = ref.current;
    const host = dialog?.closest('.sheet-back') ?? null;

    // Everything else on the page cannot be reached while the sheet is open.
    const made: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement && child !== host && !child.hasAttribute('inert')) {
        child.setAttribute('inert', '');
        made.push(child);
      }
    }

    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const items = focusablesIn(dialog);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      for (const el of made) el.removeAttribute('inert');
      if (opener && opener.isConnected) opener.focus();
    };
  }, [opener]);

  return createPortal(
    <div
      className="sheet-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className={bare ? 'sheet sheet-bare' : 'sheet'} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
