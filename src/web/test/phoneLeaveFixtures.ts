import type { AppState, ChannelAccount, Incident, OutboxItem, Person, Project } from '../../shared/types.js';

export const NOW = new Date('2026-11-02T10:00:00Z');
const AT = NOW.toISOString();

export function channel(ch: ChannelAccount['channel'], status: ChannelAccount['status'] = 'connected', identity: string | null = null): ChannelAccount {
  return { channel: ch, status, identity, connectedAt: AT, pausedUntil: null, halfPaceUntil: null, invitesBlockedUntil: null, lastPolledAt: null };
}

export function project(over: Partial<Project> = {}): Project {
  return {
    id: 1, name: 'Reconciliation', offer: 'You help fintech teams take reconciliation off their ops team.', audience: null, tone: 'warm', sample: null,
    calendarUrl: null, approvalsLeft: 0, startedAt: AT, state: 'running', pausedUntil: null, createdAt: AT, updatedAt: AT,
    ...over,
  };
}

export function person(id: number, first: string, over: Partial<Person> = {}): Person {
  return {
    id, projectId: 1, name: `${first} Eze`, firstName: first, company: 'Oko Pay', role: 'Founder', email: `${first.toLowerCase()}@okopay.com`, linkedinUrl: null,
    xHandle: null, timezone: null, channel: 'email', stage: 'hello', status: 'active', touches: 1, lastTouchAt: null, nextTouchAt: null, linkedinState: 'none',
    invitedAt: null, snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null,
    source: 'paste', note: null, createdAt: AT, updatedAt: AT,
    ...over,
  };
}

export function incident(id: number, kind: Incident['kind'], message: string, over: Partial<Incident> = {}): Incident {
  const ch: Incident['channel'] = kind.startsWith('linkedin') ? 'linkedin' : kind === 'x_limit' || kind === 'x_signed_out' ? 'x' : 'email';
  return { id, channel: ch, kind, state: 'open', message, detail: null, personId: null, createdAt: AT, resolvedAt: null, ...over };
}

export function outboxItem(id: number, personId: number, over: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id, personId, channel: 'email', kind: 'reply', subject: null, body: 'Hi Tomas, Thursday at 14:00 works well.', state: 'scheduled', origin: 'user',
    sendAfter: AT, undoUntil: new Date(NOW.getTime() + 10_000).toISOString(), error: null, approvalCounted: false, claimedAt: null, detail: null, createdAt: AT, updatedAt: AT,
    ...over,
  };
}

export function appState(over: Partial<AppState> = {}): AppState {
  return {
    settings: { senderName: 'Gabriel', senderEmail: 'gabriel@yourcompany.com', timezone: 'Africa/Lagos', onboarded: true, currentProjectId: 1, pauseState: 'running', pausedUntil: null, notifications: null, morningBrief: true },
    projects: [project()],
    channels: [channel('email', 'connected', 'gabriel@yourcompany.com'), channel('linkedin'), channel('x')],
    people: [],
    outbox: [],
    incidents: [],
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], nextSendAt: null, line: 'All caught up. Callum keeps the river moving.' },
    demo: false,
    ...over,
  };
}
