import type { AppState, ChannelAccount, Incident, OutboxItem, Person, Project } from '../../shared/types.js';

export const NOW = new Date('2026-11-03T08:30:00.000Z'); // Tuesday, 9:30 in Lagos
export const OFFER = "You help fintech teams take reconciliation off their ops team's plate.";

export function channel(ch: ChannelAccount['channel'], status: ChannelAccount['status'] = 'connected', over: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    channel: ch, status, identity: status === 'disconnected' ? null : ch === 'email' ? 'gabriel@yourcompany.com' : 'gabriel', connectedAt: null,
    pausedUntil: null, halfPaceUntil: null, invitesBlockedUntil: null, lastPolledAt: null, ...over,
  };
}

export function project(over: Partial<Project> = {}): Project {
  return {
    id: 1, name: 'Reconciliation', offer: OFFER, audience: null, tone: 'warm', sample: null, calendarUrl: 'https://cal.example.com/g',
    approvalsLeft: 0, startedAt: '2026-10-26T09:00:00.000Z', state: 'running', pausedUntil: null,
    createdAt: '2026-10-26T08:00:00.000Z', updatedAt: '2026-10-26T08:00:00.000Z', ...over,
  };
}

export function person(id: number, name: string, over: Partial<Person> = {}): Person {
  return {
    id, projectId: 1, name, firstName: name.split(' ')[0] ?? name, company: 'Oko Pay', role: 'Founder', email: `p${id}@okopay.com`, linkedinUrl: null, xHandle: null,
    timezone: null, channel: 'email', stage: 'stranger', status: 'active', touches: 0, lastTouchAt: null, nextTouchAt: null, linkedinState: 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, source: 'csv', note: null,
    createdAt: '2026-10-26T08:00:00.000Z', updatedAt: '2026-10-26T08:00:00.000Z', ...over,
  };
}

export function incident(id: number, kind: Incident['kind'], over: Partial<Incident> = {}): Incident {
  return {
    id, channel: 'email', kind, state: 'open', message: '', detail: null, personId: null, createdAt: '2026-11-03T08:14:00.000Z', resolvedAt: null, ...over,
  };
}

export function outboxItem(id: number, personId: number, over: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id, personId, channel: 'email', kind: 'reply', subject: null, body: 'Hi', state: 'scheduled', origin: 'user', sendAfter: NOW.toISOString(),
    undoUntil: null, error: null, approvalCounted: false, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over,
  };
}

export function appState(over: Partial<AppState> = {}): AppState {
  return {
    settings: {
      senderName: 'Gabriel Femi', senderEmail: 'gabriel@yourcompany.com', timezone: 'Africa/Lagos', onboarded: true, currentProjectId: 1,
      pauseState: 'running', pausedUntil: null, notifications: null,
    },
    projects: [project()],
    channels: [channel('email'), channel('linkedin'), channel('x')],
    people: [],
    outbox: [],
    incidents: [],
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], nextSendAt: null, line: 'All caught up. Callum keeps the river moving.' },
    demo: false,
    ...over,
  };
}
