import { useEffect, useRef } from 'react';
import type { AppState, Person } from '../shared/types.js';

const BODY_MAX = 140;

function canNotify(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

function snippet(text: string | null): string | undefined {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > BODY_MAX ? `${flat.slice(0, BODY_MAX - 1).trimEnd()}…` : flat;
}

function tell(person: Person): void {
  const body = snippet(person.lastInbound);
  try {
    const note = new Notification(`${person.firstName} replied`, {
      ...(body ? { body } : {}),
      tag: `callum-reply-${person.id}`,
      icon: '/icon.svg',
    });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    // Some phone browsers only allow notifications from a service worker. The dock still shows the reply.
  }
}

/**
 * Asks the browser for permission, from a tap. True when notifications are allowed afterwards.
 * Call it when the person turns notifications on, never on load.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * A browser notification, `{first} replied`, for each person who newly starts waiting on the person using Callum.
 * It follows who was waiting at the last look, so the first load never notifies, and it only speaks when
 * notifications are on in settings and the browser has said yes.
 */
export function useNotifications(state: AppState | null): void {
  const seen = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!state) return;
    const waiting = state.people.filter((p) => p.status === 'waiting');
    const before = seen.current;
    seen.current = new Set(waiting.map((p) => p.id));
    if (!before || state.settings.notifications !== true || !canNotify()) return;
    for (const person of waiting) if (!before.has(person.id)) tell(person);
  }, [state]);
}
