import type { ReactNode } from 'react';
import type { Channel } from '../../../shared/types.js';

export const CHANNEL_NAMES: Record<Channel, string> = { email: 'Email', linkedin: 'LinkedIn', x: 'X' };

function Glyph({ size, width = 2, children }: { size: number; width?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** The channel's mark: an envelope, `in`, or an X. */
export function ChannelGlyph({ channel, size = 20 }: { channel: Channel; size?: number }) {
  if (channel === 'linkedin') return <span className="cx-in" style={{ fontSize: Math.round(size * 0.85) }} aria-hidden="true">in</span>;
  if (channel === 'x') return <Glyph size={Math.round(size * 0.8)} width={2.6}><path d="M5 5l14 14M19 5L5 19" /></Glyph>;
  return <Glyph size={size}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M4 7.5l8 6 8-6" /></Glyph>;
}

export const CheckMark = ({ size = 18 }: { size?: number }) => (
  <Glyph size={size} width={2.8}><path d="M5 12.5l4.5 4.5L19 7.5" /></Glyph>
);
export const Chevron = () => <Glyph size={16} width={2.4}><path d="M6 9l6 6 6-6" /></Glyph>;
export const External = () => <Glyph size={14} width={2.2}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Glyph>;

export function Spinner({ size = 18, light = false }: { size?: number; light?: boolean }) {
  return (
    <svg className="cx-spin" width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7" fill="none" stroke={light ? 'rgba(255,255,255,.3)' : 'rgba(63,82,217,.25)'} strokeWidth="2.4" />
      <path d="M9 2a7 7 0 0 1 7 7" fill="none" stroke={light ? '#FFFFFF' : '#3F52D9'} strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/** An error line in the error tint. Announced to screen readers as soon as it appears. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="cx-alert fade-in" role="alert">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D9480F" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.6v.01" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

export const PERSONAL_DOMAINS = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'];

export function isPersonalAddress(address: string): boolean {
  const domain = address.trim().toLowerCase().split('@')[1] ?? '';
  return PERSONAL_DOMAINS.includes(domain);
}

/** The open-source docs page for the one-time Microsoft app setup. */
export const MICROSOFT_SETUP_DOC = 'docs/SETUP.md#microsoft';

/** The desktop app's bridge, present only inside the desktop app. */
export interface CallumDesktop {
  isDesktop: true;
  version?: string;
  setOpenAtLogin(open: boolean): Promise<void> | void;
}
declare global {
  interface Window {
    callumDesktop?: CallumDesktop;
  }
}
