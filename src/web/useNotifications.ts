import { useEffect, useRef } from 'react';
import type { AppState, Person } from '../shared/types.js';

/** Nothing from the reply goes in the notification: it can show on a lock screen. */
const BODY = 'Open Callum to read it and answer.';

function canNotify(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

/** Someone is looking at Callum right now, so a notification would only repeat what is on screen. */
function lookingAtCallum(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
}

function tell(person: Person): void {
  try {
    const note = new Notification(`${person.firstName} replied`, {
      body: BODY,
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
 * notifications are on in settings, the browser has said yes and nobody has Callum open in front of them.
 */
export function useNotifications(state: AppState | null): void {
  const seen = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!state) return;
    const waiting = state.people.filter((p) => p.status === 'waiting');
    const before = seen.current;
    seen.current = new Set(waiting.map((p) => p.id));
    if (!before || state.settings.notifications !== true || !canNotify() || lookingAtCallum()) return;
    for (const person of waiting) if (!before.has(person.id)) tell(person);
  }, [state]);
}
