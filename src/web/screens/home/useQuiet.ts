import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, QuietSnapshot } from '../../../shared/types.js';
import { noteApi } from '../../api.js';

/**
 * The quiet moments of the project on screen (`GET /quiet`), read again whenever the state is. Without an answer it is
 * null, and the screens that use it simply show nothing extra: the moments are a nicety, never a reason to fail.
 */
export function useQuiet(state: AppState | null, projectId: number | null, on: boolean): { quiet: QuietSnapshot | null; reload(): void } {
  const [quiet, setQuiet] = useState<QuietSnapshot | null>(null);
  const [again, setAgain] = useState(0);
  const asked = useRef(0);

  useEffect(() => {
    if (!on || projectId === null) {
      setQuiet(null);
      return;
    }
    const ticket = ++asked.current;
    noteApi.quiet(projectId).then(
      (q) => {
        if (ticket === asked.current) setQuiet(q);
      },
      () => undefined,
    );
  }, [state, projectId, on, again]);

  const reload = useCallback(() => setAgain((n) => n + 1), []);
  return { quiet, reload };
}
