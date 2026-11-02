import { useCallback, useSyncExternalStore } from 'react';

function matcher(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
}

/** Whether the media query matches right now, kept current as the window changes. False where the browser cannot say. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = matcher(query);
      if (!list) return () => {};
      if (typeof list.addEventListener === 'function') {
        list.addEventListener('change', onChange);
        return () => list.removeEventListener('change', onChange);
      }
      // Older Safari only knows the earlier names.
      list.addListener(onChange);
      return () => list.removeListener(onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matcher(query)?.matches ?? false, () => false);
}

/** The phone layout: a narrow window. */
export const PHONE_QUERY = '(max-width: 720px)';
