import { useEffect, useRef, type ReactNode } from 'react';

/** A small card over the screen. Escape and a tap outside close it; focus starts inside. */
export function Sheet({ label, onClose, children }: { label: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, []);
  return (
    <div
      className="sheet-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
