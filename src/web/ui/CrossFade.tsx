import { useEffect, useRef, useState, type ReactNode } from 'react';
import './CrossFade.css';
import { prefersReducedMotion } from '../screens/firstrun/motion.js';

const FADE_MS = 450;

/**
 * When `id` changes, the old content fades out while the new fades in on top of it.
 * With reduced motion the swap is instant.
 */
export function CrossFade({ id, children, className }: { id: string | number; children: ReactNode; className?: string }) {
  const [shown, setShown] = useState(id);
  const [leaving, setLeaving] = useState<ReactNode>(null);
  const last = useRef<ReactNode>(children);

  if (id !== shown) {
    setShown(id);
    setLeaving(prefersReducedMotion() ? null : last.current);
  }
  last.current = children;

  useEffect(() => {
    if (leaving === null) return;
    const timer = setTimeout(() => setLeaving(null), FADE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  return (
    <div className={['xf', className].filter(Boolean).join(' ')}>
      {leaving !== null ? (
        <div className="xf-out" aria-hidden="true" inert>
          {leaving}
        </div>
      ) : null}
      <div className={leaving !== null ? 'xf-in' : undefined}>{children}</div>
    </div>
  );
}
