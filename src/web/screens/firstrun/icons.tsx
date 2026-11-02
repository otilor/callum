import type { ReactNode } from 'react';

function Svg({ size, stroke = 'currentColor', width = 2, children }: { size: number; stroke?: string; width?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const ChatIcon = () => <Svg size={18}><path d="M4 5h16v11H9l-5 4z" /></Svg>;
export const ShieldIcon = () => <Svg size={18}><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /></Svg>;
export const ClockIcon = () => <Svg size={18}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>;
export const MailIcon = () => <Svg size={44} width={1.8}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M4 7.5l8 6 8-6" /></Svg>;
export const XMark = () => <Svg size={36} width={2.2}><path d="M5 5l14 14M19 5L5 19" /></Svg>;
export const CheckIcon = () => <Svg size={18} stroke="#1D2140" width={2.8}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const GlobeIcon = () => (
  <Svg size={16} stroke="#646B85">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.6 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.6-3.5-8.5s1-5.9 3.5-8.5z" />
  </Svg>
);
export const UploadIcon = () => <Svg size={18} stroke="#1D2140"><path d="M12 16V4M7 9l5-5 5 5M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" /></Svg>;
export const PencilIcon = () => <Svg size={16} stroke="#1D2140" width={2.2}><path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z" /></Svg>;
export const ArrowUp = () => <Svg size={20} stroke="#FFFFFF" width={2.4}><path d="M12 19V5M5 12l7-7 7 7" /></Svg>;
export const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 2l8 8M10 2l-8 8" stroke="#1D2140" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
export const AlertIcon = () => <Svg size={18} stroke="#D9480F" width={2.4}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.6v.01" /></Svg>;

/** An error line in the error tint. Announced to screen readers as soon as it appears. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="fr-alert fade-in" role="alert">
      <AlertIcon />
      <span>{children}</span>
    </p>
  );
}
