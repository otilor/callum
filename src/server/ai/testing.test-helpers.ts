import type { Message, Person, Project, Settings } from '../../shared/types.js';
import type { WriteContext } from './writer.js';

export const OFFER = "You help fintech teams take reconciliation off their ops team's plate";

export function testPerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 1, projectId: 1, name: 'Kemi Eze', firstName: 'Kemi', company: 'Oko Pay', role: 'Head of Finance',
    email: 'kemi@okopay.com', linkedinUrl: null, xHandle: null, timezone: null, channel: 'email',
    stage: 'stranger', status: 'active', touches: 0, lastTouchAt: null, nextTouchAt: null,
    linkedinState: 'none', invitedAt: null, snoozedUntil: null, restUntil: null, badge: null,
    replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null,
    source: 'csv', note: null, createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

export function testProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1, name: 'Reconciliation', offer: OFFER, audience: null, tone: 'warm', sample: null, calendarUrl: 'https://cal.example.com/ada',
    approvalsLeft: 10, startedAt: null, state: 'running', pausedUntil: null,
    createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

export const testSettings: Settings = {
  senderName: 'Ada Obi', senderEmail: 'ada@example.com', timezone: 'Africa/Lagos', onboarded: true,
  currentProjectId: 1, pauseState: 'running', pausedUntil: null, notifications: null,
};

export function testCtx(overrides: Partial<WriteContext> = {}): WriteContext {
  return { person: testPerson(), project: testProject(), settings: testSettings, channel: 'email', history: [], ...overrides };
}

export function outbound(overrides: Partial<Message> = {}): Message {
  return {
    id: 1, personId: 1, channel: 'email', direction: 'out', kind: 'hello', subject: 'Quick question, Kemi',
    body: 'Hi Kemi, hello.', at: '2026-11-01T10:00:00.000Z', externalId: null, ...overrides,
  };
}

export function inbound(overrides: Partial<Message> = {}): Message {
  return {
    id: 2, personId: 1, channel: 'email', direction: 'in', kind: 'inbound', subject: 'Re: Quick question, Kemi',
    body: 'Thanks.', at: '2026-11-02T08:00:00.000Z', externalId: null, ...overrides,
  };
}
