import { useEffect, useState } from 'react';

/** True when the person asked their system for less motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Counts up to `target` like faces arriving, or jumps there at once when motion is reduced or the number drops. */
export function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (prefersReducedMotion() || target <= shown) {
      if (shown !== target) setShown(target);
      return;
    }
    const step = Math.max(1, Math.ceil((target - shown) / 40));
    const id = setInterval(() => {
      setShown((s) => {
        const next = Math.min(target, s + step);
        if (next >= target) clearInterval(id);
        return next;
      });
    }, 45);
    return () => clearInterval(id);
    // `shown` is read once, when the target changes; the interval owns it from there.
  }, [target]);
  return shown;
}
