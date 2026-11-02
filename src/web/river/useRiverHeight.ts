import { useEffect, useState } from 'react';

/** The river at its tallest, and the least it shrinks to so faces still have room. */
export const RIVER_MAX = 280;
export const RIVER_MIN = 160;
/** What the rest of Home needs above and around the river: the bar, the brief with the dock, the counts and the Ask bar. */
const AROUND = 560;

/** The water's height for a window this tall: `min(280px, 100dvh - 560px)`, less any padding the desktop window puts on top. */
export function riverHeightFor(viewport: number, topInset = 0): number {
  return Math.max(RIVER_MIN, Math.min(RIVER_MAX, Math.floor(viewport - topInset - AROUND)));
}

function read(): number {
  if (typeof window === 'undefined') return RIVER_MAX;
  let inset = 0;
  try {
    inset = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
  } catch {
    inset = 0;
  }
  return riverHeightFor(window.innerHeight, inset);
}

/** The river's height in this window, kept current as the window is resized, so the Ask bar is never pushed off the screen. */
export function useRiverHeight(): number {
  const [height, setHeight] = useState(read);
  useEffect(() => {
    const onResize = () => setHeight(read());
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return height;
}
