import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import './Sheet.css';

export interface SheetProps {
  /** Names the sheet for screen readers, as in `Kemi Eze` or `Your Callum`. */
  label: string;
  onClose(): void;
  /** How far up from the bottom of the window the sheet stops, so the river below it stays in view. */
  bottom: number;
  children: ReactNode;
}

/**
 * A page that rises over Home instead of replacing it. The header stays where it is, the river settles along the bottom
 * and keeps moving, and Escape or the round close button lets the sheet sink back.
 */
export function Sheet({ label, onClose, bottom, children }: SheetProps) {
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // A control inside the sheet that uses Escape for itself (clearing a search, closing a menu) says so first.
      if (e.key === 'Escape' && !e.defaultPrevented) close.current();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  return (
    <section ref={root} className="layer" role="region" aria-label={label} style={{ '--layer-bottom': `${bottom}px` } as CSSProperties}>
      <button type="button" className="layer-close" aria-label="Back to the river" onClick={onClose}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2.5 2.5l9 9M11.5 2.5l-9 9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>
      <div className="layer-body">{children}</div>
    </section>
  );
}
