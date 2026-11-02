import { useEffect, useRef, type RefObject } from 'react';

/**
 * Puts the cursor on a page's `h1` when the page opens (and whenever `key` changes), so a screen reader says where it is and the
 * keyboard starts at the top. Give the heading `tabIndex={-1}` and this ref.
 */
export function useHeadingFocus(key: unknown = null, enabled = true): RefObject<HTMLHeadingElement | null> {
  const ref = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (enabled) ref.current?.focus({ preventScroll: true });
  }, [key, enabled]);
  return ref;
}
