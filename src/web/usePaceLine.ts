import { useEffect, useState } from 'react';
import type { Channel } from '../shared/types.js';
import { api } from './api.js';

/** The pace line the server worked out for a channel (`20 a day now, 120 by week 3`), or the one the screen already has. */
export function paceLineOf(summary: { paceLine?: string } | null | undefined, fallback: string): string {
  const line = summary?.paceLine?.trim();
  return line ? line : fallback;
}

/**
 * `GET /channels/:ch/summary` for each channel asked about, as `{ channel: paceLine }`.
 * A channel the server cannot answer for is left out, so the screen keeps its own wording for it.
 */
export function usePaceLines(channels: Channel[]): Partial<Record<Channel, string>> {
  const [lines, setLines] = useState<Partial<Record<Channel, string>>>({});
  const key = [...channels].sort().join(',');
  useEffect(() => {
    let alive = true;
    for (const ch of key ? (key.split(',') as Channel[]) : []) {
      api
        .channelSummary(ch)
        .then((s) => alive && s.paceLine && setLines((all) => ({ ...all, [ch]: s.paceLine })))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [key]);
  return lines;
}
