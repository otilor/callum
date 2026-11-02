// The port Callum's server listens on. A web page's storage belongs to its address, so a new random port at every launch
// would forget what the page remembers (dismissed notices, drafts, notification permission). The last port is kept in
// desktop.json and tried first; if something else has taken it, any free port is used and that one is kept instead.

/** A port from desktop.json, or null when there is none worth trying. */
export function savedPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : null;
}

/** Starts with the saved port when there is one, and falls back to port 0 (any free port) when that does not work. */
export async function startOnSavedPort<T>(start: (port: number) => Promise<T>, saved: unknown, log: (line: string) => void = () => undefined): Promise<T> {
  const preferred = savedPort(saved);
  if (preferred !== null) {
    try {
      return await start(preferred);
    } catch (err) {
      log(`port ${preferred} is not available (${err instanceof Error ? err.message : String(err)}), using a free one`);
    }
  }
  return start(0);
}
