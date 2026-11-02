import { describe, expect, it, vi } from 'vitest';
import { Bus } from '../src/server/bus.js';
import * as time from '../src/server/engine/time.js';
import { createNotifier, type NotifierDeps } from './notify.js';

function setup(over: Partial<NotifierDeps> = {}) {
  const bus = new Bus();
  const state = {
    waiting: [] as { id: number; firstName: string }[],
    notifications: true as boolean | null,
    renderer: false,
    now: new Date('2026-11-04T07:00:00Z'), // Wednesday 8:00 in Lagos
    shown: null as string | null,
  };
  const show = vi.fn();
  const deps: NotifierDeps = {
    bus,
    time,
    waitingPeople: () => state.waiting,
    settings: () => ({ notifications: state.notifications, timezone: 'Africa/Lagos' }),
    brief: async () => ({ line: '3 people want to talk. 12 hellos went out yesterday.' }),
    show,
    hasRenderer: () => state.renderer,
    now: () => state.now,
    briefStore: { get: () => state.shown, set: (day) => void (state.shown = day) },
    ...over,
  };
  return { bus, state, show, notifier: createNotifier(deps) };
}

describe('replies', () => {
  it('shows a notification when someone new is waiting, but not for people already waiting at start', () => {
    const state0 = { waiting: [{ id: 1, firstName: 'Kemi' }] };
    const { bus, state, show } = setup({ waitingPeople: () => state0.waiting });
    bus.emit('people');
    expect(show).not.toHaveBeenCalled();
    state0.waiting = [{ id: 1, firstName: 'Kemi' }, { id: 2, firstName: 'Femi' }];
    bus.emit('people');
    expect(show).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith({ title: 'Femi replied', body: 'Open Callum to read it and answer.' });
    bus.emit('people');
    expect(show).toHaveBeenCalledOnce();
    expect(state.notifications).toBe(true);
  });

  it('notifies again when a person who was answered replies once more', () => {
    const waiting = [{ id: 1, firstName: 'Kemi' }];
    const { bus, show } = setup({ waitingPeople: () => waiting.slice() });
    waiting.length = 0;
    bus.emit('people');
    waiting.push({ id: 1, firstName: 'Kemi' });
    bus.emit('people');
    expect(show).toHaveBeenCalledOnce();
  });

  it('stays quiet when notifications are off, and does not save them up for later', () => {
    const waiting: { id: number; firstName: string }[] = [];
    const { bus, state, show } = setup({ waitingPeople: () => waiting.slice() });
    state.notifications = false;
    waiting.push({ id: 1, firstName: 'Kemi' });
    bus.emit('people');
    state.notifications = true;
    bus.emit('people');
    expect(show).not.toHaveBeenCalled();
  });

  it('leaves replies to the window while it is alive', () => {
    const waiting: { id: number; firstName: string }[] = [];
    const { bus, state, show } = setup({ waitingPeople: () => waiting.slice() });
    state.renderer = true;
    waiting.push({ id: 1, firstName: 'Kemi' });
    bus.emit('people');
    expect(show).not.toHaveBeenCalled();
  });

  it('ignores other kinds of change and stops after stop()', () => {
    const waiting: { id: number; firstName: string }[] = [];
    const { bus, show, notifier } = setup({ waitingPeople: () => waiting.slice() });
    waiting.push({ id: 1, firstName: 'Kemi' });
    bus.emit('outbox');
    expect(show).not.toHaveBeenCalled();
    notifier.stop();
    bus.emit('people');
    expect(show).not.toHaveBeenCalled();
  });
});

describe('the morning brief', () => {
  it('shows once, from 8:30 on a weekday in the person\'s time zone', async () => {
    const { state, show, notifier } = setup();
    await notifier.tick();
    expect(show).not.toHaveBeenCalled();
    state.now = new Date('2026-11-04T07:31:00Z'); // 8:31 in Lagos
    await notifier.tick();
    expect(show).toHaveBeenCalledWith({ title: 'Good morning', body: '3 people want to talk. 12 hellos went out yesterday.' });
    expect(state.shown).toBe('2026-11-04');
    await notifier.tick();
    expect(show).toHaveBeenCalledOnce();
    state.now = new Date('2026-11-05T07:40:00Z');
    await notifier.tick();
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('skips weekends, late starts and switched-off notifications', async () => {
    const { state, show, notifier } = setup();
    state.now = new Date('2026-11-07T07:40:00Z'); // Saturday
    await notifier.tick();
    state.now = new Date('2026-11-04T12:00:00Z'); // 13:00, long past breakfast
    await notifier.tick();
    state.now = new Date('2026-11-04T07:40:00Z');
    state.notifications = null;
    await notifier.tick();
    expect(show).not.toHaveBeenCalled();
  });

  it('tries again later when the brief could not be read, and skips an empty one', async () => {
    let result: { line: string } | null = null;
    const { state, show, notifier } = setup({ brief: async () => result });
    state.now = new Date('2026-11-04T07:40:00Z');
    await notifier.tick();
    expect(state.shown).toBeNull();
    result = { line: '' };
    await notifier.tick();
    expect(show).not.toHaveBeenCalled();
    result = { line: 'Nothing waiting for you.' };
    await notifier.tick();
    expect(show).toHaveBeenCalledOnce();
  });
});
