import { useEffect, useRef, useState, type ReactNode } from 'react';
import './AccountMenu.css';

/** What the account menu can do. An entry whose handler is missing is not shown. */
export interface AccountSlots {
  /** Opens Your Callum. */
  onYourCallum?: () => void;
  /** Opens the Take a break or wrap up sheet. */
  onLeave?: () => void;
  /** Reopens the weekly note, `Your week, in people`. */
  onWeekly?: () => void;
  /** Signs out. App passes it only when this Callum has a password. */
  onSignOut?: () => void;
}

const icon = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: '#1D2140', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

const ICONS: Record<string, ReactNode> = {
  you: <svg {...icon}><circle cx="12" cy="8.5" r="3.6" /><path d="M5 20c.6-3.6 3.4-5.6 7-5.6s6.4 2 7 5.6" /></svg>,
  week: <svg {...icon}><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>,
  leave: <svg {...icon}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>,
  out: <svg {...icon}><path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" /><path d="M10 16l-4-4 4-4M6 12h10" /></svg>,
};

/** The round face at the top right and the menu under it. */
export function AccountMenu({ slots }: { slots: AccountSlots }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const entries = [
    slots.onYourCallum ? { key: 'you', label: 'Your Callum', run: slots.onYourCallum } : null,
    slots.onWeekly ? { key: 'week', label: 'Your week, in people', run: slots.onWeekly } : null,
    slots.onLeave ? { key: 'leave', label: 'Take a break or wrap up', run: slots.onLeave } : null,
    slots.onSignOut ? { key: 'out', label: 'Sign out', run: slots.onSignOut } : null,
  ].filter((e): e is { key: string; label: string; run: () => void } => e !== null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  if (entries.length === 0) return <span className="account-face" role="img" aria-label="You" />;

  return (
    <div className="account" ref={root}>
      <button type="button" className="account-face" aria-label="Your account" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open ? (
        <div className="account-menu panel-in" role="menu">
          {entries.map((e) => (
            <button
              key={e.key}
              type="button"
              role="menuitem"
              className="account-item"
              onClick={() => {
                setOpen(false);
                e.run();
              }}
            >
              {ICONS[e.key]}
              {e.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
