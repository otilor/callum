import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Person } from '../shared/types.js';
import { requestNotificationPermission, useNotifications } from './useNotifications.js';

const AT = '2026-11-02T10:00:00.000Z';

function person(id: number, first: string, over: Partial<Person> = {}): Person {
  return {
    id, projectId: 1, name: `${first} Eze`, firstName: first, company: null, role: null, email: null, linkedinUrl: null, xHandle: null,
    timezone: null, channel: 'email', stage: 'hello', status: 'active', touches: 1, lastTouchAt: null, nextTouchAt: null, linkedinState: 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, source: 'paste', note: null,
    createdAt: AT, updatedAt: AT,
    ...over,
  };
}

function state(people: Person[], notifications: boolean | null = true): AppState {
  return {
    settings: { senderName: null, senderEmail: null, timezone: 'Africa/Lagos', onboarded: true, currentProjectId: 1, pauseState: 'running', pausedUntil: null, notifications, morningBrief: true },
    projects: [], channels: [], people, outbox: [], incidents: [],
    brief: { wantToTalk: 0, sentYesterday: 0, acceptedRecently: [], nextSendAt: null, line: '' },
    demo: false,
  };
}

const made: { title: string; options: NotificationOptions | undefined }[] = [];

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  onclick: (() => void) | null = null;
  constructor(title: string, options?: NotificationOptions) {
    made.push({ title, options });
  }
  close() {}
}

let looking = false;

beforeEach(() => {
  looking = false;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => looking);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (looking ? 'visible' : 'hidden'));
  made.length = 0;
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal('Notification', FakeNotification);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useNotifications', () => {
  it('stays quiet on the first load, even when people are already waiting', () => {
    renderHook(() => useNotifications(state([person(1, 'Kemi', { status: 'waiting' })])));
    expect(made).toEqual([]);
  });

  it('says `{first} replied` once for a person who starts waiting after the first load', () => {
    const { rerender } = renderHook(({ s }) => useNotifications(s), { initialProps: { s: state([person(1, 'Kemi')]) } });
    rerender({ s: state([person(1, 'Kemi', { status: 'waiting', lastInbound: 'Could you send a short deck before Monday?' })]) });
    expect(made).toHaveLength(1);
    expect(made[0]?.title).toBe('Kemi replied');
    // The reply itself never goes on the lock screen.
    expect(made[0]?.options?.body).toBe('Open Callum to read it and answer.');
    expect(JSON.stringify(made[0])).not.toContain('short deck');
    rerender({ s: state([person(1, 'Kemi', { status: 'waiting', lastInbound: 'Could you send a short deck before Monday?' })]) });
    expect(made).toHaveLength(1);
  });

  it('does nothing before the first state has arrived', () => {
    const { rerender } = renderHook(({ s }) => useNotifications(s), { initialProps: { s: null as AppState | null } });
    rerender({ s: state([person(1, 'Kemi', { status: 'waiting' })]) });
    expect(made).toEqual([]);
    rerender({ s: state([person(1, 'Kemi', { status: 'waiting' }), person(2, 'Tunde', { status: 'waiting' })]) });
    expect(made.map((n) => n.title)).toEqual(['Tunde replied']);
  });

  it('speaks again when someone who left the dock replies a second time', () => {
    const { rerender } = renderHook(({ s }) => useNotifications(s), { initialProps: { s: state([person(1, 'Kemi', { status: 'waiting' })]) } });
    rerender({ s: state([person(1, 'Kemi', { status: 'snoozed' })]) });
    rerender({ s: state([person(1, 'Kemi', { status: 'waiting' })]) });
    expect(made.map((n) => n.title)).toEqual(['Kemi replied']);
  });

  it('keeps track while notifications are off, so turning them on later does not announce old replies', () => {
    const { rerender } = renderHook(({ s }) => useNotifications(s), { initialProps: { s: state([person(1, 'Kemi')], false) } });
    rerender({ s: state([person(1, 'Kemi', { status: 'waiting' })], false) });
    rerender({ s: state([person(1, 'Kemi', { status: 'waiting' })], true) });
    expect(made).toEqual([]);
  });

  it('is silent while the page is visible and focused, and speaks once it is not', () => {
    looking = true;
    const { rerender } = renderHook(({ s }) => useNotifications(s), { initialProps: { s: state([person(1, 'Kemi'), person(2, 'Tunde')]) } });
    rerender({ s: state([person(1, 'Kemi', { status: 'waiting' }), person(2, 'Tunde')]) });
    expect(made).toEqual([]);
    looking = false;
    rerender({ s: state([person(1, 'Kemi', { status: 'waiting' }), person(2, 'Tunde', { status: 'waiting' })]) });
    expect(made.map((n) => n.title)).toEqual(['Tunde replied']);
  });

  it('is silent when the setting is off or unset', () => {
    for (const setting of [false, null]) {
      const { rerender, unmount } = renderHook(({ s }) => useNotifications(s), { initialProps: { s: state([person(1, 'Kemi')], setting) } });
      rerender({ s: state([person(1, 'Kemi', { status: 'waiting' })], setting) });
      unmount();
    }
    expect(made).toEqual([]);
  });

  it('is silent when the browser has not allowed it', () => {
    FakeNotification.permission = 'default';
    const { rerender } = renderHook(({ s }) => useNotifications(s), { initialProps: { s: state([person(1, 'Kemi')]) } });
    rerender({ s: state([person(1, 'Kemi', { status: 'waiting' })]) });
    expect(made).toEqual([]);
  });

  it('does not break the page where the browser has no Notification at all', () => {
    vi.stubGlobal('Notification', undefined);
    const { rerender } = renderHook(({ s }) => useNotifications(s), { initialProps: { s: state([person(1, 'Kemi')]) } });
    expect(() => rerender({ s: state([person(1, 'Kemi', { status: 'waiting' })]) })).not.toThrow();
  });
});

describe('requestNotificationPermission', () => {
  it('asks once when undecided and reports the answer', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockImplementation(async () => {
      FakeNotification.permission = 'granted';
      return 'granted';
    });
    await expect(requestNotificationPermission()).resolves.toBe(true);
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('does not ask again once refused', async () => {
    FakeNotification.permission = 'denied';
    await expect(requestNotificationPermission()).resolves.toBe(false);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });
});
