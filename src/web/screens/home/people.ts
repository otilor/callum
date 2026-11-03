import type { AppState, Person } from '../../../shared/types.js';
import { riverLayout } from '../../river/layout.js';

/** People with a message of the user's own on its way (still inside the Undo window or waiting to leave). */
export function pendingSendIds(state: AppState): Set<number> {
  return new Set(state.outbox.filter((o) => o.origin === 'user' && (o.state === 'scheduled' || o.state === 'awaiting_ok')).map((o) => o.personId));
}

/**
 * Who waits on the user, across every project, oldest reply first: status `waiting` only (the server moves a snoozed
 * person back to waiting when they are due). A person whose reply is already on its way is
 * not waiting any more, even if the server has not moved them yet.
 */
export function dockPeople(state: AppState): Person[] {
  const sending = pendingSendIds(state);
  return riverLayout(state.people, 1000, 280).dock.filter((p) => !sending.has(p.id));
}

/** The people the river draws for one project: the ones with a reply on its way sit among those talking. */
export function riverPeople(state: AppState, projectId: number | null, sending: Set<number>): Person[] {
  return state.people
    .filter((p) => projectId === null || p.projectId === projectId)
    .map((p) => (sending.has(p.id) && p.status === 'waiting' ? { ...p, status: 'active' as const, stage: 'talking' as const } : p));
}

export function channelPhrase(channel: Person['channel']): string {
  return channel === 'linkedin' ? 'on LinkedIn' : channel === 'x' ? 'on X' : 'by email';
}

export function channelName(channel: Person['channel']): string {
  return channel === 'linkedin' ? 'LinkedIn' : channel === 'x' ? 'X' : 'Email';
}

export function greeting(hour: number): string {
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}
