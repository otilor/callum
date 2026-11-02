import type { ReactNode } from 'react';
import './ErrorNote.css';

/** A problem in the error tint, announced as soon as it appears. */
export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={className ? `err-note fade-in ${className}` : 'err-note fade-in'} role="alert">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D9480F" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.6v.01" />
      </svg>
      <span>{children}</span>
    </p>
  );
}
